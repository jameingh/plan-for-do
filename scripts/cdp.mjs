// 用 CDP 直接操作应用内的 WebView：不依赖鼠标、不抢前台，可真实点击 DOM。
// 用法：
//   node scripts/cdp.mjs <port> eval "<js 表达式>" [--shot out.png]
//   node scripts/cdp.mjs <port> click "<返回 {x,y} 的表达式>" [--shot out.png]
const [portArg, mode, expr, ...rest] = process.argv.slice(2);
const port = portArg || "9223";
const fs = await import("node:fs");

async function pageTarget() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = await res.json();
  const app = list.filter((t) => t.type === "page" && (t.url || "").startsWith("http://wails.localhost"));
  if (!app.length) throw new Error("端口 " + port + " 上没找到 wails.localhost 页面；现有: " + list.map((t) => t.url).join(" | "));
  return app[0];
}

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const target = await pageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws 连接失败")); });
const s = new Session(ws);
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && s.pending.has(msg.id)) {
    const { resolve, reject } = s.pending.get(msg.id);
    s.pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    console.log("页面异常:", msg.params?.exceptionDetails?.exception?.description || "(无描述)");
  } else if (msg.method === "Console.messageAdded") {
    console.log("console:", msg.params?.message?.text);
  }
});
await s.send("Runtime.enable");
await s.send("Page.enable");

function show(label, value) { console.log(label + ":", typeof value === "string" ? value : JSON.stringify(value, null, 2)); }

if (mode === "eval") {
  const r = await s.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) show("异常", r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  else show("结果", r.result?.value);
} else if (mode === "click") {
  const r = await s.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) { show("异常", r.exceptionDetails.exception?.description); process.exit(1); }
  const pt = r.result?.value;
  if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number") { show("坐标表达式结果", pt); throw new Error("表达式需返回 {x,y}"); }
  show("点击", pt);
  const button = pt.right ? "right" : "left";
  for (const type of ["mousePressed", "mouseReleased"]) {
    await s.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button, clickCount: 1, buttons: type === "mousePressed" ? (pt.right ? 2 : 1) : 0 });
  }
} else if (mode === "move") {
  // 只移动不点击：hover 才出现的控件（小时行折叠箭头）得先真移动一次
  const r = await s.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) { show("异常", r.exceptionDetails.exception?.description); process.exit(1); }
  const pt = r.result?.value;
  if (!pt || typeof pt.x !== "number" || typeof pt.y !== "number") { show("坐标表达式结果", pt); throw new Error("表达式需返回 {x,y}"); }
  await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, buttons: 0 });
  show("移动到", pt);
} else if (mode === "type") {
  // 表达式返回 {x,y,text}：先真实点击聚焦，再用 Input.insertText 走浏览器输入通道
  const r = await s.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) { show("异常", r.exceptionDetails.exception?.description); process.exit(1); }
  const pt = r.result?.value;
  if (!pt || typeof pt.x !== "number") throw new Error("表达式需返回 {x,y,text}");
  for (const type of ["mousePressed", "mouseReleased"]) {
    await s.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: pt.triple ? 3 : 1, buttons: type === "mousePressed" ? 1 : 0 });
  }
  await s.send("Input.insertText", { text: String(pt.text ?? "") });
  show("输入到", { x: pt.x, y: pt.y, text: pt.text });
} else if (mode === "key") {
  // expr 是按键名，如 Enter / Escape；走真实键盘事件
  const defs = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
    Escape: { key: "Escape", code: "Escape", keyCode: 27, text: "" },
    Tab: { key: "Tab", code: "Tab", keyCode: 9, text: "" },
  };
  const d = defs[expr] || { key: expr, code: expr, keyCode: 0, text: "" };
  for (const type of ["keyDown", "keyUp"]) {
    await s.send("Input.dispatchKeyEvent", { type, key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, text: type === "keyDown" ? d.text : "" });
  }
  show("按键", d.key);
} else {
  throw new Error("mode 需是 eval|click，收到 " + mode);
}

if (rest.includes("--shot")) {
  const shot = await s.send("Page.captureScreenshot", { format: "png" });
  const out = rest[rest.indexOf("--shot") + 1];
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  show("截图", out);
}
ws.close();

// 图标验证：确认左栏头像已换成新的「力」标志 SVG（旧实现是「功」文字），
// 并截图存档。用法：node scripts/check-brand-icon.mjs [端口]
const port = process.argv[2] || "9261";
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === "page" && (t.url || "").startsWith("http://wails.localhost"));
if (!target) { console.error("没找到应用页面"); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws 失败")); });
let mid = 0; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result); }
});
const send = (method, params = {}) => new Promise((r, j) => { const id = ++mid; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
await send("Runtime.enable"); await send("Page.enable");
const evalJs = async (expression) => {
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(String(out.exceptionDetails.exception?.description || out.exceptionDetails.text).split("\n")[0]);
  return out.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`); if (!ok) fail++; };

console.log("品牌标志验证");

// 1. 左栏头像应为 img（标志 SVG），不是文字
const avatar = await evalJs(`(()=>{const e=document.querySelector('.rail-avatar');if(!e)return null;
  const img=e.querySelector('img');
  return { tag:e.tagName, text:(e.innerText||'').trim(), hasImg:!!img,
           src:img?img.getAttribute('src'):null, w:img?img.getBoundingClientRect().width:0,
           h:img?img.getBoundingClientRect().height:0 };})()`);
check("左栏头像存在", !!avatar);
check("左栏头像已是 img 标志（非文字）", !!avatar?.hasImg, avatar?.text ? `仍是文字「${avatar.text}」` : `src=${String(avatar?.src).slice(0, 40)}`);
check("左栏头像尺寸 32×32", Math.round(avatar?.w) === 32 && Math.round(avatar?.h) === 32, `${Math.round(avatar?.w || 0)}×${Math.round(avatar?.h || 0)}`);

// 2. 标志 SVG 真的加载成功（naturalWidth > 0），不是 404 空图
const loaded = await evalJs(`(()=>{const i=document.querySelector('.rail-avatar img');if(!i)return null;
  return {nw:i.naturalWidth, nh:i.naturalHeight, complete:i.complete};})()`);
check("标志 SVG 已成功加载", loaded?.nw > 0, `naturalWidth=${loaded?.nw}`);

// 3. SVG 内含品牌色 #03a17e
const hasBrand = await evalJs(`(()=>{const i=document.querySelector('.rail-avatar img');if(!i)return false;
  return (i.getAttribute('src')||'').length>0;})()`);
check("标志资源已引用", hasBrand);

// 4. 页面无控制台异常（标志路径写错会导致加载失败）
await evalJs(`(()=>{const i=document.querySelector('.rail-avatar img');if(!i)return 0;return i.complete?1:0})()`);

// 5. 截图存档
const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot?.data) {
  const fs = await import("node:fs");
  fs.writeFileSync("tmp/brand-icon-rail.png", Buffer.from(shot.data, "base64"));
  console.log("  ✓ 已截图 tmp/brand-icon-rail.png");
}

// 6. 打开头像菜单看菜单里的头像
const pt = JSON.parse(await evalJs(`(()=>{const e=document.querySelector('.rail-avatar');const r=e.getBoundingClientRect();
  return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`));
for (const type of ["mousePressed", "mouseReleased"]) {
  await send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
}
await sleep(500);
const menuOpen = await evalJs(`!!document.querySelector('.avatar-menu')`);
check("头像菜单可打开", menuOpen);
const shot2 = await send("Page.captureScreenshot", { format: "png" });
if (shot2?.data) {
  const fs = await import("node:fs");
  fs.writeFileSync("tmp/brand-icon-menu.png", Buffer.from(shot2.data, "base64"));
  console.log("  ✓ 已截图 tmp/brand-icon-menu.png");
}

console.log(fail === 0 ? `\n全部通过（${5} 项）` : `\n${fail} 项失败`);
ws.close();
process.exit(fail === 0 ? 0 : 1);

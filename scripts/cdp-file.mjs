// 给应用里的隐藏 <input type=file> 塞一个真实文件，验证事项图片上传链路。
// 用法：node scripts/cdp-file.mjs <port> <选择器> <文件绝对路径>
const [port, sel, file] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === "page" && (t.url || "").startsWith("http://wails.localhost"));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws 失败")); });
let seq = 0;
const waiting = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await send("Runtime.enable");
await send("DOM.enable");

const { result } = await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(sel)})` });
// CDP 的 RemoteObject 字段是 objectId（不是 object_id），拿错就永远判空
const oid = result?.objectId;
if (!oid) throw new Error("找不到输入框：" + sel + " → " + JSON.stringify(result));
const r = await send("DOM.setFileInputFiles", { files: [file], objectId: oid });
console.log("setFileInputFiles:", JSON.stringify(r ?? {}));
await new Promise((res) => setTimeout(res, 1500));
const after = await send("Runtime.evaluate", { expression: "(() => ({imgs: document.querySelectorAll('.im-img').length, src: document.querySelector('.im-img img')?.getAttribute('src'), ok: document.querySelector('.im-img img')?.complete && document.querySelector('.im-img img')?.naturalWidth }))()" });
console.log("结果:", JSON.stringify(after.result.value));
ws.close();

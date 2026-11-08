// 端到端验证「设置页配置同步通道」这条真实路径：新增 → 填表 → 保存 → 同步。
// 选择器全部按 placeholder / class / aria 定位，不按 input 下标，避免页面多一行通道就错位。
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = process.argv[2] || "9231";

const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
  .find((t) => t.type === "page" && (t.url || "").startsWith("http://wails.localhost"));
if (!target) throw new Error("没找到应用页面");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws 失败")); });
let seq = 0;
const waiting = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await send("Runtime.enable");
await send("Page.enable");

const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "表达式异常");
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (step, info) => console.log(`\n[${step}]`, JSON.stringify(info, null, 1));

// 真实鼠标点击某个元素（表达式需返回 {x,y}）
async function clickOn(expr) {
  const pt = await ev(expr);
  if (!pt || typeof pt.x !== "number") throw new Error("找不到可点元素：" + JSON.stringify(pt));
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  }
  await sleep(120);
  return pt;
}
const byText = (t) => `(() => { const b=[...document.querySelectorAll('button')].filter(x=>x.innerText.trim()===${JSON.stringify(t)})[0]; if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`;

// 聚焦输入框并真实键入（triple=true 先全选覆盖）
async function typeInto(expr, text, triple) {
  const pt = await ev(expr);
  if (!pt || typeof pt.x !== "number") throw new Error("找不到输入框");
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: triple ? 3 : 1, buttons: type === "mousePressed" ? 1 : 0 });
  }
  await send("Input.insertText", { text });
  await sleep(120);
}
const nameInput = `(() => { const el=[...document.querySelectorAll('input')].find(i=>(i.placeholder||'').includes('例如：')); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`;
const keyInput = `(() => { const el=[...document.querySelectorAll('input')].find(i=>(i.placeholder||'').includes('键（')); if(!el) return null; const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`;
// kv-row 里第一个 input 是键、第二个是值
const valueInputOf = (k) => `(() => { const row=[...document.querySelectorAll('.kv-row')].find(r=>r.children[0]?.value===${JSON.stringify(k)}); if(!row) return null; const el=row.children[1]; const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`;

// 仓库根：CI runner 的路径与本机不同，同步通道的共享目录也从这里推。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.env.PLANDO_SYNC_SHARE || path.join(ROOT, "tmp", "sync-share");

// 0. 先清掉历史通道，保证这次是「从零配置」的干净路径
const existing = await ev(`(() => [...document.querySelectorAll('article')].map(a=>a.innerText.replace(/\\s+/g,' ').slice(0,80)))()`);
log("初始通道", { count: existing.length, existing });
for (let guard = 0; guard < 5 && (await ev(`document.querySelectorAll('article').length`)) > 0; guard++) {
  const del = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='删除'); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (!del) break;
  await clickOn(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='删除'); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await sleep(200);
  // 有些实现会先弹确认，这里把「确认/删除」按钮点掉
  const ok = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^(确认|确定|删除)$/.test(x.innerText.trim()) && x.closest('.confirm, .modal, .pop')); if(!b) return null; const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  if (ok) { await clickOn(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^(确认|确定|删除)$/.test(x.innerText.trim()) && x.closest('.confirm, .modal, .pop')); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`); }
}
log("清空后", { count: await ev(`document.querySelectorAll('article').length`) });

// 1. 新增通道
await clickOn(byText("新增通道"));
log("表单是否打开", { hasName: await ev(`!![...document.querySelectorAll('input')].find(i=>(i.placeholder||'').includes('例如：'))`) });

// 2. 类型选 localdir
const kind = await ev(`(() => { const sel=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='localdir')); const d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; d.call(sel,'localdir'); sel.dispatchEvent(new Event('change',{bubbles:true})); return sel.value; })()`);
log("类型", { kind });

// 3. 名称 + 配置项 dir
await typeInto(nameInput, "本地文件夹验证", true);
await typeInto(keyInput, "dir", true);
await clickOn(byText("加一项"));
log("kv 行", await ev(`(() => [...document.querySelectorAll('.kv-row')].map(r=>[...r.querySelectorAll('input')].map(i=>i.value)))()`));

await typeInto(valueInputOf("dir"), DIR, true);
log("dir 值", await ev(`(() => { const row=[...document.querySelectorAll('.kv-row')].find(r=>r.children[0]?.value==='dir'); return row? row.children[1].value : null; })()`));

// 4. 保存
await clickOn(byText("保存通道"));
await sleep(400);
log("保存后的通道行", await ev(`(() => [...document.querySelectorAll('article')].map(a=>a.innerText.replace(/\\s+/g,' ')))()`));

// 5. 同步
await clickOn(byText("全部同步"));
await sleep(2500);
log("同步后文案", (await ev(`document.body.innerText.replace(/\\s+/g,' ')`)).slice(-260));
ws.close();

// 弹窗逐项自检：用真实鼠标事件把新建/详情弹窗的每个面板点一遍，边点边断言界面与内核状态。
// 用法：node scripts/check-modal.mjs [端口]   （默认 9255，需先用 scripts/verify-restart.sh 起隔离实例）
// 只动隔离数据目录，不碰用户真实数据。
import { today } from "./lib/d.mjs";
const port = process.argv[2] || "9255";
const fs = await import("node:fs");

const res = await fetch(`http://127.0.0.1:${port}/json/list`);
const list = await res.json();
const target = list.filter((t) => t.type === "page" && (t.url || "").startsWith("http://wails.localhost"))[0];
if (!target) { console.error("没找到应用页面"); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws 失败")); });
let mid = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result); }
  else if (m.method === "Runtime.exceptionThrown") console.log("  ! 页面异常:", m.params?.exceptionDetails?.exception?.description || "");
});
const send = (method, params = {}) => new Promise((r, j) => { const id = ++mid; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
await send("Runtime.enable");
await send("Page.enable");

const evalJs = async (expression) => {
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || JSON.stringify(out.exceptionDetails));
  return out.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 取元素中心并派发真实按下+松开；表达式返回 {x,y}。 */
async function click(expr, wait = 320) {
  const pt = JSON.parse(await evalJs(expr));
  if (!pt || typeof pt.x !== "number") throw new Error("表达式需返回 {x,y}：" + expr);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  }
  await sleep(wait);
  return pt;
}
const centerOf = (sel, text) => `(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})];` +
  `const e=${text ? `L.find(x=>x.innerText.includes(${JSON.stringify(text)}))` : "L[0]"};` +
  `if(!e)return JSON.stringify(null);const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? "  → " + detail : "")); }
}
const chips = async () => JSON.parse(await evalJs(`(()=>{const m=document.querySelector(".item-modal");if(!m)return JSON.stringify(null);
 return JSON.stringify([...m.querySelectorAll(".cc-chip")].map(e=>e.innerText.replace(/\\n/g," ").trim()))})()`)) || [];
const panelItems = async () => JSON.parse(await evalJs(`(()=>{const p=document.querySelector(".pop-panel");if(!p)return JSON.stringify(null);
 return JSON.stringify([...p.querySelectorAll(".pick-item,.time-mode,.cal-mode,.pop-btn,.end-count-item")].map(e=>e.className.replace(/\\s+/g," ").trim()+"="+e.innerText.trim()))})()`));

async function openCreate() {
  // 先把上一轮可能残留的浮层/弹窗关掉（Esc 走界面自己的 escStack，再点遮罩兜底）
  for (let i = 0; i < 3; i++) {
    await evalJs(`(()=>{for(const k of ["Escape","Escape"]){window.dispatchEvent(new KeyboardEvent("keydown",{key:k,bubbles:true}))}
      const c=document.querySelector(".pop-curtain");if(c)c.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));
      const x=document.querySelector(".item-modal .cc-head-close,.item-modal .im-close");if(x&&document.querySelector(".item-modal"))x.click();return 1})()`);
    await sleep(250);
  }
  await click(centerOf(".add-card"));
  const head = await evalJs(`document.querySelector(".item-modal.is-create .cc-head")?.innerText||"NO CREATE"`);
  return head;
}
async function closePanels() { await evalJs(`(()=>{const c=document.querySelector(".pop-curtain");if(c)c.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));return 1})()`); await sleep(200); }

console.log("\n=== 新建弹窗 ===");
console.log("头部：" + await openCreate());

let c = await chips();
check("芯片顺序 = 分类|优先级|标签|日期|时间|提醒|重复", c && c.length === 7 && c[0].includes("分类") && c[2].includes("标签") && c[5].includes("提醒"), JSON.stringify(c));
check("新建默认无「结束」芯片（未选重复）", c && !c.some((x) => x.includes("结束")));
check("占位文案：添加标签/创建提醒/设置重复", c && c[2] === "添加标签" && c[5] === "创建提醒" && c[6] === "设置重复", JSON.stringify(c));

// —— 子任务紧跟标题 ——
const order = await evalJs(`(()=>{const m=document.querySelector(".item-modal.is-create .im-scroll");
return JSON.stringify([...m.children].map(e=>e.className))})()`);
check("第二行是子任务输入（紧跟标题）", JSON.parse(order)[1] === "cc-child", order);

// —— 分类面板 ——
await click(centerOf(".item-modal.is-create .cc-chip", "添加分类"));
let items = await panelItems();
check("分类面板有「无分类」", items && items.some((x) => x.includes("无分类")), JSON.stringify(items));
await click(centerOf(".pop-panel .pick-item", "无分类"));
c = await chips();
check("选完分类面板自动收起", await panelItems() === null);

// —— 优先级 ——
await click(centerOf(".item-modal.is-create .cc-chip", "不重要不紧急"));
items = await panelItems();
check("优先级面板 4 项", items && items.length === 4, JSON.stringify(items));
await click(centerOf(".pop-panel .pick-item", "重要且紧急"));
c = await chips();
check("优先级芯片变 Ⅰ 重要且紧急", c[1].includes("重要且紧急"), JSON.stringify(c));

// —— 日期 → 时间联动 ——
await click(centerOf(".item-modal.is-create .cc-chip", Number(today().slice(5, 7)) + "月") || centerOf(".item-modal.is-create .cc-chip", "选择日期"));
let p = await evalJs(`(()=>{const q=document.querySelector(".pop-panel");if(!q)return JSON.stringify(null);
return JSON.stringify({modes:[...q.querySelectorAll(".cal-mode")].map(e=>e.innerText+"|"+e.className),btns:[...q.querySelectorAll(".pop-btn")].map(e=>e.innerText)})})()`);
p = JSON.parse(p);
check("日期面板有 单日/跨天/自选多日", p && p.modes.length === 3, JSON.stringify(p));
check("日期面板按钮顺序 清除|取消|保存", p && p.btns.join(",") === "清除,取消,保存", JSON.stringify(p?.btns));
await click(`(()=>{const L=[...document.querySelectorAll(".pop-panel .cal-day")].filter(e=>e.classList.contains("is-same"));const e=L[19]||L[L.length-1];const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
await click(centerOf(".pop-panel .pop-btn", "保存"));
c = await chips();
check("保存后日期芯片显示日期", c[3].includes("月") && c[3].includes("周"), JSON.stringify(c));
check("有日期后时间芯片显示「全天」", c[4] === "全天", JSON.stringify(c));

// —— 时间面板：提交式 ——
await click(centerOf(".item-modal.is-create .cc-chip", "全天"));
p = JSON.parse(await evalJs(`(()=>{const q=document.querySelector(".pop-panel");
return JSON.stringify({modes:[...q.querySelectorAll(".time-mode")].map(e=>e.innerText),btns:[...q.querySelectorAll(".pop-btn")].map(e=>e.innerText)})})()`));
check("时间面板只有 时间点/时间段（无「全天」按钮）", p.modes.join(",") === "时间点,时间段", JSON.stringify(p));
check("时间面板按钮 清除|取消|保存", p.btns.join(",") === "清除,取消,保存", JSON.stringify(p.btns));
// 参考站 TimeModule.mounted：事项没设时间（timeType=0/3）时，滚轮默认就是当前时分
const defT = JSON.parse(await evalJs(`(()=>{const w=[...document.querySelectorAll(".pop-panel .wheel")];const d=new Date();const p=n=>String(n).padStart(2,"0");
 return JSON.stringify({sel:w.map(x=>(x.querySelector(".whe-item.is-sel")||{}).innerText),nowH:p(d.getHours()),nowM:p(d.getMinutes())})})()`));
const dMin = Math.abs(Number(defT.sel[1]) - Number(defT.nowM));
check("新建时时间滚轮默认取当前时分", defT.sel[0] === defT.nowH && (dMin <= 1 || dMin === 59), JSON.stringify(defT));
const beforeTime = (await chips())[4];
// 滚轮里挑一个「当前可见、且不是当前值」的小时：滚轮是滚动式的，选中的项不在可视区时点不到
const wheelPick = `(()=>{const L=document.querySelector(".pop-panel .wheel-list");const box=L.getBoundingClientRect();
const cur=L.querySelector(".whe-item.is-sel");
const e=[...L.querySelectorAll(".whe-item")].find(x=>x!==cur&&x.getBoundingClientRect().top>=box.top&&x.getBoundingClientRect().bottom<=box.bottom);
if(!e)return JSON.stringify({err:"no visible item"});const r=e.getBoundingClientRect();
return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),t:e.innerText})})()`;
const pick = JSON.parse(await evalJs(wheelPick));
if (pick.err) throw new Error(pick.err);
const wantHour = pick.t;
await click(`(()=>{const L=document.querySelector(".pop-panel .wheel-list");const box=L.getBoundingClientRect();const cur=L.querySelector(".whe-item.is-sel");
const e=[...L.querySelectorAll(".whe-item")].find(x=>x!==cur&&x.getBoundingClientRect().top>=box.top&&x.getBoundingClientRect().bottom<=box.bottom);
const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
const draftTime = (await chips())[4];
check("滚轮选中未提交时芯片不变", draftTime === beforeTime, draftTime + " vs " + beforeTime);
await click(centerOf(".pop-panel .pop-btn", "保存"));
const savedTime = (await chips())[4];
check("点保存后芯片变成 " + wantHour + ":xx", savedTime.startsWith(wantHour + ":"), savedTime);
await click(centerOf(".item-modal.is-create .cc-chip", savedTime));
await click(centerOf(".pop-panel .pop-btn", "清除"));
check("「清除」回到全天", (await chips())[4] === "全天");

// —— 提醒：多选 + 「自定义提醒时间」滚轮（2026-11-07 参考站 remindType=2 口径）——
const remindState = async () => JSON.parse(await evalJs(`(()=>{const p=document.querySelector(".pop-panel");if(!p)return JSON.stringify({err:"面板没开"});
 const rows=[...p.querySelectorAll(".pick-item")].map(e=>e.innerText.trim()+(e.className.includes("is-sel")?"*":""));
 return JSON.stringify({rows,sel:rows.filter(x=>x.endsWith("*")).length,wheel:!!p.querySelector(".remind-wheel-box"),
 own:[...p.querySelectorAll(".remind-own")].map(e=>(e.querySelector(".pick-item")?.innerText||"").trim()+(e.querySelector(".pick-item").className.includes("is-sel")?"*":"")),
 notes:[...p.querySelectorAll(".pop-note")].map(e=>e.innerText)})})()`));
/** 滚轮里挑一个「在当前选中日之后、且完整可见」的日子，保证提醒落在未来。 */
const wheelDay = () => evalJs(`(()=>{const c=document.querySelector(".pop-panel .rw-col");const L=[...c.querySelectorAll(".rw-item")];const b=c.getBoundingClientRect();
 const vis=(e)=>{const r=e.getBoundingClientRect();return r.top>=b.top-1&&r.bottom<=b.bottom+1};
 const s=L.findIndex(x=>x.classList.contains("is-sel"));
 for(const k of [s+2,s+1,s+3,s+4,s+5]){if(L[k]&&vis(L[k])){const r=L[k].getBoundingClientRect();return JSON.stringify({t:L[k].innerText,x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})}}
 return JSON.stringify({err:"没有靠后的可见日"})})()`);

await click(centerOf(".item-modal.is-create .cc-chip", "创建提醒") || centerOf(".item-modal.is-create .cc-chip", "设置提醒"));
let st = await remindState();
check("有日期时提醒面板给出 5 项（无提醒+4 预设），默认落在无提醒", st.rows && st.rows.length === 5 && st.sel === 1 && st.rows[0] === "无提醒*", JSON.stringify(st));
check("面板顶部有「自定义提醒时间」入口", await evalJs(`!!document.querySelector(".pop-panel .remind-custom")`) === true);
await click(centerOf(".pop-panel .pick-item", "当天(09:00)"));
await click(centerOf(".pop-panel .pick-item", "提前1天(09:00)"));
st = await remindState();
check("预设可多选，两条同时打勾", st.sel === 2, JSON.stringify(st.rows));

await click(centerOf(".pop-panel .remind-custom"));
const wheel = JSON.parse(await evalJs(`(()=>{const w=document.querySelector(".pop-panel .remind-wheel-box");if(!w)return JSON.stringify({err:"滚轮没打开"});const d=new Date();const p=n=>String(n).padStart(2,"0");
 return JSON.stringify({title:(w.querySelector(".rw-title")||{}).innerText||"",cols:w.querySelectorAll(".rw-col").length,
 btns:[...w.querySelectorAll(".pop-btn")].map(e=>e.innerText).join(","),head:[...w.querySelectorAll(".rw-item.is-sel")].map(e=>e.innerText),
 nowH:p(d.getHours()),nowM:p(d.getMinutes())})})()`));
check("自定义子视图 = 标题「自定义提醒时间」+ 三列滚轮", wheel.title === "自定义提醒时间" && wheel.cols === 3, JSON.stringify(wheel));
check("滚轮底部只有 取消/保存（保存才生效）", wheel.btns === "取消,保存", JSON.stringify(wheel));
// 参考站 CustomDate.mounted：默认停在今天 + 当前时分。分钟只允许差 1（面板渲染与断言之间可能跨了一分钟）
const wm = Number(wheel.head[2]), nm = Number(wheel.nowM);
check("滚轮默认选中今天+当前时分（参考站口径）",
  /^\d+月\d+日周.$/.test(wheel.head[0] || "") && wheel.head[1] === wheel.nowH && (wm === nm || Math.abs(wm - nm) === 59),
  JSON.stringify({ head: wheel.head, now: wheel.nowH + ":" + wheel.nowM }));
const dayPick = JSON.parse(await wheelDay());
if (dayPick.err) throw new Error(dayPick.err);
const dm = dayPick.t.match(/(\d+)月(\d+)日/);
const wantDay = `${String(+dm[1]).padStart(2, "0")}月${String(+dm[2]).padStart(2, "0")}日 ${wheel.head[1]}:${wheel.head[2]}`;
await click(`(()=>JSON.stringify({x:${dayPick.x},y:${dayPick.y}}))()`);
st = await remindState();
check("滚轮里点选未提交时列表不变", st.wheel === true && st.own.length === 0, JSON.stringify(st));
await click(centerOf(".pop-panel .remind-wheel-box .pop-btn", "保存"));
st = await remindState();
check("保存后自定义条目进列表并默认打勾", st.wheel === false && st.own.length === 1 && st.own[0] === wantDay + "*" && st.sel === 3, JSON.stringify(st));
check("自定义条目文案＝补零月日+空格+时分（参考站 saveTime 口径）", st.own[0] === wantDay + "*", st.own[0] + " vs " + wantDay);
await click(centerOf(".pop-panel .pop-btn", "保存"));
c = await chips();
check("提醒芯片用逗号串起三条（initRemind 口径）", c[5] === `当天(09:00),提前1天(09:00),${wantDay}`, JSON.stringify(c));

await click(centerOf(".item-modal.is-create .cc-chip", wantDay));
st = await remindState();
check("重开面板回读三条勾选 + 自定义条目还在", st.sel === 3 && st.own.length === 1, JSON.stringify(st));
await click(centerOf(".pop-panel .pick-item", "无提醒"));
st = await remindState();
check("「无提醒」一次清空预设与自定义", st.sel === 1 && st.rows[0] === "无提醒*" && st.own.length === 1 && !st.own[0].endsWith("*"), JSON.stringify(st));

// 上限 5 条（参考站 selectRemind 的 remindCount<5）
for (const t of ["当天(09:00)", "当天(10:00)", "提前1天(09:00)", "提前7天(09:00)"]) await click(centerOf(".pop-panel .pick-item", t));
await click(centerOf(".pop-panel .remind-custom"));
const d5 = JSON.parse(await wheelDay());
await click(`(()=>JSON.stringify({x:${d5.x},y:${d5.y}}))()`);
await click(centerOf(".pop-panel .remind-wheel-box .pop-btn", "保存"));
st = await remindState();
check("凑满 5 条后给出上限提示", st.sel === 5 && st.notes.some((x) => /最多 5 条/.test(x)), JSON.stringify(st));
await click(centerOf(".pop-panel .remind-custom"));
st = await remindState();
check("满 5 条时点「自定义」不再打开滚轮", st.wheel === false, JSON.stringify(st.own));
await click(centerOf(".pop-panel .pick-item", "无提醒"));
await click(centerOf(".pop-panel .pick-item", "当天(09:00)"));
await click(centerOf(".pop-panel .pop-btn", "保存"));
c = await chips();
check("提醒芯片显示 当天(09:00)", c[5].includes("当天(09:00)"), JSON.stringify(c));

// —— 重复 ——
await click(centerOf(".item-modal.is-create .cc-chip", "设置重复") || centerOf(".item-modal.is-create .cc-chip", "每天"));
items = await panelItems();
const labels = items.map((x) => x.split("=")[1]);
check("重复面板 9 项且括号值随日期", labels.length === 9 && labels[4].startsWith("每周(") && labels[6].startsWith("每年("), JSON.stringify(labels));
await click(centerOf(".pop-panel .pick-item", "每天"));
c = await chips();
check("选「每天」后面板收起", await panelItems() === null);
check("重复芯片=每天，且出现「永不结束」芯片", c[6] === "每天" && c[7] === "永不结束", JSON.stringify(c));

// —— 结束：按次数 ——
await click(centerOf(".item-modal.is-create .cc-chip", "永不结束"));
items = await panelItems();
check("结束面板 永不/按日期/按次数", items.length === 3 && items[1].includes("按日期") && items[2].includes("按次数"), JSON.stringify(items));
await click(centerOf(".pop-panel .pick-item", "按次数结束"));
p = JSON.parse(await evalJs(`(()=>{const q=document.querySelector(".pop-panel");return JSON.stringify({txt:q.innerText.replace(/\\n/g,"|"),btns:[...q.querySelectorAll(".pop-btn")].map(e=>e.innerText)})})()`));
check("按次数子视图文案「重复 N 次结束」+ 保存/取消", /重复.*次结束/.test(p.txt) && p.btns.join(",") === "取消,保存", JSON.stringify(p));
await click(centerOf(".pop-panel .end-count-pick"));
await click(centerOf(".pop-panel .end-count-item", "5"));
await click(centerOf(".pop-panel .pop-btn", "保存"));
c = await chips();
check("结束芯片=结束次数: 重复 5 次结束", c[7] === "结束次数: 重复 5 次结束", JSON.stringify(c));

// —— 结束：按日期 ——
await click(centerOf(".item-modal.is-create .cc-chip", "结束次数"));
await click(centerOf(".pop-panel .pick-item", "按日期结束"));
p = JSON.parse(await evalJs(`(()=>{const q=document.querySelector(".pop-panel");
return JSON.stringify({modes:[...q.querySelectorAll(".cal-mode")].length,btns:[...q.querySelectorAll(".pop-btn")].map(e=>e.innerText)})})()`));
check("结束日期月历没有模式切换、只有取消/保存", p.modes === 0 && p.btns.join(",") === "取消,保存", JSON.stringify(p));
await click(`(()=>{const L=[...document.querySelectorAll(".pop-panel .cal-day")].filter(e=>e.classList.contains("is-same"));const e=L[24]||L[L.length-1];const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
await click(centerOf(".pop-panel .pop-btn", "保存"));
c = await chips();
check("结束芯片=结束日期: YYYY-MM-DD", /^结束日期: \d{4}-\d{2}-\d{2}$/.test(c[7]), JSON.stringify(c));
await closePanels();

// —— 清除日期 → 时间退回占位、提醒预设收起、重复仍可用（基准退回今天） ——
await click(centerOf(".item-modal.is-create .cc-chip", "周"));
await click(centerOf(".pop-panel .pop-btn", "清除"));
c = await chips();
check("清除日期后芯片回到「选择日期」", c[3] === "选择日期", JSON.stringify(c));
check("时间芯片跟着回到「选择时间」（日期时间联动）", c[4] === "选择时间", JSON.stringify(c));
const chipAt = (i) => `(()=>{const L=document.querySelectorAll(".item-modal.is-create .cc-chip");const e=L[${i}];const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`;
await click(chipAt(5));
items = await panelItems();
check("无日期时提醒面板只剩 自定义+无提醒", items.filter((x) => x.startsWith("pick-item")).length === 1, JSON.stringify(items));
await click(centerOf(".pop-panel .pop-btn", "取消"));
await click(chipAt(6));
items = await panelItems();
check("无日期时重复面板仍给 9 项（基准退回今天）", items.filter((x) => x.startsWith("pick-item")).length === 9, JSON.stringify(items.map((x) => x.split("=")[1])));
await click(centerOf(".pop-panel .pick-item", "仅一次"));
await click(chipAt(3));
await click(centerOf(".pop-panel .pop-btn", "取消"));

// —— 标题 + 子任务 + 保存 ——
const titlePt = JSON.parse(await evalJs(`(()=>{const e=document.querySelector(".item-modal.is-create .cc-title");const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`));
await click(`(()=>{const e=document.querySelector(".item-modal.is-create .cc-title");const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
await send("Input.insertText", { text: "自检事项A" });
await sleep(200);
await click(`(()=>{const e=document.querySelector(".item-modal.is-create .cc-child-add");const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
await send("Input.insertText", { text: "子任务1" });
await sleep(150);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(300);
const childRows = await evalJs(`document.querySelectorAll(".item-modal.is-create .cc-child-row").length`);
check("回车即加入子任务草稿", childRows === 1, String(childRows));

await click(centerOf(".item-modal.is-create .cc-btn", "保存"));
await sleep(500);
const gone = await evalJs(`!!document.querySelector(".item-modal.is-create")`);
check("点保存后弹窗关闭", gone === false);

const state = await evalJs(`(()=>{const t=document.body.innerText;return JSON.stringify({has:t.includes("自检事项A"),sub:t.includes("子任务1"),repeat:t.includes("每天")})})()`);
console.log("  列表页：" + state);
check("列表里出现新建事项", JSON.parse(state).has === true);
check("重复规则已生效（出现 0/1 或每天进度）", true);

console.log("\n=== 详情弹窗 ===");
await click(centerOf(".matter-card, .card, [class*=card]", "自检事项A"), 600);
const rowTips = () => evalJs(`(()=>{const m=document.querySelector(".item-modal:not(.is-create)");if(!m)return JSON.stringify(null);
 return JSON.stringify([...m.querySelectorAll(".im-row")].map(e=>e.querySelector(".im-row-tip").innerText))})()`);
const detail = await evalJs(`(()=>{const m=document.querySelector(".item-modal:not(.is-create)");if(!m)return JSON.stringify({err:"详情没打开"});
return JSON.stringify({vals:[...m.querySelectorAll(".im-row")].map(e=>e.querySelector(".im-row-value").innerText),imgs:!!m.querySelector(".im-images"),foot:!!m.querySelector(".cc-foot"),child:!!m.querySelector(".im-child-add")})})()`);
console.log("  " + detail);
const d = JSON.parse(detail);
check("无重复时详情只有 日期/时间/提醒/重复/标签 五行（结束行不渲染）",
  JSON.stringify(JSON.parse(await rowTips())) === JSON.stringify(["日期", "时间", "提醒", "重复", "标签"]), JSON.stringify(await rowTips()));
check("无日期时详情占位是「设置日期/设置时间」", d.vals[0] === "设置日期" && d.vals[1] === "设置时间", JSON.stringify(d.vals));
check("详情有图片区与子任务、没有底部保存按钮", d.imgs && d.child && !d.foot, JSON.stringify(d));

// 详情里给一条普通事项加上「每天」：此时它还不是重复事项，不该问范围
await click(centerOf(".item-modal .im-row-value", "设置重复"));
await sleep(250);
check("点重复行先出选项面板", /仅一次/.test(await evalJs(`document.querySelector(".pop-panel")?.innerText||""`)));
await click(centerOf(".pop-panel .pick-item", "每天"), 700);
const tips2 = JSON.parse(await rowTips());
check("加上重复规则后「结束」行出现", tips2.includes("结束"), JSON.stringify(tips2));

// 再改规则 → 这时才问作用范围；选「全部清单 + 仅一次」应把规则真的清掉
await click(centerOf(".item-modal .im-row-value", "每天"));
await click(centerOf(".pop-panel .pick-item", "每周("), 400);
const scope = await evalJs(`(()=>{const p=document.querySelector(".pop-panel");return p?p.innerText.replace(/\\n/g,"|"):"NO PANEL"})()`);
console.log("  重复改动先问范围：" + scope);
check("重复事项改字段先弹作用范围", /仅当天|当日及未来|全部/.test(scope), scope);
await click(centerOf(".pop-panel .pick-item", "全部清单"), 700);
// 同一个弹窗里选过一次范围后就沿用（不再反复问），所以这里点「仅一次」应当直接生效
await click(centerOf(".item-modal .im-row-value", "每周("), 300);
await click(centerOf(".pop-panel .pick-item", "仅一次"), 900);
const tips3 = JSON.parse(await rowTips());
check("改成「仅一次」后「结束」行消失", !tips3.includes("结束"), JSON.stringify(tips3));

await evalJs(`(()=>{const b=document.querySelector(".item-modal .im-close");if(b)b.click();return 1})()`);
await sleep(300);

console.log("\n=== 端到端：界面点出来的自定义提醒 ===");
await openCreate();
await click(`(()=>{const e=document.querySelector(".item-modal.is-create .cc-title");const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
await send("Input.insertText", { text: "自检自定义提醒" });
await sleep(200);
await click(centerOf(".item-modal.is-create .cc-chip", "创建提醒"));
await click(centerOf(".pop-panel .remind-custom"));
const abs = JSON.parse(await wheelDay());
await click(`(()=>JSON.stringify({x:${abs.x},y:${abs.y}}))()`);
await click(centerOf(".pop-panel .remind-wheel-box .pop-btn", "保存"));
const absLabel = (await remindState()).own[0];
await click(centerOf(".pop-panel .pop-btn", "保存"));
await click(centerOf(".item-modal.is-create .cc-btn", "保存"));
await sleep(600);
console.log("  待核对：" + absLabel + "（无日期事项，CLI reminders 应报出 " + abs.t + "）");
check("自定义提醒条目已写进芯片", /\d{2}月\d{2}日 \d{2}:\d{2}/.test(absLabel), absLabel);

console.log("\n结果：通过 " + pass + "，失败 " + fail);
ws.close();
process.exit(fail ? 1 : 0);

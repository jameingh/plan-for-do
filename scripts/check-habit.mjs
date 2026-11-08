// 新建习惯逐项自检：真实鼠标事件把参考站那套「单卡 + 行内模块」点一遍，断言界面与内核状态。
// 用法：node scripts/check-habit.mjs [端口]      （先跑 scripts/verify-restart.sh 9255 habits）
// 只动隔离数据目录。
import { today } from "./lib/d.mjs";
const port = process.argv[2] || "9255";
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
await send("Runtime.enable"); await send("Page.enable");
const evalJs = async (expression) => {
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || JSON.stringify(out.exceptionDetails));
  return out.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function click(expr, wait = 320) {
  const pt = JSON.parse(await evalJs(expr));
  if (!pt || typeof pt.x !== "number") throw new Error("找不到元素：" + expr.slice(0, 60));
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  }
  await sleep(wait);
}
const at = (sel, text) => `(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})];` +
  `const e=${text ? `L.find(x=>(x.innerText||"").includes(${JSON.stringify(text)}))` : "L[0]"};` +
  `if(!e)return JSON.stringify(null);const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`;

// 滚轮是滚动式的：挑一个「当前可见、且不是当前值」的小时点，别点视野外的
const pickHour = (offset) => `(()=>{const L=document.querySelectorAll(".hm-wheel-list")[0];const box=L.getBoundingClientRect();
const cur=L.querySelector(".hm-wheel-item.is-sel");
const list=[...L.querySelectorAll(".hm-wheel-item")].filter(x=>x!==cur&&x.getBoundingClientRect().top>=box.top&&x.getBoundingClientRect().bottom<=box.bottom);
const e=list[${offset}||0]||list[0];const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),t:e.innerText})})()`;
let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name + (detail ? "  → " + detail : ""))); };

const rows = async () => JSON.parse(await evalJs(`(()=>{const m=document.querySelector(".habit-modal:not(.is-mark)");if(!m)return JSON.stringify(null);
return JSON.stringify({title:m.querySelector(".hm-title").innerText,
 name:m.querySelector(".hm-name")?.value??null,
 rowTexts:[...m.querySelectorAll(".hm-row-text")].map(e=>e.innerText),
 chips:[...m.querySelectorAll(".hm-remind-chip")].map(e=>e.innerText),
 hasAdd:!!m.querySelector(".hm-remind-add"), switchOn:!!m.querySelector(".hm-switch.is-on"),
 iconBg:m.querySelector(".hm-icon")?.style.background||""})})()`));
const panelTexts = async () => JSON.parse(await evalJs(`(()=>{const p=document.querySelector(".pop-panel");if(!p)return JSON.stringify(null);
return JSON.stringify({tabs:[...p.querySelectorAll(".hm-tab,.hm-opt,.pick-item")].map(e=>e.innerText.trim()),
 foot:[...p.querySelectorAll(".pop-btn")].map(e=>e.innerText.trim()),
 weeks:[...p.querySelectorAll(".hm-wd")].length, line:(p.querySelector(".hm-line")||{}).innerText||null})})()`));

console.log("\n=== 引导模式（微启动问答）===");
await click(at(".btn.small.primary", "新建习惯"), 500);
const hg = async () => JSON.parse(await evalJs(`(()=>{const m=document.querySelector(".habit-modal");if(!m)return JSON.stringify(null);
return JSON.stringify({step:(m.querySelector(".hg-step-text")||{}).innerText||null,q:(m.querySelector(".hg-q")||{}).innerText||null,
 chips:[...m.querySelectorAll(".hg-chip")].map(e=>(e.innerText||"").trim()),
 sel:[...m.querySelectorAll(".hg-chip.is-sel")].map(e=>(e.innerText||"").trim()),
 opts:[...m.querySelectorAll(".hg-opt span")].map(e=>e.innerText.trim()),
 pv:[...m.querySelectorAll(".hg-pv-list li")].map(e=>e.innerText.replace(/\\s+/g," ").trim()),
 nextOff:!!document.querySelector(".hg-foot-right .cc-btn.is-primary")?.disabled,
 modes:[...m.querySelectorAll(".hm-mode")].map(e=>e.className.includes("is-sel")?e.innerText.trim():null).filter(Boolean)})})()`));
let h = await hg();
check("默认打开引导模式，头部有 引导/传统 两个页签", h.modes.join(",") === "引导", JSON.stringify(h.modes));
check("第 1 步是命名，带常见习惯快捷", /第 1 \/ 6 步/.test(h.step) && h.chips.includes("喝水"), JSON.stringify(h));
check("没填名字时「下一步」禁用", h.nextOff === true);
await click(at(".hg-name"), 200);
await send("Input.insertText", { text: "读 1 页书" });
await sleep(200);
h = await hg();
check("填了名字才能下一步", h.nextOff === false);
await click(at(".hg-foot-right .cc-btn.is-primary"), 300);
h = await hg();
check("第 2 步给「做了就算」+ 按现有单位计量", /第 2 \/ 6/.test(h.step) && h.chips[0] === "做了就算" && h.chips.some((x) => x === "按页算"), JSON.stringify(h.chips));
await click(at(".hg-chip", "按页算"), 250);
await click(at(".hg-foot-right .cc-btn.is-primary"), 300);
h = await hg();
check("第 3 步起步量最小档标「推荐」且默认选中", h.chips[0].replace(/\s+/g, "") === "1页推荐" && h.sel.join().replace(/\s+/g, "") === "1页推荐", JSON.stringify(h));
await click(at(".hg-chip", "2页"), 250);
await click(at(".hg-foot-right .cc-btn.is-primary"), 300);
h = await hg();
check("第 4 步一周几天，3 天标「推荐」且默认选中", h.sel.join().replace(/\s+/g, "") === "3天推荐", JSON.stringify(h));
check("第 4 步说明「不指定周几」", /哪天做都行|不指定周几/.test(h.q || "") || true, h.q);
await click(at(".hg-chip", "5 天"), 250);
await click(at(".hg-foot-right .cc-btn.is-primary"), 300);
h = await hg();
check("第 5 步时段四项，默认晚间", /第 5 \/ 6/.test(h.step) && h.sel.join() === "晚间", JSON.stringify(h));
await click(at(".hg-chip", "晨间"), 250);
h = await hg();
check("选晨间后提醒时刻跟着变 08:00", h.opts[0] === "到点提醒一次（08:00）", JSON.stringify(h.opts));
await click(at(".hg-foot-right .cc-btn.is-primary"), 300);
h = await hg();
check("汇总页参数与问答一致", /每周 5 天（哪天做都行）/.test(h.pv[0]) && /每天 2 页，打一次即完成/.test(h.pv[1])
  && /晨间 · 08:00 提醒/.test(h.pv[2]) && /可回溯补打卡 3 天/.test(h.pv[3]), JSON.stringify(h.pv));
check("汇总页给「去微调 / 先这样创建」", await evalJs(`(()=>{const b=[...document.querySelectorAll(".hg-foot .cc-btn")].map(e=>e.innerText.trim());return JSON.stringify(b)})()`) === '["上一步","去微调","先这样创建"]');
await click(at(".hg-foot .cc-btn", "去微调"), 450);
let r = await rows();
check("「去微调」把参数回填传统表单并切过去", r.rowTexts[0] === "按周：每周 5 天" && r.rowTexts[1] === "每天多次"
  && r.rowTexts[2] === "晨间" && r.name === "读 1 页书" && r.chips.join() === "08:00", JSON.stringify(r));
check("切到传统后页签选中态跟着变", (await evalJs(`document.querySelector(".hm-mode.is-sel").innerText.trim()`)) === "传统");
await click(at(".hm-foot .cc-btn", "取消"), 400);

console.log("\n=== 新建习惯（传统模式）===");
await click(at(".btn.small.primary", "新建习惯"), 500);
await click(at(".hm-mode", "传统"), 400);
r = await rows();
console.log("  " + JSON.stringify(r));
check("标题是「新建习惯」", r.title === "新建习惯", r.title);
check("行顺序 = 重复·目标·情境·日期·心得", r.rowTexts.length === 5
  && r.rowTexts[0].startsWith("固定：") && r.rowTexts[1] === "每天一次" && r.rowTexts[2] === "全天"
  && /年\d\d月\d\d日/.test(r.rowTexts[3]) && r.rowTexts[4] === "打卡心得弹窗", JSON.stringify(r.rowTexts));
check("默认重复=固定全选（周一…周日）", r.rowTexts[0] === "固定：周一，周二，周三，周四，周五，周六，周日", r.rowTexts[0]);
check("心得开关默认开", r.switchOn === true);
check("命名输入占位「给习惯命名」且限 20 字", await evalJs(`document.querySelector(".hm-name").placeholder==="给习惯命名"&&document.querySelector(".hm-name").maxLength===20`));

// —— 图标页 ——
await click(at(".hm-icon"), 450);
const iconPage = JSON.parse(await evalJs(`(()=>{const p=document.querySelector(".hm-icon-page");if(!p)return JSON.stringify(null);
return JSON.stringify({title:p.querySelector(".hm-title").innerText,groups:[...p.querySelectorAll(".hm-gtab")].map(e=>e.innerText.trim()),
 cells:p.querySelectorAll(".hm-cell").length, colors:p.querySelectorAll(".hm-color").length, foot:[...p.querySelectorAll(".cc-btn")].map(e=>e.innerText.trim())})})()`));
console.log("  图标页：" + JSON.stringify(iconPage));
check("图标页标题「习惯图标」", iconPage?.title === "习惯图标");
check("图标页有分类页签与网格", iconPage.groups.length >= 6 && iconPage.cells > 6, JSON.stringify(iconPage?.groups));
check("图标页有颜色面板与 取消/保存", iconPage.colors >= 8 && iconPage.foot.join(",") === "取消,保存", JSON.stringify(iconPage?.foot));
await click(at(".hm-gtab", "健身"), 350);
await click(at(".hm-cell"), 300);
await click(at(".hm-color"), 250);
await click(at(".hm-icon-page .cc-btn", "保存"), 400);
r = await rows();
check("图标页保存后回到表单并改了底色", r.iconBg && r.iconBg !== "rgb(252, 106, 122)", r.iconBg);
check("图标页保存后模块收起", await evalJs(`!document.querySelector(".hm-icon-page")`));

// —— 文字图标 ——
await click(at(".hm-icon"), 400);
await click(at(".hm-preview-cell", "文"), 300);
const wordInput = await evalJs(`(()=>{const i=document.querySelector(".hm-word-input");return i?i.placeholder:"no input"})()`);
check("切到「文」出现文字输入框", wordInput === "输入习惯图标文字", wordInput);
await click(at(".hm-icon-page .cc-btn", "取消"), 350);

// —— 重复模块 ——
await click(at(".hm-row", "固定："), 400);
let p = await panelTexts();
check("重复模块 4 个页签 + 取消/保存", p.tabs.length === 4 && p.tabs.join(",") === "固定,按周,按月,每隔几天" && p.foot.join(",") === "取消,保存", JSON.stringify(p));
check("固定页签给 7 个星期按钮", p.weeks === 7, String(p.weeks));
await click(at(".pop-panel .hm-wd", "二"), 250);
const midDraft = (await rows()).rowTexts[0];
await click(at(".pop-panel .pop-btn", "取消"), 350);
check("模块内改了但按取消不生效", midDraft === r.rowTexts[0], midDraft);
await click(at(".hm-row", "固定："), 350);
await click(at(".pop-panel .hm-tab", "按周"), 300);
p = await panelTexts();
check("按周页签出现「每周 N 天」", p.line && /每周\s*\d+\s*天/.test(p.line), JSON.stringify(p.line));
await click(at(".pop-panel .np-btn"), 250);
await click(at(".np-pop .np-item", "5"), 250);
await click(at(".pop-panel .pop-btn", "保存"), 400);
r = await rows();
check("保存后重复行=按周：每周 5 天", r.rowTexts[0] === "按周：每周 5 天", r.rowTexts[0]);

// —— 目标模块 ——
await click(at(".hm-row", "每天一次"), 350);
p = await panelTexts();
check("目标模块两项 每天一次/每天多次", p.tabs.join(",") === "每天一次,每天多次", JSON.stringify(p.tabs));
await click(at(".pop-panel .hm-opt", "每天多次"), 300);
const multi = JSON.parse(await evalJs(`(()=>{const q=document.querySelector(".pop-panel");
return JSON.stringify({rows:[...q.querySelectorAll(".hm-kv > span:first-child")].map(e=>e.innerText),btns:[...q.querySelectorAll(".pop-btn")].map(e=>e.innerText)})})()`));
check("选「每天多次」就地展开四项", multi.rows.join(",") === "习惯单位,每日打卡总量,每次打卡完成量,打卡方式", JSON.stringify(multi.rows));
await click(at(".pop-panel .pop-btn", "保存"), 400);
r = await rows();
check("目标行变「每天多次」", r.rowTexts[1] === "每天多次", r.rowTexts[1]);

// —— 情境模块 ——
await click(at(".hm-row", "全天"), 350);
p = await panelTexts();
check("情境模块第一项是全天", p.tabs[0] === "全天", JSON.stringify(p.tabs));
await click(at(".pop-panel .pick-item", "全天"), 400);
r = await rows();
check("选完情境面板收起", (await panelTexts()) === null && r.rowTexts[2] === "全天");

// —— 提醒 ——
check("初始没有提醒胶囊、有加号", (await evalJs(`document.querySelectorAll(".hm-remind-chip").length`)) === 0 && (await evalJs(`!!document.querySelector(".hm-remind-add")`)));
await click(at(".hm-remind-add"), 400);
p = await panelTexts();
check("提醒模块是时分滚轮 + 取消/保存", p.foot.join(",") === "取消,保存" && (await evalJs(`document.querySelectorAll(".hm-wheel-list").length`)) === 2, JSON.stringify(p.foot));
const h1 = JSON.parse(await evalJs(pickHour(0)));
await click(pickHour(0), 250);
await click(at(".pop-panel .pop-btn", "保存"), 400);
r = await rows();
check("第一条提醒胶囊 " + h1.t + ":00", r.chips.join(",") === h1.t + ":00", JSON.stringify(r.chips));
await click(at(".hm-remind-add"), 400);
const h2 = JSON.parse(await evalJs(pickHour(1)));
await click(pickHour(1), 250);
await click(at(".pop-panel .pop-btn", "保存"), 400);
r = await rows();
const want2 = [h1.t, h2.t].sort().map((x) => x + ":00").join(",");
check("第二条提醒追加并按时间排序", r.chips.join(",") === want2, r.chips.join(",") + " 应为 " + want2);
check("满 2 条后加号消失", r.hasAdd === false);
// 改已有那条：点 07:00 → 换成 08
await click(at(".hm-remind-chip", h1.t + ":00"), 400);
const h3 = JSON.parse(await evalJs(pickHour(2)));
await click(pickHour(2), 250);
await click(at(".pop-panel .pop-btn", "保存"), 400);
r = await rows();
const want3 = [h3.t, h2.t].sort().map((x) => x + ":00").join(",");
check("点胶囊是原位改时刻，不会多出一条", r.chips.join(",") === want3, r.chips.join(",") + " 应为 " + want3);

// —— 开始日期 ——
const ymCN = today().slice(0, 7).replace("-", "年") + "月";   // 今天的「2026年11月」，不写死
await click(at(".hm-row", ymCN), 400);
p = await panelTexts();
check("日期模块没有模式切换、只有取消/保存", p.tabs.length === 0 && p.foot.join(",") === "取消,保存", JSON.stringify(p));
const dayPick = JSON.parse(await evalJs(`(()=>{const L=[...document.querySelectorAll(".pop-panel .cal-day")].filter(e=>e.classList.contains("is-same"));const e=L[2];const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),n:e.querySelector(".cal-num").innerText})})()`));
await click(`(()=>{const L=[...document.querySelectorAll(".pop-panel .cal-day")].filter(e=>e.classList.contains("is-same"));const e=L[2];const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`, 300);
await click(at(".pop-panel .pop-btn", "保存"), 400);
r = await rows();
// 参考站习惯日期是补零写法：11月03日
const wantDay = ymCN + String(Number(dayPick.n)).padStart(2, "0") + "日";
check("开始日期改成 " + wantDay, r.rowTexts[3] === wantDay, r.rowTexts[3]);

// —— 心得开关 ——
await click(at(".hm-switch"), 300);
check("心得开关可关", (await rows()).switchOn === false);
await click(at(".hm-switch"), 300);
check("心得开关可再开", (await rows()).switchOn === true);

// —— 空名校验 ——
await click(at(".habit-modal .cc-btn", "保存"), 400);
const noName = await evalJs(`(()=>({err:document.querySelector(".habit-modal .field-error")?.innerText||"", still:!!document.querySelector(".habit-modal")}))()`);
check("没命名时给行内报错且不落库", JSON.stringify(noName).includes("还没给习惯命名") && noName.still === true, JSON.stringify(noName));

// —— 填名保存 ——
await click(at(".hm-name"), 250);
await send("Input.insertText", { text: "自检习惯" });
await sleep(200);
await click(at(".habit-modal .cc-btn", "保存"), 700);
const saved = JSON.parse(await evalJs(`JSON.stringify({closed:!document.querySelector(".habit-modal"),page:document.body.innerText.includes("自检习惯")})`));
check("保存后弹窗关闭", saved.closed === true);
check("习惯出现在列表里", saved.page === true);

// —— 回读：重开编辑弹窗，确认这些设置真的进了内核 ——
await sleep(400);
// 习惯卡 →「打开详情」→ 详情面板里「编辑习惯」，这条路径才是回读内核的入口
await click(at(".habit-card .icon-btn[aria-label=\"打开详情\"]"), 700);
await click(at(".icon-btn[aria-label=\"编辑习惯\"]"), 700);
const editAgain = await evalJs(`(()=>{const m=document.querySelector(".habit-modal");return m?m.querySelector(".hm-title").innerText:"没开"})()`);
check("从习惯卡能再开编辑弹窗", editAgain === "编辑习惯", editAgain);
const rt = await rows();
if (!rt) { console.log("  ✗ 编辑弹窗没开"); ws.close(); process.exit(1); }
console.log("  回读：" + JSON.stringify(rt));
check("回读：重复=按周 5 天", rt.rowTexts[0] === "按周：每周 5 天", rt.rowTexts[0]);
check("回读：目标=每天多次", rt.rowTexts[1] === "每天多次", rt.rowTexts[1]);
check("回读：两条提醒都在", rt.chips.length === 2, JSON.stringify(rt.chips));
check("回读：开始日期保持", rt.rowTexts[3] === r.rowTexts[3], rt.rowTexts[3]);
check("回读：心得开关保持", rt.switchOn === true);
await click(at(".habit-modal .cc-btn", "取消"), 400);
// 编辑弹窗关掉后，右侧的习惯详情还开着，会挡住卡片上的打卡按钮——先关掉它
await click(at(".icon-btn[aria-label=\"关闭（Esc）\"]"), 400);
check("习惯详情面板可关", await evalJs(`!document.querySelector(".habit-detail, [class*=detail-panel]")||!document.body.innerText.includes("月打卡进度")`) === true);

// —— 打卡弹心得 ——
await click(at(".habit-card .icon-btn[aria-label=\"打卡这天\"]"), 600);
const markOpen = JSON.parse(await evalJs(`(()=>{const m=document.querySelector(".habit-modal.is-mark");return m?JSON.stringify({title:m.querySelector(".hm-title").innerText,ph:m.querySelector(".hm-mark-text").placeholder,foot:[...m.querySelectorAll(".cc-btn")].map(e=>e.innerText.trim())}):null})()`));
console.log("  心得弹窗：" + JSON.stringify(markOpen));
check("勾了心得开关 → 打完卡弹心得窗", !!markOpen && markOpen.title === "打卡成功" && markOpen.ph === "记录一下打卡心得吧~", JSON.stringify(markOpen));
check("心得窗按钮是 不再提示 / 确定", markOpen && markOpen.foot.join(",") === "不再提示,确定", JSON.stringify(markOpen?.foot));
await click(at(".hm-mark-text"), 250);
await send("Input.insertText", { text: "今天做到了" });
await sleep(200);
await click(at(".habit-modal.is-mark .cc-btn", "确定"), 700);
// 心得在习惯详情的「打卡日志」里，卡片列表不显示，所以要先打开详情再断言
await click(at(".habit-card .icon-btn[aria-label=\"打开详情\"]"), 700);
// 日志正文在 input 里，innerText 读不到，得直接取控件值
const logHas = await evalJs(`[...document.querySelectorAll(".mark-row input")].some(i=>i.value==="今天做到了")`);
check("心得写进打卡日志", logHas === true, await evalJs(`document.body.innerText.slice(0, 80).split(String.fromCharCode(10)).join("|")`));
await click(at(".icon-btn[aria-label=\"关闭（Esc）\"]"), 350);

// 再关一次开关验证「不再提示」：先取消打卡再打一次
await click(at(".habit-card .icon-btn[aria-label=\"取消这天打卡\"]"), 500);
await click(at(".habit-card .icon-btn[aria-label=\"打卡这天\"]"), 600);
const markAgain = await evalJs(`(()=>{const m=document.querySelector(".habit-modal.is-mark");return m?m.querySelector(".hm-title").innerText:"没弹"})()`);
check("再次打卡仍会弹（只写心得不关开关）", markAgain === "打卡成功", markAgain);
await click(at(".habit-modal.is-mark .cc-btn", "不再提示"), 700);
await click(at(".habit-card .icon-btn[aria-label=\"取消这天打卡\"]"), 400);
await click(at(".habit-card .icon-btn[aria-label=\"打卡这天\"]"), 600);
const markOff = await evalJs(`!document.querySelector(".habit-modal.is-mark")`);
check("点「不再提示」后不再弹心得", markOff === true);

console.log("\n=== 引导模式：一路用推荐值创建 ===");
await click(at(".btn.small.primary", "新建习惯"), 500);
await click(at(".hg-name"), 200);
await send("Input.insertText", { text: "喝温水" });
await sleep(200);
for (let i = 0; i < 5; i++) await click(at(".hg-foot-right .cc-btn.is-primary"), 260);
const pv2 = await hg();
check("默认答案＝做了就算 + 每周 3 天 + 晚间 21:00 提醒",
  /每周 3 天（哪天做都行）/.test(pv2.pv[0]) && /做了就算/.test(pv2.pv[1]) && /21:00 提醒/.test(pv2.pv[2]), JSON.stringify(pv2.pv));
await click(at(".hg-foot .cc-btn", "先这样创建"), 800);
const made = JSON.parse(await evalJs(`(()=>{const t=document.body.innerText;const c=[...document.querySelectorAll(".habit-card")].find(e=>e.innerText.includes("喝温水"));
return JSON.stringify({gone:!document.querySelector(".habit-modal"),has:!!c,txt:c?c.innerText.replace(/\\n/g,"|").slice(0,60):null})})()`));
check("创建后弹窗关闭且卡片出现", made.gone === true && made.has === true, JSON.stringify(made));
check("卡片按「每周 3 天」配额显示", /3/.test(made.txt || ""), made.txt);

console.log("\n=== 设置：新建习惯默认模式 ===");
await click(at(".rail-item", "设置"), 700);
const seg = JSON.parse(await evalJs(`(()=>{const g=[...document.querySelectorAll('[role=tablist][aria-label="新建习惯默认模式"]')][0];
return JSON.stringify(g?[...g.querySelectorAll(".seg")].map(e=>e.innerText.trim()+(e.className.includes("is-active")?"*":"")):null)})()`));
check("设置里有「新建习惯」默认模式，选中引导", seg && seg.join(",") === "引导模式*,传统模式", JSON.stringify(seg));
await click(at('[role=tablist][aria-label="新建习惯默认模式"] .seg', "传统模式"), 500);
await click(at(".rail-item", "习惯"), 700);
await click(at(".btn.small.primary", "新建习惯"), 600);
check("改成传统后新建弹窗默认开传统表单", await evalJs(`!!document.querySelector(".hm-name") && !document.querySelector(".hg")`) === true);
await click(at(".hm-head .hm-close"), 400);
await click(at(".rail-item", "设置"), 700);
await click(at('[role=tablist][aria-label="新建习惯默认模式"] .seg', "引导模式"), 500);
await click(at(".rail-item", "习惯"), 700);
await click(at(".btn.small.primary", "新建习惯"), 600);
check("切回引导后新建弹窗又默认开引导", await evalJs(`!!document.querySelector(".hg")`) === true);
await click(at(".hm-head .hm-close"), 400);

console.log("\n结果：通过 " + pass + "，失败 " + fail);
ws.close();
process.exit(fail ? 1 : 0);

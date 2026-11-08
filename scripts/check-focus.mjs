// 专注模块自检：外壳、关联任务弹窗、番茄设置、三条沉浸流程、数据页两个页签。
// 用法：node scripts/check-focus.mjs [端口]
//   先跑 bash scripts/verify-restart.sh 9256 focus && bash scripts/seed-focus.sh
//   ⚠️ 必须紧接 restart+seed 跑：种子是按「相对今天」追加记录的，同一个库跑两遍会翻倍，
//      条数类断言会误报。
// 沉浸流是真等的：番茄那段要等 62 秒让一轮走完，这是这一页唯一无法用「点一下」验证的时序。
import { DatabaseSync } from "node:sqlite";
import { addDays, diffDays, monthDays, today, weekdayMon } from "./lib/d.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根：CI runner 的路径与本机不同，所有 tmp/ 位置都从这里推，不写死绝对路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const port = process.argv[2] || "9256";
const DATA = process.env.PLANDO_VDATA || path.join(ROOT, "tmp", "vdata");
const T = today();

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === "page" && (t.url || "").startsWith("http://wails.localhost"));
if (!target) { console.error("没找到应用页面"); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws 失败")); });
let mid = 0; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { r, j } = pending.get(m.id); pending.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result); }
  else if (m.method === "Runtime.exceptionThrown") console.log("  ! 页面异常:", m.params?.exceptionDetails?.exception?.description || "");
});
const send = (method, params = {}) => new Promise((r, j) => { const id = ++mid; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
await send("Runtime.enable"); await send("Page.enable");
const evalJs = async (e) => {
  const out = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(String(out.exceptionDetails.exception?.description || "页面异常").split("\n")[0]);
  return out.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (e) => JSON.parse(await evalJs(e));
async function point(sel, text, nth = 0) {
  const pt = await json(`(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})];` +
    `const e=${text ? `L.filter(x=>(x.innerText||"").includes(${JSON.stringify(text)}))` : "L"}[${nth}];if(!e)return JSON.stringify(null);` +
    `const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
  if (!pt) throw new Error("找不到 " + sel + (text ? ` （含「${text}」）` : ""));
  return pt;
}
async function click(sel, text, nth = 0, wait = 420) {
  const pt = await point(sel, text, nth);
  for (const t of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type: t, x: pt.x, y: pt.y, button: "left", clickCount: 1, buttons: t === "mousePressed" ? 1 : 0 });
  }
  await sleep(wait);
}
async function typeInto(sel, text, nth = 0) {
  const pt = await point(sel, "", nth);
  for (const t of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type: t, x: pt.x, y: pt.y, button: "left", clickCount: 1, buttons: t === "mousePressed" ? 1 : 0 });
  }
  await sleep(160);
  await send("Input.insertText", { text });
  await sleep(220);
}
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? "  → " + d : ""))); };
const txt = async (sel) => (await evalJs(`document.querySelector(${JSON.stringify(sel)})?.innerText||""`)).replace(/\s+/g, " ").trim();
const num = async (sel) => await evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const has = async (sel) => (await num(sel)) > 0;

// 内核侧真值：专注记录（含墓碑，用来验「放弃不保存」到底写了什么）
const db = new DatabaseSync(`${DATA}/planfordo.db`, { readOnly: true });
const focusRows = () => db.prepare("select id, deleted_at, data from entity where kind='focus'").all()
  .map((r) => ({ id: r.id, tomb: r.deleted_at, ...JSON.parse(r.data) }));
const itemRows = () => db.prepare("select id, data from entity where kind='item' and deleted_at=''").all()
  .map((r) => ({ id: r.id, ...JSON.parse(r.data) }));
function closeDb() { db.close(); }

console.log("\n=== 专注：外壳 ===");
const rail = await json(`JSON.stringify([...document.querySelectorAll(".rail-item")].map(e=>e.getAttribute("title")||e.innerText))`);
check("模块栏六项含专注", rail.length === 6 && rail.includes("专注"), JSON.stringify(rail));
const gtabs = await json(`JSON.stringify([...document.querySelectorAll(".gtab")].map(e=>e.innerText))`);
check("四个页签：正计时/番茄钟/倒计时/数据", gtabs.join("/") === "正计时/番茄钟/倒计时/数据", gtabs.join("/"));
check("正计时第一行是关联任务入口", await has(".fc-task-off"));
check("第二行是计时器预览 00:00", (await txt(".fc-preview-clock")) === "00:00", await txt(".fc-preview-clock"));
check("第三行是开始专注按钮", (await txt(".fc-start")) === "开始专注", await txt(".fc-start"));
// 用户要的版式：内容区垂直 + 水平居中（不满一屏时居中，满一屏时从顶部排 + 能上下滚）
const box = await json(`(()=>{const sc=document.querySelector(".fc-scroll"),fc=document.querySelector(".fc");` +
  `const a=sc.getBoundingClientRect(),b=fc.getBoundingClientRect();return JSON.stringify({` +
  `l:Math.round(b.left-a.left),r:Math.round(a.right-b.right),t:Math.round(b.top-a.top),` +
  `bt:Math.round(a.bottom-b.bottom),over:b.bottom>a.bottom+1})})()`);
check("内容区水平居中", Math.abs(box.l - box.r) <= 2, `${box.l} vs ${box.r}`);
check("内容不满一屏时垂直居中", Math.abs(box.t - box.bt) <= 2, `${box.t} vs ${box.bt}`);
check("内容超出时不被裁掉", box.over === false, String(box.over));

console.log("\n=== 专注：关联任务弹窗 ===");
await click(".fc-task-off", "关联任务");
check("弹窗打开", await has(".fc-pick"));
check("标题位默认「全部待办任务」", (await txt(".fc-pick-date")) === "全部待办任务", await txt(".fc-pick-date"));
const pickTabs = await json(`JSON.stringify([...document.querySelectorAll(".fc-pick-tab")].map(e=>e.innerText))`);
check("两页签：待办事项清单/习惯打卡", pickTabs.join("/") === "待办事项清单/习惯打卡", pickTabs.join("/"));
const names = await json(`JSON.stringify([...document.querySelectorAll(".fc-pick-name")].map(e=>e.innerText))`);
check("默认列出全部待办（种子三条今天的事项都在）",
  ["写周报", "评审方案", "读一页书"].every((x) => names.includes(x)), JSON.stringify(names));

await click(".fc-pick-date", "全部待办");
check("点标题位开日历", (await num(".fc-pick-cal .cal-day")) > 0);
const calBtns = await json(`JSON.stringify([...document.querySelectorAll(".fc-pick-cal .pop-btn")].map(e=>e.innerText))`);
check("日历三键：清除/取消/保存", calBtns.join(",") === "清除,取消,保存", calBtns.join(","));
// 选「本月里今天的下一天」，保存后应当只剩那一天的任务
const nextDay = addDays(T, 1);
// 日历里 is-same 的格子就是当月那些天，按日号取索引最稳（title 是农历/节日文案，不可靠）
await evalJs(`(()=>{const L=[...document.querySelectorAll(".fc-pick-cal .cal-day.is-same")];const e=L[${Number(nextDay.slice(8, 10)) - 1}];e&&e.click()})()`);
await sleep(200);
await click(".fc-pick-cal .pop-btn", "保存", 0, 500);
check("保存日期后标题位变成那一天", (await txt(".fc-pick-date")).includes(`${Number(nextDay.slice(5, 7))}月${Number(nextDay.slice(8, 10))}日`), await txt(".fc-pick-date"));
const oneDay = await json(`JSON.stringify([...document.querySelectorAll(".fc-pick-row")].map(e=>e.innerText))`);
check("按天筛只剩那天的任务（种子把三条都放今天，明天应为空）", oneDay.length === 0, JSON.stringify(oneDay));
await click(".fc-pick-date", "月");
await click(".fc-pick-cal .pop-btn", "清除", 0, 500);
check("清除日期回到全部待办", (await txt(".fc-pick-date")) === "全部待办任务", await txt(".fc-pick-date"));

await click(".fc-pick-tab", "习惯打卡");
const habitRows = await json(`JSON.stringify([...document.querySelectorAll(".fc-pick-name")].map(e=>e.innerText))`);
check("习惯页签列出种子习惯", habitRows.includes("晨跑"), JSON.stringify(habitRows));
await click(".fc-pick-tab", "待办事项清单");
await click(".fc-pick-row", "写周报");
check("选一条后弹窗关闭", (await num(".fc-pick")) === 0);
check("已关联显示在子模块标题位", (await txt(".fc-task-on")).includes("写周报"), await txt(".fc-task-on"));
await click(".fc-task-on", "写周报");
const menu = await json(`JSON.stringify([...document.querySelectorAll(".fc-task-menu button")].map(e=>e.innerText))`);
check("再点已关联给出更换/清除", menu.join(",") === "更换任务,清除任务", menu.join(","));
await click(".fc-task-menu button", "清除任务");
check("清除后回到关联任务入口", await has(".fc-task-off"));
await click(".fc-task-off", "关联任务");
await click(".fc-pick-row", "写周报");

console.log("\n=== 专注：番茄钟设置与滚轮 ===");
await click(".gtab", "番茄钟", 0, 600);
const wheelItems = await num(".fc-wheel-item");
check("番茄滚轮 1~120 分钟", wheelItems === 120, String(wheelItems));
check("默认选中 25 分", (await txt(".fc-wheel-item.is-sel")).startsWith("25"), await txt(".fc-wheel-item.is-sel"));
// 选中的那一格必须真的停在滚轮正中（用户指出过：25 在上面、26 在中间）
const wheelGeo = () => json(`(()=>{const w=document.querySelector(".fc-wheel"),sel=document.querySelector(".fc-wheel-item.is-sel");` +
  `const a=w.getBoundingClientRect(),b=sel.getBoundingClientRect();` +
  `return JSON.stringify({diff:Math.round((b.top+b.bottom)/2-(a.top+a.bottom)/2),sel:sel.innerText.trim()})})()`);
const g0 = await wheelGeo();
check("选中那格在滚轮正中", Math.abs(g0.diff) <= 2, `${g0.sel} 偏 ${g0.diff}px`);
await click(".fc-plan-btn", "番茄设置", 0, 500);
check("番茄设置弹窗打开", await has(".fc-plan-rows"));
const planRows = await json(`JSON.stringify([...document.querySelectorAll(".fc-plan-row")].map(e=>e.innerText.replace(/\\s+/g," ")))`);
check("五行设置项文案齐全",
  ["番茄钟个数", "短休息时长", "长休息时长", "长休息间隔", "自动开始休息"].every((k) => planRows.some((r) => r.includes(k))),
  JSON.stringify(planRows));
const stepperX = await json(`JSON.stringify([...document.querySelectorAll(".fc-plan-row .fc-stepper")].map(e=>Math.round(e.getBoundingClientRect().left)))`);
check("四行步进器左边缘对齐（单位占固定宽）", new Set(stepperX).size === 1, JSON.stringify(stepperX));
const planVals = await json(`JSON.stringify([...document.querySelectorAll(".fc-stepper input")].map(e=>e.value))`);
check("默认值 4/1/2/4", planVals.slice(0, 4).join("/") === "4/1/2/4", planVals.join("/"));
check("自动开始休息默认开", planRows.some((r) => r.includes("自动开始休息") && r.includes("开")), JSON.stringify(planRows.slice(4)));
await click(".fc-stepper button", "", 1, 300);   // 个数 +1 → 5
await click(".fc-stepper button", "", 1, 300);   // → 6
await click(".modal .btn", "保存", 0, 600);
check("设置入口回显 6 个番茄", (await txt(".fc-plan-val")).includes("6 个番茄"), await txt(".fc-plan-val"));
// 滚轮只在「露得出来的格子」上接受点击：选中项永远居中，第一格此时还在容器上方，
// 点它会打到滚动容器外的坐标。所以先点中间偏下那一格（26），再滚到顶（等价于用户向上拖到底）。
await click(".fc-wheel-item", "", 25, 400);
check("滚轮点一格能改选中", (await txt(".fc-wheel-item.is-sel")).startsWith("26"), await txt(".fc-wheel-item.is-sel"));
await evalJs(`document.querySelector(".fc-wheel").scrollTop=0`);
await sleep(500);
check("滚到顶选中 1 分", (await txt(".fc-wheel-item.is-sel")).startsWith("1"), await txt(".fc-wheel-item.is-sel"));
const g1 = await wheelGeo();
check("第一格也能停在正中（上下垫格生效）", Math.abs(g1.diff) <= 2, `${g1.sel} 偏 ${g1.diff}px`);
// 滚到底同样要居中，否则最后一格永远只能贴底
await evalJs(`(()=>{const w=document.querySelector(".fc-wheel");w.scrollTop=w.scrollHeight})()`);
await sleep(500);
const g2 = await wheelGeo();
check("滚到底最后一格也居中", Math.abs(g2.diff) <= 2, `${g2.sel} 偏 ${g2.diff}px`);
await evalJs(`document.querySelector(".fc-wheel").scrollTop=0`);
await sleep(500);

console.log("\n=== 专注：正计时沉浸流 ===");
await click(".gtab", "正计时", 0, 600);
const before = focusRows().filter((x) => !x.tomb).length;
await click(".fc-start", "开始专注", 0, 900);
check("进入沉浸页", await has(".fc-immersive"));
check("沉浸页显示已关联任务", (await txt(".fc-immer-task")).includes("写周报"), await txt(".fc-immer-task"));
const clock0 = await txt(".fc-clock-num");
await sleep(2200);
const clock1 = await txt(".fc-clock-num");
check("时钟在走", clock0 !== clock1, `${clock0} → ${clock1}`);
await click(".fc-big-btn", "暂停", 0, 600);
check("暂停后出现继续与结束", (await num(".fc-big-btn")) === 2 && (await txt(".fc-immer-actions")).includes("继续"), await txt(".fc-immer-actions"));
await click(".fc-big-btn", "结束", 0, 600);
check("结束确认标题「当前专注进行中」", (await txt(".fc-end-box .modal-head h3")) === "当前专注进行中", await txt(".fc-end-box .modal-head h3"));
const endBtns = await json(`JSON.stringify([...document.querySelectorAll(".fc-end-btn")].map(e=>e.innerText))`);
check("三按钮：结束保存/放弃不保存/取消", endBtns.join(",") === "结束（保存记录）,放弃（不保存）,取消", endBtns.join(","));
await click(".fc-end-btn", "放弃", 0, 900);
check("放弃后回到子模块", (await num(".fc-immersive")) === 0 && await has(".fc-start"));
const afterDrop = focusRows();
check("放弃写的是墓碑而不是留一条记录", afterDrop.filter((x) => !x.tomb).length === before && afterDrop.some((x) => x.tomb),
  `存活 ${afterDrop.filter((x) => !x.tomb).length} / 墓碑 ${afterDrop.filter((x) => x.tomb).length}`);

await click(".fc-start", "开始专注", 0, 900);
await sleep(1500);
await click(".fc-big-btn", "暂停", 0, 600);
await click(".fc-big-btn", "结束", 0, 600);
await click(".fc-end-btn", "结束（保存记录）", 0, 900);
check("结算页「专注目标达成」", (await txt(".fc-settle-title")) === "专注目标达成", await txt(".fc-settle-title"));
check("结算页有心得输入框", await has(".fc-settle-note"));
check("结算页左下角是专注详情", (await txt(".fc-settle-foot .fc-detail-link")).includes("专注详情"), await txt(".fc-settle-foot"));
await typeInto(".fc-settle-note", "先测一句心得");
await click(".fc-settle-foot .btn", "保存", 0, 900);
// 用户要的交互：结算页点保存 = 落库并回到「开始专注」那一屏，不是停在结算页
check("保存后回到开始专注那一屏", (await num(".fc-immersive")) === 0 && await has(".fc-start"),
  await txt(".fc-settle-title"));
const saved = focusRows().filter((x) => !x.tomb).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
check("心得真的落库", (saved.note || "") === "先测一句心得", JSON.stringify(saved.note));
check("保存的是正计时且时长不为 0", saved.type === 1 && saved.actualSec >= 2, JSON.stringify([saved.type, saved.actualSec]));
check("关联任务写进记录", saved.itemId === itemRows().find((i) => i.title === "写周报")?.id, JSON.stringify(saved.itemId));
// 结算页已经离开，详情改从数据页的历史列表进（顺带验「刚保存的记录真的在列表最上面」）
await click(".gtab", "数据", 0, 900);
await click(".fc-ov .fc-ov-go", "", 0, 900);
check("历史列表第一条就是刚保存那条", (await txt(".fc-hist-row")).includes("写周报"), await txt(".fc-hist-row"));
await click(".fc-hist-row", "", 0, 900);
check("详情页打开", await has(".fc-detail"));
const detailTxt = await txt(".fc-detail-body");
check("详情页字段齐全", ["专注时间", "专注时长", "专注类型", "关联任务", "专注心得", "事件时间轴"].every((k) => detailTxt.includes(k)), detailTxt.slice(0, 120));
check("详情页显示关联的任务名", detailTxt.includes("写周报"), detailTxt.slice(0, 80));
const tl = await json(`JSON.stringify([...document.querySelectorAll(".fc-tl-label")].map(e=>e.innerText))`);
check("时间轴含开始/暂停/结束", tl.includes("开始专注") && tl.includes("暂停") && tl.includes("结束专注"), JSON.stringify(tl));
await typeInto(".fc-note", "详情页里补一句", 0);
await evalJs(`document.querySelector(".fc-note").blur()`);
await sleep(700);
const edited = focusRows().find((x) => x.id === saved.id);
check("详情页改心得直接落库", (edited.note || "").includes("详情页里补一句"), JSON.stringify(edited.note));
await click(".fc-danger", "删除", 0, 600);
check("删除要确认", await has(".modal"));
await click(".modal .btn", "删除", 0, 800);
const gone = focusRows().find((x) => x.id === saved.id);
check("删除写成墓碑", !!gone?.tomb, JSON.stringify(gone?.tomb));
await click(".fc-back", "", 0, 700);   // 详情退回列表，再退回统计分析，别把覆盖层留着

console.log("\n=== 专注：番茄引擎（真等 62 秒） ===");
await click(".gtab", "番茄钟", 0, 700);
await evalJs(`document.querySelector(".fc-wheel").scrollTop=0`);   // 每轮 1 分钟
await sleep(500);
await click(".fc-start", "开始专注", 0, 900);
check("沉浸页显示第 1 / 6 轮", (await txt(".fc-immer-phase")).includes("第 1 / 6 轮"), await txt(".fc-immer-phase"));
await sleep(63000);
check("一轮走完自动进休息", await has(".fc-clock.is-rest"), await txt(".fc-immer-phase"));
const pomo = focusRows().filter((x) => !x.tomb).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
check("内核记到 1 轮", pomo.type === 2 && pomo.cycles === 1, JSON.stringify([pomo.type, pomo.cycles, pomo.phase]));
check("休息期间不计专注时长", pomo.accumSec < 80, String(pomo.accumSec));
await click(".fc-big-btn", "跳过休息", 0, 900);
const skipped = focusRows().find((x) => x.id === pomo.id);
check("跳过休息把已休息的秒数记进 RestSec", skipped.restSec > 0 && skipped.cycles === 1, JSON.stringify([skipped.restSec, skipped.cycles]));
await click(".fc-big-btn", "暂停", 0, 700);
await click(".fc-big-btn", "结束", 0, 700);
await click(".fc-end-btn", "结束（保存记录）", 0, 900);
check("结算页交代了番茄轮次", (await txt(".fc-settle-sub")).includes("1 轮番茄"), await txt(".fc-settle-sub"));
await click(".fc-settle-foot .btn", "返回", 0, 700);

console.log("\n=== 专注：倒计时 ===");
await click(".gtab", "倒计时", 0, 700);
check("倒计时滚轮 1~240 分钟", (await num(".fc-wheel-item")) === 240, String(await num(".fc-wheel-item")));
check("倒计时默认 25 分", (await txt(".fc-wheel-item.is-sel")).startsWith("25"), await txt(".fc-wheel-item.is-sel"));
await evalJs(`document.querySelector(".fc-wheel").scrollTop=0`);   // 1 分钟
await sleep(500);
check("倒计时滚到顶选中 1 分", (await txt(".fc-wheel-item.is-sel")).startsWith("1"), await txt(".fc-wheel-item.is-sel"));
await click(".fc-start", "开始专注", 0, 900);
check("倒计时显示目标 1 分", (await txt(".fc-clock-sub")).includes("目标"), await txt(".fc-clock-sub"));
const cd0 = await txt(".fc-clock-num");
await sleep(1600);
check("倒计时在递减", cd0 !== (await txt(".fc-clock-num")), `${cd0} → ${await txt(".fc-clock-num")}`);
await click(".fc-big-btn", "暂停", 0, 600);
await click(".fc-big-btn", "结束", 0, 600);
await click(".fc-end-btn", "放弃（不保存）", 0, 900);
check("倒计时放弃同样不留记录", focusRows().filter((x) => !x.tomb).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0].type === 2);
check("放弃后顶部不再有「上次…还没结束」", (await num(".fc-resume")) === 0, await txt(".fc-resume"));

console.log("\n=== 专注：数据页 · 统计分析 ===");
await click(".gtab", "数据", 0, 800);
const scrollable = await json(`(()=>{const sc=document.querySelector(".fc-scroll");` +
  `return JSON.stringify({yes:sc.scrollHeight>sc.clientHeight+4,h:sc.scrollHeight,v:sc.clientHeight})})()`);
check("数据页内容超出视口时有滚动区", scrollable.yes === true, JSON.stringify(scrollable));
const dataTabs = await json(`JSON.stringify([...document.querySelectorAll(".fc-tab")].map(e=>e.innerText))`);
check("两页签：统计分析/数据分布", dataTabs.join("/") === "统计分析/数据分布", dataTabs.join("/"));
const alive = focusRows().filter((x) => !x.tomb);
const sumSec = alive.reduce((s, x) => s + x.actualSec, 0);
const ov = await txt(".fc-overview");
check("总览累计次数与内核一致", ov.includes(`总次数 ${alive.length} 次`), ov.slice(0, 90));
check("总览累计时长与内核一致", ov.includes(fmt(sumSec)), `${ov.slice(0, 90)} 应含 ${fmt(sumSec)}`);
const todayRows = alive.filter((x) => x.day === T);
check("今日专注块用今天的数", ov.includes(`总次数 ${alive.length} 次`) && (await txt(".fc-ov:nth-child(2)")).includes(`总次数 ${todayRows.length} 次`),
  await txt(".fc-ov:nth-child(2)"));

await click(".fc-ov .fc-ov-go", "", 0, 800);
check("点累计右箭头进历史列表", await has(".fc-sheet"));
const histRows = await num(".fc-hist-row");
check("历史列表条数 = 内核已结束记录数", histRows === alive.length, `${histRows} vs ${alive.length}`);
await click(".fc-hist-row", "", 0, 800);
check("历史项右箭头进专注详情", (await txt(".fc-detail-head h3")) === "专注详情", await txt(".fc-detail-head h3"));
await click(".fc-back", "", 0, 700);
check("详情返回回到列表", await has(".fc-hist-row"));
await click(".fc-back", "", 0, 700);
check("列表返回回到统计分析", await has(".fc-overview"));

await click(".fc-manual-btn", "补记专注记录", 0, 800);
check("补记页标题与保存按钮", (await txt(".fc-sheet-head h3")) === "补记专注记录" && await has(".fc-sheet-head .btn"), await txt(".fc-sheet-head"));
const manualTabs = await json(`JSON.stringify([...document.querySelectorAll(".fc-tabs.is-inner .fc-tab")].map(e=>e.innerText))`);
check("补记三页签：正计时/番茄钟/倒计时", manualTabs.join("/") === "正计时/番茄钟/倒计时", manualTabs.join("/"));
await click(".fc-stepper button", "", 1, 300);   // +1 分钟
const beforeManual = focusRows().filter((x) => !x.tomb).length;
await click(".fc-sheet-head .btn", "保存", 0, 900);
const manual = focusRows().filter((x) => !x.tomb && x.source === 2).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
check("补记落库且条数 +1", focusRows().filter((x) => !x.tomb).length === beforeManual + 1, String(beforeManual));
check("补记没有伪造起止时刻", !manual.startAt && !manual.endAt, JSON.stringify([manual.startAt, manual.endAt]));
check("补记时长 = 分钟数", manual.actualSec > 0 && manual.actualSec % 60 === 0, String(manual.actualSec));

const yearStart = `${T.slice(0, 4)}-01-01`;
const spanDays = diffDays(yearStart, T) + 1;
const spread = await json(`JSON.stringify({bars:document.querySelectorAll(".fc-bar-col").length,split:[...document.querySelectorAll(".fc-split-name")].map(e=>e.innerText)})`);
// 统计分析的区间是「今年 1 月 1 日 ~ 今天」，超过 60 天就按月聚合：柱子数 = 今年到本月跨了几个月
check(`时长分布按月聚合（今年区间 ${spanDays} 天 → ${Number(T.slice(5, 7))} 根柱）`, spread.bars === Number(T.slice(5, 7)), String(spread.bars));
check("时长分布给出三种类型占比", spread.split.length === 3, JSON.stringify(spread.split));
const heat = await json(`JSON.stringify({cols:document.querySelectorAll(".fc-heat-col").length,sizes:[...new Set([...document.querySelectorAll(".fc-heat-col")].map(c=>c.children.length))],lit:document.querySelectorAll(".fc-heat-cell.lv1,.fc-heat-cell.lv2,.fc-heat-cell.lv3,.fc-heat-cell.lv4").length})`);
check("全时段热图每列恒 7 格", heat.sizes.length === 1 && heat.sizes[0] === 7, JSON.stringify(heat.sizes));
// 热图只画到今天的这一列，所以列数由「1 月 1 日前的补位 + 区间天数」决定，不是恒 53
const expectCols = Math.ceil((spanDays + weekdayMon(yearStart) - 1) / 7);
check("热图列数 = 区间周数", heat.cols === expectCols, `${heat.cols} vs ${expectCols}`);
check("热图有亮起来的格子", heat.lit > 5, String(heat.lit));
const mx = await json(`JSON.stringify({cells:document.querySelectorAll(".fc-mx-cell").length,lit:[...document.querySelectorAll(".fc-mx-cell")].filter(c=>c.dataset.lv!=="0").length})`);
check("时段矩阵恒 168 格", mx.cells === 168, String(mx.cells));
check("真跑过的专注落进了时段矩阵", mx.lit >= 1, String(mx.lit));
const rank = await json(`JSON.stringify([...document.querySelectorAll(".fc-rank-name")].map(e=>e.innerText))`);
check("任务排行含「写周报」", rank.includes("写周报"), JSON.stringify(rank));
check("补记不进矩阵这件事有交代", (await txt(".fc-rank")).includes("没有真实时刻"), (await txt(".fc-rank")).slice(-60));

console.log("\n=== 专注：数据页 · 数据分布 ===");
await click(".fc-tab", "数据分布", 0, 900);
const distTitles = await json(`JSON.stringify([...document.querySelectorAll(".fc-card-title.is-inner")].map(e=>e.innerText))`);
check("依次是日统计/月统计/年统计", distTitles.join("/") === "日统计/月统计/年统计", distTitles.join("/"));
check("日统计给 24 根小时条", (await num(".fc-hour-bar")) === 24, String(await num(".fc-hour-bar")));
check("月统计格子数 = 当月天数", (await num(".fc-mcell:not(.is-pad)")) === monthDays(T.slice(0, 7)).length,
  `${await num(".fc-mcell:not(.is-pad)")} vs ${monthDays(T.slice(0, 7)).length}`);
check("月统计按星期对齐（首行前面有补位）", (await num(".fc-mcell.is-pad")) === weekdayMon(monthDays(T.slice(0, 7))[0]) - 1,
  String(await num(".fc-mcell.is-pad")));
const distArrows = await json(`JSON.stringify([...document.querySelectorAll(".fc-arrow")].map(e=>e.disabled))`);
check("三模块的右箭头都不许越过今天", distArrows.filter((x) => x).length >= 2, JSON.stringify(distArrows));
await click(".fc-arrow", "", 0, 700);            // 页面上第一颗箭头 = 日统计模块的左箭头
check("日统计左箭头翻到昨天", (await txt(".fc-range")).includes(`${Number(addDays(T, -1).slice(5, 7))}月${Number(addDays(T, -1).slice(8, 10))}日`), await txt(".fc-range"));
await click(".fc-now", "回到本期", 0, 700);

console.log("\n=== 专注：收尾 ===");
await click(".gtab", "正计时", 0, 700);
check("回到子模块，界面正常", await has(".fc-start") && (await num(".fc-immersive")) === 0);
closeDb();
console.log("\n结果：通过 " + pass + "，失败 " + fail);
ws.close();
process.exit(fail ? 1 : 0);

/** 与界面同一套人话时长口径（lib/focus.ts 的 fmtDuration）。 */
function fmt(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} 秒`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0) return `${m} 分`;
  return m === 60 ? `${h + 1} 小时` : m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

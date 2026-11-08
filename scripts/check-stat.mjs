// 习惯统计自检：日/周/月/年四个页签，真实鼠标键盘事件点一遍，并拿内核记录反查界面数字。
// 用法：node scripts/check-stat.mjs [端口]
//   先跑 bash scripts/verify-restart.sh 9256 habits && bash scripts/seed-stat.sh
//   ⚠️ 必须紧接 restart+seed 跑：种子是按「相对今天」追加记录的，
//      同一个库跑两遍会灌出重复习惯，条数类断言会误报。
// 种子用的是「相对今天」的日期，所以断言只依赖今天星期几，不写死日历。
import { DatabaseSync } from "node:sqlite";
import { addMonths, monthCN, today, weekdayMon } from "./lib/d.mjs";

const port = process.argv[2] || "9256";
const DATA = "C:/Users/Public/project/plan-for-do/tmp/vdata";
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
async function click(sel, text, nth = 0, wait = 400) {
  const pt = await point(sel, text, nth);
  for (const t of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type: t, x: pt.x, y: pt.y, button: "left", clickCount: 1, buttons: t === "mousePressed" ? 1 : 0 });
  }
  await sleep(wait);
}
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? "  → " + d : ""))); };
const txt = async (sel) => (await evalJs(`document.querySelector(${JSON.stringify(sel)})?.innerText||""`)).replace(/\s+/g, " ").trim();
const num = async (sel) => await evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const title = () => txt(".hs-title");
const arrow = async (i) => await evalJs(`document.querySelectorAll(".hs-arrow")[${i}].disabled`);

// 内核侧真值：habitClock 里 (习惯, 天) 去重后的量，以及每个习惯的目标
const db = new DatabaseSync(`${DATA}/planfordo.db`, { readOnly: true });
const clocks = db.prepare("select data from entity where kind='habitClock' and deleted_at=''").all().map((r) => JSON.parse(r.data));
const habits = db.prepare("select data from entity where kind='habit' and deleted_at=''").all().map((r) => JSON.parse(r.data));
db.close();
const amountOf = {};
for (const c of clocks) amountOf[`${c.habitId}:${c.day}`] = (amountOf[`${c.habitId}:${c.day}`] ?? 0) + (c.amount || 1);

console.log("\n=== 习惯统计：入口 ===");
await click(".gtab", "习惯统计", 0, 700);
check("习惯页顶部两页签", (await num(".gtab")) === 2 && (await txt(".gtab.is-active")) === "习惯统计", await txt(".gtabs"));
check("统计页四个页签，默认日专注",
  (await evalJs(`[...document.querySelectorAll(".hs-tab")].map(e=>e.innerText).join("/")`)) === "日专注/周专注/月专注/年专注",
  await txt(".hs-tabs"));
check("新建/情境管理按钮让位给统计页", (await num('.topbar-right .btn')) === 0, String(await num('.topbar-right .btn')));

console.log("\n=== 习惯统计：日 ===");
check("标题是今天（11月07日这种写法）", (await title()).length > 0 && /月\d{2}日/.test(await title()), await title());
const rows = await json(`JSON.stringify([...document.querySelectorAll(".hs-row")].map(e=>({n:e.querySelector(".hs-name")?.innerText,p:e.querySelector(".hs-progress")?.innerText,rest:e.className.includes("is-rest")})))`);
check("每行一个习惯，带图标与名称", rows.length === habits.length && (await num(".hs-row .glyph, .hs-row svg")) >= rows.length,
  `${rows.length} 行 vs 内核 ${habits.length} 个习惯`);
const zaoshui = rows.find((r) => r.n === "早睡"), heshui = rows.find((r) => r.n === "喝水");
check("每天一次写「1/1次」", zaoshui?.p === "1/1次", JSON.stringify(zaoshui));
check("每天多次按量+单位写「3/8杯」", heshui?.p === "3/8杯", JSON.stringify(heshui));
check("没排期的习惯标「休息」而不是 0/1次", rows.filter((r) => r.rest).every((r) => r.p === "休息"), JSON.stringify(rows.filter((r) => r.rest)));
check("完美打卡环 = 打满/应打", (await txt(".hs-ring span")) === "50%", await txt(".hs-ring span"));
check("环下方写清今天该打几个", (await txt(".hs-perfect .hs-sub")) === "今天该打 2 个，已打满 1 个", await txt(".hs-perfect .hs-sub"));
check("右箭头不可点（不能看未来）", (await arrow(1)) === true);
check("左箭头可点", (await arrow(0)) === false);
const dayTitle = await title();
await click(".hs-arrow", "", 0);
check("点左箭头换到昨天", (await title()) !== dayTitle, `${dayTitle} → ${await title()}`);
check("出现「回到今天」", (await num(".hs-now")) === 1);
await click(".hs-now");
check("回到今天", (await title()) === dayTitle, await title());

console.log("\n=== 习惯统计：周 ===");
await click(".hs-tab", "周专注");
await sleep(600);
check("标题是整周（11月02日~11月08日那种）", /^1?\d月\d{2}日~1?\d月\d{2}日$/.test(await title()), await title());
check("表头七个星期格，顺序一→日",
  (await evalJs(`[...document.querySelectorAll(".hs-grid-row.is-head .hs-grid-wk b")].map(e=>e.innerText).join("")`)) === "一二三四五六日",
  await txt(".hs-grid-row.is-head"));
const grid = await json(`JSON.stringify(Array.from(document.querySelectorAll(".hs-grid-row:not(.is-head)")).map((r) => {` +
  `const cells = Array.from(r.querySelectorAll(".hs-cell")).map((c) => { return { k: c.className.replace("hs-cell is-", ""), d: c.dataset.day }; });` +
  `return { name: r.querySelector(".hs-grid-name em").innerText, cells: cells };` +
  `}))`);
check("每行 7 格、行数 = 习惯数", grid.length === habits.length && grid.every((g) => g.cells.length === 7),
  JSON.stringify(grid.map((g) => g.cells.length)));
const onCells = grid.flatMap((g) => g.cells.filter((c) => c.k === "on"));
const checkins = Number((await txt(".hs-stats3")).match(/\d+/g)?.[0] ?? "-1");
check("打卡总数 = 网格里红格数", checkins === onCells.length, `${checkins} vs ${onCells.length}`);
// 红格必须与内核记录一一对应：界面有红格 ⇔ 该习惯那天有打卡量
const dbOn = new Set(grid.flatMap((g) => g.cells.filter((c) => c.k === "on").map((c) => `${g.name}:${c.d}`)));
const mismatch = [...dbOn].filter((k) => {
  const [name, day] = k.split(":");
  const h = habits.find((x) => x.name === name);
  return !h || !amountOf[`${h.id}:${day}`];
});
check("每个红格背后都有内核打卡记录", mismatch.length === 0, JSON.stringify(mismatch));
const missing = Object.keys(amountOf).filter((k) => {
  const [id, day] = k.split(":");
  const h = habits.find((x) => x.id === id);
  if (!h) return false;
  const row = grid.find((g) => g.name === h.name);
  if (!row) return false;
  const cell = row.cells.find((c) => c.d === day);
  return cell && cell.k !== "on";
});
check("内核有记录的日子界面都变红（含非排期日补打）", missing.length === 0, JSON.stringify(missing));
const colors = await json(`JSON.stringify([...new Set([...document.querySelectorAll(".hs-cell")].map(c=>getComputedStyle(c).backgroundColor))])`);
check("三态三种底色（红/灰/浅灰）", colors.length === 3, JSON.stringify(colors));
check("红格用红色", colors.some((c) => /rgb\(225, 62, 57\)/.test(c)), JSON.stringify(colors));
check("右箭头不可点（不能看下周）", (await arrow(1)) === true);
const stats = await json(`JSON.stringify([...document.querySelectorAll(".hs-stats3 > div")].map(e=>({v:e.querySelector("b").innerText,l:e.querySelector("span").innerText})))`);
check("汇总三项文案：打卡总数/最长连续/完美打卡",
  stats.map((s) => s.l.replace(/\s/g, "")).join(",") === "打卡总数（次）,最长连续（天）,完美打卡（天）", JSON.stringify(stats));
check("最长连续不超过 7（本周内）", Number(stats[1].v) <= 7, stats[1].v);

console.log("\n=== 习惯统计：月 ===");
await click(".hs-tab", "月专注");
await sleep(600);
check("标题是当月", /^\d{4}年\d{1,2}月$/.test(await title()), await title());
const cards = await json(`JSON.stringify([...document.querySelectorAll(".hs-habit-card")].map(c=>{` +
  `const all=[...c.querySelectorAll(".hs-cell")],real=all.filter(x=>x.dataset.day);` +
  `return {name:c.querySelector(".hs-card-head b")?.innerText,cells:real.length,lead:all.length-real.length,` +
  `on:real.filter(x=>x.className.includes("is-on")).length,first:real[0]?.dataset.day,` +
  `left:real[0]?Math.round(real[0].getBoundingClientRect().left):-1,` +
  `wk:[...c.querySelectorAll(".hs-month-wk i")].map(e=>Math.round(e.getBoundingClientRect().left))}}))`);
const daysInMonth = await json(`(()=>{const d=new Date();return JSON.stringify(new Date(d.getFullYear(),d.getMonth()+1,0).getDate())})()`);
check("每张卡一行一个习惯、数据格数 = 当月天数", cards.length === habits.length && cards.every((c) => c.cells === Number(daysInMonth)),
  JSON.stringify(cards.map((c) => c.cells)));
// 月卡 1 号不再顶死第一列：前面补的空位数 = 1 号是周几，且首格真的落在表头那一列上
check("月卡按星期对齐（补位与表头同列）",
  cards.every((c) => c.lead === weekdayMon(c.first) - 1 && Math.abs(c.left - c.wk[c.lead]) <= 2),
  JSON.stringify(cards.map((c) => [c.first, c.lead, c.left, c.wk[c.lead]])));
check("卡片标题是习惯图标+名称", cards.every((c) => !!c.name), JSON.stringify(cards.map((c) => c.name)));
const monthOn = cards.reduce((a, c) => a + c.on, 0);
const dbMonthOn = Object.entries(amountOf).filter(([k]) => {
  const day = k.split(":")[1];
  const d = new Date();
  return day.slice(0, 7) === `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}).length;
check("月卡红格总数 = 内核当月有打卡的「习惯×天」数", monthOn === dbMonthOn, `${monthOn} vs ${dbMonthOn}`);
check("右箭头不可点（不能看下月）", (await arrow(1)) === true);
await click(".hs-arrow", "", 0);
check("点左箭头换到上个月", (await title()) === monthCN(addMonths(today(), -1)), await title());
await click(".hs-now");

console.log("\n=== 习惯统计：年 ===");
await click(".hs-tab", "年专注");
await sleep(900);
check("标题是当前年", /^\d{4}年$/.test(await title()), await title());
const heat = await json(`JSON.stringify([...document.querySelectorAll(".hs-heat")].map(c=>({` +
  `name:c.querySelector(".hs-card-head b")?.innerText,total:Number(c.querySelector(".hs-sub b").innerText),` +
  `cols:c.querySelectorAll(".hs-heat-col").length,` +
  `sizes:[...new Set([...c.querySelectorAll(".hs-heat-col")].map(x=>x.children.length))],` +
  `on:[...c.querySelectorAll(".hs-cell")].filter(x=>x.className.includes("is-on")).length})))`);
check("每习惯一张热力图", heat.length === habits.length, JSON.stringify(heat.map((h) => h.name)));
check("热力图每列恒 7 格（周一到周日）", heat.every((h) => h.sizes.join() === "7"), JSON.stringify(heat.map((h) => h.sizes)));
check("列数在 52~54 之间", heat.every((h) => h.cols >= 52 && h.cols <= 54), JSON.stringify(heat.map((h) => h.cols)));
check("右上角「全年打卡 N 天」= 红格数", heat.every((h) => h.total === h.on), JSON.stringify(heat.map((h) => [h.total, h.on])));
const dbYear = {};
for (const [k] of Object.entries(amountOf)) {
  const [id, day] = k.split(":");
  if (day.slice(0, 4) !== String(new Date().getFullYear())) continue;
  dbYear[id] = (dbYear[id] ?? 0) + 1;
}
const idOf = (name) => habits.find((x) => x.name === name)?.id;
check("逐习惯全年天数与内核一致",
  heat.every((h) => dbYear[idOf(h.name)] === h.on),
  JSON.stringify(heat.map((h) => [h.name, h.on, dbYear[idOf(h.name)]])));
check("右箭头不可点（不能看明年）", (await arrow(1)) === true);
await click(".hs-arrow", "", 0);
check("点左箭头换到去年", (await title()) !== `${new Date().getFullYear()}年`, await title());
check("去年的格子全灰（种子只打在今年）", (await num(".hs-cell.is-on")) === 0, String(await num(".hs-cell.is-on")));
await click(".hs-now");
check("回到今天所在年份", (await title()) === `${new Date().getFullYear()}年`, await title());

console.log("\n=== 习惯统计：切回每日打卡 ===");
await click(".gtab", "每日打卡", 0, 700);
check("回到卡片流，日期带与按钮都回来了", (await num(".datestrip")) === 1 && (await num('.topbar-right .btn')) === 2,
  `${await num(".datestrip")}/${await num('.topbar-right .btn')}`);
check("统计页已卸载", (await num(".hs")) === 0);

console.log("\n结果：通过 " + pass + "，失败 " + fail);
ws.close();
process.exit(fail ? 1 : 0);

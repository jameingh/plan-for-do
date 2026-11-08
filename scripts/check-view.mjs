// 视图模块自检：三视图切换、月网格与跨天条、周/日小时网格、折叠、自定义视图（内容/颜色）、设置开关。
// 用法：node scripts/check-view.mjs [端口]
//   先跑 bash scripts/verify-restart.sh 9256 views && bash scripts/seed-view.sh
//   种子与断言都用「相对今天 / 相对本周一」算（见 scripts/lib/d.mjs），跑在哪一天都一样。
import { addDays, addMonths, diffDays, mondayOf, monthCN, monthGrid, today, mdCN, dayTitleCN, weekTitleCN, habitDayCN } from "./lib/d.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const port = process.argv[2] || "9256";
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
const evalJs = async (expression) => {
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (out.exceptionDetails) throw new Error(String(out.exceptionDetails.exception?.description || "页面异常").split("\n")[0]);
  return out.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (expression) => JSON.parse(await evalJs(expression));

/** 元素中心点的真实鼠标事件：React 的 onClick 只认这个，不认 el.click()。 */
async function point(sel, text, nth = 0) {
  const pt = await json(`(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})];` +
    `const e=${text ? `L.filter(x=>(x.innerText||"").includes(${JSON.stringify(text)}))` : "L"}[${nth}];if(!e)return JSON.stringify(null);` +
    `const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),vis:r.width>0&&r.height>0})})()`);
  if (!pt) throw new Error("找不到 " + sel + (text ? ` （含「${text}」）` : ""));
  return pt;
}
async function click(sel, text, nth = 0, wait = 320) {
  const pt = await point(sel, text, nth);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  }
  await sleep(wait);
  return pt;
}
/** hover：小时行的折叠箭头只在 mouseenter 后出现，必须真移动一次。 */
async function hover(sel, text, nth = 0) {
  const pt = await point(sel, text, nth);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, buttons: 0 });
  await sleep(160);
  return pt;
}
async function key(k) {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 0, text: "" });
  }
  await sleep(300);
}
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? "  → " + d : ""))); };
const txt = async (sel) => (await evalJs(`document.querySelector(${JSON.stringify(sel)})?.innerText||""`)).replace(/\s+/g, " ").trim();
const num = async (sel) => await evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

/** 网格里的彩条：文字 + 背景色 + 占的列区间（跨天条靠 gridColumn 表达）。 */
const gridBars = () => json(`JSON.stringify([...document.querySelectorAll(".vbar,.vw-bar")].map(e=>{const r=e.getBoundingClientRect();` +
  `return {t:e.innerText.replace(/\\s+/g," ").trim(),bg:getComputedStyle(e).backgroundColor,` +
  `gs:getComputedStyle(e).gridColumnStart,ge:getComputedStyle(e).gridColumnEnd,` +
  `l:Math.round(r.left),w:Math.round(r.width),top:Math.round(r.top),h:Math.round(r.height)}}))`);

// 种子把数据摆在「本周一 + N」与「今天 + N」上，这里的期望值按同一套算式现算，不写死日历。
const T = today();
const MON = mondayOf(T);
const grid = monthGrid(T);            // 当前月的整周网格
const timedDay = addDays(MON, 7);     // 早会/评审/写周报：下周一
const moreDay = addDays(MON, 5);      // 单天 5 条：本周内，月网格恒含当前整周
const yday = addDays(T, -1);          // 已打卡样本：昨天（内核不给未来打卡）

// 复位：上一次跑到一半可能把界面留在日视图/别的月份，先回到「月视图 + 今天」。
// 切两次页签是故意的：种子由 CLI 直接写库，界面不会自己刷新，只有区间变了才会重新取数。
await key("Escape");
await click(".v-type", "日视图", 0, 400);
await click(".v-type", "月视图", 0, 600);
await click(".v-today", "", 0, 500);

console.log("\n=== 视图：月视图 ===");
if ((await gridBars()).length === 0) { console.error("网格是空的：先跑 bash scripts/verify-restart.sh 9256 views && bash scripts/seed-view.sh"); process.exit(1); }
check("默认落在月视图", (await txt(".v-type.is-sel")) === "月视图", await txt(".v-type.is-sel"));
check("标题是当前月", (await txt(".v-title")) === monthCN(T), await txt(".v-title") + " vs " + monthCN(T));
check("补齐整周 = 行数×7", (await num(".vm-row")) === grid.rows && (await num(".vm-title")) === grid.cells, (await num(".vm-row")) + "行/" + (await num(".vm-title")) + "格，应 " + grid.rows + "行/" + grid.cells + "格");
check("今天格子写「今」", (await txt(".vm-title.is-today .vm-num")) === "今");
// 副标题（节气/节日/农历）的准确性归内核的 calendar 包测（lunar_test.go 的 TestSolarTerm 等），
// 这里只验「内核的值真的落到了格子里」——写成「立冬」这种文案，隔天就红。
check("今天格子带农历/节气副标题", /^.+$/.test(String(await evalJs(`document.querySelector(".vm-title.is-today .vm-vice")?.innerText||""`))));

// —— 班/休角标：内核判的班休要真的画到格子上 ——
// 期望值读的是内核 //go:embed 的那几份 JSON（同一份数据，两处消费），
// 所以这里只可能失败在「界面没把值显示出来」这一侧。
const calDataDir = path.join(ROOT, "internal", "core", "calendar", "data");
const markOf = new Map();
for (const f of fs.readdirSync(calDataDir).filter((n) => n.endsWith(".json")).sort()) {
  const t = JSON.parse(fs.readFileSync(path.join(calDataDir, f), "utf8"));
  for (const d of t.holidays ?? []) markOf.set(d, "休");
  for (const d of t.makeupWorkdays ?? []) markOf.set(d, "班");
}
const gridDays = Array.from({ length: grid.cells }, (_, i) => addDays(grid.start, i));
const vm = await json(`(()=>{const out=[];for(const e of document.querySelectorAll(".vm-title")){` +
  `out.push({mark:e.querySelector(".v-mark")?.textContent||"",` +
  `box:(()=>{const m=e.querySelector(".v-mark");if(!m)return null;const r=m.getBoundingClientRect();` +
  `return {w:+r.width.toFixed(1),h:+r.height.toFixed(1)}})()});}return JSON.stringify(out)})()`);
check("月视图格子的班/休与内置表逐格一致",
  vm.length === grid.cells && vm.every((c, i) => c.mark === (markOf.get(gridDays[i]) || "")),
  JSON.stringify(vm.map((c, i) => c.mark !== (markOf.get(gridDays[i]) || "") ? `${gridDays[i]}:${c.mark || "空"}` : null).filter(Boolean).slice(0, 5)));
const monthMarks = gridDays.filter((d) => d.slice(0, 7) === T.slice(0, 7) && markOf.get(d));
if (monthMarks.length) {
  check(`本月有 ${monthMarks.length} 天带班/休，格子上都画出来了`,
    vm.filter((c) => c.mark).length >= monthMarks.length, String(vm.filter((c) => c.mark).length));
} else {
  // 本月没有假日不等于「这个功能没被验到」：往后走最多 12 个月找一个有假日的月，
  // 走不过去才说明内置表过期了（那是该补数据，不是界面的错）。
  let found = "";
  for (let i = 1; i <= 12 && !found; i++) {
    const m = addMonths(T, i).slice(0, 7);
    if (markOf.has(`${m}-01`) || Array.from({ length: 31 }, (_, k) => `${m}-${String(k + 1).padStart(2, "0")}`).some((d) => markOf.get(d))) found = m;
  }
  if (!found) {
    console.log("  待核对：本月无班休，往后 12 个月也没查到——内置节假日表可能已过期（覆盖到 " +
      Math.max(...Array.from(markOf.keys()).map((d) => Number(d.slice(0, 4)))) + " 年）");
  } else {
    for (let i = 0; i < 12; i++) {
      if ((await txt(".v-title")) === monthCN(`${found}-01`)) break;
      await click(".v-arrow", "", 1, 300); // 下个月
    }
    const g2 = await json(`(()=>{const out=[];for(const e of document.querySelectorAll(".vm-title")){out.push(e.querySelector(".v-mark")?.textContent||"")}return JSON.stringify(out)})()`);
    const start2 = mondayOf(`${found}-01`);
    const days2 = Array.from({ length: g2.length }, (_, i) => addDays(start2, i));
    check(`翻到 ${found}（有班休的月份）后逐格仍与内置表一致`,
      g2.every((c, i) => c === (markOf.get(days2[i]) || "")),
      JSON.stringify(g2.map((c, i) => c !== (markOf.get(days2[i]) || "") ? `${days2[i]}:${c || "空"}` : null).filter(Boolean).slice(0, 5)));
    check(`${found} 的班/休确实画出来了`, g2.filter(Boolean).length > 0, String(g2.filter(Boolean).length) + " 个角标");
    await click(".v-today"); // 复位，后面的断言按「今天这一月」算
    await sleep(350);
  }
}
check("角标尺寸没把抬头挤变形（≤14px 高）",
  vm.every((c) => !c.box || (c.box.h <= 14 && c.box.w <= 20)), JSON.stringify(vm.find((c) => c.box && c.box.h > 14) || "全合格"));
const cross = (await gridBars()).find((b) => b.t.includes("跨天出差"));
check(`跨天条横跨 ${mdCN(addDays(MON, 1))}~${mdCN(addDays(MON, 4))} 四列`, cross && Number(cross.ge) - Number(cross.gs) === 4, JSON.stringify(cross));
check("溢出折成「还有 N 个任务」", (await num(".vm-more")) > 0 && /还有\d+个任务/.test(await txt(".vm-more")), await txt(".vm-more"));
check("条色默认按清单 = #A9C6A8", (await gridBars()).some((b) => b.bg === "rgb(169, 198, 168)"), JSON.stringify((await gridBars()).slice(0, 2)));

await click(".vm-title", "", grid.indexOf(T));            // 整周补齐后的今天那一格
check("点格子开当日弹层", (await num(".vp")) === 1 && (await txt(".vp-head")).includes(mdCN(T)), await txt(".vp-head") + " vs " + mdCN(T));
check("当日弹层列出事项与习惯", (await num(".vp-row")) >= 2, String(await num(".vp-row")));
await key("Escape");
check("Esc 关当日弹层", (await num(".vp")) === 0);

await click(".vbar", "学习算法");
check("点彩条开事项详情", (await num(".item-modal")) === 1, await txt(".item-modal .im-title"));
await key("Escape");
check("Esc 关详情", (await num(".item-modal")) === 0);

await click(".v-arrow", "", 1);
check("下个月标题走对", (await txt(".v-title")) === monthCN(addMonths(T, 1)), await txt(".v-title") + " vs " + monthCN(addMonths(T, 1)));
check("区间外出现「回到今天」高亮", (await num(".v-today.is-on")) === 1);
await click(".v-today");
check("点回到今天拉回本月", (await txt(".v-title")) === monthCN(T) && (await num(".v-today.is-on")) === 0);

console.log("\n=== 视图：周视图 ===");
await click(".v-type", "周视图", 0, 500);
check("24 行小时 + 7 列", (await num(".vw-hour")) === 24 && (await num(".vw-col")) === 7, (await num(".vw-hour")) + "行/" + (await num(".vw-col")) + "列");
check("周标题 = 本周一~本周日", (await txt(".v-title")) === weekTitleCN(T), await txt(".v-title") + " vs " + weekTitleCN(T));
check("表头 7 天、今天标「今」", (await num(".vw-day")) === 7 && (await txt(".vw-day.is-today .vw-num")) === "今");
// 初始滚动按渲染出来的行高换算（--hour-h 是 clamp()，解析原字符串会退化成 56 的下界）。
// 平滑滚动要跑几百毫秒，先等它停稳再量。
// 夜里 22/23 点的目标是 20/21 行，窗口矮的时候根本滚不到——到底就截断，所以断言取 min(目标, 上限)。
await sleep(900);
const scroll = await json(`(()=>{const el=document.querySelector(".vw-scroll");` +
  `const row=el.querySelector(".vw-hour");const h=row.getBoundingClientRect().height;` +
  `return JSON.stringify({at:el.scrollTop/h,cap:(el.scrollHeight-el.clientHeight)/h})})()`);
const targetHour = new Date().getHours() - 2;
const wantHour = Math.min(targetHour, Math.floor(scroll.cap));
check("打开就滚到当前时刻前两小时", Math.abs(scroll.at - wantHour) <= 1,
  `${scroll.at.toFixed(1)} vs ${wantHour}${scroll.at < targetHour - 1 ? "（已到上限 " + scroll.cap.toFixed(1) + " 行）" : ""}`);
const nowHM = await evalJs(`(()=>{const d=new Date();return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")})()`);
check("今天列有实心红线与时刻", (await num(".vw-line.is-now")) === 1 && (await txt(".vw-now")) === nowHM, await txt(".vw-now") + " vs " + nowHM);
check("其余 6 列淡红线", (await num(".vw-line:not(.is-now)")) === 6);

// 参考站把带时刻的事项放小时网格，全天区只留全天/习惯（evidence-week-day §1.2 matters 与 hourMatters 分开）
await click(".v-arrow", "", 1);
await sleep(400);
check("切到下一周", (await txt(".v-title")) === weekTitleCN(addDays(MON, 7)), await txt(".v-title") + " vs " + weekTitleCN(addDays(MON, 7)));
const ad = await txt(".vw-allday");
check("全天区不混入带时刻事项", !/早会|评审|写周报/.test(ad), ad);
const timed = (await gridBars()).filter((b) => /早会|评审|写周报/.test(b.t));
check("带时刻事项落在小时网格", timed.length === 3, JSON.stringify(timed.map((b) => b.t)));
const zao = timed.find((b) => b.t.includes("早会")), shen = timed.find((b) => b.t.includes("评审"));
check("重叠事项并排分栏（同列不等宽）", zao && shen && zao.l !== shen.l && zao.w === shen.w && zao.w < 200, JSON.stringify([zao, shen]));
check("时段条高度随时长变化", shen && zao && shen.h > zao.h * 2, JSON.stringify([zao.h, shen.h]));
check("时间点事项用最小块高", (await gridBars()).some((b) => b.t.includes("写周报") && b.h <= 30));

console.log("\n=== 视图：日视图 ===");
await click(".v-type", "日视图", 0, 500);
await click(".v-today", "", 0, 500);                              // 先回到今天，再按差值翻到带时刻事项那天
for (let i = 0; i < diffDays(T, timedDay); i++) await click(".v-arrow", "", 1, 240);
check("日视图只有 1 列", (await num(".vw-col")) === 1 && (await num(".vw-hour")) === 24);
check("标题落在带时刻事项那天", (await txt(".v-title")) === dayTitleCN(timedDay), await txt(".v-title") + " vs " + dayTitleCN(timedDay));
check("全天区 1 条 + 计数行", (await num(".vw-lane")) === 2 && !/早会/.test(await txt(".vw-allday")));

console.log("\n=== 视图：折叠小时段 ===");
/** 把某一小时行滚到视口中间：一屏只装得下 4~5 行，靠 --hour-h 反推会被 clamp() 骗到，直接量元素。
 *  注意用绝对赋值：`scrollTop += 表达式` 在这里会被算成 NaN 而静默失效。 */
async function scrollToHour(label) {
  await evalJs(`(()=>{const el=document.querySelector(".vw-scroll");el.style.scrollBehavior="auto";` +
    `const row=[...document.querySelectorAll(".vw-hour")].find(x=>x.innerText.startsWith(${JSON.stringify(label)}));` +
    `if(!row)return;const box=el.getBoundingClientRect();const r=row.getBoundingClientRect();` +
    `el.scrollTop=Math.max(0,r.top-box.top+el.scrollTop-box.height/2+r.height/2)})()`);
  await sleep(220);
  return json(`(()=>{const el=document.querySelector(".vw-scroll");const box=el.getBoundingClientRect();` +
    `const row=[...document.querySelectorAll(".vw-hour")].find(x=>x.innerText.startsWith(${JSON.stringify(label)}));` +
    `const r=row.getBoundingClientRect();return JSON.stringify(r.top>box.top+4&&r.bottom<box.bottom-4)})()`);
}
check("把 11:00 行滚进视口", await scrollToHour("11:00") === true);
await hover(".vw-hour", "11:00");
check("中间安全带（10-13 点）不给折叠", (await num(".vw-fold-switch")) === 0, String(await num(".vw-fold-switch")));
check("把 14:00 行滚进视口", await scrollToHour("14:00") === true);
await hover(".vw-hour", "14:00");
check("hover 安全带外的小时出现折叠箭头", (await num(".vw-fold-switch")) === 1);
await click(".vw-fold-switch button", "", 0, 500);
check("折叠 14 点之前：出现折叠汇总行", (await num(".vw-fold")) === 1);
const rest = await num(".vw-hour");
check("剩余小时行变少且从 14 点起", rest === 10 && (await txt(".vw-hour-text")) === "14:00", String(rest) + "/" + await txt(".vw-hour-text"));
await evalJs(`document.querySelector(".vw-scroll").scrollTop=0`);   // 展开按钮在折叠行里，先滚回顶部才点得到
await sleep(200);
await click(".vw-fold-btn", "展开", 0, 600);
check("展开恢复 24 行", (await num(".vw-hour")) === 24 && (await num(".vw-fold")) === 0, String(await num(".vw-hour")));

console.log("\n=== 视图：自定义视图（内容） ===");
await click(".v-type", "月视图", 0, 500);
await click(".v-entry", "自定义视图");
check("下拉两项：内容 / 颜色", (await num(".vc-menu button")) === 2 && (await txt(".vc-menu")).includes("自定义视图颜色"), await txt(".vc-menu"));
await click(".vc-menu button", "自定义视图内容");
check("内容弹窗有清单/习惯页签与无分类行", (await num(".vc-tab")) === 2 && (await txt(".vc-list")).includes("无分类"), await txt(".vc-list"));
const beforeBars = (await gridBars()).length;
await click(".vc-row", "无分类");
check("取消勾选后该行变未选", (await evalJs(`[...document.querySelectorAll(".vc-row")].find(r=>r.innerText.includes("无分类")).querySelector(".vc-mark").className.includes("is-on")`)) === false);
await click(".vc-row", "全部");
await click(".vc-foot .cc-btn", "取消", 0, 400);
check("取消 = 丢弃草稿，配置没落盘", (await evalJs(`!!document.querySelector(".vc-mask")`)) === false && (await gridBars()).length === beforeBars);
await click(".v-entry", "自定义视图");
await click(".vc-menu button", "自定义视图内容");
await click(".vc-row", "无分类");
await click(".vc-foot .cc-btn", "保存", 0, 700);
const afterHide = await gridBars();
check("隐藏无分类后事项条清空", afterHide.length === 0 || afterHide.every((b) => !/学习算法|跨天出差|整理桌面/.test(b.t)), JSON.stringify(afterHide.map((b) => b.t)));
check("习惯条不受清单侧过滤影响", afterHide.length > 0, JSON.stringify(afterHide.map((b) => b.t)));
await click(".v-entry", "自定义视图");
await click(".vc-menu button", "自定义视图内容");
check("回显按已存值：无分类未选、全部未选", (await txt(".vc-list")).length > 0 && (await evalJs(`[...document.querySelectorAll(".vc-mark")].filter(m=>m.className.includes("is-on")).length`)) === 0);
await click(".vc-row", "全部");
await click(".vc-foot .cc-btn", "保存", 0, 700);
check("恢复全部后事项条回来", (await gridBars()).length >= beforeBars, String((await gridBars()).length));

console.log("\n=== 视图：自定义视图（颜色） ===");
await click(".v-entry", "自定义视图");
await click(".vc-menu button", "自定义视图颜色");
check("清单页签 4 个模式", (await num(".vc-row")) === 4 && (await txt(".vc-list")).includes("设置固定颜色"), await txt(".vc-list"));
await click(".vc-row", "按优先级");
await click(".vc-foot .cc-btn", "保存", 0, 700);
const prio = await gridBars();
check("按优先级后不再是清单绿", prio.length > 0 && prio.some((b) => b.bg !== "rgb(169, 198, 168)"), JSON.stringify(prio.slice(0, 3).map((b) => b.bg)));
await click(".v-entry", "自定义视图");
await click(".vc-menu button", "自定义视图颜色");
await click(".vc-tab", "习惯");
check("习惯页签 2 个模式", (await num(".vc-row")) === 2 && (await txt(".vc-list")).includes("跟随习惯图标颜色"), await txt(".vc-list"));
await click(".vc-tab", "清单");
await click(".vc-row", "设置固定颜色");
check("没选过固定色时先弹色板", (await num(".vc-card-palette")) === 1 && (await num(".vc-palette button")) === 30, String(await num(".vc-palette button")));
check("色板未选色时保存禁用", (await evalJs(`document.querySelector(".vc-card-palette .cc-btn.is-primary").disabled`)) === true);
await click(".vc-palette button", "", 2);
check("选中态描边落在被点的色块", (await evalJs(`document.querySelectorAll(".vc-palette .vc-cell")[2].className.includes("is-sel")`)) === true);
await click(".vc-card-palette .cc-btn.is-primary", "", 0, 500);
await click(".vc-foot .cc-btn", "保存", 0, 700);
const fixed = await gridBars();
check("固定色生效：事项条统一成 #D4E2FE", fixed.length > 0 && fixed.filter((b) => b.bg === "rgb(212, 226, 254)").length > 0, JSON.stringify(fixed.slice(0, 3).map((b) => b.bg)));
await click(".v-entry", "自定义视图");
await click(".vc-menu button", "自定义视图颜色");
check("回显固定色色块", (await evalJs(`document.querySelector(".vc-swatch")?.style.background`)) === "rgb(212, 226, 254)", String(await evalJs(`document.querySelector(".vc-swatch")?.style.background`)));
await click(".vc-row", "按清单详情设置");
await click(".vc-foot .cc-btn", "保存", 0, 700);
check("恢复按清单后回到清单绿", (await gridBars()).some((b) => b.bg === "rgb(169, 198, 168)"));

console.log("\n=== 视图：设置两个开关 ===");
await click(".v-type", "日视图", 0, 500);
for (let i = 0; i < diffDays(yday, timedDay); i++) await click(".v-arrow", "", 0, 260);   // → 昨天（种子把已打卡样本放在昨天）
check("落在昨天", (await txt(".v-title")) === dayTitleCN(yday), await txt(".v-title") + " vs " + dayTitleCN(yday));
// 断言按「差值」而不按绝对条数：昨天恒定有 4 事项（其中「复盘D」已打卡）+ 每天一次习惯「喝水」（已打满），
// 但每周 1/3/5 的「早睡」是否排在昨天取决于昨天是周几，绝对数会跟着抖。
const moreN = async () => Number((await txt(".vm-more")).match(/(\d+)/)?.[1]);
const n0 = await moreN();
check("默认显示已打卡：折出「还有 N 个任务」", n0 > 0, await txt(".vm-more"));
await click(".v-entry", "设置");
check("设置下拉两条开关", (await num(".vc-menu button")) === 2 && (await txt(".vc-menu")).includes("显示已打卡习惯"), await txt(".vc-menu"));
check("开关默认全开", (await num(".vc-sw.is-on")) === 2);
/** 点完一条开关菜单仍开着（参考站就是这样），所以先确认开着、点完用 Esc 收。 */
async function setSwitch(label) {
  if ((await num(".vc-menu")) === 0) await click(".v-entry", "设置");
  await click(".vc-menu button", label);
  await sleep(500);
  await key("Escape");
}
await setSwitch("显示已打卡清单");
const n1 = await moreN();
check("关掉已打卡清单：已打卡事项不再计入（少 1 条）", n1 === n0 - 1, `${n0} → ${n1}`);
await setSwitch("显示已打卡习惯");
const n2 = await moreN();
check("两个开关都关：已打卡习惯也不再计入（再少 1 条）", n2 === n1 - 1, `${n1} → ${n2}`);
await setSwitch("显示已打卡清单");
await setSwitch("显示已打卡习惯");
const n3 = await moreN();
check("恢复后条数回到原样", n3 === n0, `${n2} → ${n3}，基准 ${n0}`);
await click(".v-entry", "设置", 0, 400);
check("两条开关回到开", (await num(".vc-sw.is-on")) === 2, String(await num(".vc-sw.is-on")));
await key("Escape");

console.log("\n结果：通过 " + pass + "，失败 " + fail);
ws.close();
process.exit(fail ? 1 : 0);

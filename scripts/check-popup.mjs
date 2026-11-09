#!/usr/bin/env node
// 弹层几何常驻自检：**定位** 与 **不溢出**，每个弹层都要过。
//
// 这是 2026-11-09 用户定的两条必测项：
//   ① 定位：弹层必须贴在触发器旁边，不能飘到别处；
//   ② 不溢出：弹层内容不能超出弹层框。
// 当天就靠这两条抓到两个真 bug：备忘录「…」排序菜单飘到编辑区、
// 背景图弹层有一半在视口外；再加上回收站复选框的全局 margin 漏进菜单选中行。
//
// 交互用 CDP 派发真鼠标事件（CI 的 Windows runner 上没有 agent-desktop，
// 且 headless 语义通道点不动 WebView2 的 contextmenu 事件）；
// 本机想用 agent-desktop 走一遍语义点击，用 scripts/sweep-popup-uia.mjs。
//
// 用法：node scripts/check-popup.mjs [端口]
import fs from "node:fs";
import { CASES } from "./lib/popups.mjs";
import { probeExpr, judgePopup } from "./lib/geom.mjs";

const PORT = process.argv[2] || "9256";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find((t) => t.type === "page" && (t.url || "").startsWith("http://wails.localhost"));
if (!target) { console.error("没找到应用页面，先跑 scripts/verify-restart.sh " + PORT); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws 失败")); });
let mid = 0; const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.j(new Error(m.error.message)) : p.r(m.result); }
});
const send = (method, params = {}) => new Promise((r, j) => { const id = ++mid; pending.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;

let pass = 0, fail = 0, skip = 0;
const failures = [];
const check = (n, ok, d) => { ok ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? "  → " + d : ""))); };

/** 元素中心（视口坐标）。 */
async function centerOf(sel, text) {
  const v = await evalJs(`(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})];` +
    `const e=${text ? `L.filter(x=>(x.innerText||"").includes(${JSON.stringify(text)}))` : "L"}[0];if(!e)return "null";` +
    `e.scrollIntoView({block:"center",inline:"center"});` +
    `const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
  return v ? JSON.parse(v) : null;
}
async function mouseAt(pt, button) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button, clickCount: 1, buttons: button === "right" ? 2 : 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button, clickCount: 1, buttons: 0 });
  await sleep(320);
}
async function clickSel(sel, text, wait = 320) {
  const pt = await centerOf(sel, text);
  if (!pt) return false;
  await mouseAt(pt, "left");
  await sleep(wait);
  return true;
}
async function rightClickSel(sel, wait = 320) {
  const pt = await centerOf(sel);
  if (!pt) return false;
  await mouseAt(pt, "right");
  await sleep(wait);
  return true;
}
async function fillSel(sel, value) {
  const pt = await centerOf(sel);
  if (!pt) return false;
  await mouseAt(pt, "left");
  await sleep(150);
  await send("Input.insertText", { text: value });
  await sleep(250);
  return true;
}
const exists = async (sel) => !!(await evalJs(`!!document.querySelector(${JSON.stringify(sel)})`));
/** 切模块：点左栏。 */
async function gotoTab(label) {
  const ok = await clickSel(".rail-item", label, 600);
  await sleep(400);
  return ok;
}

console.log(`=== 弹层几何自检（定位 / 不溢出）===\n`);
for (const c of CASES) {
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(200);
  if (c.tab && !(await gotoTab(c.tab))) { console.log(`  – ${c.label}  SKIP（切不到「${c.tab}」）`); skip++; continue; }

  let prepOk = true;
  for (const s of c.prep || []) {
    const ok = s.kind === "fill" ? await fillSel(s.css, s.value) : await clickSel(s.css, s.text, 500);
    if (!ok) { prepOk = false; break; }
    await sleep(300);
  }
  if (!prepOk) { console.log(`  – ${c.label}  SKIP（造数据失败）`); skip++; continue; }

  let opened = true, point = null;
  const steps = c.steps || [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (i === steps.length - 1 && c.anchorMode === "point") point = await centerOf(s.css, s.text);
    const ok = s.kind === "rightclick" ? await rightClickSel(s.css, 400) : await clickSel(s.css, s.text, 400);
    if (!ok) { opened = false; break; }
    await sleep(250);
  }
  if (!opened) { console.log(`  – ${c.label}  SKIP（触发器点不到）`); skip++; continue; }

  const probe = await evalJs(probeExpr(c.popup, c.anchor));
  const g = probe ? JSON.parse(probe) : null;
  if (!g || !g.popup) {
    if (c.optional) { console.log(`  – ${c.label}  SKIP（弹层没出现）`); skip++; continue; }
    check(c.label + " · 弹层能打开", false, `${c.popup} 没出现`);
    failures.push({ id: c.id, label: c.label, problems: ["弹层没出现"], g });
    continue;
  }
  const judged = judgePopup(g, { anchorMode: c.anchorMode, point });
  check(c.label, judged.ok, judged.problems.join("；"));
  if (!judged.ok) failures.push({ id: c.id, label: c.label, problems: judged.problems, g });
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(200);
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}，跳过 ${skip}`);
if (failures.length) {
  console.log("\n失败明细：");
  for (const f of failures) {
    console.log(`  [${f.id}] ${f.label}`);
    for (const p of f.problems) console.log(`      - ${p}`);
    console.log(`      弹层 ${JSON.stringify(f.g?.popup)}  触发器 ${JSON.stringify(f.g?.anchor)}`);
  }
  process.exit(1);
}
ws.close();
process.exit(0);

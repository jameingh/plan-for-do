#!/usr/bin/env node
// 全应用弹层实机巡检（agent-desktop 驱动）。
//
// 必测两项，对每个弹层都过一遍：
//   ① 定位：弹层贴在触发器旁边（右键菜单贴在鼠标位置），不能飘；
//   ② 不溢出：弹层内容不能超出弹层框。
//
// 分工：交互走 agent-desktop（语义点击，headless、不抢前台、跟真人一样点得到），
// 几何走 CDP（UIA 拿不到 scrollWidth，溢出的判据只能在 DOM 层量）。
//
// 用法：node scripts/sweep-popup-uia.mjs [端口] [--shot]
//   端口默认 9256（scripts/verify-restart.sh 起的那套隔离实例）
//   --shot 额外给每个弹层存一张截图到 tmp/popup-*.png
import { execFile } from "node:child_process";
import fs from "node:fs";
import { CASES, RAIL_ORDER } from "./lib/popups.mjs";
import { probeExpr, judgePopup } from "./lib/geom.mjs";

const PORT = process.argv[2] || "9256";
const SHOT = process.argv.includes("--shot");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ————————————————————————————— CDP —————————————————————————————
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

async function shot(file) {
  try {
    const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  } catch { /* 截图失败不影响判定 */ }
}

// ————————————————————————— agent-desktop —————————————————————————
// agent-desktop 在 Windows 上装的是 npm 包，PATH 里的 `agent-desktop` 是 POSIX sh shim；
// Node 的 execFile 不带 shell 跑不了 sh shim（ENOENT），所以这里直接找原生 exe——
// 顺带还省掉 Node launcher 的 ~125ms 启动开销。
async function resolveAd() {
  const cands = [];
  if (process.env.AGENT_DESKTOP_BIN) cands.push(process.env.AGENT_DESKTOP_BIN);
  try {
    const so = await new Promise((res, rej) => execFile("npm", ["root", "-g"], { shell: true },
      (e, stdout) => e ? rej(e) : res(stdout)));
    const root = so.trim().replace(/\\/g, "/");
    cands.push(`${root}/agent-desktop/bin/agent-desktop-win32-x64.exe`);
    cands.push(`${root}/agent-desktop/bin/agent-desktop-win32-arm64.exe`);
  } catch { /* npm 不在 PATH 就走下面的兜底 */ }
  cands.push("C:/Users/Public/Programs/AgentDesktop/node_modules/agent-desktop/bin/agent-desktop-win32-x64.exe");
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return "agent-desktop";
}
const AD = await resolveAd();
const AD_SHELL = !fs.existsSync(AD);   // 兜底到 sh shim 时才需要 shell

function ad(args) {
  return new Promise((res, rej) => {
    execFile(AD, args, { maxBuffer: 1 << 24, shell: AD_SHELL }, (err, stdout, stderr) => {
      if (err) return rej(new Error(`${args[0]} 失败: ${err.message} ${String(stderr).slice(0, 200)}`));
      try { res(JSON.parse(stdout)); } catch { rej(new Error(`${args[0]} 输出不是 JSON: ${String(stdout).slice(0, 200)}`)); }
    });
  });
}

/** 找到应用进程名（planfordo.exe / planfordo-verify.exe）。 */
async function appName() {
  const r = await ad(["list-apps"]);
  const apps = (r.data?.apps || r.data || []).map((a) => a.name || a.process_name || "");
  const hit = apps.find((n) => /planfordo/i.test(n));
  return hit || "planfordo.exe";
}
const APP = await appName();

/** 按可访问名（或可见文字）找元素，返回 ref_id；找不到返回 null。
 *  注意：不要加 --role —— 「--name X --role button」这种组合 agent-desktop 会直接报错退出，
 *  角色在下面自己过滤更稳。 */
async function findRef({ name, text, role }) {
  const args = ["find", "--app", APP];
  if (name) args.push("--name", name); else args.push("--text", text);
  let ms = [];
  // 刚切完页时 WebView2 的可访问树会晚一拍，这里重试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await ad(args).catch(() => null);
    if (!r || !r.ok) return null;
    ms = r.data?.matches || [];
    if (ms.length) break;
    await sleep(600);
  }
  if (role) ms = ms.filter((m) => m.role === role);
  if (!ms.length) return null;
  // 优先：可访问名完全相等 > 名字以查询串开头（「备忘录：」要命中「备忘录：无标题」，
  // 又不能误中左栏那个「备忘录」按钮） > 第一个可交互的
  const pick = ms.find((m) => m.name === (name || text) && m.interactive)
    || ms.find((m) => m.name && m.name.startsWith(name || text) && m.interactive)
    || ms.find((m) => m.interactive)
    || ms[0];
  return pick.ref_id || null;
}

/** 诊断用：这个查询在窗口里到底看到了什么。 */
async function diag({ name, text, role }) {
  const args = ["find", "--app", APP];
  if (name) args.push("--name", name); else args.push("--text", text);
  const r = await ad(args).catch(() => null);
  if (!r) return "查询失败";
  if (!r.ok) return "查询被拒：" + (r.error?.code || r.error?.message || "").slice(0, 60);
  let ms = r.data?.matches || [];
  if (role) ms = ms.filter((m) => m.role === role);
  if (!ms.length) return "窗口里没有匹配元素";
  return ms.slice(0, 4).map((m) => `${m.role}:${m.name ?? ""}${m.ref_id ? "" : "(无ref)"}`).join(" / ");
}

async function clickRef(ref) {
  const r = await ad(["batch", JSON.stringify([
    { command: "click", args: { ref_id: ref } },
    { command: "wait", args: { ms: 500 } },
  ])]);
  return r.ok;
}
async function rightClickRef(ref) {
  const r = await ad(["batch", JSON.stringify([
    { command: "right-click", args: { ref_id: ref } },
    { command: "wait", args: { ms: 500 } },
  ])]);
  return r.ok;
}
async function pressEscape() {
  await ad(["batch", JSON.stringify([
    { command: "press", args: { combo: "escape" } },
    { command: "wait", args: { ms: 400 } },
  ])]);
}

/** 元素中心点（视口坐标）——点定位类弹层要拿它当「鼠标点在哪」。 */
const centerOf = async (sel, text) => {
  const v = await evalJs(`(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})];` +
    `const e=${text ? `L.filter(x=>(x.innerText||"").includes(${JSON.stringify(text)}))` : "L"}[0];if(!e)return null;` +
    `const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
  return v ? JSON.parse(v) : null;
};

/** CDP 真鼠标事件——agent-desktop 语义通道点不动时的回退。 */
async function cdpMouse(sel, button, text) {
  const pt = await centerOf(sel, text);
  if (!pt) return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button, clickCount: 1, buttons: button === "right" ? 2 : 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button, clickCount: 1, buttons: 0 });
  await sleep(450);
  return true;
}

/** CDP 往输入框里写字。 */
async function cdpFill(sel, text) {
  const pt = await centerOf(sel);
  if (!pt) return false;
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1, buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1, buttons: 0 });
  await sleep(150);
  await send("Input.insertText", { text });
  await sleep(250);
  return true;
}

/** 是不是有浮层冒出来了（用来判断 agent-desktop 那一下到底有没有生效）。
 *  模态框和抽屉也要算：少了它们，语义点击已经打开弹窗时还会再补一次 CDP 点击，
 *  那一下正好落在遮罩上，把刚打开的弹窗又关了。 */
const ANY_POPUP = ".menu-box, .ctx-menu, .folder-box, .pop-panel, .color-box, .back-box, .np-pop, .hm-unit-pop, .filter-pop, .avatar-menu, .fc-task-menu, .modal, .modal-mask, .item-modal, .hm-icon-page, .habit-modal, .fc-pick, .folder-manage, .body-recycle-bin";
const anyPopupOpen = async () => !!(await evalJs(`!!document.querySelector(${JSON.stringify(ANY_POPUP)})`));
/** 某个选择器在不在。 */
const exists = async (sel) => !!(await evalJs(`!!document.querySelector(${JSON.stringify(sel)})`));

/** 切模块：点左栏按钮，并用 CDP 确认真的切过去了（点到了不代表切成功）。 */
async function gotoTab(label) {
  for (let i = 0; i < 3; i++) {
    const ref = await findRef({ name: label, role: "button" });
    if (ref) { await clickRef(ref); await sleep(800); }
    const active = await evalJs(`(()=>{const L=[...document.querySelectorAll('.rail-item')];` +
      `const b=L.find(e=>(e.innerText||"").trim()===${JSON.stringify(label)});return b?b.className.includes('is-active'):false})()`);
    if (active) return true;
    await sleep(400);
  }
  return false;
}

// ——————————————————————————— 跑用例 ———————————————————————————
let pass = 0, fail = 0, skip = 0;
const failures = [];

for (const c of CASES) {
  if (ONLY && !c.id.includes(ONLY)) continue;
  const label = c.label;

  // 收干净：关掉可能开着的浮层
  await evalJs(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(250);
  // 每条用例都显式切到自己的模块（不能假设实例起始页就是它）
  if (c.tab) {
    const ok = await gotoTab(c.tab);
    if (!ok) { console.log(`  – ${label}  SKIP（切不到「${c.tab}」）`); skip++; continue; }
  }

  // prep：造数据。走 CDP 而不是语义点击——「新建清单」这类按钮在窗口里有好几个同名孪生，
  // 语义点击会挑错那个；造数据也不是被测对象，精度优先。
  let prepOk = true;
  for (const s of c.prep || []) {
    const ok = s.kind === "fill" ? await cdpFill(s.css, s.value) : await cdpMouse(s.css, "left", s.text);
    if (!ok) { prepOk = false; break; }
    await sleep(450);
  }
  if (!prepOk) { console.log(`  – ${label}  SKIP（造数据失败）`); skip++; continue; }

  // steps：打开弹层；最后一步的元素中心就是点定位的参考点
  let opened = true, point = null, failedStep = null, via = null;
  for (let i = 0; i < (c.steps || []).length; i++) {
    const s = c.steps[i];
    const last = i === c.steps.length - 1;
    if (last && c.anchorMode === "point") point = await centerOf(c.pointSel || s.css, c.pointSel ? undefined : s.text);
    let hit = false;
    if (s.kind === "fill") {
      hit = await cdpFill(s.css, s.value);           // 填字没有语义通道，用 CDP
      via = via || "cdp";
    } else {
      // 优先用 agent-desktop 语义点击，但只对「按可访问名寻址」的步骤：
      // 按文字寻址时 agent-desktop 会把整个窗口也匹配上（它把整页文本算进 name），
      // 点下去会误触遮罩把浮层关掉；这类步骤（以及只有 CSS 的）走 CDP 更准。
      const preferAD = !!s.name;
      const ref = preferAD ? await findRef({ name: s.name, text: s.text }) : null;
      if (ref) {
        await (s.kind === "rightclick" ? rightClickRef(ref) : clickRef(ref));
        await sleep(400);
        // 最后一步要看「目标弹层真的出现了」才算数；中间步骤只能看「有浮层冒出来了」
        hit = last ? await exists(c.popup) : await anyPopupOpen();
        if (hit) via = via || "agent-desktop";
      }
      if (!hit) {
        const ok = await cdpMouse(s.css, s.kind === "rightclick" ? "right" : "left", s.text);
        if (ok) { hit = last ? await exists(c.popup) : true; via = via || "cdp"; }
      }
    }
    if (!hit) { opened = false; failedStep = s; break; }
    await sleep(200);
  }
  if (!opened) {
    console.log(`  – ${label}  SKIP（触发器点不到：${await diag(failedStep || {})}）`);
    skip++; continue;
  }

  // 量几何
  const probe = await evalJs(probeExpr(c.popup, c.anchor));
  const g = probe ? JSON.parse(probe) : null;
  if (!g || !g.popup) {
    console.log(`  – ${label}  SKIP（弹层 ${c.popup} 没出现）`);
    skip++; continue;
  }

  const judged = judgePopup(g, { anchorMode: c.anchorMode, point });
  const tag = judged.ok ? "✓" : "✗";
  console.log(`  ${tag} ${label}` + (via ? `  [${via}]` : "") + (judged.ok ? "" : "  → " + judged.problems.join("；")));
  if (judged.ok) pass++; else { fail++; failures.push({ id: c.id, label, problems: judged.problems, g }); }

  if (SHOT) await shot(`tmp/popup-${c.id}.png`);
  await pressEscape();
  await sleep(300);
}

console.log(`\n结果：通过 ${pass}，失败 ${fail}，跳过 ${skip}`);
if (failures.length) {
  console.log("\n失败明细：");
  for (const f of failures) {
    console.log(`  [${f.id}] ${f.label}`);
    for (const p of f.problems) console.log(`      - ${p}`);
    console.log(`      弹层 ${JSON.stringify(f.g.popup)}  触发器 ${JSON.stringify(f.g.anchor)}`);
  }
  process.exit(1);
}
ws.close();
process.exit(0);

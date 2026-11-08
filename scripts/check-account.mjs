// 头像菜单与「个人中心」占位页自检：真实鼠标与键盘事件走一遍，断言交互与页面结构。
// 用法：node scripts/check-account.mjs [端口]     （先跑 scripts/verify-restart.sh 9255 list）
// 只动隔离数据目录，不碰用户真实数据。
const port = process.argv[2] || "9255";
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
  if (out.exceptionDetails) throw new Error(String(out.exceptionDetails.exception?.description || out.exceptionDetails.text).split("\n")[0]);
  return out.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function clickXY(x, y, wait = 300) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  }
  await sleep(wait);
}
async function clickAt(sel, text, wait = 320) {
  // 设置页很长，目标可能在视口外；先滚进来再量坐标，否则点空（CI 的 700px 窗口尤其容易）。
  await evalJs(`(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})];` +
    `const e=${text ? `L.find(x=>(x.innerText||"").includes(${JSON.stringify(text)}))` : "L[0]"};` +
    `if(e)e.scrollIntoView({block:"center"});return 1})()`);
  await sleep(250);
  const pt = JSON.parse(await evalJs(`(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})];` +
    `const e=${text ? `L.find(x=>(x.innerText||"").includes(${JSON.stringify(text)}))` : "L[0]"};if(!e)return JSON.stringify(null);` +
    `const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`));
  if (!pt) throw new Error("找不到 " + sel + " " + (text || ""));
  await clickXY(pt.x, pt.y, wait);
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

const menu = async () => JSON.parse(await evalJs(`(()=>{const m=document.querySelector(".avatar-menu");if(!m)return JSON.stringify(null);
const r=m.getBoundingClientRect();return JSON.stringify({items:[...m.querySelectorAll("[role=menuitem]")].map(e=>e.innerText.trim()),
w:Math.round(r.width),left:Math.round(r.left),top:Math.round(r.top)})})()`));
const page = async () => JSON.parse(await evalJs(`(()=>{const p=document.querySelector(".account-page");
const r={account:!!p,lists:!!document.querySelector(".board"),habits:!!document.querySelector(".datestrip"),settings:!!document.querySelector(".set-block"),
 toast:(document.querySelector(".toast-stack")||{}).innerText||""};
if(!p)return JSON.stringify(r);
r.head=(p.querySelector(".ac-title")||{}).innerText||"";r.cards=p.querySelectorAll(".ac-card").length;
r.rows=[...p.querySelectorAll(".ac-row")].map(e=>e.innerText.replace(/\\s+/g," ").trim());
r.guide=(p.querySelector(".ac-nick")||{}).innerText||"";r.tabs=[...p.querySelectorAll(".ac-tabs li")].map(e=>e.innerText.trim());
return JSON.stringify(r)})()`));
const toastText = () => evalJs(`(()=>{const t=document.querySelector(".toast-stack");return t?t.innerText.replace(/\\s+/g," ").trim():""})()`);

console.log("\n=== 头像菜单 ===");
await clickAt(".rail-avatar", null, 400);
let m = await menu();
check("点头像弹出菜单，两项＝个人中心 / 退出登录", m && m.items.join(",") === "个人中心,退出登录", JSON.stringify(m));
check("菜单贴在左栏右侧、宽 150（参考站 .items 同形，位置让开头像）", m && m.left > 64 && m.top > 30 && m.w === 150, JSON.stringify(m));
// 点遮罩任意处关闭（参考站就是 curtain-transparent 全屏关）
await clickXY(520, 480, 350);
check("点屏幕任意处菜单关闭", (await menu()) === null);
check("点遮罩不会误跳页面", (await page()).account === false);
await clickAt(".rail-avatar", null, 400);
check("遮罩关过一次后，头像仍能正常打开", (await menu()) !== null);
await clickAt(".rail-avatar", null, 400);
check("头像再点一次收起（toggle 成立，遮罩没吃掉点击）", (await menu()) === null);
await key("Escape");
check("Esc 关掉菜单", (await menu()) === null);
// 菜单开着时点模块：切页的同时菜单必须一起收起，不能留一层透明遮罩挡住界面
await clickAt(".rail-avatar", null, 400);
await clickAt(".rail-item", "习惯", 700);
const afterNav = JSON.parse(await evalJs(`(()=>JSON.stringify({menu:!!document.querySelector(".avatar-menu"),curtain:!!document.querySelector(".avatar-curtain"),habits:!!document.querySelector(".datestrip")}))()`));
check("菜单开着点模块：切页成功且不留遮罩", afterNav.menu === false && afterNav.curtain === false && afterNav.habits === true, JSON.stringify(afterNav));

console.log("\n=== 个人中心（占位页）===");
await clickAt(".rail-avatar", null, 400);
await clickAt(".avatar-menu [role=menuitem]", "个人中心", 500);
let p = await page();
check("菜单选完即关，进入个人中心", (await menu()) === null && p.account === true, JSON.stringify(p).slice(0, 120));
check("标题是「个人中心」，三张白卡", p.head === "个人中心" && p.cards === 3, JSON.stringify({ h: p.head, c: p.cards }));
check("左引导有头像与「本地用户」，页签只有个人中心", p.guide === "本地用户" && p.tabs.join() === "个人中心", JSON.stringify(p));
check("账号卡写明未登录", p.rows.some((x) => /账号 未登录 · 数据都在这台设备上/.test(x)), JSON.stringify(p.rows));
check("本机数据卡是真值（数据目录/设备 ID）", p.rows.some((x) => /vdata/.test(x)) && p.rows.some((x) => /设备 ID \S{6,}/.test(x)), JSON.stringify(p.rows));
check("清单页已让位（不再渲染看板）", p.lists === false);
await clickAt(".ac-return", null, 450);
p = await page();
check("左上角「返回」回到进入前的页面（这里是习惯页）", p.account === false && p.habits === true, JSON.stringify(p).slice(0, 140));

console.log("\n=== 返回跟着来路走 ===");
await clickAt(".rail-item", "设置", 700);
await clickAt(".rail-avatar", null, 400);
await clickAt(".avatar-menu [role=menuitem]", "个人中心", 500);
await clickAt(".ac-return", null, 600);
const backSettings = JSON.parse(await evalJs(`(()=>JSON.stringify({account:!!document.querySelector(".account-page"),settings:!!document.querySelector(".set-block")}))()`));
check("从设置页进的，返回回设置页", backSettings.account === false && backSettings.settings === true, JSON.stringify(backSettings));

console.log("\n=== 设置页：节假日与调休 ===");
// 这一节是「班/休」与「法定工作日」的数据交代处：覆盖哪几年、出处、往哪导入，都得看得见。
const cal = JSON.parse(await evalJs(`(()=>{const b=[...document.querySelectorAll(".set-block")];` +
  `const s=b.find(x=>(x.innerText||"").includes("节假日与调休"));if(!s)return JSON.stringify({on:false});` +
  `return JSON.stringify({on:true,title:s.querySelector(".section-title")?.innerText||"",` +
  `chips:[...s.querySelectorAll(".env-chips i")].map(e=>e.innerText.trim()),` +
  `dir:(s.querySelector(".env-val.is-mono")||{}).innerText||"",note:(s.querySelector("p")||{}).innerText||""})})()`));
check("设置页有「节假日与调休」小节", cal.on === true, JSON.stringify(cal).slice(0, 120));
check("生效年份至少覆盖今年与明年", cal.chips.length >= 2 && cal.chips.some((c) => c.startsWith(String(new Date().getFullYear()))), JSON.stringify(cal.chips));
check("每个年份 chip 给出休/班条数", cal.chips.every((c) => /休\d+·班\d+/.test(c)), JSON.stringify(cal.chips));
check("数据目录指向 vdata/calendars", /calendars/.test(cal.dir) && /vdata/.test(cal.dir), cal.dir);
check("说明写清「表没覆盖的年份会退化」", /退化/.test(cal.note) && /猜/.test(cal.note), cal.note.slice(0, 80));

console.log("\n=== 设置页：系统原生通知 ===");
// 这一段验的是「界面 → 绑定 → 内核 → 系统通知」这条链能不能走通；
// 横幅画不画得出来是 Windows 那侧的事（见 docs/architecture.md 第 11 节第 3 条）。
const nrow = JSON.parse(await evalJs(`(()=>{const s=[...document.querySelectorAll(".set-block")].find(x=>(x.innerText||"").includes("偏好设置"));` +
  `if(!s)return JSON.stringify({on:false});const lab=[...s.querySelectorAll(".nav-item")].find(e=>e.innerText.includes("系统原生通知"));` +
  `const btn=[...s.querySelectorAll(".btn")].find(e=>e.textContent.includes("测试通知"));` +
  `const cb=lab?lab.querySelector("input[type=checkbox]"):null;` +
  `return JSON.stringify({on:!!lab,checked:cb?cb.checked:null,disabled:cb?cb.disabled:null,` +
  `btn:!!btn,btnOff:btn?btn.disabled:null,note:(s.querySelector(".set-note:last-of-type")||{}).innerText||""})})()`));
check("偏好设置里有「系统原生通知」开关", nrow.on === true, JSON.stringify(nrow));
check("开关默认是开的（零值即默认）", nrow.checked === true, String(nrow.checked));
check("测试按钮总在", nrow.btn === true, JSON.stringify(nrow));
// 原生通知的可用性取决于跑在哪台机器上：CI 的 windows runner 不一定有通知平台。
// 所以这里按开关状态分两条断言，一条都不含糊（不能用「要么成功要么失败」糊过去）。
if (nrow.disabled === false) {
  check("通知可用时开关与测试按钮都可点", nrow.btnOff === false, JSON.stringify(nrow));
  await clickAt(".set-block .btn", "测试通知", 1200);
  const tn = await toastText();
  // runner 有没有真的通知平台不在我们控制内，但「点了必须有明确反馈」是界面契约：
  // 成功说已送出，失败说原因，不能一声不吭。
  check("点「测试通知」有明确反馈（成功/失败都说一声）", tn.length > 0 && (/已送出/.test(tn) || /通知|失败/.test(tn)), tn);
} else {
  check("通知不可用时开关禁用、不假装能开", nrow.checked === null || nrow.disabled === true, JSON.stringify(nrow));
  const note = await evalJs(`(()=>{const s=[...document.querySelectorAll(".set-block")].find(x=>(x.innerText||"").includes("偏好设置"));return s?s.innerText:""})()`);
  check("并说明「这台设备的系统通知不可用」", /不可用/.test(String(note)), String(note).slice(0, 80));
}
await clickAt(".rail-item", "设置", 700);

console.log("\n=== 设置页：备份与恢复 ===");
// 文件对话框是操作系统画的，CDP 点不到；这一段只验界面入口与口径文案，
// 导出/恢复本身由 Go 单测 + CLI 端到端覆盖（plando export/import）。
const bk = JSON.parse(await evalJs(`(()=>{const s=[...document.querySelectorAll(".set-block")].find(x=>(x.innerText||"").includes("备份与恢复"));` +
  `if(!s)return JSON.stringify({on:false});const btns=[...s.querySelectorAll(".btn")].map(e=>e.textContent.trim());` +
  `return JSON.stringify({on:true,btns,text:s.innerText})})()`));
check("设置页有「备份与恢复」小节", bk.on === true, JSON.stringify(bk).slice(0, 120));
check("两个入口：导出备份 / 恢复备份", bk.btns.join(",") === "导出备份,恢复备份", JSON.stringify(bk.btns));
check("文案说明「口令加密、恢复是合并不清库、口令丢了打不开」",
  /口令加密/.test(bk.text) && /按最后修改时间合并/.test(bk.text) && /不会清掉/.test(bk.text) && /没有后门/.test(bk.text),
  String(bk.text).slice(0, 100));

console.log("\n=== 预留动作不动数据 ===");
const before = await evalJs(`document.body.innerText.length`);
const STUB = /没有账号体系/;
await clickAt(".rail-item", "清单", 700);
await clickAt(".rail-avatar", null, 400);
await clickAt(".avatar-menu [role=menuitem]", "退出登录", 500);
const t1 = await toastText();
check("退出登录只给说明，不跳页不删数据", STUB.test(t1) && (await page()).account === false, t1);
await clickAt(".rail-avatar", null, 400);
await clickAt(".avatar-menu [role=menuitem]", "个人中心", 500);
await clickAt(".ac-act", "登录（暂未开放）", 500);
const t2 = await toastText();
check("「登录（暂未开放）」回同一句说明", STUB.test(t2) && t2.includes("登录与退出先留位"), t2);
await clickAt(".ac-act", "去设置", 700);
const onSettings = await evalJs(`!!document.querySelector(".set-block")`);
check("「去设置」跳到设置页（通道在那里配）", onSettings === true);
const after = await evalJs(`document.body.innerText.length`);
check("全程没有改动数据（页面文本规模稳定）", Math.abs(after - before) < 400, `${before} → ${after}`);

console.log("\n结果：通过 " + pass + "，失败 " + fail);
ws.close();
process.exit(fail ? 1 : 0);

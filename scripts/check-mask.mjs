// 弹窗「点灰底不该关窗」自检：新建/编辑/心得三类表单弹窗，点遮罩必须还在，Esc 与 × 才关。
// 用法：node scripts/check-mask.mjs [端口]     （先跑 scripts/verify-restart.sh 9255 list）
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
  let out;
  try {
    out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  } catch (e) {
    console.log("  ! CDP 失败:", e.message, "\n    表达式:", expression.slice(0, 160));
    throw e;
  }
  if (out.exceptionDetails) {
    // exceptionDetails 里有循环引用，不能直接 stringify，只取人话部分
    const d = out.exceptionDetails.exception?.description || out.exceptionDetails.text || "页面异常";
    throw new Error(String(d).split("\n")[0]);
  }
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
  // 设置页越来越长，目标可能已经滚出可视区；先滚进来再量坐标。
  // （量一个视口外的矩形会点空，表现成「弹窗没打开」这种假失败。）
  await evalJs(`(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})];` +
    `const e=${text ? `L.find(x=>(x.innerText||"").includes(${JSON.stringify(text)}))` : "L[0]"};` +
    `if(e)e.scrollIntoView({block:"center"});return 1})()`);
  await sleep(250);
  const pt = JSON.parse(await evalJs(`(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})];` +
    `const e=${text ? `L.find(x=>(x.innerText||"").includes(${JSON.stringify(text)}))` : "L[0]"};if(!e)return JSON.stringify(null);` +
    `const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`));
  if (!pt) throw new Error("找不到 " + sel);
  await clickXY(pt.x, pt.y, wait);
}
async function key(k) {
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: k === "Escape" ? 27 : 0, text: "" });
  }
  await sleep(320);
}
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? "  → " + d : ""))); };

/** 遮罩上离弹窗最远的一个点：内容区左上角，肯定不是弹窗自己。 */
const MASK = { x: 120, y: 420 };
const openModal = async () => JSON.parse(await evalJs(`(()=>{const m=document.querySelector(".item-modal,.habit-modal");if(!m)return JSON.stringify(null);
const r=m.getBoundingClientRect();return JSON.stringify({cls:m.className,w:Math.round(r.width)})})()`));

console.log("\n=== 点灰底不关窗 ===");
// 1) 事项新建
await clickAt(".add-card", null, 500);
check("新建事项弹窗已打开", (await openModal())?.cls.includes("is-create"));
await clickXY(MASK.x, MASK.y, 450);
check("点灰底后新建事项还在", (await openModal())?.cls.includes("is-create") === true, JSON.stringify(await openModal()));
// 敲一半的字不能因为误点丢
await clickAt(".cc-title", null, 250);
await send("Input.insertText", { text: "半截标题" });
await sleep(200);
await clickXY(MASK.x, MASK.y, 450);
const half = await evalJs(`document.querySelector(".cc-title")?.value||""`);
check("误点灰底不丢已输入的标题", half === "半截标题", half);
await key("Escape");
check("Esc 关掉新建事项", (await openModal()) === null);

// 2) 事项详情（编辑）
await clickAt(".add-card", null, 400);
await clickAt(".cc-title", null, 200);
await send("Input.insertText", { text: "遮罩自检项" });
await clickAt(".item-modal .cc-btn", "保存", 700);
await sleep(400);
await clickAt(".board-card, .matter-card, [class*=card]", "遮罩自检项", 700);
check("详情弹窗已打开", !!(await openModal()) && !(await openModal()).cls.includes("is-create"), JSON.stringify(await openModal()));
await clickXY(MASK.x, MASK.y, 450);
check("点灰底后详情还在", !!(await openModal()));
await key("Escape");
check("Esc 关掉详情", (await openModal()) === null);

// 3) 面板还开着时，Esc 先关面板不关窗
await clickAt(".add-card", null, 500);
await clickAt(".cc-chip", "设置重复", 450);
check("重复面板打开", !!(await evalJs(`!!document.querySelector(".pop-panel")`)));
await key("Escape");
check("Esc 先收面板", !(await evalJs(`!!document.querySelector(".pop-panel")`)) && !!(await openModal()));
await clickAt(".item-modal .cc-btn", "取消", 400);

// 4) 习惯新建
await clickAt(".rail-item", "习惯", 700);
await clickAt(".btn.small.primary", "新建习惯", 600);
check("新建习惯弹窗已打开", (await openModal())?.cls.includes("habit-modal"));
check("默认是引导模式", await evalJs(`!!document.querySelector(".hg")`) === true);
await clickAt(".hg-name", null, 250);
await send("Input.insertText", { text: "半截引导" });
await sleep(200);
await clickXY(MASK.x, MASK.y, 450);
check("引导模式点灰底也不关窗、不丢已填", (await evalJs(`document.querySelector(".hg-name")?.value||""`)) === "半截引导");
await key("Escape");
check("Esc 关掉引导模式弹窗", (await openModal()) === null);
await clickAt(".btn.small.primary", "新建习惯", 600);
// 现在新建习惯默认开引导模式，这段测的是传统表单的遮罩行为，先切过去
await clickAt(".hm-mode", "传统", 400);
check("切到传统模式才出现整卡表单", await evalJs(`!!document.querySelector(".hm-name")`) === true);
await clickAt(".hm-name", null, 250);
await send("Input.insertText", { text: "半截习惯" });
await sleep(200);
await clickXY(MASK.x, MASK.y, 450);
const habitHalf = await evalJs(`document.querySelector(".hm-name")?.value||""`);
check("点灰底不丢习惯名", habitHalf === "半截习惯" && !!(await openModal()), habitHalf);
await clickAt(".hm-icon", null, 450);
check("图标页打开", !!(await evalJs(`!!document.querySelector(".hm-icon-page")`)));
await key("Escape");
check("Esc 先退图标页", !(await evalJs(`!!document.querySelector(".hm-icon-page")`)) && !!(await openModal()));
await key("Escape");
check("再按 Esc 关习惯弹窗", (await openModal()) === null);

// 5) 通道配置表单（凭据敲一半最怕误点）
await clickAt(".rail-item", "设置", 700);
await clickAt(".btn", "新增通道", 600);
const chan = await evalJs(`(()=>{const m=document.querySelector(".modal-mask");return m?m.querySelector("h3").innerText:"没开"})()`);
check("通道配置弹窗已打开", chan.includes("新增同步通道") || chan.includes("编辑通道"), chan);
await clickXY(40, 300, 450);
check("点灰底后通道表单还在", !!(await evalJs(`!!document.querySelector(".modal-mask")`)));
await key("Escape");
check("Esc 关通道表单", !(await evalJs(`!!document.querySelector(".modal-mask")`)));

// 6) 纯确认框保持「点灰底可关」
await clickAt(".rail-item", "清单", 700);
await clickAt(".board-card, .matter-card, [class*=card]", "遮罩自检项", 700);
await clickAt(".im-more", null, 400);
await clickAt(".pop-panel .pick-item", "删除清单", 600);
const confirm = await evalJs(`(()=>{const m=document.querySelector(".modal-mask");return m?m.querySelector("h3").innerText:"没开"})()`);
check("删除确认框弹出", confirm.includes("删除"), confirm);
await clickXY(40, 300, 450);
check("确认框点灰底仍可关", !(await evalJs(`!!document.querySelector(".modal-mask")`)));

console.log("\n结果：通过 " + pass + "，失败 " + fail);
ws.close();
process.exit(fail ? 1 : 0);

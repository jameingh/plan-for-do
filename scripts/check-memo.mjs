// 备忘录模块自检：真实鼠标/键盘事件把参考站那套「左列表 + 右富文本编辑器」点一遍，
// 断言界面与内核状态（末尾用 node:sqlite 只读核对记录）。
// 用法：node scripts/check-memo.mjs [端口]     （先跑 scripts/verify-restart.sh 9256 memos）
// 只动隔离数据目录。
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeExpr, judgePopup } from "./lib/geom.mjs";

// 仓库根：CI runner 的路径与本机不同，所有 tmp/ 位置都从这里推，不写死绝对路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const port = process.argv[2] || "9256";
const DATA = process.env.PLANDO_VDATA || path.join(ROOT, "tmp", "vdata");
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
const json = async (e) => JSON.parse(await evalJs(e));
async function point(sel, text, nth = 0) {
  const pt = await json(`(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})];` +
    `const e=${text ? `L.filter(x=>(x.innerText||"").includes(${JSON.stringify(text)}))` : "L"}[${nth}];if(!e)return JSON.stringify(null);` +
    `e.scrollIntoView({block:"center",inline:"center"});` +          // CI 的显示比本机小，先滚进视口再量
    `const r=e.getBoundingClientRect();return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)})})()`);
  if (!pt) throw new Error("找不到 " + sel + (text ? ` （含「${text}」）` : ""));
  return pt;
}
async function click(sel, text, nth = 0, wait = 320) {
  const pt = await point(sel, text, nth);
  for (const t of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type: t, x: pt.x, y: pt.y, button: "left", clickCount: 1, buttons: t === "mousePressed" ? 1 : 0 });
  }
  await sleep(wait);
}
async function rightClick(sel, nth = 0, wait = 320) {
  const pt = await point(sel, "", nth);
  for (const t of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type: t, x: pt.x, y: pt.y, button: "right", clickCount: 1, buttons: t === "mousePressed" ? 2 : 0 });
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
async function key(k) {
  const code = { Enter: 13, Escape: 27, Tab: 9 }[k] || 0;
  for (const t of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type: t, key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: k === "Enter" ? "\r" : "" });
  }
  await sleep(300);
}
/** 正文在 iframe 里：CDP 的 insertText 会打给聚焦帧，读内容要跨帧取。 */
const edHtml = () => evalJs(`(()=>{const f=document.querySelector("iframe.edit-iframe");return f&&f.contentDocument?f.contentDocument.getElementById("editor").innerHTML:""})()`);
const setEd = (html) => evalJs(`(()=>{const f=document.querySelector("iframe.edit-iframe");const e=f.contentDocument.getElementById("editor");` +
  `e.innerHTML=${JSON.stringify(html)};e.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
const selectInFrame = () => evalJs(`(()=>{const f=document.querySelector("iframe.edit-iframe");const d=f.contentDocument;` +
  `const e=d.getElementById("editor");e.focus();const r=d.createRange();r.selectNodeContents(e);` +
  `const sel=d.getSelection();sel.removeAllRanges();sel.addRange(r);return 1})()`);
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (d ? "  → " + d : ""))); };
const txt = async (sel) => (await evalJs(`document.querySelector(${JSON.stringify(sel)})?.innerText||""`)).replace(/\s+/g, " ").trim();
const num = async (sel) => await evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const dbRows = () => {
  const db = new DatabaseSync(`${DATA}/planfordo.db`, { readOnly: true });
  // 墓碑在 entity.deleted_at 这一列上（data JSON 里保留原内容），断言要看列
  const rows = db.prepare("select deleted_at as colDeleted, data from entity where kind='memo'").all()
    .map((r) => ({ ...JSON.parse(r.data), colDeleted: r.colDeleted }));
  const meta = db.prepare("select value from meta where key='ui.settings'").all();
  const memos = db.prepare("select count(*) n from entity where kind='memo'").get().n;
  const folders = db.prepare("select count(*) n from entity where kind='memoFolder'").all();
  db.close();
  return { rows, settings: meta.length ? JSON.parse(meta[0].value) : null, memos, folderRows: folders };
};

console.log("\n=== 备忘录：骨架与空态 ===");
check("模块栏六项、备忘录在习惯与专注之后", (await evalJs(`[...document.querySelectorAll(".rail-item")].map(e=>e.innerText.trim()).join(",")`)) === "清单,视图,习惯,专注,备忘录,设置");
check("落在备忘录页", (await num(".memos-page")) === 1);
// 参考站整个模块按 rem（= 视口/19.2）缩放。我方给 --m-rem 加了 66px 下限保可读，
// 所以这里断言的是「模块内尺寸同出一个基准」：列宽/3.58 与 字号/0.15 应当一致。
const geom = await json(`(()=>{const L=document.querySelector(".memo-list").getBoundingClientRect();` +
  `const fs=parseFloat(getComputedStyle(document.querySelector(".text-folder-name")).fontSize);` +
  `const sh=parseFloat(getComputedStyle(document.querySelector(".memo-search")).height);` +
  `return JSON.stringify({list:Math.round(L.width),rem:+(L.width/3.58).toFixed(1),` +
  `fromFont:+(fs/0.22).toFixed(1),fromSearch:+(sh/0.42).toFixed(1)})})()`);
check("列宽 / 字号 / 搜索框高同出一个 rem 基准",
  Math.abs(geom.rem - geom.fromFont) < 2 && Math.abs(geom.rem - geom.fromSearch) < 2, JSON.stringify(geom));
check("搜索框 placeholder 原文", (await evalJs(`document.querySelector(".memo-search")?.placeholder`)) === "查找备忘录，按回车键搜索");
check("底栏两项：新建备忘录 / 回收站", (await txt(".foot-block")).replace(/\s/g, "") === "新建备忘录回收站", await txt(".foot-block"));
check("列表空态「暂无内容」", (await txt(".memo-list .memo-none")) === "暂无内容");
check("右侧空态「暂无内容」", (await txt(".memo-main .memo-none")) === "暂无内容");
check("还没打开时没有编辑器", (await num(".body-memo-editor")) === 0);

console.log("\n=== 备忘录：新建与保存 ===");
await click(".create-note");
check("点新建出编辑器", (await num(".body-memo-editor")) === 1 && (await num(".note-title")) === 1);
check("新建立刻落库（列表已有 1 条「无标题」）", (await num(".body-memo-item")) === 1 && (await txt(".item-title-none")) === "无标题");
await typeInto(".note-title", "项目周会纪要");
check("标题输入即写进输入框", (await evalJs(`document.querySelector(".note-title").value`)) === "项目周会纪要");
check("未保存时保存按钮带脏标记", (await num(".note-submit.is-dirty")) === 1);
await setEd("<p>讨论了排期与风险</p><p>结论是下周联调</p>");
await sleep(250);
await click(".note-submit");
check("保存后脏标记消失", (await num(".note-submit.is-dirty")) === 0);
check("列表标题更新", (await txt(".item-title")) === "项目周会纪要", await txt(".item-title"));
check("摘要是正文纯文本（段落合成一行）", (await txt(".item-content")) === "讨论了排期与风险 结论是下周联调", await txt(".item-content"));
check("列表时间当天只显示时分", /^\d{2}:\d{2}$/.test(await txt(".item-date")), await txt(".item-date"));
let snap = dbRows();
check("内核存了 HTML 原文", snap.rows.length === 1 && snap.rows[0].html.includes("<p>讨论了排期与风险</p>"), JSON.stringify(snap.rows[0]?.html));
check("内核存了标题", snap.rows[0]?.title === "项目周会纪要");
check("新建记录 fileType=-1（无附件）", snap.rows[0]?.fileType === -1, String(snap.rows[0]?.fileType));

console.log("\n=== 备忘录：工具条 ===");
const tools = await json(`JSON.stringify([...document.querySelectorAll(".body-note-utils > *")].map(e=>(e.className||e.tagName).split(" ")[0]+(e.className.includes("pick")?":"+e.innerText.trim():"")))`);
check("撤销/重做在最左", tools[0] === "icon-item" && tools[1] === "icon-item", JSON.stringify(tools.slice(0, 3)));
check("字体入口显示「默认字体」", tools.some((t) => t.includes("默认字体")), JSON.stringify(tools));
check("字号入口显示 16", tools.some((t) => t.includes(":16")), JSON.stringify(tools));
check("四个上传入口 + 隐藏 input", (await num(".icon-item")) === 19 && (await num('.body-note-utils input[type=file]')) === 4,
  String(await num(".icon-item")) + "/" + String(await num('.body-note-utils input[type=file]')));
check("文件入口 accept 与参考站一致（图片/视频/音频限定）",
  (await evalJs(`[...document.querySelectorAll(".body-note-utils input[type=file]")].map(e=>e.accept).join(",")`)) === "image/*,video/*,,audio/*");
// execCommand 要作用在选区上：先把正文整段选中（参考站也是「选中后点加粗」）
await selectInFrame();
await click('[aria-label="加粗"]');
await sleep(300);
const afterBold = await edHtml();
check("加粗写进正文 HTML", /<b>|<strong>|font-weight/i.test(afterBold), afterBold.slice(0, 120));
await selectInFrame();
await click('.tool-pick', "默认字体");
await sleep(300);
check("字体下拉六项、顺序与参考站一致",
  (await evalJs(`[...document.querySelectorAll(".menu-box .item")].map(e=>e.innerText.trim()).join("/")`)) === "默认字体/仿宋字体/楷体/手札体/娃娃体/雅痞");
await click(".menu-box .item", "楷体");
await sleep(250);
check("选楷体后入口文案跟着变", (await txt(".tool-pick")) === "楷体", await txt(".tool-pick"));
check("正文 font-family 落到楷体栈", /KaiTi|楷体/i.test(await edHtml()), (await edHtml()).slice(0, 140));
await selectInFrame();
await click('.tool-pick', "16");
await sleep(300);
check("字号七档", (await evalJs(`[...document.querySelectorAll(".menu-box .item")].map(e=>e.innerText.trim()).join(",")`)) === "10,13,16,18,24,32,48");
await click(".menu-box .item", "24");
await sleep(250);
check("选 24 后字号回显", (await txt(".tool-pick.is-size")) === "24", await txt(".tool-pick.is-size"));
await selectInFrame();
await click(".color-item");
await sleep(300);
check("取色板 10 格", (await num(".color-box button")) === 10, String(await num(".color-box button")));
await click(".color-box button", "", 3);
await sleep(250);
check("文字颜色写进正文", /#e13e39|rgb\(225, 62, 57\)|color:/i.test(await edHtml()), (await edHtml()).slice(0, 160));
await selectInFrame();
await click('[aria-label="任务列表"]');
await sleep(300);
check("复选框插入 input[type=checkbox]", /type="checkbox"/i.test(await edHtml()), (await edHtml()).slice(-160));
await click('[aria-label="选择背景"]');
await sleep(300);
check("背景面板标题「选择背景」", (await txt(".back-head")) === "选择背景", await txt(".back-head"));
check("背景一页 8 格 + 翻页 1/2", (await num(".back-cell")) === 8 && (await txt(".back-foot")).includes("1 / 2"), String(await num(".back-cell")));
await click(".back-cell", "", 2);
await sleep(200);
check("选中态落在被点的格子", (await evalJs(`document.querySelectorAll(".back-cell")[2].className.includes("is-sel")`)) === true);
await click(".back-cell", "", 2);
await sleep(200);
check("再点同一格＝清除（参考站行为）", (await num(".back-cell.is-sel")) === 0);
await click(".back-cell", "", 1);
await sleep(200);
await key("Escape");            // 背景面板的遮罩会盖住「保存」，先收面板
await sleep(200);
await click(".note-submit");
await sleep(600);
snap = dbRows();
check("背景图随保存落库", !!snap.rows[0]?.backImage, JSON.stringify(snap.rows[0]?.backImage));

console.log("\n=== 备忘录：第二条与切换自动保存 ===");
await click(".create-note");
await typeInto(".note-title", "买菜清单");
await setEd("<p>牛奶、鸡蛋</p>");
await sleep(200);
await click(".create-note");                 // 再新建一条：参考站切条时会自动保存上一条
await sleep(600);
await typeInto(".note-title", "临时记一笔");
await sleep(200);
// 不点保存，直接切回第一条 → 触发自动保存
await click(".body-memo-item", "买菜清单");
await sleep(700);
snap = dbRows();
const titles = snap.rows.map((r) => r.title);
check("切条时未保存的标题被自动落库", titles.includes("临时记一笔"), JSON.stringify(titles));
check("列表出现三条", (await num(".body-memo-item")) === 3, String(await num(".body-memo-item")));

console.log("\n=== 备忘录：右键菜单与置顶 ===");
await rightClick(".body-memo-item", 1);
check("右键出三项：置顶 / 移入文件夹 / 删除",
  (await evalJs(`[...document.querySelectorAll(".menu-box .item")].map(e=>e.innerText.trim()).join("/")`)) === "置顶/移入文件夹/删除",
  await txt(".menu-box"));
await click(".menu-box .item", "置顶");
await sleep(500);
check("置顶项排到最前", (await txt(".body-memo-item .item-title,.item-title-none")) !== "", await txt(".body-memo-item"));
check("置顶图标出现", (await num(".icon-top")) === 1);
await rightClick(".body-memo-item", 0);
await click(".menu-box .item", "取消置顶");
await sleep(500);
check("取消置顶后图标消失", (await num(".icon-top")) === 0);

console.log("\n=== 备忘录：搜索 ===");
await typeInto(".memo-search", "买菜");
check("输入未回车时不过滤", (await num(".body-memo-item")) === 3, String(await num(".body-memo-item")));
await key("Enter");
check("回车后只剩命中项", (await num(".body-memo-item")) === 1 && (await txt(".item-title")) === "买菜清单", await txt(".memo-items"));
check("命中词标红", (await num(".item-title .hl")) === 1 && (await evalJs(`getComputedStyle(document.querySelector(".item-title .hl")).color`)) === "rgb(225, 62, 57)");
await click(".icon-clear");
await sleep(400);
check("清空搜索恢复全量", (await num(".body-memo-item")) === 3 && (await evalJs(`document.querySelector(".memo-search").value`)) === "");

console.log("\n=== 备忘录：排序 ===");
await click(".icon-folder-more");
check("「…」菜单文案与参考站一致",
  (await evalJs(`[...document.querySelectorAll(".menu-box li")].map(e=>e.innerText.trim()).join("/")`)) === "排序方式/按创建时间排序/按修改时间排序/文件夹管理",
  await txt(".menu-box"));
await click(".menu-box .item", "按修改时间排序");
await sleep(500);
snap = dbRows();
check("排序方式写进内核设置（不是 localStorage）", snap.settings?.memoSortType === 1, JSON.stringify(snap.settings));
await click(".icon-folder-more");
await sleep(300);
check("重开菜单：选中的排序项带高亮",
  (await evalJs(`[...document.querySelectorAll(".menu-box .item")].filter(e=>e.className.includes("item-selected")).map(e=>e.innerText.trim()).join(",")`)) === "按修改时间排序",
  await txt(".menu-box"));
await key("Escape");

console.log("\n=== 备忘录：文件夹 ===");
await click(".icon-folder-more");
await click(".menu-box .item-title", "文件夹管理");
await sleep(400);
check("文件夹管理抽屉打开", (await num(".folder-manage")) === 1 && (await txt(".fm-head")) === "文件夹管理", await txt(".fm-head"));
check("副标题「（可拖动排序）」", (await txt(".fm-sub")) === "（可拖动排序）", await txt(".fm-sub"));
check("输入框 placeholder 与 6 字上限",
  (await evalJs(`document.querySelector(".fm-input").placeholder`)) === "请输入文件夹名称" && (await evalJs(`document.querySelector(".fm-input").maxLength`)) === 6);
await typeInto(".fm-input", "工作");
await key("Enter");
await sleep(500);
check("回车建好文件夹", (await num(".folder-item")) === 1 && (await txt(".folder-name")) === "工作", await txt(".folder-items"));
await typeInto(".fm-input", "一二三四五六七八");
await key("Enter");
await sleep(500);
check("超长名字按 6 字截断", (await evalJs(`[...document.querySelectorAll(".folder-name")].map(e=>e.innerText).join(",")`)).includes("一二三四五六"),
  await evalJs(`[...document.querySelectorAll(".folder-name")].map(e=>e.innerText).join(",")`));
await click(".fm-head .icon-close");
await sleep(400);
check("关掉抽屉后回到列表", (await num(".folder-manage")) === 0);
await click(".icon-folder-more");
await click(".menu-box .item", "按创建时间排序");
await sleep(400);
await rightClick(".body-memo-item", 0);
await click(".menu-box .item", "移入文件夹");
await sleep(300);
check("移入文件夹的选择器含「全部」与两个文件夹",
  (await evalJs(`[...document.querySelectorAll(".folder-box .item")].map(e=>e.innerText.trim()).join("/")`)) === "全部/工作/一二三四五六",
  await txt(".folder-box"));
await click(".folder-box .item", "工作");
await sleep(500);
snap = dbRows();
check("移入后内核记下 folderId", snap.rows.some((r) => r.folderId), JSON.stringify(snap.rows.map((r) => [r.title, r.folderId])));
await click(".icon-folder-select");
await sleep(300);
await click(".folder-box .item", "工作");
await sleep(500);
check("切到「工作」只剩移进去的那条", (await num(".body-memo-item")) === 1, String(await num(".body-memo-item")));
check("头部显示当前文件夹名", (await txt(".text-folder-name")) === "工作", await txt(".text-folder-name"));
await click(".icon-folder-more");
await click(".menu-box .item-title", "文件夹管理");
await sleep(400);
await click(".folder-ops button", "", 1);    // 第一个文件夹的删除
await sleep(400);
check("删除文件夹有确认与原文提示",
  (await txt(".confirm-head")) === "确定要删除该文件夹？" && (await txt(".confirm-intro")) === "删除后，该文件夹下的备忘录可在回收站查看",
  await txt(".confirm-box"));
await click(".confirm-foot .cc-btn", "确定");
await sleep(600);
snap = dbRows();
check("文件夹删了，里面的备忘录进回收站而不是消失",
  snap.rows.filter((r) => r.trashedAt).length === 1 && snap.rows.filter((r) => !r.trashedAt).length === 2,
  JSON.stringify(snap.rows.map((r) => [r.title, !!r.trashedAt])));
check("回到「全部」", (await txt(".text-folder-name")) === "全部", await txt(".text-folder-name"));
check("确认框点确定后自己收掉（不留遮罩）", (await num(".memo-mask")) === 0);
await click(".folder-manage .icon-close");
await sleep(400);
check("文件夹抽屉可关", (await num(".folder-manage")) === 0);

console.log("\n=== 备忘录：删除与回收站 ===");
// 前面删文件夹已经往回收站里放过一条了；先把回收站清空，后面的条数才算得准
await click(".delete-note");
await sleep(400);
if ((await num(".body-recycle-bin .memo-item")) > 0) {
  await click(".check-box-all");
  await click(".text-delete");
  await click(".confirm-foot .cc-btn", "确定");
  await sleep(700);
}
await click(".body-recycle-bin .icon-close");
await sleep(400);
const n0 = await num(".body-memo-item");
await rightClick(".body-memo-item", 0);
await click(".menu-box .item", "删除");
await sleep(300);
check("删除确认文案原文", (await txt(".confirm-head")) === "确定要删除该备忘录？" && (await txt(".confirm-intro")) === "删除后该备忘录可在回收站查看",
  await txt(".confirm-box"));
await click(".confirm-foot .cc-btn", "确定");
await sleep(700);
const n1 = await num(".body-memo-item");
check("删除只进回收站：列表少一条", n1 === n0 - 1, n0 + " → " + n1);
await click(".delete-note");
await sleep(500);
check("回收站抽屉打开、标题带条数", (await num(".body-recycle-bin")) === 1 && (await txt(".memo-recycle-bin")).includes("回收站 ("), await txt(".memo-recycle-bin"));
check("回收站时间只有年月日", /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(await txt(".text-memo-time")), await txt(".text-memo-time"));
check("底栏有全选/删除/恢复", (await txt(".memo-submit")).includes("全选") && (await txt(".memo-submit")).includes("恢复"), await txt(".memo-submit"));
await click(".check-box-all");
await sleep(300);
check("全选后按钮变「取消全选」", (await txt(".check-box-all")).includes("取消全选"), await txt(".check-box-all"));
await click(".text-restore");
await sleep(300);
check("恢复确认文案原文", (await txt(".confirm-head")) === "恢复备忘录" && (await txt(".confirm-intro")) === "确定要恢复备忘录至列表吗？", await txt(".confirm-box"));
await click(".confirm-foot .cc-btn", "确定");
await sleep(700);
check("恢复后回收站空了", (await num(".body-recycle-bin .memo-item")) === 0 && (await txt(".memo-recycle-bin")) === "回收站", await txt(".memo-recycle-bin"));
await click(".body-recycle-bin .icon-close");
await sleep(400);
check("恢复回到列表：条数复原", (await num(".body-recycle-bin")) === 0 && (await num(".body-memo-item")) === n0, String(await num(".body-memo-item")));
await rightClick(".body-memo-item", 0);
await click(".menu-box .item", "删除");
await click(".confirm-foot .cc-btn", "确定");
await sleep(700);
const n2 = await num(".body-memo-item");
check("再删一条：列表又少一条", n2 === n0 - 1, n0 + " → " + n2);
await click(".delete-note");
await sleep(400);
await click(".rb-item-select");
await click(".text-delete");
await sleep(300);
check("彻底删除确认文案原文", (await txt(".confirm-head")) === "删除备忘录" && (await txt(".confirm-intro")) === "确定要永久删除备忘录，删除后不可找回",
  await txt(".confirm-box"));
await click(".confirm-foot .cc-btn", "确定");
await sleep(700);
snap = dbRows();
check("彻底删除走同步墓碑（entity.deleted_at 列被写上）", snap.rows.some((r) => r.colDeleted),
  JSON.stringify(snap.rows.map((r) => [r.title, r.colDeleted || "-"])));
check("彻底删除不会把别的条目带走", (await num(".body-memo-item")) === n2, n2 + " vs " + String(await num(".body-memo-item")));
await click(".body-recycle-bin .icon-close");
await sleep(300);

console.log("\n=== 备忘录：内核状态核对 ===");
snap = dbRows();
check("memo 与 memoFolder 两类记录都在库里", snap.memos >= 3 && snap.folderRows.length >= 1, JSON.stringify({ memos: snap.memos, folders: snap.folderRows }));
check("正文里保留了富文本标签", snap.rows.some((r) => /<(p|b|ul|font|input)/.test(r.html || "")), JSON.stringify(snap.rows.map((r) => (r.html || "").slice(0, 40))));

console.log("\n=== 备忘录：弹层几何（定位 / 不溢出）===");
// 2026-11-09 用户定的必测两项。这两条当天就抓到三个真问题：排序菜单飘到编辑区、
// 背景图弹层有一半在视口外、回收站复选框的全局 margin 漏进菜单选中行把行顶出菜单框。
// 判据见 scripts/lib/geom.mjs；全应用范围的同一套检查在 scripts/check-popup.mjs。
const GEO = [
  { label: "排序方式菜单", open: async () => click(".icon-folder-more"), popup: ".menu-box", anchor: ".icon-folder-more" },
  { label: "文件夹下拉", open: async () => click(".icon-folder-select"), popup: ".folder-box", anchor: ".icon-folder-select" },
  { label: "文字颜色", open: async () => click(".color-item"), popup: ".color-box", anchor: ".color-item" },
  { label: "背景颜色", open: async () => click(".bg-item"), popup: ".color-box", anchor: ".bg-item" },
  { label: "背景图选择", open: async () => click(".icon-item[aria-label='选择背景']"), popup: ".back-box", anchor: ".icon-item[aria-label='选择背景']" },
  { label: "标题栏移入文件夹", open: async () => click(".note-folder"), popup: ".folder-box.is-setfolder", anchor: ".note-folder" },
];
// 工具条那几项要有一条**打开着**的备忘录才在（编辑器没开就没有工具条）。
if (!(await num(".body-memo-item"))) { await click(".create-note"); await sleep(800); }
await click(".body-memo-item");
await sleep(600);
for (const g of GEO) {
  try {
    await g.open();
    await sleep(360);
    const probe = await evalJs(probeExpr(g.popup, g.anchor));
    const judged = judgePopup(probe ? JSON.parse(probe) : null, { anchorMode: "element" });
    check(g.label + "：定位正确且内容不溢出", judged.ok, judged.problems.join("；"));
  } catch (e) {
    check(g.label + "：定位正确且内容不溢出", false, String(e.message).slice(0, 90));
  }
  await key("Escape");
  await sleep(220);
}

console.log("\n结果：通过 " + pass + "，失败 " + fail);
fs.mkdirSync("tmp/memo", { recursive: true });   // tmp/ 不在版本库里，干净 runner 上目录不存在
fs.writeFileSync("tmp/memo/last-run.json", JSON.stringify({ at: new Date().toISOString(), pass, fail }, null, 1));
ws.close();
process.exit(fail ? 1 : 0);

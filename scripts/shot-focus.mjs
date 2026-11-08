// 专注模块截图：外壳三页签 + 关联任务弹窗 + 沉浸页 + 数据页两页签 + 详情页。
// 用法：node scripts/shot-focus.mjs [端口] [输出目录]
//   先跑 bash scripts/verify-restart.sh 9256 focus && bash scripts/seed-focus.sh
// 沉浸页那段会真开一次专注，拍完按「放弃（不保存）」收掉，不留记录。
import { spawnSync } from "node:child_process";

const PORT = process.argv[2] || "9256";
const OUT = process.argv[3] || "tmp/focus";
const at = (sel, text) => `(()=>{const L=[...document.querySelectorAll(${JSON.stringify(sel)})];` +
  `const e=${text ? `L.filter(x=>(x.innerText||"").includes(${JSON.stringify(text)}))` : "L"}[0];` +
  `if(!e)return {x:0,y:0};const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`;
const run = (...a) => spawnSync("node", ["scripts/cdp.mjs", PORT, ...a], { stdio: "inherit" });
const wait = (ms) => spawnSync("node", ["-e", `setTimeout(()=>{},${ms})`]);
// 弹窗有入场动画（200~300ms），点完立刻截图会拍到半透明的中间帧——先等一下再拍。
const shot = (file) => { wait(450); run("eval", '"ok"', "--shot", `${OUT}/${file}.png`); };

for (const [tab, file] of [["正计时", "01-up"], ["番茄钟", "02-pomo"], ["倒计时", "03-down"]]) {
  run("click", at(".gtab", tab)); shot(file);
}
// 关联任务弹窗（默认全部待办 + 日历展开）。
// 注意：每个动作只点一次并顺手截图——开弹窗的按钮再点第二下会打到遮罩把弹窗关掉。
run("click", at(".fc-task-off", "关联任务")); shot("04-picker");
run("click", at(".fc-pick-date", "全部待办")); shot("05-picker-date");
run("click", at(".fc-pick-cal .pop-btn", "取消"));
run("click", at(".fc-pick-tab", "习惯打卡")); shot("05b-picker-habit");
run("click", at(".fc-pick-row"));                       // 选一条，弹窗关，任务落到标题位
// 真开一次正计时，拍沉浸页，然后放弃不保存
run("click", at(".fc-start", "开始专注"));
wait(2500); shot("06-immersive");
run("click", at(".fc-big-btn", "暂停"));
run("click", at(".fc-big-btn", "结束")); shot("07-end-box");
run("click", at(".fc-end-btn", "放弃"));
// 数据页
run("click", at(".gtab", "数据")); shot("08-data-analysis");
// 历史与详情都从「统计分析」那一屏进，先切回去再点右箭头
run("click", at(".fc-tab", "统计分析"));
run("click", at(".fc-ov .fc-ov-go")); shot("10-history");
run("click", at(".fc-hist-row")); shot("11-detail");
run("click", at(".fc-back"));
run("click", at(".fc-back"));
run("click", at(".fc-tab", "数据分布")); shot("09-data-dist");

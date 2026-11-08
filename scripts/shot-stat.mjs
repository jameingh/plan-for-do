// 习惯统计四页签截图：真实鼠标点过去，每个页签存一张 PNG（配合 check-stat 用肉眼看版式）。
// 用法：node scripts/shot-stat.mjs [端口] [输出目录]   （先跑 verify-restart.sh <端口> habits && seed-stat.sh）
import { spawnSync } from "node:child_process";
const PORT = process.argv[2] || "9256";
const OUT = process.argv[3] || "tmp/stat";
import fs from "node:fs";
fs.mkdirSync(OUT, { recursive: true });
const at = (sel, text) => `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>(x.innerText||"").includes(${JSON.stringify(text)}));const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`;
const run = (...a) => spawnSync("node", ["scripts/cdp.mjs", PORT, ...a], { stdio: "inherit", shell: false });
run("click", at(".gtab", "习惯统计"));
for (const [tab, file] of [["日统计", "11-day.png"], ["周统计", "12-week.png"], ["月统计", "13-month.png"], ["年统计", "14-year.png"]]) {
  run("click", at(".hs-tab", tab), "--shot", `${OUT}/${file}`);
}
run("click", at(".hs-arrow", ""), "--shot", `${OUT}/15-year-prev.png`);

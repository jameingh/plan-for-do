// 把用户真实库做成一份**只读快照**（VACUUM INTO），给界面自检当「真数据」用。
// 只读源库，不写用户数据目录；快照落在 tmp/rdata。
// 用法：node scripts/snapshot-real.mjs [目标目录]
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const src = path.join(process.env.APPDATA || "", "planfordo", "planfordo.db");
const dir = process.argv[2] || "C:/Users/Public/project/plan-for-do/tmp/rdata";
if (!fs.existsSync(src)) { console.error("找不到真实库：" + src); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, "planfordo.db").replace(/\\/g, "/");
fs.rmSync(out, { force: true });
const db = new DatabaseSync(src, { readOnly: true });
db.exec("vacuum into '" + out + "'");
db.close();
const rows = new DatabaseSync(out, { readOnly: true }).prepare("select kind, count(*) n from entity group by kind").all();
console.log("快照：" + out);
console.log("内容：" + rows.map((r) => r.kind + "=" + r.n).join(", "));

// 直接读隔离库，核对界面点完之后的内核状态（只读）。
// 用法：node scripts/peek-db.mjs [数据目录] [kind 关键字]
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 仓库根：CI runner 的路径与本机不同，所有 tmp/ 位置都从这里推，不写死绝对路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const dir = process.argv[2] || process.env.PLANDO_VDATA || path.join(ROOT, "tmp", "vdata");
const like = process.argv[3] || "habit";
const db = new DatabaseSync(`${dir}/planfordo.db`, { readOnly: true });
const tables = db.prepare("select name from sqlite_master where type = 'table'").all().map((r) => r.name);
console.log("表：", tables.join(", "));
const t = tables.find((n) => /entity|entities|row/i.test(n)) || tables[0];
const rows = db.prepare(`select * from ${t} where kind like ? limit 40`).all(`%${like}%`);
for (const r of rows) {
  const data = r.data ?? r.value ?? "";
  console.log("-", r.kind, r.id, String(data).slice(0, 300).replace(/\s+/g, " "));
}
db.close();
fs.closeSync;

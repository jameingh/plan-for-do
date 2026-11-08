// 自检脚本共用的日期算式。
//
// 为什么要有这个文件：种子脚本以前把日期写死成 2026-11-xx，断言里也写死了「11月9日 周一」这种文案，
// 于是整套脚本只在那几天有效——隔一天就满屏红，而红的是脚本而不是应用。
// 现在种子与断言都用同一套「相对今天 / 相对本周一」的口径，跑在哪一天都一样。
// 文案格式与 frontend/src/lib/day.ts 对齐（日不补零；只有习惯的开始日期补零）。

const pad = (n) => String(n).padStart(2, "0");
const at = (day) => new Date(`${day}T12:00:00`);
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => iso(new Date());
export const addDays = (day, n) => { const d = at(day); d.setDate(d.getDate() + n); return iso(d); };
export const addMonths = (day, n) => {
  const d = at(day); d.setMonth(d.getMonth() + n, 1); return iso(d);
};
/** 1=周一 .. 7=周日 */
export const weekdayMon = (day) => ((at(day).getDay() + 6) % 7) + 1;
export const mondayOf = (day) => addDays(day, 1 - weekdayMon(day));
export const diffDays = (a, b) => Math.round((at(b) - at(a)) / 86400000);
export const firstOfMonth = (day = today()) => `${day.slice(0, 7)}-01`;
export const lastOfMonth = (day = today()) => {
  const d = at(day); return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
};

// —— 界面文案 ——
export const mdCN = (day) => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;        // 11月7日
export const mdPadCN = (day) => `${Number(day.slice(5, 7))}月${day.slice(8, 10)}日`;              // 11月07日
export const habitDayCN = (day) => `${Number(day.slice(0, 4))}年${day.slice(5, 7)}月${day.slice(8, 10)}日`; // 2026年11月07日
export const monthCN = (day) => `${Number(day.slice(0, 4))}年${Number(day.slice(5, 7))}月`;       // 2026年11月
export const dotMD = (day) => `${Number(day.slice(5, 7))}.${Number(day.slice(8, 10))}`;           // 11.2
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export const dayTitleCN = (day) => `${mdCN(day)} ${WEEK[at(day).getDay()]}`;                      // 11月9日 周一
export const weekTitleCN = (day) => `${dotMD(mondayOf(day))} - ${dotMD(addDays(mondayOf(day), 6))}`; // 11.2 - 11.8

/** 某月的全部日历日。 */
export const monthDays = (month) => {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return Array.from({ length: last }, (_, i) => `${month}-${pad(i + 1)}`);
};

/** 月视图网格：整周补齐后的起止与行数（跨月那几周也会整周画出来）。 */
export const monthGrid = (day = today()) => {
  const start = mondayOf(firstOfMonth(day));
  const last = lastOfMonth(day);
  const end = addDays(last, 7 - weekdayMon(last));
  const rows = (diffDays(start, end) + 1) / 7;
  return { start, end, rows, cells: rows * 7, indexOf: (d) => diffDays(start, d) };
};

// lib/day.ts —— Day 工具集。
// 约定（docs/architecture.md 第 4 节）：
//   - Day 是本地日历日字符串 "YYYY-MM-DD"，只做字典序比较和 ±N 天计算，绝不 new Date() 之后加减天
//     （时区/夏令时会让「一天」变成 23/25 小时；Go 侧 repeat.AddDays 用 UTC 正午，这里同样用 UTC 锚点）。
//   - 绝对时刻（ClockTime）是 UTC 定宽串，一律 new Date(utcString) 后按本地时区展示。
// 农历/节气本次不做。

import type { ClockTime, Day } from "../api/types";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDay(d: string): d is Day {
  if (!DAY_RE.test(d)) return false;
  const [y, m, dd] = d.split("-").map(Number);
  if (m < 1 || m > 12 || dd < 1 || dd > 31) return false;
  const t = Date.UTC(y, m - 1, dd, 12);
  return new Date(t).getUTCDate() === dd && new Date(t).getUTCMonth() === m - 1;
}

/** 本地时区的「今天」。内核也用它兜底空 day 参数。 */
export function todayLocal(): Day {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayToUtc(d: Day): number {
  const [y, m, dd] = d.split("-").map(Number);
  // UTC 正午锚点，加减天数不会被夏令时截断
  return Date.UTC(y, m - 1, dd, 12);
}

function utcToDay(t: number): Day {
  const dt = new Date(t);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** ±N 天（与 Go repeat.AddDays 对齐：解析失败返回原值）。 */
export function addDays(d: Day, n: number): Day {
  if (!isValidDay(d)) return d;
  return utcToDay(dayToUtc(d) + n * 86_400_000);
}

/** b - a 的天数（与 Go repeat.DiffDays 对齐：DiffDays(day, today) > 0 即「逾期」）。 */
export function diffDays(a: Day, b: Day): number {
  if (!isValidDay(a) || !isValidDay(b)) return 0;
  return Math.round((dayToUtc(b) - dayToUtc(a)) / 86_400_000);
}

/** 1=周一 .. 7=周日，与 model.Weekdays 约定一致。 */
export function weekdayMon(d: Day): number {
  const w = new Date(dayToUtc(d)).getUTCDay(); // 0=周日
  return w === 0 ? 7 : w;
}

export function format(d: Day): string {
  if (!isValidDay(d)) return d || "";
  const [, m, dd] = d.split("-");
  // 参考站不补零：卡片上是「11月7日」而不是「11月07日」
  return `${Number(m)}月${Number(dd)}日`;
}

const WEEK_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function weekdayCN(d: Day): string {
  if (!isValidDay(d)) return "";
  return WEEK_CN[new Date(dayToUtc(d)).getUTCDay()];
}

/** "11月5日 周三"（与参考站的卡片/芯片文案一致，日不补零） */
export function formatDayCN(d: Day): string {
  if (!isValidDay(d)) return d || "";
  return `${format(d)} ${weekdayCN(d)}`;
}

/**
 * 日期导航的标题：把「今天/明天/昨天」提到前面，后面跟完整日期。
 * 参考站的日期导航是相对语义优先，纯日期在跨周浏览时才够用。
 */
export function relativeDayCN(d: Day, today: Day): string {
  const n = diffDays(d, today); // >0 = d 在过去（逾期方向）
  const rel = n === 0 ? "今天" : n === -1 ? "明天" : n === 1 ? "昨天" : n === 2 ? "前天" : "";
  const base = formatDayCN(d);
  return rel ? `${rel} · ${base}` : base;
}

/** 该日是不是「今天」（月切片的今天描边、习惯排期判断用）。 */
export function isSameDay(a: Day, b: Day): boolean {
  return !!a && a === b;
}

/** 把绝对时刻 UTC 串转成本地 Date；无效返回 null。 */
export function clockToDate(ct?: ClockTime): Date | null {
  if (!ct) return null;
  const t = new Date(ct);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** "10月08日 17:42"（本地时区）。参考文档 1.2 的已打卡展示格式。 */
export function formatClockCN(ct?: ClockTime): string {
  const t = clockToDate(ct);
  if (!t) return "";
  const m = String(t.getMonth() + 1).padStart(2, "0");
  const d = String(t.getDate()).padStart(2, "0");
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  return `${Number(m)}月${d}日 ${hh}:${mm}`;
}

/** 本地墙钟 HH:MM，给打卡日志的 time 字段用。 */
export function nowHHMM(): string {
  const t = new Date();
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}

/** 月份 "YYYY-MM" 的全部日历日。 */
export function monthDays(month: string): Day[] {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return [];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out: Day[] = [];
  for (let d = 1; d <= last; d++) out.push(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  return out;
}

/** 某月的月历网格（6 行 × 7 列 Mon..Sun），含上月/下月填充格。 */
export function monthGrid(month: string): Day[] {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return [];
  const first = `${month}-01`;
  const lead = (weekdayMon(first) - 1 + 7) % 7;
  const days = monthDays(month);
  const grid: Day[] = [];
  for (let i = lead; i > 0; i--) grid.push(addDays(first, -i));
  grid.push(...days);
  while (grid.length % 7 !== 0) grid.push(addDays(grid[grid.length - 1], 1));
  return grid;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}

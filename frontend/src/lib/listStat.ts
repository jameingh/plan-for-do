// listStat.ts —— 清单统计的纯计算层（日 / 周 / 月共用）。
//
// 不新增内核接口：清单的打卡状态、时刻、分类/标签/优先级全在 CalendarView 的 Occurrence 里，
// 前端按区间取一次再聚合，口径只在这里定一遍，三个页签与三种图共用同一份结果。
// （习惯统计走内核 HabitStat 是因为口径涉及排期/补卡/配额，清单没有这层复杂度。）

import type { Category, ClockTime, Label, Occurrence } from "../api/types";
import { addDays, monthDays, shiftMonth, todayLocal, weekdayMon } from "./day";

export type StatTab = "day" | "week" | "month";
export type Dimension = "category" | "label" | "priority";

export interface StatFrame {
  /** 区间起止（含端点），直接喂给 CalendarView */
  start: string;
  end: string;
  /** 日期行标题：今天 / 11月18日 / 本周 / 11月10日~11月16日 / 本月 / 2026年11月 */
  title: string;
  /** 左/右箭头点击后的新 anchor */
  prev: string;
  next: string;
  /** 当前周期（日=今天、周=本周、月=本月），用来显示「回到本期」 */
  isCurrent: boolean;
  /** 横坐标：日=0/4/8/12/16/20/24（24 无标签但占位），周=周一~周日，月=1..N 日 */
  axis: { key: string; label: string }[];
  /** 区间天数；diligent 用「截至今天」的天数，见 elapsedDays */
  days: number;
  elapsedDays: number;
}

const md = (d: string) => `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日`;
const weekStart = (d: string) => addDays(d, -(weekdayMon(d) - 1));
const ym = (d: string) => d.slice(0, 7);

/** anchor 是「该周期内的任意一天」；切页签时重置成 today。 */
export function frame(tab: StatTab, anchor: string, today: string = todayLocal()): StatFrame {
  if (tab === "day") {
    return {
      start: anchor, end: anchor,
      title: anchor === today ? "今天" : md(anchor),
      prev: addDays(anchor, -1), next: addDays(anchor, 1),
      isCurrent: anchor === today,
      // 第 7 个刻度留空：24 点不标注，但位置要留（用户明确要求）
      axis: ["0", "1", "2", "3", "4", "5", "6"].map((i) => ({
        key: i,
        label: i === "6" ? "" : `${Number(i) * 4}点`,
      })),
      days: 1,
      elapsedDays: anchor <= today ? 1 : 0,
    };
  }
  if (tab === "week") {
    const mon = weekStart(anchor);
    const sun = addDays(mon, 6);
    const curMon = weekStart(today);
    return {
      start: mon, end: sun,
      title: mon === curMon ? "本周" : `${md(mon)}~${md(sun)}`,
      prev: addDays(mon, -7), next: addDays(sun, 1),
      isCurrent: mon === curMon,
      axis: Array.from({ length: 7 }, (_, i) => ({ key: addDays(mon, i), label: "一二三四五六日"[i] })),
      days: 7,
      elapsedDays: countElapsed(mon, sun, today),
    };
  }
  const month = ym(anchor);
  const days = monthDays(month);
  const start = days[0] ?? `${month}-01`;
  const end = days[days.length - 1] ?? start;
  const curMonth = ym(today);
  return {
    start, end,
    title: month === curMonth ? "本月" : `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`,
    prev: `${shiftMonth(month, -1)}-01`, next: `${shiftMonth(month, 1)}-01`,
    isCurrent: month === curMonth,
    axis: days.map((d) => ({ key: d, label: String(Number(d.slice(8, 10))) })),
    days: days.length,
    elapsedDays: countElapsed(start, end, today),
  };
}

/** [start, min(end, today)] 的天数；未来区间返回 0。 */
function countElapsed(start: string, end: string, today: string): number {
  const last = end < today ? end : today;
  if (last < start) return 0;
  let n = 0;
  for (let d = start; d <= last; d = addDays(d, 1)) n++;
  return n;
}

export interface Overview {
  total: number;
  success: number;
  failed: number;
  pending: number;
  /** 打卡率 =（成功 + 失败）/ 应打卡总数，百分数整数 */
  rate: number;
}

export function overview(occs: Occurrence[]): Overview {
  let success = 0, failed = 0;
  for (const o of occs) {
    if (o.status === 1) success++;
    else if (o.status === 3) failed++;
  }
  const total = occs.length;
  return {
    total, success, failed,
    // 跳过(2)也归到「未打卡」：它同样没有完成一次打卡动作
    pending: total - success - failed,
    rate: total ? Math.round(((success + failed) / total) * 100) : 0,
  };
}

/** 趋势：日=按 clockedAt 本地小时落到 6 小时桶，周/月=按 occurrence.day。 */
export function trend(occs: Occurrence[], f: StatFrame): number[] {
  const out = f.axis.map(() => 0);
  if (f.axis.length === 7 && f.axis[0].key === "0") {
    // 日：只有真的打了卡的实例才有时刻；未打卡的落不进任何时段
    for (const o of occs) {
      if (o.status !== 1 && o.status !== 3) continue;
      const h = localHour(o.clockedAt);
      if (h === null) continue;
      const i = Math.floor(h / 4); // 0-3→0, 4-7→1, …, 20-23→5；第 6 格（24 点）永远空着
      if (i >= 0 && i < 6) out[i]++;
    }
    return out;
  }
  const idx = new Map(f.axis.map((a, i) => [a.key, i]));
  for (const o of occs) {
    if (o.status !== 1 && o.status !== 3) continue;
    const i = idx.get(o.day);
    if (i !== undefined) out[i]++;
  }
  return out;
}

function localHour(ct?: ClockTime): number | null {
  if (!ct) return null;
  const d = new Date(ct);
  return Number.isNaN(d.getTime()) ? null : d.getHours();
}

export interface Slice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** 分布只统计「已打卡」的实例（成功 + 失败），与「打卡分布」的语义一致。 */
export function distribution(occs: Occurrence[], dim: Dimension, categories: Category[], labels: Label[]): Slice[] {
  const checked = occs.filter((o) => o.status === 1 || o.status === 3);
  const acc = new Map<string, Slice>();
  const add = (key: string, label: string, color: string) => {
    const hit = acc.get(key);
    if (hit) hit.value++;
    else acc.set(key, { key, label, value: 1, color });
  };
  for (const o of checked) {
    if (dim === "category") {
      const id = o.item.category || "";
      const cat = categories.find((c) => c.id === id);
      add(id, cat?.name || "未分类", cat?.color || "#b6bcc6");
    } else if (dim === "label") {
      const ids = o.item.labelIds ?? [];
      if (!ids.length) {
        add("", "无标签", "#b6bcc6");
      } else {
        for (const id of ids) {
          const l = labels.find((x) => x.id === id);
          add(id, l?.name || "已删除标签", l?.color || "#b6bcc6");
        }
      }
    } else {
      const p = (o.item.priority || 4) as 1 | 2 | 3 | 4;
      const meta: Record<number, [string, string]> = {
        1: ["重要且紧急", "#FD302C"],
        2: ["重要不紧急", "#FF9E00"],
        3: ["不重要但紧急", "#4b8bf4"],
        4: ["不重要不紧急", "#999999"],
      };
      add(String(p), `${p} · ${meta[p][0]}`, meta[p][1]);
    }
  }
  return [...acc.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

export interface Discipline {
  /** 掌控 = 打卡率：把该做的都落实了 */
  control: number;
  /** 高效 = 成功 / 已打卡：打出去的卡有多少真成了 */
  efficient: number;
  /** 勤奋 = 日均打卡数 / 3，封顶 100：单位时间里的投入密度 */
  diligent: number;
}

export function discipline(o: Overview, elapsedDays: number): Discipline {
  const checked = o.success + o.failed;
  return {
    control: o.rate,
    efficient: checked ? Math.round((o.success / checked) * 100) : 0,
    diligent: Math.min(100, Math.round((checked / Math.max(1, elapsedDays) / 3) * 100)),
  };
}

/** 把日/周/月的区间请求做一次收口：月最多 31 天，远在内核 400 天上限内。 */
export function requestRange(f: StatFrame) {
  return { start: f.start, end: f.end, showDone: true, includeHabits: false };
}

export const TABS: { k: StatTab; label: string }[] = [
  { k: "day", label: "日统计" },
  { k: "week", label: "周统计" },
  { k: "month", label: "月统计" },
];

export const DIMENSIONS: { k: Dimension; label: string }[] = [
  { k: "category", label: "按分类" },
  { k: "label", label: "按标签" },
  { k: "priority", label: "按优先级" },
];

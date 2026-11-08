// 专注模块共用的小算式：文案、时长格式化、番茄轮次推进。
//
// 单独成文件的理由和 lib/day.ts 一样：这些换算散在四个组件里，改一处漏三处，
// 而「1 小时 30 分」写成两种口径，统计页和记录列表就会互相打脸。
import type { FocusPlan, FocusType } from "../api/types";

export const FOCUS_TYPE_LABEL: Record<FocusType, string> = { 1: "正计时", 2: "番茄钟", 3: "倒计时" };
export const FOCUS_TYPES: FocusType[] = [1, 2, 3];

/** 番茄默认值，必须与内核 service/focus.go 的 focusPlan 一致。 */
export const DEFAULT_PLAN: FocusPlan = {
  cycles: 4, shortRest: 1, longRest: 2, longEvery: 4, autoRest: true, focusSec: 25 * 60,
};

/** 关联到一次专注上的任务。事项与习惯二选一，与内核的约束一致。 */
export interface FocusTask {
  kind: "item" | "habit";
  id: string;
  name: string;
  /** 事项挂在哪天；习惯没有这个概念 */
  day?: string;
}

/** 沉浸页那颗大时钟：25:00，超过一小时补上小时位。 */
export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${p(h)}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
}

/** 记录与统计里的人话时长：1 小时 30 分 / 25 分 / 40 秒。 */
export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} 秒`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h === 0) return `${m} 分`;
  // 25 分那种「不满一小时」的余数四舍五入后可能变成 60，进位成整小时，别写出「1 小时 60 分」
  return m === 60 ? `${h + 1} 小时` : m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

/** 图表刻度用的分钟数，保留一位小数足够看图了。 */
export const toMinutes = (sec: number) => Math.round((sec / 60) * 10) / 10;

/** 第 cycles 轮专注结束后接哪种休息：每 longEvery 轮上长休息。 */
export function restPhaseAfter(cycles: number, plan: FocusPlan): "short" | "long" {
  const every = plan.longEvery > 0 ? plan.longEvery : 4;
  return cycles > 0 && cycles % every === 0 ? "long" : "short";
}

export function restSecOf(plan: FocusPlan, phase: "short" | "long"): number {
  return (phase === "long" ? plan.longRest : plan.shortRest) * 60;
}

/** 还剩几轮（含正在走的这一轮）。计划外的额外轮次不会算成负数。 */
export const cyclesLeft = (done: number, plan: FocusPlan) => Math.max(0, plan.cycles - done);

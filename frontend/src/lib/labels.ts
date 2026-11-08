// labels.ts —— 把 DateSpec/TimeSpec/Repeat 翻成中文摘要（行内展示与重复编辑器共用）。

import type { DateSpec, ListItem, Reminder, Repeat, TimeSpec } from "../api/types";
import { diffDays, format } from "./day";

const WEEK_CN = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function describeDate(d: DateSpec): string {
  if (!d.start && !(d.selected?.length ?? 0)) return "";
  switch (d.kind) {
    case 1:
      return format(d.start);
    case 2:
      return `${format(d.start)}-${format(d.end || d.start)}`;
    case 3:
      return `${format(d.start)} 等${(d.selected ?? []).length}天`;
    default:
      return format(d.start);
  }
}

export function describeTime(t: TimeSpec): string {
  switch (t.kind) {
    case 1:
      return t.start || "";
    case 2:
      return `${t.start || "?"}-${t.end || "?"}`;
    default:
      return "全天";
  }
}

export const QUADRANT_LABELS: Record<number, string> = {
  1: "重要且紧急",
  2: "重要不紧急",
  3: "不重要但紧急",
  4: "不重要不紧急",
};

/**
 * 象限序号的字形。参考站把 I / II / III / IV 做成了衬线体位图图标（`.icon-priority-N`，14×14），
 * 我们原先用 Unicode 罗马数字 Ⅰ Ⅱ Ⅲ Ⅳ：那几个码位在无衬线字体里要么发虚、要么直接缺字掉框。
 * 这里改成普通 ASCII 字母 + 衬线字体渲染（`.quad-num`），形状和参考站一致且任意字号都清晰。
 */
export const QUADRANT_ROMAN: Record<number, string> = { 1: "I", 2: "II", 3: "III", 4: "IV" };

/** 行内/详情头用的两字缩写：四象限全称在 320px 的详情栏里放不下。 */
export const QUADRANT_SHORT: Record<number, string> = {
  1: "急要",
  2: "重要",
  3: "急",
  4: "琐碎",
};

export function quadrantShort(p: number): string {
  return QUADRANT_SHORT[p] ?? QUADRANT_SHORT[4];
}

function weekdaysLabel(ws: number[]): string {
  if (ws.length === 5 && [1, 2, 3, 4, 5].every((x) => ws.includes(x))) return "周一至周五";
  return ws.map((w) => WEEK_CN[w - 1] ?? `周${w}`).join("、");
}

/** 从 Repeat 反推展示名（内核无 Description，这里按 model/repeat.go 的约定自己拼）。 */
export function describeRepeat(r?: Repeat): string {
  if (!r) return "仅一次";
  if (r.ebbinghaus) return "艾宾浩斯记忆法";
  const interval = r.interval <= 0 ? 1 : r.interval;
  const tail = interval > 1 ? `每${interval}${r.unit === 1 ? "天" : r.unit === 2 ? "周" : r.unit === 3 ? "月" : "年"}` : "";
  switch (r.unit) {
    case 1:
      return tail || "每天";
    case 2:
      return `${tail || "每周"}(${weekdaysLabel(r.weekdays?.length ? r.weekdays : [1])})`;
    case 3: {
      const md = r.monthDays?.length ? r.monthDays : [1];
      return `${tail || "每月"}(${md.map((x) => (x === -1 ? "最后一天" : `${x}日`)).join("、")})`;
    }
    case 4:
      return `${tail || "每年"}(${r.yearMonth ? `${String(r.yearMonth).padStart(2, "0")}月` : ""}${r.yearDay ? `${String(r.yearDay).padStart(2, "0")}日` : ""})`;
    default:
      return "自定义重复";
  }
}

/**
 * 结束条件的文案照抄参考站实测（2026-11-07 新建弹窗里选完保存后读芯片）：
 * 永不 → 「永不结束」；按日期 → 「结束日期: 2026-11-20」；按次数 → 「结束次数: 重复 3 次结束」。
 * 参考站这里直接拼了 ISO 日期，没做「11月20日」这种本地化——我们保留同样的读法，
 * 因为它和「按次数」那条一样属于状态摘要，不是给用户读的正文；日期在面板里已经是中文了。
 */
export function describeEnd(r?: Repeat): string {
  if (!r) return "";
  switch (r.end.mode) {
    case 1:
      return `结束日期: ${r.end.date ?? ""}`;
    case 2:
      return `结束次数: 重复 ${r.end.count ?? 1} 次结束`;
    default:
      return "永不结束";
  }
}

/** 行上的日期段：'逾期73天' 之类由组件另拼，这里给基础形态。 */
/**
 * 一行该显示的日期。
 *
 * 传 instanceDay 时按「这一次实例」显示：重复事项在待办里排的是未来的某一天，
 * 只显示本体起始日会让明天那条也写成今天的日期。
 */
export function itemWhenText(it: ListItem, instanceDay?: string): string {
  const spec: DateSpec = instanceDay ? { kind: 1, start: instanceDay } : it.date;
  const d = describeDate(spec);
  if (!d) return "无日期";
  const t = it.time.kind === 0 ? "" : ` ${describeTime(it.time)}`;
  return d + t;
}

/**
 * 提醒的一行文字。
 *
 * 参考站的两类提醒各有各的写法（`initRemind`）：
 *   remindType=1 偏移型 → 「当天(09:00) / 提前7天(09:00)」；
 *   remindType=2 绝对型 → 「11月07日 09:30」（日期补零、中间一个空格）。
 * 多条提醒怎么串起来见下面的 `describeReminders`。
 */
export function describeReminder(r?: Reminder): string {
  if (!r) return "设置提醒";
  if (r.atDay) {
    const d = r.atDay;
    const mm = d.slice(5, 7), dd = d.slice(8, 10);
    return `${mm}月${dd}日 ${r.atTime ?? "00:00"}`;
  }
  const o = r.offset ?? { days: 0, hours: 0, minutes: 0 };
  if (r.atTime) {
    const d = o.days || 0;
    return d === 0 ? `当天(${r.atTime})` : `提前${d}天(${r.atTime})`;
  }
  if (!o.days && !o.hours && !o.minutes) return "准时";
  const parts: string[] = [];
  if (o.days) parts.push(`${o.days}天`);
  if (o.hours) parts.push(`${o.hours}时`);
  if (o.minutes) parts.push(`${o.minutes}分`);
  return `提前${parts.join("")}`;
}

/**
 * 多条提醒的行内摘要。
 *
 * 参考站（`initRemind`）就是把每条的 text 用逗号串起来、去掉末尾逗号，
 * 不做「N 条提醒」这类折叠，芯片/字段行自己省略号截断。我们照抄，免得同一事项
 * 在两处显示成不同的意思。
 */
export function describeReminders(rs: Reminder[]): string {
  return rs.map((r) => describeReminder(r)).join(",");
}

export function isPastDay(day: string, today: string): boolean {
  return !!day && diffDays(day, today) > 0;
}

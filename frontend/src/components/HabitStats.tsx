// HabitStats.tsx —— 习惯统计：日 / 周 / 月 / 年四个标签页。
//
// 四个页签共用内核一个区间接口（HabitStat），聚合口径只在 Go 那边定一次：
//   · 打卡 = 那天有量 > 0 的记录（多次习惯没打满也算打了卡）
//   · 打满 = 量 ≥ 当日目标
//   · 完美打卡 = 某天应打的习惯全部打满
// 导航一律不允许越过今天：下一页的起点一旦晚于今天，右箭头就置灰不可点。
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { HabitStat, HabitStatDay, HabitStatHabit } from "../api/types";
import { useApp, toastErr } from "../store/appStore";
import { addDays, monthDays, todayLocal, weekdayMon } from "../lib/day";
import { Glyph, I } from "./ui";

type Tab = "day" | "week" | "month" | "year";
const TABS: { k: Tab; label: string }[] = [
  // 页签文案按用户要求（2026-11-08）改成「日/周/月/年专注」；这一页统计的仍是习惯打卡，
  // 语义与「专注」模块不是一回事，改名只动文案，不动口径（见 docs §23）。
  { k: "day", label: "日专注" },
  { k: "week", label: "周专注" },
  { k: "month", label: "月专注" },
  { k: "year", label: "年专注" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const md = (day: string) => `${day.slice(5, 7).replace(/^0/, "")}月${day.slice(8, 10)}日`;
const weekStart = (day: string) => addDays(day, -(weekdayMon(day) - 1));

/** 页签 + 锚点 → 区间、标题、下一页起点。 */
function frame(tab: Tab, anchor: string) {
  if (tab === "day") return { start: anchor, end: anchor, title: md(anchor), next: addDays(anchor, 1) };
  if (tab === "week") {
    const mon = weekStart(anchor);
    const sun = addDays(mon, 6);
    return { start: mon, end: sun, title: `${md(mon)}~${md(sun)}`, next: addDays(sun, 1) };
  }
  if (tab === "month") {
    const ym = anchor.slice(0, 7);
    const days = monthDays(ym);
    return { start: days[0], end: days[days.length - 1], title: `${Number(ym.slice(0, 4))}年${Number(ym.slice(5, 7))}月`, next: addDays(days[days.length - 1], 1) };
  }
  const y = anchor.slice(0, 4);
  return { start: `${y}-01-01`, end: `${y}-12-31`, title: `${Number(y)}年`, next: `${Number(y) + 1}-01-01` };
}

/** 上一页的起点：日/周按天跳，月/年按整月整年跳，避免月末 31 号加一天串到隔月。 */
function prevStart(tab: Tab, anchor: string): string {
  if (tab === "day") return addDays(anchor, -1);
  if (tab === "week") return addDays(weekStart(anchor), -7);
  if (tab === "month") {
    const d = new Date(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)) - 2, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
  }
  return `${Number(anchor.slice(0, 4)) - 1}-01-01`;
}

export function HabitStats() {
  const { booted, revision } = useApp();
  const today = todayLocal();
  const [tab, setTab] = useState<Tab>("day");
  const [anchor, setAnchor] = useState<string>(today);
  const [stat, setStat] = useState<HabitStat | null>(null);

  const f = useMemo(() => frame(tab, anchor), [tab, anchor]);
  // 未来方向能不能走：下一页的起点一旦晚于今天就不给走
  const canNext = f.next <= today;
  // 往回不设限：用户只要求「不能切到未来」，历史多久都能翻

  useEffect(() => {
    if (!booted) return;
    let dead = false;
    api.HabitStat({ start: f.start, end: f.end })
      .then((v) => !dead && setStat(v))
      .catch((e) => { if (!dead) { setStat(null); toastErr(e); } });
    return () => { dead = true; };
  }, [booted, revision, f.start, f.end]);

  return (
    <div className="hs">
      <nav className="hs-tabs" role="tablist" aria-label="统计粒度">
        {TABS.map((t) => (
          <button key={t.k} role="tab" aria-selected={tab === t.k}
            className={"hs-tab" + (tab === t.k ? " is-sel" : "")}
            onClick={() => { setTab(t.k); setAnchor(today); }}>{t.label}</button>
        ))}
      </nav>

      <div className="hs-head">
        <button className="hs-arrow" aria-label="上一页" onClick={() => setAnchor(prevStart(tab, anchor))}><I n="chevronLeft" size={12} /></button>
        <span className="hs-title">{f.title}</span>
        <button className="hs-arrow" aria-label="下一页" disabled={!canNext}
          title={canNext ? "" : "不能查看未来的日期"}
          onClick={() => canNext && setAnchor(f.next)}><I n="chevronRight" size={12} /></button>
        {anchor !== today && <button className="hs-now" onClick={() => setAnchor(today)}>回到今天</button>}
      </div>

      {!stat && <div className="hs-loading">正在统计…</div>}
      {stat && tab === "day" && <DayStat stat={stat} today={today} />}
      {stat && tab === "week" && <WeekStat stat={stat} />}
      {stat && tab === "month" && <MonthStat stat={stat} />}
      {stat && tab === "year" && <YearStat stat={stat} />}
    </div>
  );
}

/** 一格方块：on=已打卡（红），off=应打未打（灰），rest=没排期/还没到（浅灰）。 */
function Cell({ state, day, title }: { state: string; day: string; title?: string }) {
  const kind = state === "done" || state === "partial" ? "on" : state === "missed" || state === "pending" ? "off" : "rest";
  return <i className={"hs-cell is-" + kind} data-day={day} title={title ?? `${day} ${kind === "on" ? "已打卡" : kind === "off" ? "未打卡" : "休息"}`} />;
}

function DayStat({ stat, today }: { stat: HabitStat; today: string }) {
  const day = stat.days[0];
  const rows = stat.habits;
  const due = rows.filter((h) => cellOf(h, day.day).state !== "rest");
  const rest = rows.filter((h) => cellOf(h, day.day).state === "rest");
  const pct = day && day.scheduled > 0 ? Math.round((day.done / day.scheduled) * 100) : null;
  return (
    <>
      <section className="hs-card">
        <header className="hs-card-head"><span>今日打卡</span><span className="hs-sub">{due.length} 个习惯</span></header>
        <ul className="hs-list">
          {[...due, ...rest].map((h) => {
            const c = cellOf(h, day.day);
            const isRest = c.state === "rest";
            return (
              <li key={h.habitId} className={"hs-row" + (isRest ? " is-rest" : "")}>
                <Glyph kind={h.icon.kind} glyph={h.icon.ref} color={h.icon.color} size={26} round />
                <span className="hs-name">{h.name}</span>
                <span className={"hs-progress" + (c.state === "done" ? " is-done" : "")}>
                  {isRest ? "休息" : progressText(h, c)}
                </span>
              </li>
            );
          })}
          {!rows.length && <li className="hs-empty">还没有习惯，去「习惯」页建一个。</li>}
        </ul>
      </section>
      <section className="hs-card hs-perfect">
        <div className="hs-perfect-text">
          <b>完美打卡</b>
          <span className="hs-sub">{day && day.scheduled > 0 ? `今天该打 ${day.scheduled} 个，已打满 ${day.done} 个` : "今天没有要打的习惯"}</span>
        </div>
        <div className="hs-ring" style={{ "--p": String(pct ?? 0) } as React.CSSProperties} aria-label={`今日完成度 ${pct ?? 0}%`}>
          <span>{pct === null ? "—" : `${pct}%`}</span>
        </div>
      </section>
    </>
  );
}

function WeekStat({ stat }: { stat: HabitStat }) {
  const days = stat.days;
  return (
    <>
      <section className="hs-card">
        <header className="hs-card-head"><span>本周打卡</span><span className="hs-sub">{fmtRange(days)}</span></header>
        <div className="hs-grid" role="table">
          <div className="hs-grid-row is-head">
            <span className="hs-grid-name" />
            {days.map((d) => (
              <span key={d.day} className="hs-grid-wk" title={d.day}>
                <b>{"一二三四五六日"[weekdayMon(d.day) - 1]}</b>
                <i>{Number(d.day.slice(8, 10))}</i>
              </span>
            ))}
          </div>
          {stat.habits.map((h) => (
            <div key={h.habitId} className="hs-grid-row" role="row">
              <span className="hs-grid-name">
                <Glyph kind={h.icon.kind} glyph={h.icon.ref} color={h.icon.color} size={20} round />
                <em>{h.name}</em>
              </span>
              {h.days.map((c) => <Cell key={c.day} state={c.state} day={c.day} />)}
            </div>
          ))}
          {!stat.habits.length && <div className="hs-empty">还没有习惯。</div>}
        </div>
      </section>
      <section className="hs-card hs-stats3">
        <div><b>{stat.summary.checkins}</b><span>打卡总数（次）</span></div>
        <div><b>{stat.summary.longestStreak}</b><span>最长连续（天）</span></div>
        <div><b>{stat.summary.perfectDays}</b><span>完美打卡（天）</span></div>
      </section>
    </>
  );
}

function MonthStat({ stat }: { stat: HabitStat }) {
  return (
    <div className="hs-cards">
      {stat.habits.map((h) => (
        <section key={h.habitId} className="hs-card hs-habit-card">
          <header className="hs-card-head">
            <span><Glyph kind={h.icon.kind} glyph={h.icon.ref} color={h.icon.color} size={20} round /> <b>{h.name}</b></span>
            <span className="hs-sub">{h.done}/{h.scheduled}</span>
          </header>
          <div className="hs-month">
            <MonthCells habit={h} />
          </div>
        </section>
      ))}
      {!stat.habits.length && <div className="hs-empty">还没有习惯。</div>}
    </div>
  );
}

/**
 * 月卡格子按星期对齐：1 号落在哪一列就从哪一列开始，前面补空位。
 * 不补的话 1 号永远顶在第一列，同一张卡里「周三」和「周六」看着是同一列，
 * 与年热力图（也是按星期对齐）摆在一起会自相矛盾。
 */
function MonthCells({ habit }: { habit: HabitStatHabit }) {
  const lead = habit.days.length ? weekdayMon(habit.days[0].day) - 1 : 0;
  return (
    <>
      <div className="hs-month-wk" aria-hidden="true">
        {"一二三四五六日".split("").map((w) => <i key={w}>{w}</i>)}
      </div>
      {Array.from({ length: lead }, (_, i) => <Cell key={`lead-${i}`} state="rest" day="" title="" />)}
      {habit.days.map((c) => (
        <Cell key={c.day} state={c.state} day={c.day} title={`${Number(c.day.slice(8, 10))}日`} />
      ))}
    </>
  );
}

function YearStat({ stat }: { stat: HabitStat }) {
  return (
    <div className="hs-cards is-year">
      {stat.habits.map((h) => (
        <section key={h.habitId} className="hs-card hs-heat">
          <header className="hs-card-head">
            <span><Glyph kind={h.icon.kind} glyph={h.icon.ref} color={h.icon.color} size={20} round /> <b>{h.name}</b></span>
            <span className="hs-sub">全年打卡 <b>{h.checked}</b> 天</span>
          </header>
          <Heatmap habit={h} />
        </section>
      ))}
      {!stat.habits.length && <div className="hs-empty">还没有习惯。</div>}
    </div>
  );
}

/**
 * 热力图排成「一列一周、一行星期一到星期日」。
 * 两头各补一次空位：第一列补上 1 月 1 日之前的那几天，最后一列补上 12 月 31 日之后的那几天，
 * 这样每列恒为 7 格，行高对齐星期，看着才像一张日历而不像锯齿。
 */
function Heatmap({ habit }: { habit: HabitStatHabit }) {
  const cols: HabitStatDay[][] = [];
  if (!habit.days.length) return null;
  const pad = (day: string): HabitStatDay => ({ day, state: "rest", amount: 0, target: 0 });
  let bucket: HabitStatDay[] = [];
  // 第一列前面补几天 = 1 月 1 日是周几（周一=0 … 周日=6）
  for (let k = 0; k < weekdayMon(habit.days[0].day) - 1; k++) bucket.push(pad(""));
  habit.days.forEach((c) => {
    bucket.push(c);
    if (weekdayMon(c.day) === 7) { cols.push(bucket); bucket = []; }
  });
  if (bucket.length) {
    while (bucket.length < 7) bucket.push(pad(""));
    cols.push(bucket);
  }
  return (
    <div className="hs-heat-grid" role="img" aria-label={`${habit.name} 全年打卡热力图`}>
      {cols.map((col, ci) => (
        <div key={ci} className="hs-heat-col">
          {col.map((c, ri) => <Cell key={`${c.day || "pad"}-${ci}-${ri}`} state={c.state} day={c.day} />)}
        </div>
      ))}
    </div>
  );
}

const cellOf = (h: HabitStatHabit, day: string) =>
  h.days.find((c) => c.day === day) ?? { day, state: "rest" as const, amount: 0, target: 1 };

/** 进度文案：每天一次（mode=1）写「1/1次」，每天多次（mode=2）按量与单位写「3/8杯」。 */
function progressText(h: HabitStatHabit, c: { amount: number; target: number }): string {
  const done = Math.min(c.amount, c.target);
  const unit = h.mode === 2 ? (h.unit || "次") : "次";
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return `${fmt(done)}/${fmt(c.target)}${unit}`;
}

const fmtRange = (days: { day: string }[]) =>
  days.length ? `${md(days[0].day)} - ${md(days[days.length - 1].day)}` : "";

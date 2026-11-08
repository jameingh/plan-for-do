// ViewsPage.tsx —— 视图模块：日 / 周 / 月三套网格，照参考站 ViewModule + ViewMonth/ViewWeek/ViewDay 复刻。
//
// 取证见 docs/design-reference.md §21（原始记录 tmp/ref/evidence-*.md）。三条关键口径：
//   · 月视图每格 3 条泳道 + 1 条「还有 N 个任务」计数行；跨天事项在一行内连成一条彩条，
//     行尾裁断、下一行重新起条（参考站 createAllChain 就是这个行为）。
//   · 周/日是 24 行小时网格：1 小时 = --hour-h，块高 = 时长/60 × --hour-h，最小 26px；
//     重叠事项按「链」并排分栏，右侧相邻空链可以借来加宽（freeWidth）。
//   · 「显示已打卡」关掉时：格子里的单日事项仍然渲染、只是透明度降到 .25，
//     只有跨天条与计数把它跳过。照抄这条，否则用户会觉得「打卡后事项消失了」。
//
// 与参考站的有意差异（§21.4 逐条说明）：
//   1. 班/休标记不画——那需要法定节假日与调休数据源，本项目只有接口没有数据；宁可少标不标错。
//   2. 小时块用 absolute 定位而不是它的负 margin 文档流；视觉一致，代码少一半。
//   3. --hour-h 用 clamp(56px, 8.073vw, 155px) 复刻它的视口比例缩放并加上下限。

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type {
  CalendarDay,
  CalendarHabit,
  CalendarView,
  Category,
  Habit,
  HabitContext,
  Label,
  LunarCell,
  Occurrence,
  PlList,
  ViewConfig,
} from "../api/types";
import { addDays, diffDays, formatDayCN, monthGrid, shiftMonth, todayLocal, weekdayCN, weekdayMon } from "../lib/day";
import { useNav } from "../lib/nav";
import { patchView, selectOccurrence, setPage, toastErr, useApp } from "../store/appStore";
import type { CreateSpec } from "./ItemDetail";
import { I } from "./ui";
import { ItemDetail } from "./ItemDetail";
import { HabitDetail } from "./HabitDetail";
import { Popover } from "./ItemPanels";
import { CustomizeMenu, SettingMenu, ViewColorDialog, ViewContentDialog } from "./ViewCustomize";
type Kind = "day" | "week" | "month";

/** 参考站的四象限色，逐值相同（priorityItems），配色模式 2 用。 */
const PRIORITY_COLORS: Record<number, string> = { 1: "#FD302C", 2: "#FF9E00", 3: "#0042FF", 4: "#999999" };
/** 没配色时的兜底灰，与参考站 viewColor 空值时的 #F6F7F8 一致。 */
const FALLBACK_COLOR = "#F6F7F8";
/** 已打卡条的透明度：参考站 .25。 */
const CLOCKED_OPACITY = 0.25;
const WEEK_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
/** 月格泳道数（不含计数行）。参考站按格子高度算 chainCount，我们固定 3 + 1 计数。 */
const MONTH_LANES = 3;

type Bar = {
  key: string;
  start: number;
  end: number;
  text: string;
  color: string;
  dim: boolean;
  day: string;
  occ?: Occurrence;
  habit?: CalendarHabit;
};

const minutesOf = (hhmm?: string): number => {
  if (!hhmm) return -1;
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : -1;
};

const isClocked = (o: Occurrence) => o.status === 1 || o.status === 3;

/**
 * 「设置 → 显示已打卡清单/习惯」两个开关的落点。
 * 参考站（evidence-custom-view §5.3）：关掉后跨天条/连续条跳过 status>0 的项，
 * 已打卡项不再参与「还有 N 个任务」计数；开着时仍渲染，只是透明度降到 .25。
 */
const showMatter = (o: Occurrence, cfg: ViewConfig) => !(cfg.hideMatterClocked && isClocked(o));
const showHabit = (h: CalendarHabit, cfg: ViewConfig) => !(cfg.hideHabitClocked && h.state === "done");

/**
 * 事项条颜色：0 按清单本 / 1 按分类 / 2 按优先级 / 3 固定色，空值兜底 #F6F7F8（与参考站同）。
 *
 * 模式 0 允许退到分类色：参考站的清单本天生带色，我们的清单本色是选填，
 * 全灰一屏看着像坏了。优先级色（#999 那档）不参与兜底——它太深，只作为模式 2 的显式选择。
 */
function matterColor(item: Occurrence["item"], cfg: ViewConfig, lists: PlList[], cats: Category[]): string {
  const listColor = lists.find((l) => l.id === item.listId)?.color ?? "";
  const catColor = cats.find((x) => x.id === item.category)?.color ?? "";
  let c = "";
  switch (cfg.matterColorMode) {
    case 0: c = listColor || catColor; break;
    case 1: c = catColor || listColor; break;
    case 2: c = PRIORITY_COLORS[item.priority || 4] ?? PRIORITY_COLORS[4]; break;
    case 3: c = cfg.matterColorValue; break;
  }
  return c || FALLBACK_COLOR;
}

/** 一条习惯条的颜色：0 跟随图标色 / 1 固定色（参考站那边习惯配色实际没生效，我们不照抄那个 bug）。 */
function habitColor(h: CalendarHabit, cfg: ViewConfig): string {
  return (cfg.habitColorMode === 1 && cfg.habitColorValue ? cfg.habitColorValue : h.color) || FALLBACK_COLOR;
}

/**
 * 一行（月视图的一周 / 周日视图的全天区）里的横条。
 * 跨天事项只在它「本行第一次出现」的那格起条，向右延伸到本行内连续存在的最后一天。
 */
function rowBars(row: string[], byDay: Map<string, CalendarDay>, cfg: ViewConfig, nav: { lists: PlList[]; categories: Category[] }, allDayOnly = false): Bar[] {
  const out: Bar[] = [];
  const taken = new Set<string>();
  row.forEach((d, i) => {
    const cell = byDay.get(d);
    if (!cell) return;
    for (const o of cell.items) {
      // 周/日视图里带时刻的事项走小时网格，不进全天区（参考站 allDayChainItems 就是这么筛的）
      if (allDayOnly && o.item.time.kind !== 0) continue;
      if (!showMatter(o, cfg)) continue;
      if (taken.has(o.item.id)) continue;
      let end = i;
      const spanEnd = o.item.date.kind === 2 && o.item.date.end ? o.item.date.end : d;
      while (end + 1 < row.length && row[end + 1] <= spanEnd && (byDay.get(row[end + 1])?.items ?? []).some((x) => x.item.id === o.item.id)) {
        end++;
      }
      taken.add(o.item.id);
      out.push({
        key: `${o.item.id}@${d}`, start: i, end, day: d, occ: o,
        text: o.item.title, color: matterColor(o.item, cfg, nav.lists, nav.categories), dim: isClocked(o),
      });
    }
    for (const h of cell.habits ?? []) {
      if (!showHabit(h, cfg)) continue;
      out.push({
        key: `h:${h.habitId}@${d}`, start: i, end: i, day: d, habit: h,
        text: h.name, color: habitColor(h, cfg), dim: h.state === "done",
      });
    }
  });
  return out;
}

/**
 * 贪心分泳道：从左往右走，游标只前进不回退；装不下的进 overflow，由调用方折算成「还有 N 个任务」。
 * 这就是参考站 createAllChain / createCountChain 的行为。
 */
function packLanes(bars: Bar[], laneCount: number): { lanes: Bar[][]; overflow: Bar[] } {
  const rest = bars.slice().sort((a, b) => a.start - b.start || b.end - a.end);
  const lanes: Bar[][] = [];
  for (let l = 0; l < laneCount; l++) {
    const lane: Bar[] = [];
    let cursor = 0;
    for (;;) {
      const i = rest.findIndex((s) => s.start >= cursor);
      if (i < 0) break;
      const s = rest.splice(i, 1)[0];
      lane.push(s);
      cursor = s.end + 1;
    }
    lanes.push(lane);
  }
  return { lanes, overflow: rest };
}

/**
 * 每天被折叠掉的条数：当天总条数 − 已上栏的条数。
 * 一条跨天彩条覆盖的每一天都算「已显示」，所以计数按列区间展开（参考站的 countAfterChain 同理）。
 */
function hiddenCounts(row: string[], lanes: Bar[][], byDay: Map<string, CalendarDay>, cfg: ViewConfig, allDayOnly = false): number[] {
  return row.map((d, i) => {
    const cell = byDay.get(d);
    if (!cell) return 0;
    const items = cell.items.filter((o) => showMatter(o, cfg) && (!allDayOnly || o.item.time.kind === 0));
    const habits = (cell.habits ?? []).filter((h) => showHabit(h, cfg));
    const total = items.length + habits.length;
    const onLane = lanes.flat().filter((b) => b.start <= i && i <= b.end).length;
    return Math.max(0, total - onLane);
  });
}

export function ViewsPage() {
  const { settings, revision, booted, selection } = useApp();
  const nav = useNav(booted, revision);
  const cfg = settings.view;
  const today = todayLocal();

  const [kind, setKind] = useState<Kind>("month");
  const [anchor, setAnchor] = useState<string>(today);
  const [cal, setCal] = useState<CalendarView | null>(null);
  const [lunar, setLunar] = useState<Record<string, LunarCell>>({});
  const [pop, setPop] = useState<{ day: string; rect: DOMRect } | null>(null);
  const [create, setCreate] = useState<CreateSpec | null>(null);
  const [habit, setHabit] = useState<Habit | null>(null);
  const [menu, setMenu] = useState<"" | "custom" | "setting">("");
  const [dialog, setDialog] = useState<"" | "content" | "color">("");
  const [contexts, setContexts] = useState<HabitContext[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /** 当前窗口覆盖的日期：月=补齐到整周，周=周一起 7 天，日=当天。 */
  const days = useMemo(() => {
    if (kind === "month") return monthGrid(anchor.slice(0, 7));
    if (kind === "week") {
      const mon = addDays(anchor, -(weekdayMon(anchor) - 1));
      return Array.from({ length: 7 }, (_, i) => addDays(mon, i));
    }
    return [anchor];
  }, [kind, anchor]);

  const first = days[0];
  const last = days[days.length - 1];

  useEffect(() => {
    if (!booted) return;
    let dead = false;
    api.CalendarView({
      start: first,
      end: last,
      // 已打卡的一律取回，由界面按参考站规则处理（格子保留但变淡、跨天条跳过）。
      showDone: true,
      includeHabits: true,
      hideCategoryIds: cfg.hideCategories,
      hideHabitContexts: cfg.hideHabitContexts,
    }).then((v) => !dead && setCal(v)).catch(toastErr);
    api.LunarLabels(days).then((cs) => !dead && setLunar(Object.fromEntries(cs.map((c) => [c.day, c])))).catch(() => undefined);
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, first, last, revision, cfg.hideCategories.join(","), cfg.hideHabitContexts.join(",")]);


  const byDay = useMemo(() => {
    const m = new Map<string, CalendarDay>();
    for (const d of cal?.days ?? []) m.set(d.day, d);
    return m;
  }, [cal]);

  // 「自定义视图内容」的习惯页签要列情境，只在打开弹窗前备好一份。
  useEffect(() => {
    if (!booted) return;
    let dead = false;
    api.HabitContexts().then((cs) => !dead && setContexts(cs)).catch(() => undefined);
    return () => { dead = true; };
  }, [booted, revision]);

  function turn(dir: "prev" | "next" | "current") {
    if (dir === "current") return setAnchor(today);
    const step = dir === "prev" ? -1 : 1;
    if (kind === "month") return setAnchor(shiftMonth(anchor, step) + anchor.slice(7));
    if (kind === "week") return setAnchor(addDays(anchor, step * 7));
    return setAnchor(addDays(anchor, step));
  }

  const title = kind === "month"
    ? `${Number(anchor.slice(0, 4))}年${Number(anchor.slice(5, 7))}月`
    : kind === "week"
      ? (() => {
        const mon = addDays(anchor, -(weekdayMon(anchor) - 1));
        const sun = addDays(mon, 6);
        return `${Number(mon.slice(5, 7))}.${Number(mon.slice(8, 10))} - ${Number(sun.slice(5, 7))}.${Number(sun.slice(8, 10))}`;
      })()
      : formatDayCN(anchor);

  // 周/日视图打开时滚到「当前时刻往前两小时」，与参考站 toTimeHeight 一致。
  useEffect(() => {
    if (kind === "month") return;
    const el = scrollRef.current;
    if (!el) return;
    const t = setTimeout(() => {
      // 注意：--hour-h 是 clamp() 表达式，getComputedStyle 拿回来的是原文，parseFloat 只会读到下界 56。
      // 所以量真实渲染出来的小时行高，别解析自定义属性。
      const row = el.querySelector<HTMLElement>(".vw-hour");
      const h = row ? row.getBoundingClientRect().height : 56;
      el.scrollTo({ top: Math.max(0, (new Date().getHours() - 2) * h), behavior: "smooth" });
    }, 150);
    return () => clearTimeout(t);
  }, [kind, first]);

  const openCreate = (day: string) => setCreate({ day, priority: 4, listId: nav.lists[0]?.id ?? "list-default" });

  return (
    <div className="views-page">
      <header className="v-head">
        <div className="v-head-left">
          {([["day", "日视图"], ["week", "周视图"], ["month", "月视图"]] as [Kind, string][]).map(([k, label]) => (
            <button key={k} className={"v-type" + (kind === k ? " is-sel" : "")} onClick={() => setKind(k)}>
              <span>{label}</span>{kind === k && <i className="v-type-bar" />}
            </button>
          ))}
          <button className="v-add" onClick={() => openCreate(anchor)}><I n="plus" size={12} />新建清单</button>
        </div>
        <div className="v-head-center">
          <button className="v-arrow" aria-label="上一页" onClick={() => turn("prev")}><I n="chevronLeft" size={12} /></button>
          <span className="v-title">{title}</span>
          <button className="v-arrow" aria-label="下一页" onClick={() => turn("next")}><I n="chevronRight" size={12} /></button>
          <button className={"v-today" + (diffDays(first, today) >= 0 && diffDays(today, last) >= 0 ? "" : " is-on")}
            aria-label="回到今天" title="回到今天" onClick={() => turn("current")}><I n="arrowDown" size={11} /></button>
        </div>
        <div className="v-head-right">
          <button className="v-entry" onClick={() => setMenu(menu === "custom" ? "" : "custom")}><I n="pencil" size={11} />自定义视图</button>
          <button className="v-entry" onClick={() => setMenu(menu === "setting" ? "" : "setting")}><I n="gear" size={11} />设置</button>
        </div>
      </header>

      {menu === "custom" && <CustomizeMenu onPick={(which) => { setMenu(""); setDialog(which); }} onClose={() => setMenu("")} />}
      {menu === "setting" && <SettingMenu cfg={cfg} onToggle={(k) => patchView({ [k]: !cfg[k] } as Partial<ViewConfig>)} onClose={() => setMenu("")} />}

      <div className="v-body">
        {kind === "month" && (
          <MonthGrid days={days} byDay={byDay} lunar={lunar} today={today} cfg={cfg} nav={nav}
            onBar={(o) => selectOccurrence(o)}
            onHabit={(h, day) => void openHabitDetail(h, day, setHabit)}
            onCell={(d, rect) => setPop({ day: d, rect })} />
        )}
        {kind !== "month" && (
          <TimeGrid kind={kind} days={days} byDay={byDay} lunar={lunar} today={today} cfg={cfg} nav={nav}
            scrollRef={scrollRef}
            onBar={(o) => selectOccurrence(o)}
            onHabit={(h, day) => void openHabitDetail(h, day, setHabit)}
            onCell={(d, rect) => setPop({ day: d, rect })} />
        )}
      </div>

      {pop && (
        <DayPop cell={byDay.get(pop.day) ?? null} day={pop.day} anchor={pop.rect} cfg={cfg} nav={nav}
          onClose={() => setPop(null)}
          onBar={(o) => { setPop(null); selectOccurrence(o); }}
          onHabit={(h) => { setPop(null); void openHabitDetail(h, pop.day, setHabit); }}
          onCreate={() => { setPop(null); openCreate(pop.day); }} />
      )}

      {dialog === "content" && <ViewContentDialog cfg={cfg} categories={nav.categories} contexts={contexts} onClose={() => setDialog("")} />}
      {dialog === "color" && <ViewColorDialog cfg={cfg} onClose={() => setDialog("")} />}

      {(selection.occurrence || create) && (
        <div className="detail-overlay">
          {create ? (
            <ItemDetail occ={null} create={create} categories={nav.categories} labels={nav.labels}
              lists={nav.lists.map((l) => ({ id: l.id, name: l.name }))} onClose={() => setCreate(null)} />
          ) : (
            <ItemDetail occ={selection.occurrence} categories={nav.categories} labels={nav.labels}
              lists={nav.lists.map((l) => ({ id: l.id, name: l.name }))} />
          )}
        </div>
      )}

      {habit && (
        <div className="detail-overlay">
          <HabitDetail habit={habit} month={anchor.slice(0, 7)} units={[]}
            onEdit={() => { setHabit(null); setPage("habits"); }} onClose={() => setHabit(null)} />
        </div>
      )}
    </div>
  );
}

/** 点习惯条要的是习惯本体，视图接口只带 id/名字/颜色，所以按 id 去当月视图里取一次。 */
async function openHabitDetail(h: CalendarHabit, day: string, set: (x: Habit | null) => void) {
  try {
    const v = await api.HabitMonthView(day, day.slice(0, 7));
    const row = Object.values(v.rowsByContext).flat().find((r) => r.habit.id === h.habitId);
    if (row) set(row.habit);
  } catch (e) { toastErr(e); }
}

/** 格子的抬头：日号圆点 + 农历/节气/节日。 */
function MonthGrid({ days, byDay, lunar, today, cfg, nav, onBar, onHabit, onCell }: {
  days: string[];
  byDay: Map<string, CalendarDay>;
  lunar: Record<string, LunarCell>;
  today: string;
  cfg: ViewConfig;
  nav: { lists: PlList[]; categories: Category[]; labels: Label[] };
  onBar: (o: Occurrence) => void;
  onHabit: (h: CalendarHabit, day: string) => void;
  onCell: (day: string, rect: DOMRect) => void;
}) {
  const rows: string[][] = [];
  for (let i = 0; i < days.length; i += 7) rows.push(days.slice(i, i + 7));

  return (
    <div className="vm">
      <div className="vm-week">{WEEK_LABELS.map((w) => <div key={w}>{w}</div>)}</div>
      <div className="vm-rows">
        {rows.map((row, ri) => {
          const { lanes } = packLanes(rowBars(row, byDay, cfg, nav), MONTH_LANES);
          const counts = hiddenCounts(row, lanes, byDay, cfg);
          return (
            <div key={ri} className="vm-row" style={{ gridTemplateColumns: `repeat(${row.length}, 1fr)` }}>
              <div className="vm-titles">
                {row.map((d, i) => (
                  <button key={d} className={"vm-title" + (d === today ? " is-today" : "") + (d.slice(0, 7) === row[3]?.slice(0, 7) ? "" : " is-dim")}
                    onClick={(e) => onCell(d, (e.currentTarget as HTMLElement).getBoundingClientRect())}
                    aria-label={`${d} 当天安排`}>
                    <span className="vm-num">{d === today ? "今" : Number(d.slice(8, 10))}</span>
                    <span className="vm-vice">{lunar[d]?.festival || lunar[d]?.term || lunar[d]?.lunar || ""}</span>
                    {/* 「还有 N 个任务」跟在抬头这一行，与参考站的格子一致 */}
                    {counts[i] > 0 && <span className="vm-more">还有{counts[i]}个任务</span>}
                  </button>
                ))}
              </div>
              <div className="vm-lanes">
                {lanes.map((lane, li) => (
                  <div key={li} className="vm-lane" style={{ gridTemplateColumns: `repeat(${row.length}, 1fr)` }}>
                    {lane.map((b) => <GridBar key={b.key} bar={b} onBar={onBar} onHabit={onHabit} />)}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GridBar({ bar, onBar, onHabit }: { bar: Bar; onBar: (o: Occurrence) => void; onHabit: (h: CalendarHabit, day: string) => void }) {
  const span = bar.end - bar.start + 1;
  return (
    <button className={"vbar" + (bar.dim ? " is-dim" : "")}
      style={{ gridColumn: `${bar.start + 1} / ${bar.end + 2}`, width: undefined, background: bar.color, opacity: bar.dim ? CLOCKED_OPACITY : 1 }}
      title={bar.text}
      onClick={(e) => {
        e.stopPropagation();
        if (bar.occ) onBar(bar.occ);
        else if (bar.habit) onHabit(bar.habit, bar.day);
      }}>
      {bar.occ && isClocked(bar.occ) && <i className={"vbar-clock" + (bar.occ.status === 3 ? " is-fail" : " is-ok")} />}
      <span className="vbar-text">{bar.text}</span>
      {span > 1 && <span className="vbar-span" />}
    </button>
  );
}

/** 周 / 日视图：表头 + 全天区 + 24 行小时网格（块用 absolute 定位）。 */
function TimeGrid({ kind, days, byDay, lunar, today, cfg, nav, scrollRef, onBar, onHabit, onCell }: {
  kind: "day" | "week";
  days: string[];
  byDay: Map<string, CalendarDay>;
  lunar: Record<string, LunarCell>;
  today: string;
  cfg: ViewConfig;
  nav: { lists: PlList[]; categories: Category[]; labels: Label[] };
  scrollRef: React.MutableRefObject<HTMLDivElement | null>;
  onBar: (o: Occurrence) => void;
  onHabit: (h: CalendarHabit, day: string) => void;
  onCell: (day: string, rect: DOMRect) => void;
}) {
  const [up, setUp] = useState(-1);      // 折叠下界：<= up 的小时收起来
  const [down, setDown] = useState(24);  // 折叠上界：>= down 的小时收起来
  const [hover, setHover] = useState(-1);
  const n = days.length;

  const allDay = useMemo(() => packLanes(rowBars(days, byDay, cfg, nav, true), 1), [days, byDay, cfg, nav]);
  const allDayCounts = useMemo(() => hiddenCounts(days, allDay.lanes, byDay, cfg, true), [days, allDay, byDay, cfg]);

  /** 每列的链：只收有时刻的事项；全天与跨天走上面的全天区。 */
  const columns = useMemo(() => days.map((d) => buildChains(byDay.get(d), up, down, cfg, kind === "day" ? 16 : 7)), [days, byDay, up, down, kind, cfg]);

  const hours: number[] = [];
  for (let h = 0; h < 24; h++) {
    if (up > -1 && h <= up) continue;
    if (down < 24 && h >= down) continue;
    hours.push(h);
  }
  /** 折叠安全带：中间 4 小时（10~13）不给折叠，参考站就是这样，否则一屏挤成一条线。 */
  const foldAllow = (h: number) => (h <= 9 || h >= 14);

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const showLine = days.includes(today);

  return (
    <div className="vw" style={{ "--cols": n } as React.CSSProperties}>
      <div className="vw-head">
        <div className="vw-corner" />
        {days.map((d) => (
          <button key={d} className={"vw-day" + (d === today ? " is-today" : "")}
            onClick={(e) => onCell(d, (e.currentTarget as HTMLElement).getBoundingClientRect())}>
            <span className="vw-wk">{WEEK_LABELS[weekdayMon(d) - 1]}</span>
            <span className="vw-num">{d === today ? "今" : Number(d.slice(8, 10))}</span>
            <span className="vw-vice">{lunar[d]?.festival || lunar[d]?.term || lunar[d]?.lunar || ""}</span>
          </button>
        ))}
      </div>

      <div className="vw-allday">
        <div className="vw-axis-label">全天</div>
        <div className="vw-allday-lanes">
          <div className="vw-lane">
            {allDay.lanes[0].map((b) => <GridBar key={b.key} bar={b} onBar={onBar} onHabit={onHabit} />)}
          </div>
          <div className="vw-lane vw-countlane">
            {days.map((d, i) => (allDayCounts[i] > 0 ? (
              <button key={d} className="vm-more" style={{ gridColumn: i + 1 }}
                onClick={(e) => onCell(d, (e.currentTarget as HTMLElement).getBoundingClientRect())}>还有{allDayCounts[i]}个任务</button>
            ) : null))}
          </div>
        </div>
      </div>

      <div className="vw-scroll" ref={scrollRef}>
        {/* 折叠行是整宽的（参考站 .row-up/down-fold-hour 就是小时网格的兄弟节点）：
            放进 .vw-hours 里会被右侧列层盖住按钮，还会把列层与小时行错开一截。 */}
        {up > -1 && (
          <div className="vw-fold">
            <div className="vw-fold-axis">00:00</div>
            <FoldList items={columns[0].up} />
            <button className="vw-fold-btn" onClick={() => setUp(-1)}>展开</button>
          </div>
        )}
        <div className="vw-grid">
          <div className="vw-hours">
            {hours.map((h) => (
              <div key={h} className="vw-hour" onMouseEnter={() => setHover(h)} onMouseLeave={() => setHover(-1)}>
                <span className="vw-hour-text">{String(h).padStart(2, "0")}:00</span>
                {foldAllow(h) && hover === h && (
                  <span className="vw-fold-switch">
                    <button aria-label={`折叠到 ${h} 点之前`} onClick={() => setUp(h - 1)}><I n="chevronUp" size={9} /></button>
                    <button aria-label={`折叠 ${h} 点之后`} onClick={() => setDown(h + 1)}><I n="chevronDown" size={9} /></button>
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="vw-cols">
            {days.map((d, ci) => {
              const col = columns[ci];
              return (
                <div key={d} className={"vw-col" + (d === today ? " is-today" : "")}
                  style={{ left: `${(ci * 100) / n}%`, width: `${100 / n}%` }}>
                  {col.chains.map((chain, chi) => chain.map((b) => (
                    <TimeBar key={b.occ.item.id + "@" + b.occ.day + chi} block={b} chains={col.chains} ci={chi} cfg={cfg} nav={nav} onBar={onBar} />
                  )))}
                  {col.overflow > 0 && (
                    <button className="vw-more" style={{ top: "calc(var(--hour-h) * 23)" }}
                      onClick={(e) => onCell(d, (e.currentTarget as HTMLElement).getBoundingClientRect())}>+{col.overflow}</button>
                  )}
                  {showLine && d === today && (
                    <div className="vw-line is-now" style={{ top: `calc(var(--hour-h) * ${nowMin} / 60)` }}>
                      <span className="vw-dot" /><span className="vw-now">{String(now.getHours()).padStart(2, "0")}:{String(now.getMinutes()).padStart(2, "0")}</span>
                    </div>
                  )}
                  {showLine && d !== today && (
                    <div className="vw-line" style={{ top: `calc(var(--hour-h) * ${nowMin} / 60)` }} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {down < 24 && (
          <div className="vw-fold">
            <div className="vw-fold-axis">{String(Math.min(down, 23)).padStart(2, "0")}:00</div>
            <FoldList items={columns[0].down} />
            <button className="vw-fold-btn" onClick={() => setDown(24)}>展开</button>
          </div>
        )}
      </div>
    </div>
  );
}

type Block = { occ: Occurrence; start: number; end: number };

/** 一列里的链：按开始时间贪心装链；超出参考站的上限（周 7 / 日 16）折成 +N。 */
function buildChains(cell: CalendarDay | undefined, up: number, down: number, cfg: ViewConfig, maxChains = 7) {
  const timed: Block[] = [];
  const upMin = (up + 1) * 60;
  const downMin = down * 60;
  const upFold: { text: string; time: string }[] = [];
  const downFold: { text: string; time: string }[] = [];
  for (const o of cell?.items ?? []) {
    if (o.item.time.kind === 0) continue; // 全天走全天区
    if (!showMatter(o, cfg)) continue;
    const s = minutesOf(o.item.time.start);
    if (s < 0) continue;
    const e = Math.max(o.item.time.kind === 2 ? minutesOf(o.item.time.end) : s, s);
    if (up > -1 && e < upMin) { upFold.push({ text: o.item.title, time: hhmm(s) + (o.item.time.kind === 2 ? "-" + hhmm(e) : "") }); continue; }
    if (down < 24 && s > downMin) { downFold.push({ text: o.item.title, time: hhmm(s) + (o.item.time.kind === 2 ? "-" + hhmm(e) : "") }); continue; }
    timed.push({ occ: o, start: s, end: e });
  }
  timed.sort((a, b) => a.start - b.start || b.end - a.end);
  const chains: Block[][] = [];
  const rest = timed.slice();
  while (rest.length && chains.length < maxChains) {
    const chain: Block[] = [];
    let cursor = -1;
    for (let i = 0; i < rest.length;) {
      const b = rest[i];
      if (b.start < cursor) { i++; continue; }
      chain.push(b);
      rest.splice(i, 1);
      cursor = b.end;
    }
    chains.push(chain);
  }
  return { chains, overflow: rest.length, up: upFold, down: downFold };
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

function TimeBar({ block, chains, ci, cfg, nav, onBar }: {
  block: Block;
  chains: Block[][];
  ci: number;
  cfg: ViewConfig;
  nav: { lists: PlList[]; categories: Category[] };
  onBar: (o: Occurrence) => void;
}) {
  const { start, end, occ } = block;
  const dur = Math.max(end - start, 0);
  const color = matterColor(occ.item, cfg, nav.lists, nav.categories);
  // freeWidth：往右数到第一个真正时间碰撞的链为止，中间空链都借来加宽（参考站 getFreeWidth）。
  let free = 1;
  for (let c = ci + 1; c < chains.length; c++) {
    if (chains[c].some((x) => start < x.end && end > x.start)) break;
    free++;
  }
  const cols = chains.length;
  return (
    <button className={"vw-bar" + (isClocked(occ) ? " is-dim" : "")}
      style={{
        top: `calc(var(--hour-h) * ${start} / 60)`,
        height: `max(26px, calc(var(--hour-h) * ${dur} / 60))`,
        left: `calc(${(ci * 100) / cols}% + 2px)`,
        width: `calc(${(free * 100) / cols}% - 4px)`,
        background: color,
        borderLeftColor: color,
      }}
      title={`${hhmm(start)} ${occ.item.title}`}
      onClick={(e) => { e.stopPropagation(); onBar(occ); }}>
      <span className="vw-bar-time">{hhmm(start)}</span>
      <span className="vw-bar-text">{occ.item.title}</span>
    </button>
  );
}

function FoldList({ items }: { items: { text: string; time: string }[] }) {
  return (
    <div className="vw-fold-list">
      {items.slice(0, 3).map((f, i) => <span key={i} className="vw-fold-text">{f.time} {f.text}</span>)}
      {items.length > 3 && <span className="vw-fold-more">+{items.length - 3}</span>}
    </div>
  );
}

/** 点格子弹出的「这一天」清单：参考站的 DayMattersModule。 */
function DayPop({ cell, day, anchor, cfg, nav, onClose, onBar, onHabit, onCreate }: {
  cell: CalendarDay | null;
  day: string;
  anchor: DOMRect;
  cfg: ViewConfig;
  nav: { lists: PlList[]; categories: Category[]; labels: Label[] };
  onClose: () => void;
  onBar: (o: Occurrence) => void;
  onHabit: (h: CalendarHabit) => void;
  onCreate: () => void;
}) {
  const items = cell?.items ?? [];
  const habits = cell?.habits ?? [];
  return (
    <Popover anchor={anchor} width={230} onClose={onClose}>
      <div className="vp">
        <div className="vp-head">
          <b>{formatDayCN(day)}</b>
          <span className="vp-sub">{weekdayCN(day)}</span>
        </div>
        {items.length === 0 && habits.length === 0 && <p className="vp-empty">这天没有安排。</p>}
        <ul className="vp-list">
          {items.map((o) => (
            <li key={o.item.id}>
              <button className="vp-row" onClick={() => onBar(o)}>
                <i className={"vp-check" + (o.status === 1 ? " is-ok" : o.status === 3 ? " is-fail" : "")}
                  style={{ borderColor: matterColor(o.item, cfg, nav.lists, nav.categories) }} />
                <span className="vp-text">{o.item.title}</span>
                {o.item.time.start && <span className="vp-time">{o.item.time.start}</span>}
              </button>
            </li>
          ))}
          {habits.map((h) => (
            <li key={"h" + h.habitId}>
              <button className="vp-row" onClick={() => onHabit(h)}>
                <i className={"vp-habit" + (h.state === "done" ? " is-ok" : "")} style={{ background: habitColor(h, cfg) }} />
                <span className="vp-text">{h.name}</span>
                <span className="vp-time">{h.state === "done" ? "已完成" : h.state === "partial" ? `${h.amount}/${h.target}` : "未打卡"}</span>
              </button>
            </li>
          ))}
        </ul>
        <button className="vp-add" onClick={onCreate}><I n="plus" size={11} />在这天新建</button>
      </div>
    </Popover>
  );
}

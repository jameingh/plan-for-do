// ItemPanels.tsx —— 事项弹窗的六个子面板，结构照抄参考站（docs/design-reference.md §12.2）。
//
// 每个面板的「提交方式」也和参考站一一对应，这不是洁癖：
//   日期 / 时间 / 提醒 / 标签 = 面板里有 取消·保存（日期另有清除），选完要按下去才生效；
//   重复 / 结束 / 分类 / 优先级 = 点一下就生效。
// 之前我们把所有字段都做成即时保存，用户点错一个「每天」就得再改回来——
// 参考站恰恰在这几个最容易改错的面板上留了反悔的余地。2026-11-07 二次取证把时间也归到前者
// （参考站的 .body-time 底部确实有 清除/取消/保存，模板里挂的是 submitTime()）。

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { DateSpec, Day, EndSpec, Label, LunarCell, Reminder, Repeat, TimeSpec } from "../api/types";
import { format, monthGrid, shiftMonth, todayLocal, weekdayCN } from "../lib/day";
import { I } from "./ui";

/** 浮层容器：锚在触发元素下方，点外面或 Esc 关闭，越界翻转。 */
export function Popover({ anchor, width, onClose, children }: {
  anchor: DOMRect;
  width: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = anchor.left;
    if (left + r.width > window.innerWidth - 8) left = Math.max(8, anchor.right - r.width);
    let top = anchor.bottom + 4;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, anchor.top - r.height - 4);
    setPos({ left, top });
  }, [anchor, children]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    // 捕获阶段拦下 Esc：不能让外层弹窗先把它吃掉，否则面板还开着、弹窗先关了
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <>
      <div className="pop-curtain" onMouseDown={onClose} />
      <div ref={ref} className="pop-panel" style={{ left: pos.left, top: pos.top, width }} role="dialog" onMouseDown={(e) => e.stopPropagation()}>
        {children}
      </div>
    </>
  );
}

/**
 * 面板底部按钮。参考站的排布是：「清除」贴左，「取消」和「保存」贴右且保存最右
 * （.button-submit 与 .button-close 都 float:right，DOM 里保存写在前面，视觉上反而是 取消·保存）。
 * 所以这里按 kind 重排，调用方传的数组顺序不用操心左右。
 */
function PanelButtons({ items }: { items: { label: string; kind?: "ok" | "close" | "clear"; onClick: () => void }[] }) {
  const clear = items.filter((b) => b.kind === "clear");
  const ok = items.filter((b) => b.kind === "ok");
  const rest = items.filter((b) => b.kind !== "ok" && b.kind !== "clear");
  return (
    <div className="pop-buttons">
      {[...clear, ...rest, ...ok].map((b) => (
        <button key={b.label} className={"pop-btn" + (b.kind === "ok" ? " is-ok" : b.kind === "clear" ? " is-clear" : "")} onClick={b.onClick}>
          {b.label}
        </button>
      ))}
    </div>
  );
}

const WEEK_HEADS = ["一", "二", "三", "四", "五", "六", "日"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 日期面板：单日 / 跨天 / 自选多日 + 月历（公历 + 农历/节日）+ 清除·取消·保存。
 * 格子 29×29、周一起排、5 行；农历位优先显示节日，和参考站一样。
 *
 * variant="end" 是给「结束日期」用的：参考站那个面板（.body-repeat-end-date）没有模式切换、
 * 也没有清除，只有月历和取消/保存。
 */
export function DatePanel({ value, onCommit, onClose, variant = "full" }: {
  value: DateSpec;
  onCommit: (d: DateSpec) => void;
  onClose: () => void;
  /** full = 事项用（有模式切换、有清除）；end = 「结束日期」用（没模式也没清除）；
   *  day = 专注「关联任务」用：只要单日，但保留「清除」= 回到全部待办。 */
  variant?: "full" | "end" | "day";
}) {
  const noModes = variant !== "full";
  const showClear = variant !== "end";
  const start = value.start || todayLocal();
  const [month, setMonth] = useState(() => start.slice(0, 7));
  const [kind, setKind] = useState<number>(noModes ? 1 : (value.kind || 1));
  const [draftStart, setDraftStart] = useState<Day>(value.start || "");
  const [draftEnd, setDraftEnd] = useState<Day>(value.end || "");
  const [draftSel, setDraftSel] = useState<Day[]>(value.selected ?? []);
  const [lunar, setLunar] = useState<Record<string, LunarCell>>({});
  const today = todayLocal();

  const days = useMemo(() => monthGrid(month), [month]);

  useEffect(() => {
    let dead = false;
    // 农历由内核算（它有自己的查表实现），一次要整月，别一格一调
    api.LunarLabels(days).then((cells) => {
      if (dead) return;
      const map: Record<string, LunarCell> = {};
      for (const c of cells) map[c.day] = c;
      setLunar(map);
    }).catch(() => setLunar({}));
    return () => { dead = true; };
  }, [days]);

  function pick(day: Day) {
    if (kind === 1) { setDraftStart(day); setDraftEnd(""); return; }
    if (kind === 3) { setDraftSel(draftSel.includes(day) ? draftSel.filter((x) => x !== day) : [...draftSel, day].sort()); return; }
    if (!draftStart || draftEnd) { setDraftStart(day); setDraftEnd(""); return; }
    if (day < draftStart) { setDraftEnd(draftStart); setDraftStart(day); } else setDraftEnd(day);
  }

  function submit() {
    if (kind === 1) onCommit({ kind: 1, start: draftStart || today });
    else if (kind === 2) onCommit({ kind: 2, start: draftStart || today, end: draftEnd || draftStart || today });
    else {
      const sel = draftSel.length ? draftSel : [draftStart || today];
      onCommit({ kind: 3, start: sel[0], selected: sel });
    }
  }

  return (
    <>
      <div className="cal-head">
        <button className="cal-arrow" aria-label="上个月" onClick={() => setMonth(shiftMonth(month, -1))}><I n="chevronLeft" size={12} /></button>
        <span className="cal-title">{month.replace("-", "年")}月</span>
        <button className="cal-today" aria-label="回到本月" onClick={() => setMonth(today.slice(0, 7))}>今</button>
        <button className="cal-arrow" aria-label="下个月" onClick={() => setMonth(shiftMonth(month, 1))}><I n="chevronRight" size={12} /></button>
      </div>
      {!noModes && (
        <div className="cal-modes">
          {[{ k: 1, t: "单日" }, { k: 2, t: "跨天" }, { k: 3, t: "自选多日" }].map((o) => (
            <button key={o.k} className={"cal-mode" + (kind === o.k ? " is-sel" : "")} onClick={() => setKind(o.k)}>{o.t}</button>
          ))}
        </div>
      )}
      <div className="cal-weeks">{WEEK_HEADS.map((w) => <span key={w}>{w}</span>)}</div>
      <div className="cal-days">
        {days.map((d) => {
          const cell = lunar[d];
          const inMonth = d.slice(0, 7) === month;
          const inRange = kind === 3 ? draftSel.includes(d) : !!draftStart && d === draftStart || (!!draftEnd && d >= draftStart && d <= draftEnd);
          return (
            <button key={d}
              className={"cal-day" + (inMonth ? " is-same" : "") + (inRange ? " is-click" : "") + (d === today ? " is-today" : "")}
              title={[cell?.festival, cell?.lunar && "农历" + cell.lunar].filter(Boolean).join(" · ") || format(d)}
              onClick={() => pick(d)}>
              <span className="cal-num">{Number(d.slice(8))}</span>
              <span className="cal-lunar">{cell?.festival || cell?.lunar || ""}</span>
            </button>
          );
        })}
      </div>
      <PanelButtons items={[
        // 「清除」= 无日期：内核用「起始日为空且没自选」判定无日期，kind 仍给单日。
        // 三键文案照抄参考站：清除 / 取消 / 保存。
        ...(showClear ? [{ label: "清除", kind: "clear" as const, onClick: () => onCommit({ kind: 1, start: "" }) }] : []),
        { label: "取消", onClick: onClose },
        { label: "保存", kind: "ok", onClick: submit },
      ]} />
    </>
  );
}

/**
 * 时间面板：时间点 / 时间段 + 时分滚轮 + 清除·取消·保存。
 *
 * 之前这里做成了「滚一下就写库」，是照着旧笔记抄的；2026-11-07 重新取证，参考站的新建和详情
 * 两个面板底部都有 清除/取消/保存（模板里就是 `submitTime()`），滚轮只改本地草稿。
 * 「全天」也不是一个按钮——它就是「清除」，把时间抹掉。
 */
export function TimePanel({ value, onCommit, onClose }: {
  value: TimeSpec;
  onCommit: (t: TimeSpec) => void;
  onClose: () => void;
}) {
  // 参考站 `TimeModule.mounted`：timeType=0/3（没设时间或全天）时滚轮默认落在**当前时间**，并按「时间点」起步
  const now = new Date();
  const fallback = { h: now.getHours(), m: now.getMinutes() };
  const split = (s: string | undefined, d: { h: number; m: number }) => {
    // 空值必须整个退回默认："" .split(":") → [""] → Number 又是 0，之前默认小时就是被这样吃成了 00
    if (!s) return d;
    const [h, m] = s.split(":").map(Number);
    return Number.isFinite(h) ? { h, m: Number.isFinite(m) ? m : d.m } : d;
  };
  const [kind, setKind] = useState<number>(value.kind === 2 ? 2 : 1);
  const [start, setStart] = useState(() => split(value.start, fallback));
  const [stop, setStop] = useState(() => split(value.end, { h: (fallback.h + 1) % 24, m: fallback.m }));

  const at = (x: { h: number; m: number }) => pad2(x.h) + ":" + pad2(x.m);

  function submit() {
    // 参考站 `submitTime`：时间段起止相同就当成时间点，不留零长度区间
    if (kind === 2 && at(start) === at(stop)) onCommit({ kind: 1, start: at(start) });
    else if (kind === 2) onCommit({ kind: 2, start: at(start), end: at(stop) });
    else onCommit({ kind: 1, start: at(start) });
  }

  return (
    <>
      <div className="time-modes">
        <button className={"time-mode" + (kind === 1 ? " is-sel" : "")} onClick={() => setKind(1)}>时间点</button>
        <button className={"time-mode" + (kind === 2 ? " is-sel" : "")} onClick={() => setKind(2)}>时间段</button>
      </div>
      <div className="time-cols">
        <Wheel cap="时" n={24} value={start.h} onChange={(h) => setStart({ ...start, h })} />
        <Wheel cap="分" n={60} value={start.m} onChange={(m) => setStart({ ...start, m })} />
        {kind === 2 && <Wheel cap="时" n={24} value={stop.h} onChange={(h) => setStop({ ...stop, h })} />}
        {kind === 2 && <Wheel cap="分" n={60} value={stop.m} onChange={(m) => setStop({ ...stop, m })} />}
      </div>
      <PanelButtons items={[
        { label: "清除", kind: "clear", onClick: () => onCommit({ kind: 0 }) },
        { label: "取消", onClick: onClose },
        { label: "保存", kind: "ok", onClick: submit },
      ]} />
    </>
  );
}

/** 一列滚轮：中间高亮项是当前值；点任意项即选中（参考站是滚动式，这里点选等效且键盘可用）。 */
function Wheel({ cap, n, value, onChange }: { cap: string; n: number; value: number; onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector(".whe-item.is-sel")?.scrollIntoView({ block: "center" });
  }, [value]);
  return (
    <div className="wheel">
      <span className="wheel-cap">{cap}</span>
      <div className="wheel-list" ref={ref}>
        {Array.from({ length: n }, (_, i) => (
          <button key={i} className={"whe-item" + (i === value ? " is-sel" : "")} onClick={() => onChange(i)}>{pad2(i)}</button>
        ))}
      </div>
    </div>
  );
}

type Preset = { label: string; days: number; atTime: string };
/**
 * 预设就是参考站的 currentItems 前四项（remindType=1，偏移量+固定时刻）：
 * 当天(09:00) / 当天(10:00) / 提前1天(09:00) / 提前7天(09:00)，可多选。
 */
const REMIND_PRESETS: Preset[] = [
  { label: "当天(09:00)", days: 0, atTime: "09:00" },
  { label: "当天(10:00)", days: 0, atTime: "10:00" },
  { label: "提前1天(09:00)", days: 1, atTime: "09:00" },
  { label: "提前7天(09:00)", days: 7, atTime: "09:00" },
];
/** 参考站免费 2 条、会员 5 条；我们没有付费墙，直接按它的硬上限 5 条。 */
const MAX_REMINDERS = 5;

const isAbsolute = (r: Reminder) => !!r.atDay;
/** 同一判定用同一份数据：绝对型比日期+时刻，偏移型比提前天数+固定时刻。 */
const sameTime = (a: Reminder, b: Reminder) =>
  (isAbsolute(a) || isAbsolute(b))
    ? (a.atDay ?? "") === (b.atDay ?? "") && (a.atTime ?? "") === (b.atTime ?? "")
    : a.offset.days === b.offset.days && (a.atTime ?? "") === (b.atTime ?? "");

/** 「11月07日 09:30」——参考站 remindType=2 的列表/芯片文案（saveTime 里月日都 addZero）。 */
function absoluteLabel(r: Reminder): string {
  const d = r.atDay ?? "";
  if (d.length < 10) return `${r.atTime ?? ""}`;
  return `${d.slice(5, 7)}月${d.slice(8, 10)}日 ${r.atTime ?? "00:00"}`;
}

/** 该年每一天的 Day 串，给「月日」滚轮用（参考站的 dates 就是全年列表）。 */
function yearDays(): Day[] {
  const y = new Date().getFullYear();
  const out: Day[] = [];
  const d = new Date(y, 0, 1);
  while (d.getFullYear() === y) {
    out.push(`${y}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * 提醒面板：可多选的预设 + 「自定义提醒时间」滚轮 + 保存·取消。
 *
 * 之前这里做错了两件事（2026-11-07 对着参考站重新取证）：
 *   1. 自定义是「提前 N 天 M 时 K 分」三个数字框——参考站不是，它是一列 **月日滚轮 + 时 + 分**
 *      （`.body-custom-time`，`getMyData(2)` 给的是全年日期），存成 remindType=2 的绝对时刻；
 *   2. 只能留一条提醒，且加完自定义没有任何勾选反馈，看着就像「点了没生效」。
 * 参考站的列表本来就是多选：无提醒 = 清空，预设与自定义条目各自带 state，上限 5 条。
 *
 * hasDate=false 时预设整列收起：四条预设都是相对事项日期算的，没日期无从相对（实测确认）。
 * 滚轮子视图比列表宽一档（参考站 `.body-custom-time` 3.08rem vs `.body-remind` 2.42rem），
 * 所以通过 onWidth 把浮层宽度交给外面重排。
 */
export function RemindPanel({ value, hasDate, onCommit, onClose, onWidth }: {
  value: Reminder[];
  hasDate: boolean;
  onCommit: (r: Reminder[]) => void;
  onClose: () => void;
  onWidth?: (w: number) => void;
}) {
  const [draft, setDraft] = useState<Reminder[]>(value);
  const [customs, setCustoms] = useState<Reminder[]>(value.filter(isAbsolute));
  const [wheel, setWheel] = useState(false);
  const days = useMemo(yearDays, []);
  const today = todayLocal();
  const [pick, setPick] = useState(() => {
    // 参考站 `CustomDate.mounted`：默认停在今天 + **当前时分**（不是硬编码 09:00）
    const first = value.find(isAbsolute);
    const now = new Date();
    return {
      day: first?.atDay || today,
      hour: first?.atTime?.slice(0, 2) || pad2(now.getHours()),
      minute: first?.atTime?.slice(3, 5) || pad2(now.getMinutes()),
    };
  });

  // 参考站的滚轮子视图是独立浮层（3.08rem），比列表（2.42rem）宽 27%，这里按同比例放大
  useEffect(() => { onWidth?.(wheel ? 276 : 216); }, [wheel]);

  const selPreset = (p: Preset) => draft.some((r) => !isAbsolute(r) && r.offset.days === p.days && (r.atTime ?? "") === p.atTime && !r.offset.hours && !r.offset.minutes);
  const selCustom = (r: Reminder) => draft.some((x) => isAbsolute(x) && sameTime(x, r));

  function togglePreset(p: Preset) {
    const hit = draft.find((r) => !isAbsolute(r) && r.offset.days === p.days && (r.atTime ?? "") === p.atTime);
    if (hit) { setDraft(draft.filter((r) => r !== hit)); return; }
    if (draft.length >= MAX_REMINDERS) return;
    setDraft([...draft, { id: "", offset: { days: p.days, hours: 0, minutes: 0 }, atTime: p.atTime }]);
  }

  function toggleCustom(c: Reminder) {
    const hit = draft.find((r) => isAbsolute(r) && sameTime(r, c));
    if (hit) { setDraft(draft.filter((r) => r !== hit)); return; }
    if (draft.length >= MAX_REMINDERS) return;
    setDraft([...draft, c]);
  }

  function addCustom() {
    const r: Reminder = { id: "", offset: { days: 0, hours: 0, minutes: 0 }, atDay: pick.day, atTime: `${pick.hour}:${pick.minute}` };
    if (!customs.some((x) => sameTime(x, r))) setCustoms([...customs, r]);
    if (!draft.some((x) => isAbsolute(x) && sameTime(x, r)) && draft.length < MAX_REMINDERS) setDraft([...draft, r]);
    setWheel(false);
  }

  if (wheel) {
    return (
      <div className="remind-wheel-box">
        <div className="rw-title">自定义提醒时间</div>
        <div className="rw-cols">
          <WheelCol items={days.map((d) => ({ v: d, t: `${Number(d.slice(5, 7))}月${Number(d.slice(8, 10))}日${weekdayCN(d)}` }))} value={pick.day} onChange={(v) => setPick({ ...pick, day: v })} />
          <WheelCol items={Array.from({ length: 24 }, (_, i) => ({ v: pad2(i), t: pad2(i) }))} value={pick.hour} onChange={(v) => setPick({ ...pick, hour: v })} />
          <span className="rw-colon">:</span>
          <WheelCol items={Array.from({ length: 60 }, (_, i) => ({ v: pad2(i), t: pad2(i) }))} value={pick.minute} onChange={(v) => setPick({ ...pick, minute: v })} />
        </div>
        <PanelButtons items={[{ label: "取消", onClick: () => setWheel(false) }, { label: "保存", kind: "ok", onClick: addCustom }]} />
      </div>
    );
  }

  return (
    <>
      <button className="remind-custom" onClick={() => {
        if (draft.length >= MAX_REMINDERS) return;
        setWheel(true);
      }}>
        <span>自定义提醒时间</span><I n="chevronRight" size={12} />
      </button>
      <ul className="pick-list">
        <li><button className={"pick-item" + (draft.length === 0 ? " is-sel" : "")} onClick={() => setDraft([])}>
          <span>无提醒</span>{draft.length === 0 && <I n="check" size={12} />}
        </button></li>
        {hasDate && REMIND_PRESETS.map((p) => (
          <li key={p.label}>
            <button className={"pick-item" + (selPreset(p) ? " is-sel" : "")} onClick={() => togglePreset(p)}>
              <span>{p.label}</span>{selPreset(p) && <I n="check" size={12} />}
            </button>
          </li>
        ))}
        {customs.map((c) => (
          <li key={absoluteLabel(c)} className="remind-own">
            <button className={"pick-item" + (selCustom(c) ? " is-sel" : "")} onClick={() => toggleCustom(c)}>
              <span>{absoluteLabel(c)}</span>{selCustom(c) && <I n="check" size={12} />}
            </button>
            <button className="remind-own-del" aria-label={`删除这条提醒 ${absoluteLabel(c)}`}
              onClick={() => { setCustoms(customs.filter((x) => x !== c)); setDraft(draft.filter((r) => !(isAbsolute(r) && sameTime(r, c)))); }}>
              <I n="close" size={10} />
            </button>
          </li>
        ))}
      </ul>
      {draft.length >= MAX_REMINDERS && <p className="pop-note">最多 {MAX_REMINDERS} 条提醒，先删一条再加。</p>}
      <p className="pop-note">事项没有时间点时，提醒按当天 09:00 起算。</p>
      <PanelButtons items={[{ label: "保存", kind: "ok", onClick: () => onCommit(draft) }, { label: "取消", onClick: onClose }]} />
    </>
  );
}

/** 一列滚动选择：中间高亮即当前值，打开时滚到当前值（和参考站的滚轮形态一致）。 */
function WheelCol({ items, value, onChange }: { items: { v: string; t: string }[]; value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector(".rw-item.is-sel")?.scrollIntoView({ block: "center" });
  }, [value]);
  return (
    <div className="rw-col">
      <div className="rw-list" ref={ref}>
        {items.map((it) => (
          <button key={it.v} className={"rw-item" + (it.v === value ? " is-sel" : "")} onClick={() => onChange(it.v)}>{it.t}</button>
        ))}
      </div>
    </div>
  );
}

/** 由事项自己的日期推导预设：每周(周四)、每月(08日)、每年(10月08日)——参考站就是这么显示的。 */
export function repeatPresets(date: DateSpec): { key: string; label: string; build: () => Repeat | null }[] {
  const d = date.start || todayLocal();
  const wd = weekdayCN(d);
  const wdn = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"].indexOf(wd) + 1 || 1;
  const dayNum = Number(d.slice(8));
  const mon = Number(d.slice(5, 7));
  const base = (over: Partial<Repeat>): Repeat => ({
    unit: 1, interval: 1, skipLegalHolidays: false, followMakeupWorkday: false, smartSpan: false, ebbinghaus: false, end: { mode: 0 }, ...over,
  });
  return [
    { key: "none", label: "仅一次", build: () => null },
    { key: "daily", label: "每天", build: () => base({ unit: 1, interval: 1 }) },
    { key: "workday5", label: "每周一至周五", build: () => base({ unit: 2, interval: 1, weekdays: [1, 2, 3, 4, 5] }) },
    { key: "legal", label: "法定工作日(不包含法定节日、假日)", build: () => base({ unit: 2, interval: 1, weekdays: [1, 2, 3, 4, 5], skipLegalHolidays: true, followMakeupWorkday: true }) },
    { key: "weekly", label: `每周(${wd})`, build: () => base({ unit: 2, interval: 1, weekdays: [Math.min(7, wdn === 8 ? 1 : wdn)] }) },
    { key: "monthly", label: `每月(${pad2(dayNum)}日)`, build: () => base({ unit: 3, interval: 1, monthDays: [dayNum] }) },
    { key: "yearly", label: `每年(${pad2(mon)}月${pad2(dayNum)}日)`, build: () => base({ unit: 4, interval: 1, yearMonth: mon, yearDay: dayNum }) },
    { key: "ebbinghaus", label: "艾宾浩斯记忆法", build: () => base({ ebbinghaus: true }) },
  ];
}

/** 把当前规则认回某个预设；认不出就是「自定义重复」。 */
export function repeatKey(r: Repeat | null, date: DateSpec): string {
  if (!r) return "none";
  const hit = repeatPresets(date).find((p) => {
    const b = p.build();
    if (!b || !p.key) return false;
    return b.unit === r.unit && b.interval === r.interval && b.ebbinghaus === r.ebbinghaus
      && b.skipLegalHolidays === r.skipLegalHolidays && b.followMakeupWorkday === r.followMakeupWorkday
      && (b.weekdays ?? []).join() === (r.weekdays ?? []).join()
      && (b.monthDays ?? []).join() === (r.monthDays ?? []).join()
      && b.yearMonth === r.yearMonth && b.yearDay === r.yearDay;
  });
  return hit ? hit.key : "custom";
}

/** 重复面板：9 项预设（点一下即生效，面板随之关闭，参考站没有确定键）。 */
export function RepeatPanel({ value, date, onPick }: {
  value: Repeat | null;
  date: DateSpec;
  onPick: (r: Repeat | null) => void;
}) {
  const [custom, setCustom] = useState(false);
  const presets = useMemo(() => repeatPresets(date), [date]);
  const key = repeatKey(value, date);

  if (custom) return <RepeatCustom value={value} date={date} onPick={(r) => { onPick(r); setCustom(false); }} onBack={() => setCustom(false)} />;

  return (
    <>
      <ul className="pick-list">
        {presets.map((p) => (
          <li key={p.key}><button className={"pick-item" + (key === p.key ? " is-sel" : "")} onClick={() => onPick(p.build())}>
            <span>{p.label}</span>{key === p.key && <I n="check" size={12} />}
          </button></li>
        ))}
        <li><button className={"pick-item" + (key === "custom" ? " is-sel" : "")} onClick={() => setCustom(true)}>
          <span>自定义重复</span>{key === "custom" && <I n="check" size={12} />}
        </button></li>
      </ul>
    </>
  );
}

/** 自定义重复：单位（天/周/月/年）+ 每 N + 星期多选 / 几号 + 跳过法定节假日。 */
function RepeatCustom({ value, date, onPick, onBack }: { value: Repeat | null; date: DateSpec; onPick: (r: Repeat) => void; onBack: () => void }) {
  const [unit, setUnit] = useState<number>(value?.unit ?? 1);
  const [interval, setInterval] = useState<number>(value?.interval || 1);
  const [weekdays, setWeekdays] = useState<number[]>(value?.weekdays ?? []);
  const [monthDay, setMonthDay] = useState<number>(value?.monthDays?.[0] ?? Number((date.start || todayLocal()).slice(8)));
  const [skip, setSkip] = useState<boolean>(!!value?.skipLegalHolidays);
  const [makeup, setMakeup] = useState<boolean>(!!value?.followMakeupWorkday);

  function submit() {
    onPick({
      unit: unit as 1 | 2 | 3 | 4,
      interval: Math.max(1, interval || 1),
      weekdays: unit === 2 ? (weekdays.length ? [...weekdays].sort() : [1]) : undefined,
      monthDays: unit === 3 ? [monthDay] : undefined,
      yearMonth: unit === 4 ? Number((date.start || todayLocal()).slice(5, 7)) : undefined,
      yearDay: unit === 4 ? monthDay : undefined,
      skipLegalHolidays: skip, followMakeupWorkday: makeup,
      smartSpan: !!value?.smartSpan, ebbinghaus: false,
      end: value?.end ?? { mode: 0 },
    });
  }

  return (
    <>
      <div className="rc-head">
        <span className="rc-title">自定义重复</span>
        <select className="select sm" value={unit} aria-label="重复单位" onChange={(e) => setUnit(Number(e.target.value))}>
          <option value={1}>天</option><option value={2}>周</option><option value={3}>月</option><option value={4}>年</option>
        </select>
        <span className="rc-every">每</span>
        <input className="input num" type="number" min={1} value={interval} aria-label="每几个单位" onChange={(e) => setInterval(Number(e.target.value))} />
      </div>
      {unit === 2 && (
        <div className="rc-weeks">
          {WEEK_HEADS.map((w, i) => (
            <button key={w} className={"rc-wd" + (weekdays.includes(i + 1) ? " is-sel" : "")}
              onClick={() => setWeekdays(weekdays.includes(i + 1) ? weekdays.filter((x) => x !== i + 1) : [...weekdays, i + 1])}>{w}</button>
          ))}
        </div>
      )}
      {unit === 3 && (
        <div className="rc-month">
          <span className="muted small">每月</span>
          <input className="input num" type="number" min={-1} max={31} value={monthDay} aria-label="每月几号" onChange={(e) => setMonthDay(Number(e.target.value))} />
          <span className="muted small">日</span>
          <button className="btn small" onClick={() => setMonthDay(-1)}>最后一天</button>
        </div>
      )}
      <label className="rc-check"><input className="check-native" type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> 智能跳过法定节假日</label>
      <label className="rc-check"><input className="check-native" type="checkbox" checked={makeup} onChange={(e) => setMakeup(e.target.checked)} /> 调休上班日照常</label>
      <PanelButtons items={[{ label: "返回", onClick: onBack }, { label: "确定", kind: "ok", onClick: submit }]} />
    </>
  );
}

/**
 * 结束面板。参考站不是一个平铺列表，而是三层（2026-11-07 新建弹窗实测）：
 *   永不 → 点一下即生效；
 *   按日期结束 → 打开一个没有「单日/跨天/自选」切换的月历，清除/取消/保存；
 *   按次数结束 → 打开「重复 N 次结束」，N 是 1..60 的滚动下拉，保存/取消。
 * 之前我们把日期输入框和次数输入框塞在列表里，看着像但按下去的反馈完全不同。
 */
export function EndPanel({ end, onPick, onClose, onWidth }: {
  end: EndSpec;
  onPick: (e: EndSpec) => void;
  onClose: () => void;
  /** 面板宽度跟着子视图变：列表 190、月历 258、次数 210，和参考站三档实测一致 */
  onWidth?: (w: number) => void;
}) {
  const [view, setView] = useState<"list" | "date" | "count">("list");
  useEffect(() => { onWidth?.(view === "list" ? 190 : view === "date" ? 258 : 210); }, [view]);

  if (view === "date") {
    return (
      <div className="end-date">
        <DatePanel value={{ kind: 1, start: end.date || todayLocal() }} variant="end"
          onCommit={(d) => { onPick(d.start ? { mode: 1, date: d.start } : { mode: 0 }); }} onClose={onClose} />
      </div>
    );
  }

  if (view === "count") return <EndCount count={end.count ?? 1} onSave={(n) => onPick({ mode: 2, count: n })} onClose={onClose} />;

  return (
    <ul className="pick-list">
      <li><button className={"pick-item" + (end.mode === 0 ? " is-sel" : "")} onClick={() => onPick({ mode: 0 })}><span>永不</span>{end.mode === 0 && <I n="check" size={12} />}</button></li>
      <li><button className={"pick-item" + (end.mode === 1 ? " is-sel" : "")} onClick={() => setView("date")}><span>按日期结束</span>{end.mode === 1 && <I n="check" size={12} />}</button></li>
      <li><button className={"pick-item" + (end.mode === 2 ? " is-sel" : "")} onClick={() => setView("count")}><span>按次数结束</span>{end.mode === 2 && <I n="check" size={12} />}</button></li>
    </ul>
  );
}

/** 「重复 N 次结束」：N 用 1..60 的滚动下拉，文案与参考站逐字一致。 */
function EndCount({ count, onSave, onClose }: { count: number; onSave: (n: number) => void; onClose: () => void }) {
  const [n, setN] = useState(Math.min(60, Math.max(1, count || 1)));
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="end-count-line">
        <span className="end-count-cap">重复</span>
        <button className="end-count-pick" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span>{n}</span><I n="chevronDown" size={10} />
        </button>
        <span className="end-count-cap">次结束</span>
      </div>
      {open && (
        <div className="end-count-list scrollbar">
          {Array.from({ length: 60 }, (_, i) => i + 1).map((i) => (
            <button key={i} className={"end-count-item" + (i === n ? " is-sel" : "")}
              onClick={() => { setN(i); setOpen(false); }}>{i}</button>
          ))}
        </div>
      )}
      <PanelButtons items={[{ label: "保存", kind: "ok", onClick: () => onSave(n) }, { label: "取消", onClick: onClose }]} />
    </>
  );
}

/** 标签面板：搜索/创建 + 已选 + 保存·取消（参考站上限 10 个）。 */
export function LabelPanel({ labelIds, labels, onCreate, onCommit, onClose }: {
  labelIds: string[];
  labels: Label[];
  onCreate: (name: string) => Promise<Label | null>;
  onCommit: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>(labelIds);
  const [created, setCreated] = useState<Label[]>([]);
  // 刚创建的标签会同时出现在「本地新建」和父组件重拉回来的列表里，按 id 去重，否则列表里出现两个同名项
  const pool = [...new Map([...labels, ...created].map((l) => [l.id, l])).values()];
  const shown = q.trim() ? pool.filter((l) => l.name.includes(q.trim())).slice(0, 12) : pool.slice(0, 12);

  function toggle(id: string) {
    if (sel.includes(id)) { setSel(sel.filter((x) => x !== id)); return; }
    if (sel.length >= 10) return;
    setSel([...sel, id]);
  }

  async function createNow() {
    const name = q.trim();
    if (!name) return;
    const hit = pool.find((l) => l.name === name);
    if (hit) { toggle(hit.id); setQ(""); return; }
    const l = await onCreate(name);
    if (!l) return;
    setCreated((c) => [...c, l]);
    toggle(l.id);
    setQ("");
  }

  return (
    <>
      <div className="label-search">
        <I n="search" size={12} />
        <input className="input plain" value={q} placeholder="搜索或创建标签" aria-label="搜索或创建标签"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void createNow()} />
        {q && <button className="icon-btn" aria-label="清空" onClick={() => setQ("")}><I n="close" size={11} /></button>}
      </div>
      {q.trim() && !pool.some((l) => l.name === q.trim()) && (
        // 参考站这行是「创建标签」主色 + 后面直接跟搜索词，不是引号包起来的
        <button className="label-create" onClick={() => void createNow()}><span className="label-create-kw">创建标签</span>{q.trim()}</button>
      )}
      <ul className="pick-list">
        {shown.map((l) => (
          <li key={l.id}><button className={"pick-item" + (sel.includes(l.id) ? " is-sel" : "")} onClick={() => toggle(l.id)}>
            <span>{l.name}</span>{sel.includes(l.id) && <I n="check" size={12} />}
          </button></li>
        ))}
        {!shown.length && <li className="muted small pad">还没有标签，输入名字回车创建。</li>}
      </ul>
      <p className="pop-note">最多选择 10 个标签，已选 {sel.length}。</p>
      <PanelButtons items={[{ label: "保存", kind: "ok", onClick: () => onCommit(sel) }, { label: "取消", onClick: onClose }]} />
    </>
  );
}

/**
 * 作用范围选择：重复事项改规则前必须先选它。
 *
 * 参考站是把它放在重复面板**内部**的，不另起一层弹窗——我们照做，
 * 否则面板（z-index 更高）会盖住范围选择，用户看到的是点没反应。
 */
export function ScopePanel({ label, onPick, onCancel }: {
  label: string;
  onPick: (s: "thisDay" | "thisAndFuture" | "all") => void;
  onCancel: () => void;
}) {
  return (
    <>
      <p className="scope-lead">「{label}」要作用在哪个范围？</p>
      <ul className="pick-list">
        <li><button className="pick-item" onClick={() => onPick("thisDay")}><span>仅当天清单</span></button></li>
        <li><button className="pick-item" onClick={() => onPick("thisAndFuture")}><span>当日及未来清单</span></button></li>
        <li><button className="pick-item" onClick={() => onPick("all")}><span>全部清单</span></button></li>
      </ul>
      <PanelButtons items={[{ label: "取消", onClick: onCancel }]} />
    </>
  );
}

/** 头部小菜单（分类 / 优先级 / 更多）用的列表。 */
export function MiniMenu({ items, onPick }: {
  items: { key: string; label: string; color?: string; roman?: string; selected?: boolean }[];
  onPick: (key: string) => void;
}) {
  return (
    <ul className="pick-list">
      {items.map((it) => (
        <li key={it.key}><button className={"pick-item" + (it.selected ? " is-sel" : "")} onClick={() => onPick(it.key)}>
          {it.roman
            // 优先级用参考站那套衬线序号（I/II/III/IV）打头，颜色就是优先级色
            ? <span className="quad-num mini-roman" style={{ color: it.color }}>{it.roman}</span>
            : it.color && <span className="mini-dot" style={{ background: it.color }} />}
          <span style={it.roman && it.color ? { color: it.color } : undefined}>{it.label}</span>
          {it.selected && <I n="check" size={12} />}
        </button></li>
      ))}
    </ul>
  );
}

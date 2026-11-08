// HabitCreate.tsx —— 新建/编辑习惯弹窗，逐项照抄参考站（docs/design-reference.md §14）。
//
// 参考站这里不是一页表单，也不是分步向导，而是「一张 281px 的卡 + 每行点开自己的模块」：
//   命名（右侧 30×30 图标，点开是覆盖整张卡的图标选择页：预览 / 分类页签 / 网格 / 颜色面板）
//   重复（固定·按周·按月·每隔几天 + 保存/取消）
//   目标（每天一次 / 每天多次，选多次就地展开 单位·每日总量·每次完成量·打卡方式）
//   情境（新增情境 + 全天/晨间/午间/晚间/自建）
//   提醒（时刻胶囊 + 加号，最多 2 条，点胶囊或加号开时分滚轮）
//   开始日期（不带模式切换的月历）
//   打卡心得弹窗（开关）
//   底部 取消 / 保存
// 每个模块都是「改的是草稿，按保存才回写这一行」，取消就整块丢弃——这是参考站最核心的交互，
// 之前我们做成两步向导 + 即时生效的下拉，点错了没法反悔。

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { Frequency, Habit, HabitContext, HabitIcon, HabitUnit, Reminder } from "../api/types";
import { todayLocal } from "../lib/day";
import { bumpRevision, toastErr } from "../store/appStore";
import { BUILTIN_ICONS, I, PALETTE, useEscClose } from "./ui";
import { DatePanel, Popover } from "./ItemPanels";
import { HabitGuide, type GuideDraft } from "./HabitGuide";

const WEEK_CN = ["一", "二", "三", "四", "五", "六", "日"];
const CTX_ALWAYS = "全天";
const MAX_REMINDERS = 2;

type ModuleKey = "" | "icon" | "repeat" | "target" | "classify" | "remind" | "date";

interface Draft {
  name: string;
  icon: HabitIcon;
  context: string;
  freq: Frequency;
  mode: 1 | 2;
  autoClock: boolean;
  unitId: string;
  dailyTarget: number;
  perClock: number;
  reminders: Reminder[];
  popMark: boolean;
  startDay: string;
  backfillDays: number;
}

function toDraft(h: Habit | null): Draft {
  if (!h) {
    return {
      name: "", icon: { kind: "image", ref: "sleep", color: "#fc6a7a" }, context: "",
      freq: { kind: 2, weekdays: [1, 2, 3, 4, 5, 6, 7] }, mode: 1, autoClock: false,
      unitId: "", dailyTarget: 1, perClock: 1, reminders: [], popMark: true,
      startDay: todayLocal(), backfillDays: 3,
    };
  }
  return {
    name: h.name, icon: h.icon, context: h.context, freq: { ...h.freq }, mode: h.mode, autoClock: h.autoClock,
    unitId: h.unitId ?? "", dailyTarget: h.dailyTarget || 1, perClock: h.perClock || 1,
    reminders: (h.reminders ?? []).slice(), popMark: h.popMark !== false, startDay: h.startDay, backfillDays: h.backfillDays,
  };
}

/** 重复行的一句话摘要，形态照抄参考站「固定：周一，周二，…」。 */
function freqText(f: Frequency): string {
  switch (f.kind) {
    case 2: {
      const ws = (f.weekdays?.length ? f.weekdays : [1, 2, 3, 4, 5, 6, 7]).slice().sort((a, b) => a - b);
      return "固定：" + ws.map((w) => "周" + WEEK_CN[w - 1]).join("，");
    }
    case 5: return `按周：每周 ${Math.max(1, f.plan || 1)} 天`;
    case 6: return `按月：每月 ${Math.max(1, f.plan || 1)} 天`;
    case 4: return `每隔：每 ${Math.max(1, f.everyN || 1)} 天`;
    default: return "固定：周一，周二，周三，周四，周五，周六，周日";
  }
}

/** 参考站习惯日期行用补零的「2026年11月07日」，和事项行的「11月7日」不是一套。 */
function habitDayText(d: string): string {
  if (d.length < 10) return d;
  return `${d.slice(0, 4)}年${d.slice(5, 7)}月${d.slice(8, 10)}日`;
}

const mkReminder = (t: string): Reminder => ({ id: "hr-" + t, offset: { days: 0, hours: 0, minutes: 0 }, atTime: t });

/** 图标块里的图形：白描线画在彩色底上（底色由外层给，和参考站一致）。 */
function HabitGlyph({ icon, size = 22 }: { icon: HabitIcon; size?: number }) {
  if (icon.kind === "text" && icon.ref.trim()) {
    return <span className="hm-glyph-word" style={{ fontSize: Math.round(size * 0.66) }}>{[...icon.ref.trim()][0]}</span>;
  }
  const hit = BUILTIN_ICONS.find((i) => i.name === icon.ref) || BUILTIN_ICONS[0];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {hit.paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

export function HabitCreate({ editing, contexts, units, defaultMode, onClose, onUnitsChanged }: {
  editing: Habit | null;
  contexts: HabitContext[];
  units: HabitUnit[];
  /** 新建时默认打开哪套（设置项 habitCreateMode）；编辑已有习惯强制传统模式 */
  defaultMode?: "guided" | "classic";
  onClose: () => void;
  onUnitsChanged: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(editing));
  const [mode, setMode] = useState<"guided" | "classic">(
    editing ? "classic" : (defaultMode === "classic" ? "classic" : "guided"));
  const [mod, setMod] = useState<ModuleKey>("");
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [remindAt, setRemindAt] = useState<string>("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const unitRef = useRef<HTMLInputElement | null>(null);
  // 图标页开着时 Esc 先退图标页，再退整张卡（点灰底不再关窗，键盘必须能关）
  useEscClose(() => (mod === "icon" ? (setMod(""), setRemindAt("")) : onClose()));

  const ctxName = (id: string) => contexts.find((c) => c.id === id)?.name || CTX_ALWAYS;
  const unitName = (id: string) => units.find((u) => u.id === id)?.name || "次";

  /** 打开某个模块：锚点就是被点的那一行，参考站的模块都挂在行下面。 */
  function open(key: ModuleKey, e: React.MouseEvent) {
    e.stopPropagation();
    setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
    setMod((m) => (m === key ? "" : key));
  }
  const close = () => { setMod(""); setRemindAt(""); };

  /** 提醒胶囊的写入：改已有时刻就原位替换，新增则追加，总数不超过 2 条。 */
  function commitReminder(t: string) {
    const prev = remindAt;
    let list = draft.reminders.slice();
    if (prev) list = list.filter((r) => r.atTime !== prev);
    if (!list.some((r) => r.atTime === t)) list.push(mkReminder(t));
    list.sort((a, b) => ((a.atTime ?? "") < (b.atTime ?? "") ? -1 : 1));
    setDraft({ ...draft, reminders: list.slice(0, MAX_REMINDERS) });
    close();
  }

  async function submit(from?: Draft) {
    const d = from ?? draft;
    const name = d.name.trim();
    if (!name) { setErrs({ name: "还没给习惯命名" }); return; }
    if (!d.icon.ref.trim()) { setErrs({ icon: "还没选图标（内置图标或单个汉字）" }); return; }
    try {
      await api.SaveHabit({
        id: editing?.id,
        name,
        icon: { ...d.icon, ref: d.icon.ref.trim() },
        context: d.context,
        freq: d.freq,
        mode: d.mode,
        autoClock: d.autoClock,
        unitId: d.mode === 2 ? d.unitId : undefined,
        dailyTarget: d.mode === 2 ? d.dailyTarget : 0,
        perClock: d.mode === 2 ? d.perClock : 0,
        reminders: d.reminders,
        popMark: d.popMark,
        startDay: d.startDay,
        backfillDays: d.backfillDays,
      });
      bumpRevision();
      onClose();
    } catch (e) {
      toastErr(e);
      setErrs({ global: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 引导算出来的参数：GuideDraft 就是 Draft 的形状（freq 收窄成 number，这里补回类型）。 */
  const fromGuide = (g: GuideDraft): Draft => ({ ...g, freq: g.freq as Frequency });

  const body = (() => {
    if (mod === "repeat") return <RepeatModule value={draft.freq} onSave={(f) => { setDraft({ ...draft, freq: f }); close(); }} onCancel={close} />;
    if (mod === "target") return <TargetModule draft={draft} units={units} unitName={unitName} unitRef={unitRef}
      onSave={(patch) => { setDraft({ ...draft, ...patch }); close(); }} onCancel={close} onUnitsChanged={onUnitsChanged} />;
    if (mod === "classify") return <ClassifyModule draft={draft} contexts={contexts}
      onPick={(id) => { setDraft({ ...draft, context: id }); close(); }}
      onCreate={async (n) => {
        try {
          const c = await api.SaveHabitContext({ id: "", name: n, sort: contexts.length + 1 });
          onUnitsChanged();
          setDraft({ ...draft, context: c.id });
          close();
        } catch (e) { toastErr(e); }
      }} onCancel={close} />;
    if (mod === "remind") return <RemindModule at={remindAt} onSave={commitReminder} onCancel={close} />;
    if (mod === "date") return (
      <DatePanel value={{ kind: 1, start: draft.startDay }} variant="end"
        onCommit={(d) => { setDraft({ ...draft, startDay: d.start || todayLocal() }); close(); }} onClose={close} />
    );
    return null;
  })();

  return (
    <div className={"habit-modal" + (mod === "icon" ? " is-icon" : "")} onMouseDown={(e) => e.stopPropagation()}
      role="dialog" aria-label={editing ? "编辑习惯" : "新建习惯"}>
      <div className="hm-head">
        <span className="hm-title">{editing ? "编辑习惯" : "新建习惯"}</span>
        {/* 两套新建方式共用这张卡：引导＝微启动一步步问，传统＝直接给整张表单。
            默认哪套由设置项 habitCreateMode 决定；这里切换只影响本次弹窗。 */}
        {!editing && (
          <div className="hm-modes" role="tablist" aria-label="新建方式">
            <button className={"hm-mode" + (mode === "guided" ? " is-sel" : "")} role="tab" aria-selected={mode === "guided"}
              onClick={() => setMode("guided")}>引导</button>
            <button className={"hm-mode" + (mode === "classic" ? " is-sel" : "")} role="tab" aria-selected={mode === "classic"}
              onClick={() => setMode("classic")}>传统</button>
          </div>
        )}
        <button className="hm-close" aria-label="关闭（Esc）" title="关闭（Esc）" onClick={onClose}><I n="close" size={11} /></button>
      </div>

      {mode === "guided" && (
        <HabitGuide units={units} contexts={contexts}
          onCreate={(g) => void submit(fromGuide(g))}
          onTune={(g) => { setDraft(fromGuide(g)); setErrs({}); setMode("classic"); }} />
      )}

      {mode === "classic" && <>
      {/* 命名 + 图标：图标是 30×30 圆角块，右下角带编辑角标，点开是整页图标选择器 */}
      <div className="hm-name-row">
        <div className="hm-name-wrap">
          <input className={"hm-name" + (errs.name ? " is-error" : "")} value={draft.name} maxLength={20} placeholder="给习惯命名"
            aria-label="给习惯命名" autoFocus onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setErrs({}); }} />
          {!!draft.name && (
            <button className="hm-name-clear" aria-label="清空名称" onClick={() => setDraft({ ...draft, name: "" })}><I n="close" size={10} /></button>
          )}
        </div>
        <button className="hm-icon" style={{ background: draft.icon.color }} aria-label="选择习惯图标" onClick={(e) => open("icon", e)}>
          <HabitGlyph icon={draft.icon} />
          <span className="hm-icon-edit"><I n="pencil" size={7} /></span>
        </button>
      </div>
      {(errs.name || errs.icon) && <div className="field-error">{errs.name || errs.icon}</div>}

      <ModRow icon="repeat" text={freqText(draft.freq)} active={mod === "repeat"} onOpen={(e) => open("repeat", e)} />
      <ModRow icon="target" text={draft.mode === 1 ? "每天一次" : "每天多次"} active={mod === "target"} onOpen={(e) => open("target", e)} />
      <ModRow icon="clock" text={ctxName(draft.context)} active={mod === "classify"} onOpen={(e) => open("classify", e)} />

      {/* 提醒不是「一行一点」，而是时刻胶囊列表 + 加号：点哪条改哪条，最多 2 条 */}
      <div className="hm-remind-row">
        <span className="hm-row-icon" style={{ color: draft.reminders.length ? "var(--brand)" : "var(--text-3)" }}><I n="bell" size={10} /></span>
        <div className="hm-remind-items">
          {draft.reminders.map((r) => (
            <span key={r.id} className="hm-remind-chip-wrap">
              <button className="hm-remind-chip" onClick={(e) => { setRemindAt((r.atTime || "").slice(0, 5)); open("remind", e); }}>{r.atTime}</button>
              <button className="hm-remind-del" aria-label={`删除提醒 ${r.atTime}`}
                onClick={() => setDraft({ ...draft, reminders: draft.reminders.filter((x) => x.id !== r.id) })}><I n="close" size={8} /></button>
            </span>
          ))}
          {draft.reminders.length < MAX_REMINDERS && (
            <button className="hm-remind-add" aria-label="添加提醒" onClick={(e) => { setRemindAt(""); open("remind", e); }}>
              <I n="plus" size={9} />
            </button>
          )}
        </div>
      </div>

      <ModRow icon="calendar" text={habitDayText(draft.startDay)} active={mod === "date"} onOpen={(e) => open("date", e)} />

      <div className="hm-mark-row">
        <span className="hm-row-icon"><I n="note" size={10} /></span>
        <span className="hm-row-text">打卡心得弹窗</span>
        <button className={"hm-switch" + (draft.popMark ? " is-on" : "")} role="switch" aria-checked={draft.popMark}
          aria-label="打卡时弹出心得窗口" onClick={() => setDraft({ ...draft, popMark: !draft.popMark })} />
      </div>
      <div className="hm-backfill">
        <span className="muted small">可回溯补打卡</span>
        <input className="input num" type="number" min={0} aria-label="可回溯天数" value={draft.backfillDays}
          onChange={(e) => setDraft({ ...draft, backfillDays: Math.max(0, Number(e.target.value)) })} />
        <span className="muted small">天（0=不允许补卡）</span>
      </div>

      <div className="hm-foot">
        <button className="cc-btn" onClick={onClose}>取消</button>
        <button className="cc-btn is-primary" onClick={() => void submit()}>保存</button>
      </div>
      {errs.global && <div className="field-error">{errs.global}</div>}
      </>}

      {mod && mod !== "icon" && anchor && (
        <Popover anchor={anchor} width={mod === "date" ? 258 : mod === "repeat" ? 210 : mod === "target" ? 190 : mod === "remind" ? 150 : 170} onClose={close}>
          {body}
        </Popover>
      )}

      {mod === "icon" && (
        <IconModule icon={draft.icon} onSave={(ic) => { setDraft({ ...draft, icon: ic }); close(); }} onCancel={close} />
      )}
    </div>
  );
}

/** 一行 = 图标 + 摘要 + 箭头；模块打开时箭头朝上（参考站的 icon-item-open）。 */
function ModRow({ icon, text, active, onOpen }: { icon: string; text: string; active: boolean; onOpen: (e: React.MouseEvent) => void }) {
  return (
    <button className={"hm-row" + (active ? " is-open" : "")} onClick={onOpen}>
      <span className="hm-row-icon"><I n={icon} size={10} /></span>
      <span className="hm-row-text">{text}</span>
      <span className="hm-row-arrow"><I n={active ? "chevronUp" : "chevronRight"} size={10} /></span>
    </button>
  );
}

/**
 * 数字下拉：参考站的 .body-scroll-select，1..max 的滚动列表。
 * 浮层用 fixed 定位——它嵌在面板里，面板自己会滚动，绝对定位会被裁掉一半点不到。
 */
function NumPick({ value, max, onSave, label }: { value: number; max: number; onSave: (n: number) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  return (
    <span className="np">
      <button className="np-btn" aria-label={label} aria-expanded={open}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ left: r.left, top: r.bottom + 4 });
          setOpen((o) => !o);
        }}>{value}</button>
      {open && (
        <span className="np-pop" style={{ left: pos.left, top: pos.top }}>
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button key={n} className={"np-item" + (n === value ? " is-sel" : "")} onClick={() => { onSave(n); setOpen(false); }}>{n}</button>
          ))}
        </span>
      )}
    </span>
  );
}

/** 重复模块：固定（周几多选）/ 按周 N 天 / 按月 N 天 / 每隔几天。 */
function RepeatModule({ value, onSave, onCancel }: { value: Frequency; onSave: (f: Frequency) => void; onCancel: () => void }) {
  const [tab, setTab] = useState<number>(value.kind === 4 ? 4 : value.kind === 5 ? 5 : value.kind === 6 ? 6 : 2);
  const [weekdays, setWeekdays] = useState<number[]>(value.weekdays?.length ? value.weekdays : [1, 2, 3, 4, 5, 6, 7]);
  const [plan, setPlan] = useState<number>(value.plan || (value.kind === 6 ? 20 : 5));
  const [everyN, setEveryN] = useState<number>(value.everyN || 2);

  function save() {
    if (tab === 2) onSave({ kind: 2, weekdays: weekdays.length ? [...weekdays].sort((a, b) => a - b) : [1, 2, 3, 4, 5, 6, 7] });
    else if (tab === 5) onSave({ kind: 5, plan: Math.min(7, Math.max(1, plan)) });
    else if (tab === 6) onSave({ kind: 6, plan: Math.min(31, Math.max(1, plan)) });
    else onSave({ kind: 4, everyN: Math.max(1, everyN) });
  }

  return (
    <div className="hm-repeat">
      <div className="hm-tabs">
        {[{ k: 2, t: "固定" }, { k: 5, t: "按周" }, { k: 6, t: "按月" }, { k: 4, t: "每隔几天" }].map((o) => (
          <button key={o.k} className={"hm-tab" + (tab === o.k ? " is-sel" : "")} onClick={() => setTab(o.k)}>{o.t}</button>
        ))}
      </div>
      {tab === 2 && (
        <div className="hm-weeks">
          {WEEK_CN.map((w, i) => (
            <button key={w} className={"hm-wd" + (weekdays.includes(i + 1) ? " is-sel" : "")} aria-pressed={weekdays.includes(i + 1)}
              onClick={() => setWeekdays(weekdays.includes(i + 1) ? weekdays.filter((x) => x !== i + 1) : [...weekdays, i + 1])}>{w}</button>
          ))}
        </div>
      )}
      {tab === 5 && <div className="hm-line">每周 <NumPick value={Math.min(7, Math.max(1, plan))} max={7} label="每周几天" onSave={setPlan} /> 天</div>}
      {tab === 6 && <div className="hm-line">每月 <NumPick value={Math.min(31, Math.max(1, plan))} max={31} label="每月几天" onSave={setPlan} /> 天</div>}
      {tab === 4 && <div className="hm-line">每隔 <NumPick value={Math.max(1, everyN)} max={30} label="每隔几天" onSave={setEveryN} /> 天</div>}
      <div className="pop-buttons">
        <button className="pop-btn" onClick={onCancel}>取消</button>
        <button className="pop-btn is-ok" onClick={save}>保存</button>
      </div>
    </div>
  );
}

/** 目标模块：每天一次 / 每天多次（就地展开量化参数与打卡方式）。 */
function TargetModule({ draft, units, unitName, unitRef, onSave, onCancel, onUnitsChanged }: {
  draft: Draft;
  units: HabitUnit[];
  unitName: (id: string) => string;
  unitRef: React.MutableRefObject<HTMLInputElement | null>;
  onSave: (patch: Partial<Draft>) => void;
  onCancel: () => void;
  onUnitsChanged: () => void;
}) {
  const [mode, setMode] = useState<1 | 2>(draft.mode);
  const [unit, setUnit] = useState(draft.unitId || units[0]?.id || "");
  const [newUnit, setNewUnit] = useState("");
  const [total, setTotal] = useState(draft.dailyTarget || 1);
  const [each, setEach] = useState(draft.perClock || 1);
  const [auto, setAuto] = useState(draft.autoClock);
  const [pickUnit, setPickUnit] = useState(false);

  async function save() {
    let unitId = unit;
    if (newUnit.trim()) {
      try {
        const u = await api.SaveHabitUnit({ name: newUnit.trim() });
        unitId = u.id;
        onUnitsChanged();
      } catch (e) { toastErr(e); return; }
    }
    onSave({
      mode,
      unitId: mode === 2 ? unitId : "",
      dailyTarget: mode === 2 ? Math.max(0.1, total) : 0,
      perClock: mode === 2 ? Math.max(0.1, each) : 0,
      autoClock: auto,
    });
  }

  return (
    <div className="hm-target">
      {[1, 2].map((m) => (
        <button key={m} className={"hm-opt" + (mode === m ? " is-sel" : "")} onClick={() => setMode(m as 1 | 2)}>
          <span>{m === 1 ? "每天一次" : "每天多次"}</span>{mode === m && <I n="check" size={11} />}
        </button>
      ))}
      {mode === 2 && (
        <div className="hm-multi">
          <div className="hm-multi-title">每天多次</div>
          <div className="hm-kv"><span>习惯单位</span>
            <span className="hm-kv-right">
              <button className="hm-kv-pick" onClick={() => setPickUnit((p) => !p)}>{unitName(unit)}</button>
              {pickUnit && (
                <span className="hm-unit-pop">
                  {units.map((u) => (
                    <button key={u.id} className={"hm-unit-item" + (u.id === unit ? " is-sel" : "")}
                      onClick={() => { setUnit(u.id); setNewUnit(""); setPickUnit(false); }}>{u.name}</button>
                  ))}
                  <input ref={unitRef} className="input plain sm" maxLength={2} placeholder="新单位" value={newUnit}
                    onChange={(e) => setNewUnit(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
                </span>
              )}
            </span>
          </div>
          <div className="hm-kv"><span>每日打卡总量</span>
            <input className="hm-kv-input" type="number" min={0.1} step={0.1} aria-label="每日打卡总量" value={total} onChange={(e) => setTotal(Number(e.target.value))} /></div>
          <div className="hm-kv"><span>每次打卡完成量</span>
            <input className="hm-kv-input" type="number" min={0.1} step={0.1} aria-label="每次完成量" value={each} onChange={(e) => setEach(Number(e.target.value))} /></div>
          <div className="hm-kv"><span>打卡方式</span>
            <button className="hm-kv-pick" onClick={() => setAuto((a) => !a)}>{auto ? "自动打卡" : "手动打卡"}</button></div>
        </div>
      )}
      <div className="pop-buttons">
        <button className="pop-btn" onClick={onCancel}>取消</button>
        <button className="pop-btn is-ok" onClick={() => void save()}>保存</button>
      </div>
    </div>
  );
}

/** 情境模块：新增情境（回车即建并选中）+ 全天/自建列表。 */
function ClassifyModule({ draft, contexts, onPick, onCreate, onCancel }: {
  draft: Draft;
  contexts: HabitContext[];
  onPick: (id: string) => void;
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const rows = [{ id: "", name: CTX_ALWAYS }, ...contexts.filter((c) => c.id !== "ctx-always")];
  return (
    <div className="hm-classify">
      <div className="hm-add">
        <input className="input plain" value={q} maxLength={5} placeholder="新增情境" aria-label="新增情境"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) { onCreate(q.trim()); setQ(""); } }} />
      </div>
      <ul className="pick-list">
        {rows.map((c) => (
          <li key={c.id || "always"}>
            <button className={"pick-item" + (draft.context === c.id ? " is-sel" : "")} onClick={() => onPick(c.id)}>
              <span>{c.name}</span>{draft.context === c.id && <I n="check" size={12} />}
            </button>
          </li>
        ))}
      </ul>
      <div className="pop-buttons">
        <button className="pop-btn" onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

/** 提醒模块：时、分两列滚轮，保存即写入（参考站复用的就是 .body-time）。 */
function RemindModule({ at, onSave, onCancel }: { at: string; onSave: (t: string) => void; onCancel: () => void }) {
  const [h, m] = (at || "").split(":").map(Number);
  const now = new Date();
  const [hh, setHh] = useState(Number.isFinite(h) ? h : now.getHours());
  const [mm, setMm] = useState(Number.isFinite(m) ? m : 0);
  const hourRef = useRef<HTMLDivElement | null>(null);
  const minRef = useRef<HTMLDivElement | null>(null);
  // 打开就把当前值滚到中间：参考站的滚轮是「居中即选中」的形态，不定位过去用户看到的是 00
  useEffect(() => {
    for (const box of [hourRef.current, minRef.current]) {
      box?.querySelector(".hm-wheel-item.is-sel")?.scrollIntoView({ block: "center" });
    }
  }, []);
  return (
    <div className="hm-remind">
      <div className="hm-wheel">
        <div className="hm-wheel-list" ref={hourRef}>
          {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((x) => (
            <button key={x} className={"hm-wheel-item" + (Number(x) === hh ? " is-sel" : "")} onClick={() => setHh(Number(x))}>{x}</button>
          ))}
        </div>
        <div className="hm-wheel-list" ref={minRef}>
          {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((x) => (
            <button key={x} className={"hm-wheel-item" + (Number(x) === mm ? " is-sel" : "")} onClick={() => setMm(Number(x))}>{x}</button>
          ))}
        </div>
      </div>
      <div className="pop-buttons">
        <button className="pop-btn" onClick={onCancel}>取消</button>
        <button className="pop-btn is-ok" onClick={() => onSave(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`)}>保存</button>
      </div>
    </div>
  );
}

/** 图标模块：覆盖整张卡的「习惯图标」页——预览 / 分类页签 / 图标网格 / 颜色面板 / 保存取消。 */
function IconModule({ icon, onSave, onCancel }: { icon: HabitIcon; onSave: (i: HabitIcon) => void; onCancel: () => void }) {
  const groups = useMemo(() => [...new Set(BUILTIN_ICONS.map((i) => i.group))], []);
  const [group, setGroup] = useState(() => {
    const hit = BUILTIN_ICONS.find((i) => i.name === icon.ref);
    return hit && icon.kind !== "text" ? hit.group : groups[0];
  });
  const [kind, setKind] = useState<"image" | "text">(icon.kind === "text" ? "text" : "image");
  const [ref, setRef] = useState(icon.kind === "text" ? "" : icon.ref);
  const [word, setWord] = useState(icon.kind === "text" ? icon.ref : "");
  const [color, setColor] = useState(icon.color || PALETTE[0]);
  const shown = BUILTIN_ICONS.filter((i) => i.group === group);

  return (
    <div className="hm-icon-page">
      <div className="hm-head">
        <span className="hm-title">习惯图标</span>
        <button className="hm-close" aria-label="返回" title="返回" onClick={onCancel}><I n="close" size={11} /></button>
      </div>

      <div className="hm-preview">
        <button className={"hm-preview-cell" + (kind === "image" ? " is-sel" : "")} style={{ background: color }} aria-label="用图形图标"
          onClick={() => setKind("image")}>
          <HabitGlyph icon={{ kind: "image", ref, color }} size={20} />
        </button>
        <button className={"hm-preview-cell" + (kind === "text" ? " is-sel" : "")} style={{ background: color }} aria-label="用文字图标"
          onClick={() => setKind("text")}>
          <span className="hm-glyph-word" style={{ fontSize: 13 }}>{[...word.trim()][0] || "文"}</span>
        </button>
      </div>

      {kind === "text" ? (
        <input className="hm-word-input" maxLength={2} value={word} placeholder="输入习惯图标文字" aria-label="输入习惯图标文字"
          onChange={(e) => setWord(e.target.value)} />
      ) : (
        <>
          <div className="hm-gtabs">
            {groups.map((g) => (
              <button key={g} className={"hm-gtab" + (g === group ? " is-sel" : "")} onClick={() => setGroup(g)}>{g}</button>
            ))}
          </div>
          <div className="hm-grid">
            {shown.map((i) => {
              const on = kind === "image" && i.name === ref;
              return (
                <button key={i.name} className={"hm-cell" + (on ? " is-sel" : "")} title={i.label} aria-label={i.label} aria-pressed={on}
                  onClick={() => { setKind("image"); setRef(i.name); }}>
                  <span className="hm-cell-box">
                    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.5}
                      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      {i.paths.map((d, k) => <path key={k} d={d} />)}
                    </svg>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="hm-color-title">选择图标颜色</div>
      <div className="hm-colors">
        {PALETTE.map((c) => (
          <button key={c} className={"hm-color" + (c === color ? " is-sel" : "")} aria-label={"颜色 " + c} style={{ background: c }} onClick={() => setColor(c)} />
        ))}
      </div>

      <div className="hm-foot">
        <button className="cc-btn" onClick={onCancel}>取消</button>
        <button className="cc-btn is-primary" onClick={() => onSave(
          kind === "text" ? { kind: "text", ref: [...word.trim()][0] || "", color } : { kind: "image", ref, color })}>保存</button>
      </div>
    </div>
  );
}

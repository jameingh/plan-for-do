// HabitsPage.tsx —— 习惯页，按 §9.6 / 条目2、7 重构：
//   · 左栏改成 56px 图标模块栏（在 App/chrome），习惯页不再有 200px 筛选栏；
//   · 顶栏 = 单个文字页签「每日打卡」+ 右侧「新建习惯」「情境管理」；
//   · 顶部日期卡片带：54×74、圆角 8、边框 1.6px（今天/选中主色，其余灰）、间距 78（CSS 落地）；
//   · 情境是可折叠组头（「晚间 1 ⌄」），不是分段 tab；
//   · 每条习惯一张卡：30px 圆形图标底（用习惯自己的颜色）+ 标题 + 累计打卡天数 + 跟着选中那天展开的圆点切片（15px）。
// 圆点态：未打卡 #e8e8e8 底 #999 字、已打卡主色实心、部分主色描边、未来更浅、今天红实心白字。
// 补打卡越界时内核返回的中文错误贴在该卡片下方，不弹全局 toast。

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { Habit, HabitCell, HabitContext, HabitRow, HabitUnit, HabitView } from "../api/types";
import { addDays, format, todayLocal, weekdayCN } from "../lib/day";
import { selectHabit, setHabitDay, toast, toastErr, toggleGroup, useApp } from "../store/appStore";
import { HabitCreate } from "./HabitCreate";
import { HabitMarkDialog } from "./HabitDetail";
import { HabitDetail } from "./HabitDetail";
import { TopBar } from "./chrome";
import { HabitStats } from "./HabitStats";
import { Empty, FieldError, Glyph, I, Modal } from "./ui";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)) || "未知错误";

/** 日期卡片带：选中日往前 6 天、往后 7 天。 */
const STRIP_BACK = 6;
const STRIP_FWD = 7;
/** 圆点切片：跟着选中日往前 6 天、往后 8 天展开（实拍 04 是十几个点）。 */
const DOT_BACK = 6;
const DOT_FWD = 8;

function dayWindow(center: string, back: number, fwd: number): string[] {
  const out: string[] = [];
  for (let i = -back; i <= fwd; i++) out.push(addDays(center, i));
  return out;
}

export function HabitsPage() {
  const { booted, boot, revision, selection, collapsedGroups, habitDay, settings } = useApp();
  const [view, setView] = useState<HabitView | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [contexts, setContexts] = useState<HabitContext[]>([]);
  const [units, setUnits] = useState<HabitUnit[]>([]);
  const [creating, setCreating] = useState(false);
  const [mark, setMark] = useState<{ habit: Habit; day: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showCtxMgr, setShowCtxMgr] = useState(false);
  // 顶部两页签：每日打卡（原来的卡片流）/ 习惯统计（日周月年）
  const [mode, setMode] = useState<"list" | "stat">("list");
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const mainRef = useRef<HTMLElement | null>(null);

  const today = boot?.today ?? todayLocal();
  const selDay = habitDay || today;
  const stripDays = useMemo(() => dayWindow(selDay, STRIP_BACK, STRIP_FWD), [selDay]);

  const reloadHabitData = () => {
    if (!booted) return;
    let dead = false;
    // 切片窗口会跨月，跨月时多取一个月视图把 cell 拼上（只加请求，不动内核）
    const months = [...new Set(dayWindow(selDay, DOT_BACK, DOT_FWD).map((d) => d.slice(0, 7)))];
    Promise.all(months.map((m) => api.HabitMonthView(selDay, m)))
      .then((vs) => {
        if (dead) return;
        const primary = vs.find((v) => v.month === selDay.slice(0, 7)) ?? vs[0];
        const extra = vs.filter((v) => v !== primary);
        if (extra.length) {
          for (const rows of Object.values(primary.rowsByContext)) {
            for (const row of rows) {
              const cells: HabitCell[] = [...row.month];
              for (const v of extra) {
                const src = (v.rowsByContext[row.habit.context || "ctx-always"] ?? []).find((r) => r.habit.id === row.habit.id);
                if (src) cells.push(...src.month);
              }
              row.month = cells;
            }
          }
        }
        setView(primary);
        setLoadErr("");
      })
      .catch((e) => {
        if (dead) return;
        setView(null);
        setLoadErr(errText(e));
      });
    api.HabitContexts().then(setContexts).catch(() => undefined);
    api.HabitUnits().then(setUnits).catch(() => undefined);
  };

  useEffect(reloadHabitData, [booted, revision, selDay, today]);

  // 折叠记忆按「日期:组」，切日期不丢（规范 4.4）
  const gkey = (day: string, k: string) => `${day}:${k}`;
  const isCollapsed = (k: string) => collapsedGroups.includes(gkey(selDay, k));

  // 情境分段顺序 + 展平行，↑↓ 在里面走
  const orderedCtx = view?.contexts ?? [];
  const flat = useMemo(
    () => orderedCtx.flatMap((ctxId) => (view?.rowsByContext[ctxId] ?? [])),
    [view, orderedCtx]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey || !view) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!flat.length) return;
        e.preventDefault();
        const cur = flat.findIndex((r) => r.habit.id === selection.habitId);
        const next = cur < 0 ? 0 : Math.max(0, Math.min(flat.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
        selectHabit(flat[next].habit.id);
        mainRef.current?.querySelector(`[data-habit="${CSS.escape(flat[next].habit.id)}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (e.key === " ") {
        const row = flat.find((r) => r.habit.id === selection.habitId);
        if (!row || !row.dueToday) return;
        e.preventDefault();
        void clock(row);
      } else if (e.key >= "1" && e.key <= "4") {
        const ctxId = orderedCtx[Number(e.key) - 1];
        if (!ctxId) return;
        e.preventDefault();
        mainRef.current?.querySelector(`[data-ctx="${CSS.escape(ctxId)}"]`)?.scrollIntoView({ block: "start" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, flat, selection.habitId, orderedCtx]);

  async function clock(row: HabitRow) {
    const h = row.habit;
    const d = row.day;
    try {
      if (row.clocked) {
        const n = await api.CancelHabitClock(h.id, d);
        toast(`已取消 ${format(d)} 的打卡（${n} 条）`);
      } else {
        await api.ClockHabit(h.id, d, h.mode === 2 ? h.perClock : 0);
        if (h.popMark !== false) setMark({ habit: h, day: d }); // 参考站：习惯勾了「打卡心得弹窗」就打完后弹一下
      }
    } catch (e) {
      setRowErr((old) => ({ ...old, [h.id]: errText(e) }));
    }
  }

  async function cellClick(row: HabitRow, cellDay: string, state: string) {
    if (state === "future" || state === "off") return;
    const h = row.habit;
    setRowErr((old) => ({ ...old, [h.id]: "" }));
    if (state === "done" || state === "partial") {
      // 取消整批：内核 CancelHabitClock 会删掉该习惯当天全部记录
      try {
        const n = await api.CancelHabitClock(h.id, cellDay);
        toast(`已取消 ${format(cellDay)} 的打卡（${n} 条）`);
      } catch (e) {
        setRowErr((old) => ({ ...old, [h.id]: errText(e) }));
      }
      return;
    }
    // missed / pending / 空 → 打卡或补打卡；补打卡越界由内核拒绝，错误贴在本行下方
    try {
      await api.ClockHabit(h.id, cellDay, h.mode === 2 ? h.perClock : 0);
      if (h.popMark !== false) setMark({ habit: h, day: cellDay });
    } catch (e) {
      setRowErr((old) => ({ ...old, [h.id]: errText(e) }));
    }
  }

  const selectedRow = view ? flat.find((r) => r.habit.id === selection.habitId) ?? null : null;
  const selectedHabit = selectedRow?.habit ?? null;
  const ctxName = (id: string) => contexts.find((c) => c.id === id)?.name ?? (id === "ctx-always" ? "全天" : id);

  return (
    <>
      <TopBar
        tabs={
          <nav className="gtabs" aria-label="视图">
            <button className={"gtab" + (mode === "list" ? " is-active" : "")} onClick={() => setMode("list")}>每日打卡</button>
            <button className={"gtab" + (mode === "stat" ? " is-active" : "")} onClick={() => setMode("stat")}>习惯统计</button>
          </nav>
        }
        extra={
          <>
            {mode === "list" && (
              <>
                <button className="btn small primary" onClick={() => { setEditingId(null); setCreating(true); }}><I n="plus" size={14} />新建习惯</button>
                <button className="btn small" onClick={() => setShowCtxMgr(true)}>情境管理</button>
              </>
            )}
          </>
        }
      />

      {mode === "stat" ? (
        <main className="content"><HabitStats /></main>
      ) : (
      <main className="content" ref={mainRef}>
        {/* 顶部日期卡片带：选中它 = 切换下面所有习惯看的那一天 */}
        <DateStrip days={stripDays} selDay={selDay} today={today} stat={view ? `累计打卡 ${view.totalClockDays} 天` : "…"} onPick={setHabitDay} />

        <div className="group-list">
          {loadErr && <FieldError text={`加载失败：${loadErr}`} />}
          {!loadErr && !view && <Empty text="正在加载…" />}
          {view && flat.length === 0 && <Empty text="还没有习惯。" action="新建习惯" onAction={() => { setEditingId(null); setCreating(true); }} />}

          {view && orderedCtx.map((ctxId) => {
            const rows = view.rowsByContext[ctxId] ?? [];
            const total = rows.reduce((a, r) => a + r.totalDays, 0);
            const ck = `ctx-${ctxId}`;
            const collapsed = isCollapsed(ck);
            return (
              <section key={ctxId} className={"habit-section" + (collapsed ? " is-collapsed" : "")} data-ctx={ctxId}>
                {/* 情境是可折叠组头，不是分段 tab */}
                <header className="ctx-head">
                  <button className="caret" aria-label={collapsed ? "展开情境" : "折叠情境"} aria-expanded={!collapsed} onClick={() => toggleGroup(gkey(selDay, ck))}>
                    <I n="chevronDown" size={14} />
                  </button>
                  <h4>{ctxName(ctxId)}</h4>
                  {rows.length > 0 && <span className="count">{rows.length}</span>}
                  <span className="head-ops muted small">{total ? `累计 ${total} 天` : ""}</span>
                </header>
                <div className="group-body">
                  <div className="group-inner">
                    {rows.length === 0 ? (
                      <div className="col-empty" style={{ padding: "4px 39.5px 8px" }}>此情境暂无习惯</div>
                    ) : (
                      <div className="habit-list">
                        {rows.map((row) => (
                          <div key={row.habit.id}>
                            <HabitCard row={row} selDay={selDay} today={today} units={units}
                              selected={selection.habitId === row.habit.id}
                              onPick={() => selectHabit(row.habit.id)}
                              onClock={() => void clock(row)}
                              onCell={(d, st) => void cellClick(row, d, st)} />
                            <FieldError text={rowErr[row.habit.id]} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      </main>
      )}

      {/* 习惯详情：居中弹窗（与事项详情同款遮罩）。
          遮罩不关弹窗：心得输入到一半被点掉太伤，参考站点灰区也是不会收的。 */}
      {selectedHabit && (
        <div className="detail-overlay">
          <div className="item-modal">
            <HabitDetail
              habit={selectedHabit}
              month={selDay.slice(0, 7)}
              units={units}
              onEdit={() => { setEditingId(selectedHabit.id); setCreating(true); }}
              onClose={() => selectHabit(null)}
            />
          </div>
        </div>
      )}

      {creating && (
        <div className="detail-overlay">
          <HabitCreate
            editing={editingId && view ? flat.find((r) => r.habit.id === editingId)?.habit ?? null : null}
            contexts={contexts}
            units={units}
            defaultMode={settings.habitCreateMode}
            onUnitsChanged={reloadHabitData}
            onClose={() => { setCreating(false); setEditingId(null); }}
          />
        </div>
      )}

      {mark && (
        <div className="detail-overlay">
          <HabitMarkDialog habit={mark.habit} day={mark.day} onClose={() => setMark(null)} />
        </div>
      )}

      {showCtxMgr && <ContextManager contexts={contexts} counts={view?.rowsByContext ?? {}} onChanged={reloadHabitData} onClose={() => setShowCtxMgr(false)} />}
    </>
  );
}

/** 顶部日期卡片带：54×74 三行（月份/日/周几），今天或选中=主色描边+主色字。 */
function DateStrip({ days, selDay, today, stat, onPick }: { days: string[]; selDay: string; today: string; stat: string; onPick: (d: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  // 只在选中的卡片跑到视野外时才滚，否则保持从窗口第一天开始读
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const idx = days.findIndex((d) => d === selDay);
    const node = idx >= 0 ? (el.children[idx] as HTMLElement | undefined) : undefined;
    if (!node) return;
    const left = node.offsetLeft;
    const right = left + node.offsetWidth;
    if (left < el.scrollLeft) el.scrollTo({ left: Math.max(0, left - 8) });
    else if (right > el.scrollLeft + el.clientWidth) el.scrollTo({ left: right - el.clientWidth + 8 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selDay]);

  return (
    <div className="datestrip" ref={ref} role="tablist" aria-label="查看哪一天">
      {days.map((d) => (
        <button key={d} role="tab" aria-selected={d === selDay}
          className={"dcard" + (d === selDay ? " is-active" : "") + (d === today ? " is-today" : "")}
          onClick={() => onPick(d)}>
          <span className="m">{Number(d.slice(5, 7))}月</span>
          <span className="d">{Number(d.slice(8, 10))}</span>
          <span className="w">{weekdayCN(d)}</span>
        </button>
      ))}
      <span className="strip-stat">{stat}</span>
    </div>
  );
}

/** 习惯卡：30px 圆形图标底（习惯色）+ 标题 + 累计打卡天数 + 跟着选中那天展开的圆点切片。 */
function HabitCard({ row, selDay, today, units, selected, onPick, onClock, onCell }: {
  row: HabitRow;
  selDay: string;
  today: string;
  units: HabitUnit[];
  selected: boolean;
  onPick: () => void;
  onClock: () => void;
  onCell: (day: string, state: string) => void;
}) {
  const h = row.habit;
  const unitName = units.find((u) => u.id === h.unitId)?.name ?? "";
  const amountText = h.mode === 2 ? `${trimNum(row.amount)}/${trimNum(row.target)}${unitName}` : row.clocked ? "已打卡" : row.dueToday ? "未打卡" : "今日不排期";
  return (
    <article className={"habit-card" + (selected ? " is-selected" : "")} data-habit={h.id} tabIndex={0} role="button"
      onClick={onPick}
      onKeyDown={(e) => { if (e.key === "Enter") onPick(); }}>
      <Glyph kind={h.icon.kind} glyph={h.icon.ref} color={h.icon.color} size={30} round />
      <div className="habit-body">
        <div className="habit-name">{h.name}</div>
        <div className="habit-total">
          累计打卡{row.totalDays}天 · <span className={"qty" + (!row.clocked && row.dueToday ? " is-todo" : "")}>{amountText}</span>
          {row.streak > 0 && ` · 连续${row.streak}天`}
          {!row.canBackfill && row.dueToday && <span title={`可回溯 ${h.backfillDays} 天`}> · 禁补卡</span>}
        </div>
        <DotStrip row={row} selDay={selDay} today={today} onCell={onCell} />
      </div>
      <div className="row-ops">
        <button className="icon-btn" title={row.clocked ? "取消这天打卡" : "打卡这天"} aria-label={row.clocked ? "取消这天打卡" : "打卡这天"} disabled={!row.dueToday}
          onClick={(e) => { e.stopPropagation(); onClock(); }}><I n="check" size={14} /></button>
        <button className="icon-btn" title="打开详情" aria-label="打开详情" onClick={(e) => { e.stopPropagation(); onPick(); }}><I n="chevronRight" size={14} /></button>
      </div>
    </article>
  );
}

/** 圆点切片：跟着顶部选中的那天向两侧展开若干天（不是月历网格），非排期日不占位。 */
function DotStrip({ row, selDay, today, onCell }: { row: HabitRow; selDay: string; today: string; onCell: (day: string, state: string) => void }) {
  const cells = new Map(row.month.map((c) => [c.day, c]));
  const shown = dayWindow(selDay, DOT_BACK, DOT_FWD).map((d) => ({ d, c: cells.get(d) })).filter((x) => x.c);
  return (
    <div className="dotstrip" aria-label={`${row.habit.name} 打卡切片`}>
      {shown.map(({ d, c }) => {
        const isToday = d === today;
        const title = `${format(d)} ${weekdayCN(d)} · ${stateText(c!.state)} ${trimNum(c!.amount)}/${trimNum(c!.target)}`;
        return (
          <button key={d}
            className={"hdot " + c!.state + (isToday ? " is-today" : "") + (d === selDay ? " is-picked" : "")}
            title={title}
            aria-label={title}
            onClick={(e) => { e.stopPropagation(); onCell(d, c!.state); }}>
            {Number(d.slice(8, 10))}
          </button>
        );
      })}
    </div>
  );
}

/** 情境管理弹窗：改名 / 删除（非全天）/ 新增。旧版在左栏，条目2 把左栏改成图标栏后移到这里。 */
function ContextManager({ contexts, counts, onChanged, onClose }: {
  contexts: HabitContext[];
  counts: Record<string, HabitRow[]>;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<HabitContext | null>(null);

  const add = () => {
    if (!draft.trim()) return;
    api.SaveHabitContext({ name: draft.trim(), sort: contexts.length })
      .then(() => { setDraft(""); onChanged(); })
      .catch((e) => setErr(errText(e)));
  };
  const rename = (c: HabitContext, name: string) => {
    if (!name.trim() || name === c.name) { setRenaming(null); return; }
    api.SaveHabitContext({ id: c.id, name: name.trim(), sort: c.sort }).then(() => { setRenaming(null); onChanged(); }).catch(toastErr);
  };
  const del = (c: HabitContext) => {
    setDeleting(null);
    api.DeleteHabitContext(c.id).then((n) => { toast(`已删除情境，${n} 个习惯归入「全天」`); onChanged(); }).catch(toastErr);
  };

  return (
    <Modal title="情境管理" onClose={onClose} keepOnMask>
      <div className="cat-list">
        {contexts.map((c) => {
          const n = (counts[c.id] ?? []).length;
          return (
            <div key={c.id} className="cat-row">
              {renaming?.id === c.id ? (
                <input className="input" autoFocus defaultValue={c.name}
                  onKeyDown={(e) => {
                    const v = (e.target as HTMLInputElement).value;
                    if (e.key === "Enter") rename(c, v);
                    else if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); }
                  }}
                  onBlur={(e) => rename(c, e.target.value)} />
              ) : (
                <>
                  <span className="grow">{c.name}</span>
                  <span className="muted small">{n}</span>
                  <button className="icon-btn" title="改名" aria-label={`重命名情境 ${c.name}`} onClick={() => setRenaming({ id: c.id, name: c.name })}><I n="pencil" size={12} /></button>
                  {c.id !== "ctx-always" && <button className="icon-btn danger" title="删除情境" aria-label={`删除情境 ${c.name}`} onClick={() => setDeleting(c)}><I n="trash" size={12} /></button>}
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="field-row" style={{ marginTop: 12 }}>
        <input className={"input" + (err ? " is-error" : "")} placeholder="新情境，回车创建" value={draft}
          onChange={(e) => { setDraft(e.target.value); if (err) setErr(""); }}
          onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn primary" disabled={!draft.trim()} onClick={add}><I n="plus" size={14} />添加</button>
      </div>
      <FieldError text={err} />
      <p className="muted small">删除情境后，其下习惯归入「全天」（内核行为，习惯本身不删）。「全天」为内置情境，不可删除。</p>

      {deleting && (
        <Modal title={`删除情境「${deleting.name}」`} onClose={() => setDeleting(null)}>
          <p className="muted">其下 {(counts[deleting.id] ?? []).length} 个习惯将归入「全天」，确认删除？</p>
          <div className="btn-row">
            <button className="btn danger" onClick={() => void del(deleting)}>删除</button>
            <button className="btn" onClick={() => setDeleting(null)}>取消</button>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function stateText(s: string): string {
  if (s === "done") return "已打卡";
  if (s === "partial") return "部分完成";
  if (s === "pending") return "今天还没打卡";
  if (s === "missed") return "未打卡（可点补卡）";
  if (s === "future") return "未到期";
  return "非排期";
}

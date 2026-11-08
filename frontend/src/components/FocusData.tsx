// 专注数据页：统计分析 + 数据分布两个页签。
//
// 数字全部来自内核 FocusStat / FocusList，界面只做排版与配色，不自己再算一遍口径——
// 「累计专注」和「今日专注」如果前端各算各的，早晚会和详情页对不上。
// 区间聚合里 overview 是全历史的，daily/byType/byTask/matrix 才按区间，这里也照这个分工用。
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { Day, FocusDaily, FocusListItem, FocusStat, FocusType } from "../api/types";
import { toastErr } from "../store/appStore";
import { addDays, formatDayCN, monthDays, todayLocal, weekdayMon } from "../lib/day";
import { FOCUS_TYPE_LABEL, fmtDuration, toMinutes } from "../lib/focus";
import { DatePanel, Popover } from "./ItemPanels";
import { FocusDetail } from "./FocusDetail";
import { I } from "./ui";

type Tab = "stat" | "dist";

export function FocusData() {
  const [tab, setTab] = useState<Tab>("stat");
  return (
    <div className="fc-data">
      <nav className="fc-tabs" role="tablist" aria-label="数据页签">
        {([["stat", "统计分析"], ["dist", "数据分布"]] as [Tab, string][]).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k}
            className={"fc-tab" + (tab === k ? " is-sel" : "")} onClick={() => setTab(k)}>{label}</button>
        ))}
      </nav>
      {tab === "stat" ? <Analysis /> : <Distribution />}
    </div>
  );
}

/** 区间标题 + 左右翻页（不许越过今天）+ 「回到本期」。四个粒度共用这一套语义。 */
function RangeHead({ label, start, end, onPrev, onNext, onNow, canNext }: {
  label: string; start: Day; end: Day; onPrev: () => void; onNext: () => void; onNow: () => void; canNext: boolean;
}) {
  return (
    <div className="fc-head">
      <button className="fc-arrow" aria-label="上一期" onClick={onPrev}><I n="chevronLeft" size={12} /></button>
      <span className="fc-range">{label}</span>
      <button className="fc-arrow" aria-label="下一期" disabled={!canNext}
        title={canNext ? "" : "不能查看未来的日期"} onClick={onNext}><I n="chevronRight" size={12} /></button>
      {start !== todayLocal() && end !== todayLocal() && (
        <button className="fc-now" onClick={onNow}>回到本期</button>
      )}
      <span className="fc-range-sub">{start.slice(5).replace("-", "/")} - {end.slice(5).replace("-", "/")}</span>
    </div>
  );
}

function useStat(start: Day, end: Day) {
  const [stat, setStat] = useState<FocusStat | null>(null);
  useEffect(() => {
    let dead = false;
    api.FocusStat({ start, end }).then((v) => !dead && setStat(v)).catch((e) => !dead && toastErr(e));
    return () => { dead = true; };
  }, [start, end]);
  return stat;
}

// —— 统计分析 ——

function Analysis() {
  const today = todayLocal();
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const stat = useStat(yearStart, today);
  const [history, setHistory] = useState<{ day: string } | null>(null);
  const [manual, setManual] = useState(false);

  if (!stat) return <div className="fc-loading">正在统计…</div>;
  const o = stat.overview;

  return (
    <>
      <section className="fc-card">
        <div className="fc-card-title">数据总览</div>
        <div className="fc-overview">
          <OverviewCell title="累计专注" main={fmtDuration(o.totalSec)} sub={`总次数 ${o.totalCount} 次`}
            onOpen={() => setHistory({ day: "" })} />
          <OverviewCell title="今日专注" main={fmtDuration(o.todaySec)} sub={`总次数 ${o.todayCount} 次`}
            onOpen={() => setHistory({ day: today })} />
        </div>
      </section>

      <button className="fc-manual-btn" onClick={() => setManual(true)}>
        <I n="plus" size={12} />补记专注记录
      </button>

      <DurationSpread stat={stat} />
      <AllTimeHeat stat={stat} />
      <DurationBreak stat={stat} />

      {history && <FocusHistory day={history.day} onBack={() => setHistory(null)} />}
      {manual && <FocusManual onBack={() => setManual(false)} />}
    </>
  );
}

function OverviewCell({ title, main, sub, onOpen }: { title: string; main: string; sub: string; onOpen: () => void }) {
  return (
    <div className="fc-ov">
      <div className="fc-ov-text">
        <b className="fc-ov-title">{title}</b>
        <span className="fc-ov-main">{main}</span>
        <span className="fc-ov-sub">{sub}</span>
      </div>
      <button className="fc-ov-go" aria-label={`查看${title}记录`} onClick={onOpen}><I n="chevronRight" size={14} /></button>
    </div>
  );
}

/** 专注时长分布：每日趋势柱 + 类型占比条。 */
function DurationSpread({ stat }: { stat: FocusStat }) {
  const days = stat.daily;
  const max = Math.max(60, ...days.map((d) => d.sec));
  // 一年 365 根柱子在一屏里会变成噪点，超过 60 天改成按月聚合
  const monthly = useMemo(() => groupMonthly(days), [days]);
  const bars = days.length > 60 ? monthly : days.map((d) => ({ label: d.day.slice(8, 10), sec: d.sec, count: d.count }));
  const totalSec = stat.byType.reduce((s, t) => s + t.sec, 0) || 1;
  return (
    <section className="fc-card">
      <div className="fc-card-title">专注时长分布<span className="fc-sub">{days.length > 60 ? "按月" : "按天"}</span></div>
      <div className="fc-bars" role="img" aria-label="专注时长趋势">
        {bars.map((b, i) => (
          <div key={i} className="fc-bar-col" title={`${b.label}：${fmtDuration(b.sec)} / ${b.count} 次`}>
            <span className="fc-bar" style={{ height: `${Math.max(2, (b.sec / max) * 100)}%` }} />
            <i>{b.label}</i>
          </div>
        ))}
      </div>
      <div className="fc-split">
        {stat.byType.map((t) => (
          <div key={t.type} className="fc-split-row">
            <span className="fc-split-name">{FOCUS_TYPE_LABEL[t.type as FocusType]}</span>
            <span className="fc-split-bar">
              <i style={{ width: `${(t.sec / totalSec) * 100}%` }} data-type={t.type} />
            </span>
            <span className="fc-split-val">{fmtDuration(t.sec)} · {t.count} 次</span>
          </div>
        ))}
        {!stat.byType.length && <div className="fc-dim">这一期还没有专注记录。</div>}
      </div>
    </section>
  );
}

function groupMonthly(days: FocusDaily[]) {
  const map = new Map<string, { sec: number; count: number }>();
  for (const d of days) {
    const k = d.day.slice(5, 7);
    const v = map.get(k) || { sec: 0, count: 0 };
    v.sec += d.sec;
    v.count += d.count;
    map.set(k, v);
  }
  return [...map.entries()].map(([label, v]) => ({ label: `${Number(label)}月`, ...v }));
}

/** 全时段热图：一年日历，深浅 = 当天专注了多少。 */
function AllTimeHeat({ stat }: { stat: FocusStat }) {
  const byDay = useMemo(() => new Map(stat.daily.map((d) => [d.day, d.sec])), [stat]);
  const maxMin = Math.max(1, ...stat.daily.map((d) => d.sec / 60));
  const cols = useMemo(() => heatColumns(stat.start, stat.end, byDay, maxMin), [stat, byDay, maxMin]);
  return (
    <section className="fc-card">
      <div className="fc-card-title">全时段热图<span className="fc-sub">颜色越深，那天专注越久</span></div>
      <div className="fc-heat" role="img" aria-label="全年专注热图">
        {cols.map((col, ci) => (
          <div key={ci} className="fc-heat-col">
            {col.map((c, ri) => (
              <i key={ri} className={`fc-heat-cell lv${c.lv}`} title={c.day ? `${c.day}：${fmtDuration(c.sec)}` : ""} />
            ))}
          </div>
        ))}
      </div>
      <div className="fc-heat-legend">
        <span>少</span>
        {[1, 2, 3, 4].map((lv) => <i key={lv} className={`fc-heat-cell lv${lv}`} />)}
        <span>多</span>
      </div>
    </section>
  );
}

function heatColumns(start: Day, end: Day, byDay: Map<Day, number>, maxMin: number) {
  const out: { day: Day; sec: number; lv: number }[][] = [];
  let bucket: { day: Day; sec: number; lv: number }[] = [];
  // 第一列前面补空格子，让「一行 = 一个星期几」成立
  for (let k = 0; k < weekdayMon(start) - 1; k++) bucket.push({ day: "", sec: 0, lv: 0 });
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const sec = byDay.get(d) ?? 0;
    const ratio = sec / 60 / maxMin;
    const lv = sec === 0 ? 0 : ratio > 0.66 ? 4 : ratio > 0.33 ? 3 : ratio > 0.1 ? 2 : 1;
    bucket.push({ day: d, sec, lv });
    if (weekdayMon(d) === 7) { out.push(bucket); bucket = []; }
    if (d === end) break;
  }
  if (bucket.length) {
    while (bucket.length < 7) bucket.push({ day: "", sec: 0, lv: 0 });
    out.push(bucket);
  }
  return out;
}

/** 专注时长分解：时段 × 星期矩阵 + 任务排行。 */
function DurationBreak({ stat }: { stat: FocusStat }) {
  const max = Math.max(1, ...stat.matrix.map((c) => c.sec));
  const top = Math.max(1, ...stat.byTask.map((t) => t.sec));
  return (
    <section className="fc-card">
      <div className="fc-card-title">专注时长分解<span className="fc-sub">哪个时段最能沉下去</span></div>
      <div className="fc-matrix" role="img" aria-label="时段与星期矩阵">
        <span className="fc-mx-corner" />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="fc-mx-hour">{h}</span>)}
        {[1, 2, 3, 4, 5, 6, 7].map((w) => (
          <FragmentRow key={w} weekday={w} matrix={stat.matrix} max={max} />
        ))}
      </div>
      <div className="fc-rank">
        {stat.byTask.map((t) => (
          <div key={t.itemId || "none"} className="fc-rank-row">
            <span className="fc-rank-name">{t.name}</span>
            <span className="fc-rank-bar"><i style={{ width: `${(t.sec / top) * 100}%` }} /></span>
            <span className="fc-rank-val">{fmtDuration(t.sec)} · {t.count} 次</span>
          </div>
        ))}
        {!stat.byTask.length && <div className="fc-dim">这一期还没有专注记录。</div>}
        {stat.unplacedCount > 0 && (
          <p className="fc-dim">另有 {stat.unplacedCount} 条补记（{fmtDuration(stat.unplacedSec)}）没有真实时刻，不落在时段矩阵里。</p>
        )}
      </div>
    </section>
  );
}

function FragmentRow({ weekday, matrix, max }: { weekday: number; matrix: FocusStat["matrix"]; max: number }) {
  const cells = matrix.filter((c) => c.weekday === weekday);
  return (
    <>
      <span className="fc-mx-day">{"一二三四五六日"[weekday - 1]}</span>
      {cells.map((c) => (
        <i key={c.hour} className="fc-mx-cell" data-lv={c.sec === 0 ? 0 : Math.min(4, Math.ceil((c.sec / max) * 4))}
          title={`周${"一二三四五六日"[weekday - 1]} ${c.hour}:00 - ${fmtDuration(c.sec)} / ${c.count} 次`} />
      ))}
    </>
  );
}

// —— 数据分布：日 / 月 / 年 三个模块 ——

function Distribution() {
  const today = todayLocal();
  const [day, setDay] = useState<Day>(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [year, setYear] = useState(today.slice(0, 4));

  const dayStat = useStat(day, day);
  const monthStat = useStat(monthDays(month)[0], monthDays(month).slice(-1)[0]);
  const yearStat = useStat(`${year}-01-01`, `${year}-12-31`);
  const [list, setList] = useState<FocusListItem[]>([]);
  useEffect(() => {
    let dead = false;
    api.FocusList(day, 0).then((v) => !dead && setList(v ?? [])).catch(toastErr);
    return () => { dead = true; };
  }, [day]);

  return (
    <>
      <section className="fc-card">
        <RangeHead label={`${formatDayCN(day)}`} start={day} end={day} canNext={addDays(day, 1) <= today}
          onPrev={() => setDay(addDays(day, -1))} onNext={() => setDay(addDays(day, 1))} onNow={() => setDay(today)} />
        <div className="fc-card-title is-inner">日统计</div>
        {dayStat && (
          <div className="fc-nums">
            <Num label="时长" value={fmtDuration(dayStat.overview.todaySec)} />
            <Num label="次数" value={`${dayStat.overview.todayCount} 次`} />
            <Num label="番茄轮数" value={`${list.reduce((s, x) => s + (x.record.type === 2 ? x.record.cycles : 0), 0)} 轮`} />
            <Num label="休息" value={fmtDuration(list.reduce((s, x) => s + x.record.restSec, 0))} />
          </div>
        )}
        <div className="fc-hours">
          {Array.from({ length: 24 }, (_, h) => {
            const sec = list.filter((x) => x.record.startAt && new Date(x.record.startAt).getHours() === h)
              .reduce((s, x) => s + x.record.actualSec, 0);
            return <i key={h} className="fc-hour-bar" style={{ height: `${Math.min(100, (sec / 3600) * 100)}%` }} title={`${h}:00 ${fmtDuration(sec)}`} />;
          })}
        </div>
        <ul className="fc-mini-list">
          {list.map((x) => (
            <li key={x.record.id}>
              <span className="fc-mini-time">{x.record.startAt ? new Date(x.record.startAt).toTimeString().slice(0, 5) : "补记"}</span>
              <span className="fc-mini-name">{x.taskName}</span>
              <span className="fc-mini-dur">{fmtDuration(x.record.actualSec)}</span>
            </li>
          ))}
          {!list.length && <li className="fc-dim">这天还没有专注记录。</li>}
        </ul>
      </section>

      <section className="fc-card">
        <RangeHead label={`${Number(year)}年${Number(month.slice(5, 7))}月`} start={monthDays(month)[0]} end={monthDays(month).slice(-1)[0]}
          canNext={addDays(monthDays(month).slice(-1)[0], 1) <= today}
          onPrev={() => setMonth(addMonth(month, -1))} onNext={() => setMonth(addMonth(month, 1))} onNow={() => setMonth(today.slice(0, 7))} />
        <div className="fc-card-title is-inner">月统计</div>
        {monthStat && (
          <div className="fc-nums">
            <Num label="总时长" value={fmtDuration(monthStat.daily.reduce((s, d) => s + d.sec, 0))} />
            <Num label="总次数" value={`${monthStat.daily.reduce((s, d) => s + d.count, 0)} 次`} />
            <Num label="有专注的天" value={`${monthStat.daily.filter((d) => d.count > 0).length} 天`} />
            <Num label="日均" value={fmtDuration(Math.round(monthStat.daily.reduce((s, d) => s + d.sec, 0) / Math.max(1, monthStat.daily.length)))} />
          </div>
        )}
        {monthStat && <MonthGrid stat={monthStat} month={month} />}
      </section>

      <section className="fc-card">
        <RangeHead label={`${Number(year)}年`} start={`${year}-01-01`} end={`${year}-12-31`}
          canNext={`${Number(year) + 1}-01-01` <= today}
          onPrev={() => setYear(String(Number(year) - 1))} onNext={() => setYear(String(Number(year) + 1))} onNow={() => setYear(today.slice(0, 4))} />
        <div className="fc-card-title is-inner">年统计</div>
        {yearStat && (
          <div className="fc-nums">
            <Num label="总时长" value={fmtDuration(yearStat.daily.reduce((s, d) => s + d.sec, 0))} />
            <Num label="总次数" value={`${yearStat.daily.reduce((s, d) => s + d.count, 0)} 次`} />
            <Num label="最长一天" value={fmtDuration(Math.max(0, ...yearStat.daily.map((d) => d.sec)))} />
          </div>
        )}
        {yearStat && <DurationSpread stat={yearStat} />}
      </section>
    </>
  );
}

function Num({ label, value }: { label: string; value: string }) {
  return <div className="fc-num"><b>{value}</b><span>{label}</span></div>;
}

/** 月格：一天一格，深浅 = 当天专注时长。 */
function MonthGrid({ stat, month }: { stat: FocusStat; month: string }) {
  const days = monthDays(month);
  const sec = new Map(days.map((d, i) => [d, stat.daily[i]?.sec ?? 0]));
  const max = Math.max(1, ...[...sec.values()]) / 60;
  const lead = weekdayMon(days[0]) - 1;
  return (
    <div className="fc-month">
      {"一二三四五六日".split("").map((w) => <span key={w} className="fc-month-wk">{w}</span>)}
      {Array.from({ length: lead }, (_, i) => <i key={`p${i}`} className="fc-mcell is-pad" />)}
      {days.map((d) => {
        const v = sec.get(d) ?? 0;
        const lv = v === 0 ? 0 : Math.min(4, Math.ceil((v / 60 / max) * 4));
        return <i key={d} className={`fc-mcell lv${lv}`} title={`${Number(d.slice(8))}日 ${fmtDuration(v)}`} />;
      })}
    </div>
  );
}

function addMonth(month: string, n: number): string {
  const d = new Date(`${month}-01T12:00:00`);
  d.setMonth(d.getMonth() + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// —— 历史列表（累计 / 今日 共用一个组件）——

export function FocusHistory({ day, onBack }: { day: Day | ""; onBack: () => void }) {
  const [rows, setRows] = useState<FocusListItem[] | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    api.FocusList(day, 0).then((v) => !dead && setRows(v ?? [])).catch((e) => !dead && toastErr(e));
    return () => { dead = true; };
  }, [day]);

  if (detail) {
    return <FocusDetailInline focusID={detail} onBack={() => setDetail(null)} />;
  }
  return (
    <div className="fc-sheet">
      <header className="fc-sheet-head">
        <button className="fc-back" aria-label="返回" onClick={onBack}><I n="chevronLeft" size={14} /></button>
        <h3>{day ? `${formatDayCN(day)}的专注` : "累计专注记录"}</h3>
        <span className="fc-count">{rows ? `${rows.length} 条` : ""}</span>
      </header>
      <div className="fc-sheet-body">
        {rows === null && <div className="fc-loading">正在取记录…</div>}
        {rows?.length === 0 && <div className="fc-dim">还没有专注记录。第一次专注结束后就会出现在这里。</div>}
        {rows?.map((x) => (
          <button key={x.record.id} className="fc-hist-row" onClick={() => setDetail(x.record.id)}>
            <span className="fc-hist-day">{day ? (x.record.startAt ? new Date(x.record.startAt).toTimeString().slice(0, 5) : "补记") : x.record.day.slice(5).replace("-", "/")}</span>
            <span className="fc-hist-main">
              <b>{x.taskName}</b>
              <i>{FOCUS_TYPE_LABEL[x.record.type as FocusType]} · {fmtDuration(x.record.actualSec)}</i>
            </span>
            <span className="fc-hist-min">{toMinutes(x.record.actualSec)} 分</span>
            <I n="chevronRight" size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}

// 详情页在数据页里以「覆盖一层」的方式出现，避免和沉浸页抢同一块屏幕。
// key 带上改动次数：改完心得要能看到新值，重挂一次比手动同步 state 老实。
function FocusDetailInline({ focusID, onBack }: { focusID: string; onBack: () => void }) {
  const [stamp, setStamp] = useState(0);
  return <FocusDetail key={`${focusID}-${stamp}`} focusID={focusID} onBack={onBack} onChanged={() => setStamp((n) => n + 1)} />;
}

// —— 补记专注记录 ——

export function FocusManual({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<FocusType>(1);
  const [day, setDay] = useState<Day>(todayLocal());
  const [minutes, setMinutes] = useState(25);
  const [cycles, setCycles] = useState(1);
  const [note, setNote] = useState("");
  const [box, setBox] = useState<DOMRect | null>(null);
  const [busy, setBusy] = useState(false);

  function save() {
    if (busy) return;
    setBusy(true);
    api.FocusSave({
      type: tab, day, actualSec: tab === 2 ? minutes * cycles * 60 : minutes * 60,
      cycles: tab === 2 ? cycles : 0, note,
    }).then(() => { onBack(); }).catch(toastErr).finally(() => setBusy(false));
  }

  return (
    <div className="fc-sheet">
      <header className="fc-sheet-head">
        <button className="fc-back" aria-label="返回" onClick={onBack}><I n="chevronLeft" size={14} /></button>
        <h3>补记专注记录</h3>
        <button className="btn primary" onClick={save} disabled={busy}>保存</button>
      </header>
      <nav className="fc-tabs is-inner" role="tablist" aria-label="补记类型">
        {([1, 2, 3] as FocusType[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={"fc-tab" + (tab === t ? " is-sel" : "")} onClick={() => setTab(t)}>
            {FOCUS_TYPE_LABEL[t]}
          </button>
        ))}
      </nav>
      <div className="fc-sheet-body">
        <div className="fc-row">
          <span className="fc-lab">日期</span>
          <span className="fc-val">
            <button className="fc-chip" onClick={(e) => setBox(e.currentTarget.getBoundingClientRect())}>
              <I n="calendar" size={12} />{formatDayCN(day)}<I n="chevronDown" size={10} />
            </button>
          </span>
        </div>
        <div className="fc-row">
          <span className="fc-lab">{tab === 2 ? "每轮分钟" : "时长"}</span>
          <span className="fc-val"><Stepper value={minutes} min={1} max={240} unit="分" onChange={setMinutes} /></span>
        </div>
        {tab === 2 && (
          <div className="fc-row">
            <span className="fc-lab">轮数</span>
            <span className="fc-val"><Stepper value={cycles} min={1} max={12} unit="轮" onChange={setCycles} /></span>
          </div>
        )}
        <div className="fc-row">
          <span className="fc-lab">合计</span>
          <span className="fc-val is-strong">{fmtDuration((tab === 2 ? minutes * cycles : minutes) * 60)}</span>
        </div>
        <div className="fc-row is-col">
          <span className="fc-lab">心得</span>
          <textarea className="fc-note" placeholder="那天做了什么？一句话就好。" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      {box && (
        <ManualDateBox anchor={box} day={day} onPick={(d) => { setDay(d); setBox(null); }} onClose={() => setBox(null)} />
      )}
    </div>
  );
}

function ManualDateBox({ anchor, day, onPick, onClose }: { anchor: DOMRect; day: Day; onPick: (d: Day) => void; onClose: () => void }) {
  return (
    <Popover anchor={anchor} width={320} onClose={onClose}>
      <DatePanel variant="day" value={{ kind: 1, start: day }} onCommit={(d) => onPick(d.start || todayLocal())} onClose={onClose} />
    </Popover>
  );
}

function Stepper({ value, min, max, unit, onChange }: { value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <span className="fc-stepper">
      <button aria-label="减少" onClick={() => onChange(clamp(value - 1))}>-</button>
      <input aria-label={`时长（${unit}）`} value={value} onChange={(e) => onChange(clamp(Number(e.target.value.replace(/\D/g, "")) || min))} />
      <button aria-label="增加" onClick={() => onChange(clamp(value + 1))}>+</button>
      <i>{unit}</i>
    </span>
  );
}

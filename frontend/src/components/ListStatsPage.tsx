// ListStatsPage.tsx —— 清单统计（日 / 周 / 月三个页签）。
//
// 从清单页顶栏「统计」进入；与习惯统计不同，清单的口径不需要排期/补卡那套，
// 所以直接取一次 CalendarView（showDone=true），把实例按 status/clockedAt/分类标签优先级
// 在前端聚合（纯函数在 lib/listStat.ts）。三个页签共用同一套四块面板：
//   数据总览 / 打卡趋势（折线·柱状）/ 打卡分布（分类·标签·优先级）/ 自律指数（三角雷达）。
//
// 图表全部手写 SVG + CSS，不引第三方图表库：项目其它地方也是零图表依赖，
// 为一个页面引入 echarts 会白增几百 KB 的桌面安装包体积。

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { CalendarView, Category, Label } from "../api/types";
import { todayLocal } from "../lib/day";
import {
  DIMENSIONS, TABS, discipline, distribution, frame, overview, requestRange, trend,
  type Dimension, type Slice, type StatTab,
} from "../lib/listStat";
import { setPage, toastErr, useApp } from "../store/appStore";
import { TopBar } from "./chrome";
import { I } from "./ui";

export function ListStatsPage() {
  const { booted, revision } = useApp();
  const today = todayLocal();
  const [tab, setTab] = useState<StatTab>("day");
  const [anchor, setAnchor] = useState(today);
  const [view, setView] = useState<CalendarView | null>(null);
  const [nav, setNav] = useState<{ categories: Category[]; labels: Label[] }>({ categories: [], labels: [] });
  const [chart, setChart] = useState<"line" | "bar">("line");
  const [dim, setDim] = useState<Dimension>("category");

  const f = useMemo(() => frame(tab, anchor, today), [tab, anchor, today]);
  const occs = useMemo(() => view?.days.flatMap((d) => d.items) ?? [], [view]);
  const ov = useMemo(() => overview(occs), [occs]);
  const tr = useMemo(() => trend(occs, f), [occs, f]);
  const slices = useMemo(() => distribution(occs, dim, nav.categories, nav.labels), [occs, dim, nav]);
  const index = useMemo(() => discipline(ov, f.elapsedDays), [ov, f.elapsedDays]);

  useEffect(() => {
    if (!booted) return;
    let dead = false;
    api.CalendarView(requestRange(f))
      .then((v) => { if (!dead) { setView(v); } })
      .catch((e) => { if (!dead) { setView(null); toastErr(e); } });
    return () => { dead = true; };
  }, [booted, revision, f.start, f.end]);

  useEffect(() => {
    if (!booted) return;
    let dead = false;
    Promise.all([api.Categories(), api.Labels()])
      .then(([categories, labels]) => { if (!dead) setNav({ categories, labels }); })
      .catch(() => undefined);
    return () => { dead = true; };
  }, [booted, revision]);

  return (
    <>
      <TopBar
        tabs={
          <nav className="gtabs" role="tablist" aria-label="统计粒度">
            {TABS.map((t) => (
              <button key={t.k} role="tab" aria-selected={tab === t.k}
                className={"gtab" + (tab === t.k ? " is-active" : "")}
                onClick={() => { setTab(t.k); setAnchor(today); }}>{t.label}</button>
            ))}
          </nav>
        }
        extra={<button className="stats-back" onClick={() => setPage("lists")}><I n="chevronLeft" size={14} />返回清单</button>}
      />

      <main className="content ls-page">
        <header className="ls-datebar">
          <button className="icon-btn" aria-label="上一周期" onClick={() => setAnchor(f.prev)}><I n="chevronLeft" /></button>
          <span className="ls-date-title" data-testid="ls-title">{f.title}</span>
          <button className="icon-btn" aria-label="下一周期" onClick={() => setAnchor(f.next)}><I n="chevronRight" /></button>
          {!f.isCurrent && <button className="btn small" onClick={() => setAnchor(today)}>回到本期</button>}
          <span className="spacer" />
          <span className="ls-range">{f.start === f.end ? f.start : `${f.start} ~ ${f.end}`}</span>
        </header>

        {!view && <div className="ls-loading">正在统计…</div>}
        {view && (
          <div className="ls-body">
            {/* 数据总览：2×2，上排成功/失败，下排未打卡/打卡率 */}
            <section className="ls-card ls-overview">
              <header className="ls-card-head"><b>数据总览</b></header>
              <div className="ls-overview-grid">
                <div className="ls-metric is-success"><b>{ov.success}</b><span>成功打卡个数</span></div>
                <div className="ls-metric is-fail"><b>{ov.failed}</b><span>失败打卡个数</span></div>
                <div className="ls-metric is-pending"><b>{ov.pending}</b><span>未打卡个数</span></div>
                <div className="ls-metric is-rate"><b>{ov.rate}%</b><span>打卡率</span></div>
              </div>
            </section>

            {/* 打卡趋势 + 打卡分布并排（用户描述里同为「第三行」） */}
            <div className="ls-row2">
              <section className="ls-card ls-trend">
                <header className="ls-card-head">
                  <b>打卡趋势</b>
                  <div className="ls-seg" role="group" aria-label="图表类型">
                    <button className={chart === "line" ? "is-active" : ""} aria-pressed={chart === "line"} onClick={() => setChart("line")}>折线图</button>
                    <button className={chart === "bar" ? "is-active" : ""} aria-pressed={chart === "bar"} onClick={() => setChart("bar")}>柱状图</button>
                  </div>
                </header>
                <TrendChart values={tr} axis={f.axis} mode={chart} />
              </section>

              <section className="ls-card ls-dist">
                <header className="ls-card-head">
                  <b>打卡分布</b>
                  <DimPicker value={dim} onChange={setDim} />
                </header>
                {slices.length ? <Pie slices={slices} /> : <div className="ls-empty">暂无数据</div>}
              </section>
            </div>

            {/* 自律指数：掌控 / 高效 / 勤奋 三角雷达 */}
            <section className="ls-card ls-index">
              <header className="ls-card-head"><b>自律指数</b></header>
              <Radar value={index} />
            </section>
          </div>
        )}
      </main>
    </>
  );
}

/** 维度下拉：浮层用 fixed + 触发器真实 rect 落位，避免被可滚动内容区裁掉。 */
function DimPicker({ value, onChange }: { value: Dimension; onChange: (d: Dimension) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const label = DIMENSIONS.find((d) => d.k === value)?.label ?? "按分类";

  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const btn = btnRef.current, pop = popRef.current;
    if (!btn || !pop) return;
    const r = btn.getBoundingClientRect();
    let left = r.right - pop.offsetWidth;
    if (left < 8) left = 8;
    let top = r.bottom + 4;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 4);
    setPos({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node) || btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <>
      <button ref={btnRef} className="ls-dim-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label}<I n="chevronDown" size={12} />
      </button>
      {open && (
        <div ref={popRef} className="ls-dim-pop" role="menu" style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}>
          {DIMENSIONS.map((d) => (
            <button key={d.k} role="menuitem" className={d.k === value ? "is-active" : ""}
              onClick={() => { onChange(d.k); setOpen(false); }}>{d.label}</button>
          ))}
        </div>
      )}
    </>
  );
}

/** 趋势图：SVG 只画图形（viewBox 拉伸不变形），刻度文字交给 HTML。 */
function TrendChart({ values, axis, mode }: { values: number[]; axis: { key: string; label: string }[]; mode: "line" | "bar" }) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [plotW, setPlotW] = useState(680);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const measure = () => setPlotW(Math.max(120, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const max = Math.max(4, Math.ceil(Math.max(...values, 0) / 4) * 4);
  const H = 140;
  const y = (v: number) => H - (v / max) * (H - 8);
  const ticks = [max, max * 0.75, max * 0.5, max * 0.25, 0];
  const step = plotW / Math.max(axis.length, 1);
  const cx = (i: number) => step * i + step / 2;
  const barW = Math.max(2, Math.min(26, step * 0.5));
  const pts = values.map((v, i) => `${cx(i)},${y(v)}`).join(" ");

  return (
    <div className="ls-chart">
      <div className="ls-chart-y" aria-hidden>{ticks.map((t) => <span key={t}>{t}</span>)}</div>
      <div className="ls-chart-main">
        <div className="ls-chart-plot" ref={plotRef}>
          {ticks.map((_, i) => <i key={i} className="ls-gridline" style={{ top: `${(i / (ticks.length - 1)) * 100}%` }} />)}
          <svg className="ls-chart-svg" viewBox={`0 0 ${plotW} ${H}`} preserveAspectRatio="none" role="img" aria-label="打卡趋势图">
            {mode === "bar" ? values.map((v, i) => (
              <rect key={axis[i].key} x={cx(i) - barW / 2} y={y(v)} width={barW} height={H - y(v)} rx={2} className="ls-bar" />
            )) : (
              <>
                <polyline points={pts} className="ls-line" />
                {values.map((v, i) => <circle key={axis[i].key} cx={cx(i)} cy={y(v)} r={3.5} className="ls-dot" />)}
              </>
            )}
          </svg>
        </div>
        <div className="ls-chart-x" aria-hidden>
          {axis.map((a) => <span key={a.key}>{a.label}</span>)}
        </div>
      </div>
    </div>
  );
}

/** 饼图：真扇形（不是环形），单个分类退化成整圆避免 360° 弧路径失效。 */
function Pie({ slices }: { slices: Slice[] }) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  let acc = 0;
  const polar = (deg: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${70 + 54 * Math.cos(a)} ${70 + 54 * Math.sin(a)}`;
  };
  return (
    <div className="ls-pie-wrap">
      <svg className="ls-pie" viewBox="0 0 140 140" role="img" aria-label="打卡分布饼图">
        {slices.map((s) => {
          const from = (acc / total) * 360;
          acc += s.value;
          const to = (acc / total) * 360;
          if (to - from >= 359.99) return <circle key={s.key} cx={70} cy={70} r={54} fill={s.color} />;
          const large = to - from > 180 ? 1 : 0;
          const d = `M 70 70 L ${polar(from)} A 54 54 0 ${large} 1 ${polar(to)} Z`;
          return <path key={s.key} d={d} fill={s.color} stroke="var(--surface)" strokeWidth={1.5} />;
        })}
      </svg>
      <ul className="ls-legend">
        {slices.map((s) => (
          <li key={s.key} title={`${s.label}：${s.value} 次`}>
            <i style={{ background: s.color }} />
            <span className="ls-legend-name">{s.label}</span>
            <span className="ls-legend-val">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 三角雷达：顶点朝上=掌控，右下=高效，左下=勤奋；网格 25/50/75/100%。 */
function Radar({ value }: { value: { control: number; efficient: number; diligent: number } }) {
  const cx = 120, cy = 104, R = 74;
  const angle = [-90, 30, 150].map((d) => (d * Math.PI) / 180);
  const point = (i: number, ratio: number) =>
    `${cx + R * ratio * Math.cos(angle[i])},${cy + R * ratio * Math.sin(angle[i])}`;
  const tri = (ratio: number) => angle.map((_, i) => point(i, ratio)).join(" ");
  const vals = [value.control, value.efficient, value.diligent];
  const data = vals.map((v, i) => point(i, Math.max(0, Math.min(100, v)) / 100)).join(" ");
  const labels = [
    { name: "掌控", v: value.control, x: cx, y: 16, anchor: "middle" as const },
    { name: "高效", v: value.efficient, x: cx + R + 16, y: cy + R / 2 + 10, anchor: "start" as const },
    { name: "勤奋", v: value.diligent, x: cx - R - 16, y: cy + R / 2 + 10, anchor: "end" as const },
  ];
  return (
    <div className="ls-radar">
      <svg viewBox="0 0 240 220" role="img" aria-label={`自律指数：掌控 ${value.control}，高效 ${value.efficient}，勤奋 ${value.diligent}`}>
        {[0.25, 0.5, 0.75, 1].map((r) => <polygon key={r} points={tri(r)} className="ls-radar-grid" />)}
        {angle.map((_, i) => <line key={i} x1={cx} y1={cy} x2={cx + R * Math.cos(angle[i])} y2={cy + R * Math.sin(angle[i])} className="ls-radar-axis" />)}
        <polygon points={data} className="ls-radar-data" />
        {vals.map((v, i) => {
          const [px, py] = point(i, Math.max(0, Math.min(100, v)) / 100).split(",").map(Number);
          return <circle key={i} cx={px} cy={py} r={3.5} className="ls-radar-dot" />;
        })}
        {labels.map((l) => (
          <text key={l.name} x={l.x} y={l.y} textAnchor={l.anchor} className="ls-radar-label">{l.name} {l.v}</text>
        ))}
      </svg>
      <p className="ls-radar-note" title="掌控＝打卡率；高效＝成功打卡/已打卡；勤奋＝日均打卡数÷3（封顶 100）">掌控＝打卡率 · 高效＝成功率 · 勤奋＝日均投入</p>
    </div>
  );
}

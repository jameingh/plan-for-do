// 分钟滚轮：外圈一个圆，里面是能上下滑的分钟选择器。
//
// 番茄钟和倒计时都用它，所以只做一件事：给一个 [min,max] 的整数区间，滚/拖/点都行，
// 把选中的值 change 出去。以前仓库里有三份私有滚轮（ItemPanels 的两份 + HabitCreate 一份），
// 它们只认点击；这里要的是「能上下滑」，所以另写一个，不去改那三处已经测过的行为。
import { useEffect, useMemo, useRef } from "react";

const ITEM_H = 28;
/** 上下各垫 (visible-1)/2 格，选中项才可能真的停在正中。
 *  不垫的话第一格只能贴到顶（滚不动了），而中间那格其实是「选中项下面那一格」——
 *  2026-11-08 用户就是指着「25 分在上面、26 分在中间」提出来的。 */
const padOf = (visible: number) => ((visible - 1) / 2) * ITEM_H;

export function FocusWheel({ value, min, max, onChange, unit = "分", visible = 3, label }: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  unit?: string;
  /** 一屏露几格；3 格最像滚轮，中间那格就是当前值 */
  visible?: number;
  label?: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const items = useMemo(() => {
    const out: number[] = [];
    for (let v = min; v <= max; v++) out.push(v);
    return out;
  }, [min, max]);
  const clampValue = (v: number) => Math.min(max, Math.max(min, v));

  // 外部改了值（比如点了「+1」或重置默认）要把它滚到正中。
  // 上下各垫了 padOf 格之后，第 i 格的中心正好落在 scrollTop = i * ITEM_H 处。
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const want = (clampValue(value) - min) * ITEM_H;
    if (Math.abs(el.scrollTop - want) > 1) el.scrollTop = want;
  }, [value, min]);

  function commitTop() {
    const el = boxRef.current;
    if (!el) return;
    const next = clampValue(min + Math.round(el.scrollTop / ITEM_H));
    if (next !== value) onChange(next);
  }

  return (
    <div className="fc-wheel-wrap" role="group" aria-label={label}>
      <div className="fc-wheel-mask is-top" aria-hidden="true" />
      <div className="fc-wheel-mask is-bottom" aria-hidden="true" />
      <div
        ref={boxRef}
        className="fc-wheel"
        style={{ height: visible * ITEM_H, scrollPaddingBlock: `${padOf(visible)}px` }}
        onScroll={() => {
          // 惯性滚动会连发几十个 scroll 事件，落定后取一次就够
          const el = boxRef.current;
          if (!el) return;
          window.clearTimeout((el as HTMLDivElement & { t?: number }).t);
          (el as HTMLDivElement & { t?: number }).t = window.setTimeout(commitTop, 140);
        }}
      >
        <div className="fc-wheel-pad" style={{ height: padOf(visible) }} aria-hidden="true" />
        {items.map((v) => (
          <button
            key={v}
            type="button"
            className={"fc-wheel-item" + (v === clampValue(value) ? " is-sel" : "")}
            style={{ height: ITEM_H, lineHeight: `${ITEM_H}px` }}
            onClick={() => onChange(v)}
          >
            {v}
            <i>{unit}</i>
          </button>
        ))}
        <div className="fc-wheel-pad" style={{ height: padOf(visible) }} aria-hidden="true" />
      </div>
      <div className="fc-wheel-needle" aria-hidden="true" />
    </div>
  );
}

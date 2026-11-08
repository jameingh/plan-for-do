// 关联任务弹窗：三个计时子模块与专注详情页共用。
//
// 版式按用户的规格：标题位置就是日期选择器（默认「全部待办任务」），点它开日历；
// 第二行两个页签——待办事项清单（默认）与习惯打卡；点一条即关联并关闭。
// 「已关联的任务」显示在子模块的标题位，再点它可以清除或换一条。
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { DateSpec, FocusCandidate } from "../api/types";
import { toastErr } from "../store/appStore";
import { formatDayCN, todayLocal } from "../lib/day";
import type { FocusTask } from "../lib/focus";
import { DatePanel, Popover } from "./ItemPanels";
import { Glyph, I, useEscClose } from "./ui";

type Tab = "item" | "habit";

export function FocusPicker({ picked, onPick, onClose }: {
  picked: FocusTask | null;
  onPick: (t: FocusTask) => void;
  onClose: () => void;
}) {
  useEscClose(onClose);
  // day 为空 = 全部待办（逾期 + 今天 + 往后），这是规格里的默认态
  const [day, setDay] = useState("");
  const [tab, setTab] = useState<Tab>("item");
  const [rows, setRows] = useState<FocusCandidate[] | null>(null);
  const [dateBox, setDateBox] = useState<DOMRect | null>(null);
  const revision = day + "|" + tab;
  const dateLabel = useMemo(() => (day ? formatDayCN(day) : "全部待办任务"), [day]);

  useEffect(() => {
    let dead = false;
    setRows(null);
    api.FocusCandidates({ day, tab })
      .then((v) => !dead && setRows(v ?? []))
      .catch((e) => !dead && toastErr(e));
    return () => { dead = true; };
  }, [revision, day, tab]);

  function choose(c: FocusCandidate) {
    onPick({ kind: c.kind, id: c.id, name: c.name, day: c.kind === "item" ? c.day : undefined });
    onClose();
  }

  return (
    <>
      <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal fc-pick" role="dialog" aria-label="关联任务">
          <header className="fc-pick-head">
            <button className="fc-pick-date" onClick={(e) => setDateBox(e.currentTarget.getBoundingClientRect())}>
              <I n="calendar" size={12} />
              <span>{dateLabel}</span>
              <I n="chevronDown" size={10} />
            </button>
            <button className="icon-btn" aria-label="关闭" onClick={onClose}><I n="close" /></button>
          </header>

          <nav className="fc-pick-tabs" role="tablist" aria-label="关联对象">
            {([["item", "待办事项清单"], ["habit", "习惯打卡"]] as [Tab, string][]).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k}
                className={"fc-pick-tab" + (tab === k ? " is-sel" : "")} onClick={() => setTab(k)}>{label}</button>
            ))}
          </nav>

          <div className="fc-pick-list">
            {rows === null && <div className="fc-pick-empty">正在取任务…</div>}
            {rows?.length === 0 && (
              <div className="fc-pick-empty">{tab === "item" ? "这个范围里没有待办事项。" : "还没有习惯。"}</div>
            )}
            {rows?.map((c) => (
              <button key={c.kind + c.id} className={"fc-pick-row" + (picked?.id === c.id ? " is-sel" : "")}
                onClick={() => choose(c)}>
                {c.kind === "habit"
                  ? <Glyph kind={c.icon.kind} glyph={c.icon.ref} color={c.icon.color} size={22} round />
                  : <i className="fc-pick-dot" />}
                <span className="fc-pick-name">{c.name}</span>
                <span className="fc-pick-meta">
                  {c.kind === "item" ? `${c.day === todayLocal() ? "今天" : c.day.slice(5).replace("-", "/")} ${c.timeText}` : c.timeText}
                  {c.group ? ` · ${c.group}` : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {dateBox && (
        <Popover anchor={dateBox} width={320} onClose={() => setDateBox(null)}>
          <div className="fc-pick-cal">
            <DatePanel
              variant="day"
              value={{ kind: 1, start: day || todayLocal() } as DateSpec}
              onCommit={(d) => { setDay(d.start || ""); setDateBox(null); }}
              onClose={() => setDateBox(null)}
            />
          </div>
        </Popover>
      )}
    </>
  );
}

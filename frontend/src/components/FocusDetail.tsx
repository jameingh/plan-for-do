// 专注详情页：一次专注的全部事实 + 时间轴 + 删除。
//
// 三个入口都进这同一个页面：沉浸页/结算页左下角的「专注详情」、历史列表每一项右侧的箭头。
// 编辑口径跟着内核走：实时记录只有「心得」与「关联任务」可改，时长/日期/类型是计时器算出来的真值；
// 补记记录整条都能重写（它本来就是手填的）。
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { FocusListItem } from "../api/types";
import { toast, toastErr, useApp } from "../store/appStore";
import { formatClockCN, formatDayCN } from "../lib/day";
import { FOCUS_TYPE_LABEL, fmtDuration, type FocusTask } from "../lib/focus";
import { FocusPicker } from "./FocusPicker";
import { ChoiceModal, Empty, I } from "./ui";

const STATUS_LABEL: Record<number, string> = { 1: "进行中", 2: "已暂停", 3: "已结束" };

export function FocusDetail({ focusID, onBack, onChanged }: {
  focusID: string;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { booted, revision } = useApp();
  const [item, setItem] = useState<FocusListItem | null>(null);
  const [note, setNote] = useState("");
  const [picking, setPicking] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (!booted) return;
    let dead = false;
    api.Focus(focusID)
      .then((v) => {
        if (dead || !v) return;
        setItem(v);
        setNote(v.record.note ?? "");
      })
      .catch((e) => !dead && toastErr(e));
    return () => { dead = true; };
  }, [booted, revision, focusID]);

  if (!item) return <div className="fc-detail"><Empty text="正在取这条专注…" /></div>;
  const r = item.record;

  const live = r.status !== 3;          // 进行中/暂停：内核不允许改事实字段
  const manual = r.source === 2;
  const task: FocusTask | null = r.itemId
    ? { kind: "item", id: r.itemId, name: item.taskName }
    : r.habitId
      ? { kind: "habit", id: r.habitId, name: item.taskName }
      : null;

  function commit(patch: { note?: string; itemId?: string; habitId?: string }) {
    api.FocusSave({
      id: r!.id, type: r!.type, day: r!.day, actualSec: r!.actualSec, cycles: r!.cycles,
      itemId: patch.itemId ?? r!.itemId, habitId: patch.habitId ?? r!.habitId,
      note: patch.note ?? note,
    }).then(() => {
      onChanged();
      toast("已保存");
    }).catch(toastErr);
  }

  return (
    <div className="fc-detail">
      <header className="fc-detail-head">
        <button className="fc-back" aria-label="返回" onClick={onBack}><I n="chevronLeft" size={14} /></button>
        <h3>专注详情</h3>
        <span className="fc-detail-status">{live ? `${STATUS_LABEL[r.status]} · 先结束才能改事实字段` : STATUS_LABEL[r.status]}</span>
      </header>

      <div className="fc-detail-body">
        <section className="fc-card">
          <div className="fc-row">
            <span className="fc-lab">专注时间</span>
            <span className="fc-val">
              {r.startAt
                ? `${formatDayCN(r.day)} ${formatClockCN(r.startAt)} - ${r.endAt ? formatClockCN(r.endAt) : "…"}`
                : `${formatDayCN(r.day)}（补记，没有真实起止时刻）`}
            </span>
          </div>
          <div className="fc-row">
            <span className="fc-lab">专注时长</span>
            <span className="fc-val is-strong">{fmtDuration(r.actualSec || r.accumSec)}</span>
          </div>
          {r.restSec > 0 && (
            <div className="fc-row">
              <span className="fc-lab">其中休息</span>
              <span className="fc-val">{fmtDuration(r.restSec)}（不计入专注时长）</span>
            </div>
          )}
          {r.type === 2 && (
            <div className="fc-row">
              <span className="fc-lab">番茄轮次</span>
              <span className="fc-val">{r.cycles} 轮{r.pomodoro ? ` · 计划 ${r.pomodoro.cycles} 轮` : ""}</span>
            </div>
          )}
          <div className="fc-row">
            <span className="fc-lab">专注类型</span>
            <span className="fc-val">{FOCUS_TYPE_LABEL[r.type]}</span>
          </div>
          <div className="fc-row">
            <span className="fc-lab">关联任务</span>
            <span className="fc-val">
              {task && item.taskName !== "未关联任务" ? task.name : <span className="fc-dim">未关联</span>}
              {!live && (
                <button className="fc-mini-btn" onClick={() => setPicking(true)}>更换</button>
              )}
              {!live && task && (
                <button className="fc-mini-btn" onClick={() => commit({ itemId: "", habitId: "" })}>清除</button>
              )}
              {live && <span className="fc-dim">（进行中不能换）</span>}
            </span>
          </div>
        </section>

        <section className="fc-card">
          <div className="fc-card-title">专注心得</div>
          <textarea
            className="fc-note"
            placeholder={live ? "结束后就能写心得。" : "当时怎么想的？"}
            value={note}
            disabled={live && !manual}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => { if (!live && note !== (r!.note ?? "")) commit({ note }); }}
          />
        </section>

        <section className="fc-card">
          <div className="fc-card-title">事件时间轴</div>
          <ol className="fc-timeline">
            {(r.events ?? []).map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <span className="fc-tl-time">{e.at ? formatClockCN(e.at) : ""}</span>
                <span className="fc-tl-dot" aria-hidden="true" />
                <span className="fc-tl-label">{e.label}</span>
              </li>
            ))}
            {!r.events?.length && <li className="fc-dim">还没有事件。</li>}
          </ol>
        </section>

        <button className="fc-danger" onClick={() => setConfirmDel(true)}>删除这条专注</button>
      </div>

      {picking && (
        <FocusPicker
          picked={task}
          onPick={(t) => commit(t.kind === "item" ? { itemId: t.id, habitId: "" } : { itemId: "", habitId: t.id })}
          onClose={() => setPicking(false)}
        />
      )}

      {confirmDel && (
        <ChoiceModal
          title="删除专注记录"
          question="删除后这条记录在所有设备上都会消失，确定吗？"
          choices={[{ label: "删除", value: true, danger: true }, { label: "取消", value: false }]}
          onPick={(go) => {
            setConfirmDel(false);
            if (!go) return;
            api.FocusDelete(r.id).then(() => { toast("已删除"); onBack(); }).catch(toastErr);
          }}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </div>
  );
}

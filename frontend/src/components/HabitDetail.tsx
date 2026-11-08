// HabitDetail.tsx —— 习惯详情面板：月打卡进度、总进度、打卡日志（按日期分组、可写心得）。

import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Habit, HabitMark, HabitStats } from "../api/types";
import { format, nowHHMM, todayLocal } from "../lib/day";
import { bumpRevision, markSaved, toastErr } from "../store/appStore";
import { Empty, FieldError, I, useEscClose } from "./ui";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)) || "未知错误";

export function HabitDetail({ habit, month, units, onEdit, onClose }: { habit: Habit; month: string; units: { id: string; name: string }[]; onEdit: () => void; onClose: () => void }) {
  const [stats, setStats] = useState<HabitStats | null>(null);
  const [marks, setMarks] = useState<HabitMark[]>([]);
  const [newText, setNewText] = useState("");
  const [newDay, setNewDay] = useState(todayLocal());
  const [err, setErr] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);

  const unitName = units.find((u) => u.id === habit.unitId)?.name ?? "";

  const reload = () => {
    api.HabitStats(habit.id, month).then(setStats).catch(toastErr);
    api.HabitMarks(habit.id).then(setMarks).catch(() => setMarks([]));
  };
  useEffect(reload, [habit.id, month]);

  async function addMark() {
    if (!newText.trim()) return;
    setErr("");
    try {
      await api.SaveHabitMark({ habitId: habit.id, day: newDay, time: nowHHMM(), text: newText.trim() });
      setNewText("");
      reload();
      bumpRevision();
      markSaved();
    } catch (e) {
      setErr(errText(e));
    }
  }

  async function delHabit() {
    setConfirmDel(false);
    try {
      await api.DeleteHabit(habit.id);
      onClose();
      bumpRevision();
    } catch (e) {
      setErr(errText(e));
    }
  }

  const byDay = new Map<string, HabitMark[]>();
  for (const m of marks) {
    if (!byDay.has(m.day)) byDay.set(m.day, []);
    byDay.get(m.day)!.push(m);
  }

  return (
    <div className="habit-modal-body" onMouseDown={(e) => e.stopPropagation()}>
      <header className="item-modal-head">
        <span className="im-title" style={{ flex: 1, margin: 0 }}>{habit.name}</span>
        <button className="icon-btn" title="编辑习惯" aria-label="编辑习惯" onClick={onEdit}><I n="pencil" size={14} /></button>
        <button className="icon-btn danger" title="删除习惯" aria-label="删除习惯" onClick={() => setConfirmDel(true)}><I n="trash" size={14} /></button>
        <button className="icon-btn im-more" aria-label="关闭（Esc）" title="关闭（Esc）" onClick={onClose}><I n="close" size={14} /></button>
      </header>

      <h5 className="section-title">月打卡进度 · {month.replace("-", "年")}月</h5>
      {stats ? (
        <>
          <div className="stats-grid">
            <div className="stat-box"><b>{stats.planned}</b><div className="lbl">计划打卡</div></div>
            <div className="stat-box"><b>{stats.actual}</b><div className="lbl">实际打卡</div></div>
            <div className="stat-box" title={stats.pending > 0 ? `今天还没过完，剩下 ${stats.pending} 天不计入错过` : undefined}><b>{stats.missed}</b><div className="lbl">错过打卡</div></div>
            <div className="stat-box"><b>{stats.ratio}%</b><div className="lbl">完成度</div></div>
          </div>
          <div className="progress-bar" style={{ marginTop: 8 }}><div style={{ width: `${Math.min(100, stats.ratio)}%` }} /></div>

          <h5 className="section-title" style={{ marginTop: 16 }}>打卡总进度</h5>
          <div className="stats-grid">
            <div className="stat-box"><b style={{ fontSize: 14 }}>{format(stats.startDay)}</b><div className="lbl">开始日期</div></div>
            <div className="stat-box"><b>{stats.daysSince}</b><div className="lbl">距今天数</div></div>
            <div className="stat-box"><b>{stats.totalDays}</b><div className="lbl">打卡总天数</div></div>
            <div className="stat-box"><b>{stats.longestStreak}</b><div className="lbl">最长连续</div></div>
          </div>
        </>
      ) : (
        <Empty text="统计加载中…" />
      )}

      <h5 className="section-title" style={{ marginTop: 16 }}>打卡日志</h5>
      <div className="field-row" style={{ marginBottom: 8 }}>
        <input type="date" className="input" style={{ width: 132 }} value={newDay} onChange={(e) => setNewDay(e.target.value)} />
        <input className={"input" + (err ? " is-error" : "")} placeholder="写心得，回车保存" value={newText}
          onChange={(e) => { setNewText(e.target.value); if (err) setErr(""); }} onKeyDown={(e) => e.key === "Enter" && void addMark()} />
        <button className="btn primary" disabled={!newText.trim()} onClick={() => void addMark()}>记一条</button>
      </div>
      <FieldError text={err} />
      {marks.length === 0 && <Empty text="还没有打卡日志。" />}
      {[...byDay.entries()].map(([day, list]) => (
        <div key={day} style={{ marginBottom: 8 }}>
          <div className="muted small">{format(day)}</div>
          {list.map((m) => (
            <div key={m.id} className="mark-row">
              <span className="muted small" style={{ width: 38, flex: "none" }}>{m.time}</span>
              <input className="input" defaultValue={m.text} onBlur={(e) => {
                if (!e.target.value.trim() || e.target.value === m.text) return;
                api.SaveHabitMark({ habitId: habit.id, id: m.id, day: m.day, time: m.time, text: e.target.value }).then(() => { reload(); markSaved(); }).catch(toastErr);
              }} />
              <button className="icon-btn" title="删除日志" aria-label="删除日志" onClick={() => { api.DeleteHabitMark(m.id).then(reload).catch(toastErr); }}><I n="close" size={12} /></button>
            </div>
          ))}
        </div>
      ))}
      <div className="muted small">
        量化习惯每次打卡 {habit.perClock || 1}{unitName}，每日目标 {habit.dailyTarget || 1}{unitName || "次"}；可回溯补打卡 {habit.backfillDays} 天。
      </div>

      {confirmDel && (
        <div className="scope-bar">
          <span>删除习惯？打卡历史会保留（内核行为）</span>
          <button className="btn small danger" onClick={() => void delHabit()}>确定删除</button>
          <button className="btn small" onClick={() => setConfirmDel(false)}>取消</button>
        </div>
      )}
    </div>
  );
}

/**
 * 打卡心得弹窗（参考站的 HabitClockModule）：打完卡弹一个只写心得的小窗。
 * 「不再提示」会把习惯的 popMark 关掉——参考站那颗开关就是这么用的，
 * 所以这里必须回写习惯本体，不能只把弹窗藏起来。
 */
export function HabitMarkDialog({ habit, day, onClose }: { habit: Habit; day: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  useEscClose(onClose);

  async function save(stopAsking: boolean) {
    setErr("");
    try {
      if (text.trim()) {
        await api.SaveHabitMark({ habitId: habit.id, day, time: nowHHMM(), text: text.trim() });
      }
      if (stopAsking) {
        await api.SaveHabit({
          id: habit.id, name: habit.name, icon: habit.icon, context: habit.context, freq: habit.freq,
          mode: habit.mode, autoClock: habit.autoClock, unitId: habit.unitId, dailyTarget: habit.dailyTarget,
          perClock: habit.perClock, reminders: habit.reminders ?? [], popMark: false,
          startDay: habit.startDay, backfillDays: habit.backfillDays,
        });
      }
      bumpRevision();
      markSaved();
      onClose();
    } catch (e) {
      setErr(errText(e));
    }
  }

  return (
    <div className="habit-modal is-mark" role="dialog" aria-label="打卡心得">
      <div className="hm-head">
        <span className="hm-title">打卡成功</span>
        <button className="hm-close" aria-label="关闭" title="关闭" onClick={onClose}><I n="close" size={11} /></button>
      </div>
      <div className="hm-mark-tip">{habit.name} · {format(day)}</div>
      <textarea className="hm-mark-text" value={text} maxLength={300} placeholder="记录一下打卡心得吧~" aria-label="打卡心得"
        autoFocus onChange={(e) => setText(e.target.value)} />
      {err && <FieldError text={err} />}
      <div className="hm-foot">
        <button className="cc-btn" onClick={() => void save(true)}>不再提示</button>
        <button className="cc-btn is-primary" onClick={() => void save(false)}>确定</button>
      </div>
    </div>
  );
}

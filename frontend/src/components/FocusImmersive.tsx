// 沉浸式专注页 + 结束确认 + 结算页。
//
// 三个子模块进的是同一套沉浸版式，只是走表方向不同：
//   · 正计时：从 0 往上走，没有目标；
//   · 倒计时：从选定的分钟数往下减，走到 0 视为目标达成；
//   · 番茄钟：按配置一轮一轮走。一轮专注走完 → 记轮数 → 进休息（休息不计时：内核在休息期
//     把段起点清空）→ 休息走完 → 下一轮。最后一轮专注结束就直接结算，不再补一次休息。
// 时钟只信内核的账本：本地每秒算 accumSec + (now - segmentStart)，每 30 秒打一次 FocusTick 心跳，
// 于是应用被关掉时最多丢一个心跳周期的精度（内核的 FocusRecover 也只按这个宽限期补）。
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { FocusRecord } from "../api/types";
import { toast, toastErr } from "../store/appStore";
import { cyclesLeft, fmtClock, fmtDuration, restPhaseAfter, restSecOf, type FocusTask } from "../lib/focus";
import { I } from "./ui";

const HEARTBEAT_SEC = 30; // 与内核 focusRecoverGrace 对齐
const RUNNING = 1; // 2 = 暂停，3 = 已结束（内核 model.FocusStatus）

/**
 * 送一条系统通知（番茄轮次切换、倒计时到点这类「人可能已经走开」的时刻）。
 *
 * 错误一律吞掉：通知是锦上添花，弹不出去不该把计时流程打断。
 * 平台不支持与「设置里静音了」都由内核返回 nil 直接通过，前端不需要分支。
 */
function pushNotify(title: string, body: string) {
  void api.PushNotify(title, body).catch(() => undefined);
}

interface Rest { phase: "short" | "long"; left: number; total: number; pending: boolean }

export function FocusImmersive({ record, task, onChange, onClose, onSettled, onOpenDetail }: {
  record: FocusRecord;
  task: FocusTask | null;
  onChange: (r: FocusRecord) => void;
  onClose: () => void;
  onSettled: (r: FocusRecord) => void;
  onOpenDetail: (id: string) => void;
}) {
  const [r, setR] = useState<FocusRecord>(record);
  const [endBox, setEndBox] = useState(false);
  const [rest, setRest] = useState<Rest | null>(null);
  const [, setNowTick] = useState(0);
  const busy = useRef(false);

  const plan = r.pomodoro ?? { cycles: 4, shortRest: 1, longRest: 2, longEvery: 4, autoRest: true, focusSec: 25 * 60 };
  const isPomo = r.type === 2;

  const put = useCallback((next: FocusRecord | null) => {
    if (!next) return;
    setR(next);
    onChange(next);
  }, [onChange]);

  /** 所有对内核的写都走这里：一次只允许一个在飞，界面不会被自己的重渲染喂出双份事件。 */
  const run = useCallback((fn: () => Promise<FocusRecord | null>) => {
    if (busy.current) return;
    busy.current = true;
    fn().then(put).catch(toastErr).finally(() => { busy.current = false; });
  }, [put]);

  // 每秒推进一次渲染（时钟数字与到点判定都靠它）
  useEffect(() => {
    const t = window.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const elapsed = r.status === RUNNING && r.segmentStart
    ? r.accumSec + Math.max(0, Math.round((Date.now() - Date.parse(r.segmentStart)) / 1000))
    : r.accumSec;
  const target = r.targetSec > 0 ? r.targetSec : 0;
  // 番茄钟的「本轮剩余」要减掉本轮开始时的累计基准，否则第二轮一睁眼就「已超时」，
  // 一路自动冲到最后一轮。正计时/倒计时没有轮次，roundBase 恒为 0。
  const roundSec = Math.max(0, elapsed - (r.roundBase ?? 0));
  const left = target > 0 ? Math.max(0, target - roundSec) : 0;

  // 心跳：只在走表时打。暂停/休息期间段起点已清空，打了也是空转。
  useEffect(() => {
    if (r.status !== RUNNING) return;
    const t = window.setInterval(() => {
      api.FocusTick(r.id).then(put).catch(() => { /* 心跳失败不拦界面，下一跳会补上 */ });
    }, HEARTBEAT_SEC * 1000);
    return () => window.clearInterval(t);
  }, [r.id, r.status, put]);

  // 倒计时到点 = 目标达成，直接保存并进结算
  useEffect(() => {
    if (isPomo || r.status !== RUNNING || target === 0 || left > 0) return;
    pushNotify("功到 · 专注目标达成", fmtDuration(target) + " 走完了，去结算页写一句心得");
    run(() => api.FocusFinish(r.id, true).then((done) => { if (done) onSettled(done); return null; }));
  }, [left, r.status, target, isPomo, r.id, run, onSettled]);

  // 番茄：一轮专注到点 → 记轮数 → 进休息（或最后一轮直接结算）
  useEffect(() => {
    if (!isPomo || rest || r.status !== RUNNING || target === 0 || left > 0) return;
    run(() => api.FocusPhaseEnd(r.id, "focus", 0).then((after) => {
      const done = after?.cycles ?? 0;
      if (cyclesLeft(done, plan) === 0) {
        pushNotify("功到 · 番茄全部完成", `${done} 轮都走完了，来写一句专注心得`);
        return api.FocusFinish(r.id, true).then((fin) => { if (fin) onSettled(fin); return null; });
      }
      const phase = restPhaseAfter(done, plan) as "short" | "long";
      const sec = restSecOf(plan, phase);
      // 轮次切换是「人可能已经走开」的时刻，应用内的提示条看不到，所以走系统通知。
      pushNotify("功到 · 第 " + (done) + " 轮结束", `该${phase === "long" ? "长" : "短"}休息 ${Math.round(sec / 60)} 分钟`);
      return api.FocusRestStart(r.id, phase).then((x) => {
        setRest({ phase, left: sec, total: sec, pending: !plan.autoRest });
        return x;
      });
    }));
  }, [isPomo, rest, left, r.status, r.id, target, plan, run, onSettled]);

  // 休息倒计时（纯界面行为；内核只在休息结束时收一次秒数）
  useEffect(() => {
    if (!rest || rest.pending || rest.left <= 0) return;
    const t = window.setInterval(() => setRest((v) => (v ? { ...v, left: Math.max(0, v.left - 1) } : v)), 1000);
    return () => window.clearInterval(t);
  }, [rest?.pending, rest?.left === 0, rest]);

  function commitRest(sec: number) {
    if (!rest) return;
    const snapshot = rest;
    setRest(null);
    if (plan.autoRest && cyclesLeft(r.cycles, plan) > 0) pushNotify("功到 · 休息结束", "下一轮开始了，回到专注上");
    run(() => api.FocusPhaseEnd(r.id, snapshot.phase, sec).then((x) => {
      if (!x) return null;
      // 自动休息开着就一路走到底；关着就把「继续」留给用户按
      if (plan.autoRest && cyclesLeft(x.cycles, plan) > 0) return api.FocusResume(r.id);
      return x;
    }));
  }

  useEffect(() => {
    if (!rest || rest.pending || rest.left > 0) return;
    commitRest(rest.total);
  }, [rest]);

  const finish = (save: boolean) => {
    setEndBox(false);
    run(() => (save
      ? api.FocusFinish(r.id, true).then((done) => { if (done) onSettled(done); return null; })
      : api.FocusFinish(r.id, false).then(() => { onClose(); return null; })));
  };

  const resting = !!rest;
  const title = isPomo
    ? resting ? (rest!.phase === "long" ? "长休息" : "短休息") : `第 ${Math.min(r.cycles + 1, plan.cycles)} / ${plan.cycles} 轮`
    : r.type === 1 ? "正计时" : "倒计时";
  const shown = resting ? rest!.left : target > 0 ? left : elapsed;
  const running = r.status === RUNNING;

  return (
    <div className="fc-immersive" role="dialog" aria-label="专注中">
      <button className="fc-escape" aria-label="退出沉浸" title="退出沉浸（专注继续进行中）" onClick={onClose}>
        <I n="close" size={16} />
      </button>

      <div className="fc-immer-head">
        {task ? (
          <span className="fc-immer-task"><I n="target" size={12} />{task.name}</span>
        ) : (
          <span className="fc-immer-task is-none">未关联任务</span>
        )}
        <span className="fc-immer-phase">{title}</span>
      </div>

      <div className={"fc-clock" + (resting ? " is-rest" : "")}>
        <span className="fc-clock-num">{fmtClock(shown)}</span>
        <span className="fc-clock-sub">
          {resting ? "休息中，不计入专注时长" : target > 0 ? `目标 ${fmtDuration(target)}` : `已专注 ${fmtDuration(elapsed)}`}
        </span>
      </div>

      <div className="fc-immer-actions">
        {resting && !rest!.pending && (
          <button className="fc-big-btn" onClick={() => commitRest(rest!.total - rest!.left)}>跳过休息</button>
        )}
        {resting && rest!.pending && (
          <button className="fc-big-btn primary" onClick={() => setRest({ ...rest!, pending: false })}>开始休息</button>
        )}
        {!resting && running && (
          <button className="fc-big-btn" onClick={() => run(() => api.FocusPause(r.id))}>暂停</button>
        )}
        {!resting && !running && (
          <>
            <button className="fc-big-btn primary" onClick={() => run(() => api.FocusResume(r.id))}>继续</button>
            <button className="fc-big-btn" onClick={() => setEndBox(true)}>结束</button>
          </>
        )}
        {running && resting && <button className="fc-big-btn" onClick={() => setEndBox(true)}>结束</button>}
      </div>

      <div className="fc-immer-foot">
        <button className="fc-detail-link" onClick={() => onOpenDetail(r.id)}>
          <I n="chevronLeft" size={12} />专注详情
        </button>
        <span className="fc-immer-tip">{running ? "计时进行中" : resting ? "休息待开始" : "已暂停"}</span>
      </div>

      {endBox && (
        <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setEndBox(false)}>
          <div className="modal fc-end-box" role="dialog" aria-label="当前专注进行中">
            <header className="modal-head"><h3>当前专注进行中</h3></header>
            <div className="modal-body">
              <p className="fc-end-tip">这次专注已经走了 {fmtDuration(elapsed)}。</p>
              <button className="fc-end-btn primary" onClick={() => finish(true)}>结束（保存记录）</button>
              <button className="fc-end-btn" onClick={() => finish(false)}>放弃（不保存）</button>
              <button className="fc-end-btn" onClick={() => setEndBox(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 结算页：目标达成 + 心得输入 + 左下角「专注详情」。
 *  心得直接写进记录（内核的 FocusSave 对实时记录只认心得与关联任务两处改动），
 *  所以这里没有「先保存再离开」的顺序感：改了就是落库，离开时补一次静默保存。 */
export function FocusSettle({ record, onClose, onOpenDetail }: {
  record: FocusRecord;
  onClose: () => void;
  onOpenDetail: (id: string) => void;
}) {
  const [note, setNote] = useState(record.note ?? "");
  const [dirty, setDirty] = useState(false);
  const busy = useRef(false);

  /** 落库。silent = 不弹 toast（用于「离开时顺手存一下」）。 */
  function persist(silent: boolean): Promise<void> {
    if (busy.current) return Promise.resolve();
    busy.current = true;
    return api.FocusSave({
      id: record.id, type: record.type, day: record.day, actualSec: record.actualSec,
      cycles: record.cycles, itemId: record.itemId, habitId: record.habitId, note,
    }).then(() => {
      if (!silent) toast("已保存");
      setDirty(false);
    }).catch((e) => { toastErr(e); }).finally(() => { busy.current = false; });
  }

  /** 保存后回到子模块那一屏（开始专注的页面）——结算页不是一个要停留的地方。 */
  const saveAndLeave = () => void persist(false).then(onClose);
  const leave = () => (dirty && note ? persist(true) : Promise.resolve()).then(onClose);

  return (
    <div className="fc-immersive is-settle" role="dialog" aria-label="专注目标达成">
      <button className="fc-escape" aria-label="关闭" onClick={leave}>
        <I n="close" size={16} />
      </button>
      <div className="fc-settle-mark" aria-hidden="true"><I n="check" size={22} /></div>
      <h2 className="fc-settle-title">专注目标达成</h2>
      <p className="fc-settle-sub">
        {fmtDuration(record.actualSec)}
        {record.type === 2 ? ` · ${record.cycles} 轮番茄` : ""}
        {record.restSec > 0 ? ` · 休息 ${fmtDuration(record.restSec)}` : ""}
      </p>
      <textarea
        className="fc-settle-note"
        placeholder="此刻在想什么？一句话记下，回头看得上用。"
        value={note}
        onChange={(e) => { setNote(e.target.value); setDirty(true); }}
      />
      <div className="fc-settle-foot">
        <button className="fc-detail-link" onClick={() => onOpenDetail(record.id)}>
          <I n="chevronLeft" size={12} />专注详情
        </button>
        <span className="grow" />
        <button className="btn" onClick={leave}>返回</button>
        <button className="btn primary" onClick={saveAndLeave}>保存</button>
      </div>
    </div>
  );
}

// 专注模块外壳：正计时 / 番茄钟 / 倒计时 / 数据 四个页签。
//
// 三个计时子模块的行结构按规格来：关联任务 → 计时器（或分钟滚轮）→（番茄还有设置）→ 开始专注。
// 已关联的任务显示在子模块的标题位，再点它可以更换或清除。
// 进行中的专注是独占的：内核只允许一条未结束的记录，重启后直接回到那一次。
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { FocusPlan, FocusRecord } from "../api/types";
import { toastErr, useApp } from "../store/appStore";
import { DEFAULT_PLAN, FOCUS_TYPE_LABEL, fmtClock, type FocusTask } from "../lib/focus";
import { TopBar } from "./chrome";
import { FocusData } from "./FocusData";
import { FocusDetail } from "./FocusDetail";
import { FocusImmersive, FocusSettle } from "./FocusImmersive";
import { FocusPicker } from "./FocusPicker";
import { FocusWheel } from "./FocusWheel";
import { I, Modal, Segmented } from "./ui";

type Tab = "up" | "pomo" | "down" | "data";
const TIMER_TABS: { k: Tab; label: string; type: 1 | 2 | 3 }[] = [
  { k: "up", label: "正计时", type: 1 },
  { k: "pomo", label: "番茄钟", type: 2 },
  { k: "down", label: "倒计时", type: 3 },
];

/** 记录里只有 itemId/habitId，名字要由内核现取（FocusGet 会带回来）。 */
function taskFromItem(r: FocusRecord, item: { taskName: string; taskKind: string } | null): FocusTask | null {
  if (!item || item.taskName === "未关联任务" || !item.taskKind) return null;
  return { kind: item.taskKind as "item" | "habit", id: item.taskKind === "item" ? r.itemId! : r.habitId!, name: item.taskName };
}

/** 每个子模块各留一份关联任务：切页签不该把上一条带过来，那是两个不同的专注。 */
type TaskByTab = Record<Tab, FocusTask | null>;
const emptyTasks = (): TaskByTab => ({ up: null, pomo: null, down: null, data: null });

export function FocusPage() {
  const { booted } = useApp();
  const [tab, setTab] = useState<Tab>("up");
  const [tasks, setTasks] = useState<TaskByTab>(emptyTasks);
  const [downMin, setDownMin] = useState(25);      // 倒计时默认 25 分
  const [pomoMin, setPomoMin] = useState(25);      // 番茄每轮默认 25 分
  const [plan, setPlan] = useState<FocusPlan>(DEFAULT_PLAN);
  const [picking, setPicking] = useState(false);
  const [taskMenu, setTaskMenu] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  // 沉浸页要显示「这次挂的是哪个任务」，所以会话本体带上任务，不从当前页签去反查
  const [session, setSession] = useState<{ record: FocusRecord; task: FocusTask | null } | null>(null);
  const [settle, setSettle] = useState<FocusRecord | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [running, setRunning] = useState<FocusRecord | null>(null);

  // 重启回到那一次：开机查到未结束的记录就进沉浸页；走表状态先让内核按宽限期补一次再暂停。
  useEffect(() => {
    if (!booted) return;
    let dead = false;
    api.FocusCurrent().then(async (r) => {
      if (dead || !r) return;
      setRunning(r);
      // 走表状态先让内核按宽限期补一次（崩溃期间那段时间不算专注）
      const rec = r.status === 1 ? await api.FocusRecover(r.id).catch(() => r) : r;
      const item = rec ? await api.Focus(rec.id).catch(() => null) : null;
      if (dead || !rec) return;
      setSession({ record: rec, task: taskFromItem(rec, item) });
    }).catch(toastErr);
    return () => { dead = true; };
  }, [booted]);

  const task = tasks[tab];
  const typeOf = TIMER_TABS.find((t) => t.k === tab)?.type ?? 1;

  const start = useCallback(() => {
    const req = {
      type: typeOf,
      targetSec: tab === "up" ? 0 : (tab === "down" ? downMin : pomoMin) * 60,
      itemId: task?.kind === "item" ? task.id : undefined,
      habitId: task?.kind === "habit" ? task.id : undefined,
      pomodoro: tab === "pomo" ? { ...plan, focusSec: pomoMin * 60 } : undefined,
    };
    api.FocusStart(req).then((r) => {
      if (!r) return;
      setSession({ record: r, task: task ?? null });
      setRunning(r);
    }).catch(async (e) => {
      // 已经有一条在进行中：不弹错误糊用户，直接把那一次捞出来接着走
      if (!(e instanceof Error) || !e.message.includes("已有专注进行中")) { toastErr(e); return; }
      const cur = await api.FocusCurrent().catch(() => null);
      if (!cur) return;
      const item = await api.Focus(cur.id).catch(() => null);
      setRunning(cur);
      setSession({ record: cur, task: taskFromItem(cur, item) });
    });
  }, [typeOf, tab, downMin, pomoMin, task, plan]);

  if (detail) {
    // 详情页里删掉这条之后，结算页就不该再待着——返回时探一次记录还在不在，没了就把结算页一起收掉。
    // 内核这边删除是墓碑，FocusGet 会当作不存在报错，正好当存在性检查用。
    return (
      <FocusDetail
        focusID={detail}
        onBack={() => {
          setDetail(null);
          if (!settle) return;
          void api.Focus(settle.id).then((v) => { if (!v) { setSettle(null); setRunning(null); } }).catch(() => { setSettle(null); setRunning(null); });
        }}
        onChanged={() => void 0}
      />
    );
  }
  if (settle) {
    return (
      <FocusSettle
        record={settle}
        onClose={() => { setSettle(null); setRunning(null); }}
        onOpenDetail={(id) => setDetail(id)}
      />
    );
  }
  if (session) {
    return (
      <FocusImmersive
        record={session.record}
        task={session.task}
        onChange={(r) => { setSession({ ...session, record: r }); setRunning(r.status === 3 ? null : r); }}
        // 退出沉浸页后向内核再要一次「进行中的那条」：放弃（不保存）之后顶部那条
        // 「上次…还没结束」必须消失，不能靠本地 state 猜。
        onClose={() => { setSession(null); void api.FocusCurrent().then((r) => setRunning(r ?? null)).catch(() => void 0); }}
        onSettled={(r) => { setSession(null); setSettle(r); }}
        onOpenDetail={(id) => setDetail(id)}
      />
    );
  }

  return (
    <>
      <TopBar
        tabs={
          <nav className="gtabs" aria-label="专注">
            {[...TIMER_TABS.map((t) => ({ k: t.k, label: t.label })), { k: "data" as Tab, label: "数据" }].map((t) => (
              <button key={t.k} className={"gtab" + (tab === t.k ? " is-active" : "")} onClick={() => setTab(t.k)}>{t.label}</button>
            ))}
          </nav>
        }
      />

      <main className="content">
        {/* .content 自己是 overflow:hidden（各页自带滚动区），所以这里必须给一层能滚的容器，
            否则数据页超出视口的部分根本看不到。 */}
        <div className="fc-scroll">
        {tab === "data" ? (
          <FocusData />
        ) : (
          <div className="fc">
            {/* 第一行：关联任务。空态是一个按钮，已关联时是任务名 + 点击换/清 */}
            <section className="fc-card fc-task-row">
              {task ? (
                <button className="fc-task-on" onClick={() => setTaskMenu((v) => !v)}>
                  <I n="target" size={13} />
                  <b>{task.name}</b>
                  <span className="fc-task-hint">已关联 · 点击可更换或清除</span>
                </button>
              ) : (
                <button className="fc-task-off" onClick={() => setPicking(true)}>
                  <I n="plus" size={12} />关联任务
                </button>
              )}
              {taskMenu && (
                <div className="fc-task-menu">
                  <button onClick={() => { setTaskMenu(false); setPicking(true); }}>更换任务</button>
                  <button onClick={() => { setTaskMenu(false); setTasks({ ...tasks, [tab]: null }); }}>清除任务</button>
                </div>
              )}
            </section>

            {running && (
              <button className="fc-resume" onClick={() => setSession({ record: running, task })}>
                <span className="fc-resume-dot" />
                上次{FOCUS_TYPE_LABEL[running.type]}还没结束（{fmtClock(running.actualSec || running.accumSec)}）
                <I n="chevronRight" size={12} />
              </button>
            )}

            {tab === "up" && (
              <section className="fc-card fc-preview">
                <div className="fc-preview-clock">00:00</div>
                <p className="fc-preview-tip">正计时不设目标，按下开始就一直走；停下来时选择保存或放弃。</p>
              </section>
            )}

            {tab !== "up" && (
              <section className="fc-card fc-dial">
                <div className="fc-dial-ring">
                  <FocusWheel
                    label={tab === "down" ? "倒计时分钟" : "每轮专注分钟"}
                    value={tab === "down" ? downMin : pomoMin}
                    min={1}
                    max={tab === "down" ? 240 : 120}
                    onChange={(v) => (tab === "down" ? setDownMin(v) : setPomoMin(v))}
                  />
                </div>
                <p className="fc-preview-tip">
                  {tab === "down" ? `倒计时 ${downMin} 分钟，走完自动结算。` : `每轮专注 ${pomoMin} 分钟，共 ${plan.cycles} 轮。`}
                </p>
              </section>
            )}

            {tab === "pomo" && (
              <button className="fc-card fc-plan-btn" onClick={() => setShowPlan(true)}>
                <span className="fc-plan-lab">番茄设置</span>
                <span className="fc-plan-val">
                  {plan.cycles} 个番茄 · 短休息 {plan.shortRest} 分 · 长休息 {plan.longRest} 分 · 每 {plan.longEvery} 轮长休息 · {plan.autoRest ? "自动开始休息" : "手动开始休息"}
                </span>
                <I n="chevronRight" size={12} />
              </button>
            )}

            <button className="fc-start" onClick={start}>开始专注</button>
          </div>
        )}
        </div>
      </main>

      {picking && (
        <FocusPicker
          picked={task}
          onPick={(t) => setTasks({ ...tasks, [tab]: t })}
          onClose={() => setPicking(false)}
        />
      )}

      {showPlan && <PlanModal plan={plan} onClose={() => setShowPlan(false)} onSave={setPlan} />}
    </>
  );
}

/** 番茄设置：个数 / 短休息 / 长休息 / 长休息间隔 / 自动开始休息。默认 4 / 1 / 2 / 4 / 开。 */
function PlanModal({ plan, onClose, onSave }: { plan: FocusPlan; onClose: () => void; onSave: (p: FocusPlan) => void }) {
  const [draft, setDraft] = useState<FocusPlan>(plan);
  const set = (patch: Partial<FocusPlan>) => setDraft({ ...draft, ...patch });
  return (
    <Modal title="番茄设置" onClose={onClose}>
      <div className="fc-plan-rows">
        <NumRow label="番茄钟个数" hint="一次专注里要完成几轮" value={draft.cycles} min={1} max={12} unit="个" onChange={(v) => set({ cycles: v })} />
        <NumRow label="短休息时长" value={draft.shortRest} min={1} max={60} unit="分钟" onChange={(v) => set({ shortRest: v })} />
        <NumRow label="长休息时长" value={draft.longRest} min={1} max={60} unit="分钟" onChange={(v) => set({ longRest: v })} />
        <NumRow label="长休息间隔" hint={`每 ${draft.longEvery} 轮上长休息`} value={draft.longEvery} min={1} max={12} unit="次" onChange={(v) => set({ longEvery: v })} />
        <div className="fc-plan-row">
          <span className="fc-plan-lab">自动开始休息</span>
          <Segmented
            ariaLabel="自动开始休息"
            value={draft.autoRest ? "on" : "off"}
            onChange={(v) => set({ autoRest: v === "on" })}
            options={[{ value: "on", label: "开" }, { value: "off", label: "关" }]}
          />
        </div>
        <p className="fc-plan-tip">关掉后，每轮之间会停下来等你按继续。休息不计入专注时长。</p>
      </div>
      <div className="btn-row">
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={() => { onSave(draft); onClose(); }}>保存</button>
      </div>
    </Modal>
  );
}

function NumRow({ label, hint, value, min, max, unit, onChange }: {
  label: string; hint?: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="fc-plan-row">
      <span className="fc-plan-lab">{label}{hint && <i className="fc-plan-hint">{hint}</i>}</span>
      <span className="fc-stepper">
        <button aria-label={`${label}减少`} onClick={() => onChange(clamp(value - 1))}>-</button>
        <input aria-label={label} value={value} onChange={(e) => onChange(clamp(Number(e.target.value.replace(/\D/g, "")) || min))} />
        <button aria-label={`${label}增加`} onClick={() => onChange(clamp(value + 1))}>+</button>
        <i>{unit}</i>
      </span>
    </div>
  );
}

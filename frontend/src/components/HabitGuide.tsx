// HabitGuide.tsx —— 新建习惯的「引导模式」：按微启动策略一步步问，最后换算成习惯参数。
//
// 为什么要有这个：大部分习惯坚持不住，不是因为毅力差，而是第一天就把量定高了——
// 量一高，失败一次就等于「我不行」，于是整条链断掉。所以这里的每一步都在往下压：
//   计量方式 → 起步量（默认推荐最小的一档）→ 一周几天（默认推荐 3 天，且哪天做都行）→
//   时段与提醒 → 汇总确认。
// 天数走的是内核的「按周 N 天」配额（freq kind 5 + plan），不是固定周几：
// 漏一天不算断，凑够数就算完成，这对初期坚持更友好。
//
// 交互上它和传统模式共用同一张弹窗（顶部切换），引导只负责产出参数：
// 「先这样创建」直接落库，「去微调」把参数交回传统表单继续改。

import { useState } from "react";
import type { HabitContext, HabitIcon, HabitUnit, Reminder } from "../api/types";
import { todayLocal } from "../lib/day";
import { BUILTIN_ICONS, PALETTE } from "./ui";

export type GuideDraft = {
  name: string;
  icon: HabitIcon;
  context: string;
  freq: { kind: number; plan?: number; weekdays?: number[]; everyN?: number };
  mode: 1 | 2;
  autoClock: boolean;
  unitId: string;
  dailyTarget: number;
  perClock: number;
  reminders: Reminder[];
  popMark: boolean;
  startDay: string;
  backfillDays: number;
};

/** 关键词 → 内置图标名。命中就用，没命中退回「星标」。 */
const ICON_HINTS: [string[], string][] = [
  [["喝", "水"], "water"],
  [["跑", "运动", "锻炼", "健身"], "run"],
  [["步", "走"], "walk"],
  [["力量", "俯卧撑", "腹肌"], "workout"],
  [["冥想", "打坐", "呼吸", "正念"], "meditate"],
  [["读", "书", "看"], "book"],
  [["学", "课", "单词", "背", "英语"], "study"],
  [["代码", "编程", "刷课"], "code"],
  [["写", "日记", "笔记", "复盘"], "write"],
  [["早起", "起床"], "early"],
  [["睡", "早睡"], "sleep"],
  [["记账", "存钱", "钱", "消费"], "money"],
  [["护肤", "化妆", "面膜"], "beauty"],
  [["吃", "餐", "饭", "蔬菜"], "food"],
  [["音乐", "琴", "吉他"], "music"],
];

/** 名字里挑一个汉字当图标：越靠前的关键词越具体。 */
function pickIcon(name: string, seed: number): HabitIcon {
  const hit = ICON_HINTS.find(([keys]) => keys.some((k) => name.includes(k)));
  const ref = hit ? hit[1] : "star";
  const known = BUILTIN_ICONS.some((i) => i.name === ref);
  // 只在前 7 个鲜色里轮转：调色板后段是灰/棕，新建时抽到它显得这习惯「没精神」
  const vivid = PALETTE.slice(0, 7);
  return { kind: known ? "image" : "text", ref: known ? ref : [...name.trim()][0] || "习", color: vivid[Math.abs(seed) % vivid.length] };
}

/** 预览用的小图标：和 HabitCreate 里那个同源（白描线画在彩色底上）。 */
function GuideGlyph({ icon }: { icon: HabitIcon }) {
  if (icon.kind === "text" && icon.ref.trim()) {
    return <span className="hm-glyph-word" style={{ fontSize: 13 }}>{[...icon.ref.trim()][0]}</span>;
  }
  const hit = BUILTIN_ICONS.find((i) => i.name === icon.ref) || BUILTIN_ICONS[0];
  return (
    <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth={1.5}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {hit.paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/** 各计量单位的起步量档位。第一档永远是最小的，也是推荐的——微启动的关键就在这。 */
const START_STEPS: Record<string, number[]> = {
  分: [1, 3, 5, 10, 15, 30],
  秒: [30, 60, 120],
  杯: [1, 2, 3, 4, 6, 8],
  页: [1, 2, 5, 10, 20],
  个: [1, 2, 5, 10, 20],
  步: [100, 500, 1000, 3000, 6000],
  米: [50, 100, 200, 500],
  公里: [0.5, 1, 2, 3, 5],
};
const FALLBACK_STEPS = [1, 2, 3, 5, 10];

/** 时段 → 建议提醒时刻（全天不提醒，交给「想起来就做」）。 */
const SLOT: Record<string, { id: string; name: string; at: string }> = {
  always: { id: "", name: "全天", at: "" },
  morning: { id: "ctx-morning", name: "晨间", at: "08:00" },
  noon: { id: "ctx-noon", name: "午间", at: "13:00" },
  evening: { id: "ctx-evening", name: "晚间", at: "21:00" },
};

const mkReminder = (t: string): Reminder => ({ id: "", offset: { days: 0, hours: 0, minutes: 0 }, atTime: t });

type Answers = {
  name: string;
  /** "" = 做了就算（不计量）；否则是单位名，如「分」「杯」 */
  unitName: string;
  start: number;
  days: number;
  slot: keyof typeof SLOT;
  remind: boolean;
  popMark: boolean;
};

const STEP_TITLES = ["想养成什么", "怎么算完成一次", "第一天做多少", "一周做几天", "什么时候做", "先这样开始"];

export function HabitGuide({ units, contexts, onCreate, onTune }: {
  units: HabitUnit[];
  contexts: HabitContext[];
  /** 引导算出来的参数，交给外层落库或回填传统表单 */
  onCreate: (d: GuideDraft) => void;
  onTune: (d: GuideDraft) => void;
}) {
  const [step, setStep] = useState(0);
  const [ans, setAns] = useState<Answers>({ name: "", unitName: "", start: 0, days: 3, slot: "evening", remind: true, popMark: true });
  const set = (patch: Partial<Answers>) => setAns({ ...ans, ...patch });

  const unitList = units.length ? units : [{ id: "", name: "次" }];
  const stepsOf = (u: string) => START_STEPS[u] || FALLBACK_STEPS;
  const startOptions = ans.unitName ? stepsOf(ans.unitName) : FALLBACK_STEPS;
  const chosenStart = ans.start || startOptions[0];
  const slot = SLOT[ans.slot];
  const canNext = step !== 0 || ans.name.trim().length > 0;

  function build(): GuideDraft {
    const measured = !!ans.unitName;
    const unit = unitList.find((u) => u.name === ans.unitName);
    const name = ans.name.trim();
    return {
      name,
      icon: pickIcon(name, name.charCodeAt(0) || 0),
      // 情境优先用库里已有的 ID（用户可能改过名），没有就退回「全天」
      context: contexts.find((c) => c.name === slot.name)?.id ?? (slot.id || ""),
      freq: { kind: 5, plan: ans.days },
      mode: measured ? 2 : 1,
      autoClock: false,
      unitId: measured ? (unit?.id ?? "") : "",
      dailyTarget: measured ? chosenStart : 0,
      perClock: measured ? chosenStart : 0,
      reminders: ans.remind && slot.at ? [mkReminder(slot.at)] : [],
      popMark: ans.popMark,
      startDay: todayLocal(),
      backfillDays: 3,
    };
  }

  const pv = build();

  return (
    <div className="hg">
      <div className="hg-progress">
        {STEP_TITLES.map((t, i) => (
          <span key={t} className={"hg-dot" + (i === step ? " is-on" : i < step ? " is-done" : "")} aria-hidden />
        ))}
        <span className="hg-step-text">第 {step + 1} / {STEP_TITLES.length} 步 · {STEP_TITLES[step]}</span>
      </div>

      {step === 0 && (
        <div className="hg-body">
          <div className="hg-q">先说清要做的那一件小事</div>
          <p className="hg-why">别写「保持健康」，写「做一件具体到能立刻开始的事」，比如「做 1 个俯卧撑」「读 1 页书」。</p>
          <input className="hg-name" maxLength={20} autoFocus placeholder="例如：读 1 页书" aria-label="习惯名称"
            value={ans.name} onChange={(e) => set({ name: e.target.value })} />
          <div className="hg-chips">
            {["喝水", "跑步", "阅读", "冥想", "早起", "记账"].map((s) => (
              <button key={s} className="hg-chip" onClick={() => set({ name: s })}>{s}</button>
            ))}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="hg-body">
          <div className="hg-q">做成什么样，算完成一次？</div>
          <p className="hg-why">能数就数（喝水几杯、跑步几分钟）；不好数就选「做了就算」，一次勾选就是一次完成。</p>
          <div className="hg-chips">
            <button className={"hg-chip" + (ans.unitName === "" ? " is-sel" : "")} onClick={() => set({ unitName: "", start: 0 })}>做了就算</button>
            {unitList.map((u) => (
              <button key={u.id} className={"hg-chip" + (ans.unitName === u.name ? " is-sel" : "")}
                onClick={() => set({ unitName: u.name, start: 0 })}>按{u.name}算</button>
            ))}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="hg-body">
          <div className="hg-q">{ans.unitName ? `第一天做到多少 ${ans.unitName}，闭着眼也能完成？` : "那这一步就跳过——一次打卡即完成"}</div>
          {ans.unitName ? (
            <>
              <p className="hg-why">选最小的那个。量小到「不想做也能做完」，习惯才活得下来；涨量是后面的事。</p>
              <div className="hg-chips">
                {startOptions.map((n, i) => (
                  <button key={n} className={"hg-chip" + (chosenStart === n ? " is-sel" : "")} onClick={() => set({ start: n })}>
                    {n}{ans.unitName}
                    {i === 0 && <small>推荐</small>}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="hg-why">「做了就算」已经是最小的起步量了，直接下一步。</p>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="hg-body">
          <div className="hg-q">一周做几天就算没断？</div>
          <p className="hg-why">这里选的天数<b>不指定周几</b>：一周内哪天做了都算，凑够数就完成。
            漏一天不是失败，这是初期最容易活下来的排法。</p>
          <div className="hg-chips">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <button key={n} className={"hg-chip" + (ans.days === n ? " is-sel" : "")} onClick={() => set({ days: n })}>
                {n === 7 ? "每天" : `${n} 天`}
                {n === 3 && <small>推荐</small>}
              </button>
            ))}
          </div>
          {ans.days >= 6 && <p className="hg-warn">每天做当然好，只是断 1 天容易让人全盘放弃。先 3～5 天，连续两周后再加。</p>}
        </div>
      )}

      {step === 4 && (
        <div className="hg-body">
          <div className="hg-q">一般安排在什么时候？</div>
          <p className="hg-why">挂在一个已经存在的节点后面（刷牙后、午饭后、睡前），比「有空就做」靠谱得多。</p>
          <div className="hg-chips">
            {(Object.keys(SLOT) as (keyof typeof SLOT)[]).map((k) => (
              <button key={k} className={"hg-chip" + (ans.slot === k ? " is-sel" : "")} onClick={() => set({ slot: k })}>{SLOT[k].name}</button>
            ))}
          </div>
          <div className="hg-opts">
            <label className="hg-opt">
              <input type="checkbox" className="check-native" checked={ans.remind} disabled={!slot.at}
                onChange={(e) => set({ remind: e.target.checked })} />
              <span>{slot.at ? `到点提醒一次（${slot.at}）` : "「全天」不设固定提醒"}</span>
            </label>
            <label className="hg-opt">
              <input type="checkbox" className="check-native" checked={ans.popMark}
                onChange={(e) => set({ popMark: e.target.checked })} />
              <span>打卡后问我一句心得</span>
            </label>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="hg-body">
          <div className="hg-q">先这样开始，两周后再加量</div>
          <p className="hg-why">这一份就是最终参数，之后都能改；现在唯一要确认的是「小得足够开始」。</p>
          <div className="hg-preview">
            <div className="hg-pv-head">
              <span className="hg-pv-icon" style={{ background: pv.icon.color }}>
                <GuideGlyph icon={pv.icon} />
              </span>
              <b className="hg-pv-name">{pv.name || "（还没命名）"}</b>
            </div>
            <ul className="hg-pv-list">
              <li><span>频率</span><i>每周 {ans.days === 7 ? "7" : ans.days} 天（哪天做都行）</i></li>
              <li><span>目标</span><i>{ans.unitName ? `每天 ${chosenStart} ${ans.unitName}，打一次即完成` : "做了就算，每天一次"}</i></li>
              <li><span>时段</span><i>{slot.name}{ans.remind && slot.at ? ` · ${slot.at} 提醒` : ""}</i></li>
              <li><span>开始</span><i>{todayLocal()} · 可回溯补打卡 3 天</i></li>
              <li><span>心得</span><i>{ans.popMark ? "打卡后弹一句心得" : "不打扰"}</i></li>
            </ul>
          </div>
        </div>
      )}

      <div className="hg-foot">
        <button className="cc-btn" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))}>上一步</button>
        <div className="hg-foot-right">
          {step < STEP_TITLES.length - 1 ? (
            <button className="cc-btn is-primary" disabled={!canNext} onClick={() => setStep((s) => s + 1)}>下一步</button>
          ) : (
            <>
              <button className="cc-btn" onClick={() => onTune(build())}>去微调</button>
              <button className="cc-btn is-primary" disabled={!ans.name.trim()} onClick={() => onCreate(build())}>先这样创建</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

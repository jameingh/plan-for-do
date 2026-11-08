// 专注的内核镜像实现（mock 后端用）。
//
// 与 memoMock 同一个理由：浏览器里 `npm run dev`（没有 Wails 壳）时，专注页要能跑出
// 与真内核**逐条一致**的行为，界面自检才不会被假数据骗。
// 规则改动必须同步改 internal/core/service/focus.go，两边对不上时以 Go 为准。
import { addDays, diffDays, todayLocal } from "../lib/day";
import type {
  ClockTime,
  Day,
  FocusCandidate,
  FocusCandidateRequest,
  FocusCell,
  FocusDaily,
  FocusEvent,
  FocusInput,
  FocusListItem,
  FocusPhase,
  FocusPlan,
  FocusRecord,
  FocusStat,
  FocusStatRequest,
  FocusStartRequest,
  FocusType,
  Habit,
  ListView,
  ListViewRequest,
} from "./types";

// 与 Go 侧同名常量一一对应（focus.go）。
const FOCUS_MAX_SEC = 24 * 3600;
const FOCUS_RECOVER_GRACE = 30;
const FOCUS_STAT_MAX_SPAN = 380;
const FOCUS_TASK_TOP_N = 10;
const FOCUS_LIST_MAX = 500;

/** 番茄默认值：4 轮 / 短休息 1 分 / 长休息 2 分 / 每 4 轮长休息 / 自动开始休息。
 *  界面上的默认值必须与这里一致，否则「重置成默认」在两边给出不同的数。 */
export const FOCUS_DEFAULT_PLAN: FocusPlan = {
  cycles: 4, shortRest: 1, longRest: 2, longEvery: 4, autoRest: true, focusSec: 0,
};

const STATUS_RUNNING = 1, STATUS_PAUSED = 2, STATUS_DONE = 3;
const SOURCE_LIVE = 1, SOURCE_MANUAL = 2;

type FocusDB = {
  focus: FocusRecord[];
  // 只取专注用得上的几列，避免把整个 mock 的内存结构拖进来
  items: { id: string; title: string; listId: string }[];
  lists: { id: string; name: string }[];
  habits: Habit[];
  habitClocks: { habitId: string; day: Day; amount: number }[];
};

type Helpers = {
  call: <T>(fn: () => T) => Promise<T>;
  now: () => ClockTime;
  newID: () => string;
  emit: (what: string) => void;
  err: (msg: string) => Error;
  buildListView: (req: ListViewRequest) => ListView;
  scheduledDays: (h: Habit, from: Day, to: Day) => Day[];
};

const clampInt = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const secsBetween = (from: ClockTime, to: ClockTime) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

function plan(p: FocusPlan | null | undefined): FocusPlan {
  const out: FocusPlan = { ...FOCUS_DEFAULT_PLAN };
  if (p) {
    out.focusSec = p.focusSec;
    if (p.cycles > 0) out.cycles = clampInt(p.cycles, 1, 12);
    if (p.shortRest > 0) out.shortRest = clampInt(p.shortRest, 1, 120);
    if (p.longRest > 0) out.longRest = clampInt(p.longRest, 1, 120);
    if (p.longEvery > 0) out.longEvery = clampInt(p.longEvery, 1, 12);
    out.autoRest = p.autoRest;
  }
  return out;
}

/** 把正在走的那一段折进累计并清空段起点，返回折进去的秒数（Go 的 focusFold）。 */
function fold(r: FocusRecord, at: ClockTime): number {
  if (!r.segmentStart) return 0;
  const sec = secsBetween(r.segmentStart, at);
  r.segmentStart = undefined;
  if (sec > 0) r.accumSec += sec;
  return sec > 0 ? sec : 0;
}

const ev = (at: ClockTime, kind: string, label: string): FocusEvent => ({ at, kind, label });

/** 区间内的每一天（含端点），与 Go 的 allDays 一样带 400 格上限，脏区间不至于把界面卡死。 */
function allDays(from: Day, to: Day): Day[] {
  const out: Day[] = [];
  let d = from;
  for (;;) {
    out.push(d);
    if (d === to || out.length > 400) break;
    d = addDays(d, 1);
  }
  return out;
}

export function createFocusAPI(db: FocusDB, h: Helpers) {
  const { call, now, newID, emit, err } = h;
  const find = (id: string): FocusRecord => {
    const r = db.focus.find((x) => x.id === id && !x.deletedAt);
    if (!r) throw err(`service: 对象不存在: focus ${id}`);
    return r;
  };
  const checkTask = (itemId?: string, habitId?: string): [string, string] => {
    if (itemId && habitId) throw err("service: 关联任务只能选一个（事项与习惯不能同时挂）");
    if (itemId && !db.items.some((x) => x.id === itemId)) throw err(`service: 对象不存在: item ${itemId}`);
    if (habitId && !db.habits.some((x) => x.id === habitId)) throw err(`service: 对象不存在: habit ${habitId}`);
    return [itemId || "", habitId || ""];
  };
  const unfinished = () => {
    const xs = db.focus.filter((r) => !r.deletedAt && r.status !== STATUS_DONE);
    return xs.sort((a, b) => (a.startAt || "").localeCompare(b.startAt || ""))[xs.length - 1];
  };
  const touch = (r: FocusRecord, at: ClockTime) => {
    r.updatedAt = at;
    emit("focus");
  };

  const validateManual = (in0: FocusInput, fallback: Day) => {
    const day = in0.day || fallback;
    if (in0.type < 1 || in0.type > 3) throw err(`service: 未知的专注类型 ${in0.type}`);
    if (in0.actualSec <= 0 || in0.actualSec > FOCUS_MAX_SEC) throw err("service: 专注时长要在 1 秒到 24 小时之间");
    if (diffDays(todayLocal(), day) > 0) throw err("service: 补记不能写到未来");
    return day;
  };

  return {
    FocusStart: (req: FocusStartRequest) =>
      call(() => {
        if (req.type < 1 || req.type > 3) throw err(`service: 未知的专注类型 ${req.type}`);
        if (req.targetSec < 0 || req.targetSec > FOCUS_MAX_SEC) throw err("service: 目标时长超出范围（最多 24 小时）");
        const [itemId, habitId] = checkTask(req.itemId, req.habitId);
        if (unfinished()) throw err("service: 已有专注进行中，请先结束或放弃");
        const at = now();
        const r: FocusRecord = {
          id: newID(), type: req.type as FocusType, status: STATUS_RUNNING, source: SOURCE_LIVE,
          day: todayLocal(), startAt: at, segmentStart: at, targetSec: req.targetSec,
          accumSec: 0, roundBase: 0, actualSec: 0, restSec: 0, cycles: 0, phase: "",
          itemId: itemId || undefined, habitId: habitId || undefined,
          events: [ev(at, "start", "开始专注")], createdAt: at, updatedAt: at,
        };
        if (req.type === 2) {
          const p = plan(req.pomodoro);
          r.pomodoro = p;
          r.phase = "focus";
          if (!r.targetSec) r.targetSec = p.focusSec;
        } else if (req.type === 3) {
          if (req.targetSec <= 0) throw err("service: 倒计时要先选一个时长");
          r.phase = "focus";
        }
        db.focus.push(r);
        emit("focus");
        return { ...r };
      }),

    // 心跳不 emit：真内核也不发 data:changed，界面不该每 30 秒重取一遍
    FocusTick: (id: string) =>
      call(() => {
        const r = find(id);
        if (r.status !== STATUS_RUNNING) return { ...r };
        const at = now();
        fold(r, at);
        r.segmentStart = at;
        r.updatedAt = at;
        return { ...r };
      }),

    FocusPause: (id: string) =>
      call(() => {
        const r = find(id);
        if (r.status !== STATUS_RUNNING) return { ...r };
        const at = now();
        fold(r, at);
        r.status = STATUS_PAUSED;
        r.events = [...(r.events || []), ev(at, "pause", "暂停")];
        touch(r, at);
        return { ...r };
      }),

    FocusResume: (id: string) =>
      call(() => {
        const r = find(id);
        if (r.status === STATUS_DONE) throw err("service: 这次专注已经结束");
        if (r.status === STATUS_RUNNING) return { ...r };
        const at = now();
        r.status = STATUS_RUNNING;
        r.segmentStart = at;
        r.phase = "focus";
        r.events = [...(r.events || []), ev(at, "resume", "继续")];
        touch(r, at);
        return { ...r };
      }),

    FocusRestStart: (id: string, phase: FocusPhase) =>
      call(() => {
        if (phase !== "short" && phase !== "long") throw err(`service: 未知的休息阶段 ${phase}`);
        const r = find(id);
        if (r.status === STATUS_DONE) throw err("service: 这次专注已经结束");
        const at = now();
        fold(r, at); // 休息期间不计时：段起点必须为空
        r.status = STATUS_PAUSED;
        r.phase = phase;
        r.events = [...(r.events || []), ev(at, "rest", phase === "long" ? "长休息开始" : "短休息开始")];
        touch(r, at);
        return { ...r };
      }),

    FocusPhaseEnd: (id: string, phase: FocusPhase, restSec: number) =>
      call(() => {
        const r = find(id);
        if (r.status === STATUS_DONE) throw err("service: 这次专注已经结束");
        const at = now();
        if (phase === "focus") {
          fold(r, at);
          r.cycles++;
          r.roundBase = r.accumSec; // 下一轮从零开始算
          r.status = STATUS_PAUSED;
          r.events = [...(r.events || []), ev(at, "cycle", `第 ${r.cycles} 轮专注完成`)];
        } else if (phase === "short" || phase === "long") {
          if (restSec > 0) r.restSec += restSec;
          r.events = [...(r.events || []), ev(at, "rest", phase === "long" ? "长休息结束" : "短休息结束")];
        } else {
          throw err(`service: 未知的番茄阶段 ${phase}`);
        }
        r.phase = phase;
        touch(r, at);
        return { ...r };
      }),

    FocusFinish: (id: string, save: boolean) =>
      call(() => {
        const r = find(id);
        if (r.status === STATUS_DONE) throw err("service: 这次专注已经结束");
        const at = now();
        fold(r, at);
        r.status = STATUS_DONE;
        r.endAt = at;
        r.actualSec = r.accumSec;
        r.segmentStart = undefined;
        r.phase = "";
        if (!save) {
          // 放弃 = 同步墓碑，另一台设备上的这条要跟着消失
          r.deletedAt = at;
          touch(r, at);
          return { ...r };
        }
        r.events = [...(r.events || []), ev(at, "end", "结束专注")];
        touch(r, at);
        return { ...r };
      }),

    FocusCurrent: () => call(() => {
      const cur = unfinished();
      return cur ? { ...cur } : null;
    }),

    FocusRecover: (id: string) =>
      call(() => {
        const r = find(id);
        if (r.status !== STATUS_RUNNING) return { ...r };
        const at = now();
        const sec = fold(r, at);
        if (sec > FOCUS_RECOVER_GRACE) r.accumSec -= sec - FOCUS_RECOVER_GRACE; // 关掉期间的不算
        r.status = STATUS_PAUSED;
        r.segmentStart = undefined;
        r.events = [...(r.events || []), ev(at, "recover", "应用重启，已暂停")];
        touch(r, at);
        return { ...r };
      }),

    Focus: (id: string) =>
      call(() => {
        const r = find(id);
        let taskName = "";
        let taskKind: FocusListItem["taskKind"] = "";
        if (r.itemId) { taskKind = "item"; taskName = db.items.find((x) => x.id === r.itemId)?.title || ""; }
        else if (r.habitId) { taskKind = "habit"; taskName = db.habits.find((x) => x.id === r.habitId)?.name || ""; }
        return { record: { ...r }, taskName: taskName || "未关联任务", taskKind };
      }),

    FocusSave: (input: FocusInput) =>
      call(() => {
        const [itemId, habitId] = checkTask(input.itemId, input.habitId);
        const at = now();
        if (!input.id) {
          const day = validateManual(input, todayLocal());
          const r: FocusRecord = {
            id: newID(), type: input.type as FocusType, status: STATUS_DONE, source: SOURCE_MANUAL,
            day, accumSec: 0, roundBase: 0, actualSec: input.actualSec, targetSec: input.actualSec,
            restSec: 0, cycles: input.cycles, phase: "",
            itemId: itemId || undefined, habitId: habitId || undefined,
            note: input.note, events: [ev(at, "start", "补记一条专注")],
            createdAt: at, updatedAt: at,
          };
          db.focus.push(r);
          emit("focus");
          return { ...r };
        }
        const r = find(input.id);
        if (r.status !== STATUS_DONE) throw err("service: 进行中的专注不能改，先结束它");
        r.note = input.note;
        r.itemId = itemId || undefined;
        r.habitId = habitId || undefined;
        // 实时记录的类型/日期/时长是计时器算出来的真值，改它们等于伪造历史
        if (r.source === SOURCE_MANUAL) {
          r.day = validateManual(input, r.day);
          r.type = input.type as FocusType;
          r.actualSec = input.actualSec;
          r.targetSec = input.actualSec;
          r.cycles = input.cycles;
          r.events = [...(r.events || []), ev(at, "start", "修改补记")];
        }
        touch(r, at);
        return { ...r };
      }),

    FocusDelete: (id: string) =>
      call(() => {
        const r = find(id);
        const at = now();
        r.deletedAt = at;
        r.updatedAt = at;
        emit("focus");
      }),

    FocusList: (day: string, limit: number) =>
      call(() => {
        const rows = db.focus
          .filter((r) => !r.deletedAt && r.status === STATUS_DONE)
          .filter((r) => !day || r.day === day)
          .map((record): FocusListItem => {
            let taskName = "";
            let taskKind: FocusListItem["taskKind"] = "";
            if (record.itemId) {
              taskKind = "item";
              taskName = db.items.find((x) => x.id === record.itemId)?.title || "";
            } else if (record.habitId) {
              taskKind = "habit";
              taskName = db.habits.find((x) => x.id === record.habitId)?.name || "";
            }
            return { record: { ...record }, taskName: taskName || "未关联任务", taskKind };
          });
        rows.sort((a, b) =>
          b.record.day.localeCompare(a.record.day) ||
          (b.record.startAt || "").localeCompare(a.record.startAt || "") ||
          b.record.createdAt.localeCompare(a.record.createdAt));
        const cap = limit > 0 && limit < FOCUS_LIST_MAX ? limit : FOCUS_LIST_MAX;
        return rows.slice(0, cap);
      }),

    FocusStat: (req: FocusStatRequest) =>
      call<FocusStat>(() => {
        if (!req.start || !req.end) throw err("service: 统计区间不能为空");
        const span = diffDays(req.start, req.end);
        if (span < 0) throw err("service: 统计区间反了");
        if (span > FOCUS_STAT_MAX_SPAN) throw err("service: 统计区间过长（最多一年）");
        const today = todayLocal();
        const rows = db.focus.filter((r) => !r.deletedAt && r.status === STATUS_DONE);
        const daily = allDays(req.start, req.end).map((d): FocusDaily => ({ day: d, sec: 0, count: 0 }));
        const dailyIdx = new Map(daily.map((d, i) => [d.day, i]));
        const matrix: FocusCell[] = [];
        for (let w = 1; w <= 7; w++) for (let hr = 0; hr < 24; hr++) matrix.push({ weekday: w, hour: hr, sec: 0, count: 0 });
        const typeMap = new Map<FocusType, { sec: number; count: number }>();
        const taskMap = new Map<string, { name: string; sec: number; count: number }>();
        const out: FocusStat = {
          start: req.start, end: req.end, today,
          overview: { totalSec: 0, totalCount: 0, todaySec: 0, todayCount: 0 },
          daily, byType: [], byTask: [], matrix, unplacedSec: 0, unplacedCount: 0,
        };
        for (const r of rows) {
          out.overview.totalSec += r.actualSec;
          out.overview.totalCount++;
          if (r.day === today) {
            out.overview.todaySec += r.actualSec;
            out.overview.todayCount++;
          }
          if (diffDays(req.start, r.day) < 0 || diffDays(r.day, req.end) < 0) continue;
          const di = dailyIdx.get(r.day);
          if (di !== undefined) {
            daily[di].sec += r.actualSec;
            daily[di].count++;
          }
          const t = typeMap.get(r.type) || { sec: 0, count: 0 };
          t.sec += r.actualSec;
          t.count++;
          typeMap.set(r.type, t);
          const key = r.itemId || r.habitId || "";
          const name = r.itemId
            ? db.items.find((x) => x.id === r.itemId)?.title || ""
            : r.habitId
              ? db.habits.find((x) => x.id === r.habitId)?.name || ""
              : "未关联任务";
          const p = taskMap.get(key) || { name, sec: 0, count: 0 };
          p.sec += r.actualSec;
          p.count++;
          taskMap.set(key, p);
          if (!r.startAt) {
            out.unplacedSec += r.actualSec;
            out.unplacedCount++;
            continue;
          }
          const d = new Date(r.startAt);
          const wd = ((d.getDay() + 6) % 7) + 1;
          const cell = matrix[(wd - 1) * 24 + d.getHours()];
          cell.sec += r.actualSec;
          cell.count++;
        }
        out.byType = [...typeMap.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([type, v]) => ({ type, ...v }));
        out.byTask = [...taskMap.entries()]
          .map(([itemId, v]) => ({ itemId: itemId || undefined, ...v }))
          .sort((a, b) => b.sec - a.sec || b.count - a.count)
          .slice(0, FOCUS_TASK_TOP_N);
        return out;
      }),

    FocusCandidates: (req: FocusCandidateRequest) =>
      call(() => {
        const tab = req.tab || "item";
        const explicit = !!req.day;
        const day = req.day || todayLocal();
        const out: FocusCandidate[] = [];
        if (tab === "item") {
          const lv = h.buildListView({ day, groupBy: "date", showDone: false } as ListViewRequest);
          for (const g of lv.groups) {
            if (g.key === "done") continue;
            for (const o of g.items) {
              if (o.status === 1 || o.status === 3) continue; // 已结清
              if (explicit && o.day !== day) continue;
              const t = o.item.time;
              const timeText = t.kind === 0 ? "全天" : t.end && t.end !== t.start ? `${t.start}-${t.end}` : t.start || "";
              out.push({
                kind: "item", id: o.item.id, name: o.item.title, day: o.day, timeText,
                group: db.lists.find((l) => l.id === o.item.listId)?.name || "",
                icon: { kind: "text", ref: "", color: "" }, clocked: false,
              });
            }
          }
          out.sort((a, b) => a.day.localeCompare(b.day) || a.timeText.localeCompare(b.timeText));
          return out;
        }
        if (tab === "habit") {
          for (const hb of db.habits) {
            const due = h.scheduledDays(hb, day, day).length > 0;
            const amount = db.habitClocks.filter((c) => c.habitId === hb.id && c.day === day)
              .reduce((s, c) => s + (c.amount || 1), 0);
            out.push({
              kind: "habit", id: hb.id, name: hb.name, day,
              timeText: due ? "今天该打" : "休息日", group: hb.context, icon: hb.icon, clocked: amount > 0,
            });
          }
          out.sort((a, b) => Number(a.clocked) - Number(b.clocked) || a.name.localeCompare(b.name));
          return out;
        }
        throw err(`service: 未知的候选类型 ${tab}`);
      }),
  };
}

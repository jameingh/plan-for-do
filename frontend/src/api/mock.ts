// mock.ts —— Kernel 的浏览器内存实现（纯 `npm run dev` 调试 UI 用，Wails 在场时不会被选中）。
//
// 语义尽量复刻 Go 内核（service/{list,habit,catalog,reminders}.go），包括中文错误文案，
// 让 UI 的空状态/报错路径与真机一致。简化处有注释；重复展开只做到「够调试」的程度。
// 内置一份演示数据（逾期/今天/未来/无日期/重复事项 + 三个习惯），保证三页走一遍不白屏。

import type {
  Attachment,
  BootInfo,
  Category,
  CategoryInput,
  Child,
  ChildInput,
  ClockTime,
  DateSpec,
  Day,
  FocusRecord,
  Habit,
  HabitClock,
  HabitContext,
  HabitMark,
  HabitStats,
  HabitStat,
  HabitStatDaySummary,
  HabitStatHabit,
  HabitStatState,
  HabitUnit,
  HabitView,
  ItemInput,
  ItemStatus,
  Label,
  LabelInput,
  ListItem,
  Memo,
  MemoFolder,
  CalendarDay,
  CalendarHabit,
  CalendarRequest,
  CalendarView,
  ListView,
  ListViewRequest,
  ListInput,
  Occurrence,
  OccurrenceOverride,
  OverdueBundle,
  PlList,
  Reminder,
  ReminderFire,
  Repeat,
  Scope,
  Settings,
  SyncConfig,
  SyncResult,
  SyncState,
  TimeSpec,
} from "./types";
import type { Kernel, KernelEventName } from "./client";
import { createMemoAPI } from "./memoMock";
import { createFocusAPI } from "./focusMock";
import { addDays, diffDays, isValidDay, todayLocal, weekdayMon } from "../lib/day";

type Listener = (data: unknown) => void;

interface DB {
  seq: number;
  lastTickMs: number;
  lists: PlList[];
  categories: Category[];
  labels: Label[];
  items: ListItem[];
  children: Child[];
  /** 事项图片：itemId → 附件。浏览器里没有 dataDir，path 直接存 data: URL */
  images: Record<string, Attachment[]>;
  overrides: Record<string, OccurrenceOverride>;
  habits: Habit[];
  habitClocks: HabitClock[];
  habitMarks: HabitMark[];
  units: HabitUnit[];
  contexts: HabitContext[];
  memoFolders: MemoFolder[];
  memos: Memo[];
  focus: FocusRecord[];
  settings: Settings;
  channels: SyncConfig[];
  syncStates: Record<string, SyncState>;
}

const err = (msg: string) => new Error(msg);

/** 与内核 api.go 的 imageMime 同一张表，浏览器侧只用于造 data: URL。 */
function mimeOfImage(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" } as Record<string, string>)[ext] ?? "";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function monthSpan(month: string): [Day, Day] {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [`${month}-01`, `${month}-${pad2(last)}`];
}

// —— 重复展开（简化版 repeat.Materialize）——

function anchorOf(d: DateSpec): Day {
  return d.start || d.selected?.[0] || "";
}

/** 一个候选日是否被规则命中；index 为命中序（供按次数结束），返回 null 表示不命中。 */
function hit(r: Repeat, day: Day, anchor: Day): boolean {
  if (r.ebbinghaus) {
    const offsets = new Set([0]);
    let acc = 0;
    for (const iv of [1, 2, 4, 7, 15, 30, 60]) {
      acc += iv;
      offsets.add(acc);
    }
    const d = diffDays(anchor, day);
    return d >= 0 && offsets.has(d);
  }
  const interval = r.interval <= 0 ? 1 : r.interval;
  switch (r.unit) {
    case 1:
      return diffDays(anchor, day) >= 0 && diffDays(anchor, day) % interval === 0;
    case 2: {
      const dayWeeks = Math.floor(diffDays(mondayOf(anchor), day) / 7);
      if (dayWeeks < 0 || dayWeeks % interval !== 0) return false;
      const wds = r.weekdays && r.weekdays.length ? r.weekdays : [weekdayMon(anchor)];
      return wds.includes(weekdayMon(day));
    }
    case 3: {
      const months = monthDiff(anchor, day);
      if (months < 0 || months % interval !== 0) return false;
      const md = r.monthDays && r.monthDays.length ? r.monthDays : [Number(anchor.slice(8, 10))];
      const dom = Number(day.slice(8, 10));
      return md.some((x) => (x < 0 ? dom === lastDayOfMonth(day) + 1 + x : x === dom));
    }
    case 4: {
      const years = Number(day.slice(0, 4)) - Number(anchor.slice(0, 4));
      if (years < 0 || years % interval !== 0) return false;
      const m = r.yearMonth || Number(anchor.slice(5, 7));
      const d = r.yearDay || Number(anchor.slice(8, 10));
      return Number(day.slice(5, 7)) === m && Number(day.slice(8, 10)) === d;
    }
  }
  return false;
}

function mondayOf(d: Day): Day {
  return addDays(d, -(weekdayMon(d) - 1));
}
function monthDiff(a: Day, b: Day): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)));
}
function lastDayOfMonth(d: Day): number {
  const [y, m] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 展开事项在 [from,to] 的所有实例日（不含 override）。 */
function occurrenceDays(item: ListItem, from: Day, to: Day): Day[] {
  const d = item.date;
  if (!d.start && !(d.selected?.length ?? 0)) return [];
  const anchor = anchorOf(d);
  const out: Day[] = [];
  const r = item.repeat;
  if (!r) {
    let days: Day[] = [];
    if (d.kind === 1) days = [d.start];
    else if (d.kind === 2) {
      const n = Math.max(0, diffDays(d.start, d.end || d.start));
      days = Array.from({ length: n + 1 }, (_, i) => addDays(d.start, i));
    } else days = [...(d.selected ?? [])];
    for (const day of days) if (day >= from && day <= to) out.push(day);
    return out;
  }
  // 跨天+重复按锚点展开（内核的跨天智能重复细节未完全复刻，调试够用）
  let count = 0;
  for (let day = anchor < from ? from : anchor; day <= to; day = addDays(day, 1)) {
    if (day < anchor) continue;
    if (r.end.mode === 1 && r.end.date && day > r.end.date) break;
    if (diffDays(anchor, day) < 0) continue;
    if (!hit(r, day, anchor)) continue;
    count++;
    if (r.end.mode === 2 && r.end.count && count > r.end.count) break;
    if (day >= from) out.push(day);
  }
  return out;
}

// —— 主工厂 ——

export function createMockKernel(): Kernel {
  const db: DB = {
    seq: 0,
    lastTickMs: 0,
    lists: [],
    categories: [],
    labels: [],
    items: [],
    children: [],
    images: {},
    overrides: {},
    habits: [],
    habitClocks: [],
    habitMarks: [],
    units: [],
    contexts: [],
    memoFolders: [],
    focus: [],
    memos: [],
    settings: { showDone: true, defaultGroup: "date", theme: "light", habitCreateMode: "guided", memoSortType: 0, view: { hideMatterClocked: false, hideHabitClocked: false, matterColorMode: 0, matterColorValue: "", habitColorMode: 0, habitColorValue: "", hideCategories: [], hideHabitContexts: [] } },
    channels: [
      { name: "本地文件夹", kind: "localdir", enabled: true, options: { path: "D:/sync/plan-for-do" } },
      { name: "飞书多维表格", kind: "feishuBase", enabled: false, options: { app_id: "cli_a000000000", app_secret: "•", table_id: "tblDemo0001" } },
    ],
    syncStates: {},
  };
  const listeners = new Map<KernelEventName, Set<Listener>>();
  let reminderDemoSent = false;
  const newID = () => `mk${(++db.seq).toString().padStart(6, "0")}`;
  const now = (): ClockTime => {
    const ms = Math.max(Date.now(), db.lastTickMs + 1);
    db.lastTickMs = ms;
    return new Date(ms).toISOString().replace(/Z$/, "Z");
  };
  const emit = (what: string) => {
    listeners.get("data:changed")?.forEach((l) => l({ what, at: todayLocal() }));
  };
  const call = async <T>(fn: () => T): Promise<T> => {
    await Promise.resolve(); // 模拟异步
    return fn();
  };

  // ——— 种子 ———
  const today = todayLocal();
  const at = now();
  const seed = <T extends object>(v: T): T & { createdAt: string; updatedAt: string } => ({
    ...v,
    createdAt: at,
    updatedAt: at,
  }) as T & { createdAt: string; updatedAt: string };

  db.lists = [
    seed({ id: "list-default", name: "全部", icon: "list", color: "", sort: 0 }),
    seed({ id: newID(), name: "副业项目", icon: "idea", color: "#8a6cf0", sort: 100 }),
    seed({ id: newID(), name: "家庭事务", icon: "heart", color: "#fc6a7a", sort: 200 }),
  ];
  db.contexts = [
    seed({ id: "ctx-always", name: "全天", sort: 0 }),
    seed({ id: "ctx-morning", name: "晨间", sort: 1 }),
    seed({ id: "ctx-noon", name: "午间", sort: 2 }),
    seed({ id: "ctx-evening", name: "晚间", sort: 3 }),
  ];
  db.units = ["个", "步", "米", "公里", "页", "杯", "分"].map((name, i) =>
    seed({ id: `unit-${i}`, name, createdAt: at, updatedAt: at })
  );
  db.categories = [
    seed({ id: newID(), name: "工作", icon: "list", color: "#4b8bf4", sort: 0 }),
    seed({ id: newID(), name: "生活", icon: "heart", color: "#03a17e", sort: 1 }),
    seed({ id: newID(), name: "学习", icon: "book", color: "#f2a33b", sort: 2 }),
    seed({ id: newID(), name: "健康", icon: "run", color: "#fc6a7a", sort: 3 }),
    seed({ id: newID(), name: "财务", icon: "money", color: "#22b8cf", sort: 4 }),
    seed({ id: newID(), name: "灵感", icon: "星", color: "#8a6cf0", sort: 5 }),
  ];
  db.labels = [
    seed({ id: newID(), name: "重要", color: "#e13e39" }),
    seed({ id: newID(), name: "长期", color: "#03a17e" }),
    seed({ id: newID(), name: "等人", color: "#f2a33b" }),
    seed({ id: newID(), name: "线上", color: "#4b8bf4" }),
    seed({ id: newID(), name: "花钱", color: "#8a6cf0" }),
  ];

  const daySpec = (start: Day, kind: DateSpec["kind"] = 1, end?: Day): DateSpec => ({ kind, start, end });
  const allDay: TimeSpec = { kind: 0 };
  const mkItem = (partial: Partial<ListItem>): ListItem =>
    seed({
      id: newID(),
      listId: "list-default",
      title: "",
      remark: "",
      category: "",
      priority: 4,
      labelIds: [],
      date: daySpec(today),
      time: allDay,
      reminders: [],
      progress: -1,
      isTop: false,
      ...partial,
    } as ListItem);

  const iOverdue = mkItem({ title: "提交季度周报", date: daySpec(addDays(today, -3)), priority: 1, category: db.categories[0].id, labelIds: [db.labels[0].id], remark: "已经拖了几天了，先补齐数据再交。" });
  const iOldOverdue = mkItem({ title: "换新护照", date: daySpec(addDays(today, -73)), priority: 2, category: db.categories[1].id, remark: "出入境大厅周末不开门。" });
  const iWaitOverdue = mkItem({ title: "回复张总的报价邮件", date: daySpec(addDays(today, -12)), priority: 1, category: db.categories[0].id, labelIds: [db.labels[2].id, db.labels[0].id] });
  const iToday = mkItem({ title: "买牛奶和鸡蛋", labelIds: [db.labels[1].id], category: db.categories[1].id });
  const iMeeting = mkItem({
    title: "产品评审会",
    time: { kind: 2, start: "15:00", end: "16:00" },
    priority: 1,
    category: db.categories[0].id,
    labelIds: [db.labels[3].id],
    reminders: [{ id: newID(), offset: { days: 0, hours: 0, minutes: 30 } }],
  });
  const iCall = mkItem({ title: "和爸妈视频", time: { kind: 1, start: "20:30" }, priority: 2, category: db.categories[1].id, reminders: [{ id: newID(), offset: { days: 0, hours: 0, minutes: 0 }, atTime: "20:00" }] });
  const iRun = mkItem({
    title: "晨间拉伸",
    date: daySpec(addDays(today, -10)),
    priority: 2,
    category: db.categories[3].id,
    repeat: { unit: 1, interval: 1, skipLegalHolidays: false, followMakeupWorkday: false, smartSpan: false, ebbinghaus: false, end: { mode: 0 } },
  });
  const iStandup = mkItem({
    title: "站会",
    date: daySpec(addDays(today, -30)),
    time: { kind: 1, start: "09:30" },
    priority: 3,
    category: db.categories[0].id,
    repeat: { unit: 2, interval: 1, weekdays: [1, 2, 3, 4, 5], skipLegalHolidays: true, followMakeupWorkday: true, smartSpan: false, ebbinghaus: false, end: { mode: 0 } },
  });
  const iSpan = mkItem({
    title: "装修验收（跨天）",
    date: { kind: 2, start: addDays(today, -1), end: addDays(today, 2) },
    priority: 1,
    category: db.categories[1].id,
    labelIds: [db.labels[4].id],
    remark: "跨天清单，每天要去看一次进度。",
  });
  const iPickDays = mkItem({
    title: "线下英语课",
    date: { kind: 3, start: addDays(today, 1), selected: [addDays(today, 1), addDays(today, 3), addDays(today, 6)] },
    time: { kind: 2, start: "19:00", end: "20:30" },
    priority: 2,
    category: db.categories[2].id,
  });
  const iNoDate = mkItem({ title: "给小明挑生日礼物", date: { kind: 3, start: "", selected: [] }, priority: 2, category: db.categories[1].id, labelIds: [db.labels[4].id] }); // start 与 selected 皆空=无日期，恒在「待办」
  const iSomeday = mkItem({ title: "整理书房的线", date: { kind: 3, start: "", selected: [] }, priority: 4 });
  const iFuture = mkItem({
    title: "看牙医",
    date: daySpec(addDays(today, 2)),
    time: { kind: 1, start: "10:30" },
    priority: 2,
    category: db.categories[1].id,
    labelIds: [db.labels[2].id],
    reminders: [{ id: newID(), offset: { days: 1, hours: 0, minutes: 0 } }],
  });
  const iTrip = mkItem({
    title: "订寒假回家的票",
    date: daySpec(addDays(today, 9)),
    priority: 2,
    category: db.categories[1].id,
    reminders: [{ id: newID(), offset: { days: 7, hours: 0, minutes: 0 } }],
  });
  const iPay = mkItem({ title: "交房租", date: daySpec(addDays(today, 5)), priority: 1, category: db.categories[4].id, labelIds: [db.labels[4].id] });
  const iRead = mkItem({ title: "读完《为什么伟大不能被计划》", date: daySpec(addDays(today, 4)), priority: 2, category: db.categories[2].id, progress: 40 });
  const iDone = mkItem({ title: "晚安日记", date: daySpec(today), priority: 4, category: db.categories[1].id });
  const iDoneMail = mkItem({ title: "发出供应商对账表", date: daySpec(today), priority: 3, category: db.categories[0].id });
  const iDoneWater = mkItem({ title: "换净水器滤芯", date: daySpec(addDays(today, -1)), priority: 4, category: db.categories[1].id });
  const iEbb = mkItem({
    title: "架构复习（艾宾浩斯）",
    date: daySpec(addDays(today, -3)),
    priority: 2,
    category: db.categories[2].id,
    repeat: { unit: 1, interval: 0, ebbinghaus: true, skipLegalHolidays: false, followMakeupWorkday: false, smartSpan: false, end: { mode: 0 } },
  });
  db.items = [
    iOverdue, iOldOverdue, iWaitOverdue, iToday, iMeeting, iCall, iRun, iStandup,
    iSpan, iPickDays, iNoDate, iSomeday, iFuture, iTrip, iPay, iRead, iDone, iDoneMail, iDoneWater, iEbb,
  ];

  db.children = [1, 2, 3, 4].map((n) =>
    seed({
      id: newID(),
      itemId: iToday.id,
      title: `小步骤 ${n}`,
      remark: "",
      sort: n,
      pinned: false,
      priority: 4,
      done: n === 1,
      progress: -1,
    } as Child)
  );
  db.overrides[`${iDone.id}:${today}`] = {
    id: `ovr:${iDone.id}:${today}`,
    itemId: iDone.id,
    day: today,
    status: 1,
    clockedAt: now(),
    createdAt: at,
    updatedAt: at,
  };
  db.overrides[`${iDoneMail.id}:${today}`] = {
    id: `ovr:${iDoneMail.id}:${today}`,
    itemId: iDoneMail.id,
    day: today,
    status: 1,
    clockedAt: now(),
    createdAt: at,
    updatedAt: at,
  };
  db.overrides[`${iDoneWater.id}:${addDays(today, -1)}`] = {
    id: `ovr:${iDoneWater.id}:${addDays(today, -1)}`,
    itemId: iDoneWater.id,
    day: addDays(today, -1),
    status: 1,
    clockedAt: now(),
    createdAt: at,
    updatedAt: at,
  };
  for (let k = 1; k <= 8; k++) {
    const d = addDays(today, -k);
    db.overrides[`${iRun.id}:${d}`] = { id: `ovr:${iRun.id}:${d}`, itemId: iRun.id, day: d, status: 1, clockedAt: now(), createdAt: at, updatedAt: at };
  }

  const habit = (p: Partial<Habit>): Habit =>
    seed({
      id: newID(),
      name: "",
      icon: { kind: "text", ref: "习", color: "#03a17e" },
      context: "",
      freq: { kind: 1 },
      mode: 1,
      autoClock: false,
      dailyTarget: 0,
      perClock: 0,
      startDay: addDays(today, -20),
      backfillDays: 3,
      ...p,
    } as Habit);
  const hWater = habit({
    name: "喝水",
    icon: { kind: "image", ref: "water", color: "#22b8cf" },
    mode: 2,
    unitId: "unit-5",
    dailyTarget: 4,
    perClock: 1,
    backfillDays: 1,
  });
  const hRun = habit({ name: "跑步", icon: { kind: "image", ref: "run", color: "#fc6a7a" }, context: "ctx-morning", startDay: addDays(today, -15) });
  const hEarly = habit({ name: "早起", icon: { kind: "image", ref: "early", color: "#f2a33b" }, context: "ctx-morning", startDay: addDays(today, -28), backfillDays: 0 });
  const hRead = habit({
    name: "读书",
    icon: { kind: "image", ref: "book", color: "#8a6cf0" },
    context: "ctx-evening",
    freq: { kind: 2, weekdays: [1, 3, 5] },
    unitId: "unit-4",
    mode: 2,
    dailyTarget: 10,
    perClock: 5,
  });
  const hPlank = habit({
    name: "平板支撑",
    icon: { kind: "image", ref: "workout", color: "#4b8bf4" },
    context: "ctx-noon",
    mode: 2,
    unitId: "unit-6",
    dailyTarget: 3,
    perClock: 1,
    startDay: addDays(today, -9),
  });
  const hDiary = habit({ name: "晚安日记", icon: { kind: "text", ref: "记", color: "#03a17e" }, context: "ctx-evening", startDay: addDays(today, -40) });
  const hNoJunk = habit({ name: "不喝含糖饮料", icon: { kind: "text", ref: "糖", color: "#e13e39" }, startDay: addDays(today, -6), freq: { kind: 4, everyN: 2 } });
  db.habits = [hWater, hRun, hEarly, hRead, hPlank, hDiary, hNoJunk];
  const clockOnce = (h: Habit, d: Day) =>
    db.habitClocks.push({
      id: h.mode === 1 ? `dc:${h.id}:${d}` : newID(),
      habitId: h.id,
      day: d,
      amount: h.mode === 2 ? h.perClock : 1,
      clockedAt: now(),
      manual: d !== today,
      updatedAt: at,
    });
  for (let k = 2; k <= 8; k++) clockOnce(hRun, addDays(today, -k));
  for (let k = 10; k <= 14; k++) clockOnce(hRun, addDays(today, -k));
  for (let k = 1; k <= 3; k++) clockOnce(hWater, addDays(today, -k));
  clockOnce(hWater, today);
  clockOnce(hWater, today);
  clockOnce(hWater, today);
  // 部分完成：昨天只喝了两杯
  clockOnce(hWater, addDays(today, -5));
  clockOnce(hWater, addDays(today, -5));
  [addDays(today, -1), addDays(today, -3), addDays(today, -6)].forEach((d) => clockOnce(hRead, d));
  // 读书 5 页 / 目标 10 页 = 部分完成
  clockOnce(hRead, addDays(today, -8));
  for (let k = 1; k <= 6; k++) clockOnce(hEarly, addDays(today, -k));
  for (let k = 1; k <= 9; k++) clockOnce(hDiary, addDays(today, -k));
  for (let k = 1; k <= 4; k++) clockOnce(hPlank, addDays(today, -k));
  clockOnce(hPlank, addDays(today, -2));
  clockOnce(hPlank, addDays(today, -2));
  for (let k = 1; k <= 5; k++) clockOnce(hNoJunk, addDays(today, -k * 2));
  db.habitMarks = [
    { id: newID(), habitId: hRun.id, day: addDays(today, -2), time: "07:12", text: "今天状态不错，配速提到了 6'10''，最后两公里没掉速。", createdAt: at, updatedAt: at },
    { id: newID(), habitId: hRun.id, day: addDays(today, -5), time: "06:55", text: "下雨改室内，跑了 4 组高抬腿代替。", createdAt: at, updatedAt: at },
    { id: newID(), habitId: hWater.id, day: today, time: "18:40", text: "到下午四点才喝到第三杯，明天把杯子放到办公桌上。", createdAt: at, updatedAt: at },
    { id: newID(), habitId: hRead.id, day: addDays(today, -1), time: "22:31", text: "读完第三章，作者对「指标陷阱」的论证比我想象的薄。", createdAt: at, updatedAt: at },
    { id: newID(), habitId: hDiary.id, day: addDays(today, -3), time: "23:05", text: "和爸妈通了电话，心情比前两天好一些。", createdAt: at, updatedAt: at },
  ];

  // ——— 清单视图 ———

  function itemsInWindow(from: Day, to: Day, req: ListViewRequest): Occurrence[] {
    const out: Occurrence[] = [];
    const childStats: Record<string, { total: number; done: number }> = {};
    for (const c of db.children) {
      const s = (childStats[c.itemId] ??= { total: 0, done: 0 });
      s.total++;
      if (c.done) s.done++;
    }
    for (const it of db.items) {
      if (req.listId && it.listId !== req.listId) continue;
      if (req.categoryId && it.category !== req.categoryId) continue;
      if (req.labelId && !it.labelIds.includes(req.labelId)) continue;
      const days = occurrenceDays(it, from, to);
      if (!days.length && !it.date.start && !it.date.selected?.length) {
        out.push({ item: it, day: "", status: 0, childTotal: childStats[it.id]?.total ?? 0, childDone: childStats[it.id]?.done ?? 0, overdueDays: 0 });
        continue;
      }
      for (const day of days) {
        const ovr = db.overrides[`${it.id}:${day}`];
        let status: ItemStatus = 0;
        let clockedAt: string | undefined;
        let postponedFrom: string | undefined;
        if (ovr) {
          if (ovr.status === 2) continue; // 跳过
          status = ovr.status;
          clockedAt = ovr.clockedAt;
          postponedFrom = ovr.postponedFrom;
        }
        // 被顺延走的原始日不出现
        const moved = Object.values(db.overrides).find((o) => o.itemId === it.id && o.postponedFrom === day && o.day !== day);
        if (moved && !ovr) continue;
        if (moved && ovr && ovr.status !== 1) continue;
        out.push({
          item: it,
          day,
          status,
          clockedAt,
          postponedFrom,
          overrideId: `ovr:${it.id}:${day}`,
          childTotal: childStats[it.id]?.total ?? 0,
          childDone: childStats[it.id]?.done ?? 0,
          overdueDays: status !== 1 && day && diffDays(day, today) > 0 ? diffDays(day, today) : 0,
        });
      }
      // 顺延来的目标日（原本不是排期日）
      for (const o of Object.values(db.overrides)) {
        if (o.itemId !== it.id || !o.postponedFrom || o.day < from || o.day > to) continue;
        if (occurrenceDays(it, o.day, o.day).includes(o.day)) continue;
        out.push({
          item: it,
          day: o.day,
          status: o.status,
          clockedAt: o.clockedAt,
          postponedFrom: o.postponedFrom,
          overrideId: o.id,
          childTotal: childStats[it.id]?.total ?? 0,
          childDone: childStats[it.id]?.done ?? 0,
          overdueDays: 0,
        });
      }
    }
    return out;
  }

  const timeKey = (t: TimeSpec) => (t.kind === 0 || !t.start ? "99:99" : t.start);
  function sortOcc(xs: Occurrence[]) {
    xs.sort((a, b) => {
      // 与内核 sortOccurrences 一致：置顶优先，置顶项之间仍按原规则排。
      if (a.item.isTop !== b.item.isTop) return a.item.isTop ? -1 : 1;
      const tk = timeKey(a.item.time).localeCompare(timeKey(b.item.time));
      if (tk) return tk;
      if (a.item.priority !== b.item.priority) return a.item.priority - b.item.priority;
      if (a.day !== b.day) return a.day < b.day ? -1 : 1;
      if (a.item.createdAt !== b.item.createdAt) return a.item.createdAt < b.item.createdAt ? -1 : 1;
      return a.item.id < b.item.id ? -1 : 1;
    });
    return xs;
  }
  function collapse(xs: Occurrence[]): Occurrence[] {
    const best = new Map<string, Occurrence>();
    for (const o of xs) {
      const cur = best.get(o.item.id);
      if (!cur || (o.day && (!cur.day || o.day < cur.day))) best.set(o.item.id, o);
    }
    const out = [...best.values()];
    for (const o of out) o.overdueDays = o.day && o.status !== 1 && diffDays(o.day, today) > 0 ? diffDays(o.day, today) : o.overdueDays;
    return out;
  }

  /** 自定义视图的过滤，口径与内核 calendarMatch 一致：反向列表优先，"" 代表未分类。 */
  function calendarMatch(it: ListItem, req: CalendarRequest): boolean {
    if (req.listIds?.length && !req.listIds.includes(it.listId)) return false;
    if (req.hideCategoryIds?.length && req.hideCategoryIds.includes(it.category)) return false;
    if (req.categoryIds?.length && !req.categoryIds.includes(it.category)) return false;
    if (req.labelIds?.length && !req.labelIds.some((l) => it.labelIds.includes(l))) return false;
    return true;
  }

  function buildCalendarView(req: CalendarRequest): CalendarView {
    const start = req.start || todayLocal();
    const end = req.end || addDays(start, 41);
    if (diffDays(start, end) < 0) throw err(`service: 视图区间反了：${start} → ${end}`);
    if (diffDays(start, end) >= 400) throw err(`service: 视图区间最多 400 天，实得 ${start} → ${end}`);

    const days: CalendarDay[] = [];
    const index = new Map<Day, CalendarDay>();
    for (let d = start; diffDays(d, end) >= 0; d = addDays(d, 1)) {
      const c: CalendarDay = { day: d, items: [], habits: [] };
      index.set(d, c);
      days.push(c);
    }

    // 简化处：mock 的展开只做到「够调试」，无日期事项靠 day 为空滤掉（内核那边直接不进网格）。
    const all = itemsInWindow(start, end, { showDone: true }).filter((o) => o.day && calendarMatch(o.item, req));
    for (const o of all) {
      const resolved = o.status === 1 || o.status === 3;
      if (resolved && !req.showDone) continue;
      index.get(o.day)?.items.push(o);
    }

    if (req.includeHabits) {
      for (const h of db.habits) {
        if (req.hideHabitContexts?.includes(h.context ?? "")) continue;
        const target = targetOf(h);
        const byDay = clocksByDay(h.id);
        const at = (h.reminders ?? []).map((r) => r.atTime ?? "").filter(Boolean).sort()[0] ?? "";
        for (const d of scheduledDays(h, start, end)) {
          const cell = index.get(d);
          if (!cell) continue;
          const amount = byDay[d] ?? 0;
          const state: CalendarHabit["state"] = amount >= target ? "done" : amount > 0 ? "partial" : "pending";
          if (state === "done" && !req.showDone) continue;
          (cell.habits ??= []).push({ habitId: h.id, name: h.name, color: h.icon.color, state, amount, target, at: at || undefined });
        }
      }
    }

    for (const c of days) {
      c.items.sort((x, y) => {
        const af = !(x.item.time.start ?? ""), bf = !(y.item.time.start ?? "");
        if (af !== bf) return af ? -1 : 1;
        const ts = x.item.time.start ?? "", ys = y.item.time.start ?? "";
        if (ts !== ys) return ts < ys ? -1 : 1;
        if (x.item.title !== y.item.title) return x.item.title < y.item.title ? -1 : 1;
        return x.item.id < y.item.id ? -1 : 1;
      });
    }
    return { start, end, days };
  }

  function buildListView(req: ListViewRequest): ListView {
    const day = req.day || todayLocal();
    const lookback = req.lookbackDays && req.lookbackDays > 0 ? req.lookbackDays : 180;
    const horizon = req.horizonDays && req.horizonDays > 0 ? req.horizonDays : 60;
    const groupBy = req.groupBy || "date";
    const from = addDays(day, -lookback);
    const to = addDays(day, horizon);
    const all = itemsInWindow(from, to, req);
    // 与内核 ItemStatus.Resolved() 对齐：成功与失败都算这一天结清。
    const pending = all.filter((o) => o.status !== 1 && o.status !== 3);
    const done = all.filter((o) => o.status === 1 || o.status === 3);
    const view: ListView = { day, groupBy, groups: [], overdueAll: 0 };

    if (groupBy === "date") {
      const bucket: Record<string, Occurrence[]> = { overdue: [], today: [], later: [] };
      for (const o of pending) {
        if (!o.day) bucket.later.push(o);
        else if (diffDays(o.day, day) > 0) bucket.overdue.push(o);
        else if (o.day === day) bucket.today.push(o);
        else bucket.later.push(o);
      }
      const labels: [string, string][] = [
        ["overdue", "逾期"],
        ["today", "未打卡"],
        ["later", "待办"],
        ["done", "已打卡"],
      ];
      for (const [key, label] of labels) {
        if (key === "done" && !req.showDone) continue;
        const xs = sortOcc(collapse(key === "done" ? done : bucket[key]));
        view.groups.push({ key, label, count: xs.length, items: xs });
      }
      view.overdueAll = collapse(bucket.overdue).length;
    } else if (groupBy === "category") {
      // 分类模式：每分类一列，列内按状态分子组（§9.3 / 条目5）。已打卡子组要有内容，
      // 所以 showDone 时把 done 实例也带进分组，由前端按 status/day 归子组（不改内核契约，只放开示例视图的数据）。
      const groups = collapse(req.showDone ? all : pending);
      const byCat = new Map<string, Occurrence[]>();
      for (const o of groups) {
        const k = o.item.category;
        if (!byCat.has(k)) byCat.set(k, []);
        byCat.get(k)!.push(o);
      }
      const order = new Map(db.categories.map((c, i) => [c.id, i]));
      const keys = [...byCat.keys()].sort((a, b) => (order.get(a) ?? 1 << 30) - (order.get(b) ?? 1 << 30));
      for (const k of keys) {
        const label = k ? db.categories.find((c) => c.id === k)?.name || "未分类" : "未分类";
        view.groups.push({ key: k || "uncategorized", label, count: byCat.get(k)!.length, items: sortOcc(byCat.get(k)!) });
      }
    } else if (groupBy === "quadrants") {
      // 四象限：2×2 象限卡，卡内按状态分子组（§9.4 / 条目6）。同样放开 done 让「已打卡」子组有内容。
      const groups = collapse(req.showDone ? all : pending);
      const qLabel: Record<number, string> = { 1: "重要且紧急", 2: "重要不紧急", 3: "不重要但紧急", 4: "不重要不紧急" };
      for (const p of [1, 2, 3, 4]) {
        const xs = sortOcc(groups.filter((o) => (o.item.priority || 4) === p));
        view.groups.push({ key: `q${p}`, label: qLabel[p], count: xs.length, items: xs });
      }
    } else {
      throw err(`service: 未知分组方式 "${groupBy}"`);
    }
    return view;
  }

  // ——— 习惯调度 ———

  function habitRepeat(h: Habit): Repeat {
    const r: Repeat = { unit: 1, interval: 1, skipLegalHolidays: false, followMakeupWorkday: false, smartSpan: false, ebbinghaus: false, end: { mode: 0 } };
    switch (h.freq.kind) {
      case 2:
        r.unit = 2;
        r.weekdays = h.freq.weekdays?.length ? h.freq.weekdays : [weekdayMon(h.startDay)];
        break;
      case 3:
        r.unit = 3;
        r.monthDays = h.freq.monthDays?.length ? h.freq.monthDays : [Number(h.startDay.slice(8, 10)) || 1];
        break;
      case 4:
        r.interval = Math.max(1, h.freq.everyN || 1);
        break;
    }
    return r;
  }
  function scheduledDays(h: Habit, from: Day, to: Day): Day[] {
    if (!isValidDay(h.startDay)) return [];
    return occurrenceDays({ date: { kind: 1, start: h.startDay }, repeat: habitRepeat(h) } as ListItem, from, to);
  }
  function clocksByDay(habitID: string): Record<Day, number> {
    const by: Record<Day, number> = {};
    for (const c of db.habitClocks) {
      if (c.habitId !== habitID) continue;
      by[c.day] = (by[c.day] ?? 0) + (c.amount === 0 ? 1 : c.amount);
    }
    return by;
  }
  function targetOf(h: Habit) { return h.mode === 2 ? h.dailyTarget : 1; }
  /** 周期起止：5=周一为一周之始，6=自然月。与内核 quotaPeriodOf 同口径。 */
  function quotaPeriod(kind: number, day: Day): [Day, Day] {
    if (kind === 6) {
      const first = day.slice(0, 8) + "01";
      const last = new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0);
      return [first, `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`];
    }
    const wd = (weekdayMon(day) + 6) % 7; // 0=周一
    const first = addDays(day, -wd);
    return [first, addDays(first, 6)];
  }
  /** 配额型频率按周期结算：过完的周期没打满才算错过，进行中的只算待打。 */
  function quotaStats(h: Habit, start: Day, end: Day, t: Day, by: Record<Day, number>) {
    const plan = Math.max(1, h.freq.plan || 1);
    const target = Math.max(0.0001, targetOf(h));
    let planned = 0, actual = 0, missed = 0, pending = 0;
    const seen = new Set<string>();
    for (let d = start; diffDays(d, end) >= 0; d = addDays(d, 1)) {
      const [ps, pe] = quotaPeriod(h.freq.kind || 5, d);
      if (seen.has(ps)) continue;
      seen.add(ps);
      planned += plan;
      let hit = 0;
      for (let x = ps > start ? ps : start; diffDays(x, pe < end ? pe : end) >= 0; x = addDays(x, 1)) {
        if ((by[x] ?? 0) >= target) hit++;
      }
      actual += hit;
      if (diffDays(pe, t) > 0) missed += Math.max(0, plan - hit);
      else if (diffDays(ps, t) >= 0 && hit < plan) pending = 1;
    }
    return { planned, actual, missed, pending };
  }
  function normalizeHabitReminders(list: Reminder[] = []): Reminder[] {
    const seen = new Set<string>();
    const out: Reminder[] = [];
    for (const r of list) {
      const t = (r.atTime || "").trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push({ id: r.id || `hr-${t}`, offset: { days: 0, hours: 0, minutes: 0 }, atTime: t });
    }
    return out.sort((a, b) => (a.atTime! < b.atTime! ? -1 : 1)).slice(0, 2);
  }
  function canBackfill(h: Habit, day: Day, t: Day): boolean {
    if (day === t) return true;
    if (diffDays(day, t) < 0) return false;
    if (h.backfillDays <= 0) return false;
    return diffDays(day, t) <= h.backfillDays;
  }
  function streakOf(h: Habit, by: Record<Day, number>, t: Day): number {
    const target = targetOf(h);
    let d = t;
    let n = 0;
    for (let i = 0; i < 400; i++) {
      if (diffDays(h.startDay, d) < 0) break;
      if (!scheduledDays(h, d, d).length) {
        d = addDays(d, -1);
        continue;
      }
      if ((by[d] ?? 0) >= target) {
        n++;
        d = addDays(d, -1);
        continue;
      }
      if (d === t) {
        d = addDays(d, -1);
        continue;
      }
      break;
    }
    return n;
  }

  /**
   * 打卡三态的内存实现，与内核 service.SetItemClockState 一一对应：
   * 取消时若是顺延来的只清状态、保留痕迹，否则整条例外删掉。
   */
  function clockState(itemID: string, day: Day, status: 0 | 1 | 3): void {
    const it = db.items.find((x) => x.id === itemID);
    if (!it) throw err(`service: 对象不存在: item ${itemID}`);
    if (status !== 0 && status !== 1 && status !== 3) throw err(`service: 打卡状态只接受未打卡/成功/失败，收到 ${status}`);
    const d = day || todayLocal();
    const key = `${itemID}:${d}`;
    const t = now();
    if (status === 0) {
      const o = db.overrides[key];
      if (!o) return;
      if (o.postponedFrom) db.overrides[key] = { ...o, status: 0, clockedAt: undefined, updatedAt: t };
      else delete db.overrides[key];
      emit("clock");
      return;
    }
    const o = db.overrides[key] ?? { id: `ovr:${itemID}:${d}`, itemId: itemID, day: d, status: 0, createdAt: t, updatedAt: t };
    db.overrides[key] = { ...o, status, clockedAt: t, updatedAt: t };
    emit("clock");
  }

  /** 子任务三态，与内核 service.SetChildClock 对齐。 */
  function childClock(childID: string, status: 0 | 1 | 3): void {
    const c = db.children.find((x) => x.id === childID);
    if (!c) throw err(`service: 对象不存在: child ${childID}`);
    if (status !== 0 && status !== 1 && status !== 3) throw err(`service: 子任务打卡状态只接受未打卡/成功/失败，收到 ${status}`);
    const done = status === 1;
    if (c.done === done && c.failed === (status === 3)) return; // 重复点同一状态不推进时间戳
    c.done = done;
    c.failed = status === 3;
    c.updatedAt = now();
    emit("child");
  }

  // ——— 实现 ———

  const impl: Omit<Kernel, "impl"> = {
    ...createMemoAPI(db, { call, now, newID, emit, err }),
    ...createFocusAPI(db, { call, now, newID, emit, err, buildListView, scheduledDays }),
    Start: () =>
      call<BootInfo>(() => ({
        dataDir: "（mock：内存数据，刷新即重置）",
        deviceId: "mock-device-0001",
        today: todayLocal(),
        channelKinds: ["localdir", "webdav", "feishuBase", "feishuDrive"], // 与 Go 里 sync.Register 的名字一致
        settings: db.settings,
      })),
    GetSettings: () => call(() => ({ ...db.settings })),
    // mock 模式没有磁盘上的应用日志，交给控制台；真内核写 dataDir/app-errors.log。
    ReportError: (where: string, detail: string) =>
      call(() => {
        console.warn(`[mock] 未捕获错误（${where}）\n${detail}`);
      }),
    SaveSettings: (s: Settings) =>
      call(() => {
        db.settings = { ...s, defaultGroup: s.defaultGroup || "date" };
        emit("settings");
        return undefined;
      }),

    ListView: (req: ListViewRequest) => call(() => buildListView(req)),
    CalendarView: (req: CalendarRequest) => call(() => buildCalendarView(req)),

    SaveItem: (input: ItemInput, scope: Scope, day: Day) =>
      call(() => {
        if (!input.title.trim()) throw err("service: 标题不能为空");
        if (input.labelIds.length > 10) throw err("service: 单条事项最多 10 个标签");
        if (input.date.start && !isValidDay(input.date.start)) throw err(`service: 起始日期 "${input.date.start}" 不是 YYYY-MM-DD`);
        if (input.date.kind === 2 && input.date.end && diffDays(input.date.end, input.date.start) > 0)
          throw err(`service: 结束日期 "${input.date.end}" 早于开始日期 "${input.date.start}"`);
        if (input.date.kind === 3 && !input.date.selected?.length && !input.date.start) throw err("service: 自选多日至少选一天");
        const t = now();
        const reminders = input.reminders.map((r) => ({ ...r, id: r.id || newID() }));
        if (!input.id) {
          const item: ListItem = seed({
            id: newID(),
            listId: input.listId || "list-default",
            title: input.title.trim(),
            remark: input.remark,
            category: input.category,
            priority: input.priority || 4,
            labelIds: input.labelIds,
            date: input.date,
            time: input.time,
            repeat: input.repeat || undefined,
            reminders,
            progress: input.progress === 0 ? -1 : input.progress,
          } as ListItem);
          db.items.push(item);
          emit("item");
          return [item];
        }
        const idx = db.items.findIndex((x) => x.id === input.id);
        if (idx < 0) throw err(`service: 对象不存在: item ${input.id}`);
        const existing = db.items[idx];
        const d = day || todayLocal();
        const recurring = !!existing.repeat;
        if (!recurring || scope === "all" || scope === ("" as Scope)) {
          Object.assign(existing, {
            title: input.title.trim(),
            remark: input.remark,
            category: input.category,
            priority: input.priority || 4,
            labelIds: input.labelIds,
            time: input.time,
            reminders,
            progress: input.progress === 0 ? -1 : input.progress,
          });
          if (!recurring) {
            existing.listId = input.listId || "list-default";
            existing.date = input.date;
            existing.repeat = input.repeat || undefined;
          }
          existing.updatedAt = t;
          emit("item");
          return [existing];
        }
        const truncate = (r: Repeat): Repeat => ({ ...r, end: { mode: 1, date: addDays(d, -1) } });
        const edited: ListItem = seed({
          ...existing,
          id: newID(),
          title: input.title.trim(),
          remark: input.remark,
          category: input.category,
          priority: input.priority || 4,
          labelIds: input.labelIds,
          time: input.time,
          reminders,
          progress: input.progress === 0 ? -1 : input.progress,
          createdAt: t,
          updatedAt: t,
        } as ListItem);
        const shiftAnchor = (spec: DateSpec, anchor: Day): DateSpec =>
          spec.kind === 2 ? { kind: 2, start: anchor, end: addDays(anchor, Math.max(0, diffDays(spec.start, spec.end || spec.start))) } : { kind: 1, start: anchor };
        const origTruncated: ListItem = { ...existing, repeat: truncate(existing.repeat!), updatedAt: t };
        db.items[idx] = origTruncated;
        const created = [origTruncated, edited];
        if (scope === "thisAndFuture") {
          edited.date = shiftAnchor(existing.date, d);
          edited.repeat = input.repeat && !(input.repeat.end.mode === 1 && input.repeat.end.date && diffDays(d, input.repeat.end.date) < 0) ? input.repeat : undefined;
        } else if (scope === "thisDay") {
          edited.date = { kind: 1, start: d };
          edited.repeat = undefined; // 「仅当天」忽略规则改动，与内核一致
          const contAnchor = addDays(d, 1);
          const restartOK = !(existing.repeat!.end.mode === 1 && existing.repeat!.end.date && diffDays(contAnchor, existing.repeat!.end.date) < 0);
          if (restartOK) {
            const forward: ListItem = seed({
              ...existing,
              id: newID(),
              date: shiftAnchor(existing.date, contAnchor),
              repeat: existing.repeat!,
              createdAt: t,
              updatedAt: t,
            } as ListItem);
            db.items.push(forward);
            created.push(forward);
          }
        } else {
          throw err(`service: 未知作用范围 "${scope}"`);
        }
        db.items.push(edited);
        emit("item");
        return created;
      }),

    DeleteItem: (itemID: string, scope: Scope, day: Day) =>
      call(() => {
        const idx = db.items.findIndex((x) => x.id === itemID);
        if (idx < 0) throw err(`service: 对象不存在: item ${itemID}`);
        const it = db.items[idx];
        const d = day || todayLocal();
        if (!it.repeat || scope === "all" || scope === ("" as Scope)) {
          db.items.splice(idx, 1);
          db.children = db.children.filter((c) => c.itemId !== itemID);
          emit("item");
          return undefined;
        }
        const cut: Repeat = { ...it.repeat, end: { mode: 1, date: addDays(d, -1) } };
        db.items[idx] = { ...it, repeat: cut, updatedAt: now() };
        if (scope === "thisDay") {
          const contAnchor = addDays(d, 1);
          if (!(cut.end.mode === 1 && cut.end.date && diffDays(contAnchor, cut.end.date) < 0)) {
            db.items.push({
              ...it,
              id: newID(),
              date: it.date.kind === 2 ? { kind: 2, start: contAnchor, end: addDays(contAnchor, Math.max(0, diffDays(it.date.start, it.date.end || it.date.start))) } : { kind: 1, start: contAnchor },
              repeat: it.repeat,
              createdAt: now(),
              updatedAt: now(),
            });
          }
        } else if (scope !== "thisAndFuture") {
          throw err(`service: 未知作用范围 "${scope}"`);
        }
        emit("item");
        return undefined;
      }),

    SetItemClock: (itemID: string, day: Day, on: boolean) =>
      call(() => {
        clockState(itemID, day, on ? 1 : 0);
      }),

    SetItemClockState: (itemID: string, day: Day, status: 0 | 1 | 2 | 3) =>
      call(() => {
        if (status === 2) throw err("service: 打卡状态只接受未打卡/成功/失败，收到 2");
        clockState(itemID, day, status);
      }),

    SetItemTop: (itemID: string, top: boolean) =>
      call(() => {
        const it = db.items.find((x) => x.id === itemID);
        if (!it) throw err(`service: 对象不存在: item ${itemID}`);
        if (it.isTop !== top) {
          it.isTop = top;
          it.updatedAt = now();
        }
        emit("item");
        return undefined;
      }),

    // 浏览器里没有内核算农历，示例视图就只给公历；日期面板会优雅留空农历位。
    // mock 不带农历/节气表（那套数据在 Go 的 calendar 包里），只把周末标出来，
    // 让视图网格在浏览器调试时不至于全空。
    LunarLabels: (days: Day[]) =>
      call(() => days.map((d) => {
        const wd = new Date(d + "T00:00:00").getDay();
        return { day: d, lunar: "", festival: "", term: "", weekend: wd === 0 || wd === 6 };
      })),

    ItemImages: (itemID: string) =>
      call(() => (db.images[itemID] ?? []).slice()),

    AddItemImage: (itemID: string, name: string, dataBase64: string) =>
      call(() => {
        const list = db.images[itemID] ?? (db.images[itemID] = []);
        if (list.length >= 5) throw err("一条事项最多 5 张图片");
        const t = now();
        const att: import("./types").Attachment = {
          id: newID(),
          ownerKind: "item",
          ownerId: itemID,
          // 浏览器里没有 dataDir，直接把 base64 当路径存下来，UI 原样能显示
          path: `data:${mimeOfImage(name)};base64,${dataBase64}`,
          mime: mimeOfImage(name),
          size: Math.round((dataBase64.length * 3) / 4),
          createdAt: t,
          updatedAt: t,
        };
        list.push(att);
        emit("attachment");
        return att;
      }),

    DeleteAttachment: (attachmentID: string) =>
      call(() => {
        for (const k of Object.keys(db.images)) db.images[k] = db.images[k].filter((a) => a.id !== attachmentID);
        emit("attachment");
        return undefined;
      }),

    PostponeItems: (itemIDs: string[], from: Day, to: Day) =>
      call(() => {
        const target = to || todayLocal();
        const day = from || target;
        if (day === target) return 0;
        let doneN = 0;
        const t = now();
        for (const id of itemIDs) {
          if (!db.items.find((x) => x.id === id)) throw err(`service: 对象不存在: item ${id}`);
          const key = `${id}:${target}`;
          const o = db.overrides[key] ?? { id: `ovr:${id}:${target}`, itemId: id, day: target, status: 0 as const, createdAt: t, updatedAt: t };
          db.overrides[key] = { ...o, postponedFrom: day, updatedAt: t };
          doneN++;
        }
        emit("clock");
        return doneN;
      }),

    OverdueItems: (day: Day) =>
      call<OverdueBundle>(() => {
        const d = day || todayLocal();
        const view = buildListView({ day: d, groupBy: "date", showDone: false, horizonDays: 1 });
        const g = view.groups.find((x) => x.key === "overdue");
        if (!g) return { itemIds: [], days: [] };
        return { itemIds: g.items.map((o) => o.item.id), days: g.items.map((o) => o.day) };
      }),

    Children: (itemID: string) =>
      call(() =>
        db.children
          .filter((c) => c.itemId === itemID)
          .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sort - b.sort || (a.id < b.id ? -1 : 1))
      ),
    SaveChild: (input: ChildInput) =>
      call(() => {
        if (!input.title.trim()) throw err("service: 子任务标题不能为空");
        if (!db.items.find((x) => x.id === input.itemId)) throw err(`service: 对象不存在: item ${input.itemId}`);
        const t = now();
        if (input.id) {
          const c = db.children.find((x) => x.id === input.id);
          if (!c) throw err(`service: 对象不存在: child ${input.id}`);
          Object.assign(c, { title: input.title.trim(), remark: input.remark, pinned: input.pinned, done: input.done, priority: input.priority || c.priority, due: input.due || c.due, updatedAt: t });
          emit("child");
          return c;
        }
        const c: Child = seed({
          id: newID(),
          itemId: input.itemId,
          title: input.title.trim(),
          remark: input.remark,
          sort: input.sort,
          pinned: input.pinned,
          priority: input.priority || 4,
          done: input.done,
          progress: -1,
          due: input.due || undefined,
        } as Child);
        db.children.push(c);
        emit("child");
        return c;
      }),
    SetChildDone: (childID: string, done: boolean) =>
      call(() => { childClock(childID, done ? 1 : 0); }),

    SetChildClock: (childID: string, status: 0 | 1 | 2 | 3) =>
      call(() => {
        if (status === 2) throw err("service: 子任务打卡状态只接受未打卡/成功/失败，收到 2");
        childClock(childID, status);
      }),
    DeleteChild: (childID: string) =>
      call(() => {
        db.children = db.children.filter((c) => c.id !== childID);
        emit("child");
        return undefined;
      }),

    Categories: () => call(() => [...db.categories].sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1))),
    SaveCategory: (input: CategoryInput) =>
      call(() => {
        const name = input.name.trim();
        if (!name) throw err("service: 分类名不能为空");
        const t = now();
        if (input.id) {
          const c = db.categories.find((x) => x.id === input.id);
          if (!c) throw err(`service: 对象不存在: category ${input.id}`);
          Object.assign(c, { name, icon: input.icon, color: input.color, updatedAt: t });
          emit("category");
          return c;
        }
        const c: Category = seed({ id: newID(), name, icon: input.icon, color: input.color, sort: db.categories.length });
        db.categories.push(c);
        emit("category");
        return c;
      }),
    DeleteCategory: (categoryID: string, withItems: boolean) =>
      call(() => {
        let affected = 0;
        for (const it of db.items) {
          if (it.category !== categoryID) continue;
          if (withItems) it.deletedAt = now();
          else it.category = "";
          affected++;
        }
        db.items = db.items.filter((x) => !x.deletedAt);
        db.categories = db.categories.filter((c) => c.id !== categoryID);
        emit("category");
        return affected;
      }),
    ReorderCategories: (orderedIDs: string[]) =>
      call(() => {
        orderedIDs.forEach((id, i) => {
          const c = db.categories.find((x) => x.id === id);
          if (c) c.sort = i;
        });
        emit("category");
        return undefined;
      }),
    Labels: () => call(() => [...db.labels].sort((a, b) => (a.name < b.name ? -1 : 1))),
    SaveLabel: (input: LabelInput) =>
      call(() => {
        const name = input.name.trim();
        if (!name) throw err("service: 标签名不能为空");
        if (input.id) {
          const l = db.labels.find((x) => x.id === input.id);
          if (!l) throw err(`service: 对象不存在: label ${input.id}`);
          l.name = name;
          l.color = input.color;
          l.updatedAt = now();
          emit("label");
          return l;
        }
        const dup = db.labels.find((x) => x.name === name);
        if (dup) return dup; // 同名复用，与内核一致
        const l: Label = seed({ id: newID(), name, color: input.color });
        db.labels.push(l);
        emit("label");
        return l;
      }),
    DeleteLabel: (labelID: string) =>
      call(() => {
        let touched = 0;
        for (const it of db.items) {
          if (!it.labelIds.includes(labelID)) continue;
          it.labelIds = it.labelIds.filter((x) => x !== labelID);
          touched++;
        }
        db.labels = db.labels.filter((l) => l.id !== labelID);
        emit("label");
        return touched;
      }),
    Lists: () => call(() => [...db.lists].sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1))),
    SaveList: (input: ListInput) =>
      call(() => {
        const name = input.name.trim();
        if (!name) throw err("service: 清单本名称不能为空");
        const t = now();
        if (input.id) {
          const l = db.lists.find((x) => x.id === input.id);
          if (!l) throw err(`service: 对象不存在: list ${input.id}`);
          Object.assign(l, { name, icon: input.icon, color: input.color, updatedAt: t });
          emit("list");
          return l;
        }
        const l: PlList = seed({ id: newID(), name, icon: input.icon, color: input.color, sort: 100 });
        db.lists.push(l);
        emit("list");
        return l;
      }),
    DeleteList: (listID: string, withItems: boolean) =>
      call(() => {
        if (listID === "list-default") throw err("service: 默认清单本不可删除");
        let affected = 0;
        for (const it of db.items) {
          if (it.listId !== listID) continue;
          if (withItems) it.deletedAt = now();
          else it.listId = "list-default";
          affected++;
        }
        db.items = db.items.filter((x) => !x.deletedAt);
        db.lists = db.lists.filter((l) => l.id !== listID);
        emit("list");
        return affected;
      }),

    HabitMonthView: (day: Day, month: string) =>
      call<HabitView>(() => {
        const d = day || todayLocal();
        const m = month || d.slice(0, 7);
        const [mStart, mEnd] = monthSpan(m);
        const view: HabitView = { day: d, month: m, contexts: db.contexts.map((c) => c.id), rowsByContext: {}, totalClockDays: 0 };
        for (const h of db.habits) {
          const by = clocksByDay(h.id);
          const target = targetOf(h);
          const cells = scheduledDays(h, mStart, mEnd).map((dd) => {
            const amount = by[dd] ?? 0;
            let state: import("./types").HabitCellState;
            if (amount >= target) state = "done";
            else if (amount > 0) state = "partial";
            else if (diffDays(d, dd) > 0) state = "future"; // 与内核一致：DiffDays(viewDay, cellDay) > 0 即未到期
            else if (dd === todayLocal()) state = "pending"; // 与内核一致：今天还没过完，不算错过
            else state = "missed";
            return { day: dd, state, amount, target };
          });
          const row: import("./types").HabitRow = {
            habit: h,
            contextName: db.contexts.find((c) => c.id === h.context)?.name ?? "",
            day: d,
            amount: by[d] ?? 0,
            target,
            clocked: (by[d] ?? 0) >= target,
            dueToday: scheduledDays(h, d, d).length > 0,
            streak: streakOf(h, by, d),
            totalDays: Object.keys(by).filter((x) => x >= h.startDay && x <= d).length,
            canBackfill: canBackfill(h, d, todayLocal()),
            month: cells,
          };
          const key = h.context || "ctx-always";
          (view.rowsByContext[key] ??= []).push(row);
          view.totalClockDays += row.totalDays;
        }
        return view;
      }),

    HabitStat: (req) =>
      call<HabitStat>(() => {
        if (!req.start || !req.end) throw err("service: 统计区间不能为空");
        if (diffDays(req.start, req.end) < 0) throw err(`service: 统计区间反了：${req.start} → ${req.end}`);
        if (diffDays(req.start, req.end) > 380) throw err("service: 统计区间过长（最多一年）");
        const today = todayLocal();
        const span: Day[] = [];
        for (let d = req.start; span.length <= 400; d = addDays(d, 1)) {
          span.push(d);
          if (d === req.end) break;
        }
        const days: HabitStatDaySummary[] = span.map((d) => ({
          day: d, scheduled: 0, done: 0, checked: 0, perfect: false, future: diffDays(today, d) > 0,
        }));
        const byIdx = new Map<string, HabitStatDaySummary>();
        days.forEach((d, i) => byIdx.set(d.day, days[i]));
        const out: HabitStat = { start: req.start, end: req.end, today, habits: [], days, summary: { checkins: 0, longestStreak: 0, perfectDays: 0, scheduledDays: 0 } };
        for (const h of db.habits) {
          const by = clocksByDay(h.id);
          const target = targetOf(h);
          const sched = new Set(scheduledDays(h, req.start, req.end));
          const row: HabitStatHabit = {
            habitId: h.id, name: h.name, icon: h.icon, context: h.context,
            mode: h.mode, unit: db.units.find((u) => u.id === h.unitId)?.name ?? "",
            days: [], checked: 0, done: 0, scheduled: 0, streak: streakOf(h, by, req.end),
          };
          for (const d of span) {
            const amount = by[d] ?? 0;
            const due = sched.has(d) && d >= h.startDay;
            // 与内核一致：有打卡就先算打卡（哪怕那天没排期），其次才谈休息/未到期
            let state: HabitStatState = "rest";
            if (target > 0 && amount >= target) state = "done";
            else if (amount > 0) state = "partial";
            else if (!due) state = "rest";
            else if (diffDays(today, d) > 0) state = "future";
            else if (d === today) state = "pending";
            else state = "missed";
            row.days.push({ day: d, state, amount, target });
            const sum = byIdx.get(d)!;
            if (due) { row.scheduled++; sum.scheduled++; }
            if (amount > 0) {
              row.checked++; sum.checked++; out.summary.checkins++;
              if (due && amount >= target) { row.done++; sum.done++; }
            }
          }
          out.habits.push(row);
        }
        // 完美打卡与最长连续：与内核逐行同口径（未来天既不断也不续；已过完的应打日没打满就断）
        let run = 0;
        for (const d of days) {
          if (d.scheduled > 0) {
            out.summary.scheduledDays++;
            if (!d.future && d.done === d.scheduled) { d.perfect = true; out.summary.perfectDays++; }
          }
          if (d.checked > 0 && !d.future) { run = Math.max(0, run) + 1; out.summary.longestStreak = Math.max(out.summary.longestStreak, run); continue; }
          if (d.future) { if (d.scheduled > 0) run = 0; continue; }
          if (d.scheduled > 0) run = 0;
        }
        out.habits.sort((a, b) => (a.context !== b.context ? (a.context < b.context ? -1 : 1) : a.habitId < b.habitId ? -1 : 1));
        return out;
      }),

    SaveHabit: (input) =>
      call(() => {
        const name = input.name.trim();
        if (!name) throw err("service: 习惯名不能为空");
        const mode = (input.mode || 1) as 1 | 2;
        if (mode === 2 && input.dailyTarget <= 0) throw err("service: 每天多次的习惯要设每日打卡总量");
        const kind = (input.freq.kind || 1) as number;
        const reminders = normalizeHabitReminders(input.reminders);
        if (reminders.length > 2) throw err(`service: 一个习惯最多 2 条提醒`);
        const freq = { ...(input.freq.kind ? input.freq : { kind: 1 }), plan: kind === 5 || kind === 6 ? Math.max(1, input.freq.plan || 1) : input.freq.plan };
        const t = now();
        if (input.id) {
          const h = db.habits.find((x) => x.id === input.id);
          if (!h) throw err(`service: 对象不存在: habit ${input.id}`);
          Object.assign(h, {
            name,
            icon: input.icon,
            context: input.context,
            freq,
            mode,
            autoClock: input.autoClock,
            unitId: input.unitId,
            dailyTarget: input.dailyTarget,
            perClock: input.perClock,
            reminders,
            popMark: input.popMark === undefined ? h.popMark : input.popMark,
            backfillDays: input.backfillDays > 0 ? input.backfillDays : h.backfillDays,
            updatedAt: t,
          });
          if (input.startDay && input.startDay !== h.startDay) h.startDay = input.startDay;
          emit("habit");
          return h;
        }
        const h: Habit = seed({
          id: newID(),
          name,
          icon: input.icon,
          context: input.context,
          freq,
          mode,
          autoClock: input.autoClock,
          unitId: input.unitId,
          dailyTarget: input.dailyTarget,
          perClock: input.perClock,
          reminders,
          popMark: input.popMark === undefined ? true : input.popMark,
          startDay: input.startDay || todayLocal(),
          backfillDays: input.backfillDays,
        } as Habit);
        db.habits.push(h);
        emit("habit");
        return h;
      }),
    DeleteHabit: (habitID: string) =>
      call(() => {
        db.habits = db.habits.filter((h) => h.id !== habitID);
        emit("habit");
        return undefined;
      }),
    ClockHabit: (habitID: string, day: Day, amount: number) =>
      call<HabitClock>(() => {
        const h = db.habits.find((x) => x.id === habitID);
        if (!h) throw err(`service: 对象不存在: habit ${habitID}`);
        const d = day || todayLocal();
        const t = todayLocal();
        if (!canBackfill(h, d, t)) throw err(`service: ${d} 不在可补打卡范围内（可回溯 ${h.backfillDays} 天）`);
        let amt = amount;
        if (amt <= 0) {
          amt = 1;
          if (h.mode === 2 && h.perClock > 0) amt = h.perClock;
        }
        const c: HabitClock = {
          id: h.mode === 1 ? `dc:${h.id}:${d}` : newID(),
          habitId: h.id,
          day: d,
          amount: amt,
          clockedAt: now(),
          manual: d !== t,
          updatedAt: at,
        };
        const exist = db.habitClocks.findIndex((x) => x.id === c.id);
        if (exist >= 0) db.habitClocks[exist] = c;
        else db.habitClocks.push(c);
        emit("habitClock");
        return c;
      }),
    CancelHabitClock: (habitID: string, day: Day) =>
      call(() => {
        const d = day || todayLocal();
        const before = db.habitClocks.length;
        db.habitClocks = db.habitClocks.filter((c) => !(c.habitId === habitID && c.day === d));
        emit("habitClock");
        return before - db.habitClocks.length;
      }),
    HabitStats: (habitID: string, month: string) =>
      call<HabitStats>(() => {
        const h = db.habits.find((x) => x.id === habitID);
        if (!h) throw err(`service: 对象不存在: habit ${habitID}`);
        const t = todayLocal();
        const m = month || t.slice(0, 7);
        let [start, end] = monthSpan(m);
        if (diffDays(t, end) > 0) end = t;
        if (diffDays(start, h.startDay) > 0) start = h.startDay;
        const by = clocksByDay(habitID);
        const target = targetOf(h);
        let planned = 0;
        let actual = 0;
        let pending = 0;
        let missed = 0;
        if (h.freq.kind === 5 || h.freq.kind === 6) {
          const q = quotaStats(h, start, end, t, by);
          planned = q.planned; actual = q.actual; pending = q.pending; missed = q.missed;
        } else {
          for (const d of scheduledDays(h, start, end)) {
            planned++;
            if ((by[d] ?? 0) >= target) actual++;
            else if (d === t) pending++; // 今天还没过完，不算错过
            else missed++;
          }
        }
        let best = 0;
        let run = 0;
        for (const d of scheduledDays(h, h.startDay, t)) {
          if ((by[d] ?? 0) >= target) {
            run++;
            best = Math.max(best, run);
          } else run = 0;
        }
        return {
          planned,
          actual,
          missed,
          pending,
          ratio: planned ? Math.round((actual * 100) / planned) : 0,
          startDay: h.startDay,
          daysSince: Math.max(0, diffDays(h.startDay, t)),
          totalDays: Object.keys(by).filter((x) => x >= h.startDay && x <= t).length,
          longestStreak: best,
        };
      }),
    HabitMarks: (habitID: string) =>
      call(() =>
        [...db.habitMarks]
          .filter((x) => x.habitId === habitID)
          .sort((a, b) => (a.day !== b.day ? (a.day < b.day ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
      ),
    SaveHabitMark: (input) =>
      call(() => {
        if (!input.text.trim() && !input.imagePath) throw err("service: 日志要么写心得要么配图");
        if (!db.habits.find((h) => h.id === input.habitId)) throw err(`service: 对象不存在: habit ${input.habitId}`);
        const t = now();
        if (input.id) {
          const mk = db.habitMarks.find((x) => x.id === input.id);
          if (!mk) throw err(`service: 对象不存在: mark ${input.id}`);
          mk.text = input.text;
          mk.imagePath = input.imagePath;
          if (input.time) mk.time = input.time;
          mk.updatedAt = t;
          emit("habitMark");
          return mk;
        }
        const mk: HabitMark = seed({
          id: newID(),
          habitId: input.habitId,
          clockId: input.clockId,
          day: input.day || todayLocal(),
          time: input.time || "",
          text: input.text,
          imagePath: input.imagePath,
        } as HabitMark);
        db.habitMarks.push(mk);
        emit("habitMark");
        return mk;
      }),
    DeleteHabitMark: (markID: string) =>
      call(() => {
        db.habitMarks = db.habitMarks.filter((x) => x.id !== markID);
        emit("habitMark");
        return undefined;
      }),
    HabitUnits: () => call(() => [...db.units]),
    SaveHabitUnit: (input) =>
      call(() => {
        const name = input.name.trim();
        if (!name || [...name].length > 2) throw err("service: 单位名需 1-2 个字符");
        const dup = db.units.find((u) => u.name === name);
        if (dup && dup.id !== input.id) return dup;
        const t = now();
        if (input.id) {
          const u = db.units.find((x) => x.id === input.id);
          if (!u) throw err(`service: 对象不存在: unit ${input.id}`);
          u.name = name;
          u.updatedAt = t;
          emit("habitUnit");
          return u;
        }
        const u: HabitUnit = seed({ id: newID(), name });
        db.units.push(u);
        emit("habitUnit");
        return u;
      }),
    HabitContexts: () => call(() => [...db.contexts].sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1))),
    SaveHabitContext: (input) =>
      call(() => {
        const name = input.name.trim();
        if (!name) throw err("service: 情境名不能为空");
        const t = now();
        if (input.id) {
          const c = db.contexts.find((x) => x.id === input.id);
          if (!c) throw err(`service: 对象不存在: context ${input.id}`);
          c.name = name;
          c.updatedAt = t;
          emit("habitContext");
          return c;
        }
        const c: HabitContext = seed({ id: newID(), name, sort: input.sort });
        db.contexts.push(c);
        emit("habitContext");
        return c;
      }),
    DeleteHabitContext: (contextID: string) =>
      call(() => {
        if (contextID === "ctx-always") throw err("service: 「全天」情境不可删除");
        let moved = 0;
        for (const h of db.habits) {
          if (h.context !== contextID) continue;
          h.context = "";
          moved++;
        }
        db.contexts = db.contexts.filter((c) => c.id !== contextID);
        emit("habitContext");
        return moved;
      }),

    UpcomingReminders: (day: Day, until: Day) =>
      call<ReminderFire[]>(() => {
        const d0 = day || todayLocal();
        const d1 = until || addDays(d0, 7);
        if (diffDays(d1, d0) > 0) throw err(`service: 提醒区间反了：${d0} → ${d1}`);
        const fires: ReminderFire[] = [];
        const tnow = new Date();
        for (const it of db.items) {
          if (!it.reminders.length) continue;
          for (const dayStr of occurrenceDays(it, d0, d1)) {
            const ovr = db.overrides[`${it.id}:${dayStr}`];
            if (ovr?.status === 1) continue;
            const [y, m, dd] = dayStr.split("-").map(Number);
            let hh = 9;
            let mi = 0;
            if (it.time.kind !== 0 && it.time.start) {
              const parts = it.time.start.split(":").map(Number);
              hh = parts[0] ?? 9;
              mi = parts[1] ?? 0;
            }
            const base = new Date(y, m - 1, dd, hh, mi);
            for (const r of it.reminders) {
              const fire = reminderFireTime(base, r);
              if (!fire || fire.getTime() < tnow.getTime()) continue;
              fires.push({ itemId: it.id, reminderId: r.id, title: it.title, day: dayStr, at: fire.toISOString() });
            }
          }
        }
        // 习惯的提醒挂在排期日的固定时刻上；当天已经打满就不再提醒（与内核同口径）。
        for (const h of db.habits) {
          if (!h.reminders?.length) continue;
          const by = clocksByDay(h.id);
          const target = Math.max(0.0001, targetOf(h));
          for (const dayStr of scheduledDays(h, d0, d1)) {
            if ((by[dayStr] ?? 0) >= target) continue;
            for (const r of h.reminders) {
              const [y, m, dd] = dayStr.split("-").map(Number);
              const parts = (r.atTime || "09:00").split(":").map(Number);
              const fire = new Date(y, m - 1, dd, parts[0] ?? 9, parts[1] ?? 0);
              if (fire.getTime() < tnow.getTime()) continue;
              fires.push({ itemId: h.id, reminderId: r.id, title: h.name, day: dayStr, at: fire.toISOString(), habit: true });
            }
          }
        }
        fires.sort((a, b) => (a.at < b.at ? -1 : 1));
        return fires;
      }),

    SyncChannels: () => call(() => db.channels.map((c) => ({ ...c, options: { ...c.options } }))),
    SaveSyncChannel: (cfg: SyncConfig) =>
      call(() => {
        if (!cfg.name) throw err("sync: 通道名不能为空");
        if (!["localdir", "webdav"].includes(cfg.kind)) throw err(`sync: 未注册的通道类型 "${cfg.kind}"（已注册 localdir/webdav）`);
        const idx = db.channels.findIndex((c) => c.name === cfg.name);
        if (idx >= 0) db.channels[idx] = cfg;
        else db.channels.push(cfg);
        return undefined;
      }),
    RemoveSyncChannel: (name: string) =>
      call(() => {
        const before = db.channels.length;
        db.channels = db.channels.filter((c) => c.name !== name);
        if (db.channels.length === before) throw err(`sync: 通道 "${name}" 不存在`);
        return undefined;
      }),
    ProbeSyncChannel: (cfg: SyncConfig) =>
      call(() => {
        if (cfg.kind === "localdir" && !(cfg.options?.path ?? "").trim()) throw err("localdir: 缺少 path 配置项（本地同步目录）");
        if (cfg.kind === "webdav" && !(cfg.options?.url ?? "").trim()) throw err("webdav: 缺少 url 配置项");
        return undefined;
      }),
    SyncNow: (name: string) =>
      call<SyncResult[]>(() => {
        const list = name ? db.channels.filter((c) => c.name === name) : db.channels.filter((c) => c.enabled);
        if (name && !list.length) throw err(`sync: 通道 "${name}" 不存在`);
        const t = now();
        const results = list.map((c) => {
          const state = db.syncStates[c.name] ?? { channel: c.name, lastSyncAt: "", lastPushedAt: "", note: "" };
          const revision = Number(state.note.replace("rev:", "") || 0) + 1;
          const res: SyncResult = {
            channel: c.name,
            applied: 0,
            pushed: Math.floor(Math.random() * 5),
            conflicts: 0,
            revision,
            syncedAt: t,
            skipped: ProbeOK(c) ? undefined : `sync: 通道 "${c.name}" 配置不完整，已跳过`,
          };
          if (!res.skipped) db.syncStates[c.name] = { channel: c.name, lastSyncAt: t, lastPushedAt: t, note: `rev:${revision}` };
          return res;
        });
        listeners.get("sync:done")?.forEach((l) => l(results));
        return results;
      }),
    SyncState: (name: string) =>
      call<SyncState>(() => db.syncStates[name] ?? { channel: name, lastSyncAt: "", lastPushedAt: "", note: "" }),

    On: (event: KernelEventName, cb: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      // 演示辅助：mock 里没有壳层定时器，订阅后 2.5 秒模拟一次提醒到点，
      // 让「reminder:due → 顶部横幅」的链路能在浏览器里走通。真壳由 api.go 的 reminderLoop 驱动。
      if (event === "reminder:due" && !reminderDemoSent) {
        reminderDemoSent = true;
        setTimeout(() => {
          const demo: ReminderFire = {
            itemId: iMeeting.id,
            reminderId: iMeeting.reminders[0]?.id ?? "demo",
            title: iMeeting.title,
            day: todayLocal(),
            at: new Date(Date.now() + 60_000).toISOString(),
          };
          listeners.get("reminder:due")?.forEach((l) => l([demo]));
        }, 2500);
      }
      return () => listeners.get(event)!.delete(cb);
    },
  };

  function ProbeOK(c: SyncConfig): boolean {
    try {
      if (c.kind === "localdir") return !!(c.options?.path ?? "").trim();
      if (c.kind === "webdav") return !!(c.options?.url ?? "").trim();
      return false;
    } catch {
      return false;
    }
  }

  return { ...impl, impl: "mock" };
}

function reminderFireTime(base: Date, r: Reminder): Date | null {
  const { days = 0, hours = 0, minutes = 0 } = r.offset || { days: 0, hours: 0, minutes: 0 };
  if (days || hours || minutes) {
    return new Date(base.getTime() - ((days * 24 + hours) * 60 + minutes) * 60_000);
  }
  if (r.atDay && isValidDay(r.atDay)) {
    const [y, m, d] = r.atDay.split("-").map(Number);
    const [hh = 9, mi = 0] = (r.atTime || "09:00").split(":").map(Number);
    return new Date(y, m - 1, d, hh, mi);
  }
  if (r.atTime) {
    const [hh = 9, mi = 0] = r.atTime.split(":").map(Number);
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mi);
  }
  return base; // 准时
}

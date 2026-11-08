// 本文件是手写的「绑定替身」：字段全部照抄 Go 侧 json tag
// （internal/core/service/{list,habit,catalog,reminders,service}.go、
//   internal/core/model/{model,repeat}.go、api.go、internal/core/sync/config.go）。
//
// ⚠️ 等 `wails3 generate bindings` 可用后，本文件会被生成的绑定整体替换；
// 届时只有 api/client.ts 需要改一行 import，UI 代码不动。client.ts 是唯一接缝。

/** 本地日历日，"2026-11-05"。只做字典序比较与 ±N 天计算。 */
export type Day = string;
/** UTC 定宽串绝对时刻，"2026-11-05T09:42:03.512Z"。展示必须转本地时区。 */
export type ClockTime = string;

// ---- 枚举（Go 里是 int，json 数字；这里保留数字字面量联合）----

/** DateKind: 1=单日 2=跨天 3=自选多日 */
export type DateKind = 1 | 2 | 3;
/** TimeKind: 0=全天 1=时间点 2=时间段 */
export type TimeKind = 0 | 1 | 2;
/** Priority 四象限：1 重要且紧急 2 重要不紧急 3 不重要但紧急 4 不重要不紧急（0 视为 4） */
export type Priority = 1 | 2 | 3 | 4;
/** ItemStatus：0 未打卡 1 成功打卡 2 本次跳过 3 失败打卡（与内核 model.ItemStatus 同值） */
export type ItemStatus = 0 | 1 | 2 | 3;

/** 已结清：成功或失败都离开未打卡桶。 */
export const isResolved = (s: ItemStatus) => s === 1 || s === 3;
/** RepeatUnit：1 天 2 周 3 月 4 年 */
export type RepeatUnit = 1 | 2 | 3 | 4;

/** 月历格子的农历信息，由内核 calendar 包算好后批量返回（一次一个月）。 */
export interface LunarCell {
  day: Day;
  /** 农历日名，如「廿六」「正月初一」 */
  lunar: string;
  /** 节日名；没有则为空串 */
  festival: string;
  /** 节气名（立冬/小雪…），当天不是节气则为空 */
  term?: string;
  /** 周六/周日 */
  weekend?: boolean;
  /** 班休标记：「休」= 法定节假日，「班」= 调休上班的周末，空 = 普通日子。
   *  内置年度表（2025-2027）覆盖之外的一年没有标记——宁可少标，不标错。 */
  mark?: string;
  /** 该标记的数据出处，tooltip 用 */
  markSource?: string;
}

/** 某一年的节假日数据来源（内核 calendar.YearInfo）。 */
export interface CalendarYearInfo {
  year: number;
  /** builtin = 程序内置，local = 本机导入并覆盖了内置的同一年 */
  origin: string;
  holidayCount: number;
  makeupCount: number;
  source: string;
  lastVerified: string;
}

/** 当前生效的节假日数据全貌（内核 calendar.Status）。 */
export interface CalendarStatus {
  years: CalendarYearInfo[];
  builtinYears: number[];
  localYears: number[];
  /** 放 <year>.json 即可覆盖内置同一年的目录 */
  dir: string;
}

/** 事项图片附件。文件本体在 dataDir/attachments，经 /attachments/<file> 读取。 */
export interface Attachment {
  id: string;
  ownerKind: string;
  ownerId: string;
  /** 相对数据目录的路径，如 attachments/xxx.png */
  path: string;
  mime: string;
  size: number;
  createdAt: string;
  updatedAt: string;
}
/** EndMode：0 永不 1 按日期 2 按次数（含首次） */
export type EndMode = 0 | 1 | 2;
/** HabitMode：1 每天一次 2 每天多次（量化） */
export type HabitMode = 1 | 2;
/** FreqKind：1 每天 2 固定周几 3 每月几日 4 每隔N天 */
// 1=每天 2=固定周几 3=每月几日 4=每隔N天 5=每周N天（配额） 6=每月N天（配额）
// 5/6 不指定具体哪天，周期内任意天可打，计划数按周期结算（内核 Frequency.Plan）。
export type FreqKind = 1 | 2 | 3 | 4 | 5 | 6;

/** Scope 修改/删除重复事项的作用范围（service.Scope） */
export type Scope = "all" | "thisDay" | "thisAndFuture";

// ---- 领域对象（model.*）----

export interface DateSpec {
  kind: DateKind;
  start: Day;
  end?: Day;
  selected?: Day[];
}

export interface TimeSpec {
  kind: TimeKind;
  /** 本地墙钟 "HH:MM" */
  start?: string;
  end?: string;
}

export interface ReminderOffset {
  days: number;
  hours: number;
  minutes: number;
}

export interface Reminder {
  id: string;
  offset: ReminderOffset;
  /** 固定日期提醒（与 offset 互斥；两者都给时 offset 优先） */
  atDay?: Day;
  atTime?: string;
  firedAt?: ClockTime;
}

export interface EndSpec {
  mode: EndMode;
  date?: Day;
  count?: number;
}

export interface Repeat {
  unit: RepeatUnit;
  /** 每 N 个 unit，0 按 1 处理 */
  interval: number;
  /** 1=周一..7=周日 */
  weekdays?: number[];
  /** 负数从月末倒数，-1=最后一天 */
  monthDays?: number[];
  yearMonth?: number;
  yearDay?: number;
  skipLegalHolidays: boolean;
  followMakeupWorkday: boolean;
  smartSpan: boolean;
  ebbinghaus: boolean;
  end: EndSpec;
}

export interface PlList {
  id: string;
  name: string;
  icon: string;
  color: string;
  sort: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface ListItem {
  id: string;
  listId: string;
  title: string;
  remark: string;
  /** 分类 ID，空=无分类 */
  category: string;
  priority: Priority;
  labelIds: string[];
  date: DateSpec;
  time: TimeSpec;
  repeat?: Repeat;
  reminders: Reminder[];
  /** -1 未设置，0-100 手动进度 */
  progress: number;
  /** 置顶：只影响列内排序，右键菜单与详情「⋯」都能切 */
  isTop: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface Child {
  id: string;
  itemId: string;
  title: string;
  remark: string;
  sort: number;
  pinned: boolean;
  priority: Priority;
  done: boolean;
  /** 失败打卡：与 done 互斥，子任务也是三态 */
  failed: boolean;
  progress: number;
  due?: Day;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** 重复事项在某一天的例外（打卡/跳过/顺延）。主键 ovr:<itemId>:<day>。 */
export interface OccurrenceOverride {
  id: string;
  itemId: string;
  day: Day;
  status: ItemStatus;
  clockedAt?: ClockTime;
  postponedFrom?: Day;
  note?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface Category {
  id: string;
  name: string;
  /** 内置图标名或单字 */
  icon: string;
  color: string;
  sort: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface Habit {
  id: string;
  name: string;
  icon: HabitIcon;
  /** 情境 ID，空=「全天」 */
  context: string;
  freq: Frequency;
  mode: HabitMode;
  autoClock: boolean;
  unitId?: string;
  dailyTarget: number;
  perClock: number;
  /** 习惯自己的固定时刻提醒（最多 2 条，只用 atTime） */
  reminders?: Reminder[];
  /** 打卡时是否弹「打卡心得」窗口 */
  popMark: boolean;
  startDay: Day;
  /** 可回溯补打卡天数，0=不允许 */
  backfillDays: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface HabitIcon {
  /** "image"=内置图标名 引用 | "text"=单个汉字 */
  kind: "image" | "text";
  ref: string;
  color: string;
}

export interface Frequency {
  kind: FreqKind;
  weekdays?: number[];
  monthDays?: number[];
  everyN?: number;
  /** 配额型频率（5/6）一个周期要打满的天数 */
  plan?: number;
}

export interface HabitClock {
  id: string;
  habitId: string;
  day: Day;
  amount: number;
  clockedAt: ClockTime;
  /** true=补打卡/自动，false=当天手动 */
  manual: boolean;
  updatedAt: string;
  deletedAt?: string;
}

export interface HabitMark {
  id: string;
  habitId: string;
  clockId?: string;
  day: Day;
  /** 本地墙钟 HH:MM */
  time: string;
  text: string;
  imagePath?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface HabitUnit {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface HabitContext {
  id: string;
  name: string;
  sort: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

// ---- 视图层（service.*）----

export interface Occurrence {
  item: ListItem;
  /** 无日期事项此格为空串 */
  day: Day;
  status: ItemStatus;
  clockedAt?: ClockTime;
  /** 顺延来源日（非空表示这条实例是从那天挪来的） */
  postponedFrom?: Day;
  overrideId?: string;
  childTotal: number;
  childDone: number;
  overdueDays: number;
}

export interface GroupView {
  key: string;
  label: string;
  count: number;
  items: Occurrence[];
}

export interface ListView {
  day: Day;
  groupBy: string;
  groups: GroupView[];
  overdueAll: number;
}

export interface ListViewRequest {
  day?: Day;
  groupBy?: string; // date | category | quadrants
  listId?: string;
  categoryId?: string;
  labelId?: string;
  showDone: boolean;
  lookbackDays?: number;
  horizonDays?: number;
}

/**
 * 视图模块（日/周/月）的区间取数请求。
 *
 * 与 ListViewRequest 的区别是刻意的：清单页要「今天该做什么」所以折叠成桶，
 * 视图要「这段时间哪天有什么」所以逐日铺开——折叠会把跨天事项压成一条，网格画不出跨天条。
 * listIds/categoryIds/labelIds 是「只看」，hideCategoryIds 是「明确不看」（自定义视图的反向列表），
 * 空串代表「未分类」。
 */
export interface CalendarRequest {
  start?: Day;
  end?: Day;
  showDone: boolean;
  includeHabits?: boolean;
  listIds?: string[];
  categoryIds?: string[];
  hideCategoryIds?: string[];
  // 习惯侧反向过滤（参考站的 viewHabitClassifyNotShow）。
  hideHabitContexts?: string[];
  labelIds?: string[];
}

/** 网格里的一条习惯。带 habitId 才能点开具体习惯、才能涂它自己的颜色。 */
export interface CalendarHabit {
  habitId: string;
  /** 习惯名与图标色随查询返回，视图不必再拉一次习惯列表 */
  name: string;
  color: string;
  state: "done" | "partial" | "pending";
  amount: number;
  target: number;
  at?: string;
}

export interface CalendarDay {
  day: Day;
  items: Occurrence[];
  habits?: CalendarHabit[];
}

export interface CalendarView {
  start: Day;
  end: Day;
  days: CalendarDay[];
}

export interface OverdueBundle {
  itemIds: string[];
  days: Day[];
}

// ---- 入参 ----

export interface ItemInput {
  id?: string;
  listId?: string;
  title: string;
  remark: string;
  category: string;
  priority: Priority;
  labelIds: string[];
  date: DateSpec;
  time: TimeSpec;
  repeat?: Repeat;
  reminders: Reminder[];
  /** 省略表示不改进度；0 是用户显式设定的 0%，与「没设过」不同 */
  progress?: number;
}

export interface ChildInput {
  id?: string;
  itemId: string;
  title: string;
  remark: string;
  priority: Priority;
  due?: Day;
  pinned: boolean;
  done: boolean;
  sort: number;
}

export interface CategoryInput {
  id?: string;
  name: string;
  icon: string;
  color: string;
}

export interface LabelInput {
  id?: string;
  name: string;
  color: string;
}

export interface ListInput {
  id?: string;
  name: string;
  icon: string;
  color: string;
}

export interface HabitInput {
  id?: string;
  name: string;
  icon: HabitIcon;
  context: string;
  freq: Frequency;
  mode: HabitMode;
  autoClock: boolean;
  unitId?: string;
  dailyTarget: number;
  perClock: number;
  reminders?: Reminder[];
  /** 不传=不改；参考站的开关是显式的，所以这里用 boolean 而不是可选 */
  popMark?: boolean;
  startDay: Day;
  backfillDays: number;
}

export interface HabitMarkInput {
  id?: string;
  habitId: string;
  clockId?: string;
  day: Day;
  time?: string;
  text: string;
  imagePath?: string;
}

export interface HabitUnitInput {
  id?: string;
  name: string;
}

export interface HabitContextInput {
  id?: string;
  name: string;
  sort: number;
}

// ---- 习惯视图（service.HabitView 等）----

export type HabitCellState = "done" | "partial" | "missed" | "pending" | "future" | "off";

export interface HabitCell {
  day: Day;
  state: HabitCellState;
  amount: number;
  target: number;
  clockIds?: string[];
}

export interface HabitRow {
  habit: Habit;
  contextName: string;
  day: Day;
  amount: number;
  target: number;
  clocked: boolean;
  dueToday: boolean;
  streak: number;
  totalDays: number;
  canBackfill: boolean;
  month: HabitCell[];
}

export interface HabitView {
  day: Day;
  month: string;
  contexts: string[];
  rowsByContext: Record<string, HabitRow[]>;
  totalClockDays: number;
}

export interface HabitStats {
  planned: number;
  actual: number;
  missed: number;
  /** 排期到了但还没过完的那天（一般是今天），不计入 missed */
  pending: number;
  ratio: number;
  startDay: Day;
  daysSince: number;
  totalDays: number;
  longestStreak: number;
}

// ---- 提醒（service.ReminderFire）----

export interface ReminderFire {
  itemId: string;
  /** 为真时 itemId 是习惯 ID：习惯提醒挂在排期日的固定时刻上 */
  habit?: boolean;
  reminderId: string;
  title: string;
  day: Day;
  at: ClockTime;
}

// ---- api.go：Settings / BootInfo ----

export interface Settings {
  showDone: boolean;
  defaultGroup: string;
  theme: string;
  /** 新建习惯默认打开哪套：guided＝微启动分步引导，classic＝一张卡 */
  habitCreateMode: HabitCreateMode;
  /** 视图页（日/周/月）的显示配置，对应参考站「自定义视图」+「视图设置」 */
  view: ViewConfig;
  /** 备忘录列表排序：0 按创建时间（默认）、1 按修改时间。参考站存 localStorage，我们存内核 */
  memoSortType: MemoSort;
  /** 关掉系统原生通知。false = 到点的提醒既在应用内浮出、也进系统通知中心（默认） */
  quietNative: boolean;
}

/** 原生通知在这台设备上的可用性（内核 NotifyInfo）。 */
export interface NotifyInfo {
  /** 只有 Windows 有真的落地；其它平台 false，界面要说明而不是假装能开 */
  available: boolean;
  quiet: boolean;
}

/**
 * 视图配置。参考站的 8 个 localStorage 标量在我们这里进本地 meta（换 WebView 不丢），
 * 隐藏项也从逗号串改成数组——它那边用 `search(id)` 子串匹配，ID 前缀互含会误伤。
 *
 * 所有字段都按「零值即默认」设计，老偏好记录里没有 view 时不会读出奇怪的值。
 */
export interface ViewConfig {
  /** 网格里不显示已打卡的事项（参考站 viewMatterClockedIsShow="0"） */
  hideMatterClocked: boolean;
  /** 同上，习惯侧 */
  hideHabitClocked: boolean;
  /** 事项配色：0 按清单本设置 / 1 按分类 / 2 按优先级 / 3 固定色 */
  matterColorMode: 0 | 1 | 2 | 3;
  matterColorValue: string;
  /** 习惯配色：0 跟随图标色 / 1 固定色 */
  habitColorMode: 0 | 1;
  habitColorValue: string;
  /** 清单侧隐藏的分类 ID；空串代表「无分类」 */
  hideCategories: string[];
  /** 习惯侧隐藏的情境 ID */
  hideHabitContexts: string[];
}

export type HabitCreateMode = "guided" | "classic";

export interface BootInfo {
  dataDir: string;
  deviceId: string;
  today: Day;
  channelKinds: string[];
  settings: Settings;
}

// ---- 同步（sync.Config / sync.Result）----

export interface SyncConfig {
  name: string;
  kind: string;
  enabled: boolean;
  options?: Record<string, string>;
}

export interface SyncResult {
  channel: string;
  applied: number;
  pushed: number;
  conflicts: number;
  revision: number;
  syncedAt: ClockTime;
  skipped?: string;
}

/** store.SyncState —— Go 侧带 json tag，字段名小驼峰 */
export interface SyncState {
  channel: string;
  lastSyncAt: ClockTime;
  lastPushedAt: ClockTime;
  note: string;
}

/** api.go changed() 发的 data:changed 事件负载 */
export interface DataChanged {
  what: string;
  at: Day;
}

// ---- 备忘录（参考站 /web/memo 那一套）----

/** 附件类型，取值与参考站 fileType 逐一对齐；-1 是「没有附件」。 */
export const MemoFile = {
  None: -1,
  Image: 0,
  Video: 1,
  File: 2,
  Audio: 3,
} as const;
export type MemoFileKind = (typeof MemoFile)[keyof typeof MemoFile];

/** 列表排序方式：0 按创建时间（默认），1 按修改时间。 */
export type MemoSort = 0 | 1;

export interface MemoFolder {
  id: string;
  name: string;
  sort: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface MemoFolderInput {
  id?: string;
  name: string;
  sort?: number;
}

export interface Memo {
  id: string;
  /** 空串 = 未归类；「全部」是不过滤，不是这个空串 */
  folderId: string;
  title: string;
  /** 富文本正文。参考站丢 OSS，我们进记录才能跟着同步 */
  html: string;
  backImage: string;
  fileType: MemoFileKind;
  fileId: string;
  isTop: boolean;
  /** 非空 = 在回收站里。与 deletedAt（同步墓碑）是两回事 */
  trashedAt?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface MemoInput {
  id?: string;
  folderId: string;
  title: string;
  html: string;
  backImage: string;
  fileType: MemoFileKind;
  fileId: string;
}

/** 列表项：记录 + 内核现算的纯文本摘要（3 行截断用）。 */
export interface MemoItem {
  memo: Memo;
  preview: string;
}

export interface MemoRequest {
  /** "" = 全部 */
  folderId?: string;
  search?: string;
  sort?: MemoSort;
  showDeleted?: boolean;
}

export interface MemoStats {
  total: number;
  trashed: number;
}

// ---- 习惯统计（日/周/月/年四个标签页共用一个区间接口）----

/** 某一天某习惯的状态。rest = 没排期或习惯还没开始；future = 日子还没到。 */
export type HabitStatState = "done" | "partial" | "pending" | "missed" | "rest" | "future";

export interface HabitStatDay {
  day: Day;
  state: HabitStatState;
  amount: number;
  target: number;
}

export interface HabitStatHabit {
  habitId: string;
  name: string;
  icon: HabitIcon;
  context: string;
  /** 与内核 model.HabitMode 一致：1 = 每天一次（「1/1次」），2 = 每天多次（按量走，如「3/8杯」） */
  mode: number;
  unit: string;
  days: HabitStatDay[];
  checked: number;
  done: number;
  scheduled: number;
  streak: number;
}

/** 区间内某一天的横向汇总（所有习惯放一起）。 */
export interface HabitStatDaySummary {
  day: Day;
  scheduled: number;
  done: number;
  checked: number;
  perfect: boolean;
  future: boolean;
}

export interface HabitStatSummary {
  /** 有打卡的「习惯×天」个数 */
  checkins: number;
  /** 区间内连续「当天有打卡」的最长天数 */
  longestStreak: number;
  /** 完美打卡天数：当天应打的习惯全部打满 */
  perfectDays: number;
  scheduledDays: number;
}

export interface HabitStatRequest {
  start: Day;
  end: Day;
}

export interface HabitStat {
  start: Day;
  end: Day;
  today: Day;
  habits: HabitStatHabit[];
  days: HabitStatDaySummary[];
  summary: HabitStatSummary;
}

// —— 专注（Focus）—— 字段照抄 internal/core/model/model.go 与 service/focus.go 的 json tag。

/** FocusType：1 正计时 2 番茄钟 3 倒计时（model.FocusCountUp/Pomodoro/CountDown） */
export type FocusType = 1 | 2 | 3;
/** FocusStatus：1 走表中 2 暂停中 3 已结束。1/2 都算「这次还没结束」，重启要回到那一次 */
export type FocusStatus = 1 | 2 | 3;
/** 番茄阶段：focus 专注 / short 短休息 / long 长休息；空串 = 不在番茄流程里 */
export type FocusPhase = "" | "focus" | "short" | "long";
/** 来源：1 实时计时 2 事后补记（补记没有真实起止时刻） */
export type FocusSource = 1 | 2;

export interface FocusEvent {
  at: ClockTime;
  /** start | pause | resume | cycle | rest | end | recover */
  kind: string;
  label: string;
}

/** 一次番茄钟的配置快照：改设置不回溯历史记录 */
export interface FocusPlan {
  cycles: number;
  shortRest: number;
  longRest: number;
  longEvery: number;
  autoRest: boolean;
  focusSec: number;
}

export interface FocusRecord {
  id: string;
  type: FocusType;
  status: FocusStatus;
  source: FocusSource;
  day: Day;
  startAt?: ClockTime;
  endAt?: ClockTime;
  /** 已折入的专注秒数。计时账本 = accumSec +（segmentStart 非空时 now - segmentStart） */
  accumSec: number;
  /** 本轮专注开始时的累计秒数；番茄钟算本轮剩余用它 */
  roundBase: number;
  segmentStart?: ClockTime;
  targetSec: number;
  /** 结束时定格的实际专注秒数（不含休息） */
  actualSec: number;
  restSec: number;
  cycles: number;
  phase: FocusPhase;
  pomodoro?: FocusPlan | null;
  itemId?: string;
  habitId?: string;
  note?: string;
  events?: FocusEvent[];
  createdAt: ClockTime;
  updatedAt: ClockTime;
  deletedAt?: ClockTime;
}

export interface FocusStartRequest {
  type: FocusType;
  targetSec: number;
  itemId?: string;
  habitId?: string;
  pomodoro?: FocusPlan | null;
}

/** 补记与编辑共用一个入参：id 空 = 新建补记；实时记录只认 note 与关联任务两处改动 */
export interface FocusInput {
  id?: string;
  type: FocusType;
  day: Day;
  actualSec: number;
  cycles: number;
  itemId?: string;
  habitId?: string;
  note: string;
}

export interface FocusListItem {
  record: FocusRecord;
  taskName: string;
  taskKind: "" | "item" | "habit";
}

export interface FocusOverview {
  totalSec: number;
  totalCount: number;
  todaySec: number;
  todayCount: number;
}

export interface FocusDaily {
  day: Day;
  sec: number;
  count: number;
}

export interface FocusTypeSplit {
  type: FocusType;
  sec: number;
  count: number;
}

export interface FocusTaskSplit {
  itemId?: string;
  name: string;
  sec: number;
  count: number;
}

/** 时段 × 星期矩阵的一格，内核恒给 168 格 */
export interface FocusCell {
  weekday: number;
  hour: number;
  sec: number;
  count: number;
}

export interface FocusStatRequest {
  start: Day;
  end: Day;
}

export interface FocusStat {
  start: Day;
  end: Day;
  today: Day;
  overview: FocusOverview;
  daily: FocusDaily[];
  byType: FocusTypeSplit[];
  byTask: FocusTaskSplit[];
  matrix: FocusCell[];
  /** 补记没有真实时刻，落不进时段矩阵，内核单列一个数交代掉 */
  unplacedSec: number;
  unplacedCount: number;
}

export interface FocusCandidate {
  kind: "item" | "habit";
  id: string;
  name: string;
  day: Day;
  timeText: string;
  /** 事项所属清单本 / 习惯所属情境 */
  group: string;
  icon: HabitIcon;
  clocked: boolean;
}

export interface FocusCandidateRequest {
  /** 空 = 全部待办（逾期 + 今天 + 往后） */
  day?: Day;
  tab?: "" | "item" | "habit";
}

// client.ts —— 前端调内核的唯一接缝。
//
// 结构：
//   1. Kernel 接口：方法名/签名与仓库根 api.go 的 `API` 服务一一对应（Wails 方法名即 Go 方法名）。
//   2. wailsKernel：通过 @wailsio/runtime 的 Call.ByName("main.API.<Method>", ...args) 调用真内核，
//      事件用 Events.On 订阅（data:changed / sync:done / reminder:due）。
//   3. mockKernel（mock.ts）：浏览器内存实现，纯 `npm run dev` 无 Wails 壳时调试 UI 用。
//   4. 运行时探测 window.wails.invokeAsync（Wails v3 桌面桥注入的全局函数；CLI 里也查 window.go
//      作为兼容位）选择实现，探测只发生在这里——UI 代码不出现任何 if(wails) 分支。
//
// ⚠️ 等 `wails3 generate bindings` 可用后：types.ts 整体替换为生成绑定，
// 本文件的 wailsKernel 改为直接 import 生成服务即可，Kernel 接口与 UI 层都不动。

import { createMockKernel } from "./mock";
import type {
  BootInfo,
  CalendarRequest,
  CalendarView,
  Category,
  CategoryInput,
  Child,
  ChildInput,
  Day,
  Habit,
  HabitContext,
  HabitContextInput,
  HabitInput,
  HabitMark,
  HabitMarkInput,
  HabitStats,
  HabitUnit,
  HabitUnitInput,
  HabitView,
  ItemInput,
  Label,
  LabelInput,
  ListView,
  ListViewRequest,
  ListInput,
  OverdueBundle,
  PlList,
  ReminderFire,
  Scope,
  Settings,
  SyncConfig,
  SyncResult,
  SyncState,
} from "./types";

export type KernelEventName = "data:changed" | "sync:done" | "reminder:due";

export interface Kernel {
  // —— 握手与设置（api.go）——
  Start(): Promise<BootInfo>;
  GetSettings(): Promise<Settings>;
  SaveSettings(s: Settings): Promise<void>;
  /** 前端未捕获错误落盘到 dataDir/app-errors.log，见 api.go ReportError。 */
  ReportError(where: string, detail: string): Promise<void>;

  // —— 清单 ——
  ListView(req: ListViewRequest): Promise<ListView>;
  /** 视图模块（日/周/月）：按区间逐日铺开，跨天事项每天都出现，前端才连得出跨天条 */
  CalendarView(req: CalendarRequest): Promise<CalendarView>;
  SaveItem(input: ItemInput, scope: Scope, day: Day): Promise<import("./types").ListItem[]>;
  DeleteItem(itemID: string, scope: Scope, day: Day): Promise<void>;
  SetItemClock(itemID: string, day: Day, on: boolean): Promise<void>;
  /** 打卡三态：0 取消 / 1 成功 / 3 失败（值与内核 model.ItemStatus 一致） */
  SetItemClockState(itemID: string, day: Day, status: import("./types").ItemStatus): Promise<void>;
  SetItemTop(itemID: string, top: boolean): Promise<void>;
  /** 月历格子的农历与节日，一次给整月 */
  LunarLabels(days: Day[]): Promise<import("./types").LunarCell[]>;
  /** 当前生效的法定节假日数据：覆盖年份、出处、本机导入目录 */
  CalendarInfo(): Promise<import("./types").CalendarStatus>;

  // —— 加密备份 ——
  /** 打开「另存为」对话框；空串表示用户取消 */
  PickBackupPath(): Promise<string>;
  /** 打开「选择备份文件」对话框；空串表示用户取消 */
  PickBackupFile(): Promise<string>;
  /** 导出口令加密的全量备份 */
  ExportBackup(path: string, password: string, withAttachments: boolean): Promise<import("./types").BackupSummary>;
  /** 恢复一份备份（LWW 合并，不清库） */
  ImportBackup(path: string, password: string): Promise<import("./types").BackupSummary>;

  // —— 系统原生通知 ——
  /** 这台设备有没有真的原生通知落地 + 当前是否被静音 */
  NotifyInfo(): Promise<import("./types").NotifyInfo>;
  /** 设置页的「测试通知」：错误原样抛回界面 */
  TestNotify(): Promise<void>;
  /** 界面自己算出来的时刻（番茄钟一轮走完、休息结束）也送一条系统通知 */
  PushNotify(title: string, body: string): Promise<void>;
  /** 事项图片：base64 上传（WebView2 不暴露 File.path），最多 5 张 */
  AddItemImage(itemID: string, name: string, dataBase64: string): Promise<import("./types").Attachment>;
  ItemImages(itemID: string): Promise<import("./types").Attachment[]>;
  DeleteAttachment(attachmentID: string): Promise<void>;
  PostponeItems(itemIDs: string[], from: Day, to: Day): Promise<number>;
  OverdueItems(day: Day): Promise<OverdueBundle>;

  // —— 子任务 ——
  Children(itemID: string): Promise<Child[]>;
  SaveChild(input: ChildInput): Promise<Child>;
  SetChildDone(childID: string, done: boolean): Promise<void>;
  /** 子任务三态：0 未打卡 / 1 成功 / 3 失败 */
  SetChildClock(childID: string, status: import("./types").ItemStatus): Promise<void>;
  DeleteChild(childID: string): Promise<void>;

  // —— 分类 / 标签 / 清单本 ——
  Categories(): Promise<Category[]>;
  SaveCategory(input: CategoryInput): Promise<Category>;
  DeleteCategory(categoryID: string, withItems: boolean): Promise<number>;
  ReorderCategories(orderedIDs: string[]): Promise<void>;
  Labels(): Promise<Label[]>;
  SaveLabel(input: LabelInput): Promise<Label>;
  DeleteLabel(labelID: string): Promise<number>;
  Lists(): Promise<PlList[]>;
  SaveList(input: ListInput): Promise<PlList>;
  DeleteList(listID: string, withItems: boolean): Promise<number>;

  // —— 习惯 ——
  HabitMonthView(day: Day, month: string): Promise<HabitView>;
  SaveHabit(input: HabitInput): Promise<Habit>;
  DeleteHabit(habitID: string): Promise<void>;
  ClockHabit(habitID: string, day: Day, amount: number): Promise<import("./types").HabitClock>;
  CancelHabitClock(habitID: string, day: Day): Promise<number>;
  HabitStats(habitID: string, month: string): Promise<HabitStats>;

  /** 习惯统计（日/周/月/年四个页签共用）：区间内逐习惯逐日状态 + 每日横向汇总 + 区间汇总 */
  HabitStat(req: import("./types").HabitStatRequest): Promise<import("./types").HabitStat>;
  HabitMarks(habitID: string): Promise<HabitMark[]>;
  SaveHabitMark(input: HabitMarkInput): Promise<HabitMark>;
  DeleteHabitMark(markID: string): Promise<void>;
  HabitUnits(): Promise<HabitUnit[]>;
  SaveHabitUnit(input: HabitUnitInput): Promise<HabitUnit>;
  HabitContexts(): Promise<HabitContext[]>;
  SaveHabitContext(input: HabitContextInput): Promise<HabitContext>;
  DeleteHabitContext(contextID: string): Promise<number>;

  // —— 提醒 ——
  UpcomingReminders(day: Day, until: Day): Promise<ReminderFire[]>;

  // —— 备忘录（参考站 /web/memo：文件夹 + 搜索 + 排序 + 富文本编辑器 + 回收站）——
  MemoFolders(): Promise<import("./types").MemoFolder[]>;
  SaveMemoFolder(input: import("./types").MemoFolderInput): Promise<import("./types").MemoFolder>;
  /** 删文件夹；其下备忘录一起进回收站，返回条数 */
  DeleteMemoFolder(folderID: string): Promise<number>;
  /** 文件夹拖拽排序后写回新顺序 */
  ReorderMemoFolders(orderedIDs: string[]): Promise<void>;
  MemoList(req: import("./types").MemoRequest): Promise<import("./types").MemoItem[]>;
  /** 列表不带正文，打开编辑器时单读一条 */
  Memo(memoID: string): Promise<import("./types").Memo>;
  CreateMemo(folderID: string): Promise<import("./types").Memo>;
  SaveMemo(input: import("./types").MemoInput): Promise<import("./types").Memo>;
  SetMemoTop(memoID: string, top: boolean): Promise<void>;
  MoveMemoFolders(memoIDs: string[], folderID: string): Promise<number>;
  /** 删除 = 进回收站（不是墓碑），与参考站一致 */
  TrashMemos(memoIDs: string[]): Promise<number>;
  RestoreMemos(memoIDs: string[]): Promise<number>;
  /** 彻底删除才走同步墓碑 */
  PurgeMemos(memoIDs: string[]): Promise<number>;
  MemoStats(): Promise<import("./types").MemoStats>;
  /** 附件走字节：返回附件元数据与它的类型码（0 图 / 1 视频 / 2 文件 / 3 音频） */
  AddMemoFile(memoID: string, name: string, dataBase64: string): Promise<[import("./types").Attachment, number]>;

  // —— 专注（正计时 / 番茄钟 / 倒计时 + 记录与统计）——
  /** 同一时刻只允许一次进行中的专注，第二次会拿到「已有专注进行中」 */
  FocusStart(req: import("./types").FocusStartRequest): Promise<import("./types").FocusRecord | null>;
  /** 计时心跳：把走满的一段折进累计。不触发 data:changed，界面不用跟着重取 */
  FocusTick(focusID: string): Promise<import("./types").FocusRecord | null>;
  FocusPause(focusID: string): Promise<import("./types").FocusRecord | null>;
  /** 继续，也是番茄钟开下一轮专注段的入口 */
  FocusResume(focusID: string): Promise<import("./types").FocusRecord | null>;
  /** 进入休息阶段：只改阶段与状态，不累计秒数 */
  FocusRestStart(focusID: string, phase: import("./types").FocusPhase): Promise<import("./types").FocusRecord | null>;
  /** 番茄阶段收尾：focus 折时间并 +1 轮，short/long 只累计休息秒数 */
  FocusPhaseEnd(focusID: string, phase: import("./types").FocusPhase, restSec: number): Promise<import("./types").FocusRecord | null>;
  /** save=false 就是「放弃（不保存）」，走同步墓碑 */
  FocusFinish(focusID: string, save: boolean): Promise<import("./types").FocusRecord | null>;
  /** 进行中的那一次；没有返回 null */
  FocusCurrent(): Promise<import("./types").FocusRecord | null>;
  /** 跨设备互斥：把另一台设备的进行中专注接到本机 */
  FocusTakeover(focusID: string): Promise<import("./types").FocusRecord>;
  /** 重启回到那一次：崩溃期间不计时长，最多补一个心跳周期 */
  FocusRecover(focusID: string): Promise<import("./types").FocusRecord | null>;
  /** 单读一条，带回现取的关联任务名（名字属于事项/习惯，不在记录里存副本） */
  Focus(focusID: string): Promise<import("./types").FocusListItem | null>;
  /** 补记一条，或修改已有记录 */
  FocusSave(input: import("./types").FocusInput): Promise<import("./types").FocusRecord | null>;
  FocusDelete(focusID: string): Promise<void>;
  /** 历史列表；day 空 = 全部，只出已结束的记录 */
  FocusList(day: string, limit: number): Promise<import("./types").FocusListItem[]>;
  FocusStat(req: import("./types").FocusStatRequest): Promise<import("./types").FocusStat>;
  /** 「关联任务」弹窗的候选（事项 / 习惯两页签） */
  FocusCandidates(req: import("./types").FocusCandidateRequest): Promise<import("./types").FocusCandidate[]>;

  // —— 同步 ——
  SyncChannels(): Promise<SyncConfig[]>;
  SaveSyncChannel(cfg: SyncConfig): Promise<void>;
  RemoveSyncChannel(name: string): Promise<void>;
  ProbeSyncChannel(cfg: SyncConfig): Promise<void>;
  SyncNow(name: string): Promise<SyncResult[]>;
  SyncState(name: string): Promise<SyncState>;

  // —— 事件（api.go 的 data:changed / sync:done / reminder:due）——
  On(event: KernelEventName, cb: (data: unknown) => void): () => void;

  /** 当前实现名，仅用于界面角落标注数据来源，不参与业务判断。 */
  /** 后端在探测完成前是「待定」；标签必须把它显示出来，不能默认成某一边 */
  readonly impl: "wails" | "mock" | "待定";
}

/**
 * Wails 服务调用统一走 `wails3 generate bindings` 产出的绑定模块。
 *
 * 前缀不是猜的：绑定生成器按 Go 模块路径建目录（planfordo/API.*），
 * 手写 `main.API.X` 这类字符串在服务名或包名变化时会静默失效，而绑定里的调用 ID
 * 由生成器维护，重跑一次就对齐。生成绑定后务必重跑 `wails3 generate bindings`。
 *
 * @wailsio/runtime 由绑定模块自己引入，这里用动态 import：只有真的运行在壳里才加载它，
 * 纯浏览器 mock 模式零副作用。
 */
type BindingsModule = { API?: Record<string, (...args: unknown[]) => unknown> };
let bindingsLoader: Promise<BindingsModule> | null = null;

function loadBindings(): Promise<BindingsModule> {
  if (!bindingsLoader) {
    bindingsLoader = import("../../bindings/planfordo/index.js") as unknown as Promise<BindingsModule>;
  }
  return bindingsLoader;
}

async function wailsCall<T>(method: string, args: unknown[]): Promise<T> {
  const { API } = await loadBindings();
  const fn = API?.[method];
  if (!fn) {
    throw new Error(`内核没有方法 ${method}——请重跑 wails3 generate bindings`);
  }
  return (await fn(...args)) as T;
}

function createWailsKernel(): Kernel {
  // 代理把 Kernel 方法名（与 Go 导出方法同名）映射到生成绑定里的同名函数；
  // 不能用展开（拿不到代理的动态属性）。
  const k = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, prop: string | symbol) {
      if (prop === "impl") return "wails";
      if (typeof prop !== "string") return undefined;
      if (prop === "On") {
        return (event: KernelEventName, cb: (d: unknown) => void) => {
          let dead = false;
          let off: (() => void) | null = null;
          void import("@wailsio/runtime").then(({ Events }) => {
            if (dead) return;
            off = Events.On(event, (ev: { data: unknown }) => cb(ev.data));
          });
          return () => {
            dead = true;
            if (off) off();
          };
        };
      }
      return (...args: unknown[]) => wailsCall(prop, args);
    },
    has: () => true,
  });
  return k as unknown as Kernel;
}

/** 运行时探测：桌面壳注入 `window.wails.invokeAsync`（@wailsio/runtime 自己就是这么判的，
 *  见其 runtime.js），`window._wails.invoke` 作为并存入口一起认。纯浏览器 npm run dev 时
 *  两者都不存在，退回内存 mock。 */
export function bridgeState(): "wails" | "mock" {
  if (typeof window === "undefined") return "mock"; // SSR / 测试环境一律走 mock
  const w = window as unknown as {
    wails?: { invokeAsync?: unknown };
    _wails?: { invoke?: unknown };
  };
  return typeof w.wails?.invokeAsync === "function" || typeof w._wails?.invoke === "function"
    ? "wails"
    : "mock";
}

/** 给界面角落用的诊断串：跑在 mock 上时必须说清楚桥上到底有什么，
 *  否则「看起来一切正常、其实是假数据」这种状态最难发现。 */
export function bridgeProbe(): string {
  if (typeof window === "undefined") return "无 window 环境";
  const keys = Object.keys(window).filter((k) => /wails/i.test(k));
  return keys.length ? `window: ${keys.join(", ")}` : "window 上没有任何 wails 桥";
}

const wailsKernel = createWailsKernel();
const mockKernel = createMockKernel();

/**
 * 后端选择：等桥注入，然后整个会话定死一个，不再每次调用各判一次。
 *
 * 每次调用都判定的写法会出更隐蔽的事故：启动瞬间桥还没注入，头几次调用走了 mock
 * 并被上层缓存下来；等桥注入后标签又显示「Wails 内核」——屏幕上就是假数据配真标签，
 * 比一路跑 mock 更难发现。所以这里最多等 1.5s 让桥就位，之后 choice 冻结。
 */
let choice: "wails" | "mock" | null = null;

async function decideKernel(timeoutMs = 1500): Promise<"wails" | "mock"> {
  if (choice) return choice;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (bridgeState() === "wails") {
      choice = "wails";
      return choice;
    }
    if (Date.now() >= deadline) {
      choice = "mock";
      return choice;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** kernelReady 给需要「在决定之前别渲染数据」的调用方用；api 自身已经等过了。 */
export const kernelReady: Promise<"wails" | "mock"> = decideKernel();

function activeKernel(): Kernel {
  if (choice === null) throw new Error("内核后端尚未确定，请通过 api 调用");
  return choice === "wails" ? wailsKernel : mockKernel;
}

export const api: Kernel = new Proxy({} as Kernel, {
  get(_target, prop) {
    if (prop === "impl") return choice ?? "待定";
    if (typeof prop !== "string") return undefined;
    if (prop === "On") {
      // 订阅要等后端定下来再挂，否则事件会从另一个后端来。
      return (event: KernelEventName, cb: (d: unknown) => void) => {
        let off: (() => void) | null = null;
        let dead = false;
        void kernelReady.then(() => {
          if (!dead) off = activeKernel().On(event, cb);
        });
        return () => {
          dead = true;
          if (off) off();
        };
      };
    }
    return async (...args: unknown[]) => {
      await kernelReady;
      return (activeKernel() as unknown as Record<string, (...a: unknown[]) => unknown>)[prop](...args);
    };
  },
});

// 方便组件按需引用类型，避免 UI 直接 import api/types 之外的调用细节。
export type {
  BootInfo,
  CalendarDay,
  CalendarHabit,
  CalendarRequest,
  CalendarView,
  Category,
  Day,
  Habit,
  HabitCell,
  HabitContext,
  HabitRow,
  HabitStats,
  HabitUnit,
  HabitView,
  ItemInput,
  Label,
  ListView,
  ListViewRequest,
  Occurrence,
  PlList,
  Reminder,
  ReminderFire,
  Repeat,
  Scope,
  Settings,
  SyncConfig,
  SyncResult,
} from "./types";
export { api as default };

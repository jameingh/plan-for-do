// appStore.ts —— 极简全局 store（useSyncExternalStore，无第三方依赖）。
// 只放跨页共享且需要被事件驱动更新的状态：当前页、内核握手结果、偏好、
// 筛选条件、选中项、提醒横幅、toast、以及 data:changed 的修订号（页面靠它重拉数据）。
// 页面自身的列表数据不放这里，由各页用 api + revision 自取。

import { useSyncExternalStore } from "react";
import { api } from "../api/client";
import type { BootInfo, Day, Occurrence, ReminderFire, Settings, ViewConfig } from "../api/types";

export type Page = "lists" | "views" | "habits" | "focus" | "memos" | "settings" | "account";

export interface Toast {
  id: number;
  kind: "error" | "info";
  text: string;
}

export interface Selection {
  occurrence: Occurrence | null;
  habitId: string | null;
}

export interface AppState {
  booted: boolean;
  boot: BootInfo | null;
  page: Page;
  settings: Settings;
  revision: number; // data:changed 递增
  filters: {
    day: Day;
    groupBy: string;
    listId: string;
    categoryId: string;
    labelId: string;
  };
  habitMonth: string;
  /** 从头像菜单进「个人中心」前所在的那一页，页面左上角「返回」要回到它。 */
  accountFrom: Page;
  /** 习惯页顶部日期卡片带选中的那天；空=今天。所有习惯的圆点切片跟着它走。 */
  habitDay: string;
  selection: Selection;
  reminders: ReminderFire[];
  toasts: Toast[];
  collapsedGroups: string[];
  /** 最近一次即时保存的时间戳，顶栏用它播「已保存」脉冲（规范 4.5）。 */
  savedAt: number;
}

let seq = 0;

/**
 * 启动页签。壳会把 PLANDO_START_TAB 变成 `/?tab=`，这样验证界面时不必用鼠标点标签——
 * 桌面自动化点击会被前台锁和用户鼠标干扰，点错窗口比点不到更糟。
 */
function initialPage(): Page {
  const t = new URLSearchParams(window.location.search).get("tab");
  return t === "lists" || t === "views" || t === "habits" || t === "focus" || t === "memos" || t === "settings" ? t : "lists";
}

let state: AppState = {
  booted: false,
  boot: null,
  page: initialPage(),
  settings: { showDone: true, defaultGroup: "date", theme: "light", habitCreateMode: "guided", memoSortType: 0, quietNative: false, view: { hideMatterClocked: false, hideHabitClocked: false, matterColorMode: 0, matterColorValue: "", habitColorMode: 0, habitColorValue: "", hideCategories: [], hideHabitContexts: [] } },
  revision: 0,
  filters: { day: "", groupBy: "date", listId: "", categoryId: "", labelId: "" },
  habitMonth: "",
  habitDay: "",
  accountFrom: "lists",
  selection: { occurrence: null, habitId: null },
  reminders: [],
  toasts: [],
  collapsedGroups: [],
  savedAt: 0,
};

const listeners = new Set<() => void>();

function set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useApp(): AppState {
  return useSyncExternalStore(subscribe, () => state);
}

// —— actions ——

/**
 * 偏好读回来先补一遍默认。
 *
 * 内核的 ViewConfig 用「零值即默认」，但 Go 的 nil 切片序列化是 `null` 而不是 `[]`，
 * 前端拿到的 `hideCategories` 就可能是 null——`.join()` 当场炸掉整个启动（2026-11-07 实测）。
 * 老库里的记录还可能根本没有 view 字段。与其到处写 `?? []`，在唯一的入口处补齐。
 */
export function normalizeSettings(s: Settings): Settings {
  const src = (s.view ?? {}) as Partial<ViewConfig>;
  const view: ViewConfig = {
    hideMatterClocked: src.hideMatterClocked ?? false,
    hideHabitClocked: src.hideHabitClocked ?? false,
    matterColorMode: (src.matterColorMode ?? 0) as ViewConfig["matterColorMode"],
    matterColorValue: src.matterColorValue ?? "",
    habitColorMode: (src.habitColorMode ?? 0) as ViewConfig["habitColorMode"],
    habitColorValue: src.habitColorValue ?? "",
    hideCategories: src.hideCategories ?? [],
    hideHabitContexts: src.hideHabitContexts ?? [],
  };
  return {
    ...s,
    defaultGroup: s.defaultGroup || "date",
    theme: s.theme || "light",
    habitCreateMode: s.habitCreateMode === "classic" ? "classic" : "guided",
    // 备忘录排序：老设置行里可能压根没这个键（参考站默认 createTime）
    memoSortType: s.memoSortType === 1 ? 1 : 0,
    // 原生通知默认开：老设置行里没有这一键，退回 false = 不静音
    quietNative: s.quietNative === true,
    view,
  };
}

export async function boot(): Promise<void> {
  try {
    const info = await api.Start();
    const settings = normalizeSettings(info.settings);
    set({ booted: true, boot: info, settings, filters: { ...state.filters, groupBy: settings.defaultGroup || "date" } });
    applyTheme(settings.theme);
  } catch (e) {
    toastErr(e);
    set({ booted: true });
  }
}

export function setPage(page: Page) {
  // 进「个人中心」要记住从哪儿来的：那一页左上角的「返回」回的是来路，不是清单页。
  set((s) => ({
    page,
    accountFrom: page === "account" ? (s.page === "account" ? s.accountFrom : s.page) : s.accountFrom,
    selection: { occurrence: null, habitId: null },
  }));
}

export function setFilters(patch: Partial<AppState["filters"]>) {
  set((s) => ({ filters: { ...s.filters, ...patch } }));
}

export function setHabitMonth(month: string) {
  set({ habitMonth: month });
}

/** 习惯页顶部日期卡片带的选中日；同时把 habitMonth 对到那个月，切片与详情面板一起跟着走。 */
export function setHabitDay(day: string) {
  set({ habitDay: day, habitMonth: day.slice(0, 7) });
}

export function selectOccurrence(occ: Occurrence | null) {
  set((s) => ({ selection: { occurrence: occ, habitId: occ ? null : s.selection.habitId } }));
}

export function selectHabit(habitId: string | null) {
  set((s) => ({ selection: { ...s.selection, habitId } }));
}

export function toggleGroup(key: string) {
  set((s) => ({
    collapsedGroups: s.collapsedGroups.includes(key) ? s.collapsedGroups.filter((x) => x !== key) : [...s.collapsedGroups, key],
  }));
}

/**
 * 视图页（日/周/月）的配置补丁。
 *
 * 「自定义视图」的两类配置与「视图设置」的两条开关都走这里：只填要改的字段，
 * 其余保持现值——参考站那边是 8 个 localStorage 标量各写各的，我们收成一个补丁函数，
 * 免得调用点手抄一份默认值（抄漏一次就会出现「改了颜色把过滤条件清空」这种事故）。
 */
export function patchView(patch: Partial<ViewConfig>) {
  const next: ViewConfig = { ...state.settings.view, ...patch };
  void saveSettings({ ...state.settings, view: next });
}

export async function saveSettings(raw: Settings) {
  const next = normalizeSettings(raw);
  set({ settings: next });
  applyTheme(next.theme);
  try {
    await api.SaveSettings(next);
  } catch (e) {
    toastErr(e);
  }
}

export function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}

// —— toast ——

/** 全局提示：底部居中深色 toast，3s 自动消失（规范 4.7）。字段级错误不走这里。 */
export function toast(text: string, kind: Toast["kind"] = "info") {
  const t: Toast = { id: ++seq, kind, text };
  set((s) => ({ toasts: [...s.toasts, t] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), 3000);
}

/**
 * 内核错误。
 *
 * 规范 4.7 要求中文错误贴在触发的控件下方，所以调用方优先用返回值把错误
 * 交给对应的 FieldError；只有拿不到具体控件时（启动握手、批量操作）才升级成 toast。
 */
export function toastErr(e: unknown): string {
  const msg = (e instanceof Error ? e.message : String(e)) || "未知错误";
  toast(msg, "error");
  return msg;
}

/** 即时保存成功后点亮顶栏的「已保存」脉冲，900ms 后淡回。 */
export function markSaved() {
  set({ savedAt: Date.now() });
  setTimeout(() => set((s) => (Date.now() - s.savedAt >= 900 ? { savedAt: 0 } : {})), 900);
}

export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
}

export function pushReminders(fires: ReminderFire[]) {
  set((s) => ({ reminders: [...s.reminders, ...fires] }));
}

export function dismissReminder(at: string) {
  set((s) => ({ reminders: s.reminders.filter((r) => r.at !== at) }));
}

export function clearReminders() {
  set({ reminders: [] });
}

export function bumpRevision() {
  set((s) => ({ revision: s.revision + 1 }));
}

/** 统一挂事件：写操作成功后内核发 data:changed，这里只负责让各页重拉。 */
export function wireEvents(): () => void {
  const off1 = api.On("data:changed", () => bumpRevision());
  const off2 = api.On("reminder:due", (data) => {
    const arr = Array.isArray(data) ? (data as ReminderFire[]) : [];
    if (arr.length) pushReminders(arr);
  });
  // 后台/自动同步（窗口聚焦时触发，见 onFocus）不弹提示，只记日志：
  // 否则每次切回窗口都会冒一条绿色「同步完成」，属于无意义的打扰。
  // 手动点「立即同步 / 全部同步」时此标志保持 false，照常弹 toast。
  let bgSync = false;

  const off3 = api.On("sync:done", (data) => {
    type SyncDone = { channel: string; applied: number; pushed: number; conflicts: number; skipped?: string };
    const arr = Array.isArray(data) ? (data as SyncDone[]) : [];
    if (!arr.length) return;
    // 内核把单条通道的失败塞进 Result.skipped（SyncAll 不能让一条失败拖垮其它通道）。
    // 「本地无待推送内容」是唯一正常的跳过，其余一律按失败报出来：否则用户会
    // 同时看到红色错误和绿色「同步完成」（2026-11-09 真实反馈）。
    const isSkip = (s?: string) => !s || s === "本地无待推送内容";
    const summarize = (r: SyncDone) =>
      `${r.channel}(应用${r.applied}/上推${r.pushed}/冲突${r.conflicts})` +
      (r.skipped ? (isSkip(r.skipped) ? ` 跳过:${r.skipped}` : ` 失败:${r.skipped}`) : "");
    const ok = arr.filter((r) => isSkip(r.skipped));
    const failed = arr.filter((r) => !isSkip(r.skipped));
    if (bgSync) {
      // 自动同步：不弹提示，仅记控制台日志；失败部分也要记出来，方便排查。
      bgSync = false;
      const parts: string[] = [];
      if (ok.length) parts.push("成功 " + ok.map(summarize).join("，"));
      if (failed.length) parts.push("失败 " + failed.map(summarize).join("，"));
      console.info(`[sync:background] ${parts.join("；") || "无变化"}`);
      return;
    }
    if (ok.length) toast(`同步完成：${ok.map(summarize).join("，")}`);
    for (const r of failed) toastErr(new Error(`通道「${r.channel}」同步失败：${r.skipped}`));
  });

  // 参考站也做这件事：切回窗口就重新拉一遍数据（它挂 visibilitychange）。
  // 对我们更关键——另一台设备的改动只有同步回来才看得见，所以「回来了」=「拉一次 + 重画」。
  // 30s 冷却：在窗口间来回切换是常态，不该每次都发一轮网络请求。
  let lastPull = 0;
  const onFocus = () => {
    if (document.visibilityState === "hidden") return;
    const now = Date.now();
    if (now - lastPull < 30_000) { bumpRevision(); return; }
    lastPull = now;
    bgSync = true;
    api.SyncNow("").then(() => bumpRevision()).catch((e) => {
      bgSync = false;
      console.warn("[sync:background] 同步失败：", e);
      bumpRevision();
    });
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onFocus);

  return () => {
    off1();
    off2();
    off3();
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onFocus);
  };
}

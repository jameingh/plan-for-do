// App.tsx —— 应用外壳：56px 图标模块栏（§9.1）+ 右侧主区（各页自带顶栏与内容）+ 提醒浮条 + 底部 toast +
// Esc 关闭详情 + 启动握手与事件订阅。分组页签/筛选/齿轮/立即同步都收进各页顶栏（chrome.tsx）。

import { useEffect } from "react";
import { AccountCenter } from "./components/AccountCenter";
import { HabitsPage } from "./components/HabitsPage";
import { ListsPage } from "./components/ListsPage";
import { MemosPage } from "./components/MemosPage";
import { FocusPage } from "./components/FocusPage";
import { SettingsPage } from "./components/SettingsPage";
import { ViewsPage } from "./components/ViewsPage";
import { Rail } from "./components/chrome";
import { I, modalOpen } from "./components/ui";
import { boot as bootStore, clearReminders, dismissReminder, dismissToast, selectHabit, selectOccurrence, setPage, useApp, wireEvents, type Page } from "./store/appStore";
import { formatClockCN } from "./lib/day";

const PAGES: Page[] = ["lists", "views", "habits", "focus", "memos", "settings"];

export default function App() {
  const s = useApp();

  useEffect(() => {
    void bootStore();
    const un = wireEvents();
    return un;
  }, []);

  // Esc：模态框优先（ui.tsx 的栈处理），其次关详情。
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !modalOpen()) {
        selectOccurrence(null);
        selectHabit(null);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  // 模块快捷键：Ctrl/⌘ + 1..6（清单/视图/习惯/专注/备忘录/设置）。页内的分组切换用不带修饰键的 1..4，两者不冲突。
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const i = Number(e.key);
      if (i >= 1 && i <= PAGES.length) {
        e.preventDefault();
        setPage(PAGES[i - 1]);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  return (
    <div className="app">
      <Rail page={s.page} />

      <div className="app-main">
        {s.page === "lists" && <ListsPage />}
        {s.page === "views" && <ViewsPage />}
        {s.page === "habits" && <HabitsPage />}
        {s.page === "focus" && <FocusPage />}
        {s.page === "memos" && <MemosPage />}
        {s.page === "settings" && <SettingsPage />}
        {/* 个人中心不在模块栏里，只从头像菜单进；Ctrl+1..4 切四个模块 */}
        {s.page === "account" && <AccountCenter />}
      </div>

      {/* 提醒到点：浮在左下角，不挤压布局 */}
      {s.reminders.length > 0 && (
        <div className="reminder-strip" role="alert">
          {s.reminders.slice(-3).map((r) => (
            <span key={r.at} className="reminder-pill">
              <span className="t"><I n="bell" size={14} /></span>
              <span>{r.title}</span>
              <span className="muted">{formatClockCN(r.at)}</span>
              <button className="x" aria-label="关闭该提醒" onClick={() => dismissReminder(r.at)}><I n="close" size={12} /></button>
            </span>
          ))}
          {s.reminders.length > 1 && (
            <span className="reminder-pill">
              <button className="all" onClick={clearReminders}>全部关闭</button>
            </span>
          )}
        </div>
      )}

      {/* 全局错误/结果：底部居中深色 toast，3s 自动消失，可点关闭 */}
      <div className="toast-stack" aria-live="polite">
        {s.toasts.map((t) => (
          <div key={t.id} className={"toast" + (t.kind === "error" ? " is-error" : "")} role="status">
            <span className="mark">{t.kind === "error" ? <I n="alert" size={14} /> : <I n="check" size={14} />}</span>
            <span>{t.text}</span>
            <button className="icon-btn" aria-label="关闭提示" onClick={() => dismissToast(t.id)}><I n="close" size={12} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

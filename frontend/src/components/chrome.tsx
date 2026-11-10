// chrome.tsx —— 应用外壳的共享件：56px 图标模块栏（§9.1 / 条目2）、顶栏 + 分组文字页签（§9.1 / 条目1）、
// 顶栏右侧「齿轮 + 立即同步 + 已保存脉冲」，以及把清单本/分类/标签收进去的「筛选」弹层（条目2）。
//
// 说明：参考站把筛选放在哪我没能确认——它左栏只有模块切换、顶栏右侧只取到齿轮与刷新链。
// 所以「筛选」弹层是我方的取舍（保住清单本/分类/标签这些筛选功能不丢），不是照抄。

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Category, Label, PlList } from "../api/types";
import { bumpRevision, saveSettings, setPage, setFilters, toast, toastErr, useApp, type Page } from "../store/appStore";
import { LOGIN_TODO } from "./AccountCenter";
import { Dot, Glyph, I, iconKindOf, useEscClose } from "./ui";

const MODULES: { id: Page; icon: string; label: string }[] = [
  { id: "lists", icon: "list", label: "清单" },
  { id: "views", icon: "calendar", label: "视图" },
  { id: "habits", icon: "checkSquare", label: "习惯" },
  { id: "focus", icon: "target", label: "专注" },
  { id: "memos", icon: "note", label: "备忘录" },
  { id: "settings", icon: "gear", label: "设置" },
];

/** 左栏：56px 图标模块栏（清单/视图/习惯/专注/备忘录/设置），当前项主色。
 *  头像点开是账号菜单（参考站同款：透明遮罩 + 两项）。专注不在参考站里，是我们自己加的一级模块。 */
export function Rail({ page }: { page: Page }) {
  const [menu, setMenu] = useState(false);
  return (
    <nav className={"rail" + (menu ? " is-menu" : "")} aria-label="模块">
      <button className="rail-avatar" title="功到" aria-label="账户菜单" aria-haspopup="menu" aria-expanded={menu}
        onClick={() => setMenu((v) => !v)}>功</button>
      {menu && <AvatarMenu onClose={() => setMenu(false)} />}
      {MODULES.map((m) => (
        <button key={m.id} className={"rail-item" + (page === m.id ? " is-active" : "")} aria-current={page === m.id}
          onClick={() => { setMenu(false); setPage(m.id); }}>
          <I n={m.icon} size={18} />
          <span>{m.label}</span>
        </button>
      ))}
    </nav>
  );
}

/**
 * 头像菜单。参考站的结构（bundle 里 `headerModule`）是 `.curtain-transparent` 全屏遮罩
 * + `.items` 150px 白卡 + 两条 `.item`（20px 图标 + 文字，hover 主色 5% 底），
 * 点遮罩任意处关闭；选「个人中心」路由到 UserInfo，选「退出登录」清 token 回登录页。
 *
 * 我方没有账号体系，所以这里只做**预留**：个人中心是一页写死的占位页，
 * 退出登录给一句说明，不清任何数据、也不假装登录过。
 */
function AvatarMenu({ onClose }: { onClose: () => void }) {
  useEscClose(onClose);
  const ref = useRef<HTMLUListElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // 落位从头像按钮的真实位置算，不再写死 left:70px。
  // 那个 70 是参考站的左栏宽度，我们左栏 56px，写死会让菜单从头像右侧 26px 处冒出来、
  // 像是飘在半空里（2026-11-10 用户指出）。改成头像左缘对齐、正下方展开，并做贴边保护。
  useLayoutEffect(() => {
    const btn = document.querySelector(".rail-avatar");
    const menu = ref.current;
    if (!btn || !menu) return;
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight;
    let left = r.left;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
    let top = r.bottom + 2;
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - h);
    setPos({ left, top });
  }, []);
  return (
    // 菜单是遮罩的**兄弟**而不是子节点：遮罩 z-index 120 要压在模块按钮（130）之下，
    // 好让「菜单开着时点模块也能切页」继续成立；而菜单自己得压过模块按钮，
    // 否则菜单盖住「清单」图标的地方会透出图标（2026-11-10 用户指出）。
    // 放成兄弟节点后菜单能自己拿 z-index 140，不再被遮罩的层叠上下文压住。
    <>
      <div className="avatar-curtain" onMouseDown={onClose} />
      <ul className="avatar-menu" role="menu" ref={ref}
        style={pos ? { left: pos.left, top: pos.top } : undefined}
        onMouseDown={(e) => e.stopPropagation()}>
        <li>
          <button role="menuitem" onClick={() => { onClose(); setPage("account"); }}>
            <I n="user" size={14} /><span>个人中心</span>
          </button>
        </li>
        <li>
          <button role="menuitem" onClick={() => { onClose(); toast(LOGIN_TODO); }}>
            <I n="logout" size={14} /><span>退出登录</span>
          </button>
        </li>
      </ul>
    </>
  );
}

/** 顶栏右侧的「立即同步」——参考站刷新链的等价物：跑一次全部启用通道，sync:done 事件自带 toast。 */
function SyncLink() {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      await api.SyncNow("");
    } catch (e) {
      toastErr(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="top-sync" onClick={go} disabled={busy} title="立即同步所有启用通道">
      {busy ? "同步中…" : "立即同步"}
    </button>
  );
}

/** 顶栏：左 tabs（页面提供），右 齿轮（→设置）+ 立即同步 + 已保存脉冲；extra 是页面专属动作（筛选/新建）。 */
export function TopBar({ tabs, extra }: { tabs?: ReactNode; extra?: ReactNode }) {
  const s = useApp();
  return (
    <header className="topbar">
      <div className="topbar-tabs">{tabs}</div>
      <div className="topbar-right">
        {extra}
        <span className={"saved-pulse" + (s.savedAt ? " is-on" : "")} aria-hidden={!s.savedAt}>
          <I n="check" size={12} />已保存
        </span>
        <button className="top-gear" title="设置" aria-label="设置" onClick={() => setPage("settings")}><I n="gear" size={18} /></button>
        <SyncLink />
      </div>
    </header>
  );
}

const GROUP_OPTS: { value: string; label: string }[] = [
  { value: "date", label: "日期" },
  { value: "category", label: "分类" },
  { value: "quadrants", label: "四象限" },
];

/** 分组文字页签（§9.1）：13px/700，选中主色 + 2px 下划线。 */
export function GroupTabs({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <nav className="gtabs" role="tablist" aria-label="分组方式">
      {GROUP_OPTS.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} className={"gtab" + (value === o.value ? " is-active" : "")} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </nav>
  );
}

/** 单个文字页签（习惯/设置这类只有一个 tab 的模块用）。 */
export function SingleTab({ label }: { label: string }) {
  return (
    <nav className="gtabs" aria-label="视图">
      <span className="gtab is-active">{label}</span>
    </nav>
  );
}

export interface FilterNav {
  lists: PlList[];
  categories: Category[];
  labels: Label[];
}

/** 「筛选」按钮 + 弹层：清单本 / 分类 / 标签 / 显示已打卡，全部沿用 store.filters，功能不丢。 */
export function FilterButton({ nav, onOpenCategories }: { nav: FilterNav; onOpenCategories: () => void }) {
  const { filters, settings } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const activeCount = (filters.listId ? 1 : 0) + (filters.categoryId ? 1 : 0) + (filters.labelId ? 1 : 0);
  const pick = (key: "listId" | "categoryId" | "labelId", value: string) => setFilters({ [key]: value });

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button className={"filter-btn" + (activeCount ? " has-active" : "")} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <I n="filter" size={14} />筛选{activeCount > 0 && <span className="filter-badge">{activeCount}</span>}
      </button>
      {open && (
        <div className="filter-pop" role="dialog" aria-label="筛选">
          <section className="filter-sec">
            <div className="section-title">清单本</div>
            <button className={"nav-item" + (!filters.listId ? " is-active" : "")} onClick={() => pick("listId", "")}>
              <I n="inbox" size={16} /><span className="grow">全部清单本</span>
            </button>
            {nav.lists.filter((l) => l.id !== "list-default").map((l) => (
              <button key={l.id} className={"nav-item" + (filters.listId === l.id ? " is-active" : "")} onClick={() => pick("listId", filters.listId === l.id ? "" : l.id)}>
                <Dot color={l.color || undefined} /><span className="grow">{l.name}</span>
              </button>
            ))}
            <ListCreator />
          </section>

          <section className="filter-sec">
            <div className="section-title">分类</div>
            <button className={"nav-item" + (!filters.categoryId ? " is-active" : "")} onClick={() => pick("categoryId", "")}>
              <I n="folder" size={16} /><span className="grow">全部分类</span>
            </button>
            {nav.categories.map((c) => (
              <button key={c.id} className={"nav-item" + (filters.categoryId === c.id ? " is-active" : "")} onClick={() => pick("categoryId", filters.categoryId === c.id ? "" : c.id)}>
                <Glyph kind={iconKindOf(c.icon)} glyph={c.icon} color={c.color || undefined} size={20} />
                <span className="grow">{c.name}</span>
              </button>
            ))}
            <button className="nav-item" onClick={() => { setOpen(false); onOpenCategories(); }}>
              <I n="pencil" size={16} /><span className="grow">管理分类…</span>
            </button>
          </section>

          <section className="filter-sec">
            <div className="section-title">标签</div>
            <button className={"nav-item" + (!filters.labelId ? " is-active" : "")} onClick={() => pick("labelId", "")}>
              <I n="tag" size={16} /><span className="grow">全部标签</span>
            </button>
            {nav.labels.map((l) => (
              <button key={l.id} className={"nav-item" + (filters.labelId === l.id ? " is-active" : "")} onClick={() => pick("labelId", filters.labelId === l.id ? "" : l.id)}>
                <Dot color={l.color || undefined} /><span className="grow">{l.name}</span>
              </button>
            ))}
            {nav.labels.length === 0 && <div className="muted small" style={{ padding: "4px 8px" }}>还没有标签</div>}
          </section>

          <label className="nav-item" style={{ cursor: "pointer" }}>
            <input className="check-native" type="checkbox" checked={settings.showDone} onChange={(e) => void saveSettings({ ...settings, showDone: e.target.checked })} />
            <span className="grow">显示已打卡清单</span>
          </label>
        </div>
      )}
    </div>
  );
}

/** 新建清单本：旧版在左栏，条目2 把左栏改成图标栏后移进筛选弹层，功能不丢。 */
function ListCreator() {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  async function add() {
    if (!name.trim()) return;
    try {
      await api.SaveList({ name: name.trim(), icon: "list", color: "" });
      setName("");
      setErr("");
      toast("已创建清单本");
      bumpRevision();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e) || "创建失败");
    }
  }
  return (
    <div style={{ padding: "2px 8px 0" }}>
      <input className={"input" + (err ? " is-error" : "")} placeholder="新清单本，回车创建" value={name}
        onChange={(e) => { setName(e.target.value); if (err) setErr(""); }}
        onKeyDown={(e) => e.key === "Enter" && void add()} />
      {err && <div className="field-error">{err}</div>}
    </div>
  );
}

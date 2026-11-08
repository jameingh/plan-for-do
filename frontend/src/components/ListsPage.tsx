// ListsPage.tsx —— 清单页，按 §9 CDP 实测重构：
//   · 顶栏 = 分组文字页签（日期/分类/四象限）+ 右侧「筛选」弹层（清单本/分类/标签收进来，条目2）；
//   · 日期模式 = 每桶一列、列宽 391、横向滚动、列底「+」白卡（§9.2）；
//   · 分类模式 = 每分类一列、列内再按状态分子组（逾期/未打卡/待办/已打卡，§9.3 / 条目5）；
//   · 四象限 = 2×2 象限卡、卡内按状态分子组、四色罗马数字（§9.4 / 条目6）；
//   · 事项卡片 = 两行 · 圆角 6 · border-left 2 分类色（无分类用优先级色）· 11×11 实心橙勾选框（§9.2）；
//   · 详情 = 居中弹窗 391 + 15% 遮罩（§9.5 / 条目4），遮罩只铺内容区、左栏不参与。
// 交互仍按规范第 4 节：↑↓ 移行 / Space 勾选 / Enter 开详情 / 1..4 切组、折叠记忆、错误贴在控件下方。

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "../api/client";
import type { Category, Child, Label, ListView, ListViewRequest, Occurrence, PlList, Priority } from "../api/types";
import { isResolved } from "../api/types";
import { addDays, formatClockCN, formatDayCN, relativeDayCN, todayLocal } from "../lib/day";
import { itemWhenText } from "../lib/labels";
import { bumpRevision, markSaved, selectOccurrence, setFilters, toast, toastErr, toggleGroup, useApp } from "../store/appStore";
import { CategoryManager } from "./CategoryManager";
import { ItemDetail, type CreateSpec } from "./ItemDetail";
import { FilterButton, GroupTabs, TopBar } from "./chrome";
import { ChoiceModal, ClockBox, ContextMenu, Empty, I, Modal, type MenuItem } from "./ui";

interface Nav {
  lists: PlList[];
  categories: Category[];
  labels: Label[];
}

/** 键盘事件是否落在输入控件里（那时 ↑↓/Space/1..4 归输入控件所有）。 */
function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

const rowKey = (o: Occurrence) => `${o.item.id}|${o.day}`;

/** 象限卡头部配色（§9.4）：Ⅰ 红 Ⅱ 橙 Ⅲ 蓝 Ⅳ 绿，全部引用 :root token。 */
const QUAD_META: { p: Priority; roman: string; label: string; color: string }[] = [
  { p: 1, roman: "I", label: "重要且紧急", color: "var(--quad1)" },
  { p: 2, roman: "II", label: "重要不紧急", color: "var(--quad2)" },
  { p: 3, roman: "III", label: "不重要但紧急", color: "var(--quad3)" },
  { p: 4, roman: "IV", label: "不重要不紧急", color: "var(--quad4)" },
];

/** 状态子组顺序（§9.3 / §9.4：逾期 → 未打卡 → 待办 → 已打卡）。 */
const SUB_BUCKETS: { key: string; label: string }[] = [
  { key: "overdue", label: "逾期" },
  { key: "today", label: "未打卡" },
  { key: "later", label: "待办" },
  { key: "done", label: "已打卡" },
];

/** 内核四象限/分类只给「这一组 items」，状态子组由前端按 status/day 归。 */
function statusBucket(o: Occurrence, viewDay: string): string {
  if (isResolved(o.status)) return "done";
  if (o.overdueDays > 0) return "overdue";
  if (o.day && o.day === viewDay) return "today";
  return "later";
}

const emptyTextOf = (key: string) =>
  key === "overdue" ? "没有逾期事项。" : key === "done" ? "还没有已打卡的记录。" : key === "today" ? "今天暂无待办。" : "暂无。";

/** CSS 自定义属性在 React 的 style 上没有类型，收口在这里，避免各处 as any。 */
function cssVars(vars: Record<string, string>): CSSProperties {
  return vars as unknown as CSSProperties;
}

/** 卡片左缘 2px 色条（§9.2 / 条目7）：有分类用分类色，无分类用优先级色。 */
const PRIORITY_COLOR: Record<Priority, string> = { 1: "var(--quad1)", 2: "var(--quad2)", 3: "var(--quad3)", 4: "var(--quad4)" };

/**
 * 勾选框描边色 = 优先级色（§12.3：参考站把 priorityItems 的颜色直接当未打卡框的底色）。
 * 用户要求未勾选保持空心，所以这里只借它的颜色，不借它的实心。
 */
const CLOCK_COLOR: Record<Priority, string> = { 1: "var(--prio1)", 2: "var(--prio2)", 3: "var(--prio3)", 4: "var(--prio4)" };

export function ListsPage() {
  const { booted, boot, settings, filters, revision, selection, collapsedGroups } = useApp();
  const [view, setView] = useState<ListView | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [nav, setNav] = useState<Nav>({ lists: [], categories: [], labels: [] });
  const [childMap, setChildMap] = useState<Record<string, Child[]>>({});
  const [foldedChildren, setFoldedChildren] = useState<Record<string, boolean>>({});
  const [showCatMgr, setShowCatMgr] = useState(false);
  const [postponeAll, setPostponeAll] = useState(false);
  const [create, setCreate] = useState<CreateSpec | null>(null);
  const [deleting, setDeleting] = useState<Occurrence | null>(null);
  const centerRef = useRef<HTMLElement | null>(null);
  const today = boot?.today ?? todayLocal();

  useEffect(() => {
    if (!booted) return;
    if (!filters.day) setFilters({ day: today });
  }, [booted, filters.day, today]);

  useEffect(() => {
    if (!booted) return;
    let dead = false;
    const req: ListViewRequest = {
      day: filters.day || today,
      groupBy: filters.groupBy,
      listId: filters.listId,
      categoryId: filters.categoryId,
      labelId: filters.labelId,
      showDone: settings.showDone,
    };
    api.ListView(req).then((v) => !dead && (setView(v), setLoadErr(""))).catch((e) => !dead && (setView(null), setLoadErr(e instanceof Error ? e.message : String(e))));
    Promise.all([api.Lists(), api.Categories(), api.Labels()])
      .then(([lists, categories, labels]) => !dead && setNav({ lists, categories, labels }))
      .catch(() => undefined);
    return () => { dead = true; };
  }, [booted, revision, filters.day, filters.groupBy, filters.listId, filters.categoryId, filters.labelId, settings.showDone, today]);

  // 子任务缩进在父卡片内部：只给「有子任务」的事项取，避免整屏逐条请求
  const childIds = useMemo(
    () => (view ? [...new Set(view.groups.flatMap((g) => g.items).filter((o) => o.childTotal > 0).map((o) => o.item.id))].sort() : []),
    [view]
  );
  useEffect(() => {
    if (!childIds.length) { setChildMap({}); return; }
    let dead = false;
    Promise.all(childIds.map((id) => api.Children(id).then((cs) => ({ id, cs })).catch(() => null)))
      .then((rs) => {
        if (dead) return;
        const map: Record<string, Child[]> = {};
        for (const r of rs) if (r) map[r.id] = r.cs;
        setChildMap(map);
      });
    return () => { dead = true; };
  }, [childIds, revision]);

  // 折叠记忆按「日期:组」，切日期不丢（规范 4.4）
  const gkey = (day: string, k: string) => `${day}:${k}`;
  const isCollapsed = (k: string) => collapsedGroups.includes(gkey(view?.day ?? filters.day ?? today, k));

  // 可见行的一维序列，↑↓ 在里面走
  const flat = useMemo(
    () => (view ? view.groups.filter((g) => !isCollapsed(g.key)).flatMap((g) => g.items) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, collapsedGroups, filters.day]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || !view) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!flat.length) return;
        e.preventDefault();
        const cur = flat.findIndex((o) => o.item.id === selection.occurrence?.item.id && o.day === selection.occurrence?.day);
        const next = cur < 0 ? 0 : Math.max(0, Math.min(flat.length - 1, cur + (e.key === "ArrowDown" ? 1 : -1)));
        selectOccurrence(flat[next]);
        centerRef.current?.querySelector(`[data-row="${CSS.escape(rowKey(flat[next]))}"]`)?.scrollIntoView({ block: "nearest" });
      } else if (e.key === " ") {
        const occ = selection.occurrence;
        if (!occ) return;
        e.preventDefault();
        // 与卡片左键一致：已结清（成功或失败）就取消，否则记成功
        void api.SetItemClockState(occ.item.id, occ.day, isResolved(occ.status) ? 0 : 1).then(() => markSaved()).catch(toastErr);
      } else if (e.key >= "1" && e.key <= "4") {
        const g = view.groups[Number(e.key) - 1];
        if (!g) return;
        e.preventDefault();
        if (isCollapsed(g.key)) toggleGroup(gkey(view.day, g.key));
        centerRef.current?.querySelector(`[data-group="${CSS.escape(g.key)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, flat, selection.occurrence, collapsedGroups]);

  async function postponeOne(occ: Occurrence) {
    try {
      await api.PostponeItems([occ.item.id], occ.day, today);
      toast(`「${occ.item.title}」已顺延到今天`);
    } catch (e) {
      toastErr(e);
    }
  }

  async function postponeAllOverdue() {
    setPostponeAll(false);
    try {
      const bundle = await api.OverdueItems(today);
      const ids = bundle?.itemIds ?? [];
      const days = bundle?.days ?? [];
      let n = 0;
      // 内核 Postpone 一次只接受一个来源日，逐条顺延（来源日各不相同）
      for (let i = 0; i < ids.length; i++) n += await api.PostponeItems([ids[i]], days[i], today);
      toast(n ? `已把 ${n} 条逾期事项顺延到今天` : "没有可顺延的事项");
    } catch (e) {
      toastErr(e);
    }
  }

  async function doDelete(occ: Occurrence, scope: "thisDay" | "thisAndFuture" | "all") {
    setDeleting(null);
    try {
      await api.DeleteItem(occ.item.id, scope, occ.day);
      if (selection.occurrence?.item.id === occ.item.id) selectOccurrence(null);
      toast("已删除");
    } catch (e) {
      toastErr(e);
    }
  }

  const occ = selection.occurrence;
  // 选中事项在刷新后的视图里找最新副本，保持详情与列表一致
  const freshOcc = occ ? view?.groups.flatMap((g) => g.items).find((o) => o.item.id === occ.item.id && o.day === occ.day) ?? occ : null;
  const day = filters.day || today;
  const overdueCount = view?.overdueAll ?? 0;
  const groupBy = filters.groupBy;
  const isCategory = groupBy === "category";
  const isQuadrants = groupBy === "quadrants";

  const cardProps = {
    categories: nav.categories,
    childMap,
    foldedChildren,
    foldChildren: (k: string, folded: boolean) => setFoldedChildren((old) => ({ ...old, [k]: folded })),
    onPostpone: (o: Occurrence) => void postponeOne(o),
    onDelete: (o: Occurrence) => setDeleting(o),
    selectedKey: freshOcc ? rowKey(freshOcc) : "",
  };

  return (
    <>
      <TopBar
        tabs={<GroupTabs value={groupBy} onChange={(g) => setFilters({ groupBy: g })} />}
        extra={<FilterButton nav={nav} onOpenCategories={() => setShowCatMgr(true)} />}
      />

      <main className="content" ref={centerRef}>
        <header className="daynav">
          <button className="icon-btn" aria-label="前一天" onClick={() => setFilters({ day: addDays(day, -1) })}><I n="chevronLeft" /></button>
          <span className="day-title">{relativeDayCN(day, today)}</span>
          <button className="icon-btn" aria-label="后一天" onClick={() => setFilters({ day: addDays(day, 1) })}><I n="chevronRight" /></button>
          {day !== today && <button className="btn small" onClick={() => setFilters({ day: today })}>回到今天</button>}
          <span className="spacer" />
          <span className={"stat" + (overdueCount ? " has-overdue" : "")}>{view ? (overdueCount ? `逾期 ${overdueCount} 条` : formatDayCN(day)) : "…"}</span>
        </header>

        {loadErr && <Empty text={`加载失败：${loadErr}`} />}
        {!loadErr && !view && <Empty text="正在加载…" />}
        {view && view.groups.length === 0 && <Empty text="这个范围内暂时没有事项。" />}

        {/* 日期：每桶一列（§9.2）；分类：每分类一列、列内按状态分子组（§9.3 / 条目5） */}
        {view && !isQuadrants && (
          <div className="board">
            {view.groups.map((g) => {
              const collapsed = isCollapsed(g.key);
              const cat = isCategory ? nav.categories.find((c) => c.id === g.key) : undefined;
              const bySub: Record<string, Occurrence[]> = {};
              if (isCategory) for (const o of g.items) (bySub[statusBucket(o, view.day)] ??= []).push(o);
              return (
                <section key={g.key} className={"col" + (collapsed ? " is-collapsed" : "")} data-group={g.key}>
                  <header className="col-head">
                    <button className="caret" aria-label={collapsed ? "展开该列" : "折叠该列"} aria-expanded={!collapsed} onClick={() => toggleGroup(gkey(view.day, g.key))}>
                      <I n="chevronDown" size={14} />
                    </button>
                    <h4>{cat ? cat.name : g.label}</h4>
                    <span className="count">{g.count}</span>
                    <span className="head-ops">
                      {!isCategory && g.key === "overdue" && g.count > 0 && <button className="textlink" onClick={() => setPostponeAll(true)}>顺延到今天</button>}
                    </span>
                  </header>
                  <div className="col-body">
                    {collapsed ? null : isCategory ? (
                      // 分类列：列内按状态分子组，子组头同款列头样式
                      <>
                        {g.items.length === 0 && <div className="col-empty">该分类暂无事项。</div>}
                        {SUB_BUCKETS.map((sb) => {
                          const xs = bySub[sb.key] ?? [];
                          if (!xs.length) return null;
                          const ck = `${g.key}:${sb.key}`;
                          const subCollapsed = isCollapsed(ck);
                          return (
                            <div key={sb.key} className={"sub" + (subCollapsed ? " is-collapsed" : "")}>
                              <header className={"sub-head" + (subCollapsed ? " is-collapsed" : "")}>
                                <button className="caret" aria-expanded={!subCollapsed} aria-label={subCollapsed ? "展开该子组" : "折叠该子组"} onClick={() => toggleGroup(gkey(view.day, ck))}>
                                  <I n="chevronDown" size={13} />
                                </button>
                                <span className="sname">{sb.label}</span>
                                <span className="count">{xs.length}</span>
                                <span className="head-ops">
                                  {sb.key === "overdue" && xs.length > 0 && <button className="textlink" onClick={() => setPostponeAll(true)}>顺延到今天</button>}
                                </span>
                              </header>
                              <div className="group-body"><div className="group-inner"><div className="stack">
                                {xs.map((o) => <OccCard key={rowKey(o)} occ={o} {...cardProps} />)}
                              </div></div></div>
                            </div>
                          );
                        })}
                      </>
                    ) : (
                      <div className="group-body"><div className="group-inner"><div className="stack">
                        {g.items.length === 0 && <div className="col-empty">{emptyTextOf(g.key)}</div>}
                        {g.items.map((o) => <OccCard key={rowKey(o)} occ={o} {...cardProps} />)}
                      </div></div></div>
                    )}
                    {!collapsed && <AddCard onOpen={() => setCreate({
                      day,
                      priority: 4,
                      listId: filters.listId,
                      categoryId: isCategory && g.key !== "uncategorized" ? g.key : filters.categoryId,
                    })} />}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        {/* 四象限：2×2 象限卡，卡内按状态折叠子组（§9.4 / 条目6） */}
        {view && isQuadrants && (
          <div className="quad-board">
            {QUAD_META.map((q) => {
              const items = view.groups.find((x) => x.key === `q${q.p}`)?.items ?? [];
              const bySub: Record<string, Occurrence[]> = {};
              for (const o of items) (bySub[statusBucket(o, view.day)] ??= []).push(o);
              return (
                <section key={q.p} className="quad" style={cssVars({ "--qc": q.color })}>
                  <header className="quad-head">
                    <span className="roman quad-num">{q.roman}</span>
                    <span className="qname">{q.label}</span>
                    <button className="add" title={`在「${q.label}」新建清单`} aria-label={`在${q.label}新建清单`}
                      onClick={() => setCreate({ day, priority: q.p, listId: filters.listId, categoryId: filters.categoryId })}>
                      <I n="plus" size={16} />
                    </button>
                  </header>
                  <div className="quad-body">
                    {items.length === 0 && <div className="quad-empty">此象限暂无事项。</div>}
                    {SUB_BUCKETS.map((sb) => {
                      const xs = bySub[sb.key] ?? [];
                      if (!xs.length) return null;
                      const ck = `q${q.p}:${sb.key}`;
                      const collapsed = isCollapsed(ck);
                      return (
                        <div key={sb.key} className={"sub" + (collapsed ? " is-collapsed" : "")}>
                          <button className={"sub-head" + (collapsed ? " is-collapsed" : "")} aria-expanded={!collapsed} onClick={() => toggleGroup(gkey(view.day, ck))}>
                            <span className="caret"><I n="chevronDown" size={12} /></span>
                            <span className="sname">{sb.label}</span>
                            <span className="count">{xs.length}</span>
                          </button>
                          <div className="group-body"><div className="group-inner"><div className="sub-group">
                            {xs.map((o) => <OccCard key={rowKey(o)} occ={o} {...cardProps} />)}
                          </div></div></div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </main>

      {/* 详情：居中弹窗，遮罩只铺内容区（左栏不参与，§9.5）。
          遮罩不关弹窗——参考站点灰色区域是不会收的，只有 ×／取消／Esc 才关；
          点一下就丢内容对「正在编辑一半」的表单来说是灾难。 */}
      {freshOcc && !create && (
        <div className="detail-overlay">
          <ItemDetail occ={freshOcc} categories={nav.categories} labels={nav.labels} lists={nav.lists.map((l) => ({ id: l.id, name: l.name }))} />
        </div>
      )}

      {/* 新建：同一张表单的新建态（§11.6），保存/取消收尾 */}
      {create && (
        <div className="detail-overlay">
          <ItemDetail occ={null} create={create} categories={nav.categories} labels={nav.labels} lists={nav.lists.map((l) => ({ id: l.id, name: l.name }))} onClose={() => setCreate(null)} />
        </div>
      )}

      {showCatMgr && <CategoryManager onClose={() => setShowCatMgr(false)} />}
      {postponeAll && (
        <ChoiceModal title="批量顺延" question={`确认把 ${view?.groups.find((g) => g.key === "overdue")?.count ?? 0} 条逾期事项顺延到今天？顺延后日期将更改至今天。`}
          choices={[{ label: "确认顺延", value: true }, { label: "取消", value: false }]}
          onPick={(v) => v && void postponeAllOverdue()} onClose={() => setPostponeAll(false)} />
      )}
      {deleting && (
        <Modal title={deleting.item.repeat ? "删除重复事项" : "删除事项"} onClose={() => setDeleting(null)}>
          <p className="muted">
            {deleting.item.repeat ? `「${deleting.item.title}」是重复事项，删除哪个范围？` : `删除「${deleting.item.title}」？`}
          </p>
          <div className="btn-row">
            {deleting.item.repeat && (
              <>
                <button className="btn" onClick={() => void doDelete(deleting, "thisDay")}>仅当天清单</button>
                <button className="btn" onClick={() => void doDelete(deleting, "thisAndFuture")}>当日及未来清单</button>
              </>
            )}
            <button className="btn danger" onClick={() => void doDelete(deleting, "all")}>
              {deleting.item.repeat ? "全部删除" : "删除"}
            </button>
            <button className="btn" onClick={() => setDeleting(null)}>取消</button>
          </div>
        </Modal>
      )}
    </>
  );
}

/**
 * 列底「+」白卡（§9.2）。
 *
 * 之前这里就地展开一个输入框，回车即建——快，但和参考站不是一回事：
 * 参考站的「+」打开的是「新建清单」表单（§11.6），标题、子任务、分类、日期、时间、提醒、重复、备注都在一张弹窗里。
 * 改成打开表单并没有变慢：标题输入框自动聚焦，回车同样直接保存。
 */
function AddCard({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="add-card" title="新建清单" aria-label="新建清单" onClick={onOpen}>
      <I n="plus" size={18} />
    </button>
  );
}

/** 事项卡片（§9.2）：两行——勾选框+标题 / 元信息（日期·逾期 + 右侧分类圆点与名称）。
 *  border-left 2px 用分类色，无分类用优先级色。子任务缩进在卡内。
 *  右键行为照抄参考站（§11.3）：卡片 = 置顶/编辑/删除，勾选框 = 成功打卡/失败打卡/取消打卡。 */
function OccCard({ occ, categories, childMap, foldedChildren, foldChildren, selectedKey, onPostpone, onDelete }: {
  occ: Occurrence;
  categories: Category[];
  childMap: Record<string, Child[]>;
  foldedChildren: Record<string, boolean>;
  foldChildren: (key: string, folded: boolean) => void;
  selectedKey: string;
  onPostpone: (occ: Occurrence) => void;
  onDelete: (occ: Occurrence) => void;
}) {
  const done = occ.status === 1;
  const failed = occ.status === 3;
  const resolved = isResolved(occ.status);
  const overdue = occ.overdueDays > 0;
  const cat = categories.find((c) => c.id === occ.item.category);
  const accent = cat?.color || PRIORITY_COLOR[occ.item.priority || 4];
  const when = itemWhenText(occ.item, occ.day);
  const key = rowKey(occ);
  const kids = childMap[occ.item.id] ?? [];
  const expanded = foldedChildren[key] !== false;
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  // 左键：与参考站 leftClickMatterClock 一致——已结清（成功或失败）就取消，否则记成功。
  const toggleClock = () =>
    void api.SetItemClockState(occ.item.id, occ.day, resolved ? 0 : 1).then(markSaved).catch(toastErr);

  const clockMenu = (): MenuItem[] => [
    { label: "成功打卡", onSelect: () => void api.SetItemClockState(occ.item.id, occ.day, 1).then(markSaved).catch(toastErr) },
    { label: "失败打卡", onSelect: () => void api.SetItemClockState(occ.item.id, occ.day, 3).then(markSaved).catch(toastErr) },
    ...(resolved ? [{ label: "取消打卡", onSelect: () => void api.SetItemClockState(occ.item.id, occ.day, 0).then(markSaved).catch(toastErr) }] : []),
  ];
  const cardMenu = (): MenuItem[] => [
    { label: occ.item.isTop ? "取消置顶" : "置顶", onSelect: () => void api.SetItemTop(occ.item.id, !occ.item.isTop).then(markSaved).catch(toastErr) },
    { label: "编辑", onSelect: () => selectOccurrence(occ) },
    { label: "删除", danger: true, onSelect: () => onDelete(occ) },
  ];
  const openMenu = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <article className={"occ-card" + (selectedKey === key ? " is-selected" : "") + (occ.item.isTop ? " is-pinned" : "")}
      data-row={key} tabIndex={0} role="button"
      style={cssVars({ "--card-accent": accent, "--clock-color": CLOCK_COLOR[occ.item.priority || 4] })}
      onClick={() => selectOccurrence(occ)}
      onContextMenu={(e) => openMenu(e, cardMenu())}
      onKeyDown={(e) => { if (e.key === "Enter") selectOccurrence(occ); }}>
      <div className="occ-row">
        <ClockBox state={done ? "on" : failed ? "fail" : "off"} label={`打卡「${occ.item.title}」`} onToggle={toggleClock}
          // 勾选框自己的右键菜单要盖住卡片的，所以 ClockBox 里会吞掉冒泡
          onContextMenu={(e) => openMenu(e, clockMenu())} />
        <div className={"occ-title" + (resolved ? " is-done" : "")}>{occ.item.title}</div>
        <div className="row-ops">
          {overdue && <button className="icon-btn" title="顺延到今天" aria-label="顺延到今天" onClick={(e) => { e.stopPropagation(); onPostpone(occ); }}><I n="postpone" size={14} /></button>}
          <button className="icon-btn" title={occ.item.isTop ? "取消置顶" : "置顶"} aria-label={occ.item.isTop ? "取消置顶" : "置顶"}
            onClick={(e) => { e.stopPropagation(); void api.SetItemTop(occ.item.id, !occ.item.isTop).then(markSaved).catch(toastErr); }}>
            <I n="pin" size={14} />
          </button>
          <button className="icon-btn danger" title="删除事项" aria-label="删除事项" onClick={(e) => { e.stopPropagation(); onDelete(occ); }}><I n="trash" size={14} /></button>
        </div>
      </div>
      <div className="occ-meta">
        {occ.childTotal > 0 && (
          <button className={"caret-inline" + (expanded ? "" : " is-closed")} aria-expanded={expanded}
            aria-label={expanded ? "折叠子任务" : "展开子任务"}
            onClick={(e) => { e.stopPropagation(); foldChildren(key, expanded); }}>
            <I n="chevronDown" size={12} />{occ.childDone}/{occ.childTotal}
          </button>
        )}
        {overdue ? <span className="overdue">逾期{occ.overdueDays}天</span>
          : resolved && occ.clockedAt ? (
            <span className={"item" + (failed ? " is-failed" : "")}>
              <I n={failed ? "close" : "check"} size={12} />{failed ? "失败打卡：" : "打卡时间："}{formatClockCN(occ.clockedAt)}
            </span>
          )
          : when ? <span className="when">{when}</span>
          : <span className="when">无日期</span>}
        {occ.postponedFrom && <span className="needs">顺延自{occ.postponedFrom.slice(5)}</span>}
        {occ.item.repeat && !resolved && <span className="item"><I n="repeat" size={12} /></span>}
        <span className="tail">
          {occ.item.isTop && <span className="item pin-mark" title="已置顶"><I n="pin" size={12} /></span>}
          {occ.item.remark && !resolved && <span className="item"><I n="note" size={12} /></span>}
          {occ.item.reminders.length > 0 && !resolved && <span className="item"><I n="bell" size={12} /></span>}
          {cat && <span className="item"><span className="cat-dot" style={{ background: cat.color || "var(--text-3)" }} /><span className="cat-name">{cat.name}</span></span>}
        </span>
      </div>
      {occ.childTotal > 0 && expanded && kids.length > 0 && (
        <div className="child-list">
          {kids.map((c) => (
            <div key={c.id} className="child-line" style={cssVars({ "--clock-color": CLOCK_COLOR[c.priority || 4] })}>
              <ClockBox state={c.done ? "on" : "off"} label={`完成子任务「${c.title}」`}
                onToggle={() => void api.SetChildDone(c.id, !c.done).then(() => { markSaved(); bumpRevision(); }).catch(toastErr)} />
              <span className={"child-title" + (c.done ? " is-done" : "")}>{c.title}</span>
            </div>
          ))}
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </article>
  );
}

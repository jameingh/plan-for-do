// ItemDetail.tsx —— 事项详情/新建弹窗，结构与交互照抄参考站（docs/design-reference.md §12、§13）。
//
// 参考站的「新建」和「详情」是两套版式，不是同一个组件换个标题（2026-11-07 二次取证）：
//   新建 = 标题 → 子任务 → [分类 | 优先级] → 标签 → [日期 | 时间] → 提醒 → 重复 →（选了重复才有「结束」）
//          → 备注 → 底部 取消/保存。一行一个描边小盒子，没填时是灰占位文案 + 右侧箭头，没有图片区。
//   详情 = 头部 返回·分类·优先级·⋯，正文「图标 + 灰标签 + 值」若干行（没有重复规则就不出现「结束」行），
//          备注 + 图片 + 子任务，改哪存哪，没有底部按钮。
// 早先我们自己加的「象限/清单/进度」三行删掉了：参考站没有，象限就是头部的优先级，
// 清单由「在哪一列新建」决定，进度这条项目前没有入口（内核字段保留）。
//
// 提交语义分两类：日期/时间/提醒/标签走面板自己的取消·保存；重复/结束/分类/优先级点一下就生效。
// 重复事项改任何字段前都要先选作用范围（仅当天/当日及未来/全部），这条约束和内核一致。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type {
  Attachment, Category, Child, DateSpec, Day, ItemInput, Label, ListItem, Occurrence, Priority, Reminder, Repeat, Scope, TimeSpec,
} from "../api/types";
import { formatDayCN, todayLocal } from "../lib/day";
import { describeEnd, describeRepeat, describeReminders, QUADRANT_LABELS, QUADRANT_ROMAN } from "../lib/labels";
import { bumpRevision, markSaved, selectOccurrence, toast, toastErr } from "../store/appStore";
import { ClockBox, FieldError, I, Modal, TintedGlyph, useEscClose } from "./ui";
import { DatePanel, EndPanel, LabelPanel, MiniMenu, Popover, RemindPanel, RepeatPanel, ScopePanel, TimePanel } from "./ItemPanels";

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)) || "未知错误";
}

/** 新建态的默认值：日期落在当前视图那天，优先级由入口象限决定。 */
export interface CreateSpec {
  day: Day;
  priority: Priority;
  listId: string;
  categoryId?: string;
}

function blankItem(c: CreateSpec): ListItem {
  return {
    id: "", listId: c.listId, title: "", remark: "", category: c.categoryId ?? "", priority: c.priority,
    labelIds: [], date: { kind: 1, start: c.day }, time: { kind: 0 }, reminders: [], progress: -1, isTop: false,
    createdAt: "", updatedAt: "",
  };
}

function toInput(it: ListItem): ItemInput {
  return {
    id: it.id, listId: it.listId, title: it.title, remark: it.remark, category: it.category,
    priority: it.priority, labelIds: it.labelIds, date: it.date, time: it.time,
    repeat: it.repeat, reminders: it.reminders, progress: it.progress,
  };
}

/** 优先级色：参考站的勾选框与头部优先级文字都用这套（§12.3），值在 global.css 的 token 里。 */
const PRIORITY_COLOR: Record<Priority, string> = { 1: "var(--prio1)", 2: "var(--prio2)", 3: "var(--prio3)", 4: "var(--prio4)" };

/**
 * 象限序号统一取 labels.ts 的 QUADRANT_ROMAN（衬线体 I/II/III/IV，与参考站的位图图标同形），
 * 这里只包一层取值。
 */
const romanOf = (p: Priority) => QUADRANT_ROMAN[p] || QUADRANT_ROMAN[4];

/** 附件的显示地址：桌面壳走 /attachments/…，浏览器示例内核直接用 data: URL。 */
function imageSrc(a: Attachment): string {
  return a.path.startsWith("data:") || a.path.startsWith("http") ? a.path : "/" + a.path;
}

type PanelKey = "date" | "time" | "remind" | "repeat" | "end" | "label" | "classify" | "priority" | "more";
/** width 由面板自己按需覆盖：结束面板的三种子视图宽度不同（190 / 258 / 210）。 */
type PanelState = { key: PanelKey; anchor: DOMRect; width?: number } | null;

export function ItemDetail({ occ, create, categories, labels, lists, onClose }: {
  occ: Occurrence | null;
  /** 传了就进新建模式：所有改动只进本地草稿，点保存或标题回车才落库 */
  create?: CreateSpec;
  categories: Category[];
  labels: Label[];
  lists: { id: string; name: string }[];
  onClose?: () => void;
}) {
  const isNew = !!create;
  const [draft, setDraft] = useState<ListItem>(create ? blankItem(create) : (occ?.item ?? blankItem({ day: todayLocal(), priority: 4, listId: "list-default" })));
  const [scope, setScope] = useState<Scope | null>(null);
  const [pendingOp, setPendingOp] = useState<{ label: string; run: (s: Scope) => void } | null>(null);
  const [panel, setPanel] = useState<PanelState>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [draftChildren, setDraftChildren] = useState<string[]>([]);
  const [childText, setChildText] = useState("");
  const [images, setImages] = useState<Attachment[]>([]);
  const [errs, seterrs] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const day = create ? create.day : (occ?.day ?? "");
  const close = useCallback(() => (onClose ? onClose() : selectOccurrence(null)), [onClose]);
  // 点灰底不再关窗（参考站也不关），所以 Esc 必须能关：新建态和详情态都注册到 Esc 栈的最上层。
  useEscClose(close);

  useEffect(() => {
    if (isNew || !occ) return;
    setDraft(occ.item);
    setScope(null);
    setPendingOp(null);
    seterrs({});
  }, [isNew, occ?.item.id, occ?.day]);

  useEffect(() => {
    if (isNew || !occ) { setChildren([]); return; }
    api.Children(occ.item.id).then(setChildren).catch(() => setChildren([]));
  }, [isNew, occ?.item.id]);

  useEffect(() => {
    if (isNew || !occ) { setImages([]); return; }
    api.ItemImages(occ.item.id).then(setImages).catch(() => setImages([]));
  }, [isNew, occ?.item.id]);

  const cat = categories.find((c) => c.id === draft.category);
  const prioColor = PRIORITY_COLOR[draft.priority || 4];
  const hasTime = draft.time.kind !== 0 && !!draft.time.start;
  const hasDate = !!draft.date.start || (draft.date.selected ?? []).length > 0;

  /** 所有写操作的统一出口：新建只改草稿；重复事项先过作用范围。 */
  function apply(label: string, mut: (i: ItemInput) => ItemInput) {
    const before = toInput(draft);
    const input = mut(before);
    // 参考站是「点一下选项 → 面板收起 → 芯片换成新值」，不会停在面板里等用户再点别处。
    if (isNew) { setDraft({ ...draft, ...input }); setPanel(null); return; }
    // 点了当前已选中的选项（重复面板最容易撞上）：什么都不改，就别弹范围、也别写库。
    // 少了这一句，每点一次都会「截断旧序列 + 新建一条同名事项」，点几次多几条。
    if (JSON.stringify(before) === JSON.stringify(input)) { setPanel(null); return; }
    const run = (s: Scope) => void save(input, s);
    if (draft.repeat && !scope) { setPendingOp({ label, run }); return; } // 范围选择嵌在面板里，这时不能收
    setPanel(null);
    run(scope!);
  }

  async function save(input: ItemInput, s: Scope) {
    try {
      const created = await api.SaveItem(input, s, day);
      const edited = created.length > 1 ? created[created.length - 1] : created[0];
      setDraft(edited);
      markSaved();
      bumpRevision();
    } catch (e) {
      toastErr(e);
      seterrs((old) => ({ ...old, __global: errText(e) }));
    }
  }

  async function createNow(titleOverride?: string) {
    const title = (titleOverride ?? draft.title).trim();
    if (!title) { seterrs((old) => ({ ...old, title: "标题不能为空" })); return; }
    try {
      const created = await api.SaveItem({ ...toInput(draft), title }, "all", "");
      const it = created[created.length - 1];
      for (const [i, t] of draftChildren.entries()) {
        await api.SaveChild({ itemId: it.id, title: t, remark: "", priority: 4, pinned: false, done: false, sort: i + 1 });
      }
      markSaved();
      bumpRevision();
      close();
    } catch (e) {
      toastErr(e);
      seterrs((old) => ({ ...old, __global: errText(e) }));
    }
  }

  async function pickScope(s: Scope) {
    setScope(s);
    const op = pendingOp;
    setPendingOp(null);
    setPanel(null); // 选完范围就把面板收起：参考站点完选项面板就消失，不会停在原地等用户再点一次
    if (op) op.run(s);
  }

  async function doDelete(s: Scope) {
    setDeleting(false);
    setPanel(null);
    try {
      await api.DeleteItem(draft.id, s, day);
      close();
      bumpRevision();
    } catch (e) {
      toastErr(e);
    }
  }

  function openPanel(key: PanelKey, e: React.MouseEvent) {
    e.stopPropagation();
    const anchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPanel((p) => (p?.key === key ? null : { key, anchor }));
  }

  async function addSubtask() {
    const title = childText.trim();
    if (!title) return;
    if (isNew) { setDraftChildren([...draftChildren, title]); setChildText(""); return; }
    try {
      await api.SaveChild({ itemId: draft.id, title, remark: "", priority: 4, pinned: false, done: false, sort: children.length + 1 });
      setChildText("");
      markSaved();
      bumpRevision();
      setChildren(await api.Children(draft.id));
    } catch (e) {
      toastErr(e);
    }
  }

  async function pickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (!files.length) return;
    if (isNew) { toast("先保存这条事项，再给它加图片"); return; }
    for (const f of files) {
      if (images.length >= 5) { toast("一条事项最多 5 张图片"); break; }
      try {
        const b64 = await fileToBase64(f);
        const att = await api.AddItemImage(draft.id, f.name, b64);
        setImages((old) => [...old, att]);
        markSaved();
      } catch (err2) {
        toastErr(err2);
      }
    }
  }

  /**
   * 日期与时间是联动的：参考站清掉日期，时间芯片就从「11:20」退回占位；
   * 反过来选了日期没管时间，时间芯片显示「全天」（2026-11-07 新建弹窗实测）。
   * 占位文案分两套：详情态「设置日期/设置时间/设置提醒」，新建态「选择日期/选择时间/创建提醒」。
   */
  const dateText = useMemo(() => {
    if (!hasDate) return isNew ? "选择日期" : "设置日期";
    const d = draft.date;
    if (d.kind === 2 && d.end && d.end !== d.start) return `${formatDayCN(d.start)} → ${formatDayCN(d.end)}`;
    if (d.kind === 3) return `自选 ${d.selected?.length ?? 0} 天`;
    return formatDayCN(d.start);
  }, [draft.date, hasDate, isNew]);

  const timeText = !hasDate ? (isNew ? "选择时间" : "设置时间")
    : hasTime ? (draft.time.kind === 2 ? `${draft.time.start} - ${draft.time.end ?? ""}` : draft.time.start!) : "全天";
  const remindText = draft.reminders.length ? describeReminders(draft.reminders) : (isNew ? "创建提醒" : "设置提醒");
  const repeatText = draft.repeat ? describeRepeat(draft.repeat) : "设置重复";
  const endText = describeEnd(draft.repeat) || "永不结束";
  const labelNames = draft.labelIds.map((id) => labels.find((l) => l.id === id)?.name).filter(Boolean) as string[];
  const labelTip = labelNames.length ? labelNames.join("、") : "添加标签";

  function commitDate(d: DateSpec) {
    setPanel(null);
    const alive = !!d.start || (d.selected ?? []).length > 0;
    apply("日期", (i) => ({ ...i, date: d, time: alive ? i.time : { kind: 0 } }));
  }

  return (
    <div className={"item-modal" + (isNew ? " is-create" : "")} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={isNew ? "新建清单" : "事项详情"}>
      {isNew ? (
        // 新建态头部：参考站就一行「新建清单」+ 右上角 ×，没有分类/优先级芯片（它们下沉成正文芯片）
        <header className="cc-head">
          <span className="cc-head-title">新建清单</span>
          <button className="cc-head-close" aria-label="关闭（Esc）" title="关闭（Esc）" onClick={close}><I n="close" size={13} /></button>
        </header>
      ) : (
      <header className="im-header">
        {/* 参考站头部用的是「←」而不是「×」：这张卡是从列表页展开的一层，返回语义更贴切 */}
        <button className="im-close" aria-label="关闭（Esc）" title="关闭（Esc）" onClick={close}><I n="chevronLeft" size={16} /></button>
        <button className="im-chip" style={{ color: cat?.color || "var(--text-3)" }} onClick={(e) => openPanel("classify", e)}>
          {/* 图标走 currentColor，颜色由外层按钮的 style 决定，和参考站「图标与文字同色」一致 */}
          <TintedGlyph icon={cat?.icon ?? ""} size={14} /><span>{cat?.name || "添加分类"}</span>
        </button>
        <button className="im-chip" style={{ color: prioColor }} onClick={(e) => openPanel("priority", e)}>
          <span className="quad-num im-prio-roman">{romanOf(draft.priority || 4)}</span>
          <span>{QUADRANT_LABELS[draft.priority] || QUADRANT_LABELS[4]}</span>
        </button>
        <span className="spacer" />
        <button className="im-more" aria-label="更多操作" aria-expanded={panel?.key === "more"} onClick={(e) => openPanel("more", e)}><I n="dots" size={14} /></button>
      </header>
      )}

      <div className="im-scroll">
        {isNew ? (<>
          <input className="cc-title" value={draft.title} maxLength={150} placeholder="请输入清单标题"
            aria-label="标题" autoFocus
            onChange={(e) => apply("标题", (i) => ({ ...i, title: e.target.value }))}
            onKeyDown={(e) => { if (e.key === "Enter" && e.currentTarget.value.trim()) void createNow(e.currentTarget.value); }} />
          <FieldError text={errs.title} />

          {/* 子任务紧跟标题：参考站新建表单第二行就是它，而且加号只在输入了文字之后才出现 */}
          <div className="cc-child">
            <span className="cc-child-icon"><I n="list" size={14} /></span>
            <input className="cc-child-add" value={childText} maxLength={150} placeholder="添加子任务，按回车快速保存" aria-label="添加子任务"
              onChange={(e) => setChildText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addSubtask(); }} />
            {!!childText.trim() && (
              <button className="cc-child-plus" aria-label="添加子任务" onClick={() => void addSubtask()}><I n="plus" size={11} /></button>
            )}
          </div>
          {!!draftChildren.length && (
            <ul className="cc-child-list">
              {draftChildren.map((t, i) => (
                <li key={i} className="cc-child-row">
                  <span className="im-child-title">{t}</span>
                  <button className="icon-btn" aria-label="移除该子任务" onClick={() => setDraftChildren(draftChildren.filter((_, j) => j !== i))}><I n="close" size={11} /></button>
                </li>
              ))}
            </ul>
          )}

          <div className="cc-row">
            <CreateChip icon="folder" text={cat?.name || "添加分类"} color={cat?.color} filled={!!cat} active={panel?.key === "classify"} onOpen={(e) => openPanel("classify", e)} />
            <CreateChip roman={romanOf(draft.priority || 4)} romanColor={prioColor} text={QUADRANT_LABELS[draft.priority] || QUADRANT_LABELS[4]} filled
              active={panel?.key === "priority"} onOpen={(e) => openPanel("priority", e)} />
          </div>
          <CreateChip icon="tag" text={labelTip} filled={!!labelNames.length} active={panel?.key === "label"} onOpen={(e) => openPanel("label", e)} />
          <div className="cc-row">
            <CreateChip icon="calendar" text={dateText} filled={hasDate} active={panel?.key === "date"} onOpen={(e) => openPanel("date", e)} />
            <CreateChip icon="clock" text={timeText} filled={hasDate} active={panel?.key === "time"} onOpen={(e) => openPanel("time", e)} />
          </div>
          <CreateChip icon="bell" text={remindText} filled={!!draft.reminders.length} active={panel?.key === "remind"} onOpen={(e) => openPanel("remind", e)} />
          <CreateChip icon="repeat" text={repeatText} filled={!!draft.repeat} active={panel?.key === "repeat"} onOpen={(e) => openPanel("repeat", e)} />
          {/* 「结束」只在选了重复规则之后出现，参考站整行是 v-if */}
          {!!draft.repeat && (
            <CreateChip icon="power" text={endText} filled active={panel?.key === "end"} onOpen={(e) => openPanel("end", e)} />
          )}

          <label className="cc-remark">
            <span className="cc-remark-icon"><I n="note" size={14} /></span>
            <textarea defaultValue={draft.remark} maxLength={2000} placeholder="添加备注" aria-label="备注"
              onBlur={(e) => e.target.value !== draft.remark && apply("备注", (i) => ({ ...i, remark: e.target.value }))} />
          </label>

          <div className="cc-foot">
            <button className="cc-btn" onClick={close}>取消</button>
            <button className="cc-btn is-primary" onClick={() => void createNow()}>保存</button>
          </div>
        </>) : (<>
        <input className="im-title" value={draft.title} maxLength={150} placeholder="请输入清单标题"
          aria-label="标题"
          onChange={(e) => apply("标题", (i) => ({ ...i, title: e.target.value }))}
          onBlur={(e) => e.target.value.trim() !== draft.title && apply("标题", (i) => ({ ...i, title: e.target.value.trim() }))} />
        <FieldError text={errs.title} />

        <FieldRow icon="calendar" tip="日期" value={dateText} filled={hasDate} active={panel?.key === "date"} onOpen={(e) => openPanel("date", e)} />
        <FieldRow icon="clock" tip="时间" value={timeText} filled={hasDate} active={panel?.key === "time"} onOpen={(e) => openPanel("time", e)} />
        <FieldRow icon="bell" tip="提醒" value={remindText} filled={!!draft.reminders.length} active={panel?.key === "remind"} onOpen={(e) => openPanel("remind", e)} />
        <FieldRow icon="repeat" tip="重复" value={repeatText} filled={!!draft.repeat} active={panel?.key === "repeat"} onOpen={(e) => openPanel("repeat", e)} />
        {/* 没有重复规则就没有「结束」这一行：参考站整行不渲染，不是灰着禁用 */}
        {!!draft.repeat && (
          <FieldRow icon="power" tip="结束" value={endText} filled active={panel?.key === "end"} onOpen={(e) => openPanel("end", e)} />
        )}
        <FieldRow icon="tag" tip="标签" value={labelTip} filled={!!labelNames.length} active={panel?.key === "label"} onOpen={(e) => openPanel("label", e)} />

        <textarea className="im-remark" defaultValue={draft.remark} maxLength={2000} placeholder="添加备注" aria-label="备注"
          onBlur={(e) => e.target.value !== draft.remark && apply("备注", (i) => ({ ...i, remark: e.target.value }))} />

        <div className="im-images">
          {images.map((a) => (
            <span key={a.id} className="im-img">
              <img src={imageSrc(a)} alt="" loading="lazy" />
              <button className="im-img-x" aria-label="删除图片" onClick={async () => {
                try { await api.DeleteAttachment(a.id); setImages((old) => old.filter((x) => x.id !== a.id)); markSaved(); } catch (e) { toastErr(e); }
              }}><I n="close" size={10} /></button>
            </span>
          ))}
          {images.length < 5 && (
            <button className="im-img-add" aria-label="添加图片" title="添加图片（最多 5 张）" onClick={() => fileRef.current?.click()}>
              <I n="plus" size={16} />
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void pickImage(e)} />
        </div>

        <div className="im-child">
          {children.map((c) => (
              <div key={c.id} className="im-child-row" style={{ ["--clock-color" as string]: PRIORITY_COLOR[c.priority || 4] }}>
                <ClockBox state={c.done ? "on" : c.failed ? "fail" : "off"} size={13} label={`完成子任务「${c.title}」`}
                  onToggle={async () => {
                    try {
                      await api.SetChildClock(c.id, c.done || c.failed ? 0 : 1);
                      markSaved();
                      bumpRevision();
                      setChildren(await api.Children(draft.id));
                    } catch (e) {
                      toastErr(e);
                    }
                  }} />
                <span className={"im-child-title" + (c.done || c.failed ? " is-done" : "")}>{c.title}</span>
                <button className="icon-btn" aria-label={`删除子任务 ${c.title}`} onClick={async () => {
                  try { await api.DeleteChild(c.id); bumpRevision(); setChildren(await api.Children(draft.id)); } catch (e) { toastErr(e); }
                }}><I n="trash" size={12} /></button>
              </div>
            ))}
          <div className="im-child-add-row">
            {/* 参考站的加号在输入框内侧左边，点它等同回车 */}
            <button className="im-child-plus" aria-label="添加子任务" onClick={() => void addSubtask()}><I n="plus" size={11} /></button>
            <input className="im-child-add" value={childText} maxLength={150} placeholder="添加子任务，按回车快速保存" aria-label="添加子任务"
              onChange={(e) => setChildText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void addSubtask()} />
          </div>
        </div>

        <FieldError text={errs.__global} />
        </>)}
      </div>

      {panel && (
        <Popover anchor={panel.anchor} width={panel.width ?? panelWidth(panel.key)} onClose={() => { setPanel(null); setPendingOp(null); }}>
          {pendingOp ? (
            // 范围选择嵌在面板里（参考站就是这样），否则浮层层级更高会把它盖住
            <ScopePanel label={pendingOp.label} onPick={(s) => void pickScope(s)} onCancel={() => setPendingOp(null)} />
          ) : (
            <>
              {panel.key === "date" && (
                <DatePanel value={draft.date} onCommit={(d) => commitDate(d)} onClose={() => setPanel(null)} />
              )}
              {panel.key === "time" && (
                <TimePanel value={draft.time}
                  onCommit={(t: TimeSpec) => { setPanel(null); apply("时间", (i) => ({ ...i, time: t })); }}
                  onClose={() => setPanel(null)} />
              )}
              {panel.key === "remind" && (
                <RemindPanel value={draft.reminders} hasDate={hasDate}
                  onWidth={(w) => setPanel((p) => (p ? { ...p, width: w } : p))}
                  onCommit={(r: Reminder[]) => { setPanel(null); apply("提醒", (i) => ({ ...i, reminders: r })); }} onClose={() => setPanel(null)} />
              )}
              {panel.key === "repeat" && (
                <RepeatPanel value={draft.repeat ?? null} date={draft.date}
                  onPick={(r: Repeat | null) => apply("重复", (i) => ({ ...i, repeat: r ?? undefined }))} />
              )}
              {panel.key === "end" && (
                <EndPanel end={draft.repeat?.end ?? { mode: 0 }}
                  onWidth={(w) => setPanel((p) => (p ? { ...p, width: w } : p))}
                  onClose={() => setPanel(null)}
                  onPick={(e) => { apply("结束", (i) => ({ ...i, repeat: i.repeat ? { ...i.repeat, end: e } : i.repeat })); }} />
              )}
              {panel.key === "label" && (
                <LabelPanel labelIds={draft.labelIds} labels={labels}
                  onCreate={async (name) => { try { return await api.SaveLabel({ name, color: "" }); } catch (e) { toastErr(e); return null; } }}
                  onCommit={(ids) => { setPanel(null); apply("标签", (i) => ({ ...i, labelIds: ids })); }}
                  onClose={() => setPanel(null)} />
              )}
              {panel.key === "classify" && (
                <MiniMenu items={[
                  { key: "", label: "无分类", selected: !draft.category },
                  ...categories.map((c) => ({ key: c.id, label: c.name, color: c.color || undefined, selected: c.id === draft.category })),
                  { key: "__manage", label: "管理分类…" },
                ]} onPick={(k) => {
                  setPanel(null);
                  if (k === "__manage") { toast("在顶栏「筛选 → 管理分类…」里维护分类"); return; }
                  apply("分类", (i) => ({ ...i, category: k }));
                }} />
              )}
              {panel.key === "priority" && (
                <MiniMenu items={([1, 2, 3, 4] as Priority[]).map((p) => ({ key: String(p), label: QUADRANT_LABELS[p], color: PRIORITY_COLOR[p], roman: QUADRANT_ROMAN[p], selected: (draft.priority || 4) === p }))}
                  onPick={(k) => { setPanel(null); apply("优先级", (i) => ({ ...i, priority: Number(k) as Priority })) }} />
              )}
              {panel.key === "more" && (
                <MiniMenu items={[
                  { key: "top", label: draft.isTop ? "取消置顶" : "置顶" },
                  { key: "delete", label: "删除清单" },
                ]} onPick={(k) => {
                  setPanel(null);
                  if (k === "top") void api.SetItemTop(draft.id, !draft.isTop).then(() => { markSaved(); bumpRevision(); }).catch(toastErr);
                  if (k === "delete") {
                    // 一律先弹确认：之前只有重复事项走确认，普通事项点一下就删了，
                    // 手滑一次就少一条清单，参考站是两步（确认 → 重复的再问范围）。
                    setDeleting(true);
                  }
                }} />
              )}
            </>
          )}
        </Popover>
      )}

      {pendingOp && !panel && (
        <Modal title="这条是重复事项" onClose={() => setPendingOp(null)}>
          <p className="muted">「{pendingOp.label}」要作用在哪个范围？</p>
          <div className="btn-row">
            {(["thisDay", "thisAndFuture", "all"] as Scope[]).map((s) => (
              <button key={s} className="btn" onClick={() => void pickScope(s)}>{SCOPE_LABEL[s]}</button>
            ))}
            <button className="btn" onClick={() => setPendingOp(null)}>取消</button>
          </div>
        </Modal>
      )}

      {deleting && !pendingOp && (
        // 确认框属于「点灰底=取消」的瞬时对话（参考站的删除确认就是这样），不套 keepOnMask
        <Modal title="删除事项" onClose={() => setDeleting(false)}>
          <p className="muted">确认删除「{draft.title || "（无标题）"}」？{draft.repeat ? "这是重复事项，下一步会问作用范围。" : ""}</p>
          <div className="btn-row">
            <button className="btn danger" onClick={() => {
              if (draft.repeat && !scope) { setDeleting(false); setPendingOp({ label: "删除", run: (s) => void doDelete(s) }); return; }
              void doDelete(scope ?? "all");
            }}>删除</button>
            <button className="btn" onClick={() => setDeleting(false)}>取消</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const SCOPE_LABEL: Record<Scope, string> = { thisDay: "仅当天清单", thisAndFuture: "当日及未来清单", all: "全部清单" };

/** 各面板的宽度照抄参考站实测值（§12.2 / §13）；结束面板会按子视图自己改宽度。 */
function panelWidth(key: PanelKey): number {
  if (key === "date") return 258;
  if (key === "time") return 200;
  if (key === "repeat") return 250;
  if (key === "label") return 250;
  if (key === "remind") return 216;
  if (key === "end") return 190;
  return 180;
}

/**
 * 新建态芯片：描边小盒子，左侧图标（空态灰 / 已填主色绿）、中间文案（空态占位灰）、右侧箭头。
 * 参考站的 .matter-* 就是这个形态，hover 时整圈描边变绿。
 */
function CreateChip({ icon, roman, romanColor, color, text, filled, active, onOpen }: {
  icon?: string; roman?: string; romanColor?: string; color?: string; text: string; filled?: boolean; active?: boolean;
  onOpen: (e: React.MouseEvent) => void;
}) {
  return (
    <button className={"cc-chip" + (filled ? " is-filled" : "") + (active ? " is-active" : "")} onClick={onOpen}>
      {roman
        // 序号就是参考站那枚彩色衬线字形：颜色跟优先级走，旁边的文字仍按空/满两态着色
        ? <span className="quad-num cc-chip-roman" style={romanColor ? { color: romanColor } : undefined}>{roman}</span>
        : <span className="cc-chip-icon">{icon ? <I n={icon} size={14} /> : null}</span>}
      <span className="cc-chip-text" style={filled && color ? { color } : undefined}>{text}</span>
      <span className="cc-chip-arrow"><I n="chevronRight" size={12} /></span>
    </button>
  );
}

/** 详情态字段行：图标 + 灰色标签 + 值。值没填时是占位灰，填了才是主色绿（参考站 .text-tip / .text-right）。 */
function FieldRow({ icon, tip, value, filled, active, onOpen }: {
  icon: string; tip: string; value: string; filled?: boolean; active?: boolean; onOpen: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="im-row">
      <span className="im-row-icon"><I n={icon} size={14} /></span>
      <span className="im-row-tip">{tip}</span>
      <button className={"im-row-value" + (filled ? "" : " is-void") + (active ? " is-active" : "")} onClick={onOpen}>{value}</button>
    </div>
  );
}

function fileToBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? "");
      res(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => rej(new Error("读不到所选图片"));
    r.readAsDataURL(f);
  });
}

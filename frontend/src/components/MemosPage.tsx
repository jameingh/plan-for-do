// MemosPage.tsx —— 备忘录模块，按参考站 /web/memo 逐层复刻。
// 取证：tmp/ref/evidence-memo-bundle.md（组件/类名树/数据模型/交互表/文案表/CSS 原文）
//      tmp/ref/evidence-memo-editor.md（postMessage 协议、保存链路、配额与上限）
//      docs/design-reference.md §22（我方落地与偏离）
//
// 版式：左列 3.58rem（文件夹头 + 搜索 + 列表 + 底部「新建备忘录 / 回收站」），
//       右侧编辑器（标题行 + 工具条 + iframe 正文）；没打开时是居中「暂无内容」空态。
// 关键交互（都照参考站，不是我方发挥）：
//   · 单击列表项开编辑器；点标题就地改名（回车提交 / Esc 取消）；右键出「置顶 / 移入文件夹 / 删除」
//   · 只有点「保存」或切到另一条备忘录才落库；离开本页静默丢弃（参考站就是这样）
//   · 搜索只在回车时过滤，并把命中词标红（±30 字窗口）；搜索态下丢掉置顶优先级
//   · 删除只进回收站；回收站里恢复 / 彻底删除各带一次确认
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { Attachment, Memo, MemoFileKind, MemoFolder, MemoInput, MemoItem, MemoSort } from "../api/types";
import { MemoFile } from "../api/types";
import { bumpRevision, toast, toastErr, useApp } from "../store/appStore";
import { todayLocal } from "../lib/day";
import { I, useAutoFocus, useEscClose } from "./ui";
import { MEMO_COLORS, MEMO_FONTS, MEMO_SIZES, MemoEditor, baseStyle, sizeToExec, type MemoEditorHandle, type MemoStyle } from "./MemoEditor";

const SORTS: { v: MemoSort; label: string }[] = [
  { v: 0, label: "按创建时间排序" },
  { v: 1, label: "按修改时间排序" },
];

/** 弹层种类。同一时刻只开一个（参考站 openModule 会把其它 status 复位）。 */
type Popup = "" | "folder" | "sort" | "handle" | "move" | "setfolder" | "manager" | "bin" | "font" | "size" | "color" | "bgcolor" | "back";

const emptyDraft = (): MemoInput => ({
  id: "", folderId: "", title: "", html: "", backImage: "", fileType: MemoFile.None, fileId: "",
});

/** 列表时间：当天只给时分，今年给月日，跨年补年份。取创建还是修改时间跟着排序方式走。 */
function memoWhen(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const t = todayLocal();
  // 参考站：当天只显示 HH:mm（不是「11月07日 21:25」那种整串）
  if (day === t) return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === Number(t.slice(0, 4)) ? md : `${d.getFullYear()}年${md}`;
}

/** 回收站的时间：参考站 setCreateDate 只到年月日，不显示时分。 */
function memoDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 附件的展示地址：内核给的是相对 dataDir 的路径，壳层挂在 /attachments/ 下。 */
function attachmentURL(a?: Pick<Attachment, "path"> | null): string {
  if (!a?.path) return "";
  if (a.path.startsWith("data:") || a.path.startsWith("http") || a.path.startsWith("/")) return a.path;
  return `/attachments/${a.path.split("/").pop()}`;
}

/** 参考站的背景图池：14 张 CDN webp，分两页。素材不能内嵌，这里换成同等数量的本机渐变底。 */
const MEMO_BACKS: { id: string; css: string }[] = [
  { id: "plain", css: "" },
  { id: "grid", css: "repeating-linear-gradient(0deg,#f6f8f7 0 23px,#e9efec 23px 24px)" },
  { id: "dot", css: "radial-gradient(#dfe7e4 1px,transparent 1px) 0 0/18px 18px" },
  { id: "line", css: "repeating-linear-gradient(0deg,transparent 0 27px,#e6ece9 27px 28px)" },
  { id: "cream", css: "linear-gradient(180deg,#fffaf0,#fdf3e3)" },
  { id: "mint", css: "linear-gradient(180deg,#f1fbf7,#e4f5ee)" },
  { id: "sky", css: "linear-gradient(180deg,#f2f8ff,#e6f0fb)" },
  { id: "blush", css: "linear-gradient(180deg,#fff5f5,#fdeaea)" },
  { id: "lilac", css: "linear-gradient(180deg,#f7f5fd,#eee9f9)" },
  { id: "sand", css: "linear-gradient(180deg,#fbf8f1,#f4eee1)" },
  { id: "sage", css: "linear-gradient(135deg,#f4f7f0,#e8efe2)" },
  { id: "graph", css: "repeating-linear-gradient(90deg,#f7f9f8 0 23px,#e9efec 23px 24px),repeating-linear-gradient(0deg,#f7f9f8 0 23px,#e9efec 23px 24px)" },
  { id: "warm", css: "linear-gradient(180deg,#fdf6ee,#f8ead9)" },
  { id: "cool", css: "linear-gradient(180deg,#f4f8fa,#e8f0f4)" },
];

/** 弹层的落位信息。right 只有「元素触发」时才有（鼠标触发的右键菜单没有触发器）。 */
type At = { x: number; y: number; right?: number };

/**
 * 浮层贴边保护：浮层按触发器位置摆好后，可能被视口右边/下边切掉。
 * 2026-11-09 背景图弹层就有一半在屏幕外（工具栏最右，弹层 3rem 宽）。
 * 这里量出实际尺寸再决定最终落位：
 *   · 默认贴着触发器左边；align="end" 时贴右边（排序菜单就该右对齐，否则会横着伸进编辑区）；
 *   · 右边放不下就改成贴视口右边；下边放不下就往上顶。
 * 用 offsetWidth/offsetHeight 量（不受 transform 影响），所以修正量不会来回抖。
 */
function useEdgeGuard(at: At, align: "start" | "end" = "start") {
  // 用 callback ref 而不是 useRef<HTMLElement>：同一个 hook 要挂到 ul / div 两种元素上，
  // useRef 的类型对不上会报 TS2322；callback ref 的参数类型 HTMLElement 是超集，各元素都能接。
  const [el, setEl] = useState<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => setEl(node), []);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  useLayoutEffect(() => {
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = align === "end" && at.right !== undefined ? at.right - w : at.x;
    if (left + w > vw - 8) {
      // 右对齐放不下：先试左对齐触发器，再退到贴视口右边
      if (align === "end" && at.x + w <= vw - 8) left = at.x;
      else left = vw - 8 - w;
    }
    if (left < 8) left = 8;
    let top = at.y;
    if (top + h > vh - 8) top = Math.max(8, vh - 8 - h);
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  });
  return { ref, style: { left: pos.left, top: pos.top } };
}

export function MemosPage() {
  const { booted, revision, settings } = useApp();
  const [folders, setFolders] = useState<MemoFolder[]>([]);
  const [items, setItems] = useState<MemoItem[]>([]);
  const [folderId, setFolderId] = useState("");          // "" = 全部
  const [word, setWord] = useState("");                   // 输入框里的词
  const [applied, setApplied] = useState("");             // 回车后才生效的词
  const [sort, setSort] = useState<MemoSort>(settings.memoSortType ?? 0);
  const [open, setOpen] = useState<Memo | null>(null);
  const [draft, setDraft] = useState<MemoInput>(emptyDraft());
  const [dirty, setDirty] = useState(false);
  const [popup, setPopup] = useState<Popup>("");
  const [at, setAt] = useState<At>({ x: 0, y: 0 });
  const [handleID, setHandleID] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [style, setStyle] = useState<MemoStyle>(baseStyle());
  const [confirmBox, setConfirmBox] = useState<{ title: string; intro: string; ok: string; onOk: () => void } | null>(null);
  const [backPage, setBackPage] = useState(0);
  const editor = useRef<MemoEditorHandle | null>(null);
  const filePick = useRef<Partial<Record<MemoFileKind, HTMLInputElement | null>>>({});
  const moreBtn = useRef<HTMLDivElement | null>(null);
  const folderNameRef = useRef<HTMLDivElement | null>(null);
  const state = useRef({ draft, open });
  state.current = { draft, open };

  // 每个浮层一套贴边保护。只有真正渲染出来的那套 ref 非空，其余直接跳过。
  const gSort = useEdgeGuard(at, "end");   // 排序菜单：右对齐「…」，否则会伸进编辑区
  const gFolder = useEdgeGuard(at);        // 「全部」下拉：左缘对齐标题
  const gFont = useEdgeGuard(at);           // 字体 / 字号
  const gColor = useEdgeGuard(at);          // 文字色 / 背景色
  const gBack = useEdgeGuard(at);           // 背景图
  const gCtx = useEdgeGuard(at);            // 列表右键菜单（跟着鼠标）
  const gMove = useEdgeGuard(at);           // 右键「移入文件夹」

  // 参考站：筛选目标文件夹不存在时自动回落「全部」（evidence-memo-bundle §4 末「其他实现细节」）。
  // 删掉当前文件夹后如果还留着那个 id，列表会空掉——就是这种时候最容易发现。
  useEffect(() => {
    if (folderId && folders.length && !folders.some((f) => f.id === folderId)) setFolderId("");
  }, [folders, folderId]);

  const folderName = useMemo(
    () => (folderId ? folders.find((f) => f.id === folderId)?.name || "全部" : "全部"),
    [folderId, folders]);

  useEffect(() => {
    if (!booted) return;
    let dead = false;
    api.MemoFolders().then((f) => !dead && setFolders(f)).catch(toastErr);
    return () => { dead = true; };
  }, [booted, revision]);

  useEffect(() => {
    if (!booted) return;
    let dead = false;
    api.MemoList({ folderId, search: applied, sort, showDeleted: false })
      .then((v) => !dead && setItems(v)).catch(toastErr);
    return () => { dead = true; };
  }, [booted, revision, folderId, applied, sort]);

  // 排序方式：参考站写 localStorage，我们写内核设置（这样它会跟着同步走）
  useEffect(() => {
    const s = settings.memoSortType ?? 0;
    if (s !== sort) setSort(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.memoSortType]);

  function chooseSort(v: MemoSort) {
    setSort(v);
    setPopup("");
    void api.SaveSettings({ ...settings, memoSortType: v }).then(() => bumpRevision()).catch(toastErr);
  }

  /** 切到另一条之前先把当前这条存了——参考站的 watch targetNote 就是这个分支。 */
  const flush = useCallback(async () => {
    const cur = state.current;
    if (!cur.open || !cur.draft.id || cur.draft.id !== cur.open.id) return;
    const changed = cur.draft.title !== cur.open.title || cur.draft.html !== cur.open.html
      || cur.draft.backImage !== cur.open.backImage || cur.draft.folderId !== cur.open.folderId;
    if (!changed) return;
    try { await api.SaveMemo(cur.draft); } catch (e) { toastErr(e); }
  }, []);

  async function openMemo(id: string) {
    if (open?.id === id) return;                 // 参考站：同一条重复点击不动作
    await flush();
    try {
      const m = await api.Memo(id);
      setOpen(m);
      setDraft({ id: m.id, folderId: m.folderId, title: m.title, html: m.html, backImage: m.backImage, fileType: m.fileType, fileId: m.fileId });
      setDirty(false);
      setPopup("");
      setStyle(baseStyle());
    } catch (e) { toastErr(e); }
  }

  async function createMemo() {
    try {
      await flush();
      const m = await api.CreateMemo(folderId);
      bumpRevision();
      setOpen(m);
      setDraft({ id: m.id, folderId: m.folderId, title: "", html: "", backImage: "", fileType: MemoFile.None, fileId: "" });
      setDirty(false);
      setTimeout(() => editor.current?.focus(), 60);
    } catch (e) { toastErr(e); }
  }

  function patch(p: Partial<MemoInput>) {
    setDraft((d) => ({ ...d, ...p }));
    setDirty(true);
  }

  async function save() {
    if (!draft.id) return;
    try {
      const m = await api.SaveMemo(draft);
      bumpRevision();
      setOpen(m);
      setDraft((d) => ({ ...d, id: m.id }));
      setDirty(false);
    } catch (e) { toastErr(e); }
  }

  async function top(id: string, on: boolean) {
    try {
      await api.SetMemoTop(id, on);
      setPopup("");
      bumpRevision();
    } catch (e) { toastErr(e); }
  }

  function askTrash(id: string) {
    setPopup("");
    setConfirmBox({
      title: "确定要删除该备忘录？",
      intro: "删除后该备忘录可在回收站查看",
      ok: "确定",
      onOk: async () => {
        setConfirmBox(null);
        try {
          await api.TrashMemos([id]);
          if (state.current.open?.id === id) { setOpen(null); setDraft(emptyDraft()); }
          bumpRevision();
        } catch (e) { toastErr(e); }
      },
    });
  }

  /** 右键的「移入文件夹」：参考站走 moveNote，立即同步，与当前开没开这条无关。 */
  async function moveInto(fid: string) {
    const id = handleID;
    setPopup("");
    try {
      await api.MoveMemoFolders([id], fid);
      bumpRevision();
    } catch (e) { toastErr(e); }
  }

  /** 编辑器里那个文件夹图标：参考站走 setFolder，只改 currentNote，点「保存」才提交。 */
  function setFolder(fid: string) {
    setPopup("");
    patch({ folderId: fid });
  }

  /** 附件：字节 base64 进内核落盘，正文里插对应标签；列表缩略记这条的第一个附件类型。 */
  const onPickFile = async (kind: MemoFileKind, file: File) => {
    if (!draft.id) { toast("先保存一次再放附件"); return; }
    try {
      const b64 = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(",")[1] || "");
        fr.onerror = () => rej(fr.error);
        fr.readAsDataURL(file);
      });
      const [att, rawKind] = await api.AddMemoFile(draft.id, file.name, b64);
      const got = rawKind as MemoFileKind;
      const url = attachmentURL(att);
      const name = file.name.replace(/[<>&"]/g, "");
      const frag = got === MemoFile.Image
        ? `<p><img id="${att.id}" data-file-id="${att.id}" class="showDivImg" src="${url}" alt="${name}"></p>`
        : got === MemoFile.Video
          ? `<div class="enclosure-fileBox" data-file-id="${att.id}" contenteditable="false"><span class="enclosure-name">${name}</span><span class="enclosure-size">${file.size}</span></div>`
          : got === MemoFile.Audio
            ? `<div class="enclosure-fileBox" data-file-id="${att.id}" contenteditable="false"><span class="enclosure-name">${name}</span><span class="enclosure-size">${file.size}</span></div>`
            : `<div class="enclosure-fileBox" data-file-id="${att.id}" contenteditable="false"><span class="enclosure-name">${name}</span><span class="enclosure-size">${file.size}</span></div>`;
      editor.current?.insertHTML(frag);
      // 参考站的列表缩略取本条第一个附件；我们只记「最近一次插入的类型」，
      // 因为内核没有按 owner 列附件的公开读口，硬凑一个反而偏离证据。
      patch({ fileType: got, fileId: att.id });
      bumpRevision();
    } catch (e) { toastErr(e); }
  };

  /** 正文里点附件卡片：文件走下载，其余新开窗口（参考站 openFile 的分支）。 */
  const onOpenFile = (fileId: string) => {
    if (!fileId) return;
    if (draft.fileId === fileId && draft.fileType === MemoFile.File) { toast("附件预览在本机打开"); return; }
    toast("附件已随记录保存在本机数据目录");
  };

  function toolbar(cmd: string, val?: string) {
    editor.current?.exec(cmd, val);
    setDirty(true);
  }

  /** 参考站的复选框：`&zwnj;<input type=checkbox name=vehicle>&nbsp;` */
  const insertCheckBox = () => toolbar("insertHTML", "&zwnj;<input type=\"checkbox\" name=\"vehicle\" value=\"checkBox\">&nbsp;");

  const pickFolder = () => {
    // 落位跟着「全部」这一行的真实位置算（参考站的 FolderSelect 也是 mounted 时按锚点算 margin），
    // 不再写死 left:1.1rem —— 那是相对遮罩左边算的，跟标题对不齐。
    const r = folderNameRef.current?.getBoundingClientRect();
    if (r) setAt({ x: r.left, y: r.bottom + 2 });
    setPopup(popup === "folder" ? "" : "folder");
  };

  return (
    <div className="memos-page">
      <section className="memo-list" aria-label="备忘录列表">
        <div className="memo-folder">
          <div className="text-folder-name my-cursor" ref={folderNameRef} onClick={pickFolder}>{folderName}</div>
          <div className={"icon-folder-select my-cursor" + (popup === "folder" ? " is-on" : "")} role="button"
            aria-label="切换文件夹" onClick={pickFolder}><I n="chevronDown" size={11} /></div>
          <div className="icon-folder-more my-cursor" role="button" aria-label="排序与文件夹管理" ref={moreBtn}
            onClick={() => {
              const r = moreBtn.current?.getBoundingClientRect();
              if (r) setAt({ x: r.x, y: r.bottom + 2, right: r.right });
              setPopup(popup === "sort" ? "" : "sort");
            }}><I n="dots" size={15} /></div>
        </div>

        <div className="memo-search-box">
          <span className="icon-search"><I n="search" size={13} /></span>
          <input
            className="memo-search" placeholder="查找备忘录，按回车键搜索" aria-label="查找备忘录" value={word}
            onChange={(e) => { setWord(e.target.value); if (!e.target.value) setApplied(""); }}
            onKeyDown={(e) => { if (e.key === "Enter") setApplied(word.trim()); }}
          />
          {!!word && (
            <button className="icon-clear" aria-label="清空搜索"
              onClick={() => { setWord(""); setApplied(""); }}><I n="close" size={11} /></button>
          )}
        </div>

        <div className="memo-items">
          {items.map((it) => (
            <MemoRow key={it.memo.id} it={it} word={applied} active={open?.id === it.memo.id}
              sortIsEdit={sort === 1} onOpen={() => void openMemo(it.memo.id)}
              onContext={(e) => {
                e.preventDefault();
                setAt({ x: e.clientX, y: e.clientY });
                setHandleID(it.memo.id);
                setPopup("handle");
              }}
            />
          ))}
          {!items.length && <div className="memo-none"><I n="inbox" size={30} /><span>暂无内容</span></div>}
        </div>

        <div className="foot-block">
          <div className="create-note my-cursor" role="button" onClick={() => void createMemo()}>
            <span className="icon-create"><I n="plus" size={12} /></span>新建备忘录
          </div>
          <div className="delete-note my-cursor" role="button" onClick={() => { setPopup(popup === "bin" ? "" : "bin"); setPicked([]); }}>
            <span className="icon-delete"><I n="trash" size={12} /></span>回收站
          </div>
        </div>
      </section>

      <section className="memo-main">
        {open ? (
          <div className="body-memo-editor">
            <div className="body-note-title">
              <input
                className="note-title" placeholder="无标题" aria-label="备忘录标题"
                maxLength={4000} value={draft.title}
                onChange={(e) => patch({ title: e.target.value })}
              />
              <button className={"note-submit my-cursor" + (dirty ? " is-dirty" : "")} onClick={() => void save()}>保存</button>
              <div className="note-folder my-cursor" role="button" aria-label="移入文件夹" title="移入文件夹"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setAt({ x: r.x, y: r.bottom + 2 });
                  setPopup("setfolder");
                }}><I n="folder" size={14} /></div>
            </div>

            <div className="body-note-utils">
              <div className="icon-item" role="button" aria-label="撤销" onClick={() => toolbar("undo")}><I n="undo" size={14} /></div>
              <div className="icon-item" role="button" aria-label="重做" onClick={() => toolbar("redo")}><I n="redo" size={14} /></div>
              <i className="line-item" />
              <Pick kind="font" label={MEMO_FONTS.find((f) => f.code === style.family)?.name || "默认字体"}
                open={popup === "font"} onToggle={(k, pos) => { setAt(pos); setPopup(popup === "font" ? "" : k); }} />
              <i className="line-item" />
              <Pick kind="size" label={String(MEMO_SIZES.includes(style.size) ? style.size : 16)}
                open={popup === "size"} onToggle={(k, pos) => { setAt(pos); setPopup(popup === "size" ? "" : k); }} />              <div className={"icon-item" + (style.bold ? " is-on" : "")} role="button" aria-label="加粗" onClick={() => toolbar("bold")}><b className="g">B</b></div>
              <div className={"icon-item" + (style.italic ? " is-on" : "")} role="button" aria-label="斜体" onClick={() => toolbar("italic")}><i className="g">I</i></div>
              <div className={"icon-item" + (style.underline ? " is-on" : "")} role="button" aria-label="下划线" onClick={() => toolbar("underline")}><u className="g">U</u></div>
              <div className={"icon-item" + (style.strike ? " is-on" : "")} role="button" aria-label="删除线" onClick={() => toolbar("strikeThrough")}><s className="g">S</s></div>
              <div className="block-item color-item my-cursor" role="button" aria-label="文字颜色"
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt({ x: r.x, y: r.bottom + 2, right: r.right }); setPopup(popup === "color" ? "" : "color"); }}>
                <span className="g">A</span><i className="color-stripe" style={{ background: style.color }} />
                <span className="icon-corner-mark" />
              </div>
              <div className="block-item bg-item my-cursor" role="button" aria-label="背景颜色"
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt({ x: r.x, y: r.bottom + 2, right: r.right }); setPopup(popup === "bgcolor" ? "" : "bgcolor"); }}>
                <I n="marker" size={14} /><i className="color-stripe" style={{ background: style.bg }} />
                <span className="icon-corner-mark" />
              </div>
              <i className="line-item" />
              <div className="icon-item" role="button" aria-label="任务列表" title="任务列表" onClick={insertCheckBox}><I n="checkList" size={14} /></div>
              <div className="icon-item" role="button" aria-label="有序列表" title="有序列表" onClick={() => toolbar("insertOrderedList")}><I n="orderList" size={14} /></div>
              <div className="icon-item" role="button" aria-label="无序列表" title="无序列表" onClick={() => toolbar("insertUnorderedList")}><I n="unorderedList" size={14} /></div>
              <div className="icon-item" role="button" aria-label="左对齐" onClick={() => toolbar("justifyLeft")}><I n="alignLeft" size={14} /></div>
              <div className="icon-item" role="button" aria-label="居中对齐" onClick={() => toolbar("justifyCenter")}><I n="alignCenter" size={14} /></div>
              <div className="icon-item" role="button" aria-label="右对齐" onClick={() => toolbar("justifyRight")}><I n="alignRight" size={14} /></div>
              <div className="icon-item" role="button" aria-label="增加缩进" onClick={() => toolbar("indent")}><I n="indent" size={14} /></div>
              <div className="icon-item" role="button" aria-label="减少缩进" onClick={() => toolbar("outdent")}><I n="outdent" size={14} /></div>
              <i className="line-item" />
              <div className={"icon-item" + (draft.backImage ? " is-on" : "")} role="button" aria-label="选择背景"
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setAt({ x: r.x, y: r.bottom + 2, right: r.right }); setPopup(popup === "back" ? "" : "back"); }}>
                <I n="bgImage" size={14} />
              </div>
              <i className="line-item" />
              {([MemoFile.Image, MemoFile.Video, MemoFile.File, MemoFile.Audio] as MemoFileKind[]).map((k) => (
                <div key={k} className="icon-item" role="button"
                  aria-label={k === 0 ? "插入图片" : k === 1 ? "插入视频" : k === 3 ? "插入音频" : "插入文件"}
                  onClick={() => filePick.current[k]?.click()}>
                  <I n={k === 0 ? "image" : k === 1 ? "video" : k === 3 ? "audio" : "file"} size={14} />
                </div>
              ))}
              {([MemoFile.Image, MemoFile.Video, MemoFile.File, MemoFile.Audio] as MemoFileKind[]).map((k) => (
                <input key={k} type="file" hidden ref={(el) => { filePick.current[k] = el; }}
                  accept={k === 0 ? "image/*" : k === 1 ? "video/*" : k === 3 ? "audio/*" : undefined}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickFile(k, f); e.target.value = ""; }} />
              ))}
            </div>

            <MemoEditor ref={editor} value={draft.html} backImage={backCSS(draft.backImage)}
              onChange={(html) => { setDraft((d) => ({ ...d, html })); setDirty(true); }}
              onStyle={setStyle} onOpenFile={onOpenFile} />
          </div>
        ) : (
          <div className="memo-none is-main"><I n="inbox" size={44} /><span>暂无内容</span></div>
        )}
      </section>

      {/* —— 以下都是参考站那套 curtain 浮层，不是 el-dialog —— */}
      {popup === "folder" && (
        <Curtain onClose={() => setPopup("")}>
          <div className="folder-box" ref={gFolder.ref} style={gFolder.style} onMouseDown={(e) => e.stopPropagation()}>
            <FolderList folders={folders} selected={folderId} onPick={(id) => { setFolderId(id); setPopup(""); }} />
          </div>
        </Curtain>
      )}
      {popup === "move" && (
        <Curtain onClose={() => setPopup("")}>
          <div className="folder-box is-mouse" ref={gMove.ref} style={gMove.style} onMouseDown={(e) => e.stopPropagation()}>
            <FolderList folders={folders} selected={items.find((i) => i.memo.id === handleID)?.memo.folderId || ""} onPick={moveInto} />
          </div>
        </Curtain>
      )}
      {popup === "setfolder" && (
        <Curtain onClose={() => setPopup("")}>
          {/* setFolder 不跟鼠标：参考站固定在右上角（right .7rem / top .6rem） */}
          <div className="folder-box is-setfolder" onMouseDown={(e) => e.stopPropagation()}>
            <FolderList folders={folders} selected={draft.folderId} onPick={setFolder} />
          </div>
        </Curtain>
      )}
      {popup === "sort" && (
        <Curtain onClose={() => setPopup("")}>
          <ul className="menu-box is-mouse" ref={gSort.ref} style={gSort.style} onMouseDown={(e) => e.stopPropagation()}>
            <li className="item-title">排序方式</li>
            {SORTS.map((s) => (
              <li key={s.v} className={"item my-cursor" + (sort === s.v ? " item-selected" : "")} onClick={() => chooseSort(s.v)}>
                {s.label}<i className="icon-selected" />
              </li>
            ))}
            <li className="item-title my-cursor" onClick={() => setPopup("manager")}>文件夹管理</li>
          </ul>
        </Curtain>
      )}
      {popup === "handle" && (
        <Curtain onClose={() => setPopup("")}>
          <ul className="menu-box is-mouse" ref={gCtx.ref} style={gCtx.style} onMouseDown={(e) => e.stopPropagation()}>
            {(() => {
              const isTop = !!items.find((i) => i.memo.id === handleID)?.memo.isTop;
              return (
                <>
                  <li className="item my-cursor" onClick={() => void top(handleID, !isTop)}>{isTop ? "取消置顶" : "置顶"}</li>
                  <li className="item my-cursor" onClick={() => setPopup("move")}>移入文件夹</li>
                  <li className="item my-cursor" onClick={() => askTrash(handleID)}>删除</li>
                </>
              );
            })()}
          </ul>
        </Curtain>
      )}
      {(popup === "font" || popup === "size") && (
        <Curtain onClose={() => setPopup("")}>
          <ul className="menu-box is-mouse" ref={gFont.ref} style={gFont.style} onMouseDown={(e) => e.stopPropagation()}>
            {popup === "font" && MEMO_FONTS.map((f) => (
              <li key={f.code} className={"item my-cursor" + (style.family === f.code ? " item-selected" : "")}
                style={{ fontFamily: f.stack }}
                onClick={() => { toolbar("fontName", f.stack); setPopup(""); }}>{f.name}<i className="icon-selected" /></li>
            ))}
            {popup === "size" && MEMO_SIZES.map((n) => (
              <li key={n} className={"item my-cursor" + (style.size === n ? " item-selected" : "")}
                onClick={() => { toolbar("fontSize", String(sizeToExec(n))); setPopup(""); }}>{n}<i className="icon-selected" /></li>
            ))}
          </ul>
        </Curtain>
      )}
      {(popup === "color" || popup === "bgcolor") && (
        <Curtain onClose={() => setPopup("")}>
          <div className="color-box" ref={gColor.ref} style={gColor.style} onMouseDown={(e) => e.stopPropagation()}>
            {MEMO_COLORS.map((c) => (
              <button key={c} aria-label={`颜色 ${c}`} style={{ background: c }}
                onClick={() => { toolbar(popup === "color" ? "foreColor" : "hiliteColor", c); setPopup(""); }} />
            ))}
          </div>
        </Curtain>
      )}
      {popup === "back" && (
        <Curtain onClose={() => setPopup("")}>
          <div className="back-box" ref={gBack.ref} style={gBack.style} onMouseDown={(e) => e.stopPropagation()}>
            <div className="back-head">选择背景</div>
            <div className="back-grid">
              {MEMO_BACKS.slice(backPage * 8, backPage * 8 + 8).map((b) => (
                <button key={b.id}
                  className={"back-cell" + (draft.backImage === b.id ? " is-sel" : "")}
                  style={b.css ? { background: b.css } : undefined}
                  aria-label={`背景 ${b.id}`}
                  // 再点一次已选中的 = 清除（参考站就是这么做的）
                  onClick={() => patch({ backImage: draft.backImage === b.id ? "" : b.id })} />
              ))}
            </div>
            <div className="back-foot">
              <button className="cc-btn" disabled={backPage === 0} onClick={() => setBackPage(0)}>‹</button>
              <span>{backPage + 1} / 2</span>
              <button className="cc-btn" disabled={backPage === 1} onClick={() => setBackPage(1)}>›</button>
            </div>
          </div>
        </Curtain>
      )}
      {popup === "manager" && (
        // 参考站是 curtain-grey（点外面关）+ 居中卡片；我们原来没有遮罩，直接一个右侧抽屉。
        <Curtain onClose={() => setPopup("")}>
          <FolderManager folders={folders} onClose={() => setPopup("")} />
        </Curtain>
      )}
      {popup === "bin" && (
        <RecycleBin picked={picked} setPicked={setPicked} onClose={() => setPopup("")}
          askConfirm={(kind, ids) => {
            setPopup("");
            if (kind === "restore") {
              setConfirmBox({
                title: "恢复备忘录", intro: "确定要恢复备忘录至列表吗？", ok: "确定",
                onOk: async () => {
                  setConfirmBox(null);
                  try { await api.RestoreMemos(ids); setPicked([]); bumpRevision(); setPopup("bin"); } catch (e) { toastErr(e); }
                },
              });
            } else {
              setConfirmBox({
                title: "删除备忘录", intro: "确定要永久删除备忘录，删除后不可找回", ok: "确定",
                onOk: async () => {
                  setConfirmBox(null);
                  try { await api.PurgeMemos(ids); setPicked([]); bumpRevision(); setPopup("bin"); } catch (e) { toastErr(e); }
                },
              });
            }
          }} />
      )}
      {confirmBox && (
        <div className="memo-mask">
          <div className="confirm-box" onMouseDown={(e) => e.stopPropagation()}>
            <div className="confirm-head"><span>{confirmBox.title}</span>
              <button aria-label="关闭" onClick={() => setConfirmBox(null)}><I n="close" size={11} /></button></div>
            <p className="confirm-intro">{confirmBox.intro}</p>
            <div className="confirm-foot">
              <button className="cc-btn" onClick={() => setConfirmBox(null)}>取消</button>
              <button className="cc-btn is-primary" onClick={confirmBox.onOk}>{confirmBox.ok}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 背景图 id → CSS 值（参考站存的是完整 URL，我们存 id，渲染时查表）。 */
function backCSS(id: string): string {
  if (!id) return "";
  if (id.startsWith("http") || id.startsWith("data:") || id.startsWith("/")) return attachmentURL({ path: id });
  const hit = MEMO_BACKS.find((b) => b.id === id);
  return hit?.css || "";
}

/**
 * 命中词标红。参考站的 replaceText 以命中点为锚取 30 字窗口后整体换 innerHTML：
 *   e = i - s < 30 ? e.substr(s - (30 - (i - s))) : e.substr(s)   （s=命中位置，i=文本长度）
 * 尾部命中会裁掉开头、开头命中会裁掉尾部。这里照同一套裁窗 + 标红。
 */
function highlight(text: string, word: string) {
  if (!word) return <>{text}</>;
  const s = text.search(word);
  if (s < 0) return <>{text}</>;
  const A = 30;
  const cut = text.length - s < A ? Math.max(0, s - (A - (text.length - s))) : s;
  const parts: React.ReactNode[] = [];
  let rest = text.slice(cut), k = 0;
  for (;;) {
    const i = rest.indexOf(word);
    if (i < 0) { parts.push(<span key={k++}>{rest}</span>); break; }
    if (i > 0) parts.push(<span key={k++}>{rest.slice(0, i)}</span>);
    parts.push(<span key={k++} className="hl">{word}</span>);
    rest = rest.slice(i + word.length);
  }
  return <>{parts}</>;
}

function MemoRow({ it, word, active, sortIsEdit, onOpen, onContext }: {
  it: MemoItem;
  word: string;
  active: boolean;
  sortIsEdit: boolean;
  onOpen: () => void;
  onContext: (e: React.MouseEvent) => void;
}) {
  const when = memoWhen(sortIsEdit ? it.memo.updatedAt : it.memo.createdAt);
  return (
    <div className={"body-memo-item my-cursor" + (active ? " is-active" : "")} onClick={onOpen} onContextMenu={onContext}
      role="button" aria-label={`备忘录：${it.memo.title || "无标题"}`}>
      {it.memo.title ? (
        <div className="item-title">{highlight(it.memo.title, word)}</div>
      ) : (
        <div className="item-title-none">无标题</div>
      )}
      <div className="item-info">
        <div className="item-content"><div>{highlight(it.preview, word)}</div></div>
        {it.memo.fileType !== MemoFile.None && (
          <span className="item-thumb"><I n={it.memo.fileType === 0 ? "image" : it.memo.fileType === 1 ? "video" : it.memo.fileType === 3 ? "audio" : "file"} size={13} /></span>
        )}
      </div>
      <div className="item-date">
        {when}
        {it.memo.isTop && <span className="icon-top"><I n="pin" size={11} /></span>}
      </div>
    </div>
  );
}

function Curtain({ onClose, children }: { onClose: () => void; children?: React.ReactNode }) {
  useEscClose(onClose);
  return <div className="curtain-grey" onMouseDown={onClose}>{children}</div>;
}

/** 工具条上的字体/字号入口。参考站的下拉按 offsetLeft/offsetTop 定位在工具条内，这里量 rect 等效。 */
function Pick({ kind, label, open, onToggle }: {
  kind: "font" | "size";
  label: string;
  open: boolean;
  onToggle: (p: "font" | "size", at: At) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={ref} className={"block-item tool-pick my-cursor" + (kind === "size" ? " is-size" : "") + (open ? " is-on" : "")}
      role="button" aria-label={kind === "size" ? "字号" : "字体"}
      onClick={() => {
        const r = ref.current?.getBoundingClientRect();
        if (!r) return;
        onToggle(kind, { x: r.x, y: r.bottom + 2, right: r.right });
      }}>
      <span className="pick-text">{label}</span><span className="icon-corner-mark" />
    </div>
  );
}

function FolderList({ folders, selected, onPick }: { folders: MemoFolder[]; selected: string; onPick: (id: string) => void }) {
  return (
    <ul className="items scrollbar">
      <li className={"item my-cursor" + (!selected ? " item-selected" : "")} onClick={() => onPick("")}>全部</li>
      {folders.map((f) => (
        <li key={f.id} className={"item my-cursor" + (selected === f.id ? " item-selected" : "")} onClick={() => onPick(f.id)}>{f.name}</li>
      ))}
    </ul>
  );
}

/**
 * 文件夹管理（参考站 FolderManage）：**居中卡片**，不是右侧抽屉。
 * 结构照参考站：标题「文件夹管理」+ 副题「（可拖动排序）」+ 关闭；
 * 每一行 = 一个带绿边框的「名字盒子」（点击改名）+ 右侧红色删除图标（点击删）；
 * 底部一整行「＋」（点击新建）。
 * 新建/改名/删除都走嵌套子弹窗（参考站 MemoSetFolder），不在列表里塞输入框。
 */
function FolderManager({ folders, onClose }: { folders: MemoFolder[]; onClose: () => void }) {
  const [rows, setRows] = useState<MemoFolder[]>(folders);
  const [sub, setSub] = useState<{ mode: 0 | 1 | 2; item: MemoFolder | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const dragID = useRef("");
  useEffect(() => setRows(folders), [folders]);
  useEscClose(onClose);

  const run = (f: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    f().then(() => bumpRevision()).catch(toastErr).finally(() => setBusy(false));
  };

  // 参考站是关闭面板时才把 DOM 顺序写回 folderSort（saveSortFolder），拖的过程中不发请求
  const close = () => {
    const ids = rows.map((x) => x.id);
    if (ids.join(",") !== folders.map((x) => x.id).join(",")) {
      void api.ReorderMemoFolders(ids).then(() => bumpRevision()).catch(toastErr);
    }
    onClose();
  };

  const onOk = (name: string) => {
    const mode = sub?.mode ?? 0;
    const item = sub?.item ?? null;
    setSub(null);
    if (mode === 0) run(() => api.SaveMemoFolder({ name, sort: rows.length }));
    else if (mode === 1 && item) run(() => api.SaveMemoFolder({ id: item.id, name }));
    else if (mode === 2 && item) run(() => api.DeleteMemoFolder(item.id));
  };

  return (
    <>
      <div className="folder-manage" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fm-head">
          <span className="text-title">文件夹管理</span>
          <span className="title-tip">（可拖动排序）</span>
          <button className="icon-close" aria-label="关闭" onClick={close}><I n="close" size={13} /></button>
        </div>
        <ul className="folder-items">
          {rows.map((f) => (
            <li key={f.id} className={"folder-item" + (dragID.current === f.id ? " is-moving" : "")} draggable
              onDragStart={() => { dragID.current = f.id; }}
              onDragEnter={(e) => {
                e.preventDefault();
                if (!dragID.current || dragID.current === f.id) return;
                setRows((rs) => {
                  const from = rs.findIndex((x) => x.id === dragID.current);
                  const to = rs.findIndex((x) => x.id === f.id);
                  if (from < 0 || to < 0) return rs;
                  const next = rs.slice();
                  const [moved] = next.splice(from, 1);
                  next.splice(to, 0, moved);
                  return next;
                });
              }}
              onDragOver={(e) => e.preventDefault()}
              onDragEnd={() => { dragID.current = ""; }}>
              <div className="folder-intro my-cursor" onClick={() => setSub({ mode: 1, item: f })}>{f.name}</div>
              <button className="icon-delete my-cursor" aria-label={`删除文件夹 ${f.name}`}
                onClick={() => setSub({ mode: 2, item: f })}><I n="trash" size={12} /></button>
            </li>
          ))}
        </ul>
        <div className="folder-add my-cursor" role="button" aria-label="新建文件夹"
          onClick={() => setSub({ mode: 0, item: null })}><I n="plus" size={13} /></div>
      </div>
      {sub && <SetFolderDialog mode={sub.mode} item={sub.item} onCancel={() => setSub(null)} onOk={onOk} />}
    </>
  );
}

/**
 * 文件夹管理的子弹窗（参考站 MemoSetFolder）：
 * mode 0=新建 / 1=重命名 → 一个输入框（maxlength 6、占位「请输入文件夹名称」）；
 * mode 2=删除 → 一句提示「删除后，该文件夹下的备忘录可在回收站查看」。
 * 底下是「取消 / 确定」。
 */
function SetFolderDialog({ mode, item, onCancel, onOk }: {
  mode: 0 | 1 | 2;
  item: MemoFolder | null;
  onCancel: () => void;
  onOk: (name: string) => void;
}) {
  const [name, setName] = useState(item?.name || "");
  const input = useAutoFocus<HTMLInputElement>();
  useEscClose(onCancel);
  const title = mode === 0 ? "新建文件夹" : mode === 1 ? "重命名文件夹" : "删除文件夹";
  const submit = () => {
    const v = name.trim();
    if (mode === 2) { onOk(""); return; }
    if (v) onOk(v);
  };
  return (
    <div className="fm-sub-mask" onMouseDown={onCancel}>
      <div className="fm-sub-body" onMouseDown={(e) => e.stopPropagation()}>
        <div className="fm-head">
          <span className="text-title">{title}</span>
          <button className="icon-close" aria-label="关闭" onClick={onCancel}><I n="close" size={13} /></button>
        </div>
        {mode < 2 ? (
          <label className="fm-field">
            <input ref={input} className="fm-input" maxLength={6} placeholder="请输入文件夹名称"
              aria-label="请输入文件夹名称" value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") onCancel();
              }} />
          </label>
        ) : (
          <p className="fm-tip">删除后，该文件夹下的备忘录可在回收站查看</p>
        )}
        <div className="fm-btns">
          <button className="cc-btn" onClick={onCancel}>取消</button>
          <button className="cc-btn is-primary" onClick={submit}>确定</button>
        </div>
      </div>
    </div>
  );
}

/** 回收站抽屉：右侧 35%，多选 + 全选 + 恢复 / 彻底删除（各带一次确认）。 */
function RecycleBin({ picked, setPicked, onClose, askConfirm }: {
  picked: string[];
  setPicked: (ids: string[]) => void;
  onClose: () => void;
  askConfirm: (kind: "restore" | "purge", ids: string[]) => void;
}) {
  const [rows, setRows] = useState<MemoItem[]>([]);
  const { revision } = useApp();
  useEscClose(onClose);
  useEffect(() => {
    let dead = false;
    api.MemoList({ showDeleted: true }).then((v) => !dead && setRows(v)).catch(toastErr);
    return () => { dead = true; };
  }, [revision]);

  const all = rows.map((r) => r.memo.id);
  const isAll = !!all.length && picked.length === all.length;
  const toggle = (id: string) =>
    setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);

  return (
    <>
      {/* 参考站的回收站遮罩本身不响应点击（与文件夹管理面板不同），只能点 × 或 Esc 关 */}
      <div className="curtain-grey is-bin" />
      <aside className="body-recycle-bin" aria-label="回收站">
        <div className="memo-recycle-bin">
          <button className="icon-close" aria-label="关闭回收站" onClick={onClose}><I n="close" size={13} /></button>
          <span className="text-title">回收站{rows.length ? " (" + rows.length + ")" : ""}</span>
        </div>
        <div className="memo-items">
          {rows.map((r) => (
            <div key={r.memo.id} className="memo-item">
              <button className={picked.includes(r.memo.id) ? "rb-item-selected" : "rb-item-select"}
                aria-label={`选择 ${r.memo.title || "无标题"}`} onClick={() => toggle(r.memo.id)} />
              {/* 点信息卡同样切换选中：参考站这里也绑了 setSelected */}
              <div className="memo-info my-cursor" onClick={() => toggle(r.memo.id)}>
                <div className={r.memo.title ? "text-memo-title" : "item-title-none"}>{r.memo.title || "无标题"}</div>
                <div className="text-memo-content">{r.preview}</div>
                <div className="text-memo-time">{memoDate(r.memo.createdAt)}</div>
              </div>
            </div>
          ))}
          {!rows.length && <div className="memo-none"><I n="inbox" size={30} /><span>暂无内容</span></div>}
        </div>
        {!!rows.length && <div className="memo-submit">
          <div className="check-box-all my-cursor" onClick={() => setPicked(isAll ? [] : all)}>
            <span className={isAll ? "icon-selected-all" : "icon-select-all"} />
            <span>{isAll ? "取消全选" : "全选"}</span>
          </div>
          <div className={"text-delete my-cursor" + (picked.length ? "" : " is-off")}
            onClick={() => picked.length && askConfirm("purge", picked)}>删除</div>
          <div className={"text-restore my-cursor" + (picked.length ? "" : " is-off")}
            onClick={() => picked.length && askConfirm("restore", picked)}>恢复</div>
        </div>}
      </aside>
    </>
  );
}

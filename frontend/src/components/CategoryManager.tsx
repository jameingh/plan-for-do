// CategoryManager.tsx —— 分类管理：改名/颜色/图标/排序/删除（删除时内核要求显式二选一）。
// 图标走规范第 6 节：内置 SVG 图标集或自定义单字，彩色底取分类自己的 color。

import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Category } from "../api/types";
import { bumpRevision, toast, toastErr } from "../store/appStore";
import { ChoiceModal, ColorPicker, FieldError, Glyph, I, IconPicker, Modal, iconKindOf, useAutoFocus } from "./ui";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)) || "未知错误";

export function CategoryManager({ onClose }: { onClose: () => void }) {
  const [cats, setCats] = useState<Category[]>([]);
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [iconFor, setIconFor] = useState<Category | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const newFocus = useAutoFocus<HTMLInputElement>();

  const reload = () => api.Categories().then(setCats).catch(toastErr);
  useEffect(() => {
    void reload();
  }, []);

  const setErr = (k: string, v: string) => setErrs((old) => ({ ...old, [k]: v }));

  async function save(patch: { id?: string; name: string; icon: string; color: string }) {
    setErr(patch.id ?? "__new", "");
    try {
      await api.SaveCategory(patch);
      if (!patch.id) setNameDraft("");
      void reload();
      bumpRevision();
    } catch (e) {
      setErr(patch.id ?? "__new", errText(e));
    }
  }

  async function move(i: number, dir: -1 | 1) {
    const next = [...cats];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    await persistOrder(next);
  }

  /** 拖拽与上下移动共用一条落库路径，避免两套排序逻辑漂移。 */
  async function persistOrder(next: Category[]) {
    setCats(next);
    try {
      await api.ReorderCategories(next.map((c) => c.id));
      bumpRevision();
    } catch (e) {
      toastErr(e);
      void reload();
    }
  }

  // 参考站的分类列表就是 HTML5 拖拽排序（dragstart/dragenter/dragover/dragend）。
  // 上移/下移按钮保留：只用拖拽排序对键盘和读屏用户是不可用的。
  const dragFrom = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  async function doDelete(c: Category, withItems: boolean) {
    setDeleting(null);
    try {
      const n = await api.DeleteCategory(c.id, withItems);
      toast(withItems ? `已删除分类与其下 ${n} 条事项` : `分类已删除，${n} 条事项归入未分类`);
      void reload();
      bumpRevision();
    } catch (e) {
      toastErr(e);
    }
  }

  return (
    <Modal title="分类管理" onClose={onClose} wide keepOnMask>
      <div className="cat-list">
        {cats.map((c, i) => (
          <div key={c.id} className={"cat-row" + (errs[c.id] ? " is-error" : "") + (dragOver === i ? " is-drop" : "")}
            draggable
            onDragStart={(e) => { dragFrom.current = i; if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"; }}
            onDragOver={(e) => { e.preventDefault(); if (dragFrom.current !== null && dragFrom.current !== i) setDragOver(i); }}
            onDragLeave={() => setDragOver((cur) => (cur === i ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragFrom.current;
              dragFrom.current = null;
              setDragOver(null);
              if (from === null || from === i) return;
              const next = [...cats];
              const [moved] = next.splice(from, 1);
              next.splice(i, 0, moved);
              void persistOrder(next);
            }}
            onDragEnd={() => { dragFrom.current = null; setDragOver(null); }}>
            <button className="icon-btn" title="换图标" aria-label={`换「${c.name}」的图标`} onClick={() => setIconFor(c)} style={{ width: "auto", padding: 0 }}>
              <Glyph kind={iconKindOf(c.icon)} glyph={c.icon} color={c.color || undefined} size={24} />
            </button>
            <input className="input" defaultValue={c.name} aria-label="分类名"
              onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && save({ id: c.id, name: e.target.value, icon: c.icon, color: c.color })} />
            <ColorPicker value={c.color} onChange={(col) => save({ id: c.id, name: c.name, icon: c.icon, color: col })} />
            <button className="icon-btn" title="上移" aria-label="上移" disabled={i === 0} onClick={() => move(i, -1)}><I n="arrowUp" size={14} /></button>
            <button className="icon-btn" title="下移" aria-label="下移" disabled={i === cats.length - 1} onClick={() => move(i, 1)}><I n="arrowDown" size={14} /></button>
            <button className="icon-btn danger" title="删除分类" aria-label={`删除分类 ${c.name}`} onClick={() => setDeleting(c)}><I n="trash" size={14} /></button>
            <FieldError text={errs[c.id]} />
          </div>
        ))}
      </div>

      <div className={"cat-row" + (errs.__new ? " is-error" : "")} style={{ marginTop: 12 }}>
        <input ref={newFocus} className="input" placeholder="新分类名，回车创建" value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && nameDraft.trim() && save({ name: nameDraft, icon: "", color: "" })} />
        <button className="btn primary" disabled={!nameDraft.trim()} onClick={() => save({ name: nameDraft, icon: "", color: "" })}>
          <I n="plus" size={14} />添加
        </button>
        <FieldError text={errs.__new} />
      </div>
      <p className="muted small">新分类默认用主色底，创建后点左侧方块换图标与颜色；图标可用内置图形或一个汉字。</p>

      {iconFor && (
        <Modal title={`「${iconFor.name}」的图标`} onClose={() => setIconFor(null)}>
          <IconPicker
            icon={{ kind: iconKindOf(iconFor.icon), ref: iconFor.icon, color: iconFor.color }}
            onChange={(kind, ref, color) => save({ id: iconFor.id, name: iconFor.name, icon: kind === "text" ? ref : ref || "list", color })}
          />
          <div className="btn-row">
            <button className="btn" onClick={() => setIconFor(null)}>完成</button>
          </div>
        </Modal>
      )}
      {deleting && (
        <ChoiceModal
          title={`删除分类「${deleting.name}」`}
          question="该分类下还有事项，请选择处理方式："
          choices={[
            { label: "删除分类并清空分类下事项", value: true, danger: true },
            { label: "保留事项，归入未分类", value: false },
          ]}
          onPick={(v) => doDelete(deleting, v)}
          onClose={() => setDeleting(null)}
        />
      )}
    </Modal>
  );
}

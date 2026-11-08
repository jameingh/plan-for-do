// MemoEditor.tsx —— 备忘录的富文本编辑器内核壳。
//
// 参考站的正文区是一个 iframe：`iframe.edit-iframe` 里 `<div id="editor" contenteditable="true">`，
// 外加它自己的 Editor.js / EditorEvent.js / EditorMessage.js，Vue 侧用 postMessage 发命令、
// iframe 回发 fontStyle（光标处的字号/颜色/加粗态）与 openFile（点了正文里的附件卡片）。
// 这里照同一套结构，只把跨文档的 postMessage 换成同进程的 ref 调用——少一层协议，行为不变。
//
// 用 iframe 而不是主文档里的 contenteditable，是为了拿到它只有独立文档才有的两点：
// 正文区自己的滚动条（绿色渐变 thumb）与可整幅铺在文字底下的背景图（iframe 背景透明）。
//
// 与参考站的差异（逐条记在 docs/design-reference.md §22）：
//   · 它的 6 个字体里 4 个是自家 CDN 上的 ttf（kaiTi/shouZha/waWa/yaPi），字体有授权、
//     也不能离线，这里退到系统里最接近的中文字体栈；
//   · 它的正文 HTML 单独传 OSS（noteHtmlDataUrl 指向一个 .txt），我们进记录才能跟着同步；
//   · 它的背景图是 14 张 CDN 上的 webp，我们没有这些素材，改成同数量、同交互的本机渐变底。
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";

/** 工具条字体下拉的六项。code 与参考站 FontFamily.words 一一对应，stack 是我方回退。 */
export const MEMO_FONTS: { code: string; name: string; stack: string }[] = [
  { code: "SimSun", name: "默认字体", stack: '"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif' },
  { code: "fangSong", name: "仿宋字体", stack: '"FangSong","STFangsong",serif' },
  { code: "kaiTi", name: "楷体", stack: '"KaiTi","STKaiti","Kaiti SC",serif' },
  { code: "shouZha", name: "手札体", stack: '"KaiTi","STKaiti",cursive' },
  { code: "waWa", name: "娃娃体", stack: '"YouYuan","幼圆","KaiTi",cursive' },
  { code: "yaPi", name: "雅痞", stack: '"STXingkai","华文行楷","KaiTi",cursive' },
];

/** 字号：参考站就是这七档（Editor.js:22 的 fonts 数组）。 */
export const MEMO_SIZES = [10, 13, 16, 18, 24, 32, 48];

/** execCommand 的 fontSize 只认 1..7，按索引换算。 */
export const sizeToExec = (px: number): number => Math.min(7, Math.max(1, MEMO_SIZES.indexOf(px) + 1));
export const execToSize = (n: number): number => MEMO_SIZES[Math.min(6, Math.max(0, n - 1))];

/** 取色板：参考站的取色器是一格一格的固定色。 */
export const MEMO_COLORS = [
  "#333333", "#999999", "#ffffff", "#e13e39", "#ff9e00", "#f4c012",
  "#03a17e", "#0042ff", "#bfa2db", "#000000",
];

/** 光标处的样式回显（参考站 iframe 回发的 fontStyle 对象）。 */
export type MemoStyle = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  family: string;
  size: number;
  color: string;
  bg: string;
  undo: boolean;
  redo: boolean;
};

export const baseStyle = (): MemoStyle => ({
  bold: false, italic: false, underline: false, strike: false,
  family: MEMO_FONTS[0].code, size: 16, color: "#333333", bg: "transparent", undo: false, redo: false,
});

export type MemoEditorHandle = {
  exec: (cmd: string, val?: string) => void;
  focus: () => void;
  html: () => string;
  insertHTML: (frag: string) => void;
};

const SHELL = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;height:100%}
#editor{width:100%;min-height:100%;box-sizing:border-box;padding:0;margin:0;outline:none;
  font-size:16px;color:#333;line-height:1.7;word-break:break-word;background:transparent;
  font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif}
#editor::-webkit-scrollbar{width:10px}
#editor::-webkit-scrollbar-thumb{border-radius:50px;
  background-image:linear-gradient(to right,rgba(3,161,126,.5),rgb(3,161,126))}
#editor img{max-width:100%}
#editor ul,#editor ol{padding-left:1.6em}
#editor a{color:#03a17e}
#editor input[type=checkbox]{margin:0 .4em 0 0;transform:translateY(1px)}
.enclosure-fileBox{max-width:300px;display:flex;align-items:center;gap:6px;
  border:1px solid #eee;border-radius:6px;padding:6px 10px;margin:6px 0;
  background:#fafafa;font-size:13px;color:#333;cursor:pointer}
.enclosure-name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.enclosure-size{color:#999;font-size:12px}
</style></head><body><div id="editor" contenteditable="true" spellcheck="false"></div></body></html>`;

export const MemoEditor = forwardRef<MemoEditorHandle, {
  value: string;
  backImage: string;
  onChange: (html: string) => void;
  onStyle?: (s: MemoStyle) => void;
  onOpenFile?: (fileId: string) => void;
  onReady?: () => void;
}>(function MemoEditor({ value, backImage, onChange, onStyle, onOpenFile, onReady }, ref) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const doc = useRef<Document | null>(null);
  const ed = useRef<HTMLElement | null>(null);
  const ready = useRef(false);
  const last = useRef("");

  const readStyle = useCallback(() => {
    const d = doc.current, e = ed.current;
    if (!d || !e) return;
    const sel = d.getSelection();
    const node = sel && sel.anchorNode
      ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode as HTMLElement : sel.anchorNode.parentElement)
      : e;
    const cs = node ? (d as Document).defaultView?.getComputedStyle(node) : undefined;
    const fam = (cs?.fontFamily || "").toLowerCase();
    const code = MEMO_FONTS.find((f) => fam.includes(f.stack.split(",")[0].replace(/"/g, "").toLowerCase()))?.code
      || (fam.includes("fangsong") ? "fangSong" : fam.includes("kai") ? "kaiTi"
        : fam.includes("youyuan") ? "waWa" : fam.includes("xingkai") ? "yaPi" : "SimSun");
    onStyle?.({
      bold: d.queryCommandState("bold"),
      italic: d.queryCommandState("italic"),
      underline: d.queryCommandState("underline"),
      strike: d.queryCommandState("strikeThrough"),
      family: code,
      size: parseInt(cs?.fontSize || "16", 10) || 16,
      color: cs?.color || "#333333",
      bg: cs?.backgroundColor || "transparent",
      undo: d.queryCommandSupported("undo"),
      redo: d.queryCommandSupported("redo"),
    });
  }, [onStyle]);

  const push = useCallback(() => {
    if (!ed.current) return;
    const h = ed.current.innerHTML;
    if (h !== last.current) { last.current = h; onChange(h); }
  }, [onChange]);

  useImperativeHandle(ref, () => ({
    exec: (cmd, val) => {
      const d = doc.current, e = ed.current;
      if (!d || !e) return;
      e.focus();
      d.execCommand(cmd, false, val);
      push();
      readStyle();
    },
    focus: () => ed.current?.focus(),
    html: () => ed.current?.innerHTML ?? "",
    insertHTML: (frag) => {
      const d = doc.current, e = ed.current;
      if (!d || !e) return;
      e.focus();
      d.execCommand("insertHTML", false, frag);
      push();
    },
  }), [push, readStyle]);

  useEffect(() => {
    const f = frame.current;
    if (!f) return;
    const onLoad = () => {
      const d = f.contentDocument;
      if (!d) return;
      const e = d.getElementById("editor");
      if (!e) return;
      doc.current = d;
      ed.current = e;
      e.innerHTML = value || "";
      last.current = e.innerHTML;
      e.addEventListener("input", () => { push(); readStyle(); });
      // 参考站在 click / 方向键 / 光标移动时回发 fontStyle，这里同一套触发点
      e.addEventListener("click", readStyle);
      e.addEventListener("keyup", readStyle);
      d.addEventListener("selectionchange", readStyle);
      // 正文里的附件卡片/图片点击 → 交给上层决定预览还是下载（参考站的 openFile）
      e.addEventListener("click", (ev) => {
        const t = (ev.target as HTMLElement)?.closest?.("[data-file-id]");
        if (t) onOpenFile?.(t.getAttribute("data-file-id") || "");
      });
      ready.current = true;
      onReady?.();
    };
    f.addEventListener("load", onLoad);
    return () => f.removeEventListener("load", onLoad);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换备忘录：整体重写正文。iframe 里没有虚拟 DOM，不能靠 diff。
  useEffect(() => {
    if (!ready.current || !ed.current) return;
    if (ed.current.innerHTML !== value) {
      ed.current.innerHTML = value || "";
      last.current = ed.current.innerHTML;
    }
  }, [value]);

  return (
    <div className="edit-iframe" style={backImage ? { backgroundImage: `url(${backImage})` } : undefined}>
      <iframe ref={frame} className="edit-iframe" title="备忘录正文" srcDoc={SHELL} />
    </div>
  );
});

// ui.tsx —— 无第三方框架的基础件：图标体系、模态框（带 Esc 栈）、分段控件、空状态、错误行、调色板。
//
// 图标规范（docs/design-reference.md 第 6 节）：统一 16px 线性、描边 1.5px、currentColor；
// 分类/习惯的彩色底是 24px 圆角方块（--r-ctl），底色取该分类自己的 color，图形用白色。
// 全站不使用 emoji 当图标。

import { useEffect, useRef, useState, type ReactNode } from "react";

// —— 功能图标：16×16 viewBox，stroke-width 1.5 ——
export const ICON_PATHS: Record<string, string[]> = {
  chevronDown: ["M4 6.2 8 10 12 6.2"],
  chevronRight: ["M6.2 4 10 8 6.2 12"],
  chevronLeft: ["M9.8 4 6 8 9.8 12"],
  chevronUp: ["M4 9.8 8 6 12 9.8"],
  close: ["M4.4 4.4 11.6 11.6", "M11.6 4.4 4.4 11.6"],
  check: ["M3.4 8.4 6.4 11.4 12.6 4.6"],
  plus: ["M8 3.4 8 12.6", "M3.4 8 12.6 8"],
  minus: ["M3.6 8 12.4 8"],
  dots: ["M8 3.9v.01", "M8 8v.01", "M8 12.1v.01"],
  pencil: ["M10.6 3.4 12.6 5.4 5.8 12.2 3.2 12.8 3.8 10.2z", "M9 5 11 7"],
  trash: ["M3.4 5.4 12.6 5.4", "M6 5.4 6 3.6 10 3.6 10 5.4", "M4.8 5.4 5.3 12.7 10.7 12.7 11.2 5.4", "M7.2 7.8 7.2 10.4", "M8.8 7.8 8.8 10.4"],
  arrowUp: ["M8 12.6 8 3.4", "M4.6 6.8 8 3.4 11.4 6.8"],
  arrowDown: ["M8 3.4 8 12.6", "M4.6 9.2 8 12.6 11.4 9.2"],
  postpone: ["M3.2 8 11.6 8", "M8.4 4.6 11.8 8 8.4 11.4"],
  bell: ["M8 3.2c-2.1 0-3.5 1.7-3.5 3.9 0 2.1-1 3.3-1.5 4h10c-.5-.7-1.5-1.9-1.5-4 0-2.2-1.4-3.9-3.5-3.9z", "M6.5 11.1c.1.9.6 1.6 1.5 1.6s1.4-.7 1.5-1.6"],
  repeat: ["M3.6 8a4.4 4.4 0 0 1 7.6-3", "M11.6 3v2.4H9.2", "M12.4 8a4.4 4.4 0 0 1-7.6 3", "M4.4 13v-2.4h2.4"],
  calendar: ["M3.4 5.2h9.2v7.4H3.4z", "M3.4 7.8h9.2", "M6 3.6v2.4", "M10 3.6v2.4"],
  clock: ["M8 3.8a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4z", "M8 6v2.3l1.6 1"],
  tag: ["M3.4 3.4h4.6l5.6 5.6-4.6 4.6-5.6-5.6z", "M5.8 5.8v.01"],
  search: ["M10.4 10.4 13 13", "M7.2 3.6a3.6 3.6 0 1 1 0 7.2 3.6 3.6 0 0 1 0-7.2z"],
  list: ["M3.6 5h8.8", "M3.6 8h8.8", "M3.6 11h5.6"],
  target: ["M8 3.4a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2z", "M8 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4z", "M8 7.4v.01"],
  sun: ["M8 5.4a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z", "M8 2.4v1.4", "M8 12.2v1.4", "M2.4 8h1.4", "M12.2 8h1.4", "M4 4l1 1", "M11 11l1 1", "M12 4l-1 1", "M5 11l-1 1"],
  moon: ["M10.6 9.8A4.6 4.6 0 1 1 6.2 3.4a3.8 3.8 0 0 0 4.4 6.4z"],
  inbox: ["M3.2 8.4 5 4.2h6l1.8 4.2v3.6H3.2z", "M3.2 8.4h3l.6 1.4h2.4l.6-1.4h3"],
  note: ["M4 3.6h8v8.8H4z", "M6 6.4h4", "M6 8.8h4"],
  folder: ["M3.4 5.4h3.2l1 1.4h5v5.8h-9.2z"],
  alert: ["M8 2.9 14 13.1H2z", "M8 6.6v3", "M8 11v.01"],
  // 齿轮：一整圈带 8 个齿的轮廓 + 中心孔。早先这里画的是「圆 + 8 根放射短线」，
  // 那是太阳的形状，用户一眼就看出来了（2026-11-07）。齿必须和圆环连成一条闭合轮廓才像齿轮。
  gear: [
    "M14.14 6.58 L14.14 9.42 L12.54 9.39 L12.19 10.23 L13.34 11.34 L11.34 13.34 L10.23 12.19 L9.39 12.54 L9.42 14.14 L6.58 14.14 L6.61 12.54 L5.77 12.19 L4.66 13.34 L2.66 11.34 L3.81 10.23 L3.46 9.39 L1.86 9.42 L1.86 6.58 L3.46 6.61 L3.81 5.77 L2.66 4.66 L4.66 2.66 L5.77 3.81 L6.61 3.46 L6.58 1.86 L9.42 1.86 L9.39 3.46 L10.23 3.81 L11.34 2.66 L13.34 4.66 L12.19 5.77 L12.54 6.61 Z",
    "M8.00 5.85 a2.15 2.15 0 1 0 0.01 0",
  ],
  filter: ["M2.8 4h10.4l-4 4.8V12l-2.4-1.6V8.8z"],
  checkSquare: ["M3.4 4.6h9.2v8H3.4z", "M5.6 8 7.2 9.6 10.6 6"],
  // 图钉：置顶用。针头在上、针尖在下，和 arrowUp 区分开，避免看成「上移」。
  pin: ["M6.2 3.4h3.6l-.5 3 2.3 2.1h-7.2l2.3-2.1z", "M8 8.5v4.1"],
  // 电源符号：参考站「结束」行用的就是它（重复序列的终止）。
  power: ["M8 3.2v4.6", "M5.2 4.6a3.9 3.9 0 1 0 5.6 0"],
  // —— 备忘录工具条（参考站 .icon-item 那一排；B/I/U/S 用字形而不是图标，它自己也是这么显示的）——
  undo: ["M4.6 6.8h5.2a3 3 0 1 1 0 6H7.4", "M6.9 4.3 4.4 6.8 6.9 9.3"],
  redo: ["M11.4 6.8H6.2a3 3 0 1 0 0 6h2.4", "M9.1 4.3 11.6 6.8 9.1 9.3"],
  checkList: ["M3.4 4.4h2.2v2.2H3.4z", "M6.8 5.5h5.6", "M6.8 10.5h5.6", "M3.4 10.5h2.2"],
  orderList: ["M7 4.6h5.4", "M7 8h5.4", "M7 11.4h5.4", "M3.2 3.8h.9v2.4", "M3 9.6h1.2v.9H3v.9h1.4"],
  unorderedList: ["M3.6 4.6v.01", "M3.6 8v.01", "M3.6 11.4v.01", "M6.6 4.6h5.8", "M6.6 8h5.8", "M6.6 11.4h5.8"],
  alignLeft: ["M3.2 4h9.6", "M3.2 8h6", "M3.2 12h8"],
  alignCenter: ["M3.2 4h9.6", "M5 8h6", "M4 12h8"],
  alignRight: ["M3.2 4h9.6", "M6.8 8h6", "M4.8 12h8"],
  indent: ["M6.4 4h6.4", "M6.4 8h6.4", "M3.2 12h9.6", "M3.4 5.4 5.6 7 3.4 8.6"],
  outdent: ["M6.4 4h6.4", "M6.4 8h6.4", "M3.2 12h9.6", "M5.6 5.4 3.4 7 5.6 8.6"],
  bgImage: ["M3.2 4.4h9.6v7.2H3.2z", "M4.6 10 6.6 7.6 8.4 9.4l1.6-1.8 1.6 2.4"],
  image: ["M3.2 4.4h9.6v7.2H3.2z", "M5.6 7.2v.01", "M3.4 10.4 6.4 7.4l3 3 1.4-1.4 2 2"],
  video: ["M3.2 4.8h7.6v6.4H3.2z", "M10.8 7.6 13 6v4l-2.2 1.6z"],
  file: ["M4.4 3.2h4.4l2.8 2.8v6.8H4.4z", "M8.8 3.2V6h2.8"],
  audio: ["M6 10.6V4.6l4.6-1v6", "M6 10.6a1.6 1.6 1.6 0 1 1.6-1.6", "M10.6 9.6a1.6 1.6 1.6 0 1 1.6-1.6"],
  marker: ["M4 11.4 9.4 6l1.4 1.4L5.4 12.8H4z", "M9.4 6 11 4.4a1 1 0 0 1 1.4 0l.4.4a1 1 0 0 1 0 1.4L11.2 8", "M3.2 13.4h4"],
  // 头像菜单两项用的图标：参考站是 20px 位图（个人中心=人形、退出登录=出门箭头），这里同形描线。
  user: ["M8 3.1a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6z", "M3.6 13.2c.5-2.3 2.3-3.6 4.4-3.6s3.9 1.3 4.4 3.6"],
  logout: ["M6.6 3.4H4.4v9.2h2.2", "M9.4 5.6 12 8l-2.6 2.4", "M7.6 8H12"],
};

// —— 内置图标集（分类/习惯用），沿用参考站的分组习惯 ——
export const BUILTIN_ICONS: { name: string; label: string; group: string; paths: string[] }[] = [
  { name: "list", label: "清单", group: "常用", paths: ICON_PATHS.list },
  { name: "star", label: "星标", group: "常用", paths: ["M8 3 9.6 6.2 13 6.7 10.5 9.2 11.1 12.6 8 11 4.9 12.6 5.5 9.2 3 6.7 6.4 6.2z"] },
  { name: "idea", label: "灵感", group: "常用", paths: ["M8 3.2a3.5 3.5 0 0 1 2 6.4c.4.4.6 1 .6 1.5h-5.2c0-.5.2-1.1.6-1.5a3.5 3.5 0 0 1 2-6.4z", "M6.6 12.8h2.8"] },
  { name: "heart", label: "重要的人", group: "常用", paths: ["M8 12.6 3.9 8.5a2.7 2.7 0 0 1 3.8-3.8l.3.3.3-.3a2.7 2.7 0 0 1 3.8 3.8z"] },
  { name: "music", label: "音乐", group: "常用", paths: ["M6.6 11.2V4.6l5.8-1.2v6.6", "M6.6 11.2a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0z", "M12.4 10a1.8 1.8 0 1 1-3.6 0 1.8 1.8 0 0 1 3.6 0z"] },
  { name: "sleep", label: "睡眠", group: "常用", paths: ICON_PATHS.moon },
  { name: "early", label: "早起", group: "常用", paths: ["M8 3.2v1.6", "M4.4 6.2l1.1 1.1", "M11.6 6.2l-1.1 1.1", "M2.8 11.4h10.4", "M5.4 11.4a2.6 2.6 0 0 1 5.2 0"] },
  { name: "money", label: "记账", group: "常用", paths: ["M8 3.4 11.8 5.2 8 7 4.2 5.2z", "M4.2 8.8 8 10.6l3.8-1.8", "M4.2 5.2v3.6", "M11.8 5.2v3.6"] },
  { name: "run", label: "跑步", group: "健身", paths: ["M9.6 3.6a1 1 0 1 1-2 0 1 1 0 0 1 2 0z", "M5 12.8 6.8 9.6 5.2 8.4l1.6-3 2.4.6 1.4 1.6 1.8.4", "M6.8 9.6 9.4 10.6 10 13"] },
  { name: "workout", label: "力量", group: "健身", paths: ["M3.4 6.4v3.2", "M5.2 5.2v5.6", "M10.8 5.2v5.6", "M12.6 6.4v3.2", "M5.2 8h5.6"] },
  { name: "walk", label: "步行", group: "健身", paths: ["M8.6 3.8a.9 .9 0 1 1-1.8 0 .9 .9 0 0 1 1.8 0z", "M8 5.4 6.4 8.2 7 12.8", "M8 5.4 9.6 8.2 9 12.8", "M6 6.8l2 .8 2-.8"] },
  { name: "meditate", label: "冥想", group: "健身", paths: ["M8 3.8a1.7 1.7 0 1 1 0 3.4A1.7 1.7 0 0 1 8 3.8z", "M3.8 12.4c1-2.2 2.5-3.2 4.2-3.2s3.2 1 4.2 3.2", "M2.6 10.2 4.6 9", "M13.4 10.2 11.4 9"] },
  { name: "beauty", label: "护肤", group: "美妆", paths: ["M6 12.6V7.2h4v5.4z", "M6.4 7.2 7 3.4h2l.6 3.8", "M6 9.6h4"] },
  { name: "food", label: "饮食", group: "美食", paths: ["M8 6.4a3.6 3.6 0 1 1 0 6 3.6 3.6 0 0 1 0-6z", "M8 6.4V4.2", "M8 4.8c1 0 1.9-.7 2.1-1.8-1.1.1-1.9.8-2.1 1.8z"] },
  { name: "water", label: "喝水", group: "美食", paths: ["M8 3.2c2.2 2.7 3.4 4.5 3.4 6a3.4 3.4 0 0 1-6.8 0c0-1.5 1.2-3.3 3.4-6z"] },
  { name: "nuts", label: "加餐", group: "坚果", paths: ["M8 3.4a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4z", "M8 7.8a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z"] },
  { name: "travel", label: "出行", group: "旅行", paths: ["M2.8 9.6 13.2 3.6 9.4 13.4 7.8 10z", "M7.8 10 10.4 7.6"] },
  { name: "book", label: "读书", group: "学习", paths: ["M8 5.6 3.8 4.4v7.8L8 11", "M8 5.6l4.2-1.2v7.8L8 11", "M8 5.6V11"] },
  { name: "study", label: "课程", group: "学习", paths: ["M2.4 6.4 8 4.2l5.6 2.2L8 8.6z", "M5 7.6v2.6c0 .8 1.3 1.4 3 1.4s3-.6 3-1.4V7.6"] },
  { name: "code", label: "编码", group: "学习", paths: ["M6 5.2 3.2 8 6 10.8", "M10 5.2 12.8 8 10 10.8", "M8.9 4 7.1 12"] },
  { name: "write", label: "写作", group: "学习", paths: ICON_PATHS.pencil },
];

const ICON_MAP = new Map(BUILTIN_ICONS.map((i) => [i.name, i]));

/** 分类的 icon 字段既可能是内置名也可能是单个汉字，渲染前先判断走哪条路径。 */
export function iconKindOf(icon: string): "image" | "text" {
  return ICON_MAP.has(icon) ? "image" : "text";
}

/** 16px 线性功能图标，颜色跟随 currentColor。 */
export function I({ n, size, className, title }: { n: string; size?: number; className?: string; title?: string }) {
  const paths = ICON_PATHS[n] ?? ICON_PATHS.dots;
  return (
    <svg className={"icon" + (className ? " " + className : "")} width={size ?? 16} height={size ?? 16} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/** 分类/习惯图标：圆角方块底（习惯卡用 round 出 44px 圆形底）+ 该条目自己的颜色；
 *  内置名走 SVG，kind=text 走单个汉字，图形一律白色。
 *  注意 prop 不能叫 ref——函数组件上的 ref 会被 React 当回调 ref 拦截。 */
export function Glyph({ kind, glyph, color, size = 24, round }: { kind: string; glyph: string; color?: string; size?: number; round?: boolean }) {
  const style = { background: color || "var(--brand)", width: size, height: size };
  const px = Math.round(size * 0.62);
  if (kind === "text" && glyph.trim()) return <span className={"glyph" + (round ? " is-round" : "")} style={style}>{[...glyph.trim()][0]}</span>;
  const hit = ICON_MAP.get(glyph);
  const paths = hit ? hit.paths : ["M5 3.2h6v9.6L8 10.2 5 12.8z"];
  return (
    <span className={"glyph" + (round ? " is-round" : "")} style={style}>
      <svg width={px} height={px} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {paths.map((d, i) => <path key={i} d={d} />)}
      </svg>
    </span>
  );
}

/** 小圆点：清单本/标签这类没有图形语义的条目用。 */
export function Dot({ color, size = 8 }: { color?: string; size?: number }) {
  return <span className="dot" style={{ background: color || "var(--text-3)", width: size, height: size }} aria-hidden />;
}

/** 分类图标（着色版，§9.5 详情头用）：图标与文字都跟随 currentColor（= 分类色），不加彩色方底。
 *  内置名走 SVG 描边，单字走文字。 */
export function TintedGlyph({ icon, size = 14 }: { icon: string; size?: number }) {
  if (iconKindOf(icon) === "text" && icon.trim()) {
    return <span style={{ color: "inherit", fontSize: size, fontWeight: 700, lineHeight: 1 }}>{[...icon.trim()][0]}</span>;
  }
  const hit = ICON_MAP.get(icon);
  const paths = hit ? hit.paths : ICON_PATHS.folder;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/** 行内 14px 的分类彩色小方块：内置名走 SVG，单字走文字。 */
export function MiniGlyph({ icon, color, text }: { icon: string; color?: string; text?: string }) {
  const style = { background: color || "var(--brand)" };
  if (iconKindOf(icon) === "image") {
    const hit = ICON_MAP.get(icon);
    return (
      <span className="mini-glyph" style={style} aria-hidden>
        <svg width={10} height={10} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          {(hit?.paths ?? []).map((d, i) => <path key={i} d={d} />)}
        </svg>
      </span>
    );
  }
  return <span className="mini-glyph" style={style} aria-hidden>{[...(icon || text || "类")][0]}</span>;
}

// —— 调色板：分类/习惯自己的颜色（是数据，不是设计 token）——
export const PALETTE = ["#03a17e", "#fc6a7a", "#f2a33b", "#4b8bf4", "#8a6cf0", "#22b8cf", "#e85d9a", "#5c6672", "#8d6e3a", "#2f5fd0"];

// —— Esc 栈：模态框按打开顺序压栈，Esc 只关最上层 ——
const escStack: (() => void)[] = [];
let escBound = false;
function bindEsc() {
  if (escBound) return;
  escBound = true;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && escStack.length) {
      e.stopPropagation();
      escStack[escStack.length - 1]();
    }
  });
}

/** 任何浮层都用它注册 Esc，顺序即层级（参考站的弹窗就是 Esc 关最上层）。 */
export function useEscClose(onClose: () => void) {
  useEffect(() => {
    bindEsc();
    escStack.push(onClose);
    return () => {
      const i = escStack.lastIndexOf(onClose);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, [onClose]);
}

/**
 * 通用模态框。`keepOnMask` 给「里面有正在输入的表单」的对话框用：
 * 点灰底就关掉，等于把用户敲了一半的凭据/名称清空，参考站的表单类弹窗也是不关的。
 * 纯确认类（删除、选图标）保持点灰底可关，那是快捷取消，不会丢东西。
 */
export function Modal({ title, onClose, children, wide, keepOnMask }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; keepOnMask?: boolean }) {
  useEscClose(onClose);
  return (
    <div className="modal-mask" onMouseDown={(e) => !keepOnMask && e.target === e.currentTarget && onClose()}>
      <div className={"modal" + (wide ? " modal-wide" : "")} role="dialog" aria-label={title}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}><I n="close" /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** 当前是否有模态框打开（App 的 Esc 关详情要先问它）。 */
export function modalOpen(): boolean {
  return escStack.length > 0;
}

/** 自动聚焦输入框的小 hook。 */
export function useAutoFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);
  return ref;
}

export function Segmented<T extends string>({ value, options, onChange, disabled, ariaLabel }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean; ariaLabel?: string }) {
  return (
    <div className={"segmented" + (disabled ? " is-disabled" : "")} role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} disabled={disabled} className={value === o.value ? "seg is-active" : "seg"} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 通用多选确认弹窗（内核要求显式选择语义的场景：删除分类/清单本）。 */
export function ChoiceModal({ title, question, choices, onPick, onClose }: { title: string; question: string; choices: { label: string; value: boolean; danger?: boolean }[]; onPick: (v: boolean) => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted">{question}</p>
      <div className="btn-row">
        {choices.map((c) => (
          <button key={c.label} className={c.danger ? "btn danger" : "btn"} onClick={() => onPick(c.value)}>
            {c.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** 空状态（规范 4.6）：一句话 + 一个动作，居中，--text-3，12px。无插画无 emoji。 */
export function Empty({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return (
    <div className="empty">
      <p>{text}</p>
      {action && onAction && <button className="btn small" onClick={onAction}>{action}</button>}
    </div>
  );
}

/** 错误贴在触发控件下方（规范 4.7）；只有全局错误才走底部 toast。 */
export function FieldError({ text }: { text?: string }) {
  if (!text) return null;
  return <div className="field-error" role="alert">{text}</div>;
}

/** 颜色选择：小圆点，选中用主色描边。 */
export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <span className="color-row" role="radiogroup" aria-label="颜色">
      {PALETTE.map((c) => (
        <button key={c} role="radio" aria-checked={c === value} aria-label={`颜色 ${c}`} className={c === value ? "swatch is-active" : "swatch"} style={{ background: c }} onClick={() => onChange(c)} />
      ))}
    </span>
  );
}

/** 图标选择：内置 SVG 图标（按类分组）+ 「文」单字。 */
export function IconPicker({ icon, onChange }: { icon: { kind: string; ref: string; color: string }; onChange: (kind: "image" | "text", ref: string, color: string) => void }) {
  const [mode, setMode] = useState<"image" | "text">(icon.kind === "text" ? "text" : "image");
  const groups = [...new Set(BUILTIN_ICONS.map((i) => i.group))];
  return (
    <div className="icon-picker">
      <Segmented value={mode} options={[{ value: "image", label: "内置图标" }, { value: "text", label: "文（单字）" }]}
        onChange={(m) => { setMode(m); if (m !== icon.kind) onChange(m, m === "text" ? "" : "list", icon.color); }} />
      {mode === "image" ? (
        <div className="icon-groups">
          {groups.map((g) => (
            <div key={g} className="icon-group">
              <span className="icon-group-title">{g}</span>
              <div className="icon-grid">
                {BUILTIN_ICONS.filter((i) => i.group === g).map((i) => {
                  const on = icon.kind === "image" && icon.ref === i.name;
                  return (
                    <button key={i.name} title={i.label} aria-label={i.label} aria-pressed={on} className={on ? "icon-cell is-active" : "icon-cell"} onClick={() => onChange("image", i.name, icon.color)}>
                      <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        {i.paths.map((d, k) => <path key={k} d={d} />)}
                      </svg>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <input className="input" maxLength={2} placeholder="输入一个汉字" value={icon.ref} onChange={(e) => onChange("text", [...e.target.value].slice(0, 1).join(""), icon.color)} />
      )}
      <ColorPicker value={icon.color} onChange={(c) => onChange(mode, icon.ref, c)} />
    </div>
  );
}

/**
 * 打卡勾选框（§9.2 / §10.6）：11×11 实心橙色方块 #ff9e00，无圆角；
 * 完成态 = 灰底 + 白勾（勾用 stroke-dashoffset 120ms 描出来）。
 * 这是整个产品最重要的一个控件，取代此前「描边圆角方形」的旧版。
 */
export type ClockState = "off" | "on" | "fail";

/**
 * 打卡框。三态来自参考站勾选框的右键菜单：成功打卡 / 失败打卡 / 取消打卡。
 * 未勾选是空心（用户 2026-11-06 明确要求，覆盖参考站的实心橙色读数）；
 * 成功灰底白勾，失败同样灰底但换成叉——失败是「这一天结清了」，不是「没做」的另一种写法。
 */
export function ClockBox({ state = "off", onToggle, onContextMenu, label, size = 11 }: {
  state?: ClockState;
  onToggle: () => void;
  /** 勾选框自己的右键菜单（打卡三态）；不传就冒泡给所在行的菜单 */
  onContextMenu?: (e: React.MouseEvent) => void;
  label: string;
  size?: number;
}) {
  const s = state;
  return (
    <button type="button" className={"clock" + (s === "on" ? " is-on" : s === "fail" ? " is-fail" : "")} style={{ width: size, height: size }}
      role="checkbox" aria-checked={s === "fail" ? "mixed" : s === "on"} aria-label={label}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      onContextMenu={(e) => { if (!onContextMenu) return; e.preventDefault(); e.stopPropagation(); onContextMenu(e); }}>
      <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden>
        {s === "fail"
          ? <path className="clock-tick" d="M5.4 5.4 14.6 14.6 M14.6 5.4 5.4 14.6" />
          : <path className="clock-tick" d="M4.6 10.4 8.4 14 15.4 6.4" />}
      </svg>
    </button>
  );
}

export type MenuItem = { label: string; danger?: boolean; onSelect: () => void };

/**
 * 右键菜单：参考站的一等交互（卡片=置顶/编辑/删除，勾选框=成功/失败/取消打卡）。
 * 行为照抄它：透明遮罩铺满、点任意处或 Esc 关闭、菜单落在鼠标点、贴边时翻转。
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = x + r.width > window.innerWidth - 8 ? Math.max(8, x - r.width) : x;
    const top = y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y;
    setPos({ left, top });
  }, [x, y, items.length]);

  useEscClose(onClose);

  return (
    <div className="ctx-curtain" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.stopPropagation()}>
        {items.map((it, i) => (
          <button key={i} type="button" role="menuitem" className={"ctx-item" + (it.danger ? " is-danger" : "")}
            onClick={() => { onClose(); it.onSelect(); }}>
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

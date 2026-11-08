// ViewCustomize.tsx —— 视图页右上「自定义视图」与「设置」两个入口的弹层。
//
// 取证结论（docs §21.3、tmp/ref/evidence-custom-view.md）：参考站的「自定义视图」**不是**一个
// 可以新建/命名/删除的视图对象，而是两份全局单例配置——
//   内容：清单侧隐藏哪些分类（含「无分类」哨兵）、习惯侧隐藏哪些情境，存的是**反向选择**；
//   颜色：清单 4 个模式（按清单详情设置 / 按分类 / 按优先级 / 固定色）、习惯 2 个模式（跟随图标色 / 固定色）。
// 「设置」入口另有两条开关：显示已打卡清单 / 显示已打卡习惯。它不产生视图页签。
//
// 我方差异：配置存本地 meta（Settings.view）而不是它的 8 个 localStorage 标量——换 WebView 不丢；
// 隐藏项用数组而不是它的逗号串（那边 `search(id)` 子串匹配，ID 前缀互含会误伤）；不做 VIP 门槛。

import { useState } from "react";
import type { Category, HabitContext, ViewConfig } from "../api/types";
import { patchView } from "../store/appStore";
import { I, useEscClose } from "./ui";

/** 参考站 ViewColorModule 的 30 色，按它的数组顺序渲染（6 列 × 5 行）。 */
export const VIEW_PALETTE = [
  "#FDE4DA", "#F6CECC", "#D4E2FE", "#FFF5DA", "#C6C9F2", "#F6D1E5",
  "#E1F2FB", "#D1D2EB", "#F4EDB4", "#A7C5EB", "#E1DBCF", "#FFAAA7",
  "#91D9EA", "#A9C6A8", "#E9B561", "#94CEFF", "#7BD2B2", "#FF9593",
  "#FFBEEC", "#96CE85", "#E6925B", "#98DDCA", "#DEBA9D", "#BFA2DB",
  "#D9E4DD", "#D49A89", "#E7D3B0", "#F7D3BA", "#E6E5F7", "#D3F0C0",
];

const MATTER_MODES = ["按清单详情设置", "按清单分类", "按优先级", "设置固定颜色"];
const HABIT_MODES = ["跟随习惯图标颜色", "设置固定颜色"];

/** 透明遮罩 + 白卡菜单，与头像菜单同一套壳（点遮罩关、Esc 关）。 */
function Menu({ onClose, width, children }: { onClose: () => void; width: number; children: React.ReactNode }) {
  useEscClose(onClose);
  return (
    <div className="vc-curtain" onMouseDown={onClose}>
      <div className="vc-menu" style={{ width }} onMouseDown={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

export function CustomizeMenu({ onPick, onClose }: { onPick: (which: "content" | "color") => void; onClose: () => void }) {
  return (
    <Menu onClose={onClose} width={168}>
      <button onClick={() => onPick("content")}>自定义视图内容</button>
      <button onClick={() => onPick("color")}>自定义视图颜色</button>
    </Menu>
  );
}

export function SettingMenu({ cfg, onToggle, onClose }: {
  cfg: ViewConfig;
  onToggle: (key: "hideMatterClocked" | "hideHabitClocked") => void;
  onClose: () => void;
}) {
  return (
    <Menu onClose={onClose} width={200}>
      <button onClick={() => onToggle("hideMatterClocked")}>
        <span>显示已打卡清单</span><i className={"vc-sw" + (!cfg.hideMatterClocked ? " is-on" : "")} />
      </button>
      <button onClick={() => onToggle("hideHabitClocked")}>
        <span>显示已打卡习惯</span><i className={"vc-sw" + (!cfg.hideHabitClocked ? " is-on" : "")} />
      </button>
    </Menu>
  );
}

/**
 * 整屏遮罩弹窗（参考站的 CustomViewMatter / CustomViewColor 就是 curtain-grey + 居中白卡）。
 * 里面是「草稿 + 保存/取消」：取消就整块丢弃，回显下次按已存值重来。
 */

/** 自定义视图内容：页签（清单/习惯）+ 分类/情境多选，「全部」与具体项互斥。 */
export function ViewContentDialog({ cfg, categories, contexts, onClose }: {
  cfg: ViewConfig;
  categories: Category[];
  contexts: HabitContext[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"matter" | "habit">("matter");
  const [hideM, setHideM] = useState<string[]>(cfg.hideCategories);
  const [hideH, setHideH] = useState<string[]>(cfg.hideHabitContexts);

  const rows = tab === "matter"
    ? [{ id: "__all", name: "全部" }, ...categories.map((c) => ({ id: c.id, name: c.name })), { id: "", name: "无分类" }]
    : [{ id: "__all", name: "全部" }, ...contexts.map((c) => ({ id: c.id, name: c.name }))];
  const hide = tab === "matter" ? hideM : hideH;
  const setHide = (next: string[]) => (tab === "matter" ? setHideM(next) : setHideH(next));
  const allOn = hide.length === 0;

  function toggle(id: string) {
    if (id === "__all") return setHide([]);
    const next = hide.includes(id) ? hide.filter((x) => x !== id) : [...hide, id];
    setHide(next);
  }

  function save() {
    patchView({ hideCategories: hideM, hideHabitContexts: hideH });
    onClose();
  }

  return (
    <div className="vc-mask" onMouseDown={onClose}>
      <div className="vc-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="自定义视图内容">
        <div className="vc-head">
          <span className="vc-title">自定义视图内容</span>
          <button className="vc-close" aria-label="关闭" onClick={onClose}><I n="close" size={11} /></button>
        </div>
        <div className="vc-tabs">
          <button className={"vc-tab" + (tab === "matter" ? " is-sel" : "")} onClick={() => setTab("matter")}>清单</button>
          <button className={"vc-tab" + (tab === "habit" ? " is-sel" : "")} onClick={() => setTab("habit")}>习惯</button>
        </div>
        <ul className="vc-list">
          {rows.map((r) => {
            const on = r.id === "__all" ? allOn : !hide.includes(r.id);
            return (
              <li key={r.id || "none"}>
                <button className="vc-row" onClick={() => toggle(r.id)}>
                  <span>{r.name}</span>
                  <i className={"vc-mark" + (on ? " is-on" : "")}>{on ? <I n="check" size={11} /> : null}</i>
                </button>
              </li>
            );
          })}
        </ul>
        <p className="vc-note">取消勾选即从视图网格里隐藏这一类；清单页不受影响。</p>
        <div className="vc-foot">
          <button className="cc-btn" onClick={onClose}>取消</button>
          <button className="cc-btn is-primary" onClick={save}>保存</button>
        </div>
      </div>
    </div>
  );
}

/** 自定义视图颜色：单选模式；点「设置固定颜色」且还没选过色时不立刻生效，先弹色板（参考站就是这个分支）。 */
export function ViewColorDialog({ cfg, onClose }: {
  cfg: ViewConfig;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"matter" | "habit">("matter");
  const [modeM, setModeM] = useState(cfg.matterColorMode);
  const [modeH, setModeH] = useState(cfg.habitColorMode);
  const [valM, setValM] = useState(cfg.matterColorValue);
  const [valH, setValH] = useState(cfg.habitColorValue);
  const [palette, setPalette] = useState(false);

  const rows = tab === "matter" ? MATTER_MODES : HABIT_MODES;
  const mode = tab === "matter" ? modeM : modeH;
  const value = tab === "matter" ? valM : valH;
  const fixedIndex = tab === "matter" ? 3 : 1;

  function pick(i: number) {
    if (i === fixedIndex && !value) return setPalette(true);
    if (tab === "matter") setModeM(i as ViewConfig["matterColorMode"]);
    else setModeH(i as ViewConfig["habitColorMode"]);
  }

  function choseColor(hex: string) {
    if (tab === "matter") { setValM(hex); setModeM(3); } else { setValH(hex); setModeH(1); }
    setPalette(false);
  }

  function save() {
    patchView({
      matterColorMode: modeM, matterColorValue: modeM === 3 ? valM : "",
      habitColorMode: modeH, habitColorValue: modeH === 1 ? valH : "",
    });
    onClose();
  }

  return (
    <>
      <div className="vc-mask" onMouseDown={onClose}>
        <div className="vc-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="自定义视图颜色">
          <div className="vc-head">
            <span className="vc-title">自定义视图颜色</span>
            <button className="vc-close" aria-label="关闭" onClick={onClose}><I n="close" size={11} /></button>
          </div>
          <div className="vc-tabs">
            <button className={"vc-tab" + (tab === "matter" ? " is-sel" : "")} onClick={() => setTab("matter")}>清单</button>
            <button className={"vc-tab" + (tab === "habit" ? " is-sel" : "")} onClick={() => setTab("habit")}>习惯</button>
          </div>
          <ul className="vc-list">
            {rows.map((t, i) => (
              <li key={t}>
                <button className="vc-row" onClick={() => pick(i)}>
                  <span>{t}</span>
                  {mode === i && i === fixedIndex && <i className="vc-swatch" style={{ background: value || "transparent" }}>{value ? "" : "选色"}</i>}
                  <i className={"vc-mark" + (mode === i ? " is-on" : "")}>{mode === i ? <I n="check" size={11} /> : null}</i>
                </button>
              </li>
            ))}
          </ul>
          <div className="vc-foot">
            <button className="cc-btn" onClick={onClose}>取消</button>
            <button className="cc-btn is-primary" onClick={save}>保存</button>
          </div>
        </div>
      </div>
      {palette && <ColorPalette current={value} onCancel={() => setPalette(false)} onPick={choseColor} />}
    </>
  );
}

/** 30 色色板：选中态是外圈描边；一个都没选时点保存只关窗、不改配置（参考站如此）。 */
export function ColorPalette({ current, onPick, onCancel }: {
  current: string;
  onPick: (hex: string) => void;
  onCancel: () => void;
}) {
  const [sel, setSel] = useState("");
  useEscClose(onCancel);
  return (
    <div className="vc-mask" onMouseDown={onCancel}>
      <div className="vc-card vc-card-palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="选择固定颜色">
        <div className="vc-head"><span className="vc-title">设置固定颜色</span></div>
        <ul className="vc-palette">
          {VIEW_PALETTE.map((hex) => (
            <li key={hex} className={"vc-cell" + (sel === hex ? " is-sel" : "") + (current === hex ? " is-now" : "")}>
              <button aria-label={`颜色 ${hex}`} style={{ background: hex }} onClick={() => setSel(hex)} />
            </li>
          ))}
        </ul>
        <div className="vc-foot">
          <button className="cc-btn" onClick={onCancel}>取消</button>
          <button className="cc-btn is-primary" disabled={!sel} onClick={() => sel && onPick(sel)}>保存</button>
        </div>
      </div>
    </div>
  );
}

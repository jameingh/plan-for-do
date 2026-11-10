// 弹层几何断言：①定位 ②不溢出。
//
// 为什么单独立这个文件：这两条是**必测项**，每个弹层都要过。
//   ①定位：弹层必须贴在触发器旁边，不能飘到别处。
//     2026-11-09 备忘录「…」排序菜单就是飘的——`.menu-box` 基础规则写死
//     `left: 4.15rem`，结果菜单落到编辑区上方，离按钮 51px。
//   ②不溢出：弹层内容不能超出弹层框。
//     同一天另一处：回收站复选框的全局 `.item-selected { margin: 0 .24rem }`
//     漏进菜单选中行，把整行推出菜单框 15.84px（scrollWidth 141 vs clientWidth 125）。
//
// 两条都必须在 DOM 层量：UIA 拿不到 scrollWidth，溢出的判据只能是
// scrollWidth/clientWidth + 子元素 rect。UIA 只适合做「点得到哪个元素」，
// 所以交互用 agent-desktop，几何用 CDP —— 各自用它擅长的那一半。

/** 弹层与触发器之间允许的最大间隙（px）。贴着算 0，所以 16 已经很宽松。 */
export const MAX_GAP = 16;
/** 子元素允许超出容器的容差（px）。 */
export const TOL = 2;
/** 带 transform 的元素视觉外扩（旋转 45° 的对勾）额外放宽多少。 */
export const ROT_TOL = 8;
/** 点定位（右键菜单）允许的偏差（px）。 */
export const POINT_TOL = 8;

/**
 * 生成一段在页面里跑的探测表达式。
 * @param {string} popupSel  弹层选择器
 * @param {string} anchorSel 触发器选择器（可空）
 */
export function probeExpr(popupSel, anchorSel) {
  return `(() => {
  const q = (s) => s ? document.querySelector(s) : null;
  const R = (el) => { if(!el) return null; const b = el.getBoundingClientRect();
    return {x:+b.x.toFixed(1), y:+b.y.toFixed(1), w:+b.width.toFixed(1), h:+b.height.toFixed(1),
            left:+b.left.toFixed(1), top:+b.top.toFixed(1),
            right:+b.right.toFixed(1), bottom:+b.bottom.toFixed(1)}; };
  const popup = q(${JSON.stringify(popupSel)});
  const anchor = q(${JSON.stringify(anchorSel || "")});
  const out = { popup: R(popup), anchor: R(anchor), vw: innerWidth, vh: innerHeight,
                scroll: null, kids: [], clipped: [], scrollable: false };
  if (!popup) return JSON.stringify(out);
  out.scroll = { w: popup.scrollWidth, h: popup.scrollHeight, cw: popup.clientWidth, ch: popup.clientHeight };
  // 弹层自己带滚动（max-height + overflow:auto）时，超出部分是设计好的滚动区，不算溢出。
  const pc = getComputedStyle(popup);
  out.scrollable = /(auto|scroll)/.test(pc.overflowY) || /(auto|scroll)/.test(pc.overflowX);
  // 弹层里所有可见后代；被某个「自带滚动/裁剪」的祖先包着的跳过——
  // 那是设计上的长列表，不是溢出。
  const clippedBy = (el) => {
    if (out.scrollable) return true;   // 弹层自己就是滚动区，超出部分不算溢出
    for (let p = el.parentElement; p && p !== popup; p = p.parentElement) {
      const c = getComputedStyle(p);
      if (/(auto|scroll|hidden)/.test(c.overflowY) || /(auto|scroll|hidden)/.test(c.overflowX)) return true;
    }
    return false;
  };
  for (const el of popup.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const b = el.getBoundingClientRect();
    if (!b.width && !b.height) continue;
    const rot = cs.transform !== 'none';
    const rec = { cls: (el.className || el.tagName).toString().slice(0, 60), rot, r: R(el) };
    if (clippedBy(el)) { out.clipped.push(rec); continue; }
    out.kids.push(rec);
  }
  // 命中测试：浮层上面不能压着别的元素。
  // 2026-11-10 头像菜单就是这个毛病——菜单不透明，但它被「清单」按钮压在上面，
  // 看着像透明。光看 background-color 查不出来，得问「这个点上最上面是谁」。
  out.hits = [];
  try {
    const r = popup.getBoundingClientRect();
    const pts = [[r.x + r.width / 2, r.y + r.height / 2],
                 [r.x + Math.min(8, r.width / 2), r.y + Math.min(8, r.height / 2)],
                 [r.right - Math.min(8, r.width / 2), r.bottom - Math.min(8, r.height / 2)]];
    for (const [x, y] of pts) {
      const hit = document.elementFromPoint(x, y);
      if (!hit) continue;
      if (hit === popup || popup.contains(hit)) continue;
      out.hits.push(((hit.className || hit.tagName) || "").toString().slice(0, 50));
    }
  } catch (e) { out.hits = ["命中测试失败：" + String(e && e.message)]; }
  return JSON.stringify(out);
})()`;
}

/** 两个矩形之间的间隙；相交为 0。 */
function rectGap(a, b) {
  // 注意：这里必须用 left/top。矩形对象里只有 x/y/w/h/right/bottom，
  // 写成 a.left 会得到 undefined → NaN → 比较恒为 false → 判据整个失效（2026-11-10 踩过）。
  const g = Math.max(0, a.left - b.right, b.left - a.right, a.top - b.bottom, b.top - a.bottom);
  return Number.isFinite(g) ? g : Infinity;
}

/**
 * 判定一个弹层是否合格。
 * @param {object} g        probeExpr 的结果
 * @param {object} opt
 * @param {"element"|"point"|"none"} opt.anchorMode 定位判据
 * @param {{x:number,y:number}} [opt.point] 点定位时的鼠标位置
 */
export function judgePopup(g, opt = {}) {
  const problems = [];
  const mode = opt.anchorMode || "element";

  if (!g.popup) return { ok: false, problems: ["弹层没出现"] };

  // —— ② 不溢出 ——
  // 弹层自带滚动条时，超出的那截是设计好的滚动区，不算溢出。
  if (g.scroll && !g.scrollable) {
    if (g.scroll.w > g.scroll.cw + 1) problems.push(`内容横向溢出 ${g.scroll.w} > ${g.scroll.cw}`);
    if (g.scroll.h > g.scroll.ch + 1) problems.push(`内容纵向溢出 ${g.scroll.h} > ${g.scroll.ch}`);
  }
  for (const k of g.kids || []) {
    const tol = TOL + (k.rot ? ROT_TOL : 0);
    const r = k.r;
    if (r.right > g.popup.right + tol || r.left < g.popup.left - tol ||
        r.bottom > g.popup.bottom + tol || r.top < g.popup.top - tol) {
      problems.push(`子元素 .${k.cls} 超出弹层框`);
    }
  }

  // —— ① 定位 ——
  if (mode === "element") {
    if (!g.anchor) problems.push("找不到触发器");
    else {
      const gap = rectGap(g.popup, g.anchor);
      if (gap > MAX_GAP) problems.push(`离触发器 ${gap.toFixed(1)}px（上限 ${MAX_GAP}）`);
      if (g.popup.right < g.anchor.left - MAX_GAP || g.popup.left > g.anchor.right + MAX_GAP) {
        problems.push("与触发器横向不重叠");
      }
    }
  } else if (mode === "point") {
    if (opt.point) {
      const dx = Math.abs(g.popup.left - opt.point.x);
      const dy = Math.abs(g.popup.top - opt.point.y);
      if (dx > POINT_TOL || dy > POINT_TOL) problems.push(`没贴在右键位置（Δ${dx.toFixed(1)},${dy.toFixed(1)}）`);
    }
  }

  // —— 通用：不能被切在视口外 ——
  if (g.popup.right > g.vw + 1 || g.popup.bottom > g.vh + 1 ||
      g.popup.left < -1 || g.popup.top < -1) {
    problems.push(`弹层超出视口（视口 ${g.vw}×${g.vh}）`);
  }

  // —— 通用：不能被下层元素压住（看着像透明）——
  for (const h of g.hits || []) {
    problems.push(`浮层被「${h}」压在上面`);
  }

  return { ok: problems.length === 0, problems };
}

// 全应用弹层清单（必测两件事：**定位** 与 **不溢出**）。
//
// 这张表被两个脚本共用：
//   scripts/check-popup.mjs      —— CI 里的常驻自检（CDP 派发真鼠标事件开弹层）
//   scripts/sweep-popup-uia.mjs  —— 本机 agent-desktop 实机巡检（语义点击开弹层）
//
// 每个 case：
//   tab        先切到哪个模块（rail 里的名字）
//   label      人读的说明
//   steps      打开弹层的操作序列；最后一步的产物就是要量的弹层
//              { css, text?, name?, kind?: "click"|"rightclick" }
//              css  → CDP 版用（选择器 + 可选文字）
//              name → agent-desktop 版用（可访问名，图标按钮只有 aria-label 能定位）
//              text → agent-desktop 版用（可见文字）
//   popup      要量的弹层选择器
//   anchor     触发器选择器（anchorMode=element 时必填）
//   anchorMode element=贴触发器 / point=贴右键位置 / none=整屏浮层，只查溢出与视口
//   prep       造数据用的额外步骤（先于 steps 执行）
//   optional   前置条件不满足就跳过（记 SKIP 而不是 FAIL）

export const CASES = [
  // ——— 备忘录 ———
  {
    id: "memo-sort", tab: "备忘录", label: "备忘录 · 排序方式菜单",
    steps: [{ css: ".icon-folder-more", name: "排序与文件夹管理" }],
    popup: ".menu-box", anchor: ".icon-folder-more", anchorMode: "element",
  },
  {
    id: "memo-folder", tab: "备忘录", label: "备忘录 · 文件夹下拉",
    steps: [{ css: ".icon-folder-select", name: "切换文件夹" }],
    popup: ".folder-box", anchor: ".icon-folder-select", anchorMode: "element",
  },
  {
    id: "memo-ctx", tab: "备忘录", label: "备忘录 · 列表右键菜单",
    prep: [{ css: ".create-note", name: "新建备忘录" }],
    steps: [{ css: ".body-memo-item", name: "备忘录：", kind: "rightclick" }],
    popup: ".menu-box.is-mouse", anchor: ".body-memo-item", anchorMode: "point",
  },
  {
    id: "memo-move-folder", tab: "备忘录", label: "备忘录 · 右键「移入文件夹」",
    prep: [{ css: ".create-note", name: "新建备忘录" }],
    steps: [
      { css: ".body-memo-item", name: "备忘录：", kind: "rightclick" },
      { css: ".menu-box .item", text: "移入文件夹" },
    ],
    popup: ".folder-box.is-mouse", anchor: ".body-memo-item", anchorMode: "point",
    // 期望落点取**最初右键的那一行**，不是菜单项：参考站就是 moveInFolder 跟着鼠标走，
    // 点菜单项时 at 没有更新，弹层仍落在右键处。
    pointSel: ".body-memo-item",
  },
  {
    id: "memo-font", tab: "备忘录", label: "备忘录 · 字体下拉",
    prep: [{ css: ".create-note", name: "新建备忘录" }],
    steps: [{ css: ".tool-pick:not(.is-size)", name: "字体" }],
    popup: ".menu-box", anchor: ".tool-pick:not(.is-size)", anchorMode: "element",
  },
  {
    id: "memo-size", tab: "备忘录", label: "备忘录 · 字号下拉",
    prep: [{ css: ".create-note", name: "新建备忘录" }],
    steps: [{ css: ".tool-pick.is-size", name: "字号" }],
    popup: ".menu-box", anchor: ".tool-pick.is-size", anchorMode: "element",
  },
  {
    id: "memo-color", tab: "备忘录", label: "备忘录 · 文字颜色",
    prep: [{ css: ".create-note", name: "新建备忘录" }],
    steps: [{ css: ".color-item", name: "文字颜色" }],
    popup: ".color-box", anchor: ".color-item", anchorMode: "element",
  },
  {
    id: "memo-bgcolor", tab: "备忘录", label: "备忘录 · 背景颜色",
    prep: [{ css: ".create-note", name: "新建备忘录" }],
    steps: [{ css: ".bg-item", name: "背景颜色" }],
    popup: ".color-box", anchor: ".bg-item", anchorMode: "element",
  },
  {
    id: "memo-back", tab: "备忘录", label: "备忘录 · 背景图选择",
    prep: [{ css: ".create-note", name: "新建备忘录" }],
    steps: [{ css: ".icon-item[aria-label='选择背景']", name: "选择背景" }],
    popup: ".back-box", anchor: ".icon-item[aria-label='选择背景']", anchorMode: "element",
  },
  {
    id: "memo-setfolder", tab: "备忘录", label: "备忘录 · 标题栏「移入文件夹」",
    prep: [{ css: ".create-note", name: "新建备忘录" }],
    steps: [{ css: ".note-folder", name: "移入文件夹" }],
    popup: ".folder-box.is-setfolder", anchor: ".note-folder", anchorMode: "element",
  },
  {
    id: "memo-recycle", tab: "备忘录", label: "备忘录 · 回收站抽屉",
    steps: [{ css: ".delete-note", text: "回收站" }],
    popup: ".body-recycle-bin", anchor: null, anchorMode: "none",
  },
  {
    // 文件夹管理抽屉：整屏侧板，只查「内容不溢出」。
    // 它的底部输入框+两个按钮曾经排在一行里（合计 286px > 内容区 211px），
    // 主按钮被挤出裁掉——这条断言就是为它加的（2026-11-10 用户指出）。
    id: "memo-folder-manager", tab: "备忘录", label: "备忘录 · 文件夹管理抽屉",
    steps: [
      { css: ".icon-folder-more", name: "排序与文件夹管理" },
      { css: ".menu-box .item-title", text: "文件夹管理" },
    ],
    popup: ".folder-manage", anchor: null, anchorMode: "none", optional: true,
  },

  // ——— 清单 ———
  {
    id: "list-ctx", tab: "清单", label: "清单 · 卡片右键菜单",
    prep: [
      { css: ".add-card", name: "新建清单" },
      { css: ".cc-title", kind: "fill", value: "巡检用清单" },
      { css: ".item-modal.is-create .cc-btn.is-primary", text: "保存" },
    ],
    steps: [{ css: ".occ-card", kind: "rightclick" }],
    popup: ".ctx-menu", anchor: ".occ-card", anchorMode: "point", optional: true,
  },

  // ——— 顶栏 ———
  {
    id: "view-filter", tab: "清单", label: "顶栏 · 筛选面板",
    steps: [{ css: ".filter-btn", name: "筛选" }],
    popup: ".filter-pop", anchor: ".filter-btn", anchorMode: "element",
  },

  // ——— 习惯 ———
  // 新建习惯是向导弹窗（.habit-modal）：默认「引导」页 → 切「传统」→ 展开折叠行 →
  // 再切子标签，数字/单位选择器才出现，所以这几步是一层层点下去的。
  {
    id: "habit-np", tab: "习惯", label: "习惯 · 数字选择弹层",
    steps: [
      { css: ".btn.small.primary", name: "新建习惯" },
      { css: ".hm-mode", text: "传统" },
      { css: ".hm-row", text: "固定" },      // 展开「重复」面板
      { css: ".hm-tab", text: "按周" },      // 切到「按周」才有 NumPick
      { css: ".np-btn" },
    ],
    popup: ".np-pop", anchor: ".np-btn", anchorMode: "element", optional: true,
  },
  {
    id: "habit-unit", tab: "习惯", label: "习惯 · 单位选择弹层",
    steps: [
      { css: ".btn.small.primary", name: "新建习惯" },
      { css: ".hm-mode", text: "传统" },
      { css: ".hm-row", text: "每天一次" },  // 展开「每天一次/多次」面板
      { css: ".hm-opt", text: "每天多次" },  // 切到「每天多次」才有单位选择
      { css: ".hm-kv-pick" },
    ],
    popup: ".hm-unit-pop", anchor: ".hm-kv-pick", anchorMode: "element", optional: true,
  },

  // ——— 专注 ———
  {
    id: "focus-task-picker", tab: "专注", label: "专注 · 关联任务弹窗",
    steps: [{ css: ".fc-task-off", text: "关联任务" }],
    popup: ".fc-pick", anchor: null, anchorMode: "none", optional: true,
  },
  {
    id: "focus-task-menu", tab: "专注", label: "专注 · 任务菜单",
    steps: [{ css: ".fc-task-on" }],
    popup: ".fc-task-menu", anchor: ".fc-task-on", anchorMode: "element", optional: true,
  },

  // ——— 账户 ———
  {
    id: "avatar-menu", tab: "清单", label: "左上角 · 头像菜单",
    steps: [{ css: ".rail-avatar", name: "账户菜单" }],
    popup: ".avatar-menu", anchor: ".rail-avatar", anchorMode: "element",
  },
];

export const RAIL_ORDER = ["清单", "日程", "习惯", "专注", "备忘录", "设置"];

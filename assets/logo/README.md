# 「功到」标志设计说明

## 一句话

桌面图标从「飞书语系」的蓝青渐变流动曲线，换成**绿底白「力」**——
一枚只有两笔的字：横折钩方直如规矩，撇弧形出锋如行动。

## 为什么换

旧图标有六个问题，前三个是硬伤：

| # | 问题 | 后果 |
| --- | --- | --- |
| 1 | 图标是蓝青渐变 `#2F7CF6→#23A6EC→#15C7C0`，界面主色是**绿** `#03a17e` | 任务栏上是蓝的、点开是绿的，同一程序两套身份 |
| 2 | 旧预览页自述「飞书语系」「最像飞书」，flow 版骨架几乎就是飞书标识 | **商标撞脸风险** |
| 3 | 「工」写成了上下两横等长 + 竖居中 | 那是衬线大写字母 **I** 的构造，中文读不出来 |
| 4 | 向上箭头是品类陈词（效率工具 8.6% 用箭头） | 表达的是「冲刺向上」，而「功到自然成」讲的是**累积** |
| 5 | 箭头几何有近似角 `47.5°`/`132.5°`（应 45°/135°） | 肩部不对称，一眼就是失误 |
| 6 | 靠渐变挽救形式 | 渐变在 32px 就糊成白斑 |

## 构造

「功」= 工 + 力。本次只取**「力」**两笔：

```
横折钩 = 一横（方直，端头斜切）+ 一竖（微偏右）+ 一钩（向左上回锋，45° 斜切）
撇     = 三次贝塞尔脊线 + 法向偏移，起笔顿挫（宽度剖面 hold 段）后收锋至 2 单位
```

- **横细竖粗**（汉字排印惯例，与拉丁相反）——横 17 / 竖 19
- **光学修正**：视觉中心略高于几何中心，整字上移约 2%
- **反白减细**：白版几何减细 3%（irradiation，白字黑底会显胖）
- **小尺寸版**：`gongdao-small.svg` 加粗撇、加大钩，16px 用它

## 为什么是「力」而不是完整的「功」

硬指标是 **16px**。「功」五笔，缩到 16px 时「工」的上下横会连成一根竖条——
实测像素级对照（`tmp/logo-small/compare.png`）：

| 方案 | 16px | 24px | 32px |
| --- | --- | --- | --- |
| A 完整「功」 | 糊，上下横合并成竖条 | 勉强可读 | 可读但「工」偏弱 |
| B 阳文方印 | 框在，内文糊 | 勉强可读 | 可读，框占掉一圈 |
| **C 单「力」** | **清楚，横折钩+撇分明** | **清楚** | **最清晰** |

对照图是当时按真实像素渲染后放大观察的（临时文件不入库）。
三个概念的几何稿留在 `assets/logo/concepts/`。

桌面图标的主要战场是 16px 任务栏，所以选 C。
「功到自然成」——**功字里的那个「力」**，名字没丢；界面左上角头像与「功到」文案承接品牌联结。

## 交付清单

| 文件 | 格式 | 尺寸 | 用途 |
| --- | --- | --- | --- |
| `masters/gongdao-symbol.svg` | SVG | 256 | 单色母版（品牌绿、透明底） |
| `masters/gongdao-symbol-black.svg` | SVG | 256 | 纯黑 |
| `masters/gongdao-symbol-white.svg` | SVG | 256 | 反白版（几何减细 3%） |
| `masters/gongdao-app-icon.svg` | SVG | 256 | 绿底圆角方 + 白符号 |
| `masters/gongdao-app-icon-1024.svg` | SVG | 1024 | 高分辨率 |
| `masters/gongdao-small.svg` | SVG | 256 | 小尺寸专用简化版 |
| `variants/gongdao-symbol-{black,white,mono-03a17e,square,favicon,app-icon}.svg` | SVG | 256 | 各场景变体 |
| `icons/icon.ico` | ICO | 16/24/32/48/64/128/256 | **Windows 打包用**（已接入 `build/windows/icon.ico`） |
| `icons/favicon.ico` + `favicon-{16,32,48}.png` | ICO/PNG | — | 网页 |
| `icons/apple-touch-icon.png` | PNG | 180 | iOS |
| `icons/icon-{192,512}.png`、`maskable-512.png` | PNG | — | PWA |
| `icons/site.webmanifest`、`icons/head-snippet.html` | — | — | PWA 清单 / `<head>` 片段 |

## 已接入

| 位置 | 改动 |
| --- | --- |
| `build/windows/icon.ico` | 已替换，由 `wails3 generate icons` 从 `appicon.png` 生成 |
| `build/appicon.png` | 全平台图标源（1024 满幅），Linux 包与 iOS 用它 |
| `build/darwin/icons.icns` | macOS DMG 用，已同步重生成 |
| `wails_windows_{amd64,arm64}.syso` | 已用新 ico 重新生成（exe 图标资源） |
| `frontend/src/components/BrandMark.tsx` | 新增，共用标志组件 |
| `frontend/src/components/chrome.tsx` | 左栏头像：文字「功」→ 标志 SVG |
| `frontend/src/components/AccountCenter.tsx` | 个人中心两个头像同上 |
| `frontend/src/styles/global.css` | 三个头像去掉 `background: var(--brand)`（绿底由 SVG 自带） |

## 已做的验证

| 项目 | 结果 |
| --- | --- |
| SVG 结构审计（`svg_audit.py`） | 97–98/100，无 WARN / FAIL |
| 尺度测试 16/24/32px | 16px 可辨「力」 |
| 单色 / 反白 / 灰度 / 镜像 / 眯眼 | 均成立 |
| exe 资源提取验证 | 从 `bin/planfordo.exe` 的 PE 资源表提取出 6 档 RT_ICON（16/32/48/64/128/256），确认是新标志 |
| GUI 实机（`cu.py shot`） | 窗口标题栏图标与左栏头像均为新标志 |
| 界面自检 `check-mask.mjs` | 23/23 通过（与改动前一致） |
| 标志自检 `check-brand-icon.mjs` | 5/5 通过 |
| 前端类型检查 `tsc --noEmit` | 通过 |

### 已知既有失败（与本次改动无关，已用 stash 对照实验确认）

| 脚本 | 失败项 | 原因 |
| --- | --- | --- |
| `check-account.mjs` | 菜单位置期望 `left > 64`，实际 `left: 12` | CSS 里 `left: 12px` 是**有意偏离**参考站的选择（`global.css` 注释写明），脚本没跟上 |
| `check-focus.mjs` | 「种子三条今天的事项」「种子习惯」为空 | 需先跑清单/习惯模块的种子脚本 |
| `check-view.mjs` | 找不到 `.v-type` | 同上，缺种子数据 |

改动前版本跑这三个脚本，失败项与数量完全相同。

## 未决项与边界

- **商标可注册性未核实**——需专业检索（商标数据库 + 反向图片搜索）。本次只做了「不撞脸飞书」的分析。
- **未做字体授权评估**——本方案是几何构造的汉字笔画，**不依赖任何字体文件**，无授权问题。
- 旧的飞书语系素材（`gongdao-fs-*.svg` 与预览页）已删除，仓库只留一套身份；需要时从 git 历史取回。

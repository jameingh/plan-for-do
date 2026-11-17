# plan-for-do 项目长期约定

## 品牌标志（2026-11-10 定）

- 桌面图标 = **绿底白「力」**（单「力」两笔，非完整「功」）。母版与全套资产在 `assets/logo/`，
  设计说明见 `assets/logo/README.md`。
- **主色就是界面绿 `#03a17e`**（`--brand`）。旧图标是蓝青渐变（撞脸飞书 + 与界面两套身份），已废弃，
  但 `assets/logo/gongdao-fs-*.svg` 暂留未删。
- 改标志的链路（顺序不能反）：
  1. 改 `assets/logo/masters/gongdao-symbol.svg` 等母版（**几何靠脚本生成，别手写坐标**，
     生成器在 `tmp/logo-gen/`）；
  2. `python ~/.workbuddy/skills/brand-identity-design/scripts/export_variants.py` 出变体；
  3. `render_png.py --ico` 出 7 档 Windows icon.ico → 覆盖 `build/windows/icon.ico`；
  4. **必须重生成 syso**：`cd build && wails3 generate syso -arch amd64 -icon windows/icon.ico
     -manifest windows/wails.exe.manifest -info windows/info.json -out ../wails_windows_amd64.syso`
     （arm64 同理）—— 换了 icon.ico 但没重生成 syso，exe 里的图标还是旧的；
  5. 重建前端 + exe（同下节）。
- 界面里三处头像（左栏 `chrome.tsx` + 个人中心两处 `AccountCenter.tsx`）走共用组件
  `frontend/src/components/BrandMark.tsx`；**绿底在 SVG 里**，所以三个头像的 CSS 都去掉了
  `background: var(--brand)`（留着会叠成两层绿）。
- **16px 是硬指标**：完整「功」五笔在 16px 上下横会连成竖条，所以选了两笔的「力」。
  以后改标志必须先看 16px 像素级效果，别只看大图。

## 改完必重建 + GUI 实机验证（用户 2026-11-09 要求）

- **前端**：`cd frontend && npm run build`（= tsc && vite build），产物 `frontend/dist` 被 `.gitignore` 忽略。
  CI/Release 会自动重建，但本机必须自己跑一次，否则 `//go:embed all:frontend/dist` 打进去的是旧 UI。
- **桌面 exe**（Windows 生产配方，与 `build/windows/Taskfile.yml`、`.github/workflows/release.yml` 一致）：
  `CGO_ENABLED=0 go build -tags production -trimpath -buildvcs=false -ldflags="-w -s -H windowsgui" -o bin/planfordo.exe .`
  `-H windowsgui` 少了会弹控制台。不要用 `go build ./...`：`build/ios` 的 `main_ios.go` 带 `ios` 标签，
  非 iOS 平台会报 `function main is undeclared`（既有结构问题，不是改动引起的）。
- **验证实例**（隔离，不动 `%APPDATA%\planfordo`）：
  `PLANDO_DATA_DIR=tmp/vdata-gui PLANDO_WEBVIEW_PROFILE=tmp/vprofile-gui PLANDO_CDP_PORT=9257 PLANDO_START_TAB=settings ./bin/planfordo.exe`
  用 Bash `run_in_background: true` 启动；CDP `http://127.0.0.1:9257/json/list` 就绪后用
  `computer-use-unified` 的 `cu.py` 真实点击验证。项目自带 `scripts/verify-restart.sh <port> <tab>`
  也能重建 + 起隔离实例（产出 `bin/planfordo-verify.exe`，带控制台便于看日志）。
- 窗口标题「功到」、class `WailsWebviewWindow`；设置页分三个分组页签（偏好设置 / 系统信息 / 数据与同步），「同步通道」在「数据与同步」下，脚本要先切 tab 再点。
- 自检脚本按文本定位按钮：`check-mask.mjs` 用 `clickAt(".btn","新增通道")`、
  `verify-channel.mjs` 用精确 `byText("新增通道")`；新增按钮文案别含「新增通道」，
  也别新增 placeholder 含「例如：」或「键（」的输入框，否则界面自检会选错控件。

## 自检失败先做 stash 对照实验，别急着改代码（2026-11-10 确立）

- **手动起实例跑自检容易假失败**：CDP `json/list` 有响应 ≠ 界面 boot 完成。
  必须用 `bash scripts/verify-restart.sh <port> <tab>` 起实例——它会删旧数据目录、等内核把
  `planfordo.db` 落盘再交活。手动起实例至少要：CDP 就绪 + sleep 3s + 等 db 文件出现。
- **已知既有失败（不是回归，别去"修"）**：
  - `check-account.mjs`「菜单贴在左栏右侧」期望 `left > 64`、实际 `left: 12`
    —— CSS 里 `left: 12px` 是**有意偏离参考站**的选择（`global.css` 注释写明），脚本没跟上；
  - `check-focus.mjs`「种子三条今天的事项」「种子习惯」为空 → 缺清单/习惯模块的种子数据；
  - `check-view.mjs` 找不到 `.v-type` → 同上，缺种子数据。
- **判定因果的标准做法**：`git stash push <改动文件>` → 重建前端 → 跑同一脚本 → 对比失败项。
  失败项完全相同 = 既有问题，与本次改动无关；本次改动相关的自检全过即可交付。
  （2026-11-10 用这招排除了 check-mask 的假失败和 check-account/check-focus/check-view 的既有失败。）

## 弹层「定位 + 不溢出」是必测两项（用户 2026-11-09 定）- 判据与实现在 `scripts/lib/geom.mjs`（`probeExpr` 量几何、`judgePopup` 判定）；
  弹层清单在 `scripts/lib/popups.mjs`（所有模块的触发器 + 弹层 + 锚点）。
- 两个执行器共用同一张清单：
  - `scripts/check-popup.mjs` —— **CI 常驻自检**（CDP 派发真鼠标事件，Windows runner 上可跑），
    已进 `.github/workflows/ci.yml` 的 ui job 矩阵。
  - `scripts/sweep-popup-uia.mjs` —— 本机 **agent-desktop 实机巡检**（语义点击开弹层 + CDP 量几何）。
  - `scripts/check-memo.mjs` 末尾也加了备忘录 6 个浮层的同两项断言（现 87 项全过）。
- 判定口径：定位 = 弹层与触发器的间隙 ≤16px 且横向不脱开；点定位（右键菜单）= 弹层左上角
  贴鼠标位置 ≤8px；不溢出 = `scrollWidth/clientWidth` 不超 + 后代 rect 不出框；
  弹层自带 `overflow:auto`（滚动区）时不算溢出；任何浮层都不得被视口切掉；
  **不得被下层元素压住** = 用 `elementFromPoint` 问「这个点上最上面是谁」，
  浮层上面压着别的元素就判失败（只看 background-color 查不出层叠问题——
  菜单背景可能明明是不透明的，却被下层按钮压住，看着像透明）。
- **嵌在可滚动面板里的浮层要用 `position: fixed` + 按触发器真实 rect 算落位**，
  否则会被面板的 `overflow-y:auto` 裁掉下半截（下半截点不到）。
  HabitCreate 里的 `.np-pop` 早就这么做了，`.hm-unit-pop` 漏了，2026-11-10 才补上。
- **判据里的字段名必须和探测器返回的字段名逐字对齐**：矩形对象是 `{x,y,w,h,left,top,right,bottom}`，
  写成 `a.left` 而探测器没给 left → undefined → NaN → `NaN > 16` 恒 false，**判据静默失效**
  （2026-11-10 踩过：定位这一项从上线起一直是空判）。所以 rectGap 遇到非有限值要返回 Infinity，
  且探测器要把 left/top 一起给出。
- 新增浮层时必须往 `scripts/lib/popups.mjs` 加一条，否则这两项检查覆盖不到它。
  点定位类用例可用 `pointSel` 指定「期望落点取哪个元素」（有些弹层跟着最初右键的位置走）。
- **巡检脚本的健壮性**：切模块/造数据走 CDP 真鼠标（导航不是被测对象，
  agent-desktop 的语义通道在「同名孪生多、上一条用例留了抽屉」的状态下会失灵）；
  每条用例前后清理残留的模态框与抽屉，否则下一条用例点不到左栏。
- 判据要在 DOM 层量：UIA 拿不到 `scrollWidth`，所以几何永远用 CDP，agent-desktop 只管「点得到」。

## agent-desktop 在本项目 WebView2 上的坑（2026-11-09 实测）

- 找元素：`find --name <可访问名>` 能命中 `aria-label`；`--text` 只搜可见文字，**搜不到 aria-label**。
  两者别混用：触发器图标按钮只有 aria-label 时必须用 `--name`。
- **别加 `--role`**：`find --name X --role button` 这种组合 agent-desktop 直接非零退出，脚本会崩。
  改成只传 `--name`/`--text`，角色自己在 JS 里过滤。
- 按文字寻址时它会把**整个窗口**也匹配上（窗口 name 含整页文本），点下去会误触遮罩把浮层关掉；
  只有「按可访问名寻址」的步骤才交给语义通道，其余（CSS/文字限定）走 CDP 更准。
- 语义通道点不动两类东西：`aria-haspopup` 的按钮（UIA 角色变 menubutton，InvokePattern 不触发
  React onClick）、以及 DOM 的 `contextmenu` 事件。两者都退回 CDP 真鼠标事件。
- PATH 里的 `agent-desktop` 是 POSIX sh shim，Node `execFile` 跑不了（ENOENT）：
  用原生 exe `C:/Users/Public/Programs/AgentDesktop/node_modules/agent-desktop/bin/agent-desktop-win32-x64.exe`，
  顺带省掉 Node launcher 的 ~125ms。
- WebView2 的可访问树比 DOM 慢一拍：刚切完页立刻 find 可能一个都找不到，find 要重试一次。

## 增量同步：暂不做（用户 2026-11-09 决定）

- 结论：**等量上来再考虑**，现阶段继续「全量快照 + 记录级 LWW + 两端推并集」。
  实测默认库 52 行、data 14.7KB、快照 JSON 约 22KB，一轮同步就是 1 GET + 1 PUT 共几十 KB；
  增量的收益远小于引入水位/compact/乱序/删除传播与削弱自愈能力的代价。
- 触发阈值：记录 >2 万 / 压缩后快照 >5MB / 改成自动定时同步 / 设备 >3 台 /
  移动端按流量计费 / 同步耗时被投诉。
- 真要做时：**全量快照必须保留作基线兜底**，增量只做可选旁路（仿 `BlobChannel` 加
  `BucketChannel`），首轮或异常永远能退回全量重推；不能让增量替换全量。
- 在此之前值得做的两个小优化（按性价比）：① gzip 快照（需处理旧客户端兼容）；
  ② blob 内容寻址分片（解决 14MB 上限、base64 膨胀、每轮重写整份归档、单附件 50MB 无法同步）。

# 功到 · planfordo

> 本地优先的跨端清单 / 习惯 / 视图 / 专注 / 备忘录应用。纯 Go 内核 + Wails v3 桌面壳 + React 前端，
> 数据默认只存在你自己机器上，同步通道可插拔（飞书多维表格 / 飞书云盘 / WebDAV / 本地文件夹）。

![CI](https://github.com/jameingh/plan-for-do/actions/workflows/ci.yml/badge.svg) ![Release](https://github.com/jameingh/plan-for-do/actions/workflows/release.yml/badge.svg)

中文项目，文档与代码注释均为中文。产品名「功到」取「功到自然成」；界面与交互的规格记录在
[docs/design-reference.md](docs/design-reference.md)，架构与口径记录在 [docs/architecture.md](docs/architecture.md)。

## 它是什么

| 模块 | 里面有什么 |
| --- | --- |
| 清单 | 日期 / 分类 / 四象限三种分组，重复规则（每天、每周几、每月几日、每隔 N 天、按周月配额）、子任务、跨天与自选多日、时间点与时间段、提醒（含自定义提醒时间）、标签、置顶、逾期顺延、打卡三态（成功 / 跳过 / 失败） |
| 视图 | 日 / 周 / 月三种日历视图（月网格 + 跨天条、周日视图 24 小时网格 + 重叠并排分栏 + 折叠小时段）、自定义视图（内容多选 + 颜色模式含 30 色板）、两个「显示已打卡」开关 |
| 习惯 | 每天一次 / 每天多次（量化 + 单位）、情境分段、按排期日历打卡、可回溯补打卡、心得、新建引导模式（微启动分步提问），以及「习惯统计」四页签（日/周/月/年：打卡格子、完美打卡、连续天数、全年热力图） |
| 专注 | 正计时 / 番茄钟 / 倒计时三个子模块，都能关联任务；沉浸式计时、暂停与结束确认、结算页与专注心得、专注详情页（含事件时间轴）；数据页有统计分析（累计与今日总览、时长分布、全时段热图、时长分解、补记与历史列表）与数据分布（日/月/年） |
| 备忘录 | 文件夹管理 + 拖拽排序、搜索（回车触发、命中词高亮）、按创建/修改时间排序、置顶、右键菜单、富文本编辑器（字体/字号/颜色/对齐/列表/复选框/背景）、附件、回收站与彻底删除 |
| 设置 | 运行环境（握手信息）、节假日与调休（覆盖年份 / 出处 / 导入目录）、偏好（含系统原生通知开关）、备份与恢复（口令加密）（默认分组 / 主题 / 新建习惯模式 / 显示已打卡 / 系统通知）、同步通道配置与「立即同步」 |

## 架构

```
api.go / main.go            Wails v3 桌面壳：绑定 API、事件、静态资源内嵌（//go:embed frontend/dist）
cmd/plando                  同内核的命令行：add / clock / habit / habit-clock / focus / sync / stats …
internal/core/model         领域对象（不依赖 UI、驱动、同步实现；iOS 将来直接复用）
internal/core/store         单表 entity（kind,id + JSON data + 派生列 day/parent/status/sort），纯 Go sqlite
internal/core/repeat        重复规则展开、override、节假日
internal/core/calendar      农历/节气/节日换算 + 内置法定节假日与调休年度表（可被本机导入覆盖）
internal/core/service       用例：清单 / 习惯 / 视图 / 专注 / 备忘录 / 提醒 / 统计
internal/core/sync          合并引擎（记录级 LWW + tombstone 全量快照）+ 通道接口
internal/core/sync/channel  feishuBase / feishuDrive / webdav / localdir
frontend/src                React + Vite + TS；api/client.ts 是唯一接缝（Wails 绑定 / 浏览器 mock 两边同口径）
scripts                     CDP 真点击自检脚本 + 种子数据 + 截图脚本
docs                        设计规格、架构、iOS 打包步骤
```

内核刻意保持 CGO-free（`CGO_ENABLED=0` 可编译），所以交叉出包不需要对应平台的主机。

## 本地跑起来

```bash
# 1) 前端产物（桌面壳把它内嵌进二进制）
cd frontend && npm ci && npm run build && cd ..

# 2) 桌面应用
CGO_ENABLED=0 go build -o bin/planfordo.exe .   # 非 Windows 用 -o bin/planfordo
./bin/planfordo.exe

# 只想在浏览器里看界面（走内存 mock，同口径的另一套实现）
cd frontend && npm run dev
```

环境：Go 1.27+、Node 20+。Windows 需要 WebView2 运行时（Win10/11 自带）。

命令行（与界面共用一个内核与一个数据目录）：

```bash
go build -o bin/plando.exe ./cmd/plando
./bin/plando.exe add "写周报" --day 2026-11-10 --time 09:00-10:30
./bin/plando.exe habit "晨跑" --freq "weekly:1,3,5" --backfill 7
./bin/plando.exe habit-clock "晨跑" --day 2026-11-08
./bin/plando.exe focus --type pomo --minutes 25 --cycles 4 --item "写周报"
./bin/plando.exe sync            # 跑所有启用的通道
./bin/plando.exe calendar        # 节假日数据覆盖了哪几年、出处、导入目录
./bin/plando.exe export backup.planfordo --with-attachments   # 口令加密的全量备份（PLANDO_BACKUP_PASSWORD）
./bin/plando.exe import backup.planfordo                      # 恢复：按最后修改时间合并，不清库
./bin/plando.exe calendar day 2026-10-01     # 查一天的班/休
./bin/plando.exe where           # 数据目录与设备 ID
```

## 数据在哪里，隐私怎么处理

- 数据默认在 `%APPDATA%\planfordo`（macOS/Linux 走系统配置目录）：`planfordo.db`、附件、同步状态、`app-errors.log`。
- 没有账号体系，没有服务端；同步只有在你配了通道之后才发生，密钥只存本机 `meta`，不进快照、不打日志、界面不回显。
- 本仓库**不含**任何用户数据：数据库、日志、`tmp/` 下的自检临时库与验证截图、参考站实拍与本机截图全部被 `.gitignore` 挡住。
  文档里引用到的取证内容已脱敏（任务名换成中性示例，测量数值未改）。

## 测试

```bash
CGO_ENABLED=0 go vet ./internal/...
CGO_ENABLED=0 go test ./...          # 内核单测：重复展开、存储、用例、同步合并、各通道 httptest 打桩
cd frontend && npx tsc --noEmit
```

这些每次 push 都会由 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 跑一遍：
`kernel`（vet + go test）与 `web`（tsc + 构建）在 ubuntu 上，八个界面自检各占一个 **windows runner** job
（它们起真的 Wails 窗口 + WebView2，靠 CDP 派发真鼠标键盘事件，Linux/macOS 上没有这套东西），
失败的 job 会上传当时的截图与实例日志作为工件。

界面回归走 CDP 真鼠标键盘事件（不靠人点，也不信假数据）：

```bash
bash scripts/verify-restart.sh 9256 focus && bash scripts/seed-focus.sh && node scripts/check-focus.mjs 9256
```

| 脚本 | 覆盖 | 项数 |
| --- | --- | --- |
| `check-modal.mjs` | 新建/详情弹窗逐面板（日期、时间、重复、提醒、标签、优先级、子任务、结束）+ 班/休角标 | 66 |
| `check-habit.mjs` | 新建习惯弹窗（图标、频率、单位、情境、提醒、引导模式） | 66 |
| `check-view.mjs` | 日/周/月视图、跨天条、折叠、自定义视图、两个开关、班/休角标 | 67 |
| `check-stat.mjs` | 习惯统计四页签（含内核记录反查） | 45 |
| `check-memo.mjs` | 备忘录（列表、编辑器、文件夹、回收站、搜索排序） | 81 |
| `check-focus.mjs` | 专注三计时器 + 关联任务 + 沉浸/结算/详情 + 数据页（含番茄真等 62 秒）+ 跨设备接管 | 106 |
| `check-mask.mjs` / `check-account.mjs` | 遮罩与层级、头像菜单与个人中心、节假日数据交代、系统通知链路、备份入口 | 23 / 32 |

种子与断言一律用**相对日期**（`scripts/lib/d.mjs`：本周一 `m N` / 今天 `d N`），所以脚本跑在哪一天都成立；
每个脚本都要按它开头注释里的 start tab 重启实例后再跑，共用实例会被上一个脚本的页面状态污染出假失败。

## 发布

推一个 `v*` 标签就会出包（也可以在工作流页面手动触发，手动触发产出预发布版本）：

```bash
git tag v0.1.0 && git push origin v0.1.0
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) 在单个 ubuntu runner 上交叉编译六个目标，
打 zip 与 sha256，然后创建 GitHub Release 并挂上产物：

| 产物 | 构建标签 | 状态 |
| --- | --- | --- |
| `planfordo-windows-amd64.zip` | `production`，GUI 子系统（不弹控制台） | **已实测**（主力平台） |
| `planfordo-windows-arm64.zip` | 同上 | 编译通过，未在 ARM 机上跑过 |
| `planfordo-linux-amd64.zip` / `-arm64` | `production purego` | Wails 的 CGO-free 实验后端；运行时仍需系统 WebKitGTK，未实测 |
| `planfordo-darwin-amd64.zip` / `-arm64` | `production purego` | 未签名（Gatekeeper 会拦），未实测；正式 macOS/iOS 打包见 [docs/ios-testflight.md](docs/ios-testflight.md) |

## 已知限制

真正还缺的，按优先级：

1. **附件字节同步**：通道之间只同步附件元数据，换设备看不到事项图片。
   备用路径：备份文件勾「连附件一起导出」可以带过去（见设计文档 §27），但那不是同步。
2. **系统原生通知的横幅**：提醒到点/番茄轮次切换确实送进了 Windows 通知库（已验证），
   但未打包程序还差一个带 AppUserModelID 的开始菜单快捷方式，横幅才会画出来；
   那段 COM 注册在本机看不到效果，所以没提交。真机或打包安装后可解（§26）。
3. **macOS / iOS 打包**：需要 Mac 与开发者账号，iOS 后置；darwin 产物未签名、未实测。
4. **账号体系**：没有云端账号，个人中心与登录入口是占位；同步靠通道（飞书 / WebDAV / 本地文件夹）。
5. **关掉应用期间不继续计时**：这是设计（恢复时最多补一个心跳周期），不是缺陷。

已收口（2026-11-08）：法定节假日与调休（内置 2025–2027，§25）、系统原生通知的投递（§26）、
口令加密的备份与恢复（§27）、专注的跨设备互斥（§28）。细节都在
[docs/design-reference.md](docs/design-reference.md)。

## 许可证

[GNU GPLv3](LICENSE)（见仓库根 `LICENSE`）。你可以自由运行、研究、修改和再分发本程序；
**任何分发修改版的义务是同样的**：必须公开对应的完整源代码并保留本许可证（GPL-3 的 copyleft），
网络服务除外（若想要 AGPL 那种「云服务也得开源」的强度，另行说明）。

依赖的许可证与本项目的 GPL-3 兼容：Wails v3 与 `modernc.org/sqlite` 为 MPL-2.0（文件级 copyleft，可与 GPL 组合作品共存），
React/Vite 等为 MIT。各依赖保留各自的许可证文件。

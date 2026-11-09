# 架构与技术选型

本文记录已确认的决策与其依据。产品能力范围见 [reference-zomoplan.md](reference-zomoplan.md) 第 6 节。

**产品名：功到**（取「功到自然成」，对应这个产品的主张——量定小、做得完、自然成）。
用户可见处只有四个：窗口标题（`main.go`）、页面标题（`frontend/index.html`）、安装包与 iOS 显示名
（`build/config.yml` 的 `productName` / `displayName`）、左栏单字 logo（`chrome.tsx` 的「功」）。
仓库目录、Go module、二进制与 CLI 目前仍是 `planfordo` / `plando`，数据目录也是 `planfordo`：
改名要连带迁移 `%APPDATA%/planfordo` 里的现有数据，作为单独一次变更处理，不与界面文案混在一起改。
「朝暮计划」只是参考产品，出现在对照说明里，不作为本产品的名字或标识。

## 1. 一句话架构

**一个纯 Go 内核（`internal/core`）+ 三种薄壳（Wails 桌面、Wails iOS、`plando` CLI）**，
前端只有一套 React + Vite + TS。壳只做平台适配（窗口、通知、路径、生命周期），
业务规则、存储、同步全部在内核里，壳可以随时被替换或删掉而不丢功能。

依赖方向单向，内核不允许 import 任何 UI/框架包：

```
frontend (React) ──bindings/events──> app (Wails shell) ──> internal/core ──> 磁盘
cmd/plando (CLI) ─────────────────────────────────────────────┘
core/sync/channel/*  ── 飞书 Base / 飞书云盘 / WebDAV / 本地文件夹
```

## 2. 已确认决策

| 决策 | 取值 | 依据 |
|---|---|---|
| 框架 | Wails **v3**（本机 CLI 实测 v3.1.0） | 只有 v3 有 iOS/Android 支持；v2 打不了手机包 |
| iOS | 后置。当前只在 Windows 开发，代码按 iOS 可构建写 | 用户手上没有 Mac；v3 打 iOS 包强制 macOS + 完整版 Xcode |
| 内核 CGO | 必须 CGO-free | 本机 `CGO_ENABLED=0` 下 doctor 全绿即可构建；iOS 侧 CGO 是长期包袱 |
| 存储 | `modernc.org/sqlite`（纯 Go SQLite） | CGO-free、单文件、可跑 iOS；比 JSON 文件更适合按日分桶与打卡统计查询 |
| 同步 | 可插拔 `SyncChannel`；落地 飞书多维表格 + 飞书云盘 + WebDAV + 本地文件夹 | 用户选的；本地文件夹通道让没有凭证时也能多设备验证 |
| 冲突 | 记录级 LWW（`updatedAt`），删除用 tombstone | 单人多设备，字段级合并和 CRDT 都是不必要的复杂度 |
| 第一里程碑 | 内核与桌面壳并行 | 用户选的 |
| 暂缓 | 日历视图、备忘录、番茄钟、账号体系、会员、图片云存储 | 见 reference 第 6 节 |

## 3. 目录结构

```
go.mod                      module planfordo（Wails v3 项目在仓库根，main.go 在根是它的默认布局）
main.go / api.go            Wails v3 壳：解析目录 → 开内核 → 把 API 注册成服务 → 转发事件
internal/core/              纯 Go 内核，可独立编译与单测，不 import 任何 UI 框架
  model/        ✓           领域对象 + 确定性主键
  id/           ✓           可排序 ID
  tclock/       ✓           UTC 定宽时间戳的发号与比较
  repeat/       ✓           重复规则 → 实例序列 + override 叠加
  store/        ✓           SQLite(CGO-free)、迁移、entity 表读写、同步水位
  service/      ✓           用例层：清单/习惯/统计/提醒计算；Wails 绑定的就是这层的方法
  sync/         ✓           快照、LWW 合并引擎、Channel 接口、localdir 通道、通道配置 Manager
    channel/                feishu（多维表格 + 云盘）/ webdav —— 各自 Install() 注册
cmd/plando/     ✓           同一内核的 CLI（today/add/clock/postpone/habits/sync/channel…）
frontend/                   React + Vite + TS（Wails react 模板起步）
build/ Taskfile.yml          Wails 构建任务，含 ios/android 的 Taskfile（在 Mac 上才有用）
docs/                       本目录
```

`internal/core/calendar/` 是节假日与农历数据源（实现 `repeat.HolidaySource`，内置年度表 +
本机覆盖，见第 11 节第 2 条）。`internal/notify/` 是系统原生通知的落地层（Windows 有实现、
其它平台空实现），提醒时刻本身仍算在 `service/reminders.go`，壳层在到点时两边都发。

## 4. 时间模型（最容易做错的部位）

- `Day` 是**本地日历日**字符串（`2026-11-05`），打卡、逾期、重复命中一律按本地日算。
  用 UTC 日会让跨时区设备把同一天算成两天。
- 所有**绝对时刻**（`createdAt/updatedAt/deletedAt/clockedAt`）统一存 UTC 定宽串
  `2026-11-05T09:42:03.512Z`（`internal/core/tclock`）。这样字典序即时间序，LWW 可以直接比字符串；
  带本地偏移的 RFC3339 会让「17:42+08:00」和「09:42Z」这两条同一时刻的记录比出大小，同步就错了。
  展示时由前端换算回本地时区。
- **墙钟**语义（提醒的「当天 09:00」、习惯日志的时间列）单独存 `HH:MM`，绝不与绝对时刻混用。
- `updatedAt` 由内核统一发号：`store.Tick` 取 `max(当前时间, 上次发号 + 1ms)` 并把水位持久化，
  保证本机单调递增。直接用 `time.Now()` 会让同毫秒的两次写无法比较，系统时钟回拨更会让新改动
  永远输给旧改动。比较走 `tclock.IsNewer`，同刻用 payload 字典序破平局（两端对称，才会收敛）。
- 设备间时钟不可信：合并只保证最终一致，不保证「谁赢」符合直觉。

## 5. 存储

- 一个 SQLite 文件（`planfordo.db`）+ 一个 `attachments/` 目录（图片走本地文件，不进库、不进同步快照，
  附件内容经通道的 blob 归档单独搬运，见 §7）。
- **所有实体共用一张 `entity` 表**：`(kind, id)` 主键，业务字段进 `data`(JSON)，另有
  `updated_at / deleted_at / day / parent / status / sort` 派生列。选一张表而不是十二张表的原因：
  同步引擎要统一枚举全量记录，UI 演进要频繁加字段——扁平表让加字段不用写迁移，
  只有派生列变化才动 DDL。代价是类型转换要过 JSON，以及 `NewEntity` 里那张按 kind 抽派生列的 switch
  （新实体类型漏加会直接报错，不会静默漏数据）。
- 迁移：`internal/core/store/migrations/*.sql` 按文件名顺序执行，记账在自建的 `migration` 表里
  （不记在 `meta`，否则「读 meta 时表还没建」会自举死锁）。禁止在代码里拼 DDL。
- 软删除：`deleted_at` 非空即 tombstone；物理清理只在 `CompactTombstones` 里做，
  且必须确认所有通道都推过，否则删除会在一端消失、在另一端复活。
- 数据目录由壳解析后注入内核（`os.UserConfigDir()/planfordo`，`PLANDO_DATA_DIR` 可覆盖）。
  iOS 上这就是 app container 内的可写路径，所以内核不猜路径这件事是硬要求。

## 6. 重复事项怎么存

本体只存一条 `ListItem`，`OccurrenceOverride` 存单日例外（打卡 / 跳过 / 顺延）。
读取某天列表时由 `repeat.Occurrences(item, from, to)` 展开实例，`repeat.Materialize` 再叠加 override。

不采用「每天物化一条」的做法：物化会让同步冲突面变大，改一次规则要重写历史，
「永不结束」的重复也无法物化。代价是展开必须是纯函数且有测试覆盖，包括
跨天智能重复、法定节假日跳过、艾宾浩斯序列、按次数结束（次数含首次）。

override 与「每天一次」习惯的打卡记录用**确定性主键**（`model.OverrideID` / `model.DailyClockID`，
形如 `ovr:<itemId>:<day>`）：两台设备同一天各打一次卡会落进同一行、由 LWW 收敛成一条，
而不是同步回来两条把统计翻倍。

修改重复事项的作用范围（朝暮的三选一）用「截断 + 新建段」实现，见 `service.SaveItem`：

| scope | 效果 |
|---|---|
| `all` | 直接改本体，历史与未来一起变 |
| `thisAndFuture` | 本体结束日改成 day-1，再以 day 为锚点新建一条带**编辑后规则**的事项 |
| `thisDay` | 本体结束日改成 day-1；day 当天建一条不重复的新事项；day+1 起重启一条**原规则**的续接段 |

`thisDay` 会忽略对重复规则本身的改动（改一天不该改写未来节奏），UI 要在这个选项下禁用规则选择器。

## 7. 同步协议

通道只需要**对象存储**语义——读一份快照、写一份快照，远端不参与合并计算。
这是让「飞书多维表格 / 飞书云盘 / WebDAV / 普通文件夹」共用一个引擎的前提，也是它们能互相兜底的原因。

```go
type Channel interface {
    Name() string
    Kind() string
    Probe(ctx) error                    // 连通性与写权限，设置页「测试连接」用
    Load(ctx) (*Snapshot, error)        // 远端全量；没有时返回空快照而不是报错
    Save(ctx, *Snapshot) error          // 写回全量
}
type ConditionalChannel interface {
    Channel
    SaveConditional(ctx, *Snapshot, expectRevision int64) error  // 支持 ETag 的通道实现
}
// 可选：能存整块二进制对象的通道才实现；feishuBase 明确不实现
type BlobChannel interface {
    LoadBlob(ctx) (*BlobArchive, error)   // 远端没有归档时返回空归档
    SaveBlob(ctx, *BlobArchive) error     // 无条件覆盖，归档恒为并集
}
```

`Snapshot = { schema, deviceId, syncedAt, revision, records[] }`，records 就是 `store.Entity`，
**含 tombstone**（删除必须能传播）。

一轮同步（`Engine.Run`）：`Load` 远端 → 逐条 LWW 合入本地 → **合并之后**用 blob 归档补本机缺的
附件字节（并把本机独有的字节并回归档）→ 导出本地全量 → `Save` 并集回去 → 落水位。
合入并回推「并集」而不是「只推自己改的」，是因为飞书表格这类通道没有事务与锁，
两端都推并集才能保证第三方设备下一轮拿到完整状态。

冲突策略：记录级 LWW（比 `updated_at`，同刻比 payload 字典序，规则两端对称才会收敛）。
不询问用户，只把冲突条数报给 UI。删除靠 tombstone + `CompactTombstones` 的保留期（默认 90 天）控制快照体积。

### 附件字节：可选的 `BlobChannel`

快照里只有附件元数据（`kind=attachment` 的行），文件本体单独装成一份
`planfordo-blobs.json`：`{ schema, blobs: { "<文件名>": { sha256, size, dataBase64 } } }`。
用 JSON + base64 而不是 zip，是为了不破坏「通道只需对象存储语义」这个前提，
飞书云盘 / WebDAV 上还能直接打开人工检查；代价是 4/3 膨胀。

- 键是 `path.Base` 压平后的文件名，写盘只允许落在 `dataDir/attachments/`，
  与备份导入同一套防穿越规则；`sha256`/`size` 对不上的条目跳过，绝不写坏图。
- 引擎在**记录合并之后**枚举本地全部存活的附件行：本地缺（或留下半截文件）就从归档补，
  本地有而归档没有就并回归档。顺序保证界面看到新附件时字节已经落盘。
- 归档是并集、不做 GC（另一台设备可能还引用）；写回前再 `LoadBlob` 一次只补不删，
  缩小 read-merge-write 竞态窗口，残留窗口里丢的那份字节仍在它本机磁盘上，下一轮自愈。
- **可选增强**：通道不实现 `BlobChannel`（feishuBase）、或调用方没注入 `dataDir` 时整条跳过；
  归档损坏、超限、网络失败只写进 `Result.BlobsSkipped`，记录同步照常完成。
- `localdir` / `webdav` / `feishuDrive` 各自实现：`localdir` 走原子写，
  `webdav` 走同目录 GET/PUT（不碰快照的 ETag 校验值），`feishuDrive` 把「单文件对象」
  抽成 `driveObject`，快照与归档各有独立文件名与临时名前缀，覆盖写互不清理。
- **飞书云盘的覆盖写**（2026-11-09 修正）：v1 没有可用的改名接口（`/rename` 实测 HTTP 404），
  同名文件重复上传只会并存第二份。因此改成「以正式名直传 → 再列一次目录 → 按 `file_token`
  精确删掉其它同名与历史临时残留」，不再有「删旧后改名发布」的空窗；上传后再列目录是为了
  把并发期间另一轮写入的同名副本也清掉（否则 `pushed=0` 时引擎跳过 Save，重复文件永远没人清）。
  旧版失败轮留在云盘里的 `.planfordo-tmp-*` 也会被新代码回收。
- **feishuBase 明确不支持**：多维表格只有文本/数字列，没有二进制对象语义，把 base64 塞进
  单元格会撞长度上限；需要跨设备带图片请改用另外三条通道或备份文件。

已知取舍与限制：
- **全量快照**：个人数据量级（几千条）下最简单可靠；真涨到需要增量时再换协议，通道接口不用动。
- **读-改-写竞态**：两台设备同时在 `Load` 与 `Save` 之间插入，后写者可能抹掉先写者的新增记录；
  支持 ETag 的通道走 `SaveConditional` 直接拒写重来，不支持的（飞书表格）靠「两端都推并集」在下一轮自愈。
- 飞书多维表格是**单向权威**：本地是主库，表格里手改可读列不会回流，下一轮被本地覆盖。
- 凭证（`app_id/app_secret`、WebDAV 密码）只从配置读，存在本机 `meta`，绝不进快照；同步内容默认明文
  （多维表格才有可读价值），加密通道待议。
- 多通道串行同步，不并发写同一个库。
- **单份 blob 归档 14MB 原始字节上限**：归档是 base64 JSON，上传体积约 4/3；
  飞书 `upload_all` 卡 20MB 上传文件（14MB → 约 18.7MB，留结构开销），
  WebDAV 客户端读响应 32MB 反而更宽。读写两侧都校验，超了明确报 `ErrBlobTooLarge`，
  不让服务端静默截断；单个 50MB 附件或总量更大时走「连附件一起导出」的备份文件。

## 8. 提醒

内核 `notify` 计算未来窗口内的提醒触发点（绝对时刻列表），壳负责落地：
桌面用 Wails notifications + 一个常驻定时器；iOS 用移动端本地通知 API 预排下一批（系统有 64 条上限，
所以每次应用激活时重排）。iOS 后台不会跑 Go 定时器，因此提醒必须「预排」而非「到点算」。

## 9. 前端

- React 19 + Vite + TS，`@wailsio/runtime` 调 Go 服务与订阅事件。
- **bridge 抽象**：`frontend/src/bridge` 是唯一知道「怎么调内核」的地方，提供两个实现——
  Wails 运行时 和 浏览器内存 mock（`npm run dev` 不开 Wails 也能调 UI）。
  这条也为将来 iOS 之外的端（小程序 / Web）留了口子。
- 状态：zustand（够小）。样式：CSS 变量 + 一份全局样式表，换肤＝改变量，不引 UI 框架。
- 依赖安装走 `frontend/.npmrc` 指到 `registry.npmmirror.com`，不用全局改 npm 配置。

## 10. 本机环境实测（2026-11-05）

- go1.27.3、node v24.14.1、npm 11.11.0、`GOPROXY=https://goproxy.cn,direct`
- `wails3` v3.1.0 安装成功（`go install` 需先 `go clean -cache`，旧缓存会报 `can't find export data`）
- `wails3 doctor`：**No issues found / ready for Wails development**，`CGO_ENABLED=0`、WebView2 156.0.4314.58
- 未安装：gcc/MinGW（不需要）、Android SDK、NSIS/SignTool（打包安装器时才需要）
- **macOS 二进制可在 Windows 交叉编译**：`GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -tags purego .`
  实测通过（24MB）。Wails v3 对 darwin 有 build guard：不加 `-tags purego` 就要求 CGO_ENABLED=1，
  所以在 Windows 上必须带这个 tag。`.app` 打包、签名与公证仍只能在 Mac 上做。
- iOS 打包：需 macOS + 完整版 Xcode + Apple 开发者账号 → 见 [ios-testflight.md](ios-testflight.md)
  （流程已写，**未经 Mac 实测**）
- 内核交叉编译已验证：`GOOS=ios GOARCH=arm64 go build ./internal/...` 通过，说明 CGO-free 约束成立

### 10.1 界面自检入口（不碰鼠标也能验证真实 UI 路径）

两个只影响调试的环境变量，正式使用不设置就是默认行为：

- `PLANDO_START_TAB=lists|habits|settings`：启动直接进指定页，省掉「先点一下」的动作。
- `PLANDO_CDP_PORT=9231` + `PLANDO_WEBVIEW_PROFILE=<空目录>`：打开 WebView2 远程调试口。
  必须同时给一个**独立且新建的** profile 目录——WebView2 会复用同一 user-data-folder 里
  已经活着的浏览器进程，复用时会直接忽略 `--remote-debugging-port`（实测踩过两次）。
  端口只接受 4–5 位纯数字，其它值按「没开」处理，避免把任意字符串拼进浏览器命令行。

配套脚本：`scripts/cdp.mjs`（eval / click / type / key 四种模式，走真实鼠标与键盘事件）、
`scripts/verify-channel.mjs`（设置页从零配一条 localdir 通道并同步）。
用它点过一次就抓到一个纯逻辑测试抓不到的 bug：`SettingsPage` 的配置项输入框写的是
`[k]: v`，受控值永远回退，等于「通道参数根本输不进去」——见 2026-11-06 的修复。

## 11. 还没定的事

按「先跑起来，再补」排序：

1. **飞书多维表格要不要回流**：第一版本地是主库，表格里手改可读列不回收，下一轮被覆盖。
   要支持「在飞书里改」得给标题/日期/打卡状态定字段映射，作为独立里程碑。
2. ~~**法定节假日与调休数据**~~（已做，2026-11-08）：`internal/core/calendar/data/<year>.json`
   内置 2025/2026/2027 三年（逐条核对国务院办公厅通知原文，含每天括注的星期），
   `calendar.Open(dataDir/calendars)` = 内置打底 + 本机同名年份整年覆盖；
   `SkipLegalHolidays`、`FollowMakeupWorkday`、「法定工作日」预设与日期面板/视图的「班/休」角标都吃这一份数据。
   表没覆盖的年份（2028 起）仍然退化成普通周一至周五——**程序不替官方猜日历**，
   设置页「节假日与调休」把覆盖年份、出处、核对日期与导入目录都摊开给用户看。
   每年 11 月官方公布下一年安排后，加一个 `data/<year>.json` 即可（`calendar_test.go` 的
   `TestBuiltinTablesAreValid` 会按条数与星期校验，写错星期或漏一天都过不去）。
3. **系统通知**（2026-11-08 做了一半，剩下的那一半卡在 Windows 的注册要求上）：
   `internal/notify` 已经落地——提醒轮询到点、番茄钟轮次切换、倒计时到点都会送系统通知，
   设置页有开关（`Settings.QuietNative`，零值即默认开）与「测试通知」，
   `main.go` 认 `-ToastActivated` 直接退出，免得点通知时开出第二个实例去抢同一个 SQLite 库。
   实现走 Wails 自带的通知服务（底层 `go-toast`，纯 syscall/COM，CGO-free 不破）。
   **已验证**：界面点「测试通知」→ 内核返回成功 → 系统通知库
   （`%LOCALAPPDATA%` 下 `Microsoft/Windows/Notifications/wpndatabase.db`，必须连 `-wal` 一起查）
   里确实有我们发出的记录，含应用触发的那条。
   **没验证到**：横幅本身在这台精简版 Windows VM 上三次定时全屏截图都没画出来。
   原因定位到未打包程序的硬性要求——开始菜单里必须有一个带同一 AppUserModelID 的快捷方式，
   Windows 才肯把 toast 归属给这个应用并画横幅（只写注册表 `AppUserModelId` 那一条不够）。
   补这段代码要动用户的开始菜单、而本机又看不到效果，所以先不写；
   等能在真机上验证到横幅再补，或者改走打包安装（MSIX / 安装器会顺带把 AUMID 注册好）。
   iOS 那半边仍是「应用激活时把 `UpcomingReminders` 预排成本地通知」（系统 64 条上限）。
4. **附件同步**（2026-11-08 已做）：事项图片落 `dataDir/attachments`、经 `/attachments/<file>`
   显示（上限 5 张），字节现在随 `localdir` / `webdav` / `feishuDrive` 三条通道同步（§7 的
   `BlobChannel`），换设备不再图裂。**feishuBase 明确不支持**，且单份归档 14MB 原始字节封顶；
   归档不做 GC，长期运行后可能留着没人引用的旧字节，需要时再做清理策略。
5. **加密与导出**（2026-11-08 做了备份这一半）：与通道解耦的「口令加密全量备份」已落地
   （`internal/core/backup`：PBKDF2-SHA256 310k 轮 + AES-256-GCM，头部当 AAD；恢复是 LWW 合并、
   不清库；CLI `plando export/import` + 设置页「备份与恢复」）。
   **通道本身仍然明文**——那是刻意的：多维表格那侧要能读才有多维表格的意义。
   要不要再给 WebDAV/云盘快照加一层 AES-GCM、以及 CSV 导出，仍待定。
6. **专注的跨设备互斥**（2026-11-08 已做）：记录带 `deviceId`，另一台设备的进行中记录
   不自动恢复，界面给「接管 / 放弃」；接管会停在暂停态并留事件。见 docs/design-reference.md 第 28 节。
7. **多清单本 UI**：内核已支持 `model.List`（默认本「全部」），界面上要不要真分出多本？
   现有分组（日期/分类/四象限）已覆盖大部分需求。
8. **macOS 分发**：Go 二进制已能在 Windows 用 `-tags purego` 交叉编译（第 10 节），但 .app 打包、签名与公证必须在 Mac 上做。


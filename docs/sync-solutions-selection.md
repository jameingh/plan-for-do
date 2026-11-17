# 多端数据同步开源方案选型报告

| 项目 | 内容 |
|---|---|
| 文档版本 | v1.0 |
| 日期 | 2026-11-09 |
| 适用产品 | 功到（`plan-for-do`，Go + Wails v3 + React） |
| 调研口径 | 开源、多端（桌面 / iOS / Android / Web）、小数据量免费、可集成 |
| 状态 | **决策建议，未实施**；本次调研未改动任何代码 |
| 引用方式 | `[Rnn]` 外部资料、`[Inn]` 项目内部文件，索引见第 10 节 |

> 本文只写「事实」与「判断」两类内容，并区分标注。所有价格、授权、额度均标注来源与核验等级；
> 供应商条款会变动，采购或实施前须按第 9 节复核。相关背景见 [architecture.md](architecture.md)。

---

## 0. 摘要（TL;DR）

**结论：本项目不需要更换同步引擎，缺的是通道，不是引擎。**

1. 「小数据量免费」有歧义，必须先分清两种口径：**(a) 零服务器成本**（借免费云存储只传快照）与 **(b) 软件开源免费**（自托管，但仍需一台机器）。本项目当前属于 (a)，且已实现完整闭环。
2. 对本项目存在一条**硬门槛**：内核使用纯 Go 的 `modernc.org/sqlite`，不支持加载 SQLite 扩展，且架构决策要求 CGO-free [I1][I5][R27][R28]。因此 cr-sqlite、PowerSync 客户端 SQLite 扩展、Turso embedded replica 等「在 SQLite 层做同步」的方案全部无法直接接入，换驱动会破坏 Windows 静态构建与 iOS/Android 交叉编译。
3. 现有 `Channel` 抽象只需 `Load/Save`（可选 `SaveConditional`、`LoadBlob/SaveBlob`），合并语义（全量快照 + 记录级 LWW + tombstone）已经稳定 [I2][I3]。引入 PouchDB / RxDB 会与 Go 侧 SQLite 形成**双主数据源**，收益远小于风险。
4. 推荐路线分三档：**档 1** 免费 WebDAV 网盘或 Cloudflare R2（零改造）；**档 2** 有实时多端需求时加 PocketBase 通道；**档 3** 仅当业务形态变为「多人协作 / 移动端重度离线」才评估 CouchDB+PouchDB 或 PowerSync（重写级）。
5. 按项目既有的增量同步决策 [I6]，升级触发阈值为：记录 > 2 万 / 压缩后快照 > 5MB / 改为自动定时同步 / 设备 > 3 台 / 移动端按流量计费 / 同步耗时被投诉。**当前均未触发，应停在档 1。**

---

## 1. 背景与需求定义

### 1.1 项目现状（代码级事实）

| 维度 | 事实 | 依据 |
|---|---|---|
| 架构 | 纯 Go 内核 `internal/core` + 三种薄壳（Wails 桌面 / Wails iOS / CLI），前端一套 React 18 + Vite + TS | [I1][I5] |
| 依赖 | `go 1.27.3`、`wails/v3 v3.1.0`、`modernc.org/sqlite v1.61.1`；**无任何第三方同步库** | [I5] |
| 存储 | 单文件 SQLite `planfordo.db` + `attachments/`；实体共用 `entity(kind,id)` 表，`data` 存 JSON，派生列含 `updated_at/deleted_at` | [I1][I7] |
| 时间模型 | 绝对时刻为 UTC 定宽串，字典序即时间序；`store.Tick` 保证本机单调递增；同刻按 payload 字典序破平局 | [I1] |
| 同步协议 | `Snapshot{schema=1,deviceId,syncedAt,revision,records[]}`，Records 含 tombstone；远端 schema 更高时拒写 | [I2] |
| 同步算法 | `Engine.Run`：拉远端 → 逐条 `db.MergeRemote` LWW 合并 → 导出本地全量 → 推「并集」写回、`revision+1` | [I2] |
| 并发保护 | 支持 ETag 的通道实现 `ConditionalChannel.SaveConditional(expectRevision)`，防止读-改-写竞态 | [I2] |
| 通道 | `localdir` / `webdav` / `feishuDrive` / `feishuBase` 四种；Manager 提供 `SyncOne/SyncAll/Probe` | [I1][I4] |
| 附件 | 可选 `BlobChannel`，固定文件名 `planfordo-blobs.json`，JSON + base64（4/3 膨胀），`MaxBlobBytes = 14 << 20`（14MB），校验 sha256/size，并集不 GC | [I3] |
| tombstone | 快照中保留 90 天（`TombstoneRetention = 90`），物理清理走 `CompactTombstones` | [I2][I7] |
| 规模 | 2026-11-09 实测默认库 52 行、data 14.7KB、快照 JSON 约 22KB；一轮同步 = 1 GET + 1 PUT | [I6] |
| 界面出口 | 设置页「同步通道」；`api.go` 暴露 `SyncNow/SyncChannels/SaveSyncChannel/ProbeSyncChannel/SyncState`，事件 `sync:done` / `data:changed` | [I1][I7] |

### 1.2 需求与验收口径

| 编号 | 需求 | 是否硬性 | 说明 |
|---|---|---|---|
| N1 | 开源（OSI 认可的许可证）或协议开放、自控数据 | 硬 | 不得被单一厂商锁定 |
| N2 | 多端：Windows 桌面优先，iOS/Android 后置但需可构建 | 硬 | 见 [I1] 的 iOS 后置决策 |
| N3 | 小数据量零或近零成本 | 硬 | 目标是 MB 级数据、单人 2–3 台设备 |
| N4 | 离线可用、最终一致、删除可传播 | 硬 | 当前 LWW + tombstone 已满足 |
| N5 | 不引入需要 CGO 的依赖 | 硬 | 架构决策 [I1] §2 |
| N6 | 改动局限在 `core/sync/channel/*`，不动合并引擎 | 软 | 降低回归风险 |
| N7 | 实时（秒级）多端变更通知 | 软 | 当前为手动/定时同步 |
| N8 | 字段级自动合并 / CRDT | 否 | 单人多设备，明确不必要 [I1] §2 |

### 1.3 关键歧义：「免费」的两种口径

| 口径 | 含义 | 真实成本 | 代表方案 |
|---|---|---|---|
| **(a) 零服务器成本** | 借用现有免费云存储，客户端自管快照 | $0，仅需注册账号 | WebDAV 免费网盘、Cloudflare R2 |
| **(b) 软件开源免费** | 自托管开源服务端，无授权费 | VPS + 运维；小数据量约 $5–6/月（1 核 1GB）[R29] | CouchDB、PocketBase、ElectricSQL、PowerSync Open Edition |
| **(c) 云免费额度**（易混淆） | 厂商免费档，通常带闲置停用条款 | $0 但有条件 | PowerSync Cloud Free、Supabase/Turso/D1 Free |

**判断**：用户诉求「小数据量免费」最可能指 (a) 或 (c)；但 (c) 的闲置停用条款对「几个月不打开一次」的待办应用是真实风险（见 §7），因此本报告优先推荐 (a)。

### 1.4 不在本报告范围

- 端到端加密方案设计（当前通道未实现，属独立议题）。
- 多人协作的字段级冲突 UI。
- 具体代码实现与 PR；本文仅给实施建议与验收点。

---

## 2. 候选方案全景

### 2.1 A 类：存储 / 通道型（无同步引擎，客户端自管快照）

**A1 · 免费 WebDAV 网盘**（项目已实现 WebDAV 通道 [I4]）

| 服务商 | 免费额度 | 备注 |
|---|---|---|
| Koofr | 10GB 永久免费、不限流量 | 应用专用密码；欧洲节点 [R19][R20] |
| InfiniCLOUD | 20GB（邀请码可 +5GB） | 日本节点；长期不活跃可能删号 [R19] |
| 坚果云 | 约 1GB 存储，月上传 1GB / 下载 3GB | 国内最稳；单文件 ≤500MB、30 分钟 ≤600 请求 [R20] |
| 中科院数据胶囊 | 20GB 永久免费（实名后） | 国内节点，禁商用 [R20] |

> 免费额度为 2026 年公开资料汇总 [R19][R20]（C 级），**注册前以服务商官网当日条款为准**。

**A2 · Cloudflare R2（S3 兼容对象存储）**：官方免费档为 10 GB-month/月存储、100 万次 Class A（写/列）、1000 万次 Class B（读）操作，出流量免费；删除操作免费 [R15][R16]（A 级）。对本项目的 22KB 快照，一轮同步消耗 1 次 A 类 + 1 次 B 类，免费额度实质等于无限使用。

**A3 · 免费云端数据库额度**：Turso 5GB / 5 亿行读·1000 万行写每月；Cloudflare D1 5GB / 每日 500 万行读·10 万行写；Supabase 500MB × 2 项目、闲置 7 天暂停 [R17][R18]（C 级）。**这些是远端数据库，不是同步引擎**，只能当快照存储用，且需自行实现客户端。

**A4 · Git 仓库作为快照版本库**（补充思路）：GitHub/GitLab 免费私有仓库可存 JSON 快照，天然带历史与冲突可见性；但移动端缺 git 运行时、合并需人工，仅适合桌面之间。

**A5 · Syncthing**：MPL-2.0、P2P、真 $0 [R30]。**属文件级同步，不是结构化记录同步**；且不能同步「正在运行的 SQLite 文件」（WAL 未 checkpoint 会损坏），只能同步导出后的快照文件；iOS 无官方客户端 [R30]。因此被硬门槛排除。

### 2.2 B 类：轻量自托管后端

**B1 · PocketBase**：官方仓库自述为「Open Source realtime backend in 1 file」，Go 编写，内嵌 SQLite + realtime subscriptions + 文件/用户管理 + Admin UI + REST-ish API；明确 **MIT 许可**，且警告 **v1.0.0 前不保证向后兼容**；可作为 Go 库嵌入自有二进制，`CGO_ENABLED=0 go build` 可得静态可执行文件 [R06]（A 级）。官网亦展示 `pb.collection(...).subscribe('*', …)` 的 SSE 实时订阅用法 [R07]。

> **适配判断**：与本项目技术栈同源（Go + SQLite + CGO-free），最贴合「只加一个 Channel」的诉求。它不提供冲突合并，但本项目已有 LWW，恰好互补。

**B2 · Apache CouchDB + PouchDB**：CouchDB 官网明确主打「Seamless multi-primary sync」与 Couch Replication Protocol，数据可从服务器集群流向手机与浏览器，支持 offline-first；官网亦明确 CouchDB 面向服务端、PouchDB 面向移动端与浏览器，两者可无缝复制 [R12]（A 级）；复制协议的检查点与修订树定义见官方规范 [R14]。PouchDB 的 `sync(remote, {live:true, retry:true})` 支持断点续传、`since` 检查点、`batch_size` 批处理与断网退避重连 [R10][R11]（A 级）。授权为 ASF 项目标准的 Apache-2.0（本轮核验的官网首页未直接列出许可证文本，列为 B 级待复核）。资源参考：空载 200–300MB，1 核 1GB 可支撑单人 2–3 台设备，磁盘按库 3–5 倍预留（因保留每次修订）[R29]（C 级）。

> **适配判断**：唯一「端到端全开源 + 协议级双向增量」的成熟方案，但 Go 生态没有 PouchDB 等价物；要么让 React 前端跑 PouchDB（与 Go 侧 SQLite 形成双主数据源），要么在 Go 侧自行实现复制协议 —— 两者都是重写级。

### 2.3 C 类：完整同步引擎

**C1 · PowerSync**：服务端从源库（Postgres / MongoDB / MySQL / SQL Server / Azure DocumentDB）复制变更，客户端 SDK 维护本地 SQLite 与持久化上传队列，读写均可在离线完成 [R03]（B 级）。客户端 SDK 与 SQLite 扩展为 Apache-2.0；**Open Edition 的 PowerSync Service 现为 Apache-2.0 开源**，历史版本曾用 FSL，每个 FSL 版本发布两年后额外获得 Apache-2.0 授权 [R01]（A 级，官网原文核验）。

官方定价 [R02]（A 级）：

| 档 | 价格 | 同步量/月 | 托管数据 | 峰值并发 | 闲置 |
|---|---|---|---|---|---|
| Free | $0 | 2 GB | 500 MB | 50 | **1 周不活跃即停用** |
| Pro | 从 $49/月 | 30 GB（超出 $1/GB） | 10 GB | 1,000 | 不停用 |
| Team | 从 $599/月 | 30 GB | 10 GB | 1,000 | 不停用 |

自托管 Open Edition 免费，但需自备源数据库并运维逻辑复制（Postgres 需 `wal_level=logical`）；写回路径由开发者实现 `uploadData()`，冲突默认按字段 LWW、删除优先 [R23]（C 级）。

**C2 · ElectricSQL**：官方 README 原文「Real-time sync for Postgres」「Electric is a read-path sync engine for Postgres」，许可证徽章为 Apache-2.0，要求 Postgres 开启逻辑复制，通过 Shapes 做部分复制 [R04]（A 级）。官方 writes 指南明确「Electric does not do write-path sync」，写入需自行实现，给出 online writes / optimistic state / shared persistent optimistic state / through-the-database sync 四种模式，并指出两大复杂点是 **merge logic** 与 **rollbacks** [R05]（A 级）。自托管 Apache-2.0 无授权费 [R26]（C 级）；2026-08 宣布并入 Databricks（Neon/Lakebase 团队）、Electric Cloud 托管服务收缩 [R21]（C 级，需复核）。

**C3 · RxDB**：核心 Apache-2.0 免费，但官方定价页明确免费档**最多 13 个并行打开的 collection**，OPFS/SQLite/Filesystem 存储、WebCrypto 加密、全文检索均在 Pro（从 $99/月，年付）及以上；Pro Plus 从 $239/月 [R09]（A 级页面、B 级摘录）。定位为客户端库，服务端 replication 端点需自建 [R24]。

**C4 · 其他简评**：WatermelonDB（MIT，但主分支最后提交约 2025-08，维护放缓 [R22] C 级）、Triplit（AGPL-3.0、社区规模小 [R21] C 级）、Zero / LiveStore（绑定 Postgres 或事件流模型，迁移成本高 [R21] C 级）。均不进入短名单。

### 2.4 已淘汰

**Realm / Atlas Device Sync**：MongoDB 官方公告明确 Atlas Device Sync、Atlas Device SDKs (Realm) 等于 **2025-09-30 停止支持并移除**，官方建议迁移至 Ditto、PowerSync、ObjectBox 等替代方案 [R13]（A 级）。**不得再纳入候选。**

---

## 3. 关键事实核验表

| 编号 | 事实 | 结论 | 来源 | 等级 |
|---|---|---|---|---|
| F1 | PowerSync Open Edition 服务端授权 | **Apache-2.0**；FSL 仅属历史版本，两年后转 Apache-2.0 | [R01] | A |
| F2 | PowerSync Cloud Free 额度 | 2GB/月、500MB 托管、50 并发、2 实例、**1 周闲置停用** | [R02] | A |
| F3 | Electric 同步方向 | **仅 read-path**，write-path 由应用自行实现 | [R04][R05] | A |
| F4 | Electric 许可证与前置条件 | Apache-2.0；Postgres + logical replication | [R04] | A |
| F5 | PocketBase 许可证 / 形态 | MIT；Go 单文件、内嵌 SQLite + realtime；pre-1.0 不保证兼容 | [R06] | A |
| F6 | CouchDB 能力 | multi-primary sync、复制协议覆盖手机与浏览器、offline-first | [R12] | A |
| F7 | PouchDB 复制 | live + retry + checkpoint + batch_size，断网自动退避重连 | [R10][R11] | A |
| F8 | RxDB 免费档限制 | ≤13 collection；SQLite/OPFS/加密需 $99/月起 | [R09] | A/B |
| F9 | R2 免费档 | 10GB-month、100 万 A 类、1000 万 B 类、出流量免费 | [R15][R16] | A |
| F10 | Atlas Device Sync 停服 | 2025-09-30 移除 | [R13] | A |
| F11 | CGO-free SQLite 不支持扩展加载 | 迁移到 `modernc.org/sqlite` 后 external loadable extensions 不再支持 | [R27][R28] | A/B |
| F12 | 免费数据库额度与闲置条款 | Turso 5GB / D1 5GB / Supabase 500MB×2；Supabase 7 天暂停、Turso 10 天归档 | [R17][R18] | C |
| F13 | WebDAV 免费网盘额度 | Koofr 10GB、InfiniCLOUD 20GB、坚果云月上传 1GB | [R19][R20] | C |
| F14 | CouchDB 自托管资源 | 1 核 1GB 可支撑 2–3 台设备；约 $5–6/月 VPS | [R29] | C |
| F15 | Electric 公司变动 | 2026-08 并入 Databricks，Cloud 收缩 | [R21] | C |

> 等级定义：**A** = 本轮直接抓取官方文档 / 仓库 / 定价页原文；**B** = 官方页面但仅经检索结果摘要获得，或事实为行业共识但页面未明示；**C** = 第三方评测 / 汇总，需以官网复核。

---

## 4. 与本项目适配性分析

### 4.1 硬约束 1：CGO-free 与 SQLite 扩展（★★★ 决定性）

- 架构决策要求内核 CGO-free，理由是 iOS 侧 CGO 是长期包袱 [I1] §2；`go.mod` 仅有 `modernc.org/sqlite v1.61.1` [I5]。
- `modernc.org/sqlite` 是 C 源码转译的纯 Go 实现，**不支持 `sqlite3_load_extension` / `.load` 外部扩展**；已有项目迁移记录明确「External loadable SQLite extensions (.load) are no longer supported」[R27]，两种 Go 驱动的差异也说明只有 cgo 驱动才具备完整扩展支持 [R28]。
- **推论**：cr-sqlite、PowerSync 客户端 SQLite 扩展、Turso embedded replica 等「挂到 SQLite 上做同步」的方案在本项目上不可直接集成。若改用 `mattn/go-sqlite3`，则 `CGO_ENABLED=0` 构建配方（Windows `-H windowsgui` 静态 exe）与 iOS/Android 交叉编译同时失效 —— 属于架构级回退，不可接受。

### 4.2 硬约束 2：Channel 抽象与合并语义已稳定

`Channel` 仅要求 `Name/Kind/Probe/Load/Save` [I2]；`ConditionalChannel` 与 `BlobChannel` 是可选增强 [I2][I3]。`Engine.Run` 的「拉 → LWW 合并 → 推并集」与「备份恢复走同一个 `merge`」的设计意味着合并规则是唯一事实源 [I2]。因此：

- **新增通道 = 实现一个 struct**，无需触碰 `MergeRemote`、`Snapshot`、`tclock`；
- **更换引擎 = 重写合并层 + 双写迁移 + 全量回归**，且会让备份恢复与通道同步的一致性约束失效 [I2] §ApplySnapshot 注释。

### 4.3 硬约束 3：单人多设备，LWW 已够用

架构决策明确「字段级合并和 CRDT 都是不必要的复杂度」[I1] §2。CouchDB 的 MVCC 冲突修订、PowerSync 的上传队列、RxDB 的自定义 conflict handler 都要为「不会发生的场景」付出持续复杂度。当前 `Result.Conflicts` 只用于设置页提示发生过覆盖 [I2]。

### 4.4 真正的瓶颈在附件，不在记录

- 记录侧：22KB 快照、1 GET + 1 PUT [I6]，增量优化收益极低（与既有决策一致 [I6]）。
- 附件侧：`blob.go` 明文写着选 JSON+base64 是因为三条通道都是「整块文本对象」语义，代价是 4/3 膨胀与 14MB 硬上限（受飞书 `upload_all` 单文件 20MB 约束），且**并集不 GC、每轮重写整份归档** [I3]。
- **判断**：A2（R2）这类原生二进制对象存储恰好能一次性解决这三个问题 —— 内容寻址分片、去掉 base64、突破 14MB、支持单附件 50MB。这比换同步引擎的性价比高一个数量级，也与既有决策中列出的「两个小优化」第 ② 项吻合 [I6]。

### 4.5 双主数据源风险

PouchDB / RxDB 都要求把数据放进自己的本地库（IndexedDB / OPFS / SQLite）。若同时保留 Go 侧 `entity` 表，就必须定义谁是权威、如何双向投影、断网时以谁为准 —— 这会把当前单主模型变成分布式一致性问题。**明确不建议。**

### 4.6 硬门槛与量化评分

评分维度与权重：零成本 25 / 集成代价 30 / 开源合规 15 / 多端覆盖 15 / 离线与冲突 10 / 长期可维护 5；每项 1–5 分，加权后满分 100。**硬门槛优先于分数**，不通过者不参与排名。

| 方案 | 硬门槛 | 零成本 | 集成 | 授权 | 多端 | 离线冲突 | 可维护 | 加权分 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| **A1/A2 WebDAV / R2** | 通过 | 5 | 5 | 5 | 4 | 3 | 5 | **93** |
| **B1 PocketBase** | 通过 | 3 | 4 | 5 | 4 | 3 | 4 | **76** |
| A3 免费云端库 | 通过 | 4 | 4 | 4 | 4 | 2 | 3 | 75 |
| B2 CouchDB + PouchDB | 通过（但需重写） | 3 | 2 | 5 | 5 | 5 | 5 | 72 |
| Syncthing | **不通过**（文件级 / iOS） | 5 | 2 | 5 | 2 | 1 | 4 | — |
| RxDB | **不通过**（付费墙 / 双主） | 4 | 2 | 3 | 4 | 3 | 3 | — |
| PowerSync | **不通过**（需 CGO 扩展 + 源库） | 3 | 1 | 4 | 5 | 5 | 3 | — |
| ElectricSQL | **不通过**（只读路径 + Postgres） | 3 | 1 | 5 | 3 | 2 | 3 | — |

> 分数为基于 §3 事实与 §4 约束的工程判断，不是实测基准。

---

## 5. 推荐路线

### 5.1 档 1 · 立即（零改造，推荐）

1. **直接复用现有 WebDAV 通道**：在设置页填入 Koofr / InfiniCLOUD / 坚果云 的 WebDAV 地址与应用专用密码，用「测试连接」验证 [I4][R19][R20]。这是唯一不需要写代码的路径。
2. **若要解决附件瓶颈**，新增一个 S3 兼容通道（Cloudflare R2 免费档 [R15]），实现 `Channel` + `BlobChannel`：
   - 快照仍是同一个 `planfordo-blobs.json` 之外的 `snapshot.json`，`SaveConditional` 可用 ETag / `If-Match`；
   - 附件改为按 `sha256` 内容寻址的对象键，去掉 base64，去掉 14MB 上限和不 GC 带来的整份重写 [I3]；
   - 保留全量快照作为基线兜底（与既有决策一致 [I6]）。
3. **不做**：gzip 之外的协议改造、字段级合并、增量水位。

### 5.2 档 2 · 有实时多端需求时

新增 **PocketBase Channel**（MIT、Go 单文件、SSE 订阅、可 `CGO_ENABLED=0` 静态构建 [R06]）：

- 一个 collection 存 `Snapshot` 记录（或按 `deviceId` 分记录），`revision` 作为条件写；
- 客户端订阅 SSE，收到变更事件后触发一次 `SyncOne`，**事件只做唤醒，不做数据通道**，避免绕过合并引擎；
- LWW、tombstone、`Result` 全部复用 [I2]；
- 版本风险：pre-1.0 不保证向后兼容 [R06]，须**锁定版本号**并读 release notes 再升级；单写者、垂直扩展，不能水平扩容 [R08]。

### 5.3 档 3 · 仅当业务形态变化时

| 触发条件 | 推荐评估对象 | 前提 |
|---|---|---|
| 变为多人协作、需要字段级冲突可见 | CouchDB + PouchDB [R12][R10] | 接受前端与 Go 双写重构，或 Go 侧自实现复制协议 |
| 移动端重度离线、需要持久化上传队列与多端官方 SDK | PowerSync Open Edition [R01][R03] | 接受引入 Postgres + 逻辑复制 + 客户端 SQLite 扩展（即放弃 CGO-free） |
| 读多写少、已有 Postgres 作为事实源 | ElectricSQL [R04][R05] | 自行实现 write-path 与回滚 |

**三者都意味着重写，不是"集成"。** 不应因「方案看起来更先进」而升级。

### 5.4 升级触发阈值（与既有决策对齐 [I6]）

> 记录 > 2 万 / 压缩后快照 > 5MB / 改为自动定时同步 / 设备 > 3 台 /
> 移动端按流量计费 / 同步耗时被用户投诉。

**当前 52 行、22KB、手动同步、2–3 台设备，全部未触发 → 停在档 1。**

### 5.5 明确不建议做的事

- 引入 PouchDB / RxDB 与 Go 侧 SQLite 并行（双主，见 §4.5）。
- 为了接同步引擎而把 `modernc.org/sqlite` 换成 cgo 驱动（破坏 §4.1）。
- 用 Syncthing / 网盘客户端直接同步运行中的 `planfordo.db`（WAL 未 checkpoint 会损坏 [R28]）。
- 用免费云档承载长期不活跃数据（闲置停用，见 §7）。
- 现在就做增量同步：会引入水位、compact、乱序、删除传播，并削弱全量快照的自愈能力 [I6]。

---

## 6. 风险清单

| 等级 | 风险 | 说明 / 缓释 | 来源 |
|---|---|---|---|
| ★★★ | **授权误判** | 大量二手资料仍称 PowerSync 服务端为 FSL；官网已确认 Open Edition 服务端为 Apache-2.0，FSL 只属历史版本 [R01]。签合同/对外 SaaS 前逐条读 LICENSE | [R01] |
| ★★★ | **免费档闲置停用** | PowerSync Cloud Free 1 周不活跃停用 [R02]；Supabase 7 天暂停、Turso 10 天归档 [R18]。待办类低频应用极易触发 → 优先选 R2 / 网盘 | [R02][R18] |
| ★★★ | **供应商变动** | Atlas Device Sync 已停服 [R13]；Electric 2026-08 并入 Databricks、Cloud 收缩 [R21]。数据留在自控存储是唯一长期保险 | [R13][R21] |
| ★★☆ | **pre-1.0 破坏性升级** | PocketBase 官方明确 v1.0.0 前不保证向后兼容 → 锁版本 [R06] | [R06] |
| ★★☆ | **开源核心 + 付费墙** | RxDB 免费档 13 collection，生产级存储/加密 $99/月起 [R09] | [R09] |
| ★★☆ | **AGPL 网络条款** | Triplit、Nextcloud、Seafile 为 AGPL-3.0：自用无碍，修改后对外提供网络服务需公开源码 [R21][R30] | [R21] |
| ★★☆ | **CouchDB 磁盘膨胀** | 保留每次修订，磁盘按库 3–5 倍预留；附件历史版本同样留存 [R29] | [R29] |
| ★★☆ | **冲突语义错配** | ElectricSQL / PowerSync 默认服务端权威 + 行级 LWW，两人离线改同一行会静默丢一方数据；CouchDB 才会显式保留冲突分支 [R05][R23] | [R05][R23] |
| ★☆☆ | **维护放缓** | WatermelonDB 主分支最后提交约 2025-08 [R22]；PocketBase 接近单人维护 [R08] | [R22][R08] |
| ★☆☆ | **额度口径差异** | D1 按「行」计量且有每日上限，一次大范围扫描会快速消耗 [R17] | [R17] |

---

## 7. 实施建议与验收点

### 7.1 若实施 R2 / S3 通道

1. 在 `internal/core/sync/channel/` 下新增包，按现有 `Install()` 注册模式接入 [I4]；
2. 实现 `Channel`（`Name/Kind/Probe/Load/Save`）+ `ConditionalChannel`（ETag / `If-Match`）+ `BlobChannel` [I2][I3]；
3. 附件按 `sha256` 分对象存储，保留 `planfordo-blobs.json` 兼容旧通道的行为；`MaxBlobBytes` 逻辑仅约束旧归档 [I3]；
4. 配置脱敏：Access Key 不落日志、不进快照；`Probe` 只做最小权限校验；
5. 单测覆盖：首轮空快照、ETag 冲突重试、blob 校验和失败仅记 `BlobsSkipped` 而不中断记录同步 [I2][I3]。

### 7.2 若实施 PocketBase 通道

1. 一个 collection 存快照；服务端规则限定只写自己的记录（API rules）[R07]；
2. SSE 只作为「唤醒信号」，收到后仍走 `SyncOne` 全量合并，禁止直接把 SSE payload 写库；
3. 锁定 PocketBase 版本 [R06]；备份策略用 SQLite 文件复制 / Litestream（官方 FAQ 未内置复制）[R08]；
4. 验收：双实例并发推送时 `SaveConditional` 能挡住后写者，不丢记录 [I2]。

### 7.3 通用验收清单（项目约定）

- 前端改动后必须 `cd frontend && npm run build`，否则 `//go:embed all:frontend/dist` 打进去的是旧 UI；
- 桌面 exe 用 `CGO_ENABLED=0 go build -tags production -trimpath -buildvcs=false -ldflags="-w -s -H windowsgui" -o bin/planfordo.exe .` 重建；
- 用隔离数据目录起实例（`PLANDO_DATA_DIR` / `PLANDO_WEBVIEW_PROFILE` / `PLANDO_CDP_PORT`），GUI 实机点一遍设置页「同步通道」→「测试连接」→「立即同步」，关键控件再补 CDP 断言；
- 界面自检脚本按文本定位按钮，不要新增文案含「新增通道」的按钮、也不要新增 placeholder 含「例如：」或「键（」的输入框。

> 以上为项目既有约定 [I6]，本报告本身只新增文档、未改代码，因此**不触发重建与 GUI 验证**。

---

## 8. 待核实项与复核周期

| 项 | 当前状态 | 复核动作 |
|---|---|---|
| CouchDB 许可证文本 | B 级：官网首页未明示，按 ASF 标准推断 Apache-2.0 | 查源码 LICENSE / ASF 项目页 |
| WebDAV 各家免费额度 | C 级：第三方汇总，且有「注册可能排队」「长期不活跃删号」等变数 | 注册前查官网当日条款 |
| Supabase / Turso / D1 免费额度 | C 级：第三方汇总 | 查各自官方 pricing 页 |
| Electric 并入 Databricks 后的产品走向 | C 级：单一来源 | 查 Electric 官方公告与仓库活跃度 |
| PocketBase 当前版本号 | 第三方资料为 v0.40.x（2026-10）[R08] | 查 GitHub Releases |
| RxDB 免费档 13 collection 是否仍适用 | 官方定价页摘录 [R09] | 采购前复查 |
| 免费档是否存在信用卡 / 地域限制 | 未覆盖 | 实施前确认 |

**复核周期**：免费额度与授权条款每季度一次；若决定实施任一方案，实施当周重新核验一次。

---

## 9. 参考资料

### 9.1 一手来源（A 级，本轮直接抓取原文）

- **[R01]** PowerSync, *Licensing & Terms Overview* — Open Edition 服务端 Apache-2.0、历史 FSL、客户端 SDK Apache-2.0 — <https://powersync.com/legal/licensing-terms>
- **[R02]** PowerSync, *Pricing* — Free / Pro / Team 额度与 1 周闲置停用 — <https://powersync.com/pricing>
- **[R04]** electric-sql/electric, *README.md* — Apache-2.0 徽章、read-path sync engine for Postgres、Shapes、logical replication — <https://raw.githubusercontent.com/electric-sql/electric/main/README.md>
- **[R05]** Electric, *Writes guide* — "Electric does not do write-path sync"、四种写入模式、merge/rollback 复杂性 — <https://electric-sql.com/docs/guides/writes>
- **[R06]** pocketbase/pocketbase, *GitHub 仓库 README* — MIT、单文件 Go 后端、内嵌 SQLite + realtime、pre-1.0 警告、CGO_ENABLED=0 构建 — <https://github.com/pocketbase/pocketbase>
- **[R12]** Apache CouchDB 官网 — multi-primary sync、Couch Replication Protocol、offline-first、PouchDB 面向移动端/浏览器 — <https://couchdb.apache.org/>
- **[R13]** MongoDB, *Feature Updates: End-of-Life And Deprecation* — Atlas Device Sync / Realm SDK 于 2025-09-30 移除，官方替代方案 — <https://www.mongodb.com/products/updates/product-support-deprecation>
- **[R15]** Cloudflare, *R2 pricing* — 10 GB-month、100 万 A 类、1000 万 B 类、出流量免费 — <https://developers.cloudflare.com/r2/pricing/>
- **[R16]** Cloudflare, *R2 定价计算器（中文）* — 永远免费档口径 — <https://r2-calculator.cloudflare.com/cn/>
- **[R27]** StackQL v0.12.718 release discussion — 迁移到 `modernc.org/sqlite` 后 external loadable SQLite extensions 不再支持 — <https://github.com/stackql/stackql/discussions/791>

### 9.2 官方页面 / 权威文档（A–B 级，经检索摘要或原文摘录）

- **[R03]** PowerSync 官网 — 架构、支持源库、客户端 SQLite 与上传队列 — <https://www.powersync.com/>
- **[R07]** PocketBase 官网 — SDK、realtime `subscribe`、文件存储 — <https://pocketbase.io/>
- **[R09]** RxDB, *RxDB for Professionals* — 免费档 ≤13 collection、Pro $99/月、Pro Plus $239/月 — <https://www.rxdb.info/premium/>
- **[R10]** PouchDB, *Replication guide* — `live` / `retry` 与断网重连 — <https://pouchdb.com/guides/replication.html>
- **[R11]** PouchDB, *API Reference* — `since` checkpoint、`batch_size`、`back_off_function` — <https://pouchdb.com/api.html>
- **[R14]** Apache CouchDB, *Replication Protocol 规范* — 检查点、修订树与复制算法的官方定义（本轮由官网链接给出，未抓取正文，B 级）— <https://docs.couchdb.org/en/stable/replication/protocol.html>
- **[R28]** *SQLite in Go: The cgo Decision You Make Before Anything Else* — cgo 驱动具备完整扩展支持、纯 Go 驱动换取静态交叉编译 — <https://www.runxbuild.com/blog/sqlite-golang>

### 9.3 第三方评测 / 汇总（C 级，需以官网复核）

- **[R08]** *What is PocketBase? The Single-File Backend Explained* — v0.40.x、单写者、垂直扩展、无内置复制 — <https://pocketbasecloud.com/blog/what-is-pocketbase>
- **[R17]** FreeTier.co, *The Best Free Database Tiers in 2026 (15 Compared)* — Turso / D1 / Supabase 额度与限制 — <https://freetier.co/articles/best-free-database-free-tiers-2026>
- **[R18]** ToolRadar, *Best Free Database Hosting in 2026* — 闲置条款（Supabase 1 周、Turso 10 天）、触顶行为 — <https://toolradar.com/guides/best-free-database-hosting>
- **[R19]** AeroFTP Docs, *Integrations / WebDAV providers* — Koofr 10GB、InfiniCLOUD 20GB 等 — <http://docs.aeroftp.app/providers>
- **[R20]** *2026 年可还可以用的 WebDAV 网盘总结* — 坚果云流量限制、国内节点、应用密码 — <http://excelbook.cn/computer/2026%E5%B9%B4%E5%8F%AF%E8%BF%98%E5%8F%AF%E4%BB%A5%E7%94%A8%E7%9A%84webdav-%E7%BD%91%E7%9B%98%E6%80%BB%E7%BB%93%EF%BC%81/>
- **[R21]** Frenchy Digital, *Offline-First Mobile Architecture: The 2026 Guide* — 各家现状、Realm 关停、Electric 并入 Databricks、Triplit/Zero 风险 — <https://frenchydigital.com/blog/offline-first-mobile-architecture-2026>
- **[R22]** *Offline-first React Native database: PowerSync vs WatermelonDB* — WatermelonDB 维护放缓、Electric read-path 原文引用 — <https://dawloom.com/blog/offline-first-react-native-database>
- **[R23]** QueryPlane, *PowerSync: Offline-First Sync for Postgres* — 上传队列、冲突由后端决定、逻辑复制前提 — <https://queryplane.com/blog/powersync-offline-first-sync>
- **[R24]** quinn.io, *open-source self-hosted bidirectional sync Q&A* — CouchDB+PouchDB / RxDB / Electric 的取舍 — <https://quinn.io/ai-slop/2025/12-30-what-is-a-good-database-for-an-offline-first>
- **[R25]** MakerStack, *Electric SQL Review (2026)* — 自托管免费、write-path 仍在成熟中 — <https://makerstack.co/reviews/electric-sql-review/>
- **[R26]** aiCoolies, *ElectricSQL Pricing* — Apache-2.0、自托管零授权费、Cloud Free 5M writes/月 — <https://aicoolies.com/pricing/electricsql>
- **[R29]** *VPS 搭建 Obsidian 同步服务器(2026): LiveSync + CouchDB* — 资源口径、修订历史磁盘膨胀、Syncthing 无 iOS 官方端 — <https://vpscost.com/blog/post/vps-obsidian-livesync-couchdb-sync-guide-2026>
- **[R30]** *Syncthing 完整教學 2026* — MPL-2.0、P2P 文件级、与 Nextcloud 对比 — <https://most.tw/posts/blog/syncthing-complete-guide-2026>

### 9.4 项目内部资料（I 级）

- **[I1]** `docs/architecture.md` — 一句话架构、已确认决策表（CGO-free、Wails v3、LWW、iOS 后置）、时间模型
- **[I2]** `internal/core/sync/sync.go` — Snapshot / Channel / ConditionalChannel / Result / Engine.Run / merge / localSnapshot 原文
- **[I3]** `internal/core/sync/blob.go` — BlobChannel、base64 4/3 膨胀、`MaxBlobBytes = 14 << 20`、并集不 GC
- **[I4]** `internal/core/sync/config.go`、`localdir.go`、`channel/webdav/`、`channel/feishu/` — 通道注册与四种实现
- **[I5]** `go.mod` — Go / Wails / modernc.org/sqlite 版本
- **[I6]** `.workbuddy/memory/MEMORY.md` — 增量同步暂不做的决策与触发阈值、52 行 / 14.7KB / 22KB 实测、构建与 GUI 验证约定
- **[I7]** `internal/core/store/query.go`、`api.go`、`frontend/src/components/SettingsPage.tsx`、`frontend/src/api/client.ts` — 存储与界面出口

---

## 附录 A · 术语

| 术语 | 含义 |
|---|---|
| LWW | Last-Write-Wins，按 `updatedAt` 取新者；本项目同刻按 payload 字典序破平局 |
| tombstone | 删除标记，需随快照传播，否则删除会在其他设备复活 |
| 全量快照 | 每次同步传输完整状态；自愈能力强，代价是数据量随记录数线性增长 |
| checkpoint | 复制协议中记录「已同步到哪个序号」，用于断点续传（PouchDB `since`） |
| read-path / write-path | 下行（服务端→客户端）与上行（客户端→服务端）同步；Electric 只做前者 |
| FSL | Functional Source License，非 OSI 认可的开源许可；PowerSync 历史版本用过 |
| AGPL | 修改后对外提供网络服务需公开修改后源码 |
| 双主数据源 | 两个本地库各自可写且互不感知，需要额外定义权威与投影规则 |

## 附录 B · 引用索引（结论 → 来源）

| 报告结论 | 主要依据 |
|---|---|
| 停在档 1、不换引擎 | [I1][I2][I6] + §4 硬约束 |
| CGO-free 封死 SQLite 层引擎 | [R27][R28][I1][I5] |
| R2 免费档足够小数据量 | [R15][R16][I6] |
| PocketBase 是最贴合的自托管档 | [R06][R07][R08] |
| CouchDB+PouchDB 是唯一端到端全开源增量 | [R12][R10][R11][R24] |
| PowerSync 授权已澄清 + 免费档停用 | [R01][R02] |
| Electric 只读下行 + 供应商变动 | [R04][R05][R21] |
| RxDB 付费墙 | [R09] |
| Realm 不得纳入候选 | [R13] |
| 附件才是真瓶颈 | [I3][I6] |

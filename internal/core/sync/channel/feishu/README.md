# 飞书同步通道（feishuDrive / feishuBase）

`planfordo/internal/core/sync/channel/feishu` 给同步引擎提供两条远端通道，宿主（桌面壳/CLI）
需显式调用 `feishu.Install()` 注册；包不在 `init()` 里注册，重复调用 `Install()` 幂等不 panic。

- **feishuDrive（主通道）**：整份快照作为 `planfordo-snapshot.json` 存在云盘某个文件夹里，
  语义与 localdir 一致，出问题可直接人工检查文件；附件字节另存一份 `planfordo-blobs.json`（见下）。
- **feishuBase**：每个实体 kind 一张多维表格数据表（`pf_item`、`pf_habitClock`……），
  `payload` 列存整条记录 JSON，另有 `pf_meta` 表存同步水位（revision / deviceId / syncedAt）。
  **明确不支持附件字节**（`sync.BlobChannel`），只同步附件元数据。

## 单向权威（必读）

**第一版是单向权威：本地库是唯一真相源。** 用户在飞书云表格里手改 `title` 等可读列不会回流，
下一次同步会被原样覆盖——`feishuBase` 的 Load 只认 `payload` 列，可读列只是给人浏览的镜像。
在把「飞书端可编辑」做成双向同步之前，不要把这两张通道宣传成协作表格。

## feishuDrive 的覆盖写策略

drive v1 的 `files/upload_all` 只有「新增」语义：同一目录再传一个同名文件不会替换旧的，
而是**并存第二份**（2026-11-09 实测：两次上传拿到两个不同 `file_token`，列目录两份都在）。
飞书云盘 v1 也**没有可用的改名接口**——`PATCH /files/{file_token}/rename` 实测返回
`HTTP 404` + 纯文本 `404 page not found`，官方文档同样查无此 endpoint。带 `file_token`
的内容更新接口 v1 也没有可用的。因此覆盖必须**正式名直传 + 按 token 精确删旧**：

1. 先列目录，收集所有同名正式文件与历史临时残留的 `file_token`；
2. 直接以正式名上传新内容（`upload_all` 返回本轮 `file_token`）；
3. **再列一次目录**，把上传期间由另一轮并发写入的同名文件也并进清理列表，
   除本轮 token 外全部删掉。少了这一步，引擎在 `pushed=0 / revision≠0` 时
   整轮跳过 `Save`，重复文件就永远没人清了。

任意时刻被打断：上传失败则远端仍是旧文件（完好）；上传成功、删旧失败则远端同时有
新旧两份同名，`loadObject` 按创建时间取最新一份，下一轮 `Save` 会把残留一并清掉。
**不存在「旧文件已删、新文件还没发布」的空窗**——早期「临时名 + 改名」方案正是
卡在改名这一步，把正式快照丢在远端之外（真实用户报错，2026-11-09 修复）。
极端并发下两端可能把对方的同名文件都删掉，那等价于首轮空远端：引擎下一轮
`Load` 空快照、`Revision=0`，会重推全量自愈，不会丢记录。

删旧是**幂等**的：并发覆盖写时另一轮可能已经删掉了同一个 token，飞书会回
`1061001` / `1061007` 而不是成功；复查一次列目录确认文件已不在就当成功。
只有「旧正式文件确实还在、删不掉」才报错（它可能让 `loadObject` 挑回旧内容）。
旧版本遗留的临时残留删不掉只影响云盘卫生，下一轮再试，不阻断本轮同步。

代码里把「一个云盘文件」抽成 `driveObject{fileName, tmpPrefix, label}`，快照与 blob 归档共用
这套读/覆盖写骨架，但**各有独立的临时名前缀**：快照清理 `.planfordo-tmp-*`、归档清理
`.planfordo-blob-tmp-*`，互不误删。新版本不再生成过渡文件，但保留这两个前缀的清理，
用于回收旧版本失败轮留在云盘里的残留（含 `Probe` 的写探针）。

## 附件字节归档（BlobChannel）

`feishuDrive` 实现 `sync.BlobChannel`：同一个文件夹里多一份 `planfordo-blobs.json`，
内容是把附件字节 base64 后的并集（带 sha256 / size）。引擎在记录合并后用它补本机缺的字节，
再把本机独有的字节并回归档；两条通路互不依赖，归档失败不影响记录同步。

- `options.fileName` 只改快照文件名，不能与 `planfordo-blobs.json` 撞名（工厂里直接拒绝）。
- 单份归档上限 14MB **原始附件字节**：归档是 base64 JSON，上传体积约为原始的 4/3，
  `upload_all` 卡的是 20MB 上传文件，14MB × 4/3 ≈ 18.7MB 才留得下 JSON 结构开销。
  超限时引擎明确报错，不会静默截断；附件很多或单个很大时请改用「连附件一起导出」的备份文件。
- **`feishuBase` 明确不支持**：多维表格没有整块二进制对象语义，只有文本/数字列，
  把 base64 塞进单元格会撞长度上限，拆行存又等于在表格里重造文件系统。这不是待办，是结论。

## 设置页的引导配置

桌面壳「设置 → 同步通道 → 引导配置飞书云盘」把上面这些键名藏进四步向导：
准备说明 → 应用凭证 → 文件夹链接 → 命名与测试连接。粘贴整条云盘文件夹链接会自动提取
`folderToken`（`/drive/folder/<token>` 或 `?folder_token=`），默认域名与快照文件名先填好；
「仅测试连接」不落盘，只有「保存通道」才写本机 meta。已有 feishuDrive 通道时按钮变成
「重新引导配置飞书云盘」并预填，App Secret 保持掩码、不回显（留空即沿用内核已存的真值）。

纯逻辑在 `frontend/src/lib/feishu.ts`（可单独跑断言），界面在
`frontend/src/components/FeishuDriveGuide.tsx`；内存 mock 也放行了 feishuDrive，
浏览器预览能走完整条流程。

### 真实环境配置流程（2026-11-09 实测走通）

向导第 1 步按这五步写，缺一不可：

1. 开发者后台 →「凭证与基础信息」拿 App ID / App Secret。
2. 「权限管理」开通云空间文件权限：`drive:drive`（查看、评论、编辑和管理云空间中所有文件）
   是列目录/读写的前提，再加上传、下载、删除相关项（通道要传文件、删旧快照）。
3. **「添加应用能力」→ 添加「机器人」**。
4. 飞书客户端新建群 → 把应用加为群机器人 → 云盘把目标文件夹**分享给该群，给「可管理」**。
   个人云空间的文件夹不会自动对 `tenant_access_token` 开放；官方明确说直接把应用加为
   文件夹协作者无效（添加成功但应用仍无权限），必须经群机器人。
5. 「版本管理与发布」创建版本并发布、等审核通过；每次改权限/能力都要重发一次。

错误码速查：

| 报错 | 含义 | 处理 |
| --- | --- | --- |
| `1061004 forbidden` on `/drive/v1/files` | 应用身份对该文件夹没有访问权 | 回到第 3～5 步；可用「不带 folder_token 列根目录」对照：根目录成功、指定文件夹失败即为此因 |
| `1061002 params error` on `/files/upload_all` | 请求体参数不合法 | **程序侧问题，本版已修**：`upload_all` 必填 `size`（文件字节数），见 `uploadAll`；用户不用改配置 |
| `invalid character 'p' after top-level value` on `/files/{token}/rename` | 旧版去调了不存在的改名接口，飞书返回 `404 page not found` 纯文本，Go 把开头的 `404` 当成 JSON 数字再撞上后面的 `p` | **程序侧问题，本版已修**：改用「正式名直传 + 精确删旧」，不再有 rename 这一步；升级客户端后重新同步即可自愈 |
| `1061001` / `1061007` on `DELETE /files/{token}` | 另一轮同步已经把同一个旧文件删了（并发覆盖写） | **程序侧问题，本版已修**：删除改成幂等，复查列目录确认已不在即视为成功；历史残留删不掉也不阻断同步 |
| `1061005 auth failed` | 凭证错 / token 无效 | 检查 App ID、App Secret、以及发布版本是否生效 |

`uploadAll` 的 multipart 字段固定为 `file_name` / `parent_type=explorer` / `parent_node` /
`size` / `file`；`size` 必须与 `file` 实际字节数一致且不能为 0，否则服务端只回一句
`params error`，不指出是哪个字段。

## Options 键名（设置页用）

| 键 | 通道 | 必填 | 说明 |
| --- | --- | --- | --- |
| `appId` | 两者 | 是 | 自建应用 App ID |
| `appSecret` | 两者 | 是 | 自建应用 App Secret（只存本机，绝不进快照） |
| `baseUrl` | 两者 | 否 | 默认 `https://open.feishu.cn`；Lark 国际版填 `https://open.larksuite.com` |
| `folderToken` | feishuDrive | 是 | 云盘文件夹 token |
| `fileName` | feishuDrive | 否 | 快照文件名，默认 `planfordo-snapshot.json` |
| `appToken` | feishuBase | 是 | 多维表格 app_token |
| `tablePrefix` | feishuBase | 否 | 数据表名前缀，默认 `pf_` |

应用需要申请的权限（scope）：drive 文件的上传/下载/删除/列目录，bitable 应用与表的读写
（对应 v1 endpoints，全部走 `tenant_access_token`）。**没有「改名」权限项，也不需要申请。**

## 使用的 endpoint

- 鉴权：`POST /open-apis/auth/v3/tenant_access_token/internal`（token 缓存至临近过期，401 续签一次后重试）
- Drive：`GET /open-apis/drive/v1/files`（列目录，分页）、`POST /open-apis/drive/v1/files/upload_all`、
  `GET /open-apis/drive/v1/files/{file_token}/download`、`DELETE /open-apis/drive/v1/files/{file_token}`
- Base：`GET|POST /open-apis/bitable/v1/apps/{app_token}/tables`、
  `GET|POST .../tables/{table_id}/fields`、`GET .../tables/{table_id}/records`（page_size≤500，page_token 翻全）、
  `.../records/batch_create|batch_update|batch_delete`

> 已确认不存在、不要再用的 endpoint：`PATCH /open-apis/drive/v1/files/{file_token}/rename`
> （HTTP 404 纯文本）。曾据此设计过覆盖写，2026-11-09 真实环境报错后移除。

## 形状存疑点（已做成可配置路径变量，见 client.go）

真实环境与文档不符时改这些包级变量即可，不用动调用点：

1. `pathDriveDelete` 与 `driveDeleteQueryType`：DELETE `/files/{file_token}` 的 `type` 查询参数是否必填存疑；
2. 列目录分页游标键 `page_token` / `next_page_token`：两种都兼容（`drivePageTokenKey`）；
3. 建表响应的 `table_id` 是否包一层 `table`：两种都认，并兜底重列按名查找；
4. drive 文件的 `created_at` 数字/字符串两种形状都兼容（`json.RawMessage` 宽松解析）。

## 限速与错误处理

HTTP 200 里的非零业务 `code`（`99991400` 全局限流，见 `retryAPICodes`）与 429/5xx 一并按指数退避
重试（`retryBaseDelay`，服从 `Retry-After`），上限 `maxAttempts`；分页拿不到下一页游标、
`payload` 缺失或解析失败都会报错中断本轮，绝不静默产出残缺快照。所有请求尊重 ctx 取消。
非 2xx 响应先判状态码：能解出飞书错误 envelope 就报 `HTTP xxx (code=…): msg`，解不出就报
`HTTP xxx（响应不是飞书错误体）: "响应片段"`，不再把 404 明文硬塞给 JSON 解析器。

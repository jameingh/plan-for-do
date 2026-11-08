# 飞书同步通道（feishuDrive / feishuBase）

`planfordo/internal/core/sync/channel/feishu` 给同步引擎提供两条远端通道，宿主（桌面壳/CLI）
需显式调用 `feishu.Install()` 注册；包不在 `init()` 里注册，重复调用 `Install()` 幂等不 panic。

- **feishuDrive（主通道）**：整份快照作为 `planfordo-snapshot.json` 存在云盘某个文件夹里，
  语义与 localdir 一致，出问题可直接人工检查文件。
- **feishuBase**：每个实体 kind 一张多维表格数据表（`pf_item`、`pf_habitClock`……），
  `payload` 列存整条记录 JSON，另有 `pf_meta` 表存同步水位（revision / deviceId / syncedAt）。

## 单向权威（必读）

**第一版是单向权威：本地库是唯一真相源。** 用户在飞书云表格里手改 `title` 等可读列不会回流，
下一次同步会被原样覆盖——`feishuBase` 的 Load 只认 `payload` 列，可读列只是给人浏览的镜像。
在把「飞书端可编辑」做成双向同步之前，不要把这两张通道宣传成协作表格。

## feishuDrive 的覆盖写策略

drive v1 的 `files/upload_all` 只有「新增」语义：同一目录再传一个同名文件不会替换旧的，
带 `file_token` 的内容更新接口 v1 也没有可用的。因此覆盖必须**显式删旧建新**：

1. 以临时名（`.planfordo-tmp-*`）上传新快照；
2. 上传成功后才删除旧正式文件与上轮崩溃遗留的临时文件；
3. 把新文件改名成正式名。

任意时刻被打断，远端要么「旧快照完好」要么「没有快照」；后者等同首轮起点，引擎下一轮会把
本地全量重新推上来，不会丢数据，也绝不存在半截快照。任何一步失败都返回错误。

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

应用需要申请的权限（scope）：drive 文件的上传/下载/删除/改名，bitable 应用与表的读写
（对应 v1 endpoints，全部走 `tenant_access_token`）。

## 使用的 endpoint

- 鉴权：`POST /open-apis/auth/v3/tenant_access_token/internal`（token 缓存至临近过期，401 续签一次后重试）
- Drive：`GET /open-apis/drive/v1/files`（列目录，分页）、`POST /open-apis/drive/v1/files/upload_all`、
  `GET /open-apis/drive/v1/files/{file_token}/download`、`DELETE /open-apis/drive/v1/files/{file_token}`、
  `PATCH /open-apis/drive/v1/files/{file_token}/rename`
- Base：`GET|POST /open-apis/bitable/v1/apps/{app_token}/tables`、
  `GET|POST .../tables/{table_id}/fields`、`GET .../tables/{table_id}/records`（page_size≤500，page_token 翻全）、
  `.../records/batch_create|batch_update|batch_delete`

## 形状存疑点（已做成可配置路径变量，见 client.go）

真实环境与文档不符时改这些包级变量即可，不用动调用点：

1. `pathDriveRename`：PATCH `/files/{file_token}/rename?file_token=…` + body `{"new_name":…}` 的
   方法与查询参数组合不完全确定；
2. `pathDriveDelete` 与 `driveDeleteQueryType`：DELETE `/files/{file_token}` 的 `type` 查询参数是否必填存疑；
3. 列目录分页游标键 `page_token` / `next_page_token`：两种都兼容（`drivePageTokenKey`）；
4. 建表响应的 `table_id` 是否包一层 `table`：两种都认，并兜底重列按名查找；
5. drive 文件的 `created_at` 数字/字符串两种形状都兼容（`json.RawMessage` 宽松解析）。

## 限速与错误处理

HTTP 200 里的非零业务 `code`（`99991400` 全局限流，见 `retryAPICodes`）与 429/5xx 一并按指数退避
重试（`retryBaseDelay`，服从 `Retry-After`），上限 `maxAttempts`；分页拿不到下一页游标、
`payload` 缺失或解析失败都会报错中断本轮，绝不静默产出残缺快照。所有请求尊重 ctx 取消。

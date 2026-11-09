// feishuDrive 通道配置的纯逻辑：和 React 分开，链接解析 / 配置拼装可以单独验证。
// 界面那层只管分步、校验与错误展示，不在这里掺 DOM。
import type { SyncConfig } from "../api/types";

export const OPEN_APP_URL = "https://open.feishu.cn/app";
export const DEFAULT_BASE_URL = "https://open.feishu.cn";
export const DEFAULT_FILE_NAME = "planfordo-snapshot.json";
export const BLOB_FILE_NAME = "planfordo-blobs.json";
export const DEFAULT_NAME = "我的飞书云盘";

export type DriveDraft = {
  name: string;
  enabled: boolean;
  appId: string;
  appSecret: string;
  baseUrl: string;
  folderRaw: string;
  fileName: string;
};

export function initialDraft(existing?: SyncConfig | null): DriveDraft {
  const o = existing?.options ?? {};
  return {
    name: existing?.name ?? DEFAULT_NAME,
    enabled: existing?.enabled ?? true,
    appId: o.appId ?? "",
    appSecret: "", // 密钥永不回显，留空表示「沿用本机已存的值」
    baseUrl: o.baseUrl || DEFAULT_BASE_URL,
    folderRaw: o.folderToken ?? "",
    fileName: o.fileName || DEFAULT_FILE_NAME,
  };
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** 从云盘文件夹链接里取 folder_token：.../drive/folder/<token>、?folder_token=<token>，
 *  或直接一段 token。认不出来就原样交回去，让「测试连接」给明确报错，不在这儿猜。 */
export function parseFolderToken(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (!/[/?:&=]/.test(s)) return s;
  const seg = s.match(/\/folder\/([^/?#\s]+)/);
  if (seg) return safeDecode(seg[1]);
  const q = s.match(/[?&]folder_token=([^&#\s]+)/);
  if (q) return safeDecode(q[1]);
  try {
    const u = new URL(s);
    const last = u.pathname.split("/").filter(Boolean).pop();
    // 末段恰好是 "folder"（链接没带 token）不算识别成功，原样交回让测试连接报错。
    if (last && last !== "folder") return safeDecode(last);
  } catch { /* 不是 URL，原样交回 */ }
  return s;
}

/** 把向导里的字段拼成内核认识的 SyncConfig。
 *  appSecret 留空时沿用 existing 里那个掩码值（内核 unmask 会还原真凭证）。 */
export function buildCfg(d: DriveDraft, existing?: SyncConfig | null): SyncConfig {
  const options: Record<string, string> = {
    appId: d.appId.trim(),
    appSecret: d.appSecret || (existing?.options?.appSecret ?? ""),
    baseUrl: d.baseUrl.trim() || DEFAULT_BASE_URL,
    folderToken: parseFolderToken(d.folderRaw),
  };
  const fileName = d.fileName.trim();
  if (fileName && fileName !== DEFAULT_FILE_NAME) options.fileName = fileName;
  return { name: d.name.trim(), kind: "feishuDrive", enabled: d.enabled, options };
}

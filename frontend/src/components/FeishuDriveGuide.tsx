// FeishuDriveGuide.tsx —— feishuDrive 通道的分步引导配置。
//
// 「新增通道」是通用 KV 编辑器，用户得自己知道 appId / appSecret / folderToken 这些键名，
// 还要去翻文档找文件夹 token 是链接的哪一段。这里把准备步骤摊开成四步：
// 粘贴整条云盘链接自动取 token、默认域名与文件名先填好、最后一步才测连接并落盘。
//
// 密钥不回显：编辑已有通道时 appSecret 输入框留空即沿用本机已存的掩码值，
// 由内核 unmask 还原真凭证，界面任何时候都拿不到明文。

import { useState } from "react";
import type { SyncConfig } from "../api/types";
import { copyToClipboard } from "../lib/clipboard";
import {
  BLOB_FILE_NAME, DEFAULT_BASE_URL, DEFAULT_FILE_NAME, OPEN_APP_URL,
  buildCfg, initialDraft, parseFolderToken,
} from "../lib/feishu";
import type { DriveDraft } from "../lib/feishu";
import { FieldError, Modal } from "./ui";

const STEPS = ["准备什么", "应用凭证", "云盘文件夹", "命名并验证"];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)) || "未知错误";

export function FeishuDriveGuide({ existing, onClose, onProbe, onSave }: {
  /** 已有 feishuDrive 配置时预填，输入仍可改；null 表示从零配置。 */
  existing: SyncConfig | null;
  onClose: () => void;
  onProbe: (cfg: SyncConfig) => Promise<void>;
  onSave: (cfg: SyncConfig) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [d, setD] = useState<DriveDraft>(() => initialDraft(existing));
  const [busy, setBusy] = useState<"" | "probe" | "save">("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const set = (patch: Partial<DriveDraft>) => setD((old) => ({ ...old, ...patch }));

  const hasSecret = !!(existing?.options?.appSecret);
  const token = parseFolderToken(d.folderRaw);
  const stepOK = [
    true,
    !!d.appId.trim() && (!!d.appSecret.trim() || hasSecret),
    !!token,
    !!d.name.trim(),
  ];
  const allOK = stepOK.every(Boolean);

  function move(next: number) {
    setStep(Math.max(0, Math.min(STEPS.length - 1, next)));
    setErr("");
    setOk("");
  }

  async function run(kind: "probe" | "save") {
    setErr("");
    setOk("");
    setBusy(kind);
    try {
      const cfg = buildCfg(d, existing);
      if (kind === "probe") {
        await onProbe(cfg);
        setOk("连接正常，云盘可写，可以保存了");
        setBusy("");
      } else {
        // 保存成功后外层直接关窗，不必再 setState；失败留在原步，错误贴在按钮下方。
        await onSave(cfg);
      }
    } catch (e) {
      setErr(`${kind === "probe" ? "连接失败" : "保存失败"}：${errText(e)}`);
      setBusy("");
    }
  }

  return (
    <Modal title={existing ? "重新引导配置飞书云盘" : "引导配置飞书云盘"} onClose={onClose} wide keepOnMask>
      <div className="fdg">
        <div className="hg-progress">
          {STEPS.map((t, i) => (
            <span key={t} className={"hg-dot" + (i === step ? " is-on" : i < step ? " is-done" : "")} aria-hidden />
          ))}
          <span className="hg-step-text">第 {step + 1} / {STEPS.length} 步 · {STEPS[step]}</span>
        </div>

        <div className="fdg-body">
          {step === 0 && (
            <>
              <div className="hg-q">先按这五步把应用授权好（第 3、4 步最容易漏）</div>
              <p className="hg-why">飞书云盘通道把整份快照存成一个 JSON 文件，多设备靠它对齐；附件字节会另存一份归档，跟着一起同步。</p>
              <ol className="fdg-list">
                <li>企业自建应用 →「凭证与基础信息」拿 <b>App ID / App Secret</b></li>
                <li>「权限管理」开通<b>云空间文件</b>权限：至少「查看、评论、编辑和管理云空间中所有文件」，再加上传 / 下载 / 删除相关项（通道要传文件、删旧快照、改名）</li>
                <li><b>「添加应用能力」→ 添加「机器人」</b>：不加机器人，应用身份读不到个人云空间里的文件夹</li>
                <li>飞书客户端<b>新建一个群，把应用加为群机器人</b>；云盘里把目标文件夹<b>分享给这个群，给「可管理」</b>。直接把应用加为文件夹协作者无效</li>
                <li>「版本管理与发布」<b>创建版本并发布</b>、等审核通过；每次改权限 / 能力都要重发一次</li>
              </ol>
              <div className="fdg-link-row">
                <span>开放平台控制台</span>
                <code className="fdg-code">{OPEN_APP_URL}</code>
                <button className="btn small" onClick={() => void copyToClipboard(OPEN_APP_URL)}>复制链接</button>
              </div>
              <p className="hg-why">
                文件夹 token 是链接最后一段，第 3 步粘整条链接就会自动识别。测试连接报
                <code className="fdg-code">1061004 forbidden</code> = 文件夹没按第 3～4 步授权给应用；
                报 <code className="fdg-code">1061002 params error</code> 是程序侧参数问题（本版已修复），不用改配置。
                链接复制到浏览器打开，应用内不跳转外部页面，免得弄丢填了一半的表单。
              </p>
            </>
          )}

          {step === 1 && (
            <>
              <div className="hg-q">填应用凭证</div>
              <p className="hg-why">在「凭证与基础信息」里复制这两个值。密钥只存本机 meta，不进同步快照、不回显、不打日志。</p>
              <label className="fdg-field">
                <span>App ID <i>必填</i></span>
                <input className="input" value={d.appId} placeholder="cli_xxxxxxxxxxxxxxxx"
                  onChange={(e) => set({ appId: e.target.value })} />
              </label>
              <label className="fdg-field">
                <span>App Secret <i>{hasSecret ? "已保存，留空即不修改" : "必填"}</i></span>
                <input className="input" type="password" autoComplete="new-password" value={d.appSecret}
                  placeholder={hasSecret ? "已设置（••••••），输入以覆盖" : "输入后不回显"}
                  onChange={(e) => set({ appSecret: e.target.value })} />
              </label>
              <label className="fdg-field">
                <span>开放平台域名 <i>一般用默认</i></span>
                <input className="input" value={d.baseUrl} placeholder={DEFAULT_BASE_URL}
                  onChange={(e) => set({ baseUrl: e.target.value })} />
              </label>
              <p className="hg-why">Lark 国际版把域名改成 <code className="fdg-code">https://open.larksuite.com</code>。</p>
            </>
          )}

          {step === 2 && (
            <>
              <div className="hg-q">指向云盘文件夹</div>
              <p className="hg-why">在飞书云盘里新建一个文件夹，把地址栏整条链接粘进来就行，下面会自动取出 token。</p>
              <label className="fdg-field">
                <span>文件夹链接或 folder token <i>必填</i></span>
                <input className="input" value={d.folderRaw}
                  placeholder="https://xxx.feishu.cn/drive/folder/fldcnXXXXXXXX 或 fldcnXXXXXXXX"
                  onChange={(e) => set({ folderRaw: e.target.value })} />
              </label>
              {token && token !== d.folderRaw.trim() && (
                <div className="fdg-ok">已从链接识别出 token：<code className="fdg-code">{token}</code></div>
              )}
              <label className="fdg-field">
                <span>快照文件名 <i>可选</i></span>
                <input className="input" value={d.fileName} placeholder={DEFAULT_FILE_NAME}
                  onChange={(e) => set({ fileName: e.target.value })} />
              </label>
              <p className="hg-why">
                附件字节会自动存成同目录的 <code className="fdg-code">{BLOB_FILE_NAME}</code>，快照文件名不要与它撞名。
                应用需要能访问这个文件夹，测试连接会真实写删一个探针文件来确认。
              </p>
            </>
          )}

          {step === 3 && (
            <>
              <div className="hg-q">起个名字，然后测一下</div>
              <p className="hg-why">「仅测试连接」不保存配置，会验证凭证、目录可读与写权限；建议保存前先测一次。</p>
              <label className="fdg-field">
                <span>通道名 <i>必填</i></span>
                <input className="input" value={d.name} disabled={!!existing}
                  onChange={(e) => set({ name: e.target.value })} />
              </label>
              {existing && <p className="hg-why">改名字等于新建一条通道，编辑时这一项锁定；要改名请走「新增通道」。</p>}
              <label className="nav-item" style={{ cursor: "pointer", width: "auto", padding: "4px 8px" }}>
                <input className="check-native" type="checkbox" checked={d.enabled}
                  onChange={(e) => set({ enabled: e.target.checked })} />
                <span className="grow">启用这条通道</span>
              </label>
              <div className="fdg-summary">
                <div><span>类型</span><b>feishuDrive</b></div>
                <div><span>App ID</span><code>{d.appId.trim() || "（未填）"}</code></div>
                <div><span>文件夹</span><code>{token || "（未填）"}</code></div>
                <div><span>域名</span><code>{d.baseUrl.trim() || DEFAULT_BASE_URL}</code></div>
                <div><span>密钥</span><code>{d.appSecret.trim() ? "本轮新填" : hasSecret ? "沿用已保存的值" : "（未填）"}</code></div>
              </div>
            </>
          )}
        </div>

        <div className="hg-foot">
          <button className="btn" disabled={step === 0 || !!busy} onClick={() => move(step - 1)}>上一步</button>
          <div className="hg-foot-right">
            {step < STEPS.length - 1 ? (
              <button className="btn primary" disabled={!stepOK[step]} onClick={() => move(step + 1)}>下一步</button>
            ) : (
              <>
                <button className="btn" disabled={!!busy || !allOK} onClick={() => void run("probe")}>
                  {busy === "probe" ? "测试中…" : "仅测试连接"}
                </button>
                <button className="btn primary" disabled={!!busy || !allOK} onClick={() => void run("save")}>
                  {busy === "save" ? "保存中…" : "保存通道"}
                </button>
              </>
            )}
          </div>
        </div>
        <FieldError text={err} />
        {ok && <div className="fdg-ok">{ok}</div>}
      </div>
    </Modal>
  );
}

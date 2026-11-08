// SettingsPage.tsx —— 设置页：顶栏「设置」页签 + 单列内容（运行环境 / 偏好 / 同步通道）。
// 条目2 把左栏改成图标模块栏后，本页不再有 200px 侧栏，偏好从侧栏移进内容区。
// 安全约束：密码类字段（appSecret/password/token 等）输入后不回显、不进 console.log；
// 注意内核 SyncChannels 会把 Options 原样带回（含密钥），这里只做掩码展示，不打印。
// 校验/内核错误贴在触发的控件下方（规范 4.7）。

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, bridgeProbe } from "../api/client";
import type { CalendarStatus, SyncConfig, SyncResult, SyncState } from "../api/types";
import { saveSettings, toast, toastErr, useApp } from "../store/appStore";
import { SingleTab, TopBar } from "./chrome";
import { Empty, FieldError, I, Modal, Segmented } from "./ui";

const SECRET_KEY_RE = /secret|password|token|pwd|apikey|api_key/i;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)) || "未知错误";

export function SettingsPage() {
  const { booted, boot, settings, revision } = useApp();
  const [channels, setChannels] = useState<SyncConfig[]>([]);
  const [editing, setEditing] = useState<SyncConfig | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState("");
  const [results, setResults] = useState<SyncResult[] | null>(null);
  const [states, setStates] = useState<Record<string, SyncState>>({});
  const [probeMsg, setProbeMsg] = useState("");
  // 节假日数据只在设置页要显示，不进 boot 握手：它是「解释界面为什么这样标」的辅助信息，
  // 读失败不该把整页拖成空白。
  const [cal, setCal] = useState<CalendarStatus | null>(null);

  const reload = useCallback(() => {
    api.SyncChannels().then(setChannels).catch(toastErr);
  }, []);
  useEffect(reload, [reload, revision]);

  useEffect(() => {
    if (!booted) return;
    api.CalendarInfo().then(setCal).catch(() => setCal(null));
  }, [booted]);

  useEffect(() => {
    if (!booted) return;
    channels.forEach((c) => api.SyncState(c.name).then((s) => setStates((old) => ({ ...old, [c.name]: s }))).catch(() => undefined));
  }, [booted, channels]);

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toastErr(e);
    } finally {
      setBusy("");
    }
  }

  async function syncAll() {
    await act("同步", async () => {
      const rs = await api.SyncNow("");
      setResults(rs);
      toast(`同步完成（${rs.length} 条通道）`);
    });
  }

  const implTag = api.impl === "wails" ? "Wails 内核" : api.impl === "mock" ? `内存 mock（${bridgeProbe()}）` : "内核探测中…";

  return (
    <>
      <TopBar tabs={<SingleTab label="设置" />} />

      <main className="content">
        <div className="page-body">
          <section className="set-block">
            <h5 className="section-title">运行环境<i>Start() 握手</i></h5>
            {boot ? (
              <div className="env-card">
                <EnvRow lab="数据目录" mono copy={boot.dataDir}>{boot.dataDir}</EnvRow>
                <EnvRow lab="设备 ID" mono copy={boot.deviceId}>{boot.deviceId}</EnvRow>
                <EnvRow lab="内核的今天" mono>{boot.today}</EnvRow>
                <EnvRow lab="内核实现">{implTag}</EnvRow>
                <EnvRow lab="通道类型" title="内核已注册的通道类型，不代表已经配好通道">
                  {boot.channelKinds.length
                    ? <span className="env-chips">{boot.channelKinds.map((k) => <i key={k}>{k}</i>)}</span>
                    : <span className="env-dim">（无）</span>}
                </EnvRow>
              </div>
            ) : (
              <Empty text={booted ? "握手失败" : "正在与内核握手…"} />
            )}
          </section>

          <section className="set-block">
            <h5 className="section-title">节假日与调休<i>法定工作日、跳过节假日、班/休标记的数据</i></h5>
            {cal ? (
              <div className="env-card">
                <EnvRow lab="生效年份">
                  <span className="env-chips">{cal.years.map((y) => (
                    <i key={y.year} title={`${y.source}（核对 ${y.lastVerified}）`}>
                      {y.year} 休{y.holidayCount}·班{y.makeupCount}{y.origin === "local" ? "·本机" : ""}
                    </i>
                  ))}</span>
                </EnvRow>
                <EnvRow lab="数据目录" mono copy={cal.dir}
                  title="放一份 <年份>.json 进来就覆盖内置的同一年，重启后生效">{cal.dir}</EnvRow>
                <p className="muted small">
                  内置表来自国务院办公厅公布的节假日安排，覆盖 {cal.years[0]?.year ?? "—"}–{cal.years[cal.years.length - 1]?.year ?? "—"} 年。
                  表没有的年份不标班/休，「法定工作日」与「跳过节假日」在那几年退化成普通周一至周五——程序不替官方猜日历。
                </p>
              </div>
            ) : (
              <Empty text={booted ? "读不到节假日数据" : "正在与内核握手…"} />
            )}
          </section>

          <section className="set-block">
            <h5 className="section-title">偏好设置</h5>
            <div className="set-row">
              <span className="lab">默认分组</span>
              <select className="select" style={{ maxWidth: 220 }} value={settings.defaultGroup} onChange={(e) => void saveSettings({ ...settings, defaultGroup: e.target.value })}>
                <option value="date">按日期</option><option value="category">按分类</option><option value="quadrants">按四象限</option>
              </select>
            </div>
            <div className="set-row">
              <span className="lab">主题</span>
              <Segmented value={settings.theme || "light"} onChange={(v) => void saveSettings({ ...settings, theme: v })}
                options={[{ value: "light", label: "浅色" }, { value: "dark", label: "深色" }]} ariaLabel="主题" />
            </div>
            <div className="set-row">
              <span className="lab">新建习惯</span>
              <Segmented value={settings.habitCreateMode || "guided"} onChange={(v) => void saveSettings({ ...settings, habitCreateMode: v as "guided" | "classic" })}
                options={[{ value: "guided", label: "引导模式" }, { value: "classic", label: "传统模式" }]} ariaLabel="新建习惯默认模式" />
            </div>
            <p className="set-note">引导模式按「微启动」分步提问，把起步量压到闭着眼也能完成；
              编辑已有习惯时仍走传统模式。</p>
            <label className="nav-item" style={{ cursor: "pointer", width: "auto", padding: "4px 8px" }}>
              <input className="check-native" type="checkbox" checked={settings.showDone} onChange={(e) => void saveSettings({ ...settings, showDone: e.target.checked })} />
              <span className="grow">显示已打卡清单</span>
            </label>
          </section>

          <section className="set-block">
            <h5 className="section-title">同步通道</h5>
            <div className="field-row">
              <button className="btn" onClick={() => { setIsNew(true); setEditing({ name: "", kind: boot?.channelKinds[0] ?? "localdir", enabled: true, options: {} }); setProbeMsg(""); }}>
                <I n="plus" size={14} />新增通道
              </button>
              <button className="btn primary" disabled={!!busy} onClick={() => void syncAll()}>
                <I n="repeat" size={14} />{busy === "同步" ? "同步中…" : "全部同步"}
              </button>
            </div>

            {channels.length === 0 && <Empty text="还没有同步通道。第一版先落地飞书，本地文件夹通道可无凭证验证多设备。" action="新增通道" onAction={() => { setIsNew(true); setEditing({ name: "", kind: boot?.channelKinds[0] ?? "localdir", enabled: true, options: {} }); }} />}
            {channels.map((c) => (
              <div key={c.name} className="channel-card">
                <div className="field-row" style={{ justifyContent: "space-between" }}>
                  <strong style={{ fontSize: 14, fontWeight: 500 }}>{c.name} <span className="chip">{c.kind}</span></strong>
                  <label className="muted small"><input className="check-native" type="checkbox" checked={c.enabled} onChange={(e) => void act("启停", async () => { await api.SaveSyncChannel({ ...c, enabled: e.target.checked }); reload(); })} /> 启用</label>
                </div>
                <div className="muted small" style={{ margin: "6px 0" }}>
                  {Object.entries(c.options ?? {}).map(([k, v]) => `${k}=${SECRET_KEY_RE.test(k) ? "••••••" : v}`).join("，") || "无配置项"}
                </div>
                <div className="field-row">
                  <button className="btn small" disabled={!!busy} onClick={() => void act(`测连${c.name}`, async () => { await api.ProbeSyncChannel(c); toast(`通道「${c.name}」连接正常`); })}>测试连接</button>
                  <button className="btn small" disabled={!!busy} onClick={() => void act(`同步${c.name}`, async () => { const rs = await api.SyncNow(c.name); setResults(rs); })}>同步</button>
                  <button className="btn small" disabled={!!busy} onClick={() => void act("水位", async () => { const s = await api.SyncState(c.name); setStates((old) => ({ ...old, [c.name]: s })); })}>刷新水位</button>
                  <button className="btn small" onClick={() => { setIsNew(false); setEditing({ ...c, options: { ...c.options } }); setProbeMsg(""); }}>编辑</button>
                  <button className="btn small danger" disabled={!!busy} onClick={() => void act("删除", async () => { await api.RemoveSyncChannel(c.name); reload(); })}>删除</button>
                </div>
                {states[c.name] && (
                  <div className="muted small" style={{ marginTop: 6 }}>
                    水位：最近拉取 {states[c.name].lastSyncAt ? states[c.name].lastSyncAt.slice(0, 19).replace("T", " ") : "从未"} · 最近推送 {states[c.name].lastPushedAt ? states[c.name].lastPushedAt.slice(0, 19).replace("T", " ") : "从未"}{states[c.name].note ? ` · ${states[c.name].note}` : ""}
                  </div>
                )}
              </div>
            ))}
            {results && results.length > 0 && (
              <div className="channel-card">
                <strong className="small" style={{ fontWeight: 500 }}>最近一次同步结果</strong>
                {results.map((r) => (
                  <div key={r.channel} className="muted small" style={{ marginTop: 4 }}>
                    {r.channel}：应用 {r.applied} · 上推 {r.pushed} · 冲突 {r.conflicts} · 版本 {r.revision}
                    {r.skipped ? ` · 跳过原因：${r.skipped}` : ""}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </main>

      {editing && (
        <ChannelModal
          cfg={editing}
          isNew={isNew}
          kinds={boot?.channelKinds ?? []}
          probeMsg={probeMsg}
          setProbeMsg={setProbeMsg}
          onClose={() => setEditing(null)}
          onSave={async (cfg, probeFirst) => {
            try {
              if (probeFirst) await api.ProbeSyncChannel(cfg);
              else await api.SaveSyncChannel(cfg);
              toast(probeFirst ? `通道「${cfg.name}」连接正常（未保存）` : `已保存通道「${cfg.name}」`);
              reload();
              if (!probeFirst) setEditing(null);
              else setProbeMsg("连接正常");
            } catch (e) {
              const msg = errText(e);
              setProbeMsg(probeFirst ? `连接失败：${msg}` : msg);
              if (!probeFirst) toastErr(e);
            }
          }}
        />
      )}
    </>
  );
}

function ChannelModal({ cfg, isNew, kinds, probeMsg, setProbeMsg, onClose, onSave }: {
  cfg: SyncConfig;
  isNew: boolean;
  kinds: string[];
  probeMsg: string;
  setProbeMsg: (s: string) => void;
  onClose: () => void;
  onSave: (cfg: SyncConfig, probeFirst: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState<SyncConfig>(cfg);
  const [kvKey, setKvKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [nameErr, setNameErr] = useState("");

  async function go(probeFirst: boolean) {
    if (!draft.name.trim()) { setNameErr("通道名不能为空"); setProbeMsg(""); return; }
    setNameErr("");
    setSaving(true);
    await onSave({ ...draft, name: draft.name.trim(), options: Object.fromEntries(Object.entries(draft.options ?? {}).filter(([k]) => k.trim())) }, probeFirst);
    setSaving(false);
  }

  return (
    <Modal title={isNew ? "新增同步通道" : `编辑通道「${cfg.name}」`} onClose={onClose} wide keepOnMask>
      <div className="field"><span className="k">名称</span><div className="v">
        <input className={"input" + (nameErr ? " is-error" : "")} disabled={!isNew} value={draft.name} placeholder="例如：我的飞书多维表格"
          onChange={(e) => { setDraft({ ...draft, name: e.target.value }); if (nameErr) setNameErr(""); }} />
        <FieldError text={nameErr} />
      </div></div>
      <div className="field"><span className="k">类型</span><div className="v">
        <select className="select" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
          {kinds.includes(draft.kind) || kinds.length === 0 ? null : <option value={draft.kind}>{draft.kind}</option>}
          {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div></div>
      <div className="field"><span className="k">配置项</span><div className="v">
        {Object.entries(draft.options ?? {}).map(([k, v]) => {
          const secret = SECRET_KEY_RE.test(k);
          return (
            <div key={k} className="kv-row">
              <input className="input" value={k} readOnly={secret ? true : undefined} onChange={(e) => {
                const next = { ...(draft.options ?? {}) };
                delete next[k];
                next[e.target.value] = v;
                setDraft({ ...draft, options: next });
              }} />
              {secret ? (
                <input className="input" type="password" autoComplete="new-password" placeholder={v ? "已设置（••••••，输入以覆盖）" : "输入后不回显"} value=""
                  onChange={(e) => setDraft({ ...draft, options: { ...(draft.options ?? {}), [k]: e.target.value } })} />
              ) : (
                // 这里以前写的是 `[k]: v`，把受控输入钉回旧值，等于「配置项根本输不进去」。
                <input className="input" value={v} onChange={(e) => setDraft({ ...draft, options: { ...(draft.options ?? {}), [k]: e.target.value } })} />
              )}
              <button className="icon-btn" title="删除该配置项" aria-label="删除该配置项" onClick={() => {
                const next = { ...(draft.options ?? {}) };
                delete next[k];
                setDraft({ ...draft, options: next });
              }}><I n="close" size={12} /></button>
            </div>
          );
        })}
        <div className="kv-row">
          <input className="input" placeholder="键（如 app_id / url / path）" value={kvKey} onChange={(e) => setKvKey(e.target.value)} />
          <span />
          <button className="btn small" disabled={!kvKey.trim()} onClick={() => {
            setDraft({ ...draft, options: { ...(draft.options ?? {}), [kvKey.trim()]: "" } });
            setKvKey("");
          }}>加一项</button>
        </div>
      </div></div>
      <FieldError text={probeMsg} />
      <div className="btn-row">
        <label className="muted small"><input className="check-native" type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> 启用</label>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={saving} onClick={() => void go(true)}>仅测试连接</button>
        <button className="btn primary" disabled={saving || !draft.name.trim()} onClick={() => void go(false)}>{saving ? "保存中…" : "保存通道"}</button>
      </div>
      <p className="muted small">密钥类字段（app_secret/password 等）只存本机 meta，绝不进同步快照；界面上输入后不回显，也不打日志。</p>
    </Modal>
  );
}

/**
 * 运行环境的一行：标签在左、值在右，长值（路径 / 设备 ID）单占一行而不是折进两列网格。
 * copy 给了就在悬停时露出「复制」——排查问题时这两个值是要粘给别人看的，
 * 但平时不该占位，所以按钮默认透明、只在 hover/focus 时出现。
 */
function EnvRow({ lab, mono, copy, title, children }: {
  lab: string; mono?: boolean; copy?: string; title?: string; children: ReactNode;
}) {
  return (
    <div className="env-row">
      <span className="env-lab">{lab}</span>
      <span className={"env-val" + (mono ? " is-mono" : "")} title={title}>{children}</span>
      {copy && <button className="env-act" onClick={() => void copyToClipboard(copy)}>复制</button>}
    </div>
  );
}

/** WebView2 里 http://wails.localhost 不是安全上下文，navigator.clipboard 常常直接 reject，
 *  所以留一条 execCommand 的退路，而不是让用户点了没反应。 */
async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
    return;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    document.body.removeChild(ta);
    toast(ok ? "已复制到剪贴板" : "复制失败，请手动选中");
  }
}

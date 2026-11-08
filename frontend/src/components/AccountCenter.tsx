// AccountCenter.tsx —— 头像菜单里的「个人中心」：**写死的占位页**，没有账号体系也先把位置留好。
//
// 版式照参考站的 UserInfo 页（bundle 里 `name:"UserInfo"`）：
//   左上角「← 返回」 → 14% 宽的左引导栏（头像 + 昵称 + 竖排页签）→ 右侧标题 + 若干张白卡。
//   它的三张卡分别是 头像（图片裁剪）/ 绑定（手机·微信·QQ）/ 账号（注销用户，红字）。
// 我方对应改成：账号（未登录，登录暂未开放）/ 本机数据（这三行是真值，来自内核 BootInfo）/ 账号操作（退出登录，预留）。
// 「会员特权」页签不抄：本产品没有会员体系，留一个点不动的假页签比不画更糟。

import { setPage, toast, useApp } from "../store/appStore";
import { I } from "./ui";

export function AccountCenter() {
  const { boot, accountFrom } = useApp();

  return (
    <div className="account-page">
      <div className="ac-head">
        <button className="ac-return" onClick={() => setPage(accountFrom)}>
          <I n="chevronLeft" size={12} /><span>返回</span>
        </button>
      </div>

      <div className="ac-body">
        <aside className="ac-guide">
          <div className="ac-avatar">功</div>
          <div className="ac-nick">本地用户</div>
          <ul className="ac-tabs">
            <li className="is-sel"><I n="user" size={13} /><span>个人中心</span></li>
          </ul>
        </aside>

        <main className="ac-main">
          <h4 className="ac-title">个人中心</h4>

          <section className="ac-card">
            <div className="ac-row">
              <span className="ac-lab">头像</span>
              <span className="ac-val"><i className="ac-mini">功</i></span>
            </div>
            <div className="ac-row">
              <span className="ac-lab">昵称</span>
              <span className="ac-val">本地用户</span>
              <span className="ac-val is-dim" style={{ flex: "none" }}>改名要等账号体系</span>
            </div>
            <div className="ac-row">
              <span className="ac-lab">账号</span>
              <span className="ac-val is-dim">未登录 · 数据都在这台设备上</span>
              <button className="ac-act" onClick={() => toastSoon()}>登录（暂未开放）</button>
            </div>
          </section>

          <section className="ac-card">
            <div className="ac-row">
              <span className="ac-lab">数据目录</span>
              <span className="ac-val is-mono">{boot?.dataDir ?? "（还没与内核握手）"}</span>
            </div>
            <div className="ac-row">
              <span className="ac-lab">设备 ID</span>
              <span className="ac-val is-mono">{boot?.deviceId ?? "—"}</span>
            </div>
            <div className="ac-row">
              <span className="ac-lab">通道类型</span>
              {/* 这里是内核「已注册的通道类型」，不代表已配好通道——措辞与设置页保持一致，别让人以为四个通道都在跑 */}
              <span className="ac-val">{boot?.channelKinds.join(" / ") || "（无）"}</span>
              <button className="ac-act" onClick={() => setPage("settings")}>去设置</button>
            </div>
          </section>

          <section className="ac-card">
            <div className="ac-row">
              <span className="ac-lab">账号</span>
              <span className="ac-val is-dim">本地版本没有登录与注销，这里先留位</span>
              <button className="ac-act is-danger" onClick={() => toastSoon()}>退出登录</button>
            </div>
          </section>

          <p className="ac-note">
            这一页是占位：账号、登录、退出都还没做，本机数据不受影响。
            将来接了账号体系，「登录」走真实流程，「本机数据」这卡改成云端与同步状态。
          </p>
        </main>
      </div>
    </div>
  );
}

/** 预留动作的统一文案：不假装成功，也不动任何数据。菜单和页面都引用这一句。 */
export const LOGIN_TODO = "本地版本没有账号体系，登录与退出先留位";

/** 这一版没有账号：登录、退出都只回同一句说明。 */
function toastSoon() {
  toast(LOGIN_TODO);
}

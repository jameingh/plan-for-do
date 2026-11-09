import { toast } from "../store/appStore";

/** WebView2 里 http://wails.localhost 不是安全上下文，navigator.clipboard 常常直接 reject，
 *  所以留一条 execCommand 的退路，而不是让用户点了没反应。 */
export async function copyToClipboard(text: string): Promise<void> {
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

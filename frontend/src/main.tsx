import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { api } from "./api/client";
import "./styles/global.css";

/**
 * 把未捕获错误同时做两件事：画在页面上 + 交给内核落盘。
 *
 * 生产构建里 devtools 是关的，桌面壳崩一次只剩白屏，用户说不清、我也看不到栈。
 * 落盘那条自身可能失败（比如错误就出在桥上），所以 DOM 浮层是主、上报是尽力而为。
 */
function showFatal(where: string, detail: string) {
  const id = "planfordo-fatal";
  let box = document.getElementById(id);
  if (!box) {
    box = document.createElement("pre");
    box.id = id;
    box.setAttribute(
      "style",
      "position:fixed;inset:auto 12px 12px 12px;max-height:45%;overflow:auto;z-index:99999;" +
        "margin:0;padding:10px 12px;background:#2b1c1c;color:#ffd9d9;border:1px solid #7a3030;" +
        "border-radius:8px;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap"
    );
    document.body.appendChild(box);
  }
  box.textContent = `启动出错（${where}）\n${detail}`;
  void Promise.resolve(api.ReportError(where, detail)).catch(() => undefined);
}

window.addEventListener("error", (e) => {
  showFatal("同步", `${e.message}\n${e.filename ?? ""}:${e.lineno ?? "?"}:${e.colno ?? "?"}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason as { message?: string; stack?: string } | undefined;
  showFatal("异步", reason?.stack ?? reason?.message ?? String(reason));
});

/**
 * 渲染期错误边界：React 抛错会整棵树卸载（白屏），且不一定触发 window.onerror，
 * 所以点页签这类「切换时才崩」的问题必须靠边界才能抓到。
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { err: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err: Error) {
    return { err };
  }

  componentDidCatch(err: Error, info: React.ErrorInfo) {
    showFatal("渲染", `${err.message}\n${err.stack ?? ""}${info.componentStack ?? ""}`);
  }

  render() {
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

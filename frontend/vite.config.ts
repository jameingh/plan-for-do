import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wails from "@wailsio/runtime/plugins/vite";
import { existsSync } from "node:fs";

// bindings/ 目前还不存在（`wails3 generate bindings` 暂时跑不了：Go 侧同步通道包在补），
// 而 @wailsio/runtime 的 vite 插件强制要求 eventcreate 绑定，否则 build 报错。
// 因此在绑定生成前条件挂载：一旦 frontend/bindings 出现，插件自动恢复，无需改回代码。
const hasBindings = existsSync(new URL("./bindings", import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [react(), ...(hasBindings ? [wails("./bindings")] : [])],
});

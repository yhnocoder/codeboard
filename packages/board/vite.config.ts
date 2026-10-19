import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// 白板界面打包成一个入口 js（ES module）+ 一个 css，由宿主（VS Code webview）加载；
// Markdown 编辑器、Mermaid 这些用到时才 import() 的放在 chunks/ 里
export default defineConfig({
  plugins: [solid()],
  base: "./", // 字体用相对 css 的路径：webview 里没有站点根
  build: {
    outDir: "../../extensions/vscode/media/board",
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    // BOARD_SOURCEMAP=1 (nightly CI): source maps let the harness map each scenario's coverage back to source files
    sourcemap: !!process.env.BOARD_SOURCEMAP,
    rollupOptions: {
      input: "src/index.tsx",
      output: { entryFileNames: "board.js", assetFileNames: (a) => (a.names?.[0] ?? a.name ?? "").endsWith(".css") ? "board.css" : "fonts/[name][extname]", chunkFileNames: "chunks/[name]-[hash].js", format: "es" },
    },
  },
});

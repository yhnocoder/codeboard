import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// 白板界面打包成一个 js + 一个 css，由宿主（VS Code webview）加载
export default defineConfig({
  plugins: [solid()],
  base: "./", // 字体用相对 css 的路径：webview 里没有站点根
  build: {
    outDir: "../../extensions/vscode/media/board",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/index.tsx",
      output: { entryFileNames: "board.js", assetFileNames: (a) => (a.names?.[0] ?? a.name ?? "").endsWith(".css") ? "board.css" : "fonts/[name][extname]", format: "iife" },
    },
  },
});

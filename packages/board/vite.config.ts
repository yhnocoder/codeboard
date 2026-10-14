import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// 白板界面打包成一个 js + 一个 css，由宿主（VS Code webview）加载
export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: "../../extensions/vscode/media/board",
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/index.tsx",
      output: { entryFileNames: "board.js", assetFileNames: "board[extname]", format: "iife" },
    },
  },
});

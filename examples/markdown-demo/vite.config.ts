import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// @codeboard/markdown 发的是源码（和 core 一样，main 是 src/index.ts）：编辑器的界面是 Solid 写的，所以这里要 vite-plugin-solid。
// 只读的入口不带 Solid 界面；编辑器那一块（@codeboard/markdown/editor）和 Mermaid（pele）是 import() 的，打成单独的 chunk
export default defineConfig({
  plugins: [solid()],
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  preview: { port: 4317, strictPort: true },
});

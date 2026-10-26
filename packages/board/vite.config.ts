import * as fs from "node:fs";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { build } from "esbuild";

// import x from "./a.ts?script"：把 a.ts 单独打包成一段 IIFE，x 是它的源码字符串（导出的 HTML 里内联的查看脚本）。小样（.storybook/vite.config.ts）也用它
export function scriptString(): Plugin {
  return {
    name: "script-string",
    async load(id) {
      if (!id.endsWith("?script")) return;
      const r = await build({ entryPoints: [id.slice(0, -"?script".length)], bundle: true, write: false, format: "iife", minify: true, target: "es2020" });
      return `export default ${JSON.stringify(r.outputFiles[0].text)};`;
    },
  };
}

// With BOARD_SOURCEMAP: the board's source maps go through the maps of the built packages it uses (@yhnocoder/markdown's dist/) back
// to their sources, so the nightly coverage sees packages/markdown/src
function inputSourcemaps(): Plugin {
  return {
    name: "input-sourcemaps",
    load(id) {
      if (!/\/packages\/[^/]+\/dist\/.*\.js$/.test(id) || id.includes("/node_modules/") || !fs.existsSync(id + ".map")) return;
      return { code: fs.readFileSync(id, "utf8"), map: fs.readFileSync(id + ".map", "utf8") };
    },
  };
}

// 白板界面打包成一个入口 js（ES module）+ 一个 css，由宿主（VS Code webview）加载；
// Markdown 编辑器、Mermaid 图（pele）这些用到时才 import() 的放在 chunks/ 里
export default defineConfig({
  plugins: [solid(), scriptString(), ...(process.env.BOARD_SOURCEMAP ? [inputSourcemaps()] : [])],
  base: "./", // 字体用相对 css 的路径：webview 里没有站点根
  build: {
    outDir: "../../extensions/vscode/media/board",
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    // BOARD_SOURCEMAP=1 (nightly CI): source maps let the harness map each scenario's coverage back to source files
    sourcemap: !!process.env.BOARD_SOURCEMAP,
    rolldownOptions: {
      input: "src/index.tsx",
      output: { entryFileNames: "board.js", assetFileNames: (a) => (a.names?.[0] ?? a.name ?? "").endsWith(".css") ? "board.css" : "fonts/[name][extname]", chunkFileNames: "chunks/[name]-[hash].js", format: "es" },
    },
  },
});

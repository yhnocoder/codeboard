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
// to their sources, so the regular-run coverage sees packages/markdown/src
function inputSourcemaps(): Plugin {
  return {
    name: "input-sourcemaps",
    load(id) {
      if (!/\/packages\/[^/]+\/dist\/.*\.js$/.test(id) || id.includes("/node_modules/") || !fs.existsSync(id + ".map")) return;
      return { code: fs.readFileSync(id, "utf8"), map: fs.readFileSync(id + ".map", "utf8") };
    },
  };
}

// 白板界面打包成入口 js（ES module：board.js 给 VS Code，boot.js 给自带通道的页面）+ 一个 css，放在 dist/，由宿主（VS Code webview）加载：插件的构建把它拷进 media/board；
// Markdown 编辑器、Mermaid 图（pele）这些用到时才 import() 的放在 chunks/ 里
export default defineConfig({
  plugins: [solid(), scriptString(), ...(process.env.BOARD_SOURCEMAP ? [inputSourcemaps()] : [])],
  base: "./", // 字体用相对 css 的路径：webview 里没有站点根
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    // BOARD_SOURCEMAP=1 (the regular CI runs): source maps let the harness map each scenario's coverage back to source files
    sourcemap: !!process.env.BOARD_SOURCEMAP,
    rolldownOptions: {
      // board.js: the VS Code webview's entry; boot.js: boot() for pages that bring their own way to the host (the harness)
      input: { board: "src/index.tsx", boot: "src/boot.tsx" },
      output: { entryFileNames: "[name].js", assetFileNames: (a) => (a.names?.[0] ?? a.name ?? "").endsWith(".css") ? "board.css" : "fonts/[name][extname]", chunkFileNames: "chunks/[name]-[hash].js", format: "es" },
    },
  },
});

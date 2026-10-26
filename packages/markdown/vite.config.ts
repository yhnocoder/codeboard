import * as fs from "node:fs";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

// The npm build (dist/), which is also what the board and examples/markdown-demo use: the Solid JSX compiled for the DOM (so a
// consumer needs no vite-plugin-solid), one ES module per source file (the lazy entries and import()s stay separate), every
// dependency and solid-js left to the consumer, source maps back to src/. The declarations come from tsc (tsconfig.build.json).
const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const deps = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];

// The stylesheets as they are: style.css has no url() or @import, katex.css imports KaTeX's own (katex is a dependency, so its
// fonts load from the katex package, relative to its stylesheet)
function stylesheets(): Plugin {
  const files = { "style.css": "src/markdown.css", "katex.css": "src/katex.css" };
  return {
    name: "stylesheets",
    generateBundle() {
      for (const [fileName, src] of Object.entries(files)) this.emitFile({ type: "asset", fileName, source: fs.readFileSync(new URL(src, import.meta.url), "utf8") });
    },
  };
}

export default defineConfig({
  plugins: [solid(), stylesheets()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    minify: false,
    sourcemap: true,
    lib: { entry: ["src/index.ts", "src/editor/index.tsx", "src/cm/editor.ts", "src/ui/index.ts"], formats: ["es"] },
    rolldownOptions: {
      external: (id) => deps.some((d) => id === d || id.startsWith(d + "/")),
      output: { preserveModules: true, preserveModulesRoot: "src", entryFileNames: "[name].js" },
    },
  },
});

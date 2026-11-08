import { defineConfig } from "vite";

// The card page (index.html + main.ts) as one folder the app bundles (apps/macos/build.sh copies dist/web into Resources/web):
// @yhnocoder/markdown as built (its dist/), the board's stylesheets and fonts from packages/board/src
export default defineConfig({
  root: __dirname,
  base: "./",
  build: { outDir: "../dist/web", emptyOutDir: true, target: "safari18", modulePreload: false },
  define: { "import.meta.env.DEV": "false" },
  // the page is loaded from file:: a module script marked crossorigin is refused there (opaque origin), silently
  plugins: [{ name: "no-crossorigin", transformIndexHtml: (html) => html.replace(/ crossorigin/g, "") }],
});

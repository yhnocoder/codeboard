import { defineConfig } from "vite";

// @yhnocoder/markdown as published (its dist/, the Solid JSX already compiled): no vite-plugin-solid, solid-js is only installed.
// The read-only entry has no Solid UI; the editor (@yhnocoder/markdown/editor) and Mermaid (pele) are import()ed, so they become
// chunks of their own
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  preview: { port: 4317, strictPort: true },
});

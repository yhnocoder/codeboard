import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig(({ mode }) => ({
  plugins: mode === "single" ? [solid(), viteSingleFile()] : [solid()],
  build: mode === "single" ? { outDir: "dist-single" } : {},
}));

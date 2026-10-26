import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
// Vite 8 用 Node 直接加载配置，导入要写 .ts 后缀
import { scriptString } from "../vite.config.ts";

export default defineConfig({ plugins: [solid(), scriptString()] });

import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { scriptString } from "./vite.config.ts";

// 白板模块的单元测试（走线、label 位置、换白板时的界面状态等）；界面行为走 test/scenarios/（Playwright Test，见 playwright.config.ts）。
// 默认不碰 DOM；要 DOM 和响应式的文件开头写 // @vitest-environment happy-dom（插件和打包时一样：编译 .tsx、?script）
export default defineConfig({ plugins: [solid(), scriptString()], test: { include: ["test/unit/**/*.test.ts"], environment: "node" } });

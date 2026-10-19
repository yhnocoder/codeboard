import { defineConfig } from "vitest/config";

// 白板里不碰 DOM 的模块的单元测试（走线、label 位置等）；界面行为走 test/run-harness.mjs
export default defineConfig({ test: { include: ["test/unit/**/*.test.ts"], environment: "node" } });

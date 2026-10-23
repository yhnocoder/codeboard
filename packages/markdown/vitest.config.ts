import { defineConfig } from "vitest/config";

// Markdown 的解析 / 写回、静态显示、打字规则的单元测试（不建编辑器界面；要 DOM 的文件自己选 jsdom / happy-dom）
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node" } });

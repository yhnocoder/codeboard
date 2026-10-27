import { defineConfig } from "vitest/config";

// npm test: the unit tests of every package in one run, the packages side by side (each keeps its own vitest config: host still runs
// its files one at a time)
export default defineConfig({ test: { projects: ["packages/core", "packages/markdown", "packages/board", "packages/host", "extensions/vscode"] } });

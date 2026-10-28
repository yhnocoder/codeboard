import { defineConfig } from "vitest/config";

// Analysis tests are pure functions over source text (no mocks, no fake timers): the files share their workers' module cache, so
// tree-sitter and its grammars start once per worker instead of once per file
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node", isolate: false } });

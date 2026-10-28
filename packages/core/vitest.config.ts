import { defineConfig } from "vitest/config";

// Core's tests are pure functions over boards and text (no mocks, no fake timers, no global state they rely on being fresh): the
// files share their workers' module cache instead of each starting a worker and importing core again
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node", isolate: false } });

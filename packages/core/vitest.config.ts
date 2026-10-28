import { defineConfig } from "vitest/config";

// Core's tests are pure functions over boards and text (no mocks, no fake timers, no global state they rely on being fresh): the
// files share their workers' module cache instead of each starting a worker and importing core again.
// The timeout is only a ceiling: the first Tidy Up test loads ELK (1.6 MB), which on a busy machine took longer than vitest's 5 s
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node", isolate: false, testTimeout: 30000 } });

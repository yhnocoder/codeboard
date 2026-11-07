import { defineConfig } from "vitest/config";

// innerbox's tests are pure: an in-memory embedder, no server, no files
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node", isolate: false } });

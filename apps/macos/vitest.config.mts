import { defineConfig } from "vitest/config";

// The bridge's tests run in plain Node with a Node Fs (test/node-native.ts) on copies of board files, never on the real ones
export default defineConfig({ test: { include: ["js/test/**/*.test.ts"], environment: "node", testTimeout: 30000 } });

import { defineConfig } from "vitest/config";

// Host tests in plain Node with a Node Workspace (test/node-workspace.ts), on a copy of nano-vllm and small git repos made by the tests.
// Several tests measure timing (prefetch queue, background indexing), so the files run one at a time.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/setup.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});

import { defineConfig } from "vitest/config";

// Host tests in plain Node with a Node Workspace (test/node-workspace.ts), on a copy of nano-vllm and small git repos made by the tests.
// The files run side by side: none of them changes the shared copy of nano-vllm (WS) in a way the others' scans would see.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});

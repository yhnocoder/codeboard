import { defineConfig } from "vitest/config";

// The client against the real binary (npm run build -w @codeboard/box), each test file with its own data folder
export default defineConfig({ test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 30000 } });

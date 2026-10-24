// The demo's end-to-end test: the built page (npm test builds it first) served by vite preview, in Playwright's Chromium.
// The browser and its flags are the repo's one definition (tools/test/chromium.mjs, as for the board harness); only this config
// reaches outside the example, the page and the test import nothing but @yhnocoder/markdown
import * as path from "node:path";
import { defineConfig } from "@playwright/test";
import { CHROMIUM, CHROMIUM_ARGS } from "../../tools/test/chromium.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  testDir: "test",
  outputDir: path.join(here, "../../test-out/markdown-demo"),
  forbidOnly: true,
  retries: 0,
  timeout: 20e3,
  reporter: "list",
  webServer: { command: "npx vite preview", cwd: here, url: "http://localhost:4317/", reuseExistingServer: false, timeout: 30e3 },
  use: { baseURL: "http://localhost:4317/", launchOptions: { executablePath: CHROMIUM, args: CHROMIUM_ARGS }, actionTimeout: 5e3 },
});

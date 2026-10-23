// The demo's end-to-end test: the built page (npm test builds it first) served by vite preview, in Playwright's Chromium.
// CHROMIUM: the browser CI installs (.github/actions/chromium); otherwise the preinstalled one, as for the board harness
import * as path from "node:path";
import { defineConfig } from "@playwright/test";

const here = path.dirname(new URL(import.meta.url).pathname);
const CHROMIUM = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

export default defineConfig({
  testDir: "test",
  outputDir: path.join(here, "../../test-out/markdown-demo"),
  forbidOnly: true,
  retries: 0,
  timeout: 20e3,
  reporter: "list",
  webServer: { command: "npx vite preview", cwd: here, url: "http://localhost:4317/", reuseExistingServer: false, timeout: 30e3 },
  use: { baseURL: "http://localhost:4317/", launchOptions: { executablePath: CHROMIUM }, actionTimeout: 5e3 },
});

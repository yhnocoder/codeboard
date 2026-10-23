// Playwright's Chromium for every browser test (board harness, perf, the Markdown demo): CHROMIUM (CI, .github/actions/chromium)
// or the preinstalled one, and the flags they all launch it with
export const CHROMIUM = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
export const CHROMIUM_ARGS = ["--allow-file-access-from-files"];

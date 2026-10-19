/** Playwright's Chromium for the harness and perf: CHROMIUM (CI, .github/actions/chromium) or the preinstalled one */
export const CHROMIUM = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
export const CHROMIUM_ARGS = ["--allow-file-access-from-files"];

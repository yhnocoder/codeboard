// Playwright's Chromium for every browser test (board harness, perf, the Markdown demo): CHROMIUM (CI, .github/actions/chromium)
// or the cloud image's preinstalled one, and the flags they all launch it with.
// /opt/pw-browsers/chromium is the image's link to whatever Chromium it ships: a revision path (chromium-NNNN) breaks
// whenever the image or our playwright-core version moves on.
export const CHROMIUM = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium";
export const CHROMIUM_ARGS = ["--allow-file-access-from-files"];

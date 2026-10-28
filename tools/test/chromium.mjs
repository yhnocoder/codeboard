// /opt/pw-browsers/chromium is the image's link to whatever Chromium it ships: a revision path (chromium-NNNN) breaks
// whenever the image or our playwright-core version moves on.
import { chromium } from "playwright-core";

export const CHROMIUM = process.env.CHROMIUM ?? "/opt/pw-browsers/chromium";
export const CHROMIUM_ARGS = ["--allow-file-access-from-files"];

/** Chromium for any script (repo tests, review tools, one-off checks): the repo's playwright-core with the browser above. A bare
 *  require("playwright") looks for the browser revision its own version pins, which the cloud image does not ship */
export const launch = (options = {}) => chromium.launch({ executablePath: CHROMIUM, args: CHROMIUM_ARGS, ...options });

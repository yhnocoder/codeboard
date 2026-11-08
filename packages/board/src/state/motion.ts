// How fast the board animates: the system's "reduce motion" and the slow-motion setting. It imports only still.ts (no imports of
// its own), so any state module can use it without a cycle
import { still } from "./still";
// Made once: .matches follows the system setting (and emulateMedia). A new MediaQueryList each time costs, and animations ask
// dozens of times per frame
const motionQ = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
/** A still picture animates nothing either: whatever moves is drawn where it ends */
export const reduceMotion = () => still() || !!motionQ?.matches;

/** The animation speed factor (styles.css --t: the slow-motion setting, reduced motion): CSS durations are multiplied by it, so
 *  a JS timer waiting for an animation must be too */
export const animScale = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--t")) || 1;

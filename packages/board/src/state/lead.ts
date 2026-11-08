// Where the camera will be a few frames from now. A card culled off screen (cull.ts) and a Note not rendered yet (md/lazy.ts)
// are hidden; what is hidden must be shown, and painted, before it can come into view: shown in the frame it comes into view,
// its tiles are rastered for the very frame that has to show them, and on a GPU short of tile memory that frame showed it blank.
// So both treat what the camera will show LEAD frames on, if it keeps the motion of its last frame, as in view: shown at once,
// with no budget. A frame is the camera's change between two animation frames (a wheel step, a pinch step, a fling's or a
// flight's frame). Ahead is at most a viewport further each way: a camera that jumps further in one frame (a board switch, a
// reveal set at once) is not a motion to follow
import { cam, view } from "./camera";

/** How many frames ahead: shown two frames before it comes into view, it is drawn in a frame of its own and its tiles are
 *  there (Chromium does not commit a frame while the one before it waits for its tiles), with a frame to spare for a step
 *  larger than the one before */
const LEAD = 3;

/** The camera at the last animation frame after a call (null before the first) */
let was: { x: number; y: number; z: number } | null = null;
/** A frame's snap is asked for */
let armed = false;
const snap = () => {
  armed = false;
  was = { x: cam.x, y: cam.y, z: cam.z };
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A box on screen (CSS px of the board's viewport) */
export type ScreenBox = { l: number; t: number; r: number; b: number };

/**
 * The viewport, grown to what the camera will show LEAD frames from now: in screen px of the current camera. Reads the camera
 * (tracked in a memo or an effect); the camera a frame ago is taken in the next animation frame after any call
 */
export function leadView(): ScreenBox {
  const { w, h } = view();
  const z = cam.z,
    x = cam.x,
    y = cam.y;
  if (!armed) {
    armed = true;
    requestAnimationFrame(snap);
  }
  if (!was) return { l: 0, t: 0, r: w, b: h };
  const { x: px, y: py, z: pz } = was;
  // each edge of the viewport in world units a frame ago and now; moved on LEAD times as far, then back to screen px
  const ahead = (now: number, prev: number) => (now - prev) * LEAD * z;
  return {
    l: clamp(ahead(-x / z, -px / pz), -w, 0),
    t: clamp(ahead(-y / z, -py / pz), -h, 0),
    r: w + clamp(ahead((w - x) / z, (w - px) / pz), 0, w),
    b: h + clamp(ahead((h - y) / z, (h - py) / pz), 0, h),
  };
}

/** The box (screen px) meets the lead view */
export const meets = (v: ScreenBox, l: number, t: number, r: number, b: number) =>
  r > v.l && l < v.r && b > v.t && t < v.b;

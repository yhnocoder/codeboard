// Where the camera will be a few frames from now. A card culled off screen (cull.ts) and a Note not rendered yet (md/lazy.ts)
// are hidden; what is hidden must be shown, and painted, before it can come into view: shown in the frame it comes into view,
// its tiles are rastered for the very frame that has to show them, and on a GPU short of tile memory that frame showed it blank.
// So both treat what the camera will show LEAD frames on, if it keeps the motion of its last frame, as in view: shown at once,
// with no budget. A frame is the camera's change between two animation frames (a wheel step, a pinch step, a fling's or a
// flight's frame), so the camera a frame ago is taken at every animation frame while the lead view is asked for, and forgotten
// a few frames after it was last asked for: a lead view asked for after a pause (the cards woken from the summaries, a board switch, a camera
// set while nothing watched it) has no frame before it to follow and is the plain viewport. A camera that moves an edge more than
// a viewport in one frame (a board switch, a reveal set at once, a jump with reduced motion) is not a motion to follow either;
// ahead is at most a viewport further each way
import { cam, view } from "./camera";

/** How many frames ahead: shown two frames before it comes into view, it is drawn in a frame of its own and its tiles are
 *  there (Chromium does not commit a frame while the one before it waits for its tiles), with a frame to spare for a step
 *  larger than the one before */
const LEAD = 3;

/** Animation frames with no call after which the camera a frame ago is forgotten: a wheel sends a step every frame or two */
const KEEP = 4;

/** The camera at the last animation frame, taken while the lead view is asked for (null: not asked for KEEP frames) */
let was: { x: number; y: number; z: number } | null = null;
/** The snapshot loop runs */
let armed = false;
/** Animation frames since the last call */
let quiet = 0;
const snap = () => {
  if (++quiet > KEEP) {
    // the loop stops, and what it took is no longer the frame before the next call
    armed = false;
    was = null;
    return;
  }
  was = { x: cam.x, y: cam.y, z: cam.z };
  requestAnimationFrame(snap);
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A box on screen (CSS px of the board's viewport) */
export type ScreenBox = { l: number; t: number; r: number; b: number };

/**
 * The viewport, grown to what the camera will show LEAD frames from now: in screen px of the current camera. Reads the camera
 * (tracked in a memo or an effect); the camera a frame ago is taken at each animation frame until KEEP frames pass with no call
 */
export function leadView(): ScreenBox {
  const { w, h } = view();
  const z = cam.z,
    x = cam.x,
    y = cam.y;
  quiet = 0;
  if (!armed) {
    armed = true;
    requestAnimationFrame(snap);
  }
  const plain = { l: 0, t: 0, r: w, b: h };
  if (!was) return plain;
  const { x: px, y: py, z: pz } = was;
  // each edge of the viewport's move in the last frame, in screen px: from world units a frame ago to now
  const step = (now: number, prev: number) => (now - prev) * z;
  const l = step(-x / z, -px / pz),
    t = step(-y / z, -py / pz),
    r = step((w - x) / z, (w - px) / pz),
    b = step((h - y) / z, (h - py) / pz);
  if (Math.max(Math.abs(l), Math.abs(r)) > w || Math.max(Math.abs(t), Math.abs(b)) > h) return plain;
  // moved on LEAD times as far
  return {
    l: clamp(l * LEAD, -w, 0),
    t: clamp(t * LEAD, -h, 0),
    r: w + clamp(r * LEAD, 0, w),
    b: h + clamp(b * LEAD, 0, h),
  };
}

/** The box (screen px) meets the lead view */
export const meets = (v: ScreenBox, l: number, t: number, r: number, b: number) =>
  r > v.l && l < v.r && b > v.t && t < v.b;

// The detent at the summary cut and the switch between the two levels (SUMMARY.detent), as pure rules over the push (0…1,
// through at 1) and the switch's progress: what the board's state/summary.ts and the macOS app run, so a zoom gesture stops,
// pushes, drains and switches the same way on both.
import { SUMMARY } from "../summary";

const D = SUMMARY.detent;
/** What the shell draws for the detent and the switch: the mist's height (of the viewport; D.cover covers the board whole),
 *  the vermilion line's fill, whether the seal shows and which level it announces */
export type Detent = { mist: number; line: number; seal: boolean; to: 0 | 1 };
export const DETENT_REST: Detent = { mist: 0, line: 0, seal: false, to: 1 };
/** Let go before it is through, the push starts draining this long after the last step (ms) */
export const DRAIN_AFTER = D.drainAfter;
/** The level a zoom shows: 1 (summaries) below the cut */
export const levelFor = (z: number, cut: number): 0 | 1 => (cut > 0 && z < cut ? 1 : 0);
/** A zoom step from z0 to z is towards the cut from the level shown */
export const towardCut = (z0: number, z: number, cut: number, shown: 0 | 1) =>
  shown === 0 ? z < z0 && z <= cut : z > z0 && z >= cut;
/** The push after a step held at the cut: how far it would have gone past, in notches */
export const pushStep = (push: number, z0: number, z: number) =>
  Math.min(1, push + Math.min(1, Math.abs(Math.log(z / z0)) / D.notch));
/** What shows while pushed q of the way */
export const pushed = (q: number, to: 0 | 1): Detent => ({ mist: q * D.mist, line: q, seal: q >= D.seal, to });
/** Let go before it is through, the push drains over dt seconds */
export const drainStep = (push: number, dt: number) => Math.max(0, push - dt * D.drain);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
/** The switch's length in ms, and what shows at t (0…1) of it starting from mist0: covered from `cover` on, when the levels
 *  swap under the mist */
export const SWITCH_MS = D.coverMs + D.clearMs;
export const SWITCH_COVER = D.coverMs / SWITCH_MS;
export function switching(t: number, mist0: number, to: 0 | 1): Detent {
  if (t < SWITCH_COVER) return { mist: mist0 + (D.cover - mist0) * easeOut(t / SWITCH_COVER), line: 1, seal: true, to };
  const k = (t - SWITCH_COVER) / (1 - SWITCH_COVER);
  return { mist: D.cover * (1 - easeInOut(k)), line: 1 - k, seal: k < 0.15, to };
}
/** The camera just across the cut around the push point, so the zoom goes on from the other side */
export const acrossCut = (cut: number, to: 0 | 1) => (to === 1 ? cut * 0.9 : cut * 1.1);

// Sub-board scenarios (subboards.spec.ts, boards.spec.ts, subboard-card.spec.ts) on the real host (realhost.ts): one board panel
// that the host switches between boards (crumbs, cameras, walkthrough hops), skeletons pushed after saves, boards made, dropped,
// restored and deleted in its storage.
import type { Board } from "@codeboard/core";
import { hostBoards, light } from "./fixtures";

/**
 * o.light: this scenario's theme whatever HARNESS_LIGHT says (for one that compares colours with a light design).
 * o.beforeSwitch: runs after an enterBoard / leaveBoard is accepted and before the next board's init reaches the page (the board
 * is mid-transition)
 */
export async function subHost(
  start: Board,
  others: Board[],
  o: { light?: boolean; beforeSwitch?: () => Promise<void> } = {},
) {
  const run = await hostBoards([start, ...others], {
    page: { light: o.light ?? light, w: 1400, h: 900 },
    beforeSwitch: o.beforeSwitch,
  });
  const h = await run.open(start.id);
  const panel = () => run.host.hub.all()[0];
  return { store: run.host.store, h, inits: run.inits, cur: () => panel().id, crumbs: () => panel().crumbs };
}

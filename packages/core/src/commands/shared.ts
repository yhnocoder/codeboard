// The same card in several places: pasting cards (as copies or as the same cards), Reference / Detach
import type { Board, Link } from "../model";
import { detachTwin, makeTwin, placeCards, type CardCopy } from "../edit";
import type { CommandEnv } from "./env";

/**
 * Paste cards in one step, moved by (dx, dy) with their relative places kept and the arrows between them. copy = independent copies
 * (new ids), else the cards as they are (same ids; ones already here are skipped). settle(b, id) files each placed card in the
 * Section it landed in. pairs = [placed id, the card it was made from] for the cards with a place; segs = segment ids old → new
 */
export function pasteCards(
  env: CommandEnv,
  items: CardCopy[],
  links: Link[],
  o: { copy: boolean; dx: number; dy: number; settle: (b: Board, id: string) => void },
): { pairs: [string, string][]; segs: Record<string, string> } | null {
  const tops = items.filter((x) => x.place);
  let pairs: [string, string][] = [],
    segs: Record<string, string> = {};
  const ok = env.edit((b) => {
    const m = placeCards(b, items, { copy: o.copy, links, at: (p) => ({ ...p, x: p.x + o.dx, y: p.y + o.dy }) });
    pairs = tops.filter((x) => m.cards[x.card.id]).map((x) => [m.cards[x.card.id], x.card.id]);
    segs = m.segs;
    for (const [id] of pairs) o.settle(b, id);
  });
  return ok ? { pairs, segs } : null;
}

/** Reference: pasted copies become the same cards as their originals (editing one changes the other). How many did */
export function makeReferences(env: CommandEnv, pairs: [string, string][]): number {
  let n = 0;
  return env.edit((b) => {
    for (const [id, of] of pairs) if (makeTwin(b, id, of)) n++;
  })
    ? n
    : 0;
}

/** Detach: these places of the same card become copies of their own; their segments get new ids (old → new) */
export function detachTwins(env: CommandEnv, ids: string[]): Record<string, string> | null {
  const segs: Record<string, string> = {};
  return env.edit((b) => {
    for (const id of ids) Object.assign(segs, detachTwin(b, id));
  })
    ? segs
    : null;
}

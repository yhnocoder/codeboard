// Keeping a code card fitted to its content when what it shows under its lines changes
import { uid, type Board, type Sidenote } from "../model";
import type { CommandEnv } from "./env";

/**
 * How a shell measures a code card for keeping it fitted: `measure` = the height of its code area (Place.h) that shows all its
 * content as laid out now, and that content's height (body); `codeMax` = the most a code card without a stored height grows to
 */
export type FitMeasure = { measure(cardId: string): { h: number; body: number } | null; codeMax: number };

/** A sidenote drawn under its lines (Always Show): the only part of a Highlight that takes room in its card */
export const shownUnder = (n: Sidenote) => n.kind === "text" && !!n.alwaysShow && !!n.at.lines;

/** fit, when a change to a card's Highlights can show or hide notes under its lines (it has Always Show ones, or adds them);
 *  undefined otherwise: a Highlight alone never changes a card's size, so nothing is refitted */
export const fitIfShown = (
  b: Pick<Board, "sidenotes">,
  card: string,
  fit: FitMeasure | undefined,
  adding: Sidenote[] = [],
) => ([...b.sidenotes, ...adding].some((n) => n.at.card === card && shownUnder(n)) ? fit : undefined);

/**
 * A change to what code cards show under their lines (an Always Show sidenote shown, hidden, written, added or deleted, or removed
 * with its Highlight). A card that showed all its content fits it again after the change, in the same undo step: the change is
 * made, the shell lays it out and measures, and the new height is folded into the change's step. That is a card whose stored
 * height fitted its content (Fit Content, or dragged to it), and a card without a stored height whose content was no taller than
 * codeMax: notes shown under its lines never push its code out of view, it grows past codeMax with them (its height stored) and
 * back. As Fit Content, content no taller than codeMax keeps no height. A card without a stored height that already scrolled
 * (its code alone taller than codeMax) keeps scrolling, and one with a height set by hand that does not fit its content keeps it
 */
export function keepFitted(
  env: CommandEnv,
  cardIds: string | Iterable<string>,
  fit: FitMeasure | undefined,
  change: (b: Board) => void,
) {
  const b0 = env.board();
  const fitted = fit
    ? [...new Set(typeof cardIds === "string" ? [cardIds] : cardIds)].filter((id) => {
        const p = b0.place[id];
        if (!p || b0.cards.find((c) => c.id === id)?.kind !== "code") return false;
        const m = fit.measure(id);
        if (!m) return false;
        return p.h === undefined ? m.body <= fit.codeMax : Math.abs(m.h - p.h) <= 1;
      })
    : [];
  const merge = uid("fit");
  if (!env.edit(change, fitted.length ? { merge } : undefined) || !fit) return;
  for (const id of fitted) {
    const now = fit.measure(id);
    if (!now) continue;
    const h = now.body <= fit.codeMax ? undefined : Math.round(now.h);
    if (h === env.board().place[id]?.h) continue;
    env.edit(
      (b) => {
        const p = b.place[id];
        if (p) p.h = h;
      },
      { merge },
    );
  }
}

// Keeping a code card fitted to its content when what it shows under or beside its lines changes
import { uid, type Board } from "../model";
import type { CommandEnv } from "./env";

/**
 * How a shell measures a code card for keeping it fitted: `measure` = the height of its code area (Place.h) that shows all its
 * content as laid out now, and that content's height (body); `codeMax` = the most a code card without a stored height grows to
 */
export type FitMeasure = { measure(cardId: string): { h: number; body: number } | null; codeMax: number };

/**
 * A change to what a code card shows under its lines (an Always Show sidenote shown, hidden, written, added or deleted; a Highlight made, grown or removed, which moves its lines and can change the gutter). A card whose
 * stored height fitted its content (Fit Content, or dragged to it) fits it again after the change, in the same undo step: the
 * change is made, the shell lays it out and measures, and the new height is folded into the change's step. As Fit Content,
 * content no taller than codeMax keeps no height. A card without a stored height follows its content anyway; one with a height
 * set by hand that does not fit its content keeps it
 */
export function keepFitted(env: CommandEnv, cardId: string, fit: FitMeasure | undefined, change: (b: Board) => void) {
  const b0 = env.board(),
    p0 = b0.place[cardId];
  const fitted =
    fit &&
    p0?.h !== undefined &&
    b0.cards.find((c) => c.id === cardId)?.kind === "code" &&
    Math.abs((fit.measure(cardId)?.h ?? Number.NaN) - p0.h) <= 1;
  const merge = uid("fit");
  if (!env.edit(change, fitted ? { merge } : undefined) || !fitted) return;
  const now = fit.measure(cardId);
  if (!now) return;
  const h = now.body <= fit.codeMax ? undefined : Math.round(now.h);
  if (h === env.board().place[cardId]?.h) return;
  env.edit(
    (b) => {
      const p = b.place[cardId];
      if (p) p.h = h;
    },
    { merge },
  );
}

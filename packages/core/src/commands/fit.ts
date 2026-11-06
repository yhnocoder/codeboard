// Keeping a code card fitted to its content when what it shows under or beside its lines changes
import { uid, type Board } from "../model";
import type { CommandEnv } from "./env";
import { fitWidth } from "./sections";

/**
 * How a shell measures a code card for keeping it fitted: `measure` = the height of its code area (Place.h) that shows all its
 * content as laid out now, that content's height (body) and the width its longest shown line needs with the gutter as drawn now
 * (w, as Fit Content measures it); `codeMax` = the most a code card without a stored height grows to
 */
export type FitMeasure = {
  measure(cardId: string): { h: number; body: number; w?: number } | null;
  codeMax: number;
};

/**
 * A change to what code cards show under or beside their lines (an Always Show sidenote shown, hidden, written, added or deleted;
 * a Highlight made, grown or removed, which moves its lines and can widen the gutter). A card whose stored width or height fitted
 * its content (Fit Content, or dragged to it) fits it again after the change, in the same undo step: the change is made, the shell
 * lays it out and measures, and the new size is folded into the change's step. The width first, since the height is measured at
 * it. As Fit Content, content no taller than codeMax keeps no height. A card without a stored height follows its content anyway;
 * a size set by hand that does not fit its content stays
 */
export function keepFitted(
  env: CommandEnv,
  cardIds: string | Iterable<string>,
  fit: FitMeasure | undefined,
  change: (b: Board) => void,
) {
  const b0 = env.board();
  const near = (a: number | undefined, z: number) => a !== undefined && Math.abs(a - z) <= 1;
  const fitted = fit
    ? [...new Set(typeof cardIds === "string" ? [cardIds] : cardIds)].flatMap((id) => {
        const c = b0.cards.find((k) => k.id === id),
          p = b0.place[id],
          m = c?.kind === "code" && p ? fit.measure(id) : null;
        if (!m) return [];
        const w = m.w !== undefined && near(fitWidth(c, m.w), p.w),
          h = p.h !== undefined && near(m.h, p.h);
        return w || h ? [{ id, w, h }] : [];
      })
    : [];
  const merge = uid("fit");
  if (!env.edit(change, fitted.length ? { merge } : undefined) || !fit) return;
  const resize = (id: string, set: (p: Board["place"][string]) => void) => {
    env.edit(
      (b) => {
        const p = b.place[id];
        if (p) set(p);
      },
      { merge },
    );
  };
  for (const f of fitted) {
    const c = env.board().cards.find((k) => k.id === f.id);
    if (f.w) {
      const w = fit.measure(f.id)?.w;
      const nw = w === undefined ? undefined : fitWidth(c, w);
      if (nw !== undefined && nw !== env.board().place[f.id]?.w) resize(f.id, (p) => (p.w = nw));
    }
    if (!f.h) continue;
    const now = fit.measure(f.id);
    if (!now) continue;
    const h = now.body <= fit.codeMax ? undefined : Math.round(now.h);
    if (h !== env.board().place[f.id]?.h) resize(f.id, (p) => (p.h = h));
  }
}

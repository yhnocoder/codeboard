// What is selected on the board (cards, links, Sections, a range of lines). The host hears of it a moment after it changes
import { batch } from "solid-js";
import { createStore } from "solid-js/store";
import type { Board } from "@codeboard/core";
import { send } from "../host";
import { boardSignal } from "./root";
import { SEL_REPORT } from "./timing";

export type Sel = { cards: string[]; links: string[]; sections: string[] };
const [sel, setSel] = createStore<Sel>({ cards: [], links: [], sections: [] });
export { sel };
export type LineSel = { card: string; seg: string; start: number; end: number };
export const [lineSel, setLineSel] = boardSignal<LineSel | null>(null);

export function select(o: Partial<Sel>, add = false) {
  batch(() => {
    if (!add) setSel({ cards: [], links: [], sections: [] });
    for (const k of ["cards", "links", "sections"] as const) {
      const v = o[k];
      if (v) setSel(k, (old) => (add ? [...new Set([...old, ...v])] : v));
    }
  });
  reportSelection();
}
export function toggleSel(kind: keyof Sel, id: string) {
  setSel(kind, (old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id]));
  reportSelection();
}
export const clearSel = () => {
  select({});
  setLineSel(null);
};
export const isSel = (id: string) => sel.cards.includes(id);
/** A card went away (a fresh card left empty) */
export const unselectCard = (id: string) => setSel("cards", (c) => c.filter((x) => x !== id));

/** After undo / redo: drop what is no longer on the board. When everything is still there `sel` is left alone (new arrays would
 *  make every card's isSel run again) */
export function keepOn(b: Board) {
  const keep = (xs: string[], ok: (x: string) => boolean) => (xs.every(ok) ? xs : xs.filter(ok));
  const cards = new Set(b.cards.map((c) => c.id));
  setSel("cards", (c) => keep(c, (x) => cards.has(x)));
  setSel("links", (l) => keep(l, (x) => b.links.some((k) => k.id === x)));
  setSel("sections", (l) => keep(l, (x) => b.sections.some((k) => k.id === x)));
}

let selTimer: number | undefined;
export function reportSelection() {
  clearTimeout(selTimer);
  selTimer = window.setTimeout(() => {
    const ls = lineSel();
    send({ type: "selection", cards: [...sel.cards], lines: ls ?? undefined });
  }, SEL_REPORT);
}

// Variants of a code card (another branch, a PR, my own edits): add, show, rename, remove, notes, after a merge upstream.
// What a variant's code looks like comes from the host (views); these change only the board
import { activeOf, findCard, isCode, type Board, type CodeCard, type Segment } from "../model";
import type { NewVariant } from "../protocol";
import { fixHighlights } from "../edit";
import {
  addVariant as addOne,
  dropVariants,
  removeVariant as removeOne,
  setVariantSegs,
  switchVariant,
} from "../variants";
import type { CommandEnv } from "./env";

const code = (b: Board, id: string) => {
  const c = findCard(b, id)?.card;
  return isCode(c) ? c : undefined;
};
const variantOf = (b: Board, id: string, vid: string) => code(b, id)?.variants?.find((v) => v.id === vid);

/** Show a variant: the card's segments become its segments, arrows and sidenotes following their lines */
export function showVariant(env: CommandEnv, id: string, vid: string): boolean {
  const c = code(env.board(), id);
  if (!c?.variants || activeOf(c) === vid) return false;
  env.edit((b) => {
    switchVariant(b, id, vid);
  });
  return true;
}

/** Add the variant the host made (not shown yet); its id */
export function addVariant(env: CommandEnv, id: string, nv: NewVariant): string {
  const vid = `v${Date.now().toString(36)}`;
  env.edit((b) => addOne(b, id, { id: vid, name: nv.name, from: nv.from, segs: nv.segs }));
  return vid;
}

export function renameVariant(env: CommandEnv, id: string, vid: string, name: string) {
  env.edit((b) => {
    const v = variantOf(b, id, vid);
    if (v) v.name = name;
  });
}

/** Remove a variant (not upstream; the shell shows upstream first if it was shown). With only upstream left it is a plain card */
export function removeVariant(env: CommandEnv, id: string, vid: string) {
  env.edit((b) => removeOne(b, id, vid));
}

/** Back to a plain card: on the upstream code, or on `segs` (upstream's latest, which has a merged variant's changes) */
export function dropAllVariants(env: CommandEnv, id: string, segs?: Segment[]) {
  env.edit((b) => dropVariants(b, id, segs));
}

/** The shown variant's note; empty removes it */
export function setVariantNote(env: CommandEnv, id: string, text: string) {
  env.edit((b) => {
    const c = code(b, id);
    const v = c?.variants?.find((k) => k.id === activeOf(c));
    if (!v) return;
    if (text.trim()) v.note = text.trim();
    else delete v.note;
  });
}

/** Keep Variants after one was merged upstream: that merge (its tip) is not asked about again */
export function keepMergedVariant(env: CommandEnv, id: string, vid: string, tip: string) {
  env.edit((b) => {
    const v = variantOf(b, id, vid);
    if (v) v.merged = tip;
  });
}

/** A sidenote on a card with variants: shown only on the variant shown now, or on all of them again */
export function toggleVariantOnly(env: CommandEnv, noteId: string) {
  env.edit((b) => {
    const n = b.sidenotes.find((k) => k.id === noteId);
    const c = n?.at.card !== undefined ? (findCard(b, n.at.card)?.card as CodeCard | undefined) : undefined;
    if (!n || !c?.variants?.length) return;
    if (n.variant) delete n.variant;
    else n.variant = activeOf(c);
    fixHighlights(b, [c.id]);
  });
}

/** The host's newer segments for a card's variants (variant id → segments): a sync, not an edit */
export function syncVariantSegs(b: Board, id: string, segs: Record<string, Segment[]>) {
  for (const [vid, ss] of Object.entries(segs)) setVariantSegs(b, id, vid, ss);
}

// Sections and where cards sit: moving cards into a Section, folding and fitting Sections, unfolding what hides a card, locks,
// moves the shell laid out (Tidy Up, Align), card sizes fitted to their content
import { findCard, type Board, type Section } from "../model";
import { align, type AlignOp, type Rect } from "../layout";
import type { CommandEnv } from "./env";

/** A Section is locked when it or a Section it is in is */
export function sectionLocked(b: Pick<Board, "sections">, s?: Section): boolean {
  for (let q = s, i = 0; q && i < 50; q = b.sections.find((k) => k.id === q!.parent), i++) if (q.locked) return true;
  return false;
}
/** A card is locked when its place is, or a Section it is in (a Compare's column: the Compare's) */
function cardLocked(b: Pick<Board, "cards" | "place" | "sections">, id: string): boolean {
  const p = b.place[findCard(b, id)?.host.id ?? id];
  return (
    !!p?.locked ||
    sectionLocked(
      b,
      b.sections.find((s) => s.id === p?.section),
    )
  );
}

/** Move to Section: these cards go into the Section, moved by (dx, dy) together (the free spot the shell found in its frame) */
export function moveIntoSection(env: CommandEnv, ids: string[], section: string, dx: number, dy: number) {
  env.edit((b) => {
    for (const i of ids) {
      const p = b.place[i];
      if (!p) continue;
      p.x += dx;
      p.y += dy;
      p.section = section;
    }
  });
}

/** Move Out of Parent Section: it goes one level up, into the Section its parent is in (none: on the board) */
export function moveOutOfParent(env: CommandEnv, id: string) {
  env.edit((b) => {
    const s = b.sections.find((q) => q.id === id);
    if (s) s.parent = b.sections.find((q) => q.id === s.parent)?.parent;
  });
}

/**
 * Fold or unfold a Section. Folding keeps its open frame (`open`, as drawn) to unfold to; the folded one sits at its top left.
 * Only while it is still folded as `was` (an undo or a reveal meanwhile changed it: left as it is)
 */
export function setSectionFolded(env: CommandEnv, id: string, shut: boolean, o: { was: boolean; open: Rect }) {
  env.edit((b) => {
    const s = b.sections.find((q) => q.id === id);
    if (!s || !!s.collapsed !== o.was) return;
    if (shut)
      Object.assign(s, {
        x: Math.round(o.open.x),
        y: Math.round(o.open.y),
        w: Math.round(o.open.w),
        h: Math.round(o.open.h),
      });
    s.collapsed = shut || undefined;
  });
}

/**
 * Fit Content of Sections: each frame becomes `fit(s)` (just around its cards and inner Sections, as the shell measures them).
 * Folded, locked and empty ones stay. before(ids) runs just before, with the ones that change. Whether any did
 */
export function fitSections(
  env: CommandEnv,
  ids: string[],
  fit: (s: Section) => Rect | null,
  before?: (ids: string[]) => void,
): boolean {
  const b0 = env.board();
  const fits = new Map<string, Rect>();
  for (const id of ids) {
    const s = b0.sections.find((q) => q.id === id);
    if (!s || s.collapsed || sectionLocked(b0, s)) continue;
    const r = fit(s);
    if (r) fits.set(id, r);
  }
  if (!fits.size) return false;
  before?.([...fits.keys()]);
  env.edit((b) => {
    for (const [id, r] of fits) {
      const s = b.sections.find((q) => q.id === id);
      if (s) Object.assign(s, { x: r.x, y: r.y, w: r.w, h: r.h });
    }
  });
  return true;
}

/**
 * Bring a card into view: the cards above it in a folded call tree (`callers`, found by the shell from its call graphs) and the
 * folded Sections it is in unfold, in one step
 */
export function unfoldTo(env: CommandEnv, host: string, callers: Iterable<string>): boolean {
  return env.edit((b) => {
    for (const k of callers) if (b.place[k]?.collapsed) b.place[k].collapsed = undefined;
    const seen = new Set<string>();
    for (
      let s = b.sections.find((q) => q.id === b.place[host]?.section);
      s && !seen.has(s.id);
      s = b.sections.find((q) => q.id === s!.parent)
    ) {
      seen.add(s.id);
      if (s.collapsed) s.collapsed = undefined;
    }
  });
}

/** Cards moved to where the shell laid them out (Tidy Up), in one step */
export function moveCards(env: CommandEnv, to: Record<string, { x: number; y: number }>): boolean {
  return env.edit((b) => {
    for (const [id, p] of Object.entries(to)) {
      const c = b.place[id];
      if (c) {
        c.x = p.x;
        c.y = p.y;
      }
    }
  });
}

/** Align or distribute cards (their frames as drawn); the locked ones count but stay */
export function alignCards(env: CommandEnv, rs: (Rect & { id: string })[], op: AlignOp) {
  const m = align(rs, op);
  env.edit((b) => {
    for (const [id, p] of m) {
      const c = b.place[id];
      if (c && !cardLocked(b, id)) Object.assign(c, p);
    }
  });
}

/** The widths Fit Content keeps a card between (the board lays a code card out at the clamped width to measure its height) */
export const FIT_WIDTH = { min: 240, max: 1600 };
/**
 * Fit Content of cards to their natural size as measured (w = the longest line, h = all lines shown; body = a code card's content
 * height, chrome = its title and margins). The width is kept within 240–1600. The height is stored only for a code card taller
 * than `codeMax` (its content area); Notes, Web, Image cards and shorter code follow their content
 */
export function fitCardSizes(
  env: CommandEnv,
  sizes: Map<string, { w?: number; h: number; body?: number; chrome: number }>,
  codeMax: number,
) {
  env.edit((b) => {
    for (const [id, n] of sizes) {
      const p = b.place[id];
      if (!p) continue;
      if (n.w) p.w = Math.max(FIT_WIDTH.min, Math.min(FIT_WIDTH.max, n.w));
      const c = b.cards.find((k) => k.id === id);
      const code = c?.kind === "code";
      p.h =
        c?.kind === "note" ||
        c?.kind === "web" ||
        c?.kind === "image" ||
        (code && n.body !== undefined && n.body <= codeMax)
          ? undefined
          : Math.round(n.h - (code ? n.chrome : 0));
    }
  });
}

/** A Section's title; blank is "Untitled Section" */
export function renameSection(env: CommandEnv, id: string, v: string) {
  env.edit((b) => {
    const s = b.sections.find((q) => q.id === id);
    if (s) s.title = v.trim() || "Untitled Section";
  });
}

/** The colour of these Sections (one, or all those selected), in one step; none = uncoloured. No step when none changes */
export function setSectionColor(env: CommandEnv, ids: string[], color: string | undefined) {
  const want = new Set(ids);
  const change = env.board().sections.filter((s) => want.has(s.id) && s.color !== color);
  if (!change.length) return;
  const these = new Set(change.map((s) => s.id));
  env.edit((b) => {
    for (const s of b.sections) if (these.has(s.id)) s.color = color;
  });
}

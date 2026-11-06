// Code cards: hidden and highlighted lines, Free code's text and language, the card frame, segments added by the editor, and
// the handwritten annotations on a segment's text
import { findCard, isCode, type Board, type CodeAnnot, type HandColor, type HlRange, type Segment } from "../model";
import { addHighlight, removeHighlights } from "../edit";
import { guessLang, pythonDialect } from "../paste";
import type { CommandEnv } from "./env";

/** Lines start..end of one segment of a card */
export type LineRange = { card: string; seg: string; start: number; end: number };

const segIn = (b: Board, card: string, seg: string) => {
  const c = findCard(b, card)?.card;
  return isCode(c) ? c.segments.find((s) => s.id === seg) : undefined;
};

/** Hide these lines: hidden ranges that overlap or touch them merge into one, the ranges stay in line order */
export function hideLines(env: CommandEnv, ls: LineRange) {
  env.edit((b) => {
    const s = segIn(b, ls.card, ls.seg);
    if (!s) return;
    let r: [number, number] = [ls.start, ls.end];
    const keep = (s.hidden ?? []).filter((h) => {
      if (h[1] < r[0] - 1 || h[0] > r[1] + 1) return true;
      r = [Math.min(h[0], r[0]), Math.max(h[1], r[1])];
      return false;
    });
    s.hidden = [...keep, r].sort((a, c) => a[0] - c[0]);
  });
}

/**
 * Highlight: lines that are all highlighted already lose their Highlights, whole (a Highlight is one range: the lines around the
 * selected ones go too) and with the sidenotes on them; otherwise the lines become one Highlight, taking in the ones they overlap
 * (addHighlight). How many sidenotes went with removed Highlights (the shell says so: undo brings them back)
 */
export function toggleHighlight(env: CommandEnv, ls: LineRange): number {
  let gone = 0;
  env.edit((b) => {
    const s = segIn(b, ls.card, ls.seg);
    if (!s) return;
    const hit = (s.hl ?? []).filter(([a, z]) => a <= ls.end && z >= ls.start);
    const all = (l: number) => hit.some(([a, z]) => l >= a && l <= z);
    const covered = Array.from({ length: ls.end - ls.start + 1 }, (_, i) => ls.start + i).every(all);
    if (covered) gone = removeHighlights(b, s, hit);
    else addHighlight(b, s, [ls.start, ls.end]);
  });
  return gone;
}

/** Remove Highlight: the range and the sidenotes on it, in one undo step. How many sidenotes went */
export function removeHighlight(env: CommandEnv, card: string, seg: string, range: HlRange): number {
  let gone = 0;
  env.edit((b) => {
    const s = segIn(b, card, seg);
    if (s) gone = removeHighlights(b, s, [range]);
  });
  return gone;
}

/** Show All Hidden Lines of a card */
export function showAllLines(env: CommandEnv, id: string) {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (isCode(c)) for (const s of c.segments) s.hidden = undefined;
  });
}

/** The language Free code's text looks like: Python told apart further into Triton / TileLang; null when it can't tell */
export const freeLang = (text: string) => {
  const g = guessLang(text);
  return g === "python" ? pythonDialect(text) : g;
};

/** The card's first segment as it is now, a copy (for the shell to ask the host for its view) */
const firstSeg = (env: CommandEnv, id: string): Segment | undefined => {
  const c = findCard(env.board(), id)?.card;
  return isCode(c) && c.segments[0] ? structuredClone(c.segments[0]) : undefined;
};

/**
 * Write a Free code card's text. Its language follows the text unless it was picked by hand (unchanged when the text looks like
 * no language). A new card written empty goes as if it never was (env.fresh). The segment as written, or none when it went
 */
export function writeFreeCode(env: CommandEnv, id: string, text: string): Segment | undefined {
  const set = (b: Board) => {
    const c = findCard(b, id)?.card;
    if (!isCode(c)) return;
    const s = c.segments[0];
    s.text = text.split("\n");
    s.end = s.start + s.text.length - 1;
    if (s.src.kind === "free" && !s.src.langPicked) s.lang = freeLang(text) ?? s.lang;
  };
  if (env.fresh.is(id)) env.fresh.settle(id, !!text.trim(), set);
  else env.edit(set);
  return firstSeg(env, id);
}

/** A code card's language picked by hand; null = Free code follows its text again. The segment as it is then */
export function setCodeLang(env: CommandEnv, id: string, lang: string | null): Segment | undefined {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (!isCode(c)) return;
    const s = c.segments[0];
    if (s.src.kind === "free") s.src.langPicked = lang ? true : undefined;
    s.lang = lang ?? freeLang(s.text.join("\n")) ?? s.lang;
  });
  return firstSeg(env, id);
}

/** The card frame on or off: an image has none by default, a code card has one */
export function toggleBackground(env: CommandEnv, id: string) {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind === "image") c.bg = !c.bg || undefined;
    else if (c?.kind === "code") c.bg = c.bg === false ? undefined : false;
  });
}

/** A segment the editor sent added at the end of a code card */
export function appendSegment(env: CommandEnv, id: string, seg: Segment) {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (isCode(c)) c.segments.push(seg);
  });
}

/**
 * An annotation written on characters from..to of a line: it replaces the ones it overlaps there and takes the colour of the
 * segment's last one. Nothing written: no annotation
 */
export function addAnnot(
  env: CommandEnv,
  at: { card: string; seg: string; line: number; from: number; to: number },
  text: string,
) {
  const t = text.trim();
  if (!t) return;
  env.edit((b) => {
    const s = segIn(b, at.card, at.seg);
    if (!s) return;
    const color = s.annots?.[s.annots.length - 1]?.color;
    const a: CodeAnnot = { line: at.line, from: at.from, to: at.to, text: t, ...(color ? { color } : {}) };
    s.annots = [...(s.annots ?? []).filter((x) => x.line !== at.line || x.to <= at.from || x.from >= at.to), a];
  });
}

/** Remove a segment's i-th annotation */
export function removeAnnot(env: CommandEnv, card: string, seg: string, i: number) {
  env.edit((b) => {
    const s = segIn(b, card, seg);
    if (!s?.annots?.[i]) return;
    const rest = s.annots.filter((_, k) => k !== i);
    if (rest.length) s.annots = rest;
    else delete s.annots;
  });
}

/**
 * Change a segment's i-th annotation: its text (written empty, it goes), its colour (blue, the default, is not stored), above or
 * below the line (above, the default, is not stored)
 */
export function editAnnot(
  env: CommandEnv,
  card: string,
  seg: string,
  i: number,
  o: { text: string } | { color: HandColor } | { below: boolean },
) {
  if ("text" in o && !o.text.trim()) return removeAnnot(env, card, seg, i);
  env.edit((b) => {
    const a = segIn(b, card, seg)?.annots?.[i];
    if (!a) return;
    if ("text" in o) a.text = o.text.trim();
    else if ("color" in o) {
      if (o.color === "blue") delete a.color;
      else a.color = o.color;
    } else if (o.below) a.below = true;
    else delete a.below;
  });
}

/** A new Free code card with nothing written yet: fresh (env.fresh) at `place`, filed by settle(b, id) where it landed */
export function newBlankCode(
  env: CommandEnv,
  id: string,
  seg: Segment,
  place: { x: number; y: number; w: number },
  settle: (b: Board, id: string) => void,
) {
  env.fresh.add(id, (b) => {
    b.cards.push({ id, kind: "code", segments: [seg] });
    b.place[id] = { x: Math.round(place.x), y: Math.round(place.y), w: place.w };
    settle(b, id);
  });
}

/** What a code card hides (comments, docstrings, blank lines) switched */
export function toggleCodeHide(env: CommandEnv, id: string, k: "comments" | "docstrings" | "blank") {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (isCode(c)) c.hide = { ...c.hide, [k]: !c.hide?.[k] };
  });
}

/** Line wrap of code cards: all wrapped already unwraps them, else all wrap */
export function toggleWrap(env: CommandEnv, ids: string[]) {
  const b0 = env.board();
  const cs = ids.filter((i) => isCode(findCard(b0, i)?.card));
  if (!cs.length) return;
  const on = !cs.every((i) => {
    const c = findCard(b0, i)?.card;
    return isCode(c) && c.wrap;
  });
  env.edit((b) => {
    for (const i of cs) {
      const k = findCard(b, i)?.card;
      if (isCode(k)) k.wrap = on || undefined;
    }
  });
}

/** Keep Old Version on a card whose symbol is gone: it stays as saved and is not flagged again */
export function keepOldVersion(env: CommandEnv, id: string) {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (isCode(c)) c.keepOld = true;
  });
}

/** A class card's member list shown in full */
export function showAllMembers(env: CommandEnv, id: string) {
  env.edit((b) => {
    const c = findCard(b, id)?.card;
    if (isCode(c) && c.members) c.members.shown = [];
  });
}

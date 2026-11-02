// Code versions: which cards have a newer version, updating to it, keeping the pinned one
import {
  allCodeCards,
  cardTitle,
  findCard,
  isCode,
  versionLabel,
  viewKeyOf,
  UPSTREAM,
  type Board,
  type Card,
  type CodeCard,
  type Segment,
} from "../model";
import type { DiffData, Stale } from "../protocol";
import type { SegView } from "../lines";
import { notesOnChangedLines, rebaseSegment, shiftBy, unlinkCard } from "../edit";
import { rebaseUpstream, upstreamSegs } from "../variants";
import { sharedOn, type CommandEnv } from "./env";

export interface VersionEnv extends CommandEnv {
  /** The version state the host found for a segment (none = not checked yet) */
  stale(segId: string): Stale | undefined;
  /** The segments are up to date */
  staleOk(segIds: string[]): void;
  /** Segment views by view key */
  putViews(views: Record<string, SegView>): void;
  /** Forget the version states of these segments (checked again by the host) */
  dropStale(segIds: string[]): void;
}

export type CardStale = "changed" | "hidden" | "lost" | "missing" | null;

/** The version dot on a card's title: changed = a yellow dot; hidden = only hidden lines changed (a hollow dot) */
export function cardStale(c: CodeCard, stale: (segId: string) => Stale | undefined): CardStale {
  let hidden = false;
  for (const s of upstreamSegs(c)) {
    const st = stale(s.id);
    if (!st) continue;
    if (st.state === "changed" && s.keep && st.head.startsWith(s.keep)) continue;
    if (st.state === "changed") {
      if (!st.hiddenOnly) return "changed";
      hidden = true;
    }
    if ((st.state === "lost" || st.state === "many") && !c.keepOld) return "lost";
    if (st.state === "missing") return "missing";
  }
  return hidden ? "hidden" : null;
}

export const uncommitted = (c: Card | undefined) =>
  isCode(c) && c.segments.some((s) => s.version.kind === "git" && s.version.uncommitted);

/** How many cards on the board have a newer version */
export const staleCount = (b: Board, stale: (segId: string) => Stale | undefined) =>
  allCodeCards(b).filter((c) => cardStale(c, stale) === "changed").length;

/** The next card to review in the new-version banner (changed, or only hidden lines changed), or null when all are up to date */
export function nextToReview(b: Board, stale: (segId: string) => Stale | undefined): string | null {
  for (const c of allCodeCards(b)) {
    const st = cardStale(c, stale);
    if (st === "changed" || st === "hidden") return c.id;
  }
  return null;
}

/**
 * The card's upstream segment becomes `seg` (same id): Update to a new version, or Relocate. Sidenotes, arrows and stickers follow
 * their lines by content, one on a deleted line moves to the whole card; review = mark sidenotes on changed lines for review with
 * this label. When the upstream segment is not the one shown (a Variant is), its view goes under its view key
 */
export function putUpstream(env: VersionEnv, cardId: string, seg: Segment, view?: SegView, review?: string) {
  const c = findCard(env.board(), cardId)?.card;
  env.edit((b) => rebaseUpstream(b, cardId, seg, undefined, review ? { review } : {}));
  if (view && isCode(c)) env.putViews({ [viewKeyOf(c, seg.id, UPSTREAM)]: view });
  env.staleOk([seg.id]);
}

/** Update: switch a segment to the new version (putUpstream), its sidenotes on changed lines marked for review */
export function applyVersion(env: VersionEnv, cardId: string, segId: string, data: DiffData) {
  if (!data.newSeg) return;
  const ns = structuredClone(data.newSeg);
  ns.id = segId;
  putUpstream(env, cardId, ns, data.newView, versionLabel(ns.version));
}

/**
 * Update on a card that is also on other boards: the sharedUpdate setting decides, or the user when it says ask. This Board Only
 * first unlinks the card here (the other boards keep the old version). The card to update (a new id when unlinked), or null for
 * Keep and a dismissed question (keep runs for Keep)
 */
export async function updateScope(
  env: CommandEnv,
  cardId: string,
  segId: string,
  data: DiffData,
  keep: () => void,
): Promise<string | null> {
  if (sharedOn(env, cardId) < 2 || !data.newSeg) return cardId;
  let scope = env.settings().sharedUpdate;
  if (scope === "ask") {
    const b = env.board();
    const c = findCard(b, cardId)?.card;
    const ns = { ...data.newSeg, id: segId };
    const hit = notesOnChangedLines(b, cardId, ns).length;
    const i = await env.choose({
      title: `Update ${c ? cardTitle(c, b) : "this card"} to ${versionLabel(ns.version)}?`,
      options: ["Update on All Boards", "This Board Only", "Keep"],
      text: boardsText(env, cardId),
      warn: hit ? `${hit} sidenote${hit > 1 ? "s are" : " is"} on a changed line` : undefined,
      note: "This Board Only makes a copy here, so the other boards keep the old version.",
    });
    if (i === null) return null;
    if (i === 2) {
      keep();
      return null;
    }
    scope = i === 0 ? "all" : "this";
  }
  if (scope !== "this") return cardId;
  let to = cardId;
  env.edit((b) => {
    to = unlinkCard(b, cardId);
  });
  return to;
}

/** 「This card is on 3 boards: A, B, C.」 */
export function boardsText(env: Pick<CommandEnv, "boardsOf">, cardId: string) {
  const bs = env.boardsOf(cardId);
  return `This card is on ${bs.length} boards: ${bs.join(", ")}.`;
}

/**
 * Show the card's code at another commit: each repo segment as the host read it there. Arrows, sidenotes, stickers and the
 * segments' hidden / highlighted lines follow by content to that commit's lines; the version states are checked again
 */
export function switchCommit(env: VersionEnv, cardId: string, segs: { seg: Segment; view: SegView }[]) {
  env.edit((b) => {
    for (const r of segs) rebaseSegment(b, cardId, r.seg);
  });
  env.putViews(Object.fromEntries(segs.map((r) => [r.seg.id, r.view])));
  env.dropStale(segs.map((r) => r.seg.id));
}

/**
 * The host found code that only moved (same content, other lines): the segments follow it, with their lines, arrows and sidenotes
 * shifted along, and pinned to the version it was found in. A sync, not an edit: run again after undo, so it aims at the found
 * lines, not at a shift from where the segment is
 */
export function followMoved(b: Board, moved: [string, Extract<Stale, { state: "moved" }>][]) {
  for (const [sid, s] of moved) {
    for (const k of allCodeCards(b)) {
      // a card with Variants: the version state is the upstream segment's (the one shown may be a variant)
      const seg = upstreamSegs(k).find((q) => q.id === sid);
      if (seg)
        rebaseUpstream(
          b,
          k.id,
          { ...seg, start: s.start, end: s.end, version: s.version },
          shiftBy(s.start - seg.start),
        );
    }
    for (const n of b.sidenotes)
      if (n.kind === "code" && n.code.id === sid)
        n.code = { ...n.code, start: s.start, end: s.end, version: s.version };
  }
}

/** Keep: stay on the pinned version and remember this HEAD, so the same new version does not ask again */
export function keepVersion(env: VersionEnv, cardId: string, segId: string) {
  const st = env.stale(segId);
  const head = st?.state === "changed" ? st.head : undefined;
  if (head)
    env.edit((b) => {
      const c = findCard(b, cardId)?.card;
      if (isCode(c)) {
        const s = upstreamSegs(c).find((q) => q.id === segId);
        if (s) s.keep = head;
      }
    });
  else env.staleOk([segId]);
}

/**
 * Update All in the banner: get each changed segment's diff and update it, as Update on each card would. Cards also on other
 * boards follow the sharedUpdate setting, asked once for the whole batch
 */
export async function updateAll(env: VersionEnv) {
  const todo: [string, Segment][] = [];
  for (const c of allCodeCards(env.board()))
    if (cardStale(c, env.stale) === "changed")
      for (const s of upstreamSegs(c)) if (env.stale(s.id)?.state === "changed") todo.push([c.id, s]);
  const linked = [...new Set(todo.map(([c]) => c))].filter((c) => sharedOn(env, c) > 1);
  let scope: "all" | "this" | "skip" | "ask" = env.settings().sharedUpdate;
  if (linked.length && scope === "ask") {
    const i = await env.choose({
      title: `${linked.length} of these cards ${linked.length > 1 ? "are" : "is"} also on other boards`,
      options: ["Update on All Boards", "This Board Only", "Skip Linked Cards"],
      note: "This Board Only makes a copy here, so the other boards keep the old version.",
    });
    if (i === null) return;
    scope = i === 0 ? "all" : i === 1 ? "this" : "skip";
  }
  const ren = new Map<string, string>();
  if (scope === "this")
    env.edit((b) => {
      for (const c of linked) ren.set(c, unlinkCard(b, c));
    });
  let n = 0;
  for (const [cid0, s] of todo) {
    if (scope === "skip" && linked.includes(cid0)) continue;
    const cid = ren.get(cid0) ?? cid0;
    try {
      const k = findCard(env.board(), cid)?.card;
      const data = await env.ask("diff", { seg: s, against: isCode(k) && k.variants?.length ? "upstream" : undefined });
      if (data.canUpdate) {
        applyVersion(env, cid, s.id, data);
        n++;
      }
    } catch {
      /* skip this one */
    }
  }
  env.toast(
    n === todo.length
      ? `Updated ${n} card${n === 1 ? "" : "s"}`
      : `Updated ${n} of ${todo.length}; open the others to review`,
  );
}

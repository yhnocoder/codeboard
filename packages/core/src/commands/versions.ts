// Code versions: which cards have a newer version, updating to it, keeping the pinned one
import {
  allCodeCards,
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
import { unlinkCard } from "../edit";
import { rebaseUpstream, upstreamSegs } from "../variants";
import type { CommandEnv } from "./env";

export interface VersionEnv extends CommandEnv {
  /** The version state the host found for a segment (none = not checked yet) */
  stale(segId: string): Stale | undefined;
  /** The segments are up to date */
  staleOk(segIds: string[]): void;
  /** Segment views by view key */
  putViews(views: Record<string, SegView>): void;
  /** How many boards the card is on (1 = only this one) */
  sharedOn(cardId: string): number;
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
 * Switch a segment to the new version: sidenotes follow their lines, one on a deleted line moves to the whole card, and one on a
 * changed line is marked for review. When the upstream segment is not the one shown, its view goes under its view key
 */
export function applyVersion(env: VersionEnv, cardId: string, segId: string, data: DiffData) {
  if (!data.newSeg) return;
  const ns = structuredClone(data.newSeg);
  ns.id = segId;
  const c = findCard(env.board(), cardId)?.card;
  env.edit((b) => rebaseUpstream(b, cardId, ns, undefined, { review: versionLabel(ns.version) }));
  if (data.newView && isCode(c)) env.putViews({ [viewKeyOf(c, segId, UPSTREAM)]: data.newView });
  env.staleOk([segId]);
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
  const linked = [...new Set(todo.map(([c]) => c))].filter((c) => env.sharedOn(c) > 1);
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

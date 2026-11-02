// Calls on the board: a call expanded into a new card, a call linked to a card already there (or drawn by hand), another
// implementation or argument value swapped in, RPC marks and the message card between an RPC arrow's ends, process tags, start
// cards, the legend, the call graphs' marks, a captured run, Generated cards
import type { BoundVal, CallAlt, Var } from "@codeboard/analysis/basics";
import {
  LEGEND,
  canMark,
  findCard,
  isCode,
  uid,
  type Card,
  type CodeCard,
  type GraphMark,
  type LegendKey,
  type Link,
  type NoteCard,
  type Place,
  type RpcMark,
} from "../model";
import type { CallSpan } from "../lines";
import type { CrossMark, ImplPick } from "../protocol";
import { instName } from "../chip";
import { applyRun, matchRun, type RunApply, type RunMatch } from "../run";
import { joinLinks, placeCards, removeLostCalls, splitLink, swapCallTarget } from "../edit";
import type { CommandEnv } from "./env";

/** The Call mark on the arrow of a call: its name and column, a loop, the argument candidates */
export function callMark(call: CallSpan, cands?: Var[]): NonNullable<Link["call"]> {
  const m: NonNullable<Link["call"]> = { name: call.name, col: call.col };
  if (call.loop) m.loop = true;
  if (cands?.length) m.cands = cands;
  return m;
}

/**
 * A call expanded: the new card at `place`, in its caller's Section (a folded caller unfolds), and a Call arrow from the call's
 * line to it in place of one whose card is gone. push = cards moved down to make room. ex = more of the Call mark, the arrow's
 * label, the card's title
 */
export function addCallCard(
  env: CommandEnv,
  from: { card: string; seg: string; call: CallSpan },
  card: CodeCard,
  place: Place,
  o: { vars?: Var[]; push?: { id: string; dy: number }[]; mark?: CrossMark; label?: string; title?: string },
): boolean {
  const host = findCard(env.board(), from.card)?.host.id ?? from.card;
  const { call } = from;
  return env.edit((b) => {
    for (const q of o.push ?? []) b.place[q.id].y += q.dy;
    const nc = structuredClone(card);
    const np = { ...place };
    const hp = b.place[host];
    if (hp?.section) np.section = hp.section;
    if (hp?.collapsed) hp.collapsed = undefined;
    if (o.title) nc.title = o.title;
    b.cards.push(nc);
    b.place[nc.id] = np;
    const mk = { ...callMark(call, o.vars), ...o.mark };
    for (const k of Object.keys(mk) as (keyof typeof mk)[]) if (mk[k] === undefined) delete mk[k];
    removeLostCalls(b, { card: from.card, seg: from.seg, line: call.line }, call.name);
    b.links.push({
      id: uid("l"),
      from: { card: from.card, seg: from.seg, line: call.line },
      to: { card: nc.id },
      call: mk,
      ...(o.label ? { label: o.label } : {}),
    });
  });
}

/**
 * Link a call to a card already on the board: a Call arrow to it. Only a code card can be called, and not by itself. The new
 * arrow's id, or why not
 */
export function linkCall(
  env: CommandEnv,
  from: { card: string; seg: string; call: CallSpan },
  target: string,
  sides?: Link["sides"],
): { id: string } | { why: string } {
  const b = env.board();
  const t = findCard(b, target);
  if (!t || !isCode(t.card)) return { why: "Only code cards can be the target of a call." };
  if (t.host.id === (findCard(b, from.card)?.host.id ?? from.card)) return { why: "A card cannot call itself." };
  const id = uid("l");
  env.edit((d) => {
    d.links.push({
      id,
      from: { card: from.card, seg: from.seg, line: from.call.line },
      to: { card: target },
      call: callMark(from.call),
      ...(sides ? { sides } : {}),
    });
  });
  return { id };
}

/**
 * Another implementation picked for a call: the arrow goes to `card` (swapCallTarget). The old card is swapped out when the arrow
 * was all it had, else it stays (kept = true) and the new card is a second branch below it
 */
export function swapCall(
  env: CommandEnv,
  linkId: string,
  card: CodeCard,
  o: { title?: string; alt: number; oldAlt?: CallAlt; w: number; label?: string; vals?: BoundVal[] },
): boolean {
  let kept = false;
  env.edit((b) => {
    const nc = structuredClone(card);
    if (o.title) nc.title = o.title;
    kept = swapCallTarget(b, linkId, nc, o)?.kept ?? false;
  });
  return kept;
}

/** A message card between the two ends of an RPC arrow (A → [message] → B, both RPC) at `place`, in `section` */
export function insertMessage(env: CommandEnv, linkId: string, name: string, place: Place, section?: string): string {
  const mid = uid("n"),
    l2 = uid("l");
  const card: NoteCard = { id: mid, kind: "note", md: name, look: "note", msg: {} };
  env.edit((b) => {
    if (!b.links.some((k) => k.id === linkId && k.rpc)) return;
    placeCards(b, [{ card: card as Card, place }], { copy: false, at: (q) => (section ? { ...q, section } : q) });
    // the first part (sender → message) has no arrowhead, the second (message → receiver) goes on to the old end
    splitLink(b, linkId, mid, l2);
  });
  return mid;
}
/** The message card taken out again: the two arrows join back into one */
export function removeMessage(env: CommandEnv, first: string, second: string, mid: string) {
  env.edit((b) => joinLinks(b, first, second, mid));
}

/** A manual Call arrow (dashed, evidence "manual") from a call to a card, drawn by hand; not to the calling card itself */
export function manualCall(
  env: CommandEnv,
  from: { card: string; seg?: string; line?: number; call: CallSpan },
  to: string,
): { id: string } | { why: string } | null {
  const b0 = env.board();
  const t = findCard(b0, to);
  if (!t) return null;
  if (t.host.id === (findCard(b0, from.card)?.host.id ?? from.card)) return { why: "A card cannot call itself." };
  const id = uid("l");
  env.edit((b) => {
    b.links.push({
      id,
      from: { card: from.card, seg: from.seg, line: from.line },
      to: { card: to },
      call: { ...callMark(from.call), ev: { kind: "manual" } },
    });
  });
  return { id };
}

/** The other implementations of a dynamic dispatch, as alternatives of its arrow (the base class's own one is the arrow's) */
export const implAlts = (impls: ImplPick[]): CallAlt[] =>
  impls.map((x) => ({
    label: x.label,
    detail: x.detail,
    path: x.path,
    line: x.line,
    qual: x.qual,
    ...(x.lib ? { lib: x.lib } : {}),
  }));

/** A dispatch found after the call was expanded: the arrow learns how many implementations there are, and the new alternatives */
export function addCallAlts(env: CommandEnv, linkId: string, impls: ImplPick[]) {
  const alts = implAlts(impls.filter((x) => !x.base));
  env.edit((b) => {
    const l = b.links.find((x) => x.id === linkId);
    if (!l?.call) return;
    const have = new Set((l.call.alts ?? []).map((a) => a.qual));
    l.call.impls = impls.length;
    const add = alts.filter((a) => !have.has(a.qual));
    if (add.length) l.call.alts = [...(l.call.alts ?? []), ...add];
  });
}

/** A template instance's card title follows its argument values, only while it is still the title made for them */
function retitle(c: CodeCard, before: BoundVal[] | undefined, after: BoundVal[]) {
  const name = c.segments[0]?.symbol?.qual.split(/::|\./).pop();
  if (!name || !before?.length || c.title !== instName(name, before)) return;
  c.title = instName(name, after);
}

/**
 * Other argument values swapped in on a Call arrow (no new card). alt = the alternative they came from, which the values swapped
 * out take the place of (a config alternative); left out for another value of one argument (its other options are the
 * alternatives already)
 */
export function swapValues(env: CommandEnv, linkId: string, vals: BoundVal[], alt?: number) {
  env.edit((b) => {
    const l = b.links.find((x) => x.id === linkId);
    if (!l?.call) return;
    const before = l.call.vals;
    if (alt !== undefined) {
      const alts = [...(l.call.alts ?? [])];
      alts.splice(alt, 1, {
        label: `config · ${(before ?? []).map((v) => `${v.name}=${v.value}`).join(" ")}`,
        vals: before ?? [],
      });
      l.call.alts = alts;
    }
    l.call.vals = vals.map((v) => ({ ...v }));
    const tc = findCard(b, l.to.card)?.card;
    if (isCode(tc)) retitle(tc, before, l.call.vals);
  });
}

/** One argument value of a Call arrow picked from its options */
export function setCallValue(env: CommandEnv, linkId: string, vi: number, value: string) {
  env.edit((b) => {
    const l = b.links.find((x) => x.id === linkId);
    const v = l?.call?.vals?.[vi];
    if (!l?.call || !v) return;
    const before = l.call.vals!.map((x) => ({ ...x }));
    v.value = value;
    const tc = b.cards.find((c) => c.id === l.to.card);
    if (isCode(tc)) retitle(tc, before, l.call.vals!);
  });
}

/** Mark as RPC: an arrow that can carry a mark becomes an RPC arrow (shared memory until changed) */
export function markRpc(env: CommandEnv, id: string) {
  const L = env.board().links.find((k) => k.id === id);
  if (!L || L.rpc || !canMark(L)) return;
  env.edit((b) => {
    const l = b.links.find((k) => k.id === id);
    if (l && canMark(l)) l.rpc = { mech: "shm" };
  });
}
/** Change an RPC mark; fields left empty are not stored */
export function editRpc(env: CommandEnv, id: string, f: (r: RpcMark) => void) {
  env.edit((b) => {
    const l = b.links.find((k) => k.id === id);
    if (!l?.rpc) return;
    f(l.rpc);
    for (const k of Object.keys(l.rpc) as (keyof RpcMark)[])
      if (l.rpc[k] === undefined || l.rpc[k] === "") delete l.rpc[k];
  });
}
/** ↩ back to: an arrow back to where the walk started (Walkthrough stops there), on or off */
export function toggleBack(env: CommandEnv, id: string) {
  env.edit((b) => {
    const l = b.links.find((k) => k.id === id);
    if (!l || !canMark(l)) return;
    if (l.back) delete l.back;
    else l.back = true;
  });
}

/** A process tag (light = a thread or CUDA stream) added to a card */
export function addProcTag(env: CommandEnv, cardId: string, text: string, light = false) {
  env.edit((b) => {
    const c = b.cards.find((k) => k.id === cardId);
    if (c) c.procs = [...(c.procs ?? []), light ? { text, light: true } : { text }];
  });
}
export function editProcTag(env: CommandEnv, cardId: string, i: number, text: string) {
  env.edit((b) => {
    const q = b.cards.find((k) => k.id === cardId)?.procs?.[i];
    if (q) q.text = text;
  });
}
/** The last tag removed leaves no list */
export function removeProcTag(env: CommandEnv, cardId: string, i: number) {
  env.edit((b) => {
    const c = b.cards.find((k) => k.id === cardId);
    if (!c?.procs) return;
    c.procs = c.procs.filter((_, k) => k !== i);
    if (!c.procs.length) delete c.procs;
  });
}

/** A start card (where call trees and walks begin) on or off; a Compare's column marks the Compare */
export function toggleStart(env: CommandEnv, cardId: string) {
  const host = findCard(env.board(), cardId)?.host.id ?? cardId;
  env.edit((b) => {
    const p = b.place[host];
    if (!p) return;
    if (p.start) delete p.start;
    else p.start = true;
  });
}

/** Rename a kind of arrow in the legend; empty or its default name drops the rename */
export function renameLegend(env: CommandEnv, k: LegendKey, v: string) {
  env.edit((b) => {
    const def = LEGEND.find((x) => x[0] === k)![1];
    if (!v || v === def) {
      if (b.legend) {
        delete b.legend[k];
        if (!Object.keys(b.legend).length) delete b.legend;
      }
    } else b.legend = { ...b.legend, [k]: v };
  });
}

/** A call graph's mark (null = back to the letter given automatically), kept under the graph's id */
export function setGraphMark(env: CommandEnv, graphId: string, mark: GraphMark | null) {
  env.edit((b) => {
    if (!mark) {
      if (b.marks) {
        delete b.marks[graphId];
        if (!Object.keys(b.marks).length) delete b.marks;
      }
      return;
    }
    (b.marks ??= {})[graphId] = mark;
  });
}

/** A run the host captured: the Call arrows it matches get its observed evidence and arguments (one step). The match */
export function observeRun(env: CommandEnv, a: RunApply): RunMatch {
  const m = matchRun(env.board(), a);
  if (m.hits.length)
    env.edit((b) => {
      applyRun(b, a, m);
    });
  return m;
}

/**
 * A Generated card (made from the clipboard or a file) at `place`, in the Section of the card it came from, with a dotted
 * "Generated from" arrow back to that card or line
 */
export function addGenerated(
  env: CommandEnv,
  card: CodeCard,
  at: { card: string; seg?: string; line?: number },
  place: Place,
) {
  const host = findCard(env.board(), at.card)?.host.id ?? at.card;
  env.edit((b) => {
    const section = b.place[host]?.section;
    b.cards.push(card);
    b.place[card.id] = { ...place, ...(section ? { section } : {}) };
    b.links.push({
      id: uid("l"),
      from: { card: card.id },
      to: at.line !== undefined ? { card: at.card, seg: at.seg, line: at.line } : { card: at.card },
      gen: true,
    });
  });
}
/** What run made a Generated card; empty = none said */
export function setGenRun(env: CommandEnv, id: string, v: string) {
  env.edit((b) => {
    const c = b.cards.find((k) => k.id === id);
    if (isCode(c) && c.gen) {
      if (v.trim()) c.gen.run = v.trim();
      else delete c.gen.run;
    }
  });
}

// Calls on the board: a call expanded into a new card, a call linked to a card already there, another implementation swapped in,
// a message card between the two ends of an RPC arrow
import type { BoundVal, CallAlt, Var } from "@codeboard/analysis/basics";
import { findCard, isCode, uid, type Card, type CodeCard, type Link, type NoteCard, type Place } from "../model";
import type { CallSpan } from "../lines";
import type { CrossMark } from "../protocol";
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

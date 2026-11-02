// Arrows: drawing one, its Call mark and argument chips, which side its ends take, its look
import { varKey, type Var } from "@codeboard/analysis/basics";
import { canMark, findCard, uid, type End, type LinkSide, type LinkStyle } from "../model";
import type { CallSpan } from "../lines";
import { callMark } from "./calls";
import type { CommandEnv } from "./env";

/**
 * A new plain arrow between two ends (a card, a line, a Note's block), in any number; only the same place of one card to itself
 * is no arrow (a Compare's column counts as the Compare). side = the side the arrow leaves from. Its id, or null
 */
export function addLink(env: CommandEnv, from: End, to: End, side?: LinkSide): string | null {
  const b0 = env.board();
  const host = (id: string) => findCard(b0, id)?.host.id ?? id;
  if (host(from.card) === host(to.card) && from.line === to.line) return null;
  const sides = side ? { from: side } : undefined;
  const id = uid("l");
  // a block end's { i, h } is the hovered or dropped-on object: the board gets its own (rebaseBlocks later swaps it in place)
  const own = (e: End): End => (e.block ? { ...e, block: { ...e.block } } : { ...e });
  env.edit((b) => {
    b.links.push(sides ? { id, from: own(from), to: own(to), sides } : { id, from: own(from), to: own(to) });
  });
  return id;
}

/** A plain arrow becomes a Call arrow for `call` (an arrow that can't carry a mark stays as it is) */
export function markCall(env: CommandEnv, id: string, call: CallSpan) {
  env.edit((b) => {
    const l = b.links.find((k) => k.id === id);
    if (l && canMark(l)) l.call = callMark(call);
  });
}

/** An argument chip on a Call arrow on or off; the last one off leaves no list */
export function toggleCallVar(env: CommandEnv, id: string, v: Var) {
  env.edit((b) => {
    const c = b.links.find((k) => k.id === id)?.call;
    if (!c) return;
    const k = varKey(v);
    const has = (c.vars ?? []).some((x) => varKey(x) === k);
    const next = has ? c.vars!.filter((x) => varKey(x) !== k) : [...(c.vars ?? []), v];
    if (next.length) c.vars = next;
    else delete c.vars;
  });
}

/**
 * Which side each end of an arrow takes: left out = unchanged, "auto" = chosen by the routing again, a side = kept to it (a line
 * end takes left or right only; top or bottom there is ignored by the routing)
 */
export function setLinkSides(env: CommandEnv, id: string, from?: LinkSide | "auto", to?: LinkSide | "auto") {
  env.edit((b) => {
    const l = b.links.find((k) => k.id === id);
    if (!l) return;
    const s = { ...l.sides };
    if (from === "auto") delete s.from;
    else if (from) s.from = from;
    if (to === "auto") delete s.to;
    else if (to) s.to = to;
    if (s.from || s.to) l.sides = s;
    else delete l.sides;
  });
}

/** Change an arrow's look; what is the default (width 2, an arrowhead at the end only) is not stored, nor an empty style */
export function setLinkStyle(env: CommandEnv, id: string, f: (s: LinkStyle) => void) {
  env.edit((b) => {
    const l = b.links.find((k) => k.id === id);
    if (!l) return;
    const s: LinkStyle = { ...l.style, head: l.style?.head ? { ...l.style.head } : undefined };
    f(s);
    if (s.width === 2) delete s.width;
    if (s.head && s.head.start !== true) delete s.head.start;
    if (s.head && s.head.end !== false) delete s.head.end;
    if (s.head && !Object.keys(s.head).length) delete s.head;
    for (const k of Object.keys(s) as (keyof LinkStyle)[]) if (s[k] === undefined) delete s[k];
    if (Object.keys(s).length) l.style = s;
    else delete l.style;
  });
}

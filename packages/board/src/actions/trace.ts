// A pasted Python traceback unrolls into a call chain: the outermost frame in the workspace becomes a card, and each next frame pops
// out of its calling line like a clicked call, one after another, with an arrow marked Observed (the traceback is proof the call ran).
// The line that raised is highlighted, and the exception sits in a Note at the end of the chain. The whole paste is one undo step
import { uid, isCode, findFree, estSize, defaultWidth, placeCards, COL_GAP, type CallSpan, type CodeCard, type NoteCard, type Traceback, type TraceHit } from "@codeboard/core";
import { state, cardById, placed, rectOf } from "../state/store";
import { putViews } from "../state/views";
import { mutate } from "../state/changes";
import { select } from "../state/selection";
import { toast } from "../state/toast";
import { camTo, fitTop, isVisible, viewportCenter } from "../state/camera";
import { lineY } from "../state/geo";
import { settleHome } from "../state/sections";
import { TRACE_STEP } from "../state/timing";
import { ask } from "../host";
import { holdGesture } from "../gesture";
import { hostRect, popCard } from "./common";
import { placeExpanded } from "./flow";

type Step = TraceHit & { at: number };

export async function pasteTrace(t: Traceback, text: string, at?: { x: number; y: number }): Promise<boolean> {
  const hits = await ask("trace", { frames: t.frames }).catch(() => [] as (TraceHit | null)[]);
  const steps: Step[] = hits.flatMap((h, i) => (h ? [{ ...h, at: i }] : []));
  if (!steps.length) { toast("None of these frames are in this workspace, so the traceback is pasted as text"); return false; }
  let dropped = false;
  const done = holdGesture(() => { dropped = true; });
  const merge = uid("trace");
  const via = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  const ev = { kind: "observed" as const, via: "traceback", at: Date.now(), log: [t.error.split("\n")[0] || via].filter(Boolean) };
  const last = steps[steps.length - 1];
  const lastCard = last.card.card as CodeCard;
  lastCard.segments[0].hl = [...new Set([...(lastCard.segments[0].hl ?? []), last.line])];
  try {
    const first = placeFirst(steps[0], merge, at);
    let prev = first;
    for (let i = 1; i < steps.length; i++) {
      await new Promise((r) => setTimeout(r, TRACE_STEP));
      if (dropped || !cardById(prev)) return true;
      const s = steps[i], from = steps[i - 1];
      const seg = (cardById(prev)!.card as CodeCard).segments[0];
      const func = t.frames[s.at].func;
      const calls = state.views[seg.id]?.calls ?? [];
      const call: CallSpan = calls.find((k) => k.line === from.line && k.name === func) ?? calls.find((k) => k.line === from.line)
        ?? { line: from.line, col: 0, end: 0, name: func, loop: false };
      const skipped = s.at - from.at - 1;
      placeExpanded(prev, seg.id, call, s.card.card as CodeCard, s.card.views, [], undefined, s.card.w,
        { mark: { ev }, merge, label: skipped ? `via ${skipped} library frame${skipped === 1 ? "" : "s"}` : undefined });
      prev = s.card.card.id;
    }
    if (t.error) {
      await new Promise((r) => setTimeout(r, TRACE_STEP));
      if (!dropped && cardById(prev)) placeError(prev, last.line, t.error, merge);
    }
  } finally { done(); }
  return true;
}

/** The outermost frame: where the paste was (or the middle of the view), on free space */
function placeFirst(s: Step, merge: string, at?: { x: number; y: number }): string {
  const card = s.card.card as CodeCard;
  putViews(s.card.views);
  const w = s.card.w ?? defaultWidth(card);
  const size = estSize(card, { w });
  const c = at ?? viewportCenter();
  const p = findFree({ x: c.x - (at ? 0 : size.w / 2), y: c.y - (at ? 0 : Math.min(size.h, 300) / 2), ...size }, placed().map((k) => rectOf(k)));
  mutate((b) => {
    placeCards(b, [{ card: structuredClone(card), place: { x: Math.round(p.x), y: Math.round(p.y), w } }], { copy: false });
    settleHome(b, card.id);
  }, { merge });
  select({ cards: [card.id] });
  requestAnimationFrame(() => {
    const r = hostRect(card.id);
    if (r && !isVisible(r)) { const f = fitTop(r, 1); camTo(f.x, f.y, f.z); }
    popCard(card.id);
  });
  return card.id;
}

/** The exception, in a Note beside the line that raised it, with an arrow from that line */
function placeError(cardId: string, line: number, error: string, merge: string) {
  const r = hostRect(cardId);
  const seg = (cardById(cardId)?.card as CodeCard | undefined)?.segments[0];
  if (!r || !seg || !isCode(cardById(cardId)?.card)) return;
  const [head, ...more] = error.split("\n");
  const m = /^([\w.]+)(?::\s?(.*))?$/.exec(head);
  const body = [m ? m[2] ?? "" : head, ...more].filter((l) => l.trim()).join("\n");
  const md = `**${m ? m[1] : "Raised"}**${body ? `\n\n\`\`\`text\n${body}\n\`\`\`` : ""}`;
  const note: NoteCard = { id: uid("n"), kind: "note", md, look: "note" };
  const w = 320;
  const y = (lineY(cardId, seg.id, line)?.y ?? r.y) - 24;
  const size = estSize(note, { w });
  const p = findFree({ x: r.x + r.w + COL_GAP, y, ...size }, placed().map((k) => rectOf(k)));
  mutate((b) => {
    placeCards(b, [{ card: note, place: { x: Math.round(p.x), y: Math.round(p.y), w } }], { copy: false });
    settleHome(b, note.id);
    b.links.push({ id: uid("l"), from: { card: cardId, seg: seg.id, line }, to: { card: note.id } });
  }, { merge });
  requestAnimationFrame(() => {
    const n = hostRect(note.id);
    if (n && !isVisible(n)) {
      const u = { x: Math.min(r.x, n.x), y: Math.min(r.y, n.y), w: Math.max(r.x + r.w, n.x + n.w) - Math.min(r.x, n.x), h: Math.max(r.y + r.h, n.y + n.h) - Math.min(r.y, n.y) };
      const f = fitTop(u, 1); camTo(f.x, f.y, f.z);
    }
    popCard(note.id);
  });
}

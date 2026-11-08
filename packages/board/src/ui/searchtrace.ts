// One ⌘K session's trace: what each query answered (every group, with Related by Meaning's scores), what was picked or nothing,
// the marks and the verdict given. Sent to the host once when ⌘K closes (host searchtrace.ts keeps it on this machine, with
// the project's commit and uncommitted changes). Records what the board was shown, whatever engine answered.
import type { MeaningResult, SearchGroup, SearchItem, SearchTrace, TraceHit, TraceMark } from "@codeboard/core";
import { state } from "../state/store";
import { send } from "../host";

/** What a result points to: board:card, board:card:sidenote, path:line */
export const refOf = (it: SearchItem): string =>
  it.kind === "card"
    ? `${it.board}:${it.card}`
    : it.kind === "sidenote"
      ? `${it.board}:${it.card}:${it.sidenote}`
      : "line" in it
        ? `${it.path}:${it.line}`
        : it.path;

/** The longest passage kept per result */
const HIT_CHARS = 240;

const traceHit = (it: SearchItem, group: SearchGroup, rank: number): TraceHit => {
  const h: TraceHit = { group, rank, kind: it.kind, ref: refOf(it), label: it.label, detail: it.detail };
  if ((it.kind === "card" || it.kind === "sidenote") && it.score !== undefined)
    h.score = Math.round(it.score * 1e4) / 1e4;
  if ((it.kind === "card" || it.kind === "sidenote") && it.preview?.hit) h.hit = it.preview.hit.slice(0, HIT_CHARS);
  return h;
};

/** Word results as hits: each with its group and its place in that group */
const wordHits = (items: SearchItem[]) => {
  const n = new Map<string, number>();
  return items.map((it) => {
    const r = (n.get(it.kind) ?? 0) + 1;
    n.set(it.kind, r);
    return traceHit(it, it.kind, r);
  });
};

export type Verdict = NonNullable<NonNullable<SearchTrace["feedback"]>["verdict"]>;

/** A session's trace being gathered; send() once when ⌘K closes */
export function startTrace(mode: SearchTrace["mode"]) {
  const t0 = performance.now();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const at = new Date().toISOString();
  const board = state.board.id,
    boardName = state.board.name;
  const queries = new Map<string, SearchTrace["queries"][number]>();
  const marks = new Map<string, TraceMark>();
  let pick: SearchTrace["pick"];
  let feedback: SearchTrace["feedback"];

  let scope: SearchTrace["scope"];
  let sent = false;
  const entry = (q: string) => {
    let e = queries.get(q);
    if (!e) queries.set(q, (e = { q, t: 0, hits: [] }));
    e.t = Math.round(performance.now() - t0);
    return e;
  };
  return {
    /** The word groups answered q */
    words(q: string, items: SearchItem[]) {
      if (!q) return;
      const e = entry(q);
      e.hits = [...e.hits.filter((h) => h.group === "meaning"), ...wordHits(items)];
    },
    /** Related by Meaning answered q (its whole answer, before what the words found is taken out) */
    meaning(q: string, r: MeaningResult) {
      if (!q) return;
      const e = entry(q);
      e.hits = [
        ...e.hits.filter((h) => h.group !== "meaning"),
        ...r.items.map((it, i) => traceHit(it, "meaning", i + 1)),
      ];
      const m = { left: r.left, error: r.error, off: r.off, model: r.model };
      e.meaning = Object.values(m).some((v) => v !== undefined) ? JSON.parse(JSON.stringify(m)) : undefined;
    },
    scope(s: SearchTrace["scope"]) {
      scope = s;
    },
    picked(it: SearchItem, group: SearchGroup, rank: number, q: string, alt: boolean) {
      pick = { ...traceHit(it, group, rank), q, ...(alt ? { alt } : {}) };
    },
    /** ⌥↑ / ⌥↓ on a result; undefined takes the mark off */
    mark(it: SearchItem, q: string, good: boolean | undefined) {
      const ref = refOf(it);
      if (good === undefined) marks.delete(ref);
      else marks.set(ref, { ref, label: it.label, q, good });
    },
    /** ⌘.'s verdict and note, under query q */
    feedback(q: string, v: Verdict | undefined, n: string) {
      const note = n.trim();
      feedback = v || note ? { q, ...(v ? { verdict: v } : {}), ...(note ? { note } : {}) } : undefined;
    },
    /** ⌘K closed: the trace goes to the host (nothing typed, picked or said: nothing to keep) */
    send() {
      if (sent) return;
      sent = true;
      if (!queries.size && !pick && !feedback) return;
      // a query typed on the way to a later one (its start) is dropped, unless something was picked, marked or judged under it
      const used = new Set([pick?.q, feedback?.q, ...[...marks.values()].map((m) => m.q)]);
      const all = [...queries.values()].sort((a, b) => a.t - b.t);
      const keep = (e: (typeof all)[number], i: number) =>
        used.has(e.q) || !all.slice(i + 1).some((l) => l.q !== e.q && l.q.startsWith(e.q));
      const trace: SearchTrace = {
        id,
        at,
        ms: Math.round(performance.now() - t0),
        board,
        boardName,
        mode,
        ...(scope ? { scope } : {}),
        queries: all.filter(keep),
        ...(pick ? { pick } : {}),
        ...(marks.size ? { marks: [...marks.values()] } : {}),
        ...(feedback ? { feedback } : {}),
      };
      send({ type: "searchTrace", trace });
    },
  };
}

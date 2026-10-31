import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, danglingRefs, emptyBoard, type Board, type CodeCard, type DiffData, type Segment, type SegView, type Settings, type Stale } from "../src";
import { cardStale, keepVersion, nextToReview, staleCount, updateAll, type Choice, type VersionEnv } from "../src/commands";

const seg = (id: string, text: string[], commit = "aaa1111"): Segment => ({ id, src: { kind: "repo", repo: "" }, path: "m.py", lang: "python", start: 10, end: 9 + text.length, text, version: { kind: "git", commit } });
const view = (n: number): SegView => ({ html: Array(n).fill("x"), flags: Array(n).fill(0), calls: [], defs: [] });

function board(): Board {
  const b = emptyBoard("b", "B");
  b.cards.push({ id: "c1", kind: "code", segments: [seg("s1", ["def f():", "    return 1"])] }, { id: "c2", kind: "code", segments: [seg("s2", ["def g():", "    return 2"])] });
  b.place.c1 = { x: 0, y: 0, w: 400 };
  b.place.c2 = { x: 500, y: 0, w: 400 };
  b.sidenotes.push({ id: "n1", at: { card: "c1", seg: "s1", lines: [11, 11] }, kind: "text", md: "one" });
  return b;
}

/** A plain-object env: the board, the stale map, the boards each card is on, scripted answers to the host and the user */
function env(o: { stale: Record<string, Stale>; shared?: Record<string, number>; answer?: number | null; settings?: Partial<Settings>; diff?: (s: Segment) => DiffData }) {
  const b = board();
  const stale: Record<string, Stale | undefined> = { ...o.stale };
  const log = { edits: 0, asked: [] as Choice[], toasts: [] as string[], views: {} as Record<string, SegView>, diffs: [] as string[] };
  const e: VersionEnv = {
    board: () => b,
    edit: (fn) => { fn(b); log.edits++; },
    ask: (async (type: string, body: { seg: Segment }) => {
      expect(type).toBe("diff");
      log.diffs.push(body.seg.id);
      return (o.diff ?? newVersion)(body.seg);
    }) as VersionEnv["ask"],
    choose: async (q) => { log.asked.push(q); return o.answer ?? null; },
    toast: (t) => { log.toasts.push(t); },
    settings: () => ({ ...DEFAULT_SETTINGS, ...o.settings }),
    stale: (id) => stale[id],
    staleOk: (ids) => { for (const id of ids) stale[id] = { state: "ok" }; },
    putViews: (v) => Object.assign(log.views, v),
    sharedOn: (id) => o.shared?.[id] ?? 1,
  };
  return { b, e, log, stale };
}
const newVersion = (s: Segment): DiffData => {
  const text = [...s.text.slice(0, 1), "    return 3"];
  return { title: "New Version", left: { label: "", path: "", start: 10, text: s.text, html: [] }, right: { label: "", path: "", start: 10, text, html: [] }, canUpdate: true, newSeg: { ...s, text, version: { kind: "git", commit: "bbb2222" } }, newView: view(2) };
};
const changed = (head = "bbb2222"): Stale => ({ state: "changed", hiddenOnly: false, head });

describe("version commands", () => {
  it("shows a card's version dot from its segments' states", () => {
    const { b } = env({ stale: {} });
    const c = b.cards[0] as CodeCard;
    expect(cardStale(c, () => undefined)).toBeNull();
    expect(cardStale(c, () => changed())).toBe("changed");
    expect(cardStale(c, () => ({ state: "changed", hiddenOnly: true, head: "b" }))).toBe("hidden");
    expect(cardStale(c, () => ({ state: "lost" }))).toBe("lost");
    expect(cardStale({ ...c, keepOld: true }, () => ({ state: "lost" }))).toBeNull();
    expect(cardStale(c, () => ({ state: "missing" }))).toBe("missing");
    // Kept at this HEAD: no dot until a newer one
    expect(cardStale({ ...c, segments: [{ ...c.segments[0], keep: "bbb2" }] }, () => changed())).toBeNull();
  });

  it("counts the changed cards and finds the next one to review", () => {
    const { b } = env({ stale: {} });
    const st: Record<string, Stale> = { s2: changed() };
    expect(staleCount(b, (id) => st[id])).toBe(1);
    expect(nextToReview(b, (id) => st[id])).toBe("c2");
    expect(nextToReview(b, () => undefined)).toBeNull();
  });

  it("updates every changed card in one go, without asking when no card is shared", async () => {
    const { b, e, log, stale } = env({ stale: { s1: changed(), s2: changed() } });
    await updateAll(e);
    expect(log.asked).toEqual([]);
    expect(log.diffs).toEqual(["s1", "s2"]);
    expect(b.cards.map((c) => (c as CodeCard).segments[0].text[1])).toEqual(["    return 3", "    return 3"]);
    expect(stale.s1).toEqual({ state: "ok" });
    expect(Object.keys(log.views).sort()).toEqual(["s1", "s2"]);
    // The sidenote sat on the changed line: marked for review
    expect(b.sidenotes[0].review).toBeTruthy();
    expect(log.toasts).toEqual(["Updated 2 cards"]);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("asks once for the linked cards, and This Board Only updates a copy here", async () => {
    const { b, e, log } = env({ stale: { s1: changed(), s2: changed() }, shared: { c1: 2 }, answer: 1 });
    await updateAll(e);
    expect(log.asked.map((q) => q.title)).toEqual(["1 of these cards is also on other boards"]);
    const ids = b.cards.map((c) => c.id);
    expect(ids).not.toContain("c1");
    expect(ids).toContain("c2");
    expect(b.cards.every((c) => (c as CodeCard).segments[0].text[1] === "    return 3")).toBe(true);
    expect(danglingRefs(b)).toEqual([]);
  });

  it("skips the linked cards when asked to, and does nothing when the question is dismissed", async () => {
    const skip = env({ stale: { s1: changed(), s2: changed() }, shared: { c1: 2 }, answer: 2 });
    await updateAll(skip.e);
    expect(skip.log.diffs).toEqual(["s2"]);
    expect(skip.log.toasts).toEqual(["Updated 1 of 2; open the others to review"]);
    const gone = env({ stale: { s1: changed() }, shared: { c1: 2 }, answer: null });
    await updateAll(gone.e);
    expect(gone.log.diffs).toEqual([]);
    expect(gone.log.edits).toBe(0);
    expect(gone.log.toasts).toEqual([]);
  });

  it("follows the sharedUpdate setting without asking", async () => {
    const { log } = await (async () => { const r = env({ stale: { s1: changed() }, shared: { c1: 3 }, settings: { sharedUpdate: "all" } }); await updateAll(r.e); return r; })();
    expect(log.asked).toEqual([]);
    expect(log.diffs).toEqual(["s1"]);
  });

  it("counts a card the host cannot update as left for review", async () => {
    const { log } = await (async () => {
      const r = env({ stale: { s1: changed(), s2: changed() }, diff: (s) => (s.id === "s2" ? { ...newVersion(s), canUpdate: false } : newVersion(s)) });
      await updateAll(r.e);
      return r;
    })();
    expect(log.toasts).toEqual(["Updated 1 of 2; open the others to review"]);
  });

  it("keeps the pinned version by remembering the new HEAD", () => {
    const { b, e, stale } = env({ stale: { s1: changed("ccc3333") } });
    keepVersion(e, "c1", "s1");
    expect((b.cards[0] as CodeCard).segments[0].keep).toBe("ccc3333");
    expect(cardStale(b.cards[0] as CodeCard, (id) => stale[id])).toBeNull();
    keepVersion(e, "c2", "s2");
    expect(stale.s2).toEqual({ state: "ok" });
  });
});

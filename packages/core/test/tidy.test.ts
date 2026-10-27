import { describe, expect, it } from "vitest";
import { overlaps, GAP } from "../src";
import { tidy, TIDY_COL_GAP } from "../src/tidy";

const card = (id: string, x: number, y: number, w = 200, h = 100) => ({ id, x, y, w, h });
type At = Map<string, { x: number; y: number }>;
const at = (m: At, id: string) => m.get(id)!;
const noOverlaps = (m: At, rs: ReturnType<typeof card>[]) => {
  const placed = rs.map((r) => ({ ...r, ...at(m, r.id) }));
  for (const a of placed) for (const b of placed) if (a !== b) expect(overlaps(a, b), `${a.id} / ${b.id}`).toBe(false);
};

describe("tidy", () => {
  it("lays out cards without arrows as rows, grouped by y and ordered by x, from the top-left", async () => {
    const rs = [card("b", 500, 110), card("a", 100, 90), card("c", 300, 400), card("d", 120, 420, 200, 60)];
    const m = await tidy(rs, []);
    expect(at(m, "a")).toEqual({ x: 100, y: 90 });
    expect(at(m, "b")).toEqual({ x: 100 + 200 + GAP, y: 90 });
    const y2 = 90 + 100 + GAP;
    expect(at(m, "d")).toEqual({ x: 100, y: y2 });
    expect(at(m, "c")).toEqual({ x: 100 + 200 + GAP, y: y2 });
  });

  it("puts linked cards in columns by call depth, keeping the current top-to-bottom order within a column", async () => {
    const rs = [card("a", 0, 300), card("b", 900, 500), card("c", 600, 0), card("d", 50, 800, 300)];
    const m = await tidy(rs, [["a", "b"], ["a", "c"], ["c", "d"]]);
    expect(at(m, "a").x).toBe(0);
    expect(at(m, "b").x).toBe(200 + TIDY_COL_GAP);
    expect(at(m, "c").x).toBe(200 + TIDY_COL_GAP);
    expect(at(m, "d").x).toBe(2 * (200 + TIDY_COL_GAP));
    expect(at(m, "c").y).toBeLessThan(at(m, "b").y);
    expect(Math.min(...[...m.values()].map((p) => p.y))).toBe(0);
    noOverlaps(m, rs);
  });

  it("uncrosses arrows that cross where the cards are now", async () => {
    // a → d and b → c cross where they are
    const rs = [card("a", 0, 0), card("b", 0, 300), card("c", 600, 0), card("d", 600, 300)];
    const m = await tidy(rs, [["a", "d"], ["b", "c"]]);
    const mid = (id: string) => at(m, id).y + 50;
    expect(Math.sign(mid("a") - mid("b"))).toBe(Math.sign(mid("d") - mid("c")));
  });

  it("puts unlinked cards in rows under the arrow group when only some are linked", async () => {
    const rs = [card("a", 0, 0), card("b", 400, 0), card("c", 100, 300, 150), card("x", 800, 600), card("y", 50, 620)];
    // q is not selected, so x counts as unlinked
    const m = await tidy(rs, [["a", "b"], ["b", "c"], ["q", "x"]]);
    expect(at(m, "a").x).toBeLessThan(at(m, "b").x);
    expect(at(m, "b").x).toBeLessThan(at(m, "c").x);
    const groupBottom = Math.max(...["a", "b", "c"].map((id) => at(m, id).y + 100));
    expect(at(m, "y")).toEqual({ x: 0, y: groupBottom + TIDY_COL_GAP });
    expect(at(m, "x")).toEqual({ x: 200 + GAP, y: groupBottom + TIDY_COL_GAP });
  });

  it("terminates on cycles and still gives every card its own place", async () => {
    const rs = [card("a", 0, 0), card("b", 300, 0), card("c", 600, 0), card("s", 900, 0)];
    const m = await tidy(rs, [["a", "b"], ["b", "c"], ["c", "a"], ["s", "s"]]);
    expect([...m.keys()].sort()).toEqual(["a", "b", "c", "s"]);
    expect(new Set(["a", "b", "c"].map((id) => at(m, id).x)).size).toBe(3);
    // an arrow from a card to itself does not count as linked
    const groupBottom = Math.max(...["a", "b", "c"].map((id) => at(m, id).y + 100));
    expect(at(m, "s")).toEqual({ x: 0, y: groupBottom + TIDY_COL_GAP });
    noOverlaps(m, rs);
  });

  it("moves cards past locked cards in the way instead of overlapping them", async () => {
    const locked = { x: 230, y: -20, w: 200, h: 200 };
    const rows = [card("a", 0, 0), card("b", 0, 300), card("c", 600, 50)];
    const m = await tidy(rows, [], [locked]);
    for (const [, p] of m) expect(overlaps({ ...p, w: 200, h: 100 }, locked)).toBe(false);
    expect(at(m, "a")).toEqual({ x: 0, y: 0 });
    expect(at(m, "c")).toEqual({ x: locked.x + locked.w + GAP, y: 0 });
    expect(at(m, "b")).toEqual({ x: 0, y: 100 + GAP });
    // in a column, a locked card pushes the card down past it, and the rest of the column makes room
    const lock2 = { x: 250, y: 0, w: 300, h: 100 };
    const cols = [card("p", 0, 0), card("q", 400, 0), card("r", 0, 500)];
    const col = await tidy(cols, [["p", "q"], ["p", "r"]], [lock2]);
    for (const [, p] of col) expect(overlaps({ ...p, w: 200, h: 100 }, lock2)).toBe(false);
    noOverlaps(col, cols);
  });
});

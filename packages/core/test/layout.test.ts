import { describe, expect, it } from "vitest";
import { sectionFit, SECTION_PAD, tidy, overlaps, GAP, TIDY_COL_GAP } from "../src";

describe("sectionFit", () => {
  it("wraps the inner rects with the Section padding, rounded outward", () => {
    const r = sectionFit([{ x: 100, y: 200, w: 300, h: 120.4 }, { x: 450.5, y: 260, w: 200, h: 80 }]);
    expect(r).toEqual({ x: 100 - SECTION_PAD.l, y: 200 - SECTION_PAD.t, w: Math.ceil(650.5 + SECTION_PAD.r) - (100 - SECTION_PAD.l), h: 340 + SECTION_PAD.b - (200 - SECTION_PAD.t) });
  });
  it("is undefined for an empty Section", () => {
    expect(sectionFit([])).toBeUndefined();
  });
});

describe("tidy", () => {
  const card = (id: string, x: number, y: number, w = 200, h = 100) => ({ id, x, y, w, h });
  const at = (m: Map<string, { x: number; y: number }>, id: string) => m.get(id)!;

  it("lays out cards without arrows as rows, grouped by y and ordered by x, from the top-left", () => {
    const rs = [card("b", 500, 110), card("a", 100, 90), card("c", 300, 400), card("d", 120, 420, 200, 60)];
    const m = tidy(rs, []);
    expect(at(m, "a")).toEqual({ x: 100, y: 90 });
    expect(at(m, "b")).toEqual({ x: 100 + 200 + GAP, y: 90 });
    // second row: top-aligned under the first row, ordered by x
    const y2 = 90 + 100 + GAP;
    expect(at(m, "d")).toEqual({ x: 100, y: y2 });
    expect(at(m, "c")).toEqual({ x: 100 + 200 + GAP, y: y2 });
  });

  it("puts all-linked cards in columns by arrow depth, keeping the top-to-bottom order in each column", () => {
    const rs = [card("a", 0, 300), card("b", 900, 0), card("c", 600, 500), card("d", 50, 800, 300)];
    const m = tidy(rs, [["a", "b"], ["a", "c"], ["c", "d"]]);
    expect(at(m, "a")).toEqual({ x: 0, y: 0 });
    expect(at(m, "b")).toEqual({ x: 200 + TIDY_COL_GAP, y: 0 });
    expect(at(m, "c")).toEqual({ x: 200 + TIDY_COL_GAP, y: 100 + GAP });
    expect(at(m, "d")).toEqual({ x: 2 * (200 + TIDY_COL_GAP), y: 0 });
  });

  it("puts unlinked cards in rows under the arrow group when only some are linked", () => {
    const rs = [card("a", 0, 0), card("b", 400, 0), card("c", 100, 300, 150), card("x", 800, 600), card("y", 50, 620)];
    // q is not selected, so x counts as unlinked
    const m = tidy(rs, [["a", "b"], ["b", "c"], ["q", "x"]]);
    expect(at(m, "a").x).toBeLessThan(at(m, "b").x);
    expect(at(m, "b").x).toBeLessThan(at(m, "c").x);
    const groupBottom = Math.max(...["a", "b", "c"].map((id) => at(m, id).y + 100));
    expect(at(m, "y")).toEqual({ x: 0, y: groupBottom + TIDY_COL_GAP });
    expect(at(m, "x")).toEqual({ x: 200 + GAP, y: groupBottom + TIDY_COL_GAP });
  });

  it("terminates on cycles and still gives every card a place", () => {
    const rs = [card("a", 0, 0), card("b", 300, 0), card("c", 600, 0), card("s", 900, 0)];
    const m = tidy(rs, [["a", "b"], ["b", "c"], ["c", "a"], ["s", "s"]]);
    expect([...m.keys()].sort()).toEqual(["a", "b", "c", "s"]);
    expect(at(m, "a").x).toBeLessThan(at(m, "b").x);
    expect(at(m, "b").x).toBeLessThan(at(m, "c").x);
    // an arrow from a card to itself does not count as linked
    expect(at(m, "s")).toEqual({ x: 0, y: 100 + TIDY_COL_GAP });
  });

  it("moves cards past locked cards in the way instead of overlapping them", () => {
    const locked = { x: 230, y: -20, w: 200, h: 200 };
    const m = tidy([card("a", 0, 0), card("b", 0, 300), card("c", 600, 50)], [], [locked]);
    for (const [, p] of m) expect(overlaps({ ...p, w: 200, h: 100 }, locked)).toBe(false);
    expect(at(m, "a")).toEqual({ x: 0, y: 0 });
    expect(at(m, "c")).toEqual({ x: locked.x + locked.w + GAP, y: 0 });
    expect(at(m, "b")).toEqual({ x: 0, y: 100 + GAP });
    // in a column, a locked card pushes the card down past it, and the rest of the column follows
    const lock2 = { x: 250, y: 90, w: 300, h: 100 };
    const col = tidy([card("p", 0, 0), card("q", 400, 0), card("r", 0, 500)], [["p", "q"], ["p", "r"]], [lock2]);
    expect(at(col, "q")).toEqual({ x: 200 + TIDY_COL_GAP, y: lock2.y + lock2.h + GAP });
    expect(at(col, "r")).toEqual({ x: 200 + TIDY_COL_GAP, y: lock2.y + lock2.h + GAP + 100 + GAP });
  });
});

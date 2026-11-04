import { describe, expect, it } from "vitest";
import { placeLabels, type LabelBox, type LabelPlace } from "../src/annots";

/** no two labels of one row overlap, and every label stays over its own arrow and inside the block */
function sound(ls: LabelBox[], ps: LabelPlace[], room: number) {
  ps.forEach((p, i) => {
    expect(p.x).toBeGreaterThanOrEqual(-0.01);
    expect(p.x + ls[i].w).toBeLessThanOrEqual(room + 0.01);
    expect(p.x).toBeLessThan(ls[i].c);
    expect(p.x + ls[i].w).toBeGreaterThan(ls[i].c);
    ps.forEach((q, j) => {
      if (j <= i || q.row !== p.row) return;
      expect(p.x + ls[i].w <= q.x || q.x + ls[j].w <= p.x).toBe(true);
    });
  });
}

describe("annotation labels on one line", () => {
  it("stay centred over their arrow when they are apart", () => {
    const ls = [
      { c: 100, w: 40 },
      { c: 300, w: 60 },
    ];
    expect(placeLabels(ls, 500)).toEqual([
      { x: 80, row: 0 },
      { x: 270, row: 0 },
    ]);
  });
  it("one past the block is pulled back inside, the left edge first", () => {
    expect(placeLabels([{ c: 490, w: 60 }], 500)).toEqual([{ x: 440, row: 0 }]);
    expect(placeLabels([{ c: 10, w: 60 }], 500)).toEqual([{ x: 0, row: 0 }]);
    expect(placeLabels([{ c: 100, w: 600 }], 500)).toEqual([{ x: 0, row: 0 }]);
  });
  it("two close labels spread apart, half the overlap each (#115: 8倍 / 倍数据速率)", () => {
    const ls = [
      { c: 170, w: 36 },
      { c: 250, w: 160 },
    ];
    // centred: 152..188 and 170..330, 22px too close with the gap
    const ps = placeLabels(ls, 600);
    expect(ps).toEqual([
      { x: 141, row: 0 },
      { x: 181, row: 0 },
    ]);
    sound(ls, ps, 600);
  });
  it("what one cannot move, the other does: the earlier one stops at the block's edge or its arrow", () => {
    const ls = [
      { c: 20, w: 40 },
      { c: 60, w: 60 },
    ];
    // the first is at the left edge already: the second takes the whole shift
    const ps = placeLabels(ls, 600);
    expect(ps).toEqual([
      { x: 0, row: 0 },
      { x: 44, row: 0 },
    ]);
    sound(ls, ps, 600);
  });
  it("goes up a row when moving aside would take it off its arrow, and keeps the raised arrow free below", () => {
    // the first is at the block's left edge and cannot move left; the second cannot move far enough right
    const ls = [
      { c: 60, w: 120 },
      { c: 90, w: 80 },
      { c: 170, w: 140 },
    ];
    const ps = placeLabels(ls, 600);
    expect(ps.map((p) => p.row)).toEqual([0, 1, 0]);
    sound(ls, ps, 600);
    // the third does not cover the second's arrow, which goes up past row 0 at 90
    expect(ps[2].x).toBeGreaterThanOrEqual(90 + 6);
  });
  it("in any order, with many labels crowded together, never overlaps on a row", () => {
    const ls = [
      { c: 250, w: 90 },
      { c: 200, w: 70 },
      { c: 230, w: 50 },
      { c: 215, w: 100 },
    ];
    const ps = placeLabels(ls, 400);
    sound(ls, ps, 400);
    expect(Math.max(...ps.map((p) => p.row))).toBeGreaterThan(0);
  });
});

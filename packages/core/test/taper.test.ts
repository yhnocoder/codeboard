import { describe, expect, it } from "vitest";
import { taperLine } from "../src/canvas/taper";
import { headPath } from "../src/canvas/route";

/** The outline's corner points (the cap's arc left out): one side to the end, then the other side back */
const pts = (d: string) => {
  const n = d
    .replace(/A[^Z]*Z/, "")
    .match(/-?\d+(\.\d+)?/g)!
    .map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
};

describe("taperLine", () => {
  it("is a closed filled outline with a round cap at the source, the same for the same path", () => {
    const a = taperLine("M0 0 C120 0 280 200 400 200");
    expect(a.d).toMatch(/^M.*A1\.25 1\.25 0 0 0 .*Z$/);
    expect(a).toEqual(taperLine("M0 0 C120 0 280 200 400 200"));
  });
  it("is 2.5 wide at the source and thins evenly to 0.9 at the end", () => {
    const p = pts(taperLine("M0 0 L300 0").d),
      half = p.length / 2;
    const width = (i: number) => Math.abs(p[i][1] - p[p.length - 1 - i][1]);
    expect(width(0)).toBeCloseTo(2.5, 2);
    expect(width(half - 1)).toBeCloseTo(0.9, 2);
    expect(width(Math.floor((half - 1) / 2))).toBeCloseTo(1.7, 1);
    // the end is the route's end, heading along it
    expect(taperLine("M0 0 L300 0").end).toEqual({ x: 300, y: 0, ux: 1, uy: 0 });
  });
  it("draws only the part from the source while it is being drawn, at the widths of the whole line", () => {
    const t = taperLine("M0 0 L300 0", 2.5, 0.9, 0.5),
      p = pts(t.d);
    expect(Math.max(...p.map((q) => q[0]))).toBeCloseTo(150, 5);
    expect(t.end).toMatchObject({ x: 150, y: 0, ux: 1 });
    const half = p.length / 2;
    expect(Math.abs(p[half - 1][1] - p[half][1])).toBeCloseTo(1.7, 2);
  });
  it("follows routes of several segments, scaled widths for the thin and thick styles", () => {
    const p = pts(taperLine("M0 0 L100 0 Q114 0 114 14 L114 200", 1.5, 0.54).d);
    expect(Math.max(...p.map((q) => q[1]))).toBeGreaterThan(199);
    expect(Math.max(...p.map((q) => q[0]))).toBeLessThan(115);
    expect(taperLine("M5 5")).toEqual({ d: "", end: null });
  });
});

describe("headPath dart", () => {
  it("is a small filled dart with its tip on the end and a notched tail", () => {
    const n = headPath("dart", 100, 50, 1, 0)
      .match(/-?\d+(\.\d+)?/g)!
      .map(Number);
    expect(n).toEqual([100, 50, 93.5, 53, 95.4, 50, 93.5, 47]);
    expect(headPath("dart", 0, 0, 1, 0)).toMatch(/Z$/);
  });
});

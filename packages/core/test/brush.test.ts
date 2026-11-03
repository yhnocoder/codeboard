import { describe, expect, it } from "vitest";
import { brushLine, brushSeed, fnv } from "../src/canvas/brush";

const D = "M0 0 C120 0 280 200 400 200";
const pts = (d: string) => {
  const n = d
    .replace(/A[^Z]*Z/, "")
    .match(/-?\d+(\.\d+)?/g)!
    .map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
};

describe("brushLine", () => {
  it("is a closed filled outline, the same for the same path and seed", () => {
    const a = brushLine(D, brushSeed("L1"));
    expect(a.d.startsWith("M")).toBe(true);
    expect(a.d.endsWith("Z")).toBe(true);
    expect(a).toEqual(brushLine(D, brushSeed("L1")));
    expect(a.d).not.toEqual(brushLine(D, brushSeed("L2")).d);
  });
  it("is heavier near the start than at the end", () => {
    const p = pts(brushLine("M0 0 L400 0", 0).d),
      half = p.length / 2;
    // the outline goes along one side and back along the other: the width at a point is the two sides' distance
    const width = (i: number) => Math.abs(p[i][1] - p[p.length - 1 - i][1]);
    expect(width(Math.round(half * 0.1))).toBeGreaterThan(width(half - 2) * 2);
    expect(Math.max(...p.map((q) => Math.abs(q[1])))).toBeLessThan(1.5 * 1.3 * 1.12 + 0.1);
  });
  it("follows routes of several segments (lines and rounded corners)", () => {
    const p = pts(brushLine("M0 0 L100 0 Q114 0 114 14 L114 200", 1).d);
    expect(Math.max(...p.map((q) => q[1]))).toBeGreaterThan(190);
    expect(Math.max(...p.map((q) => q[0]))).toBeLessThan(117);
  });
  it("draws three dry-brush hairlines only on lines long enough", () => {
    expect(brushLine(D, 0).fb.match(/M/g)).toHaveLength(3);
    expect(brushLine("M0 0 L40 0", 0).fb).toBe("");
  });
});

describe("fnv", () => {
  it("is stable per string and spreads words", () => {
    expect(fnv("schedule")).toBe(fnv("schedule"));
    expect(
      new Set(["schedule", "call", "postprocess", "allocate", "run_model", "sampler"].map((w) => fnv(w) % 5)).size,
    ).toBeGreaterThan(2);
  });
});

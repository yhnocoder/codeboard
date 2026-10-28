import { describe, expect, it } from "vitest";
import { handLine } from "../../src/canvas/hand";

const C = [0, 0, 120, 0, 280, 200, 400, 200];
const nums = (d: string) => d.match(/-?\d+(\.\d+)?/g)!.map(Number);

describe("handLine", () => {
  it("draws the same strokes for the same id and curve", () => {
    expect(handLine("L1", C, true, false)).toEqual(handLine("L1", C, true, false));
  });
  it("draws different strokes for different ids", () => {
    expect(handLine("L1", C, true, false).d).not.toEqual(handLine("L2", C, true, false).d);
  });
  it("starts and ends exactly on the curve's ends", () => {
    for (const id of ["a", "b", "link-7", "中"]) {
      const n = nums(handLine(id, C, true, true).d);
      expect(n.slice(0, 2)).toEqual([0, 0]);
      expect(n.slice(-2)).toEqual([400, 200]);
    }
  });
  it("writes integer coordinates in the line paths", () => {
    const h = handLine("L1", C, false, false);
    expect(h.d).not.toMatch(/\./);
    expect(h.d2).not.toMatch(/\./);
  });
  it("draws arrowheads only on the ends asked for", () => {
    const h = handLine("L1", C, true, false);
    expect(h.head).toBeTruthy();
    expect(h.tail).toBeUndefined();
    expect(handLine("L1", C, false, true).tail).toBeTruthy();
  });
  it("stays near the curve: wobble and bow stay within a few pixels", () => {
    const n = nums(handLine("L1", [0, 0, 100, 0, 200, 0, 300, 0], false, false).d);
    const ys = n.filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys.map(Math.abs))).toBeLessThanOrEqual(8);
  });
});

import { describe, expect, it } from "vitest";
import { dragEdge, dropIndex, slotsAfter } from "../src/editor/tablemove";

// a header row of 30 and three rows of 40, 20 and 40
const starts = [0, 30, 70, 90],
  sizes = [30, 40, 20, 40];

describe("dragging a table row", () => {
  it("lands where it is until its edge passes a neighbour's middle", () => {
    expect(dropIndex(starts, sizes, 1, 30, 1)).toBe(1);
    // row 1 moved down so its bottom (edge + 40) passes row 2's middle (80)
    expect(dropIndex(starts, sizes, 1, 39, 1)).toBe(1);
    expect(dropIndex(starts, sizes, 1, 41, 1)).toBe(2);
    expect(dropIndex(starts, sizes, 1, 90, 1)).toBe(3);
    // row 3 moved up: its top passes row 2's middle, then row 1's
    expect(dropIndex(starts, sizes, 3, 79, 1)).toBe(2);
    expect(dropIndex(starts, sizes, 3, 49, 1)).toBe(1);
  });
  it("never goes above the header row", () => {
    expect(dragEdge(starts, sizes, 3, -500, 1)).toBe(30);
    expect(dropIndex(starts, sizes, 3, 30, 1)).toBe(1);
    expect(dragEdge(starts, sizes, 1, 500, 1)).toBe(90);
  });
  it("slides the others into the rows it leaves", () => {
    expect(slotsAfter(starts, sizes, 1, 3)).toEqual([0, 90, 30, 50]);
    expect(slotsAfter(starts, sizes, 3, 1)).toEqual([0, 70, 110, 30]);
    expect(slotsAfter(starts, sizes, 2, 2)).toEqual(starts);
  });
  it("moves a column to the very first place", () => {
    expect(dropIndex(starts, sizes, 2, 0)).toBe(0);
    expect(slotsAfter(starts, sizes, 2, 0)).toEqual([20, 50, 0, 90]);
  });
});

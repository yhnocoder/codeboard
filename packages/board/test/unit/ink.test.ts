// Ink Wash's card paper (state/ink.ts): one nine-slice sheet per edge pattern, the same for every card size, the same sheet for the
// same seed every time, and its own colours for light and dark. paperOf draws it on a canvas (a PNG, not an SVG: the scenarios
// inkWashLook / inkWashPaperKeptWhileEditing check that in the page); here only its shapes
import { describe, expect, it } from "vitest";
import { paperSheet } from "../../src/state/ink";

describe("paperSheet", () => {
  it("is the same sheet for the same seed every time", () => {
    expect(paperSheet(false, 2)).toEqual(paperSheet(false, 2));
  });
  it("is one square sheet for the nine-slice border image: 2 × 30 px slices around a 240 px tiled middle", () => {
    expect(paperSheet(false, 1).size).toBe(300);
  });
  it("has its own colours in dark, and a few edge patterns", () => {
    expect(paperSheet(true, 1).paper).not.toBe(paperSheet(false, 1).paper);
    expect(paperSheet(true, 1).outline).toBe(paperSheet(false, 1).outline);
    const outlines = new Set([1, 2, 3, 4].map((s) => paperSheet(false, s).outline));
    expect(outlines.size).toBe(4);
  });
  it("keeps the torn edge on its line where the slices meet, so the tiled edges join without a step", () => {
    // the top edge runs along y = 14 (PAPER_M); at x = 30 and x = 270 (the slice lines) it is exactly on it
    const pts = paperSheet(false, 3)
      .outline.slice(1, -1)
      .split("L")
      .map((p) => p.split(" ").map(Number));
    for (const x of [30, 270]) expect(pts.find((p) => p[0] === x && Math.abs(p[1] - 14) < 2)?.[1]).toBe(14);
  });
});

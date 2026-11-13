import { describe, expect, it } from "vitest";
import { dragFrameEdge, nudgeInto, sectionFit, SECTION_MIN, SECTION_PAD } from "../src";

describe("sectionFit", () => {
  it("wraps the inner rects with the Section padding, rounded outward", () => {
    const r = sectionFit([
      { x: 100, y: 200, w: 300, h: 120.4 },
      { x: 450.5, y: 260, w: 200, h: 80 },
    ]);
    expect(r).toEqual({
      x: 100 - SECTION_PAD.l,
      y: 200 - SECTION_PAD.t,
      w: Math.ceil(650.5 + SECTION_PAD.r) - (100 - SECTION_PAD.l),
      h: 340 + SECTION_PAD.b - (200 - SECTION_PAD.t),
    });
  });
  it("is undefined for an empty Section", () => {
    expect(sectionFit([])).toBeUndefined();
  });
});

describe("dragFrameEdge", () => {
  const f = { x: 100, y: 200, w: 400, h: 300 };
  it("moves only the dragged edges, the opposite ones stay", () => {
    expect(dragFrameEdge(f, "e", 50, 70)).toEqual({ x: 100, y: 200, w: 450, h: 300 });
    expect(dragFrameEdge(f, "s", 50, 70)).toEqual({ x: 100, y: 200, w: 400, h: 370 });
    expect(dragFrameEdge(f, "w", -60, 70)).toEqual({ x: 40, y: 200, w: 460, h: 300 });
    expect(dragFrameEdge(f, "n", 50, 30)).toEqual({ x: 100, y: 230, w: 400, h: 270 });
    expect(dragFrameEdge(f, "nw", 20.4, -10.6)).toEqual({ x: 120, y: 189, w: 380, h: 311 });
    expect(dragFrameEdge(f, "se", 10, 20)).toEqual({ x: 100, y: 200, w: 410, h: 320 });
    expect(dragFrameEdge(f, "ne", 10, 20)).toEqual({ x: 100, y: 220, w: 410, h: 280 });
    expect(dragFrameEdge(f, "sw", 10, 20)).toEqual({ x: 110, y: 200, w: 390, h: 320 });
  });
  it("keeps the smallest size, a dragged top or left edge stopping short of the opposite one", () => {
    expect(dragFrameEdge(f, "nw", 1000, 1000)).toEqual({
      x: 500 - SECTION_MIN.w,
      y: 500 - SECTION_MIN.h,
      w: SECTION_MIN.w,
      h: SECTION_MIN.h,
    });
    expect(dragFrameEdge(f, "se", -1000, -1000)).toEqual({ x: 100, y: 200, w: SECTION_MIN.w, h: SECTION_MIN.h });
  });
});

describe("nudgeInto", () => {
  const area = { x: 0, y: 0, w: 1000, h: 600 };
  it("leaves what is wholly inside where it is, even right at the edge", () => {
    expect(nudgeInto({ x: 0, y: 590, w: 200, h: 10 }, area, 24)).toEqual({ dx: 0, dy: 0 });
  });
  it("moves only the axis it sticks out on, by the least that leaves the margin", () => {
    expect(nudgeInto({ x: 900, y: 10, w: 200, h: 100 }, area, 24)).toEqual({ dx: -124, dy: 0 });
    expect(nudgeInto({ x: 10, y: -50, w: 200, h: 100 }, area, 24)).toEqual({ dx: 0, dy: 74 });
  });
  it("shares what room there is when the whole margin does not fit", () => {
    expect(nudgeInto({ x: 1100, y: 0, w: 980, h: 100 }, area, 24)).toEqual({ dx: -1090, dy: 0 });
  });
  it("puts what is larger than the area at the margin from its left and top", () => {
    expect(nudgeInto({ x: 300, y: 200, w: 1500, h: 900 }, area, 24)).toEqual({ dx: -276, dy: -176 });
  });
});

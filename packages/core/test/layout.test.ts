import { describe, expect, it } from "vitest";
import { sectionFit, SECTION_PAD } from "../src";

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

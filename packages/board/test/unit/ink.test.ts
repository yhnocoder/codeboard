// Ink Wash's card paper (state/ink.ts): one nine-slice image per edge pattern, the same for every card size, the same image for the
// same card every time, and its own for light and dark
import { describe, expect, it } from "vitest";
import { paperOf } from "../../src/state/ink";

describe("paperOf", () => {
  it("is the same image for the same card every time", () => {
    const a = paperOf("c1", false);
    expect(a.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(paperOf("c1", false)).toBe(a);
  });
  it("is one sheet for the nine-slice border image: 2 × 30 px slices around a 240 px tiled middle, kept square", () => {
    const a = paperOf("c1", false);
    expect(a).toContain("width='300' height='300'");
    expect(a).not.toContain("preserveAspectRatio");
  });
  it("has its own image in dark, and a few edge patterns between cards", () => {
    expect(paperOf("c1", true)).not.toBe(paperOf("c1", false));
    const ids = Array.from({ length: 12 }, (_, i) => `card${i}`);
    expect(new Set(ids.map((id) => paperOf(id, false))).size).toBeGreaterThan(1);
  });
});

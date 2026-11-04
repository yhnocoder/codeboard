// Ink Wash's card paper (state/ink.ts): one image per card size and edge pattern, shared by cards of the same size, the same
// image for the same card every time, and its own for light and dark
import { describe, expect, it } from "vitest";
import { paperOf } from "../../src/state/ink";

describe("paperOf", () => {
  it("is the same image for the same card and size, and shares one between sizes a few px apart", () => {
    const a = paperOf(560, 192, "c1", false);
    expect(a.startsWith('url("data:image/svg+xml,')).toBe(true);
    expect(paperOf(560, 192, "c1", false)).toBe(a);
    expect(paperOf(561, 193, "c1", false)).toBe(a);
    expect(paperOf(600, 192, "c1", false)).not.toBe(a);
  });
  it("draws the paper outside the card: the image is the card plus 14 px on each side", () => {
    expect(paperOf(560, 192, "c1", false)).toContain("width='588' height='220'");
  });
  it("stretches onto the card: a rounded size with another aspect ratio is not shrunk to fit and centred", () => {
    expect(paperOf(900, 102, "c1", false)).toContain("preserveAspectRatio='none'");
  });
  it("has its own image in dark, and a few edge patterns between cards", () => {
    expect(paperOf(560, 192, "c1", true)).not.toBe(paperOf(560, 192, "c1", false));
    const ids = Array.from({ length: 12 }, (_, i) => `card${i}`);
    expect(new Set(ids.map((id) => paperOf(400, 300, id, false))).size).toBeGreaterThan(1);
  });
});

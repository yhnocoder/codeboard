import { describe, expect, it } from "vitest";
import { CODE_GEO, type Link } from "@codeboard/core";
import { type RouteModel, Router, setLook } from "../routes";

/** Two code cards side by side, one arrow from line 5 of the left one to the right one's head */
function model(): RouteModel {
  const link: Link = { id: "l", from: { card: "a", seg: "s", line: 5 }, to: { card: "b" } };
  return {
    links: [link],
    cards: [
      { id: "a", kind: "code", segments: [{ id: "s", start: 1, end: 20, lines: 20 }] },
      { id: "b", kind: "code", segments: [{ id: "t", start: 1, end: 3, lines: 3 }] },
    ],
  };
}
const rects = { a: { x: 0, y: 0, w: 200, h: 500 }, b: { x: 600, y: 0, w: 200, h: 120 } };

describe("the arrows' ends", () => {
  it("sit on a line at its default row until the card is drawn", () => {
    const [g] = new Router().route(model(), rects);
    // line 5 of a segment starting at 1: head + top + 4 rows + half a row
    expect(g.pts[1]).toBeCloseTo(CODE_GEO.head + CODE_GEO.top + 4 * CODE_GEO.row + CODE_GEO.row / 2);
  });
  it("sit on the line where the shell drew it (hidden lines, notes and separators move rows)", () => {
    const [g] = new Router().route(model(), { ...rects, a: { ...rects.a, rows: { "s:5": 231.5 } } });
    expect(g.pts[1]).toBe(231.5);
  });
  it("fall back to the row's default place for a drawn row past the card's bottom (stale rows, a card cut short)", () => {
    const [g] = new Router().route(model(), { ...rects, a: { ...rects.a, rows: { "s:5": 900 } } });
    expect(g.pts[1]).toBeCloseTo(CODE_GEO.head + CODE_GEO.top + 4 * CODE_GEO.row + CODE_GEO.row / 2);
  });
  it("end at the card's head on a line the drawn card does not show (hidden in a gap), as the board does", () => {
    const [g] = new Router().route(model(), { ...rects, a: { ...rects.a, rows: {} } });
    expect(g.pts[1]).toBe(CODE_GEO.head / 2);
  });
  it("draw Ink Wash's dry streaks and Warm Ink's taper by the line's weight", () => {
    setLook("ink-wash");
    const [ink] = new Router().route(model(), rects);
    expect(ink.fb).toBeTruthy();
    setLook("warm-ink");
    const [warm] = new Router().route(model(), rects);
    expect(warm.fb).toBeUndefined();
    expect(warm.taper).toBeTruthy();
  });
});

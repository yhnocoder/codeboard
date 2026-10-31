import { describe, expect, it } from "vitest";
import { boxClear, dragT, placeT } from "../src/canvas/labelpos";
import { bezAt } from "../src/canvas/geom";

// 一条从 (0, 0) 到 (400, 0) 的直线（控制点在线上），两端各一张卡
const line = [0, 0, 100, 0, 300, 0, 400, 0];
const cards = [
  { x: -200, y: -50, w: 200, h: 100 },
  { x: 400, y: -50, w: 200, h: 100 },
];
const box = { w: 80, h: 20 };

describe("label position along the arrow", () => {
  it("bezAt walks the curve", () => {
    expect(bezAt(line, 0)).toEqual({ x: 0, y: 0 });
    expect(bezAt(line, 1)).toEqual({ x: 400, y: 0 });
    expect(bezAt(line, 0.5).x).toBeCloseTo(200);
  });
  it("boxClear keeps a gap to the cards", () => {
    expect(boxClear(200, 0, box, cards)).toBe(true);
    expect(boxClear(42, 0, box, cards)).toBe(false);
    expect(boxClear(50, 0, box, cards)).toBe(true);
  });
  it("dragT follows the pointer but stops before the card ends", () => {
    const mid = dragT(line, 250, 30, box, cards);
    expect(bezAt(line, mid).x).toBeGreaterThan(240);
    expect(bezAt(line, mid).x).toBeLessThan(260);
    const end = dragT(line, 600, 0, box, cards);
    const q = bezAt(line, end);
    expect(boxClear(q.x, q.y, box, cards)).toBe(true);
    expect(q.x).toBeGreaterThan(330);
  });
  it("dragT goes to the middle when the box fits nowhere", () => {
    expect(dragT(line, 0, 0, { w: 500, h: 20 }, cards)).toBe(0.5);
  });
  it("placeT keeps a stored ratio when the box is clear, and pulls it in when a card moved close", () => {
    expect(placeT(line, 0.3, box, cards)).toBe(0.3);
    const near = [cards[0], { x: 300, y: -50, w: 200, h: 100 }];
    const t = placeT(line, 0.9, box, near);
    expect(t).toBeLessThan(0.9);
    expect(t).toBeGreaterThanOrEqual(0.5);
    const q = bezAt(line, t);
    expect(boxClear(q.x, q.y, box, near)).toBe(true);
  });
});

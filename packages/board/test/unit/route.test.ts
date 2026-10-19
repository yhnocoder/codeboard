// 箭头走线规则（W03）：摆法、缓冲、端点、错位时的斜角
import { describe, expect, it } from "vitest";
import { chooseMode, sidesOf, anchorOn, tiltAngle, connect, slide, type Box } from "../../src/canvas/route";

const S: Box = { x: 0, y: 0, w: 300, h: 200 };
const at = (x: number, y: number, w = 300, h = 160): Box => ({ x, y, w, h });

describe("chooseMode (W03 A 1–4)", () => {
  it("separated → facing sides, for line and card ends", () => {
    expect(sidesOf(chooseMode(S, at(500, 40), false, undefined, 16))).toEqual(["right", "left"]);
    expect(sidesOf(chooseMode(S, at(-500, 40), true, undefined, 16))).toEqual(["left", "right"]);
  });
  it("stacked with a line end → same side by the target's lean (C shape)", () => {
    expect(sidesOf(chooseMode(S, at(120, 400), false, undefined, 16))).toEqual(["right", "right"]);
    expect(sidesOf(chooseMode(S, at(-120, 400), false, undefined, 16))).toEqual(["left", "left"]);
  });
  it("stacked card ↔ card → bottom / top", () => {
    expect(sidesOf(chooseMode(S, at(120, 400), true, undefined, 16))).toEqual(["bottom", "top"]);
    expect(sidesOf(chooseMode(S, at(120, -400), true, undefined, 16))).toEqual(["top", "bottom"]);
  });
});

describe("hysteresis (W03 B 5)", () => {
  it("needs the buffer to become separated, and an overlap to stop being separated", () => {
    expect(chooseMode(S, at(308, 40), false, undefined, 16)).toBe("stackR"); // gap 8 from scratch: not yet
    expect(chooseMode(S, at(308, 40), false, "sepR", 16)).toBe("sepR"); // gap 8 while separated: stays
    expect(chooseMode(S, at(290, 40), false, "sepR", 16)).toBe("stackR"); // overlap: switches
    expect(chooseMode(S, at(308, 40), false, "stackR", 16)).toBe("stackR"); // back into the buffer: stays
    expect(chooseMode(S, at(320, 40), false, "stackR", 16)).toBe("sepR");
  });
  it("the C-shape lean also waits for the buffer", () => {
    expect(chooseMode(S, at(-10, 400), false, "stackR", 16)).toBe("stackR");
    expect(chooseMode(S, at(-30, 400), false, "stackR", 16)).toBe("stackL");
  });
});

describe("anchors", () => {
  it("card ends on left / right sit on the heading row, top / bottom in the middle of the edge", () => {
    expect(anchorOn(S, "left", 17)).toMatchObject({ x: 0, y: 17, nx: -1 });
    expect(anchorOn(S, "right", 17)).toMatchObject({ x: 300, y: 17, nx: 1 });
    expect(anchorOn(S, "bottom", 17)).toMatchObject({ x: 150, y: 200, ny: 1 });
  });
});

describe("tilt (W03 D 11)", () => {
  it("at most 45°, toward the other end, only when the space in front is short", () => {
    const p = { x: 0, y: 0, nx: 1, ny: 0 };
    expect(tiltAngle(p, { x: 18, y: 200 })).toBeCloseTo(Math.PI / 4);
    expect(tiltAngle(p, { x: 18, y: -200 })).toBeCloseTo(-Math.PI / 4);
    expect(tiltAngle(p, { x: 600, y: 200 })).toBe(0);
    expect(tiltAngle(p, { x: -50, y: 200 })).toBe(0);
  });
  it("the arrowhead follows the tilted end", () => {
    const sh = connect({ x: 150, y: 70, nx: -1, ny: 0 }, { x: 102, y: 104, nx: 1, ny: 0 }, "curve");
    const ang = Math.atan2(sh.inDir.y, -sh.inDir.x);
    expect(ang).toBeGreaterThan(0.2);
    expect(ang).toBeLessThanOrEqual(Math.PI / 4 + 1e-6);
  });
});

describe("slide (W03 B 6)", () => {
  it("moves the end and turns its direction", () => {
    const a = { x: 0, y: 10, nx: -1, ny: 0 }, b = { x: 300, y: 10, nx: 1, ny: 0 };
    const m = slide(a, b, 0.5);
    expect(m.x).toBe(150);
    expect(Math.hypot(m.nx, m.ny)).toBeCloseTo(1);
    expect(slide(a, b, 1)).toBe(b);
  });
});

describe("elbow clearance (City roads)", () => {
  // Stacked cards, both ends on the right edge: the vertical trunk runs outside the wider card
  const p = { x: 300, y: 40, nx: 1, ny: 0 }, q = { x: 420, y: 500, nx: 1, ny: 0 };
  const trunkX = (d: string) => Math.max(...d.slice(1).split(" L").map((v) => +v.split(" ")[0]));
  it("default keeps the trunk 24 px off the outer card edge", () => {
    expect(trunkX(connect(p, q, "elbow").d)).toBe(444);
  });
  it("a larger clear (City: road width + margin) moves the trunk out, other looks unchanged", () => {
    expect(trunkX(connect(p, q, "elbow", undefined, {}, 40).d)).toBe(460);
  });
});

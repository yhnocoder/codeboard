import { describe, expect, it } from "vitest";
import { carAt, carPaths, laneOf, zebraBack, driveFrames } from "../../src/canvas/city";

describe("City cars", () => {
  it("parked car: nose at the road end, turned along the end tangent", () => {
    expect(carAt(100, 50, 1, 0)).toEqual({ tx: 99, ty: 50, deg: 0, s: 1 });
    expect(carAt(100, 50, 0, 1, 1.25)).toEqual({ tx: 100, ty: 49, deg: 90, s: 1.25 });
  });
  it("parked car is drawn straight into world coordinates (no transform per car)", () => {
    expect(carPaths({ tx: 99, ty: 50, deg: 0, s: 1 }).body.startsWith("M79.5 45L95.5 45A3.5 3.5 0 0 1 99 48.5")).toBe(
      true,
    );
    // Turned 90°: the body runs up from the nose, its corners keep their radius
    expect(
      carPaths({ tx: 100, ty: 49, deg: 90, s: 1 }).body.startsWith("M105 29.5L105 45.5A3.5 3.5 0 0 1 101.5 49"),
    ).toBe(true);
    expect(carPaths({ tx: 0, ty: 0, deg: 0, s: 2 }).roof.startsWith("M-27.8 -7.6")).toBe(true);
  });
  it("zebra crossing: baked into the lamp path in front of the car, the car parks behind it", () => {
    const c = carPaths({ tx: 99, ty: 50, deg: 0, s: 1 }, "main");
    expect(zebraBack("main")).toBe(9.5);
    expect(c.body.startsWith("M70 45L86 45")).toBe(true);
    expect(c.lamp).toContain("M91.5 44.4L98.5 44.4L98.5 46.1L91.5 46.1Z");
    expect(c.lamp.match(/Z/g)!.length).toBe(2 + 4);
    expect(carPaths({ tx: 99, ty: 50, deg: 0, s: 1 }, "street").lamp.match(/Z/g)!.length).toBe(2 + 3);
    // Turns with the road
    expect(carPaths({ tx: 100, ty: 49, deg: 90, s: 1 }, "main").lamp).toContain("M105.6 41.5L105.6 48.5");
  });
  it("road markings: double centre line offset on both sides of an elbow road, trimmed where the car parks", () => {
    expect(laneOf("M0 0 L100 0 L100 50", 1.1, 0, 10)).toBe("M0 1.1L98.9 1.1L98.9 40M0 -1.1L101.1 -1.1L101.1 40");
    expect(laneOf("M0 0 L100 0 L100 50", 0, 5)).toBe("M5 0L100 0L100 50");
    expect(laneOf("M0 0 L10 0", 0, 6, 6)).toBe("");
  });
  it("driving car: transform keyframes along an elbow road, turning at each corner the short way", () => {
    const f = driveFrames("M0 0 L100 0 L100 -50 L200 -50")!;
    expect(f.len).toBe(250);
    expect(f.frames.map((k) => k.offset)).toEqual([0, 93 / 250, 107 / 250, 143 / 250, 157 / 250, 1]);
    expect(f.frames[0].transform).toBe("translate(0px, 0px) rotate(0deg) translate(-11px, -1.5px)");
    expect(f.frames[2].transform).toContain("rotate(-90deg)");
    expect(f.frames[5].transform).toBe("translate(200px, -50px) rotate(0deg) translate(-11px, -1.5px)");
    expect(driveFrames("M5 5")).toBeNull();
  });
});

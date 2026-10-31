import { describe, expect, it } from "vitest";
import { chooseMode, sidesOf, anchorOn, tiltAngle, connect, slide, type Box } from "../src/canvas/route";

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
    const a = { x: 0, y: 10, nx: -1, ny: 0 },
      b = { x: 300, y: 10, nx: 1, ny: 0 };
    const m = slide(a, b, 0.5);
    expect(m.x).toBe(150);
    expect(Math.hypot(m.nx, m.ny)).toBeCloseTo(1);
    expect(slide(a, b, 1)).toBe(b);
  });
});

describe("elbow clearance (City roads)", () => {
  // Stacked cards, both ends on the right edge: the vertical trunk runs outside the wider card
  const p = { x: 300, y: 40, nx: 1, ny: 0 },
    q = { x: 420, y: 500, nx: 1, ny: 0 };
  const trunkX = (d: string) =>
    Math.max(
      ...d
        .slice(1)
        .split(" L")
        .map((v) => +v.split(" ")[0]),
    );
  it("default keeps the trunk 24 px off the outer card edge", () => {
    expect(trunkX(connect(p, q, "elbow").d)).toBe(444);
  });
  it("a larger clear (City: road width + margin) moves the trunk out, other looks unchanged", () => {
    expect(trunkX(connect(p, q, "elbow", undefined, {}, 40).d)).toBe(460);
  });
});

describe("close cards: the arrow never runs through either card (#65)", () => {
  // 把 path 的 d（M / L / Q / C）取样成点
  function sample(d: string): { x: number; y: number }[] {
    const tok = d.match(/[MLQC]|-?\d+(?:\.\d+)?/g)!;
    const out: { x: number; y: number }[] = [];
    let i = 0,
      cur = { x: 0, y: 0 },
      cmd = "M";
    const num = () => +tok[i++];
    while (i < tok.length) {
      if (/[MLQC]/.test(tok[i])) cmd = tok[i++];
      if (cmd === "M") {
        cur = { x: num(), y: num() };
        out.push(cur);
        continue;
      }
      const k = cmd === "L" ? 1 : cmd === "Q" ? 2 : 3;
      const ps = [cur];
      for (let j = 0; j < k; j++) ps.push({ x: num(), y: num() });
      for (let s = 1; s <= 24; s++) {
        const t = s / 24;
        let q = ps.slice();
        while (q.length > 1)
          q = q.slice(1).map((v, n) => ({ x: q[n].x + (v.x - q[n].x) * t, y: q[n].y + (v.y - q[n].y) * t }));
        out.push(q[0]);
      }
      cur = ps[k];
    }
    return out;
  }
  const inside = (pt: { x: number; y: number }, b: Box, e: number) =>
    pt.x > b.x + e && pt.x < b.x + b.w - e && pt.y > b.y + e && pt.y < b.y + b.h - e;
  const A: Box = { x: 0, y: 0, w: 300, h: 200 };
  const sides = ["left", "right", "top", "bottom"] as const;
  type S = (typeof sides)[number];
  const anchor = (b: Box, s: S) => anchorOn(b, s, b.y + 17);

  /** 指定的边正对着、贴着另一张卡（出头第一步就进卡）：怎么走都穿卡，不算 */
  function blocked(b: Box, s: [S, S]) {
    const p = anchor(A, s[0]),
      q = anchor(b, s[1]);
    return inside({ x: p.x + p.nx, y: p.y + p.ny }, b, 0) || inside({ x: q.x + q.nx, y: q.y + q.ny }, A, 0);
  }
  function bad(b: Box, s: [S, S], route: "curve" | "elbow"): string | null {
    const p = anchor(A, s[0]),
      q = anchor(b, s[1]);
    const sh = connect(p, q, route, undefined, { a: A, b });
    const e = route === "curve" ? 4 : 0.5;
    const pts = sample(sh.d);
    const hit = pts.find((v) => inside(v, A, e) || inside(v, b, e));
    if (hit) return `enters a card at ${hit.x},${hit.y}: ${sh.d}`;
    const last = pts[pts.length - 1];
    if (Math.hypot(last.x - q.x, last.y - q.y) > 0.2) return `ends at ${last.x},${last.y}, not on the target's edge`;
    if (sh.inDir.x * -q.nx + sh.inDir.y * -q.ny < 0.6)
      return `head does not point into the target: ${JSON.stringify(sh.inDir)}`;
    return null;
  }

  // b 绕着 a 放一圈：左右缝 / 上下缝从负（叠着）到比出头还小，再到正常距离
  const gaps = [-120, -40, -8, 0, 4, 10, 16, 24, 31, 40, 80];
  const placements: Box[] = [];
  for (const g of gaps)
    for (const dy of [-260, -150, -60, -17, 0, 30, 90, 150, 260]) {
      placements.push({ x: 300 + g, y: dy, w: 260, h: 160 }, { x: -260 - g, y: dy, w: 260, h: 160 });
    }
  for (const g of gaps)
    for (const dx of [-300, -150, -40, 0, 60, 200, 330]) {
      placements.push({ x: dx, y: 200 + g, w: 260, h: 160 }, { x: dx, y: -160 - g, w: 260, h: 160 });
    }
  const apart = (b: Box) => b.x >= A.x + A.w || b.x + b.w <= A.x || b.y >= A.y + A.h || b.y + b.h <= A.y;

  for (const route of ["elbow", "curve"] as const) {
    it(`${route}: automatic sides, every placement`, () => {
      const fails: string[] = [];
      for (const b of placements) {
        if (!apart(b)) continue;
        const why = bad(b, sidesOf(chooseMode(A, b, true, undefined, 16)), route);
        if (why) fails.push(`${JSON.stringify(b)} ${why}`);
      }
      expect(fails).toEqual([]);
    });
    it(`${route}: pinned sides (any port pair), every placement`, () => {
      const fails: string[] = [];
      for (const b of placements) {
        if (!apart(b)) continue;
        for (const s0 of sides)
          for (const s1 of sides) {
            if (blocked(b, [s0, s1])) continue;
            const why = bad(b, [s0, s1], route);
            if (why) fails.push(`${JSON.stringify(b)} ${s0}→${s1} ${why}`);
          }
      }
      expect(fails.length, fails.slice(0, 5).join("\n")).toBe(0);
    });
  }

  it("the reported case: right port → left side of a card 20 px away (Drafting) stays in the gap", () => {
    const b: Box = { x: 320, y: 30, w: 260, h: 160 };
    const sh = connect(anchor(A, "right"), anchor(b, "left"), "elbow", undefined, { a: A, b });
    const xs = sample(sh.d).map((v) => v.x);
    expect(Math.max(...xs)).toBeLessThanOrEqual(320);
    expect(sh.inDir).toEqual({ x: 1, y: 0 });
  });

  it("side by side with a gap below the side buffer → still facing sides, not bottom → top", () => {
    expect(sidesOf(chooseMode(A, { x: 308, y: 20, w: 260, h: 160 }, true, undefined, 16))).toEqual(["right", "left"]);
    expect(sidesOf(chooseMode(A, { x: -268, y: 20, w: 260, h: 160 }, true, undefined, 16))).toEqual(["left", "right"]);
    // 上下摆着的：拖到并排要重叠过缓冲才换
    expect(chooseMode(A, { x: 308, y: 190, w: 260, h: 160 }, true, "down", 16)).toBe("down");
    expect(chooseMode(A, { x: 308, y: 150, w: 260, h: 160 }, true, "down", 16)).toBe("sepR");
  });
});

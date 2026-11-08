import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { CSS_TILE, PAD, TILE, isPlain, levels, rgb, shots, tileWorld } from "../src/tiles";
import { storedZip } from "../src/zip";

describe("tile geometry", () => {
  it("pads the board's extent onto whole px", () => {
    expect(tileWorld({ x: 10.5, y: -3.2, w: 100, h: 50 })).toEqual({
      x: 10 - PAD,
      y: -4 - PAD,
      w: 101 + PAD * 2,
      h: 51 + PAD * 2,
    });
  });

  it("halves the zoom until the board fits in 2 × 2 tiles", () => {
    const L = levels({ x: 0, y: 0, w: 2000, h: 500 });
    expect(L.map((l) => l.z)).toEqual([1, 0.5, 0.25]);
    expect(L[0]).toEqual({ z: 1, cols: 8, rows: 2 });
    expect(L[2]).toEqual({ z: 0.25, cols: 2, rows: 1 });
    expect(levels({ x: 0, y: 0, w: 300, h: 300 })).toEqual([{ z: 1, cols: 2, rows: 2 }]);
  });

  it("covers a level with shots of 4 × 4 tiles, the last row and column clipped to the board", () => {
    const world = { x: -100, y: 50, w: 1300, h: 300 };
    const [L] = levels(world);
    const s = shots(world, L);
    expect(s.map((x) => x.cam)).toEqual([
      { x: 100, y: -50, z: 1 },
      { x: 100 - 4 * CSS_TILE, y: -50, z: 1 },
    ]);
    expect(s.flatMap((x) => x.tiles).length).toBe(L.cols * L.rows);
    const last = s[1].tiles.at(-1)!;
    expect(last).toEqual({ col: 5, row: 1, clip: { x: TILE, y: TILE, w: 2600 - 5 * TILE, h: 600 - TILE } });
  });
});

describe("plain tiles", () => {
  const paper = rgb("#eeece6");
  const img = (w: number, h: number, at?: [number, number]) => {
    const raw = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) raw.set([paper[0] + 2, paper[1] - 3, paper[2], 255], i * 4);
    if (at) raw.set([20, 20, 20, 255], (at[1] * w + at[0]) * 4);
    return raw;
  };

  it("leaves out only tiles of nothing but the paper", () => {
    expect(isPlain(img(8, 8), 8, 4, { x: 0, y: 0, w: 8, h: 8 }, paper)).toBe(true);
    expect(isPlain(img(8, 8, [5, 6]), 8, 4, { x: 0, y: 0, w: 8, h: 8 }, paper)).toBe(false);
    expect(isPlain(img(8, 8, [5, 6]), 8, 4, { x: 0, y: 0, w: 4, h: 8 }, paper)).toBe(true);
    expect(isPlain(img(8, 8), 8, 4, { x: 0, y: 0, w: 8, h: 8 }, rgb("#202020"))).toBe(false);
  });
});

describe("zip", () => {
  it("stores the entries uncompressed, the manifest first", () => {
    const zip = storedZip(
      new Map([
        ["1/0_0.webp", new Uint8Array([1, 2, 3])],
        ["manifest.json", new TextEncoder().encode("{}")],
        ["0/0_0.webp", new Uint8Array([4, 5])],
      ]),
    );
    expect(Object.keys(unzipSync(zip))).toEqual(["manifest.json", "0/0_0.webp", "1/0_0.webp"]);
    // each local file header (PK\3\4) names compression method 0, stored
    const v = new DataView(zip.buffer, zip.byteOffset);
    let n = 0;
    for (let i = 0; i + 30 < zip.length; i++)
      if (v.getUint32(i, true) === 0x04034b50) {
        expect(v.getUint16(i + 8, true)).toBe(0);
        n++;
      }
    expect(n).toBe(3);
    expect(storedZip(new Map([["a", new Uint8Array([1])]]))).toEqual(storedZip(new Map([["a", new Uint8Array([1])]])));
  });
});

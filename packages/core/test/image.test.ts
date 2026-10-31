import { describe, expect, it } from "vitest";
import { imageScale, pngDpi, sniffImage } from "../src";

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]) => [
  ...u32(data.length),
  ...[...type].map((c) => c.charCodeAt(0)),
  ...data,
  0,
  0,
  0,
  0,
];
/** 一张 w×h 的 PNG 的块结构（不解码，CRC 不算）：IHDR、可选的 iCCP 和 pHYs、IDAT、IEND */
function png(w: number, h: number, o: { ppm?: number; unit?: number; iccp?: number; afterIdat?: boolean } = {}) {
  const phys = o.ppm === undefined ? [] : chunk("pHYs", [...u32(o.ppm), ...u32(o.ppm), o.unit ?? 1]);
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", [...u32(w), ...u32(h), 8, 6, 0, 0, 0]),
    ...(o.iccp ? chunk("iCCP", new Array(o.iccp).fill(1)) : []),
    ...(o.afterIdat ? [] : phys),
    ...chunk("IDAT", [1, 2, 3]),
    ...(o.afterIdat ? phys : []),
    ...chunk("IEND", []),
  ]);
}

describe("pngDpi / imageScale", () => {
  it("reads a Retina screenshot's 144 dpi (5669 pixels per metre) as 2×, a normal screen's 72 dpi as 1×", () => {
    const retina = png(2000, 1000, { ppm: 5669, iccp: 3000 });
    expect(sniffImage(retina)).toMatchObject({ mime: "image/png", w: 2000 });
    expect(pngDpi(retina)).toBeCloseTo(144, 0);
    expect(imageScale(retina)).toBe(2);
    expect(imageScale(png(800, 600, { ppm: 2835 }))).toBe(1);
  });
  it("uses the fallback without the chunk, with an aspect-ratio-only pHYs, after IDAT, and for other formats", () => {
    expect(pngDpi(png(10, 10))).toBeNull();
    expect(imageScale(png(10, 10), 2)).toBe(2);
    expect(imageScale(png(10, 10), 1)).toBe(1);
    expect(imageScale(png(10, 10, { ppm: 5669, unit: 0 }), 1.5)).toBe(1.5);
    expect(imageScale(png(10, 10, { ppm: 5669, afterIdat: true }), 1)).toBe(1);
    expect(imageScale(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), 2)).toBe(2);
    expect(imageScale(png(10, 10, { ppm: 5669 }).subarray(0, 40), 3)).toBe(3); // 截断在 pHYs 之前
  });
  it("keeps odd densities and clamps nonsense ones", () => {
    expect(imageScale(png(10, 10, { ppm: 3780 }))).toBeCloseTo(96 / 72, 2);
    expect(imageScale(png(10, 10, { ppm: 39 }))).toBe(0.25);
    expect(imageScale(png(10, 10, { ppm: 100000 }))).toBe(4);
  });
});

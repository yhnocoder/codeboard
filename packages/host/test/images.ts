// Tiny real images for the sticker tests, made in code (no binary fixtures): PNG, APNG, GIF (one or more frames),
// and an animated WebP put together from static WebP frames (the board scenario gets those from Chromium's canvas).
import { deflateSync } from "node:zlib";

export type Rgba = [number, number, number, number];
/** A frame: colour of pixel (x, y) */
export type Paint = (x: number, y: number) => Rgba;

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const chunk = (type: string, data: Buffer) => {
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  return Buffer.concat([u32(data.length), td, u32(crc32(td))]);
};
const pixels = (w: number, h: number, paint: Paint) => {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(paint(x, y), y * (w * 4 + 1) + 1 + x * 4);
  return deflateSync(raw);
};
const ihdr = (w: number, h: number) => chunk("IHDR", Buffer.concat([u32(w), u32(h), Buffer.from([8, 6, 0, 0, 0])]));
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A static RGBA PNG; dpi: a pHYs chunk with that resolution (144 = a Mac screenshot on a Retina screen) */
export const png = (w: number, h: number, paint: Paint, dpi?: number) =>
  Buffer.concat([
    SIG,
    ihdr(w, h),
    ...(dpi
      ? [chunk("pHYs", Buffer.concat([u32(Math.round(dpi / 0.0254)), u32(Math.round(dpi / 0.0254)), Buffer.from([1])]))]
      : []),
    chunk("IDAT", pixels(w, h, paint)),
    chunk("IEND", Buffer.alloc(0)),
  ]);

/** An animated PNG (APNG), looping, delay ms per frame */
export function apng(w: number, h: number, frames: Paint[], delay = 200) {
  let seq = 0;
  const fctl = () =>
    chunk(
      "fcTL",
      Buffer.concat([u32(seq++), u32(w), u32(h), u32(0), u32(0), u16(delay), u16(1000), Buffer.from([0, 0])]),
    );
  const parts = [SIG, ihdr(w, h), chunk("acTL", Buffer.concat([u32(frames.length), u32(0)]))];
  frames.forEach((f, i) => {
    parts.push(fctl());
    parts.push(i === 0 ? chunk("IDAT", pixels(w, h, f)) : chunk("fdAT", Buffer.concat([u32(seq++), pixels(w, h, f)])));
  });
  return Buffer.concat([...parts, chunk("IEND", Buffer.alloc(0))]);
}

/**
 * A GIF with a 256-entry palette; each frame gives a palette index per pixel. Looping, delay ms per frame.
 * `transparent`: the palette index drawn as transparent.
 * LZW without compression: 9-bit codes, a Clear code every 250 pixels so the code width never grows.
 */
export function gif(
  w: number,
  h: number,
  palette: [number, number, number][],
  frames: ((x: number, y: number) => number)[],
  delay = 200,
  transparent?: number,
) {
  const out: number[] = [...Buffer.from("GIF89a", "latin1"), w & 255, w >> 8, h & 255, h >> 8, 0xf7, 0, 0];
  for (let i = 0; i < 256; i++) out.push(...(palette[i] ?? [0, 0, 0]));
  out.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0", "latin1"), 3, 1, 0, 0, 0);
  for (const f of frames) {
    const d = Math.round(delay / 10);
    out.push(0x21, 0xf9, 4, transparent === undefined ? 0 : 0x09, d & 255, d >> 8, transparent ?? 0, 0); // with a transparent index: restore to background between frames
    out.push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 8);
    const codes: number[] = [];
    for (let i = 0; i < w * h; i++) {
      if (i % 250 === 0) codes.push(256);
      codes.push(f(i % w, Math.floor(i / w)));
    }
    codes.push(257);
    const bytes: number[] = [];
    let acc = 0,
      n = 0;
    for (const c of codes) {
      acc |= c << n;
      n += 9;
      while (n >= 8) {
        bytes.push(acc & 255);
        acc >>>= 8;
        n -= 8;
      }
    }
    if (n) bytes.push(acc & 255);
    for (let i = 0; i < bytes.length; i += 255) {
      const s = bytes.slice(i, i + 255);
      out.push(s.length, ...s);
    }
    out.push(0);
  }
  out.push(0x3b);
  return Buffer.from(out);
}

const riffChunk = (type: string, data: Buffer) =>
  Buffer.concat([
    Buffer.from(type, "latin1"),
    Buffer.from(Uint32Array.of(data.length).buffer),
    data,
    data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0),
  ]);
const u24le = (n: number) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);
const riff = (body: Buffer) =>
  Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    Buffer.from(Uint32Array.of(body.length + 4).buffer),
    Buffer.from("WEBP", "latin1"),
    body,
  ]);

/** The image chunks (ALPH / VP8 / VP8L) of a static WebP file */
function webpFrame(file: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let i = 12; i + 8 <= file.length; ) {
    const type = file.toString("latin1", i, i + 4),
      len = file.readUInt32LE(i + 4),
      end = i + 8 + len + (len & 1);
    if (type === "ALPH" || type === "VP8 " || type === "VP8L") parts.push(file.subarray(i, end));
    i = end;
  }
  return Buffer.concat(parts);
}

/** An animated WebP (VP8X with the animation flag, ANIM, one ANMF per frame, each replacing the last: no blending, disposed) from static WebP files of size w × h */
export function animWebp(w: number, h: number, frames: Buffer[], delay = 200) {
  const vp8x = Buffer.concat([Buffer.from([0x02 | 0x10, 0, 0, 0]), u24le(w - 1), u24le(h - 1)]);
  const anim = Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0])]);
  const anmf = frames.map((f) =>
    riffChunk(
      "ANMF",
      Buffer.concat([u24le(0), u24le(0), u24le(w - 1), u24le(h - 1), u24le(delay), Buffer.from([0x03]), webpFrame(f)]),
    ),
  );
  return riff(Buffer.concat([riffChunk("VP8X", vp8x), riffChunk("ANIM", anim), ...anmf]));
}

/** A 1×1 static lossless WebP */
export const WEBP_1PX = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");

/** A face sticker in two frames (eyes open / a wink), for the scenarios and screenshots */
export function faceFrames(size: number, color: Rgba): Paint[] {
  const c = size / 2,
    r = size * 0.46;
  const face =
    (wink: boolean): Paint =>
    (x, y) => {
      const dx = x + 0.5 - c,
        dy = y + 0.5 - c,
        d = Math.hypot(dx, dy);
      if (d > r) return [0, 0, 0, 0];
      const eye = (ex: number) =>
        Math.hypot(x + 0.5 - (c + ex * size * 0.17), y + 0.5 - (c - size * 0.12)) < size * 0.07;
      const winkLine =
        Math.abs(y + 0.5 - (c - size * 0.12)) < size * 0.03 && Math.abs(x + 0.5 - (c + size * 0.17)) < size * 0.09;
      const mouth = Math.abs(Math.hypot(dx, dy - size * 0.02) - size * 0.24) < size * 0.035 && dy > size * 0.08;
      if (eye(-1) || (wink ? winkLine : eye(1)) || mouth) return [60, 40, 30, 255];
      return color;
    };
  return [face(false), face(true)];
}

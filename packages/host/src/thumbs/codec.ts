// A smaller copy of a board image, for the size it is shown at (thumbs/index.ts). Pure JavaScript (pngjs, jpeg-js), so the
// extension needs no native module on any platform; it runs in the thumbnail worker (thumbs/worker.ts), off the host's event loop.
// Only still PNG and JPEG are made smaller: an animated image (APNG, GIF, animated WebP) plays from its own file, SVG is vector,
// and WebP has no pure-JavaScript decoder worth carrying, so those are shown as they are.
// The copy keeps what the browser shows: PNG's colour chunks (an ICC profile, sRGB, gamma) are copied over, a JPEG's ICC profile
// too, and a JPEG turned by its EXIF orientation is turned in the copy (which has no EXIF, so the browser shows it as it is)
import * as jpeg from "jpeg-js";
import { PNG } from "pngjs";

/** RGBA, 8 bits a channel, rows top to bottom */
export type Raster = { width: number; height: number; data: Uint8Array };
export type Thumb = { bytes: Buffer; ext: "png" | "jpg"; width: number; height: number };

/** Images larger than this are left alone: decoding one would take hundreds of MB */
const MAX_PIXELS = 60e6;
const JPEG_QUALITY = 90;
/** A copy is made only when it is at most this much of the original's width: a copy nearly as big saves little */
const WORTH = 0.75;
/** PNG chunks that change how the browser shows the colours */
const COLOR_CHUNKS = new Set(["iCCP", "sRGB", "gAMA", "cHRM", "cICP"]);

type Kind = { mime: "png" | "jpg"; width: number; height: number };

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** A still PNG or a JPEG (with its stored size, before any EXIF turn); anything else null */
export function kindOf(b: Uint8Array): Kind | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length >= 33 && b[0] === 0x89 && ascii(b, 1, 7) === "PNG\r\n\x1a\n" && ascii(b, 12, 4) === "IHDR") {
    for (const c of pngChunks(b)) {
      if (c.type === "acTL") return null; // APNG
      if (c.type === "IDAT") return { mime: "png", width: dv.getUint32(16), height: dv.getUint32(20) };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    for (const s of jpegSegments(b))
      if (s.marker >= 0xc0 && s.marker <= 0xcf && s.marker !== 0xc4 && s.marker !== 0xc8 && s.marker !== 0xcc)
        return s.end - s.start >= 9
          ? { mime: "jpg", height: dv.getUint16(s.start + 5), width: dv.getUint16(s.start + 7) }
          : null;
  }
  return null;
}

/** The chunks of a PNG: start = the chunk's first byte (its length), end = after its CRC */
function* pngChunks(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 8; i + 12 <= b.length; ) {
    const end = i + 12 + dv.getUint32(i);
    if (end > b.length) return;
    yield { type: ascii(b, i + 4, 4), start: i, end };
    i = end;
  }
}

/** A JPEG's marker segments up to the start of the scan: start = the marker's 0xFF, end = after its payload */
function* jpegSegments(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 2; i + 4 <= b.length; ) {
    if (b[i] !== 0xff) return;
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m === 0xd9 || m === 0xda) return;
    const end = i + 2 + dv.getUint16(i + 2);
    if (end > b.length) return;
    yield { marker: m, start: i, end };
    i = end;
  }
}

/** The EXIF orientation of a JPEG (1–8; 1 when it has none) */
export function jpegOrientation(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (const s of jpegSegments(b)) {
    if (s.marker !== 0xe1 || s.end - s.start < 18 || ascii(b, s.start + 4, 6) !== "Exif\0\0") continue;
    const at = s.start + 10;
    const le = dv.getUint16(at) === 0x4949;
    const ifd = at + dv.getUint32(at + 4, le);
    if (ifd + 2 > s.end) return 1;
    for (let k = 0, n = dv.getUint16(ifd, le); k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (e + 12 > s.end) return 1;
      if (dv.getUint16(e, le) === 0x0112) {
        const o = dv.getUint16(e + 8, le);
        return o >= 1 && o <= 8 ? o : 1;
      }
    }
    return 1;
  }
  return 1;
}

/** The pixels turned the way EXIF orientation o says the image is shown (2–8; 1 is as stored) */
export function orient(r: Raster, o: number): Raster {
  if (o <= 1 || o > 8) return r;
  const { width: W, height: H, data } = r;
  const turned = o >= 5;
  const w = turned ? H : W,
    h = turned ? W : H;
  // where the shown pixel (x, y) is stored
  const ways: ((x: number, y: number) => [number, number])[] = [
    (x, y) => [x, y],
    (x, y) => [W - 1 - x, y],
    (x, y) => [W - 1 - x, H - 1 - y],
    (x, y) => [x, H - 1 - y],
    (x, y) => [y, x],
    (x, y) => [y, H - 1 - x],
    (x, y) => [W - 1 - y, H - 1 - x],
    (x, y) => [W - 1 - y, x],
  ];
  const from = ways[o - 1];
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [sx, sy] = from(x, y);
      const s = (sy * W + sx) * 4,
        d = (y * w + x) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  return { width: w, height: h, data: out };
}

/** For each output index along one axis: the first source index it covers and how much of each (the weights sum to 1) */
function spans(from: number, to: number) {
  const scale = from / to;
  const first = new Int32Array(to),
    weights: Float32Array[] = [];
  for (let i = 0; i < to; i++) {
    const a = i * scale,
      b = Math.min(from, (i + 1) * scale);
    const s = Math.floor(a),
      e = Math.ceil(b);
    const w = new Float32Array(e - s);
    for (let k = s; k < e; k++) w[k - s] = (Math.min(b, k + 1) - Math.max(a, k)) / scale;
    first[i] = s;
    weights.push(w);
  }
  return { first, weights };
}

/**
 * Downscale by area averaging (each output pixel is the mean of the source pixels it covers, partly covered ones by how much),
 * on premultiplied alpha so transparent pixels' colours do not bleed into the edges. Rows first, then columns.
 * Only for making smaller: width and height at most the source's
 */
export function shrink(src: Raster, width: number, height: number): Raster {
  const { width: W, height: H, data } = src;
  const xs = spans(W, width),
    ys = spans(H, height);
  // premultiplied rows, each shrunk to width
  const mid = new Float32Array(width * H * 4);
  for (let y = 0; y < H; y++) {
    const row = y * W * 4,
      o = y * width * 4;
    for (let x = 0; x < width; x++) {
      const w = xs.weights[x];
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let k = 0, s = row + xs.first[x] * 4; k < w.length; k++, s += 4) {
        const f = w[k] * data[s + 3];
        r += data[s] * f;
        g += data[s + 1] * f;
        b += data[s + 2] * f;
        a += f;
      }
      const d = o + x * 4;
      mid[d] = r;
      mid[d + 1] = g;
      mid[d + 2] = b;
      mid[d + 3] = a;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const w = ys.weights[y],
      f0 = ys.first[y];
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let k = 0, s = (f0 * width + x) * 4; k < w.length; k++, s += width * 4) {
        r += mid[s] * w[k];
        g += mid[s + 1] * w[k];
        b += mid[s + 2] * w[k];
        a += mid[s + 3] * w[k];
      }
      const d = (y * width + x) * 4;
      if (a > 0) {
        out[d] = Math.min(255, Math.round(r / a));
        out[d + 1] = Math.min(255, Math.round(g / a));
        out[d + 2] = Math.min(255, Math.round(b / a));
      }
      out[d + 3] = Math.min(255, Math.round(a));
    }
  }
  return { width, height, data: out };
}

const opaque = (r: Raster) => {
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] !== 255) return false;
  return true;
};

/** r as a PNG (RGB when it has no transparency), with the source's colour chunks put back after IHDR */
function encodePng(r: Raster, source: Uint8Array): Buffer {
  const png = PNG.sync.write(
    { width: r.width, height: r.height, data: Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength) } as PNG,
    {
      colorType: opaque(r) ? 2 : 6,
    },
  );
  const color = [...pngChunks(source)]
    .filter((c) => COLOR_CHUNKS.has(c.type))
    .map((c) => source.subarray(c.start, c.end));
  return color.length ? Buffer.concat([png.subarray(0, 33), ...color, png.subarray(33)]) : png;
}

/** r as a JPEG, with the source's ICC profile (its APP2 segments) put back after the JFIF header */
function encodeJpeg(r: Raster, source: Uint8Array): Buffer {
  const out = jpeg.encode({ width: r.width, height: r.height, data: r.data }, JPEG_QUALITY).data;
  const icc = [...jpegSegments(source)]
    .filter((s) => s.marker === 0xe2 && ascii(source, s.start + 4, 12) === "ICC_PROFILE\0")
    .map((s) => source.subarray(s.start, s.end));
  if (!icc.length) return out;
  // jpeg-js writes SOI then the JFIF APP0
  const at = out[2] === 0xff && out[3] === 0xe0 ? 4 + ((out[4] << 8) | out[5]) : 2;
  return Buffer.concat([out.subarray(0, at), ...icc, out.subarray(at)]);
}

/** Whether a copy `width` wide of an image `shown` wide saves enough to be made */
export const worthCopy = (shown: number, width: number) => width <= shown * WORTH;
/** Whether copies of an image of this kind are made at all (a huge one is not decoded) */
export const copyable = (k: { width: number; height: number }) => k.width * k.height <= MAX_PIXELS;

/**
 * A copy of the image `width` pixels wide (the height in proportion), or null when there is no point: not a still PNG or JPEG,
 * too large to decode, or not much wider than width (WORTH). Throws when the file does not decode
 */
export function makeThumb(source: Uint8Array, width: number): Thumb | null {
  const k = kindOf(source);
  if (!k || !copyable(k)) return null;
  const o = k.mime === "jpg" ? jpegOrientation(source) : 1;
  const shownW = o >= 5 ? k.height : k.width,
    shownH = o >= 5 ? k.width : k.height;
  if (!worthCopy(shownW, width)) return null;
  let r: Raster;
  if (k.mime === "png") {
    const p = PNG.sync.read(Buffer.from(source.buffer, source.byteOffset, source.byteLength));
    r = { width: p.width, height: p.height, data: p.data };
  } else {
    const j = jpeg.decode(source, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_PIXELS / 1e6,
      maxMemoryUsageInMB: 1024,
    });
    r = orient({ width: j.width, height: j.height, data: j.data }, o);
  }
  const height = Math.max(1, Math.round((shownH * width) / shownW));
  const small = shrink(r, width, height);
  return {
    bytes: k.mime === "png" ? encodePng(small, source) : encodeJpeg(small, source),
    ext: k.mime,
    width,
    height,
  };
}

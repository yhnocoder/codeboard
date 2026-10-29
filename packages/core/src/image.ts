// 按文件头认位图：PNG（含 APNG）、JPEG、WebP（含动画）、GIF（含多帧），连同显示出来的宽高。
// 没用库：运行时依赖里没有认文件类型的库，而要看的动图标记（APNG 的 acTL、WebP VP8X 的动画位、GIF 的帧数）和 JPEG 的 EXIF 方向通用的库也不管；
// 真正解码在 webview 的图片解码器里

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
/** w / h：显示出来的大小（JPEG 按 EXIF 方向转过：浏览器默认 image-orientation: from-image） */
export type ImageInfo = { mime: ImageMime; anim: boolean; w: number; h: number };
export const IMAGE_EXT: Record<ImageMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** 认不出、或块结构走不通（截断）的返回 null。mime 取自文件头，不看扩展名 */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const sized = (mime: ImageMime, anim: boolean, w: number, h: number): ImageInfo | null => (w > 0 && h > 0 ? { mime, anim, w, h } : null);
  // PNG：8 字节签名，第一块是 IHDR（宽、高）；IDAT 之前出现 acTL 就是 APNG
  if (b.length >= 33 && b[0] === 0x89 && ascii(b, 1, 7) === "PNG\r\n\x1a\n" && ascii(b, 12, 4) === "IHDR") {
    let anim = false;
    for (let i = 8; i + 8 <= b.length;) {
      const type = ascii(b, i + 4, 4);
      if (type === "acTL") anim = true;
      if (type === "IDAT") return sized("image/png", anim, dv.getUint32(16), dv.getUint32(20));
      i += 12 + dv.getUint32(i);
    }
    return null;
  }
  // WebP：RIFF....WEBP，第一块 VP8（有损）/ VP8L（无损）/ VP8X（扩展：标志字节里 0x02 = 动画，画布宽高 - 1 各 24 位）
  if (b.length >= 21 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const c = ascii(b, 12, 4);
    if (c === "VP8 " && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return sized("image/webp", false, dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff);
    if (c === "VP8L" && b.length >= 25 && b[20] === 0x2f) { const v = dv.getUint32(21, true); return sized("image/webp", false, (v & 0x3fff) + 1, ((v >>> 14) & 0x3fff) + 1); }
    const u24 = (at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
    if (c === "VP8X" && b.length >= 30) return sized("image/webp", (b[20] & 0x02) !== 0, u24(24) + 1, u24(27) + 1);
    return null;
  }
  // GIF：GIF87a / GIF89a，逻辑屏幕的宽高；走一遍块数帧（0x2C 一帧，0x21 扩展，0x3B 结束）
  if (b.length >= 13 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) {
    const table = (flags: number) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
    let i = 13 + table(b[10]), frames = 0;
    const skipSub = () => { while (i < b.length && b[i] !== 0) i += b[i] + 1; i++; };
    while (i < b.length && b[i] !== 0x3b) {
      if (b[i] === 0x21) { i += 2; skipSub(); }
      else if (b[i] === 0x2c && i + 10 <= b.length) { i += 10 + table(b[i + 9]) + 1; skipSub(); frames++; } // 图像描述 + 局部色表 + LZW 最小码长 + 数据
      else return null;
    }
    return frames && i <= b.length ? sized("image/gif", frames > 1, dv.getUint16(6, true), dv.getUint16(8, true)) : null;
  }
  // JPEG：FF D8 FF，走标记段到第一个 SOF（帧头：高、宽）；路上的 APP1 Exif 里记下方向（5–8 = 转了 90°，宽高对调）
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2, turned = false;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; } // 填充
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // 没有长度的标记
      if (m === 0xd9 || m === 0xda) return null; // 图像结束、扫描开始：帧头之前不该出现
      const len = dv.getUint16(i + 2);
      if (len < 2 || i + 2 + len > b.length) return null;
      if (m === 0xe1 && len >= 16 && ascii(b, i + 4, 6) === "Exif\0\0") turned = exifTurned(dv, i + 10, i + 2 + len);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && len >= 7) {
        const h = dv.getUint16(i + 5), w = dv.getUint16(i + 7);
        return turned ? sized("image/jpeg", false, h, w) : sized("image/jpeg", false, w, h);
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** Exif（TIFF 头从 at 开始，到 end 为止）里的方向（0x0112）是不是 5–8 */
function exifTurned(dv: DataView, at: number, end: number): boolean {
  if (at + 8 > end) return false;
  const le = dv.getUint16(at) === 0x4949;
  const ifd = at + dv.getUint32(at + 4, le);
  if (ifd + 2 > end) return false;
  const n = dv.getUint16(ifd, le);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return false;
    if (dv.getUint16(e, le) === 0x0112) { const o = dv.getUint16(e + 8, le); return o >= 5 && o <= 8; }
  }
  return false;
}

// SVG 是文字，没有文件头：看开头（XML 声明、注释、DOCTYPE 之后）第一个元素是不是 <svg>。只认不清洗：SVG 只用 <img> 显示
// （不跑脚本、不加载外面的东西），白板存之前另外清洗过
const SVG_ROOT = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE\s+svg\b(?:[^>[]|\[[\s\S]*?\])*>)\s*)*<svg(?=[\s/>])([^>]*)>/;
/** 显示出来的大小（像素）；width / height 没写或是百分比、又没有 viewBox 时认不出（空的） */
export type SvgInfo = { w?: number; h?: number };

/** 是 SVG 时回它的大小，不是回 null */
export function sniffSvg(b: Uint8Array): SvgInfo | null {
  const m = SVG_ROOT.exec(new TextDecoder().decode(b.subarray(0, 64 * 1024)));
  return m ? svgSize(m[1]) : null;
}

/** <svg> 上的 width / height（像素）；缺的按 viewBox 的比例补，都没写就是 viewBox 的大小 */
function svgSize(attrs: string): SvgInfo {
  const attr = (n: string) => new RegExp(`\\s${n}\\s*=\\s*(["'])([^"']*)\\1`).exec(attrs)?.[2];
  const px = (v?: string) => (v && /^\s*[\d.]+(?:e[+-]?\d+)?(?:px)?\s*$/i.test(v) ? parseFloat(v) : NaN);
  let w = px(attr("width")), h = px(attr("height"));
  const vb = (attr("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const [vw, vh] = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? [vb[2], vb[3]] : [NaN, NaN];
  if (!(w > 0) && h > 0) w = (h * vw) / vh;
  else if (!(h > 0) && w > 0) h = (w * vh) / vw;
  else if (!(w > 0) && !(h > 0)) { w = vw; h = vh; }
  return w > 0 && h > 0 ? { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) } : {};
}

/**
 * PNG 的 pHYs 块记的分辨率（每英寸多少像素，按横向）：Mac 截图在 Retina 屏上是 144，普通屏 72。
 * 只认单位是米的（单位 0 只记长宽比）；不是 PNG、没有这一块（或在 IDAT 之后）回 null
 */
export function pngDpi(b: Uint8Array): number | null {
  if (b.length < 33 || b[0] !== 0x89 || ascii(b, 1, 7) !== "PNG\r\n\x1a\n") return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 8; i + 8 <= b.length;) {
    const len = dv.getUint32(i), type = ascii(b, i + 4, 4);
    if (type === "IDAT" || type === "IEND") return null;
    if (type === "pHYs" && len >= 9 && i + 17 <= b.length) {
      const ppm = dv.getUint32(i + 8);
      return b[i + 16] === 1 && ppm > 0 ? ppm * 0.0254 : null;
    }
    i += 12 + len;
  }
  return null;
}

/**
 * 图在屏幕上看到的大小是像素的几分之一（图片卡的宽度按它算）：PNG 有 pHYs 按 dpi / 72（Mac 的约定：72 dpi 是一倍）；
 * 没有的用 fallback（白板：剪贴板里的截图用窗口的 devicePixelRatio，网页上复制的、文件按 1 倍）。
 * dpi 取整到 72 的 1/4 倍附近（144 dpi 存成 5669 每米，换回来是 143.99）
 */
export function imageScale(b: Uint8Array, fallback = 1): number {
  const dpi = pngDpi(b);
  if (!dpi) return fallback;
  const k = Math.min(4, Math.max(0.25, dpi / 72)); // 记错的（1 dpi、几千 dpi）不让卡大得、小得离谱
  return Math.abs(k * 4 - Math.round(k * 4)) < 0.01 ? Math.round(k * 4) / 4 : k;
}

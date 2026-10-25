// 按文件头认位图：PNG（含 APNG）、JPEG、WebP（含动画）、GIF（含多帧），连同显示出来的宽高。宿主用：贴纸包（stickers.ts）、Note 里粘贴的图（images.ts）。
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

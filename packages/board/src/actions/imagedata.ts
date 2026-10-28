// Image 卡的图的内容：复制到系统剪贴板（image/png）、拖进 Note（存成 Note 的图）时用。
// assets/ 里的图由宿主读（webview 的 CSP 不让 fetch 资源地址，跨源的图画到 canvas 上也读不出来）；data: 的就在这里解。
import type { ImageCard } from "@codeboard/core";
import { ask } from "../host";
import { saveNoteImage } from "../md/images";

const remote = (src: string) => /^https?:/.test(src);
/** 图的 data: URL；网上的图拿不到内容（回 null） */
export async function imageDataUrl(c: ImageCard): Promise<string | null> {
  if (c.src.startsWith("data:")) return c.src;
  if (remote(c.src)) return null;
  return ask("readAsset", { file: c.src }).catch(() => null);
}

/** data: URL → Blob（不经过 fetch：CSP 不让） */
function blobOf(dataUrl: string): Blob | null {
  const m = /^data:([^,;]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const s = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  return new Blob([Uint8Array.from(s, (ch) => ch.charCodeAt(0))], { type: m[1] || "application/octet-stream" });
}
async function drawn(dataUrl: string): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth || 1;
  cv.height = img.naturalHeight || 1;
  cv.getContext("2d")!.drawImage(img, 0, 0);
  return cv;
}

/** 剪贴板要的 PNG（浏览器的剪贴板只收 image/png）：PNG 原样，别的格式画一遍 */
export async function pngOf(dataUrl: string): Promise<Blob> {
  if (/^data:image\/png[;,]/.test(dataUrl)) { const b = blobOf(dataUrl); if (b) return new Blob([b], { type: "image/png" }); }
  const cv = await drawn(dataUrl);
  return new Promise((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error("Could not encode the image"))), "image/png"));
}

/**
 * Image 卡的图存成 Note 的图（和 Note 里粘贴的图同一条路：宿主存进 assets/，见 host/src/images.ts；SVG 还是 SVG），回 Markdown 里写的地址；
 * 网上的图直接写它的网址。存不了回 null（已经提示过）
 */
export async function noteImageOf(c: ImageCard): Promise<string | null> {
  if (remote(c.src)) return c.src;
  const url = await imageDataUrl(c);
  return url ? saveNoteImage(url) : null;
}

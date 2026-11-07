// Image 卡的图的内容：复制到系统剪贴板（image/png）、拖进 Note（存成 Note 的图）时用。
// assets/ 里的图由宿主读（webview 的 CSP 不让 fetch 资源地址，跨源的图画到 canvas 上也读不出来）；data: 的就在这里解。
import type { ImageCard } from "@codeboard/core";
import { ask, send } from "../host";
import { saveNoteImage } from "../md/images";
import { camMoving } from "../state/camera";
import { dragging } from "../state/ui";
import { DRAW_QUIET_POLL } from "../state/timing";

const remote = (src: string) => /^https?:/.test(src);
/** 图的 data: URL；网上的图拿不到内容（回 null） */
export const imageDataUrl = (c: ImageCard) => srcDataUrl(c.src);
/** The picture at an address as Markdown or an Image card writes it (assets/…, a bare asset name, data:); null for the web */
async function srcDataUrl(src: string): Promise<string | null> {
  if (src.startsWith("data:")) return src;
  if (remote(src)) return null;
  return ask("readAsset", { file: src.replace(/^assets\//, "") }).catch(() => null);
}

/** The last picture this board put on the clipboard: its pixels' fingerprint and what it stands for here (the cards' text, the
 *  image's Markdown). Other apps get only the picture; a paste of it on the board is that text again */
let lastPic: { fp: string; text: string } | null = null;

/**
 * Put a picture on the system clipboard as image/png, alone: an app given text as well pastes the text (chat boxes, terminals),
 * so the board's own meaning of the copy (text) stays with the board (lastPic, and the host through onPic). withText: a copy of
 * several cards, the text of all of them goes along.
 * Call it in the key press or click: write() has to start in the user's gesture, the picture's bytes come later (ClipboardItem
 * takes a Promise). When the webview may not write it, the host puts the picture there itself (the editor's OS clipboard), or
 * the text if it can't (and the text when there is no picture: an image on the web). onPic gets the picture's fingerprint
 */
export function copyPicture(
  data: Promise<string | null>,
  text: string,
  o: { withText?: boolean; onPic?: (fp: string | null) => void } = {},
) {
  const png = data.then((u) => (u ? pngOf(u) : Promise.reject(new Error("No image data"))));
  lastPic = null;
  png.then(fingerprint).then(
    (fp) => {
      lastPic = { fp, text };
      o.onPic?.(fp);
    },
    () => o.onPic?.(null),
  );
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    void png.then(
      (b) => toHost(b, text, "no ClipboardItem in this webview"),
      () => send({ type: "copyText", text }),
    );
    return;
  }
  const item: Record<string, Blob | Promise<Blob>> = { "image/png": png };
  if (o.withText) item["text/plain"] = new Blob([text], { type: "text/plain" });
  navigator.clipboard.write([new ClipboardItem(item)]).catch((e: unknown) =>
    png.then(
      (b) => toHost(b, text, e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
      () => send({ type: "copyText", text }),
    ),
  );
}
/** A pasted picture that is the board's last copy: the text it stands for; null for any other picture */
export async function knownPicture(f: Blob): Promise<string | null> {
  const last = lastPic;
  if (!last) return null;
  return (await fingerprint(f).catch(() => null)) === last.fp ? last.text : null;
}
/**
 * The pixels of a picture, drawn small: the same after the clipboard encodes the PNG again (lossless, so a byte hash would not
 * do). Coarse levels leave room for colour conversion on the way
 */
export async function fingerprint(b: Blob): Promise<string> {
  const bmp = await createImageBitmap(b);
  const N = 12,
    cv = new OffscreenCanvas(N, N),
    g = cv.getContext("2d")!;
  g.drawImage(bmp, 0, 0, N, N);
  const px = g.getImageData(0, 0, N, N).data;
  let h = 2166136261;
  for (let i = 0; i < px.length; i++) h = Math.imul(h ^ (px[i] >> 4), 16777619);
  const fp = `${bmp.width}x${bmp.height}:${(h >>> 0).toString(36)}`;
  bmp.close();
  return fp;
}
/** An image in a Note (its address as the Markdown writes it) onto the clipboard; pasted back on the board or into a Note it is
 *  that Markdown again. md: the image's own Markdown when there is one (its alt text, width) */
export function copyNoteImage(src: string, md?: string) {
  const text = md ?? (src.startsWith("data:") ? "Image" : `![](${/[\s()<>]/.test(src) ? `<${src}>` : src})`);
  copyPicture(srcDataUrl(src), text);
}
async function toHost(png: Blob, text: string, why: string) {
  const url = await new Promise<string>((ok, no) => {
    const rd = new FileReader();
    rd.onload = () => ok(String(rd.result));
    rd.onerror = () => no(rd.error);
    rd.readAsDataURL(png);
  });
  send({ type: "copyImage", png: url, text, why });
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

/** About this many pixels on a drawn picture's longer side (what an embedding model looks at is smaller still) */
const DRAWN_SIDE = 1024;

/** Resolves on a frame where the camera is still and nothing is dragged */
const quiet = () =>
  new Promise<void>((ok) => {
    const look = () =>
      camMoving() || dragging().size ? setTimeout(look, DRAW_QUIET_POLL) : requestAnimationFrame(() => ok());
    look();
  });

/** A picture (an SVG) drawn as the board shows it, on white, as a PNG data: URL, its longer side DRAWN_SIDE; null when it does
 *  not draw. Drawn while the board is still (the host asks for one at a time), the PNG made off the main thread (toBlob) */
export async function drawnPng(dataUrl: string): Promise<string | null> {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    await quiet();
    const w = img.naturalWidth || DRAWN_SIDE,
      h = img.naturalHeight || DRAWN_SIDE;
    const k = DRAWN_SIDE / Math.max(w, h);
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(w * k));
    cv.height = Math.max(1, Math.round(h * k));
    const g = cv.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0, cv.width, cv.height);
    const png = await new Promise<Blob | null>((ok) => cv.toBlob(ok, "image/png"));
    if (!png) return null;
    return await new Promise<string>((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(r.result as string);
      r.onerror = () => no(r.error);
      r.readAsDataURL(png);
    });
  } catch {
    return null;
  }
}

/** 剪贴板要的 PNG（浏览器的剪贴板只收 image/png）：PNG 原样，别的格式画一遍 */
async function pngOf(dataUrl: string): Promise<Blob> {
  if (/^data:image\/png[;,]/.test(dataUrl)) {
    const b = blobOf(dataUrl);
    if (b) return new Blob([b], { type: "image/png" });
  }
  const cv = await drawn(dataUrl);
  return new Promise((ok, no) =>
    cv.toBlob((b) => (b ? ok(b) : no(new Error("Could not encode the image"))), "image/png"),
  );
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

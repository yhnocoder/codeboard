// Note 里的图：Markdown 写的是存储目录里的相对地址 assets/<内容的 sha1>-<宽>x<高>.<扩展名>（宿主存的，见 host/src/images.ts）。
// 显示、编辑时换成宿主给的 webview 资源地址（host.assetBase，和 Image 卡同一个目录）；文件名里的宽高交给渲染器先留好位置。
// 别的地址（网址、手打的别处的路径）照原样。
// A big still PNG or JPEG also lists its smaller copies (md/copies.ts, in host.thumbBase): the Markdown instance shows the one
// that fits the size the image is seen at, and the Markdown keeps the address as written
import type { Markdown, ResolvedImage } from "@yhnocoder/markdown";
import { ask, switched } from "../host";
import { copiesOf } from "./copies";
import { toast } from "../state/toast";
import { dropUnsafeSmil, purifiedSvg } from "./animsvg";

const SIZED = /-(\d{1,5})x(\d{1,5})\.(?:png|jpg|webp|gif|svg)$/;
let base: string | undefined;
let key = "";
/** The resolver for the host's asset address b and copies folder thumbs (none: originals only) */
export function setNoteAssets(md: Markdown, b: string, thumbs: string | undefined) {
  if (`${b}\n${thumbs}` === key) return;
  key = `${b}\n${thumbs}`;
  base = b;
  md.setImageResolver((src): ResolvedImage | undefined => {
    if (!src.startsWith("assets/")) return undefined;
    const name = src.slice(7),
      m = SIZED.exec(name),
      i = thumbs ? copiesOf(md, name) : undefined;
    const size = m ? { width: +m[1], height: +m[2] } : i ? { width: i.width, height: i.height } : {};
    return {
      src: b ? `${b}/${name}` : src,
      ...size,
      copies: i?.copies.length
        ? i.copies.map((c) => ({ width: c.width, src: c.file && `${thumbs}/${c.file}` }))
        : undefined,
    };
  });
}

/** A displayed image address back as the Note's Markdown writes it (assets/…); others are written as shown */
const noteSrcOf = (shown: string) =>
  base && shown.startsWith(`${base}/`) ? `assets/${shown.slice(base.length + 1)}` : shown;
/** A Note image's address as its Markdown writes it: data-src (it may show a smaller copy), else from what it shows */
export const noteImageSrc = (img: HTMLImageElement) => img.dataset.src ?? noteSrcOf(img.getAttribute("src") ?? "");

/** 编辑器里粘贴、拖进来、/Image 选的图交给宿主存；存不了（不是这几种图、太大）提示一下，不插 */
export async function saveNoteImage(dataUrl: string): Promise<string | null> {
  try {
    return await ask("saveImage", { dataUrl: cleanImage(dataUrl) });
  } catch (e) {
    if (!switched(e)) toast((e as Error).message || "Could not add the image");
    return null;
  }
}

const abs = (v: string | null) => (v && /^\s*[\d.]+(?:e[+-]?\d+)?(?:px)?\s*$/i.test(v) ? parseFloat(v) : NaN);

/**
 * SVG 存之前清洗一遍。显示只用 <img>（SVG 里的脚本不跑、不加载外面的东西），这一步是多一层保险：存下的文件别处打开也没有脚本。
 * 按 XML 解析（DOCTYPE 里的实体照常展开），DOMPurify（svg 配置）去掉脚本、事件属性、javascript: 链接、foreignObject；
 * SMIL 的 <animate> / <set> 留着（动画 SVG，见 md/animsvg.ts），改链接、事件属性的去掉，
 * 再用 XMLSerializer 写回（innerHTML 写出的 &nbsp; 之类不是合法的 XML）。
 * 只有 viewBox、或宽高是百分比的 SVG 在 <img> 里没有自己的大小（浏览器当 300×150）：按 viewBox 补上像素宽高，卡片和 Note 里的大小才对。
 * 不是 SVG 回 null
 */
export function cleanSvg(text: string): string | null {
  const svg = purifiedSvg(text);
  if (!svg) return null;
  dropUnsafeSmil(svg);
  let w = abs(svg.getAttribute("width")),
    h = abs(svg.getAttribute("height"));
  if (!(w > 0 && h > 0)) {
    const vb = (svg.getAttribute("viewBox") ?? "")
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const [vw, vh] = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? [vb[2], vb[3]] : [300, 150];
    if (w > 0) h = (w * vh) / vw;
    else if (h > 0) w = (h * vw) / vh;
    else {
      w = vw;
      h = vh;
    }
    svg.setAttribute("width", String(Math.round(w * 100) / 100));
    svg.setAttribute("height", String(Math.round(h * 100) / 100));
  }
  return new XMLSerializer().serializeToString(svg);
}

const utf8Base64 = (s: string) => {
  const b = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
};
export const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${utf8Base64(svg)}`;

/** 要存的图（data: URL）：SVG 换成清洗过的，读不了的 SVG 抛错（消息给用户看）；别的照原样（宿主按文件头认，认不出的不收） */
export function cleanImage(dataUrl: string): string {
  const m = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/s.exec(dataUrl);
  if (!m) return dataUrl;
  let svg: string | null = null;
  try {
    svg = cleanSvg(
      /;base64$/.test(m[1] ?? "")
        ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)))
        : decodeURIComponent(m[2]),
    );
  } catch {
    /* 下面一起报 */
  }
  if (!svg) throw new Error("This SVG image could not be read");
  return svgDataUrl(svg);
}

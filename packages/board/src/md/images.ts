// Note 里的图：Markdown 写的是存储目录里的相对地址 assets/<内容的 sha1>-<宽>x<高>.<扩展名>（宿主存的，见 host/src/images.ts）。
// 显示、编辑时换成宿主给的 webview 资源地址（host.assetBase，和 Image 卡同一个目录）；文件名里的宽高交给渲染器先留好位置。
// 别的地址（网址、手打的别处的路径）照原样
import DOMPurify from "dompurify";
import { setImageResolver } from "@yhnocoder/markdown";
import { ask } from "../host";
import { toast } from "../state/store";

const SIZED = /-(\d{1,5})x(\d{1,5})\.(?:png|jpg|webp|gif|svg)$/;
let base: string | undefined;
export function setNoteAssets(b: string) {
  if (b === base) return;
  base = b;
  setImageResolver((src) => {
    if (!src.startsWith("assets/")) return undefined;
    const name = src.slice(7), m = SIZED.exec(name);
    return { src: b ? `${b}/${name}` : src, ...(m ? { width: +m[1], height: +m[2] } : {}) };
  });
}

/** 编辑器里粘贴、拖进来、/Image 选的图交给宿主存；存不了（不是这几种图、太大）提示一下，不插 */
export async function saveNoteImage(dataUrl: string): Promise<string | null> {
  try { return await ask("saveImage", { dataUrl: cleanImage(dataUrl) }); }
  catch (e) { toast((e as Error).message || "Could not add the image"); return null; }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const abs = (v: string | null) => (v && /^\s*[\d.]+(?:e[+-]?\d+)?(?:px)?\s*$/i.test(v) ? parseFloat(v) : NaN);

/**
 * SVG 存之前清洗一遍。显示只用 <img>（SVG 里的脚本不跑、不加载外面的东西），这一步是多一层保险：存下的文件别处打开也没有脚本。
 * 按 XML 解析（DOCTYPE 里的实体照常展开），DOMPurify（svg 配置）去掉脚本、事件属性、javascript: 链接、foreignObject，
 * 再用 XMLSerializer 写回（innerHTML 写出的 &nbsp; 之类不是合法的 XML）。
 * 只有 viewBox、或宽高是百分比的 SVG 在 <img> 里没有自己的大小（浏览器当 300×150）：按 viewBox 补上像素宽高，卡片和 Note 里的大小才对。
 * 不是 SVG 回 null
 */
export function cleanSvg(text: string): string | null {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== "svg" || doc.getElementsByTagNameNS("*", "parsererror").length) return null;
  const body = DOMPurify.sanitize(root, { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM: true });
  const svg = [...body.childNodes].find((e): e is Element => e instanceof Element && e.namespaceURI === SVG_NS && e.localName === "svg");
  if (!svg) return null;
  let w = abs(svg.getAttribute("width")), h = abs(svg.getAttribute("height"));
  if (!(w > 0 && h > 0)) {
    const vb = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
    const [vw, vh] = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? [vb[2], vb[3]] : [300, 150];
    if (w > 0) h = (w * vh) / vw;
    else if (h > 0) w = (h * vw) / vh;
    else { w = vw; h = vh; }
    svg.setAttribute("width", String(Math.round(w * 100) / 100));
    svg.setAttribute("height", String(Math.round(h * 100) / 100));
  }
  return new XMLSerializer().serializeToString(svg);
}

const utf8Base64 = (s: string) => { const b = new TextEncoder().encode(s); let bin = ""; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(bin); };
export const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${utf8Base64(svg)}`;

/** 要存的图（data: URL）：SVG 换成清洗过的，读不了的 SVG 抛错（消息给用户看）；别的照原样（宿主按文件头认，认不出的不收） */
export function cleanImage(dataUrl: string): string {
  const m = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/s.exec(dataUrl);
  if (!m) return dataUrl;
  let svg: string | null = null;
  try { svg = cleanSvg(/;base64$/.test(m[1] ?? "") ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))) : decodeURIComponent(m[2])); } catch { /* 下面一起报 */ }
  if (!svg) throw new Error("This SVG image could not be read");
  return svgDataUrl(svg);
}

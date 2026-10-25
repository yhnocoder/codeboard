// 图片：Markdown 里写的地址 → 页面上显示的地址和大小。静态显示（render.ts）和编辑器的图片节点视图（editor/image.ts）用同一份 <img> 属性，
// 两种模式里一样大、一样的边距，切换时不跳。
// 地址由用的一方解析（setImageResolver；白板：assets/… 换成 webview 的资源地址，文件名里带着宽高）。给了宽高就写进 width / height：
// 图还没解码时浏览器已经按比例留好位置（CSS 里 max-width: 100%、height: auto）。没给的，第一次加载完记下它的大小，之后再画就带上。
// 解码不占主线程（decoding=async），离屏的不先加载（loading=lazy）

/** 解析出来的图：显示的地址，知道的话还有宽高（像素） */
export type ResolvedImage = { src: string; width?: number; height?: number };
/** 返回 undefined = 地址照原样用 */
export type ImageResolver = (src: string) => ResolvedImage | undefined;

let resolver: ImageResolver | null = null;
/** 加载完才知道大小的图：显示的地址 → 宽高 */
const learned = new Map<string, { w: number; h: number }>();
/** 显示的地址 → Markdown 里写的地址（学到大小时让静态显示的缓存里带着它的那几篇重画） */
const rawOf = new Map<string, string>();
let changed: (raw?: string) => void = () => {};
/** render.ts 登记：解析换了（全部重画）、某张图学到了大小（带着它的重画） */
export const onImagesChanged = (f: (raw?: string) => void) => { changed = f; };

/** 换掉图片地址的解析（null = 照原样） */
export function setImageResolver(r: ImageResolver | null) {
  if (r === resolver) return;
  resolver = r;
  learned.clear(); rawOf.clear();
  changed();
}
let base = "";
/** 常见的一种解析：assets/ 开头的地址放到 b 下面（b 为空 = 照原样） */
export function setAssetBase(b: string) {
  if (b === base) return;
  base = b;
  setImageResolver(b ? (src) => (src.startsWith("assets/") ? { src: `${b}/${src.slice(7)}` } : undefined) : null);
}

/** 一张图的 <img> 属性（值为 null 的不写） */
export function imageAttrs(a: { src?: string | null; alt?: string | null; title?: string | null }): Record<string, string | null> {
  const raw = a.src ?? "";
  const r = (raw && resolver?.(raw)) || { src: raw };
  let w = r.width, h = r.height;
  if (!(w && h)) {
    const k = learned.get(r.src);
    if (k) ({ w, h } = k);
    else if (r.src) { watchLoads(); if (rawOf.size > 4000) rawOf.clear(); rawOf.set(r.src, raw); }
  }
  return {
    src: r.src, alt: a.alt ?? "", title: a.title || null,
    width: w && h ? String(w) : null, height: w && h ? String(h) : null,
    loading: "lazy", decoding: "async",
  };
}

// 一个捕获阶段的 load 监听（load 不冒泡）就够了，不用每张图挂一个
let watching = false;
function watchLoads() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("load", (e) => {
    const im = e.target;
    if (!(im instanceof HTMLImageElement) || im.hasAttribute("width") || !im.naturalWidth) return;
    const src = im.getAttribute("src") ?? "", raw = rawOf.get(src);
    if (raw === undefined || learned.has(src)) return;
    learned.set(src, { w: im.naturalWidth, h: im.naturalHeight });
    changed(raw);
  }, true);
}

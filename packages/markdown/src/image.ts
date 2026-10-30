// 静态显示和编辑器的图片节点视图用同一份 <img> 属性，切换时不跳。写上 width / height，图还没解码时浏览器已经按比例
// 留好位置（CSS 里 max-width: 100%、height: auto）；解析没给宽高的，第一次加载完记下大小，之后再画就带上

/** 解析出来的图：显示的地址，知道的话还有宽高（像素） */
export type ResolvedImage = { src: string; width?: number; height?: number };
/** 返回 undefined = 地址照原样用 */
export type ImageResolver = (src: string) => ResolvedImage | undefined;

let resolver: ImageResolver | null = null;
/** 显示的地址 → 加载完才知道的宽高 */
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

/** 图注：Markdown 里图的 title（![a](u "图注")），空白的不算 */
export const captionOf = (title: unknown): string => (typeof title === "string" ? title.trim() : "");

/** Tallest an image is drawn without a width of its own (px; markdown.css has the same number) */
export const IMAGE_MAX_H = 340;
/** 一张图的 <img> 属性（值为 null 的不写） */
export function imageAttrs(a: { src?: string | null; alt?: string | null; title?: string | null; width?: number | null }): Record<string, string | null> {
  const raw = a.src ?? "";
  const r = (raw && resolver?.(raw)) || { src: raw };
  let w = r.width, h = r.height;
  if (!(w && h)) {
    const k = learned.get(r.src);
    if (k) ({ w, h } = k);
    else if (r.src) { watchLoads(); if (rawOf.size > 4000) rawOf.clear(); rawOf.set(r.src, raw); }
  }
  return {
    // title 是图注，画在图下面（render.ts、editor/image.ts），不再当悬停提示
    src: r.src, alt: a.alt ?? "",
    width: w && h ? String(w) : null, height: w && h ? String(h) : null,
    // 缩小了的图：正文宽的百分之几，居中（.sized，见 markdown.css；编辑器里这个宽度在包着图的那一层上，见 editor/image.ts）
    // the rest at their own size up to the column width and IMAGE_MAX_H tall (as markdown.css's max-height does for images
    // whose size is not known yet): with the size known, a max-width keeps the proportions
    style: a.width ? `width: ${a.width}%` : w && h && h > IMAGE_MAX_H ? `max-width: min(100%, ${Math.round((IMAGE_MAX_H * w) / h)}px)` : null,
    class: a.width ? "sized" : null,
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

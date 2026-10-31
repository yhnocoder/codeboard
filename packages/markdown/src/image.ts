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
export const onImagesChanged = (f: (raw?: string) => void) => {
  changed = f;
};

/** 换掉图片地址的解析（null = 照原样） */
export function setImageResolver(r: ImageResolver | null) {
  if (r === resolver) return;
  resolver = r;
  learned.clear();
  rawOf.clear();
  changed();
}
let base = "";
/** 常见的一种解析：assets/ 开头的地址放到 b 下面（b 为空 = 照原样） */
export function setAssetBase(b: string) {
  if (b === base) return;
  base = b;
  setImageResolver(b ? (src) => (src.startsWith("assets/") ? { src: `${b}/${src.slice(7)}` } : undefined) : null);
}

/**
 * The drag data type an image dragged in the editor carries besides its Markdown source (text/plain): JSON of
 * DraggedImage. A drop the editor does not take (released outside it) can read which image it was
 */
export const IMAGE_DRAG_TYPE = "application/x-markdown-image";
/** src = the address as written in the Markdown (not the resolved one), caption = the title */
export type DraggedImage = { src: string; alt: string; caption: string };
export function draggedImage(dt: DataTransfer | null | undefined): DraggedImage | null {
  if (!dt?.types.includes(IMAGE_DRAG_TYPE)) return null;
  try {
    const v = JSON.parse(dt.getData(IMAGE_DRAG_TYPE)) as Partial<DraggedImage>;
    return typeof v.src === "string" && v.src
      ? { src: v.src, alt: String(v.alt ?? ""), caption: String(v.caption ?? "") }
      : null;
  } catch {
    return null;
  }
}

/** 图注：Markdown 里图的 title（![a](u "图注")），空白的不算 */
export const captionOf = (title: unknown): string => (typeof title === "string" ? title.trim() : "");

const MISSING_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="1.8"/><path d="M2.5 11l3.2-3.2 2.6 2.6 1.7-1.7 3.5 3.5M10.2 6.2h.01"/></svg>';
/** An image there is nothing to show for: one that failed to load, or ![alt](…) whose address the parser could not read.
 *  A quiet line naming it (the alt text, or the address), with the address as its tooltip */
export function missingImage(alt: string, src: string): HTMLElement {
  const box = document.createElement("span"),
    t = document.createElement("span");
  box.className = "md-imgerr";
  box.title = src;
  box.innerHTML = MISSING_ICON;
  t.textContent = `Image failed to load · ${alt || src}`;
  box.append(t);
  return box;
}
/** The same as HTML text (the static render) */
export const missingImageHtml = (alt: string, src: string, esc: (s: string) => string) =>
  `<span class="md-imgerr" title="${esc(src)}">${MISSING_ICON}<span>Image failed to load · ${esc(alt || src)}</span></span>`;
/** 一张图的 <img> 属性（值为 null 的不写） */
export function imageAttrs(a: {
  src?: string | null;
  alt?: string | null;
  title?: string | null;
  width?: number | null;
}): Record<string, string | null> {
  const raw = a.src ?? "";
  const r = (raw && resolver?.(raw)) || { src: raw };
  let w = r.width,
    h = r.height;
  if (!(w && h)) {
    const k = learned.get(r.src);
    if (k) ({ w, h } = k);
    else if (r.src) {
      watchLoads();
      if (rawOf.size > 4000) rawOf.clear();
      rawOf.set(r.src, raw);
    }
  }
  return {
    // title 是图注，画在图下面（render.ts、editor/image.ts），不再当悬停提示
    src: r.src,
    alt: a.alt ?? "",
    width: w && h ? String(w) : null,
    height: w && h ? String(h) : null,
    // 缩小了的图：正文宽的百分之几，居中（.sized，见 markdown.css；编辑器里这个宽度在包着图的那一层上，见 editor/image.ts）
    style: a.width ? `width: ${a.width}%` : null,
    class: a.width ? "sized" : null,
    loading: "lazy",
    decoding: "async",
  };
}

// 一个捕获阶段的 load 监听（load 不冒泡）就够了，不用每张图挂一个
let watching = false;
function watchLoads() {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener(
    "load",
    (e) => {
      const im = e.target;
      if (!(im instanceof HTMLImageElement) || im.hasAttribute("width") || !im.naturalWidth) return;
      const src = im.getAttribute("src") ?? "",
        raw = rawOf.get(src);
      if (raw === undefined || learned.has(src)) return;
      learned.set(src, { w: im.naturalWidth, h: im.naturalHeight });
      changed(raw);
    },
    true,
  );
}

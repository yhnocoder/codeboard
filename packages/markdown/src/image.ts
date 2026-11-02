// 静态显示和编辑器的图片节点视图用同一份 <img> 属性，切换时不跳。写上 width / height，图还没解码时浏览器已经按比例
// 留好位置（CSS 里 max-width: 100%、height: auto）；解析没给宽高的，第一次加载完记下大小，之后再画就带上
import { capped, cappedAdd } from "./cache";

/** 解析出来的图：显示的地址，知道的话还有宽高（像素） */
export type ResolvedImage = { src: string; width?: number; height?: number };
/** 返回 undefined = 地址照原样用 */
export type ImageResolver = (src: string) => ResolvedImage | undefined;

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
const MAX = 4000;

/** One Markdown instance's images: how addresses resolve, sizes learned on load, addresses that failed to load */
export class Images {
  private resolver: ImageResolver | null = null;
  private asset = "";
  /** 显示的地址 → 加载完才知道的宽高 */
  private learned = new Map<string, { w: number; h: number }>();
  /** 显示的地址 → Markdown 里写的地址（学到大小时让静态显示的缓存里带着它的那几篇重画） */
  private rawOf = new Map<string, string>();
  private watching = false;
  /** Addresses that failed to load: drawn as the placeholder at once next time (no broken image in between) */
  private failed = new Set<string>();
  /** Addresses already shown under their source in the editor: those load at once (editor/widgets.ts) */
  private loaded = new Set<string>();

  /** changed: the resolver changed (everything redraws), or an image learned its size (raw: the address it is written as) */
  constructor(private changed: (raw?: string) => void) {}

  /** 换掉图片地址的解析（null = 照原样） */
  setResolver(r: ImageResolver | null) {
    if (r === this.resolver) return;
    this.resolver = r;
    this.asset = "";
    this.learned.clear();
    this.rawOf.clear();
    this.changed();
  }
  /**
   * The common resolver: an address under the folder dir (relative, as written in the Markdown: "assets") is served from base,
   * so dir/a.png shows base/a.png; other addresses stay as written. An empty base removes the resolver
   */
  setAssetBase(dir: string, base: string) {
    const prefix = `${dir.replace(/\/+$/, "")}/`,
      key = `${prefix}\n${base}`;
    if (key === this.asset) return;
    this.setResolver(
      base ? (src) => (src.startsWith(prefix) ? { src: `${base}/${src.slice(prefix.length)}` } : undefined) : null,
    );
    this.asset = key;
  }

  /** 一张图的 <img> 属性（值为 null 的不写） */
  attrs(a: {
    src?: string | null;
    alt?: string | null;
    title?: string | null;
    width?: number | null;
  }): Record<string, string | null> {
    const raw = a.src ?? "";
    const r = (raw && this.resolver?.(raw)) || { src: raw };
    let w = r.width,
      h = r.height;
    if (!(w && h)) {
      const k = this.learned.get(r.src);
      if (k) ({ w, h } = k);
      else if (r.src) {
        this.watchLoads();
        capped(this.rawOf, MAX, r.src, raw);
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

  /** An image that could not load: a quiet line in its place (the alt text, or the address), not the browser's broken icon */
  fail(img: HTMLImageElement) {
    const src = img.getAttribute("src") ?? "";
    if (src) cappedAdd(this.failed, MAX, src);
    img.replaceWith(missingImage(img.alt, src));
  }
  failedBefore = (src: string | null) => !!src && this.failed.has(src);
  /** The editor showed this address loaded once: it loads at once next time */
  loadedBefore = (src: string) => this.loaded.has(src);
  sawLoad(src: string) {
    cappedAdd(this.loaded, MAX, src);
  }

  // 一个捕获阶段的 load 监听（load 不冒泡）就够了，不用每张图挂一个
  private watchLoads() {
    if (this.watching || typeof document === "undefined") return;
    this.watching = true;
    document.addEventListener(
      "load",
      (e) => {
        const im = e.target;
        if (!(im instanceof HTMLImageElement) || im.hasAttribute("width") || !im.naturalWidth) return;
        const src = im.getAttribute("src") ?? "",
          raw = this.rawOf.get(src);
        if (raw === undefined || this.learned.has(src)) return;
        capped(this.learned, MAX, src, { w: im.naturalWidth, h: im.naturalHeight });
        this.changed(raw);
      },
      true,
    );
  }
}

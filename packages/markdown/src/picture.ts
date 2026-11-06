// Which source an image shows. A 2500 px screenshot shown 480 px wide costs the page as much to decode, keep and draw as at full
// size; when the page has smaller copies of it (the resolver lists them: ResolvedImage.copies), the image shows the smallest one
// still sharp at the size it is seen at: its laid-out width (from a ResizeObserver, so nothing reads layout) times the page's
// display scale (MarkdownOptions.displayScale: a zoom times devicePixelRatio), with headroom (pickCopy). The same rules hold for
// every image an instance shows, in the static render, in the editor and on an <img> of the page's own (showImage):
// - it steps up to a larger copy, then the original, as the scale or the width grows, and never down while that <img> stays on the
//   page: the larger one is decoded already, and going back would cost a decode again. Until it has shown anything it may still
//   go down (a first guess at its width, corrected by the first layout);
// - the next source is decoded before it replaces the one on screen, so the image never blinks;
// - an image the page says is not on screen (MarkdownOptions.imageVisible) keeps what it shows until updateImages;
// - a copy listed without an address is asked for (MarkdownOptions.makeImageCopy); until it is there the image keeps what it
//   shows, or a larger copy that is there, or the original when it shows nothing yet, and takes the copy on updateImages.
// Only the display changes: the Markdown, the editor's document and data-src keep the address as written, data-full is the
// original's address (an export uses it); a copy that fails to load falls back to the original
import { capped, cappedAdd } from "./cache";

/** A smaller copy of an image, `width` pixels wide; no src: one the page can make (MarkdownOptions.makeImageCopy) */
export type ImageCopy = { width: number; src?: string };
/** A resolved image: the address of the original and, when known, its size in pixels; copies: smaller copies of it (used only
 *  when the size is known, so a copy takes the space the original would) */
export type ResolvedImage = { src: string; width?: number; height?: number; copies?: readonly ImageCopy[] };

/** Headroom over the size seen: a copy a little sharper than the screen, so the next zoom step in does not blur it */
const COPY_HEADROOM = 1.15;

/** The copy to show for an image `shown` device pixels wide: the smallest at least that wide (with headroom); none = the original */
export function pickCopy(copies: readonly ImageCopy[] | undefined, shown: number): ImageCopy | undefined {
  let best: ImageCopy | undefined;
  for (const c of copies ?? []) if (c.width >= shown * COPY_HEADROOM && (!best || c.width < best.width)) best = c;
  return best;
}

export type PictureOptions = {
  /** Device pixels per CSS pixel of an image's laid-out width: the page's zoom times devicePixelRatio */
  scale?: () => number;
  /** Whether an image is on screen, so worth stepping up now */
  visible?: (img: HTMLImageElement) => boolean;
  /** Make the copy `width` wide of the image written as src; the page calls updateImages once it is there */
  make?: (src: string, width: number) => void;
};

type Shown = {
  /** the address as written */
  raw: string;
  /** the copy width it is at (Infinity: the original; 0: nothing chosen yet, or its copies not known yet) */
  want: number;
  /** its laid-out width in CSS px (0: not laid out yet) */
  css: number;
  /** the source set or being decoded */
  on: string;
  /** bumped by each swap: a decode that ends after a newer one started is dropped */
  gen: number;
  /** a copy failed to load: the original from then on */
  broken: boolean;
  /** laid out on the page once (an <img> not yet on the page is kept until the next sweep) */
  placed: boolean;
  cycle: number;
};

/** A first guess at an image's width before it is laid out, in CSS px (it is capped by the text's width anyway) */
const GUESS = 480;
const MAX = 4000;
/** Images watched between two sweeps of the ones gone from the page */
const SWEEP_EVERY = 256;

const sized = (r: ResolvedImage) => !!(r.width && r.height && r.copies?.length);

/** One instance's shown images and the sources they show */
export class Pictures {
  private shown = new Map<HTMLImageElement, Shown>();
  /** address as written → its last laid-out width, for the first pick of its next <img> (a Note drawn again) */
  private widths = new Map<string, number>();
  /** copies that failed to load */
  private bad = new Set<string>();
  /** copies asked for since the last full update */
  private asked = new Set<string>();
  private ro: ResizeObserver | undefined;
  private added = 0;
  private cycle = 0;

  constructor(
    private resolve: (raw: string) => ResolvedImage | undefined,
    private o: PictureOptions,
  ) {}

  /** img shows the image written as raw: its source set now (before it loads), then kept picked */
  watch(img: HTMLImageElement, raw: string) {
    const r = this.resolve(raw);
    if (!r) {
      this.forget(img);
      if (img.getAttribute("src") !== raw) img.setAttribute("src", raw);
      return;
    }
    let s = this.shown.get(img);
    if (!s || s.raw !== raw) {
      s = { raw, want: 0, css: 0, on: "", gen: 0, broken: false, placed: false, cycle: this.cycle };
      this.shown.set(img, s);
      this.observer()?.observe(img);
      if (++this.added % SWEEP_EVERY === 0) this.sweep();
    }
    this.pick(img, s, r);
  }

  forget(img: HTMLImageElement) {
    if (this.shown.delete(img)) this.ro?.unobserve(img);
  }

  /** Pick again (the scale changed, a copy was made, images came on screen); root: only the images inside it */
  update(root?: ParentNode) {
    if (!root) {
      this.asked.clear();
      this.sweep();
    }
    for (const [img, s] of this.shown) {
      if (root && !root.contains(img)) continue;
      const r = this.resolve(s.raw);
      if (r) this.pick(img, s, r);
      else this.forget(img);
    }
  }

  /** An image that failed to load: true when it was a copy, which gives way to the original (the copies folder may be gone) */
  failed(img: HTMLImageElement): boolean {
    const s = this.shown.get(img),
      src = img.getAttribute("src");
    const r = s && this.resolve(s.raw);
    if (!s || !r || !src || src === r.src) return false;
    cappedAdd(this.bad, MAX, src);
    s.broken = true;
    s.on = "";
    this.pick(img, s, r);
    return true;
  }

  private pick(img: HTMLImageElement, s: Shown, r: ResolvedImage) {
    if (r.width && r.height && !img.hasAttribute("width")) {
      // a copy takes the original's space: its own size is smaller
      img.setAttribute("width", String(r.width));
      img.setAttribute("height", String(r.height));
    }
    if (img.dataset.full !== r.src) img.dataset.full = r.src;
    const fresh = !s.on || !(img.complete && img.naturalWidth > 0);
    if (!fresh && !(this.o.visible?.(img) ?? true)) return;
    const copies = sized(r) && !s.broken ? r.copies!.filter((c) => !(c.src && this.bad.has(c.src))) : [];
    const css = s.css || this.widths.get(s.raw) || Math.min(r.width || GUESS, GUESS);
    const best = pickCopy(copies, css * (this.o.scale?.() ?? (globalThis.devicePixelRatio || 1)));
    const want = best ? best.width : Infinity;
    // copies not known yet (the page asks the host): the original for now, the pick made once they are (0: none made), so an image
    // shown before its copies were known steps down to its copy once, then only up while it stays on the page
    if (!sized(r) && !s.broken) s.want = 0;
    else if (fresh || !s.want || want > s.want) s.want = want;
    let to = r.src;
    if (s.want && s.want !== Infinity) {
      const up = copies.filter((c) => c.width >= s.want).sort((a, b) => a.width - b.width);
      const c = up[0];
      if (c && !c.src) {
        const k = `${s.raw}\0${c.width}`;
        if (this.o.make && !this.asked.has(k)) {
          cappedAdd(this.asked, MAX, k);
          this.o.make(s.raw, c.width);
        }
        to = up.find((u) => u.src)?.src ?? (s.on && !fresh ? s.on : r.src);
      } else if (c) to = c.src!;
      else s.want = Infinity;
    }
    if (to === s.on) return;
    s.on = to;
    const g = ++s.gen;
    if (fresh) {
      // nothing on screen yet (or only what this render put there a moment ago): set at once, before it loads
      if (img.getAttribute("src") !== to) img.setAttribute("src", to);
      return;
    }
    // decoded before it replaces the source on screen: no blank frame
    const next = new Image();
    next.src = to;
    const swap = () => {
      if (s.gen === g && this.shown.get(img) === s) img.setAttribute("src", to);
    };
    next.decode().then(swap, swap);
  }

  private observer() {
    if (this.ro || typeof ResizeObserver === "undefined") return this.ro;
    this.ro = new ResizeObserver((es) => {
      for (const e of es) {
        const img = e.target as HTMLImageElement,
          s = this.shown.get(img),
          w = e.contentRect.width;
        if (!s) {
          this.ro!.unobserve(img);
          continue;
        }
        if (!w) continue;
        s.placed = true;
        if (Math.abs(w - s.css) < 1) continue;
        s.css = w;
        capped(this.widths, MAX, s.raw, w);
        const r = this.resolve(s.raw);
        if (r && sized(r)) this.pick(img, s, r);
      }
    });
    return this.ro;
  }

  /** Lets go of the images no longer on the page */
  private sweep() {
    for (const [img, s] of this.shown) if (!img.isConnected && (s.placed || s.cycle < this.cycle)) this.forget(img);
    this.cycle++;
  }
}

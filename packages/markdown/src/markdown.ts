// A configured Markdown instance: its resolvers, highlighter, math preamble, image addresses and the caches built under them.
// Everything that reads configuration (the static render, hydrate, the editor, the code blocks) takes the instance it belongs to,
// so two instances on one page never see each other's settings
import { Highlighter, type CodeHighlighter } from "./code";
import { Images, type ImageResolver } from "./image";
import { MathPreamble, type MathMacros } from "./math";
import { renderHtml, unwrapParagraph } from "./render";
import { copyTex, mdClick, paintRef, type ClickOpts, type Refs } from "./view";
import { AnnotFit } from "./annots";
import { undoubleTex } from "./doubled";
import { capped } from "./cache";
import { createMeasure, type Measure } from "./ui/measure";
import { createGhostHold, type GhostHold } from "./ui/ghost";
import type { PassKeys } from "./ui/editkeys";
import type { Diagrams } from "./diagram";

export type MarkdownOptions = {
  /** [[wiki link]] targets: resolve a label (and the id a reference picked from the [[ menu carries, [[label#^id]]) to what it
   *  points at (null: nothing), missing = the tooltip of one that is not found */
  refs?: Refs;
  /** Code highlighting (text → HTML with token classes); langId maps a language name to the id it is cached and asked under */
  highlight?: CodeHighlighter;
  langId?: (lang: string) => string;
  /** How image addresses resolve (or setAssetBase / setImageResolver later): the original's address and size, and the smaller
   *  copies there are of it (ResolvedImage.copies). The Markdown always keeps the address as written */
  images?: ImageResolver;
  /** Device pixels per CSS pixel an image is seen at: your page's zoom times devicePixelRatio (default devicePixelRatio). Each
   *  image shows the smallest copy still sharp at its laid-out width times this; call updateImages when it changes */
  displayScale?: () => number;
  /** Whether an image is on screen (default: every one): one that is not keeps the source it has until updateImages */
  imageVisible?: (img: HTMLImageElement) => boolean;
  /** Make the copy `width` wide that the resolver listed without a src for the image written as src; call updateImages once it
   *  is there (the resolver then gives its src) */
  makeImageCopy?: (src: string, width: number) => void;
  /** Load every image at once and draw it only decoded (no loading="lazy", decoding="sync"; default: lazy and async): for a page
   *  whose images come into view by a transform (a canvas zoomed out), where a lazy image is not loaded yet and an async one is
   *  drawn as nothing until it is decoded, a blank for a few frames */
  eagerImages?: boolean;
  /** \newcommand / \def lines every formula can use (or setMathPreamble later) */
  mathPreamble?: string;
  /** Unhandled keys inside the editors' inputs that still bubble out to the page (see keepKey in @yhnocoder/markdown/ui) */
  passKeys?: PassKeys;
  /** The page's measuring round (createMeasure from @yhnocoder/markdown/ui), shared with the page's own layout; default: its own */
  measure?: Measure;
  /** The page's hold on AI completions (createGhostHold from @yhnocoder/markdown/ui); default: its own */
  ghosts?: GhostHold;
};

/** A configured Markdown renderer: made by createMarkdown, passed to the editor (mountEditor) */
export interface Markdown {
  /** Markdown → HTML (cached by source; the cache is this instance's and follows its preamble and image addresses) */
  render(src: string): string;
  /** The same without the outer <p> when it is one paragraph (one-line captions) */
  renderInline(src: string): string;
  /** Whether render(src) is cached: it then costs a lookup */
  isCached(src: string): boolean;
  /** Call after putting render's HTML into el (innerHTML): [[ref]] targets, code highlighting, Mermaid diagrams, annotations,
   *  failed images, copying formulas as TeX */
  hydrate(el: HTMLElement, html: string): void;
  /** A click on rendered Markdown: links to openLink, [[refs]] to openRef, task checkboxes to onToggle (the new source); true
   *  when handled */
  click(e: MouseEvent, src: string, o: ClickOpts): boolean;
  /** Paint one [[ref]] (.md-ref) again, after what it resolves to changed (data that arrived later) */
  paintRef(el: HTMLElement): void;
  /** Set the math preamble; true when it changed. A change clears this instance's render cache (HTML already on the page stays:
   *  render it again) */
  setMathPreamble(src: string): boolean;
  /** KaTeX's message for each preamble definition it could not read */
  mathPreambleErrors(): readonly string[];
  /** The preamble's definitions as KaTeX macros (a new object each call), for your own katex.render */
  mathMacros(): MathMacros;
  /** Addresses under the folder dir (as written in the Markdown) are served from base; an empty base removes it */
  setAssetBase(dir: string, base: string): void;
  /** Resolve every image address yourself (null: as written) */
  setImageResolver(r: ImageResolver | null): void;
  /** Pick every shown image's source again: after the display scale changed, a copy was made (makeImageCopy) or the images
   *  inside root came on screen (root: only those) */
  updateImages(root?: ParentNode): void;
  /** Show the image written as src (an address the resolver knows, as in Markdown) in an <img> of your own, picked the way
   *  rendered images are: its src, width / height and data-full are set now and kept up; returns a function that stops */
  showImage(img: HTMLImageElement, src: string): () => void;
  /** Plain text where a formula copied from a web page reads as its glyphs followed by its TeX: the TeX as $…$ */
  undoubleTex(text: string): string;
}

const MAX = 4000;

/** The instance; the editor and code blocks reach its parts through coreOf */
export class Md implements Markdown {
  readonly math = new MathPreamble();
  readonly images: Images;
  readonly code: Highlighter;
  readonly refs: Refs;
  readonly passKeys: PassKeys | undefined;
  readonly measure: Measure;
  readonly ghosts: GhostHold;
  /** The editor entry's kept editor (editor/session.ts), built for this instance */
  editorPool: unknown;
  private cache = new Map<string, string>();
  /** The {text|note} labels' places (annots.ts), in the static render and the editor */
  readonly annots: AnnotFit;
  private diagrams: Promise<Diagrams> | undefined;
  private watched = new WeakSet<HTMLElement>();
  private copying = new WeakSet<HTMLElement>();

  constructor(o: MarkdownOptions) {
    this.refs = o.refs ?? { resolve: () => null };
    this.code = new Highlighter(o.highlight, o.langId);
    this.passKeys = o.passKeys;
    this.measure = o.measure ?? createMeasure();
    this.ghosts = o.ghosts ?? createGhostHold();
    this.annots = new AnnotFit(this.measure);
    // 解析换了全部重画；一张图学到了大小，带着它的那几篇重画（下次画时先留好位置）
    this.images = new Images(
      (raw) => {
        if (raw === undefined) return this.cache.clear();
        for (const k of [...this.cache.keys()]) if (k.includes(raw)) this.cache.delete(k);
      },
      { scale: o.displayScale, visible: o.imageVisible, make: o.makeImageCopy },
      !!o.eagerImages,
    );
    if (o.images) this.images.setResolver(o.images);
    if (o.mathPreamble) this.math.set(o.mathPreamble);
  }

  render = (src: string): string => {
    let h = this.cache.get(src);
    if (h !== undefined) return h;
    h = renderHtml(src, this);
    capped(this.cache, MAX, src, h);
    return h;
  };
  renderInline = (src: string) => unwrapParagraph(this.render(src));
  isCached = (src: string) => this.cache.has(src);

  hydrate(el: HTMLElement, html: string) {
    if (html.includes("data-latex") && !this.copying.has(el)) {
      this.copying.add(el);
      el.addEventListener("copy", copyTex);
    }
    if (html.includes("<img")) {
      // error does not bubble: caught on the way down
      if (!this.watched.has(el)) {
        this.watched.add(el);
        el.addEventListener("error", this.onImageError, true);
      }
      for (const img of el.querySelectorAll("img")) {
        // the source shown, set before the image starts loading (render puts the original's address in the HTML)
        if (!img.closest(".md-html")) this.images.watch(img);
        if (
          this.images.failedBefore(img.getAttribute("src")) ||
          (img.complete && !img.naturalWidth && img.getAttribute("src"))
        )
          this.images.fail(img);
      }
    }
    if (html.includes('class="md-ref"')) for (const r of el.querySelectorAll<HTMLElement>(".md-ref")) this.paintRef(r);
    if (html.includes(" data-lang=")) this.code.color(el);
    if (html.includes('class="mmd"'))
      void (this.diagrams ??= import("./diagram").then((m) => m.diagrams(this.measure))).then((d) => d.renderAll(el));
    if (html.includes('class="md-annot"')) this.annots.fit(el);
  }
  private onImageError = (e: Event) => {
    if (e.target instanceof HTMLImageElement && e.target.closest(".md")) this.images.fail(e.target);
  };

  click = (e: MouseEvent, src: string, o: ClickOpts) => mdClick(e, src, o, this.refs);
  paintRef = (el: HTMLElement) => paintRef(el, this.refs);

  setMathPreamble(src: string) {
    if (!this.math.set(src)) return false;
    this.cache.clear();
    return true;
  }
  mathPreambleErrors = () => this.math.problems();
  mathMacros = () => this.math.macrosCopy();
  setAssetBase = (dir: string, base: string) => this.images.setAssetBase(dir, base);
  setImageResolver = (r: ImageResolver | null) => this.images.setResolver(r);
  updateImages = (root?: ParentNode) => this.images.pictures.update(root);
  showImage = (img: HTMLImageElement, src: string) => {
    this.images.pictures.watch(img, src);
    return () => this.images.pictures.forget(img);
  };
  undoubleTex = (text: string) => undoubleTex(text, this.math);
}

export const createMarkdown = (o: MarkdownOptions = {}): Markdown => new Md(o);

/** The instance behind md, for the editor and code blocks */
export function coreOf(md: Markdown): Md {
  if (!(md instanceof Md)) throw new Error("Not a Markdown instance: make one with createMarkdown");
  return md;
}

// Animated images in a Note's static view, and image cards' images: GIFs, and SVGs that animate without script (md/animsvg.ts).
// Each one stands still on a frame (its snapshot: {frame=N} in the Markdown or the card's frame, the first by default) unless it
// is set to always play ({loop=true}, the card's loop), or it is selected and played. The <img> stays where it is for layout, clicks, menus and dragging, with nothing of it shown; drawn over it
// (positioned, no pointer events) is a canvas the GIF's frames are decoded into (ImageDecoder, off the main thread), or the SVG
// inline in a shadow root, whose CSS / SMIL timeline is paused and moved. A GIF that has one frame, an SVG that does not animate
// or an image whose bytes cannot be read (the web) stays the plain <img>.
// Playing images stop off screen and while the camera moves, like animated stickers; reduced motion never plays one by itself.
// The filmstrip of the selected image is ui/AnimStrip.tsx; selecting, keys and saving the playback are wired in installAnims
import { createEffect, createRoot, createSignal, on, untrack, type Accessor } from "solid-js";
import { ask } from "../host";
import { camMoving } from "../state/camera";
import { reduceMotion } from "../state/motion";
import { boardSignal } from "../state/root";
import { sel } from "../state/selection";
import { editing } from "../state/ui";
import { noteSrcOf } from "./images";
import { GIF_MIN_DELAY } from "../state/timing";
import { clockMs, inlineSvg } from "./animsvg";

/** One image in a Note: its address as written and which of the Note's images with that address it is (from 0). whole: the image
 *  is an image card's (cards/Card.tsx), its playback stored on the card, and the card is all there is to select */
export type AnimKey = { card: string; src: string; nth: number; whole?: true };
const same = (a: AnimKey, b: AnimKey) => a.card === b.card && a.src === b.src && a.nth === b.nth;
const idOf = (k: AnimKey) => `${k.card}\n${k.nth}\n${k.src}`;

/** Most thumbnails in a filmstrip: a longer GIF shows evenly spaced frames (each still jumps to its own frame) */
const MAX_THUMBS = 60;
/** Thumbnail height in board px (ui/AnimStrip.tsx lays them out); drawn at twice that for sharp screens */
export const THUMB_H = 24;
/** An SVG with data-steps="N" stands on each step this far into it (after the step's own movement), as the approved demo did */
const STEP_HOLD = 0.6;
/** An SVG without data-steps: this many stills, evenly spaced over its cycle */
const SVG_STILLS = 8;
const MAX_SVG_STEPS = 120;

type Kind = "gif" | "svg";
const kindOf = (src: string): Kind | null =>
  /^data:image\/gif[;,]/i.test(src) || /^[^?#]*\.gif(?:[?#]|$)/i.test(src)
    ? "gif"
    : /^data:image\/svg\+xml[;,]/i.test(src) || /^[^?#]*\.svg(?:[?#]|$)/i.test(src)
      ? "svg"
      : null;

// ---------- bytes, by address (assets/ names carry their content's hash) ----------
const BYTES_MAX = 16;
const bytes = new Map<string, Promise<Uint8Array | null>>();
function dataBytes(url: string): Uint8Array | null {
  const i = url.indexOf(",");
  if (!url.startsWith("data:") || i < 0) return null;
  const body = url.slice(i + 1);
  if (!/;base64$/i.test(url.slice(0, i))) return new TextEncoder().encode(decodeURIComponent(body));
  const bin = atob(body),
    out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}
function bytesOf(src: string): Promise<Uint8Array | null> {
  let p = bytes.get(src);
  if (p) bytes.delete(src);
  else if (src.startsWith("data:")) p = Promise.resolve(dataBytes(src));
  else if (src.startsWith("assets/"))
    p = ask("readAsset", { file: src.slice(7) })
      .then(dataBytes)
      .catch(() => null);
  else p = Promise.resolve(null);
  bytes.set(src, p);
  if (bytes.size > BYTES_MAX) bytes.delete(bytes.keys().next().value!);
  return p;
}
const svgMarkup = new Map<string, Promise<string | null>>();
function svgOf(src: string): Promise<string | null> {
  let p = svgMarkup.get(src);
  if (!p) {
    p = bytesOf(src).then((b) => (b ? inlineSvg(new TextDecoder().decode(b)) : null));
    svgMarkup.set(src, p);
    if (svgMarkup.size > BYTES_MAX) svgMarkup.delete(svgMarkup.keys().next().value!);
  }
  return p;
}

// ---------- the players ----------
/** The Markdown's images, by the static view they are in (registered by MdStatic, dropped when it repaints or unmounts) */
const byView = new Map<HTMLElement, Player[]>();
const [players, bumpPlayers] = createSignal(0, { equals: false });
/** Players that play now: one frame loop drives them all */
const running = new Set<Player>();
let raf = 0;
function frame(t: number) {
  raf = 0;
  for (const p of running) p.tick(t);
  if (running.size) raf = requestAnimationFrame(frame);
}
const wake = () => {
  if (!raf && running.size) raf = requestAnimationFrame(frame);
};

let seen: IntersectionObserver | undefined, sized: ResizeObserver | undefined;
const watchers = new WeakMap<Element, Player[]>();
function watch(el: Element, p: Player) {
  sized ??= new ResizeObserver((es) => {
    for (const e of es) for (const q of watchers.get(e.target) ?? []) q.place();
  });
  const l = watchers.get(el);
  if (l) l.push(p);
  else {
    watchers.set(el, [p]);
    sized.observe(el);
  }
}
function unwatch(el: Element, p: Player) {
  const l = watchers.get(el)?.filter((q) => q !== p);
  if (l?.length) watchers.set(el, l);
  else {
    watchers.delete(el);
    sized?.unobserve(el);
  }
}

/** What a filmstrip shows: one element per still, and the frame each one stands for */
export type Thumbs = { els: HTMLElement[]; frames: number[] };
type Handoff = { frame: number; time?: number; want: boolean | null; still?: HTMLCanvasElement };

export abstract class Player {
  readonly frame: Accessor<number>;
  protected setFrame: (n: number) => void;
  /** Frames (GIF) or steps (SVG); 0 until known */
  readonly count: Accessor<number>;
  protected setCount: (n: number) => void;
  /** Played now by the user (while selected), or always (loop) */
  readonly on: Accessor<boolean>;
  private setOn: (v: boolean) => void;
  /** The Markdown's {loop=true} and {frame=N} (from 0), as this view was drawn with */
  readonly loop: boolean;
  readonly stored: number;
  readonly host: HTMLSpanElement;
  protected view: HTMLElement;
  /** Drawn: the <img> is hidden behind it */
  mounted = false;
  protected dead = false;
  protected live = false;
  private visible = true;
  private want: boolean | null = null;

  constructor(
    readonly key: AnimKey,
    readonly img: HTMLImageElement,
    readonly box: HTMLElement,
    protected handoff?: Handoff,
  ) {
    [this.frame, this.setFrame] = createSignal(0);
    [this.count, this.setCount] = createSignal(0);
    [this.on, this.setOn] = createSignal(false);
    this.loop = img.hasAttribute("data-loop");
    this.stored = Math.max(0, (Number(img.dataset.frame) || 1) - 1);
    this.want = handoff?.want ?? null;
    this.host = document.createElement("span");
    this.host.className = "md-anim";
    this.host.dataset.export = "strip";
    this.host.classList.toggle("loop", this.loop);
    const sr = this.host.attachShadow({ mode: "open" });
    sr.innerHTML =
      "<style>:host{display:block}.v{display:block;width:100%;height:100%}.v>canvas{display:block;width:100%;height:100%}" +
      ".b{position:absolute;top:6px;right:6px;padding:1px 7px;border-radius:999px;font:500 10.5px/1.5 system-ui,sans-serif;" +
      "color:var(--ink-2);background:var(--surface);box-shadow:0 0 0 1px var(--line);opacity:0;transition:opacity .14s;" +
      "pointer-events:none;white-space:nowrap}:host(.loop.hover) .b{opacity:1}</style>";
    this.view = document.createElement("span");
    this.view.className = "v";
    const badge = document.createElement("span");
    badge.className = "b";
    badge.textContent = "Always playing";
    sr.append(this.view, badge);
  }

  /** Shows the image drawn here instead of the <img>, and starts following its place */
  protected mount() {
    if (this.dead || this.mounted || !this.img.isConnected) return;
    this.mounted = true;
    this.host.style.borderRadius = getComputedStyle(this.img).borderRadius;
    this.img.before(this.host);
    this.img.classList.add("md-animsrc");
    this.hoverEl.addEventListener("pointerenter", this.hover);
    this.hoverEl.addEventListener("pointerleave", this.hover);
    this.place();
    watch(this.img, this);
    watch(this.box, this);
    seen ??= new IntersectionObserver((es) => {
      for (const e of es) for (const p of watchers.get(e.target) ?? []) p.seen(e.isIntersecting);
    });
    watch(this.host, this);
    seen.observe(this.host);
    bumpPlayers(0);
  }
  private hover = (e: PointerEvent) => this.host.classList.toggle("hover", e.type === "pointerenter");
  /** An image card's <img> takes no pointer events (the card is dragged by its box): the box is what is hovered */
  private get hoverEl(): HTMLElement {
    return this.key.whole ? this.box : this.img;
  }
  private seen(v: boolean) {
    this.visible = v;
    this.sync();
  }

  /** Over its <img>: offsets in layout px up to the overlay's containing block (the camera's scale does not count) */
  place() {
    const cb = this.host.offsetParent;
    if (!this.mounted || !cb) return;
    let x = 0,
      y = 0;
    for (let e: Element | null = this.img; e && e !== cb; e = (e as HTMLElement).offsetParent) {
      x += (e as HTMLElement).offsetLeft;
      y += (e as HTMLElement).offsetTop;
    }
    const s = this.host.style;
    s.left = `${x}px`;
    s.top = `${y}px`;
    s.width = `${this.img.offsetWidth}px`;
    s.height = `${this.img.offsetHeight}px`;
  }

  /** Plays while it should: asked to (selected) or always (loop, not under reduced motion), on screen, the camera still */
  sync() {
    const on = this.want ?? (this.loop && !reduceMotion());
    this.setOn(on && this.count() > 1);
    const go = this.mounted && !this.dead && on && this.visible && !camMoving() && this.count() > 1;
    if (go === this.live) return;
    this.live = go;
    if (go) {
      running.add(this);
      this.start();
      wake();
    } else {
      running.delete(this);
      this.stop();
    }
  }
  /** Play (true) or stand still (false) at the frame it is on; null: as the Markdown says (loop) */
  play(v: boolean | null) {
    this.want = v;
    this.sync();
  }
  /** Stand still on frame i (wraps around) */
  seek(i: number) {
    const n = this.count();
    if (!n) return;
    this.want = false;
    this.sync();
    this.show(((i % n) + n) % n);
  }
  step(d: number) {
    this.seek(this.frame() + d);
  }
  /** Releases what it holds and gives its <img> back; what it shows passes on to the player that takes its place (handoff) */
  dispose(): Handoff | undefined {
    if (this.dead) return;
    this.dead = true;
    running.delete(this);
    this.stop();
    unwatch(this.img, this);
    unwatch(this.box, this);
    unwatch(this.host, this);
    seen?.unobserve(this.host);
    this.hoverEl.removeEventListener("pointerenter", this.hover);
    this.hoverEl.removeEventListener("pointerleave", this.hover);
    this.img.classList.remove("md-animsrc");
    this.host.remove();
    return this.mounted ? { frame: this.frame(), want: this.want, ...this.passOn() } : undefined;
  }
  abstract tick(t: number): void;
  abstract thumbs(): Thumbs;
  /** Called by the filmstrip once the thumbnails are on the page */
  thumbsShown() {}
  protected abstract start(): void;
  protected abstract stop(): void;
  protected abstract show(i: number): void;
  protected abstract passOn(): Partial<Handoff>;
}

// ---------- GIF ----------
type Decoded = { image: VideoFrame };
/** A frame's delay: GIFs that ask for none or 10 ms play at GIF_MIN_DELAY, as browsers do */
const delayOf = (f: VideoFrame) => {
  const ms = (f.duration ?? 0) / 1000;
  return ms <= 10 ? GIF_MIN_DELAY : ms;
};
/** Thumbnails by GIF, filled once (content-addressed) */
const gifThumbs = new Map<string, Thumbs>();
function sample(n: number): number[] {
  if (n <= MAX_THUMBS) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: MAX_THUMBS }, (_, k) => Math.round((k * (n - 1)) / (MAX_THUMBS - 1)));
}
const thumbWidth = (img: HTMLImageElement) => {
  const w = img.naturalWidth || Number(img.getAttribute("width")) || 4,
    h = img.naturalHeight || Number(img.getAttribute("height")) || 3;
  return Math.max(18, Math.min(64, Math.round((THUMB_H * w) / h)));
};

class GifPlayer extends Player {
  private canvas = document.createElement("canvas");
  private dec: ImageDecoder | null = null;
  private data: Uint8Array | null = null;
  private delays: number[] = [];
  private due = 0;
  private next: { frame: VideoFrame; i: number } | null = null;
  private busy = false;
  private gen = 0;

  constructor(key: AnimKey, img: HTMLImageElement, box: HTMLElement, handoff?: Handoff) {
    super(key, img, box, handoff);
    this.view.append(this.canvas);
    void this.init();
  }
  private async init() {
    if (typeof ImageDecoder === "undefined") return;
    const b = await bytesOf(this.key.src);
    if (!b || this.dead) return;
    this.data = b;
    const dec = new ImageDecoder({ data: b, type: "image/gif" });
    try {
      await dec.tracks.ready;
      await dec.completed;
    } catch {
      dec.close();
      return;
    }
    const n = dec.tracks.selectedTrack?.frameCount ?? 0;
    if (this.dead || n < 2) return dec.close();
    this.dec = dec;
    this.setCount(n);
    const h = this.handoff;
    if (h?.still) {
      this.size(h.still.width, h.still.height);
      this.canvas.getContext("2d")!.drawImage(h.still, 0, 0);
      this.setFrame(Math.min(h.frame, n - 1));
      this.mount();
    } else await this.draw(Math.min(n - 1, h ? h.frame : this.stored));
    this.handoff = undefined;
    this.sync();
  }
  private size(w: number, h: number) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }
  private paint(f: VideoFrame, i: number) {
    this.size(f.displayWidth, f.displayHeight);
    this.canvas.getContext("2d")!.drawImage(f, 0, 0);
    this.delays[i] = delayOf(f);
    this.setFrame(i);
    this.mount();
  }
  private async draw(i: number) {
    const g = ++this.gen;
    const r = (await this.dec!.decode({ frameIndex: i }).catch(() => null)) as Decoded | null;
    if (!r) return;
    if (g === this.gen && !this.dead) this.paint(r.image, i);
    r.image.close();
  }
  protected show(i: number) {
    void this.draw(i);
  }
  private prefetch() {
    if (this.busy || this.next || !this.dec || !this.live) return;
    this.busy = true;
    const g = this.gen,
      i = (this.frame() + 1) % this.count();
    this.dec
      .decode({ frameIndex: i })
      .then((r) => {
        if (g !== this.gen || this.dead || !this.live) r.image.close();
        else this.next = { frame: r.image, i };
      })
      .catch(() => {})
      .finally(() => {
        this.busy = false;
      });
  }
  tick(t: number) {
    if (this.next && t >= this.due) {
      this.paint(this.next.frame, this.next.i);
      this.next.frame.close();
      this.next = null;
      this.due = t + (this.delays[this.frame()] ?? GIF_MIN_DELAY);
    }
    this.prefetch();
  }
  protected start() {
    this.gen++;
    this.due = performance.now() + (this.delays[this.frame()] ?? GIF_MIN_DELAY);
    this.prefetch();
  }
  protected stop() {
    this.gen++;
    this.next?.frame.close();
    this.next = null;
  }
  dispose() {
    const h = super.dispose();
    this.dec?.close();
    this.dec = null;
    return h;
  }
  protected passOn() {
    return { still: this.canvas };
  }
  thumbs(): Thumbs {
    let t = gifThumbs.get(this.key.src);
    if (t) return t;
    const frames = sample(this.count()),
      w = thumbWidth(this.img);
    t = {
      frames,
      els: frames.map((i) => {
        const c = document.createElement("canvas");
        c.width = w * 2;
        c.height = THUMB_H * 2;
        c.title = `Frame ${i + 1}`;
        return c;
      }),
    };
    gifThumbs.set(this.key.src, t);
    if (gifThumbs.size > BYTES_MAX) gifThumbs.delete(gifThumbs.keys().next().value!);
    if (this.data) void fillThumbs(this.data, t);
    return t;
  }
}
/** Decodes the stills with a decoder of their own (in order: a GIF decodes forward), each scaled down off the main thread */
async function fillThumbs(data: Uint8Array, t: Thumbs) {
  const dec = new ImageDecoder({ data, type: "image/gif" });
  try {
    for (let k = 0; k < t.frames.length; k++) {
      const c = t.els[k] as HTMLCanvasElement;
      const r = await dec.decode({ frameIndex: t.frames[k] });
      const bm = await createImageBitmap(r.image, {
        resizeWidth: c.width,
        resizeHeight: c.height,
        resizeQuality: "medium",
      });
      r.image.close();
      c.getContext("2d")!.drawImage(bm, 0, 0);
      bm.close();
    }
  } catch {
    /* a still that cannot be decoded stays blank */
  } finally {
    dec.close();
  }
}

// ---------- SVG ----------
const FREEZE = (ms: number) =>
  `<style>:host{display:block;width:100%;height:100%}svg{display:block;width:100%;height:100%}` +
  `svg,svg *{animation-play-state:paused!important;animation-delay:${-ms}ms!important}</style>`;

class SvgPlayer extends Player {
  private svg: SVGSVGElement | null = null;
  private anims: Animation[] = [];
  private smil = false;
  private cycle = 1000;
  private hold = 0;
  private markup = "";
  private th: Thumbs | null = null;

  constructor(key: AnimKey, img: HTMLImageElement, box: HTMLElement, handoff?: Handoff) {
    super(key, img, box, handoff);
    void this.init();
  }
  private async init() {
    const m = await svgOf(this.key.src);
    if (!m || this.dead || !this.img.isConnected) return;
    this.markup = m;
    const root = this.view.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:block;width:100%;height:100%}svg{display:block;width:100%;height:100%}</style>${m}`;
    this.svg = root.querySelector("svg");
    if (!this.svg) return;
    this.mount();
    if (!this.mounted) return;
    // only once connected does the SVG have animations to read
    this.anims = root.getAnimations();
    this.smil = !!this.svg.querySelector("animate, set, animateTransform, animateMotion");
    const ends = [
      ...this.anims.map((a) => {
        const t = a.effect?.getTiming();
        return (Number(t?.delay) || 0) + (typeof t?.duration === "number" ? t.duration : 0);
      }),
      ...[...this.svg.querySelectorAll("animate, set, animateTransform, animateMotion")].map(
        (e) => (clockMs(e.getAttribute("begin")) || 0) + (clockMs(e.getAttribute("dur")) || 0),
      ),
    ];
    this.cycle = Math.max(0, ...ends.filter(Number.isFinite)) || 1000;
    const steps = Math.round(Number(this.svg.getAttribute("data-steps")));
    this.hold = steps >= 1 ? STEP_HOLD : 0;
    this.setCount(steps >= 1 ? Math.min(steps, MAX_SVG_STEPS) : SVG_STILLS);
    const h = this.handoff;
    this.handoff = undefined;
    if (h?.time !== undefined) {
      this.at(h.time);
      this.setFrame(Math.min(h.frame, this.count() - 1));
    } else this.show(Math.min(this.count() - 1, h ? h.frame : this.stored));
    this.sync();
  }
  private timeOf = (i: number) => ((i + this.hold) * this.cycle) / this.count();
  private now() {
    const a = this.anims[0];
    const t = a ? Number(a.currentTime ?? 0) : this.smil && this.svg ? this.svg.getCurrentTime() * 1000 : 0;
    return ((t % this.cycle) + this.cycle) % this.cycle;
  }
  private at(t: number) {
    for (const a of this.anims) {
      a.pause();
      a.currentTime = t;
    }
    if (this.smil && this.svg) {
      this.svg.pauseAnimations();
      this.svg.setCurrentTime(t / 1000);
    }
  }
  protected show(i: number) {
    this.at(this.timeOf(i));
    this.setFrame(i);
  }
  tick() {
    const i = Math.min(this.count() - 1, Math.floor((this.now() * this.count()) / this.cycle));
    if (i !== this.frame()) this.setFrame(i);
  }
  protected start() {
    for (const a of this.anims) a.play();
    if (this.smil) this.svg?.unpauseAnimations();
  }
  protected stop() {
    for (const a of this.anims) a.pause();
    if (this.smil) this.svg?.pauseAnimations();
  }
  protected passOn() {
    return { time: this.svg ? this.now() : undefined };
  }
  thumbs(): Thumbs {
    if (this.th) return this.th;
    const w = thumbWidth(this.img),
      frames = Array.from({ length: this.count() }, (_, i) => i);
    this.th = {
      frames,
      els: frames.map((i) => {
        const d = document.createElement("span");
        d.className = "tsvg";
        d.style.width = `${w}px`;
        d.title = `Step ${i + 1}`;
        // frozen by CSS (paused, a negative delay), so a still is right before it is on the page
        d.attachShadow({ mode: "open" }).innerHTML = FREEZE(this.timeOf(i)) + this.markup;
        return d;
      }),
    };
    return this.th;
  }
  thumbsShown() {
    if (!this.smil || !this.th) return;
    this.th.els.forEach((d, i) => {
      const s = d.shadowRoot?.querySelector("svg");
      if (!s?.isConnected) return;
      s.pauseAnimations();
      s.setCurrentTime(this.timeOf(i) / 1000);
    });
  }
}

/** Draws the animated images of a Note's static view `box` (just painted) as players; the ones it had before are dropped */
export function attachAnims(box: HTMLElement, card: string) {
  const nth = new Map<string, number>(),
    found: [AnimKey, HTMLImageElement][] = [];
  for (const img of box.querySelectorAll("img")) {
    const shown = img.getAttribute("src");
    if (!shown || img.closest(".md-html")) continue;
    const src = noteSrcOf(shown),
      k = nth.get(src) ?? 0;
    nth.set(src, k + 1);
    found.push([{ card, src, nth: k }, img]);
  }
  attach(box, found);
}
/** An image card's image `img` (in its box), whose address on the board is src (assets/… or a data: URL); its <img> carries the
 *  card's frame and loop as a Note image's does (data-frame, data-loop). Called again when any of those change */
export function attachCardAnim(box: HTMLElement, card: string, img: HTMLImageElement, src: string) {
  attach(box, [[{ card, src, nth: 0, whole: true }, img]]);
}
function attach(box: HTMLElement, found: [AnimKey, HTMLImageElement][]) {
  const old = new Map<string, Handoff>();
  for (const p of byView.get(box) ?? []) {
    const h = p.dispose();
    if (h) old.set(idOf(p.key), h);
  }
  byView.delete(box);
  const list: Player[] = [];
  for (const [key, img] of found) {
    const kind = kindOf(key.src);
    if (kind) list.push(new (kind === "gif" ? GifPlayer : SvgPlayer)(key, img, box, old.get(idOf(key))));
  }
  if (list.length) byView.set(box, list);
  bumpPlayers(0);
}
/** The view is gone (unmounted) */
export function detachAnims(box: HTMLElement) {
  const l = byView.get(box);
  if (!l) return;
  for (const p of l) p.dispose();
  byView.delete(box);
  bumpPlayers(0);
}

/** The drawn player for an image (tracks players coming and going) */
function playerOf(k: AnimKey): Player | undefined {
  players();
  for (const l of byView.values()) for (const p of l) if (p.mounted && same(p.key, k)) return p;
  return undefined;
}
/** The drawn player whose <img> or overlay is el */
export function playerAt(el: Element | null): Player | undefined {
  const img = el?.closest?.("img.md-animsrc");
  if (!img) return undefined;
  for (const l of byView.values()) for (const p of l) if (p.img === img && p.mounted) return p;
  return undefined;
}

// ---------- the selected image ----------
const [selKey, setSelKey] = boardSignal<AnimKey | null>(null);
/** The selected animated image's player */
export const selectedAnim = () => {
  const k = selKey();
  return k ? playerOf(k) : undefined;
};
export function selectAnim(p: Player) {
  const k = selKey();
  if (k && same(k, p.key)) return;
  if (k) deselectAnim();
  setSelKey(p.key);
}

/** Saves an image's playback ({frame=N loop=true}) into its Note; wired by installAnims */
export type SavePlayback = (k: AnimKey, p: { frame?: number | null; loop?: boolean }) => void;
let save: SavePlayback = () => {};

/** Deselects: a played image stands still where it is, and that frame is its snapshot from now on (saved), unless it always
 *  plays. keep: do not save (its Note is being edited, which writes the Markdown itself) */
function deselectAnim(keep = false) {
  const k = selKey();
  if (!k) return;
  setSelKey(null);
  const p = playerOf(k);
  if (!p) return;
  p.play(null);
  if (!keep && !p.loop && p.frame() !== p.stored) save(k, { frame: p.frame() + 1 });
}

/** Always play this image, or stop that (standing on the frame it is on) */
export function toggleLoop(p: Player) {
  if (p.loop) save(p.key, { loop: false, frame: p.frame() + 1 });
  else save(p.key, { loop: true });
}

/** Wiring (wire.ts): the camera stops and restarts what plays; the selected image deselects when its Note is no longer the one
 *  selected card, when the Note is edited, or on a press anywhere but the image and its filmstrip; saving the playback */
export function installAnims(o: { save: SavePlayback }) {
  save = o.save;
  createRoot(() => {
    createEffect(
      on(
        camMoving,
        () => {
          for (const l of byView.values()) for (const p of l) p.sync();
        },
        { defer: true },
      ),
    );
    createEffect(() => {
      const s = selectedAnim();
      for (const l of byView.values()) for (const p of l) p.host.classList.toggle("sel", p === s);
    });
    createEffect(() => {
      const k = selKey();
      if (!k) return;
      // editing an image card's description writes nothing of its image: the frame is saved as on any deselect
      if (editing()?.id === k.card) deselectAnim(!k.whole);
      else if (sel.cards.length !== 1 || sel.cards[0] !== k.card) deselectAnim();
    });
    // an image card is its image: selecting the card alone selects that
    createEffect(() => {
      const id = sel.cards.length === 1 ? sel.cards[0] : undefined;
      if (!id || editing()?.id === id) return;
      players();
      for (const l of byView.values())
        for (const p of l) if (p.key.whole && p.key.card === id && p.mounted) return untrack(() => selectAnim(p));
    });
  });
  window.addEventListener(
    "pointerdown",
    (e) => {
      const p = selectedAnim(),
        t = e.target as Element | null;
      // an image card's image goes with the card's selection only
      if (p && !p.key.whole && t !== p.img && !t?.closest?.(".animstrip")) deselectAnim();
    },
    true,
  );
}

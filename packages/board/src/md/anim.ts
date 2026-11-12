// Animated images in a Note's static view, and image cards' images: GIFs, and SVGs that animate without script (md/animsvg.ts).
// Each one stands still on a frame (its snapshot: {frame=N} in the Markdown or the card's frame, the first by default) unless it
// is set to always play ({loop=true}, the card's loop), or it is selected and played. The <img> stays where it is for layout, clicks, menus and dragging, with nothing of it shown; drawn over it
// (positioned, no pointer events) is a canvas the GIF's frames are decoded into (ImageDecoder, off the main thread), or the SVG
// inline in a shadow root, whose CSS / SMIL timeline is paused and moved. A GIF that has one frame, an SVG that does not animate
// or an image whose bytes cannot be read (the web) stays the plain <img>.
// Playing images stop off screen and while the camera moves, like animated stickers; reduced motion never plays one by itself.
// The control bar floating at the bottom of each image is ui/AnimBar.tsx; selecting, keys and saving the playback are wired in
// installAnims
import { createEffect, createRoot, createSignal, on, untrack, type Accessor } from "solid-js";
import { render } from "solid-js/web";
import { ask } from "../host";
import { camMoving } from "../state/camera";
import { reduceMotion } from "../state/motion";
import { boardSignal } from "../state/root";
import { select, sel } from "../state/selection";
import { editing } from "../state/ui";
import { noteImageSrc } from "./images";
import { GIF_MIN_DELAY } from "../state/timing";
import { clockMs, inlineSvg } from "./animsvg";
import { cssTrack, frameAt, phaseOf, smilTracks, svgFrames, type SvgFrames } from "./svgframes";
import { AnimBar, BAR_MIN_W } from "../ui/AnimBar";

/** One image in a Note: its address as written and which of the Note's images with that address it is (from 0). whole: the image
 *  is an image card's (cards/Card.tsx), its playback stored on the card, and the card is all there is to select */
export type AnimKey = { card: string; src: string; nth: number; whole?: true };
const same = (a: AnimKey, b: AnimKey) => a.card === b.card && a.src === b.src && a.nth === b.nth;
const idOf = (k: AnimKey) => `${k.card}\n${k.nth}\n${k.src}`;

/** An SVG with data-steps="N" stands on each step this far into it (after the step's own movement), as the approved demo did */
const STEP_HOLD = 0.6;
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
  /** The pointer is over the image or its bar */
  readonly hovered: Accessor<boolean>;
  private setHovered: (v: boolean) => void;
  /** Played (true) or stood still (false) by the user; null: as the Markdown says */
  readonly want: Accessor<boolean | null>;
  private setWant: (v: boolean | null) => void;
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
  private bar?: () => void;

  constructor(
    readonly key: AnimKey,
    readonly img: HTMLImageElement,
    readonly box: HTMLElement,
    protected handoff?: Handoff,
  ) {
    [this.frame, this.setFrame] = createSignal(0);
    [this.count, this.setCount] = createSignal(0);
    [this.on, this.setOn] = createSignal(false);
    [this.hovered, this.setHovered] = createSignal(false);
    [this.want, this.setWant] = createSignal(handoff?.want ?? null);
    this.loop = img.hasAttribute("data-loop");
    this.stored = Math.max(0, (Number(img.dataset.frame) || 1) - 1);
    // what the image showed passes on, unless it stood on its snapshot (neither played nor held by the user, not always playing)
    // and the snapshot is another now (an undo, another window's edit): then it shows that one
    if (handoff && handoff.want === null && !this.loop && handoff.frame !== this.stored) this.handoff = undefined;
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
    // the control bar (ui/AnimBar.tsx) is the host's own child, shown through the slot: the board's styles and tips reach it
    this.view = document.createElement("span");
    this.view.className = "v";
    const badge = document.createElement("span");
    badge.className = "b";
    badge.textContent = "Always playing";
    sr.append(this.view, badge, document.createElement("slot"));
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
    // drawn again under a pointer that is already there (its Note repainted): hovered without a pointerenter
    if (this.hoverEl.matches(":hover")) {
      this.setHovered(true);
      this.host.classList.add("hover");
    }
    this.bar = render(
      () =>
        AnimBar({
          p: this,
          selected: () => {
            const k = selKey();
            return !!k && same(k, this.key);
          },
          grab: () => grabAnim(this),
          toggleLoop: () => toggleLoop(this),
        }),
      this.host,
    );
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
  /** Over the image or its bar (moving between the two is not leaving) */
  hover = (e: PointerEvent) => {
    const to = e.relatedTarget as Node | null,
      on = e.type === "pointerenter";
    if (!on && to && (this.host.contains(to) || this.hoverEl.contains(to))) return;
    this.setHovered(on);
    this.host.classList.toggle("hover", on);
  };
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
    const s = this.host.style,
      w = this.img.offsetWidth;
    s.left = `${x}px`;
    s.top = `${y}px`;
    s.width = `${w}px`;
    s.height = `${this.img.offsetHeight}px`;
    // a narrow image's bar is drawn smaller, to fit inside it
    s.setProperty("--fit", String(Math.max(0.3, Math.min(1, (w - 12) / BAR_MIN_W))));
  }

  /** Plays while it should: asked to (selected) or always (loop, not under reduced motion), on screen, the camera still */
  sync() {
    const on = untrack(this.want) ?? (this.loop && !reduceMotion());
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
    this.setWant(v);
    this.sync();
  }
  /** Stand still on frame i (wraps around) */
  seek(i: number) {
    const n = this.count();
    if (!n) return;
    this.setWant(false);
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
    this.bar?.();
    this.host.remove();
    return this.mounted ? { frame: this.frame(), want: this.want(), ...this.passOn() } : undefined;
  }
  abstract tick(t: number): void;
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
class GifPlayer extends Player {
  private canvas = document.createElement("canvas");
  private dec: ImageDecoder | null = null;
  private delays: number[] = [];
  private due = 0;
  private next: { frame: VideoFrame; i: number } | null = null;
  private busy = false;
  private gen = 0;
  /** A still asked for while one is being decoded (a scrub outruns the decoder): only the last one asked is drawn */
  private drawing = false;
  private pending = -1;

  constructor(key: AnimKey, img: HTMLImageElement, box: HTMLElement, handoff?: Handoff) {
    super(key, img, box, handoff);
    this.view.append(this.canvas);
    void this.init();
  }
  private async init() {
    if (typeof ImageDecoder === "undefined") return;
    const b = await bytesOf(this.key.src);
    if (!b || this.dead) return;
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
    this.pending = i;
    if (!this.drawing) void this.pump();
  }
  private async pump() {
    this.drawing = true;
    while (this.pending >= 0 && !this.dead) {
      const i = this.pending;
      this.pending = -1;
      await this.draw(i);
    }
    this.drawing = false;
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
}

// ---------- SVG ----------
const SMIL = "animate, set, animateTransform, animateMotion";
/** An SVG's frames: with data-steps="N" on its root, N evenly over its longest animation, each stood on STEP_HOLD into it;
 *  otherwise inferred from its animations (md/svgframes.ts) */
function framesOf(svg: SVGSVGElement, anims: Animation[]): SvgFrames {
  const steps = Math.round(Number(svg.getAttribute("data-steps")));
  if (steps >= 1) {
    const ends = [
      ...anims.map((a) => {
        const t = a.effect?.getTiming();
        return (Number(t?.delay) || 0) + (typeof t?.duration === "number" ? t.duration : 0);
      }),
      ...[...svg.querySelectorAll(SMIL)].map(
        (e) => (clockMs(e.getAttribute("begin")) || 0) + (clockMs(e.getAttribute("dur")) || 0),
      ),
    ];
    const cycle = Math.max(0, ...ends.filter(Number.isFinite)) || 1000,
      n = Math.min(steps, MAX_SVG_STEPS);
    const starts = Array.from({ length: n }, (_, i) => (i * cycle) / n);
    return { starts, stands: starts.map((t) => t + (STEP_HOLD * cycle) / n), intro: 0, period: cycle };
  }
  const tracks = [...anims.map(cssTrack), ...[...svg.querySelectorAll(SMIL)].flatMap(smilTracks)];
  return svgFrames(tracks.filter((t) => !!t)) ?? { starts: [0], stands: [0], intro: 0, period: 0 };
}

class SvgPlayer extends Player {
  private svg: SVGSVGElement | null = null;
  private anims: Animation[] = [];
  private smil = false;
  private frames: SvgFrames = { starts: [0], stands: [0], intro: 0, period: 0 };
  /** Standing still with its CSS animations cancelled (freeze), on time t; the elements' own style attributes, to give back */
  private frozen = false;
  private t = 0;
  private styles = new Map<Element, string | null>();

  constructor(key: AnimKey, img: HTMLImageElement, box: HTMLElement, handoff?: Handoff) {
    super(key, img, box, handoff);
    void this.init();
  }
  private async init() {
    const m = await svgOf(this.key.src);
    if (!m || this.dead || !this.img.isConnected) return;
    const root = this.view.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{display:block;width:100%;height:100%}svg{display:block;width:100%;height:100%}</style>${m}`;
    this.svg = root.querySelector("svg");
    if (!this.svg) return;
    this.mount();
    if (!this.mounted) return;
    // only once connected does the SVG have animations to read
    this.anims = root.getAnimations();
    this.smil = !!this.svg.querySelector(SMIL);
    this.frames = framesOf(this.svg, this.anims);
    this.setCount(this.frames.starts.length);
    const h = this.handoff;
    this.handoff = undefined;
    if (h?.time !== undefined) {
      this.at(h.time);
      this.setFrame(Math.min(h.frame, this.count() - 1));
    } else this.show(Math.min(this.count() - 1, h ? h.frame : this.stored));
    this.sync();
  }
  /** Where on its cycle it is now */
  private now() {
    if (this.frozen) return phaseOf(this.frames, this.t);
    const a = this.anims[0];
    const t = a ? Number(a.currentTime ?? 0) : this.smil && this.svg ? this.svg.getCurrentTime() * 1000 : 0;
    return phaseOf(this.frames, t);
  }
  /** Stands still on time t: paused there, and frozen (below) unless it plays */
  private at(t: number) {
    this.t = t;
    this.thaw();
    for (const a of this.anims) {
      a.pause();
      a.currentTime = t;
    }
    if (this.smil && this.svg) {
      this.svg.pauseAnimations();
      this.svg.setCurrentTime(t / 1000);
    }
    if (!this.live) this.freeze();
  }
  /** Standing still, the CSS animations' values at the time it stands on are written into the style of the elements they move
   *  and the animations are cancelled: a paused animation of a transform keeps its element a compositor layer, rastered at the
   *  scale it was first drawn at whatever the zoom (a frozen SVG shown at 0.35 kept layers rastered at 1.0) */
  private freeze() {
    if (this.frozen) return;
    this.frozen = true;
    for (const a of this.anims) {
      const el = (a.effect as KeyframeEffect | null)?.target;
      if (el && !this.styles.has(el)) this.styles.set(el, el.getAttribute("style"));
      try {
        a.commitStyles();
      } catch {
        /* not rendered: nothing to keep */
      }
      a.cancel();
    }
  }
  /** Gives the elements their own style back and the animations their time, paused there */
  private thaw() {
    if (!this.frozen) return;
    this.frozen = false;
    for (const [el, st] of this.styles) st === null ? el.removeAttribute("style") : el.setAttribute("style", st);
    this.styles.clear();
    for (const a of this.anims) a.currentTime = this.t;
  }
  protected show(i: number) {
    this.at(this.frames.stands[i] ?? 0);
    this.setFrame(i);
  }
  tick() {
    const i = frameAt(this.frames, this.now());
    if (i !== this.frame()) this.setFrame(i);
  }
  protected start() {
    this.thaw();
    for (const a of this.anims) a.play();
    if (this.smil) this.svg?.unpauseAnimations();
  }
  protected stop() {
    if (this.frozen) return;
    for (const a of this.anims) a.pause();
    if (this.smil) this.svg?.pauseAnimations();
    if (this.anims.length && !this.dead) {
      this.t = this.now();
      this.freeze();
    }
  }
  protected passOn() {
    return { time: this.svg ? this.now() : undefined };
  }
}

/** Draws the animated images of a Note's static view `box` (just painted) as players; the ones it had before are dropped */
export function attachAnims(box: HTMLElement, card: string) {
  const nth = new Map<string, number>(),
    found: [AnimKey, HTMLImageElement][] = [];
  for (const img of box.querySelectorAll("img")) {
    if (!img.getAttribute("src") || img.closest(".md-html")) continue;
    const src = noteImageSrc(img),
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

/** A press on an image's bar: the image is selected first (a Note image: its Note becomes the one selected card), so what the bar
 *  does is saved on deselect as a click and the keys would */
function grabAnim(p: Player) {
  if (editing()?.id === p.key.card) return;
  if (sel.cards.length !== 1 || sel.cards[0] !== p.key.card) select({ cards: [p.key.card] });
  selectAnim(p);
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
function toggleLoop(p: Player) {
  if (p.loop) save(p.key, { loop: false, frame: p.frame() + 1 });
  else save(p.key, { loop: true });
}

/** Wiring (wire.ts): the camera stops and restarts what plays; the selected image deselects when its Note is no longer the one
 *  selected card, when the Note is edited, or on a press anywhere but the image and its bar; saving the playback */
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
      if (p && !p.key.whole && t !== p.img && !(t && p.host.contains(t))) deselectAnim();
    },
    true,
  );
}

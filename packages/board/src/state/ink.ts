// Ink Wash's images, drawn once as small SVGs (data URIs) instead of live CSS filters or per-frame work:
// - the card paper (毛边宣纸): one image per card size (deckle), drawn on the card's ::before (themes.css), regenerated only when
//   the size changes; cached by size (rounded to SIZE_STEP) and one of PAPER_SEEDS edge patterns picked by the card's id, so
//   cards of the same size share one image
// - the selection corners, the five brush strokes under calls and the toolbar's pale ink stroke: one each per light / dark, set
//   as variables on the root while the look is Ink Wash (wireInk)
// The shapes follow the approved mock (versions/v0.2.1/ink-wash/demo.html: deckleImg, crnImg, callImg, barImg)
import { createEffect, createSignal } from "solid-js";
import { brushLine, fnv } from "@codeboard/core/canvas";
import { shape } from "./look";
import { rooted } from "./root";

// ---------- light / dark ----------
// html[data-theme] follows VS Code (host.ts followHostTheme); wireInk watches it, so the paper images can follow it
const [dark, setDark] = createSignal(false);
export { dark as inkDark };

const f = (n: number) => String(Math.round(n * 10) / 10);
/** An SVG as a CSS url(): only the characters a data URI needs escaped (the markup uses single quotes only) */
const svgUrl = (w: number, h: number, body: string, par = "") =>
  `url("data:image/svg+xml,${`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'${par}>${body}</svg>`
    .replace(/\s*\n\s*/g, "")
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E")}")`;
/** A straight stroke as a cubic (control points at the thirds), for brushLine */
const line2 = (x0: number, y0: number, x1: number, y1: number) =>
  `M${x0} ${y0}C${x0 + (x1 - x0) / 3} ${y0 + (y1 - y0) / 3} ${x0 + (2 * (x1 - x0)) / 3} ${y0 + (2 * (y1 - y0)) / 3} ${x1} ${y1}`;

// ---------- the card paper ----------
/** How far the paper reaches outside the card (themes.css: the card's ::before is inset by −PAPER_M) */
const PAPER_M = 14;
/** Sizes are rounded to this before drawing: the image is stretched onto the card, a few px off does not show */
const SIZE_STEP = 4;
const PAPER_SEEDS = 4;

/** Seeded random numbers in [0, 1) (mulberry32) */
function rng(seed: number) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A torn sheet of rice paper W × H (the card plus PAPER_M on each side): the edge jitters ±0.5 px with a rare small notch, a few
 * short fibres stick out, ~10 very faint fibres inside. The shadow under it is the card's box-shadow (themes.css): blurred 4.5 px, the
 * outline's ±0.5 px jitter does not show in it, and a filter in the image would be redrawn on every paint of the card
 */
function deckleSvg(W: number, H: number, dk: boolean, seed: number) {
  const r = rng(seed),
    M = PAPER_M,
    x0 = M,
    y0 = M,
    x1 = W - M,
    y1 = H - M,
    pts: string[] = [],
    fib: string[] = [];
  const jag = () => (r() - 0.5) * 1.0 + (r() < 0.03 ? -0.9 : 0);
  const edge = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number) => {
    const n = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 4));
    for (let i = 0; i < n; i++) {
      const t = i / n,
        j = jag(),
        x = ax + (bx - ax) * t + nx * j,
        y = ay + (by - ay) * t + ny * j;
      pts.push(`${f(x)} ${f(y)}`);
      if (r() < 0.06) {
        const l = 1 + r() * 2,
          a = (r() - 0.5) * 1.2;
        fib.push(`M${f(x)} ${f(y)}l${f(nx * l + ny * a * l)} ${f(ny * l + nx * a * l)}`);
      }
    }
  };
  edge(x0, y0, x1, y0, 0, -1);
  edge(x1, y0, x1, y1, 1, 0);
  edge(x1, y1, x0, y1, 0, 1);
  edge(x0, y1, x0, y0, -1, 0);
  const d = `M${pts.join("L")}Z`;
  const paper = dk ? "#1e1d1a" : "#fbf8f1",
    fiber = dk ? "#e9e5da" : "#6b5a3a";
  let inner = "";
  for (let i = 0; i < 10; i++) {
    const x = x0 + r() * (x1 - x0),
      y = y0 + r() * (y1 - y0),
      l = 20 + r() * 60,
      a = r() * Math.PI;
    inner += `M${f(x)} ${f(y)}q${f((Math.cos(a) * l) / 2 + 6)} ${f((Math.sin(a) * l) / 2 - 4)} ${f(Math.cos(a) * l)} ${f(Math.sin(a) * l)}`;
  }
  return svgUrl(
    W,
    H,
    `<defs><path id='p' d='${d}'/><clipPath id='c'><use href='#p'/></clipPath></defs>` +
      `<use href='#p' fill='${paper}'/>` +
      `<path clip-path='url(#c)' d='${inner}' fill='none' stroke='${fiber}' stroke-opacity='${dk ? 0.035 : 0.04}' stroke-width='.5'/>` +
      `<path d='${fib.join("")}' fill='none' stroke='${paper}' stroke-width='.7' stroke-linecap='round'/>` +
      `<use href='#p' fill='none' stroke='${fiber}' stroke-opacity='${dk ? 0.12 : 0.1}' stroke-width='.5'/>`,
  );
}

const papers = new Map<string, string>();
/** The paper image for a card of w × h with this id (cached: cards of the same rounded size and pattern share it) */
export function paperOf(w: number, h: number, id: string, dk: boolean) {
  const W = Math.max(SIZE_STEP, Math.round(w / SIZE_STEP) * SIZE_STEP) + 2 * PAPER_M,
    H = Math.max(SIZE_STEP, Math.round(h / SIZE_STEP) * SIZE_STEP) + 2 * PAPER_M,
    seed = 1 + (fnv(id) % PAPER_SEEDS),
    k = `${W}x${H}:${seed}:${dk ? 1 : 0}`;
  let u = papers.get(k);
  if (!u) {
    // a long session of resizing would grow it without end: start over past a few hundred sizes
    if (papers.size > 400) papers.clear();
    papers.set(k, (u = deckleSvg(W, H, dk, seed)));
  }
  return u;
}

// ---------- corners, call strokes, toolbar ----------
/** Selection: four small vermilion brush corners (a 96 × 96 border-image, 24 px slices) */
function cornersSvg(zhu: string) {
  const L = [
    line2(3.5, 5.5, 20, 5),
    line2(5, 3.5, 5.6, 20),
    line2(76, 5, 92.5, 5.6),
    line2(91, 3.5, 90.6, 20),
    line2(3.5, 90.8, 20, 91.2),
    line2(5.4, 76, 5, 92.5),
    line2(76, 91, 92.5, 90.6),
    line2(90.8, 76, 91.2, 92.5),
  ];
  return svgUrl(
    96,
    96,
    `<g fill='${zhu}' fill-opacity='.92'>${L.map((d, i) => `<path d='${brushLine(d, i, 1.5).d}'/>`).join("")}</g>`,
  );
}

/** The five brush strokes under clickable calls: each starts, bends, thins and ends differently; one is broken in the middle,
 *  one dry along its tail. themes.css .call.cv0–cv4 give each its own width, offset and height */
const CALL_STROKES: { P: number[]; w: number; seed: number; gap?: [number, number]; dry?: boolean }[] = [
  { P: [1.5, 3.8, 40, 2.2, 80, 3.8, 118.5, 2.4], w: 1.3, seed: 2.2 },
  { P: [118.5, 2.6, 80, 4.2, 40, 2.0, 1.5, 3.4], w: 0.95, seed: 5.1 },
  { P: [1.5, 2.0, 30, 4.4, 90, 4.2, 118.5, 1.6], w: 1.6, seed: 0.7, gap: [0.56, 0.61] },
  { P: [2, 3.4, 50, 3.8, 96, 4.0, 118.5, 0.9], w: 0.85, seed: 3.9 },
  { P: [1.5, 4.2, 45, 1.8, 75, 4.6, 118.5, 3.0], w: 1.4, seed: 8.3, dry: true },
];
function callSvg(zhu: string, k: number) {
  const c = CALL_STROKES[k],
    P = c.P;
  let body = `<path d='${brushLine(`M${P[0]} ${P[1]}C${P.slice(2).join(" ")}`, c.seed, c.w).d}' fill='${zhu}' fill-opacity='${0.78 + (k % 3) * 0.05}'/>`;
  if (c.gap)
    body = `<defs><mask id='m'><rect width='120' height='6' fill='#fff'/><rect x='${c.gap[0] * 120}' y='0' width='${f((c.gap[1] - c.gap[0]) * 120)}' height='6' fill='#000'/></mask></defs><g mask='url(#m)'>${body}</g>`;
  if (c.dry)
    body = `<defs><mask id='m'><rect width='120' height='6' fill='#fff'/><path d='M70 3.1L117 3.3' stroke='#000' stroke-width='.35'/></mask></defs><g mask='url(#m)'>${body}</g>`;
  return svgUrl(120, 6, body, " preserveAspectRatio='none'");
}

/** The bottom toolbar: one pale ink brush stroke (edges rising and falling a little, a round, darker start, a dry tail) */
function barSvg(ink: string, dk: boolean) {
  const W = 400,
    H = 46,
    top: number[][] = [],
    bot: number[][] = [];
  for (let x = 14; x <= 372; x += 6) {
    top.push([x, 8.5 + 1.1 * Math.sin(x * 0.045) + 0.6 * Math.sin(x * 0.17 + 1)]);
    bot.push([x, 37.5 + 1.2 * Math.sin(x * 0.038 + 2) + 0.5 * Math.sin(x * 0.21)]);
  }
  const tail = [
    [380, 10],
    [392, 13.5],
    [384, 17],
    [396, 22],
    [386, 27],
    [394, 31.5],
    [378, 36.5],
  ];
  const d = `M${top.map((q) => `${f(q[0])} ${f(q[1])}`).join("L")}L${tail.map((q) => q.join(" ")).join("L")}L${bot
    .reverse()
    .map((q) => `${f(q[0])} ${f(q[1])}`)
    .join("L")}C4 38 2 9 14 8.5Z`;
  let fb = "";
  for (let i = 0; i < 9; i++) {
    const y = 11 + i * 3.1 + (i % 2) * 0.7,
      a = 262 + ((i * 53) % 90),
      b = W - 4 - ((i * 29) % 40),
      mid = (a + b) / 2;
    fb += `<path d='M${a} ${f(y)}Q${f(mid)} ${f(y + (i % 2 ? 0.8 : -0.6))} ${b} ${f(y + 0.3)}' fill='none' stroke='#000' stroke-width='${f(0.35 + (i % 3) * 0.35)}' stroke-linecap='round'/>`;
  }
  const o = dk ? 0.11 : 0.1;
  return svgUrl(
    W,
    H,
    `<defs><mask id='m'><rect width='${W}' height='${H}' fill='#fff'/>${fb}</mask><linearGradient id='g' x1='0' x2='1'><stop offset='0' stop-color='${ink}' stop-opacity='${(o * 1.6).toFixed(3)}'/><stop offset='.25' stop-color='${ink}' stop-opacity='${o}'/><stop offset='1' stop-color='${ink}' stop-opacity='${(o * 0.8).toFixed(3)}'/></linearGradient></defs><path d='${d}' fill='url(#g)' mask='url(#m)'/>`,
    " preserveAspectRatio='none'",
  );
}

/** The root variables the Ink Wash rules read (themes.css): set while the look draws on paper (look.ts paper, Ink Wash), for
 *  light or dark; gone otherwise. Also follows html[data-theme] for inkDark. Wired once (wire.ts) */
const VARS = ["--ink-crn", "--ink-bar", ...CALL_STROKES.map((_, k) => `--ink-cb${k}`)];
export function wireInk() {
  const root = document.documentElement;
  const sync = () => setDark(root.dataset.theme === "dark");
  sync();
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  rooted(() =>
    createEffect(() => {
      const on = shape().paper === "deckle",
        dk = dark();
      if (!on) {
        for (const v of VARS) root.style.removeProperty(v);
        return;
      }
      const zhu = dk ? "#d6533a" : "#b8321f",
        ink = dk ? "#e9e5da" : "#1d1c1a";
      root.style.setProperty("--ink-crn", cornersSvg(zhu));
      root.style.setProperty("--ink-bar", barSvg(ink, dk));
      for (let k = 0; k < CALL_STROKES.length; k++) root.style.setProperty(`--ink-cb${k}`, callSvg(zhu, k));
    }),
  );
}

// Ink Wash's images, drawn once as small images (data URIs) instead of live CSS filters or per-frame work:
// - the card paper (毛边宣纸): one nine-slice image (deckle) per edge pattern (PAPER_SEEDS, picked by the card's id) and light /
//   dark, drawn as the border image of the card's ::before (themes.css): the same image at every card size; a PNG drawn on a
//   canvas once (paperPng), not an SVG
// - the five brush strokes under calls and the toolbar's pale ink stroke: one each per light / dark, set
//   as variables on the root while the look is Ink Wash (wireInk)
// The shapes follow the approved mock (versions/v0.2.1/ink-wash/demo.html: deckleImg, callImg, barImg)
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

// ---------- the card paper ----------
/** How far the paper reaches outside the card (themes.css: the card's ::before is inset by −PAPER_M) */
const PAPER_M = 14;
/** The sheet is drawn as a nine-slice border image (themes.css): corners PAPER_SLICE square, edges and middle tiled. Inside the
 *  card the slice reaches PAPER_SLICE − PAPER_M (16 px), past the torn edge's jitter and its outward fibres. themes.css uses the same number */
const PAPER_SLICE = 30;
/** The tiled middle of each edge and of the sheet: long enough that the repeat does not show */
const PAPER_TILE = 240;
const PAPER_SEEDS = 4;
/** Points along the torn edge are this far apart; PAPER_SLICE − PAPER_M and PAPER_TILE are multiples of it, so the edge passes
 *  through a point at each slice line */
const EDGE_STEP = 4;

/** Seeded random numbers in [0, 1) (mulberry32) */
export function rng(seed: number) {
  let a = (seed * 2654435761) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A torn sheet of rice paper, one size for every card: the edge jitters ±0.5 px with a rare small notch, a few short fibres stick
 * out, a few very faint fibres inside. It is a nine-slice image (PAPER_SLICE): the card's size never changes the image, so a Note
 * growing while it is edited keeps the paper it has. (One image per card size was redrawn, and decoded again, on every 4 px the
 * card grew: a long card showed the board through it for a frame each time.) The edge is back on its line at each slice line,
 * so the tiled edges join without a step. The shadow under it is the card's box-shadow (themes.css): blurred 4.5 px, the
 * outline's jitter does not show in it. The shapes as SVG path data, in sheet px (paperPng draws them)
 */
export function paperSheet(dk: boolean, seed: number) {
  const r = rng(seed),
    M = PAPER_M,
    S = 2 * PAPER_SLICE + PAPER_TILE,
    x0 = M,
    y0 = M,
    x1 = S - M,
    y1 = S - M,
    pts: string[] = [],
    fib: string[] = [];
  // along an edge, the slice lines fall at these distances from its start
  const lines = [PAPER_SLICE - M, S - PAPER_SLICE - M];
  const jag = () => (r() - 0.5) * 1.0 + (r() < 0.03 ? -0.9 : 0);
  const edge = (ax: number, ay: number, bx: number, by: number, nx: number, ny: number) => {
    const n = Math.round(Math.hypot(bx - ax, by - ay) / EDGE_STEP);
    for (let i = 0; i < n; i++) {
      const t = i / n,
        j = i === 0 || lines.includes(i * EDGE_STEP) ? 0 : jag(),
        x = ax + (bx - ax) * t + nx * j,
        y = ay + (by - ay) * t + ny * j;
      pts.push(`${f(x)} ${f(y)}`);
      // fibres sticking out: not across a slice line, where the tiles meet
      if (r() < 0.06 && !lines.some((l) => Math.abs(i * EDGE_STEP - l) < 6)) {
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
  // faint fibres inside, all within the tiled middle (a fibre across a slice line would be cut where the tiles meet)
  let inner = "";
  const lo = PAPER_SLICE + 6,
    hi = S - PAPER_SLICE - 6;
  for (let i = 0; i < 6; i++) {
    const l = 20 + r() * 60,
      a = r() * Math.PI,
      dx = Math.cos(a) * l,
      dy = Math.sin(a) * l,
      x = lo + r() * (hi - lo - Math.abs(dx)) + Math.max(0, -dx),
      y = lo + r() * (hi - lo - dy);
    inner += `M${f(x)} ${f(y)}q${f(dx / 2 + 6)} ${f(dy / 2 - 4)} ${f(dx)} ${f(dy)}`;
  }
  return {
    size: S,
    outline: `M${pts.join("L")}Z`,
    inner,
    fibres: fib.join(""),
    paper: dk ? "#1e1d1a" : "#fbf8f1",
    fiber: dk ? "#e9e5da" : "#6b5a3a",
    innerOpacity: dk ? 0.035 : 0.04,
    edgeOpacity: dk ? 0.12 : 0.1,
  };
}

/** The paper is drawn PAPER_SCALE times its size: still crisp on a 2× screen zoomed in 150 %. themes.css slices it at
 *  PAPER_SLICE × PAPER_SCALE image px */
const PAPER_SCALE = 3;

/**
 * The sheet as a PNG (a data URI): a bitmap, not an SVG. As an SVG border image every card's ::before redrew the vector sheet for
 * each of its nine pieces and each tile of the world it falls on, at every raster scale the zoom reached; with GPU raster
 * (a Mac) dozens of those hung the GPU process when the look switched to Ink Wash, all of VS Code with it, and the right and
 * bottom pieces were drawn off their place at some zooms (a second paper edge inside the card). A bitmap is one texture
 */
function paperPng(dk: boolean, seed: number) {
  const p = paperSheet(dk, seed),
    k = PAPER_SCALE,
    cv = document.createElement("canvas");
  cv.width = cv.height = p.size * k;
  const g = cv.getContext("2d")!;
  g.scale(k, k);
  const outline = new Path2D(p.outline);
  g.fillStyle = p.paper;
  g.fill(outline);
  g.lineWidth = 0.5;
  g.strokeStyle = p.fiber;
  g.globalAlpha = p.innerOpacity;
  g.stroke(new Path2D(p.inner));
  g.globalAlpha = 1;
  g.lineWidth = 0.7;
  g.lineCap = "round";
  g.strokeStyle = p.paper;
  g.stroke(new Path2D(p.fibres));
  g.lineWidth = 0.5;
  g.lineCap = "butt";
  g.strokeStyle = p.fiber;
  g.globalAlpha = p.edgeOpacity;
  g.stroke(outline);
  return `url("${cv.toDataURL("image/png")}")`;
}

const papers = new Map<string, string>();
/** The paper image of the card with this id: one of PAPER_SEEDS edge patterns, picked by the id, for light or dark (drawn once each) */
export function paperOf(id: string, dk: boolean) {
  const seed = paperSeed(id),
    k = `${seed}:${dk ? 1 : 0}`;
  let u = papers.get(k);
  if (!u) papers.set(k, (u = paperPng(dk, seed)));
  return u;
}
/** Which of the PAPER_SEEDS edge patterns the card with this id gets */
const paperSeed = (id: string) => 1 + (fnv(id) % PAPER_SEEDS);

// ---------- call strokes, toolbar ----------
/** The five brush strokes under clickable calls: each starts, bends, thins and ends differently, all in one unbroken stroke
 *  (a gap read as the word being cut off); one is dry along its tail. themes.css .call.cv0–cv4 give each its own width, offset and height */
const CALL_STROKES: { P: number[]; w: number; seed: number; dry?: boolean }[] = [
  { P: [1.5, 3.8, 40, 2.2, 80, 3.8, 118.5, 2.4], w: 1.3, seed: 2.2 },
  { P: [118.5, 2.6, 80, 4.2, 40, 2.0, 1.5, 3.4], w: 0.95, seed: 5.1 },
  { P: [1.5, 2.0, 30, 4.4, 90, 4.2, 118.5, 1.6], w: 1.15, seed: 0.7 },
  { P: [2, 3.4, 50, 3.8, 96, 4.0, 118.5, 0.9], w: 0.85, seed: 3.9 },
  { P: [1.5, 4.2, 45, 1.8, 75, 4.6, 118.5, 3.0], w: 1.1, seed: 8.3, dry: true },
];
function callSvg(zhu: string, k: number) {
  const c = CALL_STROKES[k],
    P = c.P;
  let body = `<path d='${brushLine(`M${P[0]} ${P[1]}C${P.slice(2).join(" ")}`, c.seed, c.w).d}' fill='${zhu}' fill-opacity='${0.78 + (k % 3) * 0.05}'/>`;
  if (c.dry)
    body = `<defs><mask id='m'><rect width='120' height='6' fill='#fff'/><path d='M70 3.1L117 3.3' stroke='#000' stroke-width='.35'/></mask></defs><g mask='url(#m)'>${body}</g>`;
  return svgUrl(120, 6, body, " preserveAspectRatio='none'");
}

/** The bottom toolbar: one pale ink brush stroke (edges rising and falling a little, a round, darker start, a dry tail).
 *  solid: the same outline filled opaque, the mask of the frosted layer under the stroke (--ink-bar-mask) */
function barSvg(ink: string, dk: boolean, solid = false) {
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
  if (solid) return svgUrl(W, H, `<path d='${d}' fill='#000'/>`, " preserveAspectRatio='none'");
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
const VARS = ["--ink-bar", "--ink-bar-mask", ...CALL_STROKES.map((_, k) => `--ink-cb${k}`)];
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
      root.style.setProperty("--ink-bar", barSvg(ink, dk));
      root.style.setProperty("--ink-bar-mask", barSvg("#000", dk, true));
      for (let k = 0; k < CALL_STROKES.length; k++) root.style.setProperty(`--ink-cb${k}`, callSvg(zhu, k));
    }),
  );
}

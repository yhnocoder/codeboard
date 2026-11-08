// Ink Wash's images, drawn once as small images (data URIs) instead of live CSS filters or per-frame work: the card paper
// (毛边宣纸: one nine-slice image per edge pattern, PAPER_SEEDS, picked by the card's id, light / dark, the border image of the
// card's ::before in themes.css; a PNG drawn on a canvas once), the five brush strokes under calls and the toolbar's pale ink
// stroke. Pure drawing, no board state: the Mac app's card page draws the same paper with it (apps/macos/web). The shapes
// follow the approved mock (versions/v0.2.1/ink-wash/demo.html: deckleImg, callImg, barImg). ink.ts wires them to the board
import { brushLine, paperSeed, paperSheet, rng } from "@codeboard/core/canvas";
export { paperSheet, rng };

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

// ---------- call strokes, toolbar ----------
/** The five brush strokes under clickable calls: each starts, bends, thins and ends differently, all in one unbroken stroke
 *  (a gap read as the word being cut off); one is dry along its tail. themes.css .call.cv0–cv4 give each its own width, offset and height */
export const CALL_STROKES: { P: number[]; w: number; seed: number; dry?: boolean }[] = [
  { P: [1.5, 3.8, 40, 2.2, 80, 3.8, 118.5, 2.4], w: 1.3, seed: 2.2 },
  { P: [118.5, 2.6, 80, 4.2, 40, 2.0, 1.5, 3.4], w: 0.95, seed: 5.1 },
  { P: [1.5, 2.0, 30, 4.4, 90, 4.2, 118.5, 1.6], w: 1.15, seed: 0.7 },
  { P: [2, 3.4, 50, 3.8, 96, 4.0, 118.5, 0.9], w: 0.85, seed: 3.9 },
  { P: [1.5, 4.2, 45, 1.8, 75, 4.6, 118.5, 3.0], w: 1.1, seed: 8.3, dry: true },
];
export function callSvg(zhu: string, k: number) {
  const c = CALL_STROKES[k],
    P = c.P;
  let body = `<path d='${brushLine(`M${P[0]} ${P[1]}C${P.slice(2).join(" ")}`, c.seed, c.w).d}' fill='${zhu}' fill-opacity='${0.78 + (k % 3) * 0.05}'/>`;
  if (c.dry)
    body = `<defs><mask id='m'><rect width='120' height='6' fill='#fff'/><path d='M70 3.1L117 3.3' stroke='#000' stroke-width='.35'/></mask></defs><g mask='url(#m)'>${body}</g>`;
  return svgUrl(120, 6, body, " preserveAspectRatio='none'");
}

/** The bottom toolbar: one pale ink brush stroke (edges rising and falling a little, a round, darker start, a dry tail).
 *  solid: the same outline filled opaque, the mask of the frosted layer under the stroke (--ink-bar-mask) */
export function barSvg(ink: string, dk: boolean, solid = false) {
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

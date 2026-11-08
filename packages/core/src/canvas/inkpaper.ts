// Ink Wash's card paper (毛边宣纸): the shapes of a torn sheet of rice paper as path data, one of PAPER_SEEDS edge patterns
// picked by the card's id. The board draws it into a nine-slice PNG (packages/board/src/state/inkart.ts); the Mac app into a
// nine-slice image of its own. Pure: numbers to path strings.
import { fnv } from "./brush";

const f = (n: number) => String(Math.round(n * 10) / 10);

/** How far the paper reaches outside the card (themes.css: the card's ::before is inset by −PAPER_M) */
export const PAPER_M = 14;
/** The sheet is drawn as a nine-slice border image (themes.css): corners PAPER_SLICE square, edges and middle tiled. Inside the
 *  card the slice reaches PAPER_SLICE − PAPER_M (16 px), past the torn edge's jitter and its outward fibres. themes.css uses the same number */
export const PAPER_SLICE = 30;
/** The tiled middle of each edge and of the sheet: long enough that the repeat does not show */
const PAPER_TILE = 240;
export const PAPER_SEEDS = 4;
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
    paper: dk ? "#1e1d1a" : "#fdfdfb",
    fiber: dk ? "#e9e5da" : "#6b5a3a",
    innerOpacity: dk ? 0.035 : 0.04,
    edgeOpacity: dk ? 0.12 : 0.1,
  };
}

/** Which of the PAPER_SEEDS edge patterns the card with this id gets */
export const paperSeed = (id: string) => 1 + (fnv(id) % PAPER_SEEDS);

// Arrow routing for the native canvas: core's arrow geometry (@codeboard/core/canvas arrow.ts, the same the web board's
// packages/board/src/canvas/routes.ts draws with) over the card rectangles the app measured, without the parts the app does not have
// yet (Compare columns, Section folding, cards popping in). Warm Ink's look: curved routes, tapered lines, dart heads, hand lines
// from Marks; Ink Wash's: brush strokes and dot heads (the board's state/look.ts SHAPES). It works on a RouteModel, the little of a board routing needs, so the shell can run it off the main thread
// (router-entry.ts) during a drag with no board of its own.
import type { Board, Link } from "@codeboard/core";
import {
  anchorsFor,
  baseFrom,
  brushLine,
  brushSeed,
  dartHead,
  geoFrom,
  headPath,
  sidesFor,
  taperLine,
  type End,
  type Geo,
  type Mode,
} from "@codeboard/core/canvas";
import { CODE_GEO } from "@codeboard/core";

/** What routing needs of a board: the links, and of each card its kind (a Mark draws hand lines) and its code rows (line ends) */
export type RouteModel = {
  links: Link[];
  cards: {
    id: string;
    kind: string;
    look?: string;
    segments?: { id: string; start: number; end: number; lines: number }[];
  }[];
};
export function routeModel(b: Board): RouteModel {
  return {
    links: b.links,
    cards: b.cards.map((c) =>
      c.kind === "code"
        ? {
            id: c.id,
            kind: c.kind,
            segments: c.segments.map((s) => ({ id: s.id, start: s.start, end: s.end, lines: s.text.length })),
          }
        : c.kind === "note"
          ? { id: c.id, kind: c.kind, look: c.look }
          : { id: c.id, kind: c.kind },
    ),
  };
}

/** The rectangle of a card as drawn, in world units, and, once the shell has drawn a code card, where its lines are: "<segment
 *  id>:<line>" → the middle of the row, from the card's top (hidden runs, Always Show notes and the separators between segments
 *  move the rows the same way the board's measured rows do, state/geo.ts lineY) */
export type Rect = { x: number; y: number; w: number; h: number; rows?: Record<string, number> };

/** core's Geo plus the tapered outline a solid line fills (Warm Ink) or the brush stroke's outline and its dry streaks (Ink Wash,
 *  fb); hand lines (d2) and dashed ones stroke d. mode = the side choice this route was made with (the buffer against flapping
 *  remembers it): a router that takes over, such as the main one after a drag routed off the main thread, adopts it so the arrow
 *  does not jump */
export type RouteGeo = Geo & { id: string; taper?: string; fb?: string; mode?: Mode };

/** A path as numbers for the shell: [op, x, y, …] with op 0 = M, 1 = L, 2 = C (x1 y1 x2 y2 x y), 3 = Q (x1 y1 x y), 4 = Z;
 *  absolute. Parsing a string on every frame of a drag is what this saves. A form it does not know (an arc) → undefined, and the
 *  shell parses the string */
function pathNums(d: string): number[] | undefined {
  const out: number[] = [];
  const toks = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g);
  if (!toks) return out;
  let cmd = "M",
    x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    i = 0;
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    const t = toks[i];
    if (/[A-Za-z]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z" || cmd === "z") {
        out.push(4);
        x = sx;
        y = sy;
      }
      continue;
    }
    const rel = cmd === cmd.toLowerCase();
    const bx = rel ? x : 0,
      by = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M":
        x = bx + num();
        y = by + num();
        out.push(0, x, y);
        sx = x;
        sy = y;
        cmd = rel ? "l" : "L";
        break;
      case "L":
        x = bx + num();
        y = by + num();
        out.push(1, x, y);
        break;
      case "H":
        x = bx + num();
        out.push(1, x, y);
        break;
      case "V":
        y = by + num();
        out.push(1, x, y);
        break;
      case "C": {
        const a = bx + num(),
          b = by + num(),
          c = bx + num(),
          e = by + num();
        x = bx + num();
        y = by + num();
        out.push(2, a, b, c, e, x, y);
        break;
      }
      case "Q": {
        const a = bx + num(),
          b = by + num();
        x = bx + num();
        y = by + num();
        out.push(3, a, b, x, y);
        break;
      }
      default:
        return undefined;
    }
  }
  return out;
}
/** What the shell draws an arrow from: the numbers of each path (the strings only where it could not read one) */
export function shellGeo(g: RouteGeo) {
  const n = (d: string | undefined) => (d === undefined ? undefined : pathNums(d));
  return {
    id: g.id,
    mode: g.mode,
    pts: g.pts,
    mx: g.mx,
    my: g.my,
    port: g.port,
    port2: g.port2,
    n: { d: n(g.d), taper: n(g.taper), fb: n(g.fb), d2: n(g.d2), head: n(g.head), tail: n(g.tail) },
    s: {
      d: pathNums(g.d) ? undefined : g.d,
      taper: g.taper && !pathNums(g.taper) ? g.taper : undefined,
      fb: g.fb && !pathNums(g.fb) ? g.fb : undefined,
      d2: g.d2 && !pathNums(g.d2) ? g.d2 : undefined,
      head: g.head && !pathNums(g.head) ? g.head : undefined,
      tail: g.tail && !pathNums(g.tail) ? g.tail : undefined,
    },
  };
}

/** Distance a card moves before an end switches sides (board tune "sideBuffer") */
const SIDE_BUFFER = 16;

/** The look the arrows are drawn in: warm-ink (tapered lines, dart heads) or ink-wash (brush strokes, dot heads) */
let look = "warm-ink";
export const setLook = (l: string) => {
  look = l;
};
const dotHead: typeof dartHead = (tx, ty, ux, uy, s) => headPath("dot", tx, ty, ux, uy, s);

export class Router {
  /** Each link's last mode: the side buffer needs it */
  private modes = new Map<string, Mode>();

  /** Routes for the links given (all when none are named). rects = where each card is drawn now; modes = side choices another
   *  router made for these links since (the drag's live routes), taken over first */
  route(b: RouteModel, rects: Record<string, Rect>, only?: Iterable<string>, modes?: Record<string, Mode>): RouteGeo[] {
    if (modes) for (const [id, m] of Object.entries(modes)) this.modes.set(id, m);
    const want = only ? new Set(only) : null;
    const out: RouteGeo[] = [];
    for (const l of b.links) {
      if (want && !want.has(l.id)) continue;
      const bs = baseFrom(endOf(b, l.from, rects), endOf(b, l.to, rects));
      if (!bs) continue;
      const [p, q] = anchorsFor(bs, sidesFor(l, bs, this.modes, SIDE_BUFFER, true));
      const from = b.cards.find((c) => c.id === l.from.card);
      const hand = from?.kind === "note" && from.look === "mark";
      const ink = look === "ink-wash";
      const g = geoFrom(l, bs, p, q, false, null, { route: "curve", hand, head: ink ? dotHead : dartHead });
      const solid = !hand && !(l.style?.dash || l.gen || l.rpc || l.call?.ev?.kind === "manual");
      // the stroke's weight (the board's Links.tsx: 0.6 / 1 / 1.6 for widths 1 / 2 / 3)
      const k = l.style?.width === 1 ? 0.6 : l.style?.width === 3 ? 1.6 : 1;
      const brush = solid && ink ? brushLine(g.d, brushSeed(l.id), 1.5 * k) : null;
      out.push({
        ...g,
        id: l.id,
        taper: !solid ? undefined : brush ? brush.d : taperLine(g.d, 2.5 * k, 0.9 * k).d,
        fb: brush?.fb || undefined,
        mode: this.modes.get(l.id),
      });
    }
    return out;
  }

  forget(id: string) {
    this.modes.delete(id);
  }
}

function endOf(b: RouteModel, e: Link["from"], rects: Record<string, Rect>): End | null {
  const r = rects[e.card];
  if (!r) return null;
  const c = b.cards.find((k) => k.id === e.card);
  let y = r.y + CODE_GEO.head / 2;
  // the row as the shell drew it; a card not drawn yet by its rows' default places
  const drawn = e.seg !== undefined && e.line !== undefined ? r.rows?.[`${e.seg}:${e.line}`] : undefined;
  if (drawn !== undefined) y = r.y + Math.min(drawn, r.h);
  else if (c?.segments) {
    const ly = lineYIn(c.segments, e.seg, e.line);
    if (ly !== null && ly < r.h) y = r.y + ly;
  }
  return { box: r, outer: r, line: e.line !== undefined || !!e.block, y, host: e.card, card: e.card, pill: false };
}

/** The y of a segment's line inside its card (the middle of the row), or null when the card has no such line */
function lineYIn(
  segments: RouteModel["cards"][number]["segments"] & {},
  seg: string | undefined,
  line: number | undefined,
): number | null {
  if (seg === undefined || line === undefined) return null;
  let y = CODE_GEO.head + CODE_GEO.top;
  for (const s of segments) {
    if (s.id === seg)
      return line >= s.start && line <= s.end ? y + (line - s.start) * CODE_GEO.row + CODE_GEO.row / 2 : null;
    y += s.lines * CODE_GEO.row + CODE_GEO.sep;
  }
  return null;
}

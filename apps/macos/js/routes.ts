// Arrow routing for the native canvas: core's arrow geometry (@codeboard/core/canvas arrow.ts, the same the web board's
// packages/board/src/canvas/routes.ts draws with) over the card rectangles the app measured, without the parts the app does not have
// yet (Compare columns, Section folding, cards popping in). Warm Ink's look: curved routes, tapered lines, dart heads, hand lines
// from Marks. It works on a RouteModel, the little of a board routing needs, so the shell can run it off the main thread
// (router-entry.ts) during a drag with no board of its own.
import type { Board, Link } from "@codeboard/core";
import {
  anchorsFor,
  baseFrom,
  dartHead,
  geoFrom,
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

/** The rectangle of a card as drawn, in world units */
export type Rect = { x: number; y: number; w: number; h: number };

/** core's Geo plus the tapered outline a solid line fills (Warm Ink); hand lines (d2) and dashed ones stroke d. mode = the side
 *  choice this route was made with (the buffer against flapping remembers it): a router that takes over, such as the main one
 *  after a drag routed off the main thread, adopts it so the arrow does not jump */
export type RouteGeo = Geo & { id: string; taper?: string; mode?: Mode };

/** Distance a card moves before an end switches sides (board tune "sideBuffer") */
const SIDE_BUFFER = 16;

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
      const g = geoFrom(l, bs, p, q, false, null, { route: "curve", hand, head: dartHead });
      const solid = !hand && !(l.style?.dash || l.gen || l.rpc || l.call?.ev?.kind === "manual");
      const s = l.style?.width === 1 ? 0.85 : l.style?.width === 3 ? 1.25 : 1;
      out.push({
        ...g,
        id: l.id,
        taper: solid ? taperLine(g.d, 2.5 * s, 0.9 * s).d : undefined,
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
  if (c?.segments) {
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

// Arrow routing for the native canvas: core's arrow geometry (@codeboard/core/canvas arrow.ts, the same the web board's
// packages/board/src/canvas/routes.ts draws with) over the card rectangles the app measured, without the parts the app does not have
// yet (Compare columns, Section folding, cards popping in). Warm Ink's look: curved routes, tapered lines, dart heads, hand lines
// from Marks.
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
import { lineYIn } from "./scene";

/** The rectangle of a card as drawn, in world units */
export type Rect = { x: number; y: number; w: number; h: number };

/** core's Geo plus the tapered outline a solid line fills (Warm Ink); hand lines (d2) and dashed ones stroke d */
export type RouteGeo = Geo & { id: string; taper?: string };

/** Distance a card moves before an end switches sides (board tune "sideBuffer") */
const SIDE_BUFFER = 16;

export class Router {
  /** Each link's last mode: the side buffer needs it */
  private modes = new Map<string, Mode>();

  /** Routes for the links given (all when none are named). rects = where each card is drawn now */
  route(b: Board, rects: Record<string, Rect>, only?: Iterable<string>): RouteGeo[] {
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
      out.push({ ...g, id: l.id, taper: solid ? taperLine(g.d, 2.5 * s, 0.9 * s).d : undefined });
    }
    return out;
  }

  forget(id: string) {
    this.modes.delete(id);
  }
}

function endOf(b: Board, e: Link["from"], rects: Record<string, Rect>): End | null {
  const r = rects[e.card];
  if (!r) return null;
  const c = b.cards.find((k) => k.id === e.card);
  let y = r.y + CODE_GEO.head / 2;
  if (c?.kind === "code") {
    const ly = lineYIn(c, e.seg, e.line);
    if (ly !== null && ly < r.h) y = r.y + ly;
  }
  return { box: r, outer: r, line: e.line !== undefined || !!e.block, y, host: e.card, card: e.card, pill: false };
}

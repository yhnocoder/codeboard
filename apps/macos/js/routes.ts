// Arrow routing for the native canvas: core's routing (@codeboard/core/canvas) over the card rectangles the app measured, the way
// packages/board/src/canvas/routes.ts does it for the web board, without the parts the app does not have yet (Compare columns,
// Section folding, cards popping in, side slides). Warm Ink's look: curved routes, tapered lines, dart heads, hand lines from Marks.
import { headOf, type Board, type Link } from "@codeboard/core";
import {
  anchorOn,
  chooseMode,
  connect,
  handLine,
  headPath,
  selfArc,
  sidesOf,
  taperLine,
  type Anchor,
  type Box,
  type Mode,
  type Side,
} from "@codeboard/core/canvas";
import { CODE, lineYIn } from "./scene";

/** The rectangle of a card as drawn, in world units */
export type Rect = { x: number; y: number; w: number; h: number };

export type RouteGeo = {
  id: string;
  /** The route (M / L / C / Q), what dashed lines stroke */
  d: string;
  /** The tapered outline a solid line fills (Warm Ink); the hand line's two strokes for a Mark's arrow */
  taper?: string;
  d2?: string;
  head?: string;
  tail?: string;
  /** The cubic's points [x1 y1 c1x c1y c2x c2y x2 y2] for a label along it */
  pts: number[];
  mx: number;
  my: number;
};

/** Distance a card moves before an end switches sides (board tune "sideBuffer") */
const SIDE_BUFFER = 16;

type End = { box: Box; line: boolean; y: number; card: string };

export class Router {
  /** Each link's last mode: the side buffer needs it */
  private modes = new Map<string, Mode>();

  /** Routes for the links given (all when none are named). rects = where each card is drawn now */
  route(b: Board, rects: Record<string, Rect>, only?: Iterable<string>): RouteGeo[] {
    const want = only ? new Set(only) : null;
    const out: RouteGeo[] = [];
    for (const l of b.links) {
      if (want && !want.has(l.id)) continue;
      const g = this.one(b, l, rects);
      if (g) out.push(g);
    }
    return out;
  }

  forget(id: string) {
    this.modes.delete(id);
  }

  private one(b: Board, l: Link, rects: Record<string, Rect>): RouteGeo | null {
    const a = endOf(b, l.from, rects),
      z = endOf(b, l.to, rects);
    if (!a || !z) return null;
    const self = a.card === z.card;
    const uf = okSide(l.sides?.from, a.line),
      ut = okSide(l.sides?.to, z.line);
    let sides: [Side, Side];
    if (self) {
      const s = uf ?? "right";
      sides = [s, ut ?? s];
    } else {
      let auto: [Side, Side] = ["right", "left"];
      if (!(uf && ut)) {
        const m = chooseMode(a.box, z.box, !a.line && !z.line, this.modes.get(l.id), SIDE_BUFFER);
        this.modes.set(l.id, m);
        auto = sidesOf(m);
      }
      sides = [uf ?? auto[0], ut ?? auto[1]];
    }
    const p = anchorOn(a.box, sides[0], a.y),
      q = anchorOn(z.box, sides[1], z.y);
    return geoFrom(b, l, p, q, self, a.box, z.box);
  }
}

const okSide = (s: Side | undefined, line: boolean): Side | undefined =>
  s && (!line || s === "left" || s === "right") ? s : undefined;

function endOf(b: Board, e: Link["from"], rects: Record<string, Rect>): End | null {
  const r = rects[e.card];
  if (!r) return null;
  const c = b.cards.find((k) => k.id === e.card);
  const line = e.line !== undefined || !!e.block;
  let y = r.y + CODE.head / 2;
  if (c?.kind === "code") {
    const ly = lineYIn(c, e.seg, e.line);
    if (ly !== null && ly < r.h) y = r.y + ly;
  }
  return { box: r, line, y, card: e.card };
}

const widthScale = (l: Link) => (l.style?.width === 1 ? 0.85 : l.style?.width === 3 ? 1.25 : 1);

function geoFrom(b: Board, l: Link, p: Anchor, q: Anchor, self: boolean, ba: Box, bb: Box): RouteGeo {
  const hd = headOf(l),
    s = widthScale(l);
  const from = b.cards.find((c) => c.id === l.from.card);
  const sh = self ? selfArc(p, q, "curve") : connect(p, q, "curve", undefined, { a: ba, b: bb });
  if (from?.kind === "note" && from.look === "mark") {
    const h = handLine(l.id, sh.pts, hd.end, hd.start, s);
    return { id: l.id, d: h.d, d2: h.d2, head: h.head, tail: h.tail, pts: sh.pts, mx: sh.mx, my: sh.my };
  }
  const solid = !(l.style?.dash || l.gen || l.rpc || l.call?.ev?.kind === "manual");
  return {
    id: l.id,
    d: sh.d,
    taper: solid ? taperLine(sh.d, 2.5 * s, 0.9 * s).d : undefined,
    head: hd.end ? headPath("dart", sh.pts[6], sh.pts[7], sh.inDir.x, sh.inDir.y, s) : undefined,
    tail: hd.start ? headPath("dart", sh.pts[0], sh.pts[1], sh.outDir.x, sh.outDir.y, s) : undefined,
    pts: sh.pts,
    mx: sh.mx,
    my: sh.my,
  };
}

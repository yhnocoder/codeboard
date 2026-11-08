// An arrow's geometry from its two ends: which sides it leaves and enters by (with the buffer against flapping), the anchors on the
// cards, and the drawn shape (curve or elbow, merged stubs, tapered or hand-drawn, with its heads). The web board
// (packages/board/src/canvas/routes.ts) measures the ends and animates them; a native shell gives rectangles. Both draw with this.
import { headOf, type Link, type LinkSide } from "../model";
import { handLine } from "./hand";
import {
  anchorOn,
  chooseMode,
  connect,
  gutterLine,
  headPath,
  selfArc,
  sidesOf,
  type Anchor,
  type Box,
  type Mode,
  type Shape,
  type Side,
} from "./route";

/** One end of an arrow as it is drawn: the box to leave from (a Compare column: that column; outer = the whole card the route avoids),
 *  whether it is on a line / block (then only left or right), the y of that line, which Compare column, the card on the canvas (host)
 *  and the card named (card), and whether the end is a collapsed Section's pill */
export type End = {
  box: Box;
  outer: Box;
  line: boolean;
  y: number;
  col?: "left" | "right";
  host: string;
  card: string;
  pill: boolean;
};
/** Both ends: between two cards, from a card to itself, or across a Compare's gutter (gx = the gutter's x). rest = the ends once a
 *  popping card has landed (the sides are chosen by it, so a card sliding in does not switch sides halfway) */
export type Base = { a: End; b: End; kind: "normal" | "self" | "gutter"; gx?: number; rest?: Base };

export function baseFrom(a: End | null, b: End | null, rest: [End | null, End | null] | null = null): Base | null {
  const bs = baseOf2(a, b);
  if (!bs || !rest) return bs;
  const r = baseOf2(rest[0], rest[1]);
  return r && r.kind === bs.kind ? { ...bs, rest: r } : bs;
}
function baseOf2(a: End | null, b: End | null): Base | null {
  if (!a || !b) return null;
  if (a.host === b.host && !a.pill) {
    // the two columns of one Compare, line to line: the comparison line across the gutter
    if (a.card !== b.card && a.col && b.col && a.col !== b.col && a.line && b.line)
      return { a, b, kind: "gutter", gx: a.col === "left" ? a.box.x + a.box.w : b.box.x + b.box.w };
    return { a, b, kind: "self" };
  }
  return { a, b, kind: "normal" };
}

const okSide = (s: LinkSide | undefined, line: boolean): Side | undefined =>
  s && (!line || s === "left" || s === "right") ? s : undefined;

/**
 * The sides the arrow leaves and enters by: the user's choice first, then a Compare column's own side, then automatic with the
 * buffer (chooseMode; modes = each link's last mode, kept by the caller; remember = write this one's)
 */
export function sidesFor(
  L: Pick<Link, "id" | "sides">,
  bs: Base,
  modes: Map<string, Mode>,
  buffer: number,
  remember: boolean,
): [Side, Side] {
  const { a, b } = bs;
  const uf = okSide(L.sides?.from, a.line),
    ut = okSide(L.sides?.to, b.line);
  if (bs.kind !== "normal") {
    const s: Side = uf ?? a.col ?? "right";
    return [s, ut ?? (bs.kind === "self" ? s : (b.col ?? "left"))];
  }
  let auto: [Side, Side] = ["right", "left"];
  if (!((uf ?? a.col) && (ut ?? b.col))) {
    const r = bs.rest ?? bs;
    const m = chooseMode(r.a.box, r.b.box, !a.line && !b.line, modes.get(L.id), buffer);
    if (remember) modes.set(L.id, m);
    auto = sidesOf(m);
  }
  return [uf ?? a.col ?? auto[0], ut ?? b.col ?? auto[1]];
}

/** The anchors on the two boxes; adjust = the shell's change to each (a tilted card: the anchor turned with it) */
export const anchorsFor = (
  bs: Base,
  s: [Side, Side],
  adjust: (e: End, a: Anchor) => Anchor = (_, a) => a,
): [Anchor, Anchor] => [adjust(bs.a, anchorOn(bs.a.box, s[0], bs.a.y)), adjust(bs.b, anchorOn(bs.b.box, s[1], bs.b.y))];

export type Geo<H = string> = {
  d: string;
  mx: number;
  my: number;
  head?: H;
  tail?: H;
  port?: { x: number; y: number };
  port2?: { x: number; y: number };
  pts: number[];
  /** A hand line (from a Mark): the second stroke; head / tail are hand-drawn paths */
  d2?: string;
};

/** How far before its end a merged arrow's own stub stops */
export const STUB = 28;
export const headScale = (L: Pick<Link, "style">) => (L.style?.width === 1 ? 0.85 : L.style?.width === 3 ? 1.25 : 1);

/** The look an arrow is drawn in: the route's shape and head (a theme's), hand = it starts from a Mark (hand-drawn) */
export type ArrowLook<H = string> = {
  route: "curve" | "elbow";
  clear?: number;
  hand: boolean;
  /** The head at the tip (tx, ty) coming from direction (ux, uy), scaled s */
  head: (tx: number, ty: number, ux: number, uy: number, s: number) => H;
};
export const dartHead: ArrowLook["head"] = (tx, ty, ux, uy, s) => headPath("dart", tx, ty, ux, uy, s);

/**
 * The drawn geometry. merged = this arrow joins others into one end (its own part stops STUB short, the head is the merge's);
 * rest = the anchors once a popping card has landed (then the route avoids cards only when the landed one would)
 */
export function geoFrom<H>(
  L: Pick<Link, "id" | "style">,
  bs: Base,
  p: Anchor,
  q: Anchor,
  merged: boolean,
  rest: [Anchor, Anchor] | null | undefined,
  look: ArrowLook<H>,
): Geo<H> {
  const hd = headOf(L),
    s = headScale(L);
  // a hand line follows the curve (an elbow theme's too) and wobbles when drawn; no port dot (a Mark has no frame)
  if (look.hand && bs.kind !== "gutter") {
    const sh =
      bs.kind === "self"
        ? selfArc(p, q, "curve")
        : connect(p, q, "curve", undefined, {
            a: bs.a.pill ? undefined : bs.a.outer,
            b: bs.b.pill ? undefined : bs.b.outer,
          });
    const h = handLine(L.id, sh.pts, hd.end, hd.start, s);
    return { d: h.d, d2: h.d2, head: h.head as H, tail: h.tail as H, mx: sh.mx, my: sh.my, pts: sh.pts };
  }
  const route = look.route;
  let sh: Shape;
  if (bs.kind === "gutter") {
    sh = gutterLine(bs.gx!, p.y, q.y, bs.a.col === "left");
    return {
      d: sh.d,
      mx: sh.mx,
      my: sh.my,
      pts: sh.pts,
      port: { x: sh.pts[0], y: sh.pts[1] },
      port2: { x: sh.pts[6], y: sh.pts[7] },
    };
  }
  const clear = look.clear;
  if (bs.kind === "self") sh = selfArc(p, q, route, clear);
  else {
    const boxesOf = (b: Base) => ({ a: b.a.pill ? undefined : b.a.outer, b: b.b.pill ? undefined : b.b.outer });
    const stub = (q: Anchor) => (merged ? { ...q, x: q.x + q.nx * STUB, y: q.y + q.ny * STUB } : q);
    const tilt = merged ? { start: true, end: false } : undefined;
    let boxes: { a?: Box; b?: Box } = boxesOf(bs);
    // an end still popping in: when the landed route needs no detour, the moving one takes none either (no switch of shape halfway)
    if (bs.rest && rest) {
      const [p0, q0] = [rest[0], stub(rest[1])];
      if (connect(p0, q0, route, tilt, boxesOf(bs.rest), clear).d === connect(p0, q0, route, tilt, {}, clear).d)
        boxes = {};
    }
    sh = connect(p, stub(q), route, tilt, boxes, clear);
  }
  return {
    d: sh.d,
    mx: sh.mx,
    my: sh.my,
    pts: sh.pts,
    head: hd.end && !merged ? look.head(sh.pts[6], sh.pts[7], sh.inDir.x, sh.inDir.y, s) : undefined,
    tail: hd.start ? look.head(sh.pts[0], sh.pts[1], sh.outDir.x, sh.outDir.y, s) : undefined,
    port: { x: p.x, y: p.y },
  };
}

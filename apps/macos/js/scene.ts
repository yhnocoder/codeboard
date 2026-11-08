// The scene: what the native canvas draws, as plain JSON (Scene.swift decodes the same shapes). The bridge builds it from the
// board; after a change only the items that changed go over (SceneChange). Geometry is in world units (the board's px at zoom 1).
import {
  CODE_GEO as CODE,
  cardTitle,
  codeGlyph,
  estSize,
  type Board,
  type Card,
  type CodeCard,
  type Link,
  type Section,
} from "@codeboard/core";
import type { Highlight, SceneTok } from "./highlight";
import { type RouteModel, routeModel } from "./routes";

export type SceneLine = { n: number; toks: SceneTok[] };
/** hl: the segment's Highlights (highlighted line ranges, a band under them) */
export type SceneSegment = {
  path: string;
  start: number;
  end: number;
  lang: string;
  lines: SceneLine[];
  hl?: [number, number][];
};
export type SceneCard = {
  id: string;
  kind: Card["kind"];
  x: number;
  y: number;
  w: number;
  /** A height the board decided (Place.h, with a code card's head) or measured on a board (Place.mh); none = the app measures */
  h?: number;
  /** The height is the board's own (Place.h: the card scrolls inside it), not measured */
  fixed?: boolean;
  title: string;
  /** A Note's own name (NoteCard.title; the head shows it, else the leading heading, else "Note") */
  name?: string;
  section?: string;
  locked?: boolean;
  tilt?: boolean;
  /** Code: the kind glyph and the segments' coloured lines; `pending` while its grammar loads (plain lines, not to be drawn) */
  glyph?: string;
  segments?: SceneSegment[];
  pending?: true;
  /** Note / Text / Box / Mark / Free Text */
  look?: string;
  md?: string;
  size?: string;
  bold?: boolean;
  fill?: string;
  hand?: string;
  weight?: string;
  level?: number;
  fs?: number;
  /** Image: the file in assets/ (an absolute path), or a data: URL */
  src?: string;
  bg?: boolean;
  /** Sub-board: the board it shows and its name, with the little map of its cards */
  board?: string;
  boardName?: string;
  mini?: { x: number; y: number; w: number; h: number; kind: string }[];
  /** Web */
  url?: string;
};
export type SceneSection = Pick<
  Section,
  "id" | "title" | "x" | "y" | "w" | "h" | "parent" | "color" | "collapsed" | "locked"
>;
export type SceneLink = {
  id: string;
  from: Link["from"];
  to: Link["to"];
  label?: string;
  dash?: boolean;
  width: number;
  color?: string;
  head: { start: boolean; end: boolean };
  call?: boolean;
  back?: boolean;
  /** From a Mark: drawn as a hand line in the Mark's colour */
  hand?: string;
};
export type Scene = {
  id: string;
  name: string;
  cam: Board["cam"];
  cards: SceneCard[];
  sections: SceneSection[];
  links: SceneLink[];
  /** What the shell's own router (off the main thread, during a drag) routes with */
  routing: RouteModel;
};
/** What changed: items to put in (added or changed) and ids that are gone */
export type SceneChange = {
  cards: SceneCard[];
  sections: SceneSection[];
  links: SceneLink[];
  gone: { cards: string[]; sections: string[]; links: string[] };
  /** Cards only placed elsewhere (a drag), nothing else of them changed: no card to rebuild */
  moved: { id: string; x: number; y: number; section?: string }[];
  name?: string;
  /** When a card or link changed: the routing model as it is now */
  routing?: RouteModel;
};

export type SceneEnv = {
  assetsDir: string;
  /** Another board's name and cards (for a sub-board card's map); null when it is not there */
  peek(id: string): Board | null | undefined;
  hl: Highlight;
};

const sepName = (p: string) => p.split("/").pop() ?? p;

/** `quick`: a Code card whose grammar is still loading comes back `pending` with plain lines (the shell shows its placeholder; the
 *  finished card follows as a change) */
export async function sceneCard(b: Board, c: Card, env: SceneEnv, quick = false): Promise<SceneCard | null> {
  const p = b.place[c.id];
  if (!p) return null;
  const out: SceneCard = { id: c.id, kind: c.kind, x: p.x, y: p.y, w: p.w, title: cardTitle(c, b) };
  if (p.section) out.section = p.section;
  if (p.locked) out.locked = true;
  if (c.tilt) out.tilt = true;
  if (p.h) {
    out.h = estSize(c, p).h;
    out.fixed = true;
  } else if (p.mh) out.h = p.mh;
  switch (c.kind) {
    case "code":
      out.glyph = codeGlyph(c);
      out.segments = await Promise.all(
        c.segments.map(async (s) => {
          const toks = await env.hl.tokens(s.lang, s.text, !quick);
          if (!toks) out.pending = true;
          return {
            path: s.src.kind === "free" ? "" : sepName(s.path),
            start: s.start,
            end: s.end,
            lang: s.lang,
            lines: s.text.map((_, i) => ({ n: s.start + i, toks: toks?.[i] ?? [[s.text[i]]] })),
            ...(s.hl?.length ? { hl: s.hl } : {}),
          };
        }),
      );
      if (!p.h && !p.mh) out.h = codeHeight(c);
      break;
    case "note":
      out.look = c.look;
      out.md = c.md;
      if (c.title) out.name = c.title;
      if (c.size) out.size = c.size;
      if (c.bold) out.bold = true;
      if (c.fill) out.fill = c.fill;
      if (c.hand) out.hand = c.hand;
      if (c.weight) out.weight = c.weight;
      if (c.level) out.level = c.level;
      if (c.fs) out.fs = c.fs;
      break;
    case "image":
      out.src = c.src.startsWith("data:") ? c.src : `${env.assetsDir}/${c.src}`;
      if (c.bg) out.bg = true;
      break;
    case "board": {
      out.board = c.board;
      const sub = env.peek(c.board);
      out.boardName = sub?.name ?? "Board";
      if (sub)
        out.mini = sub.cards
          .filter((k) => sub.place[k.id])
          .map((k) => {
            const q = sub.place[k.id];
            return { x: q.x, y: q.y, w: q.w, h: estSize(k, q).h, kind: k.kind };
          });
      break;
    }
    case "web":
      out.url = c.url;
      break;
    default:
      break;
  }
  return out;
}

/** A code card's whole height from its rows (no Place.h) */
function codeHeight(c: CodeCard): number {
  const rows = c.segments.reduce((n, s) => n + s.text.length, 0);
  return CODE.head + CODE.top + rows * CODE.row + CODE.bottom + Math.max(0, c.segments.length - 1) * CODE.sep;
}

export const sceneSection = (s: Section): SceneSection => {
  const out: SceneSection = { id: s.id, title: s.title, x: s.x, y: s.y, w: s.w, h: s.h };
  if (s.parent) out.parent = s.parent;
  if (s.color) out.color = s.color;
  if (s.collapsed) out.collapsed = true;
  if (s.locked) out.locked = true;
  return out;
};

export function sceneLink(b: Board, l: Link): SceneLink {
  const out: SceneLink = {
    id: l.id,
    from: l.from,
    to: l.to,
    width: l.style?.width ?? 2,
    head: { start: !!l.style?.head?.start, end: l.style?.head?.end !== false },
  };
  if (l.label) out.label = l.label;
  if (l.style?.dash || l.gen || l.rpc || l.call?.ev?.kind === "manual") out.dash = true;
  if (l.style?.color) out.color = l.style.color;
  if (l.call) out.call = true;
  if (l.back) out.back = true;
  const from = b.cards.find((c) => c.id === l.from.card);
  if (from?.kind === "note" && from.look === "mark") out.hand = from.hand ?? "blue";
  return out;
}

export async function scene(b: Board, env: SceneEnv, quick = false): Promise<Scene> {
  const cards = (await Promise.all(b.cards.map((c) => sceneCard(b, c, env, quick)))).filter((c): c is SceneCard => !!c);
  return {
    id: b.id,
    name: b.name,
    cam: b.cam,
    cards,
    sections: b.sections.map(sceneSection),
    links: b.links.map((l) => sceneLink(b, l)),
    routing: routeModel(b),
  };
}

// The scene: what the native canvas draws, as plain JSON (Scene.swift decodes the same shapes). The bridge builds it from the
// board; after a change only the items that changed go over (SceneChange). Geometry is in world units (the board's px at zoom 1).
import {
  isQuestion,
  CODE_GEO as CODE,
  cardTitle,
  codeGlyph,
  estSize,
  SECTION_PAD,
  sectionFrames,
  type Board,
  type Card,
  type CodeCard,
  type Link,
  type Section,
  type Sticker,
  builtinSticker,
  cardRows,
  skeletonOf,
} from "@codeboard/core";
import { fnv, paperSeed } from "@codeboard/core/canvas";
import { langLabel } from "@codeboard/analysis/langs";
import type { Highlight, SceneTok } from "./highlight";
import { type RouteModel, routeModel } from "./routes";

/** stk: the stickers on this line, chips in the gutter (CodeBody .lstks) */
export type SceneLine = { n: number; toks: SceneTok[]; stk?: SceneGlyph[] };
/** hl: the segment's Highlights (highlighted line ranges, a band under them) */
export type SceneSegment = {
  /** The segment's id (arrows name their line by it: SceneEnd.seg) */
  id: string;
  path: string;
  start: number;
  end: number;
  lang: string;
  /** The shown lines (hidden ones are left out: core cardRows) */
  lines: SceneLine[];
  /** Runs of hidden lines, drawn as a gap row before the line after them ("⋯ N lines hidden (a–b)") */
  gaps?: [number, number][];
  /** A Highlight's Always Show sidenotes, drawn under its last line (CodeBody .inotes), starting `lead` columns in */
  inotes?: { after: number; lead: number; md: string[] }[];
  hl?: [number, number][];
  /** Lines an arrow starts from (CodeBody fromLines: the row's --row tint, its number in --no-link) */
  from?: number[];
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
  /** Ink Wash: which of the paper's edge patterns this card gets (core paperSeed) */
  seed: number;
  /** Code: the kind glyph and the segments' coloured lines; a Free code card its language's label instead of a kind; `pending`
   *  while its grammar loads (plain lines, not to be drawn) */
  glyph?: string;
  /** Code: sidenotes on the whole card (no lines): the count chip in the head (CodeHead .mk.inline) */
  notes?: number;
  lang?: string;
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
  /** Sub-board: the board it shows, its card count (the name is the title) and its skeleton as JSON (core skeletonOf): the
   *  card page draws the map from it (core mapHtml, the board's BoardBody) */
  board?: string;
  count?: number;
  skel?: string;
  /** Web */
  url?: string;
};
export type SceneSection = Pick<
  Section,
  "id" | "title" | "x" | "y" | "w" | "h" | "parent" | "color" | "collapsed" | "locked"
> & {
  /** Ink Wash: the seed of its brush frame (the board's inkframe.ts: fnv of the id) */
  seed: number;
  /** The cards in it, nested Sections' included (the collapsed frame says "· N cards": the board's allMembers) */
  count: number;
  /** Its own rect as stored: the shell grows it around its cards as drawn (x / y / w / h are the frame around their estimates) */
  own: { x: number; y: number; w: number; h: number };
};
export type SceneLink = {
  id: string;
  from: Link["from"];
  to: Link["to"];
  label?: string;
  /** Where the label sits along the curve (0–1) once the user dragged it; none = the middle (Link.at) */
  at?: number;
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
  stickers: SceneSticker[];
  id: string;
  name: string;
  cam: Board["cam"];
  cards: SceneCard[];
  sections: SceneSection[];
  links: SceneLink[];
  /** What the shell's own router (off the main thread, during a drag) routes with */
  routing: RouteModel;
  /** The room a Section's frame leaves around each card and nested Section in it (core SECTION_PAD) */
  sectionPad: typeof SECTION_PAD;
};
/** What changed: items to put in (added or changed) and ids that are gone */
export type SceneChange = {
  cards: SceneCard[];
  sections: SceneSection[];
  links: SceneLink[];
  stickers: SceneSticker[];
  gone: { cards: string[]; sections: string[]; links: string[]; stickers: string[] };
  /** Cards only placed elsewhere (a drag), nothing else of them changed: no card to rebuild */
  moved: { id: string; x: number; y: number; section?: string }[];
  name?: string;
  /** When a card or link changed: the routing model as it is now */
  routing?: RouteModel;
};

/** A sticker on the canvas (core Sticker at kind "canvas"): its world rect (one bound to a card is placed from the card's corner)
 *  and what to draw: a built-in disc (its Lucide path or label), an emoji, or nothing known (a custom pack: a grey box) */
/** What a sticker shows. Built-in: the disc colour and its line (d), filled shape (fill) or label (text); emoji: the
 *  character; neither: a custom pack's icon the app does not read (drawn as the board's missing box) */
export type SceneGlyph = {
  color?: string;
  d?: string;
  fill?: string;
  text?: string;
  emoji?: string;
  pack?: string;
  name?: string;
};
export type SceneSticker = {
  id: string;
  /** On the canvas or relative to the card it is bound to; bound to an arrow: the offset from the point t along it */
  x: number;
  y: number;
  size: number;
  /** The card it is bound to (it moves with it) */
  card?: string;
  /** The arrow it rides, at t (0–1) along its curve */
  link?: string;
  t?: number;
  g: SceneGlyph;
  /** A question (the ? sticker, or one written): its text and whether it is answered */
  q?: { md: string; done: boolean };
  /** The colour the user chose (the icon's own otherwise); emoji stickers have none to choose */
  color?: string;
  emoji?: boolean;
};

/** An answered question shows ✓ (the board's shownIcon) */
function sceneGlyph(s: Sticker): SceneGlyph {
  const icon = s.q?.done ? { pack: "builtin", name: "check" } : s.icon;
  const g: SceneGlyph = {};
  if (icon.pack === "builtin") {
    const bi = builtinSticker(icon.name);
    if (bi) {
      g.color = s.q?.done ? bi.color : (s.color ?? bi.color);
      if (bi.d) g.d = bi.d;
      if (bi.fill) g.fill = bi.fill;
      if (bi.text) g.text = bi.text;
    }
  } else if (icon.pack === "emoji") g.emoji = icon.name;
  else {
    g.pack = icon.pack;
    g.name = icon.name;
  }
  return g;
}

export function sceneSticker(b: Board, s: Sticker): SceneSticker | null {
  const at = s.at;
  if (at.kind !== "canvas") return null; // a line sticker is in its card's gutter (SceneLine.stk)
  const out: SceneSticker = { id: s.id, x: at.x, y: at.y, size: at.size ?? 32, g: sceneGlyph(s) };
  if (isQuestion(s)) out.q = { md: s.q?.md ?? "", done: !!s.q?.done };
  if (s.color) out.color = s.color;
  if (s.icon.pack === "emoji") out.emoji = true;
  if (at.on && "card" in at.on) {
    const p = b.place[at.on.card];
    if (!p) return null;
    out.card = at.on.card;
    out.x += p.x;
    out.y += p.y;
  } else if (at.on) {
    if (!b.links.some((x) => x.id === (at.on as { link: string }).link)) return null;
    out.link = at.on.link;
    out.t = at.on.t;
  }
  return out;
}

export type SceneEnv = {
  assetsDir: string;
  /** Another board's name and cards (for a sub-board card's map); null when it is not there */
  peek(id: string): Board | null | undefined;
  hl: Pick<Highlight, "tokens">;
};

/** A sub-board frame's height when the board gave it none (the board's state/subboards.ts FRAME_H) */
const FRAME_H = 320;

/** Where a line's text starts, in columns (the board's highlights.ts leadCols: a tab goes on to the next stop of 4) */
function leadCols(t: string): number {
  let x = 0;
  for (const ch of t) {
    if (ch === " ") x++;
    else if (ch === "\t") x = (Math.floor(x / 4) + 1) * 4;
    else break;
  }
  return x;
}

const sepName = (p: string) => p.split("/").pop() ?? p;

/** `quick`: a Code card whose grammar is still loading comes back `pending` with plain lines (the shell shows its placeholder; the
 *  finished card follows as a change) */
export async function sceneCard(b: Board, c: Card, env: SceneEnv, quick = false): Promise<SceneCard | null> {
  const p = b.place[c.id];
  if (!p) return null;
  const out: SceneCard = {
    id: c.id,
    kind: c.kind,
    x: p.x,
    y: p.y,
    w: p.w,
    title: cardTitle(c, b),
    seed: paperSeed(c.id),
  };
  if (p.section) out.section = p.section;
  if (p.locked) out.locked = true;
  if (c.tilt) out.tilt = true;
  if (p.h) {
    out.h = estSize(c, p).h;
    out.fixed = true;
  } else if (p.mh) out.h = p.mh;
  switch (c.kind) {
    case "code":
      // a Free code card shows no kind (CodeHead: its language is a hover button)
      if (c.segments[0]?.src.kind !== "free") out.glyph = codeGlyph(c);
      else if (c.segments[0]) out.lang = langLabel(c.segments[0].lang);
      // the rows the board shows (core cardRows): hidden lines become gaps
      const rows = cardRows(c);
      out.segments = await Promise.all(
        c.segments.map(async (s) => {
          const toks = await env.hl.tokens(s.lang, s.text, !quick);
          if (!toks) out.pending = true;
          const from = b.links
            .filter((l) => l.from.card === c.id && l.from.seg === s.id && l.from.line !== undefined)
            .map((l) => l.from.line as number);
          const shown = new Set(rows.flatMap((r) => (r.t === "line" && r.seg === s.id ? [r.line] : [])));
          const gaps = rows.flatMap((r): [number, number][] =>
            r.t === "gap" && r.seg === s.id ? [[r.from, r.to]] : [],
          );
          // Always Show notes by the lines they sit on: under the last shown line, as far in as the least indented line
          const byRange = new Map<string, { after: number; lead: number; md: string[] }>();
          for (const n of b.sidenotes) {
            if (n.kind !== "text" || !n.alwaysShow || n.at.card !== c.id || n.at.seg !== s.id || !n.at.lines) continue;
            const [a, z] = n.at.lines;
            const key = `${a}-${z}`;
            let e = byRange.get(key);
            if (!e) {
              const inRange = s.text
                .map((t, i) => [s.start + i, t] as const)
                .filter(([k]) => k >= a && k <= z && shown.has(k));
              const after = inRange.length ? inRange[inRange.length - 1][0] : -1;
              const lead = Math.min(...inRange.filter(([, t]) => t.trim()).map(([, t]) => leadCols(t)), 1e9);
              e = { after, lead: lead === 1e9 ? 0 : lead, md: [] };
              byRange.set(key, e);
            }
            e.md.push(n.md);
          }
          const inotes = [...byRange.values()].filter((e) => e.after >= 0).sort((x, y) => x.after - y.after);
          return {
            id: s.id,
            path: s.src.kind === "free" ? "" : sepName(s.path),
            start: s.start,
            end: s.end,
            lang: s.lang,
            lines: s.text.flatMap((_, i) => {
              const n = s.start + i;
              if (!shown.has(n)) return [];
              const stk = b.stickers
                .filter((k) => k.at.kind === "line" && k.at.card === c.id && k.at.seg === s.id && k.at.line === n)
                .map(sceneGlyph);
              return [{ n, toks: toks?.[i] ?? [[s.text[i]]], ...(stk.length ? { stk } : {}) }];
            }),
            ...(gaps.length ? { gaps } : {}),
            ...(inotes.length ? { inotes } : {}),
            ...(s.hl?.length ? { hl: s.hl } : {}),
            ...(from.length ? { from } : {}),
          };
        }),
      );
      const notes = b.sidenotes.filter((n) => n.at.card === c.id && !n.at.lines).length;
      if (notes) out.notes = notes;
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
      if (sub) {
        // the name above the frame: the card's own title, else the board's (BoardBody)
        if (!c.title) out.title = sub.name;
        const sk = skeletonOf(sub, (id) => env.peek(id) ?? undefined);
        out.count = sk.n;
        out.skel = JSON.stringify(sk);
      }
      // the frame's height is the board's own (Place.h, else FRAME_H), never measured
      out.h = p.h ?? FRAME_H;
      out.fixed = true;
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

/** Each Section's frame as the board shows it: its own rect grown around its members (core sectionFrames; the board's
 *  state/sections.ts frames does the same over measured cards; here a Note the app has not measured counts at its estimate) */
export function sectionRects(b: Board): Map<string, { x: number; y: number; w: number; h: number }> {
  const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const c of b.cards) {
    const p = b.place[c.id];
    if (p) rects.set(c.id, { x: p.x, y: p.y, w: p.w, h: estSize(c, p).h });
  }
  return sectionFrames(b, rects);
}

/** The cards in a Section and in the Sections inside it */
function memberCount(b: Board, id: string): number {
  const inside = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of b.sections)
      if (s.parent && inside.has(s.parent) && !inside.has(s.id)) {
        inside.add(s.id);
        grew = true;
      }
  }
  return b.cards.filter((c) => {
    const sec = b.place[c.id]?.section;
    return !!sec && inside.has(sec);
  }).length;
}

export const sceneSection = (b: Board, s: Section): SceneSection => {
  const r = sectionRects(b).get(s.id) ?? s;
  const out: SceneSection = {
    id: s.id,
    title: s.title,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    seed: fnv(s.id) & 0xffffff,
    count: memberCount(b, s.id),
    own: { x: s.x, y: s.y, w: s.w, h: s.h },
  };
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
  if (l.at !== undefined) out.at = l.at;
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
    sections: b.sections.map((s) => sceneSection(b, s)),
    stickers: b.stickers.flatMap((s) => sceneSticker(b, s) ?? []),
    links: b.links.map((l) => sceneLink(b, l)),
    routing: routeModel(b),
    sectionPad: SECTION_PAD,
  };
}

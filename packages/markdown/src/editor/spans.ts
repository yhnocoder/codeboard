// How the editor draws one paragraph's source (paragraph, heading, cell): the parser (schema.ts inlineTokens, the same rules
// parseMd reads it with) splits it into tokens, and for each: where it is in the source, which characters are markers, and how
// the text inside is drawn. Only the look; the document is never changed (the decorations are in inline.ts)
import { ESC_DOLLAR, TEXT_MATH, inlineTokens, type InlineToken } from "../schema";

type Range = [number, number];
/** Something drawn in place of its source (while the caret is elsewhere the source is hidden and it counts as one character) */
export type Atom =
  | { type: "math"; latex: string; display: boolean }
  | { type: "image"; src: string; alt: string; title: string; width: number | null; altTo: number; url: Range; widthAt: Range | null; broken: boolean }
  | { type: "emoji"; name: string }
  | { type: "ref"; label: string }
  | { type: "fn"; label: string }
  | { type: "html"; raw: string }
  | { type: "br" }
  | { type: "annot"; note: string; color: string; below: boolean; text: string };
export type Span = {
  from: number; to: number;
  /** Markers (hidden while the caret is elsewhere) */
  marks: Range[];
  /** The text inside (the formatted part; drawn as tag) */
  inner: Range | null;
  tag?: { nodeName: string; [k: string]: string };
  atom?: Atom;
  /** Source that always shows (HTML comments): never hidden, not one character */
  plain?: true;
  kids: Span[];
};
export type BlockInfo = { level: number; prefix: number; spans: Span[] };

const TAGS: Record<string, string> = {
  strong: "strong", em: "em", del: "s", codespan: "code",
  x_underline: "u", x_kbd: "kbd", x_highlight: "mark", x_subscript: "sub", x_superscript: "sup",
};
const HEAD = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;

const cache = new Map<string, BlockInfo>();
const MAX = 2000;
/** The look of one paragraph's source; headings: whether it can be a heading (cells cannot) */
export function blockInfo(text: string, headings = true): BlockInfo {
  const key = (headings ? "h" : "c") + text;
  let info = cache.get(key);
  if (info) return info;
  const h = headings ? HEAD.exec(text) : null;
  const prefix = h ? h[0].length : 0;
  info = { level: h ? h[1].length : 0, prefix, spans: inlineSpans(text, prefix) };
  if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, info);
  return info;
}

/** The inline content of text from at on, as spans (before at is a heading's "## ") */
function inlineSpans(text: string, at = 0): Span[] {
  const body = text.slice(at);
  if (!body) return [];
  // an escaped \$ becomes a placeholder as in parseMd (the parser can't tell \$ from $); still two characters, so offsets hold
  const src = body.replace(/\\\$/g, `\\${ESC_DOLLAR}`);
  let toks: InlineToken[];
  try { toks = inlineTokens(src); } catch { return []; }
  const out: Span[] = [];
  walk(toks, src, at, out);
  return out;
}

function walk(toks: InlineToken[], src: string, base: number, out: Span[]) {
  let at = 0;
  for (const t of toks) {
    const raw = t.raw ?? "", from = base + at, to = from + raw.length;
    if (src.slice(at, at + raw.length) !== raw) break; // the tokens no longer match the text (the lexer rewrote it): draw nothing after
    const sp = spanOf(t, raw, src, at, from, to);
    if (sp) out.push(sp);
    else if (t.type === "text" || t.type === "escape") textSpans(raw, from, out);
    at += raw.length;
  }
}

function spanOf(t: InlineToken, raw: string, src: string, at: number, from: number, to: number): Span | null {
  const mk = (marks: Range[], inner: Range | null, extra: Partial<Span> = {}): Span => ({ from, to, marks, inner, kids: [], ...extra });
  switch (t.type) {
    case "escape": return mk([[from, from + 1]], [from + 1, to]);
    case "codespan": {
      const a = /^`+/.exec(raw)![0].length, b = /`+$/.exec(raw)![0].length;
      return mk([[from, from + a], [to - b, to]], [from + a, to - b], { tag: { nodeName: "code" } });
    }
    case "link": {
      const kids = t.tokens ?? [], inner = kids.map((k) => k.raw).join("");
      const i = inner ? raw.indexOf(inner) : raw.startsWith("[") ? 1 : 0;
      const href = String(t.href ?? "");
      if (i < 0) return null;
      const sp = mk([], [from + i, from + i + inner.length], { tag: { nodeName: "a", class: "lnk", href } });
      if (i > 0) sp.marks.push([from, from + i]);
      if (i + inner.length < raw.length) sp.marks.push([from + i + inner.length, to]);
      walk(kids, src.slice(at + i, at + i + inner.length), from + i, sp.kids);
      return sp;
    }
    case "image": return { ...mk([], null), atom: imageAtom(t, raw, from) };
    case "inlineMath": return { ...mk(dollarMarks(raw, from, to), [from + (raw.startsWith("$$") ? 2 : 1), to - (raw.startsWith("$$") ? 2 : 1)]), atom: { type: "math", latex: String(t.latex ?? ""), display: !!t.display } };
    case "emoji": return { ...mk([[from, from + 1], [to - 1, to]], [from + 1, to - 1]), atom: { type: "emoji", name: String(t.name ?? "") } };
    case "wikiRef": return { ...mk([[from, from + 2], [to - 2, to]], [from + 2, to - 2], { tag: { nodeName: "span", class: "md-refsrc" } }), atom: { type: "ref", label: String(t.label ?? "") } };
    case "footnoteReference": return { ...mk([[from, to]], null), atom: { type: "fn", label: String(t.label ?? "") } };
    case "br": return { ...mk([[from, to]], null), atom: { type: "br" } };
    case "htmlInline": {
      if (/^<br\s*\/?>$/i.test(raw)) return { ...mk([[from, to]], null), atom: { type: "br" } };
      if (/^<!--[\s\S]*-->$/.test(raw)) return mk([[from, to]], null, { plain: true });
      return { ...mk([[from, to]], null), atom: { type: "html", raw } };
    }
    case "x_annot": {
      // { } | \ in the text and the note are written \{ \} \| \\: the text runs from { to the first unescaped |
      let k = 1;
      while (k < raw.length && raw[k] !== "|") k += raw[k] === "\\" ? 2 : 1;
      return { ...mk([[from, from + 1], [from + k, to]], [from + 1, from + k], { tag: { nodeName: "span", class: "md-annotsrc" } }),
        atom: { type: "annot", note: String(t.note ?? ""), color: String(t.color ?? "blue"), below: !!t.below, text: raw.slice(1, k) } };
    }
  }
  const tag = TAGS[t.type];
  if (!tag || !t.tokens) return null;
  const inner = t.tokens.map((k) => k.raw).join("");
  // where the inner text starts: after a tag (<u>, <kbd>), else between markers of equal length (** and __, ~ and ~~)
  const sym = (raw.length - inner.length) / 2;
  const i = raw.startsWith("<") ? raw.indexOf(">") + 1 : Number.isInteger(sym) && raw.slice(sym, sym + inner.length) === inner ? sym : raw.indexOf(inner, 1);
  if (i <= 0 || raw.slice(i, i + inner.length) !== inner) return null;
  const sp = mk([[from, from + i], [from + i + inner.length, to]], [from + i, from + i + inner.length], { tag: { nodeName: tag } });
  walk(t.tokens, src.slice(at + i, at + i + inner.length), from + i, sp.kids);
  return sp;
}

const dollarMarks = (raw: string, from: number, to: number): Range[] => { const d = raw.startsWith("$$") ? 2 : 1; return [[from, from + d], [to - d, to]]; };

/** Escapes \X in text, and $formulas$ the lexer left as text (parseMd's mathify reads them too) */
function textSpans(raw: string, from: number, out: Span[]) {
  for (let i = raw.indexOf("\\"); i >= 0 && i < raw.length - 1; i = raw.indexOf("\\", i + 2)) {
    if (raw[i + 1] === ESC_DOLLAR) out.push({ from: from + i, to: from + i + 2, marks: [[from + i, from + i + 1]], inner: [from + i + 1, from + i + 2], kids: [] });
  }
  if (!raw.includes("$")) return;
  TEXT_MATH.lastIndex = 0;
  for (let m = TEXT_MATH.exec(raw); m; m = TEXT_MATH.exec(raw)) {
    const a = from + m.index + m[1].length, b = a + m[2].length + 2;
    out.push({ from: a, to: b, marks: [[a, a + 1], [b - 1, b]], inner: [a + 1, b - 1], atom: { type: "math", latex: m[2], display: false }, kids: [] });
  }
  out.sort((x, y) => x.from - y.from);
}

const IMG_HEAD = /^!\[((?:\\.|[^\]\\])*)\]\(\s*/;
const IMG_WIDTH = /\{width=(\d{1,3}(?:\.\d+)?)%\}$/;
function imageAtom(t: InlineToken, raw: string, from: number): Atom {
  const h = IMG_HEAD.exec(raw), altTo = 2 + (h ? h[1].length : 0), urlFrom = h ? h[0].length : 2;
  let urlTo = urlFrom;
  if (raw[urlFrom] === "<") urlTo = raw.indexOf(">", urlFrom) + 1 || urlFrom;
  else { let depth = 0; for (; urlTo < raw.length; urlTo++) { const c = raw[urlTo]; if (c === "\\") { urlTo++; continue; } if (/\s/.test(c) || (c === ")" && !depth--)) break; if (c === "(") depth++; } }
  const w = IMG_WIDTH.exec(raw), width = w ? Number(w[1]) : null;
  return {
    type: "image", src: String(t.href ?? ""), alt: String(t.text ?? ""), title: String(t.title ?? ""),
    width: width && width > 0 && width <= 100 ? width : null, altTo: from + altTo, url: [from + urlFrom, from + urlTo],
    widthAt: w ? [from + raw.length - w[0].length, from + raw.length] : null, broken: !!t.broken,
  };
}

/** All spans, nested ones included, in order */
export function flat(spans: Span[], out: Span[] = []): Span[] {
  for (const s of spans) { out.push(s); flat(s.kids, out); }
  return out;
}

/** An offset at the edge of a span's text (right after the opening ** or right before the closing **) moved outside its
 *  markers, innermost span first (so ***x*** steps out of both): what is inserted or split there goes next to the bold
 *  words, not into them */
export function spanEdgeOut(text: string, off: number, headings: boolean): number {
  const spans = flat(blockInfo(text, headings).spans).filter((sp) => !sp.atom && sp.inner && sp.tag).reverse();
  for (const sp of spans) {
    if (off === sp.inner![1] && off < sp.to) off = sp.to;
    else if (off === sp.inner![0] && off > sp.from) off = sp.from;
  }
  return off;
}

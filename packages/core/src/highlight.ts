// Code highlighting: tokens per line (with the board's colour classes) and the HTML a code card shows for a segment.
// Shiki colours the languages the language table gives to it; tree-sitter colours the others through the port, since the
// parsers live with the analysis. Reading files and analysing code also come through ports, so a shell that only has
// board JSON (segments carry their text) gets the same HTML as the host.
import { createHighlighterCore, createCssVariablesTheme, type HighlighterCore, type LanguageInput } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { grammarOf, langInfo, type Grammar } from "@codeboard/analysis/langs";
import type { FileAnalysis } from "@codeboard/analysis";
import { escHtml, renderLine, tokenClass, type Mark, type Tok } from "./render";
import { fingerprint } from "./diff";
import type { CallSpan, SegView } from "./lines";
import type { Segment } from "./model";

// Shiki grammars by the language table's name, loaded the first time they are used
const GRAMMAR: Record<string, LanguageInput> = {
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
};

const splitLines = (t: string) => t.split(/\r?\n/);
const plain = (text: string): Tok[][] => splitLines(text).map((l) => [{ text: l }]);

function shikiLang(lang: string): string | null {
  const h = langInfo(lang)?.highlight;
  return h?.by === "shiki" && h.lang in GRAMMAR ? h.lang : null;
}

/**
 * shiki's theme colours a call's arguments like its brackets, and they come merged into one token ("(a, b "): only the marks
 * stay punctuation, the names between them are plain text. Operators share the keyword colour; "op" lets a look tell them apart
 */
function refine(t: Tok): Tok[] {
  if (t.cls === "kw" && /^\s*[-+*/%=<>!&|^~@:?]+\s*$/.test(t.text)) return [{ text: t.text, cls: "kw op" }];
  if (t.cls !== "p" || !/[\p{L}\p{N}_$]/u.test(t.text)) return [t];
  return t.text
    .split(/([\p{L}\p{N}_$]+|\s+)/u)
    .filter(Boolean)
    .map((x) => ({
      text: x,
      cls: /^\s+$/.test(x) ? undefined : /[\p{L}\p{N}_$]/u.test(x) ? tokenClass(undefined, x) : "p",
    }));
}

/** The line in all where block starts (all of block's lines in a row), or -1 */
function findIndex(all: string[], block: string[]) {
  if (!block.length) return -1;
  outer: for (let i = 0; i + block.length <= all.length; i++) {
    for (let k = 0; k < block.length; k++) if (all[i + k] !== block[k]) continue outer;
    return i;
  }
  return -1;
}

export interface HighlightPort {
  /** Tree-sitter colours for a grammar the language table colours with tree-sitter; null when the parsers are not available */
  treeLines(g: Grammar, text: string, file?: string): Promise<Tok[][] | null>;
}

const TOK_CACHE = 60;

export class Highlighter {
  private hl: Promise<HighlighterCore> | undefined;
  private loaded = new Map<string, Promise<void>>();
  // Promises, so a text several segments ask for at once is tokenised once; insertion order = least recently used first
  private cache = new Map<string, Promise<Tok[][]>>();
  private theme = createCssVariablesTheme({ name: "codeboard", variablePrefix: "--shiki-", fontStyle: true });

  constructor(private port: HighlightPort) {}

  /** Tokens per line. file = text is that file's whole text (at that version): tree-sitter reuses the analysis's tree of it */
  tokensOf(lang: string, text: string, file?: string): Promise<Tok[][]> {
    const g = langInfo(lang)?.highlight?.by === "tree-sitter" ? grammarOf(lang) : null;
    const sl = shikiLang(lang);
    if (!g && !sl) return Promise.resolve(plain(text));
    const k = `${g ? `ts:${g}` : sl}\0${text.length}\0${fingerprint(text)}`;
    let p = this.cache.get(k);
    if (p) this.cache.delete(k);
    else p = g ? this.port.treeLines(g, text, file).then((t) => t ?? plain(text)) : this.tokenize(sl!, text);
    this.cache.set(k, p);
    if (this.cache.size > TOK_CACHE) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  /** A few lines' HTML (diffs, hovered definitions, Focus popovers; no clickable calls). context = the whole file they come from */
  async highlight(lines: string[], lang: string, context?: string): Promise<string[]> {
    if (context) {
      // The whole file's tokens, so strings and docstrings that span lines get the right colour
      const idx = findIndex(splitLines(context), lines);
      if (idx >= 0) {
        const toks = await this.tokensOf(lang, context);
        return lines.map((l, i) => renderLine(toks[idx + i] ?? [{ text: l }]));
      }
    }
    const toks = await this.tokensOf(lang, lines.join("\n"));
    return lines.map((l, i) => renderLine(toks[i] ?? [{ text: l }]));
  }

  private async shiki(sl: string): Promise<HighlighterCore> {
    const h = await (this.hl ??= createHighlighterCore({
      themes: [this.theme],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    }));
    let p = this.loaded.get(sl);
    if (!p) {
      p = h.loadLanguage(GRAMMAR[sl]);
      this.loaded.set(sl, p);
    }
    await p;
    return h;
  }

  private async tokenize(sl: string, text: string): Promise<Tok[][]> {
    const lines = splitLines(text);
    let res: Tok[][];
    try {
      const h = await this.shiki(sl);
      res = h
        .codeToTokens(text, { lang: sl, theme: "codeboard" })
        .tokens.map((line) => line.flatMap((t) => refine({ text: t.content, cls: tokenClass(t.color, t.content) })));
    } catch {
      res = lines.map((l) => [{ text: l }]);
    }
    // A decorator is one colour
    if (sl === "python")
      res.forEach((toks, i) => {
        const l = lines[i] ?? "";
        if (!/^\s*@/.test(l)) return;
        const end = l.search(/\(|$/);
        let col = 0;
        for (const t of toks) {
          if (col < end && t.text.trim()) t.cls = "dec";
          col += t.text.length;
        }
      });
    return res;
  }
}

/** Where a segment view's text and analysis come from */
export interface SegSource {
  /** The whole file at the segment's version; null = only the segment's own text is known */
  fileText(seg: Segment): Promise<string | null>;
  /** The file as it is now (a snippet's imports come from it); null = none */
  currentText(seg: Segment): Promise<string | null>;
  /** The segment's file on disk, the analysis's and tree-sitter's cache key */
  fileOf(seg: Segment): string | null;
  /** Analysis of text; with a range, only the calls and marks inside it are needed (plus the whole file's imports) */
  analyze(lang: string, text: string, range?: { start: number; end: number }, file?: string): FileAnalysis;
  /** Which package each call goes to (shown on the call); none = no packages */
  callPkgs?(
    seg: Segment,
    imports: FileAnalysis["imports"],
    file: string | null,
  ): Promise<(c: { name: string; recv?: string }) => string | undefined>;
}

/** Files longer than this highlight only the segment itself */
const MAX_FULL = 6000;

/** The analysis is done on the whole file at that version where possible (a segment in the middle of a function only parses then); otherwise on the segment's text */
export async function segViewOf(seg: Segment, src: SegSource, hl: Highlighter): Promise<SegView> {
  const lang = seg.lang;
  if (seg.src.kind === "free") return snippetView(seg, src, hl);
  const full = await src.fileText(seg).catch(() => null);
  if (!full || splitLines(full).length > MAX_FULL) return snippetView(seg, src, hl);
  const file = src.fileOf(seg) ?? undefined;
  const fa = src.analyze(lang, full, { start: seg.start, end: seg.end }, file);
  const pkgs = src.callPkgs ? await src.callPkgs(seg, fa.imports, file ?? null) : undefined;
  // A Python function / class segment starts at its def / class / decorator line, in the same lexical state as the file's start:
  // tokenise only the segment (no whole-file shiki for a big file)
  if (
    shikiLang(lang) === "python" &&
    seg.symbol &&
    seg.symbol.kind !== "module" &&
    fa.symbols.some((s) => s.start === seg.start && s.qual === seg.symbol!.qual)
  ) {
    const toks = await hl.tokensOf(lang, seg.text.join("\n"));
    return buildView(seg, fa, (i) => toks[i], 0, 0, pkgs);
  }
  const toks = await hl.tokensOf(lang, full, file);
  return buildView(seg, fa, (i) => toks[seg.start - 1 + i], 0, 0, pkgs);
}

/** Only the segment's text: analysed without its common indent (a Python snippet in the middle of a function parses then), columns added back */
async function snippetView(seg: Segment, src: SegSource, hl: Highlighter): Promise<SegView> {
  const ind = Math.min(...seg.text.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  const cut = Number.isFinite(ind) ? ind : 0;
  const ded = seg.text.map((l) => l.slice(Math.min(cut, l.length - l.trimStart().length)));
  const fa = src.analyze(seg.lang, ded.join("\n"));
  let pkgs: ((c: { name: string; recv?: string }) => string | undefined) | undefined;
  if (src.callPkgs) {
    // Imports are at the file's start, not in the segment: take the current file's
    const file = seg.src.kind === "free" ? null : src.fileOf(seg);
    const cur = file ? await src.currentText(seg).catch(() => null) : null;
    pkgs = await src.callPkgs(
      seg,
      cur ? src.analyze(seg.lang, cur, { start: 1, end: 0 }, file ?? undefined).imports : fa.imports,
      file,
    );
  }
  const toks = await hl.tokensOf(seg.lang, seg.text.join("\n"));
  return buildView(seg, fa, (i) => toks[i], cut, seg.start - 1, pkgs);
}

/**
 * fa's line numbers = segment line - shift (whole file: shift = 0, fa line L is the real line L; the segment's text: fa's line 1
 * is the segment's first line, shift = seg.start - 1). colOff = the indent taken off
 */
function buildView(
  seg: Segment,
  fa: FileAnalysis,
  tokAt: (i: number) => Tok[] | undefined,
  colOff: number,
  shift: number,
  pkgOf: (c: { name: string; recv?: string }) => string | undefined = () => undefined,
): SegView {
  const calls: CallSpan[] = [];
  const marks = new Map<number, Mark[]>();
  for (const c of fa.calls) {
    const line = c.line + shift;
    if (line < seg.start || line > seg.end) continue;
    const idx = calls.length;
    const pkg = pkgOf(c);
    calls.push({
      line,
      col: c.col + colOff,
      end: c.end + colOff,
      name: c.name,
      recv: c.recv,
      loop: c.loop,
      dispatch: c.dispatch,
      pkg,
    });
    const arr = marks.get(line) ?? [];
    arr.push({ col: c.col + colOff, end: c.end + colOff, idx, pkg });
    marks.set(line, arr);
  }
  const html: string[] = [],
    flags: number[] = [];
  const bare: Record<number, string> = {};
  seg.text.forEach((text, i) => {
    const line = seg.start + i;
    const toks = tokAt(i);
    const tk = toks && toks.map((t) => t.text).join("") === text ? toks : [{ text }];
    html.push(renderLine(tk, marks.get(line)));
    flags.push(fa.flags[line - shift - 1] ?? (text.trim() ? 0 : 1));
    const tr = fa.trailing[line - shift];
    if (tr !== undefined) bare[line] = renderLine(tk, marks.get(line), tr + colOff);
  });
  const defs = fa.symbols
    .map((s) => ({ ...s, defLine: s.defLine + shift }))
    .filter((s) => s.defLine >= seg.start && s.defLine <= seg.end)
    .map((s) => ({ line: s.defLine, name: s.name, qual: s.qual }));
  return { html, bare: Object.keys(bare).length ? bare : undefined, flags, calls, defs };
}

/** A plain-text view: what a segment shows when its view could not be built */
export const plainView = (seg: Segment): SegView => ({
  html: seg.text.map(escHtml),
  flags: seg.text.map((l) => (l.trim() ? 0 : 1)),
  calls: [],
  defs: [],
});

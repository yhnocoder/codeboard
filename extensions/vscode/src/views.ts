// 段的展示数据（SegView）：shiki 高亮成每行 HTML，调用名字套 .call，加上注释 / docstring / 空行标记和段里的函数。
// 分析尽量在「那个版本」的整个文件上做（片段在函数中间时语法才对），拿不到整个文件就分析段文本本身。
import { createHighlighterCore, createCssVariablesTheme, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import python from "shiki/langs/python.mjs";
import cpp from "shiki/langs/cpp.mjs";
import c from "shiki/langs/c.mjs";
import { escHtml, fingerprint, renderLine, tokenClass, type CallSpan, type Mark, type Segment, type SegView, type Tok } from "@codeboard/core";
import type { FileAnalysis } from "@codeboard/core/analysis";
import { analysisOf } from "./analysis";
import { versionText } from "./source";
import { Lru, splitLines } from "./ws";

const theme = createCssVariablesTheme({ name: "codeboard", variablePrefix: "--shiki-", fontStyle: true });
let hl: Promise<HighlighterCore> | undefined;
const highlighter = () =>
  (hl ??= createHighlighterCore({ themes: [theme], langs: [python, cpp, c], engine: createJavaScriptRegexEngine({ forgiving: true }) }));

/** VS Code languageId → shiki 语言；Triton、TileLang 都是 Python */
function shikiLang(lang: string): string | null {
  if (/^(python|triton|tilelang)$/.test(lang)) return "python";
  if (/^(cpp|cuda-cpp|cuda|objective-cpp)$/.test(lang)) return "cpp";
  if (lang === "c") return "c";
  return null;
}

const tokCache = new Lru<Tok[][]>(60);

/** 每行的 token（带白板的颜色 class） */
export async function tokensOf(lang: string, text: string): Promise<Tok[][]> {
  const lines = splitLines(text);
  const sl = shikiLang(lang);
  if (!sl) return lines.map((l) => [{ text: l }]);
  const k = `${sl}\0${text.length}\0${fingerprint(text)}`;
  const hit = tokCache.get(k);
  if (hit) return hit;
  const h = await highlighter();
  let res: Tok[][];
  try {
    res = h.codeToTokens(text, { lang: sl, theme: "codeboard" }).tokens.map((line) => line.map((t) => ({ text: t.content, cls: tokenClass(t.color, t.content) })));
  } catch {
    res = lines.map((l) => [{ text: l }]);
  }
  // 装饰器整体一个颜色
  if (sl === "python") res.forEach((toks, i) => {
    const l = lines[i] ?? "";
    if (!/^\s*@/.test(l)) return;
    const end = l.search(/\(|$/);
    let col = 0;
    for (const t of toks) { if (col < end && t.text.trim()) t.cls = "dec"; col += t.text.length; }
  });
  tokCache.set(k, res);
  return res;
}

/** 几行代码的高亮 HTML（diff、悬停定义、Focus 浮窗用；没有可点的调用） */
export async function highlight(lines: string[], lang: string, context?: string): Promise<string[]> {
  if (context) {
    const all = splitLines(context);
    // 在整个文件里找这几行的位置，用整个文件的 token（字符串、docstring 跨行时颜色才对）
    const idx = findIndex(all, lines);
    if (idx >= 0) {
      const toks = await tokensOf(lang, context);
      return lines.map((l, i) => renderLine(toks[idx + i] ?? [{ text: l }]));
    }
  }
  const toks = await tokensOf(lang, lines.join("\n"));
  return lines.map((l, i) => renderLine(toks[i] ?? [{ text: l }]));
}

function findIndex(all: string[], block: string[]) {
  if (!block.length) return -1;
  outer: for (let i = 0; i + block.length <= all.length; i++) {
    for (let k = 0; k < block.length; k++) if (all[i + k] !== block[k]) continue outer;
    return i;
  }
  return -1;
}

const MAX_FULL = 6000; // 超过这么多行的文件只高亮段本身

/** 一段代码的展示数据 */
export async function segView(seg: Segment): Promise<SegView> {
  const lang = seg.lang;
  if (seg.src.kind === "free") return snippetView(seg);
  const full = await versionText(seg).catch(() => null);
  if (!full || splitLines(full).length > MAX_FULL) return snippetView(seg);
  const fa = analysisOf(lang, full);
  const toks = await tokensOf(lang, full);
  return build(seg, fa, (i) => toks[seg.start - 1 + i], 0, 0);
}

/** 只有段文本：去掉公共缩进再分析（Python 片段在函数中间时才能解析），列号再加回来 */
function snippetView(seg: Segment): Promise<SegView> | SegView {
  const ind = Math.min(...seg.text.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  const cut = Number.isFinite(ind) ? ind : 0;
  const ded = seg.text.map((l) => l.slice(Math.min(cut, l.length - l.trimStart().length)));
  const fa = analysisOf(seg.lang, ded.join("\n"));
  return tokensOf(seg.lang, seg.text.join("\n")).then((toks) => build(seg, fa, (i) => toks[i], cut, seg.start - 1));
}

/**
 * fa 的行号 = 段行号 - lineOff（整个文件：lineOff = 0，fa 行 L 就是真实行 L）；
 * 段文本分析时 fa 的第 1 行是段的第一行，shift = seg.start - 1。colOff = 去掉的缩进。
 */
function build(seg: Segment, fa: FileAnalysis, tokAt: (i: number) => Tok[] | undefined, colOff: number, shift: number): SegView {
  const calls: CallSpan[] = [];
  const marks = new Map<number, Mark[]>();
  for (const c of fa.calls) {
    const line = c.line + shift;
    if (line < seg.start || line > seg.end) continue;
    const idx = calls.length;
    calls.push({ line, col: c.col + colOff, end: c.end + colOff, name: c.name, recv: c.recv, loop: c.loop, dispatch: c.dispatch });
    const arr = marks.get(line) ?? [];
    arr.push({ col: c.col + colOff, end: c.end + colOff, idx });
    marks.set(line, arr);
  }
  const html: string[] = [], flags: number[] = [];
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

/** 一批段的展示数据（失败的段给纯文本，不让整块白板出错） */
export async function viewsFor(segs: Segment[]): Promise<Record<string, SegView>> {
  const out: Record<string, SegView> = {};
  await Promise.all(segs.map(async (s) => {
    try { out[s.id] = await segView(s); } catch (e) {
      console.error("[codeboard] view", s.path, e);
      out[s.id] = { html: s.text.map(escHtml), flags: s.text.map((l) => (l.trim() ? 0 : 1)), calls: [], defs: [] };
    }
  }));
  return out;
}

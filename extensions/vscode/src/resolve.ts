// 点调用展开（expand）、标识符悬停看定义（peek）、全工作区的符号名字索引。
// 先问 VS Code 的「转到定义」（装了 Pylance、clangd 时最准）；钉的版本不是工作区当前内容、或者语言服务没给结果时，按名字在索引里找。
import * as vscode from "vscode";
import * as path from "node:path";
import { rankByReceiver, type CodeCard, type ExpandResult, type PeekDef, type PeekResult, type Segment, type Var } from "@codeboard/core";
import { symbolAt, varCandidates, type CallSite, type Sym } from "@codeboard/core/analysis";
import { analysisOf } from "./analysis";
import { cardForFileSym, symCard } from "./cards";
import { absOf, locOfFile, versionText } from "./source";
import { makeSegment, workingPlace } from "./versions";
import { highlight } from "./views";
import { CODE_EXCLUDE, CODE_GLOB, fromHostPath, hostPath, langOf, mkUid, readText, splitLines } from "./ws";

// ---------- 名字索引 ----------

export type IndexEntry = { name: string; qual: string; kind: Sym["kind"]; abs: string; start: number; end: number; defLine: number; sig: string };

let index: Promise<Map<string, IndexEntry[]>> | undefined;
const byFile = new Map<string, IndexEntry[]>();

async function indexFile(abs: string, text?: string | null) {
  text ??= await readText(abs);
  const old = byFile.get(abs) ?? [];
  const ents: IndexEntry[] = [];
  if (text !== null && text.length < 2_000_000) {
    for (const s of analysisOf(langOf(abs), text).symbols) ents.push({ name: s.name, qual: s.qual, kind: s.kind, abs, start: s.start, end: s.end, defLine: s.defLine, sig: s.sig });
  }
  byFile.set(abs, ents);
  return { old, ents };
}

export function nameIndex(): Promise<Map<string, IndexEntry[]>> {
  return (index ??= (async () => {
    const files = await vscode.workspace.findFiles(CODE_GLOB, CODE_EXCLUDE, 8000);
    const m = new Map<string, IndexEntry[]>();
    for (const f of files) {
      const { ents } = await indexFile(f.fsPath);
      for (const e of ents) (m.get(e.name) ?? m.set(e.name, []).get(e.name)!).push(e);
    }
    return m;
  })());
}

/** 文件保存 / 新建 / 删除：只重做这个文件 */
export async function reindexFile(abs: string) {
  if (!index) return;
  const m = await index;
  const { old, ents } = await indexFile(abs);
  for (const e of old) { const l = m.get(e.name); if (l) m.set(e.name, l.filter((x) => x.abs !== abs)); }
  for (const e of ents) (m.get(e.name) ?? m.set(e.name, []).get(e.name)!).push(e);
}
export function resetIndex() { index = undefined; byFile.clear(); }

// ---------- 转到定义 ----------

type Def = { abs: string; line: number; col: number };

async function lspDefs(abs: string, line: number, col: number): Promise<Def[]> {
  try {
    const r = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      "vscode.executeDefinitionProvider", vscode.Uri.file(abs), new vscode.Position(line - 1, col),
    );
    const out: Def[] = [];
    for (const d of r ?? []) {
      const uri = "targetUri" in d ? d.targetUri : d.uri;
      const range = "targetUri" in d ? (d.targetSelectionRange ?? d.targetRange) : d.range;
      if (uri.scheme !== "file") continue;
      if (uri.fsPath === abs && range.start.line === line - 1) continue; // 指回调用处自己
      out.push({ abs: uri.fsPath, line: range.start.line + 1, col: range.start.character });
    }
    return out;
  } catch { return []; }
}

/** 定义位置 → 那里的函数 / 类 */
async function symAtDef(d: Def, name?: string): Promise<{ abs: string; sym: Sym } | null> {
  const text = await readText(d.abs);
  if (text === null) return null;
  const syms = analysisOf(langOf(d.abs), text).symbols;
  const sym = syms.find((s) => s.defLine === d.line && (!name || s.name === name)) ?? syms.find((s) => s.defLine === d.line)
    ?? (name ? symbolAt(syms.filter((s) => s.name === name), d.line) : undefined);
  return sym ? { abs: d.abs, sym } : null;
}

const toSym = (e: IndexEntry): Sym => ({ name: e.name, qual: e.qual, kind: e.kind, start: e.start, end: e.end, defLine: e.defLine, sig: e.sig, params: [] });

// ---------- expand ----------

type ExpandReq = { seg: Segment; line: number; col: number; name: string; recv?: string; pick?: { path: string; line: number } };

const none = (reason: string): ExpandResult => ({ none: true, reason });

export async function expand(m: ExpandReq): Promise<ExpandResult> {
  const seg = m.seg;
  if (seg.src.kind === "free") return none("Free code has no source to follow.");
  if (seg.src.kind === "github") return none("Expanding calls in GitHub code is not supported yet.");
  const full = await versionText(seg);
  const site = callSite(seg, full, m);
  if (site?.dispatch && site.dispatch === m.name) return none("Dynamic dispatch: not resolved");

  let targets: { abs: string; sym: Sym }[] = [];
  if (m.pick) {
    const t = await symAtDef({ abs: fromHostPath(m.pick.path), line: m.pick.line, col: 0 });
    if (t) targets = [t];
  } else {
    const wp = await workingPlace(seg);
    if (wp?.exact) {
      const line = wp.start + (m.line - seg.start);
      for (const d of await lspDefs(wp.abs, line, m.col)) {
        const t = await symAtDef(d, m.name);
        if (t && !targets.some((x) => x.abs === t.abs && x.sym.qual === t.sym.qual)) targets.push(t);
      }
    }
    if (!targets.length) {
      const cands = ((await nameIndex()).get(m.name) ?? []).map((e) => ({ ...e, path: hostPath(e.abs), line: e.defLine }));
      if (cands.length) {
        const selfClass = (seg.symbol?.kind === "class" ? seg.symbol.qual : seg.symbol?.qual.split(".").slice(0, -1).join(".")) || seg.scope?.split(".").slice(0, -1).join(".");
        const here = await currentFile(seg);
        const { ranked, best } = rankByReceiver(cands, m.recv ?? site?.recv, { path: here, selfClass });
        if (best) targets = [{ abs: best.abs, sym: toSym(best) }];
        else return { pick: ranked.slice(0, 20).map((e) => ({ label: e.qual, detail: `${e.path}:${e.defLine}`, path: e.path, line: e.defLine })) };
      }
    }
  }
  if (!targets.length) return none(site?.dispatch ? "Dynamic dispatch: not resolved" : `No definition found for “${m.name}”.`);
  if (targets.length > 1) return { pick: targets.map((t) => ({ label: t.sym.qual, detail: `${hostPath(t.abs)}:${t.sym.defLine}`, path: hostPath(t.abs), line: t.sym.defLine })) };

  const t = targets[0];
  const nc = await cardForFileSym(t.abs, t.sym);
  if (!nc) return none(`Cannot read ${hostPath(t.abs)}.`);
  return { card: nc.card as CodeCard, views: nc.views, vars: site ? await varsFor(site, t) : [] };
}

async function currentFile(seg: Segment) {
  const loc = (await workingPlace(seg))?.abs;
  return loc ? hostPath(loc) : seg.path;
}

function callSite(seg: Segment, full: string | null, m: ExpandReq): CallSite | undefined {
  let calls: CallSite[];
  let shift = 0, colOff = 0;
  if (full) calls = analysisOf(seg.lang, full).calls;
  else {
    const ind = Math.min(...seg.text.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    colOff = Number.isFinite(ind) ? ind : 0;
    calls = analysisOf(seg.lang, seg.text.map((l) => l.slice(Math.min(colOff, l.length - l.trimStart().length))).join("\n")).calls;
    shift = seg.start - 1;
  }
  const on = calls.filter((c) => c.line + shift === m.line);
  return on.find((c) => c.col + colOff === m.col) ?? on.find((c) => c.name === m.name || c.dispatch === m.name);
}

/** Call link 的变量候选：类的话用 __init__ 的参数 */
async function varsFor(site: CallSite, t: { abs: string; sym: Sym }): Promise<Var[]> {
  let callee = t.sym;
  if (callee.kind === "class") {
    const text = await readText(t.abs);
    const init = text && analysisOf(langOf(t.abs), text).symbols.find((s) => s.qual === `${callee.qual}.__init__`);
    if (init) callee = init;
  } else if (!callee.params.length) {
    const text = await readText(t.abs);
    callee = (text && analysisOf(langOf(t.abs), text).symbols.find((s) => s.qual === callee.qual && s.start === callee.start)) || callee;
  }
  return varCandidates(site, callee);
}

// ---------- peek ----------

type PeekReq = { seg: Segment; line: number; col: number; word: string; at?: { path: string; line: number; col: number } };

export async function peek(m: PeekReq): Promise<PeekResult> {
  let defs: Def[] = [];
  if (m.at) defs = await lspDefs(fromHostPath(m.at.path), m.at.line, m.at.col);
  else if (m.seg.src.kind !== "free") {
    const wp = await workingPlace(m.seg);
    if (wp?.exact) defs = await lspDefs(wp.abs, wp.start + (m.line - m.seg.start), m.col);
  }
  if (defs.length) return peekAt(defs[0], m.word);
  // 兜底 1：同一个函数里的赋值 / 参数（按那个版本的文本）
  const local = await localDef(m);
  if (local) return local;
  // 兜底 2：名字索引里的函数 / 类
  const word = m.word.split(".").pop()!;
  const hits = (await nameIndex()).get(word);
  if (hits?.length) {
    const e = hits.length === 1 ? hits[0] : rankByReceiver(hits.map((h) => ({ ...h, path: hostPath(h.abs), line: h.defLine })), m.word.includes(".") ? m.word.split(".").slice(0, -1).join(".") : undefined, { path: m.seg.path }).ranked[0];
    return peekAt({ abs: e.abs, line: e.defLine, col: 0 }, word);
  }
  return null;
}

/** 定义所在行附近几行 + Pin / Place 用的段 + 下一跳 */
async function peekAt(d: Def, word: string): Promise<PeekDef | null> {
  const text = await readText(d.abs);
  if (text === null) return null;
  const lines = splitLines(text);
  const lang = langOf(d.abs);
  const syms = analysisOf(lang, text).symbols;
  const sym = syms.find((s) => s.defLine === d.line);
  const loc = await locOfFile(d.abs);
  let start: number, end: number, seg: Segment;
  if (sym) {
    start = sym.start;
    end = Math.min(sym.end, sym.defLine + 6);
    seg = (await symCard(loc, lines, sym, lang)).segments[0];
  } else {
    start = Math.max(1, d.line - 1);
    end = Math.min(lines.length, d.line + 1);
    seg = await makeSegment(loc, lines, start, end, { lang, scope: symbolAt(syms, d.line)?.qual });
  }
  const ctx = lines.slice(start - 1, end);
  const out: PeekDef = { path: hostPath(d.abs), line: d.line, start, text: ctx, html: await highlight(ctx, lang, text), seg };
  const f = followOf(lines[d.line - 1] ?? "", word);
  if (f) {
    const next = await lspDefs(d.abs, d.line, f.col);
    const where = next[0] ? ` · ${path.basename(next[0].abs)}:${next[0].line}` : "";
    out.follow = { label: `${f.expr}${where}`, line: d.line, col: f.col, path: hostPath(d.abs) };
  }
  return out;
}

/** self.x = config.max_num_batched_tokens → 下一跳是 config.max_num_batched_tokens 的最后一个名字 */
function followOf(line: string, word: string): { expr: string; col: number } | null {
  const m = /^\s*(?:self\.)?([\w.]+)\s*(?::[^=]+)?=\s*([A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)+)\s*(?:#.*)?$/.exec(line);
  if (!m || (word && !m[1].endsWith(word.split(".").pop()!))) return null;
  const expr = m[2];
  return { expr, col: line.lastIndexOf(expr) + expr.lastIndexOf(".") + 1 };
}

/** 没有语言服务：在段所在的函数里往上找 word = … / 参数 */
async function localDef(m: PeekReq): Promise<PeekDef | null> {
  const seg = m.seg;
  const full = await versionText(seg);
  if (!full) return null;
  const lines = splitLines(full);
  const name = m.word.replace(/^self\./, "");
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isSelf = m.word.startsWith("self.");
  const re = new RegExp(isSelf ? `^\\s*self\\.${esc}\\s*(:[^=]*)?=(?!=)` : `^\\s*${esc}\\s*(:[^=]*)?=(?!=)|^\\s*(?:async\\s+)?def\\s+\\w+\\(.*\\b${esc}\\b`);
  const a = analysisOf(seg.lang, full);
  const fn = symbolAt(a.symbols, m.line, "def");
  const cls = isSelf ? a.symbols.find((s) => s.kind === "class" && fn?.parent === s.qual) : undefined;
  const lo = cls?.start ?? fn?.start ?? 1, hi = cls ? cls.end : m.line - 1;
  let hit = -1;
  for (let l = isSelf ? lo : hi; isSelf ? l <= hi : l >= lo; isSelf ? l++ : l--) if (re.test(lines[l - 1] ?? "") && l !== m.line) { hit = l; break; }
  if (hit < 0) return null;
  const start = Math.max(1, hit - 1), end = Math.min(lines.length, hit + 1);
  const ctx = lines.slice(start - 1, end);
  const pseg: Segment = { id: mkUid("s"), src: seg.src, path: seg.path, lang: seg.lang, start, end, text: ctx, version: seg.version, scope: symbolAt(a.symbols, hit)?.qual };
  const out: PeekDef = { path: seg.path, line: hit, start, text: ctx, html: await highlight(ctx, seg.lang, full), seg: pseg };
  const f = followOf(lines[hit - 1], name);
  if (f) out.follow = { label: f.expr, line: hit, col: f.col, path: hostPath(absOf(seg) ?? seg.path) };
  return out;
}


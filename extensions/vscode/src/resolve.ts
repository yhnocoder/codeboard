// 点调用展开（expand）、标识符悬停看定义（peek）、全工作区的符号名字索引。
// 先问 VS Code 的「转到定义」（装了 Pylance、clangd 时最准）；钉的版本不是工作区当前内容、或者语言服务没给结果时，按名字在索引里找。
import * as vscode from "vscode";
import * as path from "node:path";
import { rankByReceiver, renderLine, type CodeCard, type ExpandPick, type ExpandResult, type PeekDef, type PeekResult, type Segment, type Var } from "@codeboard/core";
import { isModuleDef, peekPlan, splitHover, symbolAt, varCandidates, type CallSite, type FileAnalysis, type Sym } from "@codeboard/core/analysis";
import { analysisOf, cachedAnalysis } from "./analysis";
import { sharedDefs, type Def } from "./defcache";
import { cardForFileSym, symCard } from "./cards";
import { absOf, locOfFile, versionText } from "./source";
import { makeSegment, workingPlace } from "./versions";
import { highlight, tokensOf } from "./views";
import { libOf, resetScope } from "./scope";
import { log } from "./log";
import { CODE_EXCLUDE, CODE_GLOB, exists, fromHostPath, hostPath, langOf, mkUid, readText, recentFiles, splitLines, wsFolders } from "./ws";

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
export function resetIndex() { index = undefined; byFile.clear(); resetScope(); }

// ---------- 转到定义 ----------

/** 问语言服务（同一个文件、位置、内容的请求共用：悬停时可能已经在问了） */
export const lspDefs = (abs: string, line: number, col: number): Promise<Def[]> => sharedDefs(abs, line, col, () => askDefs(abs, line, col));

async function askDefs(abs: string, line: number, col: number): Promise<Def[]> {
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
  } catch (e) {
    log("warn", `definition provider failed at ${hostPath(abs)}:${line}:${col}: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/** 定义位置 → 那里的函数 / 类 */
export async function symAtDef(d: Def, name?: string, qual?: string): Promise<{ abs: string; sym: Sym } | null> {
  const text = await readText(d.abs);
  if (text === null) return null;
  const syms = analysisOf(langOf(d.abs), text).symbols;
  const sym = syms.find((s) => s.defLine === d.line && (!name || s.name === name)) ?? (qual ? syms.find((s) => s.qual === qual) : undefined) ?? syms.find((s) => s.defLine === d.line)
    ?? (name ? symbolAt(syms.filter((s) => s.name === name), d.line) : undefined);
  return sym ? { abs: d.abs, sym } : null;
}

const toSym = (e: IndexEntry): Sym => ({ name: e.name, qual: e.qual, kind: e.kind, start: e.start, end: e.end, defLine: e.defLine, sig: e.sig, params: [] });

// ---------- expand ----------

type ExpandReq = { seg: Segment; line: number; col: number; name: string; recv?: string; pick?: ExpandPick };

/** pick 的文件：rel = 相对段自己的来源根（工作区外的类卡点成员），否则是 hostPath */
export const pickAbs = (seg: Segment, p: ExpandPick) => (p.rel ? absOf({ ...seg, path: p.path }) : fromHostPath(p.path));

const none = (reason: string): ExpandResult => ({ none: true, reason });

export async function expand(m: ExpandReq): Promise<ExpandResult> {
  const seg = m.seg;
  if (seg.src.kind === "free") return none("Free code has no source to follow.");
  if (seg.src.kind === "github") return none("Expanding calls in GitHub code is not supported yet.");
  const full = await versionText(seg);
  const site = callSite(seg, full, m);
  if (!site) log("warn", `vars ${m.name} → callSite miss path=${seg.path}:${m.line}:${m.col}${full ? "" : " (file text unavailable, used saved lines)"}`);
  if (site?.dispatch && site.dispatch === m.name) { log("info", `expand ${m.name} → dynamic dispatch path=${seg.path}:${m.line}`); return none("Dynamic dispatch: not resolved"); }
  let resolved: string | undefined, lspN = 0;

  let targets: { abs: string; sym: Sym }[] = [];
  if (m.pick) {
    const abs = pickAbs(seg, m.pick);
    const t = abs && (await symAtDef({ abs, line: m.pick.line, col: 0 }, m.pick.rel ? m.name : undefined, m.pick.qual));
    if (t) targets = [t];
  } else {
    const wp = await workingPlace(seg);
    resolved = wp ? `${hostPath(wp.abs)}:${wp.start + (m.line - seg.start)}${wp.exact ? "" : " (inexact)"}` : undefined;
    if (wp?.exact) {
      const line = wp.start + (m.line - seg.start);
      const defs = await lspDefs(wp.abs, line, m.col);
      lspN = defs.length;
      for (const d of defs) {
        const t = await symAtDef(d, m.name);
        if (t && !targets.some((x) => x.abs === t.abs && x.sym.qual === t.sym.qual)) targets.push(t);
      }
    }
    // 语言服务给了定义、只是那里不是函数 / 类（变量、属性、参数）：不再去建全工作区的名字索引（大仓库要几十秒）
    // 语言服务说了话就不扫工作区：只在当前文件和已经分析过的文件里按名字找
    if (!targets.length) {
      const ents = lspN ? await nearbyEntries(m.name, wp?.abs) : ((await nameIndex()).get(m.name) ?? []);
      const cands = ents.map((e) => ({ ...e, path: hostPath(e.abs), line: e.defLine }));
      if (cands.length) {
        const selfClass = (seg.symbol?.kind === "class" ? seg.symbol.qual : seg.symbol?.qual.split(".").slice(0, -1).join(".")) || seg.scope?.split(".").slice(0, -1).join(".");
        const here = await currentFile(seg);
        const { ranked, best } = rankByReceiver(cands, m.recv ?? site?.recv, { path: here, selfClass });
        if (best) targets = [{ abs: best.abs, sym: toSym(best) }];
        else return { pick: ranked.slice(0, 20).map((e) => ({ label: e.qual, detail: `${e.path}:${e.defLine}`, path: e.path, line: e.defLine })) };
      }
    }
  }
  if (!targets.length) {
    const why = site?.dispatch ? "Dynamic dispatch: not resolved" : `No definition found for “${m.name}”.`;
    log("warn", `expand ${m.name} → ${why} path=${seg.path}:${m.line}:${m.col} resolved=${resolved ?? "none"} lsp=${lspN}${m.pick ? ` pick=${m.pick.path}:${m.pick.line}` : ""}`);
    return none(why);
  }
  if (targets.length > 1) return { pick: targets.map((t) => ({ label: t.sym.qual, detail: `${hostPath(t.abs)}:${t.sym.defLine}`, path: hostPath(t.abs), line: t.sym.defLine })) };

  const t = targets[0];
  const nc = await cardForFileSym(t.abs, t.sym);
  if (!nc) { log("error", `expand ${m.name} → cannot read ${hostPath(t.abs)}`); return none(`Cannot read ${hostPath(t.abs)}.`); }
  return { card: nc.card as CodeCard, views: nc.views, w: nc.w, vars: site ? await varsFor(site, t) : [] };
}

/** 不扫工作区的名字查找：当前文件 + 最近读过、分析还在缓存里的文件 */
async function nearbyEntries(name: string, here?: string): Promise<IndexEntry[]> {
  const out: IndexEntry[] = [];
  const files = [...new Set([...(here ? [here] : []), ...recentFiles()])];
  for (const abs of files) {
    const text = await readText(abs);
    if (text === null) continue;
    const a = abs === here ? analysisOf(langOf(abs), text) : cachedAnalysis(langOf(abs), text);
    for (const s of a?.symbols ?? []) if (s.name === name) out.push({ name: s.name, qual: s.qual, kind: s.kind, abs, start: s.start, end: s.end, defLine: s.defLine, sig: s.sig });
  }
  return out;
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
  const text = t.sym.kind === "class" || !t.sym.params.length ? await readText(t.abs) : null;
  return varCandidates(site, calleeOf(t.sym, text ? analysisOf(langOf(t.abs), text).symbols : []));
}
/** 被调的函数：类 → __init__；索引里来的 Sym 没有参数，按 qual 在分析结果里补 */
function calleeOf(sym: Sym, syms: Sym[]): Sym {
  if (sym.kind === "class") return syms.find((s) => s.qual === `${sym.qual}.__init__`) ?? sym;
  return sym.params.length ? sym : syms.find((s) => s.qual === sym.qual && s.start === sym.start) ?? syms.find((s) => s.qual === sym.qual) ?? sym;
}

// ---------- 拖到已有的卡：变量候选 ----------

type CallVarsReq = { seg: Segment; line: number; col: number; name: string; target: Segment };

/** 调用接到已有的卡上（拖过去 / Link to Existing Card）：按目标卡的符号算变量候选 */
export async function callVars(m: CallVarsReq): Promise<Var[]> {
  if (m.seg.src.kind === "free") return [];
  const site = callSite(m.seg, await versionText(m.seg), m);
  if (!site) return [];
  const t = m.target;
  const full = t.src.kind === "free" ? null : await versionText(t);
  let syms: Sym[];
  if (full) syms = analysisOf(t.lang, full).symbols;
  else {
    // 只有段文本：去掉公共缩进再分析，行号对回去
    const ind = Math.min(...t.text.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    const cut = Number.isFinite(ind) ? ind : 0;
    syms = analysisOf(t.lang, t.text.map((l) => l.slice(Math.min(cut, l.length - l.trimStart().length))).join("\n")).symbols
      .map((s) => ({
        ...s, start: s.start + t.start - 1, defLine: s.defLine + t.start - 1, end: s.end + t.start - 1,
        params: s.params.map((p, i) => (i === 0 && /^(self|cls)$/.test(p.name) ? { ...p, kind: "self" as const } : p)), // 方法单独分析时看不出 self
      }));
  }
  const top = (t.symbol && syms.find((s) => s.qual === t.symbol!.qual)) ?? syms.filter((s) => s.start >= t.start && s.end <= t.end && (s.name === m.name || s.qual.endsWith(`.${m.name}`)))[0] ?? symbolAt(syms, t.start);
  return top ? varCandidates(site, calleeOf(top, syms)) : [];
}

// ---------- peek ----------

type PeekReq = { seg: Segment; line: number; col: number; word: string; at?: { path: string; line: number; col: number } };
type Hover = { sig?: string; doc?: string };

/** VS Code 的 hover（Pylance：签名代码块 + Markdown 文档）；没有语言服务时为 null */
async function hoverAt(abs: string, line: number, col: number): Promise<Hover | null> {
  try {
    const hs = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", vscode.Uri.file(abs), new vscode.Position(line - 1, col));
    const parts: string[] = [];
    for (const h of hs ?? []) for (const c of h.contents) {
      if (typeof c === "string") parts.push(c);
      else if ("language" in c) parts.push("```" + c.language + "\n" + c.value + "\n```");
      else if (c.value) parts.push(c.value);
    }
    // Pylance 在文档末尾带 <!--moduleHash:...--> 之类的 HTML 注释，Markdown 渲染时会原样显示，先去掉
    const r = splitHover(parts.join("\n\n").replace(/<!--[\s\S]*?-->/g, "").trim());
    return r.sig || r.doc ? r : null;
  } catch { return null; }
}

export async function peek(m: PeekReq): Promise<PeekResult> {
  let defs: Def[] = [];
  let use: { abs: string; line: number; col: number } | undefined;
  if (m.at) use = { abs: fromHostPath(m.at.path), line: m.at.line, col: m.at.col };
  else if (m.seg.src.kind !== "free") {
    const wp = await workingPlace(m.seg);
    if (wp?.exact) use = { abs: wp.abs, line: wp.start + (m.line - m.seg.start), col: m.col };
  }
  if (use) defs = await lspDefs(use.abs, use.line, use.col);
  if (defs.length) {
    // hover 在使用处问（Pylance 给的类型更具体），没有再问定义处
    const hov = (use && (await hoverAt(use.abs, use.line, use.col))) || (await hoverAt(defs[0].abs, defs[0].line, defs[0].col));
    return peekAt(defs[0], m.word, hov);
  }
  // 兜底 1：import 进来的模块（mp → torch.multiprocessing）
  const mod = await importedModule(m);
  if (mod) return mod;
  // 兜底 2：同一个函数里的赋值 / 参数（按那个版本的文本）
  const local = await localDef(m);
  if (local) return local;
  // 兜底 3：名字索引里的函数 / 类
  const word = m.word.split(".").pop()!;
  const hits = (await nameIndex()).get(word);
  if (hits?.length) {
    const e = hits.length === 1 ? hits[0] : rankByReceiver(hits.map((h) => ({ ...h, path: hostPath(h.abs), line: h.defLine })), m.word.includes(".") ? m.word.split(".").slice(0, -1).join(".") : undefined, { path: m.seg.path }).ranked[0];
    return peekAt({ abs: e.abs, line: e.defLine, col: 0 }, word);
  }
  // 兜底 4：x.field → 有类的文件里找类体字段 field: … = …（只看前 400 个文件）
  const f = await classField(word);
  return f ? peekAt(f, word) : null;
}

async function classField(word: string): Promise<Def | null> {
  if (!/^[A-Za-z_]\w*$/.test(word)) return null;
  await nameIndex();
  const re = new RegExp(`^\\s+${word}\\s*(:[^=]*)?=(?!=)`);
  let n = 0;
  for (const [abs, ents] of byFile) {
    if (!ents.some((e) => e.kind === "class") || n++ > 400) continue;
    const text = await readText(abs);
    if (!text || !text.includes(word)) continue;
    const lines = splitLines(text);
    const a = analysisOf(langOf(abs), text);
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i]) && symbolAt(a.symbols, i + 1)?.kind === "class") return { abs, line: i + 1, col: lines[i].indexOf(word) };
  }
  return null;
}

/** 按 peekPlan 取的几行（不一定连续）：用整个文件的 token 高亮 */
async function rowsHtml(rows: number[], lang: string, text: string, lines: string[]) {
  const toks = await tokensOf(lang, text);
  return rows.map((l) => renderLine(toks[l - 1] ?? [{ text: lines[l - 1] ?? "" }]));
}

/** 签名 / 文档：hover 优先，没有就用 docstring */
async function topOf(plan: { sig?: string; doc?: string }, hov: Hover | null | undefined, lang: string) {
  const sig = hov?.sig ?? plan.sig;
  return { sig, sigHtml: sig ? (await highlight(splitLines(sig), lang)).join("\n") : undefined, doc: hov?.doc ?? plan.doc };
}

/** 模块的显示名：torch/multiprocessing/__init__.py → torch/multiprocessing */
const modTitle = (p: string) => p.replace(/\/__init__\.pyi?$/, "").replace(/\.pyi?$/, "");

/** 定义的那几行（按定义类型取）+ hover + Pin / Place 用的段 + 下一跳 */
async function peekAt(d: Def, word: string, hov?: Hover | null, forceModule = false): Promise<PeekDef | null> {
  const text = await readText(d.abs);
  if (text === null) return null;
  const lines = splitLines(text);
  const lang = langOf(d.abs);
  const a = analysisOf(lang, text);
  const module = forceModule || /^\(module\)/.test(hov?.sig ?? "") || isModuleDef(lines, d.line, d.col, word);
  const plan = peekPlan(a, lines, d.line, { word, module });
  const sym = a.symbols.find((s) => s.defLine === d.line);
  const loc = await locOfFile(d.abs);
  const rows = plan.rows;
  let seg: Segment;
  if (sym && !module) seg = (await symCard(loc, lines, sym, lang)).segments[0];
  else {
    const s = rows[0] ?? 1, e = rows[rows.length - 1] ?? Math.min(lines.length, 1);
    seg = await makeSegment(loc, lines, s, e, { lang, scope: symbolAt(a.symbols, d.line)?.qual });
  }
  const out: PeekDef = {
    path: hostPath(d.abs), line: d.line, start: rows[0] ?? d.line, text: rows.map((l) => lines[l - 1] ?? ""), html: await rowsHtml(rows, lang, text, lines), seg,
    kind: plan.kind, rows, head: plan.head, more: plan.more, ...(await topOf(plan, hov, lang)), lib: await libOf(d.abs),
    title: module ? modTitle(loc.src.kind === "repo" ? hostPath(d.abs) : loc.path) : undefined,
  };
  const f = !module && followOf(lines[d.line - 1] ?? "", word);
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

/** 没有语言服务：悬停的名字是 import 进来的模块（import torch.multiprocessing as mp）。工作区里的模块读它的 docstring，library 只给签名 */
async function importedModule(m: PeekReq): Promise<PeekDef | null> {
  const seg = m.seg;
  if (seg.src.kind === "free" || m.word.includes(".")) return null;
  const full = await versionText(seg);
  const a: FileAnalysis | null = full ? analysisOf(seg.lang, full) : null;
  const im = a?.imports.find((i) => i.name === m.word && !i.from);
  if (!a || !im || !full) return null;
  const rel = im.module.split(".");
  for (const f of wsFolders()) for (const c of [path.join(f.uri.fsPath, ...rel, "__init__.py"), path.join(f.uri.fsPath, ...rel) + ".py"])
    if (await exists(c)) return peekAt({ abs: c, line: 1, col: 0 }, m.word, null, true);
  const lines = splitLines(full);
  const pseg: Segment = { id: mkUid("s"), src: seg.src, path: seg.path, lang: seg.lang, start: im.line, end: im.line, text: [lines[im.line - 1] ?? ""], version: seg.version };
  const abs = absOf(seg);
  return {
    path: hostPath(abs ?? seg.path), line: im.line, start: im.line, text: [], html: [], seg: pseg, kind: "module", rows: [],
    ...(await topOf({ sig: `(module) ${m.word}` }, null, seg.lang)), lib: rel[0], title: rel.join("/"),
  };
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
  const plan = peekPlan(a, lines, hit, { word: name });
  // 函数参数那一行：只要上下文
  const rows = plan.kind === "function" ? [Math.max(1, hit - 1), hit, Math.min(lines.length, hit + 1)].filter((x, i, xs) => xs.indexOf(x) === i) : plan.rows;
  const start = rows[0], end = rows[rows.length - 1];
  const pseg: Segment = { id: mkUid("s"), src: seg.src, path: seg.path, lang: seg.lang, start, end, text: lines.slice(start - 1, end), version: seg.version, scope: symbolAt(a.symbols, hit)?.qual };
  const abs = absOf(seg);
  const out: PeekDef = {
    path: hostPath(abs ?? seg.path), line: hit, start, text: rows.map((l) => lines[l - 1] ?? ""), html: await rowsHtml(rows, seg.lang, full, lines), seg: pseg,
    kind: plan.kind === "function" ? "other" : plan.kind, rows, head: plan.kind === "function" ? undefined : plan.head, more: plan.kind === "function" ? undefined : plan.more,
    ...(plan.kind === "field" ? await topOf(plan, null, seg.lang) : {}), lib: abs ? await libOf(abs) : undefined,
  };
  const f = followOf(lines[hit - 1], name);
  if (f) out.follow = { label: f.expr, line: hit, col: f.col, path: hostPath(abs ?? seg.path) };
  return out;
}

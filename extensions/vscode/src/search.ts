// ⌘K 面板：白板上的卡和 Sidenote、工作区的符号和文件；Start from Entry Point…
import * as vscode from "vscode";
import * as path from "node:path";
import { allCodeCards, cardTitle, codeGlyph, type NewCard, type SearchItem } from "@codeboard/core";
import { initExports, moduleFiles, pyprojectScripts } from "@codeboard/core/analysis";
import { analysisOf } from "./analysis";
import { cardForFileSym, freeCard, newCodeCard, withViews } from "./cards";
import { locOfFile } from "./source";
import { nameIndex } from "./resolve";
import type { Storage } from "./storage";
import { makeSegment } from "./versions";
import { CODE_EXCLUDE, exists, fromHostPath, hostPath, langOf, readText, splitLines, wsFolders } from "./ws";

/** 简单的子序列模糊匹配打分：连续、开头、词首加分；不匹配返回 -1 */
export function fuzzy(q: string, s: string): number {
  if (!q) return 0;
  const ql = q.toLowerCase(), sl = s.toLowerCase();
  const sub = sl.indexOf(ql);
  if (sub >= 0) return 100 - sub + (sub === 0 || /[._/\s]/.test(sl[sub - 1]) ? 50 : 0) - s.length * 0.1;
  let i = 0, score = 0, last = -2;
  for (let k = 0; k < sl.length && i < ql.length; k++) {
    if (sl[k] !== ql[i]) continue;
    score += last === k - 1 ? 3 : 1;
    if (k === 0 || /[._/\s]/.test(sl[k - 1]) || (s[k] >= "A" && s[k] <= "Z")) score += 2;
    last = k;
    i++;
  }
  return i === ql.length ? score - s.length * 0.1 : -1;
}

export async function search(store: Storage, q: string, scope: "all" | "code" | "symbols" = "all"): Promise<SearchItem[]> {
  const scored: { s: number; item: SearchItem }[] = [];
  if (scope === "all") {
    for (const { board } of await store.all()) {
      board.cards.forEach((c) => {
        const t = cardTitle(c);
        const body = c.kind === "note" ? c.md : c.kind === "code" ? c.segments.map((s) => s.path).join(" ") : "";
        const s = Math.max(fuzzy(q, t), body.toLowerCase().includes(q.toLowerCase()) ? 20 : -1);
        if (s >= 0) scored.push({ s: s + 30, item: { kind: "card", label: t, detail: board.name, board: board.id, card: c.id } });
      });
      for (const n of board.sidenotes ?? []) {
        const t = n.kind === "text" ? n.md : n.kind === "code" ? n.code.text.join("\n") : n.kind === "paste" ? n.text : n.kind === "link" ? `${n.title ?? ""} ${n.url}` : "";
        if (!t || !t.toLowerCase().includes(q.toLowerCase())) continue;
        const host = allCodeCards(board).find((c) => c.id === n.at.card) ?? board.cards.find((c) => c.id === n.at.card);
        scored.push({ s: 25, item: { kind: "sidenote", label: t.split("\n").find((l) => l.toLowerCase().includes(q.toLowerCase()))!.trim().slice(0, 80), detail: `${board.name}${host ? ` · ${cardTitle(host)}` : ""}`, board: board.id, card: n.at.card, sidenote: n.id } });
      }
    }
  }
  if (q.trim()) {
    for (const ents of (await nameIndex()).values()) for (const e of ents) {
      const s = Math.max(fuzzy(q, e.name) + 5, fuzzy(q, e.qual));
      if (s < 0) continue;
      scored.push({ s, item: { kind: "symbol", label: e.qual, detail: `${hostPath(e.abs)}:${e.defLine}`, path: hostPath(e.abs), line: e.defLine, sym: e.qual, glyph: e.kind === "class" ? "C" : "ƒ" } });
    }
    if (scope !== "symbols") {
      const files = await vscode.workspace.findFiles(`**/*${q.replace(/[^\w.-]/g, "")}*`, CODE_EXCLUDE, 200);
      for (const f of files) {
        const rel = hostPath(f.fsPath);
        const s = fuzzy(q, path.basename(rel));
        if (s >= 0) scored.push({ s: s - 5, item: { kind: "file", label: path.basename(rel), detail: rel, path: rel } });
      }
    }
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, 60).map((x) => x.item);
}

/** 选中一条结果：符号 / 文件 / 入口 → 新卡（Sidenote 还是卡由白板决定）；卡和 Sidenote 白板自己处理 */
export async function searchPick(item: SearchItem): Promise<NewCard | null> {
  if (item.kind === "symbol" || (item.kind === "entry" && item.sym)) {
    const abs = fromHostPath(item.path);
    const text = await readText(abs);
    if (text === null) return null;
    const syms = analysisOf(langOf(abs), text).symbols;
    const sym = syms.find((s) => s.qual === item.sym && s.defLine === item.line) ?? syms.find((s) => s.qual === item.sym);
    return sym ? cardForFileSym(abs, sym) : null;
  }
  if (item.kind === "entry") return fileRangeCard(fromHostPath(item.path), item.line, item.end ?? item.line);
  if (item.kind === "file") return fileTopCard(fromHostPath(item.path));
  return null;
}

async function fileRangeCard(abs: string, start: number, end: number): Promise<NewCard | null> {
  const text = await readText(abs);
  if (text === null) return null;
  const lines = splitLines(text);
  const lang = langOf(abs);
  const syms = analysisOf(lang, text).symbols;
  const scope = syms.filter((s) => s.start <= start && end <= s.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0]?.qual;
  const seg = await makeSegment(await locOfFile(abs), lines, start, Math.min(end, lines.length), { lang, scope, symbol: scope ? undefined : { qual: "<module>", kind: "module" } });
  return (await withViews([newCodeCard([seg])]))[0];
}

/** 文件 → 模块顶部（第一个函数 / 类之前）；没有符号的短文件整个放上来 */
async function fileTopCard(abs: string): Promise<NewCard | null> {
  const text = await readText(abs);
  if (text === null) return null;
  const lines = splitLines(text);
  const lang = langOf(abs);
  if (lang === "plaintext") return (await withViews([freeCard(lines.slice(0, 200).join("\n"), "plaintext")]))[0];
  const first = analysisOf(lang, text).symbols[0];
  let end = first ? first.start - 1 : Math.min(lines.length, 200);
  while (end > 1 && !lines[end - 1].trim()) end--;
  if (end < 1) end = Math.min(lines.length, first ? first.end : 200);
  return fileRangeCard(abs, 1, end);
}

/** Start from Entry Point…（只做 Python）：pyproject 脚本、包 __init__ 导出、__main__ 块 */
export async function entryPoints(): Promise<SearchItem[]> {
  const out: SearchItem[] = [];
  const seen = new Set<string>();
  const add = (it: SearchItem & { kind: "entry" }) => {
    const k = `${it.path}:${it.line}`;
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  };
  const symIn = async (abs: string, qual: string) => {
    const t = await readText(abs);
    return t === null ? undefined : analysisOf("python", t).symbols.find((s) => s.qual === qual);
  };
  for (const f of wsFolders()) {
    const root = f.uri.fsPath;
    // pyproject [project.scripts]
    const toml = await readText(path.join(root, "pyproject.toml"));
    if (toml) for (const s of pyprojectScripts(toml)) {
      for (const cand of moduleFiles(s.module)) {
        const abs = path.join(root, cand);
        const sym = await symIn(abs, s.func);
        if (sym) { add({ kind: "entry", label: sym.qual, detail: `script “${s.name}” · pyproject.toml`, path: hostPath(abs), line: sym.defLine, sym: sym.qual }); break; }
      }
    }
  }
  // 包 __init__.py 里导出的公共 API（浅层包）
  const inits = await vscode.workspace.findFiles("{*/__init__.py,*/*/__init__.py,src/*/__init__.py}", CODE_EXCLUDE, 50);
  for (const u of inits) {
    const text = await readText(u.fsPath);
    if (!text) continue;
    const dir = path.dirname(u.fsPath);
    for (const ex of initExports(text)) {
      if (!ex.from.startsWith(".")) continue;
      for (const cand of moduleFiles(ex.from)) {
        const abs = path.join(dir, cand);
        if (!(await exists(abs))) continue;
        const sym = await symIn(abs, ex.name);
        if (sym) add({ kind: "entry", label: sym.qual, detail: `exported from ${hostPath(u.fsPath)}`, path: hostPath(abs), line: sym.defLine, sym: sym.qual });
        break;
      }
    }
  }
  // __main__ 块和示例脚本
  const scripts = await vscode.workspace.findFiles("{*.py,examples/**/*.py,example/**/*.py,scripts/*.py,*/__main__.py}", CODE_EXCLUDE, 200);
  for (const u of scripts) {
    const text = await readText(u.fsPath);
    if (!text) continue;
    const a = analysisOf("python", text);
    for (const b of a.mainBlocks) add({ kind: "entry", label: path.basename(u.fsPath), detail: `${hostPath(u.fsPath)} · if __name__ == "__main__"`, path: hostPath(u.fsPath), line: b.start, end: b.end });
    if (!a.mainBlocks.length && path.basename(u.fsPath) === "__main__.py") add({ kind: "entry", label: hostPath(u.fsPath), detail: "python -m", path: hostPath(u.fsPath), line: 1, end: Math.min(splitLines(text).length, 80) });
  }
  // __main__ 块里调用的 main() 之类
  for (const it of [...out]) {
    if (it.kind !== "entry" || it.sym || !it.end) continue;
    const abs = fromHostPath(it.path);
    const text = await readText(abs);
    if (!text) continue;
    const a = analysisOf("python", text);
    const main = a.calls.find((c) => c.line >= it.line && c.line <= it.end! && !c.recv && a.symbols.some((s) => s.qual === c.name));
    const sym = main && a.symbols.find((s) => s.qual === main.name);
    if (sym) add({ kind: "entry", label: sym.qual, detail: `called from ${path.basename(abs)}:${main!.line}`, path: it.path, line: sym.defLine, sym: sym.qual });
  }
  return out;
}

export { codeGlyph };

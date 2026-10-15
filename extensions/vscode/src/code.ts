import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  computeSync, diffLines, mapLine, symbolsFor, symbolAt, rankByReceiver,
  type CardView, type CodeCard, type NewCodeCard, type Sym, type Sync,
} from "@codeboard/core";
import { render } from "./highlight";
import { revOf } from "./git";

// ---------- 路径与文件内容 ----------

export const wsRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
export const absPath = (rel: string) => (path.isAbsolute(rel) ? rel : path.join(wsRoot(), rel));
export const relPath = (abs: string) => {
  const r = path.relative(wsRoot(), abs);
  return r.startsWith("..") ? abs : r.split(path.sep).join("/");
};

/** 文件当前的行：编辑器里打开着就用编辑器的内容（含未保存的改动），否则读磁盘 */
export async function currentLines(rel: string): Promise<string[] | undefined> {
  const abs = absPath(rel);
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
  if (doc) return doc.getText().split(/\r?\n/);
  try { return (await fs.readFile(abs, "utf8")).split(/\r?\n/); } catch { return undefined; }
}

export function langOf(rel: string): string {
  const abs = absPath(rel);
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
  if (doc) return doc.languageId;
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".py" || ext === ".pyi") return "python";
  if ([".cu", ".cuh"].includes(ext)) return "cuda-cpp";
  if ([".cc", ".cpp", ".cxx", ".hpp", ".hh", ".h"].includes(ext)) return "cpp";
  if (ext === ".c") return "c";
  return "plaintext";
}

/** 文件的符号：Python 和 C/C++/CUDA 用自带的解析器（快，不依赖语言插件），其他语言问 VS Code */
export async function symbolsOf(rel: string, lines: string[], lang = langOf(rel)): Promise<Sym[]> {
  const own = symbolsFor(lang, lines);
  if (own.length) return own;
  try {
    const ds = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", vscode.Uri.file(absPath(rel)));
    const out: Sym[] = [];
    const walk = (xs: vscode.DocumentSymbol[] | undefined, pre: string) => {
      for (const s of xs ?? []) {
        const fn = [vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor].includes(s.kind);
        const cls = [vscode.SymbolKind.Class, vscode.SymbolKind.Struct].includes(s.kind);
        const qual = pre ? `${pre}.${s.name}` : s.name;
        if (fn || cls) out.push({ name: s.name, qual, kind: cls ? "class" : "def", start: s.range.start.line + 1, defLine: s.selectionRange.start.line + 1, end: s.range.end.line + 1 });
        walk(s.children, cls ? qual : pre);
      }
    };
    walk(ds, "");
    return out;
  } catch { return []; }
}

// ---------- 卡片展示数据 ----------

export async function viewOf(card: CodeCard): Promise<CardView> {
  const cur = await currentLines(card.path);
  const sync: Sync = computeSync(card, cur, cur ? await symbolsOf(card.path, cur, card.lang) : []);
  const { html, calls } = await render(card.snapshot, card.lang, card.start);
  return { html, calls, sync };
}

/** 卡片上的行号 → 当前文件里的行号（代码挪过位置或改过时按内容映射） */
export async function mapToCurrent(card: CodeCard, line: number): Promise<number> {
  const cur = await currentLines(card.path);
  if (!cur) return line;
  const s = computeSync(card, cur, await symbolsOf(card.path, cur, card.lang));
  if (s.state === "moved") return line + s.start - card.start;
  if (s.state === "changed") return mapLine(diffLines(card.snapshot, cur.slice(s.start - 1, s.end), card.start, s.start), line) ?? s.start;
  return line;
}

export async function diffOf(card: CodeCard) {
  const cur = await currentLines(card.path);
  if (!cur) return null;
  const s = computeSync(card, cur, await symbolsOf(card.path, cur, card.lang));
  if (s.state !== "changed") return null;
  return { s, cur, lines: diffLines(card.snapshot, cur.slice(s.start - 1, s.end), card.start, s.start) };
}

// ---------- 新建卡片 ----------

export async function newCard(rel: string, start: number, end: number, sym?: Sym): Promise<NewCodeCard | null> {
  const lines = await currentLines(rel);
  if (!lines) return null;
  const rev = await revOf(absPath(rel));
  const snapshot = lines.slice(start - 1, end);
  return {
    type: "code", path: rel, start, end, lang: langOf(rel), snapshot, commit: rev.commit, dirty: rev.dirty || undefined,
    ...(sym ? { symbol: sym.qual } : {}),
  };
}

export async function cardForSymbol(rel: string, sym: Sym) {
  return newCard(rel, sym.start, sym.end, sym);
}

// ---------- 全工作区的名字索引：跳转定义拿不到结果时兜底 ----------

type Entry = { path: string; sym: Sym };
let index: Promise<Map<string, Entry[]>> | undefined;
const GLOB = "**/*.{py,pyi,cu,cuh,cc,cpp,cxx,h,hpp}";
const EXCLUDE = "**/{node_modules,.git,.venv,venv,build,dist,__pycache__,third_party}/**";

export function invalidateIndex() { index = undefined; }

export function symbolIndex(): Promise<Map<string, Entry[]>> {
  return (index ??= (async () => {
    const m = new Map<string, Entry[]>();
    const files = await vscode.workspace.findFiles(GLOB, EXCLUDE, 20000);
    for (const f of files) {
      const rel = relPath(f.fsPath);
      let text: string;
      try { text = await fs.readFile(f.fsPath, "utf8"); } catch { continue; }
      for (const s of symbolsFor(langOf(rel), text.split(/\r?\n/))) {
        const list = m.get(s.name) ?? [];
        list.push({ path: rel, sym: s });
        m.set(s.name, list);
      }
    }
    return m;
  })());
}

/**
 * 点了卡片里的一个调用，找它的定义。
 * 先问语言插件（装了 Pylance、clangd 时最准），拿不到再按名字在工作区里找，
 * 有多个同名定义时按接收者名字排序，排不出唯一的就让用户选。
 */
export async function resolveCall(card: CodeCard, line: number, name: string, recv: string | undefined, col: number): Promise<Entry[]> {
  const cur = await mapToCurrent(card, line);
  const lines = await currentLines(card.path);
  // 当前行里重新找一次这个名字的位置，防止代码改动后列号对不上
  let c = col;
  const text = lines?.[cur - 1];
  if (text && text.slice(col, col + name.length) !== name) {
    const k = text.indexOf(name);
    if (k >= 0) c = k;
  }
  try {
    const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      "vscode.executeDefinitionProvider", vscode.Uri.file(absPath(card.path)), new vscode.Position(cur - 1, c + 1),
    );
    const out: Entry[] = [];
    for (const d of defs ?? []) {
      const uri = "targetUri" in d ? d.targetUri : d.uri;
      const range = "targetUri" in d ? (d.targetSelectionRange ?? d.targetRange) : d.range;
      const rel = relPath(uri.fsPath);
      const ls = await currentLines(rel);
      if (!ls) continue;
      const sym = symbolAt(await symbolsOf(rel, ls), range.start.line + 1);
      if (sym && !out.some((o) => o.path === rel && o.sym.qual === sym.qual)) out.push({ path: rel, sym });
    }
    if (out.length) return out;
  } catch { /* 没有语言插件 */ }

  const all = (await symbolIndex()).get(name) ?? [];
  if (all.length < 2) return all;
  // self.foo()：优先同一个类里的 foo
  if (recv === "self" || recv === "cls") {
    const cls = card.symbol?.split(".").slice(0, -1).join(".");
    const same = all.filter((e) => cls && e.path === card.path && e.sym.qual === `${cls}.${name}`);
    if (same.length === 1) return same;
  }
  if (!recv) return all;
  const ranked = rankByReceiver(all.map((e) => ({ ...e, qual: e.sym.qual })), recv);
  // 接收者能对上类名的排在前面；只有一个对得上就直接用它
  const r = recv.replace(/_/g, "").toLowerCase();
  const hits = ranked.filter((e) => {
    const cls = e.qual.split(".").slice(-2, -1)[0]?.toLowerCase() ?? "";
    return cls && (cls.includes(r) || r.includes(cls));
  });
  return hits.length === 1 ? hits : ranked;
}

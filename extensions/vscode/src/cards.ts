// 建卡：从文件位置、符号、编辑器选区做成 CodeCard（位置由白板定）。
import * as vscode from "vscode";
import * as path from "node:path";
import { uid, type CodeCard, type NewCard, type Segment } from "@codeboard/core";
import { planSelection, symbolAtCursor, type Plan, type Sel, type Sym } from "@codeboard/core/analysis";
import { analysisOf } from "./analysis";
import { locOfFile, type Loc } from "./source";
import { makeSegment } from "./versions";
import { viewsFor } from "./views";
import { langOf, readText, splitLines } from "./ws";

/** 默认卡宽：按最长的行估 */
export function widthFor(segs: Segment[]): number {
  const longest = Math.max(20, ...segs.flatMap((s) => s.text.map((l) => l.replace(/\t/g, "    ").length)));
  return Math.round(Math.min(760, Math.max(380, longest * 7.4 + 70)));
}

export function newCodeCard(segs: Segment[], extra: Partial<CodeCard> = {}): CodeCard {
  return { id: uid("c"), kind: "code", segments: segs, ...extra };
}

export async function withViews(cards: CodeCard[]): Promise<NewCard[]> {
  return Promise.all(cards.map(async (card) => ({ card, views: await viewsFor(card.segments), w: widthFor(card.segments) })));
}

/** 一个符号 → 函数卡 / 类卡（类卡只列成员签名，shown = 显示哪些成员） */
export async function symCard(loc: Loc, lines: string[], sym: Sym, lang: string, shown: string[] = []): Promise<CodeCard> {
  const cls = sym.kind === "class";
  const seg = await makeSegment(loc, lines, sym.start, sym.end, { symbol: { qual: sym.qual, kind: cls ? "class" : "function" }, lang });
  return newCodeCard([seg], cls ? { members: { shown } } : {});
}

/** 文件里的一个符号 → 卡 */
export async function cardForFileSym(abs: string, sym: Sym): Promise<NewCard | null> {
  const text = await readText(abs);
  if (text === null) return null;
  const card = await symCard(await locOfFile(abs), splitLines(text), sym, langOf(abs));
  return (await withViews([card]))[0];
}

export type Built = { cards: CodeCard[]; ask?: "split" };

/** 按选区计划建卡 */
export async function cardsFromPlan(loc: Loc, lines: string[], plan: Plan, lang: string): Promise<Built> {
  switch (plan.kind) {
    case "function": return { cards: [await symCard(loc, lines, plan.sym, lang)] };
    case "class": return { cards: [await symCard(loc, lines, plan.sym, lang, plan.members ?? [])] };
    case "split": return { cards: await Promise.all(plan.syms.map((s) => symCard(loc, lines, s, lang))), ask: "split" };
    case "segments": {
      const segs = await Promise.all(plan.ranges.map((r) => makeSegment(loc, lines, r.start, r.end, {
        lang, scope: r.scope, symbol: r.module ? { qual: "<module>", kind: "module" } : undefined,
      })));
      return { cards: [newCodeCard(segs)] };
    }
  }
}

/** 编辑器 → 白板位置。没保存的新文件、不在磁盘上的文档 → null（建 Free code） */
export async function locOfDoc(doc: vscode.TextDocument): Promise<Loc | null> {
  if (doc.uri.scheme === "file") return locOfFile(doc.uri.fsPath);
  if (doc.uri.scheme === GIT_SCHEME) {
    const q = parseGitUri(doc.uri);
    if (!q) return null;
    const loc = await locOfFile(q.abs);
    return { ...loc, fixed: { kind: "git", commit: q.commit } };
  }
  return null;
}

export const GIT_SCHEME = "codeboard-git";
/** 只读的历史版本文档：codeboard-git:/<path>?{root, commit, path} */
export function gitUri(root: string, commit: string, rel: string): vscode.Uri {
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${commit.slice(0, 7)}/${rel}`, query: JSON.stringify({ root, commit, path: rel }) });
}
export function parseGitUri(u: vscode.Uri): { root: string; commit: string; path: string; abs: string } | null {
  try {
    const q = JSON.parse(u.query);
    return { ...q, abs: path.join(q.root, q.path) };
  } catch { return null; }
}

/** 编辑器里的选区 → 卡片；没有选区 = 光标所在的函数 */
export async function cardsFromEditor(ed: vscode.TextEditor, mode: "auto" | "function" = "auto"): Promise<Built | { error: string }> {
  const doc = ed.document;
  const text = doc.getText();
  const lines = splitLines(text);
  const lang = doc.languageId;
  const loc = await locOfDoc(doc);
  const a = analysisOf(lang, text);
  const empty = ed.selections.every((s) => s.isEmpty);
  if (!loc) {
    // 未命名文件 / 不在磁盘上：Free code
    const sel = empty ? new vscode.Range(0, 0, doc.lineCount, 0) : ed.selection;
    const t = doc.getText(sel).replace(/\n$/, "");
    if (!t.trim()) return { error: "Nothing to add." };
    return { cards: [freeCard(t, lang)] };
  }
  if (empty || mode === "function") {
    const sym = symbolAtCursor(a, ed.selection.active.line + 1);
    if (!sym) return { error: "The cursor is not inside a function or class. Select some lines first." };
    return { cards: [await symCard(loc, lines, sym, lang)] };
  }
  const sels: Sel[] = ed.selections.filter((s) => !s.isEmpty).map((s) => ({ startLine: s.start.line + 1, startCol: s.start.character, endLine: s.end.line + 1, endCol: s.end.character }));
  const plan = planSelection(sels, a);
  if (!plan) return { error: "The selection only has blank lines." };
  return cardsFromPlan(loc, lines, plan, lang);
}

export function freeCard(text: string, lang: string, url?: string): CodeCard {
  const lines = splitLines(text);
  return newCodeCard([{ id: uid("s"), src: { kind: "free", url }, path: "", lang, start: 1, end: lines.length, text: lines, version: { kind: "none" } }]);
}

import { uid, type CodeCard, type EditorState, type NewCard, type Segment } from "@codeboard/core";
import { listsMembers, planSelection, symbolAtCursor, type Plan, type Range, type Sel, type Sym } from "@codeboard/analysis";
import * as path from "node:path";
import { analysisOf } from "./analysis";
import { locOfFile, type Loc } from "./source";
import { makeSegment } from "./versions";
import { viewsFor } from "./views";
import { langOf, readText, splitLines } from "./ws";

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

/** 一个符号 → 函数卡 / 类卡（类卡只列成员签名，shown = 显示哪些成员；没有方法的类照普通代码卡显示源码） */
export async function symCard(loc: Loc, lines: string[], sym: Sym, lang: string, shown: string[] = []): Promise<CodeCard> {
  const cls = sym.kind === "class";
  const seg = await makeSegment(loc, lines, sym.start, sym.end, { symbol: { qual: sym.qual, kind: cls ? "class" : "function" }, lang });
  return newCodeCard([seg], cls && listsMembers(analysisOf(lang, lines.join("\n")), sym) ? { members: { shown } } : {});
}

export async function cardForFileSym(abs: string, sym: Sym): Promise<NewCard | null> {
  const text = await readText(abs);
  if (text === null) return null;
  const card = await symCard(await locOfFile(abs), splitLines(text), sym, langOf(abs));
  return (await withViews([card]))[0];
}

export type Built = { cards: CodeCard[]; ask?: "split" };

const rangeSeg = (loc: Loc, lines: string[], r: Range, lang: string) => makeSegment(loc, lines, r.start, r.end, {
  lang, scope: r.scope, symbol: r.module ? { qual: "<module>", kind: "module" } : undefined,
});

/** 按选区计划建卡。选中几个完整定义（split）：默认一张多段卡（每个定义一段，中间的模块级代码也各成一段）；
 *  separate = 一个定义一张卡，中间的代码各成一张小卡。两种都不丢选中的行 */
export async function cardsFromPlan(loc: Loc, lines: string[], plan: Plan, lang: string, o: { separate?: boolean } = {}): Promise<Built> {
  switch (plan.kind) {
    case "function": return { cards: [await symCard(loc, lines, plan.sym, lang)] };
    case "class": return { cards: [await symCard(loc, lines, plan.sym, lang, plan.members ?? [])] };
    case "split": {
      if (o.separate) return { cards: await Promise.all(plan.parts.map(async (p) => "sym" in p ? symCard(loc, lines, p.sym, lang) : newCodeCard([await rangeSeg(loc, lines, p.range, lang)]))) };
      const segs = await Promise.all(plan.parts.map((p) => "sym" in p
        ? makeSegment(loc, lines, p.sym.start, p.sym.end, { lang, symbol: { qual: p.sym.qual, kind: p.sym.kind === "class" ? "class" : "function" } })
        : rangeSeg(loc, lines, p.range, lang)));
      return { cards: [newCodeCard(segs)] };
    }
    case "segments": return { cards: [newCodeCard(await Promise.all(plan.ranges.map((r) => rangeSeg(loc, lines, r, lang))))] };
  }
}

/** 编辑器 → 白板位置。没保存的新文件、不在磁盘上的文档 → null（建 Free code） */
export async function locOfEditor(ed: EditorState): Promise<Loc | null> {
  if (ed.file) return locOfFile(ed.path);
  if (ed.version) {
    const loc = await locOfFile(path.join(ed.version.root, ed.version.path));
    return { ...loc, fixed: { kind: "git", commit: ed.version.commit } };
  }
  return null;
}

/** 编辑器里的选区 → 卡片；没有选区 = 光标所在的函数 */
export async function cardsFromEditor(ed: EditorState, mode: "auto" | "function" | "separate" = "auto"): Promise<Built | { error: string }> {
  const text = ed.text;
  const lines = splitLines(text);
  const lang = ed.lang;
  const loc = await locOfEditor(ed);
  const a = analysisOf(lang, text);
  const isEmpty = (s: Sel) => s.startLine === s.endLine && s.startCol === s.endCol;
  const empty = ed.selections.every(isEmpty);
  if (!loc) {
    const t = (empty ? text : ed.selectionText).replace(/\n$/, "");
    if (!t.trim()) return { error: "Nothing to add." };
    return { cards: [freeCard(t, lang)] };
  }
  if (empty || mode === "function") {
    const sym = symbolAtCursor(a, ed.cursorLine);
    if (!sym) return { error: "The cursor is not inside a function or class. Select some lines first." };
    return { cards: [await symCard(loc, lines, sym, lang)] };
  }
  const sels: Sel[] = ed.selections.filter((s) => !isEmpty(s));
  const plan = planSelection(sels, a);
  if (!plan) return { error: "The selection only has blank lines." };
  return cardsFromPlan(loc, lines, plan, lang, { separate: mode === "separate" });
}

export function freeCard(text: string, lang: string, url?: string): CodeCard {
  const lines = splitLines(text);
  return newCodeCard([{ id: uid("s"), src: { kind: "free", url }, path: "", lang, start: 1, end: lines.length, text: lines, version: { kind: "none" } }]);
}

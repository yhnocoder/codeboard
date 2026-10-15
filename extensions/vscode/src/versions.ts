// 版本：建段（钉 HEAD / 包版本 / 指纹）和「新版本」检查。
// 检查时机：打开白板、git HEAD 变化、保存文件（只影响 uncommitted 和仓库外文件）。
import * as path from "node:path";
import { allCodeCards, locateSeg, sameLines, trackSeg, versionLabel, type Board, type Segment, type Stale, type SymRef } from "@codeboard/core";
import { headOf, showFile } from "./git";
import { analysisOf } from "./analysis";
import { currentVersionLabel, rootOf, versionFor, type Loc } from "./source";
import { exists, langOf, mkUid, readText, splitLines } from "./ws";

/** 白板上所有的段：代码卡（含 Compare 的两栏）和 Code sidenote */
export function boardSegments(b: Pick<Board, "cards" | "sidenotes">): Segment[] {
  const out = allCodeCards(b).flatMap((c) => c.segments);
  for (const s of b.sidenotes ?? []) if (s.kind === "code") out.push(s.code);
  return out;
}

/** 从文件的几行建一个段 */
export async function makeSegment(loc: Loc, lines: string[], start: number, end: number, opts: { symbol?: SymRef; scope?: string; lang?: string } = {}): Promise<Segment> {
  const lang = opts.lang ?? langOf(loc.abs);
  const text = lines.slice(start - 1, end);
  const v = await versionFor(loc, { start, end, text, symbol: opts.symbol }, lang);
  return {
    id: mkUid("s"), src: loc.src, path: loc.path, lang, start: v.start, end: v.end, text,
    version: v.version, symbol: opts.symbol, scope: opts.scope,
  };
}

const symsOf = (lang: string, text: string) => analysisOf(lang, text).symbols;

/** 一个段和当前代码的关系 */
export async function staleOf(seg: Segment): Promise<Stale> {
  if (seg.src.kind === "free" || seg.src.kind === "github") return { state: "ok" };
  const root = rootOf(seg.src, seg.version);
  if (!root || !(await exists(root))) return { state: "missing" };
  const abs = path.join(root, seg.path);
  const v = seg.version;
  if (v.kind === "git") {
    const head = await headOf(root);
    if (!head) return { state: "missing" };
    const headText = await showFile(root, head, seg.path);
    const work = await readText(abs);
    if (headText === null) {
      // 文件不在 HEAD 里：没提交过的文件
      if (v.uncommitted && work !== null) return { state: "uncommitted" };
      return { state: "lost" };
    }
    const headLines = splitLines(headText);
    if (head.startsWith(v.commit) || v.commit.startsWith(head)) {
      // 钉的就是 HEAD：只看工作区有没有未提交改动
      if (v.uncommitted) {
        const t = trackSeg(seg, headLines, symsOf(seg.lang, headText), head.slice(0, 7));
        return t.state === "ok" ? { state: "ok" } : { state: "uncommitted" };
      }
      if (work !== null && work !== headText) {
        const wl = splitLines(work);
        const at = locateSeg(seg, wl, symsOf(seg.lang, work));
        if (!at || at === "many" || !sameLines(wl.slice(at.start - 1, at.end), seg.text)) return { state: "uncommitted" };
      }
      return { state: "ok" };
    }
    const { at: _at, ...t } = trackSeg(seg, headLines, symsOf(seg.lang, headText), head.slice(0, 7));
    return t;
  }
  // 仓库外：包版本 / 内容指纹，拿现在的文件比
  const work = await readText(abs);
  if (work === null) return { state: "missing" };
  const label = await currentVersionLabel(abs, v);
  const { at: _at, ...t } = trackSeg(seg, splitLines(work), symsOf(seg.lang, work), label);
  return t;
}

export async function staleFor(segs: Segment[]): Promise<Record<string, Stale>> {
  const out: Record<string, Stale> = {};
  await Promise.all(segs.map(async (s) => {
    try { out[s.id] = await staleOf(s); } catch { out[s.id] = { state: "ok" }; }
  }));
  return out;
}

/** 一张白板里有新版本的卡片数（侧栏圆点、状态栏计数） */
export function countStale(b: Board, st: Record<string, Stale>): number {
  let n = 0;
  for (const c of allCodeCards(b)) if (c.segments.some((s) => st[s.id]?.state === "changed")) n++;
  return n;
}

/** 段在当前工作区文件里的位置（跳转、行号旁标记用）；文件不在返回 null */
export async function workingPlace(seg: Segment): Promise<{ abs: string; start: number; end: number; lines: string[]; exact: boolean } | null> {
  if (seg.src.kind === "free") return null;
  const root = rootOf(seg.src, seg.version);
  if (!root) return null;
  const abs = path.join(root, seg.path);
  const text = await readText(abs);
  if (text === null) return null;
  const lines = splitLines(text);
  const at = locateSeg(seg, lines, symsOf(seg.lang, text));
  if (!at || at === "many") return { abs, start: seg.start, end: seg.end, lines, exact: false };
  return { abs, start: at.start, end: at.end, lines, exact: sameLines(lines.slice(at.start - 1, at.end), seg.text) };
}

/** 段钉的版本就是工作区现在的内容（可以直接在编辑器里跳转、问语言服务） */
export const isWorkingCopy = (p: Awaited<ReturnType<typeof workingPlace>>) => !!p?.exact;

export const versionName = versionLabel;

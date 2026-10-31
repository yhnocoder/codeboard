import * as path from "node:path";
import { allCodeCards, locateSeg, sameLines, storedSegs, trackSeg, uid, upstreamSegs, viewKey, type Board, type Segment, type Stale, type SymRef } from "@codeboard/core";
import { headOf, isAncestor, repoRootOf, resolveRef, showFile, upstreamRef } from "./git";
import { analysisOf } from "./analysis";
import { currentVersion, currentVersionLabel, hasLocalFile, rootOf, versionFor, type Loc } from "./source";
import { exists, langOf, readText, splitLines } from "./ws";

/** 白板上所有的段：代码卡（含 Compare 的两栏）和 Code sidenote */
export function boardSegments(b: Pick<Board, "cards" | "sidenotes">): Segment[] {
  const out = allCodeCards(b).flatMap((c) => c.segments);
  for (const s of b.sidenotes ?? []) if (s.kind === "code") out.push(s.code);
  return out;
}

/**
 * 版本状态要看的段：代码卡按上游的段（有 Variant 的卡显示的可能是我的分支，新版本提示和它无关），加上 Code sidenote。
 * up = 有 Variant 的卡的段：跟上游分支（upstreamRef）比，不跟 HEAD 比（HEAD 可能就是我的分支）
 */
export function staleSegments(b: Pick<Board, "cards" | "sidenotes">): { segs: Segment[]; up: Set<string> } {
  const segs: Segment[] = [], up = new Set<string>();
  for (const c of allCodeCards(b)) {
    const ss = c.variants?.length ? upstreamSegs(c) : c.segments;
    for (const s of ss) { segs.push(s); if (c.variants?.length) up.add(s.id); }
  }
  for (const s of b.sidenotes ?? []) if (s.kind === "code") segs.push(s.code);
  return { segs, up };
}
/** 不在显示的 Variant 的段，id 换成 viewKey（展示数据、文件监听用） */
export function variantSegments(b: Pick<Board, "cards">): Segment[] {
  return allCodeCards(b).flatMap((c) => storedSegs(c).map(({ vid, seg }) => ({ ...seg, id: viewKey(seg.id, vid) })));
}

export async function makeSegment(loc: Loc, lines: string[], start: number, end: number, opts: { symbol?: SymRef; scope?: string; lang?: string } = {}): Promise<Segment> {
  const lang = opts.lang ?? langOf(loc.abs);
  const text = lines.slice(start - 1, end);
  const v = await versionFor(loc, { start, end, text, symbol: opts.symbol }, lang);
  return {
    id: uid("s"), src: loc.src, path: loc.path, lang, start: v.start, end: v.end, text,
    version: v.version, symbol: opts.symbol, scope: opts.scope,
  };
}

const symsOf = (lang: string, text: string) => analysisOf(lang, text).symbols;

async function staleOf(seg: Segment, o: { upstream?: boolean; head?: (root: string) => Promise<string | null> } = {}): Promise<Stale> {
  if (!hasLocalFile(seg.src)) return { state: "ok" };
  const root = rootOf(seg.src, seg.version);
  if (!root || !(await exists(root))) return { state: "missing" };
  const abs = path.join(root, seg.path);
  const v = seg.version;
  if (v.kind === "git" && o.upstream && !v.uncommitted) {
    // 有 Variant 的卡：上游新版本 = 上游分支上的这段变了（我的分支、工作区的改动不算）
    const gr = await repoRootOf(abs);
    const ref = gr && (await upstreamRef(gr));
    const sha = gr && ref && (await resolveRef(gr, ref));
    if (gr && sha) {
      if (sha.startsWith(v.commit) || v.commit.startsWith(sha)) return { state: "ok" };
      const t = await showFile(gr, sha, path.relative(gr, abs).split(path.sep).join("/"));
      if (t === null) return { state: "lost" };
      const { at: _a, ...r } = trackSeg(seg, splitLines(t), symsOf(seg.lang, t), { label: `${ref.replace(/^origin\//, "")} ${sha.slice(0, 7)}`, version: { kind: "git", commit: sha } });
      return r;
    }
  }
  if (v.kind === "git") {
    const head = await (o.head ?? headOf)(root);
    if (!head) return { state: "missing" };
    const headText = await showFile(root, head, seg.path);
    const work = await readText(abs);
    if (v.uncommitted) {
      // 钉的是工作区内容（用户自己的改动）：跟工作区比，一样 = ok，不一样 = 新版本
      if (work === null) return { state: "lost" };
      const { at: _w, ...t } = trackSeg(seg, splitLines(work), symsOf(seg.lang, work), { label: "Working Tree", version: v });
      return t;
    }
    if (head.startsWith(v.commit) || v.commit.startsWith(head)) {
      // 钉的就是 HEAD：只看工作区有没有未提交改动
      if (headText === null) return { state: "lost" };
      if (work !== null && work !== headText) {
        const wl = splitLines(work);
        const at = locateSeg(seg, wl, symsOf(seg.lang, work));
        if (!at || at === "many" || !sameLines(wl.slice(at.start - 1, at.end), seg.text)) return { state: "uncommitted" };
      }
      return { state: "ok" };
    }
    // 新版本 = 钉的 commit 之后的代码。检出的是更早的 commit（HEAD 在钉的 commit 之前）：没有新版本
    if (await isAncestor(root, head, v.commit)) return { state: "ok" };
    if (headText === null) return { state: "lost" };
    const { at: _at, ...t } = trackSeg(seg, splitLines(headText), symsOf(seg.lang, headText), { label: head.slice(0, 7), version: { kind: "git", commit: head } });
    return t;
  }
  // 仓库外：包版本 / 内容指纹，拿现在的文件比
  const work = await readText(abs);
  if (work === null) return { state: "missing" };
  const { at: _at, ...t } = trackSeg(seg, splitLines(work), symsOf(seg.lang, work), { label: await currentVersionLabel(abs, v), version: await currentVersion(abs, v, work) });
  return t;
}

export async function staleFor(segs: Segment[], up?: Set<string>): Promise<Record<string, Stale>> {
  const out: Record<string, Stale> = {};
  // One HEAD per repo for the whole check
  const heads = new Map<string, Promise<string | null>>();
  const head = (root: string) => { let h = heads.get(root); if (!h) heads.set(root, h = headOf(root)); return h; };
  await Promise.all(segs.map(async (s) => {
    try { out[s.id] = await staleOf(s, { upstream: up?.has(s.id), head }); } catch { out[s.id] = { state: "ok" }; }
  }));
  return out;
}

export function countStale(b: Board, st: Record<string, Stale>): number {
  let n = 0;
  for (const c of allCodeCards(b)) if (upstreamSegs(c).some((s) => st[s.id]?.state === "changed")) n++;
  return n;
}

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



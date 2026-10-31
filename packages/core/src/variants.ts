// 当前显示的 Variant 的段在 card.segments，其余的存在 variant.segs，段 id 一一对应：Link、Sticker 的行号切换时按内容跟过去（rebaseSegment），
// 「只在这个 Variant」的 Sidenote 行号按那个 Variant 的代码算，切换时不动。纯函数，读文件、跑 git 由宿主做。
import { activeOf, clone, onVariant, UPSTREAM, versionLabel, type Board, type CodeCard, type Segment, type Sidenote, type Variant, type VariantFrom } from "./model";
import { alignRows, mapLines, sameLines } from "./diff";
import { lineMapOf, moveNoteLines, rebaseSegment, remapSegMarks, type LineMap } from "./edit";

export function segsOf(c: Pick<CodeCard, "segments" | "variants" | "active">, vid: string): Segment[] | undefined {
  if (activeOf(c) === vid) return c.segments;
  return c.variants?.find((v) => v.id === vid)?.segs;
}
/** 上游（钉住的版本）的段：新版本提示、Update 都按它 */
export const upstreamSegs = (c: Pick<CodeCard, "segments" | "variants" | "active">) => segsOf(c, UPSTREAM) ?? c.segments;

/** MINE：显示的不是上游，而且代码和上游不一样 */
export function isMine(c: Pick<CodeCard, "segments" | "variants" | "active">): boolean {
  if (!onVariant(c)) return false;
  const up = upstreamSegs(c);
  return c.segments.some((s) => { const u = up.find((x) => x.id === s.id); return !u || !sameLines(u.text, s.text); });
}

/** 不是当前显示的 Variant 的段（展示数据在 views[viewKey(段, Variant)]） */
export function storedSegs(c: Pick<CodeCard, "variants" | "active">): { vid: string; seg: Segment }[] {
  const out: { vid: string; seg: Segment }[] = [];
  for (const v of c.variants ?? []) if (v.id !== activeOf(c)) for (const s of v.segs ?? []) out.push({ vid: v.id, seg: s });
  return out;
}

/** 标签上的小字：branch、worktree、file、PR */
function fromLabel(f: VariantFrom): string {
  switch (f.kind) {
    case "upstream": return "";
    case "ref": return /^[0-9a-f]{7,40}$/.test(f.ref) ? "commit" : "branch";
    case "worktree": return "uncommitted";
    case "wt": return f.branch ? `worktree · ${f.branch}` : "worktree";
    case "file": return "file";
    case "pr": return `PR #${f.num}`;
  }
}
/** 标签全文：Upstream · bb823b3、fix-spec-bug · branch、Working tree */
export function variantTitle(c: Pick<CodeCard, "segments" | "variants" | "active">, v: Variant): string {
  if (v.from.kind === "upstream") return `${v.name} · ${versionLabel(upstreamSegs(c)[0]?.version, true)}`;
  if (v.from.kind === "worktree") return v.name;
  const k = fromLabel(v.from);
  return k && k !== v.name ? `${v.name} · ${k}` : v.name;
}

const findCode = (b: Board, id: string): CodeCard | undefined => { const c = b.cards.find((k) => k.id === id); return c?.kind === "code" ? c : undefined; };

/** 加一个 Variant（segs = 它的段，id 和卡上的段一一对应）。卡还没有 Variant 时先把现在的代码记成上游。不切换 */
export function addVariant(b: Board, cardId: string, v: Variant & { segs: Segment[] }): void {
  const c = findCode(b, cardId);
  if (!c) return;
  if (!c.variants?.length) c.variants = [{ id: UPSTREAM, name: "Upstream", from: { kind: "upstream" } }];
  // 隐藏 / 高亮从现在显示的代码映射过来（之后每个 Variant 各管各的）
  const segs = v.segs.map((s) => { const o = c.segments.find((x) => x.id === s.id); return o ? remapSegMarks(s, o, lineMapOf(o, s)) : clone(s); });
  c.variants.push({ ...clone(v), segs });
}

/**
 * 切到另一个 Variant：现在的段存回它自己的 Variant，换上目标的段（同一个段 id）。
 * Link 两端、Sticker、跟着卡的 Sidenote 的行号按内容跟过去（rebaseSegment），没了的照常处理（Link 端点 lost、Sidenote 改挂整卡）；
 * 「只在某个 Variant」的 Sidenote 不动。目标里没有的段保持原样
 */
export function switchVariant(b: Board, cardId: string, vid: string): boolean {
  const c = findCode(b, cardId);
  if (!c?.variants?.length || activeOf(c) === vid) return false;
  const to = c.variants.find((v) => v.id === vid);
  const from = c.variants.find((v) => v.id === activeOf(c));
  if (!to || !from) return false;
  const cur = clone(c.segments);
  const target = to.segs ?? [];
  for (const s of cur) {
    const t = target.find((x) => x.id === s.id);
    if (!t) continue;
    // 隐藏 / 高亮是这个 Variant 自己的：带着存回去，目标的原样换上
    rebaseSegment(b, cardId, clone(t), lineMapOf(s, t), { notes: (n) => !n.variant });
    const i = c.segments.findIndex((x) => x.id === s.id);
    if (i >= 0) { c.segments[i].hidden = t.hidden; c.segments[i].hl = t.hl; c.segments[i].annots = t.annots; if (!t.hidden) delete c.segments[i].hidden; if (!t.hl) delete c.segments[i].hl; if (!t.annots) delete c.segments[i].annots; }
  }
  from.segs = cur;
  delete to.segs;
  if (vid === UPSTREAM) delete c.active; else c.active = vid;
  return true;
}

/** 宿主刷新了一个 Variant 的代码（保存、分支 rebase、PR 更新）：当前显示的走 rebaseSegment，其余的换掉存着的段，「只在它」的 Sidenote 跟着挪 */
export function setVariantSegs(b: Board, cardId: string, vid: string, segs: Segment[]): void {
  const c = findCode(b, cardId);
  const v = c?.variants?.find((x) => x.id === vid);
  if (!c || !v) return;
  if (activeOf(c) === vid) { for (const s of segs) if (c.segments.some((x) => x.id === s.id)) rebaseSegment(b, cardId, clone(s)); return; }
  const old = v.segs ?? [];
  v.segs = segs.map((s) => {
    const o = old.find((x) => x.id === s.id);
    if (!o) return clone(s);
    const map = lineMapOf(o, s);
    moveNoteLines(b, cardId, s.id, map, (n) => n.variant === vid);
    return remapSegMarks(s, o, map);
  });
}

/** 上游的段换成新的（新版本 Update、只是挪了位置、Relocate）：上游在显示就是 rebaseSegment，不在显示就换掉存着的那份 */
export function rebaseUpstream(b: Board, cardId: string, ns: Segment, map?: LineMap, o: { review?: string } = {}): void {
  const c = findCode(b, cardId);
  if (!c) return;
  if (!onVariant(c)) { rebaseSegment(b, cardId, ns, map, o); return; }
  const up = c.variants!.find((v) => v.id === UPSTREAM);
  if (!up?.segs) return;
  const i = up.segs.findIndex((s) => s.id === ns.id);
  if (i < 0) return;
  const m = map ?? lineMapOf(up.segs[i], ns);
  moveNoteLines(b, cardId, ns.id, m, (n) => n.variant === UPSTREAM);
  up.segs[i] = remapSegMarks(ns, up.segs[i], m);
}

/** 删掉一个 Variant（上游删不掉）。在显示的话先切回上游；只剩上游时卡变回普通卡 */
export function removeVariant(b: Board, cardId: string, vid: string): void {
  const c = findCode(b, cardId);
  if (!c?.variants || vid === UPSTREAM) return;
  if (activeOf(c) === vid) switchVariant(b, cardId, UPSTREAM);
  releaseNotes(b, c, vid);
  c.variants = c.variants.filter((v) => v.id !== vid);
  if (c.variants.length <= 1) dropVariants(b, cardId);
}

/**
 * 变回普通卡（PR 合进上游后 Convert）：segs = 新的上游段（上游最新），没给就留着上游原来的。
 * 先切回上游，再换成新段（行号跟过去）；「只在某个 Variant」的 Sidenote 变成跟着卡
 */
export function dropVariants(b: Board, cardId: string, segs?: Segment[]): void {
  const c = findCode(b, cardId);
  if (!c) return;
  if (onVariant(c)) switchVariant(b, cardId, UPSTREAM);
  for (const v of c.variants ?? []) releaseNotes(b, c, v.id);
  delete c.variants;
  delete c.active;
  for (const s of segs ?? []) if (c.segments.some((x) => x.id === s.id)) rebaseSegment(b, cardId, clone(s));
}

/** Variant 要没了：「只在它」的 Sidenote 变成跟着卡，行号从它的代码映射到卡上显示的代码（段对不上的改挂整卡） */
function releaseNotes(b: Board, c: CodeCard, vid: string) {
  const mine = b.sidenotes.filter((n) => n.at.card === c.id && n.variant === vid);
  if (activeOf(c) !== vid) {
    const own = segsOf(c, vid) ?? [];
    for (const sid of new Set(mine.map((n) => n.at.seg ?? ""))) {
      const from = own.find((s) => s.id === sid), to = c.segments.find((s) => s.id === sid);
      moveNoteLines(b, c.id, sid, from && to ? lineMapOf(from, to) : () => 0, (n) => n.variant === vid);
    }
  }
  for (const n of mine) delete n.variant;
}

/** Sidenote 在这张卡现在显示的 Variant 上看不看得见 */
export const noteShown = (n: Pick<Sidenote, "variant">, c: Pick<CodeCard, "active"> | undefined) => !n.variant || !c || n.variant === activeOf(c);

export type VariantMarks = { marks: Map<string, "+" | "~">; changed: number; added: number; removed: number };
const NONE: VariantMarks = { marks: new Map(), changed: 0, added: 0, removed: 0 };

/** 我的代码和对比基准逐段比：每一行是新加的（+）还是改过的（~），键是「段 id:行号」 */
export function variantMarks(base: Segment[] | undefined, mine: Segment[]): VariantMarks {
  if (!base) return NONE;
  const out: VariantMarks = { marks: new Map(), changed: 0, added: 0, removed: 0 };
  for (const s of mine) {
    const b = base.find((x) => x.id === s.id);
    if (!b || sameLines(b.text, s.text)) continue;
    for (const r of alignRows(b.text, s.text)) {
      if (r.kind === "changed") { out.marks.set(`${s.id}:${s.start + r.r!}`, "~"); out.changed++; }
      else if (r.kind === "right") { out.marks.set(`${s.id}:${s.start + r.r!}`, "+"); out.added++; }
      else if (r.kind === "left") out.removed++;
    }
  }
  return out.marks.size || out.removed ? out : NONE;
}

/** 三方对照的一行：same = 没改；mine / theirs = 只有一边改了；both = 两边都改了这一行（冲突，高亮） */
export type ThreeKind = "same" | "mine" | "theirs" | "both" | "add";
export type ThreeWay = { base: ThreeKind[]; mine: ThreeKind[]; latest: ThreeKind[]; conflicts: number };

/**
 * 原版（base）、我的（mine）、上游最新（latest）：base 的每一行看两边有没有原样保留（LCS），
 * 两边都没保留 = 冲突。mine / latest 的行：原样来自 base = same；改的是冲突行 = both；新加的 = add
 */
export function threeWay(base: string[], mine: string[], latest: string[]): ThreeWay {
  const km = mapLines(base, 0, mine, 0, false), kl = mapLines(base, 0, latest, 0, false);
  const fm = mapLines(base, 0, mine, 0, true), fl = mapLines(base, 0, latest, 0, true);
  const bk: ThreeKind[] = base.map((_, i) => (km.has(i) ? (kl.has(i) ? "same" : "theirs") : kl.has(i) ? "mine" : "both"));
  const side = (len: number, keep: Map<number, number>, fuzzy: Map<number, number>, own: ThreeKind) => {
    const kept = new Set(keep.values()), from = new Map([...fuzzy].map(([a, x]) => [x, a]));
    return Array.from({ length: len }, (_, j): ThreeKind => {
      if (kept.has(j)) return "same";
      const a = from.get(j);
      if (a === undefined) return "add";
      return bk[a] === "both" ? "both" : own;
    });
  };
  return { base: bk, mine: side(mine.length, km, fm, "mine"), latest: side(latest.length, kl, fl, "theirs"), conflicts: bk.filter((k) => k === "both").length };
}

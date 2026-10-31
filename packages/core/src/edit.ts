// 改白板时要一起维护的引用：删卡要带走挂在它上面的 Link / Sidenote；
// 一段代码换了行号（新版本、挪了位置、Relocate）时，指着这段的行号都要跟着走。
// 纯函数，直接改传进来的 board（白板里在 mutate 的 produce 里调用）。
import { diffArrays } from "diff";
import { mapLines } from "./diff";
import { activeOf, blockAt, blockSig, clone, copyTwinContent, twinContent, cornerAt, findCard, mdHeading, sameVersion, UPSTREAM, withCols, sortSegments, mergeOverlapping, uid, type Board, type Card, type CodeCard, type End, type Link, type Place, type Segment, type Sidenote, type Sticker, type StickerAt } from "./model";
import { escapeRegExp, type BoundVal, type CallAlt } from "@codeboard/analysis/basics";
import { estSize, type Rect } from "./layout";
import { headingTree, splitHeadings } from "./split";

/** 删掉这些卡（Compare 连同两栏）和它们的摆放，以及连着它们的 Link、挂在它们上面或指向它们的 Sidenote、贴在它们上面的 Sticker */
export function removeCards(b: Board, ids: Iterable<string>): void {
  const gone = new Set(withCols(b, ids));
  b.cards = b.cards.filter((c) => !gone.has(c.id));
  for (const id of gone) delete b.place[id];
  b.links = b.links.filter((l) => !gone.has(l.from.card) && !gone.has(l.to.card));
  b.sidenotes = b.sidenotes.filter((n) => !gone.has(n.at.card) && !(n.kind === "card" && gone.has(n.card)));
  b.stickers = b.stickers.filter((k) => k.at.kind !== "line" || !gone.has(k.at.card));
  for (const k of b.stickers) if (k.q?.answer && gone.has(k.q.answer)) delete k.q.answer; // 解答它的卡删了：问题还在
  forget(b, gone);
  pruneStickers(b);
}

/**
 * 合并之后（另一个窗口的改动按项合进来，比如那边删了卡、这边往它上面连了线）：指着没了的卡、段、箭头、Section 的东西，
 * 按删卡的同一套规矩带走（removeCards 的级联）。缺了栏的 Compare 整张删；之后 danglingRefs 不该再报引用问题
 */
export function pruneRefs(b: Board): void {
  const ids = () => new Map(b.cards.map((c) => [c.id, c]));
  let cards = ids();
  const broken = b.cards.filter((c) => c.kind === "compare" && c.cols.some((k) => !cards.has(k))).map((c) => c.id);
  if (broken.length) { removeCards(b, broken); cards = ids(); }
  const segOk = (card: string, seg?: string) => { const c = cards.get(card); return !!c && (!seg || (c.kind === "code" && c.segments.some((s) => s.id === seg))); };
  removeLinks(b, b.links.filter((l) => !segOk(l.from.card, l.from.seg) || !segOk(l.to.card, l.to.seg)).map((l) => l.id));
  removeSidenotes(b, b.sidenotes.filter((n) => !segOk(n.at.card, n.at.seg) || (n.kind === "card" && !cards.has(n.card))).map((n) => n.id));
  removeStickers(b, b.stickers.filter((k) => k.at.kind === "line" && !segOk(k.at.card, k.at.seg)).map((k) => k.id));
  for (const k of b.stickers) if (k.q?.answer && !cards.has(k.q.answer)) delete k.q.answer;
  const gone = new Set([...Object.keys(b.place), ...Object.keys(b.marks ?? {}), ...Object.keys(b.born ?? {})].filter((id) => !cards.has(id)));
  for (const id of gone) delete b.place[id];
  forget(b, gone);
  const secs = new Set(b.sections.map((s) => s.id));
  for (const s of b.sections) if (s.parent && !secs.has(s.parent)) delete s.parent;
  for (const p of Object.values(b.place)) if (p.section && !secs.has(p.section)) delete p.section;
}

/** 删掉的卡的创建顺序和调用图标记 */
function forget(b: Board, gone: Set<string>) {
  for (const id of gone) {
    if (b.born) delete b.born[id];
    if (b.marks) delete b.marks[id];
  }
  if (b.marks && !Object.keys(b.marks).length) delete b.marks;
}

/**
 * 还没编号的卡按 cards 里的先后编上创建顺序（store 每次修改后调用；迁移时整块白板编过）。
 * 编号只增不改：Arrange 改叠放顺序、重命名都不动它
 */
export function stampBorn(b: Board): void {
  let born = b.born;
  for (const c of b.cards) {
    if (born && born[c.id] !== undefined) continue;
    if (!born) born = b.born = {};
    let n = b.seq ?? 0;
    if (!b.seq) for (const v of Object.values(born)) n = Math.max(n, v + 1); // 宿主写的白板没有 seq：接着最大的号往下编
    born[c.id] = n;
    b.seq = n + 1;
  }
}

/** 卡换个 id：摆放、Link 两端、Sidenote（挂在上面的和指向它的）、Sticker、Compare 的栏、创建顺序、调用图标记都跟着换 */
export function renameCard(b: Board, from: string, to: string): void {
  const r = (id: string) => (id === from ? to : id);
  for (const c of b.cards) {
    c.id = r(c.id);
    if (c.kind === "compare") c.cols = [r(c.cols[0]), r(c.cols[1])];
  }
  if (b.place[from]) { b.place[to] = b.place[from]; delete b.place[from]; }
  for (const l of b.links) { l.from.card = r(l.from.card); l.to.card = r(l.to.card); }
  for (const n of b.sidenotes) {
    n.at.card = r(n.at.card);
    if (n.kind === "card") n.card = r(n.card);
  }
  for (const k of b.stickers) {
    const at = k.at;
    if (at.kind === "line") at.card = r(at.card);
    else if (at.on && "card" in at.on) at.on.card = r(at.on.card);
    if (k.q?.answer) k.q.answer = r(k.q.answer);
  }
  for (const m of [b.born, b.marks] as (Record<string, unknown> | undefined)[]) if (m && from in m) { m[to] = m[from]; delete m[from]; }
}

/** 这一行的这个调用连到的卡没了（lost.to，比如子白板里删了那张卡）的 Call 箭头删掉：重新展开出来的箭头替它 */
export function removeLostCalls(b: Board, from: End, name: string): void {
  removeLinks(b, b.links.filter((l) => l.lost?.to && l.call?.name === name && l.from.card === from.card && l.from.seg === from.seg && l.from.line === from.line).map((l) => l.id));
}

/** 卡右上角、绑在卡上的贴纸位置（Compare 的栏 → 那张 Compare） */
function cornerOf(b: Board, card: string): StickerAt {
  const host = findCard(b, card)?.host.id ?? card;
  return { kind: "canvas", ...cornerAt(b.place[host]?.w ?? 320), on: { card: host } };
}

/** 删掉这些 Link，绑在它们上面的 Sticker 一起删 */
export function removeLinks(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  b.links = b.links.filter((l) => !gone.has(l.id));
  pruneStickers(b);
}

/** 绑着的卡 / 箭头没了的 Sticker 一起删（删卡、删箭头之后调用；撤销时一起回来） */
export function pruneStickers(b: Board): void {
  const cards = new Set(b.cards.map((c) => c.id)), links = new Set(b.links.map((l) => l.id));
  b.stickers = b.stickers.filter((k) => {
    const on = k.at.kind === "canvas" ? k.at.on : undefined;
    return !on || ("card" in on ? cards.has(on.card) : links.has(on.link));
  });
}

/** 旧卡上的一个位置（整卡，或某段某行）在替换它的卡上落在哪；seg 为空 = 落在整张卡上 */
export type Retarget = (at: { card: string; seg?: string; line?: number }) => { card: string; seg?: string };

/**
 * 一批卡被别的卡替换（合并、拆开、拆 Compare）：指着它们的 Link 两端、Sidenote（挂在上面的和 kind card 指向它的）、
 * Sticker（行上的、绑在卡上的）都按 to 搬过去。搬完两端落在同一张卡上的 Link 删掉，绑着它的 Sticker 一起删。
 * 删卡本身由调用方做（replaceCards / removeCards）；这里只管引用，任何换卡的操作都应该走这里，而不是各自改一遍。
 */
export function retargetCards(b: Board, ids: Iterable<string>, to: Retarget): void {
  const gone = new Set(ids);
  const moveEnd = (e: End): End => {
    const o = to(e);
    return { card: o.card, seg: o.seg, line: o.seg ? e.line : undefined };
  };
  const touched = new Set<string>();
  for (const l of b.links) {
    const f = gone.has(l.from.card), t = gone.has(l.to.card);
    if (f) l.from = moveEnd(l.from);
    if (t) l.to = moveEnd(l.to);
    if (f || t) touched.add(l.id);
  }
  b.links = b.links.filter((l) => !(touched.has(l.id) && l.from.card === l.to.card));
  for (const n of b.sidenotes) {
    if (gone.has(n.at.card)) {
      const o = to({ card: n.at.card, seg: n.at.seg, line: n.at.lines?.[0] });
      n.at = { card: o.card, seg: o.seg, lines: o.seg ? n.at.lines : undefined };
    }
    if (n.kind === "card" && gone.has(n.card)) n.card = to({ card: n.card }).card;
  }
  for (const k of b.stickers) {
    const at = k.at;
    if (at.kind === "line" && gone.has(at.card)) {
      const o = to({ card: at.card, seg: at.seg, line: at.line });
      k.at = o.seg ? { kind: "line", card: o.card, seg: o.seg, line: at.line } : cornerOf(b, o.card);
    } else if (at.kind === "canvas" && at.on && "card" in at.on && gone.has(at.on.card)) at.on = { card: to({ card: at.on.card }).card };
  }
  pruneStickers(b);
}

/** 换卡：引用按 to 搬走（retargetCards），再删掉旧卡和它们的摆放。只删这几张：拆 Compare 时它的栏留下 */
export function replaceCards(b: Board, ids: Iterable<string>, to: Retarget): void {
  const gone = new Set(ids);
  // 接手的卡沿用被换掉的卡里最早的创建顺序和调用图标记：合并、拆开之后调用图的字母不变
  for (const id of gone) {
    const t = to({ card: id }).card;
    if (gone.has(t)) continue;
    const n = b.born?.[id];
    if (n !== undefined && b.born && !(b.born[t] <= n)) b.born[t] = n;
    const m = b.marks?.[id];
    if (m && b.marks && !b.marks[t]) b.marks[t] = m;
  }
  retargetCards(b, gone, to);
  b.cards = b.cards.filter((c) => !gone.has(c.id));
  for (const id of gone) delete b.place[id];
  forget(b, gone);
}

/**
 * 点灰色备选换实现：Call 箭头 linkId 改连新卡 card（摆在旧卡的位置和 Section 里；旧卡没有摆放时摆在 (0, 0)、宽 w）。
 * 旧卡只连着这一条箭头（没有别的箭头、没有挂在它上面的 Sidenote）：整张换成新卡（replaceCards：贴纸、调用图标记跟过去），
 * 原来的实现 oldAlt 放回被点的备选（第 alt 个）的位置；否则旧卡留着（新卡往下挪 40，成了第二条分支），只把这条箭头改连新卡，被点的备选拿掉。
 * label / vals：箭头的新标签、新取值（不给就不改）。返回旧卡留没留着；箭头不在或不是 Call 时什么都不改，返回 null
 */
export function swapCallTarget(b: Board, linkId: string, card: Card, o: { alt: number; oldAlt?: CallAlt; w: number; label?: string; vals?: BoundVal[] }): { kept: boolean } | null {
  const l = b.links.find((x) => x.id === linkId);
  if (!l?.call) return null;
  const oldId = l.to.card;
  const kept = b.links.some((x) => x.id !== linkId && (x.from.card === oldId || x.to.card === oldId)) || b.sidenotes.some((n) => n.at.card === oldId);
  const p = b.place[oldId];
  const section = p?.section;
  placeCards(b, [{ card, place: p ? { x: p.x, y: kept ? p.y + 40 : p.y, w: p.w } : { x: 0, y: 0, w: o.w } }], { copy: false, at: (q) => (section ? { ...q, section } : q) });
  const alts = [...(l.call.alts ?? [])];
  alts.splice(o.alt, 1, ...(o.oldAlt && !kept ? [o.oldAlt] : []));
  if (o.label) l.label = o.label;
  if (alts.length) l.call.alts = alts; else delete l.call.alts;
  if (o.vals) l.call.vals = o.vals;
  if (kept) l.to = { card: card.id };
  else replaceCards(b, [oldId], () => ({ card: card.id }));
  return { kept };
}

/** 创建顺序按原来的先后重新从 0 编（拆出来的新白板：删掉别的卡之后号不连续），seq 接着编 */
export function renumberBorn(b: Board): void {
  const order = Object.entries(b.born ?? {}).sort((x, y) => x[1] - y[1]);
  b.born = Object.fromEntries(order.map(([id], i) => [id, i]));
  b.seq = order.length;
}

/**
 * 白板里指向不存在的东西的引用（应该永远是空的）：Link 两端、Sidenote、Sticker、问题的解答、Compare 的栏、Place、Section 父子，以及重复的 id。
 * 给测试和 mutate 的自检用；返回每一处问题的说明。
 */
export function danglingRefs(b: Board): string[] {
  const out: string[] = [];
  const cards = new Map<string, Board["cards"][number]>();
  for (const c of b.cards) { if (cards.has(c.id)) out.push(`duplicate card id ${c.id}`); cards.set(c.id, c); }
  const links = new Set(b.links.map((l) => l.id));
  const sections = new Set(b.sections.map((s) => s.id));
  const segOk = (card: string, seg?: string) => {
    const c = cards.get(card);
    if (!c) return false;
    return !seg || (c.kind === "code" && c.segments.some((s) => s.id === seg));
  };
  for (const l of b.links) for (const e of [l.from, l.to]) if (!segOk(e.card, e.seg)) out.push(`link ${l.id} → missing ${e.card}${e.seg ? `/${e.seg}` : ""}`);
  // Note 的块：只能在 Note 上，和行不能同时有；块还在不在由白板拆 Markdown 时看（blockAt 找不到就画在卡头）
  for (const l of b.links) for (const e of [l.from, l.to]) {
    if (!e.block) continue;
    const c = cards.get(e.card);
    if (c && c.kind !== "note") out.push(`link ${l.id} → block on ${e.card}, which is not a Note`);
    if (e.seg !== undefined || e.line !== undefined) out.push(`link ${l.id} → both a block and a line on ${e.card}`);
    if (!Number.isInteger(e.block.i) || e.block.i < 0 || !e.block.h) out.push(`link ${l.id} → bad block ${JSON.stringify(e.block)} on ${e.card}`);
  }
  // 标记的组合（LinkMarks）：类型挡住了写法，这里挡住从别处来的数据
  for (const l of b.links as { id: string; gen?: true; call?: unknown; rpc?: unknown; back?: true }[]) {
    const extra = (["call", "rpc", "back"] as const).filter((k) => l[k]);
    if (l.gen && extra.length) out.push(`generated-from link ${l.id} also has ${extra.join(", ")}`);
  }
  for (const n of b.sidenotes) {
    if (!segOk(n.at.card, n.at.seg)) out.push(`sidenote ${n.id} on missing ${n.at.card}`);
    if (n.kind === "card" && !cards.has(n.card)) out.push(`sidenote ${n.id} points to missing ${n.card}`);
  }
  const stickerRef = (k: Sticker): string | null => {
    const at = k.at;
    if (at.kind === "line") return segOk(at.card, at.seg) ? null : at.card;
    if (!at.on) return null;
    return "card" in at.on ? (cards.has(at.on.card) ? null : at.on.card) : links.has(at.on.link) ? null : at.on.link;
  };
  for (const k of b.stickers) { const m = stickerRef(k); if (m) out.push(`sticker ${k.id} on missing ${m}`); }
  for (const k of b.stickers) if (k.q?.answer && !cards.has(k.q.answer)) out.push(`question ${k.id} answered by missing ${k.q.answer}`);
  for (const c of b.cards) if (c.kind === "compare") for (const k of c.cols) if (!cards.has(k)) out.push(`compare ${c.id} column missing ${k}`);
  for (const id of Object.keys(b.place)) if (!cards.has(id)) out.push(`place for missing card ${id}`);
  for (const s of b.sections) if (s.parent && !sections.has(s.parent)) out.push(`section ${s.id} parent missing ${s.parent}`);
  for (const id of Object.keys(b.marks ?? {})) if (!cards.has(id)) out.push(`graph mark for missing card ${id}`);
  for (const id of Object.keys(b.born ?? {})) if (!cards.has(id)) out.push(`creation order for missing card ${id}`);
  for (const c of b.cards) if (c.kind === "code" && c.variants) out.push(...variantProblems(c));
  const twins = new Map<string, string>();
  for (const c of b.cards) {
    if (!c.same) continue;
    const k = twinContent(c), p = twins.get(c.same);
    if (p === undefined) twins.set(c.same, k); else if (p !== k) out.push(`card ${c.id} differs from the other places of the same card`);
  }
  return out;
}

/** Variant 的不变式：第一个是上游；正显示的那个没有 segs（它的段就是卡上的段），其余每个都有 segs，段 id 和卡上的一一对应 */
function variantProblems(c: CodeCard): string[] {
  const vs = c.variants ?? [];
  const act = activeOf(c);
  const ids = c.segments.map((s) => s.id).sort().join();
  const out: string[] = [];
  if (vs[0]?.id !== UPSTREAM) out.push(`card ${c.id}: first variant is not upstream`);
  if (!vs.some((v) => v.id === act)) out.push(`card ${c.id} shows missing variant ${act}`);
  for (const v of vs) {
    if (v.id === act) { if (v.segs) out.push(`card ${c.id}: shown variant ${v.id} keeps its own segments`); }
    else if (!v.segs) out.push(`card ${c.id}: variant ${v.id} has no segments`);
    else if (v.segs.map((s) => s.id).sort().join() !== ids) out.push(`card ${c.id}: variant ${v.id} segments do not match the card's`);
  }
  return out;
}

/** 旧行号 → 新行号；0 = 这一行在新版本里没了 */
export type LineMap = (line: number) => number;

/** 按内容对齐（core 的 LCS + 相似行配对）：没变的行跟过去，改过的行跟到配对的那一行 */
export function lineMapOf(old: Pick<Segment, "text" | "start">, now: Pick<Segment, "text" | "start">): LineMap {
  const m = mapLines(old.text, old.start, now.text, now.start, true);
  return (l) => m.get(l) ?? 0;
}

/** 一段行映射到新版本：取区间里还在的行的首尾 */
export function mapRange(map: LineMap, a: number, e: number): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (let l = a; l <= e; l++) { const m = map(l); if (m) { lo = Math.min(lo, m); hi = Math.max(hi, m); } }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * 把卡里的一段换成新的（同一个段 id）：新版本 Update、HEAD 下只是挪了位置、Relocate 都走这里。
 * 段上的隐藏 / 高亮，Link 两端、Sidenote、Sticker 的行号都按 map 搬过去（moveLineRefs）；
 * 行没了的：Link 端点退到卡头并标上 lost（画成红色，等用户重连或删掉），Sidenote 改挂整卡并标上 lineRemoved，Sticker 挪到卡的右上角。
 * 合并卡的 mergedFrom（拆开时用的原卡快照）里落在这段上的段也一起换版本、挪行，Unmerge 时行锚还对得上。
 * review：挂在内容变了的行上的 Sidenote 标上 review（新版本的标签），提醒复查（Update 时传）
 */
export function rebaseSegment(b: Board, cardId: string, ns: Segment, map: LineMap = lineMapOf(findSeg(b, cardId, ns.id) ?? ns, ns), o: { review?: string; notes?: (n: Sidenote) => boolean } = {}): void {
  const owner = findOwner(b, cardId);
  const i = owner?.segments.findIndex((s) => s.id === ns.id) ?? -1;
  if (!owner || i < 0) return;
  const old = owner.segments[i];
  owner.segments[i] = remapSegMarks(ns, old, map);
  for (const o of owner.mergedFrom ?? []) {
    o.card.segments = o.card.segments.map((s) => {
      if (s.path !== old.path || s.src.kind !== old.src.kind || !sameVersion(s.version, old.version) || s.start > old.end || s.end < old.start) return s;
      const r = mapRange(map, Math.max(s.start, old.start), Math.min(s.end, old.end));
      if (!r) return s;
      return { ...remapSegMarks(s, s, map), start: r[0], end: r[1], text: ns.text.slice(r[0] - ns.start, r[1] - ns.start + 1), version: ns.version };
    });
  }
  // 有 Variant 的卡：「只在某个 Variant」的 Sidenote 行号按那个 Variant 的代码算，只跟着当前显示的那个挪
  const notes = o.notes ?? (owner.variants ? (n: Sidenote) => !n.variant || n.variant === activeOf(owner) : undefined);
  moveLineRefs(b, cardId, old, ns, map, { review: o.review, notes });
}

/**
 * 新段 ns 带上旧段的隐藏 / 高亮 / 标注（按 map 映射过去，没了的行去掉）。返回一份拷贝。
 * 标注要被标的字还在那一行里：原位置不是那几个字时在新的这一行里找同样的字（找第一处），找不到就去掉
 */
export function remapSegMarks(ns: Segment, old: Pick<Segment, "hidden" | "hl" | "annots" | "text" | "start">, map: LineMap): Segment {
  const hidden = (old.hidden ?? []).map(([a, e]) => mapRange(map, a, e)).filter((r): r is [number, number] => !!r);
  const hl = (old.hl ?? []).map(map).filter(Boolean);
  const annots = (old.annots ?? []).flatMap((a) => {
    const line = map(a.line), words = (old.text[a.line - old.start] ?? "").slice(a.from, a.to);
    const t = line ? ns.text[line - ns.start] : undefined;
    if (!line || t === undefined || !words) return [];
    const from = t.slice(a.from, a.to) === words ? a.from : t.indexOf(words);
    return from < 0 ? [] : [{ ...a, line, from, to: from + words.length }];
  });
  const out = clone(ns);
  if (hidden.length) out.hidden = hidden; else delete out.hidden;
  if (hl.length) out.hl = hl; else delete out.hl;
  if (annots.length) out.annots = annots; else delete out.annots;
  return out;
}

/**
 * 挂在这张卡这一段上的 Sidenote（which 选的）行号按 map 挪；行没了改挂整卡并标上 lineRemoved。
 * mark：挪之前看一眼（Update 时标 review）
 */
export function moveNoteLines(b: Board, cardId: string, segId: string, map: LineMap, which: (n: Sidenote) => boolean = () => true, mark?: (n: Sidenote, lines: [number, number]) => void): void {
  for (const n of b.sidenotes) {
    if (n.at.card !== cardId || n.at.seg !== segId || !n.at.lines || !which(n)) continue;
    mark?.(n, n.at.lines);
    const r = mapRange(map, n.at.lines[0], n.at.lines[1]);
    if (r) n.at.lines = r; else { n.at = { card: cardId }; n.lineRemoved = true; }
  }
}

/**
 * 一段换了内容之后，白板上指着这段的行号跟过去：Link 两端、Sidenote、Sticker（rebaseSegment 的后半段）。
 * notes：哪些 Sidenote 要挪（缺省全部；别的白板改了共享卡时，跟着卡来的 Sidenote 那边已经挪好了，这边只挪自己的）。
 * review：挂着的行内容变了的 Sidenote 标上 review
 */
export function moveLineRefs(b: Board, cardId: string, old: Segment, ns: Segment, map: LineMap, o: { notes?: (n: Sidenote) => boolean; review?: string } = {}): void {
  const moveEnd = (l: Link, k: "from" | "to") => {
    const e = l[k];
    if (e.card !== cardId || e.seg !== ns.id || !e.line) return;
    const m = map(e.line);
    if (m) { e.line = m; return; }
    e.seg = undefined; e.line = undefined;
    l.lost = { ...l.lost, [k]: true };
  };
  for (const l of b.links) { moveEnd(l, "from"); moveEnd(l, "to"); }
  const review = o.review;
  moveNoteLines(b, cardId, ns.id, map, o.notes, review ? (n, [a, e]) => { if (linesChanged(old, ns, map, a, e)) n.review = review; } : undefined);
  for (const k of b.stickers) {
    if (k.at.kind !== "line" || k.at.card !== cardId || k.at.seg !== ns.id) continue;
    const m = map(k.at.line);
    if (m) k.at.line = m; else k.at = cornerOf(b, cardId);
  }
}

/** 旧段的 a..e 行在新段里变了没有（没了，或那一行的内容不一样） */
export function linesChanged(old: Pick<Segment, "text" | "start">, ns: Pick<Segment, "text" | "start">, map: LineMap, a: number, e: number): boolean {
  for (let l = a; l <= e; l++) {
    const m = map(l);
    if (!m || (old.text[l - old.start] ?? "") !== (ns.text[m - ns.start] ?? "")) return true;
  }
  return false;
}

/** 换成新段之前数一下：挂在这段内容会变的行上的 Sidenote（Update 对话框里提醒） */
export function notesOnChangedLines(b: Pick<Board, "cards" | "sidenotes">, cardId: string, ns: Segment): Sidenote[] {
  const old = (b.cards.find((c) => c.id === cardId) as CodeCard | undefined)?.segments?.find((s) => s.id === ns.id);
  if (!old) return [];
  const map = lineMapOf(old, ns);
  return b.sidenotes.filter((n) => n.at.card === cardId && n.at.seg === ns.id && n.at.lines && linesChanged(old, ns, map, n.at.lines[0], n.at.lines[1]));
}

/** 段只是整体挪了几行（内容没变） */
export const shiftBy = (d: number): LineMap => (l) => l + d;

function findOwner(b: Board, cardId: string) {
  const c = b.cards.find((k) => k.id === cardId);
  return c?.kind === "code" ? c : undefined;
}
const findSeg = (b: Board, cardId: string, segId: string) => findOwner(b, cardId)?.segments.find((s) => s.id === segId);

// 白板动作里的领域改动都在这里，白板只管选中、动画、提示

export function removeSidenotes(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  b.sidenotes = b.sidenotes.filter((n) => !gone.has(n.id));
}

/**
 * Place on Board 的那张卡：Code / Paste → 代码卡，Text → Note，Link → 网页卡（「为什么相关」变成卡的说明）。
 * Card sidenote 指着的是白板上已有的卡，没有新卡
 */
export function sidenoteCard(n: Sidenote, id = uid("c")): Card | null {
  switch (n.kind) {
    case "code": return { id, kind: "code", segments: [{ ...clone(n.code), id: uid("s") }], desc: n.why };
    case "paste": {
      const text = n.text.split("\n");
      return { id, kind: "code", segments: [{ id: uid("s"), src: { kind: "free", url: n.url }, path: "", lang: n.lang, start: 1, end: text.length, text, version: { kind: "none" } }], desc: n.why };
    }
    case "text": return { id, kind: "note", md: n.md, look: "note" };
    case "link": return { id, kind: "web", url: n.url, meta: n.title ? { title: n.title } : undefined, desc: n.why };
    case "card": return null;
  }
}
/** Place on Board 在白板上的改动（新卡 card 已经放上白板）：Sidenote 去掉，从它挂的那一行连一条箭头到新卡 */
export function sidenoteToCard(b: Board, id: string, card: string): void {
  const n = b.sidenotes.find((k) => k.id === id);
  if (!n) return;
  removeSidenotes(b, [id]);
  b.links.push({ id: uid("l"), from: { card: n.at.card, seg: n.at.seg, line: n.at.lines?.[0] }, to: { card } });
}

export function removeStickers(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  b.stickers = b.stickers.filter((k) => !gone.has(k.id));
}

/** 放到白板上的一张卡：内容、摆放（Compare 的栏没有）、跟着它来的 Sidenote */
export type CardCopy = { card: Card; place?: Place; sidenotes?: Sidenote[] };

/**
 * 把卡放到白板上（⌘D、粘贴、从别的白板来的卡）。copy = 独立副本：卡、段、Sidenote 都换新 id，Sidenote 的锚点跟着换；
 * 否则原样放（共享卡：同一个 id），白板上已经有的跳过。Compare 的栏要一起给。
 * 摆放：Section、折叠、锁定是原来那块白板的，不带过来；at 可以再挪。links = 原来那块白板上的 Link：两端都是这次放的卡（或白板上已有的
 * 同一张共享卡）的跟着来，换新 id、两端换成放下的卡和段，已经有一样的就不加。返回 旧 id → 新 id（卡和段，放了的才有）
 */
export function placeCards(b: Board, items: CardCopy[], o: { copy: boolean; at?: (p: Place) => Place; links?: Link[] }): { cards: Record<string, string>; segs: Record<string, string> } {
  const cards: Record<string, string> = {}, segs: Record<string, string> = {};
  // 每张卡自己的段 旧 → 新：摆在几处的同一张卡（same）段 id 一样，副本各换各的
  const segsOf = new Map<string, Record<string, string>>();
  const have = new Set(b.cards.map((c) => c.id));
  const todo = items.filter((it) => o.copy || !have.has(it.card.id));
  for (const it of todo) cards[it.card.id] = o.copy ? uid(it.card.kind === "code" ? "c" : it.card.kind[0]) : it.card.id;
  for (const it of todo) {
    const c = clone(it.card);
    c.id = cards[it.card.id];
    if (o.copy) delete c.same; // 副本是另一张卡；要同一张卡，粘贴后选 Reference（makeTwin）
    const own: Record<string, string> = {};
    segsOf.set(it.card.id, own);
    if (c.kind === "code") {
      for (const s of c.segments) { const n = o.copy ? uid("s") : s.id; segs[s.id] = n; own[s.id] = n; s.id = n; }
      for (const v of c.variants ?? []) for (const s of v.segs ?? []) s.id = own[s.id] ?? s.id; // Variant 的段和卡上的段同一个 id
    }
    if (c.kind === "compare") c.cols = [cards[c.cols[0]] ?? c.cols[0], cards[c.cols[1]] ?? c.cols[1]];
    b.cards.push(c);
    if (it.place) {
      const p: Place = { x: it.place.x, y: it.place.y, w: it.place.w };
      if (it.place.h !== undefined) p.h = it.place.h;
      b.place[c.id] = o.at ? o.at(p) : p;
    }
    const nids = new Set(b.sidenotes.map((n) => n.id));
    for (const n of it.sidenotes ?? []) {
      if (n.kind === "card" || n.at.card !== it.card.id) continue; // 指着别的卡的 Sidenote 不带（那张卡不在这块白板上）
      const m = clone(n);
      if (o.copy) m.id = uid("n"); else if (nids.has(m.id)) continue;
      m.at = { ...m.at, card: c.id, seg: m.at.seg && own[m.at.seg] };
      if (!m.at.seg) delete m.at.seg;
      b.sidenotes.push(m);
    }
  }
  const on = (id: string) => cards[id] ?? (!o.copy && have.has(id) ? id : undefined);
  const end = (e: End, card: string): End => ({ ...e, card, ...(e.seg ? { seg: segsOf.get(e.card)?.[e.seg] ?? e.seg } : {}) });
  const key = (l: Link) => JSON.stringify([l.from.card, l.from.seg, l.from.line, l.from.block?.i, l.to.card, l.to.seg, l.to.line, l.to.block?.i]);
  const there = new Set(b.links.map(key));
  for (const l of o.links ?? []) {
    const from = on(l.from.card), to = on(l.to.card);
    if (!from || !to) continue;
    const c = clone(l);
    const n: Link = { ...c, id: uid("l"), from: end(c.from, from), to: end(c.to, to) };
    if (there.has(key(n))) continue;
    there.add(key(n));
    b.links.push(n);
  }
  return { cards, segs };
}

/**
 * 共享卡在这块白板上变成独立副本（Unlink、只在这块白板 Update、合并前）：换一个新 id，这块白板上的引用都跟着换（renameCard）；
 * Compare 连同两栏。卡库和别的白板不动：宿主看到这块白板上没有原来的 id 了，就不再把它当共享卡。返回新 id
 */
export function unlinkCard(b: Board, id: string, to = uid("c")): string {
  const c = b.cards.find((k) => k.id === id);
  if (!c) return id;
  if (c.kind === "compare") for (const k of [...c.cols]) renameCard(b, k, uid("c"));
  renameCard(b, id, to);
  return to;
}

/**
 * 粘贴出来的副本 id 变成 of 的另一处（Reference）：内容换成 of 的（段 id 也用 of 的），两张卡记上同一个 same。
 * 副本自己的摆放、斜贴、箭头、Sidenote、Sticker 留着，指着它的段的按段的先后换到 of 的段上（对不上的箭头 / Sidenote 退到整张卡，行上的 Sticker 删掉）。
 * Compare 不行（栏是别的卡）。返回 false = 没做
 */
export function makeTwin(b: Board, id: string, of: string): boolean {
  const c = b.cards.find((k) => k.id === id), o = b.cards.find((k) => k.id === of);
  if (!c || !o || c === o || c.kind === "compare" || o.kind === "compare" || (c.same && c.same === o.same)) return false;
  const old = c.kind === "code" ? c.segments.map((s) => s.id) : [];
  const now = o.kind === "code" ? o.segments.map((s) => s.id) : [];
  o.same ??= uid("t");
  c.same = o.same;
  copyTwinContent(clone(o), c);
  resegCard(b, id, new Map(old.map((s, i) => [s, now[i]])));
  return true;
}

/**
 * 摆在几处的同一张卡，这一处变成独立副本（Detach）：去掉 same，段换新 id（展示数据按段 id 存，以后两边不一样了不能再共用），
 * 这张卡上的箭头、Sidenote、Sticker 跟着换。只剩一处的那一组也去掉 same。返回 旧段 id → 新段 id（白板把展示数据复制过去）
 */
export function detachTwin(b: Board, id: string): Record<string, string> {
  const c = b.cards.find((k) => k.id === id);
  if (!c?.same) return {};
  const g = c.same;
  delete c.same;
  const rest = b.cards.filter((k) => k.same === g);
  if (rest.length === 1) delete rest[0].same;
  const segs: Record<string, string> = {};
  if (c.kind !== "code") return segs;
  for (const sg of c.segments) { segs[sg.id] = uid("s"); sg.id = segs[sg.id]; }
  for (const v of c.variants ?? []) for (const sg of v.segs ?? []) sg.id = segs[sg.id] ?? sg.id;
  resegCard(b, id, new Map(Object.entries(segs)));
  return segs;
}

/** 卡 id 上指着段的引用换段 id（map 里没有的：箭头、Sidenote 退到整张卡，行上的 Sticker 删掉） */
function resegCard(b: Board, id: string, map: Map<string, string | undefined>): void {
  if (!map.size) return;
  for (const l of b.links) for (const e of [l.from, l.to]) {
    if (e.card !== id || !e.seg) continue;
    const n = map.get(e.seg);
    if (n) e.seg = n;
    else { delete e.seg; delete e.line; }
  }
  for (const n of b.sidenotes) {
    if (n.at.card !== id || !n.at.seg) continue;
    const k = map.get(n.at.seg);
    if (k) n.at.seg = k;
    else { delete n.at.seg; delete n.at.lines; }
  }
  const gone: string[] = [];
  for (const k of b.stickers) {
    if (k.at.kind !== "line" || k.at.card !== id) continue;
    const n = map.get(k.at.seg);
    if (n) k.at.seg = n; else gone.push(k.id);
  }
  if (gone.length) removeStickers(b, gone);
}

/**
 * 摆在几处的同一张卡保持一样：每次改白板之后调（store 的 mutate / sync / live 里）。seen = 上一次看到的每张卡的内容（twinContent），
 * 内容和上次不一样的那张就是改了的，别的跟着它；新进这一组的（撤销回来、拆回来的）跟着原来就在的。raw：store 里读普通对象（代理太慢、不能 clone）
 */
export function syncTwins(b: Board, seen: Map<string, string>, raw: <T>(x: T) => T = (x) => x): void {
  const groups = new Map<string, Card[]>();
  for (const c of b.cards) {
    const g = raw(c).same;
    if (!g) continue;
    const a = groups.get(g);
    if (a) a.push(c); else groups.set(g, [c]);
  }
  const next = new Map<string, string>();
  for (const cs of groups.values()) {
    if (cs.length < 2) continue;
    const keys = cs.map((c) => twinContent(raw(c)));
    let src = cs.findIndex((c, i) => seen.has(c.id) && seen.get(c.id) !== keys[i]);
    if (src < 0) src = Math.max(0, cs.findIndex((c) => seen.has(c.id)));
    const from = clone(raw(cs[src]));
    for (let i = 0; i < cs.length; i++) if (keys[i] !== keys[src]) copyTwinContent(from, cs[i], raw);
    for (const c of cs) next.set(c.id, keys[src]);
  }
  seen.clear();
  for (const [k, v] of next) seen.set(k, v);
}

/**
 * 合并代码卡：段按文件、行号排好，重叠的并起来；连着它们的 Link、Sidenote、Sticker 按文件 + 行搬到新卡上（replaceCards）。
 * target = 被拖到的那张卡（标题、说明、文件顺序以它为准），别的卡的说明转成挂在整张卡上的 Text sidenote。
 * unlink：共享卡先在这块白板上变成副本（别的白板不受影响；mergedFrom 里记的是副本，Unmerge 不会把旧内容写回卡库）
 */
export function mergeCodeCards(b: Board, ids: string[], target: string, o: { id?: string; unlink?: (id: string) => boolean } = {}): { id: string; segments: Segment[] } | null {
  const mid = o.id ?? uid("c");
  const re = new Map<string, string>();
  for (const id of ids) re.set(id, o.unlink?.(id) ? unlinkCard(b, id) : id);
  const now = ids.map((id) => re.get(id)!);
  const orig = now.map((id) => b.cards.find((c) => c.id === id)).filter((c): c is CodeCard => c?.kind === "code").map(clone);
  if (orig.length < 2) return null;
  const T = orig.find((c) => c.id === re.get(target)) ?? orig[0];
  const segs = mergeOverlapping(sortSegments(orig.flatMap((c) => c.segments), T.segments[0]?.path));
  // 合并后段 id 变了的，Link / Sidenote 要跟着换：旧段 id → 新段（按文件 + 行找）
  const segFor = (old: Segment, line?: number) => segs.find((s) => s.path === old.path && s.src.kind === old.src.kind && sameVersion(s.version, old.version) && (line === undefined || (line >= s.start && line <= s.end))) ?? segs[0];
  const oldSegs = new Map(orig.flatMap((c) => c.segments.map((s) => [s.id, s] as const)));
  const TP = b.place[T.id];
  const M: CodeCard = {
    id: mid, kind: "code", segments: segs, title: T.title, desc: T.desc, hide: T.hide, tilt: T.tilt,
    mergedFrom: orig.flatMap((c) => c.mergedFrom ?? [{ card: c, place: clone(b.place[c.id]) }]),
  };
  for (const c of orig) if (c !== T && c.desc) b.sidenotes.push({ id: uid("n"), at: { card: mid }, kind: "text", md: c.desc });
  const w = Math.max(560, ...orig.map((c) => b.place[c.id]?.w ?? 560)); // 先量宽度，再删原来的摆放
  replaceCards(b, orig.map((c) => c.id), (at) => {
    const os = at.seg ? oldSegs.get(at.seg) : undefined;
    return { card: mid, seg: os ? segFor(os, at.line).id : undefined };
  });
  b.cards.push(M);
  b.place[mid] = { x: TP?.x ?? 0, y: TP?.y ?? 0, w, section: TP?.section };
  if (b.place[mid].section === undefined) delete b.place[mid].section;
  return { id: mid, segments: clone(segs) };
}

/** 拆开：有合并记录就拆回原来的卡（放回原位、Link 回到各自的卡）；没有就按段拆。返回新卡和它们的段 */
export function unmergeCard(b: Board, id: string): { made: string[]; segments: Segment[] } | null {
  const m = b.cards.find((c) => c.id === id);
  const mp = b.place[id];
  if (m?.kind !== "code" || !mp || (!m.mergedFrom && m.segments.length < 2)) return null;
  const f0 = m.mergedFrom?.[0].place;
  const dx = f0 ? mp.x - f0.x : 0, dy = f0 ? mp.y - f0.y : 0;
  const pp: Place[] = [];
  const have = new Set(b.cards.map((c) => c.id));
  const parts: CodeCard[] = m.mergedFrom
    ? m.mergedFrom.map((o) => {
      pp.push({ ...clone(o.place), x: o.place.x + dx, y: o.place.y + dy, section: mp.section });
      const k = clone(o.card);
      if (have.has(k.id)) k.id = uid("c"); // 复制过的合并卡再拆：原卡的 id 已经被另一份占了
      // 拆出来的卡看起来和合并卡一样：合并后改过的倾斜算数
      k.tilt = m.tilt;
      return k;
    })
    : m.segments.map((s, i) => { pp.push({ x: mp.x + i * 40, y: mp.y + i * 40, w: mp.w, section: mp.section }); return { id: uid("c"), kind: "code", segments: [clone(s)], hide: m.hide, tilt: m.tilt }; });
  // 段的高亮 / 隐藏跟着行走
  for (const p of parts) for (const s of p.segments) {
    const src = m.segments.filter((q) => q.path === s.path && sameVersion(q.version, s.version) && q.start <= s.end && q.end >= s.start);
    s.hl = [...new Set(src.flatMap((q) => q.hl ?? []).filter((l) => l >= s.start && l <= s.end))];
    s.hidden = src.flatMap((q) => q.hidden ?? []).map(([a, c]) => [Math.max(a, s.start), Math.min(c, s.end)] as [number, number]).filter(([a, c]) => a <= c);
    s.annots = src.flatMap((q) => q.annots ?? []).filter((a) => a.line >= s.start && a.line <= s.end).map((a) => ({ ...a }));
    if (!s.annots.length) s.annots = undefined;
    if (!s.hl.length) s.hl = undefined;
    if (!s.hidden.length) s.hidden = undefined;
  }
  const owner = (seg?: string, line?: number) => {
    const ms = m.segments.find((q) => q.id === seg);
    if (!ms) return { card: parts[0].id, seg: undefined as string | undefined };
    for (const p of parts) for (const s of p.segments) if (s.path === ms.path && sameVersion(s.version, ms.version) && (line === undefined ? s.start <= ms.end && s.end >= ms.start : line >= s.start && line <= s.end)) return { card: p.id, seg: s.id };
    return { card: parts[0].id, seg: undefined };
  };
  replaceCards(b, [id], (at) => (at.seg ? owner(at.seg, at.line) : { card: parts[0].id }));
  const made: string[] = [], segments: Segment[] = [];
  parts.forEach((p, i) => {
    b.cards.push(p);
    const q = pp[i];
    if (q.section === undefined) delete q.section;
    b.place[p.id] = q;
    made.push(p.id);
    segments.push(...clone(p.segments));
  });
  return { made, segments };
}

/**
 * Turn into Board 的父白板一侧：这些卡（含 Compare 的栏）换成子白板框 frame（叠放在它们里最早那张的位置，摆在 place），sections 一起删掉。
 * 外面连进来的箭头改连到整个框（去掉行），从里面连出去的改成从整个框出发（去掉行和出发边）；
 * 其余跟删卡一样（removeCards）：里面的箭头、挂在这些卡上的 Sidenote、贴纸、问题的解答
 */
export function cardsToFrame(b: Board, ids: Iterable<string>, frame: Card, place: Place, sections: Iterable<string>): void {
  const want = new Set(withCols(b, ids));
  for (const l of b.links) {
    const a = want.has(l.from.card), t = want.has(l.to.card);
    if (a === t) continue;
    if (t) { l.to = { card: frame.id }; if (l.lost) delete l.lost.to; }
    else { l.from = { card: frame.id }; if (l.lost) delete l.lost.from; if (l.sides) delete l.sides.from; }
    if (l.lost && !l.lost.from && !l.lost.to) delete l.lost;
    if (l.sides && !l.sides.from && !l.sides.to) delete l.sides;
  }
  const at = b.cards.findIndex((c) => want.has(c.id));
  removeCards(b, want);
  removeSections(b, sections);
  b.cards.splice(Math.max(0, at), 0, frame);
  b.place[frame.id] = place;
}

/** 删掉这些 Section：子 Section 和成员卡归到被删的那个的父 Section（父也删了就再往上找；都没有就不在 Section 里） */
export function removeSections(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  const up = (id?: string) => { let s = id; for (let i = 0; s && gone.has(s) && i < 50; i++) s = b.sections.find((x) => x.id === s)?.parent; return s && !gone.has(s) ? s : undefined; };
  for (const s of b.sections) if (!gone.has(s.id) && s.parent && gone.has(s.parent)) { const p = up(s.parent); if (p) s.parent = p; else delete s.parent; }
  for (const p of Object.values(b.place)) if (p.section && gone.has(p.section)) { const s = up(p.section); if (s) p.section = s; else delete p.section; }
  b.sections = b.sections.filter((s) => !gone.has(s.id));
}

/** 改叠放顺序（b.cards 的顺序就是叠放顺序）。front / back = 最上 / 最下；forward / backward = 越过一张 overlaps 说跟它们重叠的卡 */
export type Arrange = "front" | "forward" | "backward" | "back";
export function arrangeCards(b: Board, ids: Iterable<string>, how: Arrange, overlaps: (id: string) => boolean): void {
  const set = new Set(ids);
  const moving = b.cards.filter((c) => set.has(c.id)), rest = b.cards.filter((c) => !set.has(c.id));
  if (!moving.length) return;
  const idx = b.cards.map((c) => c.id);
  const hit = (i: number) => !set.has(idx[i]) && !!b.place[idx[i]] && overlaps(idx[i]);
  let at: number; // moving 插在 rest 的哪个位置
  if (how === "front") at = rest.length;
  else if (how === "back") at = 0;
  else if (how === "forward") {
    const top = Math.max(...moving.map((c) => idx.indexOf(c.id)));
    let next = -1;
    for (let i = top + 1; i < idx.length; i++) if (hit(i)) { next = i; break; }
    at = next < 0 ? rest.length : rest.findIndex((c) => c.id === idx[next]) + 1;
  } else {
    const bot = Math.min(...moving.map((c) => idx.indexOf(c.id)));
    let prev = -1;
    for (let i = bot - 1; i >= 0; i--) if (hit(i)) { prev = i; break; }
    at = prev < 0 ? 0 : rest.findIndex((c) => c.id === idx[prev]);
  }
  b.cards = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/**
 * 两张代码卡原地并成 Compare（id，摆在 place）：两栏还在 cards 里，只是不再单独摆放；
 * 绑在两栏上的贴纸改绑到 Compare 上
 */
export function makeCompare(b: Board, id: string, cols: [string, string], place: Place): void {
  // 和摆放一样以左栏为准
  const tilt = b.cards.find((c) => c.id === cols[0])?.tilt;
  b.cards.push({ id, kind: "compare", cols: [...cols], tilt });
  b.place[id] = place;
  for (const k of cols) delete b.place[k];
  for (const s of b.stickers) if (s.at.kind === "canvas" && s.at.on && "card" in s.at.on && cols.includes(s.at.on.card)) s.at.on = { card: id };
}

/**
 * 在箭头中间插一张卡：A → B 变成 A → mid → B。第二段（id = second）接着原来的终点、带着原来的 RPC 标记；
 * 第一段改连到 mid，终点不画箭头。mid 由调用方先放到白板上
 */
export function splitLink(b: Board, id: string, mid: string, second: string): void {
  const l = b.links.find((k) => k.id === id);
  if (!l) return;
  b.links.push({ id: second, from: { card: mid }, to: { ...l.to }, ...(l.rpc ? { rpc: { ...l.rpc } } : {}) });
  l.to = { card: mid };
  l.style = { ...l.style, head: { ...l.style?.head, end: false } };
  delete l.at;
}

/** splitLink 反过来：first 接上 second 的终点（终点的箭头恢复），second 和夹在中间的卡 mid 删掉 */
export function joinLinks(b: Board, first: string, second: string, mid: string): void {
  const la = b.links.find((k) => k.id === first), lb = b.links.find((k) => k.id === second);
  if (!la || !lb) return;
  la.to = { ...lb.to };
  if (la.style?.head?.end === false) { delete la.style.head; if (!Object.keys(la.style).length) delete la.style; }
  removeLinks(b, [second]);
  removeCards(b, [mid]);
}

/** 卡变成 Sidenote n：卡连同它的箭头一起删掉；n 是 kind card（指着这张卡）时卡留着 */
export function cardIntoSidenote(b: Board, cardId: string, n: Sidenote): void {
  b.sidenotes.push(n);
  if (n.kind !== "card") removeCards(b, [cardId]);
}

/**
 * Image 卡拖进 Note：图作为单独的一段放进 Note 的 Markdown（src = Note 里写的地址，如 assets/…；图的说明接在图下面），Image 卡连同它的箭头删掉。
 * at = 放在 Markdown 的第几个字（一块的开头，见 @yhnocoder/markdown 的 mdBlockStarts），不给就接在末尾。
 * 不是 Image 卡 / Note 时什么都不改，返回 false
 */
export function imageIntoNote(b: Board, imageId: string, noteId: string, src: string, at?: number): boolean {
  const img = b.cards.find((c) => c.id === imageId), note = b.cards.find((c) => c.id === noteId);
  if (img?.kind !== "image" || note?.kind !== "note") return false;
  const alt = (img.alt ?? "").replace(/[[\]\s]+/g, " ").trim();
  const block = `![${alt}](${src})${img.desc?.trim() ? `\n\n${img.desc.trim()}` : ""}`;
  const cut = at === undefined ? note.md.length : Math.max(0, Math.min(at, note.md.length));
  const head = note.md.slice(0, cut).replace(/\s+$/, ""), tail = note.md.slice(cut).replace(/\s+$/, "");
  note.md = [head, block, tail].filter(Boolean).join("\n\n");
  removeCards(b, [imageId]);
  return true;
}

// Note 的字在标题栏（36，含下边线）下面、内边距 10 / 14；Text 的内边距 2 / 4
const NOTE_PAD_X = 14 - 4, NOTE_HEAD = 36 + 10 - 2;
/**
 * Note ↔ Text（只有这两种互转）。看到的就是全部：Note 卡头的名字（改过的名字）变成 Text 正文的第一行 # 标题；
 * Text 开头的 # 标题本来就显示在 Note 的卡头上（mdHeading），所以 Turn into Note 不用搬字，来回转看起来不变。
 * 卡挪一下：标题落在原来卡头那一行，没有标题时正文留在原地。高度回到跟着内容（Text 没有改高度的把手）
 */
export function turnNoteInto(b: Board, id: string, look: "note" | "text"): void {
  const n = b.cards.find((c) => c.id === id);
  if (n?.kind !== "note" || n.look === look || (n.look !== "note" && n.look !== "text")) return;
  if (look === "text" && n.title) {
    if (mdHeading(n.md) !== n.title) n.md = n.md.trim() ? `# ${n.title}\n\n${n.md}` : `# ${n.title}`;
    delete n.title;
  }
  if (look === "note") { delete n.size; delete n.bold; }
  const headed = !!(n.title || mdHeading(n.md));
  n.look = look;
  const p = b.place[id];
  if (!p) return;
  const s = look === "text" ? 1 : -1, dy = headed ? 4 : NOTE_HEAD;
  p.x += s * NOTE_PAD_X; p.y += s * dy; p.w -= s * 2 * NOTE_PAD_X;
  delete p.h;
}

/** 卡改了名：Note、卡片说明、Text sidenote 里写着 [[旧名]] 的引用跟着改 */
export function renameTitleRefs(b: Board, from: string, to: string): void {
  if (!from || from === to || /[\[\]\n]/.test(to)) return;
  const re = new RegExp(`\\[\\[\\s*${escapeRegExp(from)}\\s*\\]\\]`, "gi");
  const fix = (s: string) => (s.includes("[[") ? s.replace(re, `[[${to}]]`) : s);
  for (const k of b.cards) {
    if (k.kind === "note") { const m = fix(k.md); if (m !== k.md) k.md = m; }
    if (k.desc) { const d = fix(k.desc); if (d !== k.desc) k.desc = d; }
  }
  for (const n of b.sidenotes) if (n.kind === "text") { const m = fix(n.md); if (m !== n.md) n.md = m; }
}

/**
 * Split by Headings：Note 按标题拆成几张 Note（规则见 split.ts 的 splitHeadings），一步改动。原卡留着第一个标题前的字
 * （前面没有字时留着第一段），每段一张新 Note，标题行留在它的 Markdown 开头（Note 的卡头就是开头的标题）；
 * 从每张卡连实线箭头到它下一级的卡，原卡连到最上一级的卡。新卡和原卡一样宽、在同一个 Section 里，摆成向下的树（headingTree）。
 * heights：原卡拆完以后的高、每段新卡的高（白板量出来的；不给按估计）；others：别的卡的矩形（新卡尽量不压着它们）。
 * 不是 Note、没有可拆的标题时什么都不改，返回 null；否则返回新卡的 id（按原文的先后）
 */
export function splitNoteByHeadings(b: Board, id: string, o: { heights?: { root: number; parts: number[] }; others?: Rect[]; ids?: string[] } = {}): string[] | null {
  const n = b.cards.find((c) => c.id === id);
  const sp = n?.kind === "note" ? splitHeadings(n.md) : null;
  if (n?.kind !== "note" || !sp) return null;
  const p = b.place[id] ?? { x: 0, y: 0, w: estSize(n).w };
  const est = (md: string) => 60 + md.split("\n").length * 21;
  const hs = sp.parts.map((q, i) => o.heights?.parts[i] ?? est(q.md));
  const at = headingTree({ x: p.x, y: p.y, w: p.w, h: o.heights?.root ?? est(sp.pre) }, sp.parts.map((q, i) => ({ h: hs[i], parent: q.parent })), o.others);
  const ids = sp.parts.map((_, i) => o.ids?.[i] ?? uid("n"));
  n.md = sp.pre;
  delete p.h; // 内容变少了：高度跟着内容
  sp.parts.forEach((q, i) => {
    b.cards.push({ id: ids[i], kind: "note", md: q.md, look: "note" });
    b.place[ids[i]] = { x: at[i].x, y: at[i].y, w: p.w, ...(p.section ? { section: p.section } : {}) };
    b.links.push({ id: uid("l"), from: { card: q.parent < 0 ? id : ids[q.parent] }, to: { card: ids[i] } });
  });
  return ids;
}

/** 一块 Markdown 大致是哪一类：一换一的改写只在同类之间直接配上 */
function blockKind(src: string): string {
  const t = src.trimStart();
  const m = /^(#{1,6}\s|```|~~~|\$\$|>|[-*+]\s|\d+[.)]\s|\||!\[)/.exec(t);
  return m ? m[1].replace(/\d+/, "1").replace(/\s$/, "") : "p";
}
/** 两块字有多像（字符二元组的 Dice 系数，中文没有空格也能比）：0..1 */
function likeness(x: string, y: string): number {
  const grams = (s: string) => { const t = s.toLowerCase().replace(/\s+/g, " ").trim(), m = new Map<string, number>(); for (let i = 0; i + 1 < t.length; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const a = grams(x), c = grams(y);
  let both = 0, na = 0, nc = 0;
  for (const v of a.values()) na += v;
  for (const [g, v] of c) { nc += v; both += Math.min(v, a.get(g) ?? 0); }
  return na + nc ? (2 * both) / (na + nc) : x.trim() === y.trim() ? 1 : 0;
}
/** 改写后还算同一块：字至少这么像 */
const LIKE = 0.3;

/**
 * Note 的块 旧 → 新（下标；-1 = 这一块没了）。没改的块按指纹对上（Myers）；夹在两处没改的之间的一段改动里，
 * 一块换一块、还是同一类的（段落还是段落）算改写；别的配给字最像的那块，够像（LIKE）才算
 */
export function blockMap(old: readonly string[], now: readonly string[]): number[] {
  const out = old.map(() => -1);
  const parts = diffArrays(old.map(blockSig), now.map(blockSig));
  let i = 0, j = 0;
  for (let k = 0; k < parts.length; k++) {
    if (!parts[k].added && !parts[k].removed) { for (let n = 0; n < parts[k].count; n++) out[i++] = j++; continue; }
    const dels: number[] = [], adds: number[] = [];
    for (; k < parts.length && (parts[k].added || parts[k].removed); k++) for (let n = 0; n < parts[k].count; n++) parts[k].removed ? dels.push(i++) : adds.push(j++);
    k--;
    if (dels.length === 1 && adds.length === 1 && blockKind(old[dels[0]]) === blockKind(now[adds[0]])) { out[dels[0]] = adds[0]; continue; }
    const used = new Set<number>();
    for (const d of dels) {
      let best = -1, score = LIKE;
      for (const a of adds) { if (used.has(a)) continue; const s = likeness(old[d], now[a]); if (s >= score) { best = a; score = s; } }
      if (best >= 0) { out[d] = best; used.add(best); }
    }
  }
  return out;
}

/**
 * Note card 的 Markdown 改了（old → now，白板拆好的块原文；拆不开时 null）：连着它某一块的箭头端点跟着那一块走（blockMap），
 * 那一块删掉了就退到整张卡。端点的指纹和 old 里那一块对不上的（连的时候 Note 正开着编辑器、按编辑器里的字连的）直接按指纹在 now 里找。
 * moved：这次改动里新出现的 Note（Split by Headings 拆出来的）和它们的块：删掉的块原样到了那里，端点跟着搬过去
 */
export function rebaseBlocks(b: Board, card: string, old: readonly string[] | null, now: readonly string[] | null, moved: readonly { card: string; blocks: readonly string[] }[] = []): void {
  const ends = b.links.flatMap((l) => [l.from, l.to].filter((e) => e.card === card && e.block).map((e) => ({ l, e })));
  if (!ends.length) return;
  const map = old && now ? blockMap(old, now) : null;
  const sigs = now?.map(blockSig) ?? [];
  const away = new Set<Link>();
  for (const { l, e } of ends) {
    const ref = e.block!;
    const k = map && old && blockSig(old[ref.i] ?? "") === ref.h ? map[ref.i] : blockAt(ref, sigs);
    if (k >= 0 && now) { e.block = { i: k, h: sigs[k] }; continue; }
    const to = moved.map((m) => ({ card: m.card, i: blockAt({ i: 0, h: ref.h }, m.blocks.map(blockSig)) })).find((m) => m.i >= 0);
    if (to) { e.card = to.card; e.block = { i: to.i, h: ref.h }; away.add(l); } else delete e.block;
  }
  // 搬过去以后两端落在同一张卡上的箭头删掉（和换卡时一样）
  const same = [...away].filter((l) => l.from.card === l.to.card).map((l) => l.id);
  if (same.length) removeLinks(b, same);
}

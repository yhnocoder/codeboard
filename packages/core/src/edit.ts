// 改白板时要一起维护的引用：删卡要带走挂在它上面的 Link / Sidenote；
// 一段代码换了行号（新版本、挪了位置、Relocate）时，指着这段的行号都要跟着走。
// 纯函数，直接改传进来的 board（白板里在 mutate 的 produce 里调用）。
import { mapLines } from "./diff";
import { sameVersion, sortSegments, mergeOverlapping, uid, type Board, type Card, type CodeCard, type End, type Link, type Place, type Segment, type Sidenote, type Sticker } from "./model";

/** 删掉这些卡（Compare 连同两栏）和它们的摆放，以及连着它们的 Link、挂在它们上面或指向它们的 Sidenote、贴在它们上面的 Sticker */
export function removeCards(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  for (const c of b.cards) if (c.kind === "compare" && gone.has(c.id)) c.cols.forEach((k) => gone.add(k));
  b.cards = b.cards.filter((c) => !gone.has(c.id));
  for (const id of gone) delete b.place[id];
  b.links = b.links.filter((l) => !gone.has(l.from.card) && !gone.has(l.to.card));
  b.sidenotes = b.sidenotes.filter((n) => !gone.has(n.at.card) && !(n.kind === "card" && gone.has(n.card)));
  b.stickers = b.stickers.filter((k) => k.at.kind === "canvas" || !gone.has(k.at.card));
  for (const k of b.stickers) if (k.q?.answer && gone.has(k.q.answer)) delete k.q.answer; // 解答它的卡删了：问题还在
  forget(b, gone);
  pruneStickers(b);
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
    if (at.kind !== "canvas") at.card = r(at.card);
    else if (at.on && "card" in at.on) at.on.card = r(at.on.card);
    if (k.q?.answer) k.q.answer = r(k.q.answer);
  }
  for (const m of [b.born, b.marks] as (Record<string, unknown> | undefined)[]) if (m && from in m) { m[to] = m[from]; delete m[from]; }
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
 * Sticker（行上、卡角、绑在卡上的）都按 to 搬过去。搬完两端落在同一张卡上的 Link 删掉，绑着它的 Sticker 一起删。
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
      k.at = o.seg ? { kind: "line", card: o.card, seg: o.seg, line: at.line } : { kind: "card", card: o.card };
    } else if (at.kind === "card" && gone.has(at.card)) k.at = { kind: "card", card: to({ card: at.card }).card };
    else if (at.kind === "canvas" && at.on && "card" in at.on && gone.has(at.on.card)) at.on = { card: to({ card: at.on.card }).card };
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
 * 白板里指向不存在的东西的引用（应该永远是空的）：Link 两端、Sidenote、Sticker、Compare 的栏、Place、Section 父子，以及重复的 id。
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
  for (const n of b.sidenotes) {
    if (!segOk(n.at.card, n.at.seg)) out.push(`sidenote ${n.id} on missing ${n.at.card}`);
    if (n.kind === "card" && !cards.has(n.card)) out.push(`sidenote ${n.id} points to missing ${n.card}`);
  }
  const stickerRef = (k: Sticker): string | null => {
    const at = k.at;
    if (at.kind === "line") return segOk(at.card, at.seg) ? null : at.card;
    if (at.kind === "card") return cards.has(at.card) ? null : at.card;
    if (!at.on) return null;
    return "card" in at.on ? (cards.has(at.on.card) ? null : at.on.card) : links.has(at.on.link) ? null : at.on.link;
  };
  for (const k of b.stickers) { const m = stickerRef(k); if (m) out.push(`sticker ${k.id} on missing ${m}`); }
  for (const c of b.cards) if (c.kind === "compare") for (const k of c.cols) if (!cards.has(k)) out.push(`compare ${c.id} column missing ${k}`);
  for (const id of Object.keys(b.place)) if (!cards.has(id)) out.push(`place for missing card ${id}`);
  for (const s of b.sections) if (s.parent && !sections.has(s.parent)) out.push(`section ${s.id} parent missing ${s.parent}`);
  for (const id of Object.keys(b.marks ?? {})) if (!cards.has(id)) out.push(`graph mark for missing card ${id}`);
  for (const id of Object.keys(b.born ?? {})) if (!cards.has(id)) out.push(`creation order for missing card ${id}`);
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
 * 行没了的：Link 端点退到卡头并标上 lost（画成红色，等用户重连或删掉），Sidenote 改挂整卡并标上 lineRemoved，Sticker 挪到卡片角上。
 * 合并卡的 mergedFrom（拆开时用的原卡快照）里落在这段上的段也一起换版本、挪行，Unmerge 时行锚还对得上。
 * review：挂在内容变了的行上的 Sidenote 标上 review（新版本的标签），提醒复查（Update 时传）
 */
export function rebaseSegment(b: Board, cardId: string, ns: Segment, map: LineMap = lineMapOf(findSeg(b, cardId, ns.id) ?? ns, ns), o: { review?: string; notes?: (n: Sidenote) => boolean } = {}): void {
  const owner = findOwner(b, cardId);
  const i = owner?.segments.findIndex((s) => s.id === ns.id) ?? -1;
  if (!owner || i < 0) return;
  const old = owner.segments[i];
  const hidden = (old.hidden ?? []).map(([a, e]) => mapRange(map, a, e)).filter(Boolean) as [number, number][];
  const hl = (old.hl ?? []).map(map).filter(Boolean);
  owner.segments[i] = { ...ns, hidden: hidden.length ? hidden : undefined, hl: hl.length ? hl : undefined };
  for (const o of owner.mergedFrom ?? []) {
    o.card.segments = o.card.segments.map((s) => {
      if (s.path !== old.path || s.src.kind !== old.src.kind || !sameVersion(s.version, old.version) || s.start > old.end || s.end < old.start) return s;
      const r = mapRange(map, Math.max(s.start, old.start), Math.min(s.end, old.end));
      if (!r) return s;
      const sh = (s.hidden ?? []).map(([a, e]) => mapRange(map, a, e)).filter(Boolean) as [number, number][];
      const sl = (s.hl ?? []).map(map).filter(Boolean);
      return { ...s, start: r[0], end: r[1], text: ns.text.slice(r[0] - ns.start, r[1] - ns.start + 1), version: ns.version, hidden: sh.length ? sh : undefined, hl: sl.length ? sl : undefined };
    });
  }
  // 有 Variant 的卡：「只在某个 Variant」的 Sidenote 行号按那个 Variant 的代码算，只跟着当前显示的那个挪
  const notes = o.notes ?? (owner.variants ? (n: Sidenote) => !n.variant || n.variant === (owner.active ?? "up") : undefined);
  moveLineRefs(b, cardId, old, ns, map, { review: o.review, notes });
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
  for (const n of b.sidenotes) {
    if (n.at.card !== cardId || n.at.seg !== ns.id || !n.at.lines) continue;
    if (o.notes && !o.notes(n)) continue;
    const [a, e] = n.at.lines;
    if (o.review && linesChanged(old, ns, map, a, e)) n.review = o.review;
    const r = mapRange(map, a, e);
    if (r) n.at.lines = r; else { n.at = { card: cardId }; n.lineRemoved = true; }
  }
  for (const k of b.stickers) {
    if (k.at.kind !== "line" || k.at.card !== cardId || k.at.seg !== ns.id) continue;
    const m = map(k.at.line);
    if (m) k.at.line = m; else k.at = { kind: "card", card: cardId };
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

// ---------- 共享卡、拷贝、合并 / 拆开（白板动作里的领域改动都在这里，白板只管选中、动画、提示） ----------

/** 深拷贝：在 Solid 的 produce 里拿到的是代理对象，structuredClone 拷不了 */
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** 删掉这些 Sidenote */
export function removeSidenotes(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  b.sidenotes = b.sidenotes.filter((n) => !gone.has(n.id));
}

/** 删掉这些 Sticker */
export function removeStickers(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  b.stickers = b.stickers.filter((k) => !gone.has(k.id));
}

/** 放到白板上的一张卡：内容、摆放（Compare 的栏没有）、跟着它来的 Sidenote */
export type CardCopy = { card: Card; place?: Place; sidenotes?: Sidenote[] };

/**
 * 把卡放到白板上（⌘D、粘贴、从别的白板来的卡）。copy = 独立副本：卡、段、Sidenote 都换新 id，Sidenote 的锚点跟着换；
 * 否则原样放（共享卡：同一个 id），白板上已经有的跳过。Compare 的栏要一起给。
 * 摆放：Section、折叠、锁定是原来那块白板的，不带过来；at 可以再挪。返回 旧 id → 新 id（卡和段，放了的才有）
 */
export function placeCards(b: Board, items: CardCopy[], o: { copy: boolean; at?: (p: Place) => Place }): { cards: Record<string, string>; segs: Record<string, string> } {
  const cards: Record<string, string> = {}, segs: Record<string, string> = {};
  const have = new Set(b.cards.map((c) => c.id));
  const todo = items.filter((it) => o.copy || !have.has(it.card.id));
  for (const it of todo) cards[it.card.id] = o.copy ? uid(it.card.kind === "code" ? "c" : it.card.kind[0]) : it.card.id;
  for (const it of todo) {
    const c = copy(it.card);
    c.id = cards[it.card.id];
    if (c.kind === "code") {
      for (const s of c.segments) { const n = o.copy ? uid("s") : s.id; segs[s.id] = n; s.id = n; }
      for (const v of c.variants ?? []) for (const s of v.segs ?? []) s.id = segs[s.id] ?? s.id; // Variant 的段和卡上的段同一个 id
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
      const m = copy(n);
      if (o.copy) m.id = uid("n"); else if (nids.has(m.id)) continue;
      m.at = { ...m.at, card: c.id, seg: m.at.seg && segs[m.at.seg] };
      if (!m.at.seg) delete m.at.seg;
      b.sidenotes.push(m);
    }
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
 * 合并代码卡：段按文件、行号排好，重叠的并起来；连着它们的 Link、Sidenote、Sticker 按文件 + 行搬到新卡上（replaceCards）。
 * target = 被拖到的那张卡（标题、说明、文件顺序以它为准），别的卡的说明转成挂在整张卡上的 Text sidenote。
 * unlink：共享卡先在这块白板上变成副本（别的白板不受影响；mergedFrom 里记的是副本，Unmerge 不会把旧内容写回卡库）
 */
export function mergeCodeCards(b: Board, ids: string[], target: string, o: { id?: string; unlink?: (id: string) => boolean } = {}): { id: string; segments: Segment[] } | null {
  const mid = o.id ?? uid("c");
  const re = new Map<string, string>();
  for (const id of ids) re.set(id, o.unlink?.(id) ? unlinkCard(b, id) : id);
  const now = ids.map((id) => re.get(id)!);
  const orig = now.map((id) => b.cards.find((c) => c.id === id)).filter((c): c is CodeCard => c?.kind === "code").map(copy);
  if (orig.length < 2) return null;
  const T = orig.find((c) => c.id === re.get(target)) ?? orig[0];
  const segs = mergeOverlapping(sortSegments(orig.flatMap((c) => c.segments), T.segments[0]?.path));
  // 合并后段 id 变了的，Link / Sidenote 要跟着换：旧段 id → 新段（按文件 + 行找）
  const segFor = (old: Segment, line?: number) => segs.find((s) => s.path === old.path && s.src.kind === old.src.kind && sameVersion(s.version, old.version) && (line === undefined || (line >= s.start && line <= s.end))) ?? segs[0];
  const oldSegs = new Map(orig.flatMap((c) => c.segments.map((s) => [s.id, s] as const)));
  const TP = b.place[T.id];
  const M: CodeCard = {
    id: mid, kind: "code", segments: segs, title: T.title, desc: T.desc, hide: T.hide,
    mergedFrom: orig.flatMap((c) => c.mergedFrom ?? [{ card: c, place: copy(b.place[c.id]) }]),
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
  return { id: mid, segments: copy(segs) };
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
      pp.push({ ...copy(o.place), x: o.place.x + dx, y: o.place.y + dy, section: mp.section });
      const k = copy(o.card);
      if (have.has(k.id)) k.id = uid("c"); // 复制过的合并卡再拆：原卡的 id 已经被另一份占了
      return k;
    })
    : m.segments.map((s, i) => { pp.push({ x: mp.x + i * 40, y: mp.y + i * 40, w: mp.w, section: mp.section }); return { id: uid("c"), kind: "code", segments: [copy(s)], hide: m.hide }; });
  // 段的高亮 / 隐藏跟着行走
  for (const p of parts) for (const s of p.segments) {
    const src = m.segments.filter((q) => q.path === s.path && sameVersion(q.version, s.version) && q.start <= s.end && q.end >= s.start);
    s.hl = [...new Set(src.flatMap((q) => q.hl ?? []).filter((l) => l >= s.start && l <= s.end))];
    s.hidden = src.flatMap((q) => q.hidden ?? []).map(([a, c]) => [Math.max(a, s.start), Math.min(c, s.end)] as [number, number]).filter(([a, c]) => a <= c);
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
    segments.push(...copy(p.segments));
  });
  return { made, segments };
}

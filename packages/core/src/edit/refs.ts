// Reference upkeep when cards, links, sidenotes and stickers go or change id: what was attached to them goes with them or follows
// them.
// Pure functions that change the board passed in (the board calls them inside a mutate).
import { cornerOf, tidyShelf } from "./internal";
import { fixHighlights } from "./highlights";
import { withCols, type Board, type End, type Link, type Sticker } from "../model";

/** Every arrow of the board: on the canvas and on the Shelf (the same objects) */
export const allLinks = (b: Pick<Board, "links" | "shelf">): Link[] => [
  ...b.links,
  ...(b.shelf ?? []).flatMap((e) => e.links),
];
/** Every sticker of the board: on the canvas and on the Shelf (the same objects) */
export const allStickers = (b: Pick<Board, "stickers" | "shelf">): Sticker[] => [
  ...b.stickers,
  ...(b.shelf ?? []).flatMap((e) => e.stickers),
];

/**
 * 删掉这些卡（Compare 连同两栏）和它们的摆放，以及连着它们的 Link、挂在它们上面或指向它们的 Sidenote、贴在它们上面的 Sticker。
 * On the Shelf too: a shelved card's place, the hidden arrows to a deleted card; an entry left empty goes
 */
export function removeCards(b: Board, ids: Iterable<string>): void {
  const gone = new Set(withCols(b, ids));
  b.cards = b.cards.filter((c) => !gone.has(c.id));
  for (const id of gone) delete b.place[id];
  const keep = (l: Link) => !gone.has(l.from.card) && !gone.has(l.to.card);
  const onLine = (k: Sticker) => k.at.kind !== "line" || !gone.has(k.at.card);
  b.links = b.links.filter(keep);
  b.sidenotes = b.sidenotes.filter((n) => !gone.has(n.at.card) && !(n.kind === "card" && gone.has(n.card)));
  b.stickers = b.stickers.filter(onLine);
  for (const e of b.shelf ?? []) {
    for (const id of gone) delete e.place[id];
    e.links = e.links.filter(keep);
    e.stickers = e.stickers.filter(onLine);
  }
  for (const k of allStickers(b)) if (k.q?.answer && gone.has(k.q.answer)) delete k.q.answer; // 解答它的卡删了：问题还在
  forget(b, gone);
  pruneStickers(b);
  tidyShelf(b);
}

/**
 * 合并之后（另一个窗口的改动按项合进来，比如那边删了卡、这边往它上面连了线）：指着没了的卡、段、箭头、Section 的东西，
 * 按删卡的同一套规矩带走（removeCards 的级联）。缺了栏的 Compare 整张删；之后 danglingRefs 不该再报引用问题
 */
export function pruneRefs(b: Board): void {
  const ids = () => new Map(b.cards.map((c) => [c.id, c]));
  let cards = ids();
  const broken = b.cards.filter((c) => c.kind === "compare" && c.cols.some((k) => !cards.has(k))).map((c) => c.id);
  if (broken.length) {
    removeCards(b, broken);
    cards = ids();
  }
  const segOk = (card: string, seg?: string) => {
    const c = cards.get(card);
    return !!c && (!seg || (c.kind === "code" && c.segments.some((s) => s.id === seg)));
  };
  removeLinks(
    b,
    b.links.filter((l) => !segOk(l.from.card, l.from.seg) || !segOk(l.to.card, l.to.seg)).map((l) => l.id),
  );
  removeSidenotes(
    b,
    b.sidenotes
      .filter((n) => !segOk(n.at.card, n.at.seg) || (n.kind === "card" && !cards.has(n.card)))
      .map((n) => n.id),
  );
  removeStickers(
    b,
    b.stickers.filter((k) => k.at.kind === "line" && !segOk(k.at.card, k.at.seg)).map((k) => k.id),
  );
  // the Shelf: what points to cards and segments that are gone, and cards that are back on the canvas (both windows changed them)
  for (const e of b.shelf ?? []) {
    e.links = e.links.filter((l) => segOk(l.from.card, l.from.seg) && segOk(l.to.card, l.to.seg));
    e.stickers = e.stickers.filter((k) => k.at.kind !== "line" || segOk(k.at.card, k.at.seg));
    for (const id of Object.keys(e.place)) if (!cards.has(id) || b.place[id]) delete e.place[id];
  }
  pruneStickers(b);
  for (const k of allStickers(b)) if (k.q?.answer && !cards.has(k.q.answer)) delete k.q.answer;
  const gone = new Set(
    [...Object.keys(b.place), ...Object.keys(b.marks ?? {}), ...Object.keys(b.born ?? {})].filter(
      (id) => !cards.has(id),
    ),
  );
  for (const id of gone) delete b.place[id];
  forget(b, gone);
  const shelf = b.shelf ?? [];
  const secs = new Set([...b.sections, ...shelf.flatMap((e) => e.sections)].map((s) => s.id));
  for (const s of [...b.sections, ...shelf.flatMap((e) => e.sections)])
    if (s.parent && !secs.has(s.parent)) delete s.parent;
  for (const p of [...Object.values(b.place), ...shelf.flatMap((e) => Object.values(e.place))])
    if (p.section && !secs.has(p.section)) delete p.section;
  tidyShelf(b);
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
  for (const place of [b.place, ...(b.shelf ?? []).map((e) => e.place)])
    if (place[from]) {
      place[to] = place[from];
      delete place[from];
    }
  for (const l of allLinks(b)) {
    l.from.card = r(l.from.card);
    l.to.card = r(l.to.card);
  }
  for (const n of b.sidenotes) {
    n.at.card = r(n.at.card);
    if (n.kind === "card") n.card = r(n.card);
  }
  for (const k of allStickers(b)) {
    const at = k.at;
    if (at.kind === "line") at.card = r(at.card);
    else if (at.on && "card" in at.on) at.on.card = r(at.on.card);
    if (k.q?.answer) k.q.answer = r(k.q.answer);
  }
  for (const m of [b.born, b.marks] as (Record<string, unknown> | undefined)[])
    if (m && from in m) {
      m[to] = m[from];
      delete m[from];
    }
}

/** 这一行的这个调用连到的卡没了（lost.to，比如子白板里删了那张卡）的 Call 箭头删掉：重新展开出来的箭头替它 */
export function removeLostCalls(b: Board, from: End, name: string): void {
  removeLinks(
    b,
    allLinks(b)
      .filter(
        (l) =>
          l.lost?.to &&
          l.call?.name === name &&
          l.from.card === from.card &&
          l.from.seg === from.seg &&
          l.from.line === from.line,
      )
      .map((l) => l.id),
  );
}

/** Delete these Links, on the canvas or on the Shelf, and the Stickers bound to them */
export function removeLinks(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  b.links = b.links.filter((l) => !gone.has(l.id));
  for (const e of b.shelf ?? []) e.links = e.links.filter((l) => !gone.has(l.id));
  pruneStickers(b);
}

/** 绑着的卡 / 箭头没了的 Sticker 一起删（删卡、删箭头之后调用；撤销时一起回来）。A shelved one is bound within its entry */
function pruneStickers(b: Board): void {
  const cards = new Set(b.cards.map((c) => c.id));
  const bound = (links: Set<string>) => (k: Sticker) => {
    const on = k.at.kind === "canvas" ? k.at.on : undefined;
    return !on || ("card" in on ? cards.has(on.card) : links.has(on.link));
  };
  b.stickers = b.stickers.filter(bound(new Set(b.links.map((l) => l.id))));
  for (const e of b.shelf ?? []) e.stickers = e.stickers.filter(bound(new Set(e.links.map((l) => l.id))));
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
  for (const l of allLinks(b)) {
    const f = gone.has(l.from.card),
      t = gone.has(l.to.card);
    if (f) l.from = moveEnd(l.from);
    if (t) l.to = moveEnd(l.to);
    if (f || t) touched.add(l.id);
  }
  const looped = (l: Link) => !(touched.has(l.id) && l.from.card === l.to.card);
  b.links = b.links.filter(looped);
  for (const e of b.shelf ?? []) e.links = e.links.filter(looped);
  const hosts = new Set<string>();
  for (const n of b.sidenotes) {
    if (gone.has(n.at.card)) {
      const o = to({ card: n.at.card, seg: n.at.seg, line: n.at.lines?.[0] });
      n.at = { card: o.card, seg: o.seg, lines: o.seg ? n.at.lines : undefined };
      hosts.add(o.card);
    }
    if (n.kind === "card" && gone.has(n.card)) n.card = to({ card: n.card }).card;
  }
  for (const k of allStickers(b)) {
    const at = k.at;
    if (at.kind === "line" && gone.has(at.card)) {
      const o = to({ card: at.card, seg: at.seg, line: at.line });
      k.at = o.seg ? { kind: "line", card: o.card, seg: o.seg, line: at.line } : cornerOf(b, o.card);
    } else if (at.kind === "canvas" && at.on && "card" in at.on && gone.has(at.on.card))
      at.on = { card: to({ card: at.on.card }).card };
  }
  pruneStickers(b);
  // sidenotes that came over with their lines bring their Highlights (cards that take them later bring them in themselves)
  fixHighlights(b, hosts);
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
  for (const id of gone) {
    delete b.place[id];
    for (const e of b.shelf ?? []) delete e.place[id];
  }
  forget(b, gone);
  tidyShelf(b);
}

/** 创建顺序按原来的先后重新从 0 编（拆出来的新白板：删掉别的卡之后号不连续），seq 接着编 */
export function renumberBorn(b: Board): void {
  const order = Object.entries(b.born ?? {}).sort((x, y) => x[1] - y[1]);
  b.born = Object.fromEntries(order.map(([id], i) => [id, i]));
  b.seq = order.length;
}

export function removeSidenotes(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  b.sidenotes = b.sidenotes.filter((n) => !gone.has(n.id));
}

/** Delete these stickers, on the canvas or on the Shelf */
export function removeStickers(b: Board, ids: Iterable<string>): void {
  const gone = new Set(ids);
  b.stickers = b.stickers.filter((k) => !gone.has(k.id));
  for (const e of b.shelf ?? []) e.stickers = e.stickers.filter((k) => !gone.has(k.id));
}

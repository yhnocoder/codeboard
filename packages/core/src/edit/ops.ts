// The board actions' domain changes (the board UI only selects, animates and tells): swapping a call's target, sidenotes ↔ cards,
// placing cards, Turn into Board, Sections, stacking order, Compare and inserting a card into an arrow.
// Pure functions that change the board passed in (the board calls them inside a mutate).
import type { BoundVal, CallAlt } from "@codeboard/analysis/basics";
import { removeCards, removeLinks, removeSidenotes, replaceCards } from "./refs";
import { clone, withCols, uid, type Board, type Card, type End, type Link, type Place, type Sidenote } from "../model";
import { eachMarkdown, retargetRefs } from "../mdrefs";

/**
 * 点灰色备选换实现：Call 箭头 linkId 改连新卡 card（摆在旧卡的位置和 Section 里；旧卡没有摆放时摆在 (0, 0)、宽 w）。
 * 旧卡只连着这一条箭头（没有别的箭头、没有挂在它上面的 Sidenote）：整张换成新卡（replaceCards：贴纸、调用图标记跟过去），
 * 原来的实现 oldAlt 放回被点的备选（第 alt 个）的位置；否则旧卡留着（新卡往下挪 40，成了第二条分支），只把这条箭头改连新卡，被点的备选拿掉。
 * label / vals：箭头的新标签、新取值（不给就不改）。返回旧卡留没留着；箭头不在或不是 Call 时什么都不改，返回 null
 */
export function swapCallTarget(
  b: Board,
  linkId: string,
  card: Card,
  o: { alt: number; oldAlt?: CallAlt; w: number; label?: string; vals?: BoundVal[] },
): { kept: boolean } | null {
  const l = b.links.find((x) => x.id === linkId);
  if (!l?.call) return null;
  const oldId = l.to.card;
  const kept =
    b.links.some((x) => x.id !== linkId && (x.from.card === oldId || x.to.card === oldId)) ||
    b.sidenotes.some((n) => n.at.card === oldId);
  const p = b.place[oldId];
  const section = p?.section;
  placeCards(b, [{ card, place: p ? { x: p.x, y: kept ? p.y + 40 : p.y, w: p.w } : { x: 0, y: 0, w: o.w } }], {
    copy: false,
    at: (q) => (section ? { ...q, section } : q),
  });
  const alts = [...(l.call.alts ?? [])];
  alts.splice(o.alt, 1, ...(o.oldAlt && !kept ? [o.oldAlt] : []));
  if (o.label) l.label = o.label;
  if (alts.length) l.call.alts = alts;
  else delete l.call.alts;
  if (o.vals) l.call.vals = o.vals;
  if (kept) l.to = { card: card.id };
  else replaceCards(b, [oldId], () => ({ card: card.id }));
  return { kept };
}

/**
 * Place on Board 的那张卡：Code / Paste → 代码卡，Text → Note，Link → 网页卡（「为什么相关」变成卡的说明）。
 * Card sidenote 指着的是白板上已有的卡，没有新卡
 */
export function sidenoteCard(n: Sidenote, id = uid("c")): Card | null {
  switch (n.kind) {
    case "code":
      return { id, kind: "code", segments: [{ ...clone(n.code), id: uid("s") }], desc: n.why };
    case "paste": {
      const text = n.text.split("\n");
      return {
        id,
        kind: "code",
        segments: [
          {
            id: uid("s"),
            src: { kind: "free", url: n.url },
            path: "",
            lang: n.lang,
            start: 1,
            end: text.length,
            text,
            version: { kind: "none" },
          },
        ],
        desc: n.why,
      };
    }
    case "text":
      return { id, kind: "note", md: n.md, look: "note" };
    case "link":
      return { id, kind: "web", url: n.url, meta: n.title ? { title: n.title } : undefined, desc: n.why };
    case "card":
      return null;
  }
}
/** Place on Board 在白板上的改动（新卡 card 已经放上白板）：Sidenote 去掉，从它挂的那一行连一条箭头到新卡 */
export function sidenoteToCard(b: Board, id: string, card: string): void {
  const n = b.sidenotes.find((k) => k.id === id);
  if (!n) return;
  removeSidenotes(b, [id]);
  b.links.push({ id: uid("l"), from: { card: n.at.card, seg: n.at.seg, line: n.at.lines?.[0] }, to: { card } });
}

/** 放到白板上的一张卡：内容、摆放（Compare 的栏没有）、跟着它来的 Sidenote */
export type CardCopy = { card: Card; place?: Place; sidenotes?: Sidenote[] };

/**
 * 把卡放到白板上（⌘D、粘贴、从别的白板来的卡）。copy = 独立副本：卡、段、Sidenote 都换新 id，Sidenote 的锚点跟着换；
 * 否则原样放（共享卡：同一个 id），白板上已经有的跳过。Compare 的栏要一起给。
 * 摆放：Section、折叠、锁定是原来那块白板的，不带过来；at 可以再挪。links = 原来那块白板上的 Link：两端都是这次放的卡（或白板上已有的
 * 同一张共享卡）的跟着来，换新 id、两端换成放下的卡和段，已经有一样的就不加。返回 旧 id → 新 id（卡和段，放了的才有）
 */
export function placeCards(
  b: Board,
  items: CardCopy[],
  o: { copy: boolean; at?: (p: Place) => Place; links?: Link[] },
): { cards: Record<string, string>; segs: Record<string, string> } {
  const cards: Record<string, string> = {},
    segs: Record<string, string> = {};
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
      for (const s of c.segments) {
        const n = o.copy ? uid("s") : s.id;
        segs[s.id] = n;
        own[s.id] = n;
        s.id = n;
      }
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
      if (o.copy) m.id = uid("n");
      else if (nids.has(m.id)) continue;
      m.at = { ...m.at, card: c.id, seg: m.at.seg && own[m.at.seg] };
      if (!m.at.seg) delete m.at.seg;
      b.sidenotes.push(m);
    }
  }
  const on = (id: string) => cards[id] ?? (!o.copy && have.has(id) ? id : undefined);
  const end = (e: End, card: string): End => ({
    ...e,
    card,
    ...(e.seg ? { seg: segsOf.get(e.card)?.[e.seg] ?? e.seg } : {}),
  });
  const key = (l: Link) =>
    JSON.stringify([
      l.from.card,
      l.from.seg,
      l.from.line,
      l.from.block?.i,
      l.to.card,
      l.to.seg,
      l.to.line,
      l.to.block?.i,
    ]);
  const there = new Set(b.links.map(key));
  for (const l of o.links ?? []) {
    const from = on(l.from.card),
      to = on(l.to.card);
    if (!from || !to) continue;
    const c = clone(l);
    const n: Link = { ...c, id: uid("l"), from: end(c.from, from), to: end(c.to, to) };
    if (there.has(key(n))) continue;
    there.add(key(n));
    b.links.push(n);
  }
  // 一起复制的卡之间的 [[引用#^id]] 跟着换成副本（和箭头一样）；指着没一起来的卡的留着原来的 id
  if (o.copy) {
    const fix = (md: string) => retargetRefs(md, cards);
    const made = new Set(Object.values(cards));
    eachMarkdown({ cards: b.cards.filter((c) => made.has(c.id)), sidenotes: [], stickers: [] }, fix);
    for (const n of b.sidenotes) if (made.has(n.at.card) && n.kind === "text") n.md = fix(n.md);
  }
  return { cards, segs };
}

/**
 * Turn into Board 的父白板一侧：这些卡（含 Compare 的栏）换成子白板框 frame（叠放在它们里最早那张的位置，摆在 place），sections 一起删掉。
 * 外面连进来的箭头改连到整个框（去掉行），从里面连出去的改成从整个框出发（去掉行和出发边）；
 * 其余跟删卡一样（removeCards）：里面的箭头、挂在这些卡上的 Sidenote、贴纸、问题的解答
 */
export function cardsToFrame(
  b: Board,
  ids: Iterable<string>,
  frame: Card,
  place: Place,
  sections: Iterable<string>,
): void {
  const want = new Set(withCols(b, ids));
  for (const l of b.links) {
    const a = want.has(l.from.card),
      t = want.has(l.to.card);
    if (a === t) continue;
    if (t) {
      l.to = { card: frame.id };
      if (l.lost) delete l.lost.to;
    } else {
      l.from = { card: frame.id };
      if (l.lost) delete l.lost.from;
      if (l.sides) delete l.sides.from;
    }
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
  const up = (id?: string) => {
    let s = id;
    for (let i = 0; s && gone.has(s) && i < 50; i++) s = b.sections.find((x) => x.id === s)?.parent;
    return s && !gone.has(s) ? s : undefined;
  };
  for (const s of b.sections)
    if (!gone.has(s.id) && s.parent && gone.has(s.parent)) {
      const p = up(s.parent);
      if (p) s.parent = p;
      else delete s.parent;
    }
  for (const p of Object.values(b.place))
    if (p.section && gone.has(p.section)) {
      const s = up(p.section);
      if (s) p.section = s;
      else delete p.section;
    }
  // on the Shelf: a shelved Section or card that was in one of these goes up the same way (where it returns to)
  for (const e of b.shelf ?? []) {
    for (const s of e.sections)
      if (s.parent && gone.has(s.parent)) {
        const p = up(s.parent);
        if (p) s.parent = p;
        else delete s.parent;
      }
    for (const p of Object.values(e.place))
      if (p.section && gone.has(p.section)) {
        const s = up(p.section);
        if (s) p.section = s;
        else delete p.section;
      }
  }
  b.sections = b.sections.filter((s) => !gone.has(s.id));
}

/** 改叠放顺序（b.cards 的顺序就是叠放顺序）。front / back = 最上 / 最下；forward / backward = 越过一张 overlaps 说跟它们重叠的卡 */
export type Arrange = "front" | "forward" | "backward" | "back";
export function arrangeCards(b: Board, ids: Iterable<string>, how: Arrange, overlaps: (id: string) => boolean): void {
  const set = new Set(ids);
  const moving = b.cards.filter((c) => set.has(c.id)),
    rest = b.cards.filter((c) => !set.has(c.id));
  if (!moving.length) return;
  const idx = b.cards.map((c) => c.id);
  const hit = (i: number) => !set.has(idx[i]) && !!b.place[idx[i]] && overlaps(idx[i]);
  let at: number; // moving 插在 rest 的哪个位置
  if (how === "front") at = rest.length;
  else if (how === "back") at = 0;
  else if (how === "forward") {
    const top = Math.max(...moving.map((c) => idx.indexOf(c.id)));
    let next = -1;
    for (let i = top + 1; i < idx.length; i++)
      if (hit(i)) {
        next = i;
        break;
      }
    at = next < 0 ? rest.length : rest.findIndex((c) => c.id === idx[next]) + 1;
  } else {
    const bot = Math.min(...moving.map((c) => idx.indexOf(c.id)));
    let prev = -1;
    for (let i = bot - 1; i >= 0; i--)
      if (hit(i)) {
        prev = i;
        break;
      }
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
  for (const s of b.stickers)
    if (s.at.kind === "canvas" && s.at.on && "card" in s.at.on && cols.includes(s.at.on.card)) s.at.on = { card: id };
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
  const la = b.links.find((k) => k.id === first),
    lb = b.links.find((k) => k.id === second);
  if (!la || !lb) return;
  la.to = { ...lb.to };
  if (la.style?.head?.end === false) {
    delete la.style.head;
    if (!Object.keys(la.style).length) delete la.style;
  }
  removeLinks(b, [second]);
  removeCards(b, [mid]);
}

/** 卡变成 Sidenote n：卡连同它的箭头一起删掉；n 是 kind card（指着这张卡）时卡留着 */
export function cardIntoSidenote(b: Board, cardId: string, n: Sidenote): void {
  b.sidenotes.push(n);
  if (n.kind !== "card") removeCards(b, [cardId]);
}

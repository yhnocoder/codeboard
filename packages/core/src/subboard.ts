// 子白板（BoardCard）：宿主把子白板算成一份很小的骨架（卡片的框和名字、调用图标记、连线、Section 色）发给父白板，
// 父白板只画骨架，不拿子白板的完整内容。纯函数：骨架、子白板关系（侧栏的树、不能套成环）、把选中的卡拆成一块新白板（Turn into Board）。
import { cardTitle, isCode, uid, versionLabel, type Board, type BoardCard, type Card, type Link, type Place, type Section } from "./model";
import { computeFlows } from "./flow";
import { bounds, estSize, union, type Rect } from "./layout";

/**
 * 骨架里的一张卡：框（相对骨架左上角，子白板的坐标）、名字、种类；g = 在子白板的第几张调用图里，m / i = 那张图的字母 / 图标；
 * sec = 所在 Section 的颜色。k = "more" 是折起来的分支（「+N」），ids = 折进去的卡
 */
export type SkelCard = { id: string; x: number; y: number; w: number; h: number; t: string; k: Card["kind"] | "more"; g?: number; m?: string; i?: string; sec?: string; ids?: string[] };
export type SkelSec = { x: number; y: number; w: number; h: number; color?: string; t: string };
/**
 * 一块子白板的骨架。w / h = 内容的范围；n = 卡数；commit = 代码卡里最多的那个 commit（短）；
 * links = 骨架里的连线，每三个数一条：[起点卡下标, 终点卡下标, 1 = Call / 0]
 */
export type Skeleton = { id: string; name: string; n: number; commit?: string; w: number; h: number; cards: SkelCard[]; secs: SkelSec[]; links: number[] };

/** 同一个出发点（同一张卡的同一行）的 Call 分支超过 FAN 条时，只留前 FAN_KEEP 条，其余折成「+N」 */
export const FAN = 5, FAN_KEEP = 3;
const SEC_PAD = { l: 22, r: 22, t: 34, b: 22 };

/** 这块白板上嵌着的子白板（去重，按出现的先后） */
export function subBoardsOf(b: Pick<Board, "cards">): string[] {
  return [...new Set(b.cards.filter((c): c is BoardCard => c.kind === "board").map((c) => c.board))];
}

/** child 放进 parent 会不会套成环：child 就是 parent，或者从 child 往下能走到 parent。subs(id) = 那块白板的子白板 */
export function wouldCycle(subs: (id: string) => readonly string[] | undefined, parent: string, child: string): boolean {
  const seen = new Set<string>();
  const stack = [child];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === parent) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    stack.push(...(subs(x) ?? []));
  }
  return false;
}

/** 卡在子白板上的框：Place 的位置 + 估计的大小（宿主量不到实测尺寸，layout.estSize） */
function rectOf(c: Card, p: Place): Rect {
  const s = estSize(c, p);
  return { x: p.x, y: p.y, w: s.w, h: c.kind === "board" ? p.h ?? 320 : s.h };
}

/** 跟白板界面 state/sections.ts 的 frameOf 一样：自己存的框 ∪ 成员卡（加边距）∪ 子 Section */
function sectionFrames(b: Board, rects: Map<string, Rect>): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const kids = new Map<string, Section[]>();
  for (const s of b.sections) if (s.parent) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s]);
  const members = new Map<string, Rect[]>();
  for (const [id, r] of rects) { const s = b.place[id]?.section; if (s) members.set(s, [...(members.get(s) ?? []), r]); }
  const pad = (k: Rect): Rect => ({ x: k.x - SEC_PAD.l, y: k.y - SEC_PAD.t, w: k.w + SEC_PAD.l + SEC_PAD.r, h: k.h + SEC_PAD.t + SEC_PAD.b });
  const frame = (s: Section, depth: number): Rect => {
    const had = out.get(s.id);
    if (had) return had;
    let r: Rect = { x: s.x, y: s.y, w: s.w, h: s.h };
    if (depth < 50) {
      for (const k of members.get(s.id) ?? []) r = union(r, pad(k));
      for (const ch of kids.get(s.id) ?? []) r = union(r, pad(frame(ch, depth + 1)));
    }
    out.set(s.id, r);
    return r;
  };
  for (const s of b.sections) frame(s, 0);
  return out;
}

/**
 * 算一块白板的骨架。nameOf：子白板里又嵌着的子白板叫什么（画成一块带名字的框）。
 * 坐标整体挪到从 (0, 0) 开始、取整，发给白板的东西尽量小
 */
export function skeletonOf(b: Board, nameOf: (id: string) => string | undefined = () => undefined): Skeleton {
  const flows = computeFlows(b);
  const graphIndex = new Map(flows.graphs.map((g, i) => [g.id, i]));
  const placed = b.cards.filter((c) => b.place[c.id]);
  const rects = new Map(placed.map((c) => [c.id, rectOf(c, b.place[c.id])]));
  const frames = sectionFrames(b, rects);
  const secColor = new Map(b.sections.map((s) => [s.id, s.color]));
  const host = new Map<string, string>();
  for (const c of b.cards) if (c.kind === "compare") for (const k of c.cols) host.set(k, c.id);
  const hostOf = (id: string) => host.get(id) ?? id;

  // 分支太多的出发点：留前 FAN_KEEP 条，其余目标折成「+N」（只折别处没有连进来的卡）
  const inCount = new Map<string, number>();
  for (const l of b.links) if (rects.has(hostOf(l.to.card)) && hostOf(l.from.card) !== hostOf(l.to.card)) inCount.set(hostOf(l.to.card), (inCount.get(hostOf(l.to.card)) ?? 0) + 1);
  const fold = new Map<string, string>(); // 卡 → 折进的那个「+N」的 id
  const mores: SkelCard[] = [];
  const points = new Map<string, Link[]>();
  for (const ls of flows.kids.values()) for (const l of ls) {
    const k = `${hostOf(l.from.card)}|${l.from.seg ?? ""}|${l.from.line ?? ""}`;
    points.set(k, [...(points.get(k) ?? []), l]);
  }
  for (const [k, ls] of points) {
    const tos = [...new Set(ls.map((l) => hostOf(l.to.card)))].filter((id) => rects.has(id));
    if (tos.length <= FAN) continue;
    const away = tos.slice(FAN_KEEP).filter((id) => (inCount.get(id) ?? 0) <= 1 && !fold.has(id));
    if (away.length < 2) continue;
    const id = `more:${k}`;
    for (const t of away) fold.set(t, id);
    const r = rects.get(away[0])!;
    mores.push({ id, x: r.x, y: r.y, w: Math.min(r.w, 220), h: 40, t: `+${away.length} more`, k: "more", ids: away });
  }

  const cards: SkelCard[] = [];
  for (const c of placed) {
    if (fold.has(c.id)) continue;
    const r = rects.get(c.id)!;
    const g = flows.byId.get(c.kind === "compare" ? c.cols.find((k) => flows.byId.has(k)) ?? c.id : c.id);
    const sc: SkelCard = { id: c.id, x: r.x, y: r.y, w: r.w, h: r.h, t: titleOf(c, b, nameOf), k: c.kind };
    if (g) {
      sc.g = graphIndex.get(g.id);
      if ("icon" in g.mark) sc.i = g.mark.icon; else sc.m = g.label;
    }
    const col = secColor.get(b.place[c.id].section ?? "");
    if (col) sc.sec = col;
    cards.push(sc);
  }
  cards.push(...mores);
  const secs: SkelSec[] = b.sections.map((s) => {
    const r = frames.get(s.id)!;
    const o: SkelSec = { x: r.x, y: r.y, w: r.w, h: r.h, t: s.title };
    if (s.color) o.color = s.color;
    return o;
  });

  const at = new Map(cards.map((c, i) => [c.id, i]));
  const idx = (id: string) => at.get(fold.get(hostOf(id)) ?? hostOf(id));
  const links: number[] = [];
  const seen = new Set<string>();
  for (const l of b.links) {
    const a = idx(l.from.card), t = idx(l.to.card);
    if (a === undefined || t === undefined || a === t) continue;
    const k = `${a}|${t}`;
    if (seen.has(k)) continue;
    seen.add(k);
    links.push(a, t, l.call ? 1 : 0);
  }

  // 挪到从 (0, 0) 开始，取整
  const box = bounds([...cards, ...secs]) ?? { x: 0, y: 0, w: 1, h: 1 };
  const r0 = (n: number) => Math.round(n);
  for (const o of [...cards, ...secs]) { o.x = r0(o.x - box.x); o.y = r0(o.y - box.y); o.w = r0(o.w); o.h = r0(o.h); }
  const sk: Skeleton = { id: b.id, name: b.name, n: b.cards.filter((c) => b.place[c.id]).length, w: Math.max(1, r0(box.w)), h: Math.max(1, r0(box.h)), cards, secs, links };
  const commit = mainCommit(b);
  if (commit) sk.commit = commit;
  return sk;
}

function titleOf(c: Card, b: Board, nameOf: (id: string) => string | undefined): string {
  if (c.kind === "board") return c.title || nameOf(c.board) || "Board";
  if (c.kind === "note") return (c.md.split("\n").map((l) => l.replace(/^[#>\-*\s]+/, "").trim()).find(Boolean) ?? "Note").slice(0, 80);
  return cardTitle(c, b).slice(0, 120);
}

/** 代码卡里出现最多的 git commit（短）；没有 git 代码时 undefined */
function mainCommit(b: Board): string | undefined {
  const n = new Map<string, number>();
  for (const c of b.cards) if (isCode(c)) for (const s of c.segments) if (s.version.kind === "git") { const k = versionLabel(s.version); n.set(k, (n.get(k) ?? 0) + 1); }
  let best: string | undefined, bn = 0;
  for (const [k, v] of n) if (v > bn) { best = k; bn = v; }
  return best;
}

/** 骨架里这张卡在不在（折进「+N」的也算在）：父白板上连到它的箭头据此标 lost */
export function skelHas(sk: Skeleton, card: string): boolean {
  return sk.cards.some((c) => c.id === card || !!c.ids?.includes(card));
}

// ---------- Turn into Board ----------

/** 子白板框的标题栏高度、四周留白（世界坐标）：白板界面画骨架、箭头找入口点都按它 */
export const FRAME_HEAD = 30, FRAME_PAD = 12;

/**
 * 把父白板上选中的卡（Compare 带上两栏）拆成一块新白板：新白板拿走这些卡、它们之间的箭头、跟着它们的 Sidenote 和贴纸、
 * 整个落在选区里的 Section（卡的位置挪到从 (80, 80) 开始）。父白板上这些卡换成一个子白板框（frame = 框的卡 id），
 * 外面连进来的箭头改成连到框里的那张卡（End.sub），从里面连出去的改成从整个框出发（去掉行）。
 * rects：卡的实测矩形（白板界面量的）。直接改 parent，返回新白板（还没存）
 */
export function extractBoard(parent: Board, ids: string[], rects: (id: string) => Rect, o: { id: string; name: string; frame?: string }): { child: Board; frame: string } | null {
  const want = new Set<string>();
  for (const id of ids) {
    const c = parent.cards.find((k) => k.id === id);
    if (!c || !parent.place[id]) continue;
    want.add(id);
    if (c.kind === "compare") c.cols.forEach((k) => want.add(k));
  }
  const top = ids.filter((id) => want.has(id));
  if (!top.length) return null;
  const box = bounds(top.map(rects))!;
  const dx = 80 - box.x, dy = 80 - box.y;
  // 成员全在选区里的 Section（和它下面的子 Section）一起搬走
  const secs = new Set<string>();
  const members = (sid: string) => parent.cards.filter((c) => parent.place[c.id]?.section === sid).map((c) => c.id);
  for (const s of parent.sections) { const m = members(s.id); if (m.length && m.every((id) => want.has(id))) secs.add(s.id); }
  for (let grew = true; grew;) { grew = false; for (const s of parent.sections) if (!secs.has(s.id) && s.parent && secs.has(s.parent) && members(s.id).every((id) => want.has(id))) { secs.add(s.id); grew = true; } }
  const child: Board = {
    version: parent.version, id: o.id, name: o.name, cam: { x: 40, y: 40, z: 1 },
    cards: parent.cards.filter((c) => want.has(c.id)).map((c) => clone(c)),
    place: {}, links: [], sections: [], sidenotes: [], stickers: [], born: {}, seq: 0,
  };
  for (const id of top) {
    const p = clone(parent.place[id]);
    p.x += dx; p.y += dy;
    if (p.section && !secs.has(p.section)) delete p.section;
    child.place[id] = p;
  }
  child.sections = parent.sections.filter((s) => secs.has(s.id)).map((s) => {
    const n = { ...clone(s), x: s.x + dx, y: s.y + dy };
    if (n.parent && !secs.has(n.parent)) delete n.parent;
    return n;
  });
  const isIn = (id: string) => want.has(id);
  child.links = parent.links.filter((l) => isIn(l.from.card) && isIn(l.to.card)).map((l) => clone(l));
  child.sidenotes = parent.sidenotes.filter((n) => isIn(n.at.card) && (n.kind !== "card" || isIn(n.card))).map((n) => clone(n));
  child.stickers = parent.stickers.filter((k) => {
    if (k.at.kind === "line" || k.at.kind === "card") return isIn(k.at.card);
    const on = k.at.on;
    if (on && "card" in on) return isIn(on.card);
    if (on && "link" in on) return child.links.some((l) => l.id === on.link);
    return false;
  }).map((k) => clone(k));
  // 创建顺序和调用图标记按原来的先后带过去
  const born = Object.entries(parent.born ?? {}).filter(([id]) => want.has(id)).sort((a, b) => a[1] - b[1]);
  born.forEach(([id], i) => { child.born![id] = i; });
  child.seq = born.length;
  for (const [k, m] of Object.entries(parent.marks ?? {})) if (want.has(k)) (child.marks ??= {})[k] = clone(m);

  // 父白板：卡换成框
  const frame = o.frame ?? uid("c");
  // 框比原来那片小（骨架是缩略的）：宽取一半左右，高按原来的长宽比，加标题栏
  const fw = Math.round(Math.max(360, Math.min(640, box.w * 0.45)));
  const fh = Math.round(Math.max(220, Math.min(560, (fw - FRAME_PAD * 2) * (box.h / Math.max(1, box.w)) + FRAME_HEAD + FRAME_PAD + 4)));
  const fr: Place = { x: Math.round(box.x), y: Math.round(box.y), w: fw, h: fh };
  const sec0 = parent.place[top[0]].section;
  if (sec0 && !secs.has(sec0)) fr.section = sec0;
  const moved = new Set(child.links.map((l) => l.id));
  parent.links = parent.links.filter((l) => !moved.has(l.id)).map((l) => {
    const a = isIn(l.from.card), t = isIn(l.to.card);
    if (!a && !t) return l;
    const n: Link = clone(l);
    if (t) { n.to = { card: frame, sub: hostIn(parent, l.to.card, want) }; if (n.lost) delete n.lost.to; }
    if (a) { n.from = { card: frame }; if (n.lost) delete n.lost.from; if (n.sides) delete n.sides.from; }
    if (n.lost && !n.lost.from && !n.lost.to) delete n.lost;
    if (n.sides && !n.sides.from && !n.sides.to) delete n.sides;
    return n;
  });
  const keepNote = new Set(child.sidenotes.map((n) => n.id));
  parent.sidenotes = parent.sidenotes.filter((n) => !keepNote.has(n.id) && !isIn(n.at.card) && !(n.kind === "card" && isIn(n.card)));
  const keepStk = new Set(child.stickers.map((k) => k.id));
  parent.stickers = parent.stickers.filter((k) => !keepStk.has(k.id));
  parent.sections = parent.sections.filter((s) => !secs.has(s.id)).map((s) => (s.parent && secs.has(s.parent) ? { ...s, parent: undefined } : s));
  const at = parent.cards.findIndex((c) => want.has(c.id));
  parent.cards = parent.cards.filter((c) => !want.has(c.id));
  parent.cards.splice(Math.max(0, Math.min(at, parent.cards.length)), 0, { id: frame, kind: "board", board: o.id });
  for (const id of want) { delete parent.place[id]; if (parent.born) delete parent.born[id]; if (parent.marks) delete parent.marks[id]; }
  parent.place[frame] = fr;
  return { child, frame };
}

/** 深拷贝（白板界面传进来的可能是 store 的代理，structuredClone 拷不了） */
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** 父白板上连到 Compare 的一栏：骨架里只有那张 Compare */
function hostIn(b: Board, id: string, want: Set<string>): string {
  const h = b.cards.find((c) => c.kind === "compare" && c.cols.includes(id));
  return h && want.has(h.id) ? h.id : id;
}

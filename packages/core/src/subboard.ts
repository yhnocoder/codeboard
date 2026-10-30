// 子白板（BoardCard）：宿主把子白板算成一份很小的骨架（每张卡的框、种类、名字，Section 的框，卡之间的连线，图片的缩略图，[[ 能链接的卡）发给父白板，
// 父白板按它在框里画一张缩略地图，不拿子白板的完整内容。点开地图上的一块时才问宿主要那一张卡（subCardOf）。
import { cardTitle, clone, emptyBoard, firstLine, hostOf, isCode, uid, versionLabel, withCols, type Board, type BoardCard, type Card, type Place } from "./model";
import { cardsToFrame, removeCards, removeSections, removeStickers, renumberBorn } from "./edit";
import { bounds, estSize, sectionFrames, type Rect } from "./layout";
import type { Crumb } from "./protocol";

/**
 * 骨架里的一张卡：框（相对骨架左上角，子白板的坐标）、种类、名字（悬停时的提示；图片是 alt 或正下方的图注，没有就空）。
 * lk = 没有卡框的 Note 的样子（Text 画成一道线，Box 只有边框，Mark 是几道手写色的线）；si = 所在 Section 在 secs 里的下标；
 * img = 图片（assets/ 下的文件名或小的 data: URL）
 */
export type SkelCard = { id: string; x: number; y: number; w: number; h: number; t: string; k: Card["kind"]; lk?: "text" | "box" | "mark"; si?: number; img?: string };
/** [[ 能链接到的一张卡（有真正标题的）：via = 从这块子白板往下要经过的子白板（框的卡 id、白板 id、名字），直接在这块上的没有 */
export type SkelRef = { id: string; t: string; k: Card["kind"]; via?: { f: string; b: string; n: string }[] };
export type SkelSec = { x: number; y: number; w: number; h: number; color?: string; t: string };
/**
 * 一块子白板的骨架。w / h = 内容的范围；n = 卡数；commit = 代码卡里最多的那个 commit（短）；
 * ln = 卡之间的连线（cards 里的下标，去重、不分方向）；refs = 它和它里面的子白板（一路往下）上能 [[ 链接的卡
 */
export type Skeleton = { id: string; name: string; n: number; commit?: string; w: number; h: number; cards: SkelCard[]; secs: SkelSec[]; ln: [number, number][]; refs: SkelRef[] };

/** 框里地图的留白（世界坐标）：左右下 MAP_PAD，上 MAP_TOP（最上面的 Section 名一半在区域外，要留出来）；很小的子白板也最多缩到 MAP_MAX（一两张卡不放成一大块） */
export const MAP_PAD = 14, MAP_TOP = 20, MAP_MAX = 0.5;
export type MapFit = { s: number; ox: number; oy: number };
/** 骨架（w × h）等比放进 W × H 的框：比例 s，左上角在框里的 (ox, oy)，居中 */
export function mapFit(sk: { w: number; h: number }, W: number, H: number): MapFit {
  const s = Math.max(1e-4, Math.min(MAP_MAX, (W - 2 * MAP_PAD) / sk.w, (H - MAP_TOP - MAP_PAD) / sk.h));
  return { s, ox: (W - sk.w * s) / 2, oy: MAP_TOP + (H - MAP_TOP - MAP_PAD - sk.h * s) / 2 };
}

/** 这块白板上嵌着的子白板（去重，按出现的先后） */
export function subBoardsOf(b: Pick<Board, "cards">): string[] {
  return [...new Set(b.cards.filter((c): c is BoardCard => c.kind === "board").map((c) => c.board))];
}

/**
 * 面包屑上的一块白板删掉了：它和它上面的几层都回不去了，只留它下面的几层（cams[i] 是回到 crumbs[i] 时的镜头，跟着一起剪）。
 * 面包屑上没有它返回 null
 */
export function cutCrumbs<T>(crumbs: readonly Crumb[], cams: readonly T[], gone: string): { crumbs: Crumb[]; cams: T[] } | null {
  const i = crumbs.findIndex((c) => c.id === gone);
  return i < 0 ? null : { crumbs: crumbs.slice(i + 1), cams: cams.slice(i + 1) };
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

/** 卡在子白板上的框：Place 的位置 + 大小（宿主量不到实测尺寸：layout.estSize，白板上量过的用量到的高 Place.mh） */
function rectOf(c: Card, p: Place): Rect {
  const s = estSize(c, p);
  return { x: p.x, y: p.y, w: s.w, h: c.kind === "board" ? p.h ?? 320 : s.h };
}

/**
 * [[ 引用能用的标题：自己起的名字、Note 第一行是标题（# 开头，或标题 / 小标题字号的 Text）、按符号命名的代码卡、子白板。
 * 图片和名字只是正文第一行的卡没有（undefined）
 */
export function refTitle(c: Card, nameOf: (board: string) => string | undefined = () => undefined): string | undefined {
  if (c.kind === "image") return undefined;
  const own = c.title?.trim();
  if (own) return own;
  switch (c.kind) {
    case "note": {
      const head = c.md.split("\n").find((l) => l.trim());
      return head && (/^\s{0,3}#{1,6}\s/.test(head) || (c.look === "text" && (c.size === "title" || c.size === "heading"))) ? firstLine(head) || undefined : undefined;
    }
    case "code": return c.segments[0]?.symbol ? cardTitle(c) : undefined;
    case "board": return nameOf(c.board) ?? "Board";
    default: return undefined;
  }
}

/** Note 去掉 Markdown 记号后的非空行（firstLine 同一套） */
const textLines = (md: string) => md.split("\n").map((l) => firstLine(l)).filter(Boolean);
/** 地图上能直接画的图片：assets/ 下的文件，或者不大的 data: URL（大的不往骨架里塞） */
const thumbOf = (src: string) => (!src.startsWith("data:") ? src : src.length <= 16_000 ? src : undefined);

/**
 * 算一块白板的骨架。peek：按 id 拿别的白板（子白板里又嵌着的子白板的名字、[[ 能链接到的它们的卡）。
 * 坐标整体挪到从 (0, 0) 开始、取整，发给白板的东西尽量小
 */
export function skeletonOf(b: Board, peek: (id: string) => Board | undefined = () => undefined): Skeleton {
  const nameOf = (id: string) => peek(id)?.name;
  const placed = b.cards.filter((c) => b.place[c.id]);
  const rects = new Map(placed.map((c) => [c.id, rectOf(c, b.place[c.id])]));
  const frames = sectionFrames(b, rects);
  const secIndex = new Map(b.sections.map((s, i) => [s.id, i]));
  const host = hostOf(b);

  const cards: SkelCard[] = [];
  for (const c of placed) {
    const r = rects.get(c.id)!;
    const sc: SkelCard = { id: c.id, x: r.x, y: r.y, w: r.w, h: r.h, t: c.kind === "image" ? imageName(c, r, placed, rects) : titleOf(c, b, nameOf), k: c.kind };
    if (c.kind === "note" && c.look !== "note") sc.lk = c.look;
    if (c.kind === "image") { const img = thumbOf(c.src); if (img) sc.img = img; }
    const si = secIndex.get(b.place[c.id].section ?? "");
    if (si !== undefined) sc.si = si;
    cards.push(sc);
  }
  const at = new Map(cards.map((c, i) => [c.id, i]));
  const ln: [number, number][] = [], seen = new Set<string>();
  for (const l of b.links) {
    const i = at.get(host(l.from.card)), j = at.get(host(l.to.card));
    if (i === undefined || j === undefined || i === j) continue;
    const k = i < j ? `${i},${j}` : `${j},${i}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ln.push([i, j]);
  }
  const secs: SkelSec[] = b.sections.map((s) => {
    const r = frames.get(s.id)!;
    const o: SkelSec = { x: r.x, y: r.y, w: r.w, h: r.h, t: s.title };
    if (s.color) o.color = s.color;
    return o;
  });

  const box = bounds([...cards, ...secs]) ?? { x: 0, y: 0, w: 1, h: 1 };
  const r0 = (n: number) => Math.round(n);
  for (const o of [...cards, ...secs]) { o.x = r0(o.x - box.x); o.y = r0(o.y - box.y); o.w = r0(o.w); o.h = r0(o.h); }
  const sk: Skeleton = { id: b.id, name: b.name, n: placed.length, w: Math.max(1, r0(box.w)), h: Math.max(1, r0(box.h)), cards, secs, ln, refs: refsOf(b, peek) };
  const commit = mainCommit(b);
  if (commit) sk.commit = commit;
  return sk;
}

function titleOf(c: Card, b: Board, nameOf: (id: string) => string | undefined): string {
  if (c.kind === "board") return c.title || nameOf(c.board) || "Board";
  if (c.kind === "note") return (c.look === "mark" ? textLines(c.md).join(" ").slice(0, 160) : (c.title || firstLine(c.md) || "Note").slice(0, 80)) || "Mark";
  return cardTitle(c, b).slice(0, 120);
}

/** 图片的名字：自己的 alt、标题，没有就用正下方的图注（紧贴着图下边、和图左右对齐的 Text），都没有是空的 */
function imageName(c: Extract<Card, { kind: "image" }>, r: Rect, cards: Card[], rects: Map<string, Rect>): string {
  const own = (c.alt || c.title)?.trim();
  if (own) return own.slice(0, 120);
  const cap = cards.find((k) => {
    if (k.kind !== "note" || k.look !== "text") return false;
    const q = rects.get(k.id)!;
    return q.y >= r.y + r.h - 4 && q.y <= r.y + r.h + 40 && Math.abs(q.x + q.w / 2 - (r.x + r.w / 2)) < r.w / 2;
  });
  return cap?.kind === "note" ? textLines(cap.md).join(" ").slice(0, 120) : "";
}

/**
 * 地图上点开的一张卡的完整内容（只读预览用）：卡本身，Compare 再带上两栏的卡。不在 b 上是 null。
 * 宿主再给代码段配上展示数据（高亮），见 protocol 的 subCard
 */
export function subCardOf(b: Board, id: string): { card: Card; cols?: Card[] } | null {
  const c = b.cards.find((k) => k.id === id);
  if (!c) return null;
  if (c.kind !== "compare") return { card: c };
  return { card: c, cols: c.cols.map((k) => b.cards.find((x) => x.id === k)).filter((x): x is Card => !!x) };
}

/** 这块白板上（和一路往下的子白板里）有真正标题的卡（refTitle）；套得太深、套成环的不往下走 */
function refsOf(b: Board, peek: (id: string) => Board | undefined): SkelRef[] {
  const out: SkelRef[] = [];
  const seen = new Set<string>([b.id]);
  const walk = (x: Board, via: { f: string; b: string; n: string }[]) => {
    for (const c of x.cards) {
      if (!x.place[c.id]) continue;
      const t = refTitle(c, (id) => peek(id)?.name);
      if (t) out.push(via.length ? { id: c.id, t, k: c.kind, via } : { id: c.id, t, k: c.kind });
      if (c.kind !== "board" || seen.has(c.board) || via.length >= 8) continue;
      const sub = peek(c.board);
      if (!sub) continue;
      seen.add(c.board);
      walk(sub, [...via, { f: c.id, b: sub.id, n: sub.name }]);
    }
  };
  walk(b, []);
  return out;
}

/** 代码卡里出现最多的 git commit（短）；没有 git 代码时 undefined */
function mainCommit(b: Board): string | undefined {
  const n = new Map<string, number>();
  for (const c of b.cards) if (isCode(c)) for (const s of c.segments) if (s.version.kind === "git") { const k = versionLabel(s.version); n.set(k, (n.get(k) ?? 0) + 1); }
  let best: string | undefined, bn = 0;
  for (const [k, v] of n) if (v > bn) { best = k; bn = v; }
  return best;
}

/**
 * 卡 card 在 b 或它一路往下的哪块子白板上：从 b 进到那块要经过的框（frame = 上一层白板上的框，board = 进到的白板）。
 * 就在 b 上是 []，哪都找不到是 null。宽度优先：同一张卡（共享卡）出现在几层时走最近的那层
 */
export function cardPath(b: Board, card: string, peek: (id: string) => Board | undefined): { frame: string; board: string }[] | null {
  const seen = new Set<string>([b.id]);
  let level: { b: Board; path: { frame: string; board: string }[] }[] = [{ b, path: [] }];
  for (let depth = 0; level.length && depth < 9; depth++) {
    const next: typeof level = [];
    for (const { b: x, path } of level) {
      if (x.cards.some((c) => c.id === card || (c.kind === "compare" && c.cols.includes(card)))) return path;
      for (const c of x.cards) {
        if (c.kind !== "board" || seen.has(c.board)) continue;
        const sub = peek(c.board);
        if (!sub) continue;
        seen.add(c.board);
        next.push({ b: sub, path: [...path, { frame: c.id, board: sub.id }] });
      }
    }
    level = next;
  }
  return null;
}

/** 子白板框里预览四周的留白（世界坐标）：名字在框外上方，框里只有分栏 */
const FRAME_PAD = 16;

/**
 * 把父白板上选中的卡（Compare 带上两栏）拆成一块新白板：新白板拿走这些卡、它们之间的箭头、跟着它们的 Sidenote 和贴纸、
 * 整个落在选区里的 Section（卡的位置挪到从 (80, 80) 开始）。父白板上这些卡换成一个子白板框（frame = 框的卡 id，edit.cardsToFrame）。
 * 新白板是父白板的拷贝删掉其余的卡和 Section（removeCards / removeSections），引用的清理和父白板删卡一样。
 * rects：卡的实测矩形（白板界面量的）。直接改 parent，返回新白板（还没存）
 */
export function extractBoard(parent: Board, ids: string[], rects: (id: string) => Rect, o: { id: string; name: string; frame?: string }): { child: Board; frame: string } | null {
  const top = ids.filter((id) => parent.place[id] && parent.cards.some((c) => c.id === id));
  if (!top.length) return null;
  const want = new Set(withCols(parent, top));
  const box = bounds(top.map(rects))!;
  const dx = 80 - box.x, dy = 80 - box.y;
  // 成员全在选区里的 Section（和它下面的子 Section）一起搬走
  const secs = new Set<string>();
  const members = (sid: string) => parent.cards.filter((c) => parent.place[c.id]?.section === sid).map((c) => c.id);
  for (const s of parent.sections) { const m = members(s.id); if (m.length && m.every((id) => want.has(id))) secs.add(s.id); }
  for (let grew = true; grew;) { grew = false; for (const s of parent.sections) if (!secs.has(s.id) && s.parent && secs.has(s.parent) && members(s.id).every((id) => want.has(id))) { secs.add(s.id); grew = true; } }

  const { cards, place, links, sections, sidenotes, stickers, born, marks } = clone(parent);
  const child: Board = { ...emptyBoard(o.id, o.name), cam: { x: 40, y: 40, z: 1 }, cards, place, links, sections, sidenotes, stickers, born, marks };
  removeCards(child, child.cards.filter((c) => !want.has(c.id)).map((c) => c.id));
  removeSections(child, child.sections.filter((s) => !secs.has(s.id)).map((s) => s.id));
  removeStickers(child, child.stickers.filter((k) => k.at.kind === "canvas" && !k.at.on).map((k) => k.id)); // 画布上没绑东西的留在父白板
  for (const p of Object.values(child.place)) { p.x += dx; p.y += dy; }
  for (const s of child.sections) { s.x += dx; s.y += dy; }
  renumberBorn(child);

  // 父白板：卡换成框。框比原来那片小（骨架是缩略的）：宽取一半左右，高按原来的长宽比
  const frame = o.frame ?? uid("c");
  const fw = Math.round(Math.max(360, Math.min(640, box.w * 0.45)));
  const fh = Math.round(Math.max(220, Math.min(560, (fw - FRAME_PAD * 2) * (box.h / Math.max(1, box.w)) + FRAME_PAD * 2)));
  const fr: Place = { x: Math.round(box.x), y: Math.round(box.y), w: fw, h: fh };
  const sec0 = parent.place[top[0]].section;
  if (sec0 && !secs.has(sec0)) fr.section = sec0;
  cardsToFrame(parent, want, { id: frame, kind: "board", board: o.id }, fr, secs);
  return { child, frame };
}

// Shared cards and twins: a shared card unlinked on this board, the same card placed several times kept in step.
// Pure functions that change the board passed in (the board calls them inside a mutate).
import { renameCard, removeStickers } from "./refs";
import { clone, copyTwinContent, twinContent, uid, type Board, type Card } from "../model";

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
  const c = b.cards.find((k) => k.id === id),
    o = b.cards.find((k) => k.id === of);
  if (!c || !o || c === o || c.kind === "compare" || o.kind === "compare" || (c.same && c.same === o.same))
    return false;
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
  for (const sg of c.segments) {
    segs[sg.id] = uid("s");
    sg.id = segs[sg.id];
  }
  for (const v of c.variants ?? []) for (const sg of v.segs ?? []) sg.id = segs[sg.id] ?? sg.id;
  resegCard(b, id, new Map(Object.entries(segs)));
  return segs;
}

/** 卡 id 上指着段的引用换段 id（map 里没有的：箭头、Sidenote 退到整张卡，行上的 Sticker 删掉） */
function resegCard(b: Board, id: string, map: Map<string, string | undefined>): void {
  if (!map.size) return;
  for (const l of b.links)
    for (const e of [l.from, l.to]) {
      if (e.card !== id || !e.seg) continue;
      const n = map.get(e.seg);
      if (n) e.seg = n;
      else {
        delete e.seg;
        delete e.line;
      }
    }
  for (const n of b.sidenotes) {
    if (n.at.card !== id || !n.at.seg) continue;
    const k = map.get(n.at.seg);
    if (k) n.at.seg = k;
    else {
      delete n.at.seg;
      delete n.at.lines;
    }
  }
  const gone: string[] = [];
  for (const k of b.stickers) {
    if (k.at.kind !== "line" || k.at.card !== id) continue;
    const n = map.get(k.at.seg);
    if (n) k.at.seg = n;
    else gone.push(k.id);
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
    if (a) a.push(c);
    else groups.set(g, [c]);
  }
  const next = new Map<string, string>();
  for (const cs of groups.values()) {
    if (cs.length < 2) continue;
    const keys = cs.map((c) => twinContent(raw(c)));
    let src = cs.findIndex((c, i) => seen.has(c.id) && seen.get(c.id) !== keys[i]);
    if (src < 0)
      src = Math.max(
        0,
        cs.findIndex((c) => seen.has(c.id)),
      );
    const from = clone(raw(cs[src]));
    for (let i = 0; i < cs.length; i++) if (keys[i] !== keys[src]) copyTwinContent(from, cs[i], raw);
    for (const c of cs) next.set(c.id, keys[src]);
  }
  seen.clear();
  for (const [k, v] of next) seen.set(k, v);
}

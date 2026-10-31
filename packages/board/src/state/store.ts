import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import { batch, createMemo, createSignal } from "solid-js";
import {
  applyPatch, danglingRefs, computeFlows, emptyBoard, hiddenByCollapse, removeCards, stampBorn, applySharedUpdate, syncTwins, DEFAULT_SETTINGS, CODE_HEAD,
  type Board, type BoardMeta, type BoardPatch, type Camera, type Card, type HostInfo, type ListPatch, type Place, type SegView, type SharedInfo, type SharedUpdate, type Stale,
} from "@codeboard/core";
import { ask, send } from "../host";
import { ghostOut } from "./ghost";
import { rooted, boardSignal } from "./root";
import { trimLru } from "./lru";
import { followBlocks } from "../md/blocks";
import { LIVE_DELAY, RESEND_DELAY, SEL_REPORT } from "./timing";

export const [state, setState] = createStore({
  loaded: false,
  board: emptyBoard("", "") as Board,
  boards: [] as BoardMeta[],
  host: { isMac: true, assetBase: "", target: true, settings: DEFAULT_SETTINGS } as HostInfo,
  views: {} as Record<string, SegView>,
  stale: {} as Record<string, Stale>,
});

/** 共享卡在几块白板上、别的白板上谁连到它。宿主存盘后算好整个发来；只有在两块以上白板上的卡才有；不进撤销栈、不存盘 */
export const [shared, setShared] = createStore<Record<string, SharedInfo>>({});
export const sharedOn = (id: string) => shared[id]?.boards.length ?? 0;

export type Sel = { cards: string[]; links: string[]; sections: string[] };
const [sel, setSel] = createStore<Sel>({ cards: [], links: [], sections: [] });
export { sel };
export type LineSel = { card: string; seg: string; start: number; end: number };
export const [lineSel, setLineSel] = boardSignal<LineSel | null>(null);

export function select(o: Partial<Sel>, add = false) {
  batch(() => {
    if (!add) setSel({ cards: [], links: [], sections: [] });
    for (const k of ["cards", "links", "sections"] as const) {
      const v = o[k];
      if (v) setSel(k, (old) => (add ? [...new Set([...old, ...v])] : v));
    }
  });
  reportSelection();
}
export function toggleSel(kind: keyof Sel, id: string) {
  setSel(kind, (old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id]));
  reportSelection();
}
export const clearSel = () => { select({}); setLineSel(null); };
export const isSel = (id: string) => sel.cards.includes(id);

let selTimer: number | undefined;
export function reportSelection() {
  clearTimeout(selTimer);
  selTimer = window.setTimeout(() => {
    const ls = lineSel();
    send({ type: "selection", cards: [...sel.cards], lines: ls ?? undefined });
  }, SEL_REPORT);
}

/** 只读卡的 id / 段、线的两端和 Call 标记、born / marks：拖动卡片不会让它重算 */
export const flows = rooted(() => createMemo(() => computeFlows(state.board)));
/** 因为折叠藏起来的卡（不管 Walkthrough 有没有临时展开） */
export const collapsedSet = rooted(() => createMemo(() => hiddenByCollapse(state.board, flows())));
/** Walkthrough 时临时展开所有折叠的卡：只影响显示，不进撤销、不存盘 */
const [showCollapsed, setShowCollapsed] = boardSignal(false);
export { setShowCollapsed };
export const collapsedAway = rooted(() => createMemo(() => (showCollapsed() ? new Set<string>() : collapsedSet())));

/** id → 卡（Compare 的栏也在里面，host 是外面的 Compare）。卡的增删、换 id 时才重建；拖动、改内容不动它 */
const cardIndex = rooted(() => createMemo(() => {
  const m = new Map<string, { card: Card; host: Card }>();
  for (const c of state.board.cards) if (!m.has(c.id)) m.set(c.id, { card: c, host: c });
  for (const c of state.board.cards) if (c.kind === "compare") for (const k of c.cols) { const f = m.get(k); if (f) m.set(k, { card: f.card, host: c }); }
  return m;
}));
export const cardById = (id: string) => cardIndex().get(id);
export const hostOf = (id: string) => cardById(id)?.host.id ?? id;
/** 按叠放顺序 */
export const placed = rooted(() => createMemo(() => state.board.cards.filter((c) => state.board.place[c.id])));

const NOWHERE: Place = { x: 0, y: 0, w: 320 };
export function placeOf(id: string): Place {
  return state.board.place[id] ?? state.board.place[hostOf(id)] ?? NOWHERE;
}

// 卡片实测尺寸（世界坐标）；Section 实际框
export const [sizes, setSizes] = createStore<Record<string, { w: number; h: number }>>({});
/** 宽高优先用实测；量到 0 的不算（卡被藏起来时量到的） */
export function rectOf(c: { id: string } | string) {
  const id = typeof c === "string" ? c : c.id;
  const p = placeOf(id);
  const s = sizes[hostOf(id)];
  // 还没量到：代码卡的 h 只是内容区，按 Warm Ink 的卡头加回去
  return { x: p.x, y: p.y, w: s && s.w > 0 ? s.w : p.w, h: s && s.h > 0 ? s.h : p.h ? p.h + (cardById(id)?.host.kind === "code" ? CODE_HEAD : 0) : 120 };
}

// 三层：mutate = 用户的修改（进撤销栈）；sync = 宿主同步来的、视图推出来的（存盘，不进撤销栈）；live = 拖动中的修改（结束时整个手势进一次撤销栈）。
// 快照按「每张卡 / 每条线 / 每个 Section / 每条 Sidenote 一段 JSON」存，没变的那段直接沿用上一份快照里的字符串，
// 所以 300 步撤销只多占改过的那几项，而不是 300 份整块白板。镜头不进快照。
// epoch = 拍快照时 sync 记到第几次：撤销 / 重做回到这份快照后，把它之后的 sync 重放一遍。
// ids = 每类东西的 id（和那几段一一对应；自动保存按 id 比出变了哪些）。和上一份快照一样时沿用同一个数组。
// step = 进撤销栈的快照：从它到下一步改了哪些卡 / Sidenote（"c" / "n" + id；撤销时看共享卡是不是被别的白板后来改过）
// fx = 从它到下一步在白板外面做了什么（宿主那边建了一块白板）：撤销 / 重做这一步时跟着撤 / 重做
type Ids = Record<(typeof KEYS)[number], string[]>;
type Snap = { epoch: number; head: string; cards: string[]; place: string[]; links: string[]; sections: string[]; sidenotes: string[]; stickers: string[]; ids: Ids; step?: string[]; fx?: Effect };
/** 一步修改在白板外面的效果 */
export type Effect = { undo: () => void; redo: () => void };
const undoStack: Snap[] = [];
const redoStack: Snap[] = [];
const [canUndo, setCanUndo] = createSignal(false);
export { canUndo };
const [canRedo, setCanRedo] = createSignal(false);
export { canRedo };
const last = new Map<string, string>();
function piece(k: string, o: unknown) {
  const s = JSON.stringify(o);
  const p = last.get(k);
  if (p === s) return p; // 内容一样：用旧的那个字符串，新的马上就能回收
  last.set(k, s);
  return s;
}
// 当前白板的快照缓存：mutate 改完拍的那份，就是下一次 mutate 的「改之前」。只有 mutate 会填它，
// 其它写白板的地方（live、restore、宿主 init）都会让它作废，所以每次 mutate 只拍一次快照，不是两次
let cur: Snap | null = null;
function snap(): Snap {
  if (cur) return cur;
  return snapNow();
}
let lastIds: Ids | null = null;
function snapNow(): Snap {
  const { cards, place, links, sections, sidenotes, stickers, cam: _cam, ...head } = unwrap(state.board);
  const placeIds = Object.keys(place);
  const p = lastIds;
  const ids: Ids = {
    cards: idsOf(cards, p?.cards), place: sameIds(placeIds, p?.place) ? p!.place : placeIds, links: idsOf(links, p?.links),
    sections: idsOf(sections, p?.sections), sidenotes: idsOf(sidenotes, p?.sidenotes), stickers: idsOf(stickers, p?.stickers),
  };
  lastIds = ids;
  return {
    epoch: syncN,
    head: JSON.stringify(head),
    cards: cards.map((x) => piece(`c${x.id}`, x)),
    place: placeIds.map((id) => piece(`p${id}`, [id, place[id]])),
    links: links.map((x) => piece(`l${x.id}`, x)),
    sections: sections.map((x) => piece(`s${x.id}`, x)),
    sidenotes: sidenotes.map((x) => piece(`n${x.id}`, x)),
    stickers: stickers.map((x) => piece(`k${x.id}`, x)),
    ids,
  };
}
/** id 和上一份快照一样就沿用那个数组（300 步撤销不多占一份 id） */
const idsOf = (xs: { id: string }[], prev?: string[]) => (prev && prev.length === xs.length && xs.every((x, i) => x.id === prev[i]) ? prev : xs.map((x) => x.id));
const sameIds = (xs: string[], prev?: string[]) => !!prev && prev.length === xs.length && xs.every((x, i) => x === prev[i]);
const KEYS = ["cards", "place", "links", "sections", "sidenotes", "stickers"] as const;
const sameArr = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const same = (a: Snap, b: Snap) => a.head === b.head && KEYS.every((k) => sameArr(a[k], b[k]));
const parse = (s: Snap): Board => {
  const p = (xs: string[]) => xs.map((x) => JSON.parse(x));
  return { ...JSON.parse(s.head), cards: p(s.cards), place: Object.fromEntries(p(s.place)), links: p(s.links), sections: p(s.sections), sidenotes: p(s.sidenotes), stickers: p(s.stickers) };
};
const updUndo = () => { setCanUndo(undoStack.length > 0); setCanRedo(redoStack.length > 0); };

/**
 * 新卡记下创建顺序（core stampBorn）。先在原始对象上看有没有缺的：挪卡、撤销这些不加卡的改动直接跳过，不走 produce 代理把每张卡读一遍。
 * 缺的话在一份普通对象上编号，再整个换掉 born：宿主写进来的一批卡（没有编号）一次编完只通知一次，
 * 不是每张卡一次（241 张卡时第一次挪卡要 30ms）
 */
function stamp(b: Board) {
  const raw = unwrap(b), born = raw.born;
  if (born && raw.cards.every((c) => born[c.id] !== undefined)) return;
  const tmp = { cards: raw.cards, born: { ...born }, seq: raw.seq } as Board;
  stampBorn(tmp);
  b.born = tmp.born;
  b.seq = tmp.seq;
}

// 摆在几处的同一张卡（same）：每次改完白板，把改了的那一处的内容抄给别的几处（core syncTwins），和这次修改算同一步。
// twinSeen = 上次看到的每处的内容；撤销 / 换白板之后按那时的白板重记
const twinSeen = new Map<string, string>();
function twins(b: Board) {
  if (unwrap(b).cards.some((c) => c.same)) syncTwins(b, twinSeen, unwrap);
  else twinSeen.clear();
}
// Note 的字变了：连着它某一块的箭头端点跟着那一块走（md/blocks.ts → core rebaseBlocks），和这次修改算同一步。
// blockSeen = 上次看到的每张 Note 的 md；撤销 / 换白板之后按那时的白板重记（快照里箭头和字本来就是对得上的）
const blockSeen = new Map<string, string>();
/** 每次改完白板都要做的：摆在几处的同一张卡抄一遍内容、块端点跟着字走 */
function upkeep(b: Board) {
  twins(b);
  followBlocks(b, blockSeen, unwrap);
}
function reseeTwins() {
  twinSeen.clear();
  blockSeen.clear();
  setState("board", produce(upkeep));
}
/** 和 id 是同一张卡的几处（含它自己，按叠放顺序）；不是的话空 */
const twinIndex = rooted(() => createMemo(() => {
  const m = new Map<string, string[]>();
  for (const c of state.board.cards) if (c.same) { const a = m.get(c.same); if (a) a.push(c.id); else m.set(c.same, [c.id]); }
  return m;
}));
export const twinsOf = (id: string): string[] => {
  const g = cardById(id)?.card.same;
  const a = g ? twinIndex().get(g) : undefined;
  return a && a.length > 1 ? a : [];
};

/**
 * 一次可撤销的修改。fn 里直接改 board（immer 风格）。
 * fn 抛错就整次撤回、提示一下，返回 false；什么都没改不进撤销栈。
 * opts.fx = 这一步在白板外面做的事，撤销 / 重做时跟着撤 / 重做；opts.merge：和上一步的 merge 一样（中间没有别的修改、撤销）就并进上一步，比如连续按方向键挪同一批卡算一步
 */
export function mutate(fn: (b: Board) => void, opts: { merge?: string; fx?: Effect } = {}): boolean {
  const before = snap();
  cur = null;
  try { setState("board", produce((b: Board) => { fn(b); upkeep(b); stamp(b); })); }
  catch (e) {
    // 改到一半抛错：produce 已经改了一部分，整次撤回，别留下半截的白板
    restore(before);
    console.error("mutate failed", e);
    toast("Something went wrong; the change was undone.");
    return false;
  }
  const bad = danglingRefs(unwrap(state.board));
  if (bad.length) console.warn("[codeboard] dangling references after a change:", bad); // 自检：应该永远是空的，harness 会把它当失败
  const after = snapNow();
  if (same(after, before)) { cur = before; return true; }
  cur = after;
  changed();
  pushUndo(before, after, opts);
  return true;
}

/** 栈顶那一步的 merge（见 mutate）：别的修改、撤销 / 重做之后清掉 */
let topMerge: string | undefined;
function pushUndo(before: Snap, after: Snap, { merge, fx }: { merge?: string; fx?: Effect } = {}) {
  const top = undoStack[undoStack.length - 1];
  if (merge && merge === topMerge && top) {
    top.step = touched(top, after);
    redoStack.length = 0;
    updUndo();
    return;
  }
  topMerge = merge;
  before.step = touched(before, after);
  before.fx = fx;
  undoStack.push(before);
  if (undoStack.length > 300) undoStack.shift();
  redoStack.length = 0;
  updUndo();
}

// 新建、还没写内容的 Note / Text / Code / 问题：建这一步先不进撤销栈。
// 写了内容 → 「新建 + 内容」算撤销栈里的一步；什么都没写就失焦 → 自动消失（drop），就像没建过。
const fresh = new Map<string, { before: Snap; drop: (b: Board) => void }>();
export function createFresh(id: string, fn: (b: Board) => void, drop = (b: Board) => removeCards(b, [id])) {
  const before = snap();
  live(fn);
  fresh.set(id, { before, drop });
}
export const isFresh = (id: string) => fresh.has(id);
/** 结束新卡的第一次编辑：keep = 写了内容（fn 是写内容的修改） */
export function settleFresh(id: string, keep: boolean, fn?: (b: Board) => void) {
  const f = fresh.get(id);
  if (!f) return;
  fresh.delete(id);
  if (!keep) { ghostOut([id]); live(f.drop); setSel("cards", (c) => c.filter((x) => x !== id)); return; }
  live((b) => { fn?.(b); stamp(b); });
  pushUndo(f.before, (cur = snap()));
  changed();
}

/** 拖动这种连续的修改：开始时记一下，结束时如果变了才进撤销栈（record = false：不进，比如挪的是还没结算的新卡） */
export function beginGesture(): (record?: boolean) => void {
  const before = snap();
  held.add(before);
  // 拍的这份就是现在的白板：留作快照缓存，800ms 后的自动保存不用再拍一遍
  return (record = true) => { held.delete(before); const after = (cur = snap()); if (record && !same(after, before)) { pushUndo(before, after); changed(); } };
}
/** 还没进撤销栈、但以后会进的快照（拖动开始时拍的）：它们之后的 sync 记录不能丢 */
const held = new Set<Snap>();
/** 拖动中的修改（不进撤销栈） */
export function live(fn: (b: Board) => void) {
  cur = null;
  setState("board", produce((b: Board) => { fn(b); upkeep(b); }));
  changedLive();
}
/** 镜头停下来时记进白板（不进撤销栈）。快照里没有镜头，所以快照缓存还能用，自动保存只发镜头 */
export function liveCam(c: Camera) {
  setState("board", "cam", c);
  changedLive();
}

// sync 的记录：撤销 / 重做后要重放。只留撤销 / 重做栈里最老的快照之后的那些，再多也不超过 SYNC_MAX 条。
// shared = 别的白板改的共享项（"c" / "n" + id）：撤销时重放它们，等于这一项不撤
const syncLog: { n: number; fn: (b: Board) => void; shared?: string[] }[] = [];
let syncN = 0;
const SYNC_MAX = 2000;
/**
 * 宿主同步来的、视图推出来的修改（代码挪了几行、网页信息、变量候选、换主题后的 reflow）：写进白板、存盘，但不进撤销栈。
 * 撤销 / 重做恢复到它之前的快照后会再跑一遍 fn，所以 fn 要能用在更早的白板上：按 id 找、找不到就跳过，按绝对目标算（不是 += 上次的差）。
 */
export function sync(fn: (b: Board) => void, shared?: string[]) {
  cur = null;
  setState("board", produce((b: Board) => { fn(b); upkeep(b); stamp(b); }));
  syncLog.push({ n: ++syncN, fn, shared });
  trimSync();
  changed();
}

/** 别的白板改了共享卡（宿主转来的，或者撤销时宿主跳过的项）：按项换上，不进撤销栈、撤销后重放；不再发回宿主 */
export function syncShared(cards: SharedUpdate[], views?: Record<string, SegView>) {
  // 先把还没发的改动发出去：之后把「已发」整个对齐到现在，宿主那边的这几项不会被发回去
  flushSave();
  const keys = cards.flatMap((sc) => sc.items.map((id) => (id === sc.card.id ? `c${id}` : `n${id}`)));
  batch(() => {
    if (views) setState("views", (v) => ({ ...v, ...views }));
    // core applySharedUpdate：按下标换，别的卡不通知；每次都放一份新的（撤销时 reconcile 会就地改白板里的对象，重放时不能拿到被改过的那份）
    sync((b) => { for (const sc of cards) applySharedUpdate(b, sc); }, keys);
  });
  alignSent();
}
/** 别的白板 Delete Everywhere 删掉了这些共享卡：跟着删（不进撤销栈、撤销后重放），不再发回宿主（宿主那边已经删了） */
export function syncGone(ids: string[]) {
  flushSave();
  sync((b) => removeCards(b, ids.filter((id) => b.cards.some((c) => c.id === id))));
  alignSent();
}
/** 另一个窗口改了这块白板的文件，宿主写盘时合并了进来：按项换上（不进撤销栈、撤销后重放），不再发回宿主 */
export function syncMerged(p: BoardPatch, views?: Record<string, SegView>) {
  flushSave();
  batch(() => {
    if (views) setState("views", (v) => ({ ...v, ...views }));
    sync((b) => applyPatch(b, structuredClone(p)));
  });
  alignSent();
}
/** 「已发」对齐到现在：宿主那边已经是这个样子了 */
function alignSent() { if (sent) { const s = snap(); cur = s; sent = { snap: s, cam: camKey(state.board.cam) }; } }
function trimSync() {
  let min = syncN;
  for (const s of undoStack) min = Math.min(min, s.epoch);
  for (const s of redoStack) min = Math.min(min, s.epoch);
  for (const f of fresh.values()) min = Math.min(min, f.before.epoch);
  for (const s of held) min = Math.min(min, s.epoch);
  let i = 0;
  while (i < syncLog.length && (syncLog[i].n <= min || syncLog.length - i > SYNC_MAX)) i++;
  if (i) syncLog.splice(0, i);
}
function replaySync(s: Snap): { any: boolean; shared: Set<string> } {
  const xs = syncLog.filter((x) => x.n > s.epoch);
  const shared = new Set(xs.flatMap((x) => x.shared ?? []));
  if (!xs.length) return { any: false, shared };
  setState("board", produce((b: Board) => { for (const x of xs) x.fn(b); upkeep(b); }));
  return { any: true, shared };
}

/** a → b 改了哪些卡和 Sidenote（"c" / "n" + id）。id 没变时逐个比（几乎总是这样），否则按 id 对 */
function touched(a: Snap, b: Snap): string[] {
  const out: string[] = [];
  for (const [k, p] of [["cards", "c"], ["sidenotes", "n"]] as const) {
    const ia = a.ids[k], ib = b.ids[k];
    if (ia === ib) { for (let i = 0; i < ib.length; i++) if (a[k][i] !== b[k][i]) out.push(p + ib[i]); continue; }
    const old = new Map(ia.map((id, i) => [id, a[k][i]]));
    ib.forEach((id, i) => { if (old.get(id) !== b[k][i]) out.push(p + id); old.delete(id); });
    for (const id of old.keys()) out.push(p + id);
  }
  return out;
}

// 撤销 / 重做：只把和现在不一样的那几段换回去。整块 reconcile 要把 241 张卡、196 条线挨个解析、比对一遍（每次 ~25ms）
function restore(s: Snap, now?: Snap) {
  cur = null;
  if (!now || !patch(now, s)) {
    const b = parse(s);
    b.cam = { ...state.board.cam };
    setState("board", reconcile(b));
  }
  reseeTwins();
  // 快照之后宿主同步来的改动再做一遍（不然 ⌘Z 会把行号退回去）；重放过的白板和快照不一样了，快照缓存作废
  const r = replaySync(s);
  cur = r.any ? null : { ...s, epoch: syncN, step: undefined, fx: undefined };
  changed();
  // 撤销的这一步改过的共享项，之后被别的白板改了：重放了别人的版本，等于没撤
  if (s.step && r.shared.size && s.step.some((k) => r.shared.has(k))) toast(NOT_UNDONE);
  const ids = new Set(allIds());
  // 选中的东西都还在就不动 sel：换成新数组的话，每张卡的 isSel 都要重算一遍
  const keep = <T,>(xs: T[], ok: (x: T) => boolean) => (xs.every(ok) ? xs : xs.filter(ok));
  setSel("cards", (c) => keep(c, (x) => ids.has(x)));
  setSel("links", (l) => keep(l, (x) => state.board.links.some((k) => k.id === x)));
  setSel("sections", (l) => keep(l, (x) => state.board.sections.some((k) => k.id === x)));
}
/** now → s 只是某几项内容变了（顺序、数量、白板本身的字段都没变）时，只改那几项；改不了返回 false */
function patch(now: Snap, s: Snap): boolean {
  if (now.head !== s.head || KEYS.some((k) => now[k].length !== s[k].length)) return false;
  const ops: [typeof KEYS[number], number | string, unknown][] = [];
  for (const k of KEYS) {
    for (let i = 0; i < s[k].length; i++) {
      if (s[k][i] === now[k][i]) continue;
      const a = JSON.parse(now[k][i]), b = JSON.parse(s[k][i]);
      if (k === "place") { if (a[0] !== b[0]) return false; ops.push([k, b[0], b[1]]); }
      else { if (a.id !== b.id) return false; ops.push([k, i, b]); }
    }
  }
  batch(() => { for (const [k, at, v] of ops) setState("board", k as any, at as any, reconcile(v as any)); });
  return true;
}
export function undo() {
  const s = undoStack.pop();
  if (!s) return false;
  topMerge = undefined;
  const now = snap();
  redoStack.push({ ...now, fx: s.fx });
  undone = true;
  restore(s, now);
  s.fx?.undo();
  updUndo();
  return true;
}
export function redo() {
  const s = redoStack.pop();
  if (!s) return false;
  topMerge = undefined;
  const now = snap();
  undoStack.push({ ...now, fx: s.fx });
  undone = true;
  restore(s, now);
  s.fx?.redo();
  updUndo();
  return true;
}

// 每块白板各有一份撤销历史：进子白板再回来时宿主重新发来这块白板，内容和离开时一样就接着用。
// 每份都带着整块白板的快照：面包屑上的上级白板都留着（一层层回去要用），别的只留最近离开的 RECENT_HISTORIES 块
const histories = new Map<string, { undo: Snap[]; redo: Snap[]; sync: typeof syncLog; at: Snap }>();
const RECENT_HISTORIES = 4;
/** 换上宿主发来的白板：现在这块白板的撤销历史收起来；新白板收起过、内容也和那时一样就接着用，不然从头开始。crumbs = 新白板的上级白板 */
export function setBoard(b: Board, crumbs: readonly string[]) {
  if (state.loaded) {
    histories.delete(state.board.id); // 放到最后：最近离开的
    histories.set(state.board.id, { undo: undoStack.splice(0), redo: redoStack.splice(0), sync: syncLog.splice(0), at: snapNow() });
  }
  setState("board", reconcile(b));
  reseeTwins();
  cur = null; lastIds = null; topMerge = undefined; last.clear();
  const h = histories.get(b.id);
  histories.delete(b.id);
  if (h && same(h.at, snapNow())) { undoStack.push(...h.undo); redoStack.push(...h.redo); syncLog.push(...h.sync); }
  trimLru(histories, new Set(crumbs), RECENT_HISTORIES);
  updUndo();
}

function allIds(): string[] {
  return state.board.cards.map((c) => c.id);
}

// 白板只在这个文件里被改（mutate / live / 撤销重做），改完把增量（BoardPatch）发给宿主；宿主马上换上、稍后写盘。
// VS Code 关面板时丢掉还没处理的消息，所以一步改动在改它的这个任务结束时就发（微任务，同一任务里的合成一次）：
// 改动一出现在 DOM 上消息就已经发出去了；等下一帧再发的话，Esc 结束编辑后马上关标签页就会丢。
// 拖动中的 live、镜头停下的 liveCam 停一会儿才发（不在每一帧拍整块白板的快照）；LIVE_DELAY 内关掉标签页只丢镜头位置。
// 增量 = 现在的快照和上次发出去的那份按 id 比：变了的项、删掉的 id、变了的白板字段和镜头。
let queued = false;
function changed() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; flushSave(); });
}
let saveTimer: number | undefined;
function changedLive() {
  if (!state.loaded) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => flushSave(), LIVE_DELAY);
}
/** 上次发出去的快照和镜头；null = 不知道宿主那边是什么样子（上次没收下），下次整块发 */
let sent: { snap: Snap; cam: string } | null = null;
/** 上次发出去之后有没有撤销 / 重做（宿主据此跳过别的白板后来改过的共享项） */
let undone = false;
const NOT_UNDONE = "Changed on another board; not undone.";
const camKey = (c: Camera) => `${c.x},${c.y},${c.z}`;
let resend: number | undefined;
export function flushSave(retry = false) {
  clearTimeout(resend);
  clearTimeout(saveTimer);
  if (!state.loaded) return;
  const s = snap();
  cur = s; // 白板没变之前，下一次 mutate 的「改之前」就是它
  const cam = camKey(state.board.cam);
  const p = diff(sent, s, cam);
  if (!p) return;
  sent = { snap: s, cam };
  const undo = undone;
  undone = false;
  // 宿主没收下（白板被删了之类）：不知道它那边是什么样子了，下一次整块发
  ask("patch", undo ? { patch: p, undo: true } : { patch: p }).then((r) => { if (r?.skipped) toast(NOT_UNDONE); }, (e: Error) => {
    sent = null;
    if (retry) return;
    toast(`Couldn't save the board: ${e.message}`);
    resend = window.setTimeout(() => flushSave(true), RESEND_DELAY); // 宿主没收下之后多久整块再发一次（只发一次：再不收下就等下一次修改）
  });
}
/** 宿主刚发来的白板就是存着的那一份 */
export function markSaved() { const s = snap(); cur = s; sent = { snap: s, cam: camKey(state.board.cam) }; undone = false; }

/** 上次发出去的 a → 现在的 b：变了的项；什么都没变返回 null。a 为 null 时整块发 */
function diff(a: { snap: Snap; cam: string } | null, b: Snap, cam: string): BoardPatch | null {
  const p: BoardPatch = {};
  const put = p as Record<string, unknown>;
  let any = false;
  // place 按 [id, Place] 存在快照里，发出去是 id → Place
  const places = (xs: unknown[]) => Object.fromEntries(xs as [string, Place][]);
  if (!a) {
    p.full = true;
    for (const k of KEYS) { const set = b[k].map((x) => JSON.parse(x)); put[k] = k === "place" ? { set: places(set) } : { set }; }
    any = true;
  } else {
    for (const k of KEYS) {
      const d = diffList(a.snap.ids[k], a.snap[k], b.ids[k], b[k], k !== "place");
      if (!d) continue;
      any = true;
      put[k] = k === "place" ? { set: d.set && places(d.set), del: d.del } : d;
    }
  }
  if (!a || a.snap.head !== b.head) {
    const { version: _v, id: _id, ...head } = JSON.parse(b.head);
    p.head = head;
    any = true;
  }
  if (!a || a.cam !== cam) { p.cam = { ...state.board.cam }; any = true; }
  return any ? p : null;
}

function diffList(ia: string[], pa: string[], ib: string[], pb: string[], ordered: boolean): ListPatch<unknown> | null {
  const set: unknown[] = [];
  if (ia === ib) { // id 没变（拖动、改内容）：逐段比
    for (let i = 0; i < pb.length; i++) if (pa[i] !== pb[i]) set.push(JSON.parse(pb[i]));
    return set.length ? { set } : null;
  }
  const old = new Map(ia.map((id, i) => [id, pa[i]]));
  ib.forEach((id, i) => { if (old.get(id) !== pb[i]) set.push(JSON.parse(pb[i])); });
  const now = new Set(ib);
  const del = ia.filter((id) => !now.has(id));
  const out: ListPatch<unknown> = {};
  if (set.length) out.set = set;
  if (del.length) out.del = del;
  // 顺序：宿主按「旧的去掉删了的 + 新的接在后面」排；排出来不一样（叠放顺序变了）才发完整顺序
  if (ordered) {
    const kept = ia.filter((id) => now.has(id)), added = ib.filter((id) => !old.has(id));
    const exp = kept.concat(added);
    if (exp.some((id, i) => id !== ib[i])) out.order = ib;
  }
  return set.length || del.length || out.order ? out : null;
}

export type ToastT = { text: string; actions?: { label: string; run: () => void }[]; n: number };
export const [toastMsg, setToastMsg] = createSignal<ToastT | null>(null);
let toastTimer: number | undefined, toastN = 0;
export function toast(text: string, actions?: ToastT["actions"], ms = 2600) {
  setToastMsg({ text, actions, n: ++toastN });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setToastMsg(null), actions ? Math.max(ms, 5000) : ms);
}

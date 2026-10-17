// 白板 → 宿主的增量保存（第 6 版起）：每类东西只发变了的项和删掉的 id，白板本身的字段整个发。宿主按它改自己那份白板再写盘。
// 共享卡：白板文件里是引用，内容在卡库；inflate / deflate 在两种样子之间换，putShared 把卡库里的新内容放进一块白板。
// 纯函数，直接改传进来的对象。
import type { Board, BoardFile, Camera, Card, Link, Place, Section, SharedCard, Sidenote, Sticker } from "./model";

/** 一类有 id 的东西的改动。order = 改完之后的完整 id 顺序（只在顺序变了时发：叠放顺序、Bring to Front） */
export type ListPatch<T> = { set?: T[]; del?: string[]; order?: string[] };
/** 白板本身的字段（名字、隐藏开关、创建顺序、调用图标记……）：不含宿主管的 version / id，镜头另算 */
export type BoardHead = Omit<Board, "version" | "id" | "cam" | (typeof LISTS)[number] | "place">;
export type BoardPatch = {
  /** 整个换掉（没有的字段 = 删掉） */
  head?: BoardHead;
  cam?: Camera;
  cards?: ListPatch<Card>;
  place?: { set?: Record<string, Place>; del?: string[] };
  links?: ListPatch<Link>;
  sections?: ListPatch<Section>;
  sidenotes?: ListPatch<Sidenote>;
  stickers?: ListPatch<Sticker>;
  /** 整块白板：各类的 set 就是全部（上次保存失败后，白板不知道宿主那边存到了哪一步） */
  full?: true;
};

export const LISTS = ["cards", "links", "sections", "sidenotes", "stickers"] as const;
const OWN = new Set<string>(["version", "id", "cam", "place", ...LISTS]);

/** 改动应用到白板上 */
export function applyPatch(b: Board, p: BoardPatch): void {
  if (p.head) {
    for (const k of Object.keys(b)) if (!OWN.has(k)) delete (b as Record<string, unknown>)[k];
    for (const [k, v] of Object.entries(p.head)) if (!OWN.has(k)) (b as Record<string, unknown>)[k] = v;
  }
  if (p.cam) b.cam = p.cam;
  for (const k of LISTS) {
    const lp = p[k] as ListPatch<{ id: string }> | undefined;
    if (lp) (b as Record<string, unknown>)[k] = applyList(b[k], lp, !!p.full);
    else if (p.full) (b as Record<string, unknown>)[k] = [];
  }
  if (p.full) b.place = { ...(p.place?.set ?? {}) };
  else if (p.place) {
    for (const id of p.place.del ?? []) delete b.place[id];
    Object.assign(b.place, p.place.set);
  }
}

function applyList<T extends { id: string }>(xs: T[], p: ListPatch<T>, full: boolean): T[] {
  if (full) return [...(p.set ?? [])];
  const del = new Set(p.del);
  const set = new Map((p.set ?? []).map((x) => [x.id, x]));
  const out = xs.filter((x) => !del.has(x.id)).map((x) => { const n = set.get(x.id); if (n) set.delete(x.id); return n ?? x; });
  out.push(...set.values());
  const order = p.order;
  if (!order) return out;
  // 按发来的顺序排；发来的顺序里没有的（宿主这边才有的，比如别的白板刚改的共享卡的 Sidenote）接在后面，不丢
  const at = new Map(order.map((id, i) => [id, i]));
  return out.map((x, i) => ({ x, k: at.get(x.id) ?? order.length + i })).sort((a, b) => a.k - b.k).map((o) => o.x);
}

/** 宿主转给白板的一张共享卡的改动：内容 + 变了的项（卡 id、Sidenote id；Sidenote 不在 sidenotes 里 = 删了） */
export type SharedUpdate = SharedCard & { items: string[] };

/** 跟着共享卡走的 Sidenote：挂在这张卡上、不是 boardOnly、不是 kind card（它指着的卡只在这块白板上） */
export const travels = (n: Sidenote, card: string) => n.at.card === card && !n.boardOnly && n.kind !== "card";

/** 白板上一张卡的共享内容（卡 + 跟着它走的 Sidenote）；卡不在白板上返回 undefined */
export function sharedOf(b: Pick<Board, "cards" | "sidenotes">, id: string): SharedCard | undefined {
  const card = b.cards.find((c) => c.id === id);
  return card && { card, sidenotes: b.sidenotes.filter((n) => travels(n, id)) };
}

/**
 * 卡库里的新内容放进白板：换掉卡（叠放位置不变），跟着它走的 Sidenote 按 id 换掉、没了的删掉、新的接在后面。
 * 白板上没有这张卡返回 false（什么都不改）。按绝对内容改，所以在更早的白板上再做一遍也对（撤销后的重放）
 */
export function putShared(b: Pick<Board, "cards" | "sidenotes">, sc: SharedCard): boolean {
  const id = sc.card.id;
  const i = b.cards.findIndex((c) => c.id === id);
  if (i < 0) return false;
  b.cards[i] = sc.card;
  const next = new Map(sc.sidenotes.map((n) => [n.id, n]));
  const out: Sidenote[] = [];
  for (const n of b.sidenotes) {
    const m = next.get(n.id);
    if (m) { out.push(m); next.delete(n.id); }
    else if (!travels(n, id)) out.push(n);
  }
  out.push(...next.values());
  b.sidenotes = out;
  return true;
}

/**
 * 白板文件 → 白板：共享卡的引用换成卡库里的内容（get 找不到的换成一张说明的 Note，免得连着它的 Link 和摆放悬空）。
 * refs = 换上了内容的共享卡，missing = 卡库里找不到的
 */
export function inflate(f: BoardFile, get: (id: string) => SharedCard | undefined): { board: Board; refs: string[]; missing: string[] } {
  const refs: string[] = [], missing: string[] = [];
  const cards: Card[] = [];
  const shared: SharedCard[] = [];
  for (const c of f.cards) {
    if (c.kind !== "shared") { cards.push(c); continue; }
    const sc = get(c.id);
    if (sc) { refs.push(c.id); cards.push(sc.card); shared.push(sc); }
    else { missing.push(c.id); cards.push({ id: c.id, kind: "note", md: "Shared card not found in the card library.", bg: true }); }
  }
  const board = { ...f, cards } as Board;
  board.sidenotes = [...f.sidenotes, ...shared.flatMap((s) => s.sidenotes)];
  return { board, refs, missing };
}

/** 白板 → 白板文件 + 共享卡的内容：refs 里的卡换成引用，跟着它们走的 Sidenote 去卡库 */
export function deflate(b: Board, refs: ReadonlySet<string>): { file: BoardFile; shared: SharedCard[] } {
  if (!refs.size) return { file: b, shared: [] };
  const shared: SharedCard[] = [];
  const cards = b.cards.map((c) => {
    if (!refs.has(c.id)) return c;
    shared.push({ card: c, sidenotes: b.sidenotes.filter((n) => travels(n, c.id)) });
    return { id: c.id, kind: "shared" as const };
  });
  const gone = new Set(shared.flatMap((s) => s.sidenotes.map((n) => n.id)));
  return { file: { ...b, cards, sidenotes: b.sidenotes.filter((n) => !gone.has(n.id)) }, shared };
}

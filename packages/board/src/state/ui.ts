// 界面状态（不持久化、不进撤销栈）
import { createSignal, createMemo, untrack } from "solid-js";
import { noteShown, type CodeCard, type Guide, type Link, type Sidenote } from "@codeboard/core";
import { state } from "./store";
import { rooted, boardRef, boardSignal, boardStore } from "./root";
import type { StaticTextRange } from "@yhnocoder/markdown";
import { FLASH_MS } from "./timing";
import { shape } from "./look";
import { animScale } from "./motion";

// 临时展开的手动隐藏范围（Show）："seg:from"
const [shown, setShown] = boardSignal<Set<string>>(new Set());
export { shown };
export function toggleShown(k: string) {
  const s = new Set(shown());
  s.has(k) ? s.delete(k) : s.add(k);
  setShown(s);
}

const fromIndex = rooted(() =>
  createMemo(() => {
    const m = new Map<string, Link[]>();
    for (const l of state.board.links) {
      const a = m.get(l.from.card) ?? [];
      a.push(l);
      m.set(l.from.card, a);
    }
    return m;
  }),
);
export const linksFrom = (id: string) => fromIndex().get(id) ?? [];

// Always Show 的 Sidenote 变化时要重新量行位置
export const notesOn = (id: string) => notesOf(id).filter((n) => n.kind === "text" && n.alwaysShow).length;

// 卡片 id → 挂在它上面的 Sidenote（每行都要问，按卡分好组）
const notesIndex = rooted(() =>
  createMemo(() => {
    const m = new Map<string, Sidenote[]>();
    for (const n of state.board.sidenotes) {
      const card = n.at.card;
      if (card === undefined) continue;
      // 「只在某个 Variant」：卡显示着那个 Variant 才算
      if (n.variant && !noteShown(n, state.board.cards.find((c) => c.id === card) as CodeCard | undefined)) continue;
      const a = m.get(card);
      a ? a.push(n) : m.set(card, [n]);
    }
    return m;
  }),
);
export const notesOf = (id: string): Sidenote[] => notesIndex().get(id) ?? [];
// The sidenotes not on a card: Section id → those on it, and the free ones on the canvas
const offCards = rooted(() =>
  createMemo(() => {
    const sections = new Map<string, Sidenote[]>(),
      free: Sidenote[] = [];
    for (const n of state.board.sidenotes) {
      const s = n.at.section;
      if (s !== undefined) {
        const a = sections.get(s);
        a ? a.push(n) : sections.set(s, [n]);
      } else if (n.at.card === undefined) free.push(n);
    }
    return { sections, free };
  }),
);
export const sectionNotes = (id: string): Sidenote[] => offCards().sections.get(id) ?? [];
export const freeNotes = (): Sidenote[] => offCards().free;

// 闪一下的行："card:seg:line"
const [flashRows, setFlashRows] = boardSignal<Set<string>>(new Set());
export { flashRows };
export function flash(card: string, seg: string, lines: number[]) {
  const keys = lines.map((l) => `${card}:${seg}:${l}`);
  setFlashRows(new Set([...flashRows(), ...keys]));
  setTimeout(
    () => {
      const s = new Set(flashRows());
      keys.forEach((k) => s.delete(k));
      setFlashRows(s);
    },
    (shape().flash ?? FLASH_MS) * animScale(),
  );
}
const [pingCard, setPingCard] = boardSignal<{ id: string; n: number } | null>(null);
export { pingCard };
let pingN = 0;
export const ping = (id: string) => setPingCard({ id, n: ++pingN });

/** 代码卡上新加的一条标注（还没写字）：贴在哪一行的哪几个字 */
export type AnnotDraft = { card: string; seg: string; line: number; from: number; to: number };
export type Editing =
  | {
      kind: "title" | "desc" | "note" | "label" | "section" | "free" | "board" | "sidenote" | "gen" | "vnote";
      id: string;
    }
  /** draft：新加的一条标注（id 是 "draft"），写了字才进白板；离开编辑它就没了 */
  | { kind: "annot"; id: string; draft?: AnnotDraft }
  | null;
export const [editing, setEditing] = boardSignal<Editing>(null);
/**
 * 显示时选中一段字再按 ⌫ / Delete：进入编辑，把同一段选上，再把这个键交给编辑器（和在编辑器里按一样）。
 * note：静态 Markdown 上数出来的一段（staticTextRange）；free：自由代码卡的第几行第几个字（行从 0 数）。
 * 单击选着的 Note 进来的（at，屏幕坐标）：光标放在点的地方。编辑器挂上时取走（takeEditEntry）
 */
/**
 * Where a click on a Note's static view lands, counted in its text (one character next to the point, see staticTextRange) or
 * "end" below its last block. The editor mounts before its layout settles (a leading heading slides in from the card's header),
 * so the screen point alone would resolve against a layout that is still moving
 */
export type NoteSpot = { char: StaticTextRange; after: boolean } | "end";
export type EditEntry = { id: string } & (
  | { kind: "note"; key: "Backspace" | "Delete"; range: StaticTextRange }
  | { kind: "note"; at: { x: number; y: number }; spot?: NoteSpot }
  | { kind: "free"; key: "Backspace" | "Delete"; from: [line: number, col: number]; to: [line: number, col: number] }
);
/** 代码卡显示的代码（.src）→ 选区两头在第几段第几行第几个字（行从 0 数，按原文算）；两头不在同一段的代码行里给 null。CodeBody 挂上 */
export const codeTextRange = new WeakMap<
  Element,
  (rg: Range) => { seg: string; from: [number, number]; to: [number, number] } | null
>();
// 正在编辑的 Note 的编辑器：退出编辑时才存回卡上，在那之前要按眼前的字算的（右键刚贴进来的图）从这里读
const liveNote = boardRef<{ id: string; value: () => string | null } | null>(null);
export const setLiveNote = (n: typeof liveNote.v) => {
  liveNote.v = n;
};
/** 编辑中的 Note 眼前的原文；没在编辑它时 undefined */
export const liveNoteMd = (id: string) => (liveNote.v?.id === id ? (liveNote.v.value() ?? undefined) : undefined);
const entry = boardRef<EditEntry | null>(null);
export const setEditEntry = (e: EditEntry | null) => {
  entry.v = e;
};
export function takeEditEntry<K extends EditEntry["kind"]>(
  kind: K,
  id: string,
): Extract<EditEntry, { kind: K }> | null {
  const e = entry.v;
  if (e?.kind !== kind || e.id !== id) return null;
  entry.v = null;
  return e as Extract<EditEntry, { kind: K }>;
}

// 拖动中：吸附参考线、合并目标、落点行、图片卡要放进的 Note（note）……
export const [guides, setGuides] = boardSignal<Guide[]>([]);
export const [sizeHint, setSizeHint] = boardSignal<{ x: number; y: number; text: string } | null>(null);
export const [dropTarget, setDropTarget] = boardSignal<{
  kind: "merge" | "line" | "block" | "card" | "cand" | "note";
  card: string;
  seg?: string;
  line?: number;
  armed?: boolean;
  cands?: string[];
  /** 拖箭头的终点：松手会连到这张卡（放大一点、显示成选中，.card.aim） */
  aim?: boolean;
  /** 放大的原点（卡内坐标，白板单位） */
  at?: { x: number; y: number };
} | null>(null);
export const [dragging, setDragging] = boardSignal<Set<string>>(new Set());
/** Cards just put down after a drag: their lift shadow (and scale) settles back (`.card.landing`), until its transitions end
 *  (interact.ts settling) */
export const [landing, setLanding] = boardSignal<Set<string>>(new Set());
/** Cards and Sections that a Section drag moves (interact.ts dragGroup): each a compositor layer of its own while it moves
 *  (styles.css .carry), with nothing of a lifted card's look */
export const [carried, setCarried] = boardSignal<{ cards: ReadonlySet<string>; sections: ReadonlySet<string> }>({
  cards: new Set(),
  sections: new Set(),
});
export const [marquee, setMarquee] = boardSignal<{ x: number; y: number; w: number; h: number } | null>(null);
export const [rubber, setRubber] = boardSignal<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  plain?: boolean;
} | null>(null);
// 正在拖的线（拖起点圆点、拖标签框）
export const [dragLink, setDragLink] = boardSignal<string | null>(null);
export const [hoverVar, setHoverVar] = boardSignal<{ link: string; names: string[]; from: string; to: string } | null>(
  null,
);
// 新卡弹出动画：id → 起点偏移
// 存成 store：卡和线只订阅自己那一项，动画每帧只重算正在弹出的卡，而不是整块白板
export type PopAnim = { ox: number; oy: number; v: number; slide?: boolean };
const [popStore, setPopStore] = boardStore<Record<string, PopAnim | undefined>>(() => ({}));
export const popIn = () => popStore;
/** 一张卡这一帧的动画（undefined = 动完了）。起点没变时只写进度：每帧不用把整个表比一遍，也不换掉那一项 */
export function setPopIn(id: string, a: PopAnim | undefined) {
  const cur = untrack(() => popStore[id]);
  if (a && cur && cur.ox === a.ox && cur.oy === a.oy && !!cur.slide === !!a.slide) setPopStore(id, "v", a.v);
  else setPopStore(id, a);
}
// 箭头从起点画出来的动画（Warm Ink 顺着箭头出来的新卡，actions/common.ts popAlong）：线 id → 画到了哪（0..1，undefined = 整条）。
// 同样存成 store：每帧只重算这一条线
const [drawStore, setDrawStore] = boardStore<Record<string, number | undefined>>(() => ({}));
export const drawIn = (id: string) => drawStore[id];
export const setDrawIn = (id: string, t: number | undefined) => setDrawStore(id, t);
// 展开、折叠 Section 时成员卡分几帧建、拆（actions/edit.ts 的 toggleSection）：一次建好、拆掉十几张代码卡要 50–100ms，那一帧卡住。
// "in" = 藏着（在折叠的 Section 里）也先建着（透明：弹出动画停在开头 / 收完的那一帧）；"out" = 不藏也先不建（离屏幕很远、反正看不见的卡，动画完了再建）
export type Staged = "in" | "out";
const [stagedStore, setStagedStore] = boardStore<Record<string, Staged | undefined>>(() => ({}));
export const staged = (id: string) => stagedStore[id];
export const setStaged = (id: string, s: Staged | undefined) => setStagedStore(id, s);
// 卡的大小变过去的动画（Fit Content）：id → 这一帧画出来的宽、高（高是存着高度的那一块：代码卡的内容区，别的卡整张）。
// 白板里已经是新的大小；同样存成 store，每帧只重算在变的卡
export type SizeAnim = { w: number; h: number };
const [sizeStore, setSizeStore] = boardStore<Record<string, SizeAnim | undefined>>(() => ({}));
export const sizeIn = () => sizeStore;
export const setSizeIn = (id: string, s: SizeAnim | undefined) => setSizeStore(id, s);
export type Walk = {
  root: string;
  order: string[];
  i: number;
  before: { x: number; y: number; z: number };
  expanded: string[];
};
export const [walk, setWalk] = boardSignal<Walk | null>(null);
/** here: only this board's cards and sidenotes (⌘F; ⌘K searches every board) */
export const [paletteOpen, setPaletteOpen] = createSignal<
  false | { mode: "all" | "code" | "entry"; q?: string; here?: boolean }
>(false);
export const [keysOpen, setKeysOpen] = createSignal(false);
// Settings 页（整窗）；section = 打开时滚到哪一节
export const [settingsOpen, setSettingsOpen] = createSignal<false | { section?: string }>(false);
export const [banner, setBanner] = boardSignal(true);

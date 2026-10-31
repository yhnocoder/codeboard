// 界面状态（不持久化、不进撤销栈）
import { createSignal, createMemo, untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { noteShown, type CodeCard, type Guide, type Link, type Sidenote } from "@codeboard/core";
import { state } from "./store";
import { rooted, boardSignal } from "./root";
import type { StaticTextRange } from "@yhnocoder/markdown";

// 临时展开的手动隐藏范围（Show）："seg:from"
export const [shown, setShown] = boardSignal<Set<string>>(new Set());
export function toggleShown(k: string) {
  const s = new Set(shown());
  s.has(k) ? s.delete(k) : s.add(k);
  setShown(s);
}

const fromIndex = rooted(() => createMemo(() => {
  const m = new Map<string, Link[]>();
  for (const l of state.board.links) {
    const a = m.get(l.from.card) ?? [];
    a.push(l);
    m.set(l.from.card, a);
  }
  return m;
}));
export const linksFrom = (id: string) => fromIndex().get(id) ?? [];

// Always Show 的 Sidenote 变化时要重新量行位置
export const notesOn = (id: string) => notesOf(id).filter((n) => n.kind === "text" && n.alwaysShow).length;

// 卡片 id → 挂在它上面的 Sidenote（每行都要问，按卡分好组）
const notesIndex = rooted(() => createMemo(() => {
  const m = new Map<string, Sidenote[]>();
  for (const n of state.board.sidenotes) {
    // 「只在某个 Variant」：卡显示着那个 Variant 才算
    if (n.variant && !noteShown(n, state.board.cards.find((c) => c.id === n.at.card) as CodeCard | undefined)) continue;
    const a = m.get(n.at.card); a ? a.push(n) : m.set(n.at.card, [n]);
  }
  return m;
}));
export const notesOf = (id: string): Sidenote[] => notesIndex().get(id) ?? [];

// 闪一下的行："card:seg:line"
export const [flashRows, setFlashRows] = boardSignal<Set<string>>(new Set());
export function flash(card: string, seg: string, lines: number[]) {
  const keys = lines.map((l) => `${card}:${seg}:${l}`);
  setFlashRows(new Set([...flashRows(), ...keys]));
  setTimeout(() => { const s = new Set(flashRows()); keys.forEach((k) => s.delete(k)); setFlashRows(s); }, 700);
}
export const [pingCard, setPingCard] = boardSignal<{ id: string; n: number } | null>(null);
let pingN = 0;
export const ping = (id: string) => setPingCard({ id, n: ++pingN });

/** 代码卡上新加的一条标注（还没写字）：贴在哪一行的哪几个字 */
export type AnnotDraft = { card: string; seg: string; line: number; from: number; to: number };
export type Editing =
  | { kind: "title" | "desc" | "note" | "label" | "section" | "free" | "board" | "sidenote" | "gen" | "question" | "vnote"; id: string }
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
export const codeTextRange = new WeakMap<Element, (rg: Range) => { seg: string; from: [number, number]; to: [number, number] } | null>();
// 正在编辑的 Note 的编辑器：退出编辑时才存回卡上，在那之前要按眼前的字算的（右键刚贴进来的图）从这里读
let liveNote: { id: string; value: () => string | null } | null = null;
export const setLiveNote = (n: typeof liveNote) => { liveNote = n; };
/** 编辑中的 Note 眼前的原文；没在编辑它时 undefined */
export const liveNoteMd = (id: string) => (liveNote?.id === id ? liveNote.value() ?? undefined : undefined);
let entry: EditEntry | null = null;
export const setEditEntry = (e: EditEntry | null) => { entry = e; };
export function takeEditEntry<K extends EditEntry["kind"]>(kind: K, id: string): Extract<EditEntry, { kind: K }> | null {
  const e = entry;
  if (e?.kind !== kind || e.id !== id) return null;
  entry = null;
  return e as Extract<EditEntry, { kind: K }>;
}

// 拖动中：吸附参考线、合并目标、落点行、图片卡要放进的 Note（note）……
export const [guides, setGuides] = boardSignal<Guide[]>([]);
export const [sizeHint, setSizeHint] = boardSignal<{ x: number; y: number; text: string } | null>(null);
export const [dropTarget, setDropTarget] = boardSignal<{ kind: "merge" | "line" | "block" | "card" | "cand" | "note"; card: string; seg?: string; line?: number; armed?: boolean; cands?: string[] } | null>(null);
export const [dragging, setDragging] = boardSignal<Set<string>>(new Set());
export const [marquee, setMarquee] = boardSignal<{ x: number; y: number; w: number; h: number } | null>(null);
export const [rubber, setRubber] = boardSignal<{ x1: number; y1: number; x2: number; y2: number; plain?: boolean } | null>(null);
// 正在拖的线（拖起点圆点、拖标签框）
export const [dragLink, setDragLink] = boardSignal<string | null>(null);
export const [hoverVar, setHoverVar] = boardSignal<{ link: string; names: string[]; from: string; to: string } | null>(null);
// 新卡弹出动画：id → 起点偏移
// 存成 store：卡和线只订阅自己那一项，动画每帧只重算正在弹出的卡，而不是整块白板
export type PopAnim = { ox: number; oy: number; v: number; slide?: boolean };
const [popStore, setPopStore] = createStore<Record<string, PopAnim | undefined>>({});
export const popIn = () => popStore;
/** 一张卡这一帧的动画（undefined = 动完了）。起点没变时只写进度：每帧不用把整个表比一遍，也不换掉那一项 */
export function setPopIn(id: string, a: PopAnim | undefined) {
  const cur = untrack(() => popStore[id]);
  if (a && cur && cur.ox === a.ox && cur.oy === a.oy && !!cur.slide === !!a.slide) setPopStore(id, "v", a.v);
  else setPopStore(id, a);
}
// 展开、折叠 Section 时成员卡分几帧建、拆（actions/edit.ts 的 toggleSection）：一次建好、拆掉十几张代码卡要 50–100ms，那一帧卡住。
// "in" = 藏着（在折叠的 Section 里）也先建着（透明：弹出动画停在开头 / 收完的那一帧）；"out" = 不藏也先不建（离屏幕很远、反正看不见的卡，动画完了再建）
export type Staged = "in" | "out";
const [stagedStore, setStagedStore] = createStore<Record<string, Staged | undefined>>({});
export const staged = (id: string) => stagedStore[id];
export const setStaged = (id: string, s: Staged | undefined) => setStagedStore(id, s);
// 卡的大小变过去的动画（Fit Content）：id → 这一帧画出来的宽、高（高是存着高度的那一块：代码卡的内容区，别的卡整张）。
// 白板里已经是新的大小；同样存成 store，每帧只重算在变的卡
export type SizeAnim = { w: number; h: number };
const [sizeStore, setSizeStore] = createStore<Record<string, SizeAnim | undefined>>({});
export const sizeIn = () => sizeStore;
export const setSizeIn = (id: string, s: SizeAnim | undefined) => setSizeStore(id, s);
export type Walk = { root: string; order: string[]; i: number; before: { x: number; y: number; z: number }; expanded: string[] };
export const [walk, setWalk] = boardSignal<Walk | null>(null);
export const [paletteOpen, setPaletteOpen] = createSignal<false | { mode: "all" | "code" | "entry"; q?: string }>(false);
export const [keysOpen, setKeysOpen] = createSignal(false);
// Settings 页（整窗）；section = 打开时滚到哪一节
export const [settingsOpen, setSettingsOpen] = createSignal<false | { section?: string }>(false);
export const [banner, setBanner] = boardSignal(true);

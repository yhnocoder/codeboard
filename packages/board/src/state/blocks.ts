// 箭头连着 Note 的某一块（core 的 End.block）：块在卡里的位置（实测，线的端点用）、悬停一块时卡左右边上的两个圆点、
// 拖箭头时指着哪一块（块之间的空隙、上下内边距算最近的那块，只有卡头算整张卡），以及落点和起点那两块的淡色底。
// 块和 Markdown 对不上（有脚注、HTML 注释、还没渲染完）时这张 Note 只能整张连
import { createEffect, createMemo, onCleanup } from "solid-js";
import { blockSig, blockAt, blockMap, type BlockRef } from "@codeboard/core";
import { noteBlocks } from "../md/blocks";
import { state, cardById, onBoard } from "./store";
import { editing, liveNoteMd, dragging } from "./ui";
import { look } from "./look";
import { queueMeasure, observeResize } from "./measure";
import { boardSignal, boardStore, boardTimer, rooted } from "./root";
import { BLOCK_LEAVE } from "./timing";
import { cardSel } from "../cardsel";

/** 一张 Note 里每块的位置（相对卡片顶部、未减滚动，和代码卡的 CardGeo 一样）；sigs = 量的那份 Markdown 每块的指纹（编辑中是编辑器里的字）；
 *  saved / moved: while the editor holds unsaved text, the saved text's fingerprints and where each saved block is now (blockMap) */
type BlockGeo = {
  ys: number[];
  hs: number[];
  ls: number[];
  top: number;
  bottom: number;
  scroll: number;
  sigs: string[];
  saved?: string[];
  moved?: number[];
};
const [bgeo, setBgeo] = boardStore<Record<string, BlockGeo | undefined>>(() => ({}), onBoard);

/** el 在 root 里的 y（按排版，不受缩放、斜贴影响）；root 要在 el 的 offsetParent 链上（.nbody 是 position: relative） */
function offIn(el: HTMLElement, root: HTMLElement): number {
  let y = 0,
    e: HTMLElement | null = el;
  for (; e && e !== root; e = e.offsetParent as HTMLElement | null) y += e.offsetTop;
  return y;
}

type NoteDom = {
  card: HTMLElement;
  body: HTMLElement;
  kids: HTMLElement[];
  blocks: string[];
  editor: boolean;
  saved: string;
};
/** Note 的正文和里面一块一块的顶层元素；编辑器开着时是编辑器里的、按编辑器里眼前的字拆。对不上时 null */
function noteDom(id: string): NoteDom | null {
  const c = cardById(id)?.card;
  if (c?.kind !== "note" || c.look !== "note") return null;
  const card = document.querySelector<HTMLElement>(`${cardSel(id)}`);
  const body = card?.querySelector<HTMLElement>(":scope > .cface > .nbody");
  if (!card || !body) return null;
  const editor = body.classList.contains("editing");
  const pm = editor ? body.querySelector<HTMLElement>(".md-pm") : null;
  // 编辑器里还没改过字时 liveNoteMd 是 undefined：就是卡上的字
  const md = (editor && liveNoteMd(id)) || c.md;
  if (editor && !pm) return null;
  // 编辑器末尾那个只为放光标的空段（.md-pad）不是 Markdown 里的块
  let kids = ([...(pm ?? body).children] as HTMLElement[]).filter((k) => !k.classList.contains("md-pad"));
  const blocks = noteBlocks(md);
  // an empty paragraph in the editor (Enter just pressed) is no block of the Markdown
  if (pm && blocks && blocks.length !== kids.length)
    kids = kids.filter((k) => k.tagName !== "P" || k.textContent || k.querySelector("img"));
  return blocks && blocks.length && blocks.length === kids.length
    ? { card, body, kids, blocks, editor, saved: c.md }
    : null;
}
/** 第 k 块的中线，相对卡片顶部（未减滚动） */
const midOf = (d: NoteDom, k: number) =>
  offIn(d.body, d.card) + d.body.clientTop + offIn(d.kids[k], d.body) + d.kids[k].offsetHeight / 2;

/** How tall a block's first line is: its line height, less what its own top padding adds (a code block's) */
function firstLine(el: HTMLElement): number {
  const cs = getComputedStyle(el),
    lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
  return Math.min(el.offsetHeight, lh + parseFloat(cs.paddingTop || "0"));
}

/** The fingerprints of what is on the page, and while the editor holds unsaved text the saved text's and where each saved block is now */
function blockSigs(d: NoteDom): Pick<BlockGeo, "sigs" | "saved" | "moved"> {
  const sigs = d.blocks.map(blockSig);
  const was = d.editor ? noteBlocks(d.saved) : null;
  if (!was || (was.length === d.blocks.length && was.every((b, k) => b === d.blocks[k]))) return { sigs };
  return { sigs, saved: was.map(blockSig), moved: blockMap(was, d.blocks) };
}

function readBlocks(id: string): () => void {
  const d = noteDom(id);
  if (!d) return () => setBgeo(id, undefined);
  const top = offIn(d.body, d.card) + d.body.clientTop;
  const g: BlockGeo = {
    ys: d.kids.map((k) => top + offIn(k, d.body)),
    hs: d.kids.map((k) => k.offsetHeight),
    ls: d.kids.map(firstLine),
    top,
    bottom: top + d.body.clientHeight,
    scroll: d.body.scrollTop,
    ...blockSigs(d),
  };
  return () => setBgeo(id, g);
}

/** 线的端点：这一端那一块的中线在卡里的 y（相对卡片顶部，减了滚动、夹在正文可见范围里）；量不到、块没了时 null（画在卡头） */
export function blockY(id: string, ref: BlockRef): number | null {
  const g = bgeo[id];
  if (!g) return null;
  const k = blockAt(ref, g.sigs);
  if (k < 0 || !g.hs[k]) return null;
  return Math.min(Math.max(g.ys[k] + g.hs[k] / 2 - g.scroll, g.top), g.bottom);
}

/** A sidenote's block in what is measured: by its fingerprint; while the Note is being edited, where its saved block is now (as
 *  the Note's upkeep will move it when the edit is saved, core rebaseBlocks), else at its index */
const noteBlockAt = (ref: BlockRef, g: Pick<BlockGeo, "sigs" | "saved" | "moved">) => {
  const k = blockAt(ref, g.sigs);
  if (k >= 0) return k;
  const was = g.saved && g.moved ? blockAt(ref, g.saved) : -1;
  if (was >= 0) return g.moved![was];
  return ref.i < g.sigs.length ? ref.i : -1;
};

/** A sidenote's block in the card: its top and height (from the card's top, less the scroll, the top kept inside the body's
 *  visible part), and the height of its first line; null when it is not measured or not there */
export function blockBand(id: string, ref: BlockRef): { top: number; h: number; line: number } | null {
  const g = bgeo[id];
  if (!g) return null;
  const k = noteBlockAt(ref, g);
  if (k < 0 || !g.hs[k]) return null;
  return { top: Math.min(Math.max(g.ys[k] - g.scroll, g.top), g.bottom), h: g.hs[k], line: g.ls[k] };
}

/** 有箭头连着某一块的卡 */
const anchored = rooted(() =>
  createMemo(
    () => {
      const s = new Set<string>();
      for (const l of state.board.links) {
        if (l.from.block) s.add(l.from.card);
        if (l.to.block) s.add(l.to.card);
      }
      for (const n of state.board.sidenotes) if (n.at.block) s.add(n.at.card);
      return s;
    },
    new Set<string>(),
    { equals: (a, b) => a.size === b.size && [...a].every((x) => b.has(x)) },
  ),
);

/**
 * NoteBody 里调用：有箭头连着这张 Note 的某一块时，量每一块的位置并跟着变（字、宽度、主题、编辑器进出、图片加载完、滚动）。
 * 正文元素进出编辑时会换掉，块的元素改字时会换掉：卡面和正文上各挂一个只看子节点的 MutationObserver，换了就重新挂
 */
export function trackBlocks(id: () => string, md: () => string) {
  createEffect(() => {
    const cid = id();
    if (!anchored().has(cid)) return;
    let unobs: (() => void)[] = [];
    let body: HTMLElement | null = null;
    const later = () => queueMeasure(`blocks:${cid}`, () => readBlocks(cid));
    const mo = new MutationObserver(() => watch());
    // text typed into a block that keeps its size (an empty paragraph written into) changes what the blocks are: measure again
    const typed = new MutationObserver(later);
    // 滚动只改 scroll（块的位置不随滚动变），和代码卡一样
    const onScroll = (e: Event) => {
      if (body && e.target === body && bgeo[cid]) setBgeo(cid, "scroll", body.scrollTop);
    };
    function watch() {
      for (const f of unobs) f();
      unobs = [];
      mo.disconnect();
      typed.disconnect();
      const face = document.querySelector<HTMLElement>(`${cardSel(cid)} > .cface`);
      body = face?.querySelector<HTMLElement>(":scope > .nbody") ?? null;
      if (!face || !body) return later();
      const pm = body.querySelector<HTMLElement>(".md-pm");
      mo.observe(face, { childList: true });
      // 编辑器还没挂上（先显示着静态内容）：等它出来；挂上以后只看它的顶层块
      mo.observe(body, { childList: true, subtree: !pm && body.classList.contains("editing") });
      if (pm) mo.observe(pm, { childList: true });
      if (pm) typed.observe(pm, { subtree: true, childList: true, characterData: true });
      for (const el of [body, ...(pm ?? body).children]) unobs.push(observeResize(el, later));
      later();
    }
    createEffect(() => {
      md();
      editing();
      look();
      queueMicrotask(watch);
    });
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    onCleanup(() => {
      for (const f of unobs) f();
      mo.disconnect();
      typed.disconnect();
      document.removeEventListener("scroll", onScroll, { capture: true });
      setBgeo(cid, undefined);
    });
  });
}

// ---------- 悬停：卡左右边上的两个圆点 ----------

/** 悬停着的那一块：y = 中线相对卡片顶部（减了滚动），圆点画在卡的左右边上这个高度（canvas/Links.tsx 的 BlockPorts） */
export type BlockHover = { card: string; ref: BlockRef; y: number };
const [hoverBlock, setHoverBlock] = boardSignal<BlockHover | null>(null);
export { hoverBlock };
const leaveT = boardTimer();
/** 离开一会儿才收起圆点：鼠标从块移到卡边上的圆点的路上不丢。已经在等的不重新计时（指针在别处一直动也会收起） */
export const keepBlock = () => leaveT.stop();
export const leaveBlock = () => {
  if (leaveT.pending || !hoverBlock()) return;
  leaveT.start(() => setHoverBlock(null), BLOCK_LEAVE);
};
const sameHover = (a: BlockHover | null, b: BlockHover) =>
  !!a && a.card === b.card && a.ref.i === b.ref.i && a.ref.h === b.ref.h && Math.abs(a.y - b.y) < 0.5;

/** 指针在 Note（显示着、不在编辑）的正文上：最近的那一块亮出两个圆点。Canvas 里装一次 */
export function watchBlockHover() {
  const move = (e: PointerEvent) => {
    const t = e.target as Element | null;
    if (t?.closest?.(".bport")) return keepBlock();
    const body = t?.closest?.(".card.note > .cface > .nbody.md:not(.editing)") as HTMLElement | null;
    const card = body?.closest<HTMLElement>(".card");
    const id = card?.dataset.id;
    if (!body || !id || e.buttons || dragging().size || card!.classList.contains("dim")) return leaveBlock();
    const d = noteDom(id);
    const k = d ? nearest(d.kids, e.clientY) : -1;
    if (!d || k < 0) return leaveBlock();
    keepBlock();
    const h: BlockHover = { card: id, ref: { i: k, h: blockSig(d.blocks[k]) }, y: midOf(d, k) - d.body.scrollTop };
    if (!sameHover(hoverBlock(), h)) setHoverBlock(h);
  };
  window.addEventListener("pointermove", move, { capture: true, passive: true });
  onCleanup(() => window.removeEventListener("pointermove", move, { capture: true }));
  // 进了编辑：圆点收起
  createEffect(() => {
    const h = hoverBlock();
    if (h && editing()?.id === h.card) setHoverBlock(null);
  });
}

/** 离 y（屏幕坐标）最近的一块：在块上就是它，在块之间的空隙、正文上下的内边距里就是最近的那块；看不见的块（藏起来的开头标题）不算 */
function nearest(kids: HTMLElement[], y: number): number {
  let best = -1,
    dist = Infinity;
  kids.forEach((el, k) => {
    const r = el.getBoundingClientRect();
    if (!r.height) return;
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < dist) {
      best = k;
      dist = d;
    }
  });
  return best;
}

// ---------- 拖箭头：指着哪一块，淡色底 ----------

export type BlockAim = { card: string; k: number; ref: BlockRef; el: HTMLElement; editor: boolean };
/** 拖箭头时指针在 Note 的卡身上（卡头以外）：指着最近的那一块。Note 正开着编辑器也行，按编辑器里的块和字算 */
export function aimBlock(id: string, y: number): BlockAim | null {
  const d = noteDom(id);
  const k = d ? nearest(d.kids, y) : -1;
  return d && k >= 0 ? { card: id, k, ref: { i: k, h: blockSig(d.blocks[k]) }, el: d.kids[k], editor: d.editor } : null;
}
/** 箭头起点那一块（从块边上的圆点拖出来的）：起点的淡色底画在它上面 */
export function blockOf(id: string, ref: BlockRef): BlockAim | null {
  const d = noteDom(id);
  const k = d ? blockAt(ref, d.blocks.map(blockSig)) : -1;
  return d && k >= 0 ? { card: id, k, ref, el: d.kids[k], editor: d.editor } : null;
}
/** Where a block is in its card, read from the page (layout pixels from the card's top, less the scroll): for a block not measured
 *  by trackBlocks (no sidenote or arrow on it yet) */
export function blockBandNow(a: BlockAim): { top: number; h: number; line: number } {
  const card = a.el.closest<HTMLElement>(".card")!,
    body = a.el.closest<HTMLElement>(".nbody");
  return { top: offIn(a.el, card) - (body?.scrollTop ?? 0), h: a.el.offsetHeight, line: firstLine(a.el) };
}
/** A sidenote's block on the page (found as noteBlockAt finds it) */
export function noteBlockOf(id: string, ref: BlockRef): BlockAim | null {
  const d = noteDom(id);
  const k = d ? noteBlockAt(ref, blockSigs(d)) : -1;
  return d && k >= 0 ? { card: id, k, ref, el: d.kids[k], editor: d.editor } : null;
}

// 淡色底画在块自己身上（背景 + 一圈同色的 box-shadow，比内容四周大 6px，不占位置）。编辑器里的块归 ProseMirror 管，不能改它的 class：
// 用一份样式表按「第几个子元素」挑出那一块，静态显示和编辑器一样。只在落点换了的时候改一次
let sheet: HTMLStyleElement | null = null;
const domIndex = (el: HTMLElement) => [...el.parentElement!.children].indexOf(el);
const tintKey = (a: BlockAim) => `${a.card}:${domIndex(a.el)}:${a.editor ? 1 : 0}`;
let tinted = "";
/** 落点和起点那两块上淡色底（没有落点时一块都不上）；空 = 都去掉 */
export function tintBlocks(list: (BlockAim | null)[]) {
  const xs = list.filter((a): a is BlockAim => !!a);
  const key = xs.map(tintKey).join(" ");
  if (key === tinted) return;
  tinted = key;
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.dataset.export = "strip";
    document.head.appendChild(sheet);
  }
  sheet.textContent = xs
    .map((a) => {
      const at = `${cardSel(a.card)} > .cface > .nbody${a.editor ? ".editing .md-pm" : ".md:not(.editing)"} > :nth-child(${domIndex(a.el) + 1})`;
      return `${at} { background-image: linear-gradient(var(--btint), var(--btint)); box-shadow: 0 0 0 6px var(--btint); }\n${at}:not(pre) { border-radius: 6px; }`;
    })
    .join("\n");
}

/** 拖着的箭头终点要滑到的地方（屏幕坐标）：落点那张卡朝着起点的那条边上、那一块的中线 */
export function aimPoint(a: BlockAim, fromX: number): { x: number; y: number } {
  const c = a.el.closest(".card")!.getBoundingClientRect(),
    r = a.el.getBoundingClientRect();
  return { x: c.left + c.width / 2 >= fromX ? c.left : c.right, y: r.top + r.height / 2 };
}

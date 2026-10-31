import {
  findCard, frameless, isCode, snapMove, snapResize, bounds, center,
  type Board, type Card, type CallSpan, type Rect, type Anchor, type End, type LinkSide,
} from "@codeboard/core";
import {
  state, sel, select, toggleSel, clearSel, setLineSel, isSel, cardById, hostOf, rectOf, live, toast, placeOf, placed,
} from "./state/store";
import { tune } from "./state/tune";
import { WHEEL_GESTURE, BLOCK_GLIDE } from "./state/timing";
import { cam, setCam, stopCam, camTo, fling, toWorld, view, ZMIN, ZMAX, lod, reduceMotion } from "./state/camera";
import { setGuides, setSizeHint, setDropTarget, dropTarget, setDragging, setMarquee, setRubber, setEditing, editing, setEditEntry, liveNoteMd, type NoteSpot } from "./state/ui";
import { staticTextRange, draggedImage, IMAGE_DRAG_TYPE, type DraggedImage } from "@yhnocoder/markdown";
import { frames, deepestAt, hiddenByAncestor, homeFor, partlyIn, frameOf, sec, descSections, allMembers, visibleCards, setMovingHome } from "./state/sections";
import { geo } from "./state/geo";
import { aimBlock, aimPoint, blockOf, tintBlocks, type BlockAim } from "./state/blocks";
import { pops, closeAllPops, pinPop } from "./state/pop";
import { connectFrom, modeIs, idle, takePick, endDraw, cancelMode, placing, spaceDown, setSpaceDown, setPanning } from "./state/mode";
import { selSticker, setSelSticker } from "./state/stickers";
import { ghostOut } from "./state/ghost";
import { overNote, leaveNote, noteDropAt } from "./notedrop";
import { boardPoint, worldAt, lastPointer, trackPointer, naturalSize, chromeOf } from "./state/measure";
import { installOverlays, modalOpen, typing } from "./ui/overlay";
import { NODRAG, CARD_CONTROL, OWNS_POINTER, BOARD_CHROME } from "./ui/guard";
import { dispatch, matches } from "./keymap";
import { installShield, raiseShield } from "./ui/shield";
import * as A from "./actions";
import { CALL_DRAG_SLOP, DRAG_SLOP, track, undoGesture } from "./gesture";
import { togglePreview } from "./state/subboards";
import { cardSel } from "./cardsel";

const pt = (e: { clientX: number; clientY: number }) => ({ x: e.clientX, y: e.clientY });
const local = (e: { clientX: number; clientY: number }) => boardPoint(pt(e));
const worldOf = (e: { clientX: number; clientY: number }) => worldAt(pt(e));

/**
 * 拖卡、拖 Section 时吸不吸附：拖得快时不吸附（顺滑），慢下来才对齐。屏幕上的速度，指数平滑。
 * 停住不动时没有 move 事件：停一下就当速度为 0 再算一次（again(ev, true)，这时才吸附）
 */
function snapPace(e: PointerEvent, again: (ev: PointerEvent, still: boolean) => void) {
  let vx = e.clientX, vy = e.clientY, vt = performance.now(), speed = 0, settleT: number | undefined;
  return {
    fast(ev: PointerEvent, still: boolean) {
      clearTimeout(settleT);
      if (!still) settleT = window.setTimeout(() => again(ev, true), 110);
      const now = performance.now(), dt = Math.max(1, now - vt);
      speed = still ? 0 : speed * 0.6 + (Math.hypot(ev.clientX - vx, ev.clientY - vy) / dt) * 1000 * 0.4;
      vx = ev.clientX; vy = ev.clientY; vt = now;
      return speed > tune("snapSpeed");
    },
    stop: () => clearTimeout(settleT),
  };
}

// 双击检测（pointerdown 里 preventDefault 后浏览器的 dblclick 不可靠）：同一个东西上、够快、两下点在差不多同一个地方
const DBL_SLOP = 6;
const dbl: { key?: string; t: number; x: number; y: number } = { t: 0, x: 0, y: 0 };
export function isDbl(key: string, e: { clientX: number; clientY: number }) {
  const now = performance.now();
  const r = dbl.key === key && now - dbl.t < tune("dblClick") && Math.hypot(e.clientX - dbl.x, e.clientY - dbl.y) <= DBL_SLOP;
  dbl.key = r ? undefined : key; dbl.t = now; dbl.x = e.clientX; dbl.y = e.clientY;
  return r;
}

/**
 * 只选着这一张时单击正文就进编辑，光标放在点的地方：Note 的 .nbody、Text / Box / Mark 的 .tx、手写代码卡的 .src。
 * 卡比内容高时正文下面、旁边的空白（.cface 自己）也算 Note 的正文：光标放到最近的地方，下面就是最后。
 * 正文里自己管点击的东西（引用、任务勾选框、折叠块的标题）不算；链接、按钮在 CARD_CONTROL 里，按下就不归卡
 */
const OWN_CLICK = ".md-ref, label, summary";
function clickEditKind(c: Card, t: HTMLElement): "note" | "free" | null {
  if (lod() !== "full" || t.closest(OWN_CLICK)) return null;
  if (c.kind === "note") return t.closest(c.look === "note" ? ".nbody" : ".tx") || t.classList.contains("cface") ? "note" : null;
  return c.kind === "code" && c.segments[0]?.src.kind === "free" && t.closest(".src") ? "free" : null;
}
/** first：这是单击（可能是双击的第一下）；双击的第二下进来的不用再拦下一下 */
function clickEdit(kind: "note" | "free", id: string, at: { x: number; y: number }, first = false) {
  if (kind === "note") setEditEntry({ kind: "note", id, at, spot: staticSpot(id, at) }); // 手写代码卡的编辑器自己按最近一次按下的地方放光标（lastDown）
  setEditing({ kind, id });
  if (!first) return;
  // 这一下是双击的第一下时，第二下落在刚挂上的编辑器里：只放光标，不让浏览器 / 编辑器选中一个词
  const t0 = performance.now();
  const second = (e: PointerEvent) => {
    removeEventListener("pointerdown", second, true);
    if (performance.now() - t0 < tune("dblClick") && Math.hypot(e.clientX - at.x, e.clientY - at.y) <= DBL_SLOP) e.preventDefault();
  };
  addEventListener("pointerdown", second, true);
}
/** The click on the Note's static view as a place in its text (NoteSpot); undefined where the point maps to no character */
function staticSpot(id: string, at: { x: number; y: number }): NoteSpot | undefined {
  const md = document.querySelector<HTMLElement>(`${cardSel(id)} .md:is(.nbody, .tx):not(.editing)`);
  const last = md?.lastElementChild;
  if (!md || !last) return undefined;
  if (at.y >= last.getBoundingClientRect().bottom) return "end";
  const c = document.caretRangeFromPoint?.(at.x, at.y);
  if (!c || !md.contains(c.startContainer)) return undefined;
  // the character before the point, inside the same text (a point past a line's end is after its last character, not before the
  // next block's first); at a text's start the one after it
  const before = () => {
    const all = document.createRange();
    all.selectNodeContents(md);
    all.setEnd(c.startContainer, c.startOffset);
    const b = staticTextRange(md, all);
    return b && { char: { from: b.to - 1, to: b.to, text: b.text[b.text.length - 1] }, after: true };
  };
  const after = () => {
    const rest = document.createRange();
    rest.setStart(c.startContainer, c.startOffset);
    rest.setEnd(md, md.childNodes.length);
    const r = staticTextRange(md, rest);
    return r && { char: { from: r.from, to: r.from + 1, text: r.text[0] }, after: false };
  };
  return (c.startContainer.nodeType === 3 && c.startOffset > 0 ? before() ?? after() : after() ?? before()) ?? undefined;
}
// 按在只选着的这一张的正文上（Note、手写代码）：按下时不知道是点还是选字（原生文本选择），等 click 再看
let armed: { id: string; kind: "note" | "free"; x: number; y: number } | null = null;
export function cardClick(e: MouseEvent, id: string) {
  const a = armed;
  armed = null;
  if (!a || a.id !== id || e.shiftKey || e.metaKey || e.ctrlKey) return;
  // 拖着选了字的不算；任务勾选框、引用的点击 MdStatic 自己处理了（停止冒泡，到不了这里）
  if (Math.hypot(e.clientX - a.x, e.clientY - a.y) >= DRAG_SLOP || !window.getSelection()?.isCollapsed) return;
  if ((e.target as HTMLElement).closest(OWN_CLICK) || !(isSel(id) && sel.cards.length === 1) || editing()?.id === id) return;
  clickEdit(a.kind, id, a, true);
}

/** 右键按下那一刻 Note 里选中的字：macOS 的右键会先选中光标下的词，菜单弹出时的选区不是用户选的 */
let ctxSel: { id: string; text: string } | null = null;
export function cardPointerDown(e: PointerEvent, id: string) {
  armed = null;
  const t = e.target as HTMLElement;
  if (e.button === 2) ctxSel = { id, text: A.noteSelText(id) };
  if (e.button === 1 || (e.button === 0 && spaceDown())) return startPan(e);
  if (e.button !== 0) return;
  if (t.closest(CARD_CONTROL)) return;
  if (connectFrom()) return finishConnect(e, id);
  if (modeIs("pick")) { e.preventDefault(); e.stopPropagation(); const cb = takePick(); const colEl = t.closest("[data-col]") as HTMLElement | null; cb?.(colEl?.dataset.col ?? id); return; }
  const f = cardById(id);
  if (!f) return;
  const colEl = t.closest("[data-col]") as HTMLElement | null;
  const target = colEl?.dataset.col ?? id;
  const c = f.card;
  const isText = frameless(c);
  const inHead = !!t.closest("[data-drag]");
  const inBody = !isText && !inHead;
  // 只选着这一张时，按在内容上是选字（原生文本选择）；没选中或选着好几张时，按在内容上和按卡头一样拖卡，
  // 不动就松手：没选中的选中它，选着好几张的只留这一张（之后再按就能选字）
  const multiBody = inBody && isSel(f.host.id) && sel.cards.length > 1;
  // 按下之前就只选着这一张：单击正文进编辑。双击的第二下（第一下刚选中它）就在这一下进，光标放在双击的地方、不选词
  const solo = isSel(f.host.id) && sel.cards.length === 1;
  const editKind = clickEditKind(c, t);
  if (inBody) {
    if (!t.closest(".src, .nbody, .cdesc, .tx")) { setLineSel(null); }
    if (e.shiftKey || e.metaKey || e.ctrlKey) return A.selectCard(f.host.id, true);
    const second = !!editKind && isDbl(`e${id}`, e);
    if (solo && second && editing()?.id !== id) { e.preventDefault(); return clickEdit(editKind!, id, { x: e.clientX, y: e.clientY }); }
    if (solo) { if (editKind && !second) armed = { id, kind: editKind, x: e.clientX, y: e.clientY }; return; }
  }
  e.preventDefault();
  // 拖的正是在编辑内容的这张卡（Note、手写代码）：接着编辑，焦点、光标都不动。拖动不算写完：
  // 新建的空 Note 拖一下不会被当成「什么都没写」而消失，拖完接着打字
  const ed = editing();
  if (!(ed && ed.id === f.host.id && (ed.kind === "note" || ed.kind === "free"))) {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.getSelection()?.removeAllRanges();
  }
  if (c.kind === "web" && inHead && isDbl(`w${id}`, e)) return A.openLink(c.url);
  // 双击子白板框：进去；双击在框里的一张小卡片上就进去以后带到那张卡
  if (c.kind === "board" && isDbl(`b${id}`, e)) return A.enterFrame(id, undefined, (t.closest("[data-sub]") as HTMLElement | null)?.dataset.sub);
  const tc = cardById(target)?.card;
  const freeHead = !!tc && isCode(tc) && tc.segments[0]?.src.kind === "free" && !tc.title;
  if (inHead && (t.closest(".ctitle") || freeHead) && isDbl(`t${target}`, e)) return setEditing({ kind: "title", id: target });
  // 调用图标记：点 = 改标记（字母 / 图标），拖 = 连同它往下调用的卡一起走
  if (inHead && t.closest(".step")) {
    const el = t.closest(".step")!;
    const was = [...sel.cards];
    A.selectSubtree(target, e.shiftKey); closeAllPops();
    return startCardDrag(e, f.host.id, () => { select({ cards: was.length ? was : [f.host.id] }); A.openMarkPicker(target, el); });
  }
  if (isText && isDbl(`x${id}`, e)) return void (editing()?.id !== id && clickEdit("note", id, { x: e.clientX, y: e.clientY }));
  if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleSel("cards", f.host.id); return; }
  if (!isSel(f.host.id)) A.selectCard(f.host.id);
  closeAllPops();
  const at = { x: e.clientX, y: e.clientY };
  // 子白板框的地图上的一块：没拖动就松手是开 / 关它的预览
  const block = c.kind === "board" ? (t.closest("[data-sub]") as HTMLElement | null)?.dataset.sub : undefined;
  startCardDrag(e, f.host.id, multiBody ? () => A.selectCard(f.host.id) : isText && solo && editKind ? () => clickEdit("note", id, at, true) : block ? () => togglePreview(id, block) : undefined);
}

const hostPlace = (b: Board, id: string) => { const h = findCard(b, id)?.host; return h ? b.place[h.id] : undefined; };

/** 卡头上能点也能拖的东西（文件路径、版本号）：刚拖完松手时浏览器还会补一个 click，这时不算点 */
let dragEndAt = -1e9;
export const justDragged = () => performance.now() - dragEndAt < 250;
function startCardDrag(e: PointerEvent, grabbed: string, onClick?: () => void) {
  const ids = sel.cards.filter((i) => cardById(i) && !A.isLocked(i));
  if (!ids.length) return onClick?.();
  const skip = new Set(ids);
  const items = ids.map((i) => { const c = placeOf(i); return { id: i, ox: c.x, oy: c.y, r: rectOf(cardById(i)!.host) }; });
  const box = bounds(ids.map((i) => rectOf(cardById(i)!.host)))!;
  const targets = [...visibleCards().filter((c) => !skip.has(c.id)).map((c) => rectOf(c)), ...[...frames().entries()].map(([, r]) => r)];
  const fr = new Map(frames());
  // 别的卡占的地方（世界坐标）：指针不在哪张附近时不用问浏览器指针下面是什么。elementsFromPoint 要把指针下面每一层都找出来，
  // 241 张卡的白板每次 3–6 ms，是拖动每帧最大的一块。外面留一圈：浮在卡上方的卡头、斜贴的卡角、卡边上的贴纸
  const others = placed().filter((c) => !skip.has(c.id)).map((c) => rectOf(c));
  const nearOther = (ev: PointerEvent) => {
    const p = worldOf(ev), pad = Math.max(64, 24 / cam.z);
    return others.some((r) => p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad);
  };
  const { end, moving, drop: dropGesture } = undoGesture(ids);
  const sx = e.clientX, sy = e.clientY;
  let mergeT: number | undefined, mergeTgt: string | undefined;
  const g = cardById(grabbed)!.host;
  const mergeOk = ids.every((i) => cardById(i)!.card.kind === "code");
  const webOk = ids.every((i) => { const k = cardById(i)!.card.kind; return k === "web" || k === "links"; }); // Web 卡拖到另一张的标题上 → Link List
  const noteOk = ids.length === 1 && g.kind === "note" && g.look === "note";
  const imageOk = ids.length === 1 && g.kind === "image"; // 图片卡拖到 Note / Text 上 → 放进它的 Markdown
  setDragging(new Set(ids));
  const pace = snapPace(e, (ev, still) => onMove(ev, still));
  const onMove = (ev: PointerEvent, still = false) => {
    const z = cam.z;
    let dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
    const fast = pace.fast(ev, still);
    // 合并 / 变成 Sidenote 的落点
    const under = !nearOther(ev) ? undefined : document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => (n as HTMLElement).closest?.(".card") && !skip.has(((n as HTMLElement).closest(".card") as HTMLElement).dataset.id!)) as HTMLElement | undefined;
    const uc = under?.closest(".card") as HTMLElement | undefined;
    const uid = uc?.dataset.id;
    const head = under?.closest(".chead");
    const row = under?.closest(".src > .l") as HTMLElement | null;
    const ucard = uid ? cardById(uid) : undefined;
    let drop = dropTarget();
    const webHead = webOk && uid && ucard && (ucard.host.kind === "web" || ucard.host.kind === "links") && under?.closest(".chead, .wtitle");
    if (webHead || (mergeOk && uid && head && ucard && isCode(ucard.card) && ucard.host.kind === "code")) {
      if (ev.altKey) { drop = { kind: "merge", card: uid, armed: true }; clearTimeout(mergeT); }
      else if (mergeTgt !== uid) {
        clearTimeout(mergeT);
        mergeTgt = uid;
        drop = { kind: "merge", card: uid, armed: false };
        mergeT = window.setTimeout(() => { if (mergeTgt === uid) { setDropTarget({ kind: "merge", card: uid, armed: true }); setGuides([]); } }, 400);
      }
    } else if (imageOk && uid && ucard?.card.kind === "note") {
      clearTimeout(mergeT); mergeTgt = undefined;
      const d = dropTarget();
      drop = d?.kind === "note" && d.card === uid ? d : { kind: "note", card: uid };
    } else if (row && uid && ucard && (noteOk || (ev.altKey && ids.length === 1 && isCode(g)))) {
      const at = rowAnchor(row, uid);
      clearTimeout(mergeT); mergeTgt = undefined;
      drop = at ? { kind: "line", card: at.card, seg: at.seg, line: at.lines![0] } : null;
    } else {
      clearTimeout(mergeT); mergeTgt = undefined;
      drop = null;
    }
    if (drop?.kind === "merge" && dropTarget()?.kind === "merge" && dropTarget()!.card === drop.card && dropTarget()!.armed) drop = dropTarget();
    setDropTarget(drop);
    if (drop?.kind === "note") overNote(drop.card, { x: ev.clientX, y: ev.clientY }); else leaveNote();
    if (!(ev.metaKey || ev.ctrlKey) && !drop && !fast) {
      const sn = snapMove({ ...box, x: box.x + dx, y: box.y + dy }, targets, tune("snap") / z);
      dx += sn.dx; dy += sn.dy;
      setGuides(sn.guides);
    } else setGuides([]);
    live((b) => { for (const it of items) { const c = hostPlace(b, it.id); if (c) { c.x = Math.round(it.ox + dx); c.y = Math.round(it.oy + dy); } } });
    // 松手后会在哪个 Section（和下面松手时同一个算法）：先预演出来，要进的 Section 亮起来；合并 / 变 Sidenote 时不算
    setMovingHome(drop ? null : new Map(items.map((it) => [it.id, homeFor(fr, { ...it.r, x: it.r.x + dx, y: it.r.y + dy })?.id])));
  };
  track(e, (ev) => { moving(); onMove(ev); }, (ev, moved) => {
    pace.stop();
    clearTimeout(mergeT);
    setGuides([]);
    setDragging(new Set<string>());
    setMovingHome(null);
    const drop = dropTarget();
    const noteAt = drop?.kind === "note" ? noteDropAt(drop.card) : undefined;
    setDropTarget(null);
    if (drop?.kind !== "note") leaveNote();
    if (!moved) { leaveNote(); end(); onClick?.(); return; }
    dragEndAt = performance.now();
    if (drop?.kind === "merge" && drop.armed) {
      live((b) => { for (const it of items) { const c = hostPlace(b, it.id); if (c) { c.x = it.ox; c.y = it.oy; } } });
      end();
      return webOk ? A.mergeIntoLinkList([drop.card, ...ids], drop.card) : A.mergeCards([drop.card, ...ids], drop.card);
    }
    if (drop?.kind === "note") {
      // 图先存成 Note 的图（要问宿主）：这期间卡留在松手的地方、Note 还亮着；好了以后卡在这里淡出，回到原处再删，
      // 撤销时卡回到拖之前的地方（拖动和放进 Note 是一步）
      setDropTarget(drop);
      void A.noteImageFor(ids[0]).then((src) => {
        if (src) ghostOut([ids[0]]);
        setDropTarget(null);
        leaveNote();
        live((b) => { for (const it of items) { const c = hostPlace(b, it.id); if (c) { c.x = it.ox; c.y = it.oy; } } });
        end();
        if (src) A.putImageInNote(ids[0], drop.card, src, noteAt);
      });
      return;
    }
    if (drop?.kind === "line") {
      live((b) => { for (const it of items) { const c = hostPlace(b, it.id); if (c) { c.x = it.ox; c.y = it.oy; } } });
      end();
      return A.cardToSidenote(ids[0], { card: drop.card, seg: drop.seg, lines: [drop.line!, drop.line!] });
    }
    live((b) => {
      for (const it of items) {
        const c = hostPlace(b, it.id);
        if (!c) continue;
        const best = homeFor(fr, rectOf(cardById(it.id)!.host));
        c.section = best?.id;
      }
    });
    end();
    void ev;
  }, DRAG_SLOP, () => { pace.stop(); clearTimeout(mergeT); leaveNote(); dropGesture(); });
}

function rowAnchor(row: HTMLElement, hostId: string): Anchor | null {
  const colEl = row.closest("[data-col]") as HTMLElement | null;
  const cid = colEl?.dataset.col ?? hostId;
  const g = geo[cid];
  const r = g?.rows[+row.dataset.r!];
  if (!r || r.t !== "line") return null;
  return { card: cid, seg: r.seg, lines: [r.line, r.line] };
}

export function cardContextMenu(e: MouseEvent, id: string) {
  e.preventDefault();
  e.stopPropagation();
  const t = e.target as HTMLElement;
  // Note 里的一张图（显示着或编辑中）：图的菜单
  const img = A.noteImageAt(t, id);
  if (img) return A.noteImageMenu(img, e.clientX, e.clientY);
  // Note 里选中了一段字：照这段字画 SVG 的菜单（编辑器里没选字时照旧不弹菜单）
  const picked = ctxSel?.id === id ? ctxSel.text : A.noteSelText(id);
  ctxSel = null;
  if (picked) return A.noteTextMenu(id, picked, e.clientX, e.clientY);
  if (t.closest("[contenteditable], input, textarea")) return;
  const colEl = t.closest("[data-col]") as HTMLElement | null;
  A.cardMenu(colEl?.dataset.col ?? id, e.clientX, e.clientY);
}
export function cardDblClick(e: MouseEvent, id: string) {
  const t = e.target as HTMLElement;
  // 概览 / 地图里双击卡片：放大到这张卡 100%
  if (lod() !== "full") { e.preventDefault(); const r = rectOf(cardById(id)!.host), w = view().w; return camTo(24 + Math.max(0, (w - 48 - r.w) / 2) - r.x, 72 - r.y, 1); }
  if (t.closest(".cdesc")) { e.preventDefault(); setEditing({ kind: "desc", id }); return; }
  const c = cardById(id)?.card, ed = editing();
  if (ed?.id === id && (ed.kind === "note" || ed.kind === "free")) return; // 双击的第一下已经进了编辑（单击选中的卡），第二下落在编辑器里
  // Text / Box / Mark 的双击在第二下按下时就进了
  const kind = c && !(c.kind === "note" && c.look !== "note") ? clickEditKind(c, t) : null;
  if (kind) { e.preventDefault(); clickEdit(kind, id, { x: e.clientX, y: e.clientY }); }
}

export function resizeDown(e: PointerEvent, id: string, edges: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const c = cardById(id)?.host;
  if (!c || A.isLocked(id)) return;
  A.selectCard(id);
  const r0 = rectOf(c);
  const targets = visibleCards().filter((k) => k.id !== id).map((k) => rectOf(k));
  const { end, moving, drop } = undoGesture([c.id]);
  const sx = e.clientX, sy = e.clientY;
  const text = frameless(c), box = c.kind === "note" && c.look === "box";
  // 最矮 = 头部 + 一行；拉到内容本来的高度附近就回到自动高度（Box 的高度就是框的大小，一直存着）
  const nat = box ? undefined : naturalSize(c.id);
  // 子白板的框：最小也放得下几块地图和右上角的按钮
  const frame = c.kind === "board";
  const minW = box ? 60 : text ? 80 : frame ? 200 : 160, minH = box ? 32 : frame ? 130 : nat ? Math.min(nat.minH, 100) : 64;
  const hx = c.kind === "code" ? chromeOf(c.id) : 0; // 代码卡存内容区高度：减掉卡头 / 底栏
  // 图片卡的高度跟着图片的宽高比（不存）：拖角只改宽度，往下拖按卡现在的比例折成宽度
  const image = c.kind === "image", bottom = !!edges.bottom && !image;
  track(e, (ev) => {
    moving();
    const z = cam.z, dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
    let w = r0.w, h = r0.h, x = r0.x, y = r0.y;
    const ddx = image && edges.bottom && Math.abs((dy * r0.w) / r0.h) > Math.abs(dx) ? (dy * r0.w) / r0.h : dx;
    if (edges.right) w = Math.max(minW, r0.w + ddx);
    if (edges.left) { w = Math.max(minW, r0.w - dx); x = r0.x + r0.w - w; }
    if (bottom) h = Math.max(minH, r0.h + dy);
    if (edges.top) { h = Math.max(minH, r0.h - dy); y = r0.y + r0.h - h; }
    let hint: string | null = null;
    if (!(ev.metaKey || ev.ctrlKey) && !edges.left && !edges.top) {
      const sn = snapResize({ x, y: r0.y, w, h }, { right: edges.right, bottom }, targets, tune("snap") / z);
      w = sn.w; h = sn.h;
      setGuides(sn.guides.filter(() => !sn.same));
      if (sn.same === "w") hint = `same width · ${Math.round(w)}`;
      if (sn.same === "h") hint = `same height · ${Math.round(h)}`;
    } else setGuides([]);
    setSizeHint(hint ? { x: x + w / 2, y: y + h + 8, text: hint } : null);
    // 拉到内容本来的高度附近（±8 屏幕像素）= 回到跟着内容的自动高度；别的高度照存（Note 可以比内容高，也可以矮了在正文里滚）
    const auto = bottom && nat && Math.abs(h - nat.h) < 8 / z;
    live((b) => { const k = hostPlace(b, id)!; k.w = Math.round(w); k.x = Math.round(x); if (edges.top) k.y = Math.round(y); if (bottom || edges.top) k.h = auto ? undefined : Math.round(h - hx); });
  }, () => { setGuides([]); setSizeHint(null); end(); }, DRAG_SLOP, drop);
}

// 一次滚动手势从哪开始就一直归谁：画布上开始 → 一路平移，经过卡片也不停；停 ~200ms 才算结束。
// 卡片里滚代码只在：卡片已选中，或者不是紧跟着一次画布平移开始的滚动
let wheelOwner: HTMLElement | "canvas" | null = null, wheelLast = 0, panEnd = 0;
function ownerFor(e: WheelEvent, el: HTMLElement | null): HTMLElement | "canvas" {
  const now = performance.now();
  if (now - wheelLast > WHEEL_GESTURE) {
    if (wheelOwner === "canvas") panEnd = wheelLast;
    const card = el?.closest(".card") as HTMLElement | null;
    const can = !!el && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    const selected = !!card && isSel(card.dataset.id!);
    wheelOwner = can && !e.ctrlKey && !e.metaKey && (selected || now - panEnd > 500) ? el! : "canvas";
  }
  wheelLast = now;
  return wheelOwner!;
}
/** 卡里滚动：这次手势归这张卡就原生滚动，否则交给画布 */
export function cardWheel(e: WheelEvent, el: HTMLElement) {
  if (e.ctrlKey || e.metaKey) return; // 交给画布缩放
  if (ownerFor(e, el) === el) e.stopPropagation();
}

// 调用：点 = 展开；拖 = 接到已有卡 / 放到指定位置

export function callPointerDown(e: PointerEvent, cardId: string, seg: string, call: CallSpan, el: HTMLElement) {
  if (connectFrom()) return;
  A.selectCard(cardId);
  closeAllPops();
  const from = el.getBoundingClientRect();
  let cands: string[] = [];
  let hot: string | undefined;
  track(e, (ev) => {
    if (!cands.length) {
      window.getSelection()?.removeAllRanges();
      cands = A.allCodeCandidates(call).filter((id) => hostOf(id) !== hostOf(cardId));
    }
    const a = local({ clientX: from.left, clientY: from.top + from.height / 2 });
    const b = local(ev);
    setRubber({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const ce = under?.closest(".card") as HTMLElement | null;
    const colEl = under?.closest("[data-col]") as HTMLElement | null;
    const tid = colEl?.dataset.col ?? ce?.dataset.id;
    hot = tid && hostOf(tid) !== hostOf(cardId) ? tid : undefined;
    setDropTarget(hot ? { kind: "card", card: hostOf(hot), cands } : { kind: "cand", card: "", cands });
  }, (ev, moved) => {
    setRubber(null);
    setDropTarget(null);
    if (!moved) return void A.expandCall(cardId, seg, call);
    if (hot) {
      let tid = hot;
      const h = cardById(hot)!.host;
      if (h.kind === "compare" && tid === h.id) tid = h.cols.find((k) => A.calleeMatches(cardById(k)!.card, call)) ?? h.cols[0];
      return A.attachCall(cardId, seg, call, tid);
    }
    const w = worldOf(ev);
    A.expandCall(cardId, seg, call, { x: w.x + 8, y: w.y - 18 });
  }, CALL_DRAG_SLOP);
}

/**
 * side：用户从哪个圆点拖出来，起点就固定在那一侧（不再按位置自动推）。
 * 落点：代码行（行号）→ 那一行；Note 的卡身（卡头以外：块上、块之间的空隙、上下内边距）→ 最近的那一块；别的地方 → 整张卡。
 * 指着 Note 的一块时那一块和起点那一块（从块拖出来的）上淡色底，终点滑到那一块在卡边上的位置（换一块时滑过去，不跳）
 */
export function linkPortDown(e: PointerEvent, from: End, sx: number, sy: number, side?: LinkSide) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  let to: End | null = null;
  const src = from.block ? blockOf(from.card, from.block) : null;
  // 终点（白板坐标）：指着一块时朝那一块的位置滑过去（BLOCK_GLIDE，缓出），否则就在指针上
  let shown: { x: number; y: number } | null = null, glide: { a: { x: number; y: number }; b: { x: number; y: number }; t0: number } | null = null, raf = 0, aimKey = "";
  const a = local({ clientX: sx, clientY: sy });
  const draw = () => { if (shown) setRubber({ x1: a.x, y1: a.y, x2: shown.x, y2: shown.y, plain: true }); };
  const step = (now: number) => {
    raf = 0;
    if (!glide) return;
    const p = Math.min(1, (now - glide.t0) / BLOCK_GLIDE), k = 1 - (1 - p) ** 3;
    shown = { x: glide.a.x + (glide.b.x - glide.a.x) * k, y: glide.a.y + (glide.b.y - glide.a.y) * k };
    draw();
    if (p < 1) raf = requestAnimationFrame(step); else glide = null;
  };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; glide = null; tintBlocks([]); };
  track(e, (ev) => {
    const b = local(ev);
    const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const ce = under?.closest(".card") as HTMLElement | null;
    to = null;
    let aim: BlockAim | null = null;
    if (ce && cardById(ce.dataset.id!)) {
      // 松在代码行上或行号上 → 连到那一行；Note 卡头以外 → 最近的那一块；松在卡的其它地方 → 连到整张卡
      const row = under?.closest(".src > .l, .gutter .no") as HTMLElement | null;
      const at = row ? rowAnchor(row, ce.dataset.id!) : null;
      const colEl = under?.closest("[data-col]") as HTMLElement | null;
      aim = !at && !under?.closest(".chead") ? aimBlock(ce.dataset.id!, ev.clientY) : null;
      to = at ? { card: at.card, seg: at.seg, line: at.lines![0] } : aim ? { card: aim.card, block: aim.ref } : { card: colEl?.dataset.col ?? ce.dataset.id! };
      if (hostOf(to.card) === hostOf(from.card) && !to.line) { to = null; aim = null; }
    }
    setDropTarget(to ? { kind: to.line ? "line" : to.block ? "block" : "card", card: hostOf(to.card), seg: to.seg, line: to.line } : null);
    tintBlocks(aim ? [aim, src] : to ? [src] : []); // 起点那段：对准了任何落点（一段、一行、卡头）都上色
    const key = aim ? `${aim.card}:${aim.k}` : "";
    if (!aim) { cancelAnimationFrame(raf); raf = 0; glide = null; aimKey = ""; shown = b; return draw(); }
    if (key === aimKey) return;
    aimKey = key;
    const goal = boardPoint(aimPoint(aim, sx));
    if (!shown || reduceMotion()) { shown = goal; return draw(); }
    glide = { a: shown, b: goal, t0: performance.now() };
    if (!raf) raf = requestAnimationFrame(step);
  }, (_ev, moved) => {
    stop();
    setRubber(null);
    setDropTarget(null);
    if (moved && to) A.addLink(from, to, side);
  }, DRAG_SLOP, stop);
}

function finishConnect(e: PointerEvent, id: string) {
  e.preventDefault();
  e.stopPropagation();
  const from = connectFrom()!;
  idle();
  const colEl = (e.target as HTMLElement).closest("[data-col]") as HTMLElement | null;
  const to = colEl?.dataset.col ?? id;
  if (hostOf(to) === hostOf(from.card)) return toast("Connect cancelled");
  // 手动补的 Call 箭头（解析不到的调用）
  if (from.call) return A.manualCallTo({ ...from, call: from.call }, to);
  A.addLink(from, { card: to });
}

export function canvasPointerDown(e: PointerEvent) {
  const t = e.target as HTMLElement;
  if (t.closest(OWNS_POINTER)) return;
  (document.activeElement as HTMLElement | null)?.blur?.();
  if (e.button === 1 || (e.button === 0 && spaceDown())) return startPan(e);
  if (e.button !== 0) return;
  if (modeIs("connect")) return void cancelMode();
  e.preventDefault();
  closeAllPops();
  if (isDbl("canvas", e)) {
    const w = worldOf(e), k = state.host.settings.dblClick;
    if (k === "text") A.newText({ x: w.x, y: w.y - 12 });
    else if (k === "note") A.newNote({ x: w.x, y: w.y - 18 });
    else if (k === "code") A.newFreeCode({ x: w.x, y: w.y - 18 });
    return;
  }
  if (modeIs("draw")) return drawSection(e);
  // ⌘ / Ctrl 按住 Section 的空白处拖就是拖它（和拖标题一样，最里层的那个）；不按时拖空白处总是框选，免得想框选时误拖走整个 Section
  if (!e.shiftKey && (e.metaKey || e.ctrlKey)) {
    const w = worldOf(e);
    const s = deepestAt(frames(), w.x, w.y, new Set(state.board.sections.filter(hiddenByAncestor).map((x) => x.id)));
    if (s) return sectionLabelDown(e, s.id);
  }
  const base = e.shiftKey ? [...sel.cards] : [];
  if (!e.shiftKey) clearSel();
  window.getSelection()?.removeAllRanges();
  const a = local(e);
  track(e, (ev) => {
    const b = local(ev);
    const m = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    setMarquee(m);
    const w0 = toWorld(m.x, m.y), w1 = toWorld(m.x + m.w, m.y + m.h);
    const hit = visibleCards().filter((c) => {
      if (A.isLocked(c.id)) return false;
      const r = rectOf(c);
      return r.x < w1.x && r.x + r.w > w0.x && r.y < w1.y && r.y + r.h > w0.y;
    }).map((c) => c.id);
    select({ cards: [...new Set([...base, ...hit])] });
  }, (ev, moved) => {
    setMarquee(null);
    // 在 Section 空白处点一下（没拖）选中它，最里层的那个；拖动照常是框选
    if (moved || e.shiftKey) return;
    const w = worldOf(ev);
    const s = deepestAt(frames(), w.x, w.y, new Set(state.board.sections.filter(hiddenByAncestor).map((x) => x.id)));
    if (s) select({ sections: [s.id] });
  });
}

/** 工具栏 Section（draw 模式）：在画布上拖出一个框 */
function drawSection(e: PointerEvent) {
  const a = worldOf(e);
  const la = local(e);
  track(e, (ev) => {
    const b = local(ev);
    setMarquee({ x: Math.min(la.x, b.x), y: Math.min(la.y, b.y), w: Math.abs(b.x - la.x), h: Math.abs(b.y - la.y) });
  }, (ev, moved) => {
    setMarquee(null);
    endDraw();
    const b = worldOf(ev);
    const r = moved ? { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(120, Math.abs(b.x - a.x)), h: Math.max(80, Math.abs(b.y - a.y)) } : { x: a.x, y: a.y, w: 360, h: 240 };
    clearSel();
    // 新框落在哪个 Section 里（按框中心，取最深的）就是它的父级；
    // 只收同一层的东西：三分之一以上在框内、原来属于父级（或更外层）的卡（partlyIn，和 homeFor 同一条规则），整个落在框内、和它同父级的 Section
    const fr = frames();
    const c0 = center(r);
    // 整个落在新框里的 Section 不能当父级（那是从内往外画：它们反过来成为新框的子级）
    const within = (f: Rect) => f.x >= r.x && f.y >= r.y && f.x + f.w <= r.x + r.w && f.y + f.h <= r.y + r.h;
    const enclosed = new Set(state.board.sections.filter((s) => { const f = fr.get(s.id); return f && within(f); }).map((s) => s.id));
    const parent = deepestAt(fr, c0.x, c0.y, enclosed)?.id;
    const outer = new Set<string | undefined>([undefined]);
    for (let p = parent ? sec(parent) : undefined; p; p = p.parent ? sec(p.parent) : undefined) outer.add(p.id);
    const inside = visibleCards().filter((c) => partlyIn(rectOf(c), r) && outer.has(placeOf(c.id).section)).map((c) => c.id);
    const subs = state.board.sections.filter((s) => enclosed.has(s.id) && s.parent === parent).map((s) => s.id);
    select({ cards: inside, sections: subs });
    A.moveToNewSection(r, parent);
  });
}

function startPan(e: PointerEvent) {
  e.preventDefault();
  stopCam();
  const o = { x: cam.x, y: cam.y };
  const sx = e.clientX, sy = e.clientY;
  let vx = 0, vy = 0, lt = performance.now(), lx = sx, ly = sy;
  setPanning(true);
  track(e, (ev) => {
    const now = performance.now(), dt = Math.max(1, now - lt);
    vx = vx * 0.5 + (0.5 * (ev.clientX - lx)) / dt; vy = vy * 0.5 + (0.5 * (ev.clientY - ly)) / dt;
    lt = now; lx = ev.clientX; ly = ev.clientY;
    setCam(o.x + ev.clientX - sx, o.y + ev.clientY - sy, cam.z);
  }, () => {
    setPanning(false);
    if (performance.now() - lt < 60) fling(vx * 1000, vy * 1000);
  }, 0);
}

/** 滚轮在这上面归它自己（原生滚动，不动画布）：画布上浮着的面板、浮层（data-nodrag）；卡上的按钮、把手、边上的圆点不算，
 *  卡里只有能输入的东西算 */
const ownsWheel = (t: HTMLElement) => !!t.closest(NODRAG) && (!t.closest(".card") || !!t.closest("input, textarea, [contenteditable]"));
export function canvasWheel(e: WheelEvent) {
  const t = e.target as HTMLElement;
  // 正在平移画布的这次滚动手势一路平移下去：画布带着卡移到指针下面，指针落到卡边的圆点、把手上也不停
  const panning = wheelOwner === "canvas" && performance.now() - wheelLast <= WHEEL_GESTURE;
  if (!panning && ownsWheel(t)) return;
  e.preventDefault();
  if (!t.closest(".cbody, .nbody, .tx")) ownerFor(e, null); // 卡片里的已经在 cardWheel 里记过
  stopCam();
  // 编辑中不盖：点回编辑器里放光标靠原生的 mousedown，挡板转不过去
  if (!editing()) raiseShield(e, t);
  const p = local(e);
  if (e.ctrlKey || e.metaKey) {
    const z0 = cam.z, z = Math.min(ZMAX, Math.max(ZMIN, z0 * Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.01))));
    setCam(p.x - ((p.x - cam.x) * z) / z0, p.y - ((p.y - cam.y) * z) / z0, z);
  } else {
    const k = e.deltaMode === 1 ? 16 : 1;
    setCam(cam.x - e.deltaX * k * (e.shiftKey && !e.deltaX ? 0 : 1) - (e.shiftKey && !e.deltaX ? e.deltaY * k : 0), cam.y - (e.shiftKey && !e.deltaX ? 0 : e.deltaY * k), cam.z);
  }
}

export function canvasContextMenu(e: MouseEvent) {
  e.preventDefault();
  const t = e.target as HTMLElement;
  if (t.closest(`.card, ${NODRAG}`)) return;
  const lk = t.closest("[data-link]") as HTMLElement | null;
  if (lk) return A.linkMenu(lk.dataset.link!, e.clientX, e.clientY);
  const sl = t.closest("[data-sect]") as HTMLElement | null;
  if (sl) return A.sectionMenu(sl.dataset.sect!, e.clientX, e.clientY);
  A.canvasMenu(e.clientX, e.clientY);
}

// Section 标签：拖动整体移动（卡片、子 Section 一起走）

export function sectionLabelDown(e: PointerEvent, id: string) {
  if (e.button !== 0 || (e.target as Element).closest(NODRAG)) return;
  e.preventDefault();
  e.stopPropagation();
  closeAllPops();
  const s = sec(id);
  if (!s) return;
  if (isDbl(`s${id}`, e)) return setEditing({ kind: "section", id });
  if (e.shiftKey) { toggleSel("sections", id); return; }
  select({ sections: [id] });
  if (A.sectionLocked(s)) return;
  const subs = [s, ...descSections(id)];
  const members = allMembers(id);
  const items = [...members.map((c) => { const q = placeOf(c.id); return { kind: "c" as const, id: c.id, ox: q.x, oy: q.y }; }), ...subs.map((q) => ({ kind: "s" as const, id: q.id, ox: q.x, oy: q.y }))];
  const skip = new Set(subs.map((q) => q.id));
  const fr = new Map(frames());
  // 和拖卡一样对齐、吸附：吸到别的 Section 的边和中线。自己、子 Section 跟着走；外层的框包着它、跟着它变，也不算
  const box = fr.get(id);
  const outer = new Set<string>();
  for (let p = sec(s.parent); p && !outer.has(p.id); p = sec(p.parent)) outer.add(p.id);
  const targets = [...fr.entries()].filter(([k]) => !skip.has(k) && !outer.has(k)).map(([, r]) => r);
  const g = undoGesture();
  const sx = e.clientX, sy = e.clientY;
  const pace = snapPace(e, (ev, still) => onMove(ev, still));
  const onMove = (ev: PointerEvent, still = false) => {
    const z = cam.z;
    let dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
    const fast = pace.fast(ev, still);
    if (box && !(ev.metaKey || ev.ctrlKey) && !fast) {
      const sn = snapMove({ ...box, x: box.x + dx, y: box.y + dy }, targets, tune("snap") / z);
      dx += sn.dx; dy += sn.dy;
      setGuides(sn.guides);
    } else setGuides([]);
    live((b) => {
      for (const it of items) {
        const o = it.kind === "c" ? b.place[it.id] : b.sections.find((q) => q.id === it.id);
        if (o) { o.x = Math.round(it.ox + dx); o.y = Math.round(it.oy + dy); }
      }
    });
  };
  track(e, (ev) => onMove(ev), (ev, moved) => {
    pace.stop();
    setGuides([]);
    if (moved) {
      const w = worldOf(ev);
      const np = deepestAt(fr, w.x, w.y, skip);
      if ((np?.id ?? undefined) !== s.parent) {
        live((b) => { const q = b.sections.find((x) => x.id === id); if (q) q.parent = np?.id; });
        toast(np ? `Moved into ${np.title}` : "Moved out of the section");
      }
    }
    g.end();
  }, DRAG_SLOP, () => { pace.stop(); g.drop(); });
}
/** 拖 Section 的边改大小（框只会比内容大） */
export function sectionEdgeDown(e: PointerEvent, id: string) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const s = sec(id);
  if (!s || A.sectionLocked(s)) return;
  const f0 = frameOf(s);
  const g = undoGesture();
  const sx = e.clientX, sy = e.clientY;
  track(e, (ev) => {
    const w = Math.max(120, f0.w + (ev.clientX - sx) / cam.z), h = Math.max(80, f0.h + (ev.clientY - sy) / cam.z);
    live((b) => { const q = b.sections.find((x) => x.id === id); if (q) { q.x = f0.x; q.y = f0.y; q.w = Math.round(w); q.h = Math.round(h); } });
  }, g.end, 3, g.drop);
}

export function installKeys() {
  installShield();
  installOverlays();
  trackPointer();
  // 点白板任何地方都要拿到键盘焦点。卡片标题、画布、连线等的 pointerdown 调了 preventDefault（拖动时不选字），这也取消了
  // mousedown 的默认动作（给这个 iframe 焦点）：VS Code 里焦点就留在旁边的代码编辑器，按 Backspace 删的是那里选中的字。
  // 捕获阶段先把焦点要过来（白板已经有焦点时什么都不做，不影响输入框、编辑器里的焦点）
  window.addEventListener("pointerdown", (e) => {
    if (!document.hasFocus()) window.focus();
    // 放贴纸：在卡片和画布自己的处理之前接住这一下；点到贴纸以外的地方就取消贴纸选中
    const t = e.target as HTMLElement;
    if (placing() && e.button === 0 && t.closest?.("#board") && !t.closest(BOARD_CHROME)) return void A.placeStickerAt(e);
    if (selSticker() && !t.closest?.("[data-sticker], .ctx")) setSelSticker(null);
  }, true);
  // 编辑 Note、Free code 卡时 ⌥F 也是 Fit Content（Mac 上不然打出 ƒ），光标不动、接着编辑。捕获阶段先拿：代码编辑器不往外冒按键
  window.addEventListener("keydown", (e) => {
    const ed = editing();
    if (e.isComposing || !typing() || (ed?.kind !== "note" && ed?.kind !== "free") || !matches(e, "fitContent")) return;
    e.preventDefault(); e.stopPropagation();
    A.fitContent([ed.id]);
  }, true);
  window.addEventListener("keydown", (e) => {
    // 按下 ⌘：正在显示的弹窗固定下来。按住不放时系统会一直重发 keydown（repeat），那些不算，不然按住 ⌘ 扫过的每个弹窗都会被固定
    if ((e.key === "Meta" || e.key === "Control") && !e.repeat) for (const p of pops()) if (!p.pinned && (p.pop.kind === "peek" || p.pop.kind === "notes")) pinPop(p.id);
    if (typing() || modalOpen()) return;
    const kl = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && state.host.forwardedKeys?.includes(e.shiftKey && (kl === "l" || kl === "b") ? `shift+${kl}` : kl)) { e.preventDefault(); return; } // 宿主会转回来
    dispatch(A, e);
  });
  const spaceUp = () => setSpaceDown(false);
  window.addEventListener("keyup", (e) => { if (e.key === " ") spaceUp(); });
  window.addEventListener("blur", spaceUp);
  // 粘贴：白板上复制的卡 → 卡（剪贴板里可能同时有图：复制的是图片卡）；否则图片 → Image 卡；文字 → 按内容判断
  window.addEventListener("paste", (e) => {
    if (typing()) return;
    const items = [...(e.clipboardData?.items ?? [])];
    const file = items.find((i) => i.type.startsWith("image/"))?.getAsFile() ?? null;
    const svg = file ? "" : e.clipboardData?.getData("image/svg+xml"); // SVG 作为数据（不是文件）放进剪贴板的
    const text = e.clipboardData?.getData("text/plain");
    const w = worldAt(lastPointer());
    if (!file && !text && !svg) return;
    e.preventDefault();
    // PNG 里没记分辨率时：网页上复制的图（剪贴板里带着 HTML）按 1 倍；截图按这个窗口的倍数（Retina 上是 2），看到的大小和截的时候一样
    const scale = e.clipboardData?.types.includes("text/html") ? 1 : window.devicePixelRatio || 1;
    const image = (f: File) => { const rd = new FileReader(); rd.onload = () => A.addImage(String(rd.result), f.name || "pasted.png", w, { scale }); rd.readAsDataURL(f); };
    if (!text && svg) return void A.pasteText(svg, w);
    if (!text) return image(file!);
    // 先看是不是白板上复制的卡（这块白板的，或者问宿主：别的白板上的就贴卡），否则照旧按图 / 文字粘贴
    void A.pasteFromBoard(text, w).then((done) => {
      if (done) return;
      if (file) return image(file);
      const near = A.pasteNear(text);
      A.pasteText(text, near ?? w, !!near);
    });
  });
  // Files dragged in from the OS (Finder) or from VS Code's Explorer (both only reach the board with Shift held). VS Code's
  // webview wrapper cancels every dragover and drop on this window, before the board's own listeners run: listen on the document,
  // which the drop passes first, so defaultPrevented still says only whether a Note being edited took it
  const FILE_TYPES = ["Files", "text/uri-list", "application/vnd.code.uri-list", "resourceurls", "codefiles"];
  // An image dragged in a Note being edited: released in that editor, the editor moves it there; anywhere else on the board but
  // that Note it moves out of the Note into an image card there (the drop says "move", the editor then takes its source out,
  // and at the drag's end the board makes both one change). Which Note and how wide the image is drawn are read when it starts
  let outOf: { card: string; w: number; drop?: { img: DraggedImage; at: { x: number; y: number }; before?: string } } | null = null;
  const fromNote = (e: DragEvent) => (e.target instanceof Element ? e.target.closest<HTMLElement>(".card[data-id]")?.dataset.id : undefined) === outOf?.card;
  document.addEventListener("dragstart", (e) => {
    const t = e.target instanceof Element ? e.target : null, card = t?.closest<HTMLElement>(".card[data-id]");
    const img = t?.querySelector("img") ?? t?.closest("img");
    outOf = card && img && draggedImage(e.dataTransfer) ? { card: card.dataset.id!, w: img.getBoundingClientRect().width / cam.z } : null;
  });
  // after the editor's own dragend (on the image, before this one): its source is out of the editor's text by now
  document.addEventListener("dragend", () => {
    const o = outOf;
    outOf = null;
    if (o?.drop) A.dropNoteImage(o.drop.img, o.drop.at, o.w, { id: o.card, before: o.drop.before, md: liveNoteMd(o.card) });
  });
  document.addEventListener("dragover", (e) => {
    const dt = e.dataTransfer;
    if (!dt || e.defaultPrevented) return; // an editor under the pointer took it
    if (outOf && dt.types.includes(IMAGE_DRAG_TYPE)) {
      if (fromNote(e)) { dt.dropEffect = "none"; return; } // back on its own Note, outside the text: refused, nothing changes
      e.preventDefault();
      dt.dropEffect = "move";
      return;
    }
    if (dt.types.some((t) => FILE_TYPES.includes(t))) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (e.defaultPrevented || !e.dataTransfer) return;
    const img = outOf && !fromNote(e) && draggedImage(e.dataTransfer);
    if (img) {
      e.preventDefault();
      outOf!.drop = { img, at: worldOf(e), before: liveNoteMd(outOf!.card) };
      return;
    }
    if (A.dropFiles(e.dataTransfer, worldOf(e))) e.preventDefault();
  });
}

// 指针交互：拖卡（吸附、合并、⌥ 拖成 Sidenote、进出 Section）、改大小、框选、平移、缩放、
// 拖 Section 标签、从调用拖出带 Call 标记的箭头、从行尾 / 卡边拖出箭头。installKeys 装窗口级的监听（按键分发在 keymap.ts）。
import {
  findCard, isCode, snapMove, snapResize, bounds, center, contains,
  type Board, type CallSpan, type Rect, type Anchor, type LinkSide,
} from "@codeboard/core";
import {
  state, sel, select, toggleSel, clearSel, setLineSel, isSel, cardById, hostOf, rectOf, live, beginGesture, toast, placeOf,
} from "./state/store";
import { tune } from "./state/tune";
import { cam, setCam, stopCam, camTo, fling, toWorld, view, ZMIN, ZMAX, lod } from "./state/camera";
import { setGuides, setSizeHint, setDropTarget, dropTarget, setDragging, setMarquee, setRubber, setEditing } from "./state/ui";
import { frames, deepestAt, frameOf, sec, descSections, allMembers, visibleCards } from "./state/sections";
import { geo } from "./state/geo";
import { pops, closeAllPops, pinPop } from "./state/pop";
import { connectFrom, modeIs, idle, takePick, endDraw, cancelMode, placing, spaceDown, setSpaceDown, setPanning } from "./state/mode";
import { selSticker, setSelSticker } from "./state/stickers";
import { boardPoint, worldAt, lastPointer, trackPointer, naturalSize, chromeOf } from "./state/measure";
import { installOverlays, modalOpen, isTyping } from "./ui/overlay";
import { NODRAG, CARD_CONTROL, OWNS_POINTER, BOARD_CHROME } from "./ui/guard";
import { dispatch } from "./keymap";
import * as A from "./actions";

const pt = (e: { clientX: number; clientY: number }) => ({ x: e.clientX, y: e.clientY });
const local = (e: { clientX: number; clientY: number }) => boardPoint(pt(e));
const worldOf = (e: { clientX: number; clientY: number }) => worldAt(pt(e));

/** 通用拖动：按下后跟踪移动，松手收尾。返回 false 的 move 不算移动。 */
function track(e: PointerEvent, move: (ev: PointerEvent) => void, up: (ev: PointerEvent, moved: boolean) => void, threshold = 3) {
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  const onMove = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < threshold) return;
    moved = true;
    move(ev);
  };
  const onUp = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
    up(ev, moved);
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
}

const ev0x = (e: PointerEvent) => e.clientX, ev0y = (e: PointerEvent) => e.clientY;

// 双击检测（pointerdown 里 preventDefault 后浏览器的 dblclick 不可靠）：同一个东西上、够快、两下点在差不多同一个地方
const DBL_SLOP = 6;
const dbl: { key?: string; t: number; x: number; y: number } = { t: 0, x: 0, y: 0 };
export function isDbl(key: string, e: { clientX: number; clientY: number }) {
  const now = performance.now();
  const r = dbl.key === key && now - dbl.t < tune("dblClick") && Math.hypot(e.clientX - dbl.x, e.clientY - dbl.y) <= DBL_SLOP;
  dbl.key = r ? undefined : key; dbl.t = now; dbl.x = e.clientX; dbl.y = e.clientY;
  return r;
}

// ---------- 卡片 ----------

export function cardPointerDown(e: PointerEvent, id: string) {
  const t = e.target as HTMLElement;
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
  const isText = c.kind === "note" && !c.bg;
  const inHead = !!t.closest("[data-drag]");
  if (!isText && !inHead) {
    // 卡片内容：只选中，保留原生文本选择
    if (e.shiftKey || e.metaKey || e.ctrlKey) A.selectCard(f.host.id, true);
    else if (!isSel(f.host.id) || sel.cards.length > 1) A.selectCard(f.host.id);
    if (!t.closest(".src, .nbody, .cdesc, .tx")) { setLineSel(null); }
    return;
  }
  e.preventDefault();
  (document.activeElement as HTMLElement | null)?.blur?.();
  window.getSelection()?.removeAllRanges();
  if (c.kind === "web" && inHead && isDbl(`w${id}`, e)) return A.openLink(c.url); // 双击书签 = 在浏览器里打开
  if (c.kind === "board" && isDbl(`b${id}`, e)) return A.enterFrame(id); // 双击子白板框 = 进去
  const tc = cardById(target)?.card;
  const freeHead = !!tc && isCode(tc) && tc.segments[0]?.src.kind === "free" && !tc.title;
  if (inHead && (t.closest(".ctitle") || freeHead) && isDbl(`t${target}`, e)) return setEditing({ kind: "title", id: target });
  // 调用图标记：点 = 改标记（字母 / 图标），拖 = 连同它往下调用的卡一起走（#29）
  if (t.closest(".step")) {
    const el = t.closest(".step")!;
    const was = [...sel.cards];
    A.selectSubtree(target, e.shiftKey); closeAllPops();
    return startCardDrag(e, f.host.id, () => { select({ cards: was.length ? was : [f.host.id] }); A.openMarkPicker(target, el); });
  }
  if (isText && isDbl(`x${id}`, e)) return setEditing({ kind: "note", id });
  if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleSel("cards", f.host.id); return; }
  if (!isSel(f.host.id)) A.selectCard(f.host.id);
  closeAllPops();
  startCardDrag(e, f.host.id);
}

/** 卡（或 Compare 里一栏）所在那张摆放卡的位置 */
const hostPlace = (b: Board, id: string) => { const h = findCard(b, id)?.host; return h ? b.place[h.id] : undefined; };

/** onClick：按下去没拖动就松手时调用 */
/** 卡头上能点也能拖的东西（文件路径、版本号）：刚拖完松手时浏览器还会补一个 click，这时不算点 */
let dragEndAt = -1e9;
export const justDragged = () => performance.now() - dragEndAt < 250;
function startCardDrag(e: PointerEvent, grabbed: string, onClick?: () => void) {
  const ids = sel.cards.filter((i) => cardById(i) && !A.isLocked(i));
  if (!ids.length) return onClick?.();
  const skip = new Set(ids);
  const items = ids.map((i) => { const c = placeOf(i); return { id: i, ox: c.x, oy: c.y }; });
  const box = bounds(ids.map((i) => rectOf(cardById(i)!.host)))!;
  const targets = [...visibleCards().filter((c) => !skip.has(c.id)).map((c) => rectOf(c)), ...[...frames().entries()].map(([, r]) => r)];
  const fr = new Map(frames());
  const end = beginGesture();
  const sx = e.clientX, sy = e.clientY;
  let mergeT: number | undefined, mergeTgt: string | undefined;
  const g = cardById(grabbed)!.host;
  const mergeOk = ids.every((i) => cardById(i)!.card.kind === "code");
  const webOk = ids.every((i) => { const k = cardById(i)!.card.kind; return k === "web" || k === "links"; }); // Web 卡拖到另一张的标题上 → Link List
  const noteOk = ids.length === 1 && g.kind === "note" && g.bg;
  setDragging(new Set(ids));
  // 拖得快时不吸附（顺滑），慢下来才对齐：屏幕上的速度，指数平滑
  let vx = ev0x(e), vy = ev0y(e), vt = performance.now(), speed = 0;
  let settleT: number | undefined;
  const onMove = (ev: PointerEvent, still = false) => {
    clearTimeout(settleT);
    // 停住不动时没有 move 事件：停一下就当速度为 0 再算一次（这时才吸附）
    if (!still) settleT = window.setTimeout(() => onMove(ev, true), 110);
    const z = cam.z;
    let dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
    const now = performance.now(), dt = Math.max(1, now - vt);
    speed = still ? 0 : speed * 0.6 + (Math.hypot(ev.clientX - vx, ev.clientY - vy) / dt) * 1000 * 0.4;
    vx = ev.clientX; vy = ev.clientY; vt = now;
    const fast = speed > tune("snapSpeed");
    // 合并 / 变成 Sidenote 的落点
    const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => (n as HTMLElement).closest?.(".card") && !skip.has(((n as HTMLElement).closest(".card") as HTMLElement).dataset.id!)) as HTMLElement | undefined;
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
    if (!(ev.metaKey || ev.ctrlKey) && !drop && !fast) {
      const sn = snapMove({ ...box, x: box.x + dx, y: box.y + dy }, targets, tune("snap") / z);
      dx += sn.dx; dy += sn.dy;
      setGuides(sn.guides);
    } else setGuides([]);
    live((b) => { for (const it of items) { const c = hostPlace(b, it.id); if (c) { c.x = Math.round(it.ox + dx); c.y = Math.round(it.oy + dy); } } });
  };
  track(e, (ev) => onMove(ev), (ev, moved) => {
    clearTimeout(settleT);
    clearTimeout(mergeT);
    setGuides([]);
    setDragging(new Set<string>());
    const drop = dropTarget();
    setDropTarget(null);
    if (!moved) { end(); onClick?.(); return; }
    dragEndAt = performance.now();
    if (drop?.kind === "merge" && drop.armed) {
      live((b) => { for (const it of items) { const c = hostPlace(b, it.id); if (c) { c.x = it.ox; c.y = it.oy; } } });
      end();
      return webOk ? A.mergeIntoLinkList([drop.card, ...ids], drop.card) : A.mergeCards([drop.card, ...ids], drop.card);
    }
    if (drop?.kind === "line") {
      live((b) => { for (const it of items) { const c = hostPlace(b, it.id); if (c) { c.x = it.ox; c.y = it.oy; } } });
      end();
      return A.cardToSidenote(ids[0], { card: drop.card, seg: drop.seg, lines: [drop.line!, drop.line!] });
    }
    // 中心点决定进出哪个 Section
    live((b) => {
      for (const it of items) {
        const c = hostPlace(b, it.id);
        if (!c) continue;
        const r = rectOf(cardById(it.id)!.host), p = center(r);
        const best = deepestAt(fr, p.x, p.y);
        c.section = best?.id;
      }
    });
    end();
    void ev;
  });
}

/** 落点行 → Anchor */
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
  if (t.closest("[contenteditable], input, textarea")) return;
  const colEl = t.closest("[data-col]") as HTMLElement | null;
  A.cardMenu(colEl?.dataset.col ?? id, e.clientX, e.clientY);
}
export function cardDblClick(e: MouseEvent, id: string) {
  const t = e.target as HTMLElement;
  // 概览 / 地图里双击卡片：放大到这张卡 100%
  if (lod() !== "full") { e.preventDefault(); const r = rectOf(cardById(id)!.host), w = view().w; return camTo(24 + Math.max(0, (w - 48 - r.w) / 2) - r.x, 72 - r.y, 1); }
  if (t.closest(".cdesc")) { e.preventDefault(); setEditing({ kind: "desc", id }); return; }
  const c = cardById(id)?.card;
  if (c?.kind === "note" && c.bg && t.closest(".nbody")) { e.preventDefault(); setEditing({ kind: "note", id }); }
  if (c?.kind === "code" && c.segments[0]?.src.kind === "free" && t.closest(".src")) { e.preventDefault(); setEditing({ kind: "free", id }); }
}

export function resizeDown(e: PointerEvent, id: string, edges: { left?: boolean; right?: boolean; bottom?: boolean }) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const c = cardById(id)?.host;
  if (!c || A.isLocked(id)) return;
  A.selectCard(id);
  const r0 = rectOf(c);
  const targets = visibleCards().filter((k) => k.id !== id).map((k) => rectOf(k));
  const end = beginGesture();
  const sx = e.clientX, sy = e.clientY;
  const text = c.kind === "note" && !c.bg;
  // 最矮 = 头部 + 一行；拉到内容本来的高度附近就回到自动高度（#2：单行卡拉高后能缩回去）
  const nat = naturalSize(c.id);
  const minW = text ? 80 : 160, minH = nat ? Math.min(nat.minH, 100) : 64;
  const hx = c.kind === "code" ? chromeOf(c.id) : 0; // 代码卡存内容区高度：减掉卡头 / 底栏
  track(e, (ev) => {
    const z = cam.z, dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
    let w = r0.w, h = r0.h, x = r0.x;
    if (edges.right) w = Math.max(minW, r0.w + dx);
    if (edges.left) { w = Math.max(minW, r0.w - dx); x = r0.x + r0.w - w; }
    if (edges.bottom) h = Math.max(minH, r0.h + dy);
    let hint: string | null = null;
    if (!(ev.metaKey || ev.ctrlKey) && !edges.left) {
      const sn = snapResize({ x, y: r0.y, w, h }, { right: edges.right, bottom: edges.bottom }, targets, tune("snap") / z);
      w = sn.w; h = sn.h;
      setGuides(sn.guides.filter(() => !sn.same));
      if (sn.same === "w") hint = `same width · ${Math.round(w)}`;
      if (sn.same === "h") hint = `same height · ${Math.round(h)}`;
    } else setGuides([]);
    setSizeHint(hint ? { x: x + w / 2, y: r0.y + h + 8, text: hint } : null);
    const auto = edges.bottom && nat && Math.abs(h - nat.h) < 8 / z;
    live((b) => { const k = hostPlace(b, id)!; k.w = Math.round(w); k.x = Math.round(x); if (edges.bottom) k.h = auto ? undefined : Math.round(h - hx); });
  }, () => { setGuides([]); setSizeHint(null); end(); });
}

// 一次滚动手势从哪开始就一直归谁（#51）：画布上开始 → 一路平移，经过卡片也不停；停 ~200ms 才算结束。
// 卡片里滚代码只在：卡片已选中，或者不是紧跟着一次画布平移开始的滚动
let wheelOwner: HTMLElement | "canvas" | null = null, wheelLast = 0, panEnd = 0;
function ownerFor(e: WheelEvent, el: HTMLElement | null): HTMLElement | "canvas" {
  const now = performance.now();
  if (now - wheelLast > 200) {
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

// ---------- 调用：点 = 展开；拖 = 接到已有卡 / 放到指定位置 ----------

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
  }, 6);
}

// ---------- 箭头：从行尾圆点 / 卡边圆点拖出 ----------

/** side：用户从哪个圆点拖出来，起点就固定在那一侧（不再按位置自动推） */
export function linkPortDown(e: PointerEvent, from: { card: string; seg?: string; line?: number }, sx: number, sy: number, side?: LinkSide) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  let to: { card: string; seg?: string; line?: number; sub?: string } | null = null;
  track(e, (ev) => {
    const a = local({ clientX: sx, clientY: sy }), b = local(ev);
    setRubber({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, plain: true });
    const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const ce = under?.closest(".card") as HTMLElement | null;
    to = null;
    if (ce && cardById(ce.dataset.id!)) {
      // 松在代码行上或行号上 → 连到那一行；松在卡的其它地方 → 连到整张卡
      const row = under?.closest(".src > .l, .gutter .no") as HTMLElement | null;
      const at = row ? rowAnchor(row, ce.dataset.id!) : null;
      const colEl = under?.closest("[data-col]") as HTMLElement | null;
      // 子白板框：松在骨架里的一张卡上 → 连到那张卡（线穿过框边的入口点）；松在框的别处 → 连到整个框
      const sub = (under?.closest("[data-sub]") as HTMLElement | SVGElement | null)?.dataset.sub;
      to = at ? { card: at.card, seg: at.seg, line: at.lines![0] } : sub && !sub.startsWith("more:") && cardById(ce.dataset.id!)?.card.kind === "board" ? { card: ce.dataset.id!, sub } : { card: colEl?.dataset.col ?? ce.dataset.id! };
      if (hostOf(to.card) === hostOf(from.card) && !to.line) to = null;
    }
    setDropTarget(to ? { kind: to.line ? "line" : "card", card: hostOf(to.card), seg: to.seg, line: to.line, sub: to.sub } : null);
  }, (_ev, moved) => {
    setRubber(null);
    setDropTarget(null);
    if (moved && to) A.addLink(from, to, side);
  }, 4);
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
  const sub = ((e.target as Element).closest("[data-sub]") as HTMLElement | SVGElement | null)?.dataset.sub;
  A.addLink(from, sub && !sub.startsWith("more:") && cardById(to)?.card.kind === "board" ? { card: to, sub } : { card: to });
}

// ---------- 画布 ----------

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
    if (k === "text") A.newNote({ x: w.x, y: w.y - 12 }, false);
    else if (k === "note") A.newNote({ x: w.x, y: w.y - 18 }, true);
    else if (k === "code") A.newFreeCode({ x: w.x, y: w.y - 18 });
    return;
  }
  if (modeIs("draw")) return drawSection(e);
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
  }, () => setMarquee(null));
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
    // 只收同一层的东西：中心点在框内、原来属于父级（或更外层）的卡，整个落在框内、和它同父级的 Section
    const fr = frames();
    const c0 = center(r);
    // 整个落在新框里的 Section 不能当父级（那是从内往外画：它们反过来成为新框的子级）
    const within = (f: Rect) => f.x >= r.x && f.y >= r.y && f.x + f.w <= r.x + r.w && f.y + f.h <= r.y + r.h;
    const enclosed = new Set(state.board.sections.filter((s) => { const f = fr.get(s.id); return f && within(f); }).map((s) => s.id));
    const parent = deepestAt(fr, c0.x, c0.y, enclosed)?.id;
    const outer = new Set<string | undefined>([undefined]);
    for (let p = parent ? sec(parent) : undefined; p; p = p.parent ? sec(p.parent) : undefined) outer.add(p.id);
    const inside = visibleCards().filter((c) => { const p = center(rectOf(c)); return contains(r, p.x, p.y) && outer.has(placeOf(c.id).section); }).map((c) => c.id);
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

/** 滚轮：两指平移；⌘ / 捏合 缩放 */
export function canvasWheel(e: WheelEvent) {
  const t = e.target as HTMLElement;
  if (t.closest(NODRAG)) return;
  e.preventDefault();
  if (!t.closest(".cbody")) ownerFor(e, null); // 卡片里的已经在 cardWheel 里记过
  stopCam();
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

// ---------- Section 标签：拖动整体移动（卡片、子 Section 一起走） ----------

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
  const end = beginGesture();
  const sx = e.clientX, sy = e.clientY;
  track(e, (ev) => {
    const dx = (ev.clientX - sx) / cam.z, dy = (ev.clientY - sy) / cam.z;
    live((b) => {
      for (const it of items) {
        const o = it.kind === "c" ? b.place[it.id] : b.sections.find((q) => q.id === it.id);
        if (o) { o.x = Math.round(it.ox + dx); o.y = Math.round(it.oy + dy); }
      }
    });
  }, (ev, moved) => {
    if (moved) {
      const w = worldOf(ev);
      const np = deepestAt(fr, w.x, w.y, skip);
      if ((np?.id ?? undefined) !== s.parent) {
        live((b) => { const q = b.sections.find((x) => x.id === id); if (q) q.parent = np?.id; });
        toast(np ? `Moved into ${np.title}` : "Moved out of the section");
      }
    }
    end();
  });
}
/** 拖 Section 的边改大小（框只会比内容大） */
export function sectionEdgeDown(e: PointerEvent, id: string) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const s = sec(id);
  if (!s || A.sectionLocked(s)) return;
  const f0 = frameOf(s);
  const end = beginGesture();
  const sx = e.clientX, sy = e.clientY;
  track(e, (ev) => {
    const w = Math.max(120, f0.w + (ev.clientX - sx) / cam.z), h = Math.max(80, f0.h + (ev.clientY - sy) / cam.z);
    live((b) => { const q = b.sections.find((x) => x.id === id); if (q) { q.x = f0.x; q.y = f0.y; q.w = Math.round(w); q.h = Math.round(h); } });
  }, () => end());
}

// ---------- 窗口级的监听（只在这里装一次） ----------

export function installKeys() {
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
  window.addEventListener("keydown", (e) => {
    // 按住 ⌘：正在显示的弹窗固定下来
    if (e.key === "Meta" || e.key === "Control") for (const p of pops()) if (!p.pinned && (p.pop.kind === "peek" || p.pop.kind === "notes")) pinPop(p.id);
    if (isTyping(e.target) || modalOpen()) return;
    const kl = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && state.host.forwardedKeys?.includes(e.shiftKey && (kl === "l" || kl === "b") ? `shift+${kl}` : kl)) { e.preventDefault(); return; } // 宿主会转回来
    dispatch(A, e);
  });
  const spaceUp = () => setSpaceDown(false);
  window.addEventListener("keyup", (e) => { if (e.key === " ") spaceUp(); });
  window.addEventListener("blur", spaceUp);
  // 粘贴：图片 → Image 卡；文字 → 按内容判断
  window.addEventListener("paste", (e) => {
    if (isTyping(e.target)) return;
    const items = [...(e.clipboardData?.items ?? [])];
    const img = items.find((i) => i.type.startsWith("image/"));
    const w = worldAt(lastPointer());
    if (img) {
      e.preventDefault();
      const f = img.getAsFile();
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => A.addImage(String(rd.result), f.name || "pasted.png", w);
      rd.readAsDataURL(f);
      return;
    }
    const text = e.clipboardData?.getData("text/plain");
    if (text) {
      e.preventDefault();
      // 先问宿主：是别的白板上复制的卡就贴卡（共享卡），否则照旧按文字粘贴
      void A.pasteFromBoard(text, w).then((done) => { if (done) return; const near = A.pasteNear(text); A.pasteText(text, near ?? w, !!near); });
    }
  });
  // 拖文件进来：图片
  window.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault();
    const w = worldOf(e);
    files.forEach((f, i) => { const rd = new FileReader(); rd.onload = () => A.addImage(String(rd.result), f.name, { x: w.x + i * 24, y: w.y + i * 24 }); rd.readAsDataURL(f); });
  });
}

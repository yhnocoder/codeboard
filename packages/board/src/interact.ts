// 指针交互：拖卡（吸附、合并、⌥ 拖成 Sidenote、进出 Section）、改大小、框选、平移、缩放、
// 拖 Section 标签、从调用拖出 Call link、从行尾 / 卡边拖出 Plain link，以及键盘快捷键。
import { unwrap } from "solid-js/store";
import {
  findCard, isCode, snapMove, snapResize, union, bounds, center, contains, cardTitle,
  type Board, type Card, type CallSpan, type Rect, type Anchor, type NoteCard,
} from "@codeboard/core";
import {
  state, sel, select, toggleSel, clearSel, lineSel, setLineSel, isSel, cardById, rectOf, mutate, live, beginGesture,
  undo, redo, toast, placeOf, placed, setSel, toastMsg, setToastMsg,
} from "./state/store";
import { cam, setCam, stopCam, camTo, camTarget, fling, zoomAt, toWorld, view, ZMIN, ZMAX, fitRect } from "./state/camera";
import {
  setGuides, setSizeHint, setDropTarget, dropTarget, setDragging, setMarquee, setRubber, spaceDown, setSpaceDown,
  connectFrom, setConnectFrom, walk, setEditing, editing, setPaletteOpen, paletteOpen, keysOpen, setKeysOpen,
} from "./state/ui";
import { frames, deepestAt, frameOf, sec, descSections, allMembers, collapsedHome } from "./state/sections";
import { geo } from "./state/geo";
import { closeMenu, menuOpen, dialogOpen } from "./ui/Menu";
import { pops, closePop, closeAllPops, pinPop } from "./state/pop";
import * as A from "./actions";
import { send } from "./host";

const boardEl = () => document.getElementById("board")!;
const local = (e: { clientX: number; clientY: number }) => { const r = boardEl().getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
const worldOf = (e: { clientX: number; clientY: number }) => { const p = local(e); return toWorld(p.x, p.y); };

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

// 双击检测（pointerdown 里 preventDefault 后浏览器的 dblclick 不可靠）
const dbl: { key?: string; t: number } = { t: 0 };
export function isDbl(key: string) {
  const now = performance.now(), r = dbl.key === key && now - dbl.t < 420;
  dbl.key = r ? undefined : key; dbl.t = now;
  return r;
}

// ---------- 卡片 ----------

export function cardPointerDown(e: PointerEvent, id: string) {
  const t = e.target as HTMLElement;
  if (e.button === 1 || (e.button === 0 && spaceDown())) return startPan(e);
  if (e.button !== 0) return;
  if (t.closest("[contenteditable], input, textarea, button, .call:not([data-p]), .no, .grip, .hw, a.lnk, .lport, .eport")) return; // library 调用（data-p）当普通文字
  if (connectFrom()) return finishConnect(e, id);
  if (A.picking()) { e.preventDefault(); e.stopPropagation(); const cb = A.takePick(); const colEl = (e.target as HTMLElement).closest("[data-col]") as HTMLElement | null; cb?.(colEl?.dataset.col ?? id); return; }
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
  if (inHead && t.closest(".ctitle") && isDbl(`t${target}`)) return setEditing({ kind: "title", id: target });
  if (isText && isDbl(`x${id}`)) return setEditing({ kind: "note", id });
  if (e.shiftKey || e.metaKey || e.ctrlKey) { toggleSel("cards", f.host.id); return; }
  if (!isSel(f.host.id)) A.selectCard(f.host.id);
  closeAllPops();
  startCardDrag(e, f.host.id);
}

/** 卡（或 Compare 里一栏）所在那张摆放卡的位置 */
const hostPlace = (b: Board, id: string) => { const h = findCard(b, id)?.host; return h ? b.place[h.id] : undefined; };

function startCardDrag(e: PointerEvent, grabbed: string) {
  const ids = sel.cards.filter((i) => cardById(i) && !A.isLocked(i));
  if (!ids.length) return;
  const skip = new Set(ids);
  const items = ids.map((i) => { const c = placeOf(i); return { id: i, ox: c.x, oy: c.y }; });
  const box = bounds(ids.map((i) => rectOf(cardById(i)!.host)))!;
  const targets = [...placed().filter((c) => !skip.has(c.id)).map((c) => rectOf(c)), ...[...frames().entries()].map(([, r]) => r)];
  const fr = new Map(frames());
  const end = beginGesture();
  const sx = e.clientX, sy = e.clientY;
  let mergeT: number | undefined, mergeTgt: string | undefined;
  const g = cardById(grabbed)!.host;
  const mergeOk = ids.every((i) => { const c = cardById(i)!.card; return c.kind === "code" && !c.members; });
  const noteOk = ids.length === 1 && g.kind === "note" && g.bg;
  setDragging(new Set(ids));
  track(e, (ev) => {
    const z = cam.z;
    let dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
    // 合并 / 变成 Sidenote 的落点
    const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((n) => (n as HTMLElement).closest?.(".card") && !skip.has(((n as HTMLElement).closest(".card") as HTMLElement).dataset.id!)) as HTMLElement | undefined;
    const uc = under?.closest(".card") as HTMLElement | undefined;
    const uid = uc?.dataset.id;
    const head = under?.closest(".chead");
    const row = under?.closest(".src > .l") as HTMLElement | null;
    const ucard = uid ? cardById(uid) : undefined;
    let drop = dropTarget();
    if (mergeOk && uid && head && ucard && isCode(ucard.card) && !ucard.card.members && ucard.host.kind === "code") {
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
    if (!(ev.metaKey || ev.ctrlKey) && !drop) {
      const sn = snapMove({ ...box, x: box.x + dx, y: box.y + dy }, targets, 6 / z);
      dx += sn.dx; dy += sn.dy;
      setGuides(sn.guides);
    } else setGuides([]);
    live((b) => { for (const it of items) { const c = hostPlace(b, it.id); if (c) { c.x = Math.round(it.ox + dx); c.y = Math.round(it.oy + dy); } } });
  }, (ev, moved) => {
    clearTimeout(mergeT);
    setGuides([]);
    setDragging(new Set<string>());
    const drop = dropTarget();
    setDropTarget(null);
    if (!moved) { end(); return; }
    if (drop?.kind === "merge" && drop.armed) {
      live((b) => { for (const it of items) { const c = hostPlace(b, it.id); if (c) { c.x = it.ox; c.y = it.oy; } } });
      end();
      return A.mergeCards([drop.card, ...ids], drop.card);
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
  const targets = state.board.cards.filter((k) => k.id !== id).map((k) => rectOf(k));
  const end = beginGesture();
  const sx = e.clientX, sy = e.clientY;
  const text = c.kind === "note" && !c.bg;
  const minW = text ? 80 : 240, minH = 100;
  track(e, (ev) => {
    const z = cam.z, dx = (ev.clientX - sx) / z, dy = (ev.clientY - sy) / z;
    let w = r0.w, h = r0.h, x = r0.x;
    if (edges.right) w = Math.max(minW, r0.w + dx);
    if (edges.left) { w = Math.max(minW, r0.w - dx); x = r0.x + r0.w - w; }
    if (edges.bottom) h = Math.max(minH, r0.h + dy);
    let hint: string | null = null;
    if (!(ev.metaKey || ev.ctrlKey) && !edges.left) {
      const sn = snapResize({ x, y: r0.y, w, h }, { right: edges.right, bottom: edges.bottom }, targets, 6 / z);
      w = sn.w; h = sn.h;
      setGuides(sn.guides.filter(() => !sn.same));
      if (sn.same === "w") hint = `same width · ${Math.round(w)}`;
      if (sn.same === "h") hint = `same height · ${Math.round(h)}`;
    } else setGuides([]);
    setSizeHint(hint ? { x: x + w / 2, y: r0.y + h + 8, text: hint } : null);
    live((b) => { const k = hostPlace(b, id)!; k.w = Math.round(w); k.x = Math.round(x); if (edges.bottom) k.h = Math.round(h); });
  }, () => { setGuides([]); setSizeHint(null); end(); });
}

/** 卡里滚动：代码区能滚就滚，滚到头或 ⌘ 时交给画布 */
export function cardWheel(e: WheelEvent, el: HTMLElement) {
  if (e.ctrlKey || e.metaKey) return; // 交给画布缩放
  const canY = el.scrollHeight > el.clientHeight + 1, canX = el.scrollWidth > el.clientWidth + 1;
  if (canY || canX) e.stopPropagation();
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
      cands = A.allCodeCandidates(call).filter((id) => cardById(id)?.host.id !== cardById(cardId)?.host.id);
    }
    const a = local({ clientX: from.left, clientY: from.top + from.height / 2 });
    const b = local(ev);
    setRubber({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const ce = under?.closest(".card") as HTMLElement | null;
    const colEl = under?.closest("[data-col]") as HTMLElement | null;
    const tid = colEl?.dataset.col ?? ce?.dataset.id;
    hot = tid && cardById(tid)?.host.id !== cardById(cardId)?.host.id ? tid : undefined;
    setDropTarget(hot ? { kind: "card", card: cardById(hot)!.host.id, cands } : { kind: "cand", card: "", cands });
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

// ---------- Plain link：从行尾圆点 / 卡边圆点拖出 ----------

export function linkPortDown(e: PointerEvent, from: { card: string; seg?: string; line?: number }, sx: number, sy: number) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  let to: { card: string; seg?: string; line?: number } | null = null;
  track(e, (ev) => {
    const a = local({ clientX: sx, clientY: sy }), b = local(ev);
    setRubber({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, plain: true } as any);
    const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    const ce = under?.closest(".card") as HTMLElement | null;
    to = null;
    if (ce && cardById(ce.dataset.id!)) {
      const row = under?.closest(".src > .l") as HTMLElement | null;
      const at = row ? rowAnchor(row, ce.dataset.id!) : null;
      const colEl = under?.closest("[data-col]") as HTMLElement | null;
      to = at ? { card: at.card, seg: at.seg, line: at.lines![0] } : { card: colEl?.dataset.col ?? ce.dataset.id! };
      if (cardById(to.card)?.host.id === cardById(from.card)?.host.id && !to.line) to = null;
    }
    setDropTarget(to ? { kind: to.line ? "line" : "card", card: cardById(to.card)!.host.id, seg: to.seg, line: to.line } : null);
  }, (_ev, moved) => {
    setRubber(null);
    setDropTarget(null);
    if (moved && to) A.addPlain(from, to);
  }, 4);
}

function finishConnect(e: PointerEvent, id: string) {
  e.preventDefault();
  e.stopPropagation();
  const from = connectFrom()!;
  setConnectFrom(null);
  const colEl = (e.target as HTMLElement).closest("[data-col]") as HTMLElement | null;
  const to = colEl?.dataset.col ?? id;
  if (cardById(to)?.host.id === cardById(from.card)?.host.id) return toast("Connect cancelled");
  A.addPlain(from, { card: to });
}

// ---------- 画布 ----------

export function canvasPointerDown(e: PointerEvent) {
  const t = e.target as HTMLElement;
  if (t.closest(".card, .slabel, .lhit, .lmid, .vchips, .alignbar, .pop, .ctx, .dock, .tbar, .bbar, .walkbar")) return;
  (document.activeElement as HTMLElement | null)?.blur?.();
  if (e.button === 1 || (e.button === 0 && spaceDown())) return startPan(e);
  if (e.button !== 0) return;
  if (connectFrom()) { setConnectFrom(null); toast("Connect cancelled"); return; }
  e.preventDefault();
  closeAllPops();
  if (isDbl("canvas")) { const w = worldOf(e); A.newNote({ x: w.x, y: w.y - 12 }, false); return; }
  if (tool === "section") return drawSection(e);
  const base = e.shiftKey ? [...sel.cards] : [];
  if (!e.shiftKey) clearSel();
  window.getSelection()?.removeAllRanges();
  const a = local(e);
  track(e, (ev) => {
    const b = local(ev);
    const m = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    setMarquee(m);
    const w0 = toWorld(m.x, m.y), w1 = toWorld(m.x + m.w, m.y + m.h);
    const hit = placed().filter((c) => {
      if (A.isLocked(c.id) || collapsedHome(placeOf(c.id).section)) return false;
      const r = rectOf(c);
      return r.x < w1.x && r.x + r.w > w0.x && r.y < w1.y && r.y + r.h > w0.y;
    }).map((c) => c.id);
    select({ cards: [...new Set([...base, ...hit])] });
  }, () => setMarquee(null));
}

/** 工具栏 Section：在画布上拖出一个框 */
let tool: "section" | null = null;
export const setTool = (t: "section" | null) => { tool = t; boardEl().classList.toggle("drawing", !!t); if (t) toast("Drag on the canvas to draw a section · Esc to cancel"); else if (toastMsg()?.text.startsWith("Drag on the canvas")) setToastMsg(null); };
function drawSection(e: PointerEvent) {
  const a = worldOf(e);
  const la = local(e);
  track(e, (ev) => {
    const b = local(ev);
    setMarquee({ x: Math.min(la.x, b.x), y: Math.min(la.y, b.y), w: Math.abs(b.x - la.x), h: Math.abs(b.y - la.y) });
  }, (ev, moved) => {
    setMarquee(null);
    setTool(null);
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
    const inside = placed().filter((c) => { const p = center(rectOf(c)); return contains(r, p.x, p.y) && outer.has(placeOf(c.id).section); }).map((c) => c.id);
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
  boardEl().classList.add("panning");
  track(e, (ev) => {
    const now = performance.now(), dt = Math.max(1, now - lt);
    vx = vx * 0.5 + (0.5 * (ev.clientX - lx)) / dt; vy = vy * 0.5 + (0.5 * (ev.clientY - ly)) / dt;
    lt = now; lx = ev.clientX; ly = ev.clientY;
    setCam(o.x + ev.clientX - sx, o.y + ev.clientY - sy, cam.z);
  }, () => {
    boardEl().classList.remove("panning");
    if (performance.now() - lt < 60) fling(vx * 1000, vy * 1000);
  }, 0);
}

/** 滚轮：两指平移；⌘ / 捏合 缩放 */
export function canvasWheel(e: WheelEvent) {
  const t = e.target as HTMLElement;
  if (t.closest(".pop, .ctx, .palette, .keys")) return;
  e.preventDefault();
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
  if (t.closest(".card, .pop, .ctx, .dock, .tbar, .bbar")) return;
  const lk = t.closest("[data-link]") as HTMLElement | null;
  if (lk) return A.linkMenu(lk.dataset.link!, e.clientX, e.clientY);
  const sl = t.closest("[data-sect]") as HTMLElement | null;
  if (sl) return A.sectionMenu(sl.dataset.sect!, e.clientX, e.clientY);
  A.canvasMenu(e.clientX, e.clientY);
}

// ---------- Section 标签：拖动整体移动（卡片、子 Section 一起走） ----------

export function sectionLabelDown(e: PointerEvent, id: string) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  closeAllPops();
  const s = sec(id);
  if (!s) return;
  if (isDbl(`s${id}`)) return setEditing({ kind: "section", id });
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

// ---------- 键盘 ----------

const typing = (e: KeyboardEvent) => { const t = e.target as HTMLElement; return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); };

export function installKeys() {
  window.addEventListener("keydown", (e) => {
    if ((e.key === "Meta" || e.key === "Control")) {
      // 按住 ⌘：正在显示的弹窗固定下来
      for (const p of pops()) if (!p.pinned && (p.pop.kind === "peek" || p.pop.kind === "notes")) pinPop(p.id);
    }
    if (typing(e) || dialogOpen() || paletteOpen()) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key, kl = k.toLowerCase();
    if (mod && state.host.forwardedKeys?.includes(e.shiftKey && kl === "l" ? "shift+l" : kl)) { e.preventDefault(); return; } // 宿主会转回来
    if (k === " " && !mod) { setSpaceDown(true); boardEl().classList.add("space"); e.preventDefault(); return; }
    if (k === "Escape") {
      if (menuOpen()) return closeMenu();
      if (pops().length) return closeAllPops();
      if (keysOpen()) return setKeysOpen(false);
      if (connectFrom()) { setConnectFrom(null); return toast("Connect cancelled"); }
      if (walk()) return A.exitWalk();
      if (tool) return setTool(null);
      if (A.picking()) { A.takePick(); return toast("Cancelled"); }
      clearSel(); window.getSelection()?.removeAllRanges();
      return;
    }
    if (walk()) {
      if (k === "ArrowRight" || k === "ArrowDown" || k === " ") { e.preventDefault(); return A.walkTo(walk()!.i + 1); }
      if (k === "ArrowLeft" || k === "ArrowUp") { e.preventDefault(); return A.walkTo(walk()!.i - 1); }
    }
    if (mod && e.shiftKey && kl === "l") { e.preventDefault(); return A.toggleLock(sel.cards, sel.sections); }
    if (mod && kl === "z") { e.preventDefault(); return void (e.shiftKey ? redo() : undo()); }
    if (mod && kl === "y") { e.preventDefault(); return void redo(); }
    if (mod && kl === "a") { e.preventDefault(); return A.selectAll(); }
    if (mod && kl === "d") { e.preventDefault(); return A.duplicateSel(); }
    if (mod && kl === "k") { e.preventDefault(); return setPaletteOpen({ mode: "all" }); }
    if (mod && k === "0") { e.preventDefault(); return A.fitAll(); }
    if (mod && k === "1") { e.preventDefault(); return zoomAt(1 / camTarget().z); }
    if (mod && (k === "=" || k === "+")) { e.preventDefault(); return zoomAt(1.25); }
    if (mod && k === "-") { e.preventDefault(); return zoomAt(0.8); }
    if (mod && kl === "c") {
      const s = window.getSelection();
      if (s && !s.isCollapsed) return; // 原生复制（CodeBody 的 copy 事件处理）
      const ls = lineSel();
      if (ls) { e.preventDefault(); return A.copyLines(ls); }
      const c = A.selCards().find(isCode);
      if (c) { e.preventDefault(); A.copyCard(c); }
      return;
    }
    if (e.altKey && (e.code === "KeyZ")) { e.preventDefault(); return A.toggleWrap(sel.cards.length ? sel.cards : []); }
    if (mod || e.altKey) return;
    if (k === "Delete" || k === "Backspace") { e.preventDefault(); if (lineSel() && !sel.cards.length) return; return A.deleteSel(); }
    if (k === "!" || (e.shiftKey && e.code === "Digit1")) return A.fitAll();
    if (e.shiftKey && e.code === "Digit2") return A.fitSelection();
    if (k === "?") return setKeysOpen(!keysOpen());
    if (kl === "s") { e.preventDefault(); return A.addSidenoteUI(); }
    if (kl === "h" && lineSel()) { e.preventDefault(); return A.hideLines(lineSel()!); }
    if (kl === "t" || kl === "n") { e.preventDefault(); const p = A.lastPointer(); const w = worldOf({ clientX: p.x, clientY: p.y }); return void A.newNote(w, kl === "n"); }
    if (kl === "p") return A.startWalk();
    if (k === "Enter") {
      const c = A.selCards()[0];
      if (!c) return;
      e.preventDefault();
      if (c.kind === "code") A.openCode(c.id);
      else if (c.kind === "note") setEditing({ kind: "note", id: c.id });
      else if (c.kind === "web") A.openLink(c.url);
    }
    if (k.startsWith("Arrow") && sel.cards.length) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      const dx = k === "ArrowLeft" ? -d : k === "ArrowRight" ? d : 0, dy = k === "ArrowUp" ? -d : k === "ArrowDown" ? d : 0;
      mutate((b) => { for (const id of sel.cards) { const c = hostPlace(b, id); if (c && !A.isLocked(id)) { c.x += dx; c.y += dy; } } });
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") { setSpaceDown(false); boardEl()?.classList.remove("space"); }
  });
  window.addEventListener("blur", () => { setSpaceDown(false); boardEl()?.classList.remove("space"); });
  // 粘贴：图片 → Image 卡；文字 → 按内容判断
  window.addEventListener("paste", (e) => {
    if (typing(e as any)) return;
    const items = [...(e.clipboardData?.items ?? [])];
    const img = items.find((i) => i.type.startsWith("image/"));
    const p = A.lastPointer();
    const w = worldOf({ clientX: p.x, clientY: p.y });
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
    if (text) { e.preventDefault(); A.pasteText(text, w); }
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

export { send, unwrap, cardTitle, union, fitRect, view, camTo, setSel, editing };
export type { Card, Rect, NoteCard };

// 改白板：行（隐藏、高亮、复制）、删除 / 复制卡、卡片属性、Compare、合并 / 拆开、Section。
import { unwrap } from "solid-js/store";
import {
  uid, findCard, isCode, cardTitle, segOf, sortSegments, mergeOverlapping, sameVersion, allCodeCards, colsOf,
  placeChild, besideFree, findFree, bounds, center, contains, canAttach, canExpand, canCompare, removeCards, rebaseSegment, walkOrder, treeOf, descendants, SIB_GAP, GAP,
  copyText, cardRows, versionLabel, varKey, LANGS, classifyPaste, guessLang, estSize, defaultWidth,
  type Board, type Card, type CodeCard, type NoteCard, type CompareCard, type Link, type Section, type Sidenote, type Segment, type Place,
  type WebMeta, type CallSpan, type NewCard, type ExpandResult, type Var, type Rect, type DiffData, type Commit, type SegView, type Anchor, type PeekResult, type KeyAction,
} from "@codeboard/core";
import {
  state, setState, mutate, live, createFresh, isFresh, settleFresh, sel, select, clearSel, lineSel, setLineSel, isSel, flows, cardById, rectOf, sizes, toast, allIds, setShowCollapsed, placeOf, placed,
  type LineSel,
} from "../state/store";
import { camTo, camTarget, ensureVisible, fitRect, fitTop, isVisible, union, viewportCenter, view, toWorld, zoomAt, animate, Spring, reduceMotion } from "../state/camera";
import { notesOf, flash, ping, setEditing, setPopIn, popIn, setWalk, walk, setConnectFrom, setPaletteOpen, toggleShown, setKeysOpen, setHoverVar } from "../state/ui";
import { openMenu, choose, promptText, type Item } from "../ui/Menu";
import { openPop, closePop, pops, updatePop, pinPop, type At } from "../state/pop";
import { send, ask } from "../host";
import { ghostOut } from "../state/ghost";
import { md, inline } from "../md";
import { frameOf, allMembers } from "../state/sections";
import { popCard, revealCard, sectionById, selCards } from "./common";
import { requestViews } from "./create";

export function copyLines(ls: LineSel) {
  const f = cardById(ls.card);
  if (!f || !isCode(f.card)) return;
  const s = segOf(f.card, ls.seg)!;
  const t = copyText(s.text.slice(ls.start - s.start, ls.end - s.start + 1));
  navigator.clipboard?.writeText(t).catch(() => {});
  toast(`Copied ${ls.end - ls.start + 1} line${ls.end > ls.start ? "s" : ""}`);
}
export function hideLines(ls: LineSel) {
  mutate((b) => {
    const c = findCard(b, ls.card)?.card;
    if (!isCode(c)) return;
    const s = segOf(c, ls.seg)!;
    let r: [number, number] = [ls.start, ls.end];
    const keep = (s.hidden ?? []).filter((h) => {
      if (h[1] < r[0] - 1 || h[0] > r[1] + 1) return true;
      r = [Math.min(h[0], r[0]), Math.max(h[1], r[1])];
      return false;
    });
    s.hidden = [...keep, r].sort((a, c2) => a[0] - c2[0]);
  });
  window.getSelection()?.removeAllRanges();
  setLineSel(null);
}
export function toggleHl(ls: LineSel) {
  mutate((b) => {
    const c = findCard(b, ls.card)?.card;
    if (!isCode(c)) return;
    const s = segOf(c, ls.seg)!;
    const ln = Array.from({ length: ls.end - ls.start + 1 }, (_, i) => ls.start + i);
    const all = ln.every((l) => s.hl?.includes(l));
    s.hl = all ? (s.hl ?? []).filter((l) => l < ls.start || l > ls.end) : [...new Set([...(s.hl ?? []), ...ln])];
  });
}


// ---------- 删除 / 复制 ----------

export function deleteSel() {
  const ids = new Set<string>();
  for (const id of sel.cards) { const f = cardById(id); if (f) ids.add(f.host.id); }
  const links = new Set(sel.links);
  const secs = new Set(sel.sections);
  if (!ids.size && !links.size && !secs.size) return;
  ghostOut(ids);
  const ok = mutate((b) => {
    removeCards(b, ids);
    b.links = b.links.filter((l) => !links.has(l.id));
    if (secs.size) dropSections(b, secs);
  });
  if (ok) clearSel();
}
export function deleteLinks(ids: string[]) {
  const s = new Set(ids);
  if (mutate((b) => { b.links = b.links.filter((l) => !s.has(l.id)); })) select({});
}
function dropSections(b: Board, secs: Set<string>) {
  for (const s of b.sections) if (secs.has(s.id)) {
    for (const ch of b.sections) if (ch.parent === s.id && !secs.has(ch.id)) ch.parent = s.parent;
    for (const p of Object.values(b.place)) if (p.section === s.id) p.section = s.parent;
  }
  b.sections = b.sections.filter((s) => !secs.has(s.id));
}
export function removeSections(ids: string[]) { mutate((b) => dropSections(b, new Set(ids))); select({}); }

export function duplicateSel() {
  const cs = selCards().filter((c) => c.kind !== "compare");
  if (!cs.length) return toast("Select a card to duplicate");
  const made: string[] = [];
  mutate((b) => {
    for (const c of cs) {
      const d = structuredClone(unwrap(c)) as Card;
      d.id = uid(d.kind[0]);
      const p0 = b.place[c.id];
      if (d.kind === "code") d.segments.forEach((s) => (s.id = uid("s")));
      b.cards.push(d);
      b.place[d.id] = { ...structuredClone(unwrap(p0)), x: p0.x + 48, y: p0.y + 48, collapsed: undefined, locked: undefined };
      made.push(d.id);
      // 各段的展示数据跟着复制
      if (c.kind === "code" && d.kind === "code") c.segments.forEach((s, i) => { const v = state.views[s.id]; if (v) setState("views", d.segments[i].id, v); });
    }
  });
  select({ cards: made });
  made.forEach((id) => popCard(id));
  toast(made.length > 1 ? `Duplicated ${made.length} cards (no links, no number)` : "Duplicated. The copy has no links and no number.");
}
export function copyCard(c: CodeCard) {
  const rows = cardRows(c, { views: state.views, hideAllComments: state.board.hideAllComments });
  const lines: string[] = [];
  for (const r of rows) if (r.t === "line") { const s = c.segments.find((q) => q.id === r.seg)!; lines.push(s.text[r.line - s.start] ?? ""); }
  navigator.clipboard?.writeText(lines.join("\n")).catch(() => {});
  toast(`Copied ${lines.length} lines`);
}

// ---------- 卡片属性 ----------

export const compareTitle = (c: CompareCard) => cardTitle(c, state.board);
export function renameCard(id: string, v: string) {
  mutate((b) => { const c = findCard(b, id)?.card; if (c) c.title = v.trim() && v.trim() !== cardTitle({ ...c, title: undefined } as Card) ? v.trim() : undefined; });
}
export function setDesc(id: string, v: string) {
  mutate((b) => { const c = findCard(b, id)?.card; if (c) c.desc = v.trim() || undefined; });
}
export function setNoteText(id: string, v: string) {
  const set = (b: Board) => { const c = findCard(b, id)?.card; if (c?.kind === "note") c.md = v; };
  if (isFresh(id)) return settleFresh(id, !!v.trim(), set);
  mutate(set);
  const c = cardById(id)?.card;
  if (c?.kind === "note" && !c.md.trim()) mutate((b) => removeCards(b, [id]));
}
export function setFreeCode(id: string, text: string) {
  let seg: Segment | undefined;
  const set = (b: Board) => {
    const c = findCard(b, id)?.card;
    if (!isCode(c)) return;
    const s = c.segments[0];
    s.text = text.split("\n");
    s.end = s.start + s.text.length - 1;
    seg = structuredClone(unwrap(s));
  };
  if (isFresh(id)) settleFresh(id, !!text.trim(), set);
  else mutate(set);
  if (seg) requestViews([seg]);
}
export function setLang(id: string, lang: string) {
  let seg: Segment | undefined;
  mutate((b) => { const c = findCard(b, id)?.card; if (isCode(c)) { c.segments[0].lang = lang; seg = structuredClone(unwrap(c.segments[0])); } });
  if (seg) requestViews([seg]);
}
export function langMenu(id: string, el: Element) {
  const r = el.getBoundingClientRect();
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  openMenu(LANGS.map((l) => ({ label: l.label, checked: c.segments[0].lang === l.id, run: () => setLang(id, l.id) })), r.left, r.bottom + 4);
}
export function toggleHide(id: string, k: "comments" | "docstrings" | "blank") {
  mutate((b) => { const c = findCard(b, id)?.card; if (isCode(c)) c.hide = { ...c.hide, [k]: !c.hide?.[k] }; });
}
export function toggleWrap(ids: string[]) {
  const cs = ids.map((i) => cardById(i)?.card).filter(isCode);
  if (!cs.length) return;
  const on = !cs.every((c) => c.wrap);
  mutate((b) => { for (const c of cs) { const k = findCard(b, c.id)?.card; if (isCode(k)) k.wrap = on || undefined; } });
}
export function toggleCollapse(id: string) {
  mutate((b) => { const p = b.place[id]; if (p) p.collapsed = !p.collapsed || undefined; });
}
export function toggleLock(cards: string[], sections: string[] = []) {
  const cs = [...new Set(cards.map((i) => cardById(i)?.host.id).filter(Boolean) as string[])];
  const ss = sections.map(sectionById).filter(Boolean) as Section[];
  if (!cs.length && !ss.length) return;
  const on = !(cs.every((c) => placeOf(c).locked) && ss.every((s) => s.locked));
  mutate((b) => {
    for (const c of cs) { const k = b.place[c]; if (k) k.locked = on || undefined; }
    for (const s of ss) { const k = b.sections.find((q) => q.id === s.id); if (k) k.locked = on || undefined; }
  });
  toast(on ? "Locked. It stays put; code inside still works." : "Unlocked");
}
/** 符号找不到时选 Keep Old Version：就当成一张钉死的卡，不再提示 */
export function keepLost(cardId: string) {
  const c = cardById(cardId)?.card;
  if (!isCode(c)) return;
  for (const s of c.segments) if (state.stale[s.id]?.state === "lost" || state.stale[s.id]?.state === "many") setState("stale", s.id, { state: "ok" });
  mutate((b) => { const k = findCard(b, cardId)?.card; if (isCode(k)) k.keepOld = true; });
}
export function missingNote(c: CodeCard): string | null {
  const st = c.segments.map((s) => state.stale[s.id]?.state);
  if (st.includes("missing")) return state.host.readonly ?? "Repository not found. Showing the saved snapshot (read-only).";
  if (st.includes("lost") && !c.keepOld) return "Symbol not found in the current code (deleted or renamed). Showing the saved version.";
  if (st.includes("many") && !c.keepOld) return "This snippet now appears in several places. Showing the saved version.";
  return null;
}


// ---------- Compare ----------

export function compareCheck(): { ok: true } | { ok: false; why: string } {
  const cs = selCards();
  if (cs.length !== 2 || !cs.every((c) => c.kind === "code")) return { ok: false, why: "Select exactly two code cards" };
  const r = canCompare(flows(), cs[0].id, cs[1].id);
  return r.ok ? { ok: true } : { ok: false, why: r.reason };
}
export function doCompare() {
  const chk = compareCheck();
  if (!chk.ok) return toast(chk.why);
  const [p, q] = (selCards() as CodeCard[]).sort((a, b) => placeOf(a.id).x - placeOf(b.id).x);
  const id = uid("k");
  mutate((b) => {
    const pa = b.place[p.id], pc = b.place[q.id];
    // 两栏的卡还在 cards 里，只是不再单独摆放
    const k: CompareCard = { id, kind: "compare", cols: [p.id, q.id] };
    b.cards.push(k);
    b.place[id] = { x: pa.x, y: pa.y, w: Math.min(1280, Math.max(760, pa.w + pc.w)), section: pa.section ?? pc.section };
    delete b.place[p.id]; delete b.place[q.id];
  });
  select({ cards: [id] });
  requestAnimationFrame(() => revealCard(id));
}
export function separate(id: string) {
  const k = cardById(id)?.card;
  if (k?.kind !== "compare") return;
  const ids = [...k.cols];
  mutate((b) => {
    const kp = b.place[id];
    const [a, c] = ids.map((i) => b.cards.find((x) => x.id === i)!);
    // 拆回：左栏在原位，右栏放在它右边
    const wa = defaultWidth(a), wc = defaultWidth(c);
    b.place[a.id] = { x: kp.x, y: kp.y, w: wa, section: kp.section };
    b.place[c.id] = { x: kp.x + wa + 40, y: kp.y, w: wc, section: kp.section };
    b.cards = b.cards.filter((x) => x.id !== id);
    delete b.place[id];
  });
  select({ cards: ids });
}

// ---------- 合并 / 拆开 ----------

export function mergeCheck(cs: Card[]): { ok: true } | { ok: false; why: string } {
  if (cs.length < 2) return { ok: false, why: "Select two or more code cards" };
  if (!cs.every((c) => c.kind === "code" && !c.members)) return { ok: false, why: "Only code cards can be merged (not Note, Image, Web, Compare or class cards)" };
  return { ok: true };
}
/** 合并：target 是被拖到的那张卡（标题、说明、文件顺序以它为准） */
export function mergeCards(ids: string[], target?: string) {
  const cs = ids.map((i) => cardById(i)?.card).filter(Boolean) as Card[];
  const chk = mergeCheck(cs);
  if (!chk.ok) return toast(chk.why);
  const tgt = (cs.find((c) => c.id === target) ?? cs[0]) as CodeCard;
  const others = cs.filter((c) => c !== tgt) as CodeCard[];
  const set = new Set(cs.map((c) => c.id));
  const mid = uid("c");
  let newSegs: Segment[] = [];
  const ok = mutate((b) => {
    const orig = cs.map((c) => structuredClone(unwrap(findCard(b, c.id)!.card)) as CodeCard);
    const T = orig.find((c) => c.id === tgt.id)!;
    const segs = mergeOverlapping(sortSegments(orig.flatMap((c) => c.segments), T.segments[0]?.path));
    // 合并后段 id 变了的，Link / Sidenote 要跟着换：旧段 id → 新段（按文件 + 行找）
    const segFor = (old: Segment, line?: number) => segs.find((s) => s.path === old.path && s.src.kind === old.src.kind && sameVersion(s.version, old.version) && (line === undefined || (line >= s.start && line <= s.end))) ?? segs[0];
    const oldSegs = new Map(orig.flatMap((c) => c.segments.map((s) => [s.id, s] as const)));
    const TP = b.place[T.id];
    const M: CodeCard = {
      id: mid, kind: "code", segments: segs, title: T.title, desc: T.desc, hide: T.hide,
      mergedFrom: orig.flatMap((c) => c.mergedFrom ?? [{ card: c, place: structuredClone(unwrap(b.place[c.id])) }]),
    };
    // 另一张卡的说明转成 Text sidenote 挂在整张卡上
    for (const o of orig) if (o !== T && o.desc) b.sidenotes.push({ id: uid("n"), at: { card: mid }, kind: "text", md: o.desc });
    for (const l of b.links) {
      if (set.has(l.from.card)) {
        const os = l.from.seg ? oldSegs.get(l.from.seg) : undefined;
        l.from = { card: mid, seg: os ? segFor(os, l.from.line).id : undefined, line: l.from.line };
      }
      if (set.has(l.to.card)) l.to = { card: mid };
    }
    b.links = b.links.filter((l) => !(l.from.card === mid && l.to.card === mid));
    for (const n of b.sidenotes) if (set.has(n.at.card)) {
      const os = n.at.seg ? oldSegs.get(n.at.seg) : undefined;
      n.at = { card: mid, seg: os ? segFor(os, n.at.lines?.[0]).id : undefined, lines: n.at.lines };
    }
    b.cards = b.cards.filter((c) => !set.has(c.id));
    for (const i of set) delete b.place[i];
    b.cards.push(M);
    b.place[mid] = { x: TP.x, y: TP.y, w: Math.max(560, ...orig.map((c) => b.place[c.id]?.w ?? 560)), section: TP.section };
    newSegs = structuredClone(segs);
  });
  if (!ok) return;
  // 段 id 没变的直接沿用展示数据；合出来的新段（范围变了）找宿主要
  const fresh = newSegs.filter((s) => { const v = state.views[s.id]; return !v || v.html.length !== s.text.length; });
  requestViews(fresh);
  select({ cards: [mid] });
  requestAnimationFrame(() => revealCard(mid));
  toast(`Merged ${cs.length} cards · ${newSegs.length} segment${newSegs.length > 1 ? "s" : ""}`);
}

/** 拆开：有合并记录就拆回原来的卡（放回原位、Link 回到各自的卡）；没有就按段拆 */
export function unmerge(id: string) {
  const M = cardById(id)?.card;
  if (!isCode(M)) return;
  if (!M.mergedFrom && M.segments.length < 2) return;
  const made: string[] = [];
  const need: Segment[] = [];
  const ok = mutate((b) => {
    const m = findCard(b, id)!.card as CodeCard, mp = b.place[id];
    const f0 = m.mergedFrom?.[0].place;
    const dx = f0 ? mp.x - f0.x : 0, dy = f0 ? mp.y - f0.y : 0;
    const pp: Place[] = [];
    const parts: CodeCard[] = m.mergedFrom
      ? m.mergedFrom.map((o) => { pp.push({ ...structuredClone(unwrap(o.place)), x: o.place.x + dx, y: o.place.y + dy, section: mp.section }); return structuredClone(unwrap(o.card)); })
      : m.segments.map((s, i) => { pp.push({ x: mp.x + i * 40, y: mp.y + i * 40, w: mp.w, section: mp.section }); return { id: uid("c"), kind: "code", segments: [structuredClone(unwrap(s))], hide: m.hide }; });
    // 段的高亮 / 隐藏跟着行走
    for (const p of parts) for (const s of p.segments) {
      const src = m.segments.filter((q) => q.path === s.path && sameVersion(q.version, s.version) && q.start <= s.end && q.end >= s.start);
      s.hl = [...new Set(src.flatMap((q) => q.hl ?? []).filter((l) => l >= s.start && l <= s.end))];
      s.hidden = src.flatMap((q) => q.hidden ?? []).map(([a, c]) => [Math.max(a, s.start), Math.min(c, s.end)] as [number, number]).filter(([a, c]) => a <= c);
      if (!s.hl.length) s.hl = undefined;
      if (!s.hidden.length) s.hidden = undefined;
    }
    const owner = (seg?: string, line?: number) => {
      const ms = m.segments.find((q) => q.id === seg);
      if (!ms) return { card: parts[0].id, seg: undefined as string | undefined };
      for (const p of parts) for (const s of p.segments) if (s.path === ms.path && sameVersion(s.version, ms.version) && (line === undefined ? s.start <= ms.end && s.end >= ms.start : line >= s.start && line <= s.end)) return { card: p.id, seg: s.id };
      return { card: parts[0].id, seg: undefined };
    };
    for (const l of b.links) {
      if (l.from.card === id) { const o = owner(l.from.seg, l.from.line); l.from = { card: o.card, seg: o.seg, line: o.seg ? l.from.line : undefined }; }
      if (l.to.card === id) l.to = { card: parts[0].id };
    }
    for (const n of b.sidenotes) if (n.at.card === id) { const o = owner(n.at.seg, n.at.lines?.[0]); n.at = { card: o.card, seg: o.seg, lines: o.seg ? n.at.lines : undefined }; }
    b.cards = b.cards.filter((c) => c.id !== id);
    delete b.place[id];
    parts.forEach((p, i) => { b.cards.push(p); b.place[p.id] = pp[i]; made.push(p.id); need.push(...p.segments); });
  });
  if (!ok) return;
  requestViews(need.filter((s) => !state.views[s.id]));
  select({ cards: made });
  toast(`Split into ${made.length} cards`);
}

// ---------- Section ----------

export function moveToNewSection(rect?: Rect, parentId?: string) {
  const ids = sel.cards.map((i) => cardById(i)?.host.id).filter(Boolean) as string[];
  const subs = sel.sections.slice();
  if (!ids.length && !subs.length && !rect) return;
  const id = uid("g");
  mutate((b) => {
    const homes = [...new Set(ids.map((i) => b.place[i]?.section))];
    const parent = rect ? parentId : homes.length === 1 ? homes[0] : undefined;
    const r = rect ?? bounds(ids.map((i) => rectOf(i))) ?? { x: 0, y: 0, w: 200, h: 120 };
    b.sections.push({ id, title: "Untitled Section", x: r.x, y: r.y, w: r.w, h: r.h, parent });
    for (const i of ids) if (b.place[i]) b.place[i].section = id;
    for (const q of subs) {
      // 不能把祖先放进自己里面
      let ok = true;
      for (let a: Section | undefined = b.sections.find((s) => s.id === id); a; a = b.sections.find((s) => s.id === a!.parent)) if (a.id === q) ok = false;
      const s = b.sections.find((x) => x.id === q);
      if (ok && s) s.parent = id;
    }
  });
  select({ sections: [id] });
  setEditing({ kind: "section", id });
}
export function toggleSection(id: string) {
  const s0 = sectionById(id);
  if (!s0) return;
  // 折叠前把实际框存下来：标题条放在框的左上角，展开后框不变
  const f = s0.collapsed ? null : frameOf(s0);
  const apply = () => mutate((b) => {
    const s = b.sections.find((q) => q.id === id);
    if (!s) return;
    if (f) Object.assign(s, { x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) });
    s.collapsed = !s.collapsed || undefined;
  });
  const members = allMembers(id).map((c) => c.id);
  const at = f ?? { x: s0.x, y: s0.y };
  const pt = { x: at.x + 10, y: at.y };
  if (reduceMotion() || !members.length) return apply();
  if (s0.collapsed) {
    // 展开：卡片从标题条里弹出来
    apply();
    requestAnimationFrame(() => members.forEach((m) => popCard(m, pt)));
    return;
  }
  // 折叠：卡片收进标题条（往标签缩、变淡），收完再真正折叠（#10）
  const offs = new Map(members.map((m) => { const p = placeOf(m); return [m, { ox: pt.x - p.x, oy: pt.y - p.y }]; }));
  const sp = new Spring(1, 200, 26, 0.02); sp.t = 0;
  animate((dt) => {
    sp.step(dt);
    const done = sp.v < 0.05;
    setPopIn((p) => { const n = { ...p }; for (const [m, o] of offs) { if (done) delete n[m]; else n[m] = { ...o, v: Math.max(0, sp.v) }; } return n; });
    if (done) apply();
    return done;
  });
}
export function renameSection(id: string, v: string) {
  mutate((b) => { const s = b.sections.find((q) => q.id === id); if (s) s.title = v.trim() || "Untitled Section"; });
}


// ---------- 无背景（#39）：Image 默认无背景，Code 可选 ----------

export const noBg = (c: Card) => (c.kind === "image" && !c.bg) || (c.kind === "code" && !!c.nobg);
export function toggleNoBg(id: string) {
  mutate((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind === "image") c.bg = !c.bg || undefined;
    else if (c?.kind === "code") c.nobg = !c.nobg || undefined;
  });
}

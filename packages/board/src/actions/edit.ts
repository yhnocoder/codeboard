import { untrack } from "solid-js";
import { unwrap } from "solid-js/store";
import {
  arrangeCards, makeCompare, overlaps, removeSections as removeSectionsIn, renameTitleRefs, replaceCards, removeLinks, placeCards, mergeCodeCards, unmergeCard, unlinkCard,
  uid, findCard, isCode, cardTitle, segOf,
  bounds, removeCards, SECTION_PAD, GAP,
  copyText, cardRows, guessLang, pythonDialect, defaultWidth,
  type Arrange, type Board, type Card, type CodeCard, type CompareCard, type Section, type Segment,
  type Rect, type NoteCard, type NoteLayout,
} from "@codeboard/core";
import { LANGS, langLabel } from "@codeboard/analysis/langs";
import {
  state, setState, mutate, isFresh, settleFresh, sel, select, clearSel, setLineSel, cardById, hostOf, rectOf, toast, placeOf, sharedOn, collapsedAway,
  type LineSel,
} from "../state/store";
import { animate, Spring, reduceMotion } from "../state/camera";
import { setEditing, setEditEntry, codeTextRange, staged, setStaged } from "../state/ui";
import { foldOf, setFold, setFoldV, setFoldHome, setSkel, unskel, type Fold } from "../state/fold";
import { farAway } from "../state/cull";
import { SKEL_OUT } from "../state/timing";
import { lodOf } from "../state/lodcards";
import { staticTextRange } from "@yhnocoder/markdown";
import { openMenu, type Item } from "../ui/Menu";
import { ghostOut } from "../state/ghost";
import { frameOf, fitFrame, setFitting, allMembers, isHidden, descSections, openUnder, measureShut } from "../state/sections";
import { popCard, revealCard, sectionById, sectionLocked, selCards, isLocked, slideFrom } from "./common";
import { requestViews } from "./create";
import { offerReference } from "./shared";
import { kbd } from "../keymap";
import { ask } from "../host";

/** 最近一次 ⌘C 复制的是哪张卡的哪段字：⌘V 粘回来时放在那张卡旁边（错开一点，允许重叠），不去找空地 */
let lastCopy: { card: string; text: string; n: number } | null = null;
export function pasteNear(text: string): { x: number; y: number } | null {
  if (!lastCopy || lastCopy.text.trim() !== text.trim()) return null;
  const h = cardById(lastCopy.card)?.host;
  if (!h || !state.board.place[h.id]) return null;
  const r = rectOf(h);
  const k = ++lastCopy.n;
  return { x: r.x + 36 * k, y: r.y + 36 * k };
}
export const remember = (card: string, text: string) => { lastCopy = { card, text, n: 0 }; };
export function copyLines(ls: LineSel) {
  const f = cardById(ls.card);
  if (!f || !isCode(f.card)) return;
  const s = segOf(f.card, ls.seg)!;
  const t = copyText(s.text.slice(ls.start - s.start, ls.end - s.start + 1));
  navigator.clipboard?.writeText(t).catch(() => {});
  remember(ls.card, t);
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

export function deleteSel() {
  const ids = new Set<string>();
  for (const id of sel.cards) { const f = cardById(id); if (f && !isHidden(f.host.id)) ids.add(f.host.id); } // 拖调用图标记时连着选上的折叠起来的卡：看不见的不删
  const links = new Set(sel.links);
  const secs = new Set(sel.sections);
  if (!ids.size && !links.size && !secs.size) return;
  ghostOut(ids);
  const ok = mutate((b) => {
    removeCards(b, ids);
    removeLinks(b, links);
    removeSectionsIn(b, secs);
  });
  if (ok) clearSel();
}
/**
 * 显示时在一张卡里选中了一段字再按 ⌫ / Delete：不删卡。Note / Text / Mark 和自由代码卡进入编辑，选上同一段，
 * 再把这个键交给编辑器（和在编辑器里按一样：删掉这段字，编辑器里一步撤销；退出编辑时照常存成一步）。
 * 文件里的代码改不了：什么都不做。没选字、两头不在同一张卡的正文 / 代码里：返回 false（照旧删选中的卡）
 */
export function editTextSel(key: "Backspace" | "Delete"): boolean {
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return false;
  const rg = s.getRangeAt(0);
  const el = (n: Node) => (n instanceof Element ? n : n.parentElement);
  const a = el(rg.startContainer), b = el(rg.endContainer);
  const cardEl = a?.closest<HTMLElement>(".card[data-id]");
  if (!cardEl || cardEl !== b?.closest(".card[data-id]")) return false;
  const id = cardEl.dataset.id!, c = cardById(id)?.card;
  // Note / Text / Mark 的正文（静态 Markdown，还没在编辑）
  const md = a!.closest<HTMLElement>(".md");
  if (c?.kind === "note" && md && md === b!.closest(".md") && md.matches(".nbody, .tx") && !md.classList.contains("editing")) {
    // 数不出来（选区落在了数不到的地方）：只进入编辑，不删字
    const range = staticTextRange(md, rg);
    setEditEntry(range && { kind: "note", id, key, range });
    setEditing({ kind: "note", id });
    return true;
  }
  const src = a!.closest(".src");
  const map = src && src === b!.closest(".src") ? codeTextRange.get(src) : undefined;
  if (c?.kind !== "code" || !map) return false;
  const r = map(rg), seg = r && c.segments.find((x) => x.id === r.seg);
  if (seg?.src.kind === "free" && c.segments.length === 1) {
    setEditEntry({ kind: "free", id, key, from: r!.from, to: r!.to });
    setEditing({ kind: "free", id });
  }
  return true;
}
export function deleteLinks(ids: string[]) {
  const s = new Set(ids);
  if (mutate((b) => removeLinks(b, s))) select({});
}
export function removeSections(ids: string[]) { mutate((b) => removeSectionsIn(b, ids)); select({}); }

/** 图层：卡的叠放顺序就是 b.cards 的顺序（core arrangeCards）。上移 / 下移一层只越过跟它重叠的卡（不重叠的换了也看不出来） */
export function arrange(ids: string[], how: Arrange) {
  const set = new Set(ids.map(hostOf));
  if (!set.size) return;
  const rs = [...set].filter((id) => state.board.place[id]).map((id) => rectOf(id));
  mutate((b) => arrangeCards(b, set, how, (id) => { const r = rectOf(id); return rs.some((m) => overlaps(m, r)); }));
}
/** Forward / Backward with nothing overlapping go all the way, so they change nothing exactly when Front / Back don't */
function atEdge(ids: string[], top: boolean) {
  const set = new Set(ids.map(hostOf)), cards = state.board.cards;
  const n = cards.filter((c) => set.has(c.id)).length;
  const edge = top ? cards.slice(cards.length - n) : cards.slice(0, n);
  return n > 0 && edge.every((c) => set.has(c.id));
}
export const arrangeItem = (ids: () => string[]): Item => {
  const front = atEdge(ids(), true) && "Already in front", back = atEdge(ids(), false) && "Already at the back";
  return {
    label: "Arrange",
    sub: [
      { label: "Bring to Front", kbd: kbd("front"), disabled: front, run: () => arrange(ids(), "front") },
      { label: "Bring Forward", kbd: kbd("forward"), disabled: front, run: () => arrange(ids(), "forward") },
      { label: "Send Backward", kbd: kbd("backward"), disabled: back, run: () => arrange(ids(), "backward") },
      { label: "Send to Back", kbd: kbd("back"), disabled: back, run: () => arrange(ids(), "back") },
    ],
  };
};

/**
 * Tidy Up：宿主排版（core/tidy.ts，ELK 分层布局），有箭头的按调用关系从左往右分列，没箭头的排成行放在下面。一步撤销；卡和线从旧位置滑过去。
 * 锁住的卡不动，当成障碍（别的卡绕开它）。等宿主回答期间卡被拖动或删掉了就不再套用
 */
export async function tidyUp(ids = sel.cards) {
  const hosts = [...new Set(ids.map(hostOf))].filter((id) => state.board.place[id]);
  const free = hosts.filter((id) => !isLocked(id));
  if (free.length < 2) return;
  const inSel = new Set(free);
  const links = state.board.links.map((l) => [hostOf(l.from.card), hostOf(l.to.card)] as [string, string]).filter(([f, t]) => inSel.has(f) && inSel.has(t));
  const cards = free.map((id) => ({ id, ...rectOf(id) }));
  const at = () => JSON.stringify(free.map((id) => [placeOf(id).x, placeOf(id).y]));
  const asked = at();
  const m = await ask("tidy", { cards, links, fixed: hosts.filter(isLocked).map((id) => rectOf(id)) }).catch(() => null);
  if (!m || asked !== at()) return;
  const moved: { id: string; ox: number; oy: number }[] = [];
  for (const [id, p] of Object.entries(m)) { const c = placeOf(id), ox = c.x - p.x, oy = c.y - p.y; if (ox || oy) moved.push({ id, ox, oy }); }
  if (!moved.length) return;
  if (!mutate((b) => { for (const [id, p] of Object.entries(m)) { const c = b.place[id]; if (c) { c.x = p.x; c.y = p.y; } } })) return;
  slideFrom(moved);
}

export function duplicateSel() {
  const cs = selCards().filter((c) => c.kind !== "compare");
  if (!cs.length) return toast("Select a card to duplicate");
  let made: string[] = [];
  mutate((b) => {
    // core placeCards：卡、段换新 id；摆放错开 48，不带折叠、锁定
    const r = placeCards(b, cs.map((c) => ({ card: unwrap(c), place: unwrap(b.place[c.id]) })), { copy: true, at: (p) => ({ ...p, x: p.x + 48, y: p.y + 48 }) });
    made = cs.map((c) => r.cards[c.id]);
    for (const [o, n] of Object.entries(r.segs)) { const v = state.views[o]; if (v) setState("views", n, v); }
  });
  select({ cards: made });
  made.forEach((id) => popCard(id));
  toast(made.length > 1 ? `Duplicated ${made.length} cards (no arrows)` : "Duplicated. The copy has no arrows.");
  offerReference(made.map((id, i) => [id, cs[i].id]));
}
/** 代码卡上看得见的行（复制用） */
export function cardText(c: CodeCard): string[] {
  const lines: string[] = [];
  for (const r of cardRows(c, { views: state.views })) if (r.t === "line") { const s = c.segments.find((q) => q.id === r.seg)!; lines.push(s.text[r.line - s.start] ?? ""); }
  return lines;
}
export function copyCard(c: CodeCard) {
  const lines = cardText(c);
  navigator.clipboard?.writeText(lines.join("\n")).catch(() => {});
  remember(c.id, lines.join("\n"));
  toast(`Copied ${lines.length} lines`);
  return lines.join("\n");
}

export const compareTitle = (c: CompareCard) => cardTitle(c, state.board);
export function renameCard(id: string, v: string) {
  mutate((b) => {
    const c = findCard(b, id)?.card;
    if (!c) return;
    const old = cardTitle(c, b).trim();
    c.title = v.trim() && v.trim() !== cardTitle({ ...c, title: undefined } as Card) ? v.trim() : undefined;
    renameTitleRefs(b, old, cardTitle(c, b).trim()); // 白板上写着 [[旧名]] 的引用跟着改
  });
}
export function setDesc(id: string, v: string) {
  mutate((b) => { const c = findCard(b, id)?.card; if (c) c.desc = v.trim() || undefined; });
}
/** 改 Note 的字；字删光了这张 Note 就删掉（同一步，一次撤销就回来）。layout: the editor changed table widths, row
 *  heights or code wrap (null = all automatic again); left out = unchanged */
export function setNoteText(id: string, v: string, layout?: NoteLayout | null) {
  // 写空了的 Note / Text / Mark 删掉；空的 Box 还是一个框
  const c0 = cardById(id)?.card;
  const keep = !!v.trim() || (c0?.kind === "note" && c0.look === "box");
  const set = (c: NoteCard) => { c.md = v; if (layout !== undefined) c.mdLayout = layout ?? undefined; };
  if (isFresh(id)) return settleFresh(id, keep, (b) => { const c = findCard(b, id)?.card; if (c?.kind === "note") set(c); });
  mutate((b) => { const c = findCard(b, id)?.card; if (c?.kind !== "note") return; if (keep) set(c); else removeCards(b, [id]); });
}
export function setFreeCode(id: string, text: string) {
  let seg: Segment | undefined;
  const set = (b: Board) => {
    const c = findCard(b, id)?.card;
    if (!isCode(c)) return;
    const s = c.segments[0];
    s.text = text.split("\n");
    s.end = s.start + s.text.length - 1;
    // 语言没手选过就跟着内容走（认不出来时不动）
    if (s.src.kind === "free" && !s.src.langPicked) s.lang = detectLang(text) ?? s.lang;
    seg = structuredClone(unwrap(s));
  };
  if (isFresh(id)) settleFresh(id, !!text.trim(), set);
  else mutate(set);
  if (seg) requestViews([seg]);
}
/** Free code 按内容认语言：Python 再细分 Triton / TileLang */
const detectLang = (text: string) => { const g = guessLang(text); return g === "python" ? pythonDialect(text) : g; };
/** lang = null：回到按内容自动识别 */
function setLang(id: string, lang: string | null) {
  let seg: Segment | undefined;
  mutate((b) => {
    const c = findCard(b, id)?.card;
    if (!isCode(c)) return;
    const s = c.segments[0];
    if (s.src.kind === "free") s.src.langPicked = lang ? true : undefined;
    s.lang = lang ?? detectLang(s.text.join("\n")) ?? s.lang;
    seg = structuredClone(unwrap(s));
  });
  if (seg) requestViews([seg]);
}
export function langMenu(id: string, el: Element) {
  const r = el.getBoundingClientRect();
  const c = cardById(id)?.card;
  if (!isCode(c)) return;
  const s = c.segments[0];
  const auto = s.src.kind === "free" ? detectLang(s.text.join("\n")) : null;
  const picked = s.src.kind !== "free" || !!s.src.langPicked;
  openMenu([
    ...(s.src.kind === "free" ? [{ label: auto ? `Auto-detect (${langLabel(auto)})` : "Auto-detect", checked: !picked, run: () => setLang(id, null) }, null] : []),
    ...LANGS.map((l) => ({ label: l.label, checked: picked && s.lang === l.id, run: () => setLang(id, l.id) })),
  ], r.left, r.bottom + 4);
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

export function compareCheck(): { ok: true } | { ok: false; why: string } {
  const cs = selCards();
  if (cs.length !== 2 || !cs.every((c) => c.kind === "code")) return { ok: false, why: "Select exactly two code cards" };
  return { ok: true };
}
export function doCompare() {
  const chk = compareCheck();
  if (!chk.ok) return toast(chk.why);
  const [p, q] = (selCards() as CodeCard[]).sort((a, b) => placeOf(a.id).x - placeOf(b.id).x);
  const id = uid("k");
  mutate((b) => {
    const pa = b.place[p.id], pc = b.place[q.id];
    const section = pa.section ?? pc.section;
    makeCompare(b, id, [p.id, q.id], { x: pa.x, y: pa.y, w: Math.min(1280, Math.max(760, pa.w + pc.w)), ...(section ? { section } : {}) });
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
    // 两栏拆回来时和 Compare 斜得一样
    const tilt = b.cards.find((x) => x.id === id)?.tilt;
    a.tilt = c.tilt = tilt;
    // 连在 Compare 上的箭头、贴在它上面的 Sticker 改到左栏
    replaceCards(b, [id], () => ({ card: a.id }));
  });
  select({ cards: ids });
}

export function mergeCheck(cs: Card[]): { ok: true } | { ok: false; why: string } {
  if (cs.length < 2) return { ok: false, why: "Select two or more code cards" };
  // 类卡也能合：合出来的卡按行号排段、显示源码（不再只列成员），拆开时还原成类卡
  if (!cs.every((c) => c.kind === "code")) return { ok: false, why: "Only code cards can be merged (not Note, Image, Web or Compare cards)" };
  return { ok: true };
}
/** 合并：target 是被拖到的那张卡（标题、说明、文件顺序以它为准）。共享卡先在这块白板上拆成副本，别的白板不受影响（core mergeCodeCards） */
export function mergeCards(ids: string[], target?: string) {
  const cs = ids.map((i) => cardById(i)?.card).filter(Boolean) as Card[];
  const chk = mergeCheck(cs);
  if (!chk.ok) return toast(chk.why);
  const tgt = cs.find((c) => c.id === target) ?? cs[0];
  const linked = cs.filter((c) => sharedOn(c.id) > 1).length;
  let r: ReturnType<typeof mergeCodeCards> = null;
  const ok = mutate((b) => { r = mergeCodeCards(b, cs.map((c) => c.id), tgt.id, { unlink: (id) => sharedOn(id) > 1 }); });
  const m = r as ReturnType<typeof mergeCodeCards>;
  if (!ok || !m) return;
  // 段 id 没变的直接沿用展示数据；合出来的新段（范围变了）找宿主要
  const fresh = m.segments.filter((s) => { const v = state.views[s.id]; return !v || v.html.length !== s.text.length; });
  requestViews(fresh);
  select({ cards: [m.id] });
  requestAnimationFrame(() => revealCard(m.id));
  toast(`Merged ${cs.length} cards · ${m.segments.length} segment${m.segments.length > 1 ? "s" : ""}${linked ? " · linked cards were copied first; other boards keep theirs" : ""}`);
}

/** 拆开：有合并记录就拆回原来的卡（放回原位、Link 回到各自的卡）；没有就按段拆（core unmergeCard） */
export function unmerge(id: string) {
  const M = cardById(id)?.card;
  if (!isCode(M)) return;
  if (!M.mergedFrom && M.segments.length < 2) return;
  if (!state.board.place[id]) return toast("Separate the Compare first");
  let r: ReturnType<typeof unmergeCard> = null;
  const ok = mutate((b) => { r = unmergeCard(b, id); });
  const u = r as ReturnType<typeof unmergeCard>;
  if (!ok || !u) return;
  requestViews(u.segments.filter((s) => !state.views[s.id]));
  select({ cards: u.made });
  toast(`Split into ${u.made.length} cards`);
}

/** 共享卡在这块白板上变成独立副本（Unlink）：换新 id，别的白板和卡库不动 */
export function unlinkShared(id: string) {
  const h = hostOf(id);
  let to = "";
  if (!mutate((b) => { to = unlinkCard(b, h); })) return;
  select({ cards: [to] });
  toast("Unlinked. This board now has its own copy; the other boards keep the linked card.");
}

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
/**
 * Move to Section ▸：选中的卡进这个 Section，整组（相对位置不变）挪到框里第一块空地上（框左上角往下找），从原来的位置飞过去。一步撤销
 */
export function moveToSection(id: string) {
  const s = sectionById(id);
  const ids = [...new Set(sel.cards.map(hostOf))].filter((i) => state.board.place[i] && !isHidden(i));
  if (!s || s.collapsed || !ids.length) return;
  const set = new Set(ids);
  const box = bounds(ids.map((i) => rectOf(i)))!;
  const f = frameOf(s, set);
  const others = state.board.cards.filter((c) => state.board.place[c.id] && !set.has(c.id) && !isHidden(c.id)).map((c) => rectOf(c));
  const to = freeIn(f, box, others);
  const dx = Math.round(to.x - box.x), dy = Math.round(to.y - box.y);
  const from = new Map(ids.map((i) => { const r = rectOf(i); return [i, { x: r.x + r.w / 2, y: r.y + r.h / 2 }]; }));
  mutate((b) => { for (const i of ids) { const p = b.place[i]; p.x += dx; p.y += dy; p.section = id; } });
  requestAnimationFrame(() => { ids.forEach((i) => popCard(i, from.get(i))); revealCard(ids[0], false); });
  toast(`Moved to ${s.title}`);
}
/** 框 f 里能放下 box 的第一块空地（从左上角一行一行往下找）；放不下就放在框里最下面的东西下面（框往下长） */
function freeIn(f: Rect, box: Rect, others: Rect[]): { x: number; y: number } {
  const x0 = f.x + SECTION_PAD.l, y0 = f.y + SECTION_PAD.t, x1 = f.x + f.w - SECTION_PAD.r - box.w, y1 = f.y + f.h - SECTION_PAD.b - box.h;
  const inside = others.filter((o) => overlaps(o, f));
  for (let y = y0; y <= y1; y += 24) for (let x = x0; x <= Math.max(x0, x1); x += 24) if (!inside.some((o) => overlaps({ ...box, x, y }, o, GAP))) return { x, y };
  return { x: x0, y: Math.max(y0, ...inside.map((o) => o.y + o.h + GAP)) };
}
export function toggleSection(id: string) {
  // 正在动：收、放的弹簧还在走时再点一下就从现在的位置掉头；建、拆卡片的那几帧里不管
  const run = running.get(id);
  if (run) return run();
  const s0 = sectionById(id);
  if (!s0) return;
  const was = !!s0.collapsed, open = frameOf(s0);
  // 真正改：折叠前把实际框存下来（折叠后的框在它的左上角，展开后框不变）。动画放完（展开时成员卡建好）才改；
  // 中间别处已经改过（撤销、Reveal 展开）就不再翻回去：only = 现在应该是的样子
  let now = was;
  const commit = (shut: boolean) => {
    if (now === shut) return;
    const only = now;
    now = shut;
    mutate((b) => {
      const s = b.sections.find((q) => q.id === id);
      if (!s || !!s.collapsed !== only) return;
      if (shut) Object.assign(s, { x: Math.round(open.x), y: Math.round(open.y), w: Math.round(open.w), h: Math.round(open.h) });
      s.collapsed = shut || undefined;
    });
  };
  // 跟着收的：所有成员卡（折叠的子 Section 里的也算：连着它们的线要跟着走）；画出来的：展开时看得见的卡、子 Section
  const members = allMembers(id).map((c) => c.id);
  const shown = members.filter((m) => openUnder(placeOf(m).section, id) && !collapsedAway().has(m));
  const kids = descSections(id).filter((k) => openUnder(k.parent, id)).map((k) => k.id);
  if (reduceMotion() || !members.length) return commit(!was);
  // 动画（state/fold.ts）：框、卡、线都跟着同一个弹簧 v 走（1 = 展开着，0 = 折叠好）。先显示折叠的样子（「· N cards」），再量折叠后的框
  const at = was ? { x: s0.x, y: s0.y } : open;
  let fold: Fold = { v: was ? 0 : 1, open, shut: { x: at.x, y: at.y, w: open.w, h: open.h }, tx: at.x, ty: at.y, shutting: !was };
  setFold(id, fold);
  const m = measureShut(id);
  if (m) setFold(id, (fold = { ...fold, shut: { x: at.x, y: at.y, w: m.w, h: m.h }, tx: at.x + m.tx, ty: at.y + m.ty }));
  for (const k of [...members, ...kids]) setFoldHome(k, id);
  for (const k of shown) setSkel(k, "out");
  // 弹簧收得很紧才停（|v − 终点| < 0.001、速度 < 0.01；大的 Section 收到框差不到半个像素）：停下那一帧不跳
  const sp = new Spring(fold.v, 200, 26, Math.min(0.001, 0.5 / Math.max(open.w, open.h)));
  sp.t = was ? 1 : 0;
  // 每帧只在画出来的东西差得出四分之一个像素时才写（框最大的那一边算）：弹簧最后那一段很慢，看不出的变化不用每帧重排、重画
  const q = 0.25 / Math.max(open.w, open.h);
  let drawn = fold.v, back = false;
  const write = (v: number, end: boolean) => { if (end || Math.abs(v - drawn) >= q) { drawn = v; setFoldV(id, v); } };
  // 展开：屏幕附近的成员卡先建好（state/ui.ts staged；v = 0，看不见），一帧几张，都建好了再真正展开、放出来。
  // 离屏幕很远的（整张藏着，看不见）先不建，放完了再一帧一张地建；连着它们的线照样跟着动（不要 DOM）
  const far = new Set(was ? shown.filter((k) => farAway(k) && lodOf(k) === "full") : []);
  const near = shown.filter((k) => !far.has(k));
  // 阶段：建卡（展开）→ 内容换成骨架线（折叠，SKEL_OUT）→ 弹簧 → 拆卡（折叠好了）
  let phase: "build" | "fade" | "spring" | "down" = was ? "build" : "fade";
  let i = 0, t = 0;
  running.set(id, () => {
    if (phase !== "fade" && phase !== "spring") return;
    // 掉头：弹簧接着现在的速度往另一头走；往回折叠的卡重新换成骨架线，往回展开的落到位时内容淡回来
    sp.t = 1 - sp.t;
    const shutting = sp.t === 0;
    setFold(id, { ...untrack(() => foldOf(id))!, shutting });
    if (shutting) { back = false; for (const k of shown) setSkel(k, "out"); }
  });
  const finish = () => {
    for (const k of [...members, ...kids]) setFoldHome(k, undefined);
    setFold(id, undefined);
    running.delete(id);
  };
  animate((dt, instant) => {
    if (phase === "build") {
      if (i < near.length) { for (const k of near.slice(i, (i += STAGE_IN))) setStaged(k, "in"); return false; }
      for (const k of far) setStaged(k, "out");
      commit(false);
      for (const k of near) setStaged(k, undefined);
      phase = "spring";
    }
    if (phase === "fade") {
      if ((t += dt * 1000) < SKEL_OUT && !instant) return false;
      phase = "spring";
    }
    if (phase === "spring") {
      instant ? sp.set(sp.t) : sp.step(dt);
      write(sp.done ? sp.t : sp.v, sp.done);
      // 展开快到位了：内容从骨架线淡回来
      if (sp.t === 1 && !back && (sp.v >= 0.97 || sp.done)) { back = true; unskel(shown); }
      if (!sp.done) return false;
      if (sp.t === 1) {
        commit(false);
        finish();
        if (far.size) animate(() => {
          // 已经又折叠了（撤销）：藏着的不用建，标记清掉；不然一帧建一张
          const left = [...far].filter((k) => staged(k) === "out");
          if (sectionById(id)?.collapsed) { for (const k of left) setStaged(k, undefined); return true; }
          if (left[0]) setStaged(left[0], undefined);
          return left.length <= 1;
        });
        return true;
      }
      // 折叠好了：成员卡停在收完的那一帧（看不见）留着，真正折叠以后一帧几张拆掉
      for (const k of near) setStaged(k, "in");
      commit(true);
      for (const k of far) if (staged(k) === "out") setStaged(k, undefined);
      phase = "down"; i = 0;
      return false;
    }
    for (const k of near.slice(i, (i += STAGE_OUT))) { setStaged(k, undefined); setSkel(k, undefined); }
    if (i < near.length) return false;
    for (const k of far) setSkel(k, undefined);
    finish();
    return true;
  });
}
// 正在折叠、展开的 Section：再点一下时做什么（掉头，或者建、拆卡片的那几帧里不管）
const running = new Map<string, () => void>();
// 一帧建几张、拆几张成员卡：建一张代码卡要 5–10ms（建节点、排版、量行），拆便宜得多
const STAGE_IN = 1, STAGE_OUT = 4;
/** Section 的 Fit Content：框收到刚好包住成员卡和子 Section（标准边距）；缓动过去，一步撤销。折叠的、锁着的、空的不动 */
export function fitSections(ids: string[]) {
  const fits = new Map<string, Rect>();
  for (const id of ids) {
    const s = sectionById(id);
    if (!s || s.collapsed || sectionLocked(s)) continue;
    const r = fitFrame(s);
    if (r) fits.set(id, r);
  }
  if (!fits.size) return;
  if (!reduceMotion()) {
    const me = new Set(fits.keys());
    setFitting(me);
    setTimeout(() => setFitting((f) => (f === me ? new Set<string>() : f)), 320);
  }
  mutate((b) => {
    for (const [id, r] of fits) { const s = b.sections.find((q) => q.id === id); if (s) Object.assign(s, { x: r.x, y: r.y, w: r.w, h: r.h }); }
  });
}
export function renameSection(id: string, v: string) {
  mutate((b) => { const s = b.sections.find((q) => q.id === id); if (s) s.title = v.trim() || "Untitled Section"; });
}

export const noBg = (c: Card) => (c.kind === "image" && !c.bg) || (c.kind === "code" && c.bg === false);
/** 倾斜：选中的几张卡里有没斜的就都斜，都斜着就都放正（Compare 的栏算整张 Compare） */
export function toggleTilt(ids: string[]) {
  const cs = [...new Set(ids.map((i) => cardById(i)?.host.id).filter(Boolean) as string[])];
  if (!cs.length) return;
  const on = !cs.every((i) => cardById(i)?.card.tilt);
  mutate((b) => { for (const i of cs) { const k = findCard(b, i)?.card; if (k) k.tilt = on || undefined; } });
}
/** 卡框开关：图片默认没有，代码卡默认有 */
export function toggleBg(id: string) {
  mutate((b) => {
    const c = findCard(b, id)?.card;
    if (c?.kind === "image") c.bg = !c.bg || undefined;
    else if (c?.kind === "code") c.bg = c.bg === false ? undefined : false;
  });
}

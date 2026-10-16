// 右键 / ⋯ 菜单：卡片、多选、画布、连线、Section、调用、选中的行。
import { unwrap } from "solid-js/store";
import {
  uid, findCard, isCode, cardTitle, segOf, sortSegments, mergeOverlapping, sameVersion, allCodeCards, colsOf,
  placeChild, besideFree, findFree, tidy, bounds, center, contains, canAttach, canExpand, canCompare, removeCards, rebaseSegment, walkOrder, treeOf, descendants, SIB_GAP, GAP,
  copyText, cardRows, versionLabel, varKey, LANGS, classifyPaste, guessLang, estSize, defaultWidth,
  type Board, type Card, type CodeCard, type NoteCard, type CompareCard, type Link, type PlainLink, type TidyDir, type Section, type Sidenote, type Segment, type Place,
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
import { md, inline } from "../md";
import { frameOf } from "../state/sections";
import { K, boardOffset, fitAll, fitContent, openCode, openLink, sectionById, selCards, selectAll, selectCard } from "./common";
import { addPlain, callOn, makeCall, openVars, startConnect } from "./links";
import { addToStudyScope, attachCall, calleeMatches, expandCall, isLibCall, selectFlow, startWalk, tidyFlow } from "./flow";
import { commitMenu } from "./versions";
import { compareCheck, copyCard, copyLines, deleteLinks, deleteSel, doCompare, duplicateSel, hideLines, mergeCards, mergeCheck, moveToNewSection, removeSections, separate, toggleCollapse, toggleHide, toggleHl, toggleLock, toggleSection, toggleWrap, unmerge, toggleNoBg } from "./edit";
import { newFreeCode, newNote, pasteText } from "./create";
import { openAddNote, setNoteBg, showPeek } from "./notes";
import { canLinkList, mergeIntoLinkList, webMenuItems } from "./web";

export function callMenu(cardId: string, segId: string, call: CallSpan, x: number, y: number) {
  selectCard(cardId);
  const f = cardById(cardId)!;
  const cands = allCodeCards(state.board).filter((k) => k.id !== cardId && calleeMatches(k, call));
  const lib = isLibCall(call);
  const el = document.elementFromPoint(x, y)?.closest(".call");
  const items: Item[] = [
    ...(el ? [{ label: "Peek Definition", run: () => showPeek(el, cardId, segId, call.line, call.col, call.name, true) }] : []),
    lib ? { label: "Expand Anyway", kbd: K.alt.endsWith("+") ? `${K.alt}Click` : `${K.alt} Click`, run: () => expandCall(cardId, segId, call) } : { label: "Expand", kbd: "Click", run: () => expandCall(cardId, segId, call) },
    ...(lib ? [{ label: `Add "${call.pkg}" to Study Scope`, run: () => addToStudyScope(call.pkg!) }] : []),
    {
      label: "Link to Existing Card", kbd: "Drag", sub: cands.length ? cands.map((k) => {
        const n = flows().byId.get(k.id);
        const ok = canAttach(state.board, flows(), cardId, k.id);
        return { label: `${n ? n.label + "  " : ""}${cardTitle(k)}`, disabled: ok.ok ? false : ok.reason, run: () => attachCall(cardId, segId, call, k.id) };
      }) : [{ label: "No card for this function on the board", disabled: "Drag the call onto any code card to link it" }],
    },
    null,
    ...lineItems({ card: f.card.id, seg: segId, start: call.line, end: call.line }),
  ];
  openMenu(items, x, y);
}


// ---------- 行 ----------

function lineItems(ls: LineSel): Item[] {
  const f = cardById(ls.card);
  if (!f || !isCode(f.card)) return [];
  const s = segOf(f.card, ls.seg)!;
  const n = ls.end - ls.start + 1;
  const hlAll = Array.from({ length: n }, (_, i) => ls.start + i).every((l) => s.hl?.includes(l));
  return [
    { label: "Hide Lines", kbd: "H", run: () => hideLines(ls) },
    { label: hlAll ? "Remove Highlight" : "Highlight Lines", run: () => toggleHl(ls) },
    { label: "Add Sidenote", kbd: "S", run: () => openAddNote({ card: ls.card, seg: ls.seg, lines: [ls.start, ls.end] }) },
    { label: "Copy", kbd: `${K.mod}C`, run: () => copyLines(ls) },
  ];
}
export function lineMenu(ls: LineSel, x: number, y: number) {
  selectCard(ls.card);
  openMenu(lineItems(ls), x, y);
}

// ---------- 卡片菜单 ----------

export function cardMenu(id: string, x: number, y: number) {
  const f = cardById(id);
  if (!f) return;
  if (!isSel(f.host.id)) selectCard(id);
  if (sel.cards.length + sel.sections.length > 1) return openMenu(multiItems(), x, y);
  const c = f.card;
  const host = f.host;
  const lockItem: Item = { label: placeOf(host.id).locked ? "Unlock" : "Lock", kbd: K.lock, run: () => toggleLock([host.id]) };
  const common: Item[] = [
    { label: "Connect…", run: () => startConnect(c.id) },
    { label: "Move to New Section", run: () => moveToNewSection() },
    lockItem,
  ];
  if (c.kind === "note") return openMenu([
    { label: "Edit", kbd: "Double-click", run: () => setEditing({ kind: "note", id }) },
    { label: c.bg ? "Hide Background" : "Show Background", run: () => setNoteBg(id, !c.bg) },
    null, ...common, null,
    { label: "Delete", kbd: "⌫", run: deleteSel },
  ], x, y);
  if (c.kind === "web" || c.kind === "links") return openMenu([...webMenuItems(c), null, ...common, null, { label: "Duplicate", kbd: `${K.mod}D`, run: duplicateSel }, { label: "Delete", kbd: "⌫", run: deleteSel }], x, y);
  if (c.kind === "image") return openMenu([
    { label: "Background", checked: !!c.bg, run: () => toggleNoBg(id) },
    { label: "Fit Content", kbd: `${K.alt}F`, run: () => fitContent([id]) },
    { label: "Rename", kbd: "Double-click Title", run: () => setEditing({ kind: "title", id }) },
    { label: "Edit Description", run: () => setEditing({ kind: "desc", id }) },
    null, ...common, null,
    { label: "Duplicate", kbd: `${K.mod}D`, run: duplicateSel },
    { label: "Delete", kbd: "⌫", run: deleteSel },
  ], x, y);
  if (c.kind === "compare") {
    const inFlow = c.cols.some((k) => flows().byId.has(k));
    return openMenu([
      { label: "Swap", run: () => mutate((b) => { const k = findCard(b, id)!.card as CompareCard; k.swap = !k.swap; }) },
      { label: "Unified", checked: !!c.unified, run: () => mutate((b) => { const k = findCard(b, id)!.card as CompareCard; k.unified = !k.unified; }) },
      { label: "Hide Same Lines", checked: !!c.hideSame, run: () => mutate((b) => { const k = findCard(b, id)!.card as CompareCard; k.hideSame = !k.hideSame; }) },
      null,
      { label: "Separate", run: () => separate(id) },
      { label: "Walk Through Flow", kbd: "P", disabled: inFlow ? false : "Not in a call flow", run: () => startWalk(c.cols.find((k) => flows().byId.has(k))!) },
      { label: "Move to New Section", run: () => moveToNewSection() },
      lockItem, null,
      { label: "Delete", kbd: "⌫", run: deleteSel },
    ], x, y);
  }
  if (!isCode(c)) return;
  // 代码卡（也可能是 Compare 里的一栏）。分组短一点，Hide*/Wrap 收进 View ▸（#24）
  const col = f.host.id !== c.id;
  const node = flows().byId.get(c.id);
  const hasKids = !!node?.kids.length;
  const ls = lineSel();
  const free = c.segments[0]?.src.kind === "free";
  const anyHidden = c.segments.some((s) => s.hidden?.length);
  const view: Item[] = [
    { label: "Hide Blank Lines", checked: !!c.hide?.blank, run: () => toggleHide(c.id, "blank") },
    { label: "Hide Comments", checked: !!c.hide?.comments, run: () => toggleHide(c.id, "comments") },
    { label: "Hide Docstrings", checked: !!c.hide?.docstrings, run: () => toggleHide(c.id, "docstrings") },
    { label: "Show All Hidden Lines", disabled: !anyHidden, run: () => mutate((b) => { const k = findCard(b, c.id)!.card as CodeCard; k.segments.forEach((s) => (s.hidden = undefined)); }) },
    null,
    { label: "Wrap Lines", kbd: `${K.alt}Z`, checked: !!c.wrap, run: () => toggleWrap([c.id]) },
    ...(col ? [] : [{ label: "No Background", checked: !!c.nobg, run: () => toggleNoBg(c.id) } as Item]),
  ];
  const tidyDir = (d: TidyDir) => ({ label: d === "down" ? "Down" : "Right", checked: state.host.settings.tidy === d, run: () => tidyFlow(c.id, d) } as Item);
  const items: Item[] = [
    ...(free ? [] : [{ label: "Open in Editor", kbd: "↵", run: () => openCode(c.id) } as Item]),
    ...(free || c.segments[0]?.src.kind === "github" ? [] : [
      { label: "Switch Commit…", run: () => { const el = document.querySelector(`.card[data-id="${cardById(c.id)!.host.id}"] .rev`); if (el) commitMenu(c.id, el); } } as Item,
    ]),
    { label: "Rename", kbd: "Double-click Title", run: () => setEditing({ kind: "title", id: c.id }) },
    { label: c.desc ? "Edit Description" : "Add Description", run: () => setEditing({ kind: "desc", id: c.id }) },
    { label: "Add Sidenote", kbd: "S", run: () => (ls?.card === c.id ? openAddNote({ card: ls.card, seg: ls.seg, lines: [ls.start, ls.end] }) : openAddNote({ card: c.id })) },
    null,
    { label: "View", sub: view },
    ...(col ? [] : [{ label: "Fit Content", kbd: `${K.alt}F`, run: () => fitContent(sel.cards.length > 1 ? sel.cards : [c.id]) } as Item]),
    null,
    { label: "Select Flow", disabled: node ? false : "Not in a call flow", run: () => selectFlow(c.id) },
    { label: "Walk Through Flow", kbd: "P", disabled: node ? false : "Not in a call flow", run: () => startWalk(c.id) },
    ...(node ? [{ label: "Tidy Layout", hint: "Rearranges this flow only", sub: [tidyDir("down"), tidyDir("right")] } as Item] : []),
    ...(hasKids ? [{ label: placeOf(c.id).collapsed ? "Expand Subtree" : "Collapse Subtree", run: () => toggleCollapse(c.id) } as Item] : []),
    null,
    ...(col ? [] : [{ label: "Move to New Section", run: () => moveToNewSection() } as Item, lockItem]),
    ...(c.segments.length > 1 || c.mergedFrom ? [{ label: "Unmerge", run: () => unmerge(c.id) } as Item] : []),
    { label: "Copy Code", run: () => copyCard(c) },
    { label: "Duplicate", kbd: `${K.mod}D`, run: duplicateSel },
    { label: "Delete", kbd: "⌫", run: deleteSel },
  ];
  openMenu(items, x, y);
}

function multiItems(): Item[] {
  const cs = selCards();
  const codes = cs.filter((c) => c.kind === "code") as CodeCard[];
  const mc = mergeCheck(cs);
  const cmp = compareCheck();
  const lockAll = cs.every((c) => placeOf(c.id).locked) && sel.sections.every((s) => sectionById(s)?.locked);
  return [
    ...(cs.length === 2 && codes.length === 2 ? [{ label: "Compare", disabled: cmp.ok ? false : cmp.why, run: doCompare } as Item] : []),
    ...(codes.length >= 2 ? [{ label: "Merge into One Card", disabled: mc.ok ? false : mc.why, run: () => mergeCards(sel.cards) } as Item] : []),
    ...(canLinkList(cs) ? [{ label: "Merge into Link List", run: () => mergeIntoLinkList(sel.cards) } as Item] : []),
    { label: "Connect with Plain Link", disabled: cs.length === 2 ? false : "Select exactly two cards", run: () => { const [a, b] = cs; addPlain({ card: a.id }, { card: b.id }); } },
    { label: "Move to New Section", run: () => moveToNewSection() },
    { label: lockAll ? "Unlock" : "Lock", kbd: K.lock, run: () => toggleLock(sel.cards, sel.sections) },
    null,
    { label: "Duplicate", kbd: `${K.mod}D`, run: duplicateSel },
    { label: "Delete", kbd: "⌫", run: deleteSel },
  ];
}

export function canvasMenu(x: number, y: number) {
  const w = toWorld(x - boardOffset().x, y - boardOffset().y);
  openMenu([
    { label: "New Text", kbd: "T", run: () => newNote(w, false) },
    { label: "New Note", kbd: "N", run: () => newNote(w, true) },
    { label: "New Free Code", run: () => newFreeCode(w) },
    { label: "Add Function…", kbd: `${K.mod}K`, run: () => setPaletteOpen({ mode: "code" }) },
    { label: "Paste", kbd: `${K.mod}V`, run: () => navigator.clipboard?.readText().then((t) => pasteText(t, w)).catch(() => toast("Clipboard not available here. Press ⌘V instead.")) },
    null,
    { label: "Select All", kbd: `${K.mod}A`, run: selectAll },
    { label: "Fit to Window", kbd: `${K.shift}1`, run: fitAll },
    null,
    { label: "Hide All Comments", checked: !!state.board.hideAllComments, run: () => mutate((b) => { b.hideAllComments = !b.hideAllComments; }) },
    { label: "Hide Flow Numbers", checked: !!state.board.hideNumbers, run: () => mutate((b) => { b.hideNumbers = !b.hideNumbers; }) },
  ], x, y);
}


export function linkMenu(id: string, x: number, y: number) {
  const L = state.board.links.find((l) => l.id === id);
  if (!L) return;
  select({ links: [id] });
  const set = (f: (l: Link) => void) => mutate((b) => { const l = b.links.find((k) => k.id === id); if (l) f(l); });
  const edit: Item = { label: L.label ? "Edit Label" : "Add Label", kbd: "Double-click", run: () => setEditing({ kind: "label", id }) };
  const del: Item = { label: "Delete Arrow", kbd: "⌫", run: () => deleteLinks([id]) };
  if (L.kind === "call") return openMenu([edit, { label: "Variables…", run: () => openVars(id) }, null, del], x, y);
  if (L.kind !== "plain") return;
  const P = L;
  const setP = (f: (l: PlainLink) => void) => set((l) => { if (l.kind === "plain") f(l); });
  openMenu([
    edit,
    ...(callOn(P.from, P.to) ? [{ label: "Make Call", hint: "This line calls the target function", run: () => makeCall(id) } as Item, null] : []),
    { label: "Head", sub: ([["none", "None"], ["end", "One-way  →"], ["both", "Both  ↔"]] as const).map(([v, lb]) => ({ label: lb, checked: (P.arrow ?? "none") === v, run: () => setP((l) => { l.arrow = v; }) })) },
    { label: "Style", sub: [{ label: "Dashed", checked: !P.solid, run: () => setP((l) => { l.solid = false; }) }, { label: "Solid", checked: !!P.solid, run: () => setP((l) => { l.solid = true; }) }] },
    { label: "Color", sub: LINK_COLORS.map(([v, lb]) => ({ label: lb, checked: (P.color ?? "grey") === v, run: () => setP((l) => { l.color = v === "grey" ? undefined : v; }) })) },
    null, del,
  ], x, y);
}
export const LINK_COLORS = [["grey", "Grey"], ["orange", "Orange"], ["blue", "Blue"], ["green", "Green"]] as const;
export const SECTION_COLORS = [["none", "None"], ["sand", "Warm Sand"], ["blue", "Light Blue"], ["green", "Light Green"], ["pink", "Light Pink"]] as const;

export function sectionMenu(id: string, x: number, y: number) {
  const s = sectionById(id);
  if (!s) return;
  if (!sel.sections.includes(id)) select({ sections: [id] });
  const set = (f: (q: Section) => void) => mutate((b) => { const q = b.sections.find((k) => k.id === id); if (q) f(q); });
  openMenu([
    { label: "Rename", kbd: "Double-click", run: () => setEditing({ kind: "section", id }) },
    { label: s.collapsed ? "Expand" : "Collapse", run: () => toggleSection(id) },
    { label: s.locked ? "Unlock" : "Lock", kbd: K.lock, run: () => toggleLock([], [id]) },
    ...(s.parent ? [{ label: "Move Out of Parent Section", run: () => set((q) => { q.parent = sectionById(q.parent)?.parent; }) } as Item] : []),
    { label: "Color", sub: SECTION_COLORS.map(([v, lb]) => ({ label: lb, checked: (s.color ?? "none") === v, run: () => set((q) => { q.color = v === "none" ? undefined : v; }) })) },
    null,
    { label: "Remove Section", hint: "Cards and inner sections stay", run: () => removeSections([id]) },
  ], x, y);
}


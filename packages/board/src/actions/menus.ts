// 右键 / ⋯ 菜单：卡片、多选、画布、连线、Section、调用、选中的行。
import {
  findCard, isCode, cardTitle, segOf, allCodeCards,
  walkOrder,
  headOf,
  type CodeCard, type CompareCard, type LinkSide, type Section,
  type CallSpan,
} from "@codeboard/core";
import { state, mutate, sel, select, lineSel, isSel, flows, cardById, toast, placeOf, sharedOn, type LineSel } from "../state/store";
import { toWorld } from "../state/camera";
import { setEditing, setPaletteOpen } from "../state/ui";
import { openMenu, type Item } from "../ui/Menu";
import { K, boardOffset, fitAll, fitContent, openCode, openLink, sectionById, selCards, selectAll, selectCard } from "./common";
import { addLink, callOn, manualCall, openVars, setLinkEditing, setLinkStyle, setLinkSide, clearLinkSides, toggleCallMark, toggleLoopMark, resetLabelPos, deleteLabel } from "./links";
import { addToStudyScope, attachCall, calleeMatches, expandCall, expandedTo, isLibCall, openMarkPicker, selectFlow, startWalk } from "./flow";
import { jumpTo } from "./nav";
import { searchAllLangs, drawManual, addGenerated } from "./chains";
import { compareCheck, copyLines, deleteLinks, deleteSel, doCompare, duplicateSel, hideLines, mergeCards, mergeCheck, moveToNewSection, removeSections, separate, toggleCollapse, toggleHide, toggleHl, toggleLock, toggleSection, toggleWrap, unmerge, toggleNoBg, arrangeItem } from "./edit";
import { newFreeCode, newNote, pasteText, cardFromLines } from "./create";
import { openAddNote, setNoteBg, showPeek } from "./notes";
import { canLinkList, mergeIntoLinkList, retryMeta, setListRich, setWebStyle } from "./web";
import { unlinkShared } from "./edit";
import { deleteEverywhere, pasteFromBoard, copyCardsSel } from "./shared";
import { enterFrame, turnIntoBoard, insertBoard, insertable, deleteFrameBoard } from "./subboards";
import { addProc, clearRpc, legendOf, markRpc, setLegendOpen, toggleBack, toggleStart } from "./calls";
import { askQuestion, askQuestionOnCard } from "./questions";
import { addVariantMenu } from "./variants";
import { LEGEND, legendName, type Link } from "@codeboard/core";

/**
 * 删除那一组：共享卡（在别的白板上也有）分成「从这块白板移除」（⌫）和「全部删掉」（⌘⌫，要确认），再加 Unlink；
 * 普通卡就是 Delete
 */
function deleteItems(id: string): Item[] {
  const n = sharedOn(id);
  if (n < 2) return [{ label: "Delete", kbd: "⌫", danger: true, run: deleteSel }];
  const c = cardById(id)?.card;
  return [
    { label: `${c ? cardTitle(c, state.board) : "Card"} · on ${n} boards`, head: true },
    { label: "Remove from This Board", kbd: "⌫", run: deleteSel },
    { label: "Delete Everywhere…", kbd: `${K.mod}⌫`, danger: true, run: () => void deleteEverywhere([id]) },
    null,
    { label: "Unlink (Make This a Copy)", run: () => unlinkShared(id) },
  ];
}

export function callMenu(cardId: string, segId: string, call: CallSpan, x: number, y: number) {
  selectCard(cardId);
  const f = cardById(cardId)!;
  const cands = allCodeCards(state.board).filter((k) => k.id !== cardId && calleeMatches(k, call));
  const lib = isLibCall(call);
  const el = document.elementFromPoint(x, y)?.closest(".call");
  const had = expandedTo(cardId, segId, call);
  const items: Item[] = [
    ...(el ? [{ label: "Peek Definition", run: () => showPeek(el, cardId, segId, call.line, call.col, call.name, true) }] : []),
    // 已经展开过：点 = 跳到那张卡（Go to），要再建一张用 Expand Again（W01 B 7）
    ...(had ? [
      { label: `Go to ${cardTitle(cardById(had)!.card, state.board)}`, kbd: "Click", run: () => jumpTo(had) },
      { label: "Expand Again", hint: "Makes a second card for this call", run: () => expandCall(cardId, segId, call, undefined, undefined, true) },
    ] as Item[] : [lib ? { label: "Expand Anyway", kbd: K.alt.endsWith("+") ? `${K.alt}Click` : `${K.alt} Click`, run: () => expandCall(cardId, segId, call) } : { label: "Expand", kbd: "Click", run: () => expandCall(cardId, segId, call) }]),
    ...(lib ? [{ label: `Add "${call.pkg}" to Study Scope`, run: () => addToStudyScope(call.pkg!) }] : []),
    {
      label: "Link to Existing Card", kbd: "Drag", sub: cands.length ? cands.map((k) => {
        const n = flows().byId.get(k.id);
        return { label: `${n?.label ? n.label + "  " : ""}${cardTitle(k)}`, run: () => attachCall(cardId, segId, call, k.id) };
      }) : [{ label: "No card for this function on the board", disabled: "Drag the call onto any code card to link it" }],
    },
    // 解析不到的调用（字符串注册、跨语言）：按名字搜，或手动补一条 Call 箭头（线框 01 二）
    { label: `Search “${call.name}” in All Languages`, run: () => searchAllLangs(cardId, segId, call) },
    { label: "Draw Call Arrow Manually…", run: () => drawManual(cardId, segId, call) },
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
    // 疑问（线框 06）：在第一行贴「?」并直接写问题
    { label: "Ask a Question", run: () => askQuestion({ card: ls.card, seg: ls.seg, line: ls.start }) },
    { label: "New Card from Lines", run: () => cardFromLines(ls) },
    // 生成的代码 / 编译产物：钉在一次运行上，点线连回这一行（线框 02 三）
    { label: "Add Generated Code", sub: genItems({ card: ls.card, seg: ls.seg, line: ls.start }) },
    { label: "Copy", kbd: `${K.mod}C`, run: () => copyLines(ls) },
  ];
}
const genItems = (at: { card: string; seg?: string; line?: number }): Item[] => [
  { label: "Paste from Clipboard", run: () => addGenerated(at, "clipboard") },
  { label: "Choose File…", run: () => addGenerated(at, "file") },
];
/** 右键代码行 / 行号：行的操作，整张卡的菜单在最后的 Card ▸ 里 */
export function lineMenu(ls: LineSel, x: number, y: number) {
  selectCard(ls.card);
  openMenu([...lineItems(ls), null, { label: "Card", sub: cardItems(ls.card, x, y) }], x, y);
}

// ---------- 卡片菜单 ----------

export function cardMenu(id: string, x: number, y: number) {
  const items = cardItems(id, x, y);
  if (items.length) openMenu(items, x, y);
}
/** 卡片菜单的项（行菜单里的 Card ▸ 也用它）；x、y：再弹出的子菜单（Add Variant…）的位置 */
function cardItems(id: string, x: number, y: number): Item[] {
  const f = cardById(id);
  if (!f) return [];
  if (!isSel(f.host.id)) selectCard(id);
  if (sel.cards.length + sel.sections.length > 1) return multiItems();
  const c = f.card;
  const host = f.host;
  const lockItem: Item = { label: placeOf(host.id).locked ? "Unlock" : "Lock", kbd: K.lock, run: () => toggleLock([host.id]) };
  // 每种卡同一个结构：常用操作 → Edit ▸ → Arrange ▸ → 分隔线 → Move to New Section、Delete（红）。
  // 界面上已经有的（双击改名、⌘D、拖圆点连线）不进菜单
  const tail: Item[] = [
    arrangeItem(() => [host.id]),
    null,
    { label: "Move to New Section", run: () => moveToNewSection() },
    turnItem(),
    ...deleteItems(host.id),
  ];
  // 子白板框：打开、移除框（白板还在侧栏里）、删掉那块白板
  if (c.kind === "board") return [
    { label: "Open", kbd: `${K.mod}↵`, run: () => enterFrame(id) },
    { label: "Edit", sub: [lockItem] },
    arrangeItem(() => [host.id]),
    null,
    { label: "Move to New Section", run: () => moveToNewSection() },
    { label: "Remove from This Board", kbd: "⌫", hint: "The board stays in the sidebar", run: deleteSel },
    { label: "Delete Board…", danger: true, run: () => void deleteFrameBoard(id) },
  ];
  if (c.kind === "note" && c.msg) return [
    { label: "Rename", kbd: "Double-click", run: () => setEditing({ kind: "title", id }) },
    { label: "Process Tag…", run: () => void addProc(id) },
    { label: "Start Card", checked: !!placeOf(id).start, run: () => toggleStart(id) },
    ...tail,
  ];
  if (c.kind === "note") return [
    { label: c.bg ? "Hide Background" : "Show Background", run: () => setNoteBg(id, !c.bg) },
    { label: "Edit", sub: [{ label: "Text", kbd: "Double-click", run: () => setEditing({ kind: "note", id }) }, lockItem] },
    ...tail,
  ];
  if (c.kind === "web") return [
    { label: "Open in Browser", kbd: "Double-click", run: () => openLink(c.url) },
    { label: "Refresh Preview", run: () => retryMeta(c.id) },
    { label: "Edit", sub: [
      { label: "Title", run: () => setEditing({ kind: "title", id: c.id }) },
      { label: "Description", run: () => setEditing({ kind: "desc", id: c.id }) },
      lockItem,
    ] },
    { label: "View", sub: ([[undefined, "Auto"], ["banner", "Image on Top"], ["side", "Image on Side"], ["text", "No Image"], ["compact", "Compact"]] as const).map(([s, label]) =>
      ({ label, checked: c.style === s, run: () => setWebStyle(c.id, s) })) },
    ...tail,
  ];
  if (c.kind === "links") return [
    { label: "Open All in Browser", run: () => c.items.forEach((it) => openLink(it.url)) },
    { label: "View", sub: [
      { label: "Compact", checked: !c.rich, run: () => setListRich(c.id, false) },
      { label: "Rich", checked: !!c.rich, run: () => setListRich(c.id, true) },
    ] },
    { label: "Edit", sub: [{ label: "Title", kbd: "Double-click Title", run: () => setEditing({ kind: "title", id: c.id }) }, lockItem] },
    ...tail,
  ];
  if (c.kind === "image") return [
    { label: "Fit Content", kbd: `${K.alt}F`, run: () => fitContent([id]) },
    { label: "Background", checked: !!c.bg, run: () => toggleNoBg(id) },
    { label: "Edit", sub: [
      { label: c.desc ? "Description" : "Add Description", run: () => setEditing({ kind: "desc", id }) },
      lockItem,
    ] },
    ...tail,
  ];
  if (c.kind === "compare") {
    const canWalk = walkOrder(state.board, id).length > 1;
    return [
      { label: "Swap", run: () => mutate((b) => { const k = findCard(b, id)!.card as CompareCard; k.swap = !k.swap; }) },
      { label: "Unified", checked: !!c.unified, run: () => mutate((b) => { const k = findCard(b, id)!.card as CompareCard; k.unified = !k.unified; }) },
      { label: "Hide Same Lines", checked: !!c.hideSame, run: () => mutate((b) => { const k = findCard(b, id)!.card as CompareCard; k.hideSame = !k.hideSame; }) },
      null,
      { label: "Separate", run: () => separate(id) },
      { label: "Walk Through", kbd: "P", disabled: canWalk ? false : "No arrows go out of this card", run: () => startWalk(id) },
      { label: "Move to New Section", run: () => moveToNewSection() },
      lockItem, arrangeItem(() => [host.id]), null,
      ...deleteItems(host.id),
    ];
  }
  if (!isCode(c)) return [];
  // 代码卡（也可能是 Compare 里的一栏）。分组短一点，Hide*/Wrap 收进 View ▸（#24）
  const col = f.host.id !== c.id;
  const node = flows().byId.get(c.id);
  const hasKids = flows().kids.has(c.id);
  const canWalk = walkOrder(state.board, c.id).length > 1;
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
  // 界面上已经有的（双击标题改名、标题栏的 commit 按钮、Copy Code 图标、⌘D）不进菜单。先这样分组，用一阵看哪些高频再拿出来
  const edit: Item[] = [
    { label: c.desc ? "Description" : "Add Description", run: () => setEditing({ kind: "desc", id: c.id }) },
    { label: "Add Sidenote", kbd: "S", run: () => (ls?.card === c.id ? openAddNote({ card: ls.card, seg: ls.seg, lines: [ls.start, ls.end] }) : openAddNote({ card: c.id })) },
    { label: "Ask a Question", run: () => (ls?.card === c.id ? askQuestion({ card: ls.card, seg: ls.seg, line: ls.start }) : askQuestionOnCard(c.id)) },
    { label: "Add Generated Code", sub: genItems(ls?.card === c.id ? { card: c.id, seg: ls.seg, line: ls.start } : { card: c.id }) },
    ...(col ? [] : [lockItem]),
    ...(!col && (c.segments.length > 1 || c.mergedFrom) ? [{ label: "Unmerge", run: () => unmerge(c.id) } as Item] : []),
    null,
    // 进程标签（线框 03）：自由文字；线程 / CUDA stream 用浅一点的标签
    { label: "Process Tag…", hint: "rank 0, rank 1…N, Scheduler × TP", run: () => void addProc(c.id) },
    { label: "Thread / Stream Tag…", run: () => void addProc(c.id, true) },
  ];
  const flow: Item[] = [
    // 起点卡（线框 12）：不选卡直接 Walkthrough、调用树从这里开始
    { label: "Start Card", checked: !!placeOf(host.id).start, hint: "Walkthrough with nothing selected starts here", run: () => toggleStart(c.id) },
    null,
    { label: "Select", disabled: node ? false : "Not in a call graph", run: () => selectFlow(c.id) },
    { label: "Walk Through", kbd: "P", disabled: canWalk ? false : "No arrows go out of this card", run: () => startWalk(c.id) },
    { label: placeOf(c.id).collapsed ? "Expand" : "Collapse", disabled: hasKids || placeOf(c.id).collapsed ? false : "No calls below this card", run: () => toggleCollapse(c.id) },
    { label: "Change Mark…", disabled: node ? false : "Not in a call graph", run: () => openMarkPicker(c.id) },
  ];
  const items: Item[] = [
    ...(free ? [] : [{ label: "Open in Editor", kbd: "↵", run: () => openCode(c.id) } as Item]),
    ...(col ? [] : [{ label: "Fit Content", kbd: `${K.alt}F`, run: () => fitContent(sel.cards.length > 1 ? sel.cards : [c.id]) } as Item]),
    { label: "Edit", sub: edit },
    { label: "View", sub: view },
    // 我的改动（线框 07）：同一段代码的分支 / 工作区 / 另一个 worktree / 复制的文件 / PR
    ...(free || col || c.gen ? [] : [{ label: c.variants?.length ? "Add Another Variant…" : "Add Variant…", run: () => void addVariantMenu(c.id, x, y) } as Item]),
    { label: "Call Graph", sub: flow },
    ...(col ? [] : [arrangeItem(() => [host.id])]),
    null,
    ...(col ? [] : [{ label: "Move to New Section", run: () => moveToNewSection() } as Item, turnItem()]),
    ...deleteItems(host.id),
  ];
  return items;
}

/** 选中的卡变成一块子白板（线框 05 ④） */
const turnItem = (): Item => ({ label: "Turn into Board…", kbd: `${K.mod}${K.shift}B`, run: () => void turnIntoBoard() });

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
    { label: "Connect with Arrow", disabled: cs.length === 2 ? false : "Select exactly two cards", run: () => { const [a, b] = cs; addLink({ card: a.id }, { card: b.id }); } },
    { label: "Move to New Section", run: () => moveToNewSection() },
    turnItem(),
    { label: lockAll ? "Unlock" : "Lock", kbd: K.lock, run: () => toggleLock(sel.cards, sel.sections) },
    arrangeItem(() => [...sel.cards]),
    null,
    { label: "Copy", kbd: `${K.mod}C`, run: () => copyCardsSel() },
    { label: "Duplicate", kbd: `${K.mod}D`, run: duplicateSel },
    { label: cs.some((c) => sharedOn(c.id) > 1) ? "Remove from This Board" : "Delete", kbd: "⌫", danger: !cs.some((c) => sharedOn(c.id) > 1), run: deleteSel },
  ];
}

export function canvasMenu(x: number, y: number) {
  const w = toWorld(x - boardOffset().x, y - boardOffset().y);
  openMenu([
    { label: "New Text", kbd: "T", run: () => newNote(w, false) },
    { label: "New Note", kbd: "N", run: () => newNote(w, true) },
    { label: "New Code", run: () => newFreeCode(w) },
    { label: "Add Function…", kbd: `${K.mod}K`, run: () => setPaletteOpen({ mode: "code" }) },
    // 复制的是别的白板上的卡：默认贴成共享卡（设置里可以换），⌥ 是另一种
    ...(state.host.clip && state.host.clip.board !== state.board.id ? [
      { label: state.host.settings?.pasteOther === "copy" ? "Paste as Copy" : "Paste as Linked Card", kbd: `${K.mod}V`, run: () => void pasteFromBoard(undefined, w) },
      { label: state.host.settings?.pasteOther === "copy" ? "Paste as Linked Card" : "Paste as Copy", kbd: `${K.alt}${K.mod}V`, run: () => void pasteFromBoard(undefined, w, true) },
    ] as Item[] : [
      { label: "Paste", kbd: `${K.mod}V`, run: () => navigator.clipboard?.readText().then((t) => pasteText(t, w)).catch(() => toast("Clipboard not available here. Press ⌘V instead.")) } as Item,
    ]),
    { label: "Insert Board", sub: insertable().length ? insertable().map((m) => ({ label: m.name, hint: m.why ? `Can’t: ${m.why}` : undefined, run: () => insertBoard(m.id, w) })) : [{ label: "No other boards yet", disabled: "Create another board first" }] },
    null,
    { label: "Select All", kbd: `${K.mod}A`, run: selectAll },
    { label: "Fit to Window", kbd: `${K.shift}1`, run: fitAll },
  ], x, y);
}


/** 箭头右键（W01 D 22、24、25）：Call 标记、线的样子、两端进出边、标签、删除 */
export function linkMenu(id: string, x: number, y: number) {
  const L = state.board.links.find((l) => l.id === id);
  if (!L) return;
  select({ links: [id] });
  const hd = headOf(L);
  const width = L.style?.width ?? 2;
  const color = L.style?.color ?? "grey";
  const head = (end: "start" | "end"): Item[] => [
    { label: "Arrowhead", checked: hd[end], run: () => setLinkStyle(id, (s) => { s.head = { ...s.head, [end]: true }; }) },
    { label: "None", checked: !hd[end], run: () => setLinkStyle(id, (s) => { s.head = { ...s.head, [end]: false }; }) },
  ];
  const sides = (end: "from" | "to"): Item[] => {
    const cur = L.sides?.[end];
    const whole = L[end].line === undefined;
    const opts = [[undefined, "Auto"], ["left", "Left"], ["right", "Right"], ...(whole ? [["top", "Top"], ["bottom", "Bottom"]] : [])] as [LinkSide | undefined, string][];
    return opts.map(([v, lb]) => ({ label: lb, checked: cur === v, run: () => setLinkSide(id, end, v) }));
  };
  // Call Mark：出发行确实调用了目标卡时自动认出；认不出时代码卡之间也能手动标（已经有的总能关掉）
  const found = !L.call && !!callOn(L.from, L.to);
  const canCall = !!L.call || found || !!manualCall(L.from, L.to);
  openMenu([
    ...(canCall ? [{ label: "Call Mark", checked: !!L.call, hint: L.call ? "Turning it off hides the arguments and ↺; your text stays" : found ? "This line calls the target function" : "Mark this arrow as a call", run: () => toggleCallMark(id) } as Item] : []),
    // 跨进程（线框 03）：RPC 也是线上的标记；↩ back to = 回到起点的线
    { label: L.rpc ? "Edit RPC…" : "Mark as RPC…", run: () => markRpc(id) },
    ...(L.rpc ? [{ label: "Remove RPC Mark", run: () => clearRpc(id) } as Item] : []),
    { label: "↩ Back to Start", checked: !!L.back, hint: "A return path: Walkthrough stops here", run: () => toggleBack(id) },
    null,
    { label: "Style", sub: styleItems(L) },
    { label: "Line", sub: [
      { label: "Solid", checked: !L.style?.dash, run: () => setLinkStyle(id, (s) => { delete s.dash; }) },
      { label: "Dashed", checked: !!L.style?.dash, run: () => setLinkStyle(id, (s) => { s.dash = true; }) },
    ] },
    { label: "Width", sub: ([[1, "Thin 1px"], [2, "Regular 2px"], [3, "Bold 3px"]] as const).map(([v, lb]) => ({ label: lb, checked: width === v, run: () => setLinkStyle(id, (s) => { s.width = v; }) })) },
    { label: "Start", sub: head("start") },
    { label: "End", sub: head("end") },
    { label: "Color", sub: LINK_COLORS.map(([v, lb]) => ({ label: lb, checked: color === v, run: () => setLinkStyle(id, (s) => { s.color = v === "grey" ? undefined : v; }) })) },
    null,
    { label: "Start Side", sub: sides("from") },
    { label: "End Side", sub: sides("to") },
    { label: "Reset Sides", disabled: L.sides ? false : "Both ends pick their side automatically", run: () => clearLinkSides(id) },
    null,
    { label: L.label ? "Edit Label" : "Add Label", kbd: "Double-click", run: () => setLinkEditing(id) },
    null,
    { label: "Delete", kbd: "⌫", danger: true, run: () => deleteLinks([id]) },
  ], x, y);
}

/**
 * Style ▸（线框 12 三）：图例里的几种样式，名字是这块白板的图例。只是挑个样式，不加规则：
 * Call / See also / RPC 能直接换；Observed 来自一次运行，Generated from 来自 Add Generated Code，只显示
 */
function styleItems(L: Link): Item[] {
  const cur = legendOf(L);
  const id = L.id;
  const canCall = !!L.call || !!callOn(L.from, L.to) || !!manualCall(L.from, L.to);
  const run: Record<string, Item> = {
    call: { label: legendName(state.board, "call"), checked: cur === "call", disabled: canCall ? false : "Only between code cards", run: () => { if (L.rpc) clearRpc(id); if (!L.call) toggleCallMark(id); setLinkStyle(id, (s) => { delete s.dash; }); } },
    rpc: { label: legendName(state.board, "rpc"), checked: cur === "rpc", run: () => markRpc(id) },
    observed: { label: legendName(state.board, "observed"), checked: cur === "observed", disabled: "Comes from a run: CodeBoard: Capture Run…" },
    gen: { label: legendName(state.board, "gen"), checked: cur === "gen", disabled: "Comes from Add Generated Code" },
    see: { label: legendName(state.board, "see"), checked: cur === "see", run: () => { if (L.rpc) clearRpc(id); if (L.call) toggleCallMark(id); setLinkStyle(id, (s) => { s.dash = true; }); } },
  };
  return [...LEGEND.map(([k]) => run[k]), null, { label: "Edit Legend…", run: () => setLegendOpen(true) }];
}

/** 标签框右键（W01 D 23）：编辑、选参数和 ↺（只在 Call 上）、回到中间、删掉自己写的字 */
export function labelMenu(id: string, x: number, y: number) {
  const L = state.board.links.find((l) => l.id === id);
  if (!L) return;
  select({ links: [id] });
  openMenu([
    { label: "Edit Label", kbd: "Enter", run: () => setLinkEditing(id) },
    ...(L.rpc ? [{ label: "Edit RPC…", run: () => markRpc(id) } as Item] : []),
    ...(L.call ? [
      { label: "Arguments…", run: () => openVars(id) },
      { label: "Loop Mark", checked: !!L.call.loop, run: () => toggleLoopMark(id) },
    ] as Item[] : []),
    null,
    { label: "Reset Label Position", disabled: L.at === undefined ? "The label is already in the middle" : false, run: () => resetLabelPos(id) },
    { label: "Delete Label", danger: true, disabled: L.label ? false : "No text written on this arrow", run: () => deleteLabel(id) },
  ], x, y);
}
const LINK_COLORS = [["grey", "Grey"], ["orange", "Orange"], ["blue", "Blue"], ["green", "Green"]] as const;
const SECTION_COLORS = [["none", "None"], ["sand", "Warm Sand"], ["blue", "Light Blue"], ["green", "Light Green"], ["pink", "Light Pink"]] as const;

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


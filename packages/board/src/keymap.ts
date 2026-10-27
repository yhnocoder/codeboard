// 一张表同时管按键分发（installKeys）、? 浮层和 Settings 页的清单、菜单和按钮提示里的快捷键（kbd）。
// keys 是按键写法：mod（⌘ / Ctrl）、shift、alt、ctrl（⌃；非 Mac 是 Ctrl+Alt）加一个键：
// 字母和符号按 e.key（布局里打出来的字），Key* / Digit* / Bracket* / Minus 按 e.code（⌥ 会改掉 e.key）。
// 没有 keys 的行只进清单（鼠标手势、编辑器里的快捷键）；没有 label 的行不进清单。表的顺序就是分发的顺序：同一个键先匹配的先做。
// 动作拿到的 A 是 actions 的命名空间（类型 import，运行时不引用 actions：菜单要 import 这里拿快捷键文字）
import type { KeyAction } from "@codeboard/core";
import type * as Actions from "./actions";
import { state, sel, lineSel, undo, redo, mutate, toast, clearSel, hostOf } from "./state/store";
import { camTarget, zoomAt } from "./state/camera";
import { walk, keysOpen, setKeysOpen, setPaletteOpen, setEditing } from "./state/ui";
import { setSpaceDown, cancelMode } from "./state/mode";
import { selSticker, setSelSticker } from "./state/stickers";
import { lastPointer, worldAt } from "./state/measure";

type A = typeof Actions;
export type Group = "Create" | "View" | "Cards" | "Code" | "Walkthrough" | "Board";
export type Bind = {
  id: string;
  keys?: string[];
  /** 清单里的写法（Mac）；默认由 keys 生成 */
  show?: string;
  label?: string;
  group?: Group;
  /** 什么时候算数；不算数就接着往下找 */
  when?: () => boolean;
  /** 返回 false = 这次不处理（不拦默认动作，接着往下找） */
  run?: (a: A, e: KeyboardEvent) => boolean | void;
};

/** 第几次按下方向键（自动重复不算）：同一次按住的微移并成一步撤销 */
let nudgeRun = 0;
const nudge = (dx: number, dy: number) => (a: A, e: KeyboardEvent) => {
  const d = e.shiftKey ? 10 : 1;
  // 按住方向键（自动重复）是一个动作：并成一步撤销，不然按住一会儿就把撤销栈挤满了；每按一下是一步
  if (!e.repeat) nudgeRun++;
  mutate((b) => { for (const id of sel.cards) { const c = b.place[hostOf(id)]; if (c && !a.isLocked(id)) { c.x += dx * d; c.y += dy * d; } } }, { merge: `nudge:${nudgeRun}` });
};
const atPointer = () => worldAt(lastPointer());
const hasCards = () => sel.cards.length > 0;

export const KEYMAP: Bind[] = [
  { id: "newNote", keys: ["n"], label: "New Note", group: "Create", run: (a) => void a.newNote(atPointer(), true) },
  { id: "newText", keys: ["t"], label: "New Text", group: "Create", run: (a) => void a.newNote(atPointer(), false) },
  { id: "newMark", keys: ["m"], label: "New Mark", group: "Create", run: (a) => void a.newMark(atPointer()) },
  { id: "dblText", show: "Double-click empty space", label: "New Text (change in Settings)", group: "Create" },
  { id: "addSidenote", keys: ["s"], label: "Add Sidenote", group: "Create", run: (a) => a.addSidenoteUI() },
  { id: "paste", show: "⌘V", label: "Paste code, link or image", group: "Create" },
  { id: "editorAdd", show: "⌥B", label: "Add to Board (editor)", group: "Create" },
  { id: "editorSplit", show: "⇧⌥B", label: "Add selection as separate cards, one per definition (editor)", group: "Create" },
  { id: "editorNote", show: "⌥S", label: "Add as Sidenote to selected lines (editor)", group: "Create" },
  { id: "search", keys: ["mod+k"], label: "Search", group: "View", run: () => void setPaletteOpen({ mode: "all" }) },
  { id: "fitWindow", keys: ["shift+Digit1", "!"], show: "⇧1", label: "Fit to Window", group: "View", run: (a) => a.fitAll() },
  { id: "fitSelection", keys: ["shift+Digit2"], label: "Fit Selection", group: "View", run: (a) => a.fitSelection() },
  { id: "fitAll", keys: ["mod+0"], label: "Fit All", group: "View", run: (a) => a.fitAll() },
  { id: "zoom100", keys: ["mod+1"], label: "Zoom to 100%", group: "View", run: () => zoomAt(1 / camTarget().z) },
  // ⌃- 在 ⌘- 前面：Mac 上 ⌃ 也算 mod
  { id: "navBack", keys: ["ctrl+Minus"], label: "Back after a jump", group: "View", run: (a) => a.navBack() },
  { id: "navForward", keys: ["ctrl+shift+Minus"], label: "Forward after a jump", group: "View", run: (a) => a.navForward() },
  { id: "zoomIn", keys: ["mod+=", "mod++"], show: "⌘+", label: "Zoom In", group: "View", run: () => zoomAt(1.25) },
  { id: "zoomOut", keys: ["mod+-"], show: "⌘−", label: "Zoom Out", group: "View", run: () => zoomAt(0.8) },
  { id: "zoomGesture", show: "⌘ + scroll / pinch", label: "Zoom", group: "View" },
  { id: "pan", keys: [" "], show: "Space + drag / two fingers", label: "Pan", group: "View", run: () => setSpaceDown(true) },
  { id: "marquee", show: "Drag empty space", label: "Select with a box", group: "Cards" },
  { id: "selectAll", keys: ["mod+a"], label: "Select All", group: "Cards", run: (a) => a.selectAll() },
  { id: "move", show: "Drag title bar", label: "Move (snaps; ⌘ to turn off)", group: "Cards" },
  { id: "merge", show: "Drag onto a title bar, pause", label: "Merge (⌥ = at once)", group: "Cards" },
  { id: "toSidenote", show: "⌥ + drag onto a line", label: "Turn into a Code Sidenote", group: "Cards" },
  { id: "editLabel", keys: ["Enter"], when: () => sel.links.length === 1 && !sel.cards.length && !sel.sections.length, run: (a) => a.setLinkEditing(sel.links[0]) },
  {
    id: "open", keys: ["Enter"], label: "Open in Editor (at the selected line)", group: "Cards", when: () => hasCards(), run: (a) => {
      const c = a.selCards()[0];
      if (!c) return false;
      // 选了这张卡的几行：在编辑器里打开到第一行
      const ls = lineSel();
      if (ls && hostOf(ls.card) === c.id) a.openCode(ls.card, ls.seg, ls.start);
      else if (c.kind === "code") a.openCode(c.id);
      else if (c.kind === "note") setEditing({ kind: "note", id: c.id });
      else if (c.kind === "web") a.openLink(c.url);
      else if (c.kind === "board") a.enterFrame(c.id);
    },
  },
  { id: "enterBoard", keys: ["mod+Enter"], label: "Open the selected board frame", group: "Cards", run: (a) => { const c = a.selCards()[0]; if (c?.kind !== "board") return false; a.enterFrame(c.id); } },
  {
    // 有原生选区：交给浏览器（CodeBody 的 copy 事件）；选了行：只要代码；选了卡：文字照旧进剪贴板，宿主记下是哪几张卡（贴到别的白板 = 共享卡）
    id: "copy", keys: ["mod+c"], label: "Copy (paste on another board = linked card)", group: "Cards", run: (a) => {
      const s = window.getSelection();
      if (s && !s.isCollapsed) return false;
      const ls = lineSel();
      if (ls) return void a.copyLines(ls);
      return a.copyCardsSel();
    },
  },
  {
    // ⌘X 剪下选中的卡（复制 + 删除，一步撤销）。有原生选区、选了行时不管（浏览器自己处理）；编辑器里的 ⌘X 到不了这里（isTyping）
    id: "cut", keys: ["mod+x"], label: "Cut (paste on this board puts the cards back)", group: "Cards", when: hasCards, run: (a) => {
      const s = window.getSelection();
      if ((s && !s.isCollapsed) || lineSel()) return false;
      return a.cutCardsSel();
    },
  },
  {
    // ⌥⌘V：别的白板上复制的卡贴成另一种（默认是独立副本）。浏览器不一定为它发 paste 事件，这里直接要
    id: "pasteOther", keys: ["mod+alt+KeyV"], label: "Paste as Copy (on another board)", group: "Cards",
    run: (a) => void a.pasteFromBoard(undefined, atPointer(), true).then((ok) => { if (!ok) toast("Copy cards on another board first"); }),
  },
  { id: "duplicate", keys: ["mod+d"], label: "Duplicate", group: "Cards", run: (a) => a.duplicateSel() },
  { id: "forward", keys: ["mod+BracketRight"], label: "Bring Forward", group: "Cards", when: hasCards, run: (a) => a.arrange([...sel.cards], "forward") },
  { id: "backward", keys: ["mod+BracketLeft"], label: "Send Backward", group: "Cards", when: hasCards, run: (a) => a.arrange([...sel.cards], "backward") },
  { id: "front", keys: ["mod+shift+BracketRight"], label: "Bring to Front", group: "Cards", when: hasCards, run: (a) => a.arrange([...sel.cards], "front") },
  { id: "back", keys: ["mod+shift+BracketLeft"], label: "Send to Back", group: "Cards", when: hasCards, run: (a) => a.arrange([...sel.cards], "back") },
  { id: "deleteSticker", keys: ["Backspace", "Delete"], when: () => !!selSticker(), run: (a) => a.removeSticker(selSticker()!) },
  // 选中了一张卡里的一段字：进入编辑删掉这段字，不删卡
  { id: "deleteText", keys: ["Backspace", "Delete"], run: (a, e) => a.editTextSel(e.key === "Delete" ? "Delete" : "Backspace") },
  { id: "delete", keys: ["Backspace", "Delete"], show: "⌫", label: "Delete (linked card: remove from this board)", group: "Cards", run: (a) => { if (!lineSel() || sel.cards.length) a.deleteSel(); } },
  // ⌘⌫：共享卡 Delete Everywhere（要确认）；⌫ 只从这块白板移除
  { id: "deleteEverywhere", keys: ["mod+Backspace", "mod+Delete"], show: "⌘⌫", label: "Delete Everywhere (linked card)", group: "Cards", when: () => hasCards() && !lineSel(), run: (a) => void a.deleteEverywhere() },
  { id: "lock", keys: ["mod+shift+l"], label: "Lock / Unlock", group: "Cards", run: (a) => a.toggleLock(sel.cards.slice(), sel.sections.slice()) },
  { id: "turnIntoBoard", keys: ["mod+shift+b"], label: "Turn into Board", group: "Cards", run: (a) => void a.turnIntoBoard() },
  { id: "fitContent", keys: ["alt+KeyF"], label: "Fit Content", group: "Cards", when: () => hasCards() || sel.sections.length > 0, run: (a) => { if (sel.cards.length) a.fitContent(sel.cards); else a.fitSections(sel.sections.slice()); } },
  { id: "tidyUp", keys: ["alt+KeyT"], label: "Tidy Up", group: "Cards", when: () => sel.cards.length >= 2, run: (a) => void a.tidyUp() },
  // ⌥T 已经是 Tidy Up
  { id: "tilt", keys: ["alt+shift+KeyT"], label: "Tilt", group: "Cards", when: hasCards, run: (a) => a.toggleTilt(sel.cards.slice()) },
  { id: "wrap", keys: ["alt+KeyZ"], label: "Wrap Lines", group: "Cards", run: (a) => a.toggleWrap(sel.cards.slice()) },
  { id: "nudgeL", keys: ["ArrowLeft", "shift+ArrowLeft"], show: "Arrows", label: "Nudge (⇧ = 10px)", group: "Cards", when: () => hasCards() && !walk(), run: nudge(-1, 0) },
  { id: "nudgeR", keys: ["ArrowRight", "shift+ArrowRight"], when: () => hasCards() && !walk(), run: nudge(1, 0) },
  { id: "nudgeU", keys: ["ArrowUp", "shift+ArrowUp"], when: () => hasCards() && !walk(), run: nudge(0, -1) },
  { id: "nudgeD", keys: ["ArrowDown", "shift+ArrowDown"], when: () => hasCards() && !walk(), run: nudge(0, 1) },
  { id: "expand", show: "Click a call", label: "Expand into a new card (or go to the one already expanded)", group: "Code" },
  { id: "dragCall", show: "Drag a call", label: "Arrow to an existing card", group: "Code" },
  { id: "selectLines", show: "Click line numbers", label: "Select lines (⇧ extends)", group: "Code" },
  { id: "hide", keys: ["h"], label: "Hide lines", group: "Code", when: () => !!lineSel(), run: (a) => a.hideLines(lineSel()!) },
  { id: "copyCode", show: "⌘C", label: "Copy code without line numbers", group: "Code" },
  { id: "peek", show: "Hover a name", label: "Definition peek", group: "Code" },
  { id: "pinPop", show: "⌘ + hover", label: "Pin a popup", group: "Code" },
  { id: "walk", keys: ["p"], label: "Walk Through from the selected card", group: "Walkthrough", run: (a) => a.startWalk() },
  { id: "walkNext", keys: ["ArrowRight", "ArrowDown"], show: "→", label: "Next Step", group: "Walkthrough", when: () => !!walk(), run: (a) => a.walkTo(walk()!.i + 1) },
  { id: "walkPrev", keys: ["ArrowLeft", "ArrowUp"], show: "←", label: "Previous Step", group: "Walkthrough", when: () => !!walk(), run: (a) => a.walkTo(walk()!.i - 1) },
  { id: "walkExit", show: "Esc", label: "Exit", group: "Walkthrough" },
  { id: "undo", keys: ["mod+z"], label: "Undo", group: "Board", run: () => void undo() },
  { id: "redo", keys: ["mod+shift+z", "mod+y"], show: "⇧⌘Z", label: "Redo", group: "Board", run: () => void redo() },
  { id: "settings", keys: ["mod+Comma"], label: "Settings", group: "Board", run: (a) => a.toggleSettings() },
  { id: "openSettings", run: (a) => a.openSettings() },
  { id: "help", keys: ["?"], label: "Keyboard Shortcuts", group: "Board", run: () => setKeysOpen(!keysOpen()) },
  // Esc（浮层都关了以后）：取消正在用的工具 → 取消贴纸选中 → 退出讲解 → 子白板里回上一级 → 取消选择
  {
    id: "escape", keys: ["Escape"], label: "Cancel · Deselect · Back to the parent board", group: "Board", run: (a) => {
      if (cancelMode()) return;
      if (selSticker()) return void setSelSticker(null);
      if (walk()) return a.exitWalk();
      if (a.canLeave()) return a.leaveBoard();
      clearSel(); window.getSelection()?.removeAllRanges();
    },
  },
];

const byId = new Map(KEYMAP.map((b) => [b.id, b]));

const CODE = /^(Key[A-Z]|Digit\d|Bracket(Left|Right)|Minus|Equal|Comma)$/;
type Combo = { mod: boolean; shift: boolean; alt: boolean; ctrl: boolean; key: string };
const parse = (s: string): Combo => {
  const parts = s.length > 1 && s.endsWith("++") ? [...s.slice(0, -2).split("+"), "+"] : s.split("+");
  const key = parts.pop()!;
  const has = (m: string) => parts.includes(m);
  return { mod: has("mod"), shift: has("shift"), alt: has("alt"), ctrl: has("ctrl"), key };
};
/** 符号键（? ! +）：Shift 是打出这个字要按的，不比 */
const symbol = (k: string) => k.length === 1 && !/[a-z0-9 ]/i.test(k);
function hit(c: Combo, e: KeyboardEvent): boolean {
  const mac = state.host.isMac;
  // ⌃：Mac 上是 Control（不带 ⌘）；别的系统上是 Ctrl+Alt（Ctrl+- 是缩小）
  if (c.ctrl) { if (!(e.ctrlKey && !e.metaKey && (mac || e.altKey))) return false; }
  else if ((e.metaKey || e.ctrlKey) !== c.mod || e.altKey !== c.alt) return false;
  if (!symbol(c.key) && e.shiftKey !== c.shift) return false;
  return CODE.test(c.key) ? e.code === c.key : e.key.toLowerCase() === c.key.toLowerCase();
}
const combos = new Map(KEYMAP.map((b) => [b.id, (b.keys ?? []).map(parse)]));
export const matches = (e: KeyboardEvent, id: string) => !!combos.get(id)?.some((c) => hit(c, e));

/** 白板的按键：表里第一个匹配、when 成立、run 没有说不处理的那一行。a = actions 的命名空间（见文件头） */
export function dispatch(a: A, e: KeyboardEvent): boolean {
  for (const b of KEYMAP) {
    if (!b.run || !matches(e, b.id) || (b.when && !b.when())) continue;
    if (b.run(a, e) === false) continue;
    e.preventDefault();
    return true;
  }
  return false;
}
/** 宿主转来的快捷键（VS Code 会先拦下这些键） */
export function runKey(a: A, k: KeyAction) {
  const b = byId.get(k);
  if (b?.run && (!b.when || b.when())) b.run(a, new KeyboardEvent("keydown"));
}

const KEY_TEXT: Record<string, string> = { Enter: "↵", Escape: "Esc", Backspace: "⌫", Delete: "⌫", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", " ": "Space", Minus: "-", Equal: "=", Comma: ",", BracketLeft: "[", BracketRight: "]", "-": "−" };
/** Mac 的写法，修饰键按 ⌃⌥⇧⌘ 的顺序 */
function macText(s: string) {
  const c = parse(s);
  const k = KEY_TEXT[c.key] ?? c.key.replace(/^Key|^Digit/, "").toUpperCase();
  return `${c.ctrl ? "⌃" : ""}${c.alt ? "⌥" : ""}${c.shift ? "⇧" : ""}${c.mod ? "⌘" : ""}${k}`;
}
/** 别的系统：修饰键按 Ctrl、Alt、Shift 的顺序写成字（⌃ 是 Ctrl+Alt） */
const WORDS: [string, string][] = [["⌃", "Ctrl+Alt+"], ["⌘", "Ctrl+"], ["⌥", "Alt+"], ["⇧", "Shift+"]];
export const keyText = (s: string, mac: boolean) => {
  if (mac) return s;
  // 「⌘ + scroll」：后面跟着空格的不再带 +
  return s.replace(/([⌃⌘⌥⇧]+)( ?)/g, (_, run: string, sp: string) => { const w = WORDS.filter(([m]) => run.includes(m)).map(([, t]) => t).join(""); return sp ? `${w.slice(0, -1)} ` : w; });
};
const showOf = (b: Bind) => b.show ?? (b.keys ? macText(b.keys[0]) : "");
/** 菜单、按钮提示里的快捷键（当前系统的写法） */
export const kbd = (id: string) => { const b = byId.get(id); return b ? keyText(showOf(b), state.host.isMac) : undefined; };

export type HelpRow = [keys: string, label: string];
const GROUPS: Group[] = ["Create", "View", "Cards", "Code", "Walkthrough", "Board"];
/** 清单：按组；q 搜动作名、按键、组名 */
export function helpRows(mac: boolean, q = ""): [Group, HelpRow[]][] {
  const t = q.trim().toLowerCase();
  return GROUPS.map((g): [Group, HelpRow[]] => {
    const rows = KEYMAP.filter((b) => b.group === g && b.label).map((b): HelpRow => [keyText(showOf(b), mac), b.label!]);
    return [g, !t || g.toLowerCase().includes(t) ? rows : rows.filter(([k, l]) => l.toLowerCase().includes(t) || k.toLowerCase().includes(t))];
  }).filter(([, r]) => r.length);
}

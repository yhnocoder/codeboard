// 快捷键清单：? 浮层和 Settings 页共用这一份（只读，v0.1.5 不可改）。
// 写法按 Mac；非 Mac 用 keyText 换成 Ctrl+ / Alt+ / Shift+
export type Shortcut = [keys: string, action: string];

export const SHORTCUTS: [group: string, rows: Shortcut[]][] = [
  ["Create", [["N", "New Note"], ["T", "New Text"], ["Double-click empty space", "New Text"], ["S", "Add Sidenote"], ["⌘V", "Paste code, link or image"], ["⌥B", "Add to Board (editor)"], ["⌥S", "Add as Sidenote to selected lines (editor)"]]],
  ["View", [["⌘K", "Search"], ["⇧1", "Fit to Window"], ["⇧2", "Fit Selection"], ["⌘0", "Fit All"], ["⌘1", "Zoom to 100%"], ["⌘+ / ⌘−", "Zoom In / Out"], ["⌘ + scroll / pinch", "Zoom"], ["Space + drag / two fingers", "Pan"]]],
  ["Cards", [["Drag empty space", "Select with a box"], ["⌘A", "Select All"], ["Drag title bar", "Move (snaps; ⌘ to turn off)"], ["Drag onto a title bar, pause", "Merge (⌥ = at once)"], ["⌥ + drag onto a line", "Turn into a Code Sidenote"], ["↵", "Open in Editor"], ["⌘D", "Duplicate"], ["⌘] / ⌘[", "Bring Forward / Send Backward"], ["⌘⇧] / ⌘⇧[", "Bring to Front / Send to Back"], ["⌫", "Delete"], ["⌘⇧L", "Lock / Unlock"], ["⌥Z", "Wrap Lines"], ["Arrows", "Nudge (⇧ = 10px)"]]],
  ["Code", [["Click a call", "Expand into a new card"], ["Drag a call", "Arrow to an existing card"], ["Click line numbers", "Select lines (⇧ extends)"], ["H", "Hide lines"], ["⌘C", "Copy code without line numbers"], ["Hover a name", "Definition peek"], ["⌘ + hover", "Pin a popup"]]],
  ["Flow", [["P", "Walk Through Flow"], ["→ / ←", "Next / Previous Step"], ["Esc", "Exit"]]],
  ["Board", [["⌘Z", "Undo"], ["⇧⌘Z", "Redo"], ["⌘,", "Settings"], ["?", "Keyboard Shortcuts"]]],
];

export const keyText = (s: string, mac: boolean) => (mac ? s : s.replace(/⌘/g, "Ctrl+").replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+"));

/** 搜索：动作名、按键、分组名都算 */
export function filterShortcuts(q: string, mac: boolean) {
  const t = q.trim().toLowerCase();
  if (!t) return SHORTCUTS;
  return SHORTCUTS.map(([g, rows]) => [g, g.toLowerCase().includes(t) ? rows : rows.filter(([k, a]) => a.toLowerCase().includes(t) || keyText(k, mac).toLowerCase().includes(t))] as [string, Shortcut[]]).filter(([, r]) => r.length);
}

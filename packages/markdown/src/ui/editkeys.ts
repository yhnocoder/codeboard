/** Which unhandled keys inside an input still bubble out to the page's own shortcuts */
export type PassKeys = (e: KeyboardEvent) => boolean;

/**
 * Call on a key inside an input instead of e.stopPropagation(). A key handled already (defaultPrevented: ProseMirror's undo
 * and select all, the editor's ⌘⇧V) stays in; another one bubbles out only when pass says so. Without pass none does: on a
 * plain page the browser cuts, copies and undoes by itself, not by bubbling; in VS Code's webview the clipboard, undo and the
 * command palette are VS Code's and have to reach it
 */
export function keepKey(e: KeyboardEvent, pass?: PassKeys) {
  if (!e.defaultPrevented && pass?.(e)) return;
  e.stopPropagation();
}

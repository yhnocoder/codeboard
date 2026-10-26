// 浮层栈：菜单、对话框、弹窗、面板打开时压上去，关了出栈。Esc、点外面关掉、窗口失焦都只在这里处理（installOverlays 装一次）。
// Esc 归最上面那一层：grab 的层（菜单、对话框）焦点在哪都先关它；别的层焦点在输入框里时让输入框自己处理（取消编辑）。
// 点外面：从最上面往下，点在某一层里面就停；没写 outside 的层挡住下面的层（不关）。modal 的层盖住白板：白板快捷键不响应
import { createSignal, onCleanup, type JSX } from "solid-js";

export type Layer = {
  close: () => void;
  /** 点在这一层里面（点外面关掉、Esc 判断输入框时用） */
  inside?: (t: Element) => boolean;
  grab?: boolean;
  modal?: boolean;
  outside?: boolean;
  blur?: boolean;
  /** 这一层自己的按键（对话框的 ↵）：返回 true = 处理了 */
  keys?: (e: KeyboardEvent) => boolean;
};

const [stack, setStack] = createSignal<Layer[]>([]);
/** 盖住白板的层开着（对话框、⌘K、设置页、导出）：白板快捷键不响应 */
export const modalOpen = () => stack().some((l) => l.modal);

export function pushLayer(l: Layer): () => void {
  setStack((s) => [...s, l]);
  return () => setStack((s) => s.filter((x) => x !== l));
}
/** 组件里用：挂上时压栈，卸下时出栈 */
export const useOverlay = (l: Layer) => onCleanup(pushLayer(l));
/** 包一段 JSX：它显示时是一层（嵌套的下拉框之类） */
export function Overlay(p: Layer & { children: JSX.Element }) { useOverlay(p); return p.children; }

export const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function installOverlays() {
  window.addEventListener("keydown", (e) => {
    const top = stack().at(-1);
    if (!top) return;
    if (top.keys?.(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key !== "Escape" || e.isComposing) return;
    if (!top.grab && isTyping(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    top.close();
  }, true);
  window.addEventListener("pointerdown", (e) => {
    const t = e.target as Element;
    for (const l of [...stack()].reverse()) {
      if (l.inside?.(t) || !l.outside) return;
      l.close();
      if (l.modal) return;
    }
  }, true);
  window.addEventListener("blur", () => { for (const l of stack()) if (l.blur) l.close(); });
}

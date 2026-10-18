// 输入框、编辑器里的按键：不让它冒泡到白板和 VS Code，只放过要 VS Code 来做的那几个。
// VS Code 的 webview 外壳在 window 上收 keydown，转给 VS Code，由它的 Cut / Copy / Paste / Undo / Select All 命令回到 webview 里执行
// （mac 上浏览器自己不做这些，全靠菜单）。在这之前 stopPropagation 掉的话，⌘X / ⌘C / ⌘V 什么都不发生。
// 白板自己的 window 快捷键看到焦点在输入框里会直接跳过（interact.ts 的 typing）。

/** 剪切 / 复制 / 粘贴（含 Shift+Insert）：一定要交给 VS Code */
export const isClipKey = (e: KeyboardEvent) => {
  const mod = e.metaKey || e.ctrlKey;
  return (mod && !e.altKey && [67, 86, 88].includes(e.keyCode)) || (e.shiftKey && e.keyCode === 45);
};

/** VS Code 自己的命令面板、快速打开（F1、⌘⇧P、⌘P）：编辑时也要打得开 */
const isWorkbenchKey = (e: KeyboardEvent) => (e.key === "F1" && !e.metaKey && !e.ctrlKey && !e.altKey) || ((e.metaKey || e.ctrlKey) && !e.altKey && e.keyCode === 80);

/** 输入框里收到按键时调用（代替 e.stopPropagation()）。自己已经处理了的（preventDefault 过，比如 ProseMirror 的撤销、全选，
 *  编辑器的 ⌘⇧V）不再交出去；没处理的剪切 / 复制 / 粘贴、撤销 / 重做 / 全选和命令面板、快速打开交给 VS Code */
export function keepKey(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey;
  if (!e.defaultPrevented && (isClipKey(e) || isWorkbenchKey(e) || (mod && !e.altKey && [65, 89, 90].includes(e.keyCode)))) return;
  e.stopPropagation();
}

// VS Code 的 webview 里，输入框、编辑器里的哪些按键要交给 VS Code（@yhnocoder/markdown 的 keepKey 照这个放行，index.tsx 接上）。
// VS Code 的 webview 外壳在 window 上收 keydown，转给 VS Code，由它的 Cut / Copy / Paste / Undo / Select All 命令回到 webview 里执行
// （mac 上浏览器自己不做这些，全靠菜单）。在这之前 stopPropagation 掉的话，⌘X / ⌘C / ⌘V 什么都不发生。
// 白板自己的 window 快捷键看到焦点在输入框里会直接跳过（interact.ts 的 typing）。

/** ⌘ / Ctrl（不带 ⌥）+ letters 里的某个字母；字母按 e.key（布局里打出来的字），和 keymap 一样 */
const modKey = (e: KeyboardEvent, letters: string) => (e.metaKey || e.ctrlKey) && !e.altKey && e.key.length === 1 && letters.includes(e.key.toLowerCase());

/** 剪切 / 复制 / 粘贴（含 Shift+Insert）：一定要交给 VS Code */
const isClipKey = (e: KeyboardEvent) => modKey(e, "cvx") || (e.shiftKey && e.key === "Insert");

/** VS Code 自己的命令面板、快速打开（F1、⌘⇧P、⌘P）：编辑时也要打得开 */
const isWorkbenchKey = (e: KeyboardEvent) => (e.key === "F1" && !e.metaKey && !e.ctrlKey && !e.altKey) || modKey(e, "p");

/** 交给 VS Code 的：剪切 / 复制 / 粘贴、撤销 / 重做 / 全选和命令面板、快速打开 */
export const vscodeKey = (e: KeyboardEvent) => isClipKey(e) || isWorkbenchKey(e) || modKey(e, "ayz");

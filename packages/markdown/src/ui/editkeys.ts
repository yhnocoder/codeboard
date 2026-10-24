// 输入框、编辑器里的按键：不让它冒泡到外面（白板的快捷键、宿主），只放过用的一方说要交出去的那几个（setKeyPassThrough）。
// 默认一个都不放：普通网页里剪切、复制、撤销是浏览器自己做的，不靠冒泡。白板在 VS Code 的 webview 里，要把剪贴板、撤销、
// 命令面板这些交给 VS Code，在启动时接上自己的规则

/** 这个按键要不要交出去（不 stopPropagation）；只问没被处理过（没 preventDefault）的 */
let passThrough: (e: KeyboardEvent) => boolean = () => false;
export const setKeyPassThrough = (f: (e: KeyboardEvent) => boolean) => { passThrough = f; };

/** 输入框里收到按键时调用（代替 e.stopPropagation()）。自己已经处理了的（preventDefault 过，比如 ProseMirror 的撤销、全选，
 *  编辑器的 ⌘⇧V）不再交出去；没处理的照 setKeyPassThrough 定 */
export function keepKey(e: KeyboardEvent) {
  if (!e.defaultPrevented && passThrough(e)) return;
  e.stopPropagation();
}

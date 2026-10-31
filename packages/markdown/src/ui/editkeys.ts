let passThrough: (e: KeyboardEvent) => boolean = () => false;
/** 输入框里哪些没处理过的按键照样冒泡出去（交给外面的快捷键）。默认一个都不放：普通网页里剪切、复制、撤销是浏览器自己做的，
 *  不靠冒泡；放在 VS Code 的 webview 里时，剪贴板、撤销、命令面板这些要交给 VS Code */
export const setKeyPassThrough = (f: (e: KeyboardEvent) => boolean) => {
  passThrough = f;
};

/** 输入框里收到按键时调用（代替 e.stopPropagation()）。自己已经处理了的（preventDefault 过，比如 ProseMirror 的撤销、全选，
 *  编辑器的 ⌘⇧V）不再交出去；没处理的照 setKeyPassThrough 定 */
export function keepKey(e: KeyboardEvent) {
  if (!e.defaultPrevented && passThrough(e)) return;
  e.stopPropagation();
}

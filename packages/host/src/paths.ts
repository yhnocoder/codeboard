// Copy Path：白板、卡、Section 在磁盘上的位置，一行一个 <文件>#<id>（白板本身只有文件），让终端里的 Claude Code 之类按路径打开、
// grep id 找到那一项。文件在第一个工作区根下面写相对路径，否则（存在插件的存储目录里）写绝对路径
import type { Storage } from "./storage/boards";
import type { HostContext } from "./context";

/**
 * board 这块白板上这些项（卡、Section 的 id；不给 = 白板本身）的路径，一行一个；白板的文件还没有时回 null。
 * 卡的内容在哪个文件就指哪个：共享卡在卡库（cards/<id>.json，白板文件里只有它的 id），子白板的框指那块子白板的文件
 */
export async function itemPaths(
  cx: HostContext,
  store: Storage,
  board: string,
  items?: string[],
): Promise<string | null> {
  const file = store.fileOf(board);
  if (!file) return null;
  if (!items?.length) return cx.hostPath(file);
  const b = store.peek(board);
  const refs = store.refsOf(board);
  const lines: string[] = [];
  for (const id of items) {
    const c = b?.cards.find((x) => x.id === id);
    if (c?.kind === "board") {
      if (!store.fileOf(c.board)) await store.list(); // 缓存里还没有的白板先扫进来
      const sub = store.fileOf(c.board);
      if (sub) lines.push(cx.hostPath(sub));
    } else lines.push(`${cx.hostPath(refs.has(id) ? store.cardFileOf(id) : file)}#${id}`);
  }
  return lines.length ? [...new Set(lines)].join("\n") : null;
}

/** 算好路径写进剪贴板；回写进去的文字（没有可写的回 null） */
export async function copyPaths(cx: HostContext, store: Storage, board: string, items?: string[]) {
  const text = await itemPaths(cx, store, board, items);
  if (text) await cx.ws.ui.copy(text);
  return text;
}

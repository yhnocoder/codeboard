// 卡片剪贴板：⌘C 记下哪块白板的哪几张卡（宿主记，白板之间不共享内存）；⌘V 贴到别的白板上默认是共享卡（同一张卡，内容同步），
// ⌥⌘V 或设置成 Copy 时是独立副本。同一块白板上的粘贴不走这里（还是原来的文字粘贴）。
import type { CardCopy } from "../edit";
import type { Storage } from "./boards";

/** text = ⌘C 时写进系统剪贴板的文字：⌘V 收到的文字和它一样才算贴的是这几张卡 */
export type CardClip = { board: string; cards: string[]; text: string };
/** 贴过来的卡：from = 来源白板的名字；shared = 是共享卡（同 id）还是副本（白板放的时候换 id） */
export type Pasted = { from: string; shared: boolean; cards: CardCopy[] };

const norm = (t: string) => t.replace(/\r\n/g, "\n").trim();

export async function pasteClip(store: Storage, clip: CardClip | undefined, target: string, o: { text?: string; copy: boolean }): Promise<Pasted | null> {
  if (!clip || clip.board === target) return null;
  if (o.text !== undefined && norm(o.text) !== norm(clip.text)) return null;
  const src = store.peek(clip.board) ?? (await store.load(clip.board));
  if (!src) return null;
  const ids = clip.cards.filter((id) => src.cards.some((c) => c.id === id));
  if (!ids.length) return null;
  const shared = !o.copy && !(await store.wouldRename(clip.board, ids));
  if (shared) await store.share(clip.board, ids);
  const cards = store.copyOut(clip.board, ids);
  return cards.length ? { from: src.name, shared, cards } : null;
}

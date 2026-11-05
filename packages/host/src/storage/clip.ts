import type { CardCopy, Link } from "@codeboard/core";
import type { Storage } from "./boards";

/** text = ⌘C 时写进系统剪贴板的文字：⌘V 收到的文字和它一样才算贴的是这几张卡。pic = the fingerprint of the picture written
 *  instead (a lone image card): a pasted picture with it is these cards */
export type CardClip = { board: string; cards: string[]; text: string; pic?: string };
/** 贴过来的卡和它们之间的 Link：from = 来源白板的名字；shared = 是共享卡（同 id）还是副本（白板放的时候换 id） */
export type Pasted = { from: string; shared: boolean; cards: CardCopy[]; links: Link[] };

const norm = (t: string) => t.replace(/\r\n/g, "\n").trim();

export async function pasteClip(
  store: Storage,
  clip: CardClip | undefined,
  target: string,
  o: { text?: string; pic?: string; copy: boolean },
): Promise<Pasted | null> {
  if (!clip || clip.board === target) return null;
  if (o.pic !== undefined ? o.pic !== clip.pic : o.text !== undefined && norm(o.text) !== norm(clip.text)) return null;
  const src = store.peek(clip.board) ?? (await store.load(clip.board));
  if (!src) return null;
  const ids = clip.cards.filter((id) => src.cards.some((c) => c.id === id));
  if (!ids.length) return null;
  const shared = !o.copy && !(await store.wouldRename(clip.board, ids));
  if (shared) await store.share(clip.board, ids);
  const { cards, links } = store.copyOut(clip.board, ids);
  if (shared)
    await store.offer(
      target,
      cards.map((c) => c.card.id),
    );
  return cards.length ? { from: src.name, shared, cards, links } : null;
}

// How a Note, Text or Box card looks from its data alone: shared by the card itself (NoteBody.tsx, Card.tsx) and the drawings of
// a card that is not on the board (MiniCard.tsx, SubPreviews.tsx)
import { mdHeading, type NoteCard } from "@codeboard/core";
import { state } from "../state/store";

/**
 * 卡头的名字就是 Markdown 开头的标题时，正文里藏起那一行（正文元素加 hidehead，styles.css 藏掉第一个标题）：没自己起名字、开头是标题、
 * 设置 noteHeadingInBody 没开。heading = mdHeading(md)（Note 卡里按 md 缓存着）。子白板预览的 Note 也照这一条（cards/SubPreviews.tsx）
 */
export const hidesHeading = (c: NoteCard, heading = c.look === "note" ? mdHeading(c.md) : "") =>
  !c.title && !!heading && !state.host.settings.noteHeadingInBody;

/** A Box's fill (yellow until one is picked) */
export const boxFill = (c: NoteCard) => c.fill ?? "yellow";

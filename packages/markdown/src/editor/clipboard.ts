// 复制时 text/plain 里放 Markdown；只选了代码块里的字时放原文
import type { Slice } from "@tiptap/pm/model";
import { serializeMd } from "../schema";

export function clipboardText(slice: Slice): string {
  const one = slice.content.childCount === 1 ? slice.content.firstChild! : null;
  if (one?.type.spec.code && slice.openStart > 0) return one.textContent;
  try { return serializeMd({ type: "doc", content: slice.content.toJSON() ?? [] }); } catch { return slice.content.textBetween(0, slice.content.size, "\n\n"); }
}

// 复制时放进 text/plain 的字：选中的那一片写成 Markdown（只选了格式里的一部分时，记号成对包住选中的字）；代码块里选的字原样
import type { Slice } from "@tiptap/pm/model";
import { serializeMd } from "../schema";

export function clipboardText(slice: Slice): string {
  const one = slice.content.childCount === 1 ? slice.content.firstChild! : null;
  if (one?.type.spec.code && slice.openStart > 0) return one.textContent;
  try { return serializeMd({ type: "doc", content: slice.content.toJSON() ?? [] }); } catch { return slice.content.textBetween(0, slice.content.size, "\n\n"); }
}

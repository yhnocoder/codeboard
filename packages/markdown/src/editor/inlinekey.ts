import { PluginKey } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import type { RefLinks } from "../schema";

/**
 * open: the image whose source is open (where it starts); picked: the selected image (its source selected exactly);
 * links: the document's link definitions, which its [text][label] links are drawn with
 */
export type InlineState = {
  head: number | null;
  focused: boolean;
  expand: number | null;
  open: number | null;
  picked: number | null;
  links: RefLinks;
  decos: DecorationSet;
};
export const inlineKey = new PluginKey<InlineState>("cbInline");

import { PluginKey } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";

/** open: the image whose source is open (where it starts); picked: the selected image (its source selected exactly) */
export type InlineState = {
  head: number | null;
  focused: boolean;
  expand: number | null;
  open: number | null;
  picked: number | null;
  decos: DecorationSet;
};
export const inlineKey = new PluginKey<InlineState>("cbInline");

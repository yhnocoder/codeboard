// The editor's Markdown instance travels in its state: node views, widgets and plugins read the instance of the editor they
// draw in (one editor is built per instance, editor/session.ts). The plugin's view also places the drawn {text|note} labels
// after each update (annots.ts: measured in the page's measuring round, only when the editor shows one)
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { Md } from "../markdown";

const key = new PluginKey<Md>("cbMd");
export const mdPlugin = (md: Md) =>
  new Plugin<Md>({
    key,
    state: { init: () => md, apply: (_tr, v) => v },
    view: (v) => {
      const shown = v.dom.getElementsByClassName("md-annot");
      const fit = () => {
        if (shown.length) md.annots.fit(v.dom);
      };
      fit();
      return { update: fit };
    },
  });
export const mdOf = (s: EditorState): Md => key.getState(s)!;

// The editor's Markdown instance travels in its state: node views, widgets and plugins read the instance of the editor they
// draw in (one editor is built per instance, editor/session.ts)
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import type { Md } from "../markdown";

const key = new PluginKey<Md>("cbMd");
export const mdPlugin = (md: Md) => new Plugin<Md>({ key, state: { init: () => md, apply: (_tr, v) => v } });
export const mdOf = (s: EditorState): Md => key.getState(s)!;

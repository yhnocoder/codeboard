// The caret beside a drawn image. The browser draws it as tall as the image and against its edge, since the image is the
// only box on that side of it; a line-tall caret a few pixels off the image is drawn instead, and the browser's own is made
// transparent there. The document, the selection and the layout stay the browser's: the drawn one is a zero-size widget
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { blockInfo, flat } from "./spans";
import { inlineKey } from "./inlinekey";
import { composing } from "./inline";

const key = new PluginKey<DecorationSet>("cbImageCaret");

/** The caret's side of a drawn image it touches: "l" when the image is to its left, "r" to its right; null elsewhere */
function besideImage(state: EditorState): "l" | "r" | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return null;
  const $h = sel.$head,
    p = $h.parent;
  if (p.type.name !== "paragraph" || !p.textContent.includes("![")) return null;
  const off = $h.parentOffset,
    base = $h.start(),
    inl = inlineKey.getState(state);
  let side: "l" | "r" | null = null;
  for (const sp of flat(blockInfo(p.textContent).spans)) {
    if (sp.atom?.type !== "image" || (sp.from !== off && sp.to !== off)) continue;
    // an image whose source is open is written out, not drawn: the caret beside it is beside text
    if (inl?.open === base + sp.from) continue;
    // between two images the caret has an image on both sides: the browser's own is as good as any
    if (side) return null;
    side = sp.to === off ? "l" : "r";
  }
  return side;
}

function decorate(state: EditorState): DecorationSet {
  const side = composing() ? null : besideImage(state);
  if (!side) return DecorationSet.empty;
  const $h = state.selection.$head,
    el = () => {
      const s = document.createElement("span");
      s.className = `md-icaret md-icaret-${side}`;
      return s;
    };
  return DecorationSet.create(state.doc, [
    Decoration.node($h.before(), $h.after(), { class: "md-icaretp" }),
    // the key changes with every move, so the blink starts over on the caret's new place, as the browser's own does
    Decoration.widget($h.pos, el, { side: -1, key: `icaret:${$h.pos}:${side}`, ignoreSelection: true }),
  ]);
}

export function imageCaretPlugin() {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_c, st) => decorate(st),
      apply: (tr, prev, old, st) =>
        !tr.docChanged && tr.selection.eq(old.selection) && !tr.getMeta(inlineKey) && !tr.getMeta(key)
          ? prev
          : decorate(st),
    },
    props: {
      decorations: (st) => key.getState(st),
      handleDOMEvents: {
        // an IME starts writing at the caret: the browser's own caret comes back before the first composed character, not
        // with it (the inline plugin, before this one, has marked the composition by now)
        compositionstart: (view) => {
          if (key.getState(view.state) !== DecorationSet.empty) view.dispatch(view.state.tr.setMeta(key, true));
          return false;
        },
      },
    },
  });
}

// What a copy puts on the clipboard: the Markdown source as text/plain, and that Markdown rendered as text/html (so a
// paste into another app keeps the formatting). Part of one paragraph is copied with the markers of the spans it is cut
// out of put back around it: copying "ain wor" out of ==Plain words== gives ==ain wor==, a drawn formula is whole
import type { Slice } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { renderMd } from "../render";
import { texForCopy } from "../view";
import { sourceMd } from "./srcdoc";
import { blockInfo, flat } from "./spans";
import { inlineKey } from "./inline";

/** text[a, b) of a paragraph's source, with the markers of the spans it cuts into balanced around it. shown: where the caret
 *  shows the source (an atom around it is shown as its source text, not drawn), relative to the paragraph */
export function balancedSource(text: string, a: number, b: number, headings: boolean, shown: number | null = null): string {
  const spans = flat(blockInfo(text, headings).spans);
  // a cut through a drawn atom (formula, image, ref…) takes the whole of it; through one whose source shows, the characters
  for (const sp of spans) {
    if (!sp.atom || sp.atom.type === "annot") continue;
    if (shown !== null && shown >= sp.from && shown <= sp.to) continue;
    if (a > sp.from && a < sp.to) a = sp.from;
    if (b > sp.from && b < sp.to) b = sp.to;
  }
  let A = a, B = b, open = "", close = "";
  // flat() lists outer spans first: their opening markers go outside, their closing ones after the inner ones
  for (const sp of spans) {
    if (sp.atom || sp.plain || !sp.inner || !sp.tag) continue;
    const [i0, i1] = sp.inner;
    // a cut inside the span's own syntax on both ends (a link's address, a marker) is plain characters, not the span's text
    const startsIn = sp.from < a && a < sp.to && a < i1, endsIn = sp.from < b && b < sp.to && b > i0;
    if ((sp.from < a && a < sp.to && !startsIn) || (sp.from < b && b < sp.to && !endsIn)) continue;
    if (!startsIn && !endsIn) continue;
    if (startsIn && endsIn && b <= i0) continue; // only part of the opening marker
    if (startsIn) { open += text.slice(sp.from, i0); A = Math.max(A, i0); }
    if (endsIn) { close = text.slice(i1, sp.to) + close; B = Math.min(B, i1); }
  }
  return open + text.slice(A, B) + close;
}

/** The Markdown of the current selection */
export function selectionMd(state: EditorState): string {
  const { from, to, $from, $to } = state.selection;
  if ($from.sameParent($to) && $from.parent.type.name === "paragraph") {
    const p = $from.parent, cell = $from.depth > 0 && /cell|header/.test($from.node(-1).type.spec.tableRole ?? "");
    const a = from - $from.start(), b = to - $from.start();
    const head = inlineKey.getState(state)?.head ?? null, shown = head === null ? null : head - $from.start();
    if (a > 0 || b < p.content.size) return balancedSource(p.textContent, a, b, !cell, shown);
    return p.textContent;
  }
  return sliceMd(state.selection.content());
}

function sliceMd(slice: Slice): string {
  const one = slice.content.childCount === 1 ? slice.content.firstChild! : null;
  if (one?.isTextblock && slice.openStart > 0) return one.textContent;
  try { return sourceMd({ type: "doc", content: slice.content.toJSON() ?? [] }); } catch { return slice.content.textBetween(0, slice.content.size, "\n\n"); }
}

/** text/plain: the selection's Markdown when the slice is the selection (a copy), otherwise the slice's own */
export function clipboardText(slice: Slice, view?: EditorView): string {
  if (view && slice.eq(view.state.selection.content())) return selectionMd(view.state);
  return sliceMd(slice);
}

/** text/html: the same Markdown, rendered (ProseMirror asks for a serializer; only serializeFragment is used) */
export function clipboardHtml(view: () => EditorView) {
  return {
    serializeFragment(frag: unknown, opts: { document?: Document }, target?: HTMLElement | DocumentFragment) {
      const v = view(), md = clipboardText(v.state.selection.content(), v);
      const doc = opts.document ?? document, box = doc.createElement("div");
      box.innerHTML = renderMd(md);
      texForCopy(box);
      const out = target ?? doc.createDocumentFragment();
      while (box.firstChild) out.appendChild(box.firstChild);
      return out;
    },
  };
}

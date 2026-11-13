// A press in the gap next to a code block stops the caret there (a gap cursor). Shared by the editor's own presses and by a
// band's, since a band floats over that gap and a press on its empty part means the place under it.
import type { ResolvedPos } from "@tiptap/pm/model";
import { GapCursor } from "@tiptap/pm/gapcursor";
import type { EditorView } from "@tiptap/pm/view";

/** GapCursor.valid: the check prosemirror-gapcursor's own arrow keys use; it exists, only its type does not declare it */
export const gapAt = ($p: ResolvedPos) => (GapCursor as unknown as { valid($p: ResolvedPos): boolean }).valid($p);

/** A gap cursor at height y when y is between two blocks one of which is a code block (its padding counts as gap); false
 *  when y is not in such a gap or no gap cursor fits there */
export function gapPress(view: EditorView, y: number): boolean {
  const doc = view.state.doc;
  for (let i = 0, at = 0; i <= doc.childCount; at += i < doc.childCount ? doc.child(i).nodeSize : 0, i++) {
    const before = i > 0 ? (view.nodeDOM(at - doc.child(i - 1).nodeSize) as HTMLElement | null) : null;
    const after = i < doc.childCount ? (view.nodeDOM(at) as HTMLElement | null) : null;
    if (!(before?.matches("pre.md-code") || after?.matches("pre.md-code"))) continue;
    // the gap runs from the bottom of the block above's text to the top of the block below's (a code block's padding is in it)
    const top = before ? edge(before, "bottom") : -Infinity,
      bottom = after ? edge(after, "top") : Infinity;
    if (y < top || y > bottom) continue;
    const $p = doc.resolve(at);
    if (!gapAt($p)) return false;
    view.dispatch(view.state.tr.setSelection(new GapCursor($p)));
    view.focus();
    return true;
  }
  return false;
}
/** The top / bottom of a block's content: a code block's without its padding, any other block's own edge */
function edge(el: HTMLElement, side: "top" | "bottom") {
  const r = el.getBoundingClientRect();
  if (!el.matches("pre.md-code")) return r[side];
  const cs = getComputedStyle(el);
  return side === "top" ? r.top + parseFloat(cs.paddingTop) : r.bottom - parseFloat(cs.paddingBottom);
}

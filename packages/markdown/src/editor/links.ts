// Links in a paragraph's source: which one the selection is in, and how a long address is shown folded
import { TextSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { blockInfo, flat, type Span } from "./spans";

/** A link in the document: [from, to] its whole source, [textFrom, textTo] its text; bare: an address written as it is */
export type LinkAt = { from: number; to: number; textFrom: number; textTo: number; url: string; bare: boolean };

/** The inline link span of a paragraph's source that holds [a, b] (offsets in the paragraph) */
function spanIn(p: PMNode, a: number, b: number): Span | null {
  if (!p.isTextblock || p.type.spec.code) return null;
  return (
    flat(blockInfo(p.textContent).spans).find(
      (sp) => sp.tag?.nodeName === "a" && sp.inner && sp.from <= a && sp.to >= b && (bareSpan(sp) || isInline(sp, p)),
    ) ?? null
  );
}
/** [text](url): its second marker starts with ]( */
const isInline = (sp: Span, p: PMNode) =>
  sp.marks.length === 2 && p.textContent.slice(sp.marks[1][0], sp.marks[1][0] + 2) === "](";
/** An address written as it is (GFM): no markers */
export const bareSpan = (sp: Span) => sp.tag?.nodeName === "a" && !sp.marks.length;

/** The link the selection is in (both ends inside one link), if any */
export function linkAt(state: EditorState): LinkAt | null {
  const { from, to, $from } = state.selection;
  if (!$from.sameParent(state.selection.$to)) return null;
  const base = $from.start(),
    sp = spanIn($from.parent, from - base, to - base);
  return sp ? linkOf(sp, base) : null;
}
const linkOf = (sp: Span, base: number): LinkAt | null =>
  sp.inner
    ? {
        from: base + sp.from,
        to: base + sp.to,
        textFrom: base + sp.inner[0],
        textTo: base + sp.inner[1],
        url: String(sp.tag?.href ?? ""),
        bare: bareSpan(sp),
      }
    : null;

/** A web address too long to read at a glance shows as its site and an ellipsis */
export const LONG_URL = 40;
export function shortUrl(u: string): string {
  try {
    const x = new URL(/^www\./i.test(u) ? `https://${u}` : u);
    const rest = x.pathname.length > 1 || x.search || x.hash;
    return x.host.replace(/^www\./, "") + (rest ? "/…" : "");
  } catch {
    return u.length > 24 ? `${u.slice(0, 22)}…` : u;
  }
}

/** The link at pos (a click there), if any */
export function linkAtPos(state: EditorState, pos: number): LinkAt | null {
  const $p = state.doc.resolve(pos);
  if (!$p.parent.isTextblock) return null;
  const base = $p.start(),
    sp = spanIn($p.parent, pos - base, pos - base);
  return sp ? linkOf(sp, base) : null;
}

/**
 * Open the link box (the toolbar's address field) for the link l, or for the one the selection is in (⌘K); outside any link,
 * the field for a new one. The link's text is selected while the box is open, so the box sits over it and edits it
 */
export function openLinkBox(view: EditorView, setLink: (v: string | null) => void, l = linkAt(view.state)) {
  if (l && (view.state.selection.from !== l.textFrom || view.state.selection.to !== l.textTo))
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, l.textFrom, l.textTo)));
  setLink(l?.url ?? "");
}

/** A link's text as written between [ and ]: brackets that do not pair up are escaped, or the first ] would end the text */
export function linkText(t: string): string {
  let depth = 0;
  for (const m of t.matchAll(/(?<!\\)(?:\\\\)*([[\]])/g)) {
    depth += m[1] === "[" ? 1 : -1;
    if (depth < 0) break;
  }
  return depth === 0 ? t : t.replace(/(?<!\\)((?:\\\\)*)([[\]])/g, "$1\\$2");
}

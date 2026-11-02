// The paragraph spacing classes (../gaps.ts) in the editor, as node decorations on the blocks it draws: paragraphs are <p>
// unless their source makes them a heading (ParaView), lists, code blocks, formula blocks and quotes are spaced like
// paragraphs; tables and details are drawn in a <div> there, which the spacing never counted
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { gapClass, type GapKind } from "../gaps";
import { tagOf } from "./inline";

const BLOCKS = new Set(["bulletList", "orderedList", "taskList", "codeBlock", "blockMath", "blockquote"]);
const kindOf = (n: PMNode, cell: boolean): GapKind =>
  n.type.name === "paragraph" ? (tagOf(n, cell) === "p" ? "p" : null) : BLOCKS.has(n.type.name) ? "block" : null;

function gaps(doc: PMNode): DecorationSet {
  const ds: Decoration[] = [];
  const visit = (parent: PMNode, start: number) => {
    const cell = /cell/.test(parent.type.spec.tableRole ?? "");
    let prev: GapKind = null;
    parent.forEach((n, off) => {
      const pos = start + off,
        kind = kindOf(n, cell),
        cls = gapClass(prev, kind);
      if (cls) ds.push(Decoration.node(pos, pos + n.nodeSize, { class: cls }));
      prev = kind;
      if (!n.isTextblock && !n.isAtom && n.childCount) visit(n, pos + 1);
    });
  };
  visit(doc, 0);
  return DecorationSet.create(doc, ds);
}

export const gapsPlugin = () =>
  new Plugin<DecorationSet>({
    state: {
      init: (_c, st) => gaps(st.doc),
      apply: (tr, old) => (tr.docChanged ? gaps(tr.doc) : old),
    },
    props: {
      decorations(st) {
        return this.getState(st);
      },
    },
  });

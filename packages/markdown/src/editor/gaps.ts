// The paragraph spacing classes (../gaps.ts) in the editor, as node decorations on the blocks it draws: paragraphs are <p>
// unless their source makes them a heading (ParaView), lists, code blocks, formula blocks and quotes are spaced like
// paragraphs; tables and details are drawn in a <div> there, which the spacing never counted.
// A change only redoes the blocks around it: a block's class depends on itself and the block before it, so the blocks a change
// touches and the one after each of them, at every level down to the change. What still grows with the Note is ProseMirror's:
// mapping the set, and the view looking through the top level's decorations for each top-level block
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { gapClass, type GapKind } from "../gaps";
import { tagOf } from "./inline";

const BLOCKS = new Set(["bulletList", "orderedList", "taskList", "codeBlock", "blockMath", "blockquote"]);
const kindOf = (n: PMNode, cell: boolean): GapKind =>
  n.type.name === "paragraph" ? (tagOf(n, cell) === "p" ? "p" : null) : BLOCKS.has(n.type.name) ? "block" : null;
const isCell = (n: PMNode) => /cell/.test(n.type.spec.tableRole ?? "");
const hasBlocks = (n: PMNode) => !n.isTextblock && !n.isAtom && n.childCount > 0;

/**
 * The classes of parent's children (parent's content starts at start) that touch [from, to], and of the child after them, into
 * add; old = the decorations those children had (their own, not their descendants'), into drop. Goes down into the children
 * that touch the range. Without a range, every child at every level
 */
function visit(
  parent: PMNode,
  start: number,
  range: { from: number; to: number } | null,
  set: DecorationSet | null,
  add: Decoration[],
  drop: Decoration[],
) {
  const cell = isCell(parent);
  let i = 0,
    pos = start;
  // Skipping by size only, not by kind: a kind can cost a look at the paragraph's text (tagOf)
  for (; range && i < parent.childCount && pos + parent.child(i).nodeSize < range.from; i++)
    pos += parent.child(i).nodeSize;
  let prev = i > 0 ? kindOf(parent.child(i - 1), cell) : null,
    redoNext = false;
  for (; i < parent.childCount; i++) {
    const n = parent.child(i),
      end = pos + n.nodeSize;
    const touches = !range || pos <= range.to;
    if (!touches && !redoNext) break;
    const kind = kindOf(n, cell);
    if (set) for (const d of set.find(pos, end)) if (d.from === pos) drop.push(d);
    const cls = gapClass(prev, kind);
    if (cls) add.push(Decoration.node(pos, end, { class: cls }));
    if (touches && hasBlocks(n)) visit(n, pos + 1, range, set, add, drop);
    redoNext = touches;
    prev = kind;
    pos = end;
  }
}

function all(doc: PMNode): DecorationSet {
  const add: Decoration[] = [];
  visit(doc, 0, null, null, add, []);
  return DecorationSet.create(doc, add);
}

/** The ranges of tr's new document its steps changed */
function changed(tr: Transaction): { from: number; to: number }[] {
  let out: { from: number; to: number }[] = [];
  for (const map of tr.mapping.maps) {
    out = out.map((r) => ({ from: map.map(r.from, -1), to: map.map(r.to, 1) }));
    map.forEach((_a, _b, from, to) => {
      out.push({ from, to });
    });
  }
  return out;
}

function update(tr: Transaction, old: DecorationSet): DecorationSet {
  let set = old.map(tr.mapping, tr.doc);
  for (const range of changed(tr)) {
    const add: Decoration[] = [],
      drop: Decoration[] = [];
    visit(tr.doc, 0, range, set, add, drop);
    set = set.remove(drop).add(tr.doc, add);
  }
  return set;
}

export const gapsPlugin = () =>
  new Plugin<DecorationSet>({
    state: {
      init: (_c, st) => all(st.doc),
      apply: (tr, old) => (tr.docChanged ? update(tr, old) : old),
    },
    props: {
      decorations(st) {
        return this.getState(st);
      },
    },
  });

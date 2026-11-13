// Whole top-level blocks of the document for a caller that moves them (the board's ⌘-drag): where each block is drawn, which
// blocks the selection covers, marking some (dimmed while dragged, taken out while picked up) with node decorations that follow
// edits, and the document with blocks moved, taken out or put in. Empty paragraphs are not blocks (nothing of them is saved)
import { Extension, type Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { MdPart } from "../blockmove";
import { parseMd } from "../schema";
import { layoutOf, sourceDoc, sourceMd } from "./srcdoc";

/** How marked blocks look: dim = a faint placeholder, away = taken out (the Note closes up), gone = kept in place but unseen */
export type BlockMark = "dim" | "away" | "gone";
export type MdBlocks = {
  /** Each block's element, in order */
  els(): HTMLElement[];
  /** The blocks to move when block i is grabbed: the run the selection covers when it spans several blocks and i is one of
   *  them (a selection ending at the very start of a block leaves that block out), else just i. [first, last + 1] */
  group(i: number): [number, number];
  /** Mark blocks from..to-1 (null: none). Not an edit: nothing is saved or undone */
  mark(range: [number, number] | null, how?: BlockMark): void;
  /** The marked blocks now (edits before them shift them), null when none are marked or they were deleted */
  marked(): [number, number] | null;
  /** Move blocks from..to-1 before block at (counted before the move; the count = the end): one undo step. False: no move */
  move(from: number, to: number, at: number): boolean;
  /** The document as Markdown with blocks from..to-1 taken out, and those blocks; nothing changes in the editor */
  cut(from: number, to: number): { rest: MdPart; part: MdPart };
  /** Blocks from..to-1 as Markdown */
  part(from: number, to: number): MdPart;
  /** The document as Markdown with part put before block at; nothing changes in the editor */
  withInserted(at: number, part: MdPart): MdPart;
  /** Does the editor hold exactly this saved text, block for block (nothing typed since): then the caller may cut and insert
   *  in the saved Markdown itself, which keeps the untouched blocks as they were written */
  holds(saved: MdPart): boolean;
};

type Mark = { from: number; to: number; how: BlockMark } | null;
const key = new PluginKey<Mark>("cbMoveBlocks");

/** Blocks are being moved (dragged, floating or landing): the selection's own controls stand aside meanwhile */
export const movingBlocks = (st: EditorState) => !!key.getState(st);

const empty = (n: PMNode) => n.type.name === "paragraph" && !n.content.size;
/** Positions of the blocks (before each), and the end of the last */
function spans(doc: PMNode): { pos: number; node: PMNode; k: number }[] {
  const out: { pos: number; node: PMNode; k: number }[] = [];
  doc.forEach((node, pos, k) => {
    if (!empty(node)) out.push({ pos, node, k });
  });
  return out;
}

export const MoveBlocks = Extension.create({
  name: "cbMoveBlocks",
  addProseMirrorPlugins: () => [
    new Plugin<Mark>({
      key,
      state: {
        init: () => null,
        apply(tr, v) {
          const m = tr.getMeta(key) as Mark | undefined;
          if (m !== undefined) return m;
          if (!v || !tr.docChanged) return v;
          const from = tr.mapping.map(v.from, 1),
            to = tr.mapping.map(v.to, -1);
          return to > from ? { ...v, from, to } : null;
        },
      },
      props: {
        attributes: (st): Record<string, string> => (key.getState(st) ? { class: "md-moving" } : {}),
        decorations(st) {
          const m = key.getState(st);
          if (!m) return null;
          const ds: Decoration[] = [];
          st.doc.forEach((n, pos) => {
            if (pos >= m.from && pos + n.nodeSize <= m.to)
              ds.push(Decoration.node(pos, pos + n.nodeSize, { class: `md-mv-${m.how}` }));
          });
          return DecorationSet.create(st.doc, ds);
        },
      },
    }),
  ],
});

const docOf = (ed: Editor, nodes: PMNode[]) => ed.schema.topNodeType.create(null, Fragment.fromArray(nodes));
const partOf = (ed: Editor, nodes: PMNode[]): MdPart => {
  const d = docOf(ed, nodes);
  return { md: sourceMd(d.toJSON()), layout: layoutOf(d) };
};

export function mdBlocks(ed: Editor): MdBlocks {
  const all = () => spans(ed.state.doc);
  const nodes = () => {
    const out: PMNode[] = [];
    ed.state.doc.forEach((n) => out.push(n));
    return out;
  };
  return {
    els: () =>
      all().flatMap(({ pos }) => {
        const d = ed.view.nodeDOM(pos);
        return d instanceof HTMLElement ? [d] : [];
      }),
    group(i) {
      const { from, to, empty: none } = ed.state.selection;
      const bs = all();
      if (none || !bs[i]) return [i, i + 1];
      const first = bs.findIndex((b) => b.pos + b.node.nodeSize > from);
      let last = bs.findIndex((b) => b.pos + b.node.nodeSize >= to);
      if (last < 0) last = bs.length - 1;
      if (last > first && to <= bs[last].pos + 1) last--;
      return first >= 0 && last > first && i >= first && i <= last ? [first, last + 1] : [i, i + 1];
    },
    mark(range, how = "dim") {
      const bs = all();
      const m: Mark =
        range && bs[range[0]] && bs[range[1] - 1]
          ? { from: bs[range[0]].pos, to: bs[range[1] - 1].pos + bs[range[1] - 1].node.nodeSize, how }
          : null;
      if (ed.isDestroyed) return;
      const tr = ed.state.tr.setMeta(key, m).setMeta("addToHistory", false);
      // blocks taken out: the caret (or focus in a code block's own editor) inside them would go with them, and a focused
      // element hidden loses focus, which ends editing. It moves to the nearest place after them (before them at the end)
      const { from, to } = tr.selection;
      const view = ed.view,
        inner = view.dom.contains(document.activeElement) && document.activeElement !== view.dom;
      const out = !!m && how === "away" && ((from < m.to && to > m.from) || inner);
      if (out) {
        const doc = tr.doc;
        tr.setSelection(
          m.to < doc.content.size ? Selection.near(doc.resolve(m.to), 1) : Selection.near(doc.resolve(m.from), -1),
        );
      }
      view.dispatch(tr);
      if (out && inner) view.focus();
    },
    marked() {
      const m = key.getState(ed.state);
      if (!m) return null;
      const bs = all();
      const a = bs.findIndex((b) => b.pos >= m.from),
        z = bs.findIndex((b) => b.pos >= m.to);
      const end = z < 0 ? bs.length : z;
      return a >= 0 && end > a ? [a, end] : null;
    },
    move(from, to, at) {
      const bs = all();
      if (from < 0 || to > bs.length || from >= to || (at >= from && at <= to)) return false;
      const a = bs[from].pos,
        z = bs[to - 1].pos + bs[to - 1].node.nodeSize,
        slice = ed.state.doc.slice(a, z);
      const tr = ed.state.tr;
      const dest = at < bs.length ? bs[at].pos : ed.state.doc.content.size;
      tr.delete(a, z);
      tr.insert(tr.mapping.map(dest), slice.content);
      ed.view.dispatch(tr.setMeta(key, null));
      return true;
    },
    cut(from, to) {
      const bs = all(),
        ns = nodes();
      const pick = new Set(bs.slice(from, to).map((b) => b.k));
      return {
        rest: partOf(
          ed,
          ns.filter((_, k) => !pick.has(k)),
        ),
        part: partOf(
          ed,
          ns.filter((_, k) => pick.has(k)),
        ),
      };
    },
    part(from, to) {
      const ns = nodes();
      return partOf(
        ed,
        all()
          .slice(from, to)
          .map((b) => ns[b.k]),
      );
    },
    withInserted(at, part) {
      const bs = all(),
        ns = nodes();
      const add = (ed.schema.nodeFromJSON(sourceDoc(part.md, part.layout)) as PMNode).content;
      const before = at < bs.length ? bs[at].k : ns.length;
      const out: PMNode[] = [...ns.slice(0, before)];
      add.forEach((n) => out.push(n));
      out.push(...ns.slice(before));
      return partOf(ed, out);
    },
    holds(saved) {
      const now = partOf(ed, nodes()),
        was = sourceDoc(saved.md, saved.layout);
      return (
        now.md === sourceMd(was) &&
        JSON.stringify(now.layout) === JSON.stringify(layoutOf(ed.schema.nodeFromJSON(was))) &&
        all().length === (parseMd(saved.md).content?.length ?? 0)
      );
    },
  };
}

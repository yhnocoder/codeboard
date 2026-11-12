// The table commands the toolbar band and the keys share, and the size grid's preview of the cells a resize would drop
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TableMap, addRowAfter, addRowBefore, isInTable, selectionCell } from "@tiptap/pm/tables";

export type Cmd = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;

export const tablePos = (state: EditorState): number | null => {
  const $f = state.selection.$from;
  for (let d = $f.depth; d > 0; d--) if ($f.node(d).type.name === "table") return $f.before(d);
  return null;
};

/** Enter in a cell: the same column of the next row, adding a row at the end */
export function cellDown(view: EditorView): boolean {
  if (!isInTable(view.state)) return false;
  const go = (st: EditorState) => {
    const $cell = selectionCell(st),
      table = $cell.node(-1),
      start = $cell.start(-1),
      map = TableMap.get(table);
    const { top, left } = map.findCell($cell.pos - start);
    if (top + 1 >= map.height) return false;
    const pos = start + map.map[(top + 1) * map.width + left];
    view.dispatch(st.tr.setSelection(TextSelection.near(st.doc.resolve(pos + 1))).scrollIntoView());
    return true;
  };
  if (!go(view.state)) {
    addRowAfter(view.state, view.dispatch);
    go(view.state);
  }
  return true;
}
/** Adds a row above or below; the caret stays where it is, in its cell (as the demo's prosemirror-tables commands leave it) */
export function addRow(view: EditorView, below: boolean): boolean {
  if (!isInTable(view.state)) return false;
  return (below ? addRowAfter : addRowBefore)(view.state, (tr) => view.dispatch(tr.scrollIntoView()));
}
/** Sets (or, when it is already that, clears) the alignment of the caret's column: written as :-- / :-: / --: */
export function setColAlign(view: EditorView, align: "left" | "center" | "right") {
  const { state } = view;
  if (!isInTable(state)) return;
  const $cell = selectionCell(state),
    table = $cell.node(-1),
    start = $cell.start(-1),
    map = TableMap.get(table);
  const { left } = map.findCell($cell.pos - start),
    next = $cell.nodeAfter!.attrs.align === align ? null : align;
  const tr = state.tr;
  for (let r = 0; r < map.height; r++) {
    const off = map.map[r * map.width + left],
      cell = table.nodeAt(off)!;
    tr.setNodeMarkup(start + off, null, { ...cell.attrs, align: next });
  }
  view.dispatch(tr);
}

/** Cells with content that a resize to R×C would drop */
export function doomed(table: PMNode, pos: number, R: number, C: number) {
  const map = TableMap.get(table),
    out: { pos: number; node: PMNode; r: number; c: number }[] = [];
  for (let r = 0; r < map.height; r++)
    for (let c = 0; c < map.width; c++) {
      if (r < R && c < C) continue;
      const off = map.map[r * map.width + c],
        n = table.nodeAt(off)!;
      if (n.textContent.trim()) out.push({ pos: pos + 1 + off, node: n, r, c });
    }
  return out;
}
export function resizeTable(view: EditorView, pos: number, R: number, C: number) {
  const { state } = view,
    table = state.doc.nodeAt(pos)!,
    map = TableMap.get(table),
    s = state.schema;
  const $cell = isInTable(state) ? selectionCell(state) : null;
  const at = $cell ? map.findCell($cell.pos - pos - 1) : { top: 0, left: 0 };
  const colCell = (c: number) => (c < map.width ? table.nodeAt(map.map[c]) : null);
  const rows: PMNode[] = [];
  for (let r = 0; r < R; r++) {
    const cells: PMNode[] = [];
    for (let c = 0; c < C; c++) {
      let cell = r < map.height && c < map.width ? table.nodeAt(map.map[r * map.width + c]) : null;
      if (!cell) {
        const src = colCell(c);
        cell = (r === 0 ? s.nodes.tableHeader : s.nodes.tableCell).createAndFill({
          align: src?.attrs.align ?? null,
          colwidth: src?.attrs.colwidth ?? null,
        })!;
      }
      cells.push(cell);
    }
    const old = r < map.height ? table.child(r) : null;
    rows.push(s.nodes.tableRow.create(old?.attrs ?? null, cells));
  }
  const nt = s.nodes.table.create(table.attrs, rows),
    tr = state.tr.replaceWith(pos, pos + table.nodeSize, nt);
  const off = TableMap.get(nt).positionAt(Math.min(at.top, R - 1), Math.min(at.left, C - 1), nt);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1 + off + 1)));
  view.dispatch(tr.scrollIntoView());
}

/** The grid picker's preview: cells a resize would drop are marked in the table */
export const PREV = new PluginKey<{ pos: number; R: number; C: number } | null>("cbTablePreview");
export const previewPlugin = () =>
  new Plugin({
    key: PREV,
    state: {
      init: () => null,
      apply: (tr, v) => {
        const m = tr.getMeta(PREV);
        return m !== undefined ? m : tr.docChanged ? null : v;
      },
    },
    props: {
      decorations(state) {
        const v = PREV.getState(state);
        const t = v && state.doc.nodeAt(v.pos);
        if (!v || t?.type.name !== "table") return null;
        return DecorationSet.create(
          state.doc,
          doomed(t, v.pos, v.R, v.C).map((d) => Decoration.node(d.pos, d.pos + d.node.nodeSize, { class: "md-doom" })),
        );
      },
    },
  });

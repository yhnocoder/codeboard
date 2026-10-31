// Tables in the editor: a small toolbar pill above the table's top-right corner (size grid, rows, columns, alignment,
// delete), the shortcuts, and column-width / row-height drags. Widths and heights are layout, not Markdown (layout.ts):
// colwidth on the cells (prosemirror-tables' own column resizing) and height on the rows. Neither drag moves the caret,
// and each is one undo step.
import { Extension, type AnyExtension, type Editor, type Node as TNode } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TableMap, addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, isInTable, selectionCell } from "@tiptap/pm/tables";
import { iconEl, type IconName } from "../ui/icons";
import { CELL_MIN } from "../layout";

type Cmd = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;

const tablePos = (state: EditorState): number | null => {
  const $f = state.selection.$from;
  for (let d = $f.depth; d > 0; d--) if ($f.node(d).type.name === "table") return $f.before(d);
  return null;
};

/** Enter in a cell: the same column of the next row, adding a row at the end */
function cellDown(view: EditorView): boolean {
  if (!isInTable(view.state)) return false;
  const go = (st: EditorState) => {
    const $cell = selectionCell(st), table = $cell.node(-1), start = $cell.start(-1), map = TableMap.get(table);
    const { top, left } = map.findCell($cell.pos - start);
    if (top + 1 >= map.height) return false;
    const pos = start + map.map[(top + 1) * map.width + left];
    view.dispatch(st.tr.setSelection(TextSelection.near(st.doc.resolve(pos + 1))).scrollIntoView());
    return true;
  };
  if (!go(view.state)) { addRowAfter(view.state, view.dispatch); go(view.state); }
  return true;
}
/** Adds a row above or below; the caret stays where it is, in its cell (as the demo's prosemirror-tables commands leave it) */
function addRow(view: EditorView, below: boolean): boolean {
  if (!isInTable(view.state)) return false;
  return (below ? addRowAfter : addRowBefore)(view.state, (tr) => view.dispatch(tr.scrollIntoView()));
}
/** Sets (or, when it is already that, clears) the alignment of the caret's column: written as :-- / :-: / --: */
function setColAlign(view: EditorView, align: "left" | "center" | "right") {
  const { state } = view;
  if (!isInTable(state)) return;
  const $cell = selectionCell(state), table = $cell.node(-1), start = $cell.start(-1), map = TableMap.get(table);
  const { left } = map.findCell($cell.pos - start), next = $cell.nodeAfter!.attrs.align === align ? null : align;
  const tr = state.tr;
  for (let r = 0; r < map.height; r++) {
    const off = map.map[r * map.width + left], cell = table.nodeAt(off)!;
    tr.setNodeMarkup(start + off, null, { ...cell.attrs, align: next });
  }
  view.dispatch(tr);
}

/** Cells with content that a resize to R×C would drop */
function doomed(table: PMNode, pos: number, R: number, C: number) {
  const map = TableMap.get(table), out: { pos: number; node: PMNode; r: number; c: number }[] = [];
  for (let r = 0; r < map.height; r++) for (let c = 0; c < map.width; c++) {
    if (r < R && c < C) continue;
    const off = map.map[r * map.width + c], n = table.nodeAt(off)!;
    if (n.textContent.trim()) out.push({ pos: pos + 1 + off, node: n, r, c });
  }
  return out;
}
function resizeTable(view: EditorView, pos: number, R: number, C: number) {
  const { state } = view, table = state.doc.nodeAt(pos)!, map = TableMap.get(table), s = state.schema;
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
        cell = (r === 0 ? s.nodes.tableHeader : s.nodes.tableCell).createAndFill({ align: src?.attrs.align ?? null, colwidth: src?.attrs.colwidth ?? null })!;
      }
      cells.push(cell);
    }
    const old = r < map.height ? table.child(r) : null;
    rows.push(s.nodes.tableRow.create(old?.attrs ?? null, cells));
  }
  const nt = s.nodes.table.create(table.attrs, rows), tr = state.tr.replaceWith(pos, pos + table.nodeSize, nt);
  const off = TableMap.get(nt).positionAt(Math.min(at.top, R - 1), Math.min(at.left, C - 1), nt);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1 + off + 1)));
  view.dispatch(tr.scrollIntoView());
}

/** The grid picker's preview: cells a resize would drop are marked in the table */
const PREV = new PluginKey<{ pos: number; R: number; C: number } | null>("cbTablePreview");
const previewPlugin = () => new Plugin({
  key: PREV,
  state: { init: () => null, apply: (tr, v) => { const m = tr.getMeta(PREV); return m !== undefined ? m : tr.docChanged ? null : v; } },
  props: {
    decorations(state) {
      const v = PREV.getState(state);
      const t = v && state.doc.nodeAt(v.pos);
      if (!v || t?.type.name !== "table") return null;
      return DecorationSet.create(state.doc, doomed(t, v.pos, v.R, v.C).map((d) => Decoration.node(d.pos, d.pos + d.node.nodeSize, { class: "md-doom" })));
    },
  },
});

/** Row heights: drag a row's bottom edge. A line marks the edge while the pointer is near it and follows the drag; the height
 *  is set on release (one step) */
function rowEdge(view: EditorView, e: MouseEvent): HTMLTableRowElement | null {
  const cell = (e.target as Element | null)?.closest?.("td, th");
  if (!cell || !view.dom.contains(cell)) return null;
  const tr = cell.parentElement as HTMLTableRowElement, r = tr.getBoundingClientRect(), k = tr.offsetHeight ? r.height / tr.offsetHeight : 1, d = (r.bottom - e.clientY) / k;
  return d <= 4 && d >= -2 ? tr : null;
}
const ROW_MIN = 24;
/** The line on a row's bottom edge (fixed on the page, outside the editor's DOM), at the table's width */
function rowLine(tr: HTMLTableRowElement, line = document.createElement("div")) {
  const tb = tr.closest("table")!.getBoundingClientRect();
  line.className = "md-rowline";
  line.style.cssText = `left:${tb.left}px;width:${tb.width}px;top:${tr.getBoundingClientRect().bottom}px`;
  if (!line.isConnected) document.body.append(line);
  return line;
}
const rowResize = () => {
  let dragging = false, hover: HTMLDivElement | null = null;
  const unhover = () => { hover?.remove(); hover = null; };
  return new Plugin({
    key: new PluginKey("cbRowResize"),
    view: () => ({ destroy: unhover }),
    props: {
      handleDOMEvents: {
        // after this event's other handlers: prosemirror-tables' column handle, which wins at a corner, updates its class then
        mousemove: (view, e) => {
          if (dragging) return false;
          const tr = rowEdge(view, e);
          queueMicrotask(() => {
            if (dragging) return;
            const on = !!tr && !view.dom.classList.contains("resize-cursor");
            view.dom.classList.toggle("md-row-resize", on);
            if (on) hover = rowLine(tr!, hover ?? undefined); else unhover();
          });
          return false;
        },
        mouseleave: (view) => { view.dom.classList.remove("md-row-resize"); unhover(); return false; },
        mousedown: (view, e) => {
          if (e.button !== 0) return false;
          const row = rowEdge(view, e);
          if (!row || view.dom.classList.contains("resize-cursor")) return false;
          unhover();
          const pos = view.posAtDOM(row, 0) - 1, node = view.state.doc.nodeAt(pos);
          if (node?.type.name !== "tableRow") return false;
          e.preventDefault();
          e.stopPropagation();
          const r = row.getBoundingClientRect(), k = row.offsetHeight ? r.height / row.offsetHeight : 1;
          const line = rowLine(row);
          const y0 = e.clientY, h0 = row.offsetHeight;
          let h = h0;
          const place = () => { line.style.top = `${r.top + h * k}px`; };
          place();
          const shield = document.createElement("div");
          shield.className = "md-rowshield";
          document.body.append(shield);
          dragging = true;
          const move = (ev: MouseEvent) => { h = Math.max(ROW_MIN, h0 + (ev.clientY - y0) / k); place(); };
          const up = () => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            line.remove();
            shield.remove();
            dragging = false;
            view.dom.classList.remove("md-row-resize");
            const n = view.state.doc.nodeAt(pos);
            if (Math.abs(h - h0) >= 1 && n?.type.name === "tableRow") view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...n.attrs, height: Math.round(h) }));
          };
          window.addEventListener("mousemove", move, true);
          window.addEventListener("mouseup", up, true);
          return true;
        },
      },
    },
  });
};

const GW = 10, GH = 8;
type Btn = { act: string; icon: IconName; tip: string; kbd?: string; danger?: true };

/** The toolbar pill and the size grid: fixed on the page (unscaled, like the selection toolbar), above the table */
class TableBar {
  bar: HTMLDivElement;
  pick: HTMLDivElement;
  private count: HTMLSpanElement;
  private cells: HTMLDivElement[];
  private inR: HTMLInputElement;
  private inC: HTMLInputElement;
  private open: { pos: number } | null = null;
  private pos: number | null = null;
  private frame = 0;
  constructor(private view: EditorView, isMac: () => boolean | undefined) {
    const mac = isMac() ?? /Mac|iPhone|iPad/.test(navigator.platform);
    const K = (s: string) => (mac ? s : s.replace(/⌘/g, "Ctrl+").replace(/⇧/g, "Shift+").replace(/⌫/g, "Backspace").replace(/↵/g, "Enter"));
    this.bar = document.createElement("div");
    this.bar.className = "mdui pill md-tbar";
    const btn = (b: Btn) => {
      const e = document.createElement("button");
      e.className = `tbtn md-ib${b.danger ? " danger" : ""}`;
      e.dataset.act = b.act;
      e.dataset.tip = b.tip;
      if (b.kbd) e.dataset.kbd = K(b.kbd);
      e.setAttribute("aria-label", b.tip);
      e.append(iconEl(b.icon));
      return e;
    };
    const sep = () => { const s = document.createElement("span"); s.className = "sep"; return s; };
    this.count = document.createElement("span");
    this.count.className = "md-tcount";
    this.bar.append(
      btn({ act: "grid", icon: "grid", tip: "Table size" }), this.count, sep(),
      btn({ act: "rowAbove", icon: "rowAbove", tip: "Insert row above", kbd: "⌘⇧↵" }), btn({ act: "rowBelow", icon: "rowBelow", tip: "Insert row below", kbd: "⌘↵" }),
      btn({ act: "colLeft", icon: "colLeft", tip: "Insert column left" }), btn({ act: "colRight", icon: "colRight", tip: "Insert column right" }), sep(),
      btn({ act: "delRow", icon: "delRow", tip: "Delete row", kbd: "⌘⇧⌫" }), btn({ act: "delCol", icon: "delCol", tip: "Delete column" }), sep(),
      btn({ act: "left", icon: "alignL", tip: "Align column left" }), btn({ act: "center", icon: "alignC", tip: "Align column center" }), btn({ act: "right", icon: "alignR", tip: "Align column right" }), sep(),
      btn({ act: "delTable", icon: "trash", tip: "Delete table", danger: true }),
    );
    this.pick = document.createElement("div");
    this.pick.className = "mdui md-gpick";
    this.pick.innerHTML = `<div class="md-gp-head"><span class="md-gp-title"></span><span class="md-gp-hint">Header counts as row 1</span></div>
      <div class="md-gp-grid">${'<div class="md-gc"></div>'.repeat(GW * GH)}</div>
      <div class="md-gp-row"><label>Rows <input type="number" min="1" max="40" data-r></label><label>Columns <input type="number" min="1" max="12" data-c></label><span class="sp"></span><button class="md-gp-apply">Apply</button></div>
      <div class="md-gp-warn"></div>`;
    this.cells = [...this.pick.querySelectorAll<HTMLDivElement>(".md-gc")];
    this.inR = this.pick.querySelector("[data-r]")!;
    this.inC = this.pick.querySelector("[data-c]")!;
    for (const el of [this.bar, this.pick]) {
      el.addEventListener("mousedown", (e) => { if (!(e.target as Element).closest("input")) e.preventDefault(); });
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
    }
    this.bar.addEventListener("click", (e) => { const b = (e.target as Element).closest<HTMLElement>("[data-act]"); if (b) this.act(b.dataset.act!); });
    this.cells.forEach((g, i) => {
      g.addEventListener("mouseenter", () => { this.inR.value = String(Math.floor(i / GW) + 1); this.inC.value = String((i % GW) + 1); this.preview(); });
      g.addEventListener("click", () => this.apply());
    });
    for (const inp of [this.inR, this.inC]) {
      inp.addEventListener("input", () => this.preview());
      inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); this.apply(); } if (e.key === "Escape") { e.preventDefault(); this.closePick(true); } });
    }
    this.pick.querySelector(".md-gp-apply")!.addEventListener("click", () => this.apply());
    document.addEventListener("mousedown", this.onDoc, true);
    document.addEventListener("focusin", this.onFocus);
    document.addEventListener("focusout", this.onFocus);
    window.addEventListener("resize", this.onFocus);
    document.addEventListener("scroll", this.onFocus, true);
    this.update();
  }
  private onDoc = (e: MouseEvent) => { if (this.open && !this.pick.contains(e.target as Node) && !this.bar.contains(e.target as Node)) this.closePick(false); };
  // Esc while the grid is open closes only the grid: the caret, wherever it is, never sees it (it would leave edit mode)
  private onEsc = (e: KeyboardEvent) => { if (e.key === "Escape" && this.open) { e.preventDefault(); e.stopPropagation(); this.closePick(true); } };
  private onFocus = () => { cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => this.update()); };
  private owns = (el: Element | null) => !!el && (this.bar.contains(el) || this.pick.contains(el));
  update() {
    const v = this.view;
    if (v.isDestroyed) return;
    const live = v.hasFocus() || this.owns(document.activeElement) || !!this.open;
    // the state first: offsetParent forces a style and layout pass, which only a caret in a table needs
    const at = live ? tablePos(v.state) : null;
    const pos = at !== null && v.dom.isConnected && v.dom.offsetParent ? at : null;
    if (pos === null && this.pos === null && !this.bar.isConnected) return;
    this.pos = pos;
    if (pos === null) { this.bar.remove(); if (this.open) this.closePick(false); return; }
    if (!this.bar.isConnected) document.body.append(this.bar);
    const t = v.state.doc.nodeAt(pos)!, m = TableMap.get(t);
    this.count.textContent = `${m.height}×${m.width}`;
    const al = isInTable(v.state) ? selectionCell(v.state).nodeAfter?.attrs.align : null;
    for (const a of ["left", "center", "right"]) { const b = this.bar.querySelector(`[data-act=${a}]`)!; b.classList.toggle("on", al === a); b.setAttribute("aria-pressed", String(al === a)); }
    this.place();
  }
  /** Right-aligned with the table, just above its top edge (over the margin, which every block has anyway) */
  private place() {
    if (this.pos === null) return;
    const dom = this.view.nodeDOM(this.pos) as HTMLElement | null, table = dom?.querySelector("table") ?? null;
    if (!dom || !table) return;
    const r = table.getBoundingClientRect(), d = dom.getBoundingClientRect(), right = Math.min(r.right, d.right), bw = this.bar.offsetWidth;
    this.bar.style.left = `${Math.max(4, right - bw)}px`;
    this.bar.style.top = `${r.top - this.bar.offsetHeight - 4}px`;
    if (this.open) this.placePick();
  }
  private act(a: string) {
    const v = this.view, run = (c: Cmd) => { c(v.state, v.dispatch); v.focus(); };
    switch (a) {
      case "grid": if (this.open) this.closePick(true); else this.openPick(); return;
      case "rowAbove": addRow(v, false); v.focus(); return;
      case "rowBelow": addRow(v, true); v.focus(); return;
      case "colLeft": return run(addColumnBefore);
      case "colRight": return run(addColumnAfter);
      case "delRow": return run(deleteRow);
      case "delCol": return run(deleteColumn);
      case "left": case "center": case "right": setColAlign(v, a); v.focus(); return;
      case "delTable": return run(deleteTable);
    }
  }
  private openPick() {
    if (this.pos === null) return;
    const m = TableMap.get(this.view.state.doc.nodeAt(this.pos)!);
    this.open = { pos: this.pos };
    this.inR.value = String(m.height);
    this.inC.value = String(m.width);
    this.bar.querySelector("[data-act=grid]")!.classList.add("on");
    document.body.append(this.pick);
    document.addEventListener("keydown", this.onEsc, true);
    this.placePick();
    this.preview();
  }
  private placePick() {
    const b = this.bar.querySelector("[data-act=grid]")!.getBoundingClientRect(), tb = this.bar.getBoundingClientRect();
    this.pick.style.left = `${Math.max(4, Math.min(b.left - 4, innerWidth - this.pick.offsetWidth - 4))}px`;
    // opens upwards: the table stays visible, with the cells that would go marked
    this.pick.style.top = `${Math.max(4, tb.top - this.pick.offsetHeight - 6)}px`;
  }
  private closePick(refocus: boolean) {
    if (!this.open) return;
    this.open = null;
    document.removeEventListener("keydown", this.onEsc, true);
    this.pick.remove();
    this.bar.querySelector("[data-act=grid]")?.classList.remove("on");
    if (!this.view.isDestroyed) this.view.dispatch(this.view.state.tr.setMeta(PREV, null));
    if (refocus) this.view.focus();
  }
  private size() {
    return { R: Math.max(1, Math.min(40, parseInt(this.inR.value, 10) || 1)), C: Math.max(1, Math.min(12, parseInt(this.inC.value, 10) || 1)) };
  }
  private preview() {
    if (!this.open) return;
    const { R, C } = this.size(), t = this.view.state.doc.nodeAt(this.open.pos)!, m = TableMap.get(t);
    const doom = doomed(t, this.open.pos, R, C), set = new Set(doom.map((d) => d.r * 100 + d.c));
    this.cells.forEach((g, i) => {
      const r = Math.floor(i / GW), c = i % GW;
      g.className = `md-gc${set.has(r * 100 + c) ? " doom" : r < R && c < C ? " in" : r < m.height && c < m.width ? " cur" : ""}`;
    });
    this.pick.querySelector(".md-gp-title")!.textContent = `${R} × ${C}`;
    this.pick.querySelector(".md-gp-warn")!.textContent = doom.length ? `${doom.length} cell${doom.length > 1 ? "s" : ""} with content will be removed (marked in the table)` : "";
    this.view.dispatch(this.view.state.tr.setMeta(PREV, { pos: this.open.pos, R, C }));
  }
  private apply() {
    if (!this.open) return;
    const { R, C } = this.size(), pos = this.open.pos;
    this.closePick(false);
    resizeTable(this.view, pos, R, C);
    this.view.focus();
  }
  destroy() {
    cancelAnimationFrame(this.frame);
    document.removeEventListener("mousedown", this.onDoc, true);
    document.removeEventListener("focusin", this.onFocus);
    document.removeEventListener("focusout", this.onFocus);
    window.removeEventListener("resize", this.onFocus);
    document.removeEventListener("scroll", this.onFocus, true);
    document.removeEventListener("keydown", this.onEsc, true);
    this.bar.remove();
    this.pick.remove();
  }
}

/** The table node for the editor (column resizing on, cells at least CELL_MIN wide), plus the toolbar and shortcuts */
export function tableEditing(base: TNode, isMac: () => boolean | undefined): AnyExtension[] {
  const node = base.extend({
    addProseMirrorPlugins() {
      // the row handle first: tableEditing's mousedown would otherwise start a cell selection on the same press
      return [rowResize(), ...(this.parent?.() ?? []), previewPlugin(), new Plugin({
        key: new PluginKey("cbTableBar"),
        view: (v) => {
          const bar = new TableBar(v, isMac);
          return { update: () => bar.update(), destroy: () => bar.destroy() };
        },
      })];
    },
  }).configure({ resizable: true, cellMinWidth: CELL_MIN, lastColumnResizable: true });
  // ahead of saving (⌘↵ outside a table) and of the paragraph rules
  const keys = Extension.create({
    name: "cbTableKeys",
    priority: 950,
    addKeyboardShortcuts() {
      const e = this.editor as Editor;
      return {
        "Mod-Enter": () => addRow(e.view, true),
        "Mod-Shift-Enter": () => addRow(e.view, false),
        "Mod-Shift-Backspace": () => isInTable(e.state) && deleteRow(e.state, e.view.dispatch),
      };
    },
  });
  // Enter after menus (slash, [[, emoji) and the paragraph rules have had it; a cell cannot split, so those pass it on
  const enter = Extension.create({
    name: "cbTableEnter",
    priority: 99,
    addKeyboardShortcuts() { return { Enter: () => cellDown((this.editor as Editor).view) }; },
  });
  return [node, keys, enter];
}

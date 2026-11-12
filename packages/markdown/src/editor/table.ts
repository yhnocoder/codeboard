// Tables in the editor: the table view with its toolbar band and row / column moves (tableview.ts), the shortcuts, and
// column-width / row-height drags. Widths and heights are layout, not Markdown (layout.ts):
// colwidth on the cells (prosemirror-tables' own column resizing) and height on the rows. Neither drag moves the caret,
// and each is one undo step.
import { Extension, type AnyExtension, type Editor, type Node as TNode } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { deleteRow, isInTable } from "@tiptap/pm/tables";
import { CELL_MIN } from "../layout";
import type { MdClasses } from "../ui/classes";
import { addRow, cellDown, previewPlugin, tablePos } from "./tablecmds";
import { TableBlockView, tableViewAt } from "./tableview";

/** Row heights: drag a row's bottom edge. A line marks the edge while the pointer is near it and follows the drag; the height
 *  is set on release (one step) */
function rowEdge(view: EditorView, e: MouseEvent): HTMLTableRowElement | null {
  const cell = (e.target as Element | null)?.closest?.("td, th");
  if (!cell || !view.dom.contains(cell)) return null;
  const tr = cell.parentElement as HTMLTableRowElement,
    r = tr.getBoundingClientRect(),
    k = tr.offsetHeight ? r.height / tr.offsetHeight : 1,
    d = (r.bottom - e.clientY) / k;
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
  let dragging = false,
    hover: HTMLDivElement | null = null;
  const unhover = () => {
    hover?.remove();
    hover = null;
  };
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
            if (on) hover = rowLine(tr!, hover ?? undefined);
            else unhover();
          });
          return false;
        },
        mouseleave: (view) => {
          view.dom.classList.remove("md-row-resize");
          unhover();
          return false;
        },
        mousedown: (view, e) => {
          if (e.button !== 0) return false;
          const row = rowEdge(view, e);
          if (!row || view.dom.classList.contains("resize-cursor")) return false;
          unhover();
          const pos = view.posAtDOM(row, 0) - 1,
            node = view.state.doc.nodeAt(pos);
          if (node?.type.name !== "tableRow") return false;
          e.preventDefault();
          e.stopPropagation();
          const r = row.getBoundingClientRect(),
            k = row.offsetHeight ? r.height / row.offsetHeight : 1;
          const line = rowLine(row);
          const y0 = e.clientY,
            h0 = row.offsetHeight;
          let h = h0;
          const place = () => {
            line.style.top = `${r.top + h * k}px`;
          };
          place();
          const shield = document.createElement("div");
          shield.className = "md-rowshield";
          document.body.append(shield);
          dragging = true;
          const move = (ev: MouseEvent) => {
            h = Math.max(ROW_MIN, h0 + (ev.clientY - y0) / k);
            place();
          };
          const up = () => {
            window.removeEventListener("mousemove", move, true);
            window.removeEventListener("mouseup", up, true);
            line.remove();
            shield.remove();
            dragging = false;
            view.dom.classList.remove("md-row-resize");
            const n = view.state.doc.nodeAt(pos);
            if (Math.abs(h - h0) >= 1 && n?.type.name === "tableRow")
              view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...n.attrs, height: Math.round(h) }));
          };
          window.addEventListener("mousemove", move, true);
          window.addEventListener("mouseup", up, true);
          return true;
        },
      },
    },
  });
};

/** Tells the table with the caret (its band shows while the caret is in it) and keeps its band's state current */
const caretTable = () =>
  new Plugin({
    key: new PluginKey("cbTableCaret"),
    view: (v) => {
      let cur: TableBlockView | null = null,
        frame = 0;
      const check = () => {
        if (v.isDestroyed) return;
        const live = v.hasFocus() || !!document.activeElement?.closest(".md-bandmenu, .md-gpick");
        const pos = live ? tablePos(v.state) : null,
          dom = pos === null ? null : v.nodeDOM(pos),
          tv = (dom && tableViewAt.get(dom as Element)) ?? null;
        if (tv !== cur) {
          cur?.band.set("focus", false);
          tv?.band.set("focus", true);
          cur = tv;
        }
        cur?.sync();
      };
      const later = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(check);
      };
      v.dom.addEventListener("focusin", later);
      v.dom.addEventListener("focusout", later);
      return {
        update: check,
        destroy: () => {
          cancelAnimationFrame(frame);
          v.dom.removeEventListener("focusin", later);
          v.dom.removeEventListener("focusout", later);
        },
      };
    },
  });

/** The table node for the editor (column resizing on, cells at least CELL_MIN wide), plus the toolbar and shortcuts */
export function tableEditing(base: TNode, classes: () => MdClasses | undefined): AnyExtension[] {
  const node = base
    .extend({
      addProseMirrorPlugins() {
        // the row handle first: tableEditing's mousedown would otherwise start a cell selection on the same press
        return [rowResize(), ...(this.parent?.() ?? []), previewPlugin(), caretTable()];
      },
    })
    .configure({
      resizable: true,
      cellMinWidth: CELL_MIN,
      lastColumnResizable: true,
      View: class extends TableBlockView {
        constructor(n: PMNode, min: number, v: EditorView) {
          super(n, min, v, classes);
        }
      },
    });
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
    addKeyboardShortcuts() {
      return { Enter: () => cellDown((this.editor as Editor).view) };
    },
  });
  return [node, keys, enter];
}

// A table in the editor: its toolbar band (size, rows, columns, alignment; what does not fit goes into ⋯), grips that drag a
// row or column to another place, and inserts and deletes that slide the other rows and columns aside. Nothing here touches
// the cells' own DOM attributes (ProseMirror would read them back as edits): moves are Web Animations, and the grips, the
// lifted copy and the drop line live in an overlay of the table's own, outside its content.
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import {
  CellSelection,
  TableMap,
  addColumnAfter,
  addColumnBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  selectionCell,
} from "@tiptap/pm/tables";
import { TableView } from "@tiptap/extension-table";
import { iconEl, type IconName } from "../ui/icons";
import { captionOf } from "../image";
import { captionHtml } from "../render";
import { mdOf } from "./md";
import { IS_MAC } from "../ui/platform";
import type { MdClasses } from "../ui/classes";
import { TABLE_SLIDE } from "../ui/timing";
import { Band, bandButton, bandMenu, type BandMenuItem } from "./band";
import { PREV, addRow, doomed, resizeTable, setColAlign, tablePos, type Cmd } from "./tablecmds";
import { dragEdge, dropIndex, movedRows, slotsAfter } from "./tablemove";

const GW = 10,
  GH = 8;
type Act = { act: string; icon: IconName; tip: string; kbd?: string };
/** The band's actions, in groups, in their order on the band */
const GROUPS: Act[][] = [
  [
    { act: "rowAbove", icon: "rowAbove", tip: "Insert row above", kbd: "⌘⇧↵" },
    { act: "rowBelow", icon: "rowBelow", tip: "Insert row below", kbd: "⌘↵" },
    { act: "colLeft", icon: "colLeft", tip: "Insert column left" },
    { act: "colRight", icon: "colRight", tip: "Insert column right" },
  ],
  [
    { act: "left", icon: "alignL", tip: "Align column left" },
    { act: "center", icon: "alignC", tip: "Align column center" },
    { act: "right", icon: "alignR", tip: "Align column right" },
  ],
  [
    { act: "delRow", icon: "delRow", tip: "Delete row", kbd: "⌘⇧⌫" },
    { act: "delCol", icon: "delCol", tip: "Delete column" },
  ],
];
/** Which actions stay on a band too narrow for all of them, the most used first */
const KEEP = ["rowBelow", "colRight", "left", "center", "right", "rowAbove", "colLeft", "delRow", "delCol"];
/** A band button and the 1px between two; a group gap; the band row's own padding */
const BTN = 27,
  GAP = 6,
  PAD = 15;
const SLIDE_EASE = "cubic-bezier(0.2, 0.7, 0.3, 1)";
const K = (s: string) =>
  IS_MAC ? s : s.replace(/⌘/g, "Ctrl+").replace(/⇧/g, "Shift+").replace(/⌫/g, "Backspace").replace(/↵/g, "Enter");

/** The table views by their root, for the editor's plugin that tells the one with the caret */
export const tableViewAt = new WeakMap<Element, TableBlockView>();

type Drag = {
  kind: "row" | "col";
  idx: number;
  pointer: number;
  x0: number;
  y0: number;
  live: boolean;
  /** screen pixels per editor pixel */
  s: number;
  first: number;
  starts: number[];
  sizes: number[];
  /** the cells of each row (or column), by index */
  cells: HTMLElement[][];
  offs: number[];
  /** where the table is in the overlay, and its size */
  tb: { x: number; y: number; w: number; h: number };
  t: number;
  slot: number;
  ghost: HTMLDivElement;
  line: HTMLDivElement;
  hole: HTMLDivElement;
};

/** A table (with its caption under it when it has one), its band, its grips */
export class TableBlockView extends TableView {
  private wrap: HTMLElement;
  private cap: string;
  readonly band: Band;
  private size: HTMLButtonElement;
  private count: HTMLSpanElement;
  private btns = new Map<string, HTMLButtonElement>();
  private more: HTMLButtonElement;
  private closeMenu: (() => void) | null = null;
  private pick: GridPick | null = null;
  private ovl: HTMLDivElement;
  private gripR: HTMLDivElement;
  private gripC: HTMLDivElement;
  private hovered: { r: number; c: number; cell: Element } | null = null;
  private drag: Drag | null = null;
  private anims = new Map<Element, Animation>();
  constructor(
    node: PMNode,
    cellMinWidth: number,
    readonly view: EditorView,
    private classes: () => MdClasses | undefined,
  ) {
    super(node, cellMinWidth, view);
    this.wrap = this.dom;
    this.cap = captionOf(node.attrs.caption);
    if (this.cap) {
      // drawn as the static render draws it: the table and the caption under it in a .md-tfig. The caption is the table's
      // attribute, changed only from outside the editor; a table that gains or loses one is drawn again
      const fig = document.createElement("div"),
        c = document.createElement("div");
      fig.className = "md-tfig";
      c.className = "md-cap";
      c.contentEditable = "false";
      c.innerHTML = captionHtml(this.cap, mdOf(view.state));
      fig.append(this.dom, c);
      this.dom = fig;
    }
    tableViewAt.set(this.dom, this);

    this.band = new Band(view, "table", {
      el: this.table,
      // the table's visible part: a table wider than the Note scrolls inside it
      rect: () => {
        const t = this.table.getBoundingClientRect(),
          w = this.wrap.getBoundingClientRect(),
          l = Math.max(t.left, w.left);
        return new DOMRect(l, t.top, Math.min(t.right, w.right) - l, t.height);
      },
      fit: (w) => this.fit(w),
    });
    this.size = document.createElement("button");
    this.size.type = "button";
    this.size.className = "md-tsize";
    this.size.tabIndex = -1;
    this.size.dataset.act = "grid";
    this.size.dataset.tip = "Table size";
    this.size.setAttribute("aria-label", "Table size");
    this.count = document.createElement("span");
    this.count.className = "md-tcount";
    this.size.append(iconEl("grid"), this.count);
    this.size.addEventListener("click", () => this.act("grid"));
    const sp = document.createElement("span");
    sp.className = "md-band-sp";
    this.band.row.append(this.size, sp);
    GROUPS.forEach((g, i) => {
      if (i) this.band.row.append(gap());
      for (const a of g) {
        const b = bandButton(iconEl(a.icon), a.tip, a.act, () => this.act(a.act));
        if (a.kbd) b.dataset.kbd = K(a.kbd);
        this.btns.set(a.act, b);
        this.band.row.append(b);
      }
    });
    this.more = bandButton(iconEl("dots"), "More", "more", (b) =>
      this.closeMenu ? this.closeMenu() : this.openMenu(b),
    );
    this.more.classList.add("dots");
    this.band.row.append(gap(), this.more);
    this.dom.addEventListener("pointerenter", () => this.band.set("hover", true));
    this.dom.addEventListener("pointerleave", () => this.band.set("hover", false));

    this.ovl = document.createElement("div");
    this.ovl.className = "md-tov";
    this.ovl.contentEditable = "false";
    this.ovl.style.setProperty("--md-tslide", `${TABLE_SLIDE}ms`);
    this.gripR = grip("row");
    this.gripC = grip("col");
    this.ovl.append(this.gripR, this.gripC);
    this.wrap.append(this.ovl);
    for (const [g, kind] of [
      [this.gripR, "row"],
      [this.gripC, "col"],
    ] as const)
      g.addEventListener("pointerdown", (e) => this.press(e, g, kind));
    this.wrap.addEventListener("mousemove", (e) => this.hover(e));
    this.wrap.addEventListener("mouseleave", () => this.unhover());
    this.wrap.addEventListener("scroll", () => this.unhover(), { passive: true });
    this.sync();
  }

  /** The table's position in the document */
  pos(): number | null {
    try {
      return this.view.posAtDOM(this.contentDOM, 0) - 1;
    } catch {
      return null;
    }
  }
  update(node: PMNode) {
    if (captionOf(node.attrs.caption) !== this.cap || !super.update(node)) return false;
    this.sync();
    return true;
  }
  stopEvent(e: Event) {
    return this.ovl.contains(e.target as Node);
  }
  /** The size on the band, and which alignment the caret's column has */
  sync() {
    const m = TableMap.get(this.node);
    this.count.textContent = `${m.height}×${m.width}`;
    const st = this.view.state,
      mine = isInTable(st) && tablePos(st) === this.pos();
    const al = mine ? selectionCell(st).nodeAfter?.attrs.align : null;
    for (const a of ["left", "center", "right"]) {
      const b = this.btns.get(a)!;
      b.classList.toggle("on", al === a);
      b.setAttribute("aria-pressed", String(al === a));
    }
  }
  /** As many actions as the band has room for, by KEEP; the rest are in ⋯ */
  private fit(w: number) {
    const fixed = PAD + this.size.offsetWidth + GAP + BTN,
      n = Math.floor((w - fixed - 2 * GAP) / BTN);
    const keep = new Set(KEEP.slice(0, Math.max(0, n)));
    for (const [a, b] of this.btns) b.hidden = !keep.has(a);
    // a group gap with no shown button before it would widen the band past what fixed counts for
    let shown = false;
    for (const el of this.band.row.children as Iterable<HTMLElement>)
      if (el.classList.contains("md-band-gap")) {
        el.hidden = !shown;
        shown = false;
      } else if (el.classList.contains("md-bb") && el !== this.more) shown ||= !el.hidden;
    return fixed;
  }
  private openMenu(anchor: HTMLElement) {
    const items: BandMenuItem[] = GROUPS.flat()
      .filter((a) => this.btns.get(a.act)!.hidden)
      .map((a) => ({ label: a.tip, run: () => this.act(a.act) }));
    if (items.length) items.push("sep");
    items.push({ label: "Delete table", run: () => this.act("delTable"), danger: true });
    this.band.set("held", true);
    this.closeMenu = bandMenu(anchor, items, this.classes(), (refocus) => {
      this.closeMenu = null;
      this.band.set("held", false);
      if (refocus) this.view.focus();
    });
  }
  /** A band action works on the caret's cell; with the caret elsewhere, on the table's last cell */
  private into() {
    const st = this.view.state,
      pos = this.pos();
    if (pos === null || (isInTable(st) && tablePos(st) === pos)) return;
    const m = TableMap.get(this.node),
      off = m.map[m.map.length - 1];
    this.view.dispatch(st.tr.setSelection(TextSelection.near(st.doc.resolve(pos + 1 + off + 1))));
  }
  act(a: string) {
    const v = this.view;
    if (a === "grid") {
      if (this.pick) this.pick.close(true);
      else this.openPick();
      return;
    }
    this.into();
    const run = (c: Cmd) => c(v.state, v.dispatch);
    switch (a) {
      case "rowAbove":
      case "rowBelow":
        this.flip(() => addRow(v, a === "rowBelow"));
        break;
      case "colLeft":
        this.flip(() => run(addColumnBefore));
        break;
      case "colRight":
        this.flip(() => run(addColumnAfter));
        break;
      case "delRow":
        this.flip(() => run(deleteRow));
        break;
      case "delCol":
        this.flip(() => run(deleteColumn));
        break;
      case "left":
      case "center":
      case "right":
        setColAlign(v, a);
        break;
      case "delTable":
        run(deleteTable);
        break;
    }
    v.focus();
  }
  private openPick() {
    const pos = this.pos();
    if (pos === null) return;
    this.band.set("held", true);
    this.size.classList.add("on");
    this.pick = new GridPick(this.view, pos, this.size, (refocus) => {
      this.pick = null;
      this.size.classList.remove("on");
      this.band.set("held", false);
      if (refocus) this.view.focus();
    });
  }

  /** Inserting or deleting a row or column: the cells that stay slide from where they were, new ones fade in, removed ones
   *  fade out where they were */
  private flip(run: () => void) {
    const cells0 = [...this.table.querySelectorAll<HTMLElement>("td, th")],
      before = new Map(cells0.map((c) => [c, c.getBoundingClientRect()]));
    const w0 = this.wrap.getBoundingClientRect(),
      s = this.wrap.offsetWidth ? w0.width / this.wrap.offsetWidth : 1,
      sl = this.wrap.scrollLeft;
    run();
    if (!this.table.isConnected) return;
    const w = this.wrap.getBoundingClientRect(),
      tb = this.table.getBoundingClientRect();
    for (const c of this.table.querySelectorAll<HTMLElement>("td, th")) {
      const b = before.get(c);
      if (!b) {
        c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TABLE_SLIDE, easing: "ease-out" });
        continue;
      }
      before.delete(c);
      const r = c.getBoundingClientRect(),
        dx = (b.left - r.left) / s,
        dy = (b.top - r.top) / s;
      if (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3)
        c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
          duration: TABLE_SLIDE,
          easing: SLIDE_EASE,
        });
    }
    if (!before.size) return;
    // the removed cells: copies where they were, clipped to the table as it is now, fading out
    const gone = document.createElement("div");
    gone.className = "md-tgone";
    const gx = (tb.left - w.left) / s + this.wrap.scrollLeft,
      gy = (tb.top - w.top) / s + this.wrap.scrollTop;
    Object.assign(gone.style, {
      left: `${gx}px`,
      top: `${gy}px`,
      width: `${tb.width / s}px`,
      height: `${tb.height / s}px`,
    });
    for (const [c, b] of before) {
      const x = (b.left - w0.left) / s + sl - gx,
        y = (b.top - w0.top) / s - gy;
      gone.append(copyCell(c, b, s, x, y));
    }
    this.ovl.append(gone);
    gone
      .animate([{ opacity: 1 }, { opacity: 0 }], { duration: TABLE_SLIDE - 20, easing: "ease-out", fill: "forwards" })
      .finished.then(
        () => gone.remove(),
        () => gone.remove(),
      );
  }

  /** The grips follow the hovered cell: one at the left of its row (not the header row), one at the top of its column */
  private hover(e: MouseEvent) {
    if (this.drag || this.ovl.contains(e.target as Node)) return;
    const cell = (e.target as Element).closest?.("td, th");
    if (!cell || !this.contentDOM.contains(cell)) return this.unhover();
    if (this.hovered?.cell === cell) return;
    const tr = cell.parentElement!,
      r = [...this.contentDOM.children].indexOf(tr),
      c = [...tr.children].indexOf(cell);
    this.hovered = { r, c, cell };
    const w = this.wrap.getBoundingClientRect(),
      s = this.wrap.offsetWidth ? w.width / this.wrap.offsetWidth : 1,
      sl = this.wrap.scrollLeft,
      rr = tr.getBoundingClientRect(),
      cr = cell.getBoundingClientRect(),
      tb = this.table.getBoundingClientRect();
    const rowOn = r > 0,
      mid = (cr.left + cr.width / 2 - w.left) / s,
      colOn = mid > 12 && mid < this.wrap.clientWidth - 12;
    if (rowOn) this.gripR.style.translate = `${sl + 3}px ${(rr.top - w.top + rr.height / 2) / s - 8}px`;
    if (colOn) this.gripC.style.translate = `${mid + sl - 8}px ${(tb.top - w.top) / s + 2.5}px`;
    this.gripR.classList.toggle("on", rowOn);
    this.gripC.classList.toggle("on", colOn);
  }
  private unhover() {
    if (this.drag) return;
    this.hovered = null;
    this.gripR.classList.remove("on");
    this.gripC.classList.remove("on");
  }

  private press(e: PointerEvent, g: HTMLElement, kind: "row" | "col") {
    if (e.button !== 0 || !this.hovered || this.drag) return;
    e.preventDefault();
    e.stopPropagation();
    const w = this.wrap.getBoundingClientRect();
    this.drag = {
      kind,
      idx: kind === "row" ? this.hovered.r : this.hovered.c,
      pointer: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      live: false,
      s: this.wrap.offsetWidth ? w.width / this.wrap.offsetWidth : 1,
      first: kind === "row" ? 1 : 0,
      starts: [],
      sizes: [],
      cells: [],
      offs: [],
      tb: { x: 0, y: 0, w: 0, h: 0 },
      t: -1,
      slot: 0,
      ghost: document.createElement("div"),
      line: document.createElement("div"),
      hole: document.createElement("div"),
    };
    g.setPointerCapture(e.pointerId);
    g.classList.add("act");
    const move = (ev: PointerEvent) => this.dragMove(ev);
    const up = () => end(false);
    const esc = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      end(true);
    };
    const end = (back: boolean) => {
      g.removeEventListener("pointermove", move);
      for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) g.removeEventListener(t, up);
      window.removeEventListener("keydown", esc, true);
      if (g.hasPointerCapture(e.pointerId)) g.releasePointerCapture(e.pointerId);
      g.classList.remove("act");
      this.drop(back);
    };
    g.addEventListener("pointermove", move);
    for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) g.addEventListener(t, up);
    window.addEventListener("keydown", esc, true);
  }
  /** The drag starts: everything it needs is measured now, once; moving the pointer only writes */
  private lift(d: Drag) {
    d.live = true;
    this.band.freeze(true);
    mdOf(this.view.state).ghosts.hold(true);
    const w = this.wrap.getBoundingClientRect(),
      sl = this.wrap.scrollLeft,
      st = this.wrap.scrollTop,
      tb = this.table.getBoundingClientRect(),
      trs = [...this.contentDOM.children] as HTMLElement[];
    const X = (x: number) => (x - w.left) / d.s + sl,
      Y = (y: number) => (y - w.top) / d.s + st;
    d.tb = { x: X(tb.left), y: Y(tb.top), w: tb.width / d.s, h: tb.height / d.s };
    if (d.kind === "row") {
      d.cells = trs.map((tr) => [...tr.children] as HTMLElement[]);
      const rs = trs.map((tr) => tr.getBoundingClientRect());
      d.starts = rs.map((r) => Y(r.top));
      d.sizes = rs.map((r) => r.height / d.s);
    } else {
      d.cells = [...trs[0].children].map((_, k) => trs.map((tr) => tr.children[k] as HTMLElement));
      const rs = d.cells.map((col) => col[0].getBoundingClientRect());
      d.starts = rs.map((r) => X(r.left));
      d.sizes = rs.map((r) => r.width / d.s);
    }
    d.offs = d.starts.map(() => 0);
    d.t = d.idx;
    d.slot = d.starts[d.idx];
    // the lifted copy: the row (or column) as it is drawn, at its place, then picked up (scale, shadow)
    const src = d.cells[d.idx],
      rects = src.map((c) => c.getBoundingClientRect());
    const body = document.createElement("div");
    body.className = "md-tg-body";
    const sh = document.createElement("div");
    sh.className = "md-tg-sh";
    const row = d.kind === "row";
    const gw = row ? d.tb.w : d.sizes[d.idx],
      gh = row ? d.sizes[d.idx] : d.tb.h;
    src.forEach((c, i) =>
      body.append(copyCell(c, rects[i], d.s, row ? X(rects[i].left) - d.tb.x : 0, row ? 0 : Y(rects[i].top) - d.tb.y)),
    );
    d.ghost.className = "md-tghost";
    Object.assign(d.ghost.style, { width: `${gw}px`, height: `${gh}px` });
    d.ghost.append(sh, body);
    d.hole.className = "md-thole";
    Object.assign(d.hole.style, { width: `${gw}px`, height: `${gh}px` });
    d.line.className = "md-tdrop";
    Object.assign(d.line.style, row ? { width: `${d.tb.w - 6}px` } : { height: `${d.tb.h - 6}px` });
    this.place(d, d.starts[d.idx]);
    this.ovl.append(d.hole, d.line, d.ghost);
    this.gripR.classList.remove("on");
    this.gripC.classList.remove("on");
    void d.ghost.offsetWidth;
    d.ghost.classList.add("lift");
  }
  /** The copy at the pointer's edge, the hole and the drop line at the slot */
  private place(d: Drag, edge: number) {
    const row = d.kind === "row";
    d.ghost.style.translate = row ? `${d.tb.x}px ${edge}px` : `${edge}px ${d.tb.y}px`;
    d.hole.style.translate = row ? `${d.tb.x}px ${d.slot}px` : `${d.slot}px ${d.tb.y}px`;
    d.line.style.translate = row ? `${d.tb.x + 3}px ${d.slot - 1}px` : `${d.slot - 1}px ${d.tb.y + 3}px`;
  }
  private dragMove(ev: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.live) {
      if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < 4) return;
      this.lift(d);
    }
    const delta = (d.kind === "row" ? ev.clientY - d.y0 : ev.clientX - d.x0) / d.s;
    const edge = dragEdge(d.starts, d.sizes, d.idx, delta, d.first),
      t = dropIndex(d.starts, d.sizes, d.idx, edge, d.first);
    if (t !== d.t) {
      d.t = t;
      const slots = slotsAfter(d.starts, d.sizes, d.idx, t);
      d.slot = slots[d.idx];
      slots.forEach((at, k) => {
        const off = at - d.starts[k];
        if (off !== d.offs[k]) this.slide(d.cells[k], d.kind, d.offs[k], off);
        d.offs[k] = off;
      });
    }
    this.place(d, edge);
  }
  /** Moves cells by an offset with an animation that holds its end (the cells' own style is never written) */
  private slide(cells: HTMLElement[], kind: "row" | "col", from: number, to: number) {
    const tf = (v: number) => (kind === "row" ? `translateY(${v}px)` : `translateX(${v}px)`);
    for (const c of cells) {
      const old = this.anims.get(c);
      const now = old ? getComputedStyle(c).transform : tf(from);
      const a = c.animate([{ transform: now === "none" ? tf(0) : now }, { transform: tf(to) }], {
        duration: TABLE_SLIDE,
        easing: SLIDE_EASE,
        fill: "forwards",
      });
      old?.cancel();
      this.anims.set(c, a);
    }
  }
  /** Release (or Esc): the copy glides into its slot (or home), then the move is made in one step and the copy goes in the
   *  same frame. A press without a drag selects the row or column */
  private drop(back: boolean) {
    const d = this.drag;
    if (!d) return;
    if (!d.live) {
      this.drag = null;
      this.select(d.kind, d.idx);
      return;
    }
    if (back && d.t !== d.idx) {
      d.cells.forEach((cs, k) => {
        if (d.offs[k]) this.slide(cs, d.kind, d.offs[k], 0);
        d.offs[k] = 0;
      });
      d.t = d.idx;
      d.slot = d.starts[d.idx];
    }
    d.ghost.classList.remove("lift");
    d.ghost.classList.add("glide", "land");
    this.place(d, d.slot);
    d.line.classList.add("out");
    setTimeout(() => this.commit(d), TABLE_SLIDE + 10);
  }
  private commit(d: Drag) {
    this.drag = null;
    const pos = this.pos();
    if (d.t !== d.idx && pos !== null && this.node.childCount) {
      const st = this.view.state;
      this.view.dispatch(
        closeHistory(st.tr).replaceWith(
          pos + 1,
          pos + this.node.nodeSize - 1,
          movedRows(this.node, d.kind, d.idx, d.t),
        ),
      );
    }
    for (const a of this.anims.values()) a.cancel();
    this.anims.clear();
    d.ghost.remove();
    d.hole.remove();
    d.line.remove();
    mdOf(this.view.state).ghosts.hold(false);
    this.band.freeze(false);
  }
  private select(kind: "row" | "col", i: number) {
    const pos = this.pos();
    if (pos === null) return;
    const m = TableMap.get(this.node),
      st = this.view.state,
      $c = st.doc.resolve(pos + 1 + m.map[kind === "row" ? i * m.width : i]);
    this.view.dispatch(
      st.tr.setSelection(kind === "row" ? CellSelection.rowSelection($c) : CellSelection.colSelection($c)),
    );
    this.view.focus();
  }
  ignoreMutation(m: MutationRecord) {
    return this.ovl.contains(m.target) || super.ignoreMutation(m);
  }
  destroy() {
    this.closeMenu?.();
    this.pick?.close(false);
    for (const a of this.anims.values()) a.cancel();
    if (this.drag?.live) mdOf(this.view.state).ghosts.hold(false);
    this.drag = null;
    this.band.destroy();
  }
}

function gap() {
  const g = document.createElement("span");
  g.className = "md-band-gap";
  return g;
}
const DOTS = {
  row: [8, 16, "2.75 4.5|5.25 4.5|2.75 8|5.25 8|2.75 11.5|5.25 11.5"],
  col: [16, 7, "4.5 2.25|4.5 4.75|8 2.25|8 4.75|11.5 2.25|11.5 4.75"],
} as const;
function grip(kind: "row" | "col") {
  const g = document.createElement("div"),
    [w, h, dots] = DOTS[kind];
  g.className = `md-tgrip ${kind}`;
  g.dataset.tip =
    kind === "row" ? "Drag to move the row; click to select it" : "Drag to move the column; click to select it";
  g.innerHTML = `<svg viewBox="0 0 ${w} ${h}">${dots
    .split("|")
    .map((p) => {
      const [x, y] = p.split(" ");
      return `<circle cx="${x}" cy="${y}" r=".85"/>`;
    })
    .join("")}</svg>`;
  g.addEventListener("mousedown", (e) => e.preventDefault());
  return g;
}
/** A copy of a cell as it is drawn, at a fixed size, placed at x, y (editor pixels) */
function copyCell(c: HTMLElement, r: DOMRect, s: number, x: number, y: number) {
  const n = document.createElement("div");
  n.className = `md-tcopy ${c.tagName === "TH" ? "th" : "td"}`;
  n.innerHTML = c.innerHTML;
  const cs = getComputedStyle(c);
  Object.assign(n.style, {
    left: `${x}px`,
    top: `${y}px`,
    width: `${r.width / s}px`,
    height: `${r.height / s}px`,
    textAlign: cs.textAlign,
    padding: cs.padding,
    borderRightWidth: cs.borderRightWidth,
    borderBottomWidth: cs.borderBottomWidth,
  });
  return n;
}

/** The size grid: hovering a size marks in the table the cells a resize would drop; on the page, above the band */
class GridPick {
  el: HTMLDivElement;
  private cells: HTMLDivElement[];
  private inR: HTMLInputElement;
  private inC: HTMLInputElement;
  private done = false;
  constructor(
    private view: EditorView,
    private pos: number,
    private anchor: HTMLElement,
    private closed: (refocus: boolean) => void,
  ) {
    const el = (this.el = document.createElement("div"));
    el.className = "mdui md-gpick";
    el.innerHTML = `<div class="md-gp-head"><span class="md-gp-title"></span><span class="md-gp-hint">Header counts as row 1</span></div>
      <div class="md-gp-grid">${'<div class="md-gc"></div>'.repeat(GW * GH)}</div>
      <div class="md-gp-row"><label>Rows <input type="number" min="1" max="40" data-r></label><label>Columns <input type="number" min="1" max="12" data-c></label><span class="sp"></span><button class="md-gp-apply">Apply</button></div>
      <div class="md-gp-warn"></div>`;
    this.cells = [...el.querySelectorAll<HTMLDivElement>(".md-gc")];
    this.inR = el.querySelector("[data-r]")!;
    this.inC = el.querySelector("[data-c]")!;
    el.addEventListener("mousedown", (e) => {
      if (!(e.target as Element).closest("input")) e.preventDefault();
    });
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.cells.forEach((g, i) => {
      g.addEventListener("mouseenter", () => {
        this.inR.value = String(Math.floor(i / GW) + 1);
        this.inC.value = String((i % GW) + 1);
        this.preview();
      });
      g.addEventListener("click", () => this.apply());
    });
    for (const inp of [this.inR, this.inC]) {
      inp.addEventListener("input", () => this.preview());
      inp.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          this.apply();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.close(true);
        }
      });
    }
    el.querySelector(".md-gp-apply")!.addEventListener("click", () => this.apply());
    const m = TableMap.get(view.state.doc.nodeAt(pos)!);
    this.inR.value = String(m.height);
    this.inC.value = String(m.width);
    document.addEventListener("mousedown", this.onDoc, true);
    document.addEventListener("keydown", this.onEsc, true);
    document.body.append(el);
    // opens upwards from the size: the table stays visible, with the cells that would go marked
    const b = anchor.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(b.left - 4, innerWidth - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(4, b.top - el.offsetHeight - 6)}px`;
    this.preview();
  }
  private onDoc = (e: MouseEvent) => {
    if (!this.el.contains(e.target as Node) && !this.anchor.contains(e.target as Node)) this.close(false);
  };
  // Esc while the grid is open closes only the grid: the caret, wherever it is, never sees it (it would leave edit mode)
  private onEsc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    this.close(true);
  };
  close(refocus: boolean) {
    if (this.done) return;
    this.done = true;
    document.removeEventListener("mousedown", this.onDoc, true);
    document.removeEventListener("keydown", this.onEsc, true);
    this.el.remove();
    if (!this.view.isDestroyed) this.view.dispatch(this.view.state.tr.setMeta(PREV, null));
    this.closed(refocus);
  }
  private size() {
    return {
      R: Math.max(1, Math.min(40, parseInt(this.inR.value, 10) || 1)),
      C: Math.max(1, Math.min(12, parseInt(this.inC.value, 10) || 1)),
    };
  }
  private preview() {
    const { R, C } = this.size(),
      t = this.view.state.doc.nodeAt(this.pos)!,
      m = TableMap.get(t);
    const doom = doomed(t, this.pos, R, C),
      set = new Set(doom.map((d) => d.r * 100 + d.c));
    this.cells.forEach((g, i) => {
      const r = Math.floor(i / GW),
        c = i % GW;
      g.className = `md-gc${set.has(r * 100 + c) ? " doom" : r < R && c < C ? " in" : r < m.height && c < m.width ? " cur" : ""}`;
    });
    this.el.querySelector(".md-gp-title")!.textContent = `${R} × ${C}`;
    this.el.querySelector(".md-gp-warn")!.textContent = doom.length
      ? `${doom.length} cell${doom.length > 1 ? "s" : ""} with content will be removed (marked in the table)`
      : "";
    this.view.dispatch(this.view.state.tr.setMeta(PREV, { pos: this.pos, R, C }));
  }
  private apply() {
    const { R, C } = this.size();
    this.close(false);
    resizeTable(this.view, this.pos, R, C);
    this.view.focus();
  }
}

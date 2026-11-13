// A block's toolbar band (code blocks, tables): a 30px strip in the block's own colour that grows upward out of the block's top
// edge and floats over whatever is above it; the block and the Note never resize for it. Bands live in one layer next to the
// editor's root (ProseMirror owns the root's children, and a code block scrolls sideways, which would clip a band inside it),
// placed from the block's box when they come up and again after each change while they are up.
import { Plugin, Selection } from "@tiptap/pm/state";
import { gapPress } from "./gap";
import type { EditorView } from "@tiptap/pm/view";
import { place } from "../ui/place";
import { kindClass, type MdClasses } from "../ui/classes";
import { BAND_GRACE, BAND_HIDE, BAND_SHOW } from "../ui/timing";

const BAND_H = 30;
/** How far inside the box that clips the editor a band stays (a block at the top of a Note whose body scrolls presses its
 *  band into itself instead) */
const TOP_GAP = 2;

/** The nearest box around el that clips what overflows it: a band may float over anything inside it, the card's own header
 *  above a Note's first block too, rather than cover the block's first line */
function clipBox(el: Element): Element {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowY !== "visible" || cs.overflowX !== "visible") return p;
  }
  return document.body;
}

type Why = "hover" | "focus" | "held";

/** Where a band goes: the block's element (its box, its scale on screen) and, for a table narrower than its block, the part of
 *  that box the band spans */
export type BandAnchor = {
  el: HTMLElement;
  rect?: () => DOMRect;
  /** Fits the band's content to its width and gives the least width the band needs (a band wider than its block hangs past
   *  the block's right edge) */
  fit?: (width: number) => number;
};

const layers = new WeakMap<EditorView, BandLayer>();

class BandLayer {
  el: HTMLDivElement;
  shown = new Set<Band>();
  private frame = 0;
  private ro: ResizeObserver | null = null;
  constructor(private view: EditorView) {
    this.el = document.createElement("div");
    this.el.className = "md-bands";
    if (typeof ResizeObserver !== "undefined") this.ro = new ResizeObserver(() => this.later());
  }
  /** The layer sits right after the editor's root: it moves with the editor from one Note to the next */
  attach() {
    const root = this.view.dom;
    if (this.el.previousSibling !== root && root.parentElement) {
      root.after(this.el);
      this.ro?.disconnect();
      this.ro?.observe(root);
    }
  }
  later() {
    if (this.frame || !this.shown.size) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      for (const b of this.shown) b.place();
    });
  }
  destroy() {
    cancelAnimationFrame(this.frame);
    this.ro?.disconnect();
    this.el.remove();
  }
}
const bandLayer = (view: EditorView) => {
  let l = layers.get(view);
  if (!l) layers.set(view, (l = new BandLayer(view)));
  return l;
};
/** Bands that are up follow their blocks after each change; the layer goes with the editor */
export const bandPlugin = () =>
  new Plugin({
    view: (v) => ({
      update: () => layers.get(v)?.later(),
      destroy: () => {
        layers.get(v)?.destroy();
        layers.delete(v);
      },
    }),
  });

export class Band {
  readonly root: HTMLDivElement;
  readonly row: HTMLDivElement;
  private want = new Set<Why>();
  private on = false;
  private frozen = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private clip: Element | null = null;
  constructor(
    private view: EditorView,
    private kind: "code" | "table",
    private anchor: BandAnchor,
  ) {
    const r = (this.root = document.createElement("div"));
    r.className = `md-band md-band-${kind}`;
    r.contentEditable = "false";
    r.style.setProperty("--md-band-in", `${BAND_SHOW}ms`);
    r.style.setProperty("--md-band-out", `${BAND_HIDE}ms`);
    r.innerHTML = `<span class="md-band-cnr l"></span><span class="md-band-cnr r"></span><div class="md-band-clip"><div class="md-band-slide"><div class="md-band-fade"></div><div class="md-band-face"><div class="md-band-row"></div></div></div></div>`;
    this.row = r.querySelector(".md-band-row")!;
    // a press on a control keeps the caret where it is; one on the band's empty part means the place under it (the gap
    // before the block, the text above), which the band only covers. The board does not take either as a press on the card
    r.addEventListener("mousedown", (e) => {
      const t = e.target as Element;
      if (t.closest("input")) return;
      e.preventDefault();
      if (!t.closest("button") && e.button === 0) this.pressUnder(e.clientX, e.clientY);
    });
    r.addEventListener("pointerdown", (e) => e.stopPropagation());
    r.addEventListener("pointerenter", () => this.set("hover", true));
    r.addEventListener("pointerleave", () => this.set("hover", false));
  }
  get shown() {
    return this.on;
  }
  private pressUnder(x: number, y: number) {
    const v = this.view;
    if (!v.editable || gapPress(v, y)) return;
    // the band steps aside for the one hit test that finds the text under it
    const cl = this.root.classList;
    cl.add("through");
    const hit = v.posAtCoords({ left: x, top: y });
    cl.remove("through");
    if (!hit) return;
    v.dispatch(v.state.tr.setSelection(Selection.near(v.state.doc.resolve(hit.pos))));
    v.focus();
  }
  set(why: Why, on: boolean) {
    if (on) this.want.add(why);
    else this.want.delete(why);
    this.sync();
  }
  /** While a row or column of its table is dragged the band stays exactly as it is */
  freeze(on: boolean) {
    this.frozen = on;
    if (!on) this.sync();
  }
  private sync() {
    if (this.frozen) return;
    if (this.want.size) {
      clearTimeout(this.timer);
      this.timer = undefined;
      if (!this.on) this.show();
    } else if (this.on && this.timer === undefined)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (!this.want.size && !this.frozen) this.hide();
      }, BAND_GRACE);
  }
  private show() {
    const layer = bandLayer(this.view);
    layer.attach();
    if (!this.root.isConnected) layer.el.append(this.root);
    // once per showing, not per placing: whether the Note's body scrolls changes only with its size setting
    this.clip = clipBox(layer.el);
    if (this.kind === "code") {
      // the block's own colour, corner and inset, as the page styles it: the label lines up with the code
      const cs = getComputedStyle(this.anchor.el),
        st = this.root.style;
      st.setProperty("--md-band-bg", cs.backgroundColor);
      st.setProperty("--md-band-r", cs.borderTopLeftRadius);
      st.setProperty("--md-band-pl", cs.paddingLeft);
    }
    this.place();
    // drawn hidden once where it now is, then grown: the transition starts from the block's edge
    void this.root.offsetWidth;
    this.on = true;
    layer.shown.add(this);
    this.root.classList.add("on");
  }
  private hide() {
    this.on = false;
    bandLayer(this.view).shown.delete(this);
    this.root.classList.remove("on");
  }
  /** From the block's box, in the editor's own pixels (the board may be zoomed) */
  place() {
    const el = this.anchor.el,
      layer = this.root.parentElement;
    if (!el.isConnected || !layer) return;
    const r = this.anchor.rect?.() ?? el.getBoundingClientRect(),
      L = layer.getBoundingClientRect(),
      s = el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1,
      box = (this.clip ?? document.body).getBoundingClientRect();
    const x = (r.left - L.left) / s,
      y = (r.top - L.top) / s,
      top = Math.max(y - BAND_H, (box.top - L.top) / s + TOP_GAP),
      drop = top - (y - BAND_H);
    const w = r.width / s,
      need = this.anchor.fit?.(w) ?? 0;
    const prev = el.closest(".md-pm > *")?.previousElementSibling;
    const st = this.root.style;
    st.transform = `translate(${x}px, ${top}px)`;
    st.width = `${Math.max(w, need)}px`;
    this.root.classList.toggle("wide", need > w);
    st.setProperty("--md-band-drop", `${drop}px`);
    this.root.dataset.over = !prev || drop > 0.5 ? "none" : prev.matches("pre.md-code") ? "code" : "text";
  }
  destroy() {
    clearTimeout(this.timer);
    bandLayer(this.view).shown.delete(this);
    this.root.remove();
  }
}

export type BandMenuItem = { label: string; run: () => void; danger?: boolean } | "sep";

/** A band's ⋯ menu: on the page (unscaled, like the language list), under its button; Esc or a press elsewhere closes it */
export function bandMenu(
  anchor: HTMLElement,
  items: BandMenuItem[],
  classes: MdClasses | undefined,
  closed: (refocus: boolean) => void,
): () => void {
  const box = document.createElement("div");
  box.className = "mdui-anchor md-bandmenu";
  const m = document.createElement("div");
  m.className = kindClass(classes, "menu");
  box.append(m);
  let done = false;
  const close = (refocus: boolean) => {
    if (done) return;
    done = true;
    document.removeEventListener("mousedown", away, true);
    document.removeEventListener("keydown", esc, true);
    anchor.classList.remove("on");
    box.remove();
    closed(refocus);
  };
  for (const it of items) {
    if (it === "sep") {
      m.append(document.createElement("hr"));
      continue;
    }
    const b = document.createElement("button");
    b.className = it.danger ? "danger" : "";
    b.innerHTML = `<span class="lb"></span>`;
    b.firstElementChild!.textContent = it.label;
    b.addEventListener("click", () => {
      close(false);
      it.run();
    });
    m.append(b);
  }
  box.addEventListener("mousedown", (e) => e.preventDefault());
  box.addEventListener("pointerdown", (e) => e.stopPropagation());
  const away = (e: Event) => {
    const t = e.target as Node;
    if (!box.contains(t) && !anchor.contains(t)) close(false);
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close(true);
  };
  document.addEventListener("mousedown", away, true);
  document.addEventListener("keydown", esc, true);
  anchor.classList.add("on");
  document.body.append(box);
  void m.offsetWidth;
  m.classList.add("open");
  void place(box, anchor, "bottom-end", { gap: 4, pad: 6, strategy: "fixed" }).then(({ x, y }) => {
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
  });
  return () => close(false);
}

/** A band button: an icon with its tip; presses never take the focus */
export function bandButton(icon: SVGElement, tip: string, act: string, run: (b: HTMLButtonElement) => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "md-bb";
  b.tabIndex = -1;
  b.dataset.act = act;
  b.dataset.tip = tip;
  b.setAttribute("aria-label", tip);
  b.append(icon);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    run(b);
  });
  return b;
}

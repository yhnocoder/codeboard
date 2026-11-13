// A heading is a paragraph with a level (schema.ts): its `#` marker is never part of its text, so the text does not move
// when the caret comes and goes. While the caret is in one, a small chip in the left padding says its level ("H2"),
// baseline to baseline with the heading's first line (an inline-block of no width at the start of the line, so the
// browser aligns it); clicking it opens a menu of levels.
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Slice } from "@tiptap/pm/model";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { closeHistory } from "@tiptap/pm/history";
import { place } from "../ui/place";
import { kindClass, type MdClasses } from "../ui/classes";
import { IS_MAC } from "../ui/platform";
import { inlineKey } from "./inlinekey";

const MAX_LEVEL = 6;
const inCell = (state: EditorState, pos: number) =>
  /cell/.test(state.doc.resolve(pos).parent.type.spec.tableRole ?? "");

/** Sets the level of the paragraph at pos (0 = body text); false where it cannot be a heading (a table cell) */
export function setLevel(view: EditorView, pos: number, level: number): boolean {
  const n = view.state.doc.nodeAt(pos);
  if (n?.type.name !== "paragraph" || inCell(view.state, pos)) return false;
  const l = Math.max(0, Math.min(MAX_LEVEL, level));
  if (l !== n.attrs.level)
    view.dispatch(closeHistory(view.state.tr.setNodeMarkup(pos, undefined, { ...n.attrs, level: l })).scrollIntoView());
  return true;
}

/** Replaces the selection with a pasted slice. A slice open at a paragraph takes the level of the paragraph it lands in;
 *  into an empty one, a pasted heading stays a heading */
export function pasteSlice(tr: Transaction, slice: Slice): Transaction {
  const sel = tr.selection,
    $s = sel.$from,
    level = slice.openStart ? (slice.content.firstChild?.attrs.level ?? 0) : 0;
  const into =
    level && sel.empty && $s.depth && $s.parent.type.name === "paragraph" && !$s.parent.content.size
      ? $s.before()
      : null;
  tr.replaceSelection(slice);
  if (into !== null && !/cell/.test(tr.doc.resolve(into).parent.type.spec.tableRole ?? ""))
    tr.setNodeMarkup(into, undefined, { ...tr.doc.nodeAt(into)!.attrs, level });
  return tr;
}

const key = new PluginKey("cbHeadings");
const KEY_HINT = IS_MAC ? "⌘" : "Ctrl+";

class LevelMenu {
  private box: HTMLDivElement;
  constructor(
    private view: EditorView,
    private pos: number,
    private anchor: HTMLElement,
    classes: MdClasses | undefined,
    private done: () => void,
  ) {
    const cur = view.state.doc.nodeAt(pos)?.attrs.level ?? 0;
    // on the page, not in the card (not scaled with the board); .mdui-anchor: the editor counts it as its own, so focus
    // and clicks here do not end the edit
    const b = (this.box = document.createElement("div"));
    b.className = "mdui-anchor md-hmenubox";
    const m = document.createElement("div");
    m.className = `${kindClass(classes, "menu")} md-hmenu`;
    m.setAttribute("role", "menu");
    for (let l = 0; l <= MAX_LEVEL; l++) {
      const it = document.createElement("button");
      it.type = "button";
      it.tabIndex = -1;
      it.dataset.l = String(l);
      it.setAttribute("role", "menuitemradio");
      it.setAttribute("aria-checked", String(l === cur));
      it.innerHTML = `<span class="ck"></span><span class="lb"></span><small></small>`;
      const [ck, lb, sm] = it.children;
      ck.textContent = l === cur ? "✓" : "";
      lb.textContent = l ? `Heading ${l}` : "Text";
      sm.textContent = `${KEY_HINT}${l}`;
      it.addEventListener("click", () => {
        const p = this.pos;
        this.close();
        setLevel(this.view, p, l);
      });
      m.append(it);
    }
    b.append(m);
    // the caret stays in the heading
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.addEventListener("mousedown", this.away, true);
    document.addEventListener("keydown", this.esc, true);
    document.body.append(b);
    anchor.classList.add("open");
    void place(b, anchor, "bottom-start", { gap: 4, pad: 6, strategy: "fixed" }).then(({ x, y, placement }) => {
      if (!b.isConnected) return;
      b.style.left = `${x}px`;
      b.style.top = `${y}px`;
      m.style.transformOrigin = placement.startsWith("top") ? "0 100%" : "0 0";
      void m.offsetWidth;
      m.classList.add("open");
    });
  }
  private away = (e: Event) => {
    const t = e.target as Node;
    if (!this.box.contains(t) && !this.anchor.contains(t)) this.close();
  };
  private esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    // only the menu closes, the edit goes on
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };
  /** the heading moved (typing elsewhere, undo): the menu follows it, or closes once it is gone */
  map(state: EditorState, pos: number | null) {
    if (pos === null || state.doc.nodeAt(pos)?.type.name !== "paragraph") this.close();
    else this.pos = pos;
  }
  close() {
    document.removeEventListener("mousedown", this.away, true);
    document.removeEventListener("keydown", this.esc, true);
    this.anchor.classList.remove("open");
    this.box.remove();
    this.done();
  }
}

/** The heading the chip is for: the caret's paragraph, when it has a level and the editor has the caret */
function chipAt(state: EditorState): { pos: number; level: number } | null {
  const sel = state.selection,
    $h = sel.$head;
  if (!$h.depth || $h.parent.type.name !== "paragraph" || !$h.parent.attrs.level) return null;
  if (!inlineKey.getState(state)?.focused) return null;
  return { pos: $h.before(), level: $h.parent.attrs.level };
}

export function headingsPlugin(classes: () => MdClasses | undefined) {
  let menu: LevelMenu | null = null;
  const chip = (level: number) => (view: EditorView, getPos: () => number | undefined) => {
    const w = document.createElement("span");
    w.className = "md-hchip";
    w.contentEditable = "false";
    const b = document.createElement("span");
    b.className = "md-hchip-b";
    b.setAttribute("role", "button");
    b.setAttribute("aria-label", `Heading ${level}: change the level`);
    b.setAttribute("aria-haspopup", "menu");
    b.innerHTML = `<span class="hh">H</span>${level}`;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (menu) {
        menu.close();
        return;
      }
      const p = getPos();
      if (p === undefined) return;
      const pos = view.state.doc.resolve(p).before();
      menu = new LevelMenu(view, pos, b, classes(), () => {
        menu = null;
      });
    });
    w.append(b);
    return w;
  };
  return new Plugin({
    key,
    props: {
      decorations(state) {
        const at = chipAt(state);
        if (!at) return null;
        return DecorationSet.create(state.doc, [
          Decoration.widget(at.pos + 1, chip(at.level), {
            side: -1,
            key: `hchip:${at.level}`,
            ignoreSelection: true,
            stopEvent: () => true,
          }),
        ]);
      },
    },
    view: () => ({
      update: (v) => menu?.map(v.state, chipAt(v.state)?.pos ?? null),
      destroy: () => menu?.close(),
    }),
  });
}

// The Note page of the Mac app: Notes on cards laid out as the VS Code board lays them out (the board's own
// stylesheets, in the board theme the canvas draws), drawn by the Markdown package's editor, so a snapshot of one is
// what editing it shows. Many Notes stay mounted at once, each in a slot of its own at the page's top left, all hidden
// but the one being snapshotted: measuring a board is one layout pass, and a picture at another scale lays nothing out
// again. Native drives it through window.note and hears back on the "note" message handler.
import { createMarkdown, type Markdown, type MdLayout, type RefBroken, type RefTarget } from "@yhnocoder/markdown";
import { type MdEditorHandle, mountEditor, warmUp } from "@yhnocoder/markdown/editor";
import "@yhnocoder/markdown/katex.css";
import "../../../../packages/board/src/fonts.css";
import "../../../../packages/board/src/styles.css";
import "@yhnocoder/markdown/style.css";
import "../../../../packages/board/src/themes.css";
import "./page.css";

/** CodeBoardNotes' PageNote, as JSON */
type Note = {
  text: string;
  layout: MdLayout | null;
  style:
    | { note: Record<string, never> }
    | { text: { look: "text" | "box"; fill: string; fontSize: number; wrap: boolean } };
  width: number;
  height: number | null;
  /** The board theme's id: html[data-look] and its class, as the board's settings apply it (actions/settings.ts applyLook) */
  look: string;
  /** Its dark variant: html[data-theme="dark"], as the board's host sets it */
  dark: boolean;
  /** What its [[refs]] point at, as the board resolves them (CodeBoardNotes' NoteRef); one not here is not found */
  refs: { label: string; target: string | null; hit: RefTarget | RefBroken }[];
};

declare global {
  interface Window {
    note: unknown;
    webkit?: { messageHandlers: { note: { postMessage(m: unknown): void } } };
  }
}

/** Loaded as page.html?edit: the one Note being edited, in the web view over the canvas, which takes the keyboard.
 *  Otherwise the page only draws */
const editMode = new URLSearchParams(location.search).has("edit");
document.documentElement.classList.add(editMode ? "edit" : "render");
// mounting the editor focuses it, and a web view in the background that asks for focus takes the keyboard from the
// window the user types in
if (!editMode) HTMLElement.prototype.focus = () => {};

const refKey = (label: string, target?: string | null) => `${label}\u0000${target ?? ""}`;

/** A Markdown instance for one Note: its images resolve against the Note's folder, and its [[refs]] as given. Its own,
 *  not shared: an instance learns the size of each image it loads and lays the image out from that size the next time,
 *  a fraction of a pixel off the first, and the first is what a Note on the board is drawn as */
function mdFor(images: string, refs: Note["refs"]): Markdown {
  const hits = new Map(refs.map((r) => [refKey(r.label, r.target), r.hit]));
  // images load at once, not when scrolled to: the picture waits for every one of them
  const md = createMarkdown({
    eagerImages: true,
    refs: { resolve: (label, target) => hits.get(refKey(label, target)) ?? null },
  });
  md.setAssetBase("images", images);
  return md;
}
// the editor's code runs once on a sample before the first Note, so the first one mounts as fast as the rest
warmUp(mdFor("", []));

/** A mounted Note (or image): its slot is laid out as the page's top left corner, hidden unless it is the one shown */
type Slot = { slot: HTMLDivElement; card: HTMLElement; editor?: MdEditorHandle };
const root = document.getElementById("root") as HTMLDivElement;
const slots = new Map<string, Slot>();
let shown: Slot | undefined;
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** The card and body classes Card.tsx and NoteBody.tsx give each kind, with the variables they set on the card */
function cardFor(n: Note): { card: HTMLDivElement; body: HTMLDivElement } {
  const c = document.createElement("div");
  const face = document.createElement("div");
  const body = document.createElement("div");
  face.className = "cface";
  c.append(face);
  const s = n.style;
  if ("note" in s) {
    c.className = "card note";
    // the header keeps its height (the canvas draws the header itself)
    const head = document.createElement("div");
    head.className = "chead";
    face.append(head);
    body.className = "nbody";
    c.style.width = `${n.width}px`;
  } else {
    // a Text or Box: Markdown at the card's own size, as wide as its text unless it wraps at its width (cardsel.ts
    // cardKindClass, Card.tsx style)
    const t = s.text;
    c.className = t.look === "box" ? "card text box" : "card text";
    c.style.setProperty("--tfs", `${t.fontSize}px`);
    if (t.look === "box") c.style.setProperty("--fc", `var(--bf-${t.fill})`);
    if (t.wrap) {
      c.classList.add("wrapw");
      // width 0: as narrow as its longest word goes (the board's leastWidth, interact.ts), what a side edge stops at
      c.style.width = n.width ? `${n.width}px` : "min-content";
    }
    body.className = "tx tb st-body";
  }
  // the classes of a card being edited: this picture is the editor's
  c.classList.add("editing");
  if (n.height === null) c.classList.add("autoh");
  else c.style.height = `${n.height}px`;
  body.classList.add("editing", "md");
  face.append(body);
  return { card: c, body };
}

/** Resolves once everything that can still change the pictures is in: fonts, and images loaded and decoded; after two
 *  frames unless `laidOut` (a Note shown again: it was laid out when mounted, and a snapshot waits for the screen
 *  update anyway). Whether every image of each came in */
async function settled(els: HTMLElement[], laidOut = false): Promise<boolean[]> {
  await document.fonts.ready;
  const loaded = await Promise.all(
    els.map((el) =>
      Promise.all(
        [...el.querySelectorAll("img")].map((img) =>
          img.decode().then(
            () => true,
            () => false,
          ),
        ),
      ).then((all) => all.every(Boolean)),
    ),
  );
  await document.fonts.ready;
  if (!laidOut) await frames();
  return loaded;
}

type Size = { width: number; height: number; complete: boolean };

/** The cards' sizes in CSS px, once everything is in, and whether every image came in */
async function measure(ids: string[]): Promise<Record<string, Size>> {
  const there = ids.flatMap((id) => {
    const s = slots.get(id);
    return s ? [[id, s] as const] : [];
  });
  const complete = await settled(there.map(([, s]) => s.card));
  const out: Record<string, Size> = {};
  there.forEach(([id, s], i) => {
    const r = s.card.getBoundingClientRect();
    out[id] = { width: r.width, height: r.height, complete: complete[i] };
  });
  return out;
}

function newSlot(id: string, card: HTMLElement): Slot {
  const slot = document.createElement("div");
  slot.className = "slot";
  slot.append(card);
  root.append(slot);
  const s: Slot = { slot, card };
  slots.set(id, s);
  return s;
}

function drop(id: string) {
  const s = slots.get(id);
  if (!s) return;
  if (shown === s) shown = undefined;
  s.editor?.destroy();
  s.slot.remove();
  slots.delete(id);
}

function setLook(look: string, dark: boolean) {
  const html = document.documentElement;
  const theme = dark ? "dark" : "light";
  if (html.dataset.look === look && html.dataset.theme === theme) return;
  // every mounted Note is drawn in the page's one look and appearance
  for (const id of [...slots.keys()]) drop(id);
  html.classList.remove(`look-${html.dataset.look}`);
  html.dataset.look = look;
  html.dataset.theme = theme;
  html.classList.add(`look-${look}`);
}

window.note = {
  /** Mounts Notes at 100 % (each one not mounted yet, under its id) and measures them all */
  async mount(list: { id: string; note: Note; images: string }[]) {
    for (const { id, note: n, images } of list) {
      if (slots.has(id)) continue;
      setLook(n.look, n.dark);
      const made = cardFor(n);
      const s = newSlot(id, made.card);
      s.editor = mountEditor(mdFor(images, n.refs), made.body, {
        value: n.text,
        layout: n.layout,
        onDone: () => {},
        scrollOwnBox: true,
      });
    }
    return measure(list.map((l) => l.id));
  },
  /** An image file as the board's image card shows it (Card.tsx, .imgb img): an <img> `width` px wide, as tall as its
   * proportions make it, on a dark board or not. An SVG in an <img> sees only itself: its own styles and variables,
   * none of the page's, and its prefers-color-scheme rules follow the board's appearance */
  async image(id: string, src: string, width: number, dark: boolean) {
    setLook(document.documentElement.dataset.look ?? "warm-ink", dark);
    if (!slots.has(id)) {
      const img = document.createElement("img");
      img.style.width = `${width}px`;
      img.style.display = "block";
      img.src = src;
      const card = document.createElement("div");
      card.append(img);
      newSlot(id, card);
    }
    return (await measure([id]))[id];
  },
  /** Measures again after the view grew: code blocks draw only the lines in view, so a card can grow with it */
  measure,
  /** Where each mounted card's first glyph is, from its top left at 100 % (null: no text), as the board measures it
   *  when a Text becomes a Box (notes.ts setTextLook: that glyph stays where it was) */
  first(ids: string[]) {
    const out: Record<string, { x: number; y: number } | null> = {};
    for (const id of ids) {
      const s = slots.get(id);
      if (!s) continue;
      const k = Number(s.slot.dataset.k ?? 1);
      const c = s.card.getBoundingClientRect();
      const walk = document.createTreeWalker(s.card, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      out[id] = null;
      for (let n = walk.nextNode() as Text | null; n && !out[id]; n = walk.nextNode() as Text | null) {
        const i = n.data.search(/\S/);
        if (i < 0) continue;
        range.setStart(n, i);
        range.setEnd(n, i + 1);
        const b = range.getBoundingClientRect();
        out[id] = { x: (b.left - c.left) / k, y: (b.top - c.top) / k };
      }
    }
    return out;
  },
  /** Shows that Note alone, at a zoom as the editor is shown at one: its 100 % layout under a CSS transform, so no line
   * breaks move. Resolves once its images are decoded again (a hidden image's pixels may have been let go) */
  async show(id: string, k: number) {
    const s = slots.get(id);
    if (!s) return null;
    if (shown && shown !== s) {
      shown.slot.classList.remove("shown");
      shown.slot.style.transform = "";
    }
    shown = s;
    s.slot.classList.add("shown");
    s.slot.style.transform = k === 1 ? "" : `scale(${k})`;
    return (await settled([s.card], true))[0];
  },
  /** Lets these go */
  drop(ids: string[]) {
    for (const id of ids) drop(id);
  },
};
/** What the editing web view posts: its card's size as it changes, and that the editor left by itself (Esc) */
type Posted =
  | { type: "size"; width: number; height: number }
  | { type: "done"; text: string | null; layout: MdLayout | null; layoutChanged: boolean }
  | { type: "ui"; rects: { x: number; y: number; width: number; height: number }[] };
const post = (m: Posted) => window.webkit?.messageHandlers.note.postMessage(m);

/** The card being edited: its slot is placed `margin` px in from the page's top left, so the editor's menus have room */
type Editing = { slot: Slot; original: string; layout: MdLayout | null; editor: MdEditorHandle; ended: boolean };
let editing: Editing | undefined;
const margin = () => Number(document.documentElement.dataset.margin ?? 0);

/** The editor's DOM as it is now, kept in its place as static content once the editor is gone: what was typed stays
 *  on screen until native has its picture under the web view (no caret, no selection) */
function keepStatic(e: Editing) {
  const body = e.slot.card.querySelector<HTMLElement>(".cface > .editing");
  const box = body?.firstElementChild as HTMLElement | null;
  if (!body || !box) return;
  const copy = box.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
  copy.querySelectorAll(".ProseMirror-gapcursor, .ProseMirror-separator").forEach((n) => n.remove());
  copy.classList.add("kept");
  body.append(copy);
  box.style.display = "none";
}

/** Ends the editing: what was written (null when nothing changed) and its layout; the content stays shown until clear */
function end(e: Editing, text: string | null, layout: MdLayout | null) {
  if (e.ended) return null;
  e.ended = true;
  keepStatic(e);
  return { text, layout, layoutChanged: JSON.stringify(layout ?? null) !== JSON.stringify(e.layout ?? null) };
}

/** Where the editor's own menus and boxes are (page px): native lets the pointer through everywhere else outside
 *  the card */
function watchUi() {
  let queued = false;
  const send = () => {
    queued = false;
    const rects = [...document.querySelectorAll<HTMLElement>(".mdui > *, .mdui-anchor")]
      .map((n) => n.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
    post({ type: "ui", rects });
  };
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(send);
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
}
if (editMode) watchUi();

const edit = {
  /** Mounts `note` in the editor, `margin` px from the page's top left, at zoom k, takes the keyboard and puts the
   *  caret at `caret` (card px at 100 %), else at the end; resolves with its size once laid out */
  async begin(a: {
    note: Note;
    images: string;
    k: number;
    margin: number;
    caret: { x: number; y: number } | null;
    placeholder: string;
  }) {
    edit.clear();
    setLook(a.note.look, a.note.dark);
    document.documentElement.dataset.margin = String(a.margin);
    const made = cardFor(a.note);
    const s = newSlot("edit", made.card);
    s.slot.classList.add("shown");
    s.slot.style.left = `${a.margin}px`;
    s.slot.style.top = `${a.margin}px`;
    s.slot.style.transform = a.k === 1 ? "" : `scale(${a.k})`;
    const isText = "text" in a.note.style;
    const e: Editing = {
      slot: s,
      original: a.note.text,
      layout: a.note.layout,
      ended: false,
      editor: undefined as unknown as MdEditorHandle,
    };
    const md = mdFor(a.images, a.note.refs);
    e.editor = mountEditor(md, made.body, {
      value: a.note.text,
      layout: a.note.layout,
      placeholder: a.placeholder,
      headingChip: !isText,
      scrollOwnBox: true,
      onDone: (v, l) => {
        const r = end(e, v, l === undefined ? e.layout : l);
        if (r) post({ type: "done", ...r });
      },
      saveImage: (dataUrl, name) =>
        (window.webkit?.messageHandlers as unknown as { image: { postMessage(m: unknown): Promise<string | null> } })
          .image.postMessage({ dataUrl, name })
          .catch(() => null),
    });
    s.editor = e.editor;
    editing = e;
    let last = "";
    new ResizeObserver(() => {
      const r = made.card.getBoundingClientRect();
      const k = Number(s.slot.dataset.k ?? 1);
      const size = { width: r.width / k, height: r.height / k };
      const key = `${size.width} ${size.height}`;
      if (key === last) return;
      last = key;
      post({ type: "size", ...size });
    }).observe(made.card);
    s.slot.dataset.k = String(a.k);
    await settled([made.card]);
    if (a.caret) e.editor.placeCaret({ x: a.margin + a.caret.x * a.k, y: a.margin + a.caret.y * a.k });
    else e.editor.placeCaret("end");
    const r = made.card.getBoundingClientRect();
    return { width: r.width / a.k, height: r.height / a.k };
  },
  /** The zoom it is shown at; resolves once drawn so */
  async zoom(k: number) {
    if (!editing) return;
    const s = editing.slot.slot;
    s.dataset.k = String(k);
    s.style.transform = k === 1 ? "" : `scale(${k})`;
    await frames();
  },
  /** Types text at the caret as if typed on the keyboard */
  type(text: string) {
    if (editing && !editing.ended) editing.editor.type(text);
  },
  /** Native ends the editing (a click outside): what was written; what is shown stays until clear */
  finish() {
    if (!editing) return null;
    const e = editing;
    const r = end(e, e.editor.value(), e.editor.layout());
    if (r) e.editor.destroy();
    return r;
  },
  /** Lets the card go, once native shows its picture */
  clear() {
    if (!editing) return;
    const e = editing;
    editing = undefined;
    if (!e.ended) e.editor.destroy();
    e.slot.editor = undefined;
    drop("edit");
  },
};
(window as unknown as { edit: typeof edit }).edit = edit;
window.webkit?.messageHandlers.note.postMessage("ready");

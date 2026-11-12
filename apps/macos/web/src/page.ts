// The Note page of the Mac app: one Note on a card laid out as the VS Code board lays it out (the board's own stylesheets,
// in the board theme the canvas draws), drawn by the Markdown package's editor, so a snapshot of it is what editing it shows. Native drives it
// through window.note and hears back on the "note" message handler.
import { createMarkdown, type MdLayout, type RefBroken, type RefTarget } from "@yhnocoder/markdown";
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
    | { text: { size: "title" | "heading" | "body"; bold: boolean } }
    | { box: { fill: string } }
    | { mark: { color: string; weight: "light" | "regular" | "bold"; fontSize?: number } }
    | { freeText: { level: number; bold: boolean; fontSize?: number } };
  width: number;
  height: number | null;
  /** The board theme's id: html[data-look] and its class, as the board's settings apply it (actions/settings.ts applyLook) */
  look: string;
  /** What its [[refs]] point at, as the board resolves them (CodeBoardNotes' NoteRef); one not here is not found */
  refs: { label: string; target: string | null; hit: RefTarget | RefBroken }[];
};

declare global {
  interface Window {
    note: unknown;
    webkit?: { messageHandlers: { note: { postMessage(m: unknown): void } } };
  }
}

// The page only draws: mounting the editor focuses it, and a web view in the background that asks for focus takes the
// keyboard from the window the user types in
HTMLElement.prototype.focus = () => {};

const refKey = (label: string, target?: string | null) => `${label}\u0000${target ?? ""}`;
let refs = new Map<string, RefTarget | RefBroken>();
// images load at once, not when scrolled to: the picture waits for every one of them
const md = createMarkdown({
  eagerImages: true,
  refs: { resolve: (label, target) => refs.get(refKey(label, target)) ?? null },
});
warmUp(md);
const root = document.getElementById("root") as HTMLDivElement;
let editor: MdEditorHandle | undefined;
let card: HTMLDivElement | undefined;
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

const HAND_WEIGHT = { light: 300, regular: 400, bold: 700 };
const FREE_TEXT_SIZE = [20, 40, 30, 24];

/** The card and body classes Card.tsx and NoteBody.tsx give each style, with the variables they set on the card */
function cardFor(n: Note): { card: HTMLDivElement; body: HTMLDivElement; markdown: boolean } {
  const c = document.createElement("div");
  const face = document.createElement("div");
  const body = document.createElement("div");
  face.className = "cface";
  c.append(face);
  let markdown = true;
  const s = n.style;
  if ("note" in s) {
    c.className = "card note";
    // the header keeps its height (the canvas draws the header itself)
    const head = document.createElement("div");
    head.className = "chead";
    face.append(head);
    body.className = "nbody";
  } else if ("text" in s) {
    c.className = "card text";
    body.className = `tx st-${s.text.size}`;
    if (s.text.bold) body.style.fontWeight = "650";
  } else if ("box" in s) {
    c.className = "card text box";
    c.style.setProperty("--fc", `var(--bf-${s.box.fill})`);
    body.className = "tx bx";
  } else if ("mark" in s) {
    c.className = "card text mark";
    c.style.setProperty("--hc", `var(--hd-${s.mark.color})`);
    c.style.setProperty("--hw", String(HAND_WEIGHT[s.mark.weight]));
    c.style.setProperty("--tfs", `${s.mark.fontSize ?? 18}px`);
    body.className = "tx hand";
  } else {
    const { level, bold, fontSize } = s.freeText;
    c.className = "card text freetext";
    c.style.setProperty("--tfs", `${fontSize ?? FREE_TEXT_SIZE[level]}px`);
    body.className = `tx ft ft-l${level} ${level === 3 ? "st-heading" : level ? "st-title" : "st-body"}${bold ? " ftb" : ""}`;
    markdown = false;
  }
  // the classes of a card being edited: this picture is the editor's
  c.classList.add("editing");
  if (n.height === null) c.classList.add("autoh");
  else c.style.setProperty("box" in s ? "min-height" : "height", `${n.height}px`);
  if (!("freeText" in s)) c.style.width = `${n.width}px`;
  body.classList.add("editing");
  if (markdown) body.classList.add("md");
  face.append(body);
  return { card: c, body, markdown };
}

/** Resolves once everything that can still change the picture is in: fonts, and images loaded and decoded */
async function settled(el: HTMLElement): Promise<boolean> {
  await document.fonts.ready;
  const loaded = await Promise.all(
    [...el.querySelectorAll("img")].map((img) =>
      img.decode().then(
        () => true,
        () => false,
      ),
    ),
  );
  await document.fonts.ready;
  await frames();
  return loaded.every(Boolean);
}

/** The card's size in CSS px, once everything is in, and whether every image came in */
async function measure() {
  if (!card) return null;
  const complete = await settled(card);
  const r = card.getBoundingClientRect();
  return { width: r.width, height: r.height, complete };
}

window.note = {
  /** Shows the Note at 100 % and measures it */
  async show(n: Note, images: string) {
    editor?.destroy();
    editor = undefined;
    card?.remove();
    md.setAssetBase("images", images);
    refs = new Map(n.refs.map((r) => [refKey(r.label, r.target), r.hit]));
    const html = document.documentElement;
    if (html.dataset.look !== n.look) {
      html.classList.remove(`look-${html.dataset.look}`);
      html.dataset.look = n.look;
      html.classList.add(`look-${n.look}`);
    }
    const made = cardFor(n);
    card = made.card;
    root.style.transform = "";
    root.append(card);
    if (made.markdown)
      editor = mountEditor(md, made.body, { value: n.text, layout: n.layout, onDone: () => {}, scrollOwnBox: true });
    else made.body.textContent = n.text;
    return measure();
  },
  /** An image file as the board's image card shows it (Card.tsx, .imgb img): an <img> `width` px wide, as tall as its
   * proportions make it. An SVG in an <img> sees only itself: its own styles and variables, none of the page's */
  async image(src: string, width: number) {
    editor?.destroy();
    editor = undefined;
    card?.remove();
    root.style.transform = "";
    const img = document.createElement("img");
    img.style.width = `${width}px`;
    img.style.display = "block";
    img.src = src;
    card = document.createElement("div");
    card.append(img);
    root.append(card);
    return measure();
  },
  /** Measures again after the view grew: code blocks draw only the lines in view, so the card can grow with it */
  measure,
  /** The Note at a zoom as the editor is shown at one: its 100 % layout under a CSS transform, so no line breaks move */
  async scale(k: number) {
    root.style.transform = k === 1 ? "" : `scale(${k})`;
    await frames();
  },
};
window.webkit?.messageHandlers.note.postMessage("ready");

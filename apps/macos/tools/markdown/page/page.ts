// The look tools' reference (tools/markdown: styles.mjs, look.mjs): Notes drawn as the web board draws them, on cards
// laid out as the VS Code board lays them out (the board's own stylesheets, in the board theme asked for), by the
// Markdown package's editor. The Mac app draws Notes natively; this page is what they are compared with. Many Notes
// stay mounted at once, each in a slot of its own at the page's top left, all hidden but the one shown. Built by
// build.mjs next to it into apps/macos/.build-look/page.
import { createMarkdown, type Markdown, type MdLayout, type RefBroken, type RefTarget } from "@yhnocoder/markdown";
import { type MdEditorHandle, mountEditor, warmUp } from "@yhnocoder/markdown/editor";
import "@yhnocoder/markdown/katex.css";
import "../../../../../packages/board/src/fonts.css";
import "../../../../../packages/board/src/styles.css";
import "@yhnocoder/markdown/style.css";
import "../../../../../packages/board/src/themes.css";
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
  /** Its dark variant: html[data-theme="dark"], as the board's host sets it */
  dark: boolean;
  /** What its [[refs]] point at, as the board resolves them (CodeBoardNotes' NoteRef); one not here is not found */
  refs: { label: string; target: string | null; hit: RefTarget | RefBroken }[];
  /** drawn by the static render (render + hydrate) instead of the editor: Mermaid, which the editor shows as source */
  static?: boolean;
};

declare global {
  interface Window {
    note: unknown;
    /** code colours, as the Mac app's highlighter gave them: "language\0code" → each line's [from, to, class] */
    noteTokens?: Record<string, [string, string, string][][]>;
    webkit?: { messageHandlers: { note: { postMessage(m: unknown): void } } };
  }
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Code coloured as the Mac app colours it (window.noteTokens), in the board's token classes (.kw, .fn, .str…) */
async function highlight(text: string, lang: string): Promise<string | null> {
  const lines = window.noteTokens?.[`${lang}\u0000${text}`];
  if (!lines) return null;
  return text
    .split("\n")
    .map((line, i) => {
      let html = "";
      let at = 0;
      for (const [a, b, cls] of lines[i] ?? []) {
        const from = Number(a);
        const to = Number(b);
        html += escape(line.slice(at, from)) + `<span class="${cls}">${escape(line.slice(from, to))}</span>`;
        at = to;
      }
      return html + escape(line.slice(at));
    })
    .join("\n");
}

// The page only draws: mounting the editor focuses it, and a web view in the background that asks for focus takes the
// keyboard from the window the user types in
HTMLElement.prototype.focus = () => {};

const refKey = (label: string, target?: string | null) => `${label}\u0000${target ?? ""}`;

/** A Markdown instance for one Note: its images resolve against the Note's folder, and its [[refs]] as given. Its own,
 *  not shared: an instance learns the size of each image it loads and lays the image out from that size the next time,
 *  a fraction of a pixel off the first, and the first is what a Note on the board is drawn as */
function mdFor(images: string, refs: Note["refs"]): Markdown {
  const hits = new Map(refs.map((r) => [refKey(r.label, r.target), r.hit]));
  // images load at once, not when scrolled to: the picture waits for every one of them
  const md = createMarkdown({
    eagerImages: true,
    highlight,
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
      if (made.markdown && n.static) {
        const md = mdFor(images, n.refs);
        const html = md.render(n.text);
        made.body.innerHTML = html;
        md.hydrate(made.body, html);
      } else if (made.markdown)
        s.editor = mountEditor(mdFor(images, n.refs), made.body, {
          value: n.text,
          layout: n.layout,
          onDone: () => {},
          scrollOwnBox: true,
        });
      else made.body.textContent = n.text;
    }
    return measure(list.map((l) => l.id));
  },
  /** Measures again after the view grew: code blocks draw only the lines in view, so a card can grow with it */
  measure,
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
window.webkit?.messageHandlers.note.postMessage("ready");

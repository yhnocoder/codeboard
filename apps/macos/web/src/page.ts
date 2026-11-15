// The Note page of the Mac app: Notes on cards laid out as the VS Code board lays them out (the board's own
// stylesheets, in the board theme the canvas draws), drawn by the Markdown package's editor, so a snapshot of one is
// what editing it shows. Many Notes stay mounted at once, each in a slot of its own at the page's top left, all hidden
// but the one being snapshotted: measuring a board is one layout pass, and a picture at another scale lays nothing out
// again. Native drives it through window.note and hears back on the "note" message handler.
import {
  createMarkdown,
  markTags,
  mdBlockStarts,
  texBrackets,
  type Markdown,
  type MdLayout,
  type RefBroken,
  type RefTarget,
} from "@yhnocoder/markdown";
import { type MdEditorHandle, mountEditor, warmUp } from "@yhnocoder/markdown/editor";
import "@yhnocoder/markdown/katex.css";
import "../../../../packages/board/src/fonts.css";
import "../../../../packages/board/src/styles.css";
import "@yhnocoder/markdown/style.css";
import "../../../../packages/board/src/themes.css";
import "./page.css";
import { classifyPaste, guessLang, pythonDialect } from "../../../../packages/core/src/paste";
import { cleanImage, cleanSvg, svgDataUrl } from "../../../../packages/board/src/md/images";
import { imageScale } from "../../../../packages/core/src/image";
import { NEW_CARD_W } from "../../../../packages/core/src/layout";
import { langInfo } from "../../../../packages/analysis/src/langs";
import { type QData, qlist } from "./qlist";
import { palette } from "./palette";

/** CodeBoardNotes' PageNote, as JSON */
type Note = {
  text: string;
  layout: MdLayout | null;
  style:
    | { note: { hideHead?: boolean } }
    | { text: { look: "text" | "box"; fill: string; fontSize: number; wrap: boolean } }
    | { inline: Record<string, never> };
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

/** Loaded as page.html?pop: the question list (qlist.ts), in a web view of its own over the canvas. Otherwise, but for
 *  the palette, the page only draws */
const popMode = new URLSearchParams(location.search).has("pop");
/** Loaded as page.html?palette: ⌘K and ⌘F (palette.ts), in a web view of its own over the board */
const paletteMode = new URLSearchParams(location.search).has("palette");
document.documentElement.classList.add(popMode ? "popup" : paletteMode ? "pal" : "render");
// mounting the editor focuses it, and a web view in the background that asks for focus takes the keyboard from the
// window the user types in
if (!popMode && !paletteMode) HTMLElement.prototype.focus = () => {};

/** A Note's top-level blocks, each one's Markdown (the board's md/blocks.ts noteBlocks); null when it cannot be split */
function noteBlocks(md: string): string[] | null {
  const st = mdBlockStarts(md);
  return st ? st.map((s, i) => md.slice(s, st[i + 1] ?? md.length).trim()) : null;
}

const refKey = (label: string, target?: string | null) => `${label}\u0000${target ?? ""}`;

/** A Markdown instance for one Note: its images resolve against the Note's folder, and its [[refs]] as given. Its own,
 *  not shared: an instance learns the size of each image it loads and lays the image out from that size the next time,
 *  a fraction of a pixel off the first, and the first is what a Note on the board is drawn as */
function mdFor(images: string, refs: Note["refs"]): Markdown {
  const hits = new Map(refs.map((r) => [refKey(r.label, r.target), r.hit]));
  // images load at once, not when scrolled to: the picture waits for every one of them
  const md = createMarkdown({
    eagerImages: true,
    refs: {
      resolve: (label, target) => hits.get(refKey(label, target)) ?? null,
    },
  });
  md.setAssetBase("images", images);
  return md;
}
// the editor's code runs once on a sample before the first Note, so the first one mounts as fast as the rest
warmUp(mdFor("", []));

/** A mounted Note (or image): its slot is laid out as the page's top left corner, hidden unless it is the one shown */
/** md: a Note's Markdown, whose blocks are measured with it */
type Slot = { slot: HTMLDivElement; card: HTMLElement; editor?: MdEditorHandle; md?: string };
const root = document.getElementById("root") as HTMLDivElement;
const slots = new Map<string, Slot>();
let shown: Slot | undefined;
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** The card and body classes Card.tsx and NoteBody.tsx give each kind, with the variables they set on the card */
/** `outer`: what goes in the slot when it is not the card itself (an Always Show note's .inotes) */
function cardFor(n: Note): { card: HTMLDivElement; body: HTMLDivElement; outer?: HTMLElement } {
  const s = n.style;
  if ("inline" in s) {
    // an Always Show sidenote under its lines in a code card (CodeBody .inotes > .inote): the canvas draws the code,
    // the page this note, as wide as the card leaves it
    const c = document.createElement("div");
    const body = document.createElement("div");
    c.className = "inote";
    c.style.width = `${n.width}px`;
    c.style.maxWidth = "none";
    body.className = "nbody editing md";
    c.append(body);
    const wrap = document.createElement("div");
    wrap.className = "inotes";
    wrap.append(c);
    return { card: c, body, outer: wrap };
  }
  const c = document.createElement("div");
  const face = document.createElement("div");
  const body = document.createElement("div");
  face.className = "cface";
  c.append(face);
  if ("note" in s) {
    c.className = "card note";
    // the header keeps its height (the canvas draws the header itself)
    const head = document.createElement("div");
    head.className = "chead";
    face.append(head);
    body.className = s.note.hideHead ? "nbody hidehead" : "nbody";
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
        // not ProseMirror's own src-less <img> after an image at a paragraph's end (it is never an image: its decode
        // always fails, and the Note would never count as drawn whole)
        [...el.querySelectorAll("img:not(.ProseMirror-separator)")].map((img) =>
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

/** A Note block where it is in its card at 100 % (the board's state/blocks.ts readBlocks): its fingerprint's text is
 *  the block's Markdown, y and h from the card's top, line the height of its first line */
type Block = { text: string; y: number; h: number; line: number };
/** A drawn [[ref]] that points at something: its label and id as written, a box of it (one per line it wraps over) from
 *  the card's top left at 100 % */
type RefBox = { ref: string; target: string | null; x: number; y: number; w: number; h: number };
type Size = { width: number; height: number; complete: boolean; blocks: Block[] | null; refs: RefBox[] };

function refBoxes(s: Slot, k: number): RefBox[] {
  const top = s.card.getBoundingClientRect();
  return [...s.card.querySelectorAll<HTMLElement>(".md-ref:not(.missing):not(.gone)")].flatMap((r) =>
    [...r.getClientRects()].map((b) => ({
      ref: r.dataset.ref ?? "",
      target: r.dataset.target || null,
      x: (b.left - top.left) / k,
      y: (b.top - top.top) / k,
      w: b.width / k,
      h: b.height / k,
    })),
  );
}

/** A Note's top-level blocks on the page, matched one for one with its Markdown's (the board's noteDom); null when they
 *  do not match (footnotes, raw HTML) */
function blocksOf(s: Slot, k: number): Block[] | null {
  if (s.md === undefined) return null;
  const pm = s.card.querySelector<HTMLElement>(".md-pm");
  const md = noteBlocks(s.md);
  if (!pm || !md?.length) return null;
  // the empty paragraph the editor keeps at the end for the caret is no block of the Markdown
  let kids = ([...pm.children] as HTMLElement[]).filter((e) => !e.classList.contains("md-pad"));
  if (md.length !== kids.length) kids = kids.filter((e) => e.tagName !== "P" || e.textContent || e.querySelector("img"));
  if (md.length !== kids.length) return null;
  const top = s.card.getBoundingClientRect().top;
  return kids.map((e, i) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 || 20;
    return {
      text: md[i],
      y: (r.top - top) / k,
      h: r.height / k,
      line: Math.min(e.offsetHeight, lh + (parseFloat(cs.paddingTop) || 0)),
    };
  });
}

/** The cards' sizes in CSS px, once everything is in, and whether every image came in */
async function measure(ids: string[]): Promise<Record<string, Size>> {
  const there = ids.flatMap((id) => {
    const s = slots.get(id);
    return s ? [[id, s] as const] : [];
  });
  const complete = await settled(there.map(([, s]) => s.card));
  const out: Record<string, Size> = {};
  there.forEach(([id, s], i) => {
    // at 100 %: a Note last shown for a picture is still under its zoom
    const k = Number(s.slot.dataset.k ?? 1);
    const r = s.card.getBoundingClientRect();
    out[id] = {
      width: r.width / k,
      height: r.height / k,
      complete: complete[i],
      blocks: blocksOf(s, k),
      refs: refBoxes(s, k),
    };
  });
  return out;
}

function newSlot(id: string, card: HTMLElement, outer: HTMLElement = card): Slot {
  const slot = document.createElement("div");
  slot.className = "slot";
  slot.append(outer);
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

/** Plain text pasted on the board, as main's pasteText makes a card of it (board actions/create.ts): a Note (formulas
 * copied as text kept as TeX, <mark> as ==), a web address or several, an SVG (cleaned, with the width its card is
 * drawn at: its own, at most a Note's), or code with its language guessed. Nothing for white space; an SVG that cannot
 * be read says so */
async function pasted(text: string) {
  if (!text.trim()) return { kind: "none" };
  const tex = texBrackets(mdFor("", []).undoubleTex(text));
  if (tex !== text && classifyPaste(tex).kind === "note") return { kind: "note", text: markTags(tex) };
  const k = classifyPaste(text);
  switch (k.kind) {
    case "note":
      return { kind: "note", text: markTags(text) };
    case "web":
      return { kind: "web", url: k.url };
    // a GitHub file is not fetched here: its address is kept as a page, as main does when it cannot fetch it
    case "github":
      return { kind: "web", url: text.trim() };
    case "links":
      return { kind: "links", urls: k.urls };
    case "svg": {
      const svg = cleanSvg(text.trim());
      if (!svg) return { kind: "none", error: "This SVG image could not be read" };
      const url = svgDataUrl(svg);
      const img = new Image();
      img.src = url;
      await img.decode().catch(() => {});
      return { kind: "svg", dataUrl: url, natural: img.naturalWidth };
    }
    case "code":
      return { kind: "code", text: text.replace(/\s+$/, ""), lang: k.lang };
  }
}

/** A picture file added as main's addImage adds it (board actions/create.ts): an SVG cleaned, and its card as wide as
 * the picture shows (imageCardWidth: its pixels over a PNG's resolution, else over `scale`, 24 to NEW_CARD_W); null
 * for an SVG that cannot be read */
async function added(dataUrl: string, scale = 1) {
  try {
    dataUrl = cleanImage(dataUrl);
  } catch {
    return null;
  }
  const img = new Image();
  img.src = dataUrl;
  await img.decode().catch(() => {});
  let k = scale;
  const png = /^data:image\/png;base64,/.exec(dataUrl);
  if (png) {
    const b64 = dataUrl.slice(png[0].length, png[0].length + 65536);
    try {
      k = imageScale(
        Uint8Array.from(atob(b64.slice(0, b64.length - (b64.length % 4))), (ch) => ch.charCodeAt(0)),
        scale,
      );
    } catch {
      /* not base64: scale */
    }
  }
  return { dataUrl, width: Math.max(24, Math.min(NEW_CARD_W, Math.round((img.naturalWidth || 320) / k))) };
}

window.note = {
  /** What a paste of plain text makes (pasted) */
  paste: pasted,
  /** A picture file's cleaned data: URL and its card's width (added) */
  added,
  /** The language Free code's text looks like, null when it cannot tell (core commands/code.ts freeLang) */
  lang(text: string) {
    const g = guessLang(text);
    return g === "python" ? pythonDialect(text) : g;
  },
  /** Mounts Notes at 100 % (each one not mounted yet, under its id) and measures them all */
  async mount(list: { id: string; note: Note; images: string }[]) {
    for (const { id, note: n, images } of list) {
      if (slots.has(id)) continue;
      setLook(n.look, n.dark);
      const made = cardFor(n);
      const s = newSlot(id, made.card, made.outer);
      if ("note" in n.style) s.md = n.text;
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
      delete shown.slot.dataset.k;
    }
    shown = s;
    s.slot.classList.add("shown");
    s.slot.style.transform = k === 1 ? "" : `scale(${k})`;
    // what is measured of it is divided by it (measure, first): sizes and places are at 100 %
    s.slot.dataset.k = String(k);
    return (await settled([s.card], true))[0];
  },
  /** Lets these go */
  drop(ids: string[]) {
    for (const id of ids) drop(id);
  },
};
if (popMode)
  (window as unknown as { qlist: unknown }).qlist = {
    show: (d: QData, left: number, top: number, max: number) => qlist.show(d, left, top, max, setLook),
    update: qlist.update,
    clear: qlist.clear,
  };
if (paletteMode) {
  palette.start({ mdFor, setLook });
  (window as unknown as { palette: typeof palette }).palette = palette;
}
window.webkit?.messageHandlers.note.postMessage("ready");

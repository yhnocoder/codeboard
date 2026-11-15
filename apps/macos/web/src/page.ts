// The Note page of the Mac app: Notes on cards laid out as the VS Code board lays them out (the board's own
// stylesheets, in the board theme the canvas draws), drawn by the Markdown package's editor, so a snapshot of one is
// what editing it shows. Many Notes stay mounted at once, each in a slot of its own at the page's top left, all hidden
// but the one being snapshotted: measuring a board is one layout pass, and a picture at another scale lays nothing out
// again. Native drives it through window.note and hears back on the "note" message handler.
import {
  createMarkdown,
  markTags,
  mdBlockStarts,
  staticTextRange,
  texBrackets,
  type Markdown,
  type MdLayout,
  type RefBroken,
  type RefTarget,
  type StaticTextRange,
} from "@yhnocoder/markdown";
import {
  type MdEditorHandle,
  mountEditor,
  type RefGroup,
  type RefItem,
  type RefPick,
  warmUp,
} from "@yhnocoder/markdown/editor";
import { codeEditor } from "@yhnocoder/markdown/code-editor";
import { TOOLBAR_SETTLE } from "@yhnocoder/markdown/ui";
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
import { pop } from "./pop";
import { openRefAt, watchRefs } from "./refclick";
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

/** Loaded as page.html?edit: the one Note being edited, in the web view over the canvas, which takes the keyboard.
 *  Otherwise the page only draws */
const editMode = new URLSearchParams(location.search).has("edit");
/** Loaded as page.html?pop: the sidenote popup (pop.ts), in a web view of its own over the canvas */
const popMode = new URLSearchParams(location.search).has("pop");
/** Loaded as page.html?palette: ⌘K and ⌘F (palette.ts), in a web view of its own over the board */
const paletteMode = new URLSearchParams(location.search).has("palette");
document.documentElement.classList.add(editMode ? "edit" : popMode ? "popup" : paletteMode ? "pal" : "render");
// mounting the editor focuses it, and a web view in the background that asks for focus takes the keyboard from the
// window the user types in
if (!editMode && !popMode && !paletteMode) HTMLElement.prototype.focus = () => {};

/** A Note's top-level blocks, each one's Markdown (the board's md/blocks.ts noteBlocks); null when it cannot be split */
function noteBlocks(md: string): string[] | null {
  const st = mdBlockStarts(md);
  return st ? st.map((s, i) => md.slice(s, st[i + 1] ?? md.length).trim()) : null;
}

const refKey = (label: string, target?: string | null) => `${label}\u0000${target ?? ""}`;

/** A Markdown instance for one Note: its images resolve against the Note's folder, and its [[refs]] as given. Its own,
 *  not shared: an instance learns the size of each image it loads and lays the image out from that size the next time,
 *  a fraction of a pixel off the first, and the first is what a Note on the board is drawn as */
function mdFor(images: string, refs: Note["refs"], list?: () => RefList | null): Markdown {
  const hits = new Map(refs.map((r) => [refKey(r.label, r.target), r.hit]));
  // a ref picked from the [[ list while writing: what it points at, by the id written with it; the list can come after
  // the refs were drawn (the popup's), which are then drawn again (pop.ts)
  let from: RefList | null | undefined;
  const byTarget = new Map<string, RefTarget | RefBroken>();
  const picked = (target: string) => {
    const l = list?.() ?? null;
    if (l !== from) {
      from = l;
      byTarget.clear();
      for (const i of l?.items ?? []) byTarget.set(i.target, i.hit);
      for (const g of l?.groups ?? []) {
        byTarget.set(g.target, g.hit);
        for (const i of g.items) byTarget.set(i.target, i.hit);
      }
    }
    return byTarget.get(target);
  };
  // images load at once, not when scrolled to: the picture waits for every one of them
  const md = createMarkdown({
    eagerImages: true,
    refs: {
      resolve: (label, target) => hits.get(refKey(label, target)) ?? (target ? picked(target) : null) ?? null,
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
 * the picture shows (imageCardWidth: its pixels over a PNG's resolution, 24 to NEW_CARD_W); null for an SVG that
 * cannot be read */
async function added(dataUrl: string) {
  try {
    dataUrl = cleanImage(dataUrl);
  } catch {
    return null;
  }
  const img = new Image();
  img.src = dataUrl;
  await img.decode().catch(() => {});
  let k = 1;
  const png = /^data:image\/png;base64,/.exec(dataUrl);
  if (png) {
    const b64 = dataUrl.slice(png[0].length, png[0].length + 65536);
    try {
      k = imageScale(Uint8Array.from(atob(b64.slice(0, b64.length - (b64.length % 4))), (ch) => ch.charCodeAt(0)));
    } catch {
      /* not base64: 1 */
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
/** What the [[ list offers (CodeBoardNotes' RefCandidates): each candidate with what a ref to it shows */
type RefList = {
  items: (RefItem & { target: string; hit: RefTarget | RefBroken })[];
  groups: (RefGroup & { target: string; hit: RefTarget | RefBroken; items: (RefItem & { target: string; hit: RefTarget | RefBroken })[] })[];
  recent: RefPick[];
  foot: string;
};

/** What the editing web view posts: its card's size as it changes, and that the editor left by itself (Esc) */
type Posted =
  | { type: "size"; width: number; height: number }
  | ({ type: "done" } & Ended)
  | { type: "ui"; rects: { x: number; y: number; width: number; height: number }[] }
  | { type: "picked"; group: string | null; id: string };
const post = (m: Posted) => window.webkit?.messageHandlers.note.postMessage(m);

/** The card being edited: its slot is placed `margin` px in from the page's top left, so the editor's menus have room */
/** blocks: the Note's blocks when the editing began and now (as noteBlocks), for what is on them to follow them */
type Ended = {
  text: string | null;
  layout: MdLayout | null;
  layoutChanged: boolean;
  blocks: { was: string[] | null; now: string[] | null } | null;
};
/** What the editing needs of its editor: the Markdown editor's, or the code editor's made to look like it */
type Handle = Pick<MdEditorHandle, "value" | "layout" | "destroy" | "type" | "placeCaret">;
type Editing = {
  slot: Slot;
  original: string;
  layout: MdLayout | null;
  editor: Handle;
  /** What it ended with, once ended (the editor leaving by itself or native finishing it, whichever came first) */
  ended: Ended | null;
};
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

const HEADS = ":is(h1, h2, h3, h4, h5, h6):first-child";
/** The heading's block: its height and the space under it, in the card's own pixels (NoteBody block) */
const block = (e: HTMLElement) => {
  const r = e.getBoundingClientRect();
  return r.height * (e.offsetWidth / r.width || 1) + parseFloat(getComputedStyle(e).marginBottom);
};
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A Note whose header shows its leading heading, written in (the board's NoteBody foldHeader): entering, the header
 *  folds away (the body over it) and the heading slides out of the body's top edge; leaving, the other way, and then
 *  the heading is hidden as the canvas's picture has it. The card keeps its height on every frame; 220 ms, the
 *  canvas fading its header's title with it. Resolves when done */
function fold(card: HTMLElement, entering: boolean): Promise<void> {
  const face = card.querySelector<HTMLElement>(":scope > .cface");
  const head = face?.querySelector<HTMLElement>(":scope > .chead");
  const body = face?.querySelector<HTMLElement>(":scope > .nbody");
  if (!face || !head || !body || !body.classList.contains("hidehead")) return Promise.resolve();
  const h = body.querySelector<HTMLElement>(`.md-pm > ${HEADS}`);
  let H: number, p0: number, p1: number;
  if (entering) {
    H = head.offsetHeight;
    p0 = parseFloat(getComputedStyle(body).paddingTop);
    face.style.setProperty("--fold-h", `${H}px`);
    face.style.setProperty("--fold-p0", `${p0}px`);
    body.classList.remove("unfolded");
    head.classList.add("fold");
    body.classList.add("fold");
  } else {
    H = parseFloat(face.style.getPropertyValue("--fold-h")) || head.offsetHeight;
    p0 = parseFloat(face.style.getPropertyValue("--fold-p0")) || 0;
  }
  const blk = h ? block(h) : 0;
  if (entering) {
    p1 = Math.max(6, H + p0 - blk);
    face.style.setProperty("--fold-pt", `${p1}px`);
  } else p1 = parseFloat(getComputedStyle(body).paddingTop);
  const settle = () => {
    if (entering) return;
    head.classList.remove("fold");
    body.classList.remove("fold");
    body.classList.add("unfolded");
  };
  if (reduced()) {
    settle();
    return Promise.resolve();
  }
  const opts: KeyframeAnimationOptions = {
    duration: 220,
    easing: "cubic-bezier(.2, .8, .2, 1)",
    fill: entering ? "none" : "forwards",
  };
  const dir = <T>(a: T, b: T) => (entering ? [a, b] : [b, a]);
  const anims = [
    body.animate(dir({ paddingTop: `${p0}px` }, { paddingTop: `${p1}px` }) as Keyframe[], opts),
    head.animate(dir({ marginBottom: "0px" }, { marginBottom: `${-H}px` }) as Keyframe[], opts),
    // what of the heading is above the body's top edge while it slides is cut off
    body.animate(
      [{ clipPath: "inset(0 -100vmax -100vmax -100vmax)" }, { clipPath: "inset(0 -100vmax -100vmax -100vmax)" }],
      opts,
    ),
  ];
  if (h)
    anims.push(h.animate(dir({ marginTop: `${-blk}px`, opacity: 0 }, { marginTop: "0px", opacity: 1 }) as Keyframe[], opts));
  return new Promise((done) => {
    anims[0].onfinish = anims[0].oncancel = () => {
      settle();
      for (const a of anims) a.cancel();
      done();
    };
  });
}

/** Ends the editing: what was written (text null when nothing changed) and its layout; the content stays shown until
 *  clear. Null when it had ended already */
function end(e: Editing, text: string | null, layout: MdLayout | null): Ended | null {
  if (e.ended) return null;
  e.ended = {
    text,
    layout,
    layoutChanged: JSON.stringify(layout ?? null) !== JSON.stringify(e.layout ?? null),
    blocks: text === null ? null : { was: noteBlocks(e.original), now: noteBlocks(text) },
  };
  keepStatic(e);
  return e.ended;
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

// keydowns the page has seen: native hands it the keys typed before the editor was there one at a time, each once the
// one before reached the page (WebKit runs a text key through the input method first, so Esc or ⌘↵ sent right after
// would overtake it)
let keysSeen = 0;
addEventListener("keydown", (e) => e.isTrusted && keysSeen++, true);
let compositionEnds = 0;
addEventListener("compositionend", () => compositionEnds++, true);
// Both editors keep a rule for Safari, where the key that commits a composition (a Space, a digit, Enter) reached the
// page after compositionend: they skip the first key after a composition ends as that one (prosemirror-view
// inOrNearComposition, CodeMirror's compositionPendingKey). WebKit now gives the page that key first, before the
// composition's end, for most input methods (WebViewImpl::inputMethodUsesCorrectKeyEventOrder), and the rule would skip
// the next key typed instead: an Esc that leaves, an Enter. Each composing key comes with one update (the key that
// starts it may come just before it starts); a key more than that by compositionend was the committing one, and the
// editor is handed the key its rule waits for: a keydown of nothing (Process, as a key an input method takes), which
// it skips
let keyPending = false;
let compositionKeys = 0;
let compositionUpdates = 0;
// a key's own text or composition, or its release, ends it being the one that may start a composition
addEventListener("beforeinput", () => (keyPending = false), true);
addEventListener("keyup", () => (keyPending = false), true);
addEventListener("compositionstart", () => {
  compositionKeys = keyPending ? 1 : 0;
  compositionUpdates = 0;
});
addEventListener("compositionupdate", () => compositionUpdates++, true);
addEventListener(
  "keydown",
  (e) => {
    if (!e.isTrusted) return;
    keyPending = true;
    compositionKeys++;
  },
  true,
);
// bubbling, so after the editors' own compositionend (on their elements)
addEventListener("compositionend", (e) => {
  if (compositionKeys <= compositionUpdates || !(e.target instanceof Element)) return;
  e.target.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", bubbles: true, cancelable: true }));
});
// WebKit writes a composition's text with that text selected and puts the caret where the input method says only after
// the input event; CodeMirror reads the selection in between (its MutationObserver) and keeps the text selected until
// WebKit's selectionchange. Whatever it draws before then puts that selection back, and WebKit takes a selection the
// page sets as the end of the composition: code's colours coming back in between ended it, and the commit landed beside
// what was composed ("n你"). Colours that come then wait for that selectionchange, and for CodeMirror to have read it
let caretDue: Promise<void> | null = null;
let caretCame = () => {};
addEventListener(
  "input",
  (e) => {
    if ((e as InputEvent).inputType !== "insertCompositionText" || caretDue) return;
    caretDue = new Promise((r) => (caretCame = r));
  },
  true,
);
const caretIn = () => {
  if (!caretDue) return;
  caretDue = null;
  setTimeout(caretCame);
};
document.addEventListener("selectionchange", caretIn);
addEventListener("compositionend", caretIn, true);
const afterCaret = async <T>(v: T) => {
  while (caretDue) await caretDue;
  return v;
};
// an Esc the input method took to cancel its composition: WebKit gives it as Escape with keyCode 229 (Chromium as
// Process), and the editors' Esc would leave
addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && e.keyCode === 229) e.stopImmediatePropagation();
  },
  true,
);

/** A press on a Note as a place in its text, read on its static render (the web board's interact.ts staticSpot): the
 *  character before the point, inside the same text, else the one after; "end" below the last block. Not on the
 *  editor's own text: beside a line's end WebKit's point there lands among its hidden syntax (between a link's text
 *  and its "(url)"), and what was typed broke the link */
type NoteSpot = { char: StaticTextRange; after: boolean } | "end";
function staticSpot(md: HTMLElement, x: number, y: number): NoteSpot | undefined {
  const last = md.lastElementChild;
  if (!last) return undefined;
  if (y >= last.getBoundingClientRect().bottom) return "end";
  const c = document.caretRangeFromPoint(x, y);
  if (!c || !md.contains(c.startContainer)) return undefined;
  const before = () => {
    const all = document.createRange();
    all.selectNodeContents(md);
    all.setEnd(c.startContainer, c.startOffset);
    const b = staticTextRange(md, all);
    return b && { char: { from: b.to - 1, to: b.to, text: b.text[b.text.length - 1] }, after: true };
  };
  const after = () => {
    const rest = document.createRange();
    rest.setStart(c.startContainer, c.startOffset);
    rest.setEnd(md, md.childNodes.length);
    const r = staticTextRange(md, rest);
    return r && { char: { from: r.from, to: r.from + 1, text: r.text[0] }, after: false };
  };
  return (
    (c.startContainer.nodeType === 3 && c.startOffset > 0 ? (before() ?? after()) : (after() ?? before())) ?? undefined
  );
}

const edit = {
  /** Tests: the editor takes the focus `ms` late from now on, as on a busy machine (WebKit gives the view its input
   *  context only once the page has focused something editable) */
  focusLate(ms: number) {
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, o?: FocusOptions) {
      setTimeout(() => focus.call(this, o), ms);
    };
  },
  /** The Edit menu's Select All: ⌘A pressed in the editor that has the focus, so its own key binding selects (the Note
   *  editor's is the whole document, which shows no format bar); WebKit's select-all only when nothing takes it */
  selectAll() {
    const at = document.activeElement ?? document.body;
    const key = { key: "a", code: "KeyA", metaKey: true, bubbles: true, cancelable: true };
    if (at.dispatchEvent(new KeyboardEvent("keydown", key))) document.execCommand("selectAll");
  },
  /** The keydowns seen so far */
  keysSeen: () => keysSeen,
  /** Tests: whether the format bar is up once a selection made now has waited as long as the bar does (TOOLBAR_SETTLE) */
  barAfterSettle: () =>
    new Promise<boolean>((r) =>
      setTimeout(() => requestAnimationFrame(() => r(!!document.querySelector(".md-bubble"))), TOOLBAR_SETTLE),
    ),
  /** Tests: the compositions ended so far (an input method's text committed or cancelled, or the page ending it) */
  compositionEnds: () => compositionEnds,
  /** Resolves once `n` keydowns have been seen, or after `ms` (a key that reaches no page) */
  async seen(n: number, ms: number) {
    const until = performance.now() + ms;
    while (keysSeen < n && performance.now() < until) await new Promise((r) => setTimeout(r, 1));
    return keysSeen >= n;
  },
  /** Mounts `note` in the editor, `margin` px from the page's top left, at zoom k, takes the keyboard and puts the
   *  caret at `caret` (card px at 100 %), else at the end; resolves with its size once laid out */
  async begin(a: {
    note: Note;
    images: string;
    k: number;
    margin: number;
    caret: { x: number; y: number } | null;
    /** The press was a double-click on the ref drawn at the caret: its source opens */
    open: boolean;
    placeholder: string;
    refList: RefList | null;
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
      ended: null,
      editor: undefined as unknown as MdEditorHandle,
    };
    const md = mdFor(a.images, a.note.refs, () => a.refList);
    // the press on the Note as drawn, read on its static render, which the editor then replaces (Editable.tsx)
    let spot: NoteSpot | undefined;
    if (a.caret) {
      const html = md.render(a.note.text);
      made.body.innerHTML = html;
      md.hydrate(made.body, html);
      await settled([made.card], true);
      spot = staticSpot(made.body, a.margin + a.caret.x * a.k, a.margin + a.caret.y * a.k);
      made.body.textContent = "";
    }
    const list = a.refList;
    e.editor = mountEditor(md, made.body, {
      value: a.note.text,
      // the web board's [[ list (md/load.ts editorOpts)
      refs: list
        ? {
            items: () => list.items,
            menu: "Link to Card",
            empty: "Nothing with that title",
            groups: () => list.groups,
            recent: () => list.recent,
            here: "This board",
            foot: () => list.foot,
            picked: (p) => {
              list.recent = [p, ...list.recent.filter((r) => r.group !== p.group || r.id !== p.id)].slice(0, 3);
              post({ type: "picked", group: p.group ?? null, id: p.id });
            },
          }
        : undefined,
      layout: a.note.layout,
      placeholder: a.placeholder,
      headingChip: !isText,
      scrollOwnBox: true,
      // the board's menus, bars and buttons (cm/load.ts BOARD_CLASSES)
      classes: { menu: "ctx", bar: "pill", button: "tbtn" },
      onDone: (v, l) => {
        // the header unfolds first, the heading going back into it
        void fold(made.card, false).then(() => {
          const r = end(e, v, l === undefined ? e.layout : l);
          if (r) post({ type: "done", ...r });
        });
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
    // a Note whose header shows its heading: the header folds away, the heading coming out of the body (its card as tall
    // as before, so the size below is the card's)
    void fold(made.card, true);
    await settled([made.card]);
    if (a.caret) {
      const x = a.margin + a.caret.x * a.k,
        y = a.margin + a.caret.y * a.k;
      if (spot === "end") e.editor.placeCaret("end");
      else if (!spot || !e.editor.placeCaret({ visible: spot.char, after: spot.after })) e.editor.placeCaret({ x, y });
      if (a.open) openRefAt(x, y);
    } else e.editor.placeCaret("end");
    const r = made.card.getBoundingClientRect();
    return { width: r.width / a.k, height: r.height / a.k };
  },
  /** Mounts a Free code card's code in the code editor, as the board's FreeEdit does: the card `width` wide, its code
   *  `top` below the card's top (under its header, which the canvas draws), at zoom k, `margin` px from the page's top
   *  left; the caret at `caret` (card px at 100 %), else at the start. Colours come from native (the `highlight`
   *  handler: the board's token classes as HTML), so entering and leaving change no colour. Resolves with its size */
  async code(a: {
    look: string;
    dark: boolean;
    k: number;
    margin: number;
    width: number;
    top: number;
    text: string;
    lang: string;
    start: number;
    wrap: boolean;
    html: string | null;
    caret: { x: number; y: number } | null;
  }) {
    edit.clear();
    setLook(a.look, a.dark);
    document.documentElement.dataset.margin = String(a.margin);
    // Card.tsx and CodeBody.tsx: the card, its face, its body, the code (the header keeps its place, drawn by the canvas)
    const card = document.createElement("div");
    card.className = "card ccard editing";
    card.style.width = `${a.width}px`;
    const face = document.createElement("div");
    face.className = "cface";
    face.style.paddingTop = `${a.top}px`;
    const body = document.createElement("div");
    body.className = a.wrap ? "cbody editing wrap" : "cbody editing";
    const code = document.createElement("div");
    const lines = a.text.split("\n").length;
    code.className = "code freecode";
    code.style.setProperty("--nd", String(String(a.start + lines - 1).length));
    body.append(code);
    face.append(body);
    card.append(face);
    const s = newSlot("edit", card);
    s.slot.classList.add("shown");
    s.slot.style.left = `${a.margin}px`;
    s.slot.style.top = `${a.margin}px`;
    s.slot.style.transform = a.k === 1 ? "" : `scale(${a.k})`;
    s.slot.dataset.k = String(a.k);
    const handler = (
      window.webkit?.messageHandlers as unknown as {
        highlight?: { postMessage(m: unknown): Promise<string | null> };
      }
    ).highlight;
    const lang = a.lang;
    const e: Editing = {
      slot: s,
      original: a.text,
      layout: null,
      ended: null,
      editor: undefined as unknown as Handle,
    };
    const ed = codeEditor({
      parent: code,
      text: a.text,
      lang,
      wrap: a.wrap,
      gutter: { start: a.start },
      html: a.html ?? undefined,
      highlight: handler ? (t) => handler.postMessage({ text: t, lang }).then(afterCaret, () => null) : undefined,
      stopPointerDown: true,
      find: true,
      classes: { menu: "ctx", bar: "pill", button: "tbtn" },
      // Esc, ⌘↵ (FreeEdit onExit)
      onExit: () => {
        const r = end(e, ed.text() === e.original ? null : ed.text(), null);
        if (r) post({ type: "done", ...r });
      },
      onChange: (t) => {
        code.style.setProperty("--nd", String(String(a.start + t.split("\n").length - 1).length));
      },
    });
    const v = ed.view;
    e.editor = {
      value: () => ed.text(),
      layout: () => null,
      destroy: () => ed.destroy(),
      type: (t: string) => v.dispatch(v.state.replaceSelection(t), { userEvent: "input.type", scrollIntoView: false }),
      placeCaret: (at) => {
        const pos = at === "end" ? v.state.doc.length : "x" in at ? v.posAtCoords(at, false) : 0;
        v.dispatch({ selection: { anchor: pos } });
        v.focus();
        return true;
      },
    };
    editing = e;
    let last = "";
    new ResizeObserver(() => {
      const r = card.getBoundingClientRect();
      const k = Number(s.slot.dataset.k ?? 1);
      const size = { width: r.width / k, height: r.height / k };
      const key = `${size.width} ${size.height}`;
      if (key === last) return;
      last = key;
      post({ type: "size", ...size });
    }).observe(card);
    await settled([card]);
    if (a.caret) e.editor.placeCaret({ x: a.margin + a.caret.x * a.k, y: a.margin + a.caret.y * a.k });
    else {
      v.dispatch({ selection: { anchor: 0 } });
      v.focus();
    }
    const r = card.getBoundingClientRect();
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
  /** What is written so far, the editing going on (a draft native keeps on the board); null when it has ended */
  peek(): Ended | null {
    if (!editing || editing.ended) return null;
    const e = editing;
    const layout = e.editor.layout();
    return {
      text: e.editor.value(),
      layout,
      layoutChanged: JSON.stringify(layout ?? null) !== JSON.stringify(e.layout ?? null),
      blocks: null,
    };
  },
  /** Native ends the editing (a click outside): what was written, also when the editor left by itself first (focus
   *  went, and its "done" is still on the way); what is shown stays until clear */
  async finish() {
    if (!editing) return null;
    const e = editing;
    if (e.ended) return e.ended;
    const value = e.editor.value();
    const layout = e.editor.layout();
    await fold(e.slot.card, false);
    if (e.ended) return e.ended;
    const r = end(e, value, layout);
    e.editor.destroy();
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
if (popMode) {
  pop.start({ mdFor, setLook });
  (window as unknown as { pop: typeof pop }).pop = pop;
  (window as unknown as { qlist: unknown }).qlist = {
    show: (d: QData, left: number, top: number, max: number) => qlist.show(d, left, top, max, setLook),
    update: qlist.update,
    clear: qlist.clear,
  };
}
if (paletteMode) {
  palette.start({ mdFor, setLook });
  (window as unknown as { palette: typeof palette }).palette = palette;
}
if (editMode || popMode) watchRefs((m) => window.webkit?.messageHandlers.note.postMessage(m));
window.webkit?.messageHandlers.note.postMessage("ready");

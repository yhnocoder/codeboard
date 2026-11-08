// The card page: the Mac app's Notes drawn by the same renderer as the VS Code board (@yhnocoder/markdown's static render, the
// board's stylesheets and fonts), and edited by the same editors (the TipTap Markdown editor, CodeMirror for Free code). One
// WKWebView loads this page offscreen and snapshots cards into bitmaps; another shows it over the card being edited. The app
// calls `cb.*` (evaluateJavaScript); the page answers through webkit.messageHandlers.cb (NoteRenderer.swift, EditCard.swift).
import { createMarkdown, type Markdown } from "@yhnocoder/markdown";
import { mountEditor, prepare, warmUp, type MdEditorHandle } from "@yhnocoder/markdown/editor";
import { codeEditor, type CodeEditor } from "@yhnocoder/markdown/code-editor";
import { HAND_WEIGHT_CSS, mapFit, mapHtml, mdHeading, renderLine, textSizeOf, type NoteCard, type Skeleton } from "@codeboard/core";
import { makeHighlighter } from "../js/highlight";
import { langId } from "@codeboard/analysis/langs";
import "@yhnocoder/markdown/katex.css";
import "../../../packages/board/src/fonts.css";
import "../../../packages/board/src/styles.css";
import "@yhnocoder/markdown/style.css";
import "../../../packages/board/src/themes.css";
import "./page.css";
import { paperOf } from "../../../packages/board/src/state/inkart";

/** What the app sends for one card (js/scene.ts SceneCard's Note fields and a Free code card's text) */
type CardSpec = {
  id: string;
  kind: "note" | "code" | "board" | "inote";
  look?: string;
  md: string;
  /** The title shown in the head (cardTitle); the body hides a leading heading that is this title */
  title: string;
  /** A Note's own name (NoteCard.title): the head shows it, else the leading heading, else "Note" */
  name?: string;
  w: number;
  size?: string;
  bold?: boolean;
  fill?: string;
  hand?: string;
  weight?: string;
  level?: number;
  fs?: number;
  locked?: boolean;
  /** Free code */
  lang?: string;
  /** The board's own height (Place.h): the body scrolls inside it when editing, is clipped in a bitmap */
  h?: number;
  /** A sub-board card: core's Skeleton as JSON; the frame shows its map (BoardBody's mapHtml) */
  skel?: string;
};

/** The air around the card while editing: the selection ring and Ink Wash's paper reach outside the card (EditCard.edge) */
const EDIT_EDGE = 16;
/** While editing, the text is handed to the app this often when it changed (written through core: a crash loses at most this) */
const LIVE_WRITE = 1000;

const post = (m: Record<string, unknown>) =>
  (window as unknown as { webkit?: { messageHandlers: { cb: { postMessage(x: unknown): void } } } }).webkit?.messageHandlers.cb.postMessage(m);

// the host's highlighter, as in the bridge: tree-sitter's wasm comes from the app's Resources (cb://app/wasm/…)
const hl = makeHighlighter(async (file) => new Uint8Array(await (await fetch(`cb://app/wasm/${file}`)).arrayBuffer()));
let titles: { id: string; title: string }[] = [];
/** Code blocks being highlighted: a render waits for them before its picture is taken (the first grammar takes a while) */
const highlighting = new Set<Promise<unknown>>();
const md: Markdown = createMarkdown({
  highlight: (text, lang) => {
    const p = (async () => {
      const lines = text.split("\n");
      const toks = (await hl.tokens(lang, lines)) ?? lines.map((l) => [[l]]);
      return toks.map((l) => renderLine(l.map(([t, cls]) => (cls ? { text: t, cls } : { text: t })))).join("\n");
    })();
    highlighting.add(p);
    void p.finally(() => highlighting.delete(p));
    return p;
  },
  langId,
  refs: {
    resolve: (label, target) => {
      const l = label.trim().toLowerCase();
      const hit = titles.find((t) => t.id === target) ?? titles.find((t) => t.title.trim().toLowerCase() === l);
      return hit ? { id: hit.id, title: hit.title } : null;
    },
    missing: "Nothing with this title on the board",
  },
});
// ![](assets/x.png) → the storage folder's assets, served by the app's cb: scheme (WebCards.swift)
md.setAssetBase("assets", "cb://a/assets");

const stage = document.getElementById("stage")!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The card's DOM the way Card.tsx / NoteBody.tsx build it: the classes the board's CSS draws */
function cardEl(c: CardSpec): { card: HTMLElement; body: HTMLElement; mdBody: boolean } {
  const card = document.createElement("div");
  const face = document.createElement("div");
  face.className = "cface";
  card.appendChild(face);
  const body = document.createElement("div");
  let mdBody = true;
  const n = c as unknown as NoteCard;
  if (c.kind === "inote") {
    // a Highlight's Always Show notes (CodeBody .inotes > .inote > .nbody): md is their Markdown as a JSON array; the app
    // places the picture under the Highlight's last line, so the wrapper is the picture
    card.className = "inotes hx-band";
    card.style.width = `${c.w}px`;
    for (const text of JSON.parse(c.md) as string[]) {
      const note = document.createElement("div");
      note.className = "inote";
      note.style.maxWidth = "none";
      const nb = document.createElement("div");
      nb.className = "nbody md";
      const html = md.render(text);
      nb.innerHTML = html;
      md.hydrate(nb, html);
      note.appendChild(nb);
      card.appendChild(note);
    }
    card.removeChild(face);
    mdBody = false;
  } else if (c.kind === "board") {
    // the frame of a sub-board (BoardBody.tsx): the map SVG fills it; the name above it is the app's
    card.className = "card board";
    card.style.height = `${c.h ?? 0}px`;
    const sk = c.skel ? (JSON.parse(c.skel) as Skeleton) : null;
    body.className = "sbmap";
    if (sk) body.innerHTML = mapHtml(sk, mapFit(sk, c.w, c.h ?? 0), (img) => (img.startsWith("data:") ? img : `cb://a/assets/${img}`));
    mdBody = false;
  } else if (c.kind === "code") {
    card.className = "card ccard";
    card.style.setProperty("--fc", "var(--hd-blue)");
    face.innerHTML = `<div class="chead"><span class="kind">${esc(c.lang ?? "code")}</span><span class="ctitle">${esc(c.title)}</span></div>`;
    body.className = "cbody";
    mdBody = false;
  } else if (c.look === "note") {
    // autoh: the content's own height; a Note with a height of its own keeps it (its body scrolls, page.css)
    card.className = c.h ? "card note" : "card note autoh";
    if (c.h) card.style.height = `${c.h}px`;
    // the head as NoteBody.tsx: the Note's own name, else its leading heading (then hidden in the body), else "Note"; ⋯ at the right
    const heading = mdHeading(c.md);
    face.innerHTML = `<div class="chead"><span class="kind">¶</span><span class="ctitle sys${c.name || heading ? "" : " untitled"}">${esc(c.name || heading || "Note")}</span><span class="grow"></span><button class="ib cmenu" aria-label="Note Menu"><svg class="ico" width="16" height="16" viewBox="0 0 16 16"><path d="M2 7h2v2H2zM7 7h2v2H7zM12 7h2v2h-2z"/></svg></button></div>`;
    body.className = "nbody md";
    if (!c.name && heading) body.classList.add("hidehead");
  } else if (c.look === "mark") {
    card.className = "card text mark";
    card.style.setProperty("--hc", `var(--hd-${c.hand ?? "blue"})`);
    if (c.weight) card.style.setProperty("--hw", String(HAND_WEIGHT_CSS[c.weight as keyof typeof HAND_WEIGHT_CSS]));
    card.style.setProperty("--tfs", `${textSizeOf({ ...n, look: "mark" })}px`);
    body.className = "tx hand md";
  } else if (c.look === "freetext") {
    card.className = "card text freetext";
    card.style.setProperty("--tfs", `${textSizeOf({ ...n, look: "freetext" })}px`);
    const lv = c.level ?? 0;
    body.className = `tx ft ft-l${lv} ${lv === 3 ? "st-heading" : lv ? "st-title" : "st-body"}${c.bold ? " ftb" : ""}`;
    mdBody = false;
  } else if (c.look === "box") {
    card.className = "card text box";
    card.style.setProperty("--fc", `var(--bf-${c.fill ?? "yellow"})`);
    body.className = "tx bx md";
  } else {
    card.className = "card text";
    body.className = `tx st-${c.size ?? "body"} md`;
    if (c.bold) body.style.fontWeight = "650";
  }
  if (c.look !== "freetext") card.style.width = `${c.w}px`;
  // Ink Wash: the card is a torn sheet of rice paper (the board's Card.tsx paperOf, on the card's ::before)
  if (document.documentElement.dataset.look === "ink-wash" && (c.kind === "code" || c.kind === "board" || c.look === "note"))
    card.style.setProperty("--deckle", paperOf(c.id, document.documentElement.dataset.theme === "dark"));
  face.appendChild(body);
  return { card, body, mdBody };
}

/** Everything async in a render has landed: no DOM changes for a frame and every image decoded (or failed); 400 ms at most */
function settled(el: HTMLElement): Promise<boolean> {
  return new Promise((done) => {
    let t = 0;
    const end = (capped = false) => {
      mo.disconnect();
      clearTimeout(cap);
      done(capped);
    };
    const imagesDone = () => [...el.querySelectorAll("img")].every((i) => i.complete);
    const arm = () => {
      cancelAnimationFrame(t);
      t = requestAnimationFrame(() => {
        if (imagesDone()) end();
        else arm();
      });
    };
    const mo = new MutationObserver(arm);
    mo.observe(el, { childList: true, subtree: true, attributes: true, characterData: true });
    el.querySelectorAll("img").forEach((i) => i.addEventListener("load", arm, { once: true }));
    el.querySelectorAll("img").forEach((i) => i.addEventListener("error", arm, { once: true }));
    const cap = setTimeout(() => end(true), 400);
    arm();
  });
}

const heightOf = (card: HTMLElement) => {
  const r = card.getBoundingClientRect();
  const k = Number.parseFloat(getComputedStyle(stage).zoom || "1") || 1;
  return { w: r.width / k, h: r.height / k };
};

let editor: MdEditorHandle | CodeEditor | HTMLElement | null = null;
let editing: CardSpec | null = null;
let heightWatch: ResizeObserver | null = null;
let liveTimer = 0;

/** The board's foldHeader at rest: a Note whose first heading is its title edits with the head row folded away and the
 *  heading in the editor taking its place, the card as high as before (styles.css .chead.fold / .nbody.fold) */
function foldHead(card: HTMLElement) {
  const face = card.querySelector<HTMLElement>(":scope > .cface");
  const head = face?.querySelector<HTMLElement>(":scope > .chead"),
    body = face?.querySelector<HTMLElement>(":scope > .nbody");
  const h = body?.querySelector<HTMLElement>(".md-pm > :is(h1, h2, h3, h4, h5, h6):first-child");
  if (!face || !head || !body || !h) return;
  const H = head.offsetHeight,
    p0 = Number.parseFloat(getComputedStyle(body).paddingTop);
  const cs = getComputedStyle(h);
  const blk = h.offsetHeight + Number.parseFloat(cs.marginTop) + Number.parseFloat(cs.marginBottom);
  face.style.setProperty("--fold-h", `${H}px`);
  face.style.setProperty("--fold-pt", `${Math.max(6, H + p0 - blk)}px`);
  head.classList.add("fold");
  body.classList.remove("hidehead");
  body.classList.add("fold");
}

const cb = {
  /** The editor made ahead of time (and a card's text parsed ahead, when the app knows which card is likely next) */
  warm(value?: string) {
    warmUp(md);
    if (value !== undefined) prepare(md, value);
  },
  /** The page's theme and the board's titles for [[refs]]; a new theme re-renders nothing here (the app asks again) */
  setup(o: { theme?: "light" | "dark"; look?: string; titles?: { id: string; title: string }[] }) {
    const h = document.documentElement;
    if (o.theme) h.dataset.theme = o.theme;
    if (o.look) {
      h.dataset.look = o.look;
      h.className = `look-${o.look}`;
    }
    if (o.titles) titles = o.titles;
  },
  /**
   * Draw one card at the page's origin, `scale` times its size (CSS zoom: text is laid out at the card's width and rasterised
   * sharp), then tell the app its size and how long it took: {type: "rendered", id, w, h, ms}. The app snapshots the rect
   */
  async render(c: CardSpec, scale: number, req = 0) {
    const t0 = performance.now();
    try {
      stage.style.zoom = String(scale);
      stage.style.padding = "0";
      stage.textContent = "";
      const { card, body, mdBody } = cardEl(c);
      if (mdBody) {
        const html = md.render(c.md);
        body.innerHTML = html;
        md.hydrate(body, html);
      } else if (c.kind !== "board" && c.kind !== "inote") body.textContent = c.md;
      stage.appendChild(card);
      while (highlighting.size) await Promise.allSettled([...highlighting]);
      // capped: something was still changing (an image not decoded) when the 400 ms ran out: shown, not kept on disk
      const capped = await settled(body);
      const { w, h } = heightOf(card);
      post({ type: "rendered", id: c.id, req, w, h, ms: performance.now() - t0, capped });
    } catch (e) {
      post({ type: "error", text: `render ${c.id}: ${(e as Error).stack ?? e}` });
      post({ type: "rendered", id: c.id, req, w: c.w, h: 60, ms: performance.now() - t0, error: true });
    }
  },
  /**
   * Edit a card in place: the TipTap editor on a Note / Text / Box / Mark, CodeMirror on Free code, a plain editable on Free
   * Text. {type: "painted", h} once the editor is on screen; {type: "height", h} as it grows; {type: "done", value} on Esc /
   * ⌘↵ (value null = unchanged)
   */
  edit(c: CardSpec, scale: number) {
    cb.endEdit();
    editing = c;
    stage.style.zoom = String(scale);
    stage.style.padding = `${EDIT_EDGE}px`;
    stage.textContent = "";
    const { card, body } = cardEl(c);
    card.classList.add("editing", "sel", "solo");
    stage.appendChild(card);
    const done = (value: string | null) => post({ type: "done", id: c.id, value });
    if (c.kind === "code") {
      const box = document.createElement("div");
      box.className = "code freecode";
      box.style.setProperty("--nd", String(String(c.md.split("\n").length).length));
      body.appendChild(box);
      editor = codeEditor({
        parent: box,
        text: c.md,
        lang: c.lang,
        gutter: { start: 1 },
        highlight: async (t) => {
          const lines = t.split("\n");
          const toks = (await hl.tokens(c.lang ?? "", lines)) ?? lines.map((l) => [[l]]);
          return toks.map((l) => renderLine(l.map(([x, cls]) => (cls ? { text: x, cls } : { text: x })))).join("\n");
        },
        find: true,
        onExit: () => done(cb.value()),
      });
      (editor as CodeEditor).focus();
    } else if (c.look === "freetext") {
      body.contentEditable = "plaintext-only";
      body.textContent = c.md;
      body.addEventListener("keydown", (e) => {
        if (e.key === "Escape" || (e.key === "Enter" && e.metaKey)) {
          e.preventDefault();
          done(cb.value());
        }
      });
      editor = body;
      body.focus();
      const sel = getSelection();
      sel?.selectAllChildren(body);
      sel?.collapseToEnd();
    } else {
      body.classList.add("editing");
      editor = mountEditor(md, body, {
        value: c.md,
        placeholder: c.look === "note" ? "Write a note… Markdown and $math$ work" : "Type something…",
        scrollOwnBox: true,
        refs: {
          items: () => titles.map((t) => ({ id: t.id, title: t.title, target: t.id, kind: "card" })),
          menu: "Link to Card",
          empty: "Nothing with that title",
        },
        openLink: (url) => post({ type: "openLink", url }),
        onDone: (v) => done(v),
      });
      (editor as MdEditorHandle).placeCaret("end");
    }
    const report = () => post({ type: "height", id: c.id, h: heightOf(card).h });
    heightWatch = new ResizeObserver(report);
    heightWatch.observe(card);
    let last = c.md;
    liveTimer = window.setInterval(() => {
      const v = cb.value();
      if (v !== null && v !== last) {
        last = v;
        post({ type: "changed", id: c.id, value: v });
      }
    }, LIVE_WRITE);
    requestAnimationFrame(() => {
      if (body.classList.contains("hidehead")) foldHead(card);
      requestAnimationFrame(() => post({ type: "painted", id: c.id, h: heightOf(card).h }));
    });
  },
  /** The text as edited so far (null when nothing is being edited) */
  value(): string | null {
    if (!editor) return null;
    if (editor instanceof HTMLElement) return editor.textContent ?? "";
    if ("value" in editor && typeof editor.value === "function") return (editor as MdEditorHandle).value();
    return (editor as CodeEditor).text();
  },
  /** Stop editing; the text as it is (the app writes it through core) */
  endEdit(): string | null {
    const v = cb.value();
    heightWatch?.disconnect();
    heightWatch = null;
    clearInterval(liveTimer);
    if (editor && !(editor instanceof HTMLElement)) editor.destroy();
    editor = null;
    editing = null;
    stage.textContent = "";
    return v;
  },
  /** The typing check: n characters, one per animation frame; the JS cost of each keystroke and the time to the frame after it
   *  reach the app as {type: "typed", js: [...], frame: [...]} */
  typeBench(n: number) {
    const js: number[] = [],
      layout: number[] = [],
      frame: number[] = [],
      slow: string[] = [];
    // every scheduled callback (rAF, timers, observers' microtasks are not catchable) timed: the ones over 3 ms named
    const w = window as unknown as { requestAnimationFrame: typeof requestAnimationFrame; setTimeout: typeof setTimeout };
    const raf0 = w.requestAnimationFrame.bind(window),
      st0 = w.setTimeout.bind(window);
    let i = 0;
    const timed =
      (kind: string, fn: (...a: never[]) => void) =>
      (...a: never[]) => {
        const t = performance.now();
        fn(...a);
        const ms = performance.now() - t;
        if (ms > 3) slow.push(`#${i} ${kind} ${ms.toFixed(0)}ms ${fn.toString().slice(0, 80).replace(/\s+/g, " ")}`);
      };
    w.requestAnimationFrame = (fn) => raf0(timed("raf", fn as never) as FrameRequestCallback);
    w.setTimeout = ((fn: (...a: never[]) => void, ms?: number, ...rest: never[]) => st0(timed("timer", fn), ms, ...rest)) as unknown as typeof setTimeout;
    const card = stage.firstElementChild as HTMLElement;
    const step = () => {
      if (i++ >= n) {
        w.requestAnimationFrame = raf0;
        w.setTimeout = st0;
        return post({ type: "typed", id: editing?.id, js, layout, frame, slow });
      }
      const t0 = performance.now();
      cb.type(i % 7 === 0 ? " " : "a");
      const t1 = performance.now();
      js.push(t1 - t0);
      void card.getBoundingClientRect(); // the keystroke's layout, forced here so it is timed on its own
      layout.push(performance.now() - t1);
      raf0(() => {
        frame.push(performance.now() - t0);
        step();
      });
    };
    step();
  },
  /** Type into the editor as if on the keyboard (scripted checks) */
  type(text: string) {
    if (!editor) return;
    if (editor instanceof HTMLElement) {
      editor.textContent = (editor.textContent ?? "") + text;
      return;
    }
    if ("type" in editor && typeof editor.type === "function") return (editor as MdEditorHandle).type(text);
    const v = (editor as CodeEditor).view;
    v.dispatch({ changes: { from: v.state.doc.length, insert: text } });
  },
  /** The camera zoomed while editing: the page scales with it */
  zoom(k: number) {
    stage.style.zoom = String(k);
  },
  editingId: () => editing?.id ?? null,
};
(window as unknown as { cb: typeof cb }).cb = cb;
post({ type: "ready", ms: performance.now(), fonts: document.fonts.status === "loaded" });

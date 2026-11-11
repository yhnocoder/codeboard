// The page CodeBoard's native canvas prototype puts in WKWebViews: the Note as the Markdown package draws it, static (for
// snapshots) or in its editor. Native drives it through window.cb and hears back on the "cb" message handler.
import { createMarkdown } from "@yhnocoder/markdown";
import { type MdEditorHandle, mountEditor, warmUp } from "@yhnocoder/markdown/editor";
import "@yhnocoder/markdown/katex.css";
import "@yhnocoder/markdown/style.css";

declare global {
  interface Window {
    cb: unknown;
    webkit?: { messageHandlers: { cb: { postMessage(m: unknown): void } } };
  }
}

// A page that only draws Notes (snapshots) must never take focus: mounting the editor focuses it, and on macOS that
// makes the hidden web view ask to become first responder, which blurs the editor the user is typing in.
let drawOnly = false;
const realFocus = HTMLElement.prototype.focus;
HTMLElement.prototype.focus = function (this: HTMLElement, opts?: FocusOptions) {
  if (!drawOnly) realFocus.call(this, opts);
};
const post = (m: unknown) => window.webkit?.messageHandlers.cb.postMessage(m);
const note = document.getElementById("note") as HTMLDivElement;
const md = createMarkdown({});
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
let editor: MdEditorHandle | undefined;
let saved: { a: Node; ao: number; f: Node; fo: number; top: number } | null = null;
const scrollBox = () => note.querySelector<HTMLElement>(".ProseMirror")?.parentElement ?? note;
const scrollTop = () => scrollBox().scrollTop;
const setScrollTop = (v: number) => {
  scrollBox().scrollTop = v;
};

function setBox(width: number, card: boolean) {
  note.style.width = `${width}px`;
  note.classList.toggle("card", card);
}

/** Everything that can still change the picture: fonts and images. */
async function settled() {
  await document.fonts.ready;
  await Promise.all(
    [...note.querySelectorAll("img")].map((img) => (img.complete ? img.decode().catch(() => {}) : new Promise((r) => {
      img.onload = img.onerror = () => r(null);
    }))),
  );
  await frames();
}

window.cb = {
  /** Text weight: a thin outline on the glyphs, in CSS px (0 = none), for the static render and the editor alike. */
  setTextStroke(px: number) {
    document.documentElement.style.setProperty("--text-stroke", `${px}px`);
    return true;
  },
  /** Text look: "auto" (WebKit's default), "smooth" (opaque page so the system's font smoothing applies) or "thin". */
  setTextLook(look: string) {
    document.documentElement.dataset.look = look;
    return true;
  },
  /** Asset folder of the vault, as a file URL ending in "/". */
  setVault(base: string) {
    md.setAssetBase("assets", `${base}assets`);
  },
  /** Static render; resolves to the content height in CSS px once fonts and images are in. */
  async render(src: string, width: number, card: boolean) {
    editor?.destroy();
    editor = undefined;
    note.classList.remove("still", "bare");
    setBox(width, card);
    const html = md.render(src);
    note.innerHTML = html;
    md.hydrate(note, html);
    await settled();
    return note.getBoundingClientRect().height;
  },
  /** The Note as the editor draws it, without focus or caret: display and edit share one code path. */
  async renderEditor(src: string, width: number, card: boolean) {
    editor?.destroy();
    editor = undefined;
    setBox(width, card);
    note.textContent = "";
    note.style.transform = "";
    drawOnly = true;
    note.classList.add("still");
    note.classList.remove("bare");
    editor = mountEditor(md, note, { value: src, onDone: () => {}, scrollOwnBox: true });
    (document.activeElement as HTMLElement | null)?.blur();
    window.getSelection()?.removeAllRanges();
    await settled();
    return note.offsetHeight;
  },
  /** Loads and parses ahead, so the first edit is fast. */
  warm(src: string) {
    warmUp(md);
    return true;
  },
  /** Editor in place; posts {painted, height} after two frames, {done, value} when the edit ends (Esc / ⌘↵). */
  async edit(src: string, width: number, card: boolean, x?: number, y?: number, scale = 1) {
    const t0 = performance.now();
    setBox(width, card);
    note.textContent = "";
    note.classList.remove("still", "bare");
    editor = mountEditor(md, note, {
      value: src,
      onDone: (v) => {
        editor = undefined;
        post({ done: true, value: v });
      },
      scrollOwnBox: true,
    });
    note.style.transformOrigin = "0 0";
    note.style.transform = scale === 1 ? "" : `scale(${scale})`;
    // The caret where the double-click was (CSS px inside the note), so nothing scrolls to reveal it.
    const r = note.getBoundingClientRect();
    const px = x != null && y != null ? { x, y } : { x: 12, y: 14 };
    editor.placeCaret({ x: r.left + px.x * scale, y: r.top + px.y * scale });
    window.scrollTo(0, 0);
    document.scrollingElement && (document.scrollingElement.scrollTop = 0);
    await settled();
    post({ painted: true, height: note.offsetHeight, ms: performance.now() - t0 });
    return true;
  },
  finish() {
    editor?.destroy();
    editor = undefined;
    note.textContent = "";
  },
  placeCaretEnd() {
    editor?.placeCaret("end");
  },
  /** Types `text` and resolves to ms from each key to the frame after it, as an average. */
  async typeTimed(text: string) {
    const out: number[] = [];
    for (const ch of text) {
      const t0 = performance.now();
      editor?.type(ch);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      out.push(performance.now() - t0);
    }
    out.sort((a, b) => a - b);
    return { p50: out[Math.floor(out.length / 2)], max: out[out.length - 1] };
  },
  /** Freeze: remember the selection exactly (nodes and offsets), as the canvas takes focus for the gesture. */
  saveSel() {
    const sel = getSelection();
    saved = sel && sel.rangeCount && sel.anchorNode && sel.focusNode
      ? { a: sel.anchorNode, ao: sel.anchorOffset, f: sel.focusNode, fo: sel.focusOffset, top: scrollTop() }
      : null;
    return !!saved;
  },
  /** Thaw: focus the editable element without scrolling and put the selection back, so nothing resets it. */
  restoreSel() {
    const ed = note.querySelector<HTMLElement>('[contenteditable="true"]');
    ed?.focus({ preventScroll: true });
    if (saved?.a.isConnected && saved.f.isConnected) {
      getSelection()?.setBaseAndExtent(saved.a, saved.ao, saved.f, saved.fo);
      setScrollTop(saved.top);
    }
    return document.hasFocus();
  },
  /** The selection as a comparable string: node paths from the Note and offsets, and whether the page has focus. */
  selKey() {
    const sel = getSelection();
    const path = (n: Node | null) => {
      const out: number[] = [];
      while (n && n !== note) {
        const p: Node | null = n.parentNode;
        if (!p) return "detached";
        out.unshift([...p.childNodes].indexOf(n as ChildNode));
        n = p;
      }
      return n === note ? out.join(".") : "outside";
    };
    return sel && sel.rangeCount
      ? `anchor ${path(sel.anchorNode)}:${sel.anchorOffset} head ${path(sel.focusNode)}:${sel.focusOffset} focus=${document.hasFocus()}`
      : `none focus=${document.hasFocus()}`;
  },
  /** Caret visibility (the weight test hides it so it is not counted as a difference). */
  hideCaret(on: boolean) {
    note.style.caretColor = on ? "transparent" : "";
    return true;
  },
  /** Selects a span of the first text (for the check with a non-empty selection). */
  selectSome() {
    const walker = document.createTreeWalker(note, NodeFilter.SHOW_TEXT);
    const t = walker.nextNode();
    if (t?.textContent && t.textContent.length > 8) getSelection()?.setBaseAndExtent(t, 2, t, 8);
    return true;
  },
  /** Same, and resolves once the page has painted at that scale (for thawing a frozen editor). */
  async setScaleSettled(z: number) {
    note.style.transformOrigin = "0 0";
    note.style.transform = z === 1 ? "" : `scale(${z})`;
    await frames();
    return true;
  },
  /** One image alone, at its own size (an SVG drawn the way the Note draws it). */
  async renderImage(src: string, w: number, h: number) {
    editor?.destroy();
    editor = undefined;
    note.classList.remove("card", "still");
    note.classList.add("bare");
    note.style.width = `${w}px`;
    note.style.transform = "";
    note.innerHTML = `<img src="${src}" style="display:block;width:${w}px;height:${h}px">`;
    await settled();
    return true;
  },
  /** Editor zoom without re-layout: the Note keeps its 100 % layout and is scaled. */
  setScale(z: number) {
    note.style.transformOrigin = "0 0";
    note.style.transform = z === 1 ? "" : `scale(${z})`;
    return true;
  },
  value() {
    return editor ? editor.value() : null;
  },
  height() {
    return note.getBoundingClientRect().height;
  },
};
// Esc leaves the edit through native: it snapshots the editor's last picture before anything changes.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && editor && !e.defaultPrevented && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      post({ leave: true, value: editor.value() });
    }
  },
  true,
);
// Changes while editing (text, selection), so native can keep its bitmap of the editor current.
let changeTimer = 0;
const changed = () => {
  if (!editor || note.classList.contains("still")) return;
  clearTimeout(changeTimer);
  changeTimer = window.setTimeout(() => post({ changed: true }), 30);
};
note.addEventListener("input", changed);
document.addEventListener("selectionchange", changed);
// Height changes while editing, so native can grow the view.
new ResizeObserver(() => {
  if (editor) post({ height: note.offsetHeight });
}).observe(note);
post({ ready: true });

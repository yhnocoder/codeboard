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

const post = (m: unknown) => window.webkit?.messageHandlers.cb.postMessage(m);
const note = document.getElementById("note") as HTMLDivElement;
const md = createMarkdown({});
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
let editor: MdEditorHandle | undefined;

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
  /** Asset folder of the vault, as a file URL ending in "/". */
  setVault(base: string) {
    md.setAssetBase("assets", `${base}assets`);
  },
  /** Static render; resolves to the content height in CSS px once fonts and images are in. */
  async render(src: string, width: number, card: boolean) {
    editor?.destroy();
    editor = undefined;
    setBox(width, card);
    const html = md.render(src);
    note.innerHTML = html;
    md.hydrate(note, html);
    await settled();
    return note.getBoundingClientRect().height;
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
// Height changes while editing, so native can grow the view.
new ResizeObserver(() => {
  if (editor) post({ height: note.offsetHeight });
}).observe(note);
post({ ready: true });

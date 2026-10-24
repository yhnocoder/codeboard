// @codeboard/markdown on its own: a static note (read-only entry: renderMd + hydrate), click it to edit (the editor entry, loaded
// on first use), finishing the edit saves the Markdown back and renders it statically again. Everything a host would add comes in
// through the package's setters and options: the code highlighter, [[wiki link]] resolution and clicks, the image asset base.
// AI ghost completion (`complete`), language services (`code.lsp`) and image storage (`saveImage`; by default pasted and picked
// images stay inline as data: URLs) are optional hooks and are left off here.
import { renderMd, hydrate, mdClick, setCodeHighlighter, setRefResolver, setAssetBase } from "@codeboard/markdown";
import type { MdEditorHandle } from "@codeboard/markdown/editor";
import "@codeboard/markdown/katex.css";
import "@codeboard/markdown/style.css";
import "./demo.css";
import sample from "./sample.md?raw";
import { highlight } from "./highlight";

// ---------- what the page supplies ----------
setCodeHighlighter(async (text, lang) => highlight(text, lang), (lang) => (lang === "py" ? "python" : lang));
const PAGES = [
  { id: "paging", title: "Paging", kind: "page" },
  { id: "eviction", title: "Eviction", kind: "page" },
  { id: "prefix-cache", title: "Prefix cache", kind: "page" },
];
const findPage = (label: string) => PAGES.find((p) => p.id === label || p.title.toLowerCase() === label.trim().toLowerCase()) ?? null;
setRefResolver(findPage, { missing: "No page with this title" });
// ![…](assets/x.svg) → ./assets/x.svg in the static render (the editor shows the path as written, which this page serves too)
setAssetBase("./assets");

// ---------- the page ----------
const note = document.getElementById("note")!;
const source = document.getElementById("source")!;
const mode = document.getElementById("mode")!;
const opened = document.getElementById("opened")!;
let src = sample.trim();
let editor: MdEditorHandle | undefined;

function show() {
  const html = renderMd(src);
  note.classList.remove("editing");
  note.innerHTML = html;
  hydrate(note, html);
  source.textContent = src;
  mode.textContent = "Static · click to edit";
}

async function edit() {
  if (editor) return;
  mode.textContent = "Loading the editor…";
  const { mountEditor } = await import("@codeboard/markdown/editor");
  note.textContent = "";
  note.classList.add("editing");
  mode.textContent = "Editing · Esc or ⌘↵ saves";
  editor = mountEditor(note, {
    value: src,
    onDone: (v) => { editor = undefined; if (v !== null) src = v; show(); },
    refs: { items: () => PAGES, menu: "Link to Page", empty: "No page with that title" },
    openLink: (url) => { opened.textContent = `Opened link: ${url}`; },
  });
}

note.addEventListener("click", (e) => {
  if (editor) return;
  const handled = mdClick(e, src, {
    openLink: (url) => { opened.textContent = `Opened link: ${url}`; },
    openRef: (id) => { opened.textContent = `Opened page: ${id}`; },
    onToggle: (next) => { src = next; show(); },
  });
  if (!handled) void edit();
});

const theme = document.getElementById("theme")!;
theme.addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme !== "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  theme.textContent = dark ? "Light" : "Dark";
});

show();

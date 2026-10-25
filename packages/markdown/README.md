# @yhnocoder/markdown

A Typora-style WYSIWYG Markdown editor and a fast static renderer that share one schema.

- **Static render**: `renderMd(src)` turns Markdown into an HTML string (cached, no editor, no Solid), and `hydrate(el, html)` adds what needs the page: code highlighting, `[[wiki link]]` targets, Mermaid diagrams.
- **Editor**: `mountEditor(el, opts)` edits the same Markdown in place, Typora style: you type Markdown and it turns into formatting as you go, with a `/` menu, a selection toolbar, math, tables, task lists, footnotes, emoji, images and code blocks edited with CodeMirror. It is built on [TipTap](https://tiptap.dev) (ProseMirror) with a [SolidJS](https://www.solidjs.com) UI.
- Both sides read and write Markdown through one schema, so a note looks the same before, during and after editing, and what the editor saves is plain Markdown.

Supported: CommonMark and GFM (tables, task lists, strikethrough, autolinks), KaTeX math (`$…$`, `$$…$$`), Mermaid diagrams, footnotes, `:emoji:` shortcodes, `==highlight==`, `<details>`, `[toc]`, `[[wiki links]]` and inline HTML (sanitized with DOMPurify).

Used by [CodeBoard](https://github.com/yhnocoder/codeboard).

## Install

```bash
npm i @yhnocoder/markdown solid-js
```

`solid-js` is a peer dependency (the editor's UI is Solid; the read-only entry does not use it). The package is ES modules with TypeScript declarations; the JSX is already compiled, so you need no Solid compiler plugin. Use it with a bundler (Vite, webpack, esbuild, Rollup, Parcel…).

## Entries

| Import | What |
|---|---|
| `@yhnocoder/markdown` | Read-only: `parseMd`, `serializeMd`, `renderMd`, `renderMdInline`, `hydrate`, `mdClick`, `toggleTask`, and the setters `setCodeHighlighter`, `setRefResolver`, `setImageResolver` / `setAssetBase`. No Solid, no editor. |
| `@yhnocoder/markdown/editor` | The editor: `mountEditor`, plus `prepare` / `warmUp` to parse ahead of time. Load it with `import()` on first edit to keep it out of your initial bundle. |
| `@yhnocoder/markdown/code-editor` | The CodeMirror 6 code editor the editor uses for code blocks, on its own: `codeEditor`. |
| `@yhnocoder/markdown/ui` | Small helpers the editor uses that a host may share: key handling inside inputs (`keepKey`, `setKeyPassThrough`), popover placement (`place`, `virtual`), batched DOM measuring (`queueMeasure`, `observeResize`). |
| `@yhnocoder/markdown/katex.css` | KaTeX's stylesheet (imported from the `katex` package, so its fonts load from there). Import it before `style.css`. |
| `@yhnocoder/markdown/style.css` | The stylesheet for the static render (`.md`), the editor and the code editor. |

## Usage

Render statically, and switch to the editor on click:

```ts
import { renderMd, hydrate, mdClick, setCodeHighlighter, setRefResolver, setAssetBase } from "@yhnocoder/markdown";
import type { MdEditorHandle } from "@yhnocoder/markdown/editor";
import "@yhnocoder/markdown/katex.css";
import "@yhnocoder/markdown/style.css";

// Optional hooks: your code highlighter (text → HTML with token classes), [[wiki link]] targets, the base for relative images
setCodeHighlighter(async (text, lang) => myHighlighter(text, lang));
setRefResolver((label) => findPage(label), { missing: "No page with this title" });
setAssetBase("./assets");
// or resolve every image yourself, with its size if you know it (width / height reserve the space before it decodes):
// setImageResolver((src) => ({ src: myUrl(src), width: 640, height: 480 }));

const note = document.getElementById("note")!; // give it class="md"
let src = "# Hello\n\nSome **Markdown** with $e^{i\\pi} = -1$.";
let editor: MdEditorHandle | undefined;

function show() {
  const html = renderMd(src);
  note.innerHTML = html;
  hydrate(note, html);
}

async function edit() {
  if (editor) return;
  const { mountEditor } = await import("@yhnocoder/markdown/editor"); // loaded on first use
  note.textContent = "";
  editor = mountEditor(note, {
    value: src,
    // Esc or ⌘↵ ends the edit: the new Markdown, or null when nothing changed
    onDone: (v) => { editor = undefined; if (v !== null) src = v; show(); },
    openLink: (url) => window.open(url),
  });
}

note.addEventListener("click", (e) => {
  if (editor) return;
  // links, [[refs]] and task checkboxes in the static render; anything else starts editing
  const handled = mdClick(e, src, {
    openLink: (url) => window.open(url),
    openRef: (id) => openPage(id),
    onToggle: (next) => { src = next; show(); },
  });
  if (!handled) void edit();
});

show();
```

`mountEditor` takes more options, all optional: `placeholder`, `refs` (the `[[` menu's candidates), `saveImage` / `pickImage` (where pasted, dropped and picked images go: `saveImage(dataUrl, name)` resolves to the path written into the Markdown, or `null` to insert nothing; by default they stay inline as `data:` URLs), `complete` (inline AI completion), `code` (comment tokens and language services for code blocks) and `dragHandle` (a ⋮⋮ handle left of the hovered block for dragging it; off by default). The handle has `value()`, `destroy()` and `editor()` (the TipTap editor).

A complete page using only this package is in [examples/markdown-demo](https://github.com/yhnocoder/codeboard/tree/main/examples/markdown-demo).

## Theming

`style.css` takes its colors and fonts from CSS variables that you define on `:root` (or on an element around the notes), so it follows your app's theme; switch them for dark mode:

| Variables | Used for |
|---|---|
| `--ink` `--ink-2` `--ink-3` | Text, from strongest to faintest |
| `--surface` `--hlrow` | Background; light fill for table headers, code blocks, hover |
| `--hair` `--line` | Thin rules |
| `--accent` `--accent-ink` | Accent color and text on it |
| `--warn` | Errors |
| `--k-fn` | Links, refs, footnotes |
| `--k-kw` `--k-num` `--k-self` `--k-str` `--lk-blue` `--lk-orange` `--lk-green` | Mermaid series colors |
| `--sh-float` | Shadow of popovers |
| `--md-hl` | Background of `==highlight==` (a translucent highlighter color) |
| `--sys` `--mono` `--note-h` | Body / Mermaid font, code font, small headings |
| `--r-card` | Corner radius (Mermaid uses half) |
| `--t` | Animation duration multiplier (1 is normal) |
| `--ico-w` | Stroke width of the selection toolbar's icons: 1 (default) or 2 px |

A few classes are styled by the page, not by the package, so menus and buttons match the rest of your UI: `.ctx` (menus), `.pill` (floating bars), `.tbtn` (toolbar buttons, `.on` when the format is active; each carries its name in `data-tip` and its shortcut in `data-kbd` for your tooltips), `.lnk` (links in the static render), and the token classes your highlighter emits (`.kw`, `.fn`, `.str`, `.com`, `.num`, `.self`). Heading sizes, list indents, quotes and the code block box are also left to the container. The demo's [demo.css](https://github.com/yhnocoder/codeboard/blob/main/examples/markdown-demo/src/demo.css) is a complete light and dark theme to start from.

## License

MIT

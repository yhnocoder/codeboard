# @yhnocoder/markdown

A Typora-style WYSIWYG Markdown editor and a fast static renderer that share one schema.

- **Static render**: `createMarkdown(options)` makes a configured instance; its `render(src)` turns Markdown into an HTML string (cached, no editor, no Solid), and `hydrate(el, html)` adds what needs the page: code highlighting, `[[wiki link]]` targets, Mermaid diagrams.
- **Editor**: `mountEditor(md, el, opts)` edits the same Markdown in place, Typora style: you type Markdown and it turns into formatting as you go, with a `/` menu, a selection toolbar, math, tables, task lists, footnotes, emoji, images and code blocks edited with CodeMirror. It is built on [TipTap](https://tiptap.dev) (ProseMirror) with a [SolidJS](https://www.solidjs.com) UI.
- **Find and replace** while editing: `⌘F` / `Ctrl+F` opens a small bar in the editor's top-right corner (every match highlighted, `Enter` / `Shift+Enter` to step, match case), `⌥⌘F` / `Ctrl+Alt+F` adds the replace field (`Enter` replaces one, `⌘↵` all, one undo step), `Esc` closes it. The code editor (`codeEditor({ find: true })`) has the same bar. Shortcuts and their labels follow the platform the page runs on (`⌘` / `⌥` on a Mac, `Ctrl+` / `Alt+` elsewhere); `IS_MAC` from `@yhnocoder/markdown/ui` is that same check, for labels of your own. Matches in the Markdown editor are drawn with the CSS Custom Highlight API (`::highlight(md-find)`, `::highlight(md-find-cur)`).
- Both sides read and write Markdown through one schema, so a note looks the same before, during and after editing, and what the editor saves is plain Markdown.

Supported: CommonMark and GFM (tables, task lists, strikethrough, autolinks), KaTeX math (`$…$`, `$$…$$`), Mermaid diagrams, footnotes, `:emoji:` shortcodes, `==highlight==`, `{text|annotation}`, `<details>`, `[toc]`, `[[wiki links]]` and inline HTML (sanitized with DOMPurify).

Images can be narrower than the text: `![alt](src){width=40%}` (Pandoc's attribute syntax) shows the image at 40% of the body's width, centered, so it scales with the container. In the editor, select an image and drag either of the handles on its bottom corners to set the width, which changes on both sides around the centre (one undo step per drag); double-click a handle for the full width again. Images without it fill the width, as before.

The same block holds an animated image's playback for a page that plays GIFs or animated SVGs itself: `frame=N` (from 1) is the frame it stands still on, and `loop=true` plays it all the time, as in `![alt](src){width=40% frame=12 loop=true}` (any order; a block with another key stays text). The static render and the editor put them on the `<img>` as `data-frame` and `data-loop`; the renderer itself does not play or pause anything. `imagePlayback(md, src, nth)` reads the nth image with that address's `{ width, frame, loop }`, and `setImagePlayback(md, src, nth, { frame, loop })` changes them (frame 1 and loop off are left out), rewriting only that image's attribute block. Resizing an image in the editor keeps its other attributes.

An image's title is its caption: `![alt](src "Figure 1: …")` shows "Figure 1: …" centred right under the image in small muted type (`.md-cap`), in the static render and in the editor alike; a narrowed image's caption keeps the body's width. A table's caption is a line `Table: …` right after it (Pandoc's table captions), drawn under the table the same way (the table and its caption in a `.md-tfig`, centred). Captions are inline Markdown: `$…$` formulas, bold, code. `imageCaption(md, src, nth)` reads the caption of the nth image with that address and `setImageCaption(md, src, nth, caption)` sets it (an empty caption removes it), changing only that image's Markdown; `tableCaption(md, nth)` and `setTableCaption(md, nth, caption)` do the same for the nth table.

Annotations write a handwritten note above a span of text, ruby style: `{Scheduler|decides who runs first}`. An optional third part sets the color (`blue`, the default, `purple`, `orange` or `green`) and `below` puts the note under the text: `{one forward pass|prefill or decode|purple below}`. Write `\{ \} \| \\` for those characters inside, and `|` as `\|` inside a table cell. Annotations are unrelated to `==highlight==`. The note is inline Markdown, so `$…$` in it is a formula and `**bold**` or `` `code` `` are formatted: `{wave count|$a$ waves}`. Other Markdown viewers show the source as written, so no text is lost. The note (an element of class `md-annot-n` inside the annotation) and its small arrow are placed with CSS: the annotated words become an inline block with a narrow rail above (or below), so only that line gets taller.

Used by [CodeBoard](https://github.com/yhnocoder/codeboard).

## Install

```bash
npm i @yhnocoder/markdown solid-js
```

`solid-js` is a peer dependency (the editor's UI is Solid; the read-only entry does not use it). The package is ES modules with TypeScript declarations; the JSX is already compiled, so you need no Solid compiler plugin. Use it with a bundler (Vite, webpack, esbuild, Rollup, Parcel…).

## Entries

| Import | What |
|---|---|
| `@yhnocoder/markdown` | Read-only: `createMarkdown` (see [The instance](#the-instance)), `parseMd`, `serializeMd`, `toggleTask`, `staticTextRange` / `docRange` (text selected in the static render → the same range in the editor's document) and `staticDomRange` (back to a DOM range), `toggleStaticMark` / `staticMarkActive` (bold or highlight text selected in the static render straight in the source, without the editor), `mdBlockStarts` (where each top-level block starts in the source, to insert Markdown between two blocks), `imageCaption` / `setImageCaption` (an image's caption, its title), `tableCaption` / `setTableCaption` (a table's caption, its `Table: …` line), `IMAGE_DRAG_TYPE` / `draggedImage(dataTransfer)` (an image dragged in the editor carries `{ src, alt, caption }` under this type, so a drop outside the editor can tell which image it was; a drop target that sets `dropEffect = "move"` moves it: its source leaves the editor's text), `texBrackets(src)` (Markdown pasted from elsewhere with `\( … \)` and `\[ … \]` formulas → `$…$` and `$$…$$`; those in code, HTML or a formula stay), `applyMdLayout(el, layout)` (see [Layout](#layout)) and `pickCopy(copies, shown)` (the copy of an image an instance would show `shown` device pixels wide, see [Images](#images)). No Solid, no editor. |
| `@yhnocoder/markdown/editor` | The editor: `mountEditor(md, el, opts)`, plus `prepare(md, value, layout?)` / `warmUp(md, extra?)` to parse ahead of time (one editor is kept per instance and reused; `warmUp` draws a sample of every kind of block once while the page is idle, and `extra`, a Markdown of your own, after it). Load it with `import()` on first edit to keep it out of your initial bundle. |
| `@yhnocoder/markdown/code-editor` | The CodeMirror 6 code editor the editor uses for code blocks, on its own: `codeEditor` (its `passKeys` and `ghost.hold` work as the instance's options below; `ghost.on()`, when given, is asked before each completion is scheduled, and while it returns `false` none is). With `gutter` (line numbers) its root has the class `cbcm-gutter`, to size the number column (`.cm-lineNumbers`) to your layout. |
| `@yhnocoder/markdown/ui` | Small helpers the editor uses that a host may share: key handling inside inputs (`keepKey(e, passKeys?)`: stops the key unless it was handled or `passKeys` lets it out), popover placement (`place`, `virtual`), scrolling an item into view inside its own list or panel only, not the pages that embed this one (`scrollIntoBox`), a page's batched DOM measuring (`createMeasure(batch?)` → `{ queue, observe }`) and hold on AI completions (`createGhostHold()` → `{ hold(on) }`), both to share with an instance, the editor's fixed delays (`TOOLBAR_SETTLE`: how long a selection holds still before its toolbar shows), and the selection toolbar's icons (`Icon`, a Solid component). |
| `@yhnocoder/markdown/katex.css` | KaTeX's stylesheet (imported from the `katex` package, so its fonts load from there). Import it before `style.css`. |
| `@yhnocoder/markdown/style.css` | The stylesheet for the static render (`.md`), the editor and the code editor. |

## Usage

Render statically, and switch to the editor on click:

```ts
import { createMarkdown } from "@yhnocoder/markdown";
import type { MdEditorHandle } from "@yhnocoder/markdown/editor";
import "@yhnocoder/markdown/katex.css";
import "@yhnocoder/markdown/style.css";

// All options are optional: your code highlighter (text → HTML with token classes), [[wiki link]] targets, …
const md = createMarkdown({
  highlight: async (text, lang) => myHighlighter(text, lang),
  refs: { resolve: (label) => findPage(label), missing: "No page with this title" },
});
md.setAssetBase("assets", "./assets"); // ![](assets/a.png) shows ./assets/a.png
// or resolve every image yourself, with its size if you know it (width / height reserve the space before it decodes):
// md.setImageResolver((src) => ({ src: myUrl(src), width: 640, height: 480 }));

const note = document.getElementById("note")!; // give it class="md"
let src = "# Hello\n\nSome **Markdown** with $e^{i\\pi} = -1$.";
let editor: MdEditorHandle | undefined;

function show() {
  const html = md.render(src);
  note.innerHTML = html;
  md.hydrate(note, html);
}

async function edit() {
  if (editor) return;
  const { mountEditor } = await import("@yhnocoder/markdown/editor"); // loaded on first use
  note.textContent = "";
  editor = mountEditor(md, note, {
    value: src,
    // Esc or ⌘↵ ends the edit: the new Markdown, or null when nothing changed
    onDone: (v) => { editor = undefined; if (v !== null) src = v; show(); },
    openLink: (url) => window.open(url),
  });
}

note.addEventListener("click", (e) => {
  if (editor) return;
  // links, [[refs]] and task checkboxes in the static render; anything else starts editing
  const handled = md.click(e, src, {
    openLink: (url) => window.open(url),
    openRef: (id) => openPage(id),
    onToggle: (next) => { src = next; show(); },
  });
  if (!handled) void edit();
});

show();
```

`value` and `onDone` are required. `mountEditor` takes more options, all optional: `placeholder`, `refs` (the `[[` menu's candidates, each with an optional `target` id written into the reference as `[[title#^id]]` so it survives a rename; optionally `groups` of candidates from other places, each listed under its own selectable header with three items and a "+ N more" row, `recent` picks shown first, a `foot` line and a `picked` callback. The instance's `refs.resolve` may return a `badge` shown after the title, a `seal` drawn before it instead (`{ text, color, outer?, alone? }`: a short coloured mark of the place the target is in, `color` any CSS colour; `outer` adds the larger place it belongs to as a tinted, outlined first half of the same box; `alone` draws only the seal, for a ref to the place itself), a `hint` shown on hover, or `{ broken: "item" | "place", title }` for a target that is gone; `md.paintRef(el)` repaints one chip when its data arrives later), `saveImage` / `pickImage` (where pasted, dropped and picked images go, SVG markup pasted as text included: `saveImage(dataUrl, name)` resolves to the path written into the Markdown, or `null` to insert nothing; by default they stay inline as `data:` URLs), `copyImage(src, md)` (⌘C on an image puts the picture itself on the clipboard, instead of its Markdown as text) and `knownImage(file)` (a pasted or dropped picture you recognise, such as one you put on the clipboard with `copyImage`: the Markdown to insert instead of saving it, or `null`), `complete` (inline AI completion: `complete(before, after)` resolves to the text to suggest at the caret, or `null`; without it nothing is asked), `code` (comment tokens and language services for code blocks, and `langs`: the languages listed when the language name at a code block's top right is clicked, as `{ name, label, aliases }` where `label` is what the block shows and `name` is what goes into the fence), `dragHandle` (a ⋮⋮ handle left of the hovered block for dragging it; off by default), `classes` (your own classes added to the editor's menus, floating bars and buttons, next to the package's, as `{ menu, bar, button }`: for example `{ menu: "ctx", button: "btn" }` to reuse your page's menu and button styles; `codeEditor` takes it too, for its find bar) `layout` (see [Layout](#layout)), `onSourceMode` (see `toggleSource` below) and `scrollOwnBox` (keeping the caret in view scrolls only the nearest scrolling box around the text, never the page or further ancestors: for an editor on a surface that does not scroll). The handle has `value()`, `layout()` (the [layout](#layout) as it is now), `destroy()`, `toggleSource()` (rich text ↔ Markdown source; `onSourceMode(on)` is told each time it switches, ⌘/ included, to show your toggle pressed), `placeCaret(at)` (at `"end"`, next to characters counted as the static render shows them, `{ visible: staticTextRange(…), after }`, or at a point on the page, `{ x, y }`), `selectVisible(range)` (select characters counted the same way) `press(key)` (`Backspace` or `Delete`, as if typed in the editor) and `type(text)` (text typed at the selection one character at a time, key bindings and input rules included; a newline is Enter). Together with `staticTextRange` they carry a click or a selection in the static render over into the editor, and `type` the keys typed while the editor was still loading.

A complete page using only this package is in [examples/markdown-demo](https://github.com/yhnocoder/codeboard/tree/main/examples/markdown-demo).

## The instance

`createMarkdown(options)` returns a `Markdown`: everything that depends on configuration (the static render and its cache, `hydrate`, clicks, the editor and its code blocks) goes through it, so two instances on one page keep their own settings. They share only the editors' input state (where a drag or an IME composition is), since one editor takes input at a time. Options, all optional:

| Option | What |
|---|---|
| `refs: { resolve, missing? }` | `[[wiki link]]` targets: `resolve(label, target?)` returns `{ id, title, badge?, seal?, hint?, place? }`, `{ broken, title, … }` or `null`; `target` is the id a reference picked from the `[[` menu carries (`[[title#^id]]`, see `RefItem.target`), so look it up by id first and show its current title; `missing` is the tooltip of one not found |
| `highlight(text, lang)`, `langId(lang)` | Code highlighting (a `Promise` of HTML with token classes, or `null`); `langId` maps a language name to the id it is cached and asked under |
| `images(src)` | Resolve image addresses (or `setAssetBase` / `setImageResolver` later): `{ src, width?, height?, copies? }`, see [Images](#images) |
| `displayScale()`, `imageVisible(img)`, `makeImageCopy(src, width)`, `eagerImages` | Which copy of an image is shown and when it loads, see [Images](#images) |
| `mathPreamble` | Definitions every formula can use (or `setMathPreamble` later) |
| `passKeys(e)` | Unhandled keys inside the editors' inputs that still bubble out to your page's shortcuts (by default none) |
| `measure`, `ghosts` | Your page's `createMeasure()` and `createGhostHold()` (`/ui`), to share one measuring round and one hold on AI completions with your own code; by default the instance has its own |

Its methods: `render(src)`, `renderInline(src)` (without the outer `<p>` when it is one paragraph), `isCached(src)`, `hydrate(el, html)`, `click(e, src, { openLink, openRef, onToggle? })`, `paintRef(el)`, `setMathPreamble(src)`, `mathPreambleErrors()`, `mathMacros()`, `setAssetBase(dir, base)` (addresses under the folder `dir`, as written in the Markdown, are served from `base`), `setImageResolver(r)`, `updateImages(root?)` and `showImage(img, src)` (see [Images](#images)) and `undoubleTex(text)` (plain text where a formula copied from a web page reads as its glyphs followed by its TeX → `$TeX$`). A change of preamble or image addresses clears the instance's render cache; HTML already on the page stays as it was, so render it again. Its caches are bounded (renders, highlighted code, Mermaid diagrams, image sizes and failed addresses).

## Images

The resolver may list smaller copies of an image, `copies: [{ width, src? }]`, besides the original's `src` and size. Each image then shows the smallest copy still sharp at its laid-out width times `displayScale()` (your page's zoom times `devicePixelRatio`; by default `devicePixelRatio`), with a little headroom; `pickCopy(copies, shown)` makes the same choice for your own code. Copies are used only when the original's size is known, so a copy takes the space the original would. A copy listed without `src` is one your page can make: the instance calls `makeImageCopy(src, width)` when it needs it. Call `md.updateImages(root?)` when the display scale changes, a copy has been made, or the images inside `root` came on screen; until then an image `imageVisible(img)` says is off screen keeps the source it has. `md.showImage(img, src)` shows an image written as `src` in an `<img>` of your own, picked and kept up the same way, and returns a function that stops. `eagerImages: true` loads every image at once and draws it only once decoded (no `loading="lazy"`, `decoding="sync"`): for a page whose images come into view by a transform, such as a zoomed-out canvas, where a lazy image would not be loaded yet and an async one would be blank for a few frames.

## Layout

Table column widths, row heights and which code blocks wrap are not Markdown, so the editor keeps them out of it and hands them to you: give the editor `layout` (an `MdLayout`, `{ tables?: [{ cols?, rows? } | null], wrap?: [n] }`, matched by position: the nth table, the nth code block) with the Markdown; `onDone(value, layout)` gets the new one as its second argument only when it changed (`null`: all automatic again), and `handle.layout()` returns it at any time. Keep it next to the Markdown, and after putting a static render on the page call `applyMdLayout(el, layout)` (again after each render) to size its tables and wrap its code blocks the same way. Notes stay plain GFM for every other reader.

## Math

Formulas are typeset with [KaTeX](https://katex.org): `$…$` inline, `$$…$$` on its own line as a block.

**Preamble.** `md.setMathPreamble(src)` sets `\newcommand`, `\renewcommand` and `\def` lines that every formula can use, in the instance's static render and editor, for example:

```ts
md.setMathPreamble("\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\norm}[1]{\\lVert #1 \\rVert}");
md.mathPreambleErrors(); // KaTeX's message for each definition it could not read, [] when all are fine
```

It returns `true` when the preamble changed. A change clears the instance's render cache; HTML you already put on the page stays as it was, so render it again. Each formula gets a fresh copy of the definitions, so a `\newcommand` written inside one formula stays in that formula. A definition may span several lines; one with a mistake is skipped and the others still apply. `md.mathMacros()` returns the definitions as KaTeX `macros` (a new object each call) for your own `katex.render` calls.

**Hints while editing a formula.** In the editor, typing `\` inside a formula (a math block's source, or an inline formula opened as `$…$`) lists matching commands, each with how it looks and a short description; preamble commands are tagged 预设 and those defined in the same formula 本式. ↑↓ choose, Enter or Tab insert (the caret lands in the first `{}`), Esc closes the list. While you type, a live preview shows the result (a small bubble under an inline formula). When the formula does not typeset, the last good result stays, dimmed, with a short explanation of what is wrong, the place marked, and a one-click fix for the common cases (a misspelled command → the nearest known one, preamble commands included; a missing `}`). Nothing is reported while you are still typing a command name that can complete. The hints use these classes, styled by `style.css`: `.md-mathac` (the list), `.md-mathtip` (the inline preview bubble), `.md-matherr` (the explanation) and `.md-mathstale` (the dimmed last good result).

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
| `--md-hl` | Color of the `==highlight==` marker band, drawn under the lower half of the text (a translucent highlighter color) |
| `--md-annot-blue` `--md-annot-purple` `--md-annot-orange` `--md-annot-green` | Colors of `{text|annotation}` (defaults built in) |
| `--md-hand` | Handwriting font of annotations (default: Shantell Sans, then LXGW WenKai Lite, Kaiti, cursive; the package bundles no fonts) |
| `--sys` `--mono` `--md-heading-font` | Body / Mermaid font, code font, small headings (default: `--sys`) |
| `--md-fs` | Body text size of a `.md` block (default: the size around it). Set it on the `.md` element or one around it; it applies the same to the static render and the editor, at once, without re-rendering |
| `--md-h1` … `--md-h6` | Heading sizes (defaults `1.8em` `1.35em` `1.1em` `1em` `1em` `1em`, relative to the body text; give `px` for a fixed size) |
| `--md-radius` | Corner radius (Mermaid uses half; default 10px) |
| `--t` | Animation duration multiplier (1 is normal) |
| `--ico-w` | Stroke width of the selection toolbar's icons: 1 (default) or 2 px |

A few classes are styled by the page, not by the package, so menus and buttons match the rest of your UI: `.md-menu` (menus, `.open` while shown), `.md-bar` (floating bars), `.md-btn` (toolbar buttons, `.on` when the format is active; each carries its name in `data-tip` and its shortcut in `data-kbd` for your tooltips), `.md-link` (links, in the static render and the editor: their color and underline), and the token classes your highlighter emits (`.kw`, `.fn`, `.str`, `.com`, `.num`, `.self`). List indents, quotes and the code block box are left to the container; heading sizes have the defaults above, which your own rules override. The demo's [demo.css](https://github.com/yhnocoder/codeboard/blob/main/examples/markdown-demo/src/demo.css) is a complete light and dark theme to start from.

## License

MIT

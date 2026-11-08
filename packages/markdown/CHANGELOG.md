# Changelog

## Unreleased

Added (nothing to change when upgrading):

- New `eagerImages` option on `createMarkdown`: every image is loaded at once and drawn only decoded (no `loading="lazy"`, `decoding="sync"`; by default images stay lazy and async). For a page whose images come into view by a transform, such as a canvas zoomed out, where a lazy image is not loaded yet and an async one is drawn as nothing for a few frames while it decodes.

Fixed:

- An image the page says is off screen (`imageVisible`) whose wanted smaller copy is not made yet no longer loads the original meanwhile: it shows the smallest copy there is, or no source at all, and takes its copy on `updateImages` whether on screen or not. With `eagerImages` it fetched the full size of every image off screen.

## 0.2.0

Changes that need code or styles updated when upgrading from 0.1.1:

- `MdEditorHandle.editor()` is removed. Carry a click or a selection from the static render into the editor with `placeCaret(at)` (`"end"`, `{ visible: staticTextRange(…), after }` or a point `{ x, y }`), `selectVisible(range)` and `press("Backspace" | "Delete")`.
- `setAssetBase(dir, base)` takes the folder as written in the Markdown as well: `setAssetBase("assets", "./assets")` where it was `setAssetBase("./assets")`.
- The `isMac` editor option is removed: the package reads the platform itself (`IS_MAC` in `@yhnocoder/markdown/ui`).
- New `classes` option (`{ menu, bar, button }`) on `mountEditor` and `codeEditor`. The editor no longer uses the page's `.ctx`, `.pill` and `.tbtn`: its menus, floating bars and buttons are `.md-menu` (`.open` while shown), `.md-bar` and `.md-btn` (`.on` when active), plus whatever classes you pass. Style those, or pass your own class names.
- Links are `a.md-link` (was `.lnk`), in the static render and the editor.
- The spacing between a paragraph and the paragraph or block next to it comes from classes instead of sibling selectors (`p + p`, `p + ul`, `ul + p`, which made Chrome restyle every later block of a long Note on each Enter): the static render and the editor give a paragraph after a paragraph `md-pp`, and a block after a paragraph or a paragraph after a block `md-gap`; `style.css` spaces them as before. A rule of yours that changed that spacing with sibling selectors should target these classes, and code that reads the rendered HTML as text should expect them in the class attribute (`<pre class="md-gap md-code" …>`).
- Theme variables: `--md-radius` (was `--r-card`) and `--md-heading-font` (was `--note-h`).
- The code editor's line-number class is `cbcm-gutter` (was `cbcm-card`), and its default gutter width is no longer the board's.
- Removed exports: `mdSchema`, `baseExtensions`, `clearMdCache` (a new math preamble or image resolver clears the render cache on its own), `resolveRef`, `highlightCode`, `cachedCode`, `colorCode` from `@yhnocoder/markdown`; `parseHl`, `LspKind`, `EditorSelection` and `keymap` from `@yhnocoder/markdown/code-editor` (import the last two from `@codemirror/state` and `@codemirror/view`).

Added:

- `RefTarget.seal` (`RefSeal`: `{ text, color, outer?, alone? }`): a short coloured mark drawn before a ref's title, in place of the `badge`, styled by `.md-seal` in `style.css`; `RefTarget.hint`: the ref's hover text.
- `MdEditorHandle.type(text)`: types text at the selection as if on the keyboard (key bindings and input rules run; a newline is Enter), for keys typed before the editor was mounted.
- `tableCaption` / `setTableCaption`: a table's caption, stored as a Pandoc `Table: …` line right after the table.
- `imagePlayback` / `setImagePlayback` and the types `ImageAttrs` / `ImagePlayback`: an animated image's snapshot frame and "always play" flag, stored in the image's attribute block (`{width=40% frame=12 loop=true}`).

Fixed:

- A `{text|note}` annotation's text and note can hold `{ }` pairs as typed, so a note like `$\frac{a}{b}$ 倍` is an annotation with its formula typeset (a `|` inside a pair does not end the part). The note is written back the same way: pairs stay as they are, and `\` is doubled only before `\ { } |` or at the end. Unpaired braces and `|` are still escaped (`\{ \} \|`), and the escaped form written before reads as it did.

- `{text|note}` annotations close together on one line no longer draw their labels over each other, in the static render and the editor: two labels that would overlap are spread apart (each still over its own arrow, inside its block), and when that is not enough one goes up a row with a longer arrow, its line keeping room for it above. The labels are measured in the instance's `measure` round (the editor's are now fitted too); the annotation's inline `--rise` holds the extra height.

Also added (nothing to change when upgrading):

- References can carry their target's id: `[[title#^id]]` (an id of letters, digits, `_` and `-`, optionally `board/card`). The `[[` menu writes it when a candidate (`RefItem`) or a group (`RefGroup`) has the new `target` field, and `refs.resolve(label, target)` gets it as a second argument, so the reference can be found by id after its target is renamed; show the target's current title from `resolve` and the stored title is only the readable fallback. The static render puts it on the chip as `data-target`; plain-text copies and the editor's source keep the readable `[[title]]` part, with `#^id` drawn as part of the closing marker. `[[title]]` without an id works as before.

- New `copyImage(src, md)` editor option: ⌘C with the caret in an image's source (the image drawn selected) cancels the copy and calls it, so the page can put the picture itself on the clipboard (image/png alone, for other apps). Without it, copying works as before and the caret alone copies nothing.
- New `knownImage(file)` editor option: a pasted or dropped picture the page recognizes (one it copied) is inserted as the Markdown it returns instead of being saved again.


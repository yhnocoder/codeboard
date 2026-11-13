# Changelog

## Unreleased

Added (nothing to change when upgrading):

- New `refs.showing(pick, row)` option on `mountEditor`: told which candidate the `[[` menu highlights (its `RefPick` and its row in the list) each time that changes, and `(null, null)` when the menu closes, so the page can show what it points to beside the list.
- New `refs.link(href)` option on `createMarkdown`: a link whose address names one of your items (the `target` it returns) keeps its own text, is drawn found or not as a reference is (`a.md-cardlink`, `missing` or `gone`), and is clicked as a reference is (`openRef`, `onRef`).
- In the editor, an address (a web address, or one `refs.link` reads) pasted on words selected in one paragraph makes them a link to it, and one `refs.link` reads pasted on nothing is written as a reference to that item.
- New `onRef(to, el)` option on `mountEditor`: a click on a drawn `[[reference]]` that resolves goes to it first; returning `true` keeps the caret where it was (the page showed what the reference points to), otherwise the click opens the reference's source as before. A double-click always opens the source.
- New `headingChip` option on `mountEditor`: `false` leaves out the chip that shows and changes the level of the heading the caret is in (on by default).
- New `eagerImages` option on `createMarkdown`: every image is loaded at once and drawn only decoded (no `loading="lazy"`, `decoding="sync"`; by default images stay lazy and async). For a page whose images come into view by a transform, such as a canvas zoomed out, where a lazy image is not loaded yet and an async one is drawn as nothing for a few frames while it decodes.

Fixed:

- A press on a link in the editor held as long as a hand holds a click (from about 40 ms) put the caret into the link instead of opening its box: the browser had already moved the caret there by the time the click came.
- A click on a long address shown as its site in the editor (`github.com/…`) followed the link in the page itself; a click on any link in the editor no longer reaches the page's own navigation or a listener further up that opens addresses.
- After a change in the link box, a click elsewhere in the text wrote the change but left the caret in the link instead of where the click was.
- The link box and the selection's toolbar stay under their text when the page moves the editor (a canvas panned or zoomed) instead of keeping their place in the window; the address field shows the start of the address, not its end.
- A long address written as it is renders as its site (`github.com/…`) in the static render too, as the editor shows it, so the text keeps its height when editing starts; copying it gives the whole address.
- References to another board show the pointer over all of their label, and a reference that finds nothing shows the arrow.
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


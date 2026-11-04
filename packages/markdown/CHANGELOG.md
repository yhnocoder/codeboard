# Changelog

## Unreleased (additions)

Nothing to change when upgrading:

- References can carry their target's id: `[[title#^id]]` (an id of letters, digits, `_` and `-`, optionally `board/card`). The `[[` menu writes it when a candidate (`RefItem`) or a group (`RefGroup`) has the new `target` field, and `refs.resolve(label, target)` gets it as a second argument, so the reference can be found by id after its target is renamed; show the target's current title from `resolve` and the stored title is only the readable fallback. The static render puts it on the chip as `data-target`; plain-text copies and the editor's source keep the readable `[[title]]` part, with `#^id` drawn as part of the closing marker. `[[title]]` without an id works as before.

## Unreleased (breaking, next minor)

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

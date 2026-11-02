# Changelog

## Unreleased (breaking, next minor)

Changes that need code or styles updated when upgrading from 0.1.1:

- `MdEditorHandle.editor()` is removed. Carry a click or a selection from the static render into the editor with `placeCaret(at)` (`"end"`, `{ visible: staticTextRange(…), after }` or a point `{ x, y }`), `selectVisible(range)` and `press("Backspace" | "Delete")`.
- `setAssetBase(dir, base)` takes the folder as written in the Markdown as well: `setAssetBase("assets", "./assets")` where it was `setAssetBase("./assets")`.
- The `isMac` editor option is removed: the package reads the platform itself (`IS_MAC` in `@yhnocoder/markdown/ui`).
- New `classes` option (`{ menu, bar, button }`) on `mountEditor` and `codeEditor`. The editor no longer uses the page's `.ctx`, `.pill` and `.tbtn`: its menus, floating bars and buttons are `.md-menu` (`.open` while shown), `.md-bar` and `.md-btn` (`.on` when active), plus whatever classes you pass. Style those, or pass your own class names.
- Links are `a.md-link` (was `.lnk`), in the static render and the editor.
- Theme variables: `--md-radius` (was `--r-card`) and `--md-heading-font` (was `--note-h`).
- The code editor's line-number class is `cbcm-gutter` (was `cbcm-card`), and its default gutter width is no longer the board's.
- Removed exports: `mdSchema`, `baseExtensions`, `clearMdCache` (a new math preamble or image resolver clears the render cache on its own), `resolveRef`, `highlightCode`, `cachedCode`, `colorCode` from `@yhnocoder/markdown`; `parseHl`, `LspKind`, `EditorSelection` and `keymap` from `@yhnocoder/markdown/code-editor` (import the last two from `@codemirror/state` and `@codemirror/view`).

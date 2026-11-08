# The macOS app's shape

One JavaScript context per process, one Storage per boards folder, one session per open board. Windows are views.

```
AppDelegate.bridge : JSBridge            one JSContext (dist/bridge.js: @codeboard/core, the host's Storage, the highlighter)
  └ Folder (per boards folder)           bridge.folder(dir): one Storage, FSEvents, the board list; ref-counted by its windows
      └ Session (per open board)         folder.open(id): the board, core's history (undo), saving, arrow routing, the scene diff
BoardWindowController                    a view onto a Folder and the Session of the board it shows
```

## Swift (`Sources/CodeBoard/JSBridge.swift`)

- `JSBridge(bundle:resources:)` is made once, in `AppDelegate.applicationDidFinishLaunching`. Everything in it runs on the main
  thread; async calls take a callback and resolve through the JavaScript side's `reply` event.
- `bridge.folder(dir)` returns the `Folder` for a boards folder (the same object for every window on it; it counts them). A window
  calls `folder.release()` when it closes; the last release closes the Storage (flushed, FSEvents stopped). `folder.list`,
  `folder.open(id)` (→ the `Scene` and a `Session`), `folder.flush`, `folder.listen(owner) { name, boardId, json in … }` for
  events: `boards` (the folder's list changed), and per board `changed` (`{dir, id, change: SceneChange}`), `stacks`
  (`{undo, redo}`), `toast` (`{text}`); `log`.
- `Session` is a plain value (`dir`, `id`): `changes`, `undo`, `redo`, `beginDrag` / `drag` / `endDrag(moves)` (the drop runs
  core's `dropCards`), `cam`, `route(rects)` (synchronous), `benchEdit`. Two windows on one board get the same session: edits in
  one reach the other through the `changed` event.
- `bridge.flush()` writes every folder's unsaved changes (quit). Cameras are not in the board files: `CameraStore.shared`, one
  per process, in Application Support.

A new window kind (the library, a card viewer) takes `bridge.folder(dir)` and `listen`s; it needs no context or Storage of its own.
Something new a window needs from core goes into `js/bridge.ts` as a method on the session (or the folder) and into `CodeBoard` in
`js/entry.ts` with `(req, dir, id, …)` arguments, then a line in `JSBridge.swift` and on `Session` / `Folder`.

## JavaScript (`js/`)

- `entry.ts` publishes `CodeBoard` on `globalThis`: every method names its folder (`dir`) and, for a board, its `id`; async ones
  take a request number first.
- `bridge.ts` `createBridge(native)`: `folder(dir)` → `{ list, open(id) → Session, flush, close, sessions }`; a `Session` is the
  interface at the top of the file. The highlighter (shiki, tree-sitter grammars loaded per language on first use) and the
  timers are per process.
- `native.ts` is what the shell gives JavaScript: a synchronous file system, FSEvents, timers, the camera store, `emit`.
- `scene.ts` is what the canvas draws (plain JSON, mirrored by `Scene.swift`); `routes.ts` the arrows over core's
  `canvas/arrow.ts`; `highlight.ts` the host's `Highlighter`.

## Drawing (`CanvasView.swift`, `Layers.swift`)

The camera is the world layer's transform. Each card is a `CardLayer` rasterised into an IOSurface on a three-wide queue at a few
zoom buckets, culled when far from the viewport; Sections are shape layers; arrows shape layers from core's path strings. Colours
come from `themes.json`, generated from the board's stylesheets at build time.

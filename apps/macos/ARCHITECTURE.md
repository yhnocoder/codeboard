# The macOS app's shape

One JavaScript context per process, one Storage per boards folder, one session per open board. Windows are views.

```
AppDelegate.bridge : JSBridge            one JSContext (dist/bridge.js: @codeboard/core, the host's Storage, the highlighter)
  └ Folder (per boards folder)           bridge.folder(dir): one Storage, FSEvents, the board list; ref-counted by its windows
      └ Session (per open board)         folder.open(id): the board, core's history (undo), saving, arrow routing, the scene diff
BoardWindowController                    a view onto a Folder and the Session of the board it shows
```

## Swift (`Sources/CodeBoard/JSBridge.swift`)

- `JSBridge(bundle:resources:)` is made once, in `AppDelegate.init` (so its bundle loads while AppKit launches). It is an actor:
  the JavaScript context and virtual machine are created on, and only ever touched from, one dedicated thread with its own run loop
  (`JSThread`), which is also where JavaScriptCore runs its deferred work (a WebAssembly compile's continuation, GC timers), the
  shell's `native` callbacks, JavaScript timers (run-loop timers on that thread) and FSEvents (posted to it), and where the pending
  replies live. The main thread never waits on it: every call is a posted message, and every reply and event comes back as a
  `DispatchQueue.main.async` from that thread, so they reach the main thread in the order they were emitted (one FIFO), each tagged
  with its folder and board (`{dir, id}` in events; a `Session`'s callbacks carry its id). A window applies a change only while that
  board is the one it shows (`BoardWindowController.applyChange`), drops an `open` reply for a board it no longer waits for
  (`opening`), and the canvas drops routes for a board it no longer draws (`routeKey`). Drag begin / drag / end, undo, redo and the
  camera are asynchronous messages too: the canvas already shows the gesture's result, and the change that confirms it lands when it
  comes. `RouteWorker` has a `JSThread` of its own. Quitting waits (3 s at most) for the flush reply of every folder, then writes the
  cameras; a window closing lets its canvas go (`close()`: display link, timers, the router's model) and releases its folder, whose
  last release flushes and disposes the Storage on the JavaScript thread, before any later flush. The first scene of a board is
  quick: a Code card whose tree-sitter grammar is still loading (CUDA's compiles for ~130 ms) comes `pending`, shows its
  placeholder, and follows as a `changed` event when the grammar is there.
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

The camera is the world layer's transform. Each card is a `CardLayer` rasterised into an sRGB-tagged IOSurface (its shadow baked
in, `shadowPad` around) on a three-wide queue at a few zoom buckets, once the zoom has settled for `RASTER_SETTLE` (a card coming
near mid-gesture draws at the current zoom's bucket), landed a few per frame nearest the view's centre first, culled when far
from the viewport; Sections and arrows are shape layers rasterised by Core Animation at the bucket's scale (`shouldRasterize`),
the arrows from core's numeric paths. The world's layers are the board's, bottom up: Section frames, the arrows (under every
card), the cards, the Section titles, the stickers, and `top`, where an arrow rides while it is selected, dragged or on the
card under the pointer (`relayer`). An arrow's end sits on a code line as the card drew it: a drawn card hands routing its
rows (`WorldRect.rows`). A Section's frame is the board's: its stored rect grown around its cards as drawn (a Note's page
often lands taller than the scene's estimate) and its nested Sections, padded by core's `SECTION_PAD` (`reframeSections`). Colours and sizes come from `themes.json`, generated from the board's stylesheets at build time
(`themes.mjs`: tokens, and picked declarations such as Warm Ink's arrow colour or a Section's border).

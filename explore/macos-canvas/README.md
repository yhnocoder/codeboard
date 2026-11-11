# macOS canvas prototype

A throwaway, read-only feel test: can a native AppKit canvas pan and zoom real CodeBoard boards at 120 Hz with text that
is never blank and, ideally, never blurry? It reads board JSON directly (cards from `place`, code text, Note Markdown as
plain text, sections, links as straight lines) and draws them in Warm Ink light.

```sh
./make-app.sh                       # swift build -c release, wraps it into CanvasProto.app (double-click it)
.build/release/CanvasProto [board.json | vault]           # default vault: ~/Projects/persona/.codeboard
.build/release/CanvasProto --bench 3 [--modes 1,2,3]      # scripted pan / zoom on the 3 largest boards, then quit
```

Variants for comparison: `--ca` (mode 3 into the layer's CA backing store), `--async` (same with drawsAsynchronously),
`--cgimage` (modes 1–2 hand CGImages to CA instead of IOSurfaces).

Keys: `1` settle, `2` ahead, `3` live, `4` tiles, `5` levels (`x` rest bitmaps, `n` `m` cards swapped per frame, `j` `k` pixels swapped per frame, `h` `l` redraws, `g` outer ring), `c` live via own surface / CA backing store, `a` drawsAsynchronously,
`s` IOSurface / CGImage rasters, `f` fit, `←` `→` previous / next board, `⌘O` open a board, `b` bench this board.
Two-finger scroll pans, pinch or ⌘-scroll zooms around the pointer, up to 200 % (`z` toggles 300 %; `--max-zoom`);
a pinch past the limit stretches a little (rubber band) and springs back.

Notes drawn by the Markdown package (`w` toggles them against CoreText plain text; `--no-web` starts without): the page in
`web/` (`web/src/page.ts`, bundled by `web/build.mjs` from the repository's `node_modules` and the package's build) runs in
WKWebViews. A small pool of them (3; `CANVAS_WEBPOOL`), kept behind the opaque canvas because a web view only paints in a
visible window, renders a Note statically and snapshots it at the scale the canvas asks for (modes 1–2; a card always goes
to the same view, so a re-snapshot needs no re-render); the snapshot becomes the card's IOSurface, the old one staying
until then. Double-click a Note to edit it in the package's editor: one editor web view is kept loaded and warm above
the canvas, transparent; it gets the card's place, the Note at its 100 % layout scaled with a CSS transform to the
camera's zoom (so its line breaks are the snapshot's), the caret where you clicked, and shows only after it has painted
twice. Esc or a click outside leaves: the editor's last picture and the new static snapshot are compared, the snapshot
is shown, then the editor hides. Edits stay in memory; nothing is written to the board files. `CANVAS_EDITTEST=1` runs
the scripted edit experiment (modes 1–2); `CANVAS_MODE5TEST=1` the mode 5 checks (level memory at 25 / 50 / 100 /
200 %, gesture routing while editing, freeze and thaw diffs; `CANVAS_SKIPMEM`, `CANVAS_SKIPFREEZE`), `--bench 1 --modes 5`
its bench (each motion from a filled rest: pinch 50→100 %, zoom 100→200 %, 50→200 % in one gesture, 200→50 %, flick);
also (switch diffs at 100 / 137 / 200 %, warm and cold open, typing, pan and zoom while editing;
`CANVAS_EDITZOOM=pagezoom|magnify|scale` for the other ways of following the zoom; `CANVAS_DIFFDIR` saves the pairs).

Fast motion (`--no-shaping` to start without shaping):
- `v` speed shaping. With the fingers on the trackpad movement is 1:1 up to the knee (default 2500 pt/s, `[` `]`) and
  compressed softly above it (tanh towards 1.6× the knee); nothing is buffered, so no latency is added.
- Glide: the system's momentum scroll events are ignored. When the fingers lift, the canvas glides on its own from their
  (shaped) velocity as v0·exp(−t/τ), travelling v0·τ and stopping below 15 pt/s; a new touch stops it at once. `,` `.`
  divide / multiply τ by 1.25 (default 0.24 s). The HUD shows τ and the current speed; each glide logs its distance and
  duration, and `--glide-test` flicks at τ 0.15 / 0.3 / 0.6 s and quits.

Modes:

1. **settle**: one bitmap per card, scaled by Core Animation while moving, redrawn at the new scale after the gesture.
2. **ahead**: same layers; while the camera moves, visible cards below display resolution are redrawn off the main
   thread (at 1.3× the current zoom while zooming in) and swapped in when ready. The old bitmap stays until then.
4. **tiles**: like ahead, but each card is cut into 512 px tiles at a power-of-two scale and only tiles in the
   viewport plus a 25 % margin are drawn (viewport first) and kept; tiles beyond 75 % are dropped, cards out of view lose
   theirs after a gesture, and above 384 MB the tiles farthest from the view go. The fit-zoom card bitmap stays underneath
   as the fallback, and the previous level's tiles stay until the new level covers the card's visible part. Tiles overlap
   by one device pixel and are sized to whole pixels, so no seams show; frameless cards' tiles are filled with the board
   colour so coarser layers below don't show through the text.
5. **levels** (the default): while a pan or zoom gesture runs (the app's glide and the rubber band included) the GPU
   only moves and scales the bitmaps the cards already have: nothing is redrawn, snapshotted, laid out or swapped, and
   the canvas takes no other input. At rest (no gesture event for 150 ms and the glide finished) every card within 25 %
   of the view holds a bitmap at a fixed level, 50 %, 100 % or 200 %: the smallest level at or above min(2 × zoom, 200 %),
   so one zoom-in of up to 2x from rest stays at display resolution; cards within one more screen hold the smallest
   level at or above the zoom (so a pan or flick at the same zoom stays sharp); cards farther away fall back to their
   fit-zoom bitmap. The redraws are queued nearest the view's centre and the pointer first, run at most `h` / `l`
   (default 4) at a time, and are swapped onto the screen within a pixel budget per frame (`j` / `k`, default 8 M
   device pixels) and a card count per frame (`n` / `m`, default 4), whichever is reached first; a new gesture cancels the queue and drops late results. `g` turns the outer ring off. A card bitmap
   is capped at 24 M pixels here. Layers minify with trilinear filtering; Core Animation builds mipmaps for the
   IOSurface contents (checked with CARenderer), so small text does not shimmer while zooming out.
   Pictures are drawn into their card's bitmap (Image cards and the images in CoreText Notes; `ImageCache`: ImageIO
   decodes at a power-of-two width, SVG drawn by WebKit), so they follow the same levels, rings, budgets and rest
   bitmaps as text; the separate image layers of modes 1–4 are hidden in mode 5. The HUD and bench figure
   `lowres_during_motion` / `screen_lowres` counts anything on screen below display resolution, image layers included.
   Text look (for judging by eye): `e` "exact pixels" (rest bitmaps drawn at the zoom itself and shown 1:1, corners on
   whole device pixels; slightly crisper between levels, but a 1-pixel offset against the editor remains at zooms where
   a card's width is a fractional number of pixels); `;` `'` text weight for web Notes (-webkit-text-stroke in the Note
   page, 0–0.5 px; any stroke turns off WebKit's font smoothing, so 0.1 px is lighter than none and 0.2 px slightly
   heavier). A sharpening filter over the window was tried and dropped: Core Animation renders filtered content at 1x.
   Notes (`w`): web Notes are snapshots of the editor's own page (`renderEditor`: the editor mounted without focus,
   caret hidden, images decoded first), so display and edit share one code path; or CoreText. Images inside web Notes
   are part of the snapshot, so their native image layers are hidden. SVG files for the native image layers are drawn
   by a WebKit view, since NSImage's SVG renderer ignores the file's `<style>` and CSS variables.
   At rest, visible cards are shown from the smallest level at or above the zoom with linear filtering (`x` turns this
   off): a sublayer over the held bitmap when the two levels differ, removed by the next zoom (a pan keeps it). The
   live editor is drawn by WebKit at that same level (a whole scale: 50, 100 or 200 %) and its host view is scaled to
   the zoom by the GPU, and the camera is nudged by under half a device pixel so the edited Note sits on whole pixels:
   display and edit are then the same pixels (measured on screen by capturing the app's own window,
   `CANVAS_WEIGHTTEST=<dir>`, `CANVAS_AFTERZOOM=1` to enter edit at 100 % and zoom by gesture). Drawn by WebKit at an
   in-between scale instead (a CSS transform), the editor was crisper than the shrunk bitmap, 6–17 % of pixels apart.
   Only the editor's web view takes keyboard focus; the snapshot views never do (`CANVAS_CARETTEST=1` checks the
   selection across gestures).
   Editing: every scroll and pinch of the window goes to the canvas (an event monitor), also over the editor. At a
   gesture's start the editor is replaced, in the same transaction, by a bitmap of itself (kept current at rest after
   every change); at rest it comes back at the new place and scale (CSS transform, 100 % layout) once it has painted
   there, with caret and selection untouched; off screen it stays frozen and keeps its edit state.
3. **live**: every visible card drawn with CoreText at the exact scale every frame, into a screen-sized IOSurface on the
   main thread (or, with `c`, into the layer's own backing store).

Images (Image cards and `![](assets/…)` inside Notes; PNG, JPEG, WebP and GIF's first frame through ImageIO, SVG through
NSImage) are layers of their own above the cards (above mode 3's text too), decoded off the main thread at a power-of-two
width the zoom needs (ImageIO thumbnails), handed to CA as IOSurfaces. A layer keeps the level it shows until the next one
is ready; on a board's first open each image is a flat tint until its first decode, then never again. Mode 1 decodes
after the gesture, modes 2–3 while moving (1.3× ahead when zooming in). Animated GIFs show their first frame only.

Every card keeps a bitmap at the fit zoom, so nothing is ever blank; off-screen cards fall back to it after a gesture.
A card bitmap is capped at 16 M pixels (16384 px per side).

The HUD shows memory about twice a second: card pixels (fit bitmaps plus sharper bitmaps, tiles or screen surfaces),
decoded images, and the process footprint (`phys_footprint`, as Activity Monitor shows it).

Each gesture appends one line to `~/Library/Logs/CodeBoardCanvas.log`: display-link intervals (p50 / p95 / max),
dropped frames against the display refresh, main-thread busy time per frame (callback to run loop idle, CA commit
included), visible cards, and for modes 1–2 how long any visible card was below display resolution (`lowres_any`), the
share of visible card-time spent so (`lowres_cards`), the time from the end of motion until every visible card was sharp
again (`settle`; includes the 150 ms it takes to call a motion ended) and raster times; for mode 3 draw times. Images:
`img_lowres_any` / `img_lowres` as for cards, `img_blank` (time a visible image had nothing decoded yet), decode times, and
the memory decoded images (`img_mem`) and card bitmaps (`card_mem`) hold when the gesture settles. `presented_*` comes
from a 2 pt CAMetalLayer drawn with every moving frame and presented with the CA transaction: its drawables' presented
times show which frames reached the display, independent of the display link. `fallback_any` is the time some visible card showed only its fit-zoom bitmap where it needed more, `mixed_any` (mode 4)
the time a visible card showed two levels side by side, `peak_*` the highest memory during the gesture. The bench runs
pan, zoom in and out (2 s each), then a flick (5000 pt/s decelerating over 0.8 s) and a fast pinch in and out (0.4 s).
A board's first open logs when its visible
images and all images were first shown. While benching, the window floats on top: a covered window gets no display-link
callbacks and the bench would stall.

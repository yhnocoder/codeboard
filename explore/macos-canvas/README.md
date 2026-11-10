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

Keys: `1` settle, `2` ahead, `3` live, `4` tiles, `c` live via own surface / CA backing store, `a` drawsAsynchronously,
`s` IOSurface / CGImage rasters, `f` fit, `←` `→` previous / next board, `⌘O` open a board, `b` bench this board.
Two-finger scroll pans, pinch or ⌘-scroll zooms around the pointer.

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

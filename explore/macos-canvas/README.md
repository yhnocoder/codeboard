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

Keys: `1` settle, `2` ahead, `3` live, `c` live via own surface / CA backing store, `a` drawsAsynchronously,
`s` IOSurface / CGImage rasters, `f` fit, `←` `→` previous / next board, `⌘O` open a board, `b` bench this board.
Two-finger scroll pans, pinch or ⌘-scroll zooms around the pointer.

Modes:

1. **settle**: one bitmap per card, scaled by Core Animation while moving, redrawn at the new scale after the gesture.
2. **ahead**: same layers; while the camera moves, visible cards below display resolution are redrawn off the main
   thread (at 1.3× the current zoom while zooming in) and swapped in when ready. The old bitmap stays until then.
3. **live**: every visible card drawn with CoreText at the exact scale every frame, into a screen-sized IOSurface on the
   main thread (or, with `c`, into the layer's own backing store).

Every card keeps a bitmap at the fit zoom, so nothing is ever blank; off-screen cards fall back to it after a gesture.
A card bitmap is capped at 16 M pixels (16384 px per side).

Each gesture appends one line to `~/Library/Logs/CodeBoardCanvas.log`: display-link intervals (p50 / p95 / max),
dropped frames against the display refresh, main-thread busy time per frame (callback to run loop idle, CA commit
included), visible cards, and for modes 1–2 how long any visible card was below display resolution (`lowres_any`), the
share of visible card-time spent so (`lowres_cards`), the time from the end of motion until every visible card was sharp
again (`settle`; includes the 150 ms it takes to call a motion ended) and raster times; for mode 3 draw times.

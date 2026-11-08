# CodeBoard for macOS

The native app: an AppKit shell with a Core Animation canvas, `@codeboard/core` and the host's storage in JavaScriptCore
(`js/`, bundled by `build.mjs`). `npm run mac` builds `build/CodeBoard.app`; `npm run mac:run -- --open <folder>` builds and
opens a project. The launch arguments the scripted checks use are listed at the top of `Sources/CodeBoard/main.swift`.

## The acceptance gate

Every interaction has to hold the display's full rate (120 Hz on ProMotion: no frame later than its 8.33 ms period, p95 within
10 % of it, under 1 % late frames) with no flash, blank card, jump or vanish. `npm run mac:gate` checks that on the real window,
on the live display, over copies of real boards:

```bash
npm run mac:gate                                   # quick: the image-heavy board, the biggest and a 250-card one made from it
npm run mac:gate -- --all                          # every board in the folder, plus the 250-card one (about a minute a board)
npm run mac:gate -- --boards bmvstbxlqpve8 --steps pan,pinch_out,drag_card   # some boards, some steps
npm run mac:gate -- --data ~/other/.codeboard --app path/to/CodeBoard.app --no-build --out test-out/mac-gate/x
npm run mac:gate -- --no-xctrace                   # timings from the display link only (no Animation Hitches recording)
npm run mac:gate -- --max-load 2 --wait-quiet 10   # wait up to 10 min per board for the 1-minute load to fall under 2 (the default)
```

The data folder (default `~/Projects/persona/.codeboard`) is copied under the output folder first; the originals are never
opened. The app runs from a copy of the bundle named `cbgate.app` (so a `pkill CodeBoard` elsewhere on the Mac does not end a run;
signed with `tools/mac-gate.entitlements`, get-task-allow, so the instruments can attach), once per board with `--gate <dir>` (`Sources/CodeBoard/Gate.swift`): it brings its window to the front and
drives it with synthetic input handed to its own window only (`NSWindow.sendEvent`; nothing reaches another app, and a window over it takes nothing away), one input per display frame: a trackpad pan with scroll phases and a momentum
tail, a pinch from zoom 1 to 0.1 and back to 2 (every raster bucket; a pinch has no public event, so it calls what `magnify(with:)`
calls), ⌘-scroll zoom, a card dragged by its head, several linked cards dragged together, ⌘Z / ⌘⇧Z, a marquee over empty space,
double-click + typing + click-out on a Note and on a Free code card, N for a new card, ⌫ and its undo, ⌘K open and Escape, the
window resized a frame at a time, fullscreen in and out, dark and light, the board opened again, and idle. Steps the app has no
handler for pass through as no-ops and show as "(no effect)". Keys go through the window's and menu's key equivalents and the
first responder, as a typed key does (posting them at the HID level needs Accessibility for the exact binary, which changes with
every build). Keep your hands off the Mac during a run. The run starts only once this process is the frontmost one (other CodeBoards may be
running on the Mac), is reported as an error when another app stays in front, and every event is dropped (and the step failed)
when the process is not frontmost at that moment; the gate ends only the processes it started. Screen Recording must be allowed for the
terminal that starts it, or the run has timings only (`capture: off`).

Per frame the app records the display link's interval, the main thread's cost, the camera, the cards in view (world rects) and
the ones with no bitmap yet, and captures the window with ScreenCaptureKit at the display rate, 1 px per point, reduced to the
cell grid the web harness's probes judge plus a half-size JPEG. `tools/mac-gate.mjs` judges, with the same pure functions as the
web board's action probes (`packages/board/test/probes.ts`, see TESTING.md "动作探针"):

- timing: the Animation Hitches instrument records each run (`xctrace record --attach`, `hitches.trace` next to the run) and
  its hitches are assigned to steps by wall clock: the gate is under 1 % hitches of the step's frames and under 5 ms of hitch
  time per second. The display link's intervals (the main thread's pacing: p95, late > 1.5 × the period) and the capture's
  presented-frame intervals (SCK; it falls behind at 120 Hz on full-window change, so its late counts overstate) are reported
  beside them; without the instrument (`--no-xctrace`) the display link's intervals are the gate.
- `flash`: `flashHits` over the captured grids: a cell at rest that changes for 1–3 frames and reverts. Frames where the camera
  moved, the dragged / edited cards and their arrows (24 px around), the title bar and the zoom pill are masked.
- `jump`: `jumpHits` over the cards' world rects: a card that should stay still moved (0.5 px), a moving one made a step 3 ×
  longer than its neighbours; dragged cards are `free`.
- `blank`: a card in view with no bitmap in any frame after the first two.
- `no_effect`: the step's input changed nothing (no camera, card or window change): an input the app has no handler for, or
  one that did not arrive; never a silent pass. Inputs dropped because the app was not frontmost at that moment fail the step
  too.
- the Mac's 1-minute load average is waited out (under `--max-load`, up to `--wait-quiet` minutes) before each board and
  recorded; a run that started under load is marked so in the report.

The console shows a table per board; `report.json` and `report.md` in the output folder (`test-out/mac-gate/<time>/`) have every
number; a failing step's frames are under `<board>/fails/` (the rest of the capture is dropped unless `--keep-frames`). The
exit code is 1 when any gate fails. The gate measures with the capture running; `--no-capture` gives the timings alone.

Diagnosing a failure: open the run's `hitches.trace` in Instruments, or `xcrun xctrace export --input … --xpath
'/trace-toc/run[@number="1"]/data/table[@schema="hitches"]'`. For where the main thread's time goes, `xcrun xctrace record
--template 'Time Profiler' --attach <pid>` while the app runs one step (`--steps pinch_out`).

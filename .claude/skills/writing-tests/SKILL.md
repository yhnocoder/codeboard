---
name: writing-tests
description: How to write and fix CodeBoard tests that never flake - harness scenarios, VS Code e2e scripts, host/core unit tests. Use when adding or changing a test, fixing a flaky or failing test, or reviewing test code.
---

# Writing tests that don't flake

Read TESTING.md first: it defines the tiers, the time budgets and the commands. This skill covers *how* to write a test so that it passes or fails for one reason only, which is whether the product works.

Every flake found so far had the same cause. The test waited a fixed time and hoped the board, the editor or the host had caught up. On a busy machine (CI, parallel workers) sometimes it hadn't. The test then read stale state, clicked the wrong thing, or split a paragraph at the old caret. So the core rule is simple: **wait for the state you need, never for time.**

## Where a test goes

Put each test at the lowest level that can see the behavior:

| What you test | Where | Notes |
|---|---|---|
| Data model, migration, edit ops | `packages/core/test/*.test.ts` (vitest) | pure, fast |
| Markdown parse/serialize, editor schema | `packages/markdown/test/` | round trips: load → save → load |
| Host logic (files, versions, boards) | `packages/host/test/<feature>.test.ts` | runs on a nano-vllm copy and small git repos |
| Board UI behavior | a `test("name", …)` in `packages/board/test/scenarios/*.spec.ts` | Playwright, fake host |
| Real VS Code integration (commands, webview, clipboard, palette) | `extensions/vscode/test/*.cjs` | slowest, use only when the host or VS Code itself is the point |

Name a test by the behavior it checks (`copyPartialMarkBalanced`, `emptyCardDiscard`), never by a version. Scenario names are unique across all files and contain no spaces.

## The waiting rules

### Board harness scenarios

Import from `../fixtures`:

- `until(h, what, f, ms = 5000)` polls `f` until it returns something truthy and returns that value. On timeout it **throws** with `what` and the last value. Use it for the host's copy of the board (`h.board()`), messages the board sent (`h.sent`), counts, and anything Node-side.
- `idle(h)` waits until the board has settled. That means no message waiting on the host, the camera at rest, no finite animation running, fonts loaded, and no card moving for 3 frames. Use it after opening a board, after a camera move, after a host push (`h.post`), and before reading layout.
- Playwright's own waits (`locator.waitFor()`, `expect(locator).toHaveCount(n)`, `toBeVisible`) are for elements appearing or going away. Locator actions already wait for their element, so don't add a wait before `click()`.
- `shot(h, name)` waits for `idle` before the screenshot. Pass `"now"` only for a deliberate mid-animation picture.
- `frames(pg, n)` gives you n real rendered frames, for example one pointer move per frame in a drag.
- ProseMirror (Notes, Text, the Markdown editor):
  - `pmHasSelection(pg)` waits until ProseMirror has read the DOM selection. Call it after arrows, Home/End, or a scripted selection, before you copy, type or press Enter.
  - `focusSettled(pg)` waits out ProseMirror's 200 ms after-focus guard, which undoes a caret the browser moved right after focus. Call it after opening an editor and before Home / Ctrl+End / ⌘↑.

Typical replacements:

| Old sleep | Wait for instead |
|---|---|
| after a click or key, for a menu or panel | the element: `waitFor()` / `toHaveCount` |
| after an edit, for it to be saved | `until(h, "… is saved", () => h.board().…)` |
| after a camera move or fit | `idle(h)` |
| after `open()` / `subHost()` / `h.post(...)` | `idle(h)` or the element that should appear |
| after undo/redo | `until` on the board state you expect |
| before a screenshot | nothing: `shot()` already waits for idle |
| a hand-made `for … if (…) break; sleep` poll loop | `until` (the old loops passed silently on timeout) |
| after a host reply that closes a dialog | until the dialog is detached |

### VS Code e2e scripts

Use `extensions/vscode/test/wait.cjs` and `ui.cjs`. The helpers are `until(what, f, ms)` (throws), `soon(f, ok, ms)` (returns the last value so a `check` can judge it), `idle(frame)`, `hold(ms, why)`, `timing.X` (the board's constants, compiled from source) and `fromSource(path)`. Compare with product constants (`fromSource("packages/core/src/model.ts").BOARD_VERSION`), never with a literal copy.

### When a fixed wait is legitimate

There are only three cases:

1. You are checking that something does **not** happen before a product timer fires. For example, no camera patch reaches the host before `CAM_SETTLE + LIVE_DELAY`.
2. A gesture needs its real rhythm, for example two clicks more than `DBL_CLICK` apart so they are not a double-click, or pinch and drag steps.
3. A measurement needs it.

In these cases use `hold(h, ms, why)` (`hold(ms, why)` in e2e). Take `ms` from `packages/board/src/state/timing.ts` or `@yhnocoder/markdown/ui`. If the delay you need isn't there yet, move it there from the product code so the board and the test share one number. In `why`, say what must not happen meanwhile.

`packages/board/test/unit/scenario-waits.test.ts` enforces all this in `npm test`. It fails on `waitForTimeout`, setTimeout-based sleeps, local `wait`/`sleep` helpers, empty `.catch(() => {})` and a `hold` without a reason, in both the scenarios and the e2e scripts. Don't add allow-list entries to get past it. Fix the wait.

## No silent paths

A test must fail loudly when the product is wrong:

- **No `.catch(() => {})` on actions.** On a click it waits out the 30 s action timeout and then carries on as if the click had worked. It also hides that the element was never there.
- **No fallbacks inside a test.** "If Ctrl+V didn't paste, use the context menu" means a real ⌘V regression passes. If a path really can't be driven in this environment, test the other path as its own named check, and write in a comment why the first isn't covered and where it is.
- **No waits that pass on timeout.** `until` throws. If you want a `check` to report the value instead, use `soon` (e2e) or catch around `until` and feed the value to `check`, so the check still fails.
- **No `process.exit` in a scenario.** Fail through `check` / `verdict` / `expect` so the runner reports which test failed.
- **Prove the test can fail.** Break the behavior on purpose, for example comment out the fix or flip a condition, run the test, see it fail with a clear message, then revert. Do this for every new test and every bug fix.

## Timing checks

A check that measures time, such as `p90 < 8 ms` or a tab switch under 40 ms, fails under parallel load even when the product is fine. Put it in its own scenario and list that scenario in `tiers.json` → `solo`, so it runs alone like perf. Keep the functional checks in a normal scenario.

The perf gate in CI fails only when a board timing regresses **and** is over the 16.7 ms frame budget (60 fps). A ratio on a few-ms metric is noise. Don't tighten thresholds to catch it.

## Shared state between tests

- Parallel workers and `--repeat-each` run the same test at the same time. Give each worker its own output files and store directories (the `shared` scenarios use one store directory per worker). Otherwise repeats overwrite each other's files.
- Don't push to a page after its test closed it. `subhost.ts` skips pushes to closed pages, because a late push used to fail the *next* test in that worker.
- Host and core unit tests that sleep in real time against a debounce are slow and timing-dependent. Prefer fake timers or a drain hook.

## Checking a test for flakiness

Before you call a new or changed test done, run it repeatedly in parallel and alone:

```bash
npx playwright test -c packages/board <file> -g <name> --repeat-each=10 --workers=4
npx playwright test -c packages/board <file> -g <name> --repeat-each=10 --workers=1
```

It must pass every time in both. In this cloud environment you may need `CHROMIUM=/opt/pw-browsers/chromium-<rev>/chrome-linux64/chrome`.

- **"Passed only when run alone" is a flake, not a pass.** The harness reruns a failed scenario alone and marks it `alone`, and CI stays green. Treat it as a failure to fix.
- **A test that fails even with `--workers=1` is not a load problem**, so moving it to `solo` won't help. Look for a wait that starts too early.
- **The nightly reruns every scenario changed since the last nightly 3 times on 4 workers.** It reports flakes and alone-passes in their own sections of issue #19. Those go to the flaky-test thread.

## Fixing a flaky or failing test

1. Reproduce it. Use `--repeat-each` under load, plus `CPU_THROTTLE=4` for board scenarios if needed. Read the failure context in `test-out/harness/results/`.
2. Find what the test read or did too early: which state hadn't arrived yet.
3. Replace the early read with a wait for that state. If the state **never** arrives, you've found a product bug. Report it, or fix it at the root with its own test, rather than papering over it. Several real bugs were hiding behind sleeps: two boards created by Alt+B and Open Board at once, and a Note code-block edit that didn't end on click-away.
4. Never add retries, raise timeouts, skip a test, or add it to `known` / `solo` to make it green. `known` is only for failures tracked elsewhere, with a link.
5. Prove the fix the same way: the old version fails under repeat, the new version passes 10/10 at 4 workers and 10/10 at 1 worker.

## Scope

When you change "all the tests" of some kind, say exactly which files and suites are in scope and which are not. The harness scenarios and the e2e scripts are different suites, and the waits cleanup once covered one and silently skipped the other.

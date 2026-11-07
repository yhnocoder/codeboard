---
name: reliable-tests
description: Make CodeBoard tests reliable - write new tests and audit or fix existing ones (harness scenarios, VS Code e2e, unit tests) so they fail only when the product is wrong. Use when adding or changing a test, hunting or fixing flaky tests, reviewing test code, or checking whether a suite really catches bugs.
---

# Reliable tests: writing them and finding what's wrong with existing ones

TESTING.md defines the tiers, time budgets and commands; read it first. This skill is about the test code itself. A test should fail for exactly one reason: the product is wrong.

Writing a test and auditing an existing one come down to the same thing. The patterns below are what made tests flaky or blind in this repo. When **writing**, don't produce them. When **auditing**, look for them, prove each hit, and fix it at the root.

## The patterns

### 1. Waiting for time instead of state
The test sleeps (`waitForTimeout(300)`, `sleep(800)`, a local `wait(h)`, `setTimeout` in a promise) and assumes the board, editor or host has caught up. On a busy machine it hasn't, so the test reads stale state or acts on the old selection. The result is a flake that passes alone and fails in parallel, or fails even alone if the sleep is short. Long sleeps are just as wrong: they waste minutes and still guess.
- **Spot it:** grep for `waitForTimeout`, `sleep(`, `wait(`, `new Promise(r => setTimeout`, and numbers like 80 / 300 / 450 / 600 / 800 / 1500 next to a wait.
- **Instead:** wait for the state (see "Waiting helpers").

### 2. Reading before the event has landed
Even without a sleep, the test reads something right after a trigger, before the product has finished reacting. Examples: counting a dialog right after the file write, when the host's reply closes the dialog only later; reading the saved board before the host received it; pressing Enter right after Ctrl+End before ProseMirror has read the new caret.
- **Spot it:** for each read or assertion, find the code that produces the value: the fake host's handler (`on:` in the scenario, `harness.ts`, `subhost.ts`), the store, or the editor. Check whether the value the test waits on is set *before* the thing it then reads. A handler that records a file and only afterwards awaits `reply()` is a race. So is a counter bumped before the UI updates. Ask whether the test waited for the producer itself, or for something that happens earlier.
- **Instead:** wait for the producer's effect: the element detached, the host's copy changed, the editor's own selection matching.

### 3. Silent paths: the test can't fail where it should
- `.catch(() => {})` on an action. On a click it waits out the 30 s action timeout, then carries on as if it had clicked. It also hides an element that was never there.
- A fallback inside the test: "if Ctrl+V didn't paste, use the context menu". A real ⌘V regression then passes.
- A poll that ends on timeout without failing: `for (…) { if (ok) break; await sleep(…) }` followed by reading the value anyway.
- A check that passes vacuously: "no empty-paragraph junk" stays true when the edit never happened at all. Likewise "at most 2 requests at once" holds when no request was made, and "the overview is hidden after double-click" holds when it never showed.
- A test with no assertion at all: no `check`, `verdict` or `expect`, only screenshots and logs. It fails only on a throw. That matters most when it sits in the `smoke` list, which is supposed to guard a main feature.
- Errors that are only logged: a `pageerror` or console error printed but not failing the test, so an uncaught exception in the board goes unnoticed. Network errors from the offline sandbox (`ERR_NAME_NOT_RESOLVED`, `ERR_TUNNEL_CONNECTION_FAILED`) are expected; exempt them by name, not by ignoring all errors.
- Matching a menu or palette row by substring ("Edit" also hits "Edit Description"), or pressing Enter on whatever row is first when the wanted one isn't listed.
- `process.exit(1)` or `process.exitCode` in a scenario. The runner then reports "worker exited" instead of which check failed.
- **Spot it:** grep for:
  - `.catch(() =>`, `catch {}`, `process.exit`, `if (!(await`;
  - hand-made `for (let i = 0; i <` loops;
  - `hasText: "…"` with a plain string on menu or palette rows (an anchored regex like `/^Edit$/` is fine);
  - scenarios whose body has no `check(`, `verdict(` or `expect(`.
- **Instead:** let the action throw. Test an alternative path as its own named check, with a comment saying why the first path isn't covered here. Use `until`, which throws. Make sure a check's precondition actually happened.

### 4. Timing assertions in scenarios that run in parallel
Checks like `p90 < 8 ms` or "tab switch < 40 ms" in a scenario that shares the CPU with other workers fail whenever the machine is busy.
- **Instead:** move the timing check to its own scenario and list it in `tiers.json` → `solo`; keep the functional checks where they were. The perf gate in CI fails only when a board timing regresses **and** is over 16.7 ms (60 fps). A ratio on a few-ms metric is noise, so don't tighten it.

### 5. Shared state between tests
- Parallel workers and `--repeat-each` run the same test at the same time. Shared output files or store directories make repeats overwrite each other; give each worker its own. **Spot it:** look for fixed paths a test writes to and reads back, such as `path.join(OUT, "export-…")`, a store or `cards/` directory, or a temp folder without the worker index. Prove it with `--repeat-each=6 --workers=4` on that one test, which puts copies of it side by side.
- A late push or timer aimed at a page the test already closed can fail the *next* test in that worker. `subhost.ts` skips closed pages for this reason.
- Unit tests that sleep in real time against a debounce are slow and timing-dependent. Prefer fake timers or a drain hook.

### 6. Copies instead of the source of truth
A test that hard-codes a product value goes wrong silently when the product changes: a delay of `300`, `version === 6`, a copied constant. Import it instead: `packages/board/src/state/timing.ts`, `@yhnocoder/markdown/ui`, `BOARD_VERSION` from `packages/core/src/model.ts` (in e2e: `fromSource(...)`, `timing.X`).

### 7. A wait hiding a product bug
Sometimes the awaited state never arrives, and the sleep or swallowed timeout was hiding that. These were found this way:
- Alt+B and Open Board pressed together created two boards.
- Clicking another card didn't end a Note code-block edit.
- Old-editor compat code was rewriting escaped `$`.

When a state never arrives, don't wait longer. Report the bug, or fix it at the root with its own test.
- **Spot it:** these hide behind pattern 3. A loop that "tries again" (re-select up to 10 times, click up to 6 times, reopen the file 5 times), a wait wrapped in `.catch`, or a poll that gives up quietly. To find out what such a wait was hiding, make it strict for one run: let the `.catch` throw and let the poll fail. Then run the scenario. If it times out even alone, the state never arrives, and the comment that explains the retry ("ProseMirror sometimes…", "occasionally…") is describing the bug. If the strict version passes repeatedly (`--repeat-each=8 --workers=4`), the retry is dead code: remove it and keep the test strict.

### 8. Untested scope
"All tests" usually means one suite. Board harness scenarios, VS Code e2e scripts, release-shot and replay scripts, and host/core/markdown unit tests are separate, and a cleanup once covered one and silently skipped another. State which suites and files are in scope, and which are not.

## The tools named below

The helpers (`until`, `idle`, `hold`, `frames`, `pmHasSelection`, `focusSettled`, `wait.cjs`), the named delays in `packages/board/src/state/timing.ts` and the guard test `scenario-waits.test.ts` are the fixes for patterns 1–6. Check that they exist in the code you are working on. In an older checkout they won't: then the fix for those findings starts by adding them, as described here.

## Writing a test

**Where it goes:** at the lowest level that can see the behavior.

| What | Where |
|---|---|
| Data model, migration, edit ops | `packages/core/test/*.test.ts` (vitest) |
| Markdown parse/serialize, editor schema | `packages/markdown/test/` (round trips: load → save → load) |
| Host logic | `packages/host/test/<feature>.test.ts` |
| Board UI behavior | a `test("name", …)` in `packages/board/test/scenarios/*.spec.ts` |
| Real VS Code (commands, webview, clipboard, palette) | `extensions/vscode/test/*.cjs`, only when VS Code itself is the point |

Name tests by the behavior they check, never by a version. Scenario names are unique across files and contain no spaces.

### Waiting helpers
In board scenarios, import from `../fixtures`:
- `until(h, what, f, ms = 5000)` polls `f` until it is truthy and returns the value. It **throws** with `what` and the last value. Use it for `h.board()`, `h.sent`, counts, and anything on the Node side.
- `idle(h)` waits until no message is waiting on the host, the camera is at rest, no finite animation is running, fonts are loaded, and no card has moved for 3 frames. Use it after `open()`, camera moves, `h.post(...)`, and before reading layout.
- Use Playwright's own waits (`waitFor()`, `toHaveCount`, `toBeVisible`) for elements. Locator actions already wait for their element.
- `shot(h, name)` waits for idle itself. Pass `"now"` only for a deliberate mid-animation picture.
- `frames(pg, n)` waits for real rendered frames, for example one pointer move per frame.
- ProseMirror:
  - `pmHasSelection(pg)` waits after arrows, Home/End or a scripted selection, before you copy, type or press Enter.
  - `focusSettled(pg)` waits after opening an editor, before Home / Ctrl+End / ⌘↑. ProseMirror undoes caret moves made within 200 ms of focus.

In VS Code e2e, `extensions/vscode/test/wait.cjs` and `ui.cjs` provide:
- `until`, which throws.
- `soon`, which returns the last value so a `check` can judge it.
- `idle(frame)`, `hold(ms, why)`, `timing.X` and `fromSource(path)`.

### Fixed waits that are legitimate
A fixed wait is legitimate in only three cases:
- checking that something does **not** happen before a product timer fires;
- a gesture's real rhythm, such as two clicks more than `DBL_CLICK` apart;
- a measurement.

Use `hold(h, ms, why)` (in e2e, `hold(ms, why)`), with `ms` taken from the product's named constant. If the constant isn't exported yet, move it into `timing.ts` so the product and the test share it. `why` says what must not happen meanwhile.

The test `packages/board/test/unit/scenario-waits.test.ts` (in `npm test`) fails on any other sleep, an empty `.catch(() => {})`, or a `hold` without a reason, in both the scenarios and the e2e scripts. Don't add allow-list entries to get past it; fix the wait.

### Before a test is done
1. **Prove it can fail.** Break the behavior on purpose, for example by reverting the fix or flipping a condition. The test must fail with a clear message. Then revert.
2. **Prove it doesn't flake.** Run `--repeat-each=10` at `--workers=4` and at `--workers=1`; it must pass every time. Keep a scenario under about 20 s alone, as TESTING.md asks; split longer ones. In the cloud environment you may need `CHROMIUM=/opt/pw-browsers/chromium-<rev>/chrome-linux64/chrome`.

## Auditing existing tests

Do the steps in order and report findings before making big fixes.

1. **Evidence from runs** (skip this step and say so when you have no CI or issue access).
   - Read issue #19's nightly comments: the "Flakes" and "Passed only when run alone" sections.
   - Read the CI report section of recent PRs ("passed only when run alone: …").
   - Look at failed CI, nightly and replay jobs whose commit went green on a rerun.
   - "Passed only when run alone" is a hidden flake, even though CI stayed green.
2. **Static scan of every suite in scope.** Grep for the "Spot it" patterns above, then read each hit in context. A hit is only a lead. Decide whether it is pattern 1–7 or a legitimate wait.
   - A local helper with the same name as one here (a file's own `until`, `wait` or `settle`) may behave differently. Read it before trusting it: a local `until` that returns quietly on timeout is pattern 3.
   - When there are hundreds of hits, prove them in this order:
     1. the shared helpers (`harness.ts`, `fixtures.ts`, `subhost.ts`, the e2e helpers), since every test uses them;
     2. scenarios in the `smoke` list;
     3. scenarios with run evidence (failed, flaky, alone);
     4. the rest.
   - Count everything, but prove the top ones.
3. **Read the tests for patterns 2, 3, 5 and 7**, which grep can't find.
   - **Start with the shared helpers** (`harness.ts`, `fixtures.ts`, `subhost.ts`, the e2e helpers): one bad wait there affects every test.
   - **Then read each scenario**, including the fake host handlers it defines. For every assertion, ask:
     - What produces this value?
     - Is it set before or after the thing the test reads next?
     - Did the test wait for the producer?
     - Could this check pass if the action never happened?
     - Does the test assert anything at all?
   - **For every file or folder a test writes,** ask whether a second copy of the test running at the same time would use the same path.
   - **For every late callback** (a timer, a push, a reply), ask whether it can still fire after the test closed its page.
4. **Reproduce.** Run suspects with `npx playwright test -c packages/board <file> -g '<name>$' --repeat-each=10` at 4 workers and at 1 worker. Titles carry a prefix, so anchor only the end of the pattern: `-g '^name$'` matches nothing. For e2e, use `E2E_ONLY=…` repeated. Read the failure context in `test-out/harness/results/`.
   - A test that fails at 1 worker isn't a load problem, so `solo` won't help.
   - **General load (`CPU_THROTTLE=4`, more workers) often reproduces nothing**, because the race window is a few ms. Widen the one window you suspect instead:
     - delay the fake host's reply (`await new Promise(r => setTimeout(r, 300))` before `reply(...)` in that scenario's `on:` handler);
     - delay the product step that should land first;
     - put the read right after the trigger.
     If the test then fails, the race is real. Revert the delay afterwards; it is a probe, never a fix.
   - **For a swallowed wait (pattern 7),** make it strict for one run, as described there.
   - **For shared files (pattern 5),** run copies side by side: `--repeat-each=6 --workers=4 --timeout=60000`. The lower timeout stops a clash from stalling for minutes.
5. **Check that it can fail.** For an important test, break the behavior it claims to cover and see whether it fails. If it doesn't, it is blind (pattern 3). The quickest break is usually in the fake host (make the scenario's `on:` handler or `harness.ts` reply `{none: true}` or nothing), or in `packages/host/src` for host unit tests. Breaking board code needs `npm run build` before the harness sees it.
   - If you can't run or change the product, say for each finding whether it is proven by a run or only by reading the code. Rank the ones proven only by reading by how directly the code shows the failure.
6. **Classify each finding:**
   - a flake (root cause in the test);
   - a real product bug the test caught or hid;
   - infra (runner, network, mirror);
   - not a problem.

   Report each with `file:line`, evidence (run IDs, fail counts), root cause and the proposed fix.

## Fixing

1. Find the state the test read or acted on too early (pattern 1/2), or the path that couldn't fail (pattern 3).
2. Replace it with a wait for that state, or make the path fail loudly.
3. If the state never arrives, it's a product bug (pattern 7): fix or report it, don't wait longer.
4. Never add retries, raise timeouts, skip a test, or add it to `known` / `solo` to make it green. `known` is only for a failure tracked elsewhere. `solo` is only for scenarios that measure timing.
5. Prove the fix: the old version fails under repeat, the new one passes 10/10 at 4 workers and 10/10 at 1 worker, and breaking the product still makes it fail.

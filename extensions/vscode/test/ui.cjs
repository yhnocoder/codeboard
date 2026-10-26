// VS Code's own UI for the e2e scripts, driven over CDP: the quick input (command palette, Quick Open, input boxes), opening a file at a
// line, finding the board's webview frame. Every helper waits for what it needs and throws, naming it, when that never comes
const path = require("path");
const { until, hold } = require("./wait.cjs");

// The quick input (command palette, Quick Open, input boxes)
const qi = (page) => page.locator(".quick-input-widget");
const qiValue = (page) => page.locator(".quick-input-widget .quick-input-box input").inputValue();
const qiFocused = (page) => page.evaluate(() => !!document.activeElement?.closest(".quick-input-widget"));
const qiOpen = async (page) => await qi(page).isVisible() && await qiFocused(page);
/** Wait until the quick input is closed */
const qiClosed = (page, what = "the quick input") => qi(page).waitFor({ state: "hidden", timeout: 10000 }).catch(() => { throw new Error(`${what} did not close`); });
// With a board's webview focused, VS Code focuses the webview again whenever a quick input closes: the workbench posts "focus" to the
// webview, whose host page then calls focus() on the board's frame. That message can land after the next quick input has opened (F1's
// palette, or the input box a command opens about 60 ms after the palette closes), which takes the focus from the quick input and so
// closes it at once: whatever is typed next would go to the board. Nothing in the UI says the message is still on its way, so every
// quick input is checked to be still open and focused this long after it shows (VS Code's timing, not the board's: no product constant)
const QI_REFOCUS = 150;
const qiStays = async (page) => { await hold(QI_REFOCUS, "the webview does not take the focus back from the quick input"); return qiOpen(page); };

/** Type into an open quick pick, then accept the row whose label (before any ", <keybinding>") is `label` (default: the text typed), or
 *  else contains it: Enter when it is the focused row, a click when it is further down. Returns whether such a row showed up within ms
 *  (nothing is accepted then; the pick stays open for the caller) */
async function pick(page, text, ms = 5000, label = text) {
  await page.keyboard.type(text);
  const rows = page.locator(".quick-input-widget .monaco-list-row");
  const find = () => rows.evaluateAll((rs, t) => {
    const labels = rs.map((r) => (r.getAttribute("aria-label") ?? "").toLowerCase().split(", ")[0]);
    let i = labels.indexOf(t);
    if (i < 0) i = labels.findIndex((l) => l.includes(t));
    return [i, i >= 0 && rs[i].classList.contains("focused")];
  }, label.toLowerCase());
  // The list can still change under us (Quick Open fills in as files are found): find the row again if the click misses
  const done = await until(`a quick pick row for "${label}"`, async () => {
    const [at, focused] = await find();
    if (at >= 0 && focused) { await page.keyboard.press("Enter"); return true; }
    return at >= 0 && rows.nth(at).click({ timeout: 1000 }).then(() => true, () => false);
  }, ms).catch(() => false);
  if (!done) console.log(`  ! quick pick has no row for "${text}": ${JSON.stringify({ value: await qiValue(page).catch(() => "?"), rows: await rows.evaluateAll((rs) => rs.slice(0, 4).map((r) => r.getAttribute("aria-label"))).catch(() => []) })}`);
  return done;
}
/** F1, then wait until the command palette is open and has the keyboard (pressed again when the webview took the focus back, see above) */
async function openPalette(page) {
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("F1");
    await qi(page).waitFor({ state: "visible", timeout: 5000 }).catch(() => { throw new Error("F1 does not open the command palette"); });
    if (await qiStays(page)) return;
    console.log("  … command palette closed as it opened (focus went back to the webview), F1 again");
  }
  throw new Error("the command palette does not stay open");
}
/** Run a command from the palette; returns once the palette is gone, or, for a command that asks for input, once its input box
 *  (with `prompt` in its title or message) is up and stays, so nothing typed next goes to the closing palette or to the board */
async function command(page, text, prompt) {
  for (let i = 0; i < 5; i++) {
    await openPalette(page);
    // A command that is not in the palette is a broken step, not something to stand in for with the first row
    if (!(await pick(page, text, 3000))) { await page.keyboard.press("Escape"); await qiClosed(page); throw new Error(`no command "${text}" in the command palette`); }
    if (!prompt) return qiClosed(page, `the command palette (after "${text}")`);
    await inputBox(page, prompt, `the input box of "${text}"`);
    if (await qiStays(page)) return;
    console.log(`  … input box "${prompt}" closed as it opened (focus went back to the webview), running "${text}" again`);
  }
  throw new Error(`the input box "${prompt}" of "${text}" does not stay open`);
}
/** Wait for an input box or quick pick (not the palette) whose title, prompt or placeholder mentions text */
const inputBox = (page, text, what = `an input box "${text}"`) => until(what, async () => await qi(page).isVisible() && !(await qiValue(page)).startsWith(">") &&
  [...await page.locator(".quick-input-widget .quick-input-title, .quick-input-widget .quick-input-message").allInnerTexts(),
    await page.locator(".quick-input-widget .quick-input-box input").getAttribute("placeholder") ?? ""].some((t) => t.toLowerCase().includes(text.toLowerCase())), 10000);

/** Open a file (absolute path) in the first editor group with Quick Open, and put the cursor on `line`. An absolute path is opened as
 *  typed, so this does not depend on the workspace's files having been searched yet */
async function openFile(page, abs, line) {
  const name = path.basename(abs);
  const tab = page.locator(".editor-group-container .tab.active", { hasText: name });
  await command(page, "View: Focus First Editor Group"); // code in the left group, the board on the right (with the board focused, Ctrl+1 means 100% zoom)
  await page.keyboard.press("Control+p");
  await until("Quick Open has the keyboard", () => qiOpen(page), 5000);
  if (!(await pick(page, abs, 10000, name))) throw new Error(`Quick Open does not offer ${abs}`);
  await qiClosed(page, "Quick Open");
  await until(`${name} is the active editor`, () => tab.count(), 10000);
  if (line) await goToLine(page, line);
}
/** Ctrl+G in the active editor; returns once the cursor is there (the status bar says Ln <line>, Col <col>) */
async function goToLine(page, line, col) {
  await page.keyboard.press("Control+g");
  await until("Go to Line has the keyboard", () => qiOpen(page), 5000);
  await page.keyboard.type(col ? `${line}:${col}` : String(line)); await page.keyboard.press("Enter");
  await qiClosed(page, "Go to Line");
  await until(`the cursor is on line ${line}${col ? `, column ${col}` : ""}`, async () => new RegExp(`^Ln ${line}, Col ${col ?? "\\d+"}\\b`).test(await statusSel(page)), 5000);
}
/** The status bar's cursor position of the active editor ("Ln 5, Col 1 (300 selected)") */
const statusSel = async (page) => (await page.locator("#status\\.editor\\.selection").innerText()).trim();

/** A locator's text without waiting for it (empty when it is not there): Playwright's textContent() waits out its 30 s timeout */
const text = async (loc) => ((await loc.count()) ? await loc.first().textContent() : "") ?? "";
/** The keyboard is in an editable element (a text field, an editor) inside frame f, optionally inside `within` */
const typingIn = (f, within = "") => f.evaluate((w) => { const a = document.activeElement; return !!a && (!w || !!a.closest(w)) && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName)); }, within);

/** ProseMirror (a Note's or Text card's editor) in frame f has read the DOM selection: Shift+arrows move the selection in the browser,
 *  and ProseMirror only learns of it in the async selectionchange, so a key pressed right after (⌘B) acts on the selection it had
 *  before. Same as pmHasSelection in packages/board/test/fixtures.ts */
const pmHasSelection = (f) => until("ProseMirror has read the DOM selection", () => f.evaluate(() => {
  const root = document.querySelector(".md-pm");
  if (!root?.editor || document.activeElement !== root) return true;
  const v = root.editor.view;
  return v.domObserver.currentSelection.eq(v.domSelectionRange());
}), 5000);

/** prosemirror-view's guard after the editor gets focus (DOMObserver.flush: input.lastFocus > Date.now() - 200) */
const PM_FOCUS_GUARD = 200;
/** ProseMirror's first moments after it gets focus: 20 ms after focus it puts its own selection back into the DOM, and for
 *  PM_FOCUS_GUARD ms it takes a caret moved by the browser for the browser resetting the selection. So Ctrl+End right after a
 *  double click into a Note is undone, and what is typed next lands at the double-clicked word. There is no state to wait for, only
 *  ProseMirror's timers: hold until the focus is that old, then let one page task run (timers run in the order they fall due, so
 *  ProseMirror's 20 ms one has run by then). Same as focusSettled in packages/board/test/fixtures.ts */
async function focusSettled(f) {
  const left = await f.evaluate((guard) => {
    const v = document.querySelector(".md-pm")?.editor?.view;
    return v ? Math.max(0, v.input.lastFocus + guard + 1 - Date.now()) : -1;
  }, PM_FOCUS_GUARD);
  if (left < 0) return;
  await hold(left, "ProseMirror's focus timers: a caret the browser moves within PM_FOCUS_GUARD ms of the focus is undone");
  await f.evaluate(() => new Promise((r) => setTimeout(r, 0)));
}

/** The frames that show a board (#board); boards in background tabs keep their webview, and VS Code hides those */
async function boardFrames(page, { visible = true } = {}) {
  const shown = async (f) => { for (let x = f; x.parentFrame(); x = x.parentFrame()) if (!await (await x.frameElement()).isVisible()) return false; return true; };
  const out = [];
  for (const f of page.frames()) { try { if (await f.$("#board") && (!visible || await shown(f))) out.push(f); } catch { /* frame going away */ } }
  return out;
}
/** The board on screen (or, with not, one that is not among those frames: a board that just opened) */
const boardFrame = (page, { not = [], ms = 30000 } = {}) => until(not.length ? "a new board webview" : "the board webview", async () => (await boardFrames(page)).find((f) => !not.includes(f)), ms, 100);

const card = (f, title) => f.locator(".card", { has: f.locator(".chead .ctitle", { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });

/** Click the board's own Fit to Window button (not the shortcut: the keyboard may be in the code editor). A VS Code notification toast
 *  (e.g. from Pylance) can sit over it in the bottom-right corner: clear the notifications then */
async function fit(f) {
  const btn = f.locator('button[aria-label="Fit to Window"]').first(), page = f.page();
  const free = await btn.click({ trial: true, timeout: 3000 }).then(() => true, () => false); // the checks of a click, without clicking
  if (!free && await page.locator(".notifications-toasts .notification-toast").count()) await command(page, "Notifications: Clear All Notifications");
  await btn.click({ timeout: 5000 }); // when something else covers it, this fails and says what
}

module.exports = { qi, qiValue, qiOpen, qiClosed, pick, command, inputBox, openFile, goToLine, statusSel, text, typingIn, pmHasSelection, focusSettled, boardFrame, boardFrames, card, fit };

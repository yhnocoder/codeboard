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
// VS Code hands the keyboard back to a board's webview when a quick input it took it from closes (VS Code 1.143, webviewElement.ts and
// webview/browser/pre/index.html): WebviewElement._doFocus focuses the webview's iframe and starts _focusDelayer (50 ms), whose task
// posts "focus" to the webview unless the webview has lost the focus by then; the webview's host page then focuses the board's frame
// whatever has the keyboard by then. A key pressed before that lands is lost, or opens a quick input that the landing "focus" closes
// within a frame or two (too fast for a visibility poll). When the delayer's task skips the post (VS Code no longer counts the
// webview as focused: a blur its host page reported while the quick input was up), nothing in the DOM changes and the keyboard stays
// on the host page's <body>: only the end of VS Code's own timer says that no "focus" is coming. So the recorder follows the timers that _doFocus starts (by their call stack) until they have
// run or been cancelled, the workbench numbers the "focus" messages it posts, by webview, and the host pages record the last one they
// handled (wait.cjs). A message posted to a webview that closed before handling it is not waited for.
// The recorder also logs the quick input showing, hiding, and losing the keyboard while it shows.
const QI_RECORDER = () => {
  if (!/\/workbench[^/]*\.html$/.test(location.pathname)) return 0; // also an init script, which runs in every frame
  if (window.__e2eQi) return window.__e2eQi.ev.length;
  const rec = window.__e2eQi = { ev: [], seq: 0, focus: new Map(), delayers: new Set() };
  const widget = () => document.querySelector(".quick-input-widget");
  const shown = (w) => !!w && getComputedStyle(w).display !== "none";
  let was = false;
  const observe = () => {
    was = shown(widget());
    new MutationObserver(() => { const v = shown(widget()); if (v !== was) { was = v; rec.ev.push(v ? "show" : "hide"); } })
      .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
  };
  if (document.body) observe(); else document.addEventListener("DOMContentLoaded", observe);
  // An accepted or cancelled quick input hides (or turns inert) before the keyboard moves on: losing it while shown means taken away
  window.addEventListener("focusout", (e) => {
    const w = widget();
    if (w && w.contains(e.target) && !(e.relatedTarget && w.contains(e.relatedTarget)) && shown(w) && !w.inert) rec.ev.push("lost");
  }, true);
  const setT = window.setTimeout, clearT = window.clearTimeout;
  window.setTimeout = function (fn, ...rest) {
    if (typeof fn !== "function" || !/\._doFocus\b/.test(new Error().stack)) return setT.call(this, fn, ...rest);
    const h = setT.call(this, function (...a) { rec.delayers.delete(h); return fn.apply(this, a); }, ...rest);
    rec.delayers.add(h);
    return h;
  };
  window.clearTimeout = function (h) { rec.delayers.delete(h); return clearT.call(this, h); };
  // A webview's host page hands the workbench its end of their MessagePort when it is ready; the port's iframe names the webview
  const ports = new WeakMap();
  window.addEventListener("message", (e) => {
    const f = e.ports?.[0] && [...document.querySelectorAll("iframe.webview")].find((x) => x.contentWindow === e.source);
    if (f) ports.set(e.ports[0], f);
  }, true);
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (m, ...rest) {
    const f = ports.get(this);
    if (f && m && m.channel === "focus") rec.focus.set(f, m.__e2eSeq = ++rec.seq);
    return post.call(this, m, ...rest);
  };
  return 0;
};
/** Start the recorder if it is not running (it watches only webviews opened after it started); returns how many events it holds, so a
 *  caller reads only the ones after */
const qiMark = (page) => page.evaluate(QI_RECORDER);
/** Record the window's keyboard hand-backs from now on and after every reload (call before the first board's webview exists) */
async function watchKeyboard(page) {
  await page.addInitScript(QI_RECORDER);
  await qiMark(page);
}
const qiSince = (page, mark) => page.evaluate((m) => window.__e2eQi.ev.slice(m), mark);
/** What a keyboard hand-back to a webview still waits for, or null when none is under way */
async function handBack(page) {
  const wb = await page.evaluate(() => ({
    delayers: window.__e2eQi?.delayers.size ?? 0,
    posted: [...(window.__e2eQi?.focus ?? [])].filter(([f]) => f.isConnected).map(([f, seq]) => ({ id: f.name, seq })),
  }));
  if (wb.delayers) return "VS Code has focused a webview's iframe and its _focusDelayer has not yet decided whether to post it \"focus\"";
  const handled = new Map();
  for (const f of page.frames()) {
    if (!/^vscode-webview:.*\/index\.html/.test(f.url())) continue;
    const seq = await f.evaluate(() => window.__e2eFocusSeq ?? 0).catch(() => null);
    if (seq !== null) handled.set(new URL(f.url()).searchParams.get("id"), seq);
  }
  for (const { id, seq } of wb.posted) {
    const h = handled.get(id) ?? 0;
    if (h < seq) return `"focus" #${seq} posted to webview ${id}, #${h} handled there`;
  }
  return null;
}
/** Wait until no keyboard hand-back to a webview is under way, so that a key pressed next lands where the keyboard stays */
async function keyboardSettled(page) {
  await qiMark(page);
  let why = null;
  await until("no keyboard hand-back to a webview under way", async () => !(why = await handBack(page)), 10000)
    .catch((e) => { throw new Error(`${e.message}: ${why}`); });
}
/** Press key to open a quick input (what); returns once it shows and keeps the keyboard, no hand-back left to take it */
async function openQuick(page, key, what) {
  await keyboardSettled(page);
  const mark = await qiMark(page);
  await page.keyboard.press(key);
  await until(`${key} opens ${what}`, async () => (await qiSince(page, mark)).includes("show"), 5000)
    .catch(async (e) => { throw new Error(`${key} does not open ${what} (${e.message}; ${await handBack(page) ?? "no hand-back under way"})`); });
  await keyboardSettled(page);
  if (!(await qiOpen(page))) throw new Error(`${what} did not keep the keyboard: ${(await qiSince(page, mark)).join(", ")}`);
}

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
/** F1, then wait until the command palette is open and keeps the keyboard */
const openPalette = (page) => openQuick(page, "F1", "the command palette");
/** Run a command from the palette; returns once the palette is gone and the keyboard has settled, or, for a command that asks for
 *  input, once its input box (with `prompt` in its title or message) is up and keeps the keyboard; losing it is a failure, not a retry */
async function command(page, text, prompt) {
  await openPalette(page);
  const mark = await qiMark(page);
  // A command that is not in the palette is a broken step, not something to stand in for with the first row
  if (!(await pick(page, text, 3000))) { await page.keyboard.press("Escape"); await qiClosed(page); throw new Error(`no command "${text}" in the command palette`); }
  if (!prompt) { await qiClosed(page, `the command palette (after "${text}")`); return keyboardSettled(page); }
  await until(`the input box of "${text}"`, async () => (await qiSince(page, mark)).includes("lost") || await inputBoxShows(page, prompt), 10000);
  await keyboardSettled(page);
  if ((await qiSince(page, mark)).includes("lost") || !(await qiOpen(page))) throw new Error(`the input box "${prompt}" of "${text}" lost the keyboard: ${(await qiSince(page, mark)).join(", ")}`);
}
/** CodeBoard asks on the board a command runs on (packages/host/src/prompts.ts): wait until its dialog (title) is up on board f and its
 *  field has the keyboard, with no hand-back to a webview left to move it, and the text in it all selected (what is typed replaces it) */
async function boardDialog(page, f, title) {
  const has = () => f.evaluate((t) => {
    const d = document.querySelector(".dialog");
    return !!d && d.querySelector(".dt")?.textContent === t && document.hasFocus() && !!document.activeElement?.closest(".dialog");
  }, title);
  await until(`the board's "${title}" dialog has the keyboard`, has, 10000);
  await keyboardSettled(page);
  if (!(await has())) throw new Error(`the board's "${title}" dialog lost the keyboard`);
  const sel = await f.evaluate(() => { const a = document.activeElement; return a instanceof HTMLInputElement ? [a.selectionStart, a.selectionEnd, a.value.length] : null; });
  if (sel && (sel[0] !== 0 || sel[1] !== sel[2])) throw new Error(`the board's "${title}" dialog does not have its text selected: ${JSON.stringify(sel)}`);
}
const boardDialogClosed = (f, what) => f.locator(".dialog").waitFor({ state: "detached", timeout: 10000 }).catch(() => { throw new Error(`${what} did not close`); });
/** Wait for an input box or quick pick (not the palette) whose title, prompt or placeholder mentions text */
const inputBoxShows = async (page, text) => await qi(page).isVisible() && !(await qiValue(page)).startsWith(">") &&
  [...await page.locator(".quick-input-widget .quick-input-title, .quick-input-widget .quick-input-message").allInnerTexts(),
    await page.locator(".quick-input-widget .quick-input-box input").getAttribute("placeholder") ?? ""].some((t) => t.toLowerCase().includes(text.toLowerCase()));
const inputBox = (page, text, what = `an input box "${text}"`) => until(what, () => inputBoxShows(page, text), 10000);

/** Open a file (absolute path) in the first editor group with Quick Open, and put the cursor on `line`. An absolute path is opened as
 *  typed, so this does not depend on the workspace's files having been searched yet */
async function openFile(page, abs, line) {
  const name = path.basename(abs);
  const tab = page.locator(".editor-group-container .tab.active", { hasText: name });
  await command(page, "View: Focus First Editor Group"); // code in the left group, the board on the right (with the board focused, Ctrl+1 means 100% zoom)
  await openQuick(page, "Control+p", "Quick Open");
  if (!(await pick(page, abs, 10000, name))) throw new Error(`Quick Open does not offer ${abs}`);
  await qiClosed(page, "Quick Open");
  await until(`${name} is the active editor`, () => tab.count(), 10000);
  if (line) await goToLine(page, line);
}
/** Ctrl+G in the active editor; returns once the cursor is there (the status bar says Ln <line>, Col <col>) */
async function goToLine(page, line, col) {
  await openQuick(page, "Control+g", "Go to Line");
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

/** The board in frame f has the keyboard: the keys pressed next reach it. Its shortcuts that VS Code sends back need boardKeys too */
const boardHasKeyboard = (f) => f.evaluate(() => document.hasFocus());
/** VS Code's status bar while it waits for the second key of a chord ("(Ctrl+K) was pressed. Waiting for second key of chord...") */
const inChord = (page) => page.locator(".part.statusbar", { hasText: /was pressed\. Waiting for (second|next) key of chord/ }).count();
/** Who gets the board's shortcuts (Ctrl+K, Ctrl+, …: VS Code keybindings while its key context codeboard.boardFocused is on, which
 *  VS Code sends back to the board on screen): press Ctrl+K and see. "board": the board in frame f opened its search (closed again
 *  with Escape when the board has the keyboard); "vscode": VS Code began its own Ctrl+K chord (Escape ends it) */
async function ctrlK(page, f) {
  await page.keyboard.press("Control+k");
  const who = await until("Ctrl+K opens the board's search or begins VS Code's chord", async () =>
    (await f.locator(".palette").count()) ? "board" : (await inChord(page)) ? "vscode" : null, 5000);
  if (who === "vscode") {
    await page.keyboard.press("Escape");
    await until("Escape ends VS Code's Ctrl+K chord", async () => !(await inChord(page)), 5000);
  } else if (await boardHasKeyboard(f)) {
    await until("the board's search has the keyboard", () => typingIn(f, ".palette"), 5000);
    await page.keyboard.press("Escape");
    await f.locator(".palette").waitFor({ state: "detached", timeout: 5000 });
  }
  return who;
}
/** Wait until VS Code sends the board's shortcuts back to the board in frame f, which has the keyboard: the host turns the key
 *  context on once the board reports getting the keyboard, so right after a click a shortcut can still be VS Code's own */
const boardKeys = (page, f) => until("VS Code sends the board's shortcuts to the board", async () => await boardHasKeyboard(f) && await ctrlK(page, f) === "board", 10000);

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

module.exports = { qi, qiValue, qiOpen, qiMark, watchKeyboard, keyboardSettled, boardHasKeyboard, boardKeys, ctrlK, boardDialog, boardDialogClosed, qiClosed, pick, command, inputBox, openFile, goToLine, statusSel, text, typingIn, pmHasSelection, focusSettled, boardFrame, boardFrames, card, fit };

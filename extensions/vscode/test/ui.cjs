// VS Code's own UI for the e2e scripts, driven over CDP: the quick input (command palette, Quick Open, input boxes), opening a file at a
// line, finding the board's webview frame. Every helper waits for what it needs and throws, naming it, when that never comes
const path = require("path");
const { until, hold } = require("./wait.cjs");

// The quick input (command palette, Quick Open, input boxes)
const qi = (page) => page.locator(".quick-input-widget");
const qiValue = (page) => page.locator(".quick-input-widget .quick-input-box input").inputValue();
const qiFocused = (page) => page.evaluate(() => !!document.activeElement?.closest(".quick-input-widget"));
const qiOpen = async (page) => await qi(page).isVisible() && await qiFocused(page);
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
// A webview that is still loading (a board panel just opened) has no MessagePort yet: WebviewElement keeps the delayer's "focus" with
// its pending messages and posts it once the webview reports ready, which can be after the delayer ran and a quick input has opened.
// The host page then takes the keyboard, and gives it to the board's frame when that frame's content has loaded. So a webview still
// loading when a delayer ran counts as a hand-back until it is ready (the queued "focus" is then numbered like any other), and so does a
// host page that is still loading its frame.
// The recorder also logs the quick input showing, hiding, and losing the keyboard while it shows (and to what), and counts the webview
// focuses that come from opening an editor (boardOpening).
const QI_RECORDER = () => {
  if (!/\/workbench[^/]*\.html$/.test(location.pathname)) return 0; // also an init script, which runs in every frame
  if (window.__e2eQi) return window.__e2eQi.ev.length;
  const rec = window.__e2eQi = { ev: [], seq: 0, focus: new Map(), delayers: new Set(), loading: new Set(), opened: 0, lostTo: "" };
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
    if (w && w.contains(e.target) && !(e.relatedTarget && w.contains(e.relatedTarget)) && shown(w) && !w.inert) {
      rec.ev.push("lost");
      // a frame's content taking the keyboard leaves relatedTarget null: the window's active element is then its iframe
      queueMicrotask(() => { const a = e.relatedTarget ?? document.activeElement; rec.lostTo = a?.matches?.("iframe.webview") ? `webview ${a.name}` : `${a?.tagName}.${a?.className}`; });
    }
  }, true);
  const setT = window.setTimeout, clearT = window.clearTimeout;
  window.setTimeout = function (fn, ...rest) {
    const stack = typeof fn === "function" ? new Error().stack : "";
    if (!/\._doFocus\b/.test(stack)) return setT.call(this, fn, ...rest);
    if (/\.doOpenEditor\b/.test(stack)) rec.opened++;
    const h = setT.call(this, function (...a) {
      rec.delayers.delete(h);
      for (const f of document.querySelectorAll("iframe.webview:not(.ready)")) rec.loading.add(f);
      return fn.apply(this, a);
    }, ...rest);
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
    loading: [...(window.__e2eQi?.loading ?? [])].filter((f) => f.isConnected && !f.classList.contains("ready")).map((f) => f.name),
    posted: [...(window.__e2eQi?.focus ?? [])].filter(([f]) => f.isConnected).map(([f, seq]) => ({ id: f.name, seq })),
  }));
  if (wb.delayers) return "VS Code has focused a webview's iframe and its _focusDelayer has not yet decided whether to post it \"focus\"";
  if (wb.loading.length) return `VS Code's _focusDelayer ran while webview ${wb.loading[0]} was loading: the "focus" it queued is posted once that webview is ready`;
  const handled = new Map();
  for (const f of page.frames()) {
    if (!/^vscode-webview:.*\/index\.html/.test(f.url())) continue;
    const id = new URL(f.url()).searchParams.get("id");
    const at = await f.evaluate(() => ({ seq: window.__e2eFocusSeq ?? 0, loading: !!document.getElementById("pending-frame") })).catch(() => null);
    if (!at) continue;
    // the host page gives the frame it is loading the keyboard when it lands, if the page has it by then
    if (at.loading) return `webview ${id} is still loading its content`;
    handled.set(id, at.seq);
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
  const at = await page.evaluate(() => window.__e2eQi.opened);
  await page.keyboard.press(key);
  await until(`${key} opens ${what}`, async () => (await qiSince(page, mark)).includes("show"), 5000)
    .catch(async (e) => { throw new Error(`${key} does not open ${what} (${e.message}; ${await handBack(page) ?? "no hand-back under way"})`); });
  await keyboardSettled(page);
  if (!(await qiOpen(page))) {
    const [lostTo, opened] = await page.evaluate((n) => [window.__e2eQi.lostTo, window.__e2eQi.opened - n], at);
    throw new Error(`${what} did not keep the keyboard: ${(await qiSince(page, mark)).join(", ")} (lost to ${lostTo || "?"}; ${opened} webview editor(s) opened and focused since ${key})`);
  }
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
/** VS Code shows a board some time after the command or tab click that asks for it: the extension's panel.reveal and
 *  createWebviewPanel reach the workbench through the extension host after the palette has closed, and a tab click opens its editor
 *  once the click is handled. The workbench then opens the board's editor and focuses its webview (editorService.openEditor without
 *  preserveFocus, even for a board already in front, and with the keyboard already on it). A quick input opened before that loses the
 *  keyboard to the board, which then gets the keys typed into it. Call this before the command or click: the function it returns waits
 *  until a webview editor has been opened and focused since (the recorder counts these focuses), and the keyboard hand-back has landed */
async function boardOpening(page, what) {
  await qiMark(page);
  const at = await page.evaluate(() => window.__e2eQi.opened);
  return async () => {
    await until(what, () => page.evaluate((n) => window.__e2eQi.opened > n, at), 10000);
    await keyboardSettled(page);
  };
}
/** Run a command that shows a board ("CodeBoard: Open Board" and the like); returns once the board is in front with the keyboard */
async function openBoard(page, text = "CodeBoard: Open Board") {
  const opened = await boardOpening(page, `"${text}" opens a board's editor and focuses it`);
  await command(page, text);
  await opened();
}
/** Click a board's editor tab (a locator); returns once VS Code has opened its editor and the keyboard is on the board */
async function clickBoardTab(page, tab) {
  const opened = await boardOpening(page, "clicking the board's tab opens its editor and focuses it");
  await tab.click();
  await opened();
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

/** The board in frame f has the keyboard: the keys pressed next reach it. That is when its frame has the keyboard, or its webview's
 *  host page has it (VS Code left it there; the board takes a key that lands there, packages/board/src/focus.ts). Its shortcuts that
 *  VS Code sends back need boardKeys too */
const boardHasKeyboard = (f) => f.evaluate(() => (window.frameElement?.ownerDocument ?? document).hasFocus());
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

/** VS Code's box around each webview (.webview-overlay-content, overflow hidden) has a few px of room to scroll: its <iframe> sits on a
 *  line box. VS Code never scrolls it, but a scroll into view from inside the webview does, and the board then moves under the pointer:
 *  a press that lands before the window has drawn the moved webview fails Chromium's check that the webview's answer for where the
 *  point is matches the frame it drew last, and goes to the workbench, onto the <iframe> element. The scrollTop of each such box */
const webviewBoxes = (page) => page.evaluate(() => [...document.querySelectorAll(".webview-overlay-content")].map((b) => b.scrollTop));

/** Before a pointer action Playwright scrolls the element into view, and on each retry (the element moving, a VS Code toast over it) it
 *  scrolls with scrollIntoView({ block: "end" | "center" | "start" }), which also scrolls VS Code's box around the webview
 *  (webviewBoxes). Nothing on a board needs that box scrolled to be reached, so pointer actions on elements in a webview do not scroll
 *  (scroll: "none"; Playwright then clicks the element where it is, or fails saying it is outside the viewport). Applies to every
 *  locator of the process from the first call on */
function keepWebviewsStill(page) {
  const proto = Object.getPrototypeOf(page.locator("body"));
  if (proto.__e2eStill) return;
  proto.__e2eStill = true;
  const inWebview = (loc) => /^vscode-webview:/.test(loc._frame?.url?.() ?? "");
  // the methods with a scroll option; setChecked and dragTo take their options second
  for (const [name, at] of [["click", 0], ["dblclick", 0], ["hover", 0], ["tap", 0], ["check", 0], ["uncheck", 0], ["setChecked", 1], ["dragTo", 1]]) {
    const orig = proto[name];
    proto[name] = function (...args) {
      if (inWebview(this)) args[at] = { scroll: "none", ...args[at] };
      return orig.apply(this, args);
    };
  }
}

/** The frames that show a board (#board); boards in background tabs keep their webview, and VS Code hides those. Every board action
 *  starts from one of these frames, so this also keeps the webviews still for actions in them (keepWebviewsStill) */
async function boardFrames(page, { visible = true } = {}) {
  keepWebviewsStill(page);
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

module.exports = { qi, qiValue, qiOpen, qiMark, watchKeyboard, keyboardSettled, boardHasKeyboard, boardKeys, ctrlK, boardDialog, boardDialogClosed, qiClosed, pick, command, openBoard, clickBoardTab, inputBox, openFile, goToLine, statusSel, text, typingIn, pmHasSelection, focusSettled, boardFrame, boardFrames, card, fit, webviewBoxes };

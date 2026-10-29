// Release screenshots: build a small showcase board in a real VS Code and capture the feature shots, then one shot per board theme.
// Run through tools/release/shots.sh, which runs this once through test/run.sh at 2x (VS Code light) and composes the theme pictures
//   SHOTS=features  1-overview, 2-peek, 3-new-version, 4-notes
//   SHOTS=themes    themes/<theme>.png (+ .json with the Scheduler.schedule card's box), one per board theme; tools/release/compose-themes.mjs stacks them into one picture
//   THEMES_DARK=<VS Code color theme>  then switches VS Code to that theme on the same board and shoots the themes again into themes-dark/
// Every step waits on what it needs (a quick input, a card, a swatch, the board at rest: wait.cjs, ui.cjs), never for a fixed time, so a
// run takes about a minute and a half; SHOTS_DEBUG=1 logs where the time goes
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { until, soon, idle, track } = require("./wait.cjs");
const { command, openBoard, clickBoardTab, watchKeyboard, boardDialog, boardDialogClosed, openFile, boardFrames, boardFrame, card, typingIn, pmHasSelection, focusSettled, fit } = require("./ui.cjs");
const [OUT, WS, UD] = process.argv.slice(2);
const SHOTS = (process.env.SHOTS || "features,themes").split(",");
// Board themes in the order the Settings page lists them; City is experimental and left out
const THEMES = ["Warm Ink", "Graphite", "Soft Light", "Drafting", "Colorful", "Newspaper", "Poster", "Classic", "Ink Wash"];
const T0 = Date.now();
let failed = 0;
const lap = (what) => { if (process.env.SHOTS_DEBUG) console.log(`  · ${what}  [${((Date.now() - T0) / 1000).toFixed(1)}s]`); };
const check = (ok, what) => { console.log(`${ok ? "✓" : "✗"} ${what}  [${((Date.now() - T0) / 1000).toFixed(1)}s]`); if (!ok) failed++; };

// The board at rest, then its Fit to Window button, then at rest again
const fitted = async (f) => { await idle(f); await fit(f); await idle(f); };
// Move the mouse off the board so no hover state (card toolbar, tooltips) is captured
const park = async (page, f) => { await page.mouse.move(2, 400); await idle(f, { quiet: 200 }); }; // one jump: a path across the board could open a Peek on the way
// Clipped to the board below VS Code's tab bar: the webview's box starts a few pixels under the tabs, which would show as a strip along the top edge
const boardShot = async (page, f, file) => {
  const box = await f.locator("#board").boundingBox();
  for (const t of await page.locator(".editor-group-container .title").all()) {
    const b = await t.boundingBox();
    if (box && b && b.x < box.x + box.width && b.x + b.width > box.x && b.y <= box.y && b.y + b.height > box.y) {
      const cut = Math.ceil(b.y + b.height - box.y); box.y += cut; box.height -= cut;
    }
  }
  await page.screenshot({ path: path.join(OUT, file), clip: box ?? undefined });
  console.log(`  📷 ${file}  [${((Date.now() - T0) / 1000).toFixed(1)}s]`);
};
// Bring a card's heading well inside the board view before clicking it: fit, then pan with the wheel if it still sits outside
// (window sizes differ between machines; a heading under VS Code's title bar or the board toolbar can't be clicked)
async function reveal(page, f, title, refit = true) {
  if (refit) await fitted(f);
  const loc = card(f, title).locator(".chead .ctitle");
  for (let i = 0; i < 4; i++) {
    const [b, t] = [await (await f.frameElement()).boundingBox(), await loc.boundingBox()];
    if (!b || !t) throw new Error(`${title}: no box for the board or the card's heading`);
    const cx = t.x + Math.min(t.width, 120) / 2, cy = t.y + t.height / 2;
    if (cx > b.x + 40 && cx < b.x + b.width - 40 && cy > b.y + 40 && cy < b.y + b.height - 90) return loc;
    console.log(`  … panning to ${title} (heading at ${cx | 0},${cy | 0}, board ${b.x | 0},${b.y | 0} ${b.width | 0}×${b.height | 0})`);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.wheel(cx - (b.x + b.width / 2), cy - (b.y + b.height / 2)); await idle(f);
  }
  throw new Error(`${title} cannot be panned into view`);
}
// Click empty board space and clear the selection (no selection outline or align toolbar in the shots)
const blank = async (f) => { await f.locator("#board").click({ position: { x: 30, y: 300 } }); await f.page().keyboard.press("Escape"); };
// Zoom to the selection (Shift+2: the board has the keyboard after the click that selected) and wait for the camera to arrive
const zoomToSelection = async (page, f) => { await page.keyboard.press("Shift+Digit2"); await idle(f); };
// Turn on Always Show in the open Sidenote popover. The button toggles: leave it alone when it is already on (.on)
const alwaysShowIn = async (f) => {
  const btn = f.locator(".pop button", { hasText: /^Always Show$/ }).first();
  await btn.waitFor({ timeout: 5000 });
  if (!(await btn.evaluate((b) => b.classList.contains("on")))) await btn.click();
  await until("Always Show is on", () => btn.evaluate((b) => b.classList.contains("on")), 3000);
};
const zoomOut = async (f) => { await f.locator('button[aria-label="Zoom Out"]').first().click(); await idle(f); };
// Escape out of the Note editor, and wait until it has let go of the keyboard. A gray completion takes the first Escape (it only
// dismisses the completion): wait for any completion asked for to arrive (idle: no request waiting on the host), and clear it first
const leaveNote = async (page, f) => {
  await idle(f);
  if (await f.locator(".md-ghost").count()) {
    await page.keyboard.press("Escape");
    await until("Escape dismisses the gray completion", async () => !(await f.locator(".md-ghost").count()), 5000);
  }
  await page.keyboard.press("Escape");
  await until("the Note editor lets go of the keyboard", async () => !(await f.locator(".card.note .ProseMirror-focused").count()), 5000);
};

(async () => {
  const browser = await until("VS Code's debugging port answers", () => chromium.connectOverCDP(`http://127.0.0.1:${process.env.CDP_PORT || 9223}`).catch(() => null), 60000, 200);
  const page = await until("the VS Code window", () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench")), 60000, 200);
  await track(page); // the board's requests to the host, for idle()
  await watchKeyboard(page); // the keyboard hand-backs to webviews, before the first one opens
  // Reduced motion: the board's camera, card and arrow animations jump straight to where they end (the shots show the board at rest,
  // so they look the same), and every wait for the board to settle is short. Emulated for the window and its webviews
  await page.emulateMedia({ reducedMotion: "reduce" });
  // The workbench is up once its editor area is laid out; the extension host may still be starting (commands wait for it)
  await page.locator(".monaco-workbench .part.editor").waitFor({ timeout: 60000 });
  lap("workbench ready");

  // Board: LLMEngine.step with schedule and postprocess expanded, one level deeper into allocate, a Sidenote and a Note
  await command(page, "View: Close Primary Side Bar");
  await openFile(page, path.join(WS, "nanovllm/engine/llm_engine.py"), 51);
  lap("file open");
  // Alt+B adds the function under the caret to the board, once CodeBoard is active (opening a Python file activates it).
  // The first add in a workspace opens the board beside the code, in the second editor group
  await page.keyboard.press("Alt+b");
  await until("Alt+B puts LLMEngine.step on the board", async () => { const [b] = await boardFrames(page); return b && card(b, "LLMEngine.step").count(); }, 30000, 100);
  await openBoard(page);
  const f = await boardFrame(page);
  lap("board open");
  console.log(`  … reduced motion: ${await f.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)}`);
  // Name the board (the name shows on the editor tab and in some themes' board header)
  const boardTab = page.locator('.editor-group-container .tab:has-text("nano-vllm: one engine step")');
  // From the palette over the board: CodeBoard asks on the board
  await command(page, "CodeBoard: Rename Board");
  await boardDialog(page, f, "Rename Board");
  // The dialog opens with the name selected. No Ctrl+A: in a webview VS Code runs it and sends Select All back a moment later
  await page.keyboard.type("nano-vllm: one engine step"); await page.keyboard.press("Enter"); await boardDialogClosed(f, "the Rename Board dialog");
  check(await soon(() => boardTab.count(), Boolean, 5000), "board renamed (its editor tab shows the new name)");
  // A dummy DeepSeek key: shots.sh points codeboard.ai.deepseekBaseUrl at a local mock that answers with a fixed completion
  await command(page, "CodeBoard: Set DeepSeek API Key");
  await boardDialog(page, f, "DeepSeek API Key");
  await page.keyboard.type("sk-release-shots-mock"); await page.keyboard.press("Enter"); await boardDialogClosed(f, "the DeepSeek API Key dialog");
  check(await soon(() => page.locator(".notification-list-item-message", { hasText: "key saved" }).count(), Boolean, 10000), "DeepSeek API key saved");
  // The toasts ("Added to …", the key) sit over the board's Fit to Window button: clear them now rather than when a click misses
  await command(page, "Notifications: Clear All Notifications");
  // The board fills the window while it is built (children are placed in the room the view has) and for the board shots
  // Make the board's group the active one by clicking its tab (VS Code has "Focus Second Editor Group" only as the Ctrl+2 keybinding,
  // not in the palette, and a webview having the keyboard does not make its group the one Maximize acts on)
  // VS Code focuses the board again once it has opened the clicked tab's editor: a palette opened before that loses the keyboard to it
  await clickBoardTab(page, boardTab);
  await command(page, "View: Toggle Maximize Editor Group");
  const fills = async () => { const [b, e] = [await (await f.frameElement()).boundingBox(), await page.locator(".monaco-workbench .part.editor").boundingBox()]; return b && e && b.width > e.width * 0.9; };
  check(await soon(fills, Boolean, 5000), "board fills the editor area");
  await fitted(f);
  check(await card(f, "LLMEngine.step").count() === 1, "LLMEngine.step on the board");
  // Expanding waits on the language server: wait for each new card
  const expand = async (from, name, child) => {
    await blank(f);
    await card(f, from).locator(".src .call", { hasText: new RegExp(`^${name}$`) }).first().click();
    await until(`expanding ${name} adds ${child}`, () => card(f, child).count(), 20000); await idle(f);
  };
  await expand("LLMEngine.step", "schedule", "Scheduler.schedule");
  await expand("LLMEngine.step", "postprocess", "Scheduler.postprocess");
  await expand("Scheduler.schedule", "allocate", "BlockManager.allocate");
  check(await card(f, "BlockManager.allocate").count() === 1, "calls expanded two levels deep");
  // Sidenote (zoomed to the card: line numbers are not clickable in the zoomed-out overview)
  await (await reveal(page, f, "Scheduler.schedule")).click();
  await zoomToSelection(page, f);
  const sch = card(f, "Scheduler.schedule");
  await sch.locator(".no").nth(5).click(); await sch.locator(".no").nth(6).click({ modifiers: ["Shift"] });
  await page.keyboard.press("s");
  await f.locator(".pop button", { hasText: /^Text$/ }).click();
  await until("the Sidenote's text field has the keyboard", () => typingIn(f, ".pop"));
  await page.keyboard.type("Prefill admits waiting sequences until the token budget runs out.");
  await f.locator(".pop button", { hasText: /^Add$/ }).click();
  check(await soon(() => sch.locator(".mk").count(), Boolean, 5000), "Sidenote added");
  await page.keyboard.press("Escape"); await blank(f); await idle(f);

  // Arrange: Scheduler.postprocess beside Scheduler.schedule, so the tree uses the width of the window
  const drag = async (title, target) => {
    await reveal(page, f, title, false);
    const h = await card(f, title).locator(".chead").boundingBox(), to = await target();
    await page.mouse.move(h.x + 40, h.y + h.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + 40, to.y + h.height / 2, { steps: 20 }); await page.mouse.up(); await idle(f);
  };
  await blank(f); await fitted(f);
  for (let i = 0; i < 2; i++) await zoomOut(f);
  await drag("Scheduler.postprocess", async () => { const b = await card(f, "Scheduler.schedule").boundingBox(); return { x: b.x + b.width + 30, y: b.y }; });
  // Note in the free corner under Scheduler.postprocess, beside BlockManager.allocate (keeps the board compact), created under the mouse
  const [alloc, post] = [await card(f, "BlockManager.allocate").boundingBox(), await card(f, "Scheduler.postprocess").boundingBox()];
  await blank(f); await page.mouse.move(Math.max(alloc.x + alloc.width + 40, post.x), post.y + post.height + 30);
  await page.keyboard.press("n");
  await until("the new Note's editor has the keyboard", () => typingIn(f, ".card.note"), 5000);
  // Markdown as you type: a heading, a list with a [[card reference]] (picked from the [[ menu), inline and display math, a link.
  // The editor applies each key as it comes; only the [[ menu has to be waited for. The last sentence is where the Notes shot puts the
  // caret to show the gray completion
  const type = async (text, enter = true) => { await page.keyboard.type(text); if (enter) await page.keyboard.press("Enter"); };
  await type("## One engine step");
  await type("- **schedule** picks prefill or decode: [[Scheduler.sch", false);
  await until("the [[ menu offers Scheduler.schedule", () => f.locator(".md-menu button.sel", { hasText: "Scheduler.schedule" }).count(), 5000);
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await type("**run** executes the model on the batch");
  await page.keyboard.press("Enter");
  await type("Tokens per step: $\\sum_i n_i \\le B$ ");
  await type("KV blocks per sequence:");
  await type("$$\\left\\lceil \\frac{\\text{tokens}}{\\text{block size}} \\right\\rceil$$");
  await type("From [nano-vllm](https://github.com/GeeeekExplorer/nano-vllm) by GeeeekExplorer.");
  await type("Decode adds one token per sequence each step.", false);
  await leaveNote(page, f);
  await page.keyboard.press("Escape"); await idle(f);
  check(await f.locator(".card.note").count() === 1, "Note created");
  check(await f.locator(".card.note .md-ref").count() >= 1, "Note links to Scheduler.schedule");
  // Size the Note to its content
  await blank(f); await f.locator(".card.note .chead").first().click();
  await page.keyboard.press("Alt+f"); await idle(f);
  lap("note sized");
  await blank(f); await fitted(f); await park(page, f);

  if (SHOTS.includes("features")) {
    // 1. Overview: the whole tree of expanded calls with its arrows, marks and the Note
    await boardShot(page, f, "1-overview.png");

    // 2. Definition Peek on can_allocate, zoomed to Scheduler.schedule
    await (await reveal(page, f, "Scheduler.schedule")).click();
    await zoomToSelection(page, f);
    await zoomOut(f);
    lap("peek: zoomed");
    const call = card(f, "Scheduler.schedule").locator(".src .call", { hasText: /^can_allocate$/ }).first();
    await call.hover();
    lap("peek: hovered");
    // (opens after the hover delay, then shows "Looking up …" until the definition arrives)
    await soon(async () => (await f.locator(".pop.k-peek").count()) && !(await f.locator(".pop.k-peek .empty", { hasText: "Looking up" }).count()), Boolean, 8000);
    await idle(f);
    check(await f.locator(".pop.k-peek").count() === 1, "Definition Peek opens");
    await boardShot(page, f, "2-peek.png");
    const cb = await card(f, "Scheduler.schedule").boundingBox();
    // The mouse comes to rest on empty board above the card: resting on code (the board's left edge shows LLMEngine.step's lines)
    // opens that word's Peek after the hover delay, so the check would only pass if it looked before then
    await page.mouse.move(cb.x + cb.width + 40, cb.y + 20, { steps: 6 }); await page.mouse.move(cb.x + cb.width / 2, cb.y - 40, { steps: 12 });
    await until("the Peek closes once the mouse leaves", async () => !(await f.locator(".pop.k-peek").count()), 5000); await idle(f);

    // 4. Notes: zoomed to the Note and Scheduler.schedule, the Sidenote always shown beside its lines,
    // the Note open for editing with the caret after its last sentence and the gray completion (from the mock) behind it
    await blank(f); await fitted(f);
    await card(f, "Scheduler.schedule").locator(".mk").first().click();
    await alwaysShowIn(f); await idle(f);
    await page.keyboard.press("Escape"); await blank(f); await idle(f);
    await f.locator(".card.note .chead").first().click();
    await card(f, "Scheduler.schedule").locator(".chead .ctitle").click({ modifiers: ["Shift"], timeout: 5000 });
    // One step out, so the Note keeps clear of the zoom controls once the gray text adds a line
    await zoomToSelection(page, f); await blank(f); await idle(f);
    await zoomOut(f);
    await f.locator(".card.note .nbody").first().dblclick();
    await until("the Note's editor has the keyboard", () => typingIn(f, ".card.note"), 5000);
    // Retype the closing period: the completion is asked for after an edit, once typing pauses
    await focusSettled(f); // or ProseMirror undoes the Ctrl+End (the double click just focused it)
    // The browser moves the caret for Ctrl+End and ProseMirror reads it only later: a Backspace before that acts where the double
    // click put the caret (in this Note, between two paragraphs: it selects the one before, and the period replaces it)
    await page.keyboard.press("Control+End"); await pmHasSelection(f);
    await page.keyboard.press("Backspace"); await page.keyboard.type(".");
    check(await soon(() => f.locator(".md-ghost").count(), Boolean, 10000, 100), "gray completion shown in the Note");
    await park(page, f);
    await boardShot(page, f, "4-notes.png");
    await leaveNote(page, f); await page.keyboard.press("Escape");
    await blank(f); await fitted(f);

    // 3. New version: commit a change to Scheduler.schedule; the card stays pinned to its commit and offers the diff
    const file = path.join(WS, "nanovllm/engine/scheduler.py");
    const src = fs.readFileSync(file, "utf8");
    const changed = src.replace(/(\n(\s+)def schedule\(self\)[^\n]*\n)/, "$1$2    # admit waiting sequences first, then fall back to decoding\n");
    check(changed !== src, "scheduler.py edited");
    fs.writeFileSync(file, changed);
    execSync(`git -C ${WS} -c user.name=dev -c user.email=dev@example.com commit -qam "Scheduler: comment the admission order"`);
    check(await soon(() => card(f, "Scheduler.schedule").locator(".rev.new").count(), Boolean, 15000, 100), "card shows New version");
    // A card with a new version also brings up the board's "has a new version" banner: dismiss it, it is not part of the shot
    const dismiss = f.locator('.banner button[aria-label="Dismiss"]');
    await dismiss.click({ timeout: 5000 }); await dismiss.waitFor({ state: "hidden", timeout: 5000 }); await idle(f);
    await card(f, "Scheduler.schedule").locator(".rev.new").first().click();
    const keep = f.locator(".pop button", { hasText: /^Keep / }).first();
    await keep.waitFor({ timeout: 5000 }); await idle(f);
    await park(page, f);
    await boardShot(page, f, "3-new-version.png");
    // Keep the pinned version so the theme shots that follow show a plain board
    await keep.click({ timeout: 3000 }); await keep.waitFor({ state: "hidden", timeout: 5000 }); await idle(f);
  }

  if (SHOTS.includes("themes")) {
    // One shot per board theme of Scheduler.schedule alone (with its Sidenote shown), picked on the board's own Settings page.
    // Everything else on the board is hidden while the shot is taken; in Warm Ink the card fills 80% of the shot's width
    await blank(f); await fitted(f);
    await card(f, "Scheduler.schedule").locator(".mk").first().click();
    await alwaysShowIn(f); await idle(f);
    await page.keyboard.press("Escape"); await blank(f); await idle(f);
    // Hide every element but the card, its ancestors and its contents (the board background stays); window.__unsolo() undoes it.
    // Can run again: what the board mounted since (e.g. the arrowhead of the incoming link, redrawn after a camera move) is hidden too
    const solo = (el) => el.evaluate((c) => {
      const hidden = [];
      for (let e = c; e && e !== document.body; e = e.parentElement)
        for (const sib of e.parentElement?.children ?? []) if (sib !== e && sib.style.visibility !== "hidden") { hidden.push(sib); sib.style.visibility = "hidden"; }
      const prev = window.__unsolo;
      window.__unsolo = () => { for (const h of hidden) h.style.visibility = ""; prev?.(); window.__unsolo = undefined; };
    });
    // What shows besides the card itself: hover or selection on it, a link port, other elements around it (up to 4). Should be nothing
    const strays = (el) => el.evaluate((c) => {
      const r = c.getBoundingClientRect(), m = r.width / 8;
      const state = [c.matches(":hover") && "card hovered", c.classList.contains("sel") && "card selected",
        ...[...c.querySelectorAll(".eport")].filter((e) => +getComputedStyle(e).opacity > 0).map((e) => `port ${e.className}`)].filter(Boolean);
      return state.concat([...document.querySelectorAll("#board *")].filter((e) => {
        if (c.contains(e) || e.contains(c)) return false;
        const cs = getComputedStyle(e);
        if (cs.visibility !== "visible" || cs.display === "none" || +cs.opacity === 0) return false;
        const b = e.getBoundingClientRect();
        return b.width > 0 && b.height > 0 && b.right > r.left - m && b.left < r.right + m && b.bottom > r.top - m && b.top < r.bottom + m;
      }).slice(0, 4).map((e) => `${e.tagName.toLowerCase()}.${String(e.className?.baseVal ?? e.className).trim().replace(/\s+/g, ".")}`));
    });
    // Pick a theme on the board's Settings page and wait until the board wears it (data-look) with its fonts loaded (idle waits for fonts)
    const setLook = async (t) => {
      const id = t.toLowerCase().replace(/ /g, "-");
      await blank(f);
      await page.keyboard.press("Control+,");
      const sw = f.locator(".st-sw", { hasText: t }).first();
      await sw.click({ timeout: 5000 });
      check(await soon(() => f.evaluate((id) => document.documentElement.dataset.look === id, id), Boolean, 5000, 30), `${t}: board theme set`);
      await page.keyboard.press("Control+,");
      await f.locator(".st-sw").first().waitFor({ state: "hidden", timeout: 5000 });
      await idle(f);
    };
    const CARD_W = 640;
    let zoom;
    const shootThemes = async (dir) => {
      fs.mkdirSync(path.join(OUT, dir), { recursive: true });
      for (const t of THEMES) {
        await setLook(t);
        // One board zoom for every theme, so code is the same size in every panel: the zoom at which Warm Ink's card is CARD_W px wide.
        // Zoom with Ctrl+wheel by the exact factor, then pan the card to the middle. (Zooming to the selection gave each theme its own
        // zoom, and some themes were shot at the fit-to-window zoom; the composition then scaled those up into blurry slices)
        // Only the first shot starts from Fit to Window; later ones start at the right zoom and only pan if the new theme moved the card
        const sch = card(f, "Scheduler.schedule");
        if (zoom === undefined) await fitted(f);
        await solo(await sch.elementHandle());
        const fb = await f.locator("#board").boundingBox();
        const zoomOf = async () => (await sch.boundingBox()).width / await sch.evaluate((e) => e.offsetWidth);
        zoom ??= CARD_W / await sch.evaluate((e) => e.offsetWidth);
        // The wheel events are dispatched on the board inside the webview (the board's own wheel handler sets the camera at once):
        // Ctrl+wheel sent through the window did not reach the board on CI, which left every theme at the fit-to-window zoom
        for (let i = 0; i < 3; i++) {
          const done = await sch.evaluate((c, zoom) => {
            const board = document.getElementById("board"), b = board.getBoundingClientRect();
            const wheel = (o) => board.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: b.x + 4, clientY: b.y + 4, ...o }));
            const off = () => { const r = c.getBoundingClientRect(); return [r.width / c.offsetWidth, r.x + r.width / 2 - (b.x + b.width / 2), r.y + r.height / 2 - (b.y + b.height / 2)]; };
            let [z, dx, dy] = off();
            const dz = -100 * Math.log(zoom / z);
            if (Math.abs(dz) < 0.3 && Math.abs(dx) < 2 && Math.abs(dy) < 2) return true;
            if (Math.abs(dz) >= 0.3) { wheel({ ctrlKey: true, deltaY: dz }); [z, dx, dy] = off(); }
            wheel({ deltaX: dx, deltaY: dy });
            return false;
          }, zoom);
          if (done) break;
          await idle(f, { quiet: 200 });
        }
        // Park the mouse on the board beside the card (empty: the rest is hidden), so the card loses :hover. Parking outside the
        // webview left the card hovered in some themes, showing its left link port (a dot, ring or diamond at the heading)
        await page.mouse.move(fb.x + 4, fb.y + fb.height / 2);
        await until(`${t}: the card is no longer hovered`, () => sch.evaluate((c) => !c.matches(":hover")), 3000, 30); await idle(f, { quiet: 200 });
        // Hide again what appeared since (the camera moved), then make sure only the card shows, neither hovered nor selected
        await solo(await sch.elementHandle());
        const left = await strays(sch);
        check(!left.length, `${t}: nothing but the card shows${left.length ? ` (${left.join(", ")})` : ""}`);
        const cb = await sch.boundingBox();
        const z = await zoomOf();
        check(Math.abs(z / zoom - 1) < 0.004, `${t}: board zoom ${(z * 100).toFixed(1)}% (card ${cb.width | 0}×${cb.height | 0})`);
        const pad = CARD_W / 8;
        const x0 = Math.max(fb.x, cb.x - pad), y0 = Math.max(fb.y, cb.y - pad), x1 = Math.min(fb.x + fb.width, cb.x + cb.width + pad), y1 = Math.min(fb.y + fb.height, cb.y + cb.height + pad);
        const name = t.toLowerCase().replace(/ /g, "-");
        await page.screenshot({ path: path.join(OUT, dir, `${name}.png`), clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
        console.log(`  📷 ${dir}/${name}.png  [${((Date.now() - T0) / 1000).toFixed(1)}s]`);
        await f.evaluate(() => window.__unsolo?.());
        // Where the card sits in the shot (CSS px): compose-themes.mjs crops each theme's slice to the card's left edge
        fs.writeFileSync(path.join(OUT, dir, `${name}.json`), JSON.stringify({ frame: { w: x1 - x0, h: y1 - y0 }, card: { x: cb.x - x0, y: cb.y - y0, w: cb.width, h: cb.height } }));
      }
    };
    await shootThemes("themes");
    // The same board in VS Code's dark theme (the board follows VS Code's light / dark), without building it again in a second window
    if (process.env.THEMES_DARK) {
      // Straight into the user settings (VS Code watches the file); the Color Theme picker labels themes differently from the setting
      const sf = path.join(UD, "User", "settings.json"), us = JSON.parse(fs.readFileSync(sf, "utf8"));
      fs.writeFileSync(sf, JSON.stringify({ ...us, "workbench.colorTheme": process.env.THEMES_DARK }, null, 2));
      check(await soon(() => f.evaluate(() => document.documentElement.dataset.theme === "dark"), Boolean, 10000), `VS Code switched to ${process.env.THEMES_DARK}`);
      await idle(f);
      await shootThemes("themes-dark");
    }
  }
  console.log(failed ? `${failed} checks failed` : "all passed");
  await browser.close().catch(() => { /* VS Code may already be closing the connection */ });
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

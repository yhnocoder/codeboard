// Release screenshots: build a small showcase board in a real VS Code and capture the feature shots, then one shot per board theme.
// Run through tools/release/shots.sh, which runs this once through test/run.sh at 2x (VS Code light) and composes the theme pictures
//   SHOTS=features  1-overview, 2-peek, 3-new-version, 4-notes
//   SHOTS=themes    themes/<theme>.png (+ .json with the Scheduler.schedule card's box), one per board theme; tools/release/compose-themes.mjs stacks them into one picture
//   THEMES_DARK=<VS Code color theme>  then switches VS Code to that theme on the same board and shoots the themes again into themes-dark/
// Every step waits on what it needs (a quick input, a card, a swatch, the board at rest) rather than for a fixed time, so a run takes about a minute and a half; SHOTS_DEBUG=1 logs where the time goes
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const [OUT, WS, UD] = process.argv.slice(2);
const SHOTS = (process.env.SHOTS || "features,themes").split(",");
// Board themes in the order the Settings page lists them; City is experimental and left out
const THEMES = ["Warm Ink", "Graphite", "Soft Light", "Drafting", "Colorful", "Newspaper", "Poster", "Classic", "Ink Wash"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
let failed = 0;
const lap = (what) => { if (process.env.SHOTS_DEBUG) console.log(`  · ${what}  [${((Date.now() - T0) / 1000).toFixed(1)}s]`); };
const check = (ok, what) => { console.log(`${ok ? "✓" : "✗"} ${what}  [${((Date.now() - T0) / 1000).toFixed(1)}s]`); if (!ok) failed++; };
// Poll until fn() is truthy (errors count as not yet); false after ms
const until = async (fn, ms = 10000, step = 50) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) { try { if (await fn()) return true; } catch {} }
  return false;
};

async function boardFrame(page) {
  for (let i = 0; i < 400; i++) {
    for (const f of page.frames()) { try { if (await f.$("#board")) return f; } catch {} }
    await sleep(100);
  }
  throw new Error("board webview not found");
}
// The quick input (command palette, Quick Open, input boxes)
const qi = (page) => page.locator(".quick-input-widget");
const qiValue = (page) => page.locator(".quick-input-widget .quick-input-box input").inputValue();
// Type into an open quick pick, then accept the row whose label (before any ", <keybinding>") contains the text: Enter when it is the
// focused row, a click when it is further down (e.g. under "Browse Color Themes in Marketplace"). Without such a row after ms, Enter
// accepts whatever is focused. Returns whether the row was found
const pick = async (page, text, ms = 5000) => {
  await page.keyboard.type(text);
  const rows = page.locator(".quick-input-widget .monaco-list-row");
  // The list can still change under us (Quick Open fills in as files are indexed): find the row again if the click misses
  const find = () => rows.evaluateAll((rs, t) => { const i = rs.findIndex((r) => (r.getAttribute("aria-label") ?? "").toLowerCase().split(", ")[0].includes(t)); return [i, i >= 0 && rs[i].classList.contains("focused")]; }, text.toLowerCase());
  let at = -1, focused = false;
  for (const end = Date.now() + ms; Date.now() < end;) {
    [at, focused] = await find().catch(() => [-1, false]);
    if (at >= 0 && focused) { await page.keyboard.press("Enter"); return true; }
    if (at >= 0 && await rows.nth(at).click({ timeout: 1000 }).then(() => true, () => false)) return true;
    await sleep(50);
  }
  console.log(`  ! quick pick has no row for "${text}": ${JSON.stringify({ value: await qiValue(page).catch(() => "?"), rows: await rows.evaluateAll((rs) => rs.slice(0, 4).map((r) => `${r.className}|${r.getAttribute("aria-label")}`)) })}`);
  await page.keyboard.press("Enter");
  return false;
};
// Run a command from the palette; returns once the palette is gone, or, for a command that asks for input, once its input box
// (with `prompt` in its title or message) is up, so nothing typed next goes to the closing palette
async function command(page, text, prompt) {
  const t = Date.now();
  await command0(page, text, prompt);
  if (process.env.SHOTS_DEBUG) console.log(`  · ${text} ${Date.now() - t}ms`);
}
async function command0(page, text, prompt) {
  await page.keyboard.press("F1");
  await qi(page).waitFor({ state: "visible" });
  // Commands are listed at once; without a match (this VS Code has no "Focus Second Editor Group"), Enter runs the first row as before
  await pick(page, text, 2000);
  if (!prompt) return qiClosed(page);
  if (!(await until(async () => !(await qiValue(page)).startsWith(">") &&
      (await page.locator(".quick-input-widget .quick-input-title, .quick-input-widget .quick-input-message").allInnerTexts()).some((t) => t.toLowerCase().includes(prompt.toLowerCase())))))
    console.log(`  ! no input box "${prompt}"`);
}
// Wait until the quick input is closed
const qiClosed = (page) => qi(page).waitFor({ state: "hidden" }).catch(() => {});
async function openFile(page, name, line) {
  const tab = page.locator(`.editor-group-container .tab.active[aria-label*="${name}"], .editor-group-container .tab.active:has-text("${name}")`);
  for (let i = 0; i < 5; i++) {
    await command(page, "View: Focus First Editor Group");
    await page.keyboard.press("Control+p"); await qi(page).waitFor({ state: "visible" });
    // Quick Open finds nothing until the workspace's files are indexed: then close it and try again
    if (await pick(page, name, 10000) && await until(() => tab.count(), 5000)) break;
    await page.keyboard.press("Escape"); await qiClosed(page);
  }
  if (line) {
    await page.keyboard.press("Control+g"); await qi(page).waitFor({ state: "visible" });
    await page.keyboard.type(String(line)); await page.keyboard.press("Enter"); await qiClosed(page);
  }
}
// Wait until the board stops moving: no running animations, the same card boxes and no DOM change for `quiet` ms.
// Polled from here every 40 ms (timers inside the webview can be throttled to about one a second); DOM changes are counted by a
// MutationObserver rather than by serializing the board, which took ~100 ms a sample
const settle = async (fr, quiet = 300) => {
  const t0 = Date.now(), why = {};
  const sample = () => fr.evaluate(() => {
    if (!window.__muts) { window.__muts = { n: 0 }; new MutationObserver((l) => { window.__muts.n += l.length; }).observe(document.querySelector("#board") ?? document.body, { subtree: true, childList: true, attributes: true, characterData: true }); }
    const w = document.querySelector(".world");
    const busy = document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity).map((a) => `${a.animationName ?? a.transitionProperty}@${String(a.effect?.target?.className?.baseVal ?? a.effect?.target?.className ?? "").slice(0, 24)}`);
    return { busy, s: (w ? getComputedStyle(w).transform : "") + "|" + [...document.querySelectorAll(".card")].map((c) => { const r = c.getBoundingClientRect(); return `${r.x|0},${r.y|0},${r.width|0},${r.height|0}`; }).join(";") + "|" + window.__muts.n };
  }).catch(() => null);
  let last = await sample(), since = Date.now();
  while (last && Date.now() - t0 < 12000) {
    await sleep(40);
    const cur = await sample();
    if (!cur) break;
    for (const b of cur.busy) why[b] = (why[b] ?? 0) + 1;
    if (cur.s !== last.s) { const [a, b] = [last.s.split("|"), cur.s.split("|")]; const k = a[0] !== b[0] ? "transform" : a[1] !== b[1] ? "cards" : "dom"; why[k] = (why[k] ?? 0) + 1; }
    if (cur.busy.length || cur.s !== last.s) since = Date.now(); else if (Date.now() - since >= quiet) break;
    last = cur;
  }
  if (process.env.SHOTS_DEBUG && Date.now() - t0 > 800) console.log(`  · settle ${Date.now() - t0}ms ${JSON.stringify(why).slice(0, 200)}`);
};
// Fit with the board's own button. A VS Code notification toast (e.g. from Pylance) can sit over it in the bottom-right corner:
// then clear the notifications and try again, and fail loudly rather than carry on with an unfitted camera
const fit = async (f) => {
  await settle(f);
  const btn = f.locator('button[aria-label="Fit to Window"]').first();
  for (let i = 0; i < 3; i++) {
    if (await btn.click({ timeout: 3000 }).then(() => true, () => false)) return settle(f);
    console.log("  … Fit to Window is covered, clearing notifications");
    await command(f.page(), "Notifications: Clear All Notifications");
  }
  throw new Error("cannot click Fit to Window");
};
// Move the mouse off the board so no hover state (card toolbar, tooltips) is captured
const park = async (page, f) => { await page.mouse.move(2, 400); if (f) await settle(f, 200); else await sleep(400); }; // one jump: a path across the board could open a Peek on the way
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
  if (refit) await fit(f);
  const loc = card(f, title).locator(".chead .ctitle");
  for (let i = 0; i < 4; i++) {
    const [b, t] = [await (await f.frameElement()).boundingBox(), await loc.boundingBox()];
    if (!b || !t) break;
    const cx = t.x + Math.min(t.width, 120) / 2, cy = t.y + t.height / 2;
    if (cx > b.x + 40 && cx < b.x + b.width - 40 && cy > b.y + 40 && cy < b.y + b.height - 90) return loc;
    const why = await f.evaluate(() => ({ scroll: [...document.querySelectorAll("*")].filter((e) => e.scrollTop || e.scrollLeft).map((e) => `${e.tagName}.${e.className}`.slice(0, 40) + `@${e.scrollLeft},${e.scrollTop}`).slice(0, 4), world: getComputedStyle(document.querySelector(".world") ?? document.body).transform, h: innerHeight }));
    console.log(`  … panning to ${title} (heading at ${cx | 0},${cy | 0}, board ${b.x | 0},${b.y | 0} ${b.width | 0}×${b.height | 0}) ${JSON.stringify(why)}`);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.wheel(cx - (b.x + b.width / 2), cy - (b.y + b.height / 2)); await settle(f);
  }
  return loc;
}
const card = (f, title) => f.locator(".card", { has: f.locator(".chead .ctitle", { hasText: new RegExp(`^${title.replace(/\./g, "\\.")}$`) }) });
// Click empty board space and clear the selection (no selection outline or align toolbar in the shots)
const blank = async (f) => { await f.locator("#board").click({ position: { x: 30, y: 300 } }); await f.page().keyboard.press("Escape"); };
// Zoom to the selection (Shift+2) and wait for the camera to arrive
const zoomToSelection = async (page, f) => {
  const before = await f.evaluate(() => getComputedStyle(document.querySelector(".world")).transform).catch(() => "");
  await page.keyboard.press("Shift+Digit2");
  await until(() => f.evaluate((b) => getComputedStyle(document.querySelector(".world")).transform !== b, before), 3000, 30);
  await settle(f);
};
// Turn on Always Show in the open Sidenote popover. The button toggles: leave it alone when it is already on (.on)
const alwaysShowIn = async (f) => {
  const btn = f.locator(".pop button", { hasText: /^Always Show$/ }).first();
  if (!(await btn.waitFor({ timeout: 5000 }).then(() => true, () => false))) return console.log("  ! no Always Show");
  if (!(await btn.evaluate((b) => b.classList.contains("on")))) await btn.click();
  await until(() => btn.evaluate((b) => b.classList.contains("on")), 3000);
};
const zoomOut = async (f) => { await f.locator('button[aria-label="Zoom Out"]').first().click(); await settle(f); };

(async () => {
  let browser;
  for (let i = 0; i < 300 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.CDP_PORT || 9223}`); } catch { await sleep(200); } }
  if (!browser) throw new Error("cannot connect to VS Code");
  let page;
  for (let i = 0; i < 300 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench"));
    if (!page) await sleep(200);
  }
  if (!page) throw new Error("VS Code main window not found");
  // Reduced motion: the board's camera, card and arrow animations jump straight to where they end (the shots show the board at rest,
  // so they look the same), and every wait for the board to settle is short. Emulated for the window and its webviews
  await page.emulateMedia({ reducedMotion: "reduce" });
  // The workbench is up once its editor area is laid out; the extension host may still be starting (commands wait for it)
  await page.locator(".monaco-workbench .part.editor").waitFor({ timeout: 60000 });
  lap("workbench ready");

  // Board: LLMEngine.step with schedule and postprocess expanded, one level deeper into allocate, a Sidenote and a Note
  await command(page, "View: Close Primary Side Bar");
  await openFile(page, "llm_engine.py", 51);
  lap("file open");
  // Alt+B adds the function under the caret to the board, once CodeBoard is active (opening a Python file activates it)
  // (no board is open yet, so it is saved to the board and VS Code says "Added to …")
  await page.keyboard.press("Alt+b");
  if (!(await until(() => page.locator(".notification-list-item-message", { hasText: /^Added/ }).count(), 15000, 100))) console.log("  ! no Added notification");
  await command(page, "CodeBoard: Open Board");
  const f = await boardFrame(page);
  lap("board open");
  console.log(`  … reduced motion: ${await f.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches).catch(() => "?")}`);
  await until(() => card(f, "LLMEngine.step").count(), 15000);
  // Name the board (the name shows on the editor tab and in some themes' board header)
  await command(page, "CodeBoard: Rename Board", "Rename board");
  await page.keyboard.press("Control+a"); await page.keyboard.type("nano-vllm: one engine step"); await page.keyboard.press("Enter"); await qiClosed(page);
  await until(() => page.locator('.editor-group-container .tab:has-text("nano-vllm: one engine step")').count(), 5000);
  // A dummy DeepSeek key: shots.sh points codeboard.ai.deepseekBaseUrl at a local mock that answers with a fixed completion
  await command(page, "CodeBoard: Set DeepSeek API Key", "DeepSeek API Key");
  await page.keyboard.type("sk-release-shots-mock"); await page.keyboard.press("Enter"); await qiClosed(page);
  await until(() => page.locator(".notification-list-item-message", { hasText: "key saved" }).count(), 10000);
  console.log(`  … after setting the key: ${(await page.locator(".notification-list-item-message").allInnerTexts()).join(" | ")}`);
  // The toasts ("Added to …", the key) sit over the board's Fit to Window button: clear them now rather than when a click misses
  await command(page, "Notifications: Clear All Notifications");
  // The board fills the window while it is built (children are placed in the room the view has) and for the board shots
  await command(page, "View: Focus Second Editor Group");
  await command(page, "View: Toggle Maximize Editor Group");
  await fit(f);
  check(await card(f, "LLMEngine.step").count() === 1, "LLMEngine.step on the board");
  const expand = async (from, name, child) => {
    await blank(f);
    await card(f, from).locator(".src .call", { hasText: new RegExp(`^${name}$`) }).first().click();
    await until(() => card(f, child).count(), 10000); await settle(f);
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
  await page.keyboard.type("Prefill admits waiting sequences until the token budget runs out.");
  await f.locator(".pop button", { hasText: /^Add$/ }).click();
  await until(() => sch.locator(".mk").count(), 5000);
  await page.keyboard.press("Escape"); await blank(f); await settle(f);
  check(await sch.locator(".mk").count() >= 1, "Sidenote added");

  // Arrange: Scheduler.postprocess beside Scheduler.schedule, so the tree uses the width of the window
  const drag = async (title, target) => {
    await reveal(page, f, title, false);
    const h = await card(f, title).locator(".chead").boundingBox(), to = await target();
    await page.mouse.move(h.x + 40, h.y + h.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + 40, to.y + h.height / 2, { steps: 20 }); await page.mouse.up(); await settle(f);
  };
  await blank(f); await fit(f);
  for (let i = 0; i < 2; i++) await f.locator('button[aria-label="Zoom Out"]').first().click().then(() => settle(f), () => {});
  await drag("Scheduler.postprocess", async () => { const b = await card(f, "Scheduler.schedule").boundingBox(); return { x: b.x + b.width + 30, y: b.y }; });
  // Note in the free corner under Scheduler.postprocess, beside BlockManager.allocate (keeps the board compact), created under the mouse
  const [alloc, post] = [await card(f, "BlockManager.allocate").boundingBox(), await card(f, "Scheduler.postprocess").boundingBox()];
  await blank(f); await page.mouse.move(Math.max(alloc.x + alloc.width + 40, post.x), post.y + post.height + 30); await sleep(100);
  await page.keyboard.press("n");
  await f.locator(".card.note .ProseMirror-focused").waitFor({ timeout: 5000 }).catch(() => console.log("  ! Note editor not focused"));
  // Markdown as you type: a heading, a list with a [[card reference]] (picked from the [[ menu), inline and display math, a link.
  // The last sentence is where the Notes shot puts the caret to show the gray completion
  const type = async (text, enter = true) => { await page.keyboard.type(text); await sleep(150); if (enter) { await page.keyboard.press("Enter"); await sleep(150); } };
  await type("## One engine step");
  await type("- **schedule** picks prefill or decode: [[Scheduler.sch", false); await sleep(600);
  await page.keyboard.press("Enter"); await sleep(300); await page.keyboard.press("Enter"); await sleep(150);
  await type("**run** executes the model on the batch");
  await page.keyboard.press("Enter"); await sleep(150);
  await type("Tokens per step: $\\sum_i n_i \\le B$ ");
  await type("KV blocks per sequence:");
  await type("$$\\left\\lceil \\frac{\\text{tokens}}{\\text{block size}} \\right\\rceil$$");
  await type("From [nano-vllm](https://github.com/GeeeekExplorer/nano-vllm) by GeeeekExplorer.");
  await type("Decode adds one token per sequence each step.", false);
  await page.keyboard.press("Escape"); await sleep(300);
  await page.keyboard.press("Escape"); await settle(f);
  check(await f.locator(".card.note").count() === 1, "Note created");
  check(await f.locator(".card.note .cref").count() >= 1, "Note links to Scheduler.schedule");
  // Size the Note to its content
  await blank(f); await f.locator(".card.note .chead").first().click();
  await page.keyboard.press("Alt+f"); await settle(f);
  lap("note sized");
  await blank(f); await fit(f); await park(page, f);

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
    await until(async () => (await f.locator(".pop.k-peek").count()) && !(await f.locator(".pop.k-peek .empty", { hasText: "Looking up" }).count()), 8000);
    await settle(f);
    check(await f.locator(".pop.k-peek").count() === 1, "Definition Peek opens");
    await boardShot(page, f, "2-peek.png");
    const cb = await card(f, "Scheduler.schedule").boundingBox();
    await page.mouse.move(cb.x + cb.width + 40, cb.y + 20, { steps: 6 }); await page.mouse.move(5, 300, { steps: 12 });
    await until(async () => !(await f.locator(".pop.k-peek").count()), 5000); await settle(f);

    // 4. Notes: zoomed to the Note and Scheduler.schedule, the Sidenote always shown beside its lines,
    // the Note open for editing with the caret after its last sentence and the gray completion (from the mock) behind it
    await blank(f); await fit(f);
    await card(f, "Scheduler.schedule").locator(".mk").first().click();
    await alwaysShowIn(f); await settle(f);
    await page.keyboard.press("Escape"); await blank(f); await settle(f);
    await f.locator(".card.note .chead").first().click();
    await card(f, "Scheduler.schedule").locator(".chead .ctitle").click({ modifiers: ["Shift"], timeout: 5000 }).catch(() => console.log("  ! could not add Scheduler.schedule to the selection"));
    // One step out, so the Note keeps clear of the zoom controls once the gray text adds a line
    await zoomToSelection(page, f); await blank(f); await settle(f);
    await zoomOut(f);
    await f.locator(".card.note .nbody").first().dblclick();
    await f.locator(".card.note .ProseMirror-focused").waitFor({ timeout: 5000 }).catch(() => {});
    // Retype the closing period: the completion is asked for after an edit, once typing pauses
    await page.keyboard.press("Control+End"); await sleep(100);
    await page.keyboard.press("Backspace"); await sleep(100); await page.keyboard.type("."); await sleep(100);
    console.log(`  … Note editor focused: ${await f.locator(".card.note .ProseMirror-focused").count()}`);
    const ghost = await until(() => f.locator(".md-ghost").count(), 10000, 100);
    check(ghost, "gray completion shown in the Note");
    await park(page, f);
    await boardShot(page, f, "4-notes.png");
    await page.keyboard.press("Escape"); await sleep(100); await page.keyboard.press("Escape");
    await blank(f); await fit(f);

    // 3. New version: commit a change to Scheduler.schedule; the card stays pinned to its commit and offers the diff
    const file = path.join(WS, "nanovllm/engine/scheduler.py");
    const src = fs.readFileSync(file, "utf8");
    const changed = src.replace(/(\n(\s+)def schedule\(self\)[^\n]*\n)/, "$1$2    # admit waiting sequences first, then fall back to decoding\n");
    check(changed !== src, "scheduler.py edited");
    fs.writeFileSync(file, changed);
    execSync(`git -C ${WS} -c user.name=dev -c user.email=dev@example.com commit -qam "Scheduler: comment the admission order"`);
    const isNew = await until(() => card(f, "Scheduler.schedule").locator(".rev.new").count(), 15000, 100);
    check(isNew, "card shows New version");
    await f.locator('.banner button[aria-label="Dismiss"]').click({ timeout: 1000 }).catch(() => {}); await settle(f);
    await card(f, "Scheduler.schedule").locator(".rev.new").first().click();
    await f.locator(".pop button", { hasText: /^Keep / }).first().waitFor({ timeout: 5000 }).catch(() => {}); await settle(f);
    await park(page, f);
    await boardShot(page, f, "3-new-version.png");
    // Keep the pinned version so the theme shots that follow show a plain board
    await f.locator(".pop button", { hasText: /^Keep / }).first().click({ timeout: 3000 }).catch(() => page.keyboard.press("Escape")); await settle(f);
  }

  if (SHOTS.includes("themes")) {
    // One shot per board theme of Scheduler.schedule alone (with its Sidenote shown), picked on the board's own Settings page.
    // Everything else on the board is hidden while the shot is taken; in Warm Ink the card fills 80% of the shot's width
    await blank(f); await fit(f);
    await card(f, "Scheduler.schedule").locator(".mk").first().click();
    await alwaysShowIn(f); await settle(f);
    await page.keyboard.press("Escape"); await blank(f); await settle(f);
    // Hide every element but the card, its ancestors and its contents (the board background stays); returns an undo
    const solo = (el) => el.evaluate((c) => {
      const hidden = [];
      for (let e = c; e && e !== document.body; e = e.parentElement)
        for (const sib of e.parentElement?.children ?? []) if (sib !== e && sib.style.visibility !== "hidden") { hidden.push(sib); sib.style.visibility = "hidden"; }
      window.__unsolo = () => { for (const h of hidden) h.style.visibility = ""; };
    });
    // Pick a theme on the board's Settings page and wait until the board wears it (data-look) with its fonts loaded
    const setLook = async (t) => {
      const id = t.toLowerCase().replace(/ /g, "-");
      await blank(f);
      await page.keyboard.press("Control+,");
      const sw = f.locator(".st-sw", { hasText: t }).first();
      await sw.click({ timeout: 5000 });
      check(await until(() => f.evaluate((id) => document.documentElement.dataset.look === id, id), 5000, 30), `${t}: board theme set`);
      await page.keyboard.press("Control+,");
      await f.locator(".st-sw").first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => console.log("  ! Settings page still open"));
      await f.evaluate(() => document.fonts.ready);
      await settle(f);
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
        if (zoom === undefined) await fit(f);
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
          await settle(f, 200);
        }
        await park(page, f); const cb = await sch.boundingBox();
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
      check(await until(() => f.evaluate(() => document.documentElement.dataset.theme === "dark"), 10000), `VS Code switched to ${process.env.THEMES_DARK}`);
      await settle(f);
      await shootThemes("themes-dark");
    }
  }
  console.log(failed ? `${failed} checks failed` : "all passed");
  await browser.close().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

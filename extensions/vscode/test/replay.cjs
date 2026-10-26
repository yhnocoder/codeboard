// Study-task replay: in a real VS Code, build a board of nano-vllm's LLMEngine.step in fixed steps.
// Each step: act → check results → wait for the board to settle → screenshot the board → run the generic UI audit (tools/review/audit.cjs).
// A failing step doesn't stop the rest: record the failure, take the screenshot, keep going.
// Every step waits for the state it needs (wait.cjs, ui.cjs), never for a fixed time.
// Usage: DRIVER=replay.cjs E2E_OUT=test-out/replay npm run e2e   Output: <OUT>/rNN-*.png, audit.json, steps.json
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { audit, report } = require("../../../tools/review/audit.cjs");
const { until, soon, hold, idle, track, sent, timing } = require("./wait.cjs");
const { command, openFile, boardFrame, boardFrames, card, text, typingIn, fit } = require("./ui.cjs");
const [OUT, WS, UD] = process.argv.slice(2);

const steps = [], audits = [];
let failed = 0, cur = null;
const check = (ok, what, extra) => {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${!ok && extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : ""}`);
  cur?.checks.push({ ok: !!ok, what, extra: ok ? undefined : extra });
  if (!ok) failed++;
};

async function shot(page, fr, name) {
  await idle(fr);
  const box = await (await fr.frameElement()).boundingBox();
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: box ?? undefined });
  const r = await audit(fr, name); audits.push(r);
  for (const i of r.issues) console.log(`  ⚠ ${i.rule} — ${i.what}`);
  if (process.env.AUDIT_STRICT === "1") check(!r.issues.length, "passes the UI audit", r.issues);
}
const callIn = (f, title, name) => card(f, title).locator(".src .call", { hasText: new RegExp(`^${name}$`) }).first();
const boardJson = () => {
  const d = execSync(`ls -d ${UD}/User/workspaceStorage/*/*codeboard*/boards 2>/dev/null || true`).toString().trim().split("\n")[0];
  if (!d) return null;
  const f = fs.readdirSync(d).find((n) => n.endsWith(".json"));
  return f ? JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) : null;
};
const nCards = (b) => (b?.cards ?? []).length;
// The host writes the board a moment after each change (core storage's WRITE_DELAY): poll the saved file until the predicate holds or
// time runs out; return the last read (the check after it says what was expected)
const waitJson = (pred, ms = 5000) => soon(boardJson, (b) => { try { return !!b && pred(b); } catch { return false; } }, ms, 100);
// Paste a generated PNG so the board has an Image card
async function pasteImage(f) {
  await f.evaluate(async () => {
    const cv = document.createElement("canvas"); cv.width = 320; cv.height = 200;
    const g = cv.getContext("2d"); g.fillStyle = "#c2643a"; g.fillRect(0, 0, 320, 200); g.fillStyle = "#fff"; g.fillRect(40, 40, 120, 80);
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    const dt = new DataTransfer(); dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await waitJson((b) => b.cards.some((c) => c.kind === "image")); await idle(f);
}
// Click empty canvas to deselect and close popups
const blank = async (f, page) => { await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await f.locator("#board").click({ position: { x: 12, y: 160 }, force: true }); await idle(f); };
// Line-number elements of a card that are inside the viewport (after zooming part of the card may be off screen)
async function visibleRows(f, c) {
  const all = c.locator(".no"), out = [];
  const vh = await f.evaluate(() => innerHeight);
  for (let i = 0; i < await all.count(); i++) { const b = await all.nth(i).boundingBox(); if (b && b.y > 40 && b.y + b.height < vh - 90) out.push(all.nth(i)); }
  return out;
}
// Select a card and zoom to it (Shift+2) so its lines are readable and clickable
const focusCard = async (f, page, title) => { await blank(f, page); await card(f, title).locator(".chead").click({ position: { x: 120, y: 8 }, force: true }); await page.keyboard.press("Shift+@"); await idle(f); };
const menuOpen = (f, n = 1, of = "") => until(`${n > 1 ? `the submenu${of ? ` of "${of}"` : ""}` : "the context menu"} opens`, async () => await f.locator(".ctx").count() >= n);
async function menu(f, target, label, sub, opts = {}) {
  await target.click({ button: "right", ...opts }); await menuOpen(f);
  await f.locator(".ctx button", { hasText: new RegExp(`^${label}`) }).first()[sub ? "hover" : "click"]();
  if (sub) await f.locator(".ctx button", { hasText: new RegExp(`^${sub}`) }).last().click();
  await idle(f);
}
// The keyboard is in the editor of a new Note / Text card
const noteEditing = (f) => until("the new card's editor has the keyboard", () => f.evaluate(() => !!document.activeElement?.closest(".card .md-pm")));
const noteDone = (f) => until("Esc ends editing", async () => !(await f.locator(".card .md-pm").count()));

// Card rect (coordinates inside the board iframe)
const rectOf = (loc) => loc.evaluate((e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; });
const inView = (f, r) => f.evaluate((r) => r.r > 0 && r.b > 0 && r.l < innerWidth && r.t < innerHeight && (Math.min(r.r, innerWidth) - Math.max(r.l, 0)) * (Math.min(r.b, innerHeight) - Math.max(r.t, 0)) > 0.5 * r.w * r.h, r);
const gap = (a, b) => Math.hypot(Math.max(0, a.l - b.r, b.l - a.r), Math.max(0, a.t - b.b, b.t - a.b));

(async () => {
  const port = process.env.CDP_PORT || 9223;
  const browser = await until("VS Code's debugging port answers", () => chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null), 60000, 500);
  const page = await until("the VS Code window", () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench")), 60000, 200);
  await track(page); // before the first board's webview exists
  await page.locator(".monaco-workbench .part.editor").waitFor({ timeout: 60000 });
  const errors = [];
  // Node deprecation warnings from other extensions are logged as errors too, and the workspace path contains "codeboard": not ours
  page.on("console", (m) => { if (m.type() === "error" && /codeboard|board\.js/i.test(m.text()) && !/DeprecationWarning/.test(m.text())) errors.push(m.text()); });
  let f = null;
  // Maximize the board's editor group (by default it shares the width with code, leaving the board ~540px wide, too small to click after zooming)
  // Make the board's group the active one by clicking its tab (VS Code has "Focus Second Editor Group" only as the Ctrl+2 keybinding,
  // not in the palette, and a webview having the keyboard does not make its group the one Maximize acts on)
  const maximize = async () => {
    await page.locator(".editor-group-container .tab.active").filter({ hasNotText: /\.py\b/ }).click();
    await command(page, "View: Toggle Maximize Editor Group");
    const fills = async () => { const [b, e] = [await (await f.frameElement()).boundingBox(), await page.locator(".monaco-workbench .part.editor").boundingBox()]; return b && e && b.width > e.width * 0.9; };
    await until("the board fills the editor area", fills);
    await idle(f);
  };

  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  // PART=1|2|3 splits the replay across parallel CI jobs: parts 2 and 3 each walk half of the long menu walk (r19, split by card kind),
  // after the steps that build the cards it needs; part 1 runs everything else
  const part = process.env.PART, MENU = ["r01", "r08", "r19"];
  const R19_KINDS = { 2: ["code", "note"], 3: ["web", "image"] }[part];
  const inPart = (name) => !part || (part === "1" ? !name.startsWith("r19") : MENU.some((p) => name.startsWith(p)));
  const step = async (name, title, fn) => {
    if (only && !only.some((o) => name.startsWith(o))) return;
    if (!inPart(name)) return;
    cur = { name, title, checks: [] }; steps.push(cur);
    console.log(`▶ ${name} ${title}`);
    try { await fn(); } catch (e) { check(false, "step ran without errors", String(e.message || e).split("\n")[0]); }
    try { if (f) await shot(page, f, name); } catch (e) { check(false, "the board settles for the step's screenshot", String(e.message || e).split("\n")[0]); }
  };

  await step("r01-first-card", "Alt+B inside a function, open the board", async () => {
    await openFile(page, path.join(WS, "nanovllm/engine/llm_engine.py"), 51);
    await page.keyboard.press("Alt+b");
    await command(page, "CodeBoard: Open Board");
    f = await boardFrame(page);
    await soon(() => card(f, "LLMEngine.step").count(), Boolean, 20000);
    await idle(f);
    await maximize();
    check(await card(f, "LLMEngine.step").count() === 1, "LLMEngine.step is on the board");
  });

  await step("r02-expand", "Expand schedule and postprocess, then can_allocate from schedule", async () => {
    // Expanding waits on the language server, which is slow on a cold runner: wait for each card
    const expand = async (from, call, title) => { await callIn(f, from, call).click(); await card(f, title).first().waitFor({ timeout: 20000 }); await idle(f); await blank(f, page); };
    await expand("LLMEngine.step", "schedule", "Scheduler.schedule");
    await expand("LLMEngine.step", "postprocess", "Scheduler.postprocess");
    await expand("Scheduler.schedule", "can_allocate", "BlockManager.can_allocate");
    check(await card(f, "Scheduler.schedule").count() === 1 && await card(f, "Scheduler.postprocess").count() === 1, "two child cards");
    check(await card(f, "BlockManager.can_allocate").count() === 1, "grandchild BlockManager.can_allocate");
    // Labels only name the tree (since v0.1.5 every card shows its tree's letter)
    const root = await text(card(f, "LLMEngine.step").locator(".chead .step"));
    const n = await text(card(f, "BlockManager.can_allocate").locator(".chead .step"));
    check(!!n && n === root, "grandchild is labeled with the same tree", { root, n });
    await fit(f); await idle(f);
  });

  await step("r03-arrow-right", "Drag the schedule card to the right of its parent; the arrow now leaves from the line's right end", async () => {
    const p = await card(f, "LLMEngine.step").boundingBox(), h = await card(f, "Scheduler.schedule").locator(".chead").boundingBox();
    await page.mouse.move(h.x + 150, h.y + h.height / 2); await page.mouse.down();
    const tx = p.x + p.width + 60 + 150, ty = p.y + 10;
    await page.mouse.move(tx, ty, { steps: 12 });
    await page.mouse.up(); await idle(f);
    const r = await f.evaluate(() => {
      const st = [...document.querySelectorAll(".card")].find((c) => c.querySelector(".ctitle")?.textContent === "LLMEngine.step").getBoundingClientRect();
      const ch = [...document.querySelectorAll(".card")].find((c) => c.querySelector(".ctitle")?.textContent === "Scheduler.schedule").getBoundingClientRect();
      const ends = [...document.querySelectorAll("path.edge")].map((e) => { const L = e.getTotalLength(); const m = e.getScreenCTM(); const pt = (t) => { const q = e.getPointAtLength(t); return { x: q.x * m.a + m.e, y: q.y * m.d + m.f }; }; return { a: pt(0), b: pt(L) }; });
      const near = (q, r) => Math.abs(q.x - r.left) < 40 || Math.abs(q.x - r.right) < 40;
      const e = ends.find((x) => x.b.x > st.right && near(x.b, ch) || x.a.x > st.right && near(x.a, ch));
      return { st: { l: st.left, r: st.right }, ch: { l: ch.left }, e };
    });
    check(r.ch.l > r.st.r, "child card is right of the parent", r);
    const start = r.e && (r.e.a.x < r.e.b.x ? r.e.a : r.e.b);
    check(start && Math.abs(start.x - r.st.r) < 30, "arrow starts at the parent's right edge", r);
    await page.keyboard.press("Control+z"); await idle(f);
    await fit(f); await idle(f);
  });

  await step("r05-section", "Put schedule and can_allocate in a new Section, name it, collapse and expand", async () => {
    await card(f, "Scheduler.schedule").locator(".chead").click({ position: { x: 120, y: 12 } });
    await card(f, "BlockManager.can_allocate").locator(".chead").click({ position: { x: 120, y: 12 }, modifiers: ["Shift"] });
    await until("both cards are selected", async () => await f.locator(".card.sel").count() === 2);
    await menu(f, card(f, "BlockManager.can_allocate").locator(".chead"), "Move to New Section", null, { position: { x: 120, y: 12 } });
    await until("the new Section's title field has the keyboard", () => typingIn(f));
    await page.keyboard.press("Control+a"); await page.keyboard.type("Scheduling"); await page.keyboard.press("Enter");
    const b = await waitJson((b) => b.sections?.[0]?.title === "Scheduling");
    check(b?.sections?.length === 1 && b.sections[0].title === "Scheduling", "Section created and named", b?.sections);
    await idle(f);
    const col = f.locator('button[aria-label="Collapse Section"]').first();
    await col.click();
    check(await soon(() => f.locator('button[aria-label="Expand Section"]').count(), (n) => n === 1) === 1, "Section collapsed");
    await idle(f);
    await f.locator('button[aria-label="Expand Section"]').first().click(); await idle(f);
    await blank(f, page);
  });

  await step("r06-sidenote", "Select two lines and add a multi-line sidenote (with math)", async () => {
    const st = card(f, "LLMEngine.step");
    await focusCard(f, page, "LLMEngine.step");
    const nos = await visibleRows(f, st);
    await nos[1].click(); await nos[2].click({ modifiers: ["Shift"] });
    if (process.env.DEBUG) console.log("  focus", await f.evaluate(() => [document.hasFocus(), document.activeElement?.tagName, document.activeElement?.className]));
    await page.keyboard.press("s");
    await f.locator(".pop button", { hasText: /^Text$/ }).click();
    await until("the Sidenote's text field has the keyboard", () => typingIn(f, ".pop"));
    await page.keyboard.type("Prefill first, then decode."); await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Cost: $O(n^2)$ per step");
    await f.locator(".pop button", { hasText: /^Add$/ }).click();
    const b = await waitJson((b) => b.sidenotes?.length === 1);
    check(b?.sidenotes?.length === 1 && /O\(n\^2\)/.test(b.sidenotes[0].md ?? b.sidenotes[0].text ?? ""), "sidenote saved, with math", b?.sidenotes);
    check(await soon(() => st.locator(".mk").count(), (n) => n >= 1) >= 1, "sidenote marker appears beside the lines");
    await blank(f, page);
  });

  await step("r07-sticker", "Toolbar Sticker: one on a code line, one on the canvas", async () => {
    await focusCard(f, page, "LLMEngine.step"); await blank(f, page);
    const picker = async () => { await f.locator('.bbar button[aria-label="Sticker"]').click(); await f.locator(".stkpick").waitFor(); };
    await picker();
    await f.locator(".stkpick .scell").nth(1).click();
    // A sticker sticks to a line when dropped on its line number (on the code it binds to the card).
    // While placing, an overlay takes the pointer: click through it as a user would (force skips Playwright's "covered" wait)
    await card(f, "LLMEngine.step").locator(".gutter .no").nth(4).click({ force: true });
    await waitJson((b) => b.stickers?.length >= 1); await idle(f);
    if (!(await f.locator(".stkpick").count())) await picker();
    await f.locator(".stkpick .scell").nth(0).click({ timeout: 5000 });
    const bb = await f.locator("#board").boundingBox();
    await f.locator("#board").click({ position: { x: bb.width - 80, y: 90 }, force: true });
    const k = (await waitJson((b) => b.stickers?.length >= 2))?.stickers ?? [];
    check(k.some((s) => s.at.kind === "line") && k.some((s) => s.at.kind === "canvas"), "stickers placed on a line and on the canvas", k.map((s) => s.at.kind));
    await blank(f, page);
  });

  await step("r08-new-cards", "New Note and Text, paste a GitHub link and a plain URL", async () => {
    const before = nCards(boardJson());
    await blank(f, page); await fit(f); await idle(f);
    const bb = await f.locator("#board").boundingBox();
    await page.mouse.move(bb.x + bb.width - 260, bb.y + bb.height - 220);
    await page.keyboard.press("n"); await noteEditing(f);
    await page.keyboard.type("**Takeaway**: schedule → run → postprocess"); await page.keyboard.press("Escape"); await noteDone(f);
    await page.mouse.move(bb.x + bb.width - 260, bb.y + bb.height - 120);
    await page.keyboard.press("t"); await noteEditing(f);
    await page.keyboard.type("free text"); await page.keyboard.press("Escape"); await noteDone(f);
    const paste = (t) => f.evaluate((t) => { const dt = new DataTransfer(); dt.setData("text/plain", t); window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); }, t);
    // each paste asks the host what the text is (a GitHub file, a web page): idle waits for the answer
    await paste("https://github.com/GeeeekExplorer/nano-vllm/blob/bb823b3/nanovllm/engine/scheduler.py#L24-L40"); await idle(f, { ms: 30000 });
    await paste(process.env.WEB_URL || "https://arxiv.org/abs/2309.06180"); await idle(f, { ms: 30000 });
    const b = await waitJson((b) => nCards(b) >= before + 4), kinds = (b?.cards ?? []).map((c) => c.kind);
    check(nCards(b) >= before + 4, "4 more cards", { before, after: nCards(b), kinds });
    check(kinds.includes("web"), "plain URL became a Web card", kinds);
    check((b?.cards ?? []).some((c) => c.kind === "code" && /github|gh/i.test(JSON.stringify(c.segments?.[0]?.src ?? c.source ?? c.gh ?? ""))), "GitHub link became a GitHub Code card (needs GitHub API access)", kinds);
    await blank(f, page);
    await fit(f); await idle(f);
  });

  await step("r09-menu-edges", "Open context menus at the four corners and on the lowest card", async () => {
    const bb = await f.locator("#board").boundingBox();
    const fits = () => f.evaluate(() => { const m = document.querySelector(".ctx"); if (!m) return null; const r = m.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
    const closed = () => until("Esc closes the context menu", async () => !(await f.locator(".ctx").count()));
    for (const [x, y, n] of [[8, 8, "top-left"], [bb.width - 8, 8, "top-right"], [8, bb.height - 8, "bottom-left"], [bb.width - 8, bb.height - 8, "bottom-right"]]) {
      await f.locator("#board").click({ button: "right", position: { x, y } }); await menuOpen(f); await idle(f);
      const ok = await fits(); check(ok, `menu at the ${n} corner fully visible`);
      if (!ok) await page.screenshot({ path: `${OUT}/r09-debug-${n}.png`, clip: await (await f.frameElement()).boundingBox() });
      await page.keyboard.press("Escape"); await closed();
    }
    // Lowest code card
    const heads = f.locator(".card.ccard .chead"); let low = null, ly = -1;
    for (let i = 0; i < await heads.count(); i++) { const b = await heads.nth(i).boundingBox(); if (b && b.y > ly && b.y < bb.height - 140) { ly = b.y; low = heads.nth(i); } }
    if (low) { await low.click({ button: "right", position: { x: 60, y: 8 }, force: true }); await menuOpen(f); await idle(f); check(await fits(), "menu on the lowest card fully visible"); }
  });

  await step("r10-version", "Edit one source line → card shows the local change → open the version picker", async () => {
    // Edit the workspace file directly (triggers a file change like saving in the editor) so the board stays in view
    const fp = path.join(WS, "nanovllm/engine/scheduler.py");
    const lines = fs.readFileSync(fp, "utf8").split("\n"); lines[29] += "  # local edit"; fs.writeFileSync(fp, lines.join("\n"));
    const t0 = Date.now();
    const unc = await soon(() => f.locator(".rev.unc").count(), (n) => n >= 1, 10000);
    check(unc >= 1, "editing the file outside the editor shows + uncommitted", { waitedMs: Date.now() - t0 });
    await focusCard(f, page, "Scheduler.schedule");
    await card(f, "Scheduler.schedule").locator(".rev").first().click({ force: true });
    check(await soon(() => f.locator(".k-commits").count(), (n) => n === 1, 5000) === 1, "version picker opens", await f.locator(".pop").count());
  });

  await step("r11a-zoom-min", "Zoom all the way out, hovering opens no popup", async () => {
    await blank(f, page); await fit(f); await idle(f);
    for (let i = 0; i < 14; i++) await page.keyboard.press("Control+-");
    await idle(f);
    const c = f.locator(".card .src .call").first();
    if (await c.count()) await c.hover({ force: true });
    // nothing to wait for when the check holds: a Peek would open PEEK_DELAY after the hover (then show "Looking up …"); one that
    // opens a little late (a webview's timers can be) is a DOM change, which idle() waits out
    await hold(timing.PEEK_DELAY, "hovering a call while zoomed far out opens no Definition Peek");
    await idle(f);
    check(await f.locator(".pop.k-peek").count() === 0, "no Definition Peek when zoomed far out");
  });
  await step("r11b-zoom-fit", "Back to fit-to-window", async () => { await page.mouse.move(5, 5); await fit(f); await idle(f); });
  await step("r11c-zoom-max", "Zoom all the way in", async () => {
    await focusCard(f, page, "LLMEngine.step");
    for (let i = 0; i < 12; i++) await page.keyboard.press("Control+=");
    await idle(f);
  });

  await step("r12-undo-redo", "Undo to the start, redo to the end, same as before undo", async () => {
    await fit(f); await idle(f);
    await blank(f, page);
    if (process.env.DEBUG) console.log("  focus after blank", await f.evaluate(() => [document.hasFocus(), document.activeElement?.tagName]), await page.evaluate(() => [document.activeElement?.tagName, document.activeElement?.className?.slice?.(0, 60)]));
    const want = JSON.stringify(boardJson()?.cards?.map((c) => c.id).sort());
    await f.evaluate(() => { window.__zk = 0; window.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") window.__zk++; }, true); });
    for (let i = 0; i < 40; i++) await page.keyboard.press("Control+z");
    const zk = await soon(() => f.evaluate(() => window.__zk), (n) => n >= 40, 5000);
    check(zk > 0, "Ctrl+Z reached the board", { keydowns: zk, focused: await f.evaluate(() => document.hasFocus()) });
    const mid = nCards(await waitJson((b) => nCards(b) <= 1, 6000));
    for (let i = 0; i < 40; i++) await page.keyboard.press("Control+Shift+z");
    await waitJson((b) => JSON.stringify(b.cards.map((c) => c.id).sort()) === want, 6000);
    const got = JSON.stringify(boardJson()?.cards?.map((c) => c.id).sort());
    check(mid < nCards(boardJson()), "undo really removed cards", { mid });
    check(got === want, "after redoing everything the cards match the state before undo", { want, got });
    await idle(f);
    await fit(f); await idle(f);
  });

  await step("r13-reopen", "Close and reopen the board, content is still there", async () => {
    const want = nCards(boardJson());
    await page.keyboard.press("Escape");
    await command(page, "View: Close All Editors");
    await until("every editor is closed", async () => !(await page.locator(".tabs-container .tab").count()) && !(await boardFrames(page, { visible: false })).length);
    await command(page, "CodeBoard: Open Board");
    f = await boardFrame(page); await idle(f);
    const got = await soon(() => f.locator(".card").count(), (n) => n === want);
    check(got === want, "same card count after reopening", { want, got });
  });

  // One screenshot of the same board per theme, for side-by-side comparison with the material reference in T2 (checklist S11)
  await step("r14-themes", "One screenshot per theme (8)", async () => {
    // Close Settings with its own button: a stray Ctrl+, that reaches VS Code instead of the board opens VS Code's Settings over the board,
    // after which the hidden webview stops painting (stale screenshots, every later step waits out settle())
    const isOpen = async () => (await f.locator(".st-sw").count()) > 0;
    const openSettings = async () => { await blank(f, page); await page.keyboard.press("Control+,"); await until("Ctrl+, opens the board's Settings page", isOpen); };
    const closeSettings = async () => { await f.locator('button[aria-label="Close Settings"]').click(); await until("the board's Settings page closes", async () => !(await isOpen())); };
    // a theme is on once its swatch says so and the board wears it with its fonts loaded
    const pickTheme = async (i) => {
      await f.locator(".st-sw").nth(i).click();
      await until("the picked theme's swatch is on", async () => (await f.locator(".st-sw").nth(i).getAttribute("aria-pressed")) === "true");
      await f.evaluate(() => document.fonts.ready); await idle(f);
    };
    await blank(f, page); await fit(f); await idle(f);
    await openSettings();
    const names = await f.locator(".st-sw .st-swn").allTextContents();
    check(names.length >= 8, "Settings lists 8 themes", names);
    for (let i = 0; i < names.length; i++) {
      await pickTheme(i);
      await closeSettings();
      await shot(page, f, `r14-theme-${String(i + 1).padStart(2, "0")}-${names[i].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
      await openSettings();
    }
    await pickTheme(0);
    await closeSettings();
    const tab = await text(page.locator(".tab.active"));
    check(!/Settings/.test(tab), "the board is still the active editor after Settings", tab);
  });

  // ---- The steps below come from v0.1.5 trial feedback (checklist section 4: C1 C2 C4 C8) ----

  await step("r15-paste-near", "Select a card, ⌘C ⌘V: the new card appears next to the original (C8)", async () => {
    await blank(f, page); await fit(f); await idle(f);
    const sid = await card(f, "LLMEngine.step").first().getAttribute("data-id");
    const src = f.locator(`.card[data-id="${sid}"]`), h = src.locator(".chead");
    await h.click({ position: { x: 120, y: 8 }, force: true });
    await until("the card is selected and the board has the keyboard", async () => /\bsel\b/.test(await src.getAttribute("class")) && await f.evaluate(() => document.hasFocus()));
    const before = boardJson(), ids = new Set((before?.cards ?? []).map((c) => c.id));
    await page.keyboard.press("Control+c");
    // ⌘V pastes what the system clipboard holds (read in the webview, which has the keyboard): the card's code once ⌘C has put it there
    await until("⌘C puts the card's code on the system clipboard", async () => /def step\(self\)/.test(await f.evaluate(() => navigator.clipboard.readText())));
    await page.keyboard.press("Control+v");
    const b = await waitJson((b) => nCards(b) > nCards(before));
    const nid = (b?.cards ?? []).find((c) => !ids.has(c.id))?.id;
    check(!!nid, "⌘V created a card", { before: nCards(before), after: nCards(b) });
    if (nid) {
      await idle(f);
      const a = await rectOf(src), n = await rectOf(f.locator(`.card[data-id="${nid}"]`));
      check(await inView(f, n), "new card is in view", n);
      check(gap(a, n) <= 160, "new card is right next to the copied card", { gapPx: Math.round(gap(a, n)), src: a, new: n });
      await blank(f, page); await page.keyboard.press("Control+z"); await waitJson((b) => nCards(b) === nCards(before));
    }
  });

  await step("r16-expand-in-view", "Expand a call in the middle of the tree: the new card is in view (C8)", async () => {
    await focusCard(f, page, "Scheduler.schedule");
    const c = callIn(f, "Scheduler.schedule", "allocate");
    await c.scrollIntoViewIfNeeded(); await c.click();
    const n = card(f, "BlockManager.allocate");
    await soon(() => n.count(), (k) => k === 1, 20000); await idle(f);
    check(await n.count() === 1, "BlockManager.allocate expanded");
    if (await n.count()) { const r = await rectOf(n); check(await inView(f, r), "new card is in view", r); }
    await blank(f, page);
  });

  await step("r17-popup-anchor", "Two sidenotes on the same lines, delete one, the popup stays put (C4)", async () => {
    // Find a code card with at least three readable lines after zooming (the tree has grown, so the focused card may not be in view)
    let st = null, nos = [];
    for (const t of ["LLMEngine.step", "BlockManager.allocate", "Scheduler.postprocess"]) {
      if (!(await card(f, t).count())) continue;
      await focusCard(f, page, t); st = card(f, t).first(); nos = await visibleRows(f, st);
      if (nos.length >= 3) break;
    }
    check(nos.length >= 3, "found a code card whose lines can be selected", nos.length);
    const n00 = boardJson()?.sidenotes?.length ?? 0;
    for (const [k, t] of ["First note on these lines.", "Second note on the same lines."].entries()) {
      await blank(f, page); nos = await visibleRows(f, st);
      await nos[1].click(); await nos[2].click({ modifiers: ["Shift"] });
      await page.keyboard.press("s");
      await f.locator(".pop button", { hasText: /^Text$/ }).click();
      await until("the Sidenote's text field has the keyboard", () => typingIn(f, ".pop"));
      await page.keyboard.type(t);
      await f.locator(".pop button", { hasText: /^Add$/ }).click();
      await waitJson((b) => (b.sidenotes?.length ?? 0) >= n00 + k + 1); await idle(f);
    }
    check(!!(await waitJson((b) => (b.sidenotes?.length ?? 0) >= n00 + 2)), "two sidenotes added on the same lines");
    await blank(f, page);
    const mk = st.locator('.mk:not(.inline)[data-notes*=","]').first();
    await mk.click({ force: true });
    const pop = f.locator(".pop").filter({ has: f.locator('button[aria-label="Delete Sidenote"]') }).first();
    check(await soon(() => pop.count(), (n) => n === 1, 5000) === 1, "clicking the marker opens the sidenote popup");
    if (!(await pop.count())) return;
    await idle(f);
    const r0 = await rectOf(pop), n0 = boardJson()?.sidenotes?.length ?? 0;
    await pop.locator('button[aria-label="Delete Sidenote"]').first().click();
    await waitJson((b) => (b.sidenotes?.length ?? 0) < n0); await idle(f);
    const still = await pop.count();
    check(still === 1, "the remaining sidenote is still in the popup");
    if (still) {
      const r1 = await rectOf(pop);
      check(Math.abs(r1.l - r0.l) < 60 && Math.abs(r1.t - r0.t) < 60, "popup stays next to its anchor", { before: r0, after: r1 });
    }
    // Leave the popup open so this step's screenshot and audit (L10) see it
  });

  await step("r18-drag-body", "Every non-code card can be dragged from the middle of its content (C2)", async () => {
    await blank(f, page); await fit(f); await idle(f);
    await pasteImage(f);
    // A Note (with background) has selectable text, so by design it drags by its header; only check cards whose content is not text
    for (const k of ["text", "web", "image"]) {
      // For Web cards prefer one with a loaded preview (title, description, image): that is the one users grab by its content.
      // Locally (no internet) WEB_URL can point the pasted URL at a page served on localhost
      const rich = f.locator(".card.web", { has: f.locator(".wimg") });
      const c = k === "web" && (await rich.count()) ? rich.first() : f.locator(`.card.${k}`).first();
      if (!(await c.count())) { check(false, `board has a ${k} card to drag`); continue; }
      // Fit first: the previous card's zoom can leave this one off screen, and a click there would select nothing
      await blank(f, page); await fit(f); await idle(f);
      // Select the card and zoom to it (Shift+2) so it is fully in view and large enough
      const rr = await rectOf(c); await f.locator("#board").click({ position: { x: rr.l + rr.w / 2, y: rr.t + Math.min(8, rr.h / 2) }, force: true });
      await page.keyboard.press("Shift+@"); await idle(f);
      const r0 = await rectOf(c), fb = await (await f.frameElement()).boundingBox();
      const x = fb.x + r0.l + r0.w / 2, y = fb.y + r0.t + r0.h * 0.6;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + 70, y + 50, { steps: 10 });
      await page.mouse.up(); await idle(f);
      const r1 = await rectOf(c);
      check(Math.hypot(r1.l - r0.l, r1.t - r0.t) > 30, `${k} card drags from the middle of its content`, { before: r0, after: r1 });
      if (Math.hypot(r1.l - r0.l, r1.t - r0.t) > 1) { await blank(f, page); await page.keyboard.press("Control+z"); await idle(f); }
    }
    await blank(f, page);
  });

  await step("r19-menu-items", "Click every item of each card type's context menu; every item has an effect (C1)", async () => {
    // Items that leave the board or need the outside world are skipped: open in editor / browser, refresh web preview (no internet in the sandbox)
    const SKIP = /^(Open In Editor|Open in Editor|Open In Browser|Open in Browser|Refresh Preview|Refetch Preview|Paste)/i;
    const kinds = [["code", ".card.ccard .chead"], ["note", ".card.note"], ["web", ".card.web"], ["image", ".card.image"]].filter(([k]) => !R19_KINDS || R19_KINDS.includes(k));
    if (!(await f.locator(".card.image").count())) { await blank(f, page); await pasteImage(f); }
    const fb = await (await f.frameElement()).boundingBox();
    const dead = [], unreachable = [];
    const closed = () => until("Esc closes the context menu", async () => !(await f.locator(".ctx").count()));
    for (const [k, sel] of kinds) {
      await blank(f, page); await fit(f); await idle(f);
      const t = f.locator(sel).first();
      if (!(await t.count())) continue;
      const open = async () => {
        if (!(await t.count())) throw new Error(`${k} card disappeared after a menu action`);
        // an item can move the camera away and its undo does not move it back (Move to Section pans to the section): fit again then
        if (!(await inView(f, await rectOf(t)))) { await fit(f); await idle(f); }
        const r = await rectOf(t), x = r.l + Math.min(60, r.w / 2), y = r.t + Math.min(10, r.h / 2);
        await page.mouse.click(fb.x + x, fb.y + y, { button: "right" });
        // when no menu opens, say what was under the click and where the keyboard was
        await menuOpen(f).catch(async (e) => { throw new Error(`${e.message}; right-clicked ${k} at ${x | 0},${y | 0}: ${JSON.stringify(await f.evaluate(([x, y]) => {
          const d = (e) => e ? `${e.tagName.toLowerCase()}.${String(e.className?.baseVal ?? e.className).trim().replace(/\s+/g, ".")}`.slice(0, 60) : null;
          return { at: d(document.elementFromPoint(x, y)), card: d(document.elementFromPoint(x, y)?.closest(".card")), active: d(document.activeElement), open: [...document.querySelectorAll(".pop, .dialog, .palette, .settings")].map(d) };
        }, [x, y]))}`); });
        await idle(f);
      };
      // The menu row labeled exactly so ("Edit" is a submenu; a substring match would hover "Edit Description" instead)
      const item = (m, label) => m.locator(":scope > button", { has: f.locator(".lb", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).first();
      const list = async (m) => m.locator(":scope > button").evaluateAll((bs) => bs.map((b) => ({ label: b.querySelector(".lb")?.textContent.trim(), sub: !!b.querySelector(":scope > svg"), off: b.disabled })));
      await open();
      const top = await list(f.locator(".ctx").first());
      const paths = [];
      for (const it of top) {
        if (it.off || SKIP.test(it.label)) continue;
        if (!it.sub) { paths.push([it.label]); continue; }
        await item(f.locator(".ctx").first(), it.label).hover({ timeout: 5000 });
        await menuOpen(f, 2, `${k}: ${it.label}`); await idle(f);
        const subs = await list(f.locator(".ctx").nth(1));
        for (const s of subs) if (!s.off && !s.sub && !SKIP.test(s.label)) paths.push([it.label, s.label]);
      }
      await page.keyboard.press("Escape"); await closed();
      // "Has an effect" means the picture or the saved board changed: a DOM change nobody can see (e.g. an editor hidden by CSS) does not count
      const neutral = () => page.mouse.move(fb.x + 4, fb.y + fb.height / 2);
      const look = async () => { await neutral(); await idle(f); return page.screenshot({ clip: fb }); };
      // Open the menu and click the item at path p
      const pick = async (p) => {
        try {
          await open();
          if (p.length > 1) { await item(f.locator(".ctx").first(), p[0]).hover({ timeout: 5000 }); await menuOpen(f, 2); }
          const m = f.locator(".ctx").nth(p.length - 1);
          await item(m, p[p.length - 1]).click({ timeout: 5000 });
          return true;
        } catch (e) { unreachable.push(`${k}: ${p.join(" › ")} (${String(e.message).split("\n")[0]})`); await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await idle(f); return false; }
      };
      for (const p of paths) {
        await blank(f, page); await open(); await page.keyboard.press("Escape"); await closed(); // right-click selects the card, so let the selection into the "before" picture
        const a = await look(), j0 = JSON.stringify(boardJson()), p0 = await sent(f, "patch");
        if (!(await pick(p))) continue;
        await idle(f);
        const b = await look();
        // The saved board changed when the board sent a change (a patch); the host writes it a moment later: wait for the file then
        const j1 = await sent(f, "patch") > p0 ? JSON.stringify(await soon(boardJson, (x) => JSON.stringify(x) !== j0, 5000, 100)) : j0;
        if (process.env.DEBUG) console.log("   ", k, p.join(" › "), a.equals(b) ? "picture unchanged" : "picture changed", j0 === j1 ? "save unchanged" : "save changed");
        // Bring to front / send to back are no-ops when already there (the menu should ideally disable them; not a failure here)
        const last = p[p.length - 1];
        if (a.equals(b) && j0 === j1 && !/^(Bring|Send) /.test(last)) dead.push(`${k}: ${p.join(" › ")}`);
        // Items that open an editor: typing right away must land in it (an editor that appears without focus counts as no effect)
        else if (/Description|Rename|Title|^Edit$/.test(last) && j0 === j1) {
          await page.keyboard.type("zq9");
          await f.locator("#board").click({ position: { x: 12, y: 160 }, force: true });
          const ok = !!(await waitJson((b) => JSON.stringify(b).includes("zq9"), 2500) && JSON.stringify(boardJson()).includes("zq9"));
          if (!ok) dead.push(`${k}: ${p.join(" › ")} (editor opened but typing does not reach it)`);
          else { await blank(f, page); await page.keyboard.press("Control+z"); await idle(f); }
        }
        // Restore: leave the editor / mode, undo if the save changed
        await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await idle(f);
        if (j0 !== j1) { await blank(f, page); await page.keyboard.press("Control+z"); await idle(f); }
      }
      check(paths.length > 0, `read the menu items of the ${k} card`, top);
    }
    check(!unreachable.length, "every menu item can be clicked", unreachable);
    check(!dead.length, "every menu item has an effect", dead);
    await blank(f, page);
  });

  check(!errors.length, "no webview errors", errors.slice(0, 3));
  fs.writeFileSync(`${OUT}/audit.json`, JSON.stringify(audits, null, 1));
  console.log(report(audits).join("\n"));
  fs.writeFileSync(`${OUT}/steps.json`, JSON.stringify(steps, null, 1));
  console.log(`fixed waits run: ${hold.count()} hold()`);
  console.log(failed ? `${failed} checks failed` : "all passed");
  await browser.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

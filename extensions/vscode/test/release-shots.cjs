// Release screenshots: build a small showcase board in a real VS Code and capture the feature shots, then one shot per board theme.
// Run through tools/release/shots.sh, which runs this twice (VS Code light, then dark) through test/run.sh at 2x and composes the theme pictures
//   SHOTS=features  1-overview … 5-notes
//   SHOTS=themes    themes/<theme>.png, one per board theme; tools/release/compose-themes.mjs stacks them into one picture
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const [OUT, WS, UD] = process.argv.slice(2);
const SHOTS = (process.env.SHOTS || "features,themes").split(",");
// Board themes in the order the Settings page lists them; City is experimental and left out
const THEMES = ["Warm Ink", "Graphite", "Soft Light", "Drafting", "Colorful", "Newspaper", "Poster", "Classic", "Ink Wash"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "✓" : "✗"} ${what}`); if (!ok) failed++; };

async function boardFrame(page) {
  for (let i = 0; i < 80; i++) {
    for (const f of page.frames()) { try { if (await f.$("#board")) return f; } catch {} }
    await sleep(500);
  }
  throw new Error("board webview not found");
}
async function command(page, text) {
  await page.keyboard.press("F1"); await sleep(500);
  await page.keyboard.type(text); await sleep(800);
  await page.keyboard.press("Enter"); await sleep(1200);
}
async function openFile(page, name, line) {
  for (let i = 0; i < 5; i++) {
    await command(page, "View: Focus First Editor Group");
    await page.keyboard.press("Control+p"); await sleep(500);
    await page.keyboard.type(name); await sleep(900 + i * 1000); await page.keyboard.press("Enter"); await sleep(900);
    if (await page.locator(`.editor-group-container .tab.active[aria-label*="${name}"], .editor-group-container .tab.active:has-text("${name}")`).count()) break;
    await page.keyboard.press("Escape"); await sleep(1500);
  }
  if (line) { await page.keyboard.press("Control+g"); await sleep(300); await page.keyboard.type(String(line)); await page.keyboard.press("Enter"); await sleep(400); }
}
// Wait until the board stops moving: no running animations and the same card boxes for a while
const settle = (fr) => fr.evaluate(async () => {
  const sig = () => { const w = document.querySelector(".world"); return (w ? getComputedStyle(w).transform : "") + "|" + [...document.querySelectorAll(".card")].map((c) => { const r = c.getBoundingClientRect(); return `${r.x|0},${r.y|0},${r.width|0},${r.height|0}`; }).join(";") + "|" + (document.querySelector("#board")?.innerHTML.length ?? 0); };
  let last = "", same = 0;
  for (let i = 0; i < 80 && same < 10; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const busy = document.getAnimations().some((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity);
    const s = sig(); same = !busy && s === last ? same + 1 : 0; last = s;
  }
}).catch(() => {});
const fit = async (f) => { await settle(f); await f.locator('button[aria-label="Fit to Window"]').first().click({ timeout: 3000 }).catch(() => {}); await settle(f); };
// Move the mouse off the board so no hover state (card toolbar, tooltips) is captured
const park = async (page) => { await page.mouse.move(2, 400, { steps: 4 }); await sleep(400); };
const boardShot = async (page, f, file) => {
  const box = await (await f.frameElement()).boundingBox();
  await page.screenshot({ path: path.join(OUT, file), clip: box ?? undefined });
  console.log(`  📷 ${file}`);
};
const card = (f, title) => f.locator(".card", { has: f.locator(".chead .ctitle", { hasText: new RegExp(`^${title.replace(/\./g, "\\.")}$`) }) });
// Click empty board space and clear the selection (no selection outline or align toolbar in the shots)
const blank = async (f) => { await f.locator("#board").click({ position: { x: 30, y: 300 } }); await f.page().keyboard.press("Escape"); };

(async () => {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.CDP_PORT || 9223}`); } catch { await sleep(1000); } }
  if (!browser) throw new Error("cannot connect to VS Code");
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench"));
    if (!page) await sleep(1000);
  }
  if (!page) throw new Error("VS Code main window not found");
  await sleep(6000);

  // Board: LLMEngine.step with schedule and postprocess expanded, one level deeper into allocate, a Sidenote and a Note
  await command(page, "View: Close Primary Side Bar");
  await openFile(page, "llm_engine.py", 51);
  await page.keyboard.press("Alt+b"); await sleep(2500);
  await command(page, "CodeBoard: Open Board");
  const f = await boardFrame(page); await sleep(1500);
  // The board fills the window while it is built (children are placed in the room the view has) and for the board shots
  await command(page, "View: Focus Second Editor Group");
  await command(page, "View: Toggle Maximize Editor Group");
  await fit(f);
  check(await card(f, "LLMEngine.step").count() === 1, "LLMEngine.step on the board");
  const expand = async (from, name) => {
    await blank(f); await sleep(300);
    await card(f, from).locator(".src .call", { hasText: new RegExp(`^${name}$`) }).first().click(); await sleep(1800);
  };
  await expand("LLMEngine.step", "schedule");
  await expand("LLMEngine.step", "postprocess");
  await expand("Scheduler.schedule", "allocate");
  check(await card(f, "BlockManager.allocate").count() === 1, "calls expanded two levels deep");
  // Sidenote (zoomed to the card: line numbers are not clickable in the zoomed-out overview)
  await fit(f); await card(f, "Scheduler.schedule").locator(".chead .ctitle").click(); await sleep(300);
  await page.keyboard.press("Shift+Digit2"); await sleep(1500); await settle(f);
  const sch = card(f, "Scheduler.schedule");
  await sch.locator(".no").nth(5).click(); await sch.locator(".no").nth(6).click({ modifiers: ["Shift"] });
  await page.keyboard.press("s"); await sleep(600);
  await f.locator(".pop button", { hasText: /^Text$/ }).click(); await sleep(200);
  await page.keyboard.type("Prefill admits waiting sequences until the token budget runs out.");
  await f.locator(".pop button", { hasText: /^Add$/ }).click(); await sleep(800);
  await page.keyboard.press("Escape"); await blank(f); await sleep(300);
  check(await sch.locator(".mk").count() >= 1, "Sidenote added");

  // Arrange: Scheduler.postprocess beside Scheduler.schedule, so the tree uses the width of the window
  const drag = async (title, to) => {
    const h = await card(f, title).locator(".chead").boundingBox();
    await page.mouse.move(h.x + 40, h.y + h.height / 2); await page.mouse.down();
    await page.mouse.move(to.x + 40, to.y + h.height / 2, { steps: 20 }); await page.mouse.up(); await sleep(600);
  };
  await blank(f); await fit(f);
  for (let i = 0; i < 2; i++) { await f.locator('button[aria-label="Zoom Out"]').first().click().catch(() => {}); await sleep(400); }
  await settle(f);
  const schBox = await card(f, "Scheduler.schedule").boundingBox();
  await drag("Scheduler.postprocess", { x: schBox.x + schBox.width + 30, y: schBox.y });
  // Note to the left of the root card, created under the mouse
  const root = await card(f, "LLMEngine.step").boundingBox();
  await blank(f); await page.mouse.move(Math.max(root.x - 140, 20), root.y + 4); await sleep(300);
  await page.keyboard.press("n"); await sleep(700);
  for (const line of ["## One engine step", "- **schedule** picks prefill or decode", "**run** executes the model on the batch", ""]) {
    await page.keyboard.type(line); await page.keyboard.press("Enter"); await sleep(150);
  }
  await page.keyboard.type("Tokens per step: $\\sum_i n_i \\le B$ "); await page.keyboard.press("Enter"); await sleep(150);
  await page.keyboard.type("```python"); await page.keyboard.press("Enter"); await sleep(200);
  await page.keyboard.type("seqs, is_prefill = schedule()"); await sleep(200);
  await page.keyboard.press("Escape"); await sleep(800);
  await page.keyboard.press("Escape"); await sleep(400);
  check(await f.locator(".card.note").count() === 1, "Note created");
  await blank(f); await fit(f); await park(page);

  if (SHOTS.includes("features")) {
    // 2. Expanding calls, layer by layer: the whole tree with its arrows and marks
    await boardShot(page, f, "2-expand.png");

    // 3. Definition Peek on can_allocate, zoomed to Scheduler.schedule
    await card(f, "Scheduler.schedule").locator(".chead .ctitle").click(); await sleep(300);
    await page.keyboard.press("Shift+Digit2"); await sleep(1500); await settle(f);
    await f.locator('button[aria-label="Zoom Out"]').first().click(); await settle(f);
    const call = card(f, "Scheduler.schedule").locator(".src .call", { hasText: /^can_allocate$/ }).first();
    await call.hover(); await sleep(2500);
    check(await f.locator(".pop.k-peek").count() === 1, "Definition Peek opens");
    await boardShot(page, f, "3-peek.png");
    const cb = await card(f, "Scheduler.schedule").boundingBox();
    await page.mouse.move(cb.x + cb.width + 40, cb.y + 20, { steps: 6 }); await page.mouse.move(5, 300, { steps: 12 }); await sleep(1500);

    // 5. Note and Sidenote: zoomed to the Note and Scheduler.schedule, the Sidenote always shown beside its lines
    await blank(f); await fit(f);
    await card(f, "Scheduler.schedule").locator(".mk").first().click(); await sleep(900);
    await f.locator(".pop button", { hasText: /^Always Show$/ }).click().catch(() => console.log("  ! no Always Show")); await sleep(800);
    await page.keyboard.press("Escape"); await blank(f); await sleep(300);
    await f.locator(".card.note .chead").first().click(); await sleep(200);
    await card(f, "Scheduler.schedule").locator(".chead .ctitle").click({ modifiers: ["Shift"] }); await sleep(200);
    await page.keyboard.press("Shift+Digit2"); await sleep(1500); await blank(f); await settle(f);
    await park(page);
    await boardShot(page, f, "5-notes.png");
    await page.keyboard.press("Escape"); await blank(f); await sleep(300);

    // 1. Overview: code on the left, the board on the right, the board given the larger share
    await command(page, "View: Toggle Maximize Editor Group");
    await openFile(page, "llm_engine.py", 49);
    const bx = await (await f.frameElement()).boundingBox();
    await page.mouse.move(bx.x - 2, bx.y + 300); await sleep(300); await page.mouse.down();
    await page.mouse.move(bx.x - 2 - bx.width * 0.35, bx.y + 300, { steps: 15 }); await page.mouse.up(); await sleep(800);
    await blank(f); await fit(f);
    for (const t of ["LLMEngine.step", "Scheduler.schedule", "Scheduler.postprocess"]) { await card(f, t).locator(".chead .ctitle").click({ modifiers: t === "LLMEngine.step" ? [] : ["Shift"] }); await sleep(200); }
    await page.keyboard.press("Shift+Digit2"); await sleep(1500); await blank(f); await settle(f); await park(page);
    if (await page.locator(".statusbar-item", { hasText: "Tab Moves Focus" }).count()) await command(page, "Toggle Tab Key Moves Focus");
    await park(page);
    await page.screenshot({ path: path.join(OUT, "1-overview.png") }); console.log("  📷 1-overview.png");
    await command(page, "View: Focus Second Editor Group");
    await command(page, "View: Toggle Maximize Editor Group");
    await fit(f);

    // 4. New version: commit a change to Scheduler.schedule; the card stays pinned to its commit and offers the diff
    const file = path.join(WS, "nanovllm/engine/scheduler.py");
    const src = fs.readFileSync(file, "utf8");
    const changed = src.replace(/(\n(\s+)def schedule\(self\)[^\n]*\n)/, "$1$2    # admit waiting sequences first, then fall back to decoding\n");
    check(changed !== src, "scheduler.py edited");
    fs.writeFileSync(file, changed);
    execSync(`git -C ${WS} -c user.name=dev -c user.email=dev@example.com commit -qam "Scheduler: comment the admission order"`);
    let isNew = 0;
    for (let i = 0; i < 30 && !(isNew = await card(f, "Scheduler.schedule").locator(".rev.new").count()); i++) await sleep(500);
    check(isNew > 0, "card shows New version");
    await f.locator('.banner button[aria-label="Dismiss"]').click().catch(() => {}); await sleep(300);
    await card(f, "Scheduler.schedule").locator(".rev.new").first().click(); await sleep(2000); await settle(f);
    await park(page);
    await boardShot(page, f, "4-new-version.png");
    // Keep the pinned version so the theme shots that follow show a plain board
    await f.locator(".pop button", { hasText: /^Keep / }).first().click().catch(() => page.keyboard.press("Escape")); await sleep(800);
  }

  if (SHOTS.includes("themes")) {
    // One shot per board theme of the same board, picked on the board's own Settings page
    fs.mkdirSync(path.join(OUT, "themes"), { recursive: true });
    for (const t of THEMES) {
      await blank(f); await sleep(200);
      await page.keyboard.press("Control+,"); await sleep(900);
      await f.locator(".st-sw", { hasText: t }).first().click(); await sleep(1200);
      await page.keyboard.press("Control+,"); await sleep(800);
      await fit(f); await park(page);
      await boardShot(page, f, `themes/${t.toLowerCase().replace(/ /g, "-")}.png`);
    }
  }
  console.log(failed ? `${failed} checks failed` : "all passed");
  await browser.close().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

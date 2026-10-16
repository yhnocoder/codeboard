// Drive VS Code through the main v0.1 flows, checking results and taking a screenshot at each step.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const [OUT, WS, UD] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what, extra) => { console.log(`${ok ? "✓" : "✗"} ${what}${!ok && extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : ""}`); if (!ok) failed++; };

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
  // Right after startup Quick Open may not have indexed files yet and Enter does nothing: confirm the file really opened, retry otherwise
  for (let i = 0; i < 5; i++) {
    await command(page, "View: Focus First Editor Group"); // code in the left group, board on the right (with the board focused, Ctrl+1 means 100% zoom)
    await page.keyboard.press("Control+p"); await sleep(500);
    await page.keyboard.type(name); await sleep(900 + i * 1000); await page.keyboard.press("Enter"); await sleep(900);
    if (await page.locator(`.editor-group-container .tab.active[aria-label*="${name}"], .editor-group-container .tab.active:has-text("${name}")`).count()) break;
    await page.keyboard.press("Escape"); await sleep(1500);
  }
  if (line) { await page.keyboard.press("Control+g"); await sleep(300); await page.keyboard.type(String(line)); await page.keyboard.press("Enter"); await sleep(400); }
}
// Each screenshot also runs the generic UI audit (tools/review/audit.cjs), collected in audit.json; with AUDIT_STRICT=1 issues count as failures
const { audit } = require("../../../tools/review/audit.cjs");
const audits = [];
// Before a screenshot wait for the board to settle (animations done, canvas still) and capture only the board, so unrelated changes like the VS Code status bar don't disturb the diff
const settle = (fr) => fr.evaluate(async () => {
  const sig = () => { const w = document.querySelector(".world"); return (w ? getComputedStyle(w).transform : "") + "|" + [...document.querySelectorAll(".card")].map((c) => { const r = c.getBoundingClientRect(); return `${r.x|0},${r.y|0},${r.width|0},${r.height|0}`; }).join(";") + "|" + (document.querySelector("#board")?.innerHTML.length ?? 0); }; // includes DOM size: late semantic highlighting also counts as not settled
  let last = "", same = 0;
  for (let i = 0; i < 80 && same < 14; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const busy = document.getAnimations().some((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity);
    const s = sig(); same = !busy && s === last ? same + 1 : 0; last = s;
  }
}).catch(() => {});
const shot = async (page, n) => {
  let fr = null;
  for (const x of page.frames()) if (await x.$("#board").catch(() => null)) { fr = x; break; }
  if (!fr) { await page.screenshot({ path: `${OUT}/${n}.png` }); return; }
  // Fit to window before every screenshot: card sizes may be measured after the earlier fit and the camera drifts between runs; fitting makes shots comparable
  // Skip while a popup or input is open (it would type "!" into the search box or close the popup we want to capture)
  const busy = await fr.evaluate(() => !!document.querySelector(".palette, .pop, .ctx, .dialog") || /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "") || !!document.activeElement?.isContentEditable);
  // Click the board's own Fit to Window button rather than the shortcut: keyboard focus may be in the code editor
  await settle(fr); if (!busy) { await fr.locator('button[aria-label="Fit to Window"]').first().click({ timeout: 3000 }).catch(() => {}); await settle(fr); }
  const box = await (await fr.frameElement()).boundingBox();
  await page.screenshot({ path: `${OUT}/${n}.png`, clip: box ?? undefined });
  const r = await audit(fr, n); audits.push(r);
  for (const i of r.issues) console.log(`  ⚠ ${n}: ${i.rule} — ${i.what}`);
  if (process.env.AUDIT_STRICT === "1") check(!r.issues.length, `${n} passes the UI audit`);
};
const card = (f, title) => f.locator(".card", { has: f.locator(".chead .ctitle", { hasText: new RegExp(`^${title.replace(/\./g, "\\.")}$`) }) });
const boardJson = () => {
  const d = execSync(`ls -d ${UD}/User/workspaceStorage/*/*codeboard*/boards 2>/dev/null || true`).toString().trim().split("\n")[0];
  if (!d) return null;
  const f = fs.readdirSync(d).find((n) => n.endsWith(".json"));
  return f ? JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) : null;
};

(async () => {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP("http://127.0.0.1:9223"); } catch { await sleep(1000); } }
  if (!browser) throw new Error("cannot connect to VS Code");
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench"));
    if (!page) await sleep(1000);
  }
  if (!page) throw new Error("VS Code main window not found");
  await sleep(6000);
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && /codeboard|board\.js/i.test(m.text())) errors.push(m.text()); });

  // 1. Alt+B inside a function: the board opens and the function becomes the first card
  await openFile(page, "llm_engine.py", 51);
  await page.keyboard.press("Alt+b"); await sleep(2500);
  // With no board open Alt+B only saves and shows a notice; open the board to see the result
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page); await sleep(1500);
  check(await card(f, "LLMEngine.step").count() === 1, "Alt+B puts LLMEngine.step on the board");
  const nCalls = await f.locator(".card .src .call").count();
  check(nCalls >= 3, "calls in the card are clickable", await f.locator(".card .src .call").allTextContents());
  check(await f.locator(".card .src .kw").count() > 3, "code is syntax highlighted");
  await shot(page, "1-first-card");

  // 2. Click schedule: expands Scheduler.schedule, numbered 1, with a call link
  await card(f, "LLMEngine.step").locator(".src .call", { hasText: /^schedule$/ }).first().click(); await sleep(1800);
  check(await card(f, "Scheduler.schedule").count() === 1, "clicking schedule expands Scheduler.schedule");
  check((await card(f, "Scheduler.schedule").locator(".step").textContent().catch(() => "")) === "1", "child card numbered 1");
  check(await f.locator("path.edge").count() >= 1, "call link drawn");
  // 3. Click postprocess: numbered 2
  await f.locator("#board").click({ position: { x: 30, y: 300 } }); await sleep(300);
  await card(f, "LLMEngine.step").locator(".src .call", { hasText: /^postprocess$/ }).first().click(); await sleep(1800);
  check(await card(f, "Scheduler.postprocess").count() === 1, "clicking postprocess expands it");
  await f.locator("#board").click({ position: { x: 30, y: 300 } }); await sleep(300);
  await page.keyboard.press("Shift+!"); await sleep(900);
  await shot(page, "2-flow");

  // 4. Definition Peek: hover can_allocate
  const sch = card(f, "Scheduler.schedule");
  await sch.locator(".src .call", { hasText: /^can_allocate$/ }).first().hover(); await sleep(2500);
  check(await f.locator(".pop.k-peek").count() === 1, "hovering a name opens Definition Peek");
  await shot(page, "3-peek");
  await page.mouse.move(5, 500); await sleep(800);

  // 5. Sidenote: select two lines, press S, write a sentence
  await sch.locator(".no").nth(5).click(); await sch.locator(".no").nth(6).click({ modifiers: ["Shift"] });
  await page.keyboard.press("s"); await sleep(600);
  await f.locator(".pop button", { hasText: /^Text$/ }).click(); await sleep(200);
  await page.keyboard.type("Prefill admits seqs until the token budget runs out.");
  await f.locator(".pop button", { hasText: /^Add$/ }).click(); await sleep(800);
  check(await sch.locator(".mk").count() >= 1, "Sidenote marker appears beside the lines");
  await shot(page, "4-sidenote");

  // 6. ⌘K search for allocate, ↵ puts it on the board
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k"); await sleep(600);
  await page.keyboard.type("BlockManager.allocate"); await sleep(1500);
  check(await f.locator(".palette .cand").count() > 0, "search returns results");
  await shot(page, "5-search");
  await page.keyboard.press("Enter"); await sleep(1800);
  check(await card(f, "BlockManager.allocate").count() === 1, "BlockManager.allocate placed from search");

  // 7. Note
  await page.mouse.move(700, 700);
  await page.keyboard.press("Escape"); await sleep(200);
  await page.keyboard.press("n"); await sleep(500);
  await page.keyboard.type("**Takeaway**: schedule → run → postprocess"); await page.keyboard.press("Escape"); await sleep(600);
  check(await f.locator(".card.note").count() === 1, "new Note created");
  await page.keyboard.press("Shift+!"); await sleep(900);
  await shot(page, "6-board");

  // 8. Autosave
  await sleep(2000);
  const b = boardJson();
  check(b && b.version === 2 && b.cards.length >= 5 && b.links.length >= 2 && b.sidenotes.length === 1, "board autosaved (v2 format)", b && { cards: b.cards.length, links: b.links.length, notes: b.sidenotes?.length });

  // 9. Edit code in the editor: the card shows + uncommitted (nothing committed to git)
  await openFile(page, "scheduler.py", 30);
  await page.keyboard.press("End"); await page.keyboard.type("  # local edit"); await page.keyboard.press("Control+s"); await sleep(3500);
  check(await f.locator(".rev.unc").count() >= 1, "card shows + uncommitted after a local edit");
  await shot(page, "7-uncommitted");

  check(!errors.length, "no webview errors", errors.slice(0, 3));
  fs.writeFileSync(`${OUT}/audit.json`, JSON.stringify(audits, null, 1));
  console.log(failed ? `${failed} checks failed` : "all passed");
  await browser.close().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

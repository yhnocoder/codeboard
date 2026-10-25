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
const { audit, report } = require("../../../tools/review/audit.cjs");
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
// A spot on empty canvas inside the board frame (frame coordinates): where cards land depends on the layout, so pick it rather than hard-code it
const emptySpot = (f) => f.evaluate(() => {
  const b = document.querySelector("#board").getBoundingClientRect();
  for (let y = b.top + 60; y < b.bottom - 120; y += 20) for (let x = b.left + 40; x < b.right - 40; x += 20) {
    const t = document.elementFromPoint(x, y);
    if (t && !t.closest(".card, .pop, .ctx, .dock, .bbar, .pill, .sec, .crumbs, svg [data-link]")) return { x: x - b.left, y: y - b.top };
  }
  return { x: 30, y: 300 };
});
const card = (f, title) => f.locator(".card", { has: f.locator(".chead .ctitle", { hasText: new RegExp(`^${title.replace(/\./g, "\\.")}$`) }) });
const boardJson = () => {
  const d = execSync(`ls -d ${UD}/User/workspaceStorage/*/*codeboard*/boards 2>/dev/null || true`).toString().trim().split("\n")[0];
  if (!d) return null;
  const f = fs.readdirSync(d).find((n) => n.endsWith(".json"));
  return f ? JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) : null;
};

// 13. Capture Run（线框 13）：跑一次工作区里的小脚本（nano-vllm 要 torch，这里没有），tracer 只记 Study Scope 里的调用；
// 白板上已有的 Call 箭头变 Observed，没有箭头的调用列在 Run 面板里。E2E_ONLY=capture 只跑这一步
async function captureStep(page) {
  fs.writeFileSync(path.join(WS, "e2e_capture.py"), [
    "def leaf(x):", "    return x * 2", "", "",
    "def mid(xs):", "    out = []", "    for x in xs:", "        out.append(leaf(x))", "    return out", "", "",
    "def main():", "    print(sum(mid([1, 2, 3])))", "", "",
    'if __name__ == "__main__":', "    main()", "",
  ].join("\n"));
  await sleep(1500);
  await openFile(page, "e2e_capture.py", 8);
  await page.keyboard.press("Alt+b"); await sleep(2500);
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page); await sleep(1500);
  check(await card(f, "mid").count() === 1, "Alt+B puts mid on the board");
  await command(page, "CodeBoard: Capture Run");
  await page.keyboard.press("Control+a"); await page.keyboard.type("e2e_capture.py"); await page.keyboard.press("Enter");
  let panel = 0;
  for (let i = 0; i < 40 && !panel; i++) { await sleep(500); f = await boardFrame(page); panel = await f.locator(".cpanel.runp").count(); }
  check(panel === 1, "Capture Run opens the Run panel on the board");
  const runs = execSync(`ls -d ${UD}/User/workspaceStorage/*/*codeboard*/boards/runs 2>/dev/null || true`).toString().trim().split("\n")[0];
  const recs = runs ? fs.readdirSync(runs).filter((n) => n.endsWith(".json")) : [];
  check(recs.length === 1, "the run record is saved under <storageDir>/runs/", runs);
  const rec = recs.length ? JSON.parse(fs.readFileSync(path.join(runs, recs[0]), "utf8")) : null;
  check(rec && rec.version === 1 && rec.exit === 0 && rec.calls.some((c) => c.to.qual === "leaf" && c.count === 3), "the record has leaf called 3 times", rec && rec.calls.map((c) => [c.to.qual, c.count]));
  check(!fs.existsSync(path.join(WS, "sitecustomize.py")), "nothing written into the workspace");
  const rows = await f.locator(".cpanel.runp .rrow").allTextContents();
  check(rows.some((r) => /e2e_capture\.py:8.*leaf.*3×/.test(r)) && rows.some((r) => /e2e_capture\.py:13.*mid/.test(r)), "calls with no arrow are listed in the Run panel", rows);
  // mid 在白板上：Add 建 leaf 卡和一条已经是 Observed 的 Call 箭头
  await f.locator(".cpanel.runp .rrow", { hasText: "leaf" }).first().locator(".radd").click(); await sleep(3000);
  check(await card(f, "leaf").count() === 1, "Add puts leaf on the board");
  check(await f.locator(".ev-tag.observed").count() === 1 && /3/.test(await f.locator(".ev-tag.observed").first().textContent().catch(() => "")), "the new mid → leaf Call arrow is Observed · 3×");
  const b = boardJson();
  check(b && b.links.some((l) => l.call && l.call.ev && l.call.ev.kind === "observed" && l.call.ev.count === 3), "the Observed evidence is saved with the board");
  await shot(page, "11-capture-run");
}
// 08. 导出 HTML 快照：⋯ → Export… → HTML Snapshot，存盘用 VS Code 自己的简易对话框（run.sh 打开 files.simpleDialog；原生对话框在 CDP 里够不着），
// 再在 e2e 的 Chromium 里打开导出的文件：离线、只读、能拖能缩放。E2E_ONLY=export 只跑这一步
async function exportStep(page) {
  await openFile(page, "scheduler.py", 26);
  await page.keyboard.press("Alt+b"); await sleep(2500);
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page); await sleep(1500);
  check(await f.locator(".card").count() >= 1, "Alt+B puts a card on the board");
  await command(page, "Notifications: Clear All Notifications");
  // 白板在右边一栏、比较窄：底栏和 dock 在同一行、不叠在一起（叠了就点不到 More；很窄时 dock 并进底栏）
  const pills = await f.evaluate(() => [...document.querySelectorAll(".bbar .pill, .dock .pill")].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom]; }));
  const [bb, dk] = pills;
  check(!dk || ((bb[1] <= dk[0] || dk[1] <= bb[0]) && bb[2] < dk[3] && dk[2] < bb[3]), "the bottom bar and the dock sit in one row without overlapping in a narrow pane", { pills });
  await f.locator('button[aria-label="More"]').first().click(); await sleep(400);
  await f.locator(".ctx :is(button,div,li)", { hasText: /^Export…/ }).first().click(); await sleep(600);
  check(await f.locator(".dialog.xdlg").count() === 1, "Export… opens the export dialog");
  await f.locator(".dialog.xdlg .seg button", { hasText: "HTML Snapshot" }).click();
  await shot(page, "12-export-dialog");
  await f.locator(".dialog.xdlg button.def").click();
  const out = path.join(WS, "e2e-export.html");
  const input = page.locator(".quick-input-widget input.input");
  await input.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(await input.isVisible().catch(() => false), "the save dialog appears");
  await input.fill(out); await sleep(300); await page.keyboard.press("Enter");
  for (let i = 0; i < 40 && !fs.existsSync(out); i++) await sleep(500);
  check(fs.existsSync(out), "the snapshot is written", out);
  if (!fs.existsSync(out)) return;
  const html = fs.readFileSync(out, "utf8");
  check(!/cbres:/.test(html) && /data:font\/woff2;base64/.test(html), "fonts are inlined, no unresolved references", html.length);
  // VS Code 的 CDP 连接开不了新上下文：另起一个和 harness 同一个 Chromium，断网打开
  const vb = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const ctx = await vb.newContext({ offline: true, viewport: { width: 1400, height: 900 } }); const v = await ctx.newPage();
  const net = [], errs = [];
  v.on("request", (r) => { if (!/^(file|data|about):/.test(r.url())) net.push(r.url()); });
  v.on("pageerror", (e) => errs.push(String(e)));
  await v.goto("file://" + out); await sleep(1200);
  check(await v.locator(".card").count() >= 1, "the snapshot renders the cards", await v.locator(".card").count());
  check(await v.locator(".card .src .kw").count() > 0, "code in the snapshot is highlighted");
  const before = await v.evaluate(() => getComputedStyle(document.querySelector(".world")).transform);
  await v.mouse.move(300, 600); await v.mouse.down(); await v.mouse.move(420, 660, { steps: 6 }); await v.mouse.up(); await sleep(300);
  check(before !== await v.evaluate(() => getComputedStyle(document.querySelector(".world")).transform), "the snapshot pans by drag");
  check(!net.length && !errs.length, "no network requests and no errors in the snapshot", { net: net.slice(0, 3), errs: errs.slice(0, 3) });
  await v.screenshot({ path: `${OUT}/13-export-html.png` });
  await vb.close().catch(() => {});
  fs.rmSync(out, { force: true }); // 后面的步骤要看干净的 git status
}
// 07. 我的改动：同一仓库的另一个 worktree（git worktree add，含未提交改动）在 Add Variant 菜单里自动列出；加上后卡上有标签页和 MINE，
// 在那个 worktree 里改文件（VS Code 外面），卡上的代码跟着刷新。E2E_ONLY=variants 只跑这一步
async function variantsStep(page) {
  const WT = path.join(path.dirname(WS), "ws-exp");
  execSync(`git -C "${WS}" -c user.email=t@t -c user.name=t worktree add -q "${WT}" -b exp-overlap`);
  const file = path.join(WT, "nanovllm/engine/scheduler.py");
  const orig = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, orig.replace("        scheduled_seqs = []\n", "        scheduled_seqs = list()  # keep order\n        budget = self.max_num_batched_tokens\n"));
  await openFile(page, "scheduler.py", 26);
  // 同一个 job 里前面的步骤（export）可能已经放过 Scheduler.schedule：这次放上来的是排在最后的那张
  let had = 0;
  for (const f0 of page.frames()) { try { if (await f0.$("#board")) had = await card(f0, "Scheduler.schedule").count(); } catch {} }
  await page.keyboard.press("Alt+b"); await sleep(2500);
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page); await sleep(1500);
  const sch = card(f, "Scheduler.schedule").last();
  check(await card(f, "Scheduler.schedule").count() === had + 1, "Alt+B puts Scheduler.schedule on the board", { had });
  await sch.locator(".chead").click({ button: "right", position: { x: 140, y: 12 } }); await sleep(500);
  await f.locator(".ctx button", { hasText: /^Add Variant…/ }).click(); await sleep(1500);
  const items = await f.locator(".ctx button").allTextContents();
  check(items.some((t) => /Other Worktree.*exp-overlap · \.\.\/ws-exp/.test(t)), "Add Variant lists the other worktree", items);
  await shot(page, "14-add-variant-menu");
  await f.locator(".ctx button", { hasText: /Other Worktree/ }).click(); await sleep(2500);
  const tabs = await sch.locator(".vtab:not(.vadd)").allTextContents();
  check(tabs.length === 2 && /ws-exp/.test(tabs[1]), "the card has an Upstream tab and the worktree tab", tabs);
  check(await sch.locator(".chead .mine").count() === 1, "MINE shows on the card");
  check((await sch.locator(".vmk").allTextContents()).join("") === "~+", "the changed and added lines are marked", await sch.locator(".vmk").allTextContents());
  await sleep(1200);
  const b = boardJson();
  const c = b && b.cards.find((k) => k.kind === "code" && k.variants);
  check(c && c.variants.length === 2 && c.variants[1].from.kind === "wt" && c.variants[1].from.dir === WT && c.segments[0].src.kind === "external", "the variant is saved with the card", c && c.variants);
  await shot(page, "15-variant-worktree");
  // 在 worktree 里再改一下（VS Code 外面）：卡跟着刷新
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("        num_batched_tokens = 0\n", "        num_batched_tokens = 0  # tuned\n"));
  let live = false;
  for (let i = 0; i < 30 && !live; i++) { await sleep(500); f = await boardFrame(page); live = /# tuned/.test(await card(f, "Scheduler.schedule").last().locator(".src").textContent().catch(() => "")); }
  check(live, "editing the worktree file refreshes the variant on the card");
  // 切回上游：代码换回来、MINE 没了
  await card(f, "Scheduler.schedule").last().locator(".vtab.up").click(); await sleep(600);
  check(await card(f, "Scheduler.schedule").last().locator(".chead .mine").count() === 0 && !/keep order/.test(await card(f, "Scheduler.schedule").last().locator(".src").textContent()), "switching back to Upstream shows the upstream code");
}
// ⌥B 选中跨几个定义的代码（context.py 5–27：dataclass、_CONTEXT = Context()、三个函数）：默认一张多段卡，一行不丢；
// 焦点留在编辑器，紧接着 ⌘Z / Ctrl+Z 撤销这次添加（编辑器里没改过字时）；⇧⌥B 一个定义一张卡。E2E_ONLY=addsel 只跑这一步
async function addselStep(page) {
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page); await sleep(1000);
  const n0 = await f.locator(".card").count();
  await openFile(page, "context.py", 5);
  for (let i = 0; i < 22; i++) await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End"); await sleep(300);
  await page.keyboard.press("Alt+b"); await sleep(2500);
  f = await boardFrame(page);
  const one = f.locator(".card", { hasText: "5 segments" });
  check(await f.locator(".card").count() === n0 + 1 && await one.count() === 1, "Alt+B over five definitions makes one card with five segments", { n0, n: await f.locator(".card").count() });
  const body = (await one.locator(".src").textContent().catch(() => "")) ?? "";
  check(/@dataclass\(slots=True\)/.test(body) && /block_tables: torch\.Tensor/.test(body) && /_CONTEXT = Context\(\)/.test(body) && /def reset_context/.test(body), "…with the decorator, the fields and the module line between", body.slice(0, 200));
  check(await one.locator(".src .gap").count() === 4, "…and a separator at every segment boundary", await one.locator(".src .gap").allTextContents());
  // No screenshot here: shot() clicks the board's Fit to Window button, which moves keyboard focus into the board,
  // and then Ctrl+Z would be the board's own undo instead of the editor's codeboard.undoAdd we want to test
  // focus is still in the editor: Ctrl+Z (⌘Z) undoes the add on the board, the editor text is untouched
  check(await page.locator(".editor-group-container .monaco-editor.focused").count() === 1, "focus stays in the editor after Alt+B");
  const textBefore = await page.locator(".editor-group-container .monaco-editor .view-lines").first().textContent();
  await page.keyboard.press("Control+z"); await sleep(1500);
  f = await boardFrame(page);
  check(await f.locator(".card").count() === n0, "Ctrl+Z right after Alt+B (focus in the editor) removes the card from the board", await f.locator(".card").count());
  // the board's toast says it came from the editor's undoAdd (the board's own Ctrl+Z shows no toast)
  check(/Removed the card just added/.test(await f.locator(".toast").textContent().catch(() => "")), "…through the editor's undo-add (the board says so)", await f.locator(".toast").textContent().catch(() => ""));
  check(await page.locator(".editor-group-container .monaco-editor .view-lines").first().textContent() === textBefore, "…and does not undo anything in the editor");
  await page.keyboard.press("Shift+Alt+b"); await sleep(2500);
  f = await boardFrame(page);
  check(await f.locator(".card").count() === n0 + 5 && await card(f, "Context").count() === 1 && await card(f, "reset_context").count() === 1, "Shift+Alt+B makes one card per definition (and one for the module line)", await f.locator(".card .ctitle").allTextContents());
  check(/is_prefill: bool = False/.test(await card(f, "Context").locator(".src").textContent().catch(() => "")), "the Context card shows its fields");
  await shot(page, "17-addsel-separate");
  // a screenshot of the one-card result too: Alt+B again from the editor (the selection is unchanged)
  await command(page, "View: Focus First Editor Group");
  await page.keyboard.press("Alt+b"); await sleep(2500);
  await shot(page, "16-addsel-one-card");
}

// Closing the board tab right after a change keeps the change (the board sends each change at once, the host finishes the write when
// the panel closes): Wrap Lines followed by closing the tab within 0.1 s, then a typed Text card whose tab closes as soon as its text
// is on the board. E2E_ONLY=close runs only this step
async function closeStep(page) {
  if (process.env.E2E_ONLY === "close") { await openFile(page, "llm_engine.py", 51); await page.keyboard.press("Alt+b"); await sleep(2500); }
  const dir = () => execSync(`ls -d ${UD}/User/workspaceStorage/*/*codeboard*/boards 2>/dev/null || true`).toString().trim().split("\n")[0];
  const named = (name) => fs.readdirSync(dir()).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(fs.readFileSync(path.join(dir(), n), "utf8"))).find((b) => b.name === name);
  const closeTab = (name) => page.locator(".tabs-container .tab", { hasText: name }).first().click({ button: "middle", force: true });
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page); await sleep(1500);
  const name = (await page.locator(".editor-group-container.active .tab.active").first().textContent()).trim();
  // a code card that is drawn (not hidden in a collapsed call tree) and on screen
  const shown = await f.evaluate(() => { const b = document.querySelector("#board").getBoundingClientRect(); return [...document.querySelectorAll(".card[data-id]")].filter((e) => { const r = e.getBoundingClientRect(); return r.top >= b.top && r.top + 20 < b.bottom && r.left >= b.left && r.left + 140 < b.right; }).map((e) => e.dataset.id); });
  const code = named(name)?.cards.find((c) => c.kind === "code" && shown.includes(c.id));
  check(!!code, "closeStep: the open board has a code card", name);
  if (!code) return;
  // select it by its title: the file path next to it opens the code in the editor (and the keys would go there)
  await f.locator(`.card[data-id="${code.id}"] .chead .ctitle`).first().click(); await sleep(500);
  await page.keyboard.press("Alt+z"); await sleep(100);
  await closeTab(name); await sleep(2000);
  const wrapped = named(name)?.cards.find((c) => c.id === code.id)?.wrap;
  check(!!wrapped !== !!code.wrap, "closing the board tab right after Wrap Lines keeps the change", { before: !!code.wrap, after: !!wrapped });
  await command(page, "CodeBoard: Open Board");
  f = await boardFrame(page); await sleep(1500);
  await f.locator("#board").click({ position: { x: 30, y: 300 } }); await sleep(300);
  // t: a new Text card in edit mode; type only once its editor is there and has the keyboard focus
  await page.keyboard.press("t");
  const editing = await f.waitForFunction(() => !!document.activeElement?.closest(".card[data-id] .md-pm"), null, { timeout: 5000 }).then(() => true, () => false);
  check(editing, "closeStep: t created a Text card with its editor focused", await f.evaluate(() => ({ active: document.activeElement?.className, editors: document.querySelectorAll(".md-pm").length })).catch((e) => String(e)));
  if (!editing) return;
  await page.keyboard.type("typed then closed"); await page.keyboard.press("Escape");
  const escAt = Date.now();
  // the board shows the text on the card (editing ended); the tab closes right then
  const shownText = await f.waitForFunction(() => [...document.querySelectorAll(".card[data-id]")].some((e) => !e.querySelector(".md-pm") && e.textContent.includes("typed then closed")), null, { timeout: 2000, polling: 20 }).then(() => true, () => false);
  check(shownText, "closeStep: the typed text is on the board before closing", await f.evaluate(() => [...document.querySelectorAll(".card[data-id]")].map((e) => e.textContent.slice(0, 40))).catch((e) => String(e)));
  const closeAfter = Date.now() - escAt;
  await closeTab(name); await sleep(2000);
  const notes = (named(name)?.cards ?? []).filter((c) => c.kind === "note").map((c) => c.md);
  check(notes.includes("typed then closed"), "closing the board tab right after typing a Text card keeps the text", { notes, closeAfterMs: closeAfter });
  await command(page, "CodeBoard: Open Board"); await sleep(1500);
}

// Clicking a card takes keyboard focus from a file editor: select text in context.py, click a card (its header, then its code),
// press Backspace. The card is deleted and the file is untouched. E2E_ONLY=cardfocus runs only this step
async function cardfocusStep(page) {
  // context.py on the left, the board on the right (run alone, the board opens in the file's group: move it)
  await openFile(page, "context.py", 18);
  await command(page, "CodeBoard: Open Board");
  if (await page.locator(".editor-group-container").count() < 2) await command(page, "View: Move Editor into Right Group");
  let f = await boardFrame(page); await sleep(1000);
  if (!(await card(f, "get_context").count())) {
    await openFile(page, "context.py", 18);
    await page.keyboard.press("Alt+b"); await sleep(2500);
    f = await boardFrame(page);
  }
  const editorText = () => page.locator(".editor-group-container .monaco-editor .view-lines").first().textContent();
  const dirty = () => page.locator(".tabs-container .tab.dirty").count();
  for (const [where, sel] of [["header", ".chead .ctitle"], ["code", ".src"]]) {
    f = await boardFrame(page);
    const n0 = await f.locator(".card").count();
    check(await card(f, "get_context").count() === 1, `get_context is on the board before the ${where} click`);
    await shot(page, `18-cardfocus-${where}`);
    // shot() fits the whole board, which after the earlier steps is the map zoom: card faces are hidden there and the enlarged
    // map labels can cover neighbouring cards. Go to 100% (the board's zoom button), then Reveal on Board from get_context
    // pans the board to that card
    await f.locator(".zoom").first().click(); await sleep(800);
    await openFile(page, "context.py", 18);
    await command(page, "CodeBoard: Reveal on Board"); await sleep(1500);
    f = await boardFrame(page);
    check(!/lo-map|lo-ov/.test(await card(f, "get_context").getAttribute("class")), `get_context is shown at full detail before the ${where} click`, await card(f, "get_context").getAttribute("class"));
    await openFile(page, "context.py", 21);
    await page.keyboard.press("Shift+ArrowDown"); await page.keyboard.press("Shift+ArrowDown"); await sleep(300);
    const before = await editorText();
    // click a point of the header / code that is really this card's (another card may still overlap part of it)
    const target = card(f, "get_context").locator(sel).first();
    const pt = await target.evaluate((el) => {
      const r = el.getBoundingClientRect(), me = el.closest(".card");
      const others = [...document.querySelectorAll(".card")].filter((c) => c !== me && !c.contains(me)).map((c) => c.getBoundingClientRect())
        .filter((o) => o.left < r.right && o.right > r.left && o.top < r.bottom && o.bottom > r.top).length;
      for (let y = 6; y < Math.min(r.height, 60); y += 4) for (let x = 10; x < Math.min(r.width, 300); x += 10) {
        const t = document.elementFromPoint(r.left + x, r.top + y);
        if (t && el.contains(t) && t.closest(".card") === me) return { x, y, others };
      }
      return { x: -1, y: -1, others, lod: me.className };
    });
    check(pt.x >= 0, `part of get_context's ${where} is exposed after Reveal on Board`, pt);
    if (pt.others) console.log(`  (get_context's ${where} overlaps ${pt.others} other card(s) on screen)`);
    await target.click({ position: { x: pt.x, y: pt.y }, timeout: 5000 }).catch((e) => console.log("  click failed:", e.message.split("\n")[0])); await sleep(600);
    check(await page.locator(".editor-group-container .monaco-editor.focused").count() === 0, `clicking the card's ${where} takes focus from the file editor`);
    await page.keyboard.press("Backspace"); await sleep(1200);
    f = await boardFrame(page);
    check(await editorText() === before && !(await dirty()), `…Backspace leaves the selected text in context.py alone (${where})`);
    check(await f.locator(".card").count() === n0 - 1 && await card(f, "get_context").count() === 0, `…and deletes the card (${where})`, await f.locator(".card").count());
    // the board has focus, so Ctrl+Z is the board's own undo: the card comes back
    await page.keyboard.press("Control+z"); await sleep(1200);
    f = await boardFrame(page);
    check(await card(f, "get_context").count() === 1, `…and Ctrl+Z on the board brings it back (${where})`);
  }
  // codeboard.editorMarks applies right away: "lens" drops the bar next to the line numbers, "off" also the CodeLens
  await openFile(page, "context.py", 18);
  const UDS = path.join(UD, "User/settings.json");
  const settings0 = fs.readFileSync(UDS, "utf8");
  const marksNow = async () => { await sleep(2000); return { bar: await page.locator(".editor-group-container .monaco-editor .margin [class*='ced-']").count(), lens: await page.locator(".editor-group-container .codelens-decoration").count() }; };
  const setMarks = (v) => fs.writeFileSync(UDS, settings0.replace(/\}\s*$/, `, "codeboard.editorMarks": "${v}" }`));
  const all = await marksNow();
  setMarks("lens"); const lens = await marksNow();
  setMarks("off"); const off = await marksNow();
  fs.writeFileSync(UDS, settings0); const back = await marksNow();
  check(all.bar > 0 && all.lens > 0 && lens.bar === 0 && lens.lens > 0 && off.bar === 0 && off.lens === 0 && back.bar > 0 && back.lens > 0, "codeboard.editorMarks all / lens / off switches the bar and the CodeLens live", { all, lens, off, back });
}

// PR9 编辑代码：Free code 卡用 CodeMirror 编辑，补全 / 签名提示来自 VS Code 的语言服务（Pylance）。虚拟文档是白板上同语言代码
// 旁边的隐藏文件（这里是 nanovllm/engine/.codeboard-scratch-<卡>.py），import 按那个目录找；git status 里看不到，编辑完就删掉，
// 也不会冒出未保存的标签页（重新加载窗口后也没有）。要 E2E_EXTENSIONS 里有 Pylance。E2E_ONLY=codeedit 只跑这一步
async function codeeditStep(page) {
  await openFile(page, "llm_engine.py", 51);
  await page.keyboard.press("Alt+b"); await sleep(2500);
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page); await sleep(2500);
  await f.locator("#board").click({ button: "right", position: { x: 80, y: 560 } }); await sleep(600);
  await f.locator(".ctx button", { hasText: /^New Code/ }).first().click(); await sleep(1500);
  check(await f.locator(".card .cm-content").count() === 1, "New Code opens a CodeMirror editor on the card");
  await sleep(4000); // Pylance 先起来
  const type = async (t) => { await page.keyboard.type(t, { delay: 40 }); };
  // Esc 先关看得见的补全菜单和签名提示，什么都没开时 Esc 退出编辑：所以只在开着时按。等补全问完宿主再看
  const closePopups = async () => { await sleep(800); for (let i = 0; i < 3 && await f.locator(".cbcm-ac li, .cbcm-sig").count(); i++) { await page.keyboard.press("Escape"); await sleep(200); } };
  const line = async (t) => { await type(t); await closePopups(); await page.keyboard.press("Enter"); }; // 补全菜单开着时 Enter 会接受补全
  const menu = async () => { await f.locator(".cbcm-ac li").first().waitFor({ timeout: 8000 }).catch(() => {}); await sleep(500); return f.locator(".cbcm-ac li .cm-completionLabel").allTextContents().catch(() => []); };
  /** 打 t，等菜单里出现 want；没有就删掉、等语言服务分析完再试 */
  const ask = async (t, want) => {
    let items = [];
    for (let i = 0; i < 4 && !items.includes(want); i++) {
      if (i) { await closePopups(); for (let k = 0; k < t.length; k++) await page.keyboard.press("Backspace"); await sleep(2500); }
      await type(t); items = await menu();
    }
    return items;
  };
  await line("import os");
  await line("from nanovllm.engine.block_manager import BlockManager");
  await line("from .scheduler import Scheduler");
  const scratch = path.join(WS, "nanovllm/engine");
  const hidden = fs.readdirSync(scratch).filter((n) => n.startsWith(".codeboard-"));
  const status = execSync(`git -C "${WS}" status --porcelain`).toString().trim();
  check(hidden.length === 1 && !status, "the virtual document is a hidden file next to the source, not in git status", { hidden, status });
  const items = await ask("os.pat", "path");
  check(items.includes("path"), "typing os.pat shows Pylance's completion menu with path", items.slice(0, 8));
  await shot(page, "16-codeedit-completion");
  await page.keyboard.press("Tab"); await sleep(300);
  await type(".join(");
  await f.locator(".cbcm-sig").first().waitFor({ timeout: 8000 }).catch(() => {});
  const sig = await f.locator(".cbcm-sig-l").textContent().catch(() => "");
  check(/^\(a: StrPath|join|path/.test(sig), "typing os.path.join( shows signature help", sig);
  await shot(page, "17-codeedit-signature");
  await closePopups(); await line("'a')");
  const abs = await ask("BlockManager.", "allocate");
  check(abs.includes("allocate"), "an absolute import from the workspace resolves (BlockManager. lists allocate)", abs.slice(0, 8));
  await closePopups(); await line("allocate");
  const rel = await ask("Scheduler.", "schedule");
  check(rel.includes("schedule"), "a relative import next to the source resolves (Scheduler. lists schedule)", rel.slice(0, 8));
  await closePopups(); await type("schedule");
  await closePopups(); await page.keyboard.press("Escape"); await sleep(1500); // 退出编辑
  const b = boardJson();
  const fc = b && b.cards.find((k) => k.kind === "code" && k.segments[0].src.kind === "free");
  check(fc && fc.segments[0].text.join("\n").includes("os.path.join('a')"), "the edited code is saved on the card", fc && fc.segments[0].text);
  await sleep(1000);
  check(!fs.readdirSync(scratch).some((n) => n.startsWith(".codeboard-")), "the hidden file is deleted when editing ends");
  await command(page, "Developer: Reload Window"); await sleep(9000);
  const tabs = await page.locator(".tabs-container .tab").allTextContents().catch(() => []);
  check(!tabs.some((t) => /codeboard-|Untitled/.test(t)), "no leftover editor tab for the virtual document after reloading the window", tabs);
}
// Test images made in code (no binary fixtures): the harness's own helpers in packages/host/test/images.ts, bundled on the fly
let imagesMod = null;
const testImages = () => {
  if (imagesMod) return imagesMod;
  const { outputFiles } = require("esbuild").buildSync({ entryPoints: [path.join(__dirname, "../../../packages/host/test/images.ts")], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent" });
  const m = { exports: {} };
  new Function("module", "exports", "require", outputFiles[0].text)(m, m.exports, require);
  return (imagesMod = m.exports);
};
/** Change one entry of the user settings.json, as the Settings UI would (the extension listens and passes it on to the board) */
const setUserSetting = (key, value) => {
  const f = path.join(UD, "User/settings.json"), s = JSON.parse(fs.readFileSync(f, "utf8"));
  if (value === undefined) delete s[key]; else s[key] = value;
  fs.writeFileSync(f, JSON.stringify(s, null, 1));
};
const boardsDir = () => execSync(`ls -d ${UD}/User/workspaceStorage/*/*codeboard*/boards 2>/dev/null || true`).toString().trim().split("\n")[0];
const boardNamed = (name) => { const d = boardsDir(); return d ? fs.readdirSync(d).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(fs.readFileSync(path.join(d, n), "utf8"))).find((b) => b.name === name) : undefined; };
/** CodeBoard: New Board named `name`; returns its webview frame (a fresh webview, so nothing cached from earlier steps) */
async function newBoard(page, name) {
  const before = new Set();
  for (const x of page.frames()) if (await x.$("#board").catch(() => null)) before.add(x);
  // right after startup the command may not be registered yet (the extension still activating): try again
  for (let k = 0; k < 3; k++) {
    await command(page, "CodeBoard: New Board"); await sleep(600);
    await page.keyboard.press("Control+a"); await page.keyboard.type(name); await page.keyboard.press("Enter"); await sleep(2500);
    for (let i = 0; i < 20; i++) {
      for (const x of page.frames()) if (!before.has(x) && await x.$("#board").catch(() => null)) { await sleep(1000); return x; }
      await sleep(500);
    }
    await page.keyboard.press("Escape"); await sleep(1000);
  }
  throw new Error(`New Board ${name}: no new board webview`);
}
/** A new Note at an empty spot, in edit mode with its editor focused */
async function newNote(page, f) {
  const fb = await (await f.frameElement()).boundingBox(), sp = await emptySpot(f);
  await page.mouse.click(fb.x + sp.x, fb.y + sp.y); await sleep(300);
  await page.keyboard.press("n");
  return f.waitForFunction(() => !!document.activeElement?.closest(".card.note .md-pm"), null, { timeout: 5000 }).then(() => true, () => false);
}

// Images in Notes: a PNG pasted from the clipboard while editing a Note is saved by the host as a file under <storageDir>/assets/,
// the Markdown references assets/<file>, and the board shows it through the webview's resource address in display mode.
// The paste is a synthetic ClipboardEvent carrying the image file (what a screenshot on the clipboard gives the webview; xvfb has no
// image clipboard). E2E_ONLY=noteimage runs only this step
async function noteimageStep(page) {
  const f = await newBoard(page, "Note Images E2E");
  check(await newNote(page, f), "noteimage: n opens a new Note with its editor focused");
  await page.keyboard.type("Pasted screenshot:"); await page.keyboard.press("Enter");
  const { png } = testImages();
  const bytes = png(96, 64, (x, y) => (y < 14 ? [228, 226, 222, 255] : x < 24 ? [242, 240, 236, 255] : (y - 14) % 10 < 4 && x < 30 + ((y * 7) % 50) ? [60, 60, 70, 255] : [255, 255, 255, 255]));
  await f.evaluate((b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, bytes.toString("base64"));
  const inEdit = await f.waitForFunction(() => [...document.querySelectorAll(".card.note .md-pm img")].some((i) => i.complete && i.naturalWidth > 0), null, { timeout: 8000 }).then(() => true, () => false);
  check(inEdit, "noteimage: the pasted image shows in the Note being edited", await f.evaluate(() => [...document.querySelectorAll(".card.note .md-pm img")].map((i) => i.getAttribute("src"))).catch((e) => String(e)));
  await page.keyboard.press("Escape"); await sleep(2500);
  const md = (boardNamed("Note Images E2E")?.cards ?? []).find((c) => c.kind === "note")?.md ?? "";
  const ref = /!\[[^\]]*\]\((assets\/([0-9a-f]{16}-96x64\.png))\)/.exec(md);
  check(!!ref && !/base64/.test(md), "noteimage: the Markdown references assets/<file>, no inline data", md.slice(0, 200));
  const file = ref ? path.join(boardsDir(), ref[1]) : "";
  check(!!ref && fs.existsSync(file) && fs.readFileSync(file).equals(bytes), "noteimage: the image is saved under <storageDir>/assets/ byte for byte", { file, assets: fs.existsSync(path.join(boardsDir(), "assets")) ? fs.readdirSync(path.join(boardsDir(), "assets")) : [] });
  const shown = await f.waitForFunction(() => {
    const i = document.querySelector(".card.note .nbody:not(.editing) img");
    return i && i.complete && i.naturalWidth === 96 ? { src: i.getAttribute("src"), w: Math.round(i.getBoundingClientRect().width) } : null;
  }, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => null);
  check(!!shown && !/^assets\//.test(shown.src) && shown.w > 0, "noteimage: the board shows the saved image in display mode, through the webview resource address", shown);
  await shot(page, "19-note-pasted-image");
}

// Sticker folder: codeboard.stickerFolder points at a folder with a pack (a subfolder) holding a PNG and an animated GIF; both show in
// the picker under the pack's tab and place on the board. E2E_ONLY=stickerfolder runs only this step
async function stickerfolderStep(page) {
  const { png, gif, faceFrames } = testImages();
  const dir = path.join(path.dirname(WS), "stickers"), pack = path.join(dir, "E2E Pack");
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, "smile.png"), png(64, 64, faceFrames(64, [244, 192, 64, 255])[0]));
  const idx = (p) => (x, y) => { const c = p(x, y); return c[3] === 0 ? 0 : c[0] === 60 ? 2 : 1; };
  fs.writeFileSync(path.join(pack, "wink.gif"), gif(64, 64, [[0, 0, 0], [236, 120, 160], [60, 40, 30]], faceFrames(64, [236, 120, 160, 255]).map(idx), 200, 0));
  setUserSetting("codeboard.stickerFolder", dir); await sleep(1500);
  const f = await newBoard(page, "Stickers E2E");
  // the Sticker button; in a narrow pane (two editor groups) it is folded into More as Add a Sticker
  const openPicker = async () => {
    if (await f.locator('.bbar button[aria-label="Sticker"]').count()) await f.locator('.bbar button[aria-label="Sticker"]').first().click();
    else { await f.locator('.bbar button[aria-label="More"]').first().click(); await sleep(400); await f.locator(".ctx button", { hasText: /^Add a Sticker/ }).first().click(); }
    await sleep(600);
  };
  await openPicker();
  check(/stickers$/.test(await f.locator(".stkpick .sfoot span").textContent().catch(() => "")), "stickerfolder: the picker names the folder from codeboard.stickerFolder", await f.locator(".stkpick .sfoot span").textContent().catch(() => ""));
  await f.locator(".stkpick .stabs button", { hasText: "E2E Pack" }).click({ timeout: 5000 }).catch(() => {});
  const cells = await f.waitForFunction(() => {
    const im = [...document.querySelectorAll(".stkpick img.glyph.img")];
    return im.length === 2 && im.every((i) => i.complete && i.naturalWidth > 0) ? im.map((i) => ({ name: i.dataset.name, anim: i.classList.contains("anim") })) : null;
  }, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => null);
  check(!!cells && cells.some((c) => c.name === "smile" && !c.anim) && cells.some((c) => c.name === "wink" && c.anim), "stickerfolder: the PNG and the animated GIF show in the picker under the pack's tab", cells ?? await f.locator(".stkpick .stabs button").allTextContents().catch(() => []));
  await shot(page, "20-sticker-folder-picker");
  // place both: pick in the picker, then click empty canvas
  const fb = await (await f.frameElement()).boundingBox();
  const sp = await emptySpot(f);
  for (const [k, name] of ["smile", "wink"].entries()) {
    if (!(await f.locator(".stkpick").count())) { await openPicker(); await f.locator(".stkpick .stabs button", { hasText: "E2E Pack" }).click().catch(() => {}); await sleep(400); }
    await f.locator(`.stkpick .scell[data-tip="${name}"]`).click({ timeout: 5000 }).catch(() => {}); await sleep(400);
    const x = fb.x + sp.x + 60 + k * 120, y = fb.y + sp.y + 60;
    await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.click(x, y); await sleep(600);
  }
  await sleep(1500);
  const placed = await f.evaluate(() => [...document.querySelectorAll("[data-sticker] img.glyph.img")].map((i) => ({ ok: i.complete && i.naturalWidth > 0, anim: i.classList.contains("anim"), paused: i.classList.contains("paused") })));
  const saved = (boardNamed("Stickers E2E")?.stickers ?? []).map((s) => `${s.icon.pack}/${s.icon.name}`).sort();
  check(placed.length === 2 && placed.every((p) => p.ok) && placed.some((p) => p.anim && !p.paused), "stickerfolder: both stickers are drawn on the board, the GIF playing", placed);
  check(JSON.stringify(saved) === JSON.stringify(["E2E Pack/smile", "E2E Pack/wink"]), "stickerfolder: both stickers are saved with the board by pack and name", saved);
  await shot(page, "21-sticker-folder-board");
  setUserSetting("codeboard.stickerFolder", undefined);
}

// codeboard.notes.headingInBody from VS Code's settings reaches the board: a Note titled by its leading heading hides that heading in
// its body by default and shows it once the setting is on. Then Ctrl+X on the Note and Ctrl+V on the same board put the same card back.
// E2E_ONLY=notesettings runs only this step
async function notesettingsStep(page) {
  const f = await newBoard(page, "Note Settings E2E");
  check(await newNote(page, f), "notesettings: n opens a new Note with its editor focused");
  await page.keyboard.type("# Plan"); await page.keyboard.press("Enter"); await page.keyboard.type("Schedule, then run, then postprocess.");
  await page.keyboard.press("Escape"); await sleep(1500);
  const note = f.locator(".card.note").first();
  const look = () => note.evaluate((c) => {
    const h = c.querySelector(".nbody > :is(h1,h2,h3):first-child");
    return { title: c.querySelector(".chead .ctitle")?.textContent, hidden: c.querySelector(".nbody")?.classList.contains("hidehead"), heading: !!h && getComputedStyle(h).display !== "none" };
  }).catch((e) => String(e));
  const off = await look();
  check(off.title === "Plan" && off.hidden && !off.heading, "notesettings: by default the Note is titled Plan and its body hides the heading", off);
  setUserSetting("codeboard.notes.headingInBody", true);
  let on = off; for (let i = 0; i < 20 && !on.heading; i++) { await sleep(250); on = await look(); }
  check(on.title === "Plan" && !on.hidden && on.heading, "notesettings: codeboard.notes.headingInBody in VS Code settings shows the heading in the body", on);
  await shot(page, "22-note-heading-in-body");
  // Ctrl+X / Ctrl+V on the same board
  const before = (boardNamed("Note Settings E2E")?.cards ?? []).find((c) => c.kind === "note");
  await note.locator(".chead .ctitle").click(); await sleep(400);
  await page.keyboard.press("Control+x"); await sleep(1500);
  const cut = await f.locator(".card.note").count(), afterCut = (boardNamed("Note Settings E2E")?.cards ?? []).filter((c) => c.kind === "note").length;
  check(cut === 0 && afterCut === 0, "notesettings: Ctrl+X removes the Note from the board", { onScreen: cut, saved: afterCut });
  const fb = await (await f.frameElement()).boundingBox(), sp = await emptySpot(f);
  await page.mouse.move(fb.x + sp.x, fb.y + sp.y);
  await page.keyboard.press("Control+v"); await sleep(1500);
  if (!(await f.locator(".card.note").count())) {
    console.log("  (Ctrl+V did not put the Note back: the system clipboard did not reach the webview, pasting from the canvas menu)");
    await f.locator("#board").click({ button: "right", position: sp }); await sleep(500);
    await f.locator(".ctx button", { hasText: /^Paste as / }).first().click({ timeout: 3000 }).catch(() => {}); await sleep(1500);
  }
  await sleep(1000);
  const back = (boardNamed("Note Settings E2E")?.cards ?? []).filter((c) => c.kind === "note");
  check(await f.locator(".card.note").count() === 1 && back.length === 1 && back[0].id === before?.id && back[0].md === before?.md, "notesettings: pasting on the same board puts the same Note back (same id, same text)", { before: before && [before.id, before.md], back: back.map((c) => [c.id, c.md]) });
  check(/^Plan$/.test(await f.locator(".card.note .chead .ctitle").first().textContent().catch(() => "")), "notesettings: the pasted Note keeps its title");
  setUserSetting("codeboard.notes.headingInBody", undefined);
}

const finish = async (browser, errors) => {
  check(!errors.length, "no webview errors", errors.slice(0, 3));
  fs.writeFileSync(`${OUT}/audit.json`, JSON.stringify(audits, null, 1));
  console.log(report(audits).join("\n"));
  console.log(failed ? `${failed} checks failed` : "all passed");
  await browser.close().catch(() => {});
  process.exit(failed ? 1 : 0);
};

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
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && /codeboard|board\.js/i.test(m.text())) errors.push(m.text()); });
  // E2E_ONLY=capture,addsel runs only those steps, in that order. E2E_PART splits the run for parallel CI jobs:
  // 1 = the main flow, 2 = the steps after it, 3 = the steps the default run leaves out (nightly)
  const STEPS = { capture: captureStep, export: exportStep, variants: variantsStep, codeedit: codeeditStep, addsel: addselStep, cardfocus: cardfocusStep, close: closeStep, noteimage: noteimageStep, stickerfolder: stickerfolderStep, notesettings: notesettingsStep };
  // Part 3 holds the slow steps (each 20 s or more on its own board); codeedit reloads the window, so it goes last
  const PARTS = { 2: "capture,addsel,cardfocus,close", 3: "export,variants,noteimage,stickerfolder,notesettings,codeedit" };
  const only = process.env.E2E_ONLY || PARTS[process.env.E2E_PART];
  if (only) {
    for (const k of only.split(",")) { if (!STEPS[k]) throw new Error(`E2E_ONLY: no step ${k}`); const t0 = Date.now(); await STEPS[k](page); console.log(`- ${k}: ${((Date.now() - t0) / 1000).toFixed(1)} s`); }
    return finish(browser, errors);
  }

  // 1. Alt+B inside a function: the first time in this workspace the board opens beside the editor
  //    (focus stays in the editor) and the function becomes the first card
  await openFile(page, "llm_engine.py", 51);
  await page.keyboard.press("Alt+b"); await sleep(2500);
  let f = await boardFrame(page); await sleep(1500);
  check(await page.locator(".editor-group-container .monaco-editor.focused").count() === 1, "the first Alt+B opens the board and keeps focus in the editor");
  check(await card(f, "LLMEngine.step").count() === 1, "Alt+B puts LLMEngine.step on the board");
  const nCalls = await f.locator(".card .src .call").count();
  check(nCalls >= 3, "calls in the card are clickable", await f.locator(".card .src .call").allTextContents());
  check(await f.locator(".card .src .kw").count() > 3, "code is syntax highlighted");
  await shot(page, "1-first-card");

  // 2. Click schedule: expands Scheduler.schedule, numbered 1, with a call link
  await card(f, "LLMEngine.step").locator(".src .call", { hasText: /^schedule$/ }).first().click(); await sleep(1800);
  check(await card(f, "Scheduler.schedule").count() === 1, "clicking schedule expands Scheduler.schedule");
  check((await card(f, "Scheduler.schedule").locator(".chead .step").textContent().catch(() => "")) === "A", "child card shows its tree letter A");
  check(await f.locator("path.edge").count() >= 1, "call link drawn");
  // 3. Click postprocess: second child in the same tree. On this narrow board the camera followed schedule into the
  //    column on the right, so zoom back to LLMEngine.step first (Fit, select it, Fit Selection)
  await f.locator("#board").click({ position: { x: 30, y: 300 } }); await sleep(300);
  await page.keyboard.press("Shift+!"); await sleep(900);
  await card(f, "LLMEngine.step").locator(".chead").click({ position: { x: 20, y: 6 } }); await sleep(300);
  await page.keyboard.press("Shift+@"); await sleep(900);
  await card(f, "LLMEngine.step").locator(".src .call", { hasText: /^postprocess$/ }).first().click(); await sleep(1800);
  check(await card(f, "Scheduler.postprocess").count() === 1, "clicking postprocess expands it");
  await f.locator("#board").click({ position: { x: 30, y: 300 } }); await sleep(300);
  await page.keyboard.press("Shift+!"); await sleep(900);
  await shot(page, "2-flow");

  // 4. Definition Peek: hover can_allocate (Fit on this narrow board is an overview; zoom to Scheduler.schedule first)
  const sch = card(f, "Scheduler.schedule");
  await sch.locator(".chead").click(); await sleep(300);
  await page.keyboard.press("Shift+@"); await sleep(900);
  await sch.locator(".src .call", { hasText: /^can_allocate$/ }).first().hover(); await sleep(2500);
  check(await f.locator(".pop.k-peek").count() === 1, "hovering a name opens Definition Peek");
  await shot(page, "3-peek");
  // Move away onto the code below the name (the peek opens above it here), then out of the webview in steps.
  // Synthetic CDP moves that leave the iframe deliver no leave events to it, so the path must not leave the webview straight from the peek:
  // the peek would keep :hover and stay open, which is a test artefact rather than what a real mouse does
  const w = await sch.locator(".src .call", { hasText: /^can_allocate$/ }).first().boundingBox();
  // 停在空白画布上：停在代码行上可能正好落在另一个调用上，又打开一个 Peek
  const fb = await (await f.frameElement()).boundingBox(), sp = await emptySpot(f);
  const y = fb.y + sp.y;
  if (w) await page.mouse.move(w.x + w.width / 2, w.y + w.height + 6, { steps: 2 });
  await page.mouse.move(fb.x + sp.x, y, { steps: 6 });
  await page.mouse.move(5, y, { steps: 12 });
  // 关闭有一段延迟（还要等离开事件）：CI 机器慢时 800ms 不一定够，最多等 3s
  let open = 1; for (let t = 0; t < 15 && (open = await f.locator(".pop.k-peek").count()); t++) await sleep(200);
  check(open === 0, "Definition Peek closes after the mouse moves away");

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

  // 7b. Clipboard while editing a Note: VS Code's webview host runs cut / copy / paste (they must reach it, not stop in the editor)
  {
    const pm = f.locator(".card.note .md-pm");
    const txt = async () => (await pm.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    // the new Note sits at the board's left edge, half under the toolbar: zoom to it first (it is still selected)
    await page.keyboard.press("Shift+Digit2"); await sleep(1200);
    await f.locator(".card.note .nbody").dblclick(); await pm.waitFor({ timeout: 5000 }).catch(() => {});
    await page.keyboard.press("Control+End"); await page.keyboard.type(" cutme"); await sleep(300);
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
    await sleep(200);
    await page.keyboard.press("Control+x"); await sleep(700);
    const afterCut = await txt();
    await page.keyboard.press("Control+v"); await sleep(700);
    const afterPaste = await txt();
    // copy the pasted word and paste it again at the end
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
    await sleep(200);
    await page.keyboard.press("Control+c"); await sleep(500);
    await page.keyboard.press("End"); await page.keyboard.type(" "); await page.keyboard.press("Control+v"); await sleep(700);
    const afterCopy = await txt();
    await page.keyboard.press("Escape"); await sleep(2500);
    const md = (boardJson()?.cards ?? []).find((c) => c.kind === "note")?.md ?? "";
    check(/postprocess $/.test(afterCut) || /postprocess$/.test(afterCut), "Ctrl+X in a Note cuts the selection", afterCut);
    check(/postprocess cutme$/.test(afterPaste), "Ctrl+V in a Note pastes it back", afterPaste);
    check(/cutme cutme$/.test(afterCopy), "Ctrl+C then Ctrl+V in a Note copies", afterCopy);
    check(md === "**Takeaway**: schedule → run → postprocess cutme cutme", "Note saved with the clipboard edits", md);
  }

  // 8. Autosave
  await sleep(2000);
  const b = boardJson();
  check(b && b.version === 6 && b.cards.length >= 5 && Object.keys(b.place).length === b.cards.length && b.links.length >= 2 && b.sidenotes.length === 1, "board autosaved (v6 format)", b && { cards: b.cards.length, links: b.links.length, notes: b.sidenotes?.length });

  // 8b. Settings: Ctrl+, inside the board opens the Settings page (the extension routes VS Code's own Ctrl+, back to the board); changing the theme writes codeboard.theme
  await f.locator("#board").click({ position: { x: 30, y: 300 } }); await sleep(300);
  await page.keyboard.press("Control+,"); await sleep(900);
  check(await f.locator(".settings").count() === 1, "Ctrl+, opens the Settings page in the board");
  await f.locator(".st-sw", { hasText: "Graphite" }).click(); await sleep(1500);
  const us = fs.readFileSync(`${UD}/User/settings.json`, "utf8");
  check(/"codeboard\.theme":\s*"graphite"/.test(us), "changing the theme writes codeboard.theme", us.slice(-200));
  check(await f.evaluate(() => document.documentElement.dataset.look) === "graphite", "board switches to Graphite");
  await shot(page, "7a-settings");
  await page.keyboard.press("Control+,"); await sleep(700);
  check(await f.locator(".settings").count() === 0, "Ctrl+, again closes the Settings page");
  await command(page, "CodeBoard: Open Settings"); await sleep(800);
  check(await f.locator(".settings").count() === 1, "command CodeBoard: Open Settings opens the Settings page");
  await f.locator(".st-sw", { hasText: "Warm Ink" }).click(); await sleep(800);
  await page.keyboard.press("Escape"); await sleep(400);
  // Copy Diagnostics: asks whether to include the board JSON, then says it was copied
  await command(page, "CodeBoard: Copy Diagnostics"); await sleep(800);
  await page.keyboard.press("Enter"); await sleep(1500);
  check(await page.locator(".notifications-toasts", { hasText: "Diagnostics copied to clipboard" }).count() > 0, "Copy Diagnostics says it was copied");
  await shot(page, "7b-diagnostics");

  // 8c. Change a card's file outside VS Code (another editor / git checkout): the card shows + uncommitted too
  const llm = path.join(WS, "nanovllm/engine/llm_engine.py");
  const orig = fs.readFileSync(llm, "utf8");
  fs.writeFileSync(llm, orig.replace("def step(self):", "def step(self):  # edited outside VS Code")); await sleep(4000);
  check(await f.locator(".rev.unc").count() >= 1, "card shows + uncommitted after the file changes outside VS Code");
  fs.writeFileSync(llm, orig); await sleep(2500);
  check(await f.locator(".rev.unc").count() === 0, "+ uncommitted goes away after changing it back");

  // 9. Edit code in the editor: the card shows + uncommitted (nothing committed to git)
  await openFile(page, "scheduler.py", 30);
  await page.keyboard.press("End"); await page.keyboard.type("  # local edit"); await page.keyboard.press("Control+s"); await sleep(3500);
  check(await f.locator(".rev.unc").count() >= 1, "card shows + uncommitted after a local edit");
  await shot(page, "7-uncommitted");

  // 10. 共享卡：板 1 上 Ctrl+C 一张卡，新建板 2 上 Ctrl+V = 同一张卡（⧉ 2 boards），板 2 上加的 Sidenote 板 1 上也有
  await f.locator("#board").click({ position: { x: 30, y: 300 } }); await sleep(300);
  const sch1 = card(f, "Scheduler.schedule");
  const mk0 = await sch1.locator(".mk").count();
  await sch1.locator(".chead .ctitle").click(); await sleep(300);
  await page.keyboard.press("Control+c"); await sleep(800);
  await command(page, "CodeBoard: New Board"); await sleep(600);
  await page.keyboard.press("Control+a"); await page.keyboard.type("Shared E2E"); await page.keyboard.press("Enter"); await sleep(3000);
  let g = null;
  for (let i = 0; i < 40 && !g; i++) { for (const x of page.frames()) { if (x !== f && await x.$("#board").catch(() => null)) { g = x; break; } } if (!g) await sleep(500); }
  check(!!g, "New Board opens a second board");
  if (g) {
    await sleep(1500);
    await g.locator("#board").click({ position: { x: 300, y: 300 } }); await sleep(300);
    await page.keyboard.press("Control+v"); await sleep(2000);
    // 剪贴板在 xvfb 里不一定转得进 webview：退一步用画布右键菜单
    if (!(await card(g, "Scheduler.schedule").count())) {
      await g.locator("#board").click({ button: "right", position: { x: 300, y: 300 } }); await sleep(500);
      await g.locator(".ctx button", { hasText: /^Paste as Linked Card/ }).first().click({ timeout: 3000 }).catch(() => {}); await sleep(2000);
    }
    const sch2 = card(g, "Scheduler.schedule");
    check(await sch2.count() === 1, "Ctrl+V on another board pastes the copied card");
    let badge = ""; for (let i = 0; i < 20 && !/2 boards/.test(badge); i++) { badge = (await sch2.locator(".shb").textContent().catch(() => "")) ?? ""; if (!/2 boards/.test(badge)) await sleep(250); }
    check(/2 boards/.test(badge), "the pasted card is linked: both boards show ⧉ 2 boards", badge);
    check(await sch2.locator(".mk").count() === mk0, "sidenotes travel with the linked card", { mk0, now: await sch2.locator(".mk").count() });
    // 板 2 上给另外两行加一条 Sidenote
    await sch2.locator(".no").nth(10).click(); await sch2.locator(".no").nth(11).click({ modifiers: ["Shift"] });
    await page.keyboard.press("s"); await sleep(600);
    await g.locator(".pop button", { hasText: /^Text$/ }).click(); await sleep(200);
    await page.keyboard.type("Shared across both boards.");
    await g.locator(".pop button", { hasText: /^Add$/ }).click(); await sleep(800);
    await page.keyboard.press("Escape");
    check(await sch2.locator(".mk").count() === mk0 + 1, "sidenote added on board 2");
    let mk1 = 0; for (let i = 0; i < 20 && (mk1 = await sch1.locator(".mk").count()) <= mk0; i++) await sleep(250);
    check(mk1 === mk0 + 1, "the sidenote shows up on board 1 too", { mk0, mk1 });
    check((await sch1.locator(".shb").textContent().catch(() => "")).includes("2 boards"), "board 1 also shows ⧉ 2 boards");
    await shot(page, "8-shared");
  }

  // 11. 子白板：板 1 画布右键 Insert Board ▸ Shared E2E → 骨架框；双击进去有面包屑，Esc 回来；侧栏 Shared E2E 挂在板 1 下面
  if (g) {
    // Shared E2E 已经在另一个标签页开着时双击框只是切过去：先关掉它
    await page.locator(".tabs-container .tab", { hasText: "Shared E2E" }).first().click({ button: "middle" }); await sleep(1500);
    await page.locator(".tabs-container .tab", { hasText: "New Board" }).first().click(); await sleep(2000);
    f = await boardFrame(page); await sleep(1500);
    await f.locator("#board").click({ position: { x: 30, y: 300 } }); await sleep(300);
    await f.locator("#board").click({ button: "right", position: await emptySpot(f) }); await sleep(500);
    await f.locator(".ctx button", { hasText: /^Insert Board/ }).first().hover(); await sleep(500);
    await f.locator(".ctx button", { hasText: /^Shared E2E/ }).first().click({ timeout: 3000 }).catch(() => {}); await sleep(1500);
    const fr = f.locator(".card.board");
    check(await fr.count() === 1, "Insert Board puts a sub-board frame on the board");
    let subs = 0; for (let i = 0; i < 20 && !(subs = await fr.locator(".skel [data-sub]").count()); i++) await sleep(250);
    check(subs >= 1, "the frame shows the sub-board's skeleton", subs);
    check(/1 card/.test(await fr.locator(".sbmeta").textContent().catch(() => "")), "the frame title bar shows the card count");
    await shot(page, "9-subboard");
    await fr.locator(".sbhead").dblclick(); await sleep(2500);
    let fb = await boardFrame(page);
    check(await fb.locator(".crumbs").count() === 1 && /Shared E2E/.test(await fb.locator(".crumbs").textContent().catch(() => "")), "double-click enters the sub-board with a breadcrumb");
    // 侧栏：Shared E2E 挂在板 1 下面（展开）
    await command(page, "Focus on Boards View"); await sleep(1200);
    await page.screenshot({ path: `${OUT}/9b-sidebar-nesting.png` });
    const rows = await page.locator(".part.sidebar .monaco-list-row").evaluateAll((els) => els.map((e) => `${e.getAttribute("aria-level")}:${e.textContent}`));
    check(rows.some((r) => /^2:.*Shared E2E/.test(r)), "sidebar nests the sub-board under its parent", rows.slice(0, 8));
    // 回去：点面包屑里的上一级（Esc 在 harness 的 subboards 里测；这里 xvfb 下侧栏拿走焦点后按键进不了 webview）
    await fb.locator(".crumbs button", { hasText: "New Board" }).first().click(); await sleep(2500);
    fb = await boardFrame(page);
    check(await fb.locator(".crumbs").count() === 0 && await fb.locator(".card.board").count() === 1, "clicking the parent crumb returns to the parent board");
  }

  // 12. 动态分发选实现（线框 01）：调用处的静态类型是基类，Pylance 的 Implementation 列出两个子类；选一个建卡，另一个是灰色备选框。
  // 没装 Pylance（E2E_EXTENSIONS 里没有）时 Python 没有语言服务，跳过
  if (/pylance/i.test(process.env.E2E_EXTENSIONS || "")) {
    fs.writeFileSync(path.join(WS, "nanovllm/e2e_dispatch.py"), [
      "class Sampler:", "    def sample(self, logits):", "        raise NotImplementedError", "", "",
      "class Greedy(Sampler):", "    def sample(self, logits):", "        return logits.argmax(-1)", "", "",
      "class TopK(Sampler):", "    def sample(self, logits):", "        return logits.topk(5)", "", "",
      "def pick_tokens(s: Sampler, logits):", "    return s.sample(logits)", "",
    ].join("\n"));
    await sleep(1500);
    await openFile(page, "e2e_dispatch.py", 16); // def 那一行：光标在调用上时 Alt+B 会顺带把被调的也放上来
    await sleep(6000); // Pylance 先把文件分析完
    await page.keyboard.press("Alt+b"); await sleep(2500);
    f = await boardFrame(page); await sleep(1000);
    const pt = card(f, "pick_tokens");
    check(await pt.count() === 1, "Alt+B puts pick_tokens on the board");
    // 白板窄、卡多，适应窗口后在概览档（代码是灰条，点不到调用）：照用户的做法双击这张卡，放大到它 100%
    // （适应窗口在 ~28%，Zoom In 一次 ×1.25、以画面中心放大，到 60% 的完整档之前卡就出了右边；
    // 不按键：焦点可能还在编辑器里，Shift+2 会把 @ 打进代码）
    await f.locator('button[aria-label="Fit to Window"]').first().click(); await sleep(1200);
    if (await pt.locator(".ovm").isVisible().catch(() => false)) { await pt.locator(".ovm").dblclick(); await sleep(900); }
    check(!(await pt.locator(".ovm").isVisible().catch(() => false)), "double-clicking a card in the overview zooms to it");
    await sleep(1200); // 镜头动画停下
    let impls = 0;
    for (let i = 0; i < 6 && !impls; i++) {
      await pt.locator(".src .call", { hasText: /^sample$/ }).first().click({ timeout: 8000 }).catch((e) => console.log("  click failed:", e.message.split("\n")[0])); await sleep(2500);
      impls = await f.locator(".pop.k-impls .cand").count();
      if (!impls) { await page.keyboard.press("Escape"); await sleep(3000); } // 语言服务还没就绪：退回按名字找的结果，等一下再点
    }
    check(impls === 2, "clicking s.sample lists the 2 implementations (Pylance Implementation)", impls);
    check(/2 implementations of/.test(await f.locator(".pop.k-impls .pt").textContent().catch(() => "")), "the picker names the base method");
    await f.locator(".pop.k-impls input.fld").fill("top-k sampling in this config").catch(() => {});
    await f.locator(".pop.k-impls .cand", { hasText: "TopK.sample" }).first().click().catch(() => {}); await sleep(2500);
    check(await card(f, "TopK.sample").count() === 1, "picking TopK.sample puts it on the board");
    check(await f.locator(".altbox", { hasText: "Greedy.sample" }).count() === 1, "Greedy.sample stays as a grey alternative");
    await shot(page, "10-pick-impl");
  } else console.log("- skip pick-implementation step (no Pylance in E2E_EXTENSIONS)");

  if (process.env.E2E_PART !== "1") { await captureStep(page); await addselStep(page); await cardfocusStep(page); await closeStep(page); }
  await finish(browser, errors);
})().catch((e) => { console.error(e); process.exit(2); });

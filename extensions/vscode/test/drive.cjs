// Drive VS Code through the main v0.1 flows, checking results and taking a screenshot at each step.
// Every step waits for the state it needs (wait.cjs, ui.cjs), never for a fixed time
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { until, soon, hold, idle, track, fromSource } = require("./wait.cjs");
const { command, watchKeyboard, boardDialog, boardDialogClosed, inputBox, qiClosed, openFile, goToLine, statusSel, text, typingIn, pmHasSelection, focusSettled, boardFrame, boardFrames, card, fit, boardHasKeyboard, boardKeys, ctrlK } = require("./ui.cjs");
const [OUT, WS, UD] = process.argv.slice(2);
/** The board file format the extension writes (core's model.ts), so the autosave check follows a format bump */
const { BOARD_VERSION } = fromSource("packages/core/src/model.ts");
let failed = 0;
const check = (ok, what, extra) => { console.log(`${ok ? "✓" : "✗"} ${what}${!ok && extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : ""}`); if (!ok) failed++; };
/** A file of the nano-vllm copy */
const W = (rel) => path.join(WS, rel);
const ENGINE = W("nanovllm/engine/llm_engine.py"), SCHED = W("nanovllm/engine/scheduler.py"), CONTEXT = W("nanovllm/utils/context.py");

// Each screenshot also runs the generic UI audit (tools/review/audit.cjs), collected in audit.json; with AUDIT_STRICT=1 issues count as failures
const { audit, report } = require("../../../tools/review/audit.cjs");
const audits = [];
// Before a screenshot wait for the board to settle (idle: host answered, animations done, camera still, DOM quiet) and capture only the
// board, so unrelated changes like the VS Code status bar don't disturb the diff
const shot = async (page, n) => {
  const [fr] = await boardFrames(page);
  if (!fr) { await page.screenshot({ path: `${OUT}/${n}.png` }); return; }
  // Fit to window before every screenshot: card sizes may be measured after the earlier fit and the camera drifts between runs; fitting makes shots comparable
  // Skip while a popup, input or the Settings page is open (it would type "!" into the search box, close the popup we want to capture, or
  // be covered: the Settings page lies over the Fit to Window button)
  const busy = await fr.evaluate(() => !!document.querySelector(".palette, .pop, .ctx, .dialog, .settings") || /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "") || !!document.activeElement?.isContentEditable);
  await idle(fr); if (!busy) { await fit(fr); await idle(fr); }
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
const boardsDir = () => execSync(`ls -d ${UD}/User/workspaceStorage/*/*codeboard*/boards 2>/dev/null || true`).toString().trim().split("\n")[0];
/** The board saved last: once several boards exist, that is the one the step just changed */
const boardJson = () => {
  const d = boardsDir();
  if (!d) return null;
  const f = fs.readdirSync(d).filter((n) => n.endsWith(".json")).map((n) => path.join(d, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  return f ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
};
const boardNamed = (name) => { const d = boardsDir(); return d ? fs.readdirSync(d).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(fs.readFileSync(path.join(d, n), "utf8"))).find((b) => b.name === name) : undefined; };
const editorFocused = (page) => page.locator(".editor-group-container .monaco-editor.focused").count();
/** Click on the board's canvas, then wait until its webview has the keyboard (keys pressed next go to the board) */
const clickBoard = async (f, opts = { position: { x: 30, y: 300 } }) => { await f.locator("#board").click(opts); await until("the board has the keyboard", () => boardHasKeyboard(f)); };
/** Alt+B in the code editor: resolves once the board on screen shows the card */
async function altB(page, title, keys = "Alt+b") {
  await page.keyboard.press(keys);
  let f;
  await until(`${keys} puts ${title} on the board`, async () => (f = (await boardFrames(page))[0]) && card(f, title).count(), 30000, 100);
  return f;
}
/** A Sidenote on lines a..b of a code card: S, the Text tab, type, Add */
async function sidenote(page, f, c, a, b, words) {
  await c.locator(".no").nth(a).click(); await c.locator(".no").nth(b).click({ modifiers: ["Shift"] });
  await page.keyboard.press("s");
  await f.locator(".pop button", { hasText: /^Text$/ }).click();
  await until("the Sidenote's text field has the keyboard", () => typingIn(f, ".pop"));
  await page.keyboard.type(words);
  await f.locator(".pop button", { hasText: /^Add$/ }).click();
}
/** The text the system clipboard holds, read in the board's webview (which has the keyboard): what ⌘V there will paste */
const clipboard = (f) => f.evaluate(() => navigator.clipboard.readText());

// 13. Capture Run（线框 13）：跑一次工作区里的小脚本（nano-vllm 要 torch，这里没有），tracer 只记 Study Scope 里的调用；
// 白板上已有的 Call 箭头变 Observed，没有箭头的调用列在 Run 面板里。E2E_ONLY=capture 只跑这一步
async function captureStep(page) {
  fs.writeFileSync(path.join(WS, "e2e_capture.py"), [
    "def leaf(x):", "    return x * 2", "", "",
    "def mid(xs):", "    out = []", "    for x in xs:", "        out.append(leaf(x))", "    return out", "", "",
    "def main():", "    print(sum(mid([1, 2, 3])))", "", "",
    'if __name__ == "__main__":', "    main()", "",
  ].join("\n"));
  await openFile(page, path.join(WS, "e2e_capture.py"), 8);
  await page.keyboard.press("Alt+b");
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page);
  check(await soon(() => card(f, "mid").count(), (n) => n === 1, 20000) === 1, "Alt+B puts mid on the board");
  // Run from the palette over the board: it asks on the board
  await command(page, "CodeBoard: Capture Run…");
  await boardDialog(page, f, "Capture Run");
  // The dialog opens with its text selected. No Ctrl+A: in a webview VS Code runs it and sends Select All back a moment later
  await page.keyboard.type("e2e_capture.py"); await page.keyboard.press("Enter");
  await boardDialogClosed(f, "the Capture Run dialog");
  const panel = await soon(async () => { f = await boardFrame(page); return f.locator(".cpanel.runp").count(); }, (n) => n === 1, 30000);
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
  await f.locator(".cpanel.runp .rrow", { hasText: "leaf" }).first().locator(".radd").click();
  check(await soon(() => card(f, "leaf").count(), (n) => n === 1, 20000) === 1, "Add puts leaf on the board");
  const tag = f.locator(".ev-tag.observed");
  const obs = await soon(async () => [await tag.count(), await text(tag)], ([n, t]) => n === 1 && /3/.test(t));
  check(obs[0] === 1 && /3/.test(obs[1]), "the new mid → leaf Call arrow is Observed · 3×", obs);
  const b = await soon(boardJson, (b) => b && b.links.some((l) => l.call && l.call.ev && l.call.ev.kind === "observed" && l.call.ev.count === 3));
  check(b && b.links.some((l) => l.call && l.call.ev && l.call.ev.kind === "observed" && l.call.ev.count === 3), "the Observed evidence is saved with the board");
  await shot(page, "11-capture-run");
}
// 08. 导出 HTML 快照：⋯ → Export… → HTML Snapshot，存盘用 VS Code 自己的简易对话框（run.sh 打开 files.simpleDialog；原生对话框在 CDP 里够不着），
// 再在 e2e 的 Chromium 里打开导出的文件：离线、只读、能拖能缩放。E2E_ONLY=export 只跑这一步
async function exportStep(page) {
  await openFile(page, SCHED, 26);
  await page.keyboard.press("Alt+b");
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page);
  check(await soon(() => f.locator(".card").count(), (n) => n >= 1, 20000) >= 1, "Alt+B puts a card on the board");
  await command(page, "Notifications: Clear All Notifications");
  await idle(f);
  // 白板在右边一栏、比较窄：底栏和 dock 在同一行、不叠在一起（叠了就点不到 More；很窄时 dock 并进底栏）
  const pills = await f.evaluate(() => [...document.querySelectorAll(".bbar .pill, .dock .pill")].map((e) => { const r = e.getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom]; }));
  const [bb, dk] = pills;
  check(!dk || ((bb[1] <= dk[0] || dk[1] <= bb[0]) && bb[2] < dk[3] && dk[2] < bb[3]), "the bottom bar and the dock sit in one row without overlapping in a narrow pane", { pills });
  await f.locator('button[aria-label="More"]').first().click();
  await f.locator(".ctx :is(button,div,li)", { hasText: /^Export…/ }).first().click();
  check(await soon(() => f.locator(".dialog.xdlg").count(), (n) => n === 1) === 1, "Export… opens the export dialog");
  await f.locator(".dialog.xdlg .seg button", { hasText: "HTML Snapshot" }).click();
  await shot(page, "12-export-dialog");
  await f.locator(".dialog.xdlg button.def").click();
  const out = path.join(WS, "e2e-export.html");
  const input = page.locator(".quick-input-widget input.input");
  const dialog = await input.waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false);
  check(dialog, "the save dialog appears");
  if (!dialog) return;
  await input.fill(out);
  await until("the save dialog has the path", async () => (await input.inputValue()) === out);
  await page.keyboard.press("Enter");
  check(await soon(() => fs.existsSync(out), Boolean, 20000), "the snapshot is written", out);
  if (!fs.existsSync(out)) return;
  // written once the file has its closing tag (the host writes it in one go, but the watcher can see it while it is being written)
  const html = await soon(() => fs.readFileSync(out, "utf8"), (h) => /<\/html>\s*$/.test(h));
  check(!/cbres:/.test(html) && /data:font\/woff2;base64/.test(html), "fonts are inlined, no unresolved references", html.length);
  // VS Code 的 CDP 连接开不了新上下文：另起一个和 harness 同一个 Chromium，断网打开
  const vb = await (await import("../../../tools/test/chromium.mjs")).launch();
  const ctx = await vb.newContext({ offline: true, viewport: { width: 1400, height: 900 } }); const v = await ctx.newPage();
  const net = [], errs = [];
  v.on("request", (r) => { if (!/^(file|data|about):/.test(r.url())) net.push(r.url()); });
  v.on("pageerror", (e) => errs.push(String(e)));
  await v.goto("file://" + out);
  const shown = await soon(() => v.locator(".card").count(), (n) => n >= 1);
  check(shown >= 1, "the snapshot renders the cards", shown);
  await idle(v.mainFrame(), { host: false });
  check(await v.locator(".card .src .kw").count() > 0, "code in the snapshot is highlighted");
  const before = await v.evaluate(() => getComputedStyle(document.querySelector(".world")).transform);
  await v.mouse.move(300, 600); await v.mouse.down(); await v.mouse.move(420, 660, { steps: 6 }); await v.mouse.up();
  const after = await soon(() => v.evaluate(() => getComputedStyle(document.querySelector(".world")).transform), (t) => t !== before, 3000);
  check(before !== after, "the snapshot pans by drag");
  await idle(v.mainFrame(), { host: false });
  check(!net.length && !errs.length, "no network requests and no errors in the snapshot", { net: net.slice(0, 3), errs: errs.slice(0, 3) });
  await v.screenshot({ path: `${OUT}/13-export-html.png` });
  await vb.close();
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
  await openFile(page, SCHED, 26);
  // 同一个 job 里前面的步骤（export）可能已经放过 Scheduler.schedule：这次放上来的是排在最后的那张
  let had = 0;
  for (const f0 of await boardFrames(page, { visible: false })) had = await card(f0, "Scheduler.schedule").count();
  await page.keyboard.press("Alt+b");
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page);
  const sch = card(f, "Scheduler.schedule").last();
  check(await soon(() => card(f, "Scheduler.schedule").count(), (n) => n === had + 1, 20000) === had + 1, "Alt+B puts Scheduler.schedule on the board", { had });
  await idle(f);
  await sch.locator(".chead").click({ button: "right", position: { x: 140, y: 12 } });
  await f.locator(".ctx button", { hasText: /^Add Variant…/ }).click();
  // the worktrees come from the host's reply
  const items = await soon(() => f.locator(".ctx button").allTextContents(), (t) => t.some((x) => /Other Worktree/.test(x)), 15000);
  await idle(f);
  check(items.some((t) => /Other Worktree.*exp-overlap · \.\.\/ws-exp/.test(t)), "Add Variant lists the other worktree", items);
  await shot(page, "14-add-variant-menu");
  await f.locator(".ctx button", { hasText: /Other Worktree/ }).click();
  const tabs = await soon(() => sch.locator(".vtab:not(.vadd)").allTextContents(), (t) => t.length === 2, 15000);
  await idle(f);
  check(tabs.length === 2 && /ws-exp/.test(tabs[1]), "the card has an Upstream tab and the worktree tab", tabs);
  check(await sch.locator(".chead .mine").count() === 1, "MINE shows on the card");
  check((await sch.locator(".vmk").allTextContents()).join("") === "~+", "the changed and added lines are marked", await sch.locator(".vmk").allTextContents());
  const saved = (b) => { const c = b && b.cards.find((k) => k.kind === "code" && k.variants); return c && c.variants.length === 2 && c.variants[1].from.kind === "wt" && c.variants[1].from.dir === WT && c.segments[0].src.kind === "external" ? c : null; };
  const c = saved(await soon(boardJson, saved));
  check(!!c, "the variant is saved with the card", boardJson()?.cards.find((k) => k.kind === "code" && k.variants)?.variants);
  await shot(page, "15-variant-worktree");
  // 在 worktree 里再改一下（VS Code 外面）：卡跟着刷新
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("        num_batched_tokens = 0\n", "        num_batched_tokens = 0  # tuned\n"));
  const live = await soon(async () => { f = await boardFrame(page); return /# tuned/.test(await text(card(f, "Scheduler.schedule").last().locator(".src"))); }, Boolean, 15000);
  check(live, "editing the worktree file refreshes the variant on the card");
  // 切回上游：代码换回来、MINE 没了
  await card(f, "Scheduler.schedule").last().locator(".vtab.up").click();
  const up = await soon(async () => await card(f, "Scheduler.schedule").last().locator(".chead .mine").count() === 0 && !/keep order/.test(await text(card(f, "Scheduler.schedule").last().locator(".src"))), Boolean);
  check(up, "switching back to Upstream shows the upstream code");
}
// ⌥B 选中跨几个定义的代码（context.py 5–27：dataclass、_CONTEXT = Context()、三个函数）：默认一张多段卡，一行不丢；
// 焦点留在编辑器，紧接着 ⌘Z / Ctrl+Z 撤销这次添加（编辑器里没改过字时）；⇧⌥B 一个定义一张卡。E2E_ONLY=addsel 只跑这一步
async function addselStep(page) {
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page); await idle(f);
  const n0 = await f.locator(".card").count();
  await openFile(page, CONTEXT, 5);
  for (let i = 0; i < 22; i++) await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
  await until("the editor shows the selection", async () => /^Ln 27, Col \d+ \(\d+ selected\)/.test(await statusSel(page)));
  await page.keyboard.press("Alt+b");
  const one = f.locator(".card", { hasText: "5 segments" });
  const added = await soon(async () => [await f.locator(".card").count(), await one.count()], ([n, k]) => n === n0 + 1 && k === 1, 20000);
  await idle(f);
  check(added[0] === n0 + 1 && added[1] === 1, "Alt+B over five definitions makes one card with five segments", { n0, n: added[0] });
  const body = await text(one.locator(".src"));
  check(/@dataclass\(slots=True\)/.test(body) && /block_tables: torch\.Tensor/.test(body) && /_CONTEXT = Context\(\)/.test(body) && /def reset_context/.test(body), "…with the decorator, the fields and the module line between", body.slice(0, 200));
  check(await one.locator(".src .gap").count() === 4, "…and a separator at every segment boundary", await one.locator(".src .gap").allTextContents());
  // No screenshot here: shot() clicks the board's Fit to Window button, which moves keyboard focus into the board,
  // and then Ctrl+Z would be the board's own undo instead of the editor's codeboard.undoAdd we want to test
  // focus is still in the editor: Ctrl+Z (⌘Z) undoes the add on the board, the editor text is untouched
  check(await editorFocused(page) === 1, "focus stays in the editor after Alt+B");
  const textBefore = await page.locator(".editor-group-container .monaco-editor .view-lines").first().textContent();
  await page.keyboard.press("Control+z");
  const left = await soon(() => f.locator(".card").count(), (n) => n === n0);
  check(left === n0, "Ctrl+Z right after Alt+B (focus in the editor) removes the card from the board", left);
  // the board's toast says it came from the editor's undoAdd (the board's own Ctrl+Z shows no toast)
  const toast = await soon(() => text(f.locator(".toast")), (t) => /Removed the card just added/.test(t), 5000);
  check(/Removed the card just added/.test(toast), "…through the editor's undo-add (the board says so)", toast);
  check(await page.locator(".editor-group-container .monaco-editor .view-lines").first().textContent() === textBefore, "…and does not undo anything in the editor");
  await page.keyboard.press("Shift+Alt+b");
  const sep = await soon(async () => [await f.locator(".card").count(), await card(f, "Context").count(), await card(f, "reset_context").count()], ([n, a, b]) => n === n0 + 5 && a === 1 && b === 1, 20000);
  check(sep[0] === n0 + 5 && sep[1] === 1 && sep[2] === 1, "Shift+Alt+B makes one card per definition (and one for the module line)", await f.locator(".card .ctitle").allTextContents());
  const ctx = await soon(() => text(card(f, "Context").locator(".src")), (t) => /is_prefill: bool = False/.test(t));
  check(/is_prefill: bool = False/.test(ctx), "the Context card shows its fields");
  await shot(page, "17-addsel-separate");
  // a screenshot of the one-card result too: Alt+B again from the editor (the selection is unchanged)
  await command(page, "View: Focus First Editor Group");
  await page.keyboard.press("Alt+b");
  await until("Alt+B again puts the five-segment card back", async () => await one.count() === 1, 20000);
  await shot(page, "16-addsel-one-card");
}

// Closing the board tab right after a change keeps the change (the board sends each change at once, the host finishes the write when
// the panel closes): Wrap Lines followed by closing the tab as soon as the card shows it, then a typed Text card whose tab closes as soon
// as its text is on the board. E2E_ONLY=close runs only this step
async function closeStep(page) {
  if (process.env.E2E_ONLY === "close") { await openFile(page, ENGINE, 51); await altB(page, "LLMEngine.step"); }
  const closeTab = (name) => page.locator(".tabs-container .tab", { hasText: name }).first().click({ button: "middle", force: true });
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page); await idle(f);
  const name = (await page.locator(".editor-group-container.active .tab.active").first().textContent()).trim();
  // a code card that is drawn (not hidden in a collapsed call tree) and on screen
  const shown = await f.evaluate(() => { const b = document.querySelector("#board").getBoundingClientRect(); return [...document.querySelectorAll(".card[data-id]")].filter((e) => { const r = e.getBoundingClientRect(); return r.top >= b.top && r.top + 20 < b.bottom && r.left >= b.left && r.left + 140 < b.right; }).map((e) => e.dataset.id); });
  const code = boardNamed(name)?.cards.find((c) => c.kind === "code" && shown.includes(c.id));
  check(!!code, "closeStep: the open board has a code card", name);
  if (!code) return;
  const el = f.locator(`.card[data-id="${code.id}"]`);
  // select it by its title: the file path next to it opens the code in the editor (and the keys would go there)
  await el.locator(".chead .ctitle").first().click();
  await until("the code card is selected and the board has the keyboard", async () => /\bsel\b/.test(await el.getAttribute("class")) && await boardHasKeyboard(f))
    .catch(async (e) => {
      const board = await f.evaluate(() => ({ focus: document.hasFocus(), active: `${document.activeElement?.tagName}.${document.activeElement?.className}` }));
      const workbench = await page.evaluate(() => `${document.activeElement?.tagName}.${String(document.activeElement?.className).slice(0, 40)}`);
      throw new Error(`${e.message}: ${JSON.stringify({ card: await el.getAttribute("class"), board, workbench })}`);
    });
  await page.keyboard.press("Alt+z");
  // close the tab as soon as the card shows the change: the board has sent it, the host has not necessarily written it yet
  await until("Alt+Z wraps the card's lines", async () => (await el.locator(".cbody.wrap").count() > 0) !== !!code.wrap, 5000, 10);
  await closeTab(name);
  const wrapped = (await soon(() => boardNamed(name)?.cards.find((c) => c.id === code.id), (c) => c && !!c.wrap !== !!code.wrap))?.wrap;
  check(!!wrapped !== !!code.wrap, "closing the board tab right after Wrap Lines keeps the change", { before: !!code.wrap, after: !!wrapped });
  await command(page, "CodeBoard: Open Board");
  f = await boardFrame(page); await idle(f);
  await clickBoard(f);
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
  await closeTab(name);
  const notes = (await soon(() => (boardNamed(name)?.cards ?? []).filter((c) => c.kind === "note").map((c) => c.md), (n) => n.includes("typed then closed"))) ?? [];
  check(notes.includes("typed then closed"), "closing the board tab right after typing a Text card keeps the text", { notes, closeAfterMs: closeAfter });
  await command(page, "CodeBoard: Open Board");
  await idle(await boardFrame(page));
}

// The board's own shortcuts (Ctrl+=, Ctrl+,, Ctrl+K…) are VS Code keybindings that send the key back to the board. They used to apply
// whenever the board was the active editor, so with the keyboard in the Explorer Ctrl+= zoomed the board instead of the window.
// E2E_ONLY=keyscope runs only this step
async function keyscopeStep(page) {
  await openFile(page, SCHED, 26);
  await page.keyboard.press("Alt+b");
  await command(page, "CodeBoard: Open Board");
  const f = await boardFrame(page);
  check(await soon(() => f.locator(".card").count(), (n) => n >= 1, 20000) >= 1, "keyscope: Alt+B puts a card on the board");
  await idle(f);
  await command(page, "File: Focus on Files Explorer");
  await until("the Explorer has the keyboard", () => page.evaluate(() => !!document.activeElement?.closest(".explorer-folders-view")));
  // The board reported losing the keyboard when the palette took it, so its shortcuts are VS Code's own again
  check(await ctrlK(page, f) === "vscode", "keyscope: with the keyboard in the Explorer, Ctrl+K begins VS Code's chord, not the board's search");
  check(await page.evaluate(() => document.querySelector(".editor-group-container.active .tab.active")?.textContent ?? ""), "keyscope: the board is still the active editor");
  const camZoom = () => text(f.locator(".zoom"));
  const [z0, dpr0] = [await camZoom(), await page.evaluate(() => window.devicePixelRatio)];
  await page.keyboard.press("Control+=");
  const dpr = await soon(() => page.evaluate(() => window.devicePixelRatio), (d) => d > dpr0);
  check(dpr > dpr0, "keyscope: Ctrl+= with the keyboard in the Explorer zooms the window", { dpr0, dpr });
  await idle(f);
  check(await camZoom() === z0, "keyscope: and leaves the board's zoom alone", { before: z0, after: await camZoom() });
  await command(page, "View: Reset Zoom");
  await until("the window is back at 100%", async () => await page.evaluate(() => window.devicePixelRatio) === dpr0);
  // A command run from the palette with the keyboard in the Explorer asks on the active board, which then gets the keyboard
  await command(page, "File: Focus on Files Explorer");
  await until("the Explorer has the keyboard again", () => page.evaluate(() => !!document.activeElement?.closest(".explorer-folders-view")));
  await command(page, "CodeBoard: Rename Board");
  await boardDialog(page, f, "Rename Board");
  await page.keyboard.press("Escape"); await boardDialogClosed(f, "the Rename Board dialog");
  check(true, "keyscope: Rename Board from the palette over the Explorer gives the board's dialog the keyboard");
}
// Clicking a card takes keyboard focus from a file editor: select text in context.py, click a card (its header, then its code),
// press Backspace. The card is deleted and the file is untouched. E2E_ONLY=cardfocus runs only this step
async function cardfocusStep(page) {
  // context.py on the left, the board on the right (run alone, the board opens in the file's group: move it)
  await openFile(page, CONTEXT, 18);
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page);
  if (await page.locator(".editor-group-container").count() < 2) { await command(page, "View: Move Editor into Right Group"); f = await boardFrame(page); }
  await idle(f);
  if (!(await card(f, "get_context").count())) {
    await openFile(page, CONTEXT, 18);
    f = await altB(page, "get_context");
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
    await f.locator(".zoom").first().click(); await idle(f);
    await openFile(page, CONTEXT, 18);
    await command(page, "CodeBoard: Reveal on Board");
    f = await boardFrame(page);
    // the host tells the board to fly to the card: wait for it to be shown in full, then for the camera to stop
    const lod = await soon(() => card(f, "get_context").getAttribute("class", { timeout: 1000 }), (c) => c && !/lo-map|lo-ov/.test(c));
    await idle(f);
    check(!/lo-map|lo-ov/.test(lod), `get_context is shown at full detail before the ${where} click`, lod);
    await openFile(page, CONTEXT, 21);
    await page.keyboard.press("Shift+ArrowDown"); await page.keyboard.press("Shift+ArrowDown");
    await until("the editor shows the selection", async () => /^Ln 23, Col \d+ \(\d+ selected\)/.test(await statusSel(page)));
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
    if (pt.x < 0) return;
    if (pt.others) console.log(`  (get_context's ${where} overlaps ${pt.others} other card(s) on screen)`);
    await target.click({ position: { x: pt.x, y: pt.y }, timeout: 5000 });
    const took = await soon(() => editorFocused(page), (n) => n === 0, 5000);
    check(took === 0, `clicking the card's ${where} takes focus from the file editor`);
    await until("the board has the keyboard", () => boardHasKeyboard(f));
    await page.keyboard.press("Backspace");
    const gone = await soon(async () => [await f.locator(".card").count(), await card(f, "get_context").count()], ([n, k]) => n === n0 - 1 && k === 0);
    check(await editorText() === before && !(await dirty()), `…Backspace leaves the selected text in context.py alone (${where})`);
    check(gone[0] === n0 - 1 && gone[1] === 0, `…and deletes the card (${where})`, gone[0]);
    // the board has focus, so Ctrl+Z is the board's own undo: the card comes back
    await page.keyboard.press("Control+z");
    check(await soon(() => card(f, "get_context").count(), (n) => n === 1) === 1, `…and Ctrl+Z on the board brings it back (${where})`);
    await idle(f);
  }
  // codeboard.editorMarks applies right away: "lens" drops the bar next to the line numbers, "off" also the CodeLens
  await openFile(page, CONTEXT, 18);
  const UDS = path.join(UD, "User/settings.json");
  const settings0 = fs.readFileSync(UDS, "utf8");
  const marks = async () => ({ bar: await page.locator(".editor-group-container .monaco-editor .margin [class*='ced-']").count(), lens: await page.locator(".editor-group-container .codelens-decoration").count() });
  const setMarks = (v) => fs.writeFileSync(UDS, settings0.replace(/\}\s*$/, `, "codeboard.editorMarks": "${v}" }`));
  const all = await soon(marks, (m) => m.bar > 0 && m.lens > 0);
  setMarks("lens"); const lens = await soon(marks, (m) => m.bar === 0 && m.lens > 0);
  setMarks("off"); const off = await soon(marks, (m) => m.bar === 0 && m.lens === 0);
  fs.writeFileSync(UDS, settings0); const back = await soon(marks, (m) => m.bar > 0 && m.lens > 0);
  check(all.bar > 0 && all.lens > 0 && lens.bar === 0 && lens.lens > 0 && off.bar === 0 && off.lens === 0 && back.bar > 0 && back.lens > 0, "codeboard.editorMarks all / lens / off switches the bar and the CodeLens live", { all, lens, off, back });
}

// PR9 编辑代码：Free code 卡用 CodeMirror 编辑，补全 / 签名提示来自 VS Code 的语言服务（Pylance）。虚拟文档是白板上同语言代码
// 旁边的隐藏文件（这里是 nanovllm/engine/.codeboard-scratch-<卡>.py），import 按那个目录找；git status 里看不到，编辑完就删掉，
// 也不会冒出未保存的标签页（重新加载窗口后也没有）。要 E2E_EXTENSIONS 里有 Pylance。E2E_ONLY=codeedit 只跑这一步
async function codeeditStep(page) {
  await openFile(page, ENGINE, 51);
  await page.keyboard.press("Alt+b");
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page);
  await until("Alt+B puts LLMEngine.step on the board", () => card(f, "LLMEngine.step").count(), 20000);
  await idle(f);
  await f.locator("#board").click({ button: "right", position: { x: 80, y: 560 } });
  await f.locator(".ctx button", { hasText: /^New Code/ }).first().click();
  check(await soon(() => f.locator(".card .cm-content").count(), (n) => n === 1) === 1, "New Code opens a CodeMirror editor on the card");
  await until("the code editor has the keyboard", () => f.evaluate(() => !!document.activeElement?.closest(".cm-content")));
  const type = async (t) => { await page.keyboard.type(t, { delay: 40 }); };
  const popups = () => f.locator(".cbcm-ac li, .cbcm-sig").count();
  // Esc 先关看得见的补全菜单和签名提示，什么都没开时 Esc 退出编辑：所以只在开着时按。等补全问完宿主（idle）再看
  const closePopups = async () => {
    await idle(f);
    for (let i = 0, n; i < 3 && (n = await popups()); i++) { await page.keyboard.press("Escape"); await until("Esc closes a completion popup", async () => await popups() < n, 3000); }
  };
  const line = async (t) => { await type(t); await closePopups(); await page.keyboard.press("Enter"); }; // 补全菜单开着时 Enter 会接受补全
  const labels = () => f.locator(".cbcm-ac li .cm-completionLabel").allTextContents();
  /** 打 t，等菜单里出现 want。语言服务刚读到这份虚拟文档时补全可能还是空的：Ctrl+Space 再问一次它现在知道什么（不改文字），直到列出 want */
  const ask = async (t, want) => {
    await type(t);
    return soon(async () => {
      await idle(f);
      const items = await labels();
      if (!items.includes(want)) await page.keyboard.press("Control+Space");
      return items;
    }, (items) => items.includes(want), 30000, 200);
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
  await page.keyboard.press("Tab");
  await until("Tab accepts the completion", async () => !(await f.locator(".cbcm-ac li").count()));
  await type(".join(");
  const sig = await soon(() => text(f.locator(".cbcm-sig-l")), (s) => /^\(a: StrPath|join|path/.test(s));
  check(/^\(a: StrPath|join|path/.test(sig), "typing os.path.join( shows signature help", sig);
  await shot(page, "17-codeedit-signature");
  await closePopups(); await line("'a')");
  const abs = await ask("BlockManager.", "allocate");
  check(abs.includes("allocate"), "an absolute import from the workspace resolves (BlockManager. lists allocate)", abs.slice(0, 8));
  await closePopups(); await line("allocate");
  const rel = await ask("Scheduler.", "schedule");
  check(rel.includes("schedule"), "a relative import next to the source resolves (Scheduler. lists schedule)", rel.slice(0, 8));
  await closePopups(); await type("schedule");
  await closePopups(); await page.keyboard.press("Escape"); // 退出编辑
  await until("Esc ends editing the code", async () => !(await f.locator(".card .cm-content").count()));
  const saved = (b) => b && b.cards.find((k) => k.kind === "code" && k.segments[0].src.kind === "free");
  const fc = saved(await soon(boardJson, (b) => saved(b)?.segments[0].text.join("\n").includes("os.path.join('a')")));
  check(fc && fc.segments[0].text.join("\n").includes("os.path.join('a')"), "the edited code is saved on the card", fc && fc.segments[0].text);
  check(await soon(() => !fs.readdirSync(scratch).some((n) => n.startsWith(".codeboard-")), Boolean, 10000), "the hidden file is deleted when editing ends");
  const reloaded = page.waitForEvent("load", { timeout: 60000 });
  await command(page, "Developer: Reload Window");
  await reloaded;
  // the window is back once it has restored its editors (the code file and the board)
  await page.locator(".monaco-workbench .part.editor").waitFor({ timeout: 60000 });
  await until("the reloaded window restores its editors", () => page.locator(".tabs-container .tab", { hasText: "llm_engine.py" }).count(), 60000);
  await idle(await boardFrame(page, { ms: 60000 }));
  const tabs = await page.locator(".tabs-container .tab").allTextContents();
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
/** CodeBoard: New Board named `name`; returns its webview frame (a fresh webview, so nothing cached from earlier steps) */
async function newBoard(page, name) {
  const before = await boardFrames(page, { visible: false });
  await command(page, "CodeBoard: New Board", "Name of the new board");
  await page.keyboard.press("Control+a"); await page.keyboard.type(name); await page.keyboard.press("Enter");
  await qiClosed(page, "the New Board input box");
  const f = await boardFrame(page, { not: before });
  await idle(f);
  return f;
}
/** A new Note at an empty spot, in edit mode with its editor focused */
async function newNote(page, f) {
  const fb = await (await f.frameElement()).boundingBox(), sp = await emptySpot(f);
  await page.mouse.click(fb.x + sp.x, fb.y + sp.y);
  await until("the board has the keyboard", () => boardHasKeyboard(f));
  await page.keyboard.press("n");
  return f.waitForFunction(() => !!document.activeElement?.closest(".card.note .md-pm"), null, { timeout: 5000 }).then(() => true, () => false);
}

// Paste while editing a Note: Ctrl+C a piece of a code block, select text in another code block and Ctrl+V. The text lands in the
// code block and nothing else happens. The selection starts on the highlighted call "ceil": in VS Code the paste event goes to that
// span, which the code editor replaces before the event reaches the board, and the board must not also make a card of it.
// E2E_ONLY=notepaste runs only this step
async function notepasteStep(page) {
  const f = await newBoard(page, "Note Paste E2E");
  check(await newNote(page, f), "notepaste: n opens a new Note with its editor focused");
  await focusSettled(f);
  const code = "vecAddKernel<<<ceil(n/128), 128>>>(...);";
  await page.keyboard.type("Blocks"); await page.keyboard.press("Enter");
  await page.keyboard.type("```cuda"); await page.keyboard.press("Enter");
  await page.keyboard.type(code);
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
  await page.keyboard.type("also"); await page.keyboard.press("Enter");
  await page.keyboard.type("```cuda"); await page.keyboard.press("Enter");
  await page.keyboard.type(code);
  const blocks = f.locator(".card.note .cm-content");
  check(await soon(() => blocks.count(), (n) => n === 2) === 2, "notepaste: the Note has two code blocks", await f.evaluate(() => document.querySelector(".card.note .md-pm")?.innerHTML.slice(0, 300)));
  const cards = () => f.locator(".card").count();
  const before = await cards();
  // select "ceil(n/128)" in the first block and copy it
  const selectIn = async (i, from, len) => {
    await blocks.nth(i).click();
    await until(`code block ${i} has the keyboard`, () => f.evaluate((i) => document.activeElement === document.querySelectorAll(".card.note .cm-content")[i], i));
    await page.keyboard.press("Home");
    for (let k = 0; k < from; k++) await page.keyboard.press("ArrowRight");
    for (let k = 0; k < len; k++) await page.keyboard.press("Shift+ArrowRight");
  };
  await selectIn(0, 15, 11);
  check(await f.evaluate(() => getSelection().toString()) === "ceil(n/128)", "notepaste: the piece of code is selected", await f.evaluate(() => getSelection().toString()));
  await page.keyboard.press("Control+c");
  // pointer over empty canvas, where a pasted card would land
  const fb = await (await f.frameElement()).boundingBox(), sp = await emptySpot(f);
  await page.mouse.move(fb.x + sp.x, fb.y + sp.y);
  // select "ceil(n/128), 128" in the second block and paste over it
  await selectIn(1, 15, 16);
  await page.keyboard.press("Control+v");
  const pasted = await soon(() => blocks.nth(1).innerText(), (t) => t.includes("<<<ceil(n/128)>>>"));
  await idle(f);
  check(pasted.includes("<<<ceil(n/128)>>>"), "notepaste: Ctrl+V pastes into the code block", pasted);
  const after = await cards();
  check(after === before, "notepaste: Ctrl+V in a code block makes no card", { before, after });
  await shot(page, "20-note-paste");
  await page.keyboard.press("Escape");
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
  await page.keyboard.press("Escape");
  const IMG = /!\[[^\]]*\]\((assets\/([0-9a-f]{16}-96x64\.png))\)/;
  const md = await soon(() => (boardNamed("Note Images E2E")?.cards ?? []).find((c) => c.kind === "note")?.md ?? "", (m) => IMG.test(m), 10000);
  const ref = IMG.exec(md);
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
  const f = await newBoard(page, "Stickers E2E");
  setUserSetting("codeboard.stickerFolder", dir);
  // The picker reads the packs once per board, when it first opens: open it only once VS Code has the new setting. The board's own
  // Settings page shows the folder the host passed on (live)
  await clickBoard(f); await boardKeys(page, f);
  await page.keyboard.press("Control+,");
  await until("the board's Settings page shows the new sticker folder", async () => /stickers$/.test(await f.locator(".settings .st-path").inputValue({ timeout: 1000 })), 15000);
  await page.keyboard.press("Control+,");
  await until("Ctrl+, closes the board's Settings page", async () => !(await f.locator(".settings").count()));
  // the Sticker button; in a narrow pane (two editor groups) it is folded into More as Add a Sticker
  const openPicker = async () => {
    if (await f.locator('.bbar button[aria-label="Sticker"]').count()) await f.locator('.bbar button[aria-label="Sticker"]').first().click();
    else { await f.locator('.bbar button[aria-label="More"]').first().click(); await f.locator(".ctx button", { hasText: /^Add a Sticker/ }).first().click(); }
    await f.locator(".stkpick").waitFor();
  };
  await openPicker();
  const foot = await soon(() => text(f.locator(".stkpick .sfoot span")), (t) => /stickers$/.test(t));
  check(/stickers$/.test(foot), "stickerfolder: the picker names the folder from codeboard.stickerFolder", foot);
  await f.locator(".stkpick .stabs button", { hasText: "E2E Pack" }).click({ timeout: 10000 });
  const cells = await f.waitForFunction(() => {
    const im = [...document.querySelectorAll(".stkpick img.glyph.img")];
    return im.length === 2 && im.every((i) => i.complete && i.naturalWidth > 0) ? im.map((i) => ({ name: i.dataset.name, anim: i.classList.contains("anim") })) : null;
  }, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => null);
  check(!!cells && cells.some((c) => c.name === "smile" && !c.anim) && cells.some((c) => c.name === "wink" && c.anim), "stickerfolder: the PNG and the animated GIF show in the picker under the pack's tab", cells ?? await f.locator(".stkpick .stabs button").allTextContents());
  await shot(page, "20-sticker-folder-picker");
  // place both: pick in the picker, then click empty canvas
  const fb = await (await f.frameElement()).boundingBox();
  const sp = await emptySpot(f);
  const onBoard = () => f.locator("[data-sticker] img.glyph.img").count();
  for (const [k, name] of ["smile", "wink"].entries()) {
    if (!(await f.locator(".stkpick").count())) { await openPicker(); await f.locator(".stkpick .stabs button", { hasText: "E2E Pack" }).click(); }
    await f.locator(`.stkpick .scell[data-tip="${name}"]`).click({ timeout: 5000 });
    const x = fb.x + sp.x + 60 + k * 120, y = fb.y + sp.y + 60;
    await page.mouse.move(x, y, { steps: 4 });
    await page.mouse.click(x, y);
    await until(`the ${name} sticker lands on the board`, async () => await onBoard() === k + 1, 5000);
  }
  await idle(f);
  const placed = await f.evaluate(() => [...document.querySelectorAll("[data-sticker] img.glyph.img")].map((i) => ({ ok: i.complete && i.naturalWidth > 0, anim: i.classList.contains("anim"), paused: i.classList.contains("paused") })));
  const saved = await soon(() => (boardNamed("Stickers E2E")?.stickers ?? []).map((s) => `${s.icon.pack}/${s.icon.name}`).sort(), (s) => s.length === 2);
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
  await page.keyboard.press("Escape");
  const note = f.locator(".card.note").first();
  const look = () => note.evaluate((c) => {
    const h = c.querySelector(".nbody > :is(h1,h2,h3):first-child");
    return { title: c.querySelector(".chead .ctitle")?.textContent, hidden: c.querySelector(".nbody")?.classList.contains("hidehead"), heading: !!h && getComputedStyle(h).display !== "none" };
  }).catch((e) => String(e));
  const off = await soon(look, (l) => l.title === "Plan" && l.hidden && !l.heading);
  check(off.title === "Plan" && off.hidden && !off.heading, "notesettings: by default the Note is titled Plan and its body hides the heading", off);
  setUserSetting("codeboard.notes.headingInBody", true);
  const on = await soon(look, (l) => l.heading, 10000);
  check(on.title === "Plan" && !on.hidden && on.heading, "notesettings: codeboard.notes.headingInBody in VS Code settings shows the heading in the body", on);
  await shot(page, "22-note-heading-in-body");
  // Ctrl+X / Ctrl+V on the same board
  const before = await soon(() => (boardNamed("Note Settings E2E")?.cards ?? []).find((c) => c.kind === "note"), (c) => c?.md === "# Plan\n\nSchedule, then run, then postprocess.");
  await note.locator(".chead .ctitle").click();
  await until("the Note is selected and the board has the keyboard", async () => /\bsel\b/.test(await note.getAttribute("class")) && await boardHasKeyboard(f));
  await page.keyboard.press("Control+x");
  const cut = await soon(async () => [await f.locator(".card.note").count(), (boardNamed("Note Settings E2E")?.cards ?? []).filter((c) => c.kind === "note").length], ([a, b]) => a === 0 && b === 0);
  check(cut[0] === 0 && cut[1] === 0, "notesettings: Ctrl+X removes the Note from the board", { onScreen: cut[0], saved: cut[1] });
  // ⌘V pastes what the system clipboard holds: the board writes the Note's text there on ⌘X, and the host writes it again (handlers.ts
  // copyCards). Press it once the clipboard has it, as a user would after the cut is done
  const clip = await soon(() => clipboard(f), (t) => t === before?.md);
  check(clip === before?.md, "notesettings: Ctrl+X puts the Note's text on the system clipboard", clip);
  const fb = await (await f.frameElement()).boundingBox(), sp = await emptySpot(f);
  await page.mouse.move(fb.x + sp.x, fb.y + sp.y);
  await page.keyboard.press("Control+v");
  const back = await soon(async () => [await f.locator(".card.note").count(), (boardNamed("Note Settings E2E")?.cards ?? []).filter((c) => c.kind === "note")], ([n, b]) => n === 1 && b.length === 1);
  check(back[0] === 1 && back[1].length === 1 && back[1][0].id === before?.id && back[1][0].md === before?.md, "notesettings: Ctrl+V on the same board puts the same Note back (same id, same text)", { before: before && [before.id, before.md], back: back[1].map((c) => [c.id, c.md]) });
  check(/^Plan$/.test(await text(f.locator(".card.note .chead .ctitle"))), "notesettings: the pasted Note keeps its title");
  setUserSetting("codeboard.notes.headingInBody", undefined);
}

// Copy / Move to Another Project… between two windows of a second VS Code, one a multi-root workspace (projects.cjs). E2E_ONLY=projects runs only this step
const projectsStep = () => require("./projects.cjs")({ check, OUT, WS, UD, port: Number(process.env.CDP_PORT || 9223) + 10 });
const finish = async (browser, errors) => {
  check(!errors.length, "no webview errors", errors.slice(0, 3));
  fs.writeFileSync(`${OUT}/audit.json`, JSON.stringify(audits, null, 1));
  console.log(report(audits).join("\n"));
  console.log(`fixed waits run: ${hold.count()} hold()`);
  console.log(failed ? `${failed} checks failed` : "all passed");
  await browser.close();
  process.exit(failed ? 1 : 0);
};

(async () => {
  const port = process.env.CDP_PORT || 9223;
  const browser = await until("VS Code's debugging port answers", () => chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null), 60000, 500);
  const page = await until("the VS Code window", () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench")), 60000, 200);
  await track(page); // before the first board's webview exists
  await watchKeyboard(page); // the keyboard hand-backs to webviews, likewise
  await page.locator(".monaco-workbench .part.editor").waitFor({ timeout: 60000 });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && /codeboard|board\.js/i.test(m.text())) errors.push(m.text()); });
  // E2E_ONLY=capture,addsel runs only those steps, in that order. E2E_PART splits the run for parallel CI jobs:
  // 1 = the main flow, 2 = the steps after it, 3 = the steps the default run leaves out (nightly)
  const STEPS = { capture: captureStep, export: exportStep, variants: variantsStep, codeedit: codeeditStep, addsel: addselStep, cardfocus: cardfocusStep, keyscope: keyscopeStep, close: closeStep, noteimage: noteimageStep, notepaste: notepasteStep, stickerfolder: stickerfolderStep, notesettings: notesettingsStep, projects: projectsStep };
  // Part 3 holds the slow steps (each 20 s or more on its own board); codeedit reloads the window, so it goes last
  const PARTS = { 2: "capture,addsel,cardfocus,keyscope,close,notepaste,projects", 3: "export,variants,noteimage,stickerfolder,notesettings,codeedit" };
  // E2E_FLOW=<file.cjs> runs a flow of your own after the E2E_ONLY steps (or alone): the file exports async (page, t) => { … }, t holds
  // this driver's helpers. For reproducing a problem in the real VS Code without editing this file
  const flow = process.env.E2E_FLOW && path.resolve(process.env.INIT_CWD || process.cwd(), process.env.E2E_FLOW);
  if (flow) STEPS.flow = (page) => require(flow)(page, { check, until, soon, hold, idle, shot, newBoard, newNote, emptySpot, clickBoard, altB, sidenote, clipboard, boardJson, boardNamed, editorFocused, setUserSetting, command, inputBox, qiClosed, openFile, goToLine, statusSel, text, typingIn, pmHasSelection, focusSettled, boardFrame, boardFrames, card, fit, W, OUT, WS, UD });
  const only = [process.env.E2E_ONLY || PARTS[process.env.E2E_PART], flow && "flow"].filter(Boolean).join(",");
  if (only) {
    // a step may begin with a command: wait until VS Code has loaded the extension's contributions (on a fresh window the command
    // palette doesn't list them yet)
    await page.locator('.activitybar .action-item a[aria-label^="CodeBoard"]').waitFor({ timeout: 60000 });
    for (const k of only.split(",")) { if (!STEPS[k]) throw new Error(`E2E_ONLY: no step ${k}`); const t0 = Date.now(); await STEPS[k](page); console.log(`- ${k}: ${((Date.now() - t0) / 1000).toFixed(1)} s`); }
    return finish(browser, errors);
  }

  // 1. Alt+B inside a function: the first time in this workspace the board opens beside the editor
  //    (focus stays in the editor) and the function becomes the first card
  await openFile(page, ENGINE, 51);
  let f = await altB(page, "LLMEngine.step");
  await idle(f);
  check(await editorFocused(page) === 1, "the first Alt+B opens the board and keeps focus in the editor");
  check(await card(f, "LLMEngine.step").count() === 1, "Alt+B puts LLMEngine.step on the board");
  const nCalls = await soon(() => f.locator(".card .src .call").count(), (n) => n >= 3);
  check(nCalls >= 3, "calls in the card are clickable", await f.locator(".card .src .call").allTextContents());
  check(await f.locator(".card .src .kw").count() > 3, "code is syntax highlighted");
  await shot(page, "1-first-card");

  // 2. Click schedule: expands Scheduler.schedule, numbered 1, with a call link
  await card(f, "LLMEngine.step").locator(".src .call", { hasText: /^schedule$/ }).first().click();
  check(await soon(() => card(f, "Scheduler.schedule").count(), (n) => n === 1, 20000) === 1, "clicking schedule expands Scheduler.schedule");
  await idle(f);
  check((await text(card(f, "Scheduler.schedule").locator(".chead .step"))) === "A", "child card shows its tree letter A");
  check(await f.locator("path.edge").count() >= 1, "call link drawn");
  // 3. Click postprocess: second child in the same tree. On this narrow board the camera followed schedule into the
  //    column on the right, so zoom back to LLMEngine.step first (Fit, select it, Fit Selection)
  await clickBoard(f);
  await page.keyboard.press("Shift+!"); await idle(f);
  await card(f, "LLMEngine.step").locator(".chead").click({ position: { x: 20, y: 6 } });
  await page.keyboard.press("Shift+@"); await idle(f);
  await card(f, "LLMEngine.step").locator(".src .call", { hasText: /^postprocess$/ }).first().click();
  check(await soon(() => card(f, "Scheduler.postprocess").count(), (n) => n === 1, 20000) === 1, "clicking postprocess expands it");
  await idle(f);
  await clickBoard(f);
  await page.keyboard.press("Shift+!"); await idle(f);
  await shot(page, "2-flow");

  // 4. Definition Peek: hover can_allocate (Fit on this narrow board is an overview; zoom to Scheduler.schedule first)
  const sch = card(f, "Scheduler.schedule");
  await sch.locator(".chead").click();
  await page.keyboard.press("Shift+@"); await idle(f);
  await sch.locator(".src .call", { hasText: /^can_allocate$/ }).first().hover();
  // opens after the hover delay (PEEK_DELAY), then shows "Looking up …" until the definition arrives
  check(await soon(() => f.locator(".pop.k-peek").count(), (n) => n === 1, 10000) === 1, "hovering a name opens Definition Peek");
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
  // 关闭有一段延迟（还要等离开事件）
  check(await soon(() => f.locator(".pop.k-peek").count(), (n) => n === 0, 5000) === 0, "Definition Peek closes after the mouse moves away");
  await idle(f);

  // 5. Sidenote: select two lines, press S, write a sentence
  await sidenote(page, f, sch, 5, 6, "Prefill admits seqs until the token budget runs out.");
  check(await soon(() => sch.locator(".mk").count(), (n) => n >= 1) >= 1, "Sidenote marker appears beside the lines");
  await shot(page, "4-sidenote");

  // 6. ⌘K search for allocate, ↵ puts it on the board
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await until("⌘K's search field has the keyboard", () => typingIn(f, ".palette"));
  await page.keyboard.type("BlockManager.allocate");
  check(await soon(() => f.locator(".palette .cand").count(), (n) => n > 0) > 0, "search returns results");
  await idle(f);
  await shot(page, "5-search");
  await page.keyboard.press("Enter");
  check(await soon(() => card(f, "BlockManager.allocate").count(), (n) => n === 1, 20000) === 1, "BlockManager.allocate placed from search");
  await idle(f);

  // 7. Note
  await page.mouse.move(700, 700);
  await page.keyboard.press("Escape");
  await page.keyboard.press("n");
  await until("the new Note's editor has the keyboard", () => f.evaluate(() => !!document.activeElement?.closest(".card.note .md-pm")));
  await page.keyboard.type("**Takeaway**: schedule → run → postprocess"); await page.keyboard.press("Escape");
  check(await soon(() => f.locator(".card.note").count(), (n) => n === 1) === 1, "new Note created");
  await until("Esc ends editing the Note", async () => !(await f.locator(".card.note .md-pm").count()));
  await page.keyboard.press("Shift+!"); await idle(f);
  await shot(page, "6-board");

  // 7b. Clipboard while editing a Note: VS Code's webview host runs cut / copy / paste (they must reach it, not stop in the editor)
  {
    const pm = f.locator(".card.note .md-pm");
    const txt = async () => (await pm.count() ? await pm.innerText() : "").replace(/\s+/g, " ").trim();
    // the DOM selection, and ProseMirror has read it (its cut / copy handlers act on the selection it has read)
    const selected = async (s) => { await until(`"${s}" is selected in the Note`, () => f.evaluate((s) => getSelection().toString() === s, s)); await pmHasSelection(f); };
    // the new Note sits at the board's left edge, half under the toolbar: zoom to it first (it is still selected)
    await page.keyboard.press("Shift+Digit2"); await idle(f);
    await f.locator(".card.note .nbody").dblclick();
    await until("the Note's editor has the keyboard", () => f.evaluate(() => !!document.activeElement?.closest(".card.note .md-pm")));
    await focusSettled(f); // or ProseMirror undoes the Ctrl+End and " cutme" replaces the double-clicked word
    await page.keyboard.press("Control+End"); await page.keyboard.type(" cutme");
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
    await selected("cutme");
    await page.keyboard.press("Control+x");
    const afterCut = await soon(txt, (t) => !/cutme$/.test(t));
    await page.keyboard.press("Control+v");
    const afterPaste = await soon(txt, (t) => /cutme$/.test(t));
    // copy the pasted word and paste it again at the end
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
    await selected("cutme");
    // the copy goes through VS Code (the webview host runs it) like the paste after it, on the same channel and in order
    await page.keyboard.press("Control+c");
    await page.keyboard.press("End"); await page.keyboard.type(" "); await page.keyboard.press("Control+v");
    const afterCopy = await soon(txt, (t) => /cutme cutme$/.test(t));
    await page.keyboard.press("Escape");
    const want = "**Takeaway**: schedule → run → postprocess cutme cutme";
    const md = await soon(() => (boardJson()?.cards ?? []).find((c) => c.kind === "note")?.md ?? "", (m) => m === want);
    check(/postprocess $/.test(afterCut) || /postprocess$/.test(afterCut), "Ctrl+X in a Note cuts the selection", afterCut);
    check(/postprocess cutme$/.test(afterPaste), "Ctrl+V in a Note pastes it back", afterPaste);
    check(/cutme cutme$/.test(afterCopy), "Ctrl+C then Ctrl+V in a Note copies", afterCopy);
    check(md === want, "Note saved with the clipboard edits", md);
  }

  // 8. Autosave
  const saved = (b) => b && b.version === BOARD_VERSION && b.cards.length >= 5 && Object.keys(b.place).length === b.cards.length && b.links.length >= 2 && b.sidenotes.length === 1;
  const b = await soon(boardJson, saved);
  check(saved(b), `board autosaved (v${BOARD_VERSION} format)`, b && { cards: b.cards.length, links: b.links.length, notes: b.sidenotes?.length });

  // 8b. Settings: Ctrl+, inside the board opens the Settings page (the extension routes VS Code's own Ctrl+, back to the board); changing the theme writes codeboard.theme
  await clickBoard(f); await boardKeys(page, f);
  await page.keyboard.press("Control+,");
  check(await soon(() => f.locator(".settings").count(), (n) => n === 1) === 1, "Ctrl+, opens the Settings page in the board");
  await f.locator(".st-sw", { hasText: "Graphite" }).click();
  const us = await soon(() => fs.readFileSync(`${UD}/User/settings.json`, "utf8"), (s) => /"codeboard\.theme":\s*"graphite"/.test(s));
  check(/"codeboard\.theme":\s*"graphite"/.test(us), "changing the theme writes codeboard.theme", us.slice(-200));
  check(await soon(() => f.evaluate(() => document.documentElement.dataset.look), (l) => l === "graphite") === "graphite", "board switches to Graphite");
  await shot(page, "7a-settings");
  await page.keyboard.press("Control+,");
  check(await soon(() => f.locator(".settings").count(), (n) => n === 0) === 0, "Ctrl+, again closes the Settings page");
  await command(page, "CodeBoard: Open Settings");
  check(await soon(() => f.locator(".settings").count(), (n) => n === 1) === 1, "command CodeBoard: Open Settings opens the Settings page");
  await f.locator(".st-sw", { hasText: "Warm Ink" }).click();
  await until("the board switches to Warm Ink", () => f.evaluate(() => document.documentElement.dataset.look === "warm-ink"));
  await page.keyboard.press("Escape"); await idle(f);
  // Copy Diagnostics: asks whether to include the board JSON, then says it was copied
  await command(page, "CodeBoard: Copy Diagnostics");
  await boardDialog(page, f, "Copy Diagnostics");
  await page.keyboard.press("Enter"); await boardDialogClosed(f, "the Copy Diagnostics dialog");
  check(await soon(() => page.locator(".notifications-toasts", { hasText: "Diagnostics copied to clipboard" }).count(), (n) => n > 0) > 0, "Copy Diagnostics says it was copied");
  await shot(page, "7b-diagnostics");

  // 8c. Change a card's file outside VS Code (another editor / git checkout): the card shows + uncommitted too
  const orig = fs.readFileSync(ENGINE, "utf8");
  fs.writeFileSync(ENGINE, orig.replace("def step(self):", "def step(self):  # edited outside VS Code"));
  check(await soon(() => f.locator(".rev.unc").count(), (n) => n >= 1, 15000) >= 1, "card shows + uncommitted after the file changes outside VS Code");
  fs.writeFileSync(ENGINE, orig);
  check(await soon(() => f.locator(".rev.unc").count(), (n) => n === 0, 15000) === 0, "+ uncommitted goes away after changing it back");

  // 9. Edit code in the editor: the card shows + uncommitted (nothing committed to git)
  await openFile(page, SCHED, 30);
  await page.keyboard.press("End"); await page.keyboard.type("  # local edit"); await page.keyboard.press("Control+s");
  check(await soon(() => f.locator(".rev.unc").count(), (n) => n >= 1, 15000) >= 1, "card shows + uncommitted after a local edit");
  await shot(page, "7-uncommitted");

  // 10. 共享卡：板 1 上 Ctrl+C 一张卡，新建板 2 上 Ctrl+V = 同一张卡（⧉ 2 boards），板 2 上加的 Sidenote 板 1 上也有
  await clickBoard(f);
  const sch1 = card(f, "Scheduler.schedule");
  const mk0 = await sch1.locator(".mk").count();
  await sch1.locator(".chead .ctitle").click();
  await until("Scheduler.schedule is selected and the board has the keyboard", async () => /\bsel\b/.test(await sch1.getAttribute("class")) && await boardHasKeyboard(f));
  await page.keyboard.press("Control+c");
  await until("the board says the card was copied", async () => /^Copied/.test(await text(f.locator(".toast"))), 5000);
  const g = await newBoard(page, "Shared E2E");
  check(!!g, "New Board opens a second board");
  if (g) {
    await clickBoard(g, { position: { x: 300, y: 300 } });
    // ⌘V pastes what the system clipboard holds (read here in the webview that has the keyboard, as the paste will): the card's code,
    // written by the board on ⌘C and again by the host (handlers.ts copyCards)
    const clip = await soon(() => clipboard(g), (t) => /def schedule\(self\)/.test(t));
    check(/def schedule\(self\)/.test(clip), "Ctrl+C on a card puts its code on the system clipboard", clip?.slice(0, 80));
    await page.keyboard.press("Control+v");
    const sch2 = card(g, "Scheduler.schedule");
    check(await soon(() => sch2.count(), (n) => n === 1) === 1, "Ctrl+V on another board pastes the copied card");
    const badge = await soon(() => text(sch2.locator(".shb")), (t) => /2 boards/.test(t), 5000);
    check(/2 boards/.test(badge), "the pasted card is linked: both boards show ⧉ 2 boards", badge);
    check(await sch2.locator(".mk").count() === mk0, "sidenotes travel with the linked card", { mk0, now: await sch2.locator(".mk").count() });
    await idle(g);
    // 板 2 上给另外两行加一条 Sidenote
    await sidenote(page, g, sch2, 10, 11, "Shared across both boards.");
    await page.keyboard.press("Escape");
    check(await soon(() => sch2.locator(".mk").count(), (n) => n === mk0 + 1) === mk0 + 1, "sidenote added on board 2");
    const mk1 = await soon(() => sch1.locator(".mk").count(), (n) => n > mk0, 5000);
    check(mk1 === mk0 + 1, "the sidenote shows up on board 1 too", { mk0, mk1 });
    check((await text(sch1.locator(".shb"))).includes("2 boards"), "board 1 also shows ⧉ 2 boards");
    await shot(page, "8-shared");
  }

  // 11. 子白板：板 1 画布右键 Insert Board ▸ Shared E2E → 骨架框；双击进去有面包屑，Esc 回来；侧栏 Shared E2E 挂在板 1 下面
  if (g) {
    // Shared E2E 已经在另一个标签页开着时双击框只是切过去：先关掉它
    const tab = (name) => page.locator(".tabs-container .tab", { hasText: name }).first();
    await tab("Shared E2E").click({ button: "middle" });
    await until("the Shared E2E tab closes", async () => !(await page.locator(".tabs-container .tab", { hasText: "Shared E2E" }).count()));
    await tab("New Board").click();
    await until("New Board is the active tab", () => page.locator(".tabs-container .tab.active", { hasText: "New Board" }).count());
    f = await boardFrame(page);
    await idle(f);
    await clickBoard(f);
    await f.locator("#board").click({ button: "right", position: await emptySpot(f) });
    await f.locator(".ctx button", { hasText: /^Insert Board/ }).first().hover(); // the submenu opens on hover; its item's click waits for it
    await f.locator(".ctx button", { hasText: /^Shared E2E/ }).first().click();
    const fr = f.locator(".card.board");
    check(await soon(() => fr.count(), (n) => n === 1) === 1, "Insert Board puts a sub-board frame on the board");
    const subs = await soon(() => fr.locator(".skel [data-sub]").count(), (n) => n >= 1, 5000);
    check(subs >= 1, "the frame shows the sub-board's skeleton", subs);
    check(/1 card/.test(await soon(() => text(fr.locator(".sbmeta")), (t) => /1 card/.test(t), 5000)), "the frame title bar shows the card count");
    await shot(page, "9-subboard");
    await fr.locator(".sbhead").dblclick();
    let fb2 = await boardFrame(page);
    const crumbs = await soon(async () => { fb2 = await boardFrame(page); return text(fb2.locator(".crumbs")); }, (t) => /Shared E2E/.test(t), 10000);
    check(/Shared E2E/.test(crumbs), "double-click enters the sub-board with a breadcrumb");
    await idle(fb2);
    // 侧栏：Shared E2E 挂在板 1 下面（展开）
    await command(page, "Focus on Boards View");
    const sideRows = () => page.locator(".part.sidebar .monaco-list-row").evaluateAll((els) => els.map((e) => `${e.getAttribute("aria-level")}:${e.textContent}`));
    const rows = await soon(sideRows, (r) => r.some((x) => /^2:.*Shared E2E/.test(x)));
    await idle(fb2);
    await page.screenshot({ path: `${OUT}/9b-sidebar-nesting.png` });
    check(rows.some((r) => /^2:.*Shared E2E/.test(r)), "sidebar nests the sub-board under its parent", rows.slice(0, 8));
    // 回去：点面包屑里的上一级（Esc 在 harness 的 subboards 里测；这里 xvfb 下侧栏拿走焦点后按键进不了 webview）
    await fb2.locator(".crumbs button", { hasText: "New Board" }).first().click();
    const home = await soon(async () => { fb2 = await boardFrame(page); return [await fb2.locator(".crumbs").count(), await fb2.locator(".card.board").count()]; }, ([c, n]) => c === 0 && n === 1, 10000);
    check(home[0] === 0 && home[1] === 1, "clicking the parent crumb returns to the parent board");
    f = fb2; await idle(f);
  }

  // 12. 动态分发选实现（线框 01）：调用处的静态类型是基类，Pylance 的 Implementation 列出两个子类；选一个建卡，另一个是灰色备选框。
  // 没装 Pylance（E2E_EXTENSIONS 里没有）时 Python 没有语言服务，跳过
  if (/pylance/i.test(process.env.E2E_EXTENSIONS || "")) {
    const DISPATCH = W("nanovllm/e2e_dispatch.py");
    fs.writeFileSync(DISPATCH, [
      "class Sampler:", "    def sample(self, logits):", "        raise NotImplementedError", "", "",
      "class Greedy(Sampler):", "    def sample(self, logits):", "        return logits.argmax(-1)", "", "",
      "class TopK(Sampler):", "    def sample(self, logits):", "        return logits.topk(5)", "", "",
      "def pick_tokens(s: Sampler, logits):", "    return s.sample(logits)", "",
    ].join("\n"));
    // Pylance has analysed the new file once it answers a hover on s.sample there (it answers a file's requests after analysing it)
    await openFile(page, DISPATCH, 17);
    await goToLine(page, 17, 14);
    await command(page, "Show or Focus Hover");
    await until("Pylance answers a hover on s.sample in the new file", async () => /def sample\(/.test((await page.locator(".monaco-hover .hover-contents").allInnerTexts()).join(" ")), 60000, 200);
    await page.keyboard.press("Escape");
    await goToLine(page, 16); // def 那一行：光标在调用上时 Alt+B 会顺带把被调的也放上来
    f = await altB(page, "pick_tokens");
    await idle(f);
    const pt = card(f, "pick_tokens");
    check(await pt.count() === 1, "Alt+B puts pick_tokens on the board");
    // 白板窄、卡多，适应窗口后在概览档（代码是灰条，点不到调用）：照用户的做法双击这张卡，放大到它 100%
    // （适应窗口在 ~28%，Zoom In 一次 ×1.25、以画面中心放大，到 60% 的完整档之前卡就出了右边；
    // 不按键：焦点可能还在编辑器里，Shift+2 会把 @ 打进代码）
    await fit(f); await idle(f);
    if (await pt.locator(".ovm").isVisible()) { await pt.locator(".ovm").dblclick(); await idle(f); }
    check(!(await pt.locator(".ovm").isVisible()), "double-clicking a card in the overview zooms to it");
    await pt.locator(".src .call", { hasText: /^sample$/ }).first().click({ timeout: 8000 });
    const impls = await soon(() => f.locator(".pop.k-impls .cand").count(), (n) => n === 2, 20000);
    check(impls === 2, "clicking s.sample lists the 2 implementations (Pylance Implementation)", impls);
    check(/2 implementations of/.test(await text(f.locator(".pop.k-impls .pt"))), "the picker names the base method");
    if (impls === 2) {
      await f.locator(".pop.k-impls input.fld").fill("top-k sampling in this config");
      await f.locator(".pop.k-impls .cand", { hasText: "TopK.sample" }).first().click();
    }
    check(await soon(() => card(f, "TopK.sample").count(), (n) => n === 1, 20000) === 1, "picking TopK.sample puts it on the board");
    check(await soon(() => f.locator(".altbox", { hasText: "Greedy.sample" }).count(), (n) => n === 1) === 1, "Greedy.sample stays as a grey alternative");
    await shot(page, "10-pick-impl");
  } else console.log("- skip pick-implementation step (no Pylance in E2E_EXTENSIONS)");

  if (process.env.E2E_PART !== "1") { await captureStep(page); await addselStep(page); await cardfocusStep(page); await keyscopeStep(page); await closeStep(page); await projectsStep(); }
  await finish(browser, errors);
})().catch((e) => { console.error(e); process.exit(2); });

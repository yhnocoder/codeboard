// 编辑器 Review（不进 CI）：真 VS Code 里，Note 编辑时常用快捷键是否生效。DRIVER=review-keys.cjs bash test/run.sh
// Records what each key did (review-keys.json) rather than judging it. After each key the board is waited on until it has settled
// (wait.cjs idle: nothing waiting on the host, no DOM change for a moment), never for a fixed time
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { until, idle, track } = require("./wait.cjs");
const { command, openBoard, openFile, boardFrames, boardFrame, card, typingIn, pmHasSelection } = require("./ui.cjs");
const [OUT, WS] = process.argv.slice(2);
const res = {};
(async () => {
  const browser = await until("VS Code's debugging port answers", () => chromium.connectOverCDP(`http://127.0.0.1:${process.env.CDP_PORT || 9223}`).catch(() => null), 60000, 500);
  const page = await until("the VS Code window", () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench")), 60000, 200);
  await track(page);
  await page.locator(".monaco-workbench .part.editor").waitFor({ timeout: 60000 });
  await openFile(page, path.join(WS, "nanovllm/engine/llm_engine.py"), 51);
  await page.keyboard.press("Alt+b");
  await until("Alt+B puts LLMEngine.step on the board", async () => { const [b] = await boardFrames(page); return b && card(b, "LLMEngine.step").count(); }, 30000, 100);
  await openBoard(page);
  const f = await boardFrame(page); await idle(f);
  const pm = () => f.locator(".md-pm");
  // Read at once (Playwright's innerText() / innerHTML() would wait out their timeout for an editor that has closed)
  const now = async (get, none = "(gone)") => (await pm().count()) ? get(pm().first()) : none;
  const text = () => now((l) => l.innerText(), "(no editor)");
  const html = () => now((l) => l.innerHTML());
  const zoom = () => f.evaluate(() => getComputedStyle(document.querySelector(".world")).transform);
  // The clipboard, read in the board's webview (it has the keyboard; the workbench page is not allowed to read it)
  const clip = () => f.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${e.message}`);
  const key = async (k) => { await page.keyboard.press(k); await idle(f); };
  const startEdit = async (s) => {
    if (await pm().count()) { await page.keyboard.press("Escape"); await until("the editor closes", async () => !(await pm().count()), 5000); }
    await f.locator("#board").click({ position: { x: 400, y: 300 } });
    await page.keyboard.press("t");
    await until("a new Text card's editor has the keyboard", () => typingIn(f, ".md-pm"), 5000);
    await page.keyboard.type(s); await idle(f);
  };
  const sel = async (n) => { for (let i = 0; i < n; i++) await page.keyboard.press("Shift+ArrowLeft"); await pmHasSelection(f); };
  const run = async (name, fn) => { try { res[name] = await fn(); } catch (e) { res[name] = { err: e.message.split("\n")[0] }; } console.log(name, JSON.stringify(res[name])); };

  const rectOf = (word) => f.evaluate((word) => { const root = document.querySelector(".md-pm"); const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.textContent.indexOf(word); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const b = r.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; } } return null; }, word);
  const frameOff = async () => (await f.frameElement()).boundingBox();
  await run("mouseSelectCut", async () => {
    await startEdit("alpha beta gamma"); const r = await rectOf("beta"); const o = await frameOff();
    const y = o.y + r.y + r.h / 2;
    await page.mouse.move(o.x + r.x + 1, y); await page.mouse.down(); await page.mouse.move(o.x + r.x + r.w / 2, y, { steps: 3 }); await page.mouse.move(o.x + r.x + r.w - 1, y, { steps: 3 }); await page.mouse.up(); await idle(f);
    const selTxt = await f.evaluate(() => getSelection().toString());
    await key("Control+x");
    return { selTxt, text: await text(), cardMoved: false };
  });
  await run("dblclickWord", async () => { const r = await rectOf("gamma"); const o = await frameOff(); await page.mouse.dblclick(o.x + r.x + r.w / 2, o.y + r.y + r.h / 2); await idle(f); const selTxt = await f.evaluate(() => getSelection().toString()); await key("Control+c"); await page.keyboard.press("End"); await key("Control+v"); return { selTxt, text: await text() }; });
  await run("cut", async () => { await startEdit("alpha beta"); await sel(4); await key("Control+x"); return { text: await text(), clip: await clip() }; });
  await run("paste", async () => { await key("Control+v"); return { text: await text() }; });
  await run("copy", async () => { await sel(4); await key("Control+c"); return { clip: await clip() }; });
  await run("selectAll", async () => { await key("Control+a"); return { sel: await f.evaluate(() => getSelection().toString()), cards: await f.locator(".card.sel").count() }; });
  await run("undo", async () => { await page.keyboard.press("End"); await page.keyboard.type(" zzz"); await idle(f); await key("Control+z"); return { text: await text() }; });
  await run("redo", async () => { await key("Control+Shift+z"); return { text: await text() }; });
  await run("bold", async () => { await sel(3); await key("Control+b"); return { html: await html() }; });
  await run("ctrlK", async () => { await page.keyboard.press("End"); await sel(3); await key("Control+k"); const r = { palette: await f.locator(".palette").count(), linkInput: await f.locator(".md-linkin").count(), editing: await pm().count(), vscodeChord: await page.locator(".statusbar").innerText() }; await key("Escape"); return r; });
  await run("ctrlD", async () => { await startEdit("dup test"); const n0 = await f.locator(".card").count(); await key("Control+d"); return { cardsBefore: n0, cardsAfter: await f.locator(".card").count(), editing: await pm().count() }; });
  await run("ctrlEq", async () => { await startEdit("zoom test"); const z0 = await zoom(); await key("Control+="); return { zoomChanged: z0 !== (await zoom()), editing: await pm().count(), text: await text() }; });
  await run("ctrl1", async () => { await startEdit("head test"); const z0 = await zoom(); await key("Control+1"); return { zoomChanged: z0 !== (await zoom()), html: await html() }; });
  await run("ctrl0", async () => { await startEdit("para test"); const z0 = await zoom(); await key("Control+0"); return { zoomChanged: z0 !== (await zoom()), editing: await pm().count() }; });
  await run("ctrlMinus", async () => { await startEdit("minus"); const z0 = await zoom(); await key("Control+-"); return { zoomChanged: z0 !== (await zoom()), editing: await pm().count() }; });
  await run("ctrlSlash", async () => { await startEdit("raw test"); await key("Control+/"); const r = { raw: await f.locator(".md-srcmode .cm-content").count() }; await key("Control+/"); return r; });
  await run("ctrlS", async () => { await startEdit("save test"); await key("Control+s"); return { editing: await pm().count(), text: await text() }; });
  await run("ctrlShiftL", async () => { await startEdit("lock test"); await key("Control+Shift+l"); return { editing: await pm().count(), locked: await f.locator(".card.locked, .card .lock").count() }; });
  await run("ctrlComma", async () => { await startEdit("settings test"); await key("Control+,"); return { editing: await pm().count(), settings: await f.locator(".settings").count() }; });
  await run("ctrlShiftV", async () => {
    await key("Escape"); await startEdit("pp ");
    await f.evaluate(() => navigator.clipboard.writeText("**raw**")); // in the board's webview, which has the keyboard
    await key("Control+Shift+v"); return { html: await html() };
  });
  await run("ctrlE", async () => { await startEdit("code word"); await sel(4); await key("Control+e"); return { html: await html() }; });
  await run("ctrlShiftS", async () => { await startEdit("strike word"); await sel(4); await key("Control+Shift+s"); return { html: await html() }; });
  await run("ctrlAltC", async () => { await startEdit("cb"); await key("Control+Alt+c"); return { html: await html() }; });
  await run("ctrlShift8", async () => { await startEdit("ul"); await key("Control+Shift+8"); return { html: await html() }; });
  await page.screenshot({ path: `${OUT}/review-keys.png` });
  fs.writeFileSync(`${OUT}/review-keys.json`, JSON.stringify(res, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

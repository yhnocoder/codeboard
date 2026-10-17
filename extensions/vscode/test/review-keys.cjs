// v0.1.8 编辑器 Review（不进 CI）：真 VS Code 里，Note 编辑时常用快捷键是否生效。DRIVER=review-keys.cjs bash test/run.sh
const { chromium } = require("playwright-core");
const fs = require("fs");
const [OUT] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = {};
async function boardFrame(page) {
  for (let i = 0; i < 80; i++) { for (const f of page.frames()) { try { if (await f.$("#board")) return f; } catch {} } await sleep(500); }
  throw new Error("board webview not found");
}
async function command(page, text) { await page.keyboard.press("F1"); await sleep(500); await page.keyboard.type(text); await sleep(800); await page.keyboard.press("Enter"); await sleep(1500); }
(async () => {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.CDP_PORT || 9223}`); } catch { await sleep(1000); } }
  let page;
  for (let i = 0; i < 60 && !page; i++) { page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench")); if (!page) await sleep(1000); }
  await sleep(6000);
  await command(page, "View: Focus First Editor Group");
  await page.keyboard.press("Control+p"); await sleep(500); await page.keyboard.type("llm_engine.py"); await sleep(2500); await page.keyboard.press("Enter"); await sleep(1500);
  await page.keyboard.press("Control+g"); await sleep(300); await page.keyboard.type("51"); await page.keyboard.press("Enter"); await sleep(400);
  await page.keyboard.press("Alt+b"); await sleep(2500);
  await command(page, "CodeBoard: Open Board");
  const f = await boardFrame(page); await sleep(2000);
  const pm = () => f.locator(".md-pm");
  const text = () => pm().innerText().catch(() => "(no editor)");
  const zoom = () => f.evaluate(() => getComputedStyle(document.querySelector(".world")).transform);
  const clip = () => page.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${e.message}`);
  const startEdit = async (s) => {
    if (await pm().count()) { await page.keyboard.press("Escape"); await sleep(800); }
    await f.locator("#board").click({ position: { x: 400, y: 300 } }); await sleep(300);
    await page.keyboard.press("t"); await sleep(1200);
    await pm().waitFor({ timeout: 5000 });
    await page.keyboard.type(s, { delay: 20 }); await sleep(300);
  };
  const sel = (n) => (async () => { for (let i = 0; i < n; i++) await page.keyboard.press("Shift+ArrowLeft"); await sleep(150); })();
  const run = async (name, fn) => { try { res[name] = await fn(); } catch (e) { res[name] = { err: e.message.split("\n")[0] }; } console.log(name, JSON.stringify(res[name])); };

  const rectOf = (word) => f.evaluate((word) => { const root = document.querySelector(".md-pm"); const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.textContent.indexOf(word); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + word.length); const b = r.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; } } return null; }, word);
  const frameOff = async () => { const b = await (await f.frameElement()).boundingBox(); return b; };
  await run("mouseSelectCut", async () => {
    await startEdit("alpha beta gamma"); const r = await rectOf("beta"); const o = await frameOff();
    const y = o.y + r.y + r.h / 2;
    await page.mouse.move(o.x + r.x + 1, y); await page.mouse.down(); await page.mouse.move(o.x + r.x + r.w / 2, y, { steps: 3 }); await page.mouse.move(o.x + r.x + r.w - 1, y, { steps: 3 }); await page.mouse.up(); await sleep(300);
    const selTxt = await f.evaluate(() => getSelection().toString());
    await page.keyboard.press("Control+x"); await sleep(400);
    return { selTxt, text: await text(), cardMoved: false };
  });
  await run("dblclickWord", async () => { const r = await rectOf("gamma"); const o = await frameOff(); await page.mouse.dblclick(o.x + r.x + r.w / 2, o.y + r.y + r.h / 2); await sleep(300); const selTxt = await f.evaluate(() => getSelection().toString()); await page.keyboard.press("Control+c"); await sleep(200); await page.keyboard.press("End"); await page.keyboard.press("Control+v"); await sleep(300); return { selTxt, text: await text() }; });
  await run("cut", async () => { await startEdit("alpha beta"); await sel(4); await page.keyboard.press("Control+x"); await sleep(400); return { text: await text(), clip: await clip() }; });
  await run("paste", async () => { await page.keyboard.press("Control+v"); await sleep(400); return { text: await text() }; });
  await run("copy", async () => { await sel(4); await page.keyboard.press("Control+c"); await sleep(400); return { clip: await clip() }; });
  await run("selectAll", async () => { await page.keyboard.press("Control+a"); await sleep(300); return { sel: await f.evaluate(() => getSelection().toString()), cards: await f.locator(".card.sel").count() }; });
  await run("undo", async () => { await page.keyboard.press("End"); await page.keyboard.type(" zzz"); await sleep(200); await page.keyboard.press("Control+z"); await sleep(300); return { text: await text() }; });
  await run("redo", async () => { await page.keyboard.press("Control+Shift+z"); await sleep(300); return { text: await text() }; });
  await run("bold", async () => { await sel(3); await page.keyboard.press("Control+b"); await sleep(300); return { html: await pm().innerHTML() }; });
  await run("ctrlK", async () => { await page.keyboard.press("End"); await sel(3); await page.keyboard.press("Control+k"); await sleep(800); const r = { palette: await f.locator(".palette").count(), linkInput: await f.locator(".md-linkin").count(), editing: await pm().count(), vscodeChord: await page.locator(".statusbar").innerText().catch(() => "") }; await page.keyboard.press("Escape"); await sleep(400); return r; });
  await run("ctrlD", async () => { await startEdit("dup test"); const n0 = await f.locator(".card").count(); await page.keyboard.press("Control+d"); await sleep(800); return { cardsBefore: n0, cardsAfter: await f.locator(".card").count(), editing: await pm().count() }; });
  await run("ctrlEq", async () => { await startEdit("zoom test"); const z0 = await zoom(); await page.keyboard.press("Control+="); await sleep(700); return { zoomChanged: z0 !== (await zoom()), editing: await pm().count(), text: await text() }; });
  await run("ctrl1", async () => { await startEdit("head test"); const z0 = await zoom(); await page.keyboard.press("Control+1"); await sleep(700); return { zoomChanged: z0 !== (await zoom()), html: await pm().innerHTML().catch(() => "(gone)") }; });
  await run("ctrl0", async () => { await startEdit("para test"); const z0 = await zoom(); await page.keyboard.press("Control+0"); await sleep(700); return { zoomChanged: z0 !== (await zoom()), editing: await pm().count() }; });
  await run("ctrlMinus", async () => { await startEdit("minus"); const z0 = await zoom(); await page.keyboard.press("Control+-"); await sleep(700); return { zoomChanged: z0 !== (await zoom()), editing: await pm().count() }; });
  await run("ctrlSlash", async () => { await startEdit("raw test"); await page.keyboard.press("Control+/"); await sleep(500); const r = { raw: await f.locator(".md-raw").count() }; await page.keyboard.press("Control+/"); await sleep(300); return r; });
  await run("ctrlS", async () => { await startEdit("save test"); await page.keyboard.press("Control+s"); await sleep(600); return { editing: await pm().count(), text: await text() }; });
  await run("ctrlShiftL", async () => { await startEdit("lock test"); await page.keyboard.press("Control+Shift+l"); await sleep(600); return { editing: await pm().count(), locked: await f.locator(".card.locked, .card .lock").count() }; });
  await run("ctrlComma", async () => { await startEdit("settings test"); await page.keyboard.press("Control+,"); await sleep(800); return { editing: await pm().count(), settings: await f.locator(".settings").count() }; });
  await run("ctrlShiftV", async () => { await page.keyboard.press("Escape"); await sleep(500); await startEdit("pp "); await page.evaluate(() => navigator.clipboard.writeText("**raw**")).catch(() => {}); await page.keyboard.press("Control+Shift+v"); await sleep(500); return { html: await pm().innerHTML().catch(() => "(gone)") }; });
  await run("ctrlE", async () => { await startEdit("code word"); await sel(4); await page.keyboard.press("Control+e"); await sleep(500); return { html: await pm().innerHTML().catch(() => "(gone)") }; });
  await run("ctrlShiftS", async () => { await startEdit("strike word"); await sel(4); await page.keyboard.press("Control+Shift+s"); await sleep(500); return { html: await pm().innerHTML().catch(() => "(gone)") }; });
  await run("ctrlAltC", async () => { await startEdit("cb"); await page.keyboard.press("Control+Alt+c"); await sleep(500); return { html: await pm().innerHTML().catch(() => "(gone)") }; });
  await run("ctrlShift8", async () => { await startEdit("ul"); await page.keyboard.press("Control+Shift+8"); await sleep(500); return { html: await pm().innerHTML().catch(() => "(gone)") }; });
  await page.screenshot({ path: `${OUT}/review-keys.png` });
  fs.writeFileSync(`${OUT}/review-keys.json`, JSON.stringify(res, null, 1));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

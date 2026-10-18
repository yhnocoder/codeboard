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
  await page.keyboard.press("Alt+b"); await sleep(2500);
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page); await sleep(1500);
  const sch = card(f, "Scheduler.schedule");
  check(await sch.count() === 1, "Alt+B puts Scheduler.schedule on the board");
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
  for (let i = 0; i < 30 && !live; i++) { await sleep(500); f = await boardFrame(page); live = /# tuned/.test(await card(f, "Scheduler.schedule").locator(".src").textContent().catch(() => "")); }
  check(live, "editing the worktree file refreshes the variant on the card");
  // 切回上游：代码换回来、MINE 没了
  await card(f, "Scheduler.schedule").locator(".vtab.up").click(); await sleep(600);
  check(await card(f, "Scheduler.schedule").locator(".chead .mine").count() === 0 && !/keep order/.test(await card(f, "Scheduler.schedule").locator(".src").textContent()), "switching back to Upstream shows the upstream code");
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
  const line = async (t) => { await type(t); await page.keyboard.press("Escape"); await page.keyboard.press("Enter"); }; // Esc 先关补全菜单（Enter 会接受补全）
  const menu = async () => { await f.locator(".cbcm-ac li").first().waitFor({ timeout: 8000 }).catch(() => {}); await sleep(500); return f.locator(".cbcm-ac li .cm-completionLabel").allTextContents().catch(() => []); };
  /** 打 t，等菜单里出现 want；没有就删掉、等语言服务分析完再试 */
  const ask = async (t, want) => {
    let items = [];
    for (let i = 0; i < 4 && !items.includes(want); i++) {
      if (i) { await page.keyboard.press("Escape"); for (let k = 0; k < t.length; k++) await page.keyboard.press("Backspace"); await sleep(2500); }
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
  await page.keyboard.press("Escape"); await line("'a')");
  const abs = await ask("BlockManager.", "allocate");
  check(abs.includes("allocate"), "an absolute import from the workspace resolves (BlockManager. lists allocate)", abs.slice(0, 8));
  await page.keyboard.press("Escape"); await line("allocate");
  const rel = await ask("Scheduler.", "schedule");
  check(rel.includes("schedule"), "a relative import next to the source resolves (Scheduler. lists schedule)", rel.slice(0, 8));
  await page.keyboard.press("Escape"); await type("schedule");
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await sleep(1500);
  const b = boardJson();
  const fc = b && b.cards.find((k) => k.kind === "code" && k.segments[0].src.kind === "free");
  check(fc && fc.segments[0].text.join("\n").includes("os.path.join('a')"), "the edited code is saved on the card", fc && fc.segments[0].text);
  await sleep(1000);
  check(!fs.readdirSync(scratch).some((n) => n.startsWith(".codeboard-")), "the hidden file is deleted when editing ends");
  await command(page, "Developer: Reload Window"); await sleep(9000);
  const tabs = await page.locator(".tabs-container .tab").allTextContents().catch(() => []);
  check(!tabs.some((t) => /codeboard-|Untitled/.test(t)), "no leftover editor tab for the virtual document after reloading the window", tabs);
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
  if (process.env.E2E_ONLY === "capture") { await captureStep(page); return finish(browser, errors); }
  if (process.env.E2E_ONLY === "export") { await exportStep(page); return finish(browser, errors); }
  if (process.env.E2E_ONLY === "variants") { await variantsStep(page); return finish(browser, errors); }
  if (process.env.E2E_ONLY === "codeedit") { await codeeditStep(page); return finish(browser, errors); }
  if (process.env.E2E_ONLY === "addsel") { await addselStep(page); return finish(browser, errors); }
  if (process.env.E2E_ONLY === "cardfocus") { await cardfocusStep(page); return finish(browser, errors); }

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
  check((await card(f, "Scheduler.schedule").locator(".chead .step").textContent().catch(() => "")) === "A", "child card shows its tree letter A");
  check(await f.locator("path.edge").count() >= 1, "call link drawn");
  // 3. Click postprocess: second child in the same tree
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
  // Move away onto the code below the name (the peek opens above it here), then out of the webview in steps.
  // Synthetic CDP moves that leave the iframe deliver no leave events to it, so the path must not leave the webview straight from the peek:
  // the peek would keep :hover and stay open, which is a test artefact rather than what a real mouse does
  const w = await sch.locator(".src .call", { hasText: /^can_allocate$/ }).first().boundingBox();
  // 停在卡下面的空白画布上：停在代码行上可能正好落在另一个调用上，又打开一个 Peek
  const cb = await sch.boundingBox();
  const y = cb ? cb.y + cb.height + 30 : w ? w.y + w.height + 40 : 500;
  if (w) await page.mouse.move(w.x + w.width / 2, y, { steps: 4 });
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
    // 空白处右键：镜头会跟着卡走，固定坐标可能落在卡上，找一块没有东西的地方
    const empty = await f.evaluate(() => {
      for (let y = 120; y < innerHeight - 120; y += 40) for (let x = 40; x < innerWidth - 40; x += 40) {
        const e = document.elementFromPoint(x, y);
        if (e && e.closest("#board") && !e.closest(".card, .pill, .dock, .ctx, svg [data-link], .crumbs")) return { x, y };
      }
      return { x: 260, y: 520 };
    });
    await f.locator("#board").click({ button: "right", position: empty }); await sleep(500);
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

  await captureStep(page);
  await addselStep(page);
  await cardfocusStep(page);
  await finish(browser, errors);
})().catch((e) => { console.error(e); process.exit(2); });

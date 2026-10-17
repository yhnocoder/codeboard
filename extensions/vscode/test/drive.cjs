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
    await f.locator("#board").click({ button: "right", position: { x: 260, y: 520 } }); await sleep(500);
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
    // 白板窄、卡多，适应窗口后在概览档（代码是灰条，点不到调用）：用白板自己的按钮放大一档
    // （不按键：焦点可能还在编辑器里，Shift+2 会把 @ 打进代码）
    await f.locator('button[aria-label="Fit to Window"]').first().click(); await sleep(1200);
    for (let i = 0; i < 3 && await pt.locator(".ovm").isVisible().catch(() => false); i++) { await f.locator('button[aria-label="Zoom In"]').first().click(); await sleep(900); }
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

  check(!errors.length, "no webview errors", errors.slice(0, 3));
  fs.writeFileSync(`${OUT}/audit.json`, JSON.stringify(audits, null, 1));
  console.log(failed ? `${failed} checks failed` : "all passed");
  await browser.close().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

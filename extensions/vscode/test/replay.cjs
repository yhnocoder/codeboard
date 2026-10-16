// 学习任务回放：在真实 VS Code 里按固定步骤把 nano-vllm 的 LLMEngine.step 画成白板。
// 每步：操作 → 检查结果 → 等画布静止 → 截白板 → 跑通用界面断言（tools/review/audit.cjs）。
// 某一步失败不会中断后面的步骤：记下失败、截图，继续走。
// 用法：DRIVER=replay.cjs E2E_OUT=test-out/replay npm run e2e   结果：<OUT>/rNN-*.png、audit.json、steps.json
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { audit } = require("../../../tools/review/audit.cjs");
const [OUT, WS, UD] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = [], audits = [];
let failed = 0, cur = null;
const check = (ok, what, extra) => {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${!ok && extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 300) : ""}`);
  cur?.checks.push({ ok: !!ok, what, extra: ok ? undefined : extra });
  if (!ok) failed++;
};

async function boardFrame(page) {
  for (let i = 0; i < 80; i++) {
    for (const f of page.frames()) { try { if (await f.$("#board")) return f; } catch {} }
    await sleep(500);
  }
  throw new Error("找不到白板 webview");
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
const settle = (fr) => fr.evaluate(async () => {
  const sig = () => { const w = document.querySelector(".world"); return (w ? getComputedStyle(w).transform : "") + "|" + [...document.querySelectorAll(".card")].map((c) => { const r = c.getBoundingClientRect(); return `${r.x | 0},${r.y | 0},${r.width | 0},${r.height | 0}`; }).join(";") + "|" + (document.querySelector("#board")?.innerHTML.length ?? 0); }; // 含 DOM 大小：语义高亮晚到也算没静止
  let last = "", same = 0;
  for (let i = 0; i < 80 && same < 14; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const busy = document.getAnimations().some((a) => a.playState === "running" && a.effect?.getTiming().iterations !== Infinity);
    const s = sig(); same = !busy && s === last ? same + 1 : 0; last = s;
  }
}).catch(() => {});
async function shot(page, fr, name) {
  await settle(fr);
  const box = await (await fr.frameElement()).boundingBox();
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: box ?? undefined });
  const r = await audit(fr, name); audits.push(r);
  for (const i of r.issues) console.log(`  ⚠ ${i.rule} — ${i.what}`);
  if (process.env.AUDIT_STRICT === "1") check(!r.issues.length, "通过界面断言", r.issues);
}
const card = (f, title) => f.locator(".card", { has: f.locator(".chead .ctitle", { hasText: new RegExp(`^${title.replace(/\./g, "\\.")}$`) }) });
const callIn = (f, title, name) => card(f, title).locator(".src .call", { hasText: new RegExp(`^${name}$`) }).first();
const boardJson = () => {
  const d = execSync(`ls -d ${UD}/User/workspaceStorage/*/*codeboard*/boards 2>/dev/null || true`).toString().trim().split("\n")[0];
  if (!d) return null;
  const f = fs.readdirSync(d).find((n) => n.endsWith(".json"));
  return f ? JSON.parse(fs.readFileSync(path.join(d, f), "utf8")) : null;
};
const nCards = (b) => (b?.cards ?? []).length;
// 白板自动存盘有延迟：轮询存盘文件，直到满足条件或超时，返回最后读到的内容
async function waitJson(pred, ms = 5000) {
  let b = null;
  for (let t = 0; t < ms; t += 250) { b = boardJson(); try { if (b && pred(b)) return b; } catch {} await sleep(250); }
  return b;
}
// 点空白处取消选择、关掉弹层
const blank = async (f, page) => { await page.keyboard.press("Escape"); await page.keyboard.press("Escape"); await f.locator("#board").click({ position: { x: 12, y: 160 }, force: true }); await sleep(250); };
// 卡片里当前在视口内的行号元素（缩放后卡片可能有一部分在视口外）
async function visibleRows(f, c) {
  const all = c.locator(".no"), out = [];
  const vh = await f.evaluate(() => innerHeight);
  for (let i = 0; i < await all.count(); i++) { const b = await all.nth(i).boundingBox(); if (b && b.y > 40 && b.y + b.height < vh - 90) out.push(all.nth(i)); }
  return out;
}
// 选中一张卡并缩放到它（Shift+2），保证代码行看得清、点得到
const focusCard = async (f, page, title) => { await blank(f, page); await card(f, title).locator(".chead").click({ position: { x: 120, y: 8 }, force: true }); await page.keyboard.press("Shift+@"); await sleep(900); };
async function menu(f, target, label, sub, opts = {}) {
  await target.click({ button: "right", ...opts }); await sleep(400);
  await f.locator(".ctx button", { hasText: new RegExp(`^${label}`) }).first()[sub ? "hover" : "click"](); await sleep(400);
  if (sub) { await f.locator(".ctx button", { hasText: new RegExp(`^${sub}`) }).last().click(); await sleep(500); }
}

(async () => {
  let browser;
  for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP("http://127.0.0.1:9223"); } catch { await sleep(1000); } }
  if (!browser) throw new Error("连不上 VS Code");
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("workbench"));
    if (!page) await sleep(1000);
  }
  if (!page) throw new Error("找不到 VS Code 主窗口");
  await sleep(6000);
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && /codeboard|board\.js/i.test(m.text())) errors.push(m.text()); });
  let f = null;
  // 白板所在的编辑器组最大化（默认和代码各占半边，白板只有 ~540px 宽，缩放后点不到东西）
  const maximize = async () => { await command(page, "View: Focus Second Editor Group"); await command(page, "View: Maximize Editor Group"); await sleep(1200); };

  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  const step = async (name, title, fn) => {
    if (only && !only.some((o) => name.startsWith(o))) return;
    cur = { name, title, checks: [] }; steps.push(cur);
    console.log(`▶ ${name} ${title}`);
    try { await fn(); } catch (e) { check(false, "步骤没有报错", String(e.message || e).split("\n")[0]); }
    try { if (f) await shot(page, f, name); } catch (e) { console.log("  截图失败", e.message); }
  };

  await step("r01-first-card", "函数里按 Alt+B，打开白板", async () => {
    await openFile(page, "llm_engine.py", 51);
    await page.keyboard.press("Alt+b"); await sleep(2500);
    await command(page, "CodeBoard: Open Board");
    f = await boardFrame(page); await sleep(1500);
    await maximize();
    check(await card(f, "LLMEngine.step").count() === 1, "LLMEngine.step 放上白板");
  });

  await step("r02-expand", "展开 schedule、postprocess，再从 schedule 里展开 can_allocate", async () => {
    await callIn(f, "LLMEngine.step", "schedule").click(); await sleep(1800);
    await blank(f, page);
    await callIn(f, "LLMEngine.step", "postprocess").click(); await sleep(1800);
    await blank(f, page);
    await callIn(f, "Scheduler.schedule", "can_allocate").click(); await sleep(1800);
    await blank(f, page);
    check(await card(f, "Scheduler.schedule").count() === 1 && await card(f, "Scheduler.postprocess").count() === 1, "两张子卡");
    check(await card(f, "BlockManager.can_allocate").count() === 1, "孙卡 BlockManager.can_allocate");
    const n = await card(f, "BlockManager.can_allocate").locator(".step").textContent().catch(() => "");
    check(n === "1.1", "孙卡编号 1.1", n);
    await page.keyboard.press("Shift+!"); await sleep(600);
  });

  await step("r03-tidy-right", "Tidy Layout ▸ Right", async () => {
    await menu(f, card(f, "LLMEngine.step").locator(".chead"), "Tidy Layout", "Right", { position: { x: 120, y: 12 } });
    await page.keyboard.press("Shift+!"); await sleep(600);
    const box = async (t) => card(f, t).boundingBox();
    const p = await box("LLMEngine.step"), c = await box("Scheduler.schedule");
    check(p && c && c.x > p.x + p.width - 4, "子卡在父卡右侧", { p, c });
  });

  await step("r04-tidy-down", "Tidy Layout ▸ Down", async () => {
    await menu(f, card(f, "LLMEngine.step").locator(".chead"), "Tidy Layout", "Down", { position: { x: 120, y: 12 } });
    await page.keyboard.press("Shift+!"); await sleep(600);
    const p = await card(f, "LLMEngine.step").boundingBox(), c = await card(f, "Scheduler.schedule").boundingBox();
    check(p && c && c.y > p.y + p.height - 4, "子卡在父卡下方", { p, c });
  });

  await step("r05-section", "把 schedule 和 can_allocate 放进新 Section，命名，折叠再展开", async () => {
    await card(f, "Scheduler.schedule").locator(".chead").click({ position: { x: 120, y: 12 } });
    await card(f, "BlockManager.can_allocate").locator(".chead").click({ position: { x: 120, y: 12 }, modifiers: ["Shift"] }); await sleep(300);
    await menu(f, card(f, "BlockManager.can_allocate").locator(".chead"), "Move to New Section", null, { position: { x: 120, y: 12 } });
    await page.keyboard.press("Control+a"); await page.keyboard.type("Scheduling"); await page.keyboard.press("Enter"); await sleep(600);
    const b = await waitJson((b) => b.sections?.[0]?.title === "Scheduling");
    check(b?.sections?.length === 1 && b.sections[0].title === "Scheduling", "Section 已建并命名", b?.sections);
    const col = f.locator('button[aria-label="Collapse Section"]').first();
    await col.click(); await sleep(900);
    check(await f.locator('button[aria-label="Expand Section"]').count() === 1, "Section 折叠");
    await f.locator('button[aria-label="Expand Section"]').first().click(); await sleep(900);
    await blank(f, page);
  });

  await step("r06-sidenote", "选两行加多行旁注（含公式）", async () => {
    const st = card(f, "LLMEngine.step");
    await focusCard(f, page, "LLMEngine.step");
    const nos = await visibleRows(f, st);
    await nos[1].click(); await nos[2].click({ modifiers: ["Shift"] });
    if (process.env.DEBUG) console.log("  focus", await f.evaluate(() => [document.hasFocus(), document.activeElement?.tagName, document.activeElement?.className]));
    await page.keyboard.press("s"); await sleep(600);
    if (process.env.DEBUG) { console.log("  after s", await f.evaluate(() => [document.activeElement?.tagName, document.activeElement?.className, document.querySelectorAll(".sn-edit, .addnote").length])); await page.screenshot({ path: `${OUT}/dbg-s.png`, clip: await (await f.frameElement()).boundingBox() }); }
    await f.locator(".pop button", { hasText: /^Text$/ }).click(); await sleep(300);
    await page.keyboard.type("Prefill first, then decode."); await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("Cost: $O(n^2)$ per step");
    await f.locator(".pop button", { hasText: /^Add$/ }).click(); await sleep(900);
    const b = await waitJson((b) => b.sidenotes?.length === 1);
    check(b?.sidenotes?.length === 1 && /O\(n\^2\)/.test(b.sidenotes[0].md ?? b.sidenotes[0].text ?? ""), "旁注已存，含公式", b?.sidenotes);
    check(await st.locator(".mk").count() >= 1, "行旁出现旁注标记");
    await blank(f, page);
  });

  await step("r07-sticker", "工具栏 Sticker：贴一个到代码行、一个到画布", async () => {
    await focusCard(f, page, "LLMEngine.step"); await blank(f, page);
    await f.locator('.bbar button[aria-label="Sticker"]').click(); await sleep(400);
    await f.locator(".stkpick .scell").nth(1).click(); await sleep(200);
    await card(f, "LLMEngine.step").locator(".src .l").nth(4).click({ position: { x: 40, y: 6 } }); await sleep(400);
    await f.locator('.bbar button[aria-label="Sticker"]').click(); await sleep(400);
    await f.locator(".stkpick .scell").nth(0).click(); await sleep(200);
    const bb = await f.locator("#board").boundingBox();
    await f.locator("#board").click({ position: { x: bb.width - 80, y: 90 } }); await sleep(900);
    const k = (await waitJson((b) => b.stickers?.length >= 2))?.stickers ?? [];
    check(k.some((s) => s.at.kind === "line") && k.some((s) => s.at.kind === "canvas"), "贴纸贴在行上和画布上", k.map((s) => s.at.kind));
    await blank(f, page);
  });

  await step("r08-new-cards", "新建 Note、Text，粘贴 GitHub 链接和普通网址", async () => {
    const before = nCards(boardJson());
    await blank(f, page); await page.keyboard.press("Shift+!"); await sleep(800);
    const bb = await f.locator("#board").boundingBox();
    await page.mouse.move(bb.x + bb.width - 260, bb.y + bb.height - 220);
    await page.keyboard.press("n"); await sleep(500);
    await page.keyboard.type("**Takeaway**: schedule → run → postprocess"); await page.keyboard.press("Escape"); await sleep(600);
    await page.mouse.move(bb.x + bb.width - 260, bb.y + bb.height - 120);
    await page.keyboard.press("t"); await sleep(500);
    await page.keyboard.type("free text"); await page.keyboard.press("Escape"); await sleep(600);
    const paste = (t) => f.evaluate((t) => { const dt = new DataTransfer(); dt.setData("text/plain", t); window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); }, t);
    await paste("https://github.com/GeeeekExplorer/nano-vllm/blob/bb823b3/nanovllm/engine/scheduler.py#L24-L40"); await sleep(2500);
    await paste("https://arxiv.org/abs/2309.06180"); await sleep(2500);
    const b = await waitJson((b) => nCards(b) >= before + 4), kinds = (b?.cards ?? []).map((c) => c.kind);
    check(nCards(b) >= before + 4, "多了 4 张卡", { before, after: nCards(b), kinds });
    check(kinds.includes("web"), "普通网址成了 Web 卡", kinds);
    check((b?.cards ?? []).some((c) => c.kind === "code" && /github|gh/i.test(JSON.stringify(c.segments?.[0]?.src ?? c.source ?? c.gh ?? ""))), "GitHub 链接成了 GitHub Code 卡（需要能访问 GitHub API）", kinds);
    await blank(f, page);
    await page.keyboard.press("Shift+!"); await sleep(600);
  });

  await step("r09-menu-edges", "在白板四角和最底下的卡片上打开右键菜单", async () => {
    const bb = await f.locator("#board").boundingBox();
    const fits = () => f.evaluate(() => { const m = document.querySelector(".ctx"); if (!m) return null; const r = m.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
    for (const [x, y, n] of [[8, 8, "左上"], [bb.width - 8, 8, "右上"], [8, bb.height - 8, "左下"], [bb.width - 8, bb.height - 8, "右下"]]) {
      await f.locator("#board").click({ button: "right", position: { x, y } }); await sleep(350);
      const ok = await fits(); check(ok, `${n}角的菜单完整可见`);
      if (!ok) await page.screenshot({ path: `${OUT}/r09-debug-${n}.png`, clip: await (await f.frameElement()).boundingBox() });
      await page.keyboard.press("Escape"); await sleep(200);
    }
    // 最靠下的代码卡
    const heads = f.locator(".card.ccard .chead"); let low = null, ly = -1;
    for (let i = 0; i < await heads.count(); i++) { const b = await heads.nth(i).boundingBox(); if (b && b.y > ly && b.y < bb.height - 140) { ly = b.y; low = heads.nth(i); } }
    if (low) { await low.click({ button: "right", position: { x: 60, y: 8 }, force: true }); await sleep(400); check(await fits(), "最底下卡片的菜单完整可见"); }
  });

  await step("r10-version", "改源码一行 → 卡片显示本地改动 → 打开版本选择器", async () => {
    // 直接改工作区里的文件（和在编辑器里保存一样触发文件变更），白板一直留在视野里
    const fp = path.join(WS, "nanovllm/engine/scheduler.py");
    const lines = fs.readFileSync(fp, "utf8").split("\n"); lines[29] += "  # local edit"; fs.writeFileSync(fp, lines.join("\n"));
    let t = 0; for (; t < 40 && !(await f.locator(".rev.unc").count()); t++) await sleep(250);
    check(await f.locator(".rev.unc").count() >= 1, "在编辑器外改文件，卡片也显示 + uncommitted", { waitedMs: t * 250 });
    await focusCard(f, page, "Scheduler.schedule");
    await card(f, "Scheduler.schedule").locator(".rev").first().click({ force: true });
    for (let i = 0; i < 20 && !(await f.locator(".k-commits").count()); i++) await sleep(250);
    check(await f.locator(".k-commits").count() === 1, "版本选择器打开", await f.locator(".pop").count());
  });

  await step("r11a-zoom-min", "缩到最小，悬停不弹窗", async () => {
    await blank(f, page); await page.keyboard.press("Shift+!"); await sleep(500);
    for (let i = 0; i < 14; i++) { await page.keyboard.press("Control+-"); await sleep(120); }
    await sleep(600);
    const c = f.locator(".card .src .call").first();
    if (await c.count()) { await c.hover({ force: true }).catch(() => {}); await sleep(1500); }
    check(await f.locator(".pop.k-peek").count() === 0, "缩得很小时不弹定义预览");
  });
  await step("r11b-zoom-fit", "恢复到适合窗口", async () => { await page.mouse.move(5, 5); await page.keyboard.press("Shift+!"); await sleep(600); });
  await step("r11c-zoom-max", "放到最大", async () => {
    await focusCard(f, page, "LLMEngine.step");
    for (let i = 0; i < 12; i++) { await page.keyboard.press("Control+="); await sleep(120); }
    await sleep(1200);
  });

  await step("r12-undo-redo", "撤销到底、重做到底，结果和撤销前一致", async () => {
    await page.keyboard.press("Shift+!"); await sleep(500);
    await blank(f, page);
    if (process.env.DEBUG) console.log("  focus after blank", await f.evaluate(() => [document.hasFocus(), document.activeElement?.tagName]), await page.evaluate(() => [document.activeElement?.tagName, document.activeElement?.className?.slice?.(0, 60)]));
    const want = JSON.stringify(boardJson()?.cards?.map((c) => c.id).sort());
    await f.evaluate(() => { window.__zk = 0; window.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") window.__zk++; }, true); });
    for (let i = 0; i < 40; i++) { await page.keyboard.press("Control+z"); await sleep(80); }
    const zk = await f.evaluate(() => window.__zk);
    check(zk > 0, "Ctrl+Z 送到了白板", { keydowns: zk, focused: await f.evaluate(() => document.hasFocus()) });
    const mid = nCards(await waitJson((b) => nCards(b) <= 1, 6000));
    for (let i = 0; i < 40; i++) { await page.keyboard.press("Control+Shift+z"); await sleep(80); }
    await waitJson((b) => JSON.stringify(b.cards.map((c) => c.id).sort()) === want, 6000);
    const got = JSON.stringify(boardJson()?.cards?.map((c) => c.id).sort());
    check(mid < nCards(boardJson()), "撤销确实撤掉了卡片", { mid });
    check(got === want, "重做到底后卡片和撤销前一致", { want, got });
    await page.keyboard.press("Shift+!"); await sleep(600);
  });

  await step("r13-reopen", "关掉白板再打开，内容还在", async () => {
    const want = nCards(boardJson());
    await page.keyboard.press("Escape");
    await command(page, "View: Close All Editors"); await sleep(1500);
    await command(page, "CodeBoard: Open Board");
    f = await boardFrame(page); await sleep(2000);
    check(await f.locator(".card").count() === want, "重开后卡片数一致", { want, got: await f.locator(".card").count() });
  });

  // 每个主题各截一张同样内容的白板，给 T2 和材质参考稿并排对照（检查清单 S11）
  await step("r14-themes", "8 个主题各截一张", async () => {
    await blank(f, page); await page.keyboard.press("Shift+!"); await sleep(600);
    await page.keyboard.press("Control+,"); await sleep(800);
    const names = await f.locator(".st-sw").allTextContents();
    check(names.length >= 8, "设置页列出 8 个主题", names);
    for (let i = 0; i < names.length; i++) {
      await f.locator(".st-sw").nth(i).click(); await sleep(1200);
      await page.keyboard.press("Control+,"); await sleep(700);
      await shot(page, f, `r14-theme-${String(i + 1).padStart(2, "0")}-${names[i].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
      await page.keyboard.press("Control+,"); await sleep(700);
    }
    await f.locator(".st-sw").first().click(); await sleep(800);
    await page.keyboard.press("Control+,"); await sleep(600);
  });

  check(!errors.length, "没有 webview 报错", errors.slice(0, 3));
  fs.writeFileSync(`${OUT}/audit.json`, JSON.stringify(audits, null, 1));
  fs.writeFileSync(`${OUT}/steps.json`, JSON.stringify(steps, null, 1));
  console.log(failed ? `${failed} 项失败` : "全部通过");
  await browser.close().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

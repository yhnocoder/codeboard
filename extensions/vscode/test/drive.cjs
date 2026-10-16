// 驱动 VS Code 走一遍 v0.1 的主要流程，每一步检查结果并截图。
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
  throw new Error("找不到白板 webview");
}
async function command(page, text) {
  await page.keyboard.press("F1"); await sleep(500);
  await page.keyboard.type(text); await sleep(800);
  await page.keyboard.press("Enter"); await sleep(1200);
}
async function openFile(page, name, line) {
  // 刚启动时 Quick Open 的文件索引可能还没好，回车会落空：确认编辑器真的打开了这个文件，不行就重试
  for (let i = 0; i < 5; i++) {
    await command(page, "View: Focus First Editor Group"); // 代码在左边一栏，白板在右边（白板聚焦时 Ctrl+1 是 100% 缩放）
    await page.keyboard.press("Control+p"); await sleep(500);
    await page.keyboard.type(name); await sleep(900 + i * 1000); await page.keyboard.press("Enter"); await sleep(900);
    if (await page.locator(`.editor-group-container .tab.active[aria-label*="${name}"], .editor-group-container .tab.active:has-text("${name}")`).count()) break;
    await page.keyboard.press("Escape"); await sleep(1500);
  }
  if (line) { await page.keyboard.press("Control+g"); await sleep(300); await page.keyboard.type(String(line)); await page.keyboard.press("Enter"); await sleep(400); }
}
// 每次截图顺带跑通用界面断言（tools/review/audit.cjs），结果汇总到 audit.json；AUDIT_STRICT=1 时有问题算失败
const { audit } = require("../../../tools/review/audit.cjs");
const audits = [];
// 截图前等白板静止（动画放完、画布不再移动），并只截白板区域，避免 VS Code 状态栏等无关变化干扰截图比对
const settle = (fr) => fr.evaluate(async () => {
  const sig = () => { const w = document.querySelector(".world"); return (w ? getComputedStyle(w).transform : "") + "|" + [...document.querySelectorAll(".card")].map((c) => { const r = c.getBoundingClientRect(); return `${r.x|0},${r.y|0},${r.width|0},${r.height|0}`; }).join(";") + "|" + (document.querySelector("#board")?.innerHTML.length ?? 0); }; // 含 DOM 大小：语义高亮晚到也算没静止
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
  // 截图前统一"适合窗口"：卡片尺寸可能在之前的 fit 之后才量好，相机位置每次跑会差一点，统一后截图才可比
  // 有弹层或输入框时不按（会把 "!" 打进搜索框、或关掉要截的弹层）
  const busy = await fr.evaluate(() => !!document.querySelector(".palette, .pop, .ctx, .dialog") || /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "") || !!document.activeElement?.isContentEditable);
  // 点白板自己的 Fit to Window 按钮，不用快捷键：键盘焦点可能在代码编辑器里
  await settle(fr); if (!busy) { await fr.locator('button[aria-label="Fit to Window"]').first().click({ timeout: 3000 }).catch(() => {}); await settle(fr); }
  const box = await (await fr.frameElement()).boundingBox();
  await page.screenshot({ path: `${OUT}/${n}.png`, clip: box ?? undefined });
  const r = await audit(fr, n); audits.push(r);
  for (const i of r.issues) console.log(`  ⚠ ${n}: ${i.rule} — ${i.what}`);
  if (process.env.AUDIT_STRICT === "1") check(!r.issues.length, `${n} 通过界面断言`);
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

  // 1. 在函数里按 Alt+B：白板打开，函数成为第一张卡
  await openFile(page, "llm_engine.py", 51);
  await page.keyboard.press("Alt+b"); await sleep(2500);
  // 白板没开着时 Alt+B 只写盘并提示；打开白板看结果
  await command(page, "CodeBoard: Open Board");
  let f = await boardFrame(page); await sleep(1500);
  check(await card(f, "LLMEngine.step").count() === 1, "Alt+B 把 LLMEngine.step 放上白板");
  const nCalls = await f.locator(".card .src .call").count();
  check(nCalls >= 3, "卡片里的调用可以点", await f.locator(".card .src .call").allTextContents());
  check(await f.locator(".card .src .kw").count() > 3, "代码有语法高亮");
  await shot(page, "1-first-card");

  // 2. 点 schedule：展开 Scheduler.schedule，编号 1，连 Call link
  await card(f, "LLMEngine.step").locator(".src .call", { hasText: /^schedule$/ }).first().click(); await sleep(1800);
  check(await card(f, "Scheduler.schedule").count() === 1, "点 schedule 展开出 Scheduler.schedule");
  check((await card(f, "Scheduler.schedule").locator(".step").textContent().catch(() => "")) === "1", "子卡编号 1");
  check(await f.locator("path.edge").count() >= 1, "画出 Call link");
  // 3. 点 postprocess：编号 2
  await f.locator("#board").click({ position: { x: 30, y: 300 } }); await sleep(300);
  await card(f, "LLMEngine.step").locator(".src .call", { hasText: /^postprocess$/ }).first().click(); await sleep(1800);
  check(await card(f, "Scheduler.postprocess").count() === 1, "点 postprocess 展开");
  await f.locator("#board").click({ position: { x: 30, y: 300 } }); await sleep(300);
  await page.keyboard.press("Shift+!"); await sleep(900);
  await shot(page, "2-flow");

  // 4. 定义预览：悬停 can_allocate
  const sch = card(f, "Scheduler.schedule");
  await sch.locator(".src .call", { hasText: /^can_allocate$/ }).first().hover(); await sleep(2500);
  check(await f.locator(".pop.k-peek").count() === 1, "悬停名字弹出定义预览");
  await shot(page, "3-peek");
  await page.mouse.move(5, 500); await sleep(800);

  // 5. Sidenote：选两行，按 S，写一句
  await sch.locator(".no").nth(5).click(); await sch.locator(".no").nth(6).click({ modifiers: ["Shift"] });
  await page.keyboard.press("s"); await sleep(600);
  await f.locator(".pop button", { hasText: /^Text$/ }).click(); await sleep(200);
  await page.keyboard.type("Prefill admits seqs until the token budget runs out.");
  await f.locator(".pop button", { hasText: /^Add$/ }).click(); await sleep(800);
  check(await sch.locator(".mk").count() >= 1, "行旁出现 Sidenote 标记");
  await shot(page, "4-sidenote");

  // 6. ⌘K 搜索 allocate，↵ 放到白板
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k"); await sleep(600);
  await page.keyboard.type("BlockManager.allocate"); await sleep(1500);
  check(await f.locator(".palette .cand").count() > 0, "搜索有结果");
  await shot(page, "5-search");
  await page.keyboard.press("Enter"); await sleep(1800);
  check(await card(f, "BlockManager.allocate").count() === 1, "从搜索放上 BlockManager.allocate");

  // 7. Note
  await page.mouse.move(700, 700);
  await page.keyboard.press("Escape"); await sleep(200);
  await page.keyboard.press("n"); await sleep(500);
  await page.keyboard.type("**Takeaway**: schedule → run → postprocess"); await page.keyboard.press("Escape"); await sleep(600);
  check(await f.locator(".card.note").count() === 1, "新建 Note");
  await page.keyboard.press("Shift+!"); await sleep(900);
  await shot(page, "6-board");

  // 8. 自动保存
  await sleep(2000);
  const b = boardJson();
  check(b && b.version === 2 && b.cards.length >= 5 && b.links.length >= 2 && b.sidenotes.length === 1, "白板自动存盘（v2 格式）", b && { cards: b.cards.length, links: b.links.length, notes: b.sidenotes?.length });

  // 9. 在编辑器里改代码：卡片显示 + uncommitted（不保存到 git）
  await openFile(page, "scheduler.py", 30);
  await page.keyboard.press("End"); await page.keyboard.type("  # local edit"); await page.keyboard.press("Control+s"); await sleep(3500);
  check(await f.locator(".rev.unc").count() >= 1, "本地改动后卡片显示 + uncommitted");
  await shot(page, "7-uncommitted");

  check(!errors.length, "没有 webview 报错", errors.slice(0, 3));
  fs.writeFileSync(`${OUT}/audit.json`, JSON.stringify(audits, null, 1));
  console.log(failed ? `${failed} 项失败` : "全部通过");
  await browser.close().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

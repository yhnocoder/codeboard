// 驱动 VS Code 走一遍主要流程，每一步检查结果并截图。
const { chromium } = require("playwright-core");
const fs = require("fs");
const [OUT, WS] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "✓" : "✗"} ${what}`); if (!ok) failed++; };

async function boardFrame(page) {
  for (let i = 0; i < 80; i++) {
    for (const f of page.frames()) { try { if (await f.$(".canvas")) return f; } catch {} }
    await sleep(500);
  }
  throw new Error("找不到白板 webview");
}
async function command(page, text) {
  await page.keyboard.press("F1"); await sleep(500);
  await page.keyboard.type(text); await sleep(700);
  await page.keyboard.press("Enter"); await sleep(1000);
}
async function openFile(page, name, line) {
  await page.keyboard.press("Control+1"); await sleep(300); // 代码总在左边一栏打开，白板留在右边
  await page.keyboard.press("Control+p"); await sleep(500);
  await page.keyboard.type(name); await sleep(900); await page.keyboard.press("Enter"); await sleep(900);
  if (line) { await page.keyboard.press("Control+g"); await sleep(300); await page.keyboard.type(String(line)); await page.keyboard.press("Enter"); await sleep(400); }
}
const shot = (page, n) => page.screenshot({ path: `${OUT}/${n}.png` });
const card = (f, title) => f.locator(".code-card", { has: f.locator(".title", { hasText: title }) });
const activeTab = (page) => page.locator(".tab.active .label-name").first().textContent().catch(() => "");

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
  await sleep(4000);
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error" && /codeboard|board\.js/i.test(m.text())) errors.push(m.text()); });

  // 1. 在函数里按 Alt+B：白板自动打开，函数成为第一张卡片
  await openFile(page, "llm_engine.py", 51);
  await page.keyboard.press("Alt+b");
  let f = await boardFrame(page); await sleep(1500);
  check(await card(f, "LLMEngine.step").count() === 1, "Alt+B 把 LLMEngine.step 放上白板");
  check(await f.locator(".xref").count() > 3, "卡片里的调用可以点击（xref）");
  check(await f.locator(".code-line .src span[style*='--shiki']").count() > 10, "代码有语法高亮");
  await shot(page, "1-first-card");

  // 2. 点 schedule：展开 Scheduler.schedule，自动编号、连箭头
  await card(f, "LLMEngine.step").locator('.xref[data-call="schedule"]').first().click(); await sleep(1500);
  check(await card(f, "Scheduler.schedule").count() === 1, "点 schedule 展开出 Scheduler.schedule");
  // 3. 点 call("run")：按字符串分发也能找到 ModelRunner.run
  const fit = async () => { await f.locator(".zoom button[title^='显示全部']").click(); await sleep(700); };
  await fit();
  await card(f, "LLMEngine.step").locator('.xref[data-call="run"]').first().click(); await sleep(1500);
  check(await card(f, "ModelRunner.run").count() === 1, '点 call("run") 展开出 ModelRunner.run');
  await fit();
  await card(f, "LLMEngine.step").locator('.xref[data-call="postprocess"]').first().click(); await sleep(1500);
  check(await card(f, "Scheduler.postprocess").count() === 1, "点 postprocess 展开出 Scheduler.postprocess");
  const stepsTxt = await f.locator(".code-card .step").allTextContents();
  console.log("  编号：", stepsTxt.join(" "));
  check(["1", "1.1", "1.2", "1.3"].every((s) => stepsTxt.includes(s)), "按调用顺序编号 1 → 1.1 / 1.2 / 1.3");
  check(await f.locator(".edges .edge").count() === 3, "三条调用箭头");
  // 再点一次 schedule：不重复建卡，只补箭头（这里已经有箭头，卡片数不变）
  await fit();
  await card(f, "LLMEngine.step").locator('.xref[data-call="schedule"]').first().click(); await sleep(1200);
  check(await card(f, "Scheduler.schedule").count() === 1, "重复展开不会多出一张卡片");
  await f.locator(".zoom button[title^='显示全部']").click(); await sleep(800);
  await shot(page, "2-expanded");

  // 4. 点卡片里的代码行：编辑器跳到那一行
  await fit();
  await card(f, "Scheduler.schedule").locator(".code-line").nth(4).locator(".src").click({ position: { x: 4, y: 6 } }); await sleep(1500);
  const tab = await activeTab(page);
  const cursor = await page.locator(".statusbar-item[id*='selection'] , #status\\.editor\\.selection").first().textContent().catch(() => "");
  console.log("  当前文件：", tab, cursor);
  check(/scheduler/.test(tab || ""), "点代码行跳到 scheduler.py");
  check(/29/.test(cursor || ""), "光标在第 29 行");
  await shot(page, "3-jump");

  // 5. 点行号高亮
  f = await boardFrame(page);
  await f.locator(".zoom button[title^='显示全部']").click(); await sleep(700);
  await card(f, "Scheduler.schedule").locator(".code-line .ln").nth(4).click(); await sleep(400);
  check(await card(f, "Scheduler.schedule").locator(".code-line.hl").count() === 1, "点行号高亮这一行");

  // 6. 在 schedule 中间改一行并保存：卡片亮出「有新版本」，其他卡片不受影响
  await openFile(page, "scheduler.py", 28);
  await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await page.keyboard.type("# 改动：先看看 waiting 队列"); await page.keyboard.press("Control+s"); await sleep(1800);
  f = await boardFrame(page);
  check(await card(f, "Scheduler.schedule").locator(".rev.s-changed").count() === 1, "改了 schedule 后卡片提示有新版本");
  check(await card(f, "Scheduler.postprocess").locator(".rev.s-ok").count() === 1, "postprocess 只是下移了一行，静默跟上");
  await shot(page, "4-new-version");

  // 7. 看 diff，跟进
  await fit();
  await card(f, "Scheduler.schedule").locator(".rev").click(); await sleep(1200);
  check(await f.locator(".diff .dl.op-add").count() === 1, "diff 里有一行新增");
  await shot(page, "5-diff");
  await f.locator(".diff .primary").click(); await sleep(1200);
  check(await card(f, "Scheduler.schedule").locator(".rev.s-changed").count() === 0, "跟进后黄点消失");
  const hl = card(f, "Scheduler.schedule").locator(".code-line.hl");
  check(await hl.locator(".ln").textContent() === "30" && /# prefill/.test(await hl.textContent()), "高亮的「# prefill」跟着内容移到第 30 行");
  check(await card(f, "Scheduler.schedule").locator(".code-line", { hasText: "改动：先看看" }).count() === 1, "卡片内容更新成新代码");

  // 8. 便签、讲解模式
  await f.locator(".canvas").dblclick({ position: { x: 60, y: 120 } }); await sleep(400);
  await f.locator(".note-card textarea").fill("### 一次 step\n调度 → 跑模型 → 收尾"); await sleep(300);
  await f.locator(".canvas").click({ position: { x: 40, y: 400 } }); await sleep(300);
  await f.locator(".canvas").press("p"); await sleep(1200);
  check(await f.locator(".present-bar").count() === 1, "P 进入讲解模式");
  await shot(page, "6-present");
  await f.locator(".canvas").press("Escape"); await sleep(800);

  // 9. 保存与恢复：关掉白板再打开，内容还在；侧栏大纲
  await sleep(800);
  await command(page, "View: Close All Editors"); await sleep(600);
  await command(page, "CodeBoard: 打开白板");
  f = await boardFrame(page); await sleep(1500);
  check(await f.locator(".code-card").count() === 4 && await f.locator(".note-card").count() === 1, "关掉再打开，卡片和便签都在");
  await page.locator(".activitybar [aria-label*='CodeBoard']").first().click().catch(() => {}); await sleep(1200);
  const tree = await page.locator(".pane-body .monaco-list-row").allTextContents();
  console.log("  侧栏：", tree.join(" | "));
  check(tree.some((t) => t.includes("Scheduler.schedule")), "侧栏大纲列出卡片");
  await shot(page, "7-sidebar");

  // 10. 编辑器里的 CodeLens
  await openFile(page, "scheduler.py", 25); await sleep(1200);
  const lens = await page.locator(".contentWidgets .codelens-decoration, .codelens-decoration").allTextContents();
  check(lens.some((t) => t.includes("在白板上")), "编辑器里函数上方有「在白板上」");
  await shot(page, "8-codelens");

  check(errors.length === 0, `webview 没有报错${errors.length ? "：" + errors.join(" / ") : ""}`);
  console.log(failed ? `\n${failed} 项没通过` : "\n全部通过");
  await browser.close().catch(() => {});
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

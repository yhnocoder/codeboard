// Markdown: static rendering on Notes / Text / descriptions / sidenotes, the WYSIWYG editor (lazy chunk), slash menu,
// bubble toolbar, [[card refs]], raw mode, task toggle on static notes (npm run harness -- markdownRender markdownEdit … [--light])
import * as fs from "node:fs";
import * as path from "node:path";
import { shot, symCard, findSym, put, OUT, type Host } from "../harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, light } from "../fixtures";

const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
const close = (h: Host) => h.page.context().close();
const SHOTS = process.env.MD_SHOTS ?? path.join(OUT, "markdown");

export const RICH = [
  "## block_manager.allocate",
  "",
  "prefill 时 `Scheduler.schedule()` 先调 **block_manager** 分配 KV 页，见 [nano-vllm](https://github.com/GeeeekExplorer/nano-vllm)。",
  "",
  "- [ ] check `can_allocate(seq)`",
  "- [x] 按 hash 复用前缀块",
  "  - 命中就 `ref_count += 1`",
  "",
  "| 阶段 | 每步 token |",
  "| --- | --- |",
  "| prefill | 整个 prompt |",
  "| decode | 1 |",
  "",
  "```python",
  "def allocate(self, seq):",
  "    # 先找空闲块",
  "    block = self._allocate_block(self.free_block_ids[0])",
  "    return len(seq) * 2",
  "```",
  "",
  "cost $O(n^2)$, see [[Scheduler.schedule]] and the note[^1]",
  "",
  "$$",
  "\\sum_{i=1}^{n} x_i = \\frac{a}{b}",
  "$$",
  "",
  "<details>",
  "<summary>Why __init__ is slow</summary>",
  "",
  "because __init__ builds all Blocks",
  "",
  "</details>",
  "",
  "[^1]: the footnote",
].join("\n");

export function mdBoard(): { b: Board; note: NoteCard; text: NoteCard } {
  const b = emptyBoard("b1", "markdown");
  const sch = card("Scheduler.schedule");
  sch.desc = "Picks **prefill** first, then `decode`; see [[Notes on allocate]]";
  put(b, sch, 640, 60, 520);
  const note: NoteCard = { id: "n1", kind: "note", md: RICH, bg: true };
  put(b, note, 60, 60, 520);
  const text: NoteCard = { id: "t1", kind: "note", md: "# Reading notes\nTwo lines, old style\n- a list\n- with block_manager", size: "body" };
  put(b, text, 60, 900, 360);
  b.sidenotes.push({ id: "sn1", at: { card: sch.id }, kind: "text", md: "Sidenote with $x^2$ and **bold**" } as any);
  b.cam = { x: 0, y: 0, z: 0.8 };
  return { b, note, text };
}

async function saveShot(h: Host, name: string) {
  await shot(h, name);
  try { fs.mkdirSync(SHOTS, { recursive: true }); await h.page.screenshot({ path: `${SHOTS}/${name}.png` }); } catch { /* no project files here */ }
}

/** Static render: math, code colours, tasks, table, chips, footnote, details; links go to the host, chips jump to the card */
test("markdownRender", async () => {
  for (const theme of ["warm-ink", "ink-wash", "city"]) {
    const { b } = mdBoard();
    // 视野外很远的一张：先放纯文字，空闲时补渲染
    put(b, { id: "far", kind: "note", md: "far **away** $y^2$", bg: true } as NoteCard, 9000, 6000, 300);
    const h = await open({ board: b, light, w: 1400, h: 950, settings: { theme } as any });
    await h.page.waitForTimeout(500);
    const far = await h.page.evaluate(() => !!document.querySelector('.card[data-id="far"] .nbody strong') && !!document.querySelector('.card[data-id="far"] .katex'));
    check(`markdownRender-offview ${theme}`, far, { far });
    const r = await h.page.evaluate(() => {
      const n = document.querySelector('.card[data-id="n1"] .nbody')!;
      const cs = (e: Element | null) => (e ? getComputedStyle(e) : null);
      return {
        katex: n.querySelectorAll(".katex").length,
        hl: n.querySelectorAll("pre.md-code .kw").length,
        kwColor: cs(n.querySelector("pre.md-code .kw"))?.color, tasks: n.querySelectorAll("li[data-type=taskItem] input").length,
        table: n.querySelectorAll("table td").length, chips: n.querySelectorAll(".cref").length, chipMissing: n.querySelectorAll(".cref.missing").length,
        fn: n.querySelectorAll("sup.fnref").length, details: n.querySelectorAll("details summary").length,
        raw: /\*\*|block\\_/.test((n as HTMLElement).innerText), under: (n as HTMLElement).innerText.includes("__init__"),
        desc: document.querySelector(".cdesc strong")?.textContent, text2: document.querySelector('.card[data-id="t1"] .tx h1')?.textContent,
      };
    });
    const ok = r.katex >= 2 && r.hl >= 2 && r.tasks === 2 && r.table === 4 && r.chips === 1 && r.chipMissing === 0 && r.fn === 1 && r.details === 1 && !r.raw && r.under && r.desc === "prefill" && r.text2 === "Reading notes";
    await saveShot(h, `md-${theme}-${light ? "light" : "dark"}`);
    check(`markdownRender ${theme}`, ok, r);
    // 静态勾选框：改原文；点链接：交给宿主；点引用：选中那张卡
    await h.page.locator('.card[data-id="n1"] li[data-type=taskItem] input').first().click();
    await h.page.waitForTimeout(1300);
    const md = (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;
    await h.page.locator('.card[data-id="n1"] a.lnk').first().click();
    await h.page.waitForTimeout(150);
    const opened = h.sent.some((m) => m.type === "openLink");
    await h.page.locator('.card[data-id="n1"] .cref').first().click();
    await h.page.waitForTimeout(700);
    const selId = await h.page.locator(".card.sel").evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.id));
    check(`markdownRender-click ${theme}`, opened && selId.length === 1 && selId[0] !== "n1" && md.includes("- [x] check"), { opened, selId, task: md.split("\n")[4] });
    await close(h);
  }
});

/** WYSIWYG editing: lazy chunk loads, typing with input rules, / menu, [[ picker, bubble toolbar, raw mode, ⌘Z stays in the editor, Esc saves */
test("markdownEdit", async () => {
  const { b } = mdBoard();
  const h = await open({ board: b, light, w: 1400, h: 950 });
  const pg = h.page;
  const md = () => (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;
  const nCards = () => h.board().cards.length;
  await pg.locator('.card[data-id="n1"] .nbody').dblclick({ position: { x: 200, y: 40 } });
  await pg.waitForSelector('.card[data-id="n1"] .md-pm', { timeout: 5000 });
  const focus = await pg.evaluate(() => !!document.activeElement?.closest(".md-pm"));
  // 文末打字：**x** 自动变粗体，板子的快捷键不响应（t 不会新建 Text）
  await pg.keyboard.press("Enter");
  await pg.keyboard.type("Hello **world** and t");
  const tables0 = await pg.locator('.card[data-id="n1"] .md-pm table').count();
  const boldNow = await pg.locator('.card[data-id="n1"] .md-pm strong', { hasText: "world" }).count();
  const cards0 = nCards();
  // / 菜单：过滤后回车插入表格
  await pg.keyboard.press("Enter");
  await pg.keyboard.type("/tab");
  await pg.waitForTimeout(150);
  const slash = await pg.locator(".md-menu button").allTextContents();
  await saveShot(h, "md-edit-slash");
  await pg.keyboard.press("Enter");
  await pg.waitForTimeout(100);
  const table = await pg.locator('.card[data-id="n1"] .md-pm table').count();
  await pg.keyboard.type("cell");
  // 跳出表格：表格后面再来一段（光标在表格最后一格，↓ 出表格）
  for (let i = 0; i < 3; i++) await pg.keyboard.press("ArrowDown");
  // [[ 选卡
  await pg.keyboard.type(" see [[sched");
  await pg.waitForTimeout(150);
  const refItems = await pg.locator(".md-menu button .lb").allTextContents();
  await saveShot(h, "md-edit-ref");
  await pg.keyboard.press("Enter");
  const chip = await pg.locator('.card[data-id="n1"] .md-pm .cref').count();
  // 选中几个字：出工具条，点 I 变斜体
  await pg.keyboard.type("tail words");
  for (let i = 0; i < 5; i++) await pg.keyboard.press("Shift+ArrowLeft");
  await pg.waitForTimeout(650); // 选区停住 400ms 后才出工具条
  const bubble = await pg.locator(".md-bubble").count();
  await saveShot(h, "md-edit-bubble");
  await pg.locator('.md-bubble .tbtn[data-tip="Italic"]').click();
  const italic = await pg.locator('.card[data-id="n1"] .md-pm em', { hasText: "words" }).count();
  // ⌘Z：编辑器里的撤销（斜体没了），板子不撤销
  await pg.keyboard.press("ArrowRight");
  await pg.keyboard.press("ControlOrMeta+z");
  const italicAfterUndo = await pg.locator('.card[data-id="n1"] .md-pm em', { hasText: "words" }).count();
  const stillEditing = await pg.locator('.card[data-id="n1"] .md-pm').count();
  // ⌘/ 原文模式
  await pg.keyboard.press("Control+/");
  const rawVal = await pg.locator(".md-raw").inputValue().catch(() => "");
  await pg.keyboard.type("\nraw line");
  // 切回来时焦点要立刻（同一个按键里）回到编辑器：之前要等下一帧，CI 上紧接着的 Esc 落到了白板上，没保存也没退出
  await pg.keyboard.press("Control+/");
  const focusBack = await pg.evaluate(() => !!document.activeElement?.closest(".md-pm"));
  const backWys = await pg.locator('.card[data-id="n1"] .md-pm').isVisible();
  // Esc 保存退出
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(1500); // 自动保存约 1 秒后才发给宿主
  const after = md();
  const exited = await pg.locator(".md-pm").count();
  const r = { focus, boldNow, cards0, cardsNow: nCards(), slash: slash.slice(0, 3), table, refItems: refItems.slice(0, 3), chip, bubble, italic, italicAfterUndo, stillEditing,
    rawHas: rawVal.includes("[[Scheduler.schedule]]"), backWys, focusBack, exited,
    saved: { world: after.includes("Hello **world** and t"), table: /\| *cell *\|/.test(after), ref: after.includes("[[Scheduler.schedule]]"), raw: after.includes("raw line"), under: after.includes("block_manager") && !after.includes("block\\_") } };
  const ok = focus && boldNow === 1 && r.cardsNow === cards0 && slash[0]?.startsWith("Table") && table === tables0 + 1 && refItems[0] === "Scheduler.schedule" && chip === 2 && bubble === 1 && italic === 1 && italicAfterUndo === 0 && stillEditing === 1
    && r.rawHas && backWys && focusBack && exited === 0 && Object.values(r.saved).every(Boolean);
  await saveShot(h, "md-edit-saved");
  check("markdownEdit", ok, r);
  await close(h);
});

/** ==highlight==: typing ==hi== turns into a highlight, the toolbar's highlighter button and ⌘⇧H toggle it, it is saved as ==…==,
 *  and the static Note draws the same highlighter as the editor: one unbroken band over a phrase, its spaces and bold inside it */
test("markdownHighlight", async () => {
  const b = emptyBoard("b1", "highlight");
  put(b, { id: "n1", kind: "note", md: "Plain words in a note with **bold** inside", bg: true } as NoteCard, 60, 60, 460);
  b.cam = { x: 0, y: 0, z: 1.4 };
  const h = await open({ board: b, light, w: 1000, h: 640 });
  const pg = h.page;
  fs.mkdirSync(SHOTS, { recursive: true });
  const md = () => (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;
  const pm = '.card[data-id="n1"] .md-pm';
  const marks = () => pg.locator(`${pm} mark`).allTextContents();
  await pg.locator('.card[data-id="n1"] .nbody').dblclick({ position: { x: 300, y: 12 } });
  await pg.waitForSelector(pm, { timeout: 5000 });
  await pg.keyboard.press("ControlOrMeta+End");
  // 打字：==hi== 打完收尾的 = 就变高亮
  await pg.keyboard.type(" and ==hi=");
  const before = await marks();
  await pg.keyboard.type("=");
  const typed = await marks();
  // 选中一段字（DOM 选区，和拖选一样，可以跨过粗体）；工具条要等选区停下来才出
  const sel = async (phrase: string) => {
    await pg.evaluate(([root, w]) => {
      const walk = document.createTreeWalker(document.querySelector(root)!, NodeFilter.SHOW_TEXT), ns: Text[] = [];
      for (let n = walk.nextNode(); n; n = walk.nextNode()) ns.push(n as Text);
      const all = ns.map((n) => n.data).join(""), i = all.indexOf(w);
      if (i < 0) return;
      const at = (k: number): [Text, number] => { for (const n of ns) { if (k <= n.data.length) return [n, k]; k -= n.data.length; } return [ns[ns.length - 1], ns[ns.length - 1].data.length]; };
      const r = document.createRange(); r.setStart(...at(i)); r.setEnd(...at(i + w.length));
      getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
    }, [pm, phrase] as const);
  };
  /** 一段高亮的字在屏幕上是不是一整条底色：每一行上，<mark> 的框首尾相接盖满这段字，中间没有缝，也没有叠在一起（半透明叠两层会更深） */
  const band = (root: string, phrase: string) => pg.evaluate(([root, w]) => {
    const el = document.querySelector(root)!, walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), ns: Text[] = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) ns.push(n as Text);
    const all = ns.map((n) => n.data).join(""), i = all.indexOf(w);
    if (i < 0) return { found: false, gaps: [], overlaps: [] };
    const at = (k: number): [Text, number] => { for (const n of ns) { if (k <= n.data.length) return [n, k]; k -= n.data.length; } return [ns[ns.length - 1], ns[ns.length - 1].data.length]; };
    const r = document.createRange(); r.setStart(...at(i)); r.setEnd(...at(i + w.length));
    const span = r.getBoundingClientRect();
    const boxes = [...el.querySelectorAll("mark")].flatMap((m) => [...m.getClientRects()]).filter((b) => b.right > span.left && b.left < span.right && b.bottom > span.top && b.top < span.bottom).sort((a, b) => a.left - b.left);
    const gaps: number[] = [], overlaps: number[] = [];
    if (!boxes.length || boxes[0].left > span.left + 0.5 || boxes[boxes.length - 1].right < span.right - 0.5) gaps.push(-1);
    for (let k = 1; k < boxes.length; k++) { const d = boxes[k].left - boxes[k - 1].right; if (d > 0.5) gaps.push(+d.toFixed(1)); if (d < -0.5) overlaps.push(+d.toFixed(1)); }
    return { found: true, boxes: boxes.length, gaps, overlaps };
  }, [root, phrase] as const);
  const solid = (b: { found: boolean; gaps: number[]; overlaps: number[] }) => b.found && !b.gaps.length && !b.overlaps.length;
  await sel("Plain words");
  const btn = pg.locator('.md-bubble .tbtn[data-tip="Highlight"]');
  await btn.waitFor({ timeout: 2000 });
  await pg.waitForTimeout(300); // 淡入结束
  const bubble = pg.locator(".md-bubble");
  await bubble.screenshot({ path: path.join(SHOTS, "md-toolbar-1x.png") }).catch(() => {});
  // 放大看的工具条：设备像素比 3 下截一张（看线条落在像素上）
  const cdp = await pg.context().newCDPSession(pg);
  const vp = pg.viewportSize()!;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 3, mobile: false });
  await pg.waitForTimeout(300);
  await bubble.screenshot({ path: path.join(SHOTS, "md-toolbar-3x.png") }).catch(() => {});
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await pg.waitForTimeout(200);
  const icons = await pg.locator(".md-bubble .tbtn.md-ib svg.md-ico").count();
  const labels = await pg.locator(".md-bubble .tbtn.md-ib").evaluateAll((bs) => bs.map((b) => `${b.getAttribute("aria-label")}`));
  const onBefore = await btn.evaluate((b) => b.classList.contains("on"));
  await btn.click();
  await pg.waitForTimeout(150);
  const added = await marks();
  const onAfter = await btn.evaluate((b) => b.classList.contains("on") && b.getAttribute("aria-pressed") === "true");
  await saveShot(h, "md-highlight-toolbar-on");
  await btn.click();
  await pg.waitForTimeout(150);
  const removed = await marks();
  const onOff = await btn.evaluate((b) => b.classList.contains("on"));
  await btn.click();
  await pg.waitForTimeout(150);
  // ⌘⇧H：选中跨过粗体的一段按快捷键
  await sel("note with bold");
  await pg.waitForTimeout(100);
  await pg.keyboard.press("ControlOrMeta+Shift+h");
  await pg.waitForTimeout(150);
  const keyed = await marks();
  // 光标放进高亮里：两边的 == 记号显出来（和别的格式一样）
  await pg.evaluate((root) => { const ms = document.querySelectorAll(`${root} mark`); const t = ms[ms.length - 1].firstChild!; const r = document.createRange(); r.setStart(t, 1); r.collapse(true); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); }, pm);
  await pg.waitForTimeout(200);
  // 开头的记号在 .md-mka 上，收尾的在 .md-mkb 上
  const reveal = await pg.evaluate((root) => {
    const q = (c: string, k: "mka" | "mkb") => [...document.querySelectorAll(`${root} .${c}`)].map((e) => (e as HTMLElement).dataset[k]).join("");
    return `${q("md-mka", "mka")}|${q("md-mkb", "mkb")}`;
  }, pm);
  const look = (q: string) => pg.evaluate((q) => [...document.querySelectorAll(q)].map((e) => { const c = getComputedStyle(e); return `${c.backgroundColor} ${c.borderRadius} ${c.paddingLeft} ${c.color}`; }), q);
  const editLook = await look(`${pm} mark`);
  const editBand = { phrase: await band(pm, "Plain words"), bold: await band(pm, "note with bold") };
  await pg.locator('.card[data-id="n1"]').screenshot({ path: path.join(SHOTS, "md-highlight-edit-card.png") }).catch(() => {});
  await saveShot(h, "md-highlight-edit");
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(1500);
  const saved = md();
  const showLook = await look('.card[data-id="n1"] .nbody mark');
  const shown = await pg.locator('.card[data-id="n1"] .nbody mark').allTextContents();
  const showBand = { phrase: await band('.card[data-id="n1"] .nbody', "Plain words"), bold: await band('.card[data-id="n1"] .nbody', "note with bold") };
  await pg.locator('.card[data-id="n1"]').screenshot({ path: path.join(SHOTS, "md-highlight-display-card.png") }).catch(() => {});
  await saveShot(h, "md-highlight-display");
  const r = { before, typed, icons, labels, onBefore, added, onAfter, removed, onOff, keyed, reveal, editLook, showLook, shown, saved, editBand, showBand };
  check("markdownHighlight-typing", before.length === 0 && typed.join() === "hi", r);
  check("markdownHighlight-toolbar", icons === 7 && labels.some((l) => /^Highlight \((⌘⇧|Ctrl\+Shift\+)H\)$/.test(l)) && !onBefore && added.includes("Plain words") && onAfter && !removed.includes("Plain words") && !onOff, r);
  check("markdownHighlight-shortcut", keyed.includes("note with bold"), r);
  check("markdownHighlight-reveal", reveal.includes("==|=="), r);
  check("markdownHighlight-saved", saved === "==Plain words== in a ==note with **bold**== inside and ==hi==", r);
  check("markdownHighlight-display", shown.join() === "Plain words,note with bold,hi" && showLook.length === 3 && [...showLook, ...editLook].every((l) => l === editLook[0]) && !(editLook[0] ?? "").startsWith("rgba(0, 0, 0, 0)"), r);
  check("markdownHighlight-oneBand", [editBand.phrase, editBand.bold, showBand.phrase, showBand.bold].every(solid), r);
  await close(h);
});

/** The selection toolbar waits until the selection holds still: none while drag-selecting or extending with ⇧←, it shows ~400 ms
 *  after the mouse is let go / the last key, and it goes at once when the selection collapses */
test("markdownToolbarWaitsForStillSelection", async () => {
  const b = emptyBoard("b1", "settle");
  put(b, { id: "n1", kind: "note", md: "Select some of these words slowly with the mouse", bg: true } as NoteCard, 60, 60, 520);
  b.cam = { x: 0, y: 0, z: 1.4 };
  const h = await open({ board: b, light, w: 1000, h: 640 });
  const pg = h.page;
  const pm = '.card[data-id="n1"] .md-pm';
  const has = () => pg.evaluate(() => !!document.querySelector(".md-bubble"));
  await pg.locator('.card[data-id="n1"] .nbody').dblclick({ position: { x: 400, y: 12 } });
  await pg.waitForSelector(pm, { timeout: 5000 });
  await pg.keyboard.press("ControlOrMeta+End");
  await pg.waitForTimeout(200);
  // 字在屏幕上的位置：从 "some" 的开头拖到 "slowly" 的末尾
  const at = (w: string, end: boolean) => pg.evaluate(([root, w, end]) => {
    const t = document.querySelector(root)!.querySelector("p")!.firstChild!, i = t.textContent!.indexOf(w) + (end ? w.length : 0);
    const r = document.createRange(); r.setStart(t, i); r.collapse(true); const b = r.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 };
  }, [pm, w, end] as const);
  const a = await at("some", false), z = await at("slowly", true);
  await pg.mouse.move(a.x, a.y);
  await pg.mouse.down();
  const during: boolean[] = [];
  for (let k = 1; k <= 8; k++) { await pg.mouse.move(a.x + ((z.x - a.x) * k) / 8, a.y, { steps: 2 }); await pg.waitForTimeout(90); during.push(await has()); }
  await pg.waitForTimeout(600); // 按着鼠标停住：还是在选，不出
  const heldStill = await has();
  const dragged = await pg.evaluate(() => getSelection()!.toString());
  await pg.mouse.up();
  await pg.waitForTimeout(120);
  const rightAfterUp = await has();
  await pg.waitForTimeout(500);
  const afterPause = await has();
  const opacity = await pg.evaluate(() => getComputedStyle(document.querySelector(".md-bubble")!).opacity);
  // 收拢：立刻收起
  await pg.keyboard.press("End");
  await pg.waitForTimeout(40);
  const afterCollapse = await has();
  // 键盘扩选：⇧← 按着走的途中不出，停下 400ms 后出
  const keys: boolean[] = [];
  for (let k = 0; k < 6; k++) { await pg.keyboard.press("Shift+ArrowLeft"); await pg.waitForTimeout(120); keys.push(await has()); }
  await pg.waitForTimeout(500);
  const afterKeys = await has();
  const r = { during, heldStill, dragged, rightAfterUp, afterPause, opacity, afterCollapse, keys, afterKeys };
  check("markdownToolbarWaitsForStillSelection-drag", dragged.includes("some of these words") && during.every((x) => !x) && !heldStill && !rightAfterUp && afterPause && opacity === "1", r);
  check("markdownToolbarWaitsForStillSelection-collapse", !afterCollapse, r);
  check("markdownToolbarWaitsForStillSelection-keys", keys.every((x) => !x) && afterKeys, r);
  await close(h);
});

/** Formatting around an inline formula or emoji: the static Note draws the formula inside the bold / highlight, and an edit
 *  that only adds a word keeps the Markdown around it as it was */
test("markdownMarksAroundFormula", async () => {
  const b = emptyBoard("b1", "marks");
  const src = "**bold with $x^2$ inside** and ==marked :tada: emoji== and *a $y$* done";
  put(b, { id: "n1", kind: "note", md: src, bg: true } as NoteCard, 60, 60, 560);
  b.cam = { x: 0, y: 0, z: 1.4 };
  const h = await open({ board: b, light, w: 1000, h: 640 });
  const pg = h.page;
  fs.mkdirSync(SHOTS, { recursive: true });
  await pg.waitForTimeout(400);
  const body = '.card[data-id="n1"] .nbody';
  const r0 = await pg.evaluate((q) => ({
    boldMath: !!document.querySelector(`${q} strong .katex`), markEmoji: !!document.querySelector(`${q} mark .emoji, ${q} mark [data-type="emoji"]`) || [...document.querySelectorAll(`${q} mark`)].some((m) => m.textContent!.includes("🎉")),
    emMath: !!document.querySelector(`${q} em .katex`),
  }), body);
  await pg.locator('.card[data-id="n1"]').screenshot({ path: path.join(SHOTS, "md-marks-around-formula-display.png") }).catch(() => {});
  // 编辑：文末加一个词，保存下来的原文除了这个词不变
  await pg.locator(body).dblclick({ position: { x: 500, y: 12 } });
  await pg.waitForSelector('.card[data-id="n1"] .md-pm', { timeout: 5000 });
  const r1 = await pg.evaluate(() => ({ editBoldMath: !!document.querySelector('.card[data-id="n1"] .md-pm strong [data-type="inline-math"], .card[data-id="n1"] .md-pm strong .katex') }));
  await pg.keyboard.press("ControlOrMeta+End");
  await pg.keyboard.type(" end");
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(1500);
  const saved = (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;
  const r = { ...r0, ...r1, saved };
  check("markdownMarksAroundFormula", r0.boldMath && r0.markEmoji && r0.emMath && r1.editBoldMath && saved === `${src} end`, r);
  await close(h);
});

/** Copying part of a formatted span: text/plain is Markdown with the markers balanced around the selected part, text/html carries
 *  the format, and pasting it back into the Note keeps the format (saved as the same Markdown) */
test("copyPartialMarkBalanced", async () => {
  const b = emptyBoard("b1", "copy");
  const src = "==Plain words== **Bold words** *Ital words* ~~Gone words~~ `Code words` [Link words](https://e.com/p) ==aa $x$ bb== end";
  put(b, { id: "n1", kind: "note", md: src, bg: true } as NoteCard, 60, 60, 760);
  b.cam = { x: 0, y: 0, z: 1.2 };
  const h = await open({ board: b, light, w: 1100, h: 700 });
  const pg = h.page;
  const pm = '.card[data-id="n1"] .md-pm';
  await pg.locator('.card[data-id="n1"] .nbody').dblclick({ position: { x: 600, y: 12 } });
  await pg.waitForSelector(pm, { timeout: 5000 });
  await pg.evaluate(() => { const w = window as any; w.__clip = []; document.addEventListener("copy", (e) => w.__clip.push([e.clipboardData?.getData("text/plain"), e.clipboardData?.getData("text/html")])); });
  // 选中第一段里的一截字：公式算一个字（\u0000），选区的头尾落在公式外面的字上；再等编辑器自己的选区对上（ProseMirror 读 DOM 选区是异步的）
  const select = async (phrase: string) => {
    const want = await selectDom(phrase);
    if (!want) return false;
    await pg.waitForFunction(([root, [from, to]]) => {
      const s = (document.querySelector(root) as any)?.editor?.state.selection;
      return !!s && s.from === from && s.to === to;
    }, [pm, want] as const, { timeout: 5000 });
    return true;
  };
  const selectDom = (phrase: string) => pg.evaluate(([root, w]) => {
    const p = document.querySelector(root)!.querySelector("p")!, pts: [Node, number][] = [];
    let flat = "";
    const visit = (n: Node) => {
      if (n instanceof Element && n.matches('[data-type="inline-math"], .katex')) { pts.push([n.parentNode!, [...n.parentNode!.childNodes].indexOf(n as ChildNode)]); flat += "\u0000"; return; }
      if (n.nodeType === 3) { for (let i = 0; i < n.textContent!.length; i++) { pts.push([n, i]); flat += n.textContent![i]; } return; }
      n.childNodes.forEach(visit);
    };
    visit(p);
    const i = flat.indexOf(w);
    if (i < 0 || flat.indexOf(w, i + 1) >= 0) return null;
    const [en, eo] = pts[i + w.length - 1], r = document.createRange(), view = (document.querySelector(root) as any).editor.view;
    r.setStart(...pts[i]); r.setEnd(en, eo + 1);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
    return [view.posAtDOM(...pts[i]), view.posAtDOM(en, eo + 1)] as [number, number];
  }, [pm, phrase] as const);
  // [selected, text/plain, text/html carries it, the pasted paragraph: its one formatted element and the words in it]
  const cases: [string, string, RegExp, string][] = [
    ["ain wor", "==ain wor==", /<mark>ain wor<\/mark>/, "mark ain wor"], ["old wor", "**old wor**", /<strong>old wor<\/strong>/, "strong old wor"],
    ["tal wor", "*tal wor*", /<em>tal wor<\/em>/, "em tal wor"], ["one wor", "~~one wor~~", /<s>one wor<\/s>/, "s one wor"],
    ["ode wor", "`ode wor`", /<code>ode wor<\/code>/, "code ode wor"], ["ink wor", "[ink wor](https://e.com/p)", /<a [^>]*href="https:\/\/e\.com\/p"[^>]*>ink wor<\/a>/, "a ink wor https://e.com/p"],
    ["a \u0000 b", "==a $x$ b==", /<mark>a <span[^>]*data-type="inline-math"[\s\S]*<\/mark>/, "mark a $x$ b"],
  ];
  const out: { sel: string; selected: boolean; plain?: string; html: boolean; pasted?: string }[] = [];
  for (const [sel, plain, html, want] of cases) {
    const selected = await select(sel);
    await pg.keyboard.press("ControlOrMeta+c");
    const [p, hh] = await pg.evaluate(() => (window as any).__clip.pop() ?? []) as [string, string];
    // 粘回去：文末另起一段，把刚才剪贴板里的两份一起粘进来（和系统粘贴一样走编辑器的 paste）
    // 等光标真到了文末再回车，等粘进来的那段出现再读
    await pg.keyboard.press("ControlOrMeta+End");
    await pg.waitForFunction((root) => {
      const s = (document.querySelector(root) as any)?.editor?.state.selection;
      return !!s && s.empty && s.$from.parentOffset === s.$from.parent.content.size && s.$from.after(1) === s.$from.doc.content.size;
    }, pm, { timeout: 5000 });
    await pg.keyboard.press("Enter");
    const paras = out.length + 2;
    await pg.waitForFunction(([root, n]) => document.querySelector(root)!.querySelectorAll(":scope > p").length === n, [pm, paras] as const, { timeout: 5000 });
    await pg.evaluate(([root, p, hh]) => {
      const dt = new DataTransfer(); dt.setData("text/plain", p); dt.setData("text/html", hh);
      document.querySelector(root)!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, [pm, p, hh] as const);
    await pg.waitForFunction(([root, n]) => {
      const ps = document.querySelector(root)!.querySelectorAll(":scope > p");
      return ps.length === n && !!ps[n - 1].textContent;
    }, [pm, paras] as const, { timeout: 5000 }).catch(() => {});
    // 光标处的记号装饰不算：只看格式元素和里面的字（公式写成 $latex$）
    const pasted = await pg.evaluate((root) => {
      const ps = document.querySelector(root)!.querySelectorAll(":scope > p"), p = ps[ps.length - 1], el = p.firstElementChild;
      if (!el || p.childNodes.length !== 1) return p.innerHTML;
      let t = "";
      const visit = (n: Node) => { if (n instanceof Element && n.matches('[data-type="inline-math"]')) { t += `$${n.getAttribute("data-latex")}$`; return; } if (n.nodeType === 3) t += n.textContent; else n.childNodes.forEach(visit); };
      visit(el);
      return [el.tagName.toLowerCase(), t, el.getAttribute("href") ?? ""].join(" ").trim();
    }, pm);
    out.push({ sel: sel.replace("\u0000", "$x$"), selected, plain: p, html: html.test(hh ?? ""), pasted });
    check(`copyPartialMarkBalanced ${plain}`, selected && p === plain && html.test(hh ?? "") && pasted === want, out[out.length - 1]);
  }
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(1500);
  const saved = (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;
  check("copyPartialMarkBalanced-saved", saved === [src, ...cases.map((c) => c[1])].join("\n\n"), { saved, out });
  await close(h);
});

/** One editor is reused across Notes: each edit starts from that Note's text with its own undo history */
test("markdownEditorReuse", async () => {
  const { b } = mdBoard();
  const h = await open({ board: b, light, w: 1400, h: 950 });
  const pg = h.page;
  const mdOf = (id: string) => (h.board().cards.find((c) => c.id === id) as NoteCard).md;
  const pm = (id: string) => pg.locator(`.card[data-id="${id}"] .md-pm`);
  await pg.locator('.card[data-id="n1"] .nbody').dblclick({ position: { x: 200, y: 40 } });
  await pm("n1").waitFor({ timeout: 5000 });
  await pg.keyboard.press("Enter"); await pg.keyboard.type("first edit AAA");
  await pg.keyboard.press("Escape");
  // 编辑 n1 时镜头放大到字看得清（退出编辑不缩回去），t1 出了视野：先看全部再双击它
  await pg.keyboard.press("ControlOrMeta+0"); await pg.waitForTimeout(800);
  await pg.locator('.card[data-id="t1"] .tx').dblclick();
  await pm("t1").waitFor({ timeout: 5000 });
  const t1Text = await pm("t1").innerText();
  // 撤销不能撤回上一张 Note 的内容
  for (let i = 0; i < 3; i++) await pg.keyboard.press("ControlOrMeta+z");
  const afterUndo = await pm("t1").innerText();
  await pg.keyboard.press("Enter"); await pg.keyboard.type("second BBB");
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(1500);
  const n1 = mdOf("n1"), t1 = mdOf("t1");
  const r = { t1Fresh: t1Text.includes("Reading notes") && !t1Text.includes("AAA"), undoKept: afterUndo === t1Text, n1Saved: n1.includes("first edit AAA") && !n1.includes("BBB"),
    t1Saved: t1.includes("second BBB") && !t1.includes("AAA") && t1.startsWith("# Reading notes"), stale: await pg.locator(".md-pm").count() };
  check("markdownEditorReuse", r.t1Fresh && r.undoKept && r.n1Saved && r.t1Saved && r.stale === 0, r);
  await close(h);
});

/** Large board, pan and zoom straight into areas not rendered yet: a Note in view never shows its raw-text placeholder, every frame */
test("markdownLazyRender", async () => {
  const b = emptyBoard("b1", "lazy");
  const cols = 16;
  for (let i = 0; i < 320; i++) {
    const c: NoteCard = { id: `z${i}`, kind: "note", md: `## Note ${i}\n\nsome **bold** and $x_${i % 9}^2$ text\n\n- [ ] task ${i}\n- item\n\n\`\`\`python\ndef f${i}(x):\n    return x * ${i}\n\`\`\``, ...(i % 2 ? { bg: true } : {}) };
    put(b, c, (i % cols) * 460, Math.floor(i / cols) * 520, 400);
  }
  b.cam = { x: 40, y: 40, z: 1 };
  const h = await open({ board: b, light, w: 1400, h: 900 });
  const pg = h.page;
  // 每一帧都查：视野里有没有还没渲染的 Note（藏着的）、有没有露出来的原文（没藏的占位）
  await pg.evaluate(() => {
    const w = window as any;
    w.__lz = { frames: 0, hiddenInView: 0, rawShown: 0, pendSeen: 0, culled: 0, blankInView: 0, wait: {}, waits: [] };
    const tick = () => {
      w.__lz.frames++;
      for (const e of document.querySelectorAll<HTMLElement>(".card .md-pend")) {
        w.__lz.pendSeen++;
        const r = e.getBoundingClientRect();
        if (r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
          if (e.closest(".card.off")) w.__lz.culled++; // 卡片自己被 cull.ts 藏着（原来就有的行为），不算
          else if (getComputedStyle(e).visibility === "hidden") w.__lz.hiddenInView++; else w.__lz.rawShown++;
        }
      }
      // 卡片内容被 cull.ts 藏着（.off）：在屏幕里 = 空白卡（不许有）；在屏幕外半屏以内 = 等着显示，记它等了几帧
      const W = innerWidth, H = innerHeight;
      for (const c of document.querySelectorAll<HTMLElement>(".card")) {
        const r = c.getBoundingClientRect(), id = c.dataset.id!;
        const inView = r.bottom > 0 && r.top < H && r.right > 0 && r.left < W;
        const inRing = r.bottom > -H / 2 && r.top < H * 1.5 && r.right > -W / 2 && r.left < W * 1.5;
        if (c.classList.contains("off") && inView) w.__lz.blankInView++;
        if (c.classList.contains("off") && inRing) w.__lz.wait[id] = (w.__lz.wait[id] ?? 0) + 1;
        else if (w.__lz.wait[id]) { w.__lz.waits.push(w.__lz.wait[id]); delete w.__lz.wait[id]; }
      }
      if (w.__lz.on) requestAnimationFrame(tick);
    };
    w.__lz.on = true; requestAnimationFrame(tick);
  });
  await pg.mouse.move(700, 450);
  // 马上往远处平移（右下），再缩小、放大
  for (let i = 0; i < 40; i++) { await pg.mouse.wheel(60, 50); await pg.waitForTimeout(16); }
  await pg.keyboard.down("Control");
  for (let i = 0; i < 12; i++) { await pg.mouse.wheel(0, 40); await pg.waitForTimeout(16); }
  for (let i = 0; i < 12; i++) { await pg.mouse.wheel(0, -40); await pg.waitForTimeout(16); }
  await pg.keyboard.up("Control");
  for (let i = 0; i < 30; i++) { await pg.mouse.wheel(-40, 60); await pg.waitForTimeout(16); }
  await pg.waitForTimeout(1500);
  const r = await pg.evaluate(() => {
    const w = window as any; w.__lz.on = false;
    const ws = [...w.__lz.waits].sort((a: number, b: number) => a - b);
    const { wait: _w, waits: _ws, ...rest } = w.__lz;
    // 显示延迟：卡进到屏幕外半屏以内以后，过了几帧内容才显示
    return { ...rest, revealN: ws.length, revealP95: ws[Math.floor(ws.length * 0.95)] ?? 0, revealMax: ws[ws.length - 1] ?? 0,
      leftAfter: document.querySelectorAll(".md-pend").length, rendered: document.querySelectorAll(".card .nbody h2, .card .tx h2").length };
  });
  await saveShot(h, "md-lazy");
  // pendSeen > 0：确实有过排队的（不然这项没测到什么）；1.5 秒后全部渲染完
  check("markdownLazyRender", r.pendSeen > 0 && r.rawShown === 0 && r.hiddenInView === 0 && r.blankInView === 0 && r.leftAfter === 0 && r.rendered === 320, r);
  await close(h);
});

/** Paste: HTML becomes clean markdown, VS Code code keeps its indentation, markdown text is parsed */
test("markdownPaste", async () => {
  const { b } = mdBoard();
  const h = await open({ board: b, light, w: 1400, h: 950 });
  const pg = h.page;
  await pg.locator('.card[data-id="t1"] .tx').dblclick();
  await pg.waitForSelector('.card[data-id="t1"] .md-pm', { timeout: 5000 });
  const paste = (data: Record<string, string>) => pg.evaluate((d) => {
    const dt = new DataTransfer();
    for (const [k, v] of Object.entries(d)) dt.setData(k, v);
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);
  await pg.keyboard.press("Enter"); await pg.keyboard.press("Enter"); // 文末是列表：两下回车跳出列表
  await paste({ "text/html": '<h3 style="color:red">From web</h3><p>a <b>bold</b> <span style="font-size:20px">word</span> and <a href="https://x.y/a_b">link</a></p><ul><li>one</li><li>two</li></ul>', "text/plain": "From web" });
  await pg.keyboard.press("Enter"); await pg.keyboard.press("Enter");
  await paste({ "text/plain": "    def f(x):\n        return x * 2\n", "vscode-editor-data": JSON.stringify({ mode: "python" }) });
  await paste({ "text/plain": "seq_len", "vscode-editor-data": JSON.stringify({ mode: "python" }) });
  await pg.keyboard.press("Enter");
  await paste({ "text/plain": "- [ ] pasted task\n- [x] done **too**" });
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(1500);
  const md = (h.board().cards.find((c) => c.id === "t1") as NoteCard).md;
  const r = { html: /### From web\n\na \*\*bold\*\* word and \[link\]\(https:\/\/x\.y\/a_b\)\n\n- one\n- two/.test(md), noStyle: !/style=|<span/.test(md),
    code: md.includes("```python\ndef f(x):\n    return x * 2\n```"), inline: md.includes("`seq_len`"), tasks: md.includes("- [ ] pasted task\n- [x] done **too**") };
  check("markdownPaste", Object.values(r).every(Boolean), { ...r, md: md.slice(-260) });
  await close(h);
});

const DIAGRAMS: [string, string][] = [
  ["flowchart", "graph TD\n  A[Scheduler.schedule] --> B{waiting?}\n  B -- yes --> C[allocate blocks]\n  B -- no --> D[decode running]\n  C --> E[prefill batch]\n  D --> F[append slot]\n  E --> G[ModelRunner.run]\n  F --> G\n  subgraph KV[Block manager]\n    C\n    F\n  end"],
  ["sequence", "sequenceDiagram\n  participant E as LLMEngine\n  participant S as Scheduler\n  participant M as ModelRunner\n  loop until finished\n    E->>S: schedule()\n    S-->>E: seqs, is_prefill\n    E->>M: run(seqs)\n    M-->>E: token_ids\n  end\n  Note over E,M: one step"],
  ["class", "classDiagram\n  class Scheduler { +schedule() +postprocess() }\n  class BlockManager { +allocate() +can_append() }\n  class Sequence { +token_ids +block_table }\n  Scheduler --> BlockManager\n  Scheduler o-- Sequence"],
  ["state", "stateDiagram-v2\n  [*] --> WAITING\n  WAITING --> RUNNING: scheduled\n  RUNNING --> WAITING: preempted\n  RUNNING --> FINISHED: eos\n  FINISHED --> [*]"],
  ["pie", "pie title Time per step\n  \"prefill\" : 42\n  \"decode\" : 51\n  \"sampling\" : 7"],
  ["mindmap", "mindmap\n  root((nano-vllm))\n    engine\n      scheduler\n      block manager\n    layers\n      attention\n      linear"],
];
const LOOKS = ["warm-ink", "classic", "graphite", "soft-light", "drafting", "colorful", "newspaper", "poster", "ink-wash", "city"];

/** Mermaid blocks in Notes, per theme: every diagram renders at its own size (too wide → laid out top-down), light ↔ dark
 *  recolours the drawn SVG in place (no redraw),
 *  a theme with another font draws again. MMD_LOOKS=all (or a list) for every theme's screenshots */
test("mermaidThemes", async () => {
  const want = process.env.MMD_LOOKS;
  const looks = want === "all" ? LOOKS : want ? want.split(",") : ["warm-ink", "newspaper"];
  for (const theme of looks) {
    const b = emptyBoard("b1", "mermaid");
    DIAGRAMS.forEach(([k, src], i) => put(b, { id: `m${i}`, kind: "note", md: `**${k}**\n\n\`\`\`mermaid\n${src}\n\`\`\``, bg: true } as NoteCard, 40 + (i % 3) * 470, 40 + Math.floor(i / 3) * 880, 440));
    b.cam = { x: 0, y: 0, z: 0.72 };
    const h = await open({ board: b, light: true, w: 1400, h: 1260, settings: { theme } as any });
    const pg = h.page;
    await pg.waitForFunction((n) => document.querySelectorAll(".mmd.ok svg, .mmd-err").length >= n, DIAGRAMS.length, { timeout: 5000 }).catch(() => {});
    const look = () => pg.evaluate(() => {
      const svgs = [...document.querySelectorAll<SVGElement>(".mmd.ok svg")];
      const txt = svgs[0]?.querySelector("text");
      // 宽图改竖排，不缩小：排得进 Note 的图显示宽度 = SVG 自己的宽度（竖排了还是太宽的，比如宽的类图，才缩小）
      const z = 0.72, shrunk = svgs.filter((s) => +s.getAttribute("width")! <= s.parentElement!.clientWidth && s.getBoundingClientRect().width / (+s.getAttribute("width")! * z) < 0.97).length;
      const m = document.querySelector<SVGElement>('.card[data-id="m5"] .mmd svg'), mind = !!m && +m.getAttribute("width")! <= m.parentElement!.clientWidth; // mindmap 本来 600 多宽
      return { ok: svgs.length, shrunk, mind, err: [...document.querySelectorAll(".mmd-err")].map((e) => e.textContent), ink: getComputedStyle(document.documentElement).getPropertyValue("--ink").trim(), text: txt ? getComputedStyle(txt).fill : null };
    });
    const lt = await look();
    await saveShot(h, `mermaid-${theme}-light`);
    await pg.evaluate(() => { (window as any).__svg0 = document.querySelector(".mmd.ok svg"); document.body.className = "vscode-dark"; });
    await pg.waitForTimeout(300);
    const dk = await look();
    const same = await pg.evaluate(() => (window as any).__svg0 === document.querySelector(".mmd.ok svg"));
    await saveShot(h, `mermaid-${theme}-dark`);
    check(`mermaidThemes ${theme}`, lt.ok === DIAGRAMS.length && !lt.shrunk && lt.mind && !lt.err.length && dk.ok === DIAGRAMS.length && same && lt.text !== dk.text, { lt, dk, same });
    await close(h);
  }
  // 换到字体不一样的主题：图按新字体重画
  const b = emptyBoard("b1", "mermaid");
  put(b, { id: "m0", kind: "note", md: `\`\`\`mermaid\n${DIAGRAMS[0][1]}\n\`\`\``, bg: true } as NoteCard, 40, 40, 440);
  const h = await open({ board: b, light: true, w: 900, h: 700, settings: { theme: "warm-ink" } as any });
  const pg = h.page;
  await pg.waitForSelector(".mmd.ok svg", { timeout: 5000 });
  await pg.evaluate(() => { (window as any).__svg0 = document.querySelector(".mmd.ok svg"); const el = document.documentElement; el.classList.replace("look-warm-ink", "look-newspaper"); el.dataset.look = "newspaper"; });
  await pg.waitForTimeout(400);
  const r = await pg.evaluate(() => { const s = document.querySelector(".mmd.ok svg"); return { redrawn: !!s && s !== (window as any).__svg0, font: s ? getComputedStyle(s.querySelector("text")!).fontFamily.split(",")[0] : null }; });
  check("mermaidThemes font switch redraws", r.redrawn && /Old Standard/.test(r.font ?? ""), r);
  await close(h);
  // Note 变宽：放得下了，mindmap 换回横着排
  const b2 = emptyBoard("b1", "mermaid");
  put(b2, { id: "m0", kind: "note", md: `\`\`\`mermaid\n${DIAGRAMS[5][1]}\n\`\`\``, bg: true } as NoteCard, 40, 40, 300);
  const h2 = await open({ board: b2, light: true, w: 1100, h: 600 });
  await h2.page.waitForSelector(".mmd.ok svg", { timeout: 5000 });
  const size = () => h2.page.evaluate(() => { const s = document.querySelector(".mmd.ok svg")!; return [+s.getAttribute("width")!, +s.getAttribute("height")!]; });
  const narrow = await size();
  await h2.page.evaluate(() => { (document.querySelector('.card[data-id="m0"]') as HTMLElement).style.width = "800px"; });
  await h2.page.waitForTimeout(300);
  const wide = await size();
  check("mermaidThemes wider Note lays out left to right", narrow[1] > narrow[0] && wide[0] > wide[1], { narrow, wide });
  await close(h2);
});

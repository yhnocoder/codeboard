import * as fs from "node:fs";
import * as path from "node:path";
import { shot, symCard, findSym, put, OUT, REPO, type Host } from "../harness";
import type { Page } from "@playwright/test";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { TOOLBAR_SETTLE } from "@yhnocoder/markdown/ui";
import { test, open, check, light, until, idle, hold, frames, pmHasSelection, focusSettled } from "../fixtures";

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
  const note: NoteCard = { id: "n1", kind: "note", md: RICH, look: "note" };
  put(b, note, 60, 60, 520);
  const text: NoteCard = { id: "t1", kind: "note", md: "# Reading notes\nTwo lines, old style\n- a list\n- with block_manager", look: "text", size: "body" };
  put(b, text, 60, 900, 360);
  b.sidenotes.push({ id: "sn1", at: { card: sch.id }, kind: "text", md: "Sidenote with $x^2$ and **bold**" } as any);
  b.cam = { x: 0, y: 0, z: 0.8 };
  return { b, note, text };
}

async function saveShot(h: Host, name: string) {
  await shot(h, name);
  try { fs.mkdirSync(SHOTS, { recursive: true }); await h.page.screenshot({ path: `${SHOTS}/${name}.png` }); } catch { /* no project files here */ }
}

/** Static render: math, code colours, tasks, table, chips, footnote, details; links go to the host, chips jump to the card.
 *  The default theme here (a smoke scenario), the other two in markdownRenderThemes */
test("markdownRender", () => renderIn(["warm-ink"]));
test("markdownRenderThemes", () => renderIn(["ink-wash", "city"]));

async function renderIn(themes: string[]) {
  for (const theme of themes) {
    const { b } = mdBoard();
    // 视野外很远的一张：先放纯文字，空闲时补渲染
    put(b, { id: "far", kind: "note", md: "far **away** $y^2$", look: "note" } as NoteCard, 9000, 6000, 300);
    const h = await open({ board: b, light, w: 1400, h: 950, settings: { theme } as any });
    // the far Note renders when the board is idle (its plain text first)
    await until(h, "the far Note is rendered", () => h.page.evaluate(() => !!document.querySelector('.card[data-id="far"] .nbody strong') && !!document.querySelector('.card[data-id="far"] .katex')));
    await idle(h);
    const far = await h.page.evaluate(() => !!document.querySelector('.card[data-id="far"] .nbody strong') && !!document.querySelector('.card[data-id="far"] .katex'));
    check(`markdownRender-offview ${theme}`, far, { far });
    const r = await h.page.evaluate(() => {
      const n = document.querySelector('.card[data-id="n1"] .nbody')!;
      const cs = (e: Element | null) => (e ? getComputedStyle(e) : null);
      return {
        katex: n.querySelectorAll(".katex").length,
        hl: n.querySelectorAll("pre.md-code .kw").length,
        kwColor: cs(n.querySelector("pre.md-code .kw"))?.color, tasks: n.querySelectorAll("li[data-type=taskItem] input").length,
        table: n.querySelectorAll("table td").length, chips: n.querySelectorAll(".md-ref").length, chipMissing: n.querySelectorAll(".md-ref.missing").length,
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
    await until(h, "the ticked task is saved", () => (h.board().cards.find((c) => c.id === "n1") as NoteCard).md !== RICH);
    const md = (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;
    await h.page.locator('.card[data-id="n1"] a.lnk').first().click();
    await until(h, "the link goes to the host", () => h.sent.some((m) => m.type === "openLink"));
    const opened = h.sent.some((m) => m.type === "openLink");
    await h.page.locator('.card[data-id="n1"] .md-ref').first().click();
    await until(h, "the chip selects a card", () => h.page.locator(".card.sel").count());
    await idle(h);
    const selId = await h.page.locator(".card.sel").evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.id));
    check(`markdownRender-click ${theme}`, opened && selId.length === 1 && selId[0] !== "n1" && md.includes("- [x] check"), { opened, selId, task: md.split("\n")[4] });
    await close(h);
  }
}

/** @ lists Sections and other boards next to cards; a chip to a Section selects and frames it, one to another board opens that board */
test("noteRefSectionAndBoard", async () => {
  const { b } = mdBoard();
  b.sections.push({ id: "g1", title: "Prefill stage", x: 1300, y: 60, w: 400, h: 300 });
  const note: NoteCard = { id: "n2", kind: "note", md: "see [[Prefill stage]] and [[Kernels]]", look: "note" };
  put(b, note, 60, 700, 360);
  const h = await open({ board: b, light, w: 1400, h: 950 });
  await h.post({ type: "boards", boards: [{ id: "b1", name: "markdown", cards: b.cards.length }, { id: "bk", name: "Kernels", cards: 3 }] });
  await until(h, "both chips resolve", () => h.page.evaluate(() => document.querySelectorAll('.card[data-id="n2"] .md-ref:not(.missing)').length === 2));
  const pg = h.page;
  await pg.locator('.card[data-id="n2"] .md-ref', { hasText: "Kernels" }).click();
  await until(h, "the chip opens the other board", () => h.sent.some((m) => m.type === "openBoard" && m.id === "bk"));
  // @ 的列表：Section 和别的白板带着类型
  // 双击正文右边空白处（别点在引用上）
  const box = (await pg.locator('.card[data-id="n2"] .nbody').boundingBox())!;
  await pg.locator('.card[data-id="n2"] .nbody').dblclick({ position: { x: box.width - 8, y: box.height / 2 } });
  await pg.locator('.card[data-id="n2"] .md-pm').waitFor();
  await focusSettled(pg);
  await pg.evaluate(() => { const e = (document.querySelector('.card[data-id="n2"] .md-pm') as any).editor; e.commands.setTextSelection(e.state.doc.content.size - 1); });
  await pg.keyboard.type(" @");
  await pg.locator(".md-menu button").first().waitFor();
  const items = await pg.locator(".md-menu button").allTextContents();
  await saveShot(h, "md-at-ref");
  const ok = items.some((t) => t.includes("Prefill stage") && t.includes("section")) && items.some((t) => t.includes("Kernels") && t.includes("whiteboard")) && !items.some((t) => t.includes("markdown") && t.includes("whiteboard"));
  check("noteRefSectionAndBoard picker", ok, { items });
  // 最后点 Section 的引用（镜头会挪到 Section 那边）
  await pg.keyboard.press("Escape");
  await pg.keyboard.press("Escape");
  await pg.locator('.card[data-id="n2"] .nbody .md-ref', { hasText: "Prefill stage" }).click();
  await until(h, "the chip selects the Section", () => pg.locator('.sect.sel[data-sect="g1"]').count());
  await close(h);
});

/** [[ lists every other board's titled cards: each board's own row heads its group (3 cards, "+ N more" expands in place), a card from
 *  another board is stored as [[Board › Title]], its chip carries the board's name and opens that board; gone cards and boards look broken */
/** Long titles and Section paths in the [[ list: the title gets the width first, the path takes what is left; on the selected row whatever still doesn't fit slides into view */
test("noteRefLongTitleSlides", async () => {
  const b = emptyBoard("b1", "long refs");
  put(b, { id: "n", kind: "note", md: "see", look: "note" } as NoteCard, 60, 60, 420);
  b.cam = { x: 0, y: 0, z: 1 };
  const sec = "以 Vector Add 为例介绍 Grid、Block 与 Thread 的组织方式";
  const refs = [
    { id: "v0", t: "VECADD - CUDA - SKELETON", k: "code", s: sec },
    { id: "v1", t: "VECADD - CUDA - FULL KERNEL WITH BOUNDS CHECK AND HOST CODE FOR THE LAUNCH", k: "code", s: sec },
  ];
  const h = await open({ board: b, light, w: 1200, h: 800, settings: { theme: "warm-ink" } as any, on: (m, reply) => (m.type === "boardRefs" ? (void reply(m.req!, { boards: [{ id: "bg", name: "多维网格与数据", refs }], recent: [] }), true) : false) });
  const pg = h.page;
  await pg.locator('.card[data-id="n"] .nbody').dblclick();
  await pg.locator('.card[data-id="n"] .md-pm').waitFor();
  await focusSettled(pg);
  await pg.evaluate(() => { const e = (document.querySelector('.card[data-id="n"] .md-pm') as any).editor; e.commands.setTextSelection(e.state.doc.content.size - 1); });
  await pg.keyboard.type(" [[vecadd");
  await until(h, "both long cards are listed", async () => (await pg.locator(".md-menu button .lb").allTextContents()).filter((t) => t.startsWith("VECADD")).length === 2);
  const rows = () => pg.evaluate(() => [...document.querySelectorAll<HTMLElement>(".md-menu .md-list > button")].map((r) => {
    const lb = r.querySelector<HTMLElement>(".lb")!, bc = r.querySelector<HTMLElement>(".bc");
    return { t: lb.textContent!, sel: r.classList.contains("sel"), titleCut: lb.scrollWidth > lb.clientWidth, pathCut: !!bc && bc.scrollWidth > bc.clientWidth, slide: lb.classList.contains("slide") };
  }));
  const r0 = await rows(), short = r0.find((r) => r.t.endsWith("SKELETON"))!;
  check("noteRefLongTitleSlides title first", !short.titleCut && short.pathCut, r0);
  // 走到放不下的那行：标题滑到末尾时最后一个字露出来，别的行不滑
  for (let k = 0; k < 4 && !(await rows()).find((r) => r.sel)?.t.includes("LAUNCH"); k++) await pg.keyboard.press("ArrowDown");
  await until(h, "the long title slides", async () => (await rows()).some((r) => r.sel && r.t.includes("LAUNCH") && r.slide));
  const end = await pg.evaluate(() => {
    const lb = document.querySelector<HTMLElement>(".md-menu button.sel .lb")!, tx = lb.querySelector<HTMLElement>(".tx")!;
    const a = tx.getAnimations()[0];
    if (!a) return null;
    a.pause();
    a.currentTime = (a.effect!.getComputedTiming().delay ?? 0) + Number(a.effect!.getComputedTiming().duration) * 0.9;
    const l = lb.getBoundingClientRect(), t = tx.getBoundingClientRect();
    return { lbRight: Math.round(l.right), txRight: Math.round(t.right), slid: Math.round(l.left - t.left) };
  });
  await shot(h, "note-ref-long-title-slid", "now");
  const others = (await rows()).filter((r) => !r.sel && r.slide);
  check("noteRefLongTitleSlides the selected row slides to the end", !!end && Math.abs(end.txRight - end.lbRight) <= 1 && end.slid > 10 && !others.length, { end, others });
  await close(h);
});

test("noteRefOtherBoards", async () => {
  const { b } = mdBoard();
  const note: NoteCard = { id: "n2", kind: "note", md: "see [[Kernels › Flash attention]], [[Kernels › Old card]] and [[Scratch › Notes]]", look: "note" };
  put(b, note, 60, 700, 420);
  const titles = ["Flash attention", "Paged KV", "Softmax online", "Tiling basics", "Warp shuffle", "Bank conflicts", "Occupancy", "Roofline"];
  const kernels = { id: "bk", name: "Kernels", refs: titles.map((t, i) => ({ id: `k${i}`, t, k: i % 3 ? "note" : "code", s: i < 4 ? "Attention" : "Memory" })) };
  const pmpp = { id: "bp", name: "pmpp", refs: ["Ch.3 grids", "matrixMulKernel", "Image blur"].map((t, i) => ({ id: `p${i}`, t, k: "note" })) };
  const h = await open({ board: b, light, w: 1400, h: 950, on: (m, reply) => (m.type === "boardRefs" ? (void reply(m.req!, { boards: [kernels, pmpp], recent: [] }), true) : false) });
  const pg = h.page;
  const chip = (t: string) => pg.locator('.card[data-id="n2"] .nbody .md-ref', { hasText: t });
  // 静态 Note：认出别的白板上的卡（带白板名的小字）；卡不在了是划掉的灰色，白板没了是警告色
  await until(h, "the cross-board chip resolves", () => chip("Flash attention").evaluate((e) => !e.classList.contains("missing")));
  const chips = await pg.evaluate(() => [...document.querySelectorAll('.card[data-id="n2"] .nbody .md-ref')].map((e) => ({ cls: e.className, t: e.querySelector(".t")?.textContent, bd: e.querySelector(".bd")?.textContent })));
  check("noteRefOtherBoards chips", chips[0].bd === "Kernels" && chips[0].t === "Flash attention" && chips[1].cls.includes("missing") && chips[1].bd === "Kernels" && chips[2].cls.includes("gone") && !chips[2].cls.includes("missing"), { chips });
  await pg.locator('.card[data-id="n2"]').scrollIntoViewIfNeeded();
  await shot(h, "note-ref-other-boards-chip");
  await chip("Flash attention").click();
  await until(h, "the chip opens the other board at the card", () => h.sent.some((m) => m.type === "openBoard" && m.id === "bk" && m.card === "k0"));

  // [[ 的列表：这块白板，再是别的白板各一组
  const box = (await pg.locator('.card[data-id="n2"] .nbody').boundingBox())!;
  await pg.locator('.card[data-id="n2"] .nbody').dblclick({ position: { x: box.width - 8, y: box.height / 2 } });
  await pg.locator('.card[data-id="n2"] .md-pm').waitFor();
  await focusSettled(pg);
  await pg.evaluate(() => { const e = (document.querySelector('.card[data-id="n2"] .md-pm') as any).editor; e.commands.setTextSelection(e.state.doc.content.size - 1); });
  await pg.keyboard.type(" [[");
  await pg.locator(".md-menu button.brow").first().waitFor();
  const menu = await pg.evaluate(() => {
    const m = document.querySelector(".md-menu")!;
    const rows = [...m.querySelectorAll(".md-list > *")].map((e) => `${e.className}|${e.querySelector(".lb")?.textContent ?? e.textContent}|${e.querySelector(".bc")?.textContent ?? ""}|${e.querySelector("small")?.textContent ?? ""}`);
    return { rows, foot: m.querySelector(".md-foot")?.textContent };
  });
  const at = menu.rows.findIndex((r) => r.startsWith("brow") && r.includes("|Kernels|"));
  const group = menu.rows.slice(at, at + 5);
  const okMenu = menu.rows.some((r) => r.startsWith("md-gh cur|This board")) && at > 0 && group[0].endsWith("8 cards · whiteboard")
    && group.slice(1, 4).every((r) => r.startsWith("child|") && r.includes("|Attention|")) && group[4].startsWith("more|5 more in Kernels")
    && menu.rows.some((r) => r.startsWith("brow") && r.includes("|pmpp|")) && /^\d+ titled cards · 3 boards$/.test(menu.foot ?? "");
  check("noteRefOtherBoards picker", okMenu, menu);
  await pg.locator(".md-menu button.more").first().scrollIntoViewIfNeeded();
  await shot(h, "note-ref-other-boards-picker", "now");

  // ↓ 走下去：选中的那行下面总留着两行多（列表到底时除外）
  const gaps: { gap: number; row: number; end: boolean }[] = [];
  await pg.evaluate(() => { document.querySelector(".md-menu .md-list")!.scrollTop = 0; });
  for (let i = 0; i < 9; i++) {
    await pg.keyboard.press("ArrowDown");
    gaps.push(await pg.evaluate(() => {
      const l = document.querySelector(".md-menu .md-list") as HTMLElement, s = l.querySelector("button.sel") as HTMLElement;
      const a = l.getBoundingClientRect(), r = s.getBoundingClientRect();
      return { gap: a.bottom - r.bottom, row: r.height, end: l.scrollTop + l.clientHeight >= l.scrollHeight - 1 };
    }));
  }
  check("noteRefOtherBoards arrow margin", gaps.every((g) => g.end || g.gap >= g.row * 2), { gaps });

  // 鼠标点「+ 5 more」：列表不跳，点的地方换成展开出来的第一张
  const more = pg.locator(".md-menu button.more", { hasText: "more in Kernels" });
  await more.scrollIntoViewIfNeeded();
  const mb = (await more.boundingBox())!;
  const top0 = await pg.evaluate(() => document.querySelector(".md-menu .md-list")!.scrollTop);
  await pg.mouse.click(mb.x + 40, mb.y + mb.height / 2);
  await until(h, "the group expands", () => pg.locator(".md-menu button.child", { hasText: "Warp shuffle" }).count());
  const after = await pg.evaluate(([x, y]) => ({ under: document.elementFromPoint(x, y)?.closest("button")?.querySelector(".lb")?.textContent, top: document.querySelector(".md-menu .md-list")!.scrollTop,
    more: document.querySelectorAll(".md-menu button.more").length }), [mb.x + 40, mb.y + mb.height / 2]);
  check("noteRefOtherBoards more", after.under === "Tiling basics" && after.top === top0 && after.more === 0, { after, top0 });

  // 打字：别的白板上的对上的带着「白板 › Section」，选了写成 [[Kernels › Paged KV]]
  await pg.keyboard.type("paged");
  await pg.locator(".md-menu button", { hasText: "Paged KV" }).waitFor();
  const hitRow = await pg.locator(".md-menu button", { hasText: "Paged KV" }).first().evaluate((e) => e.querySelector(".bc")?.textContent);
  await pg.keyboard.press("Enter");
  const edChip = await pg.locator('.card[data-id="n2"] .md-pm .md-ref', { hasText: "Paged KV" }).evaluate((e) => e.querySelector(".bd")?.textContent);
  await pg.keyboard.press("Escape");
  await until(h, "the note is saved", () => (h.board().cards.find((c) => c.id === "n2") as NoteCard).md.includes("Paged KV"));
  const md = (h.board().cards.find((c) => c.id === "n2") as NoteCard).md;
  const picked = h.sent.some((m) => m.type === "refPicked" && m.b === "bk" && m.id === "k1");
  check("noteRefOtherBoards pick", hitRow === "Kernels › Attention" && edChip === "Kernels" && md.includes("[[Kernels › Paged KV]]") && picked, { hitRow, edChip, md, picked });
  await close(h);
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
  // 双击把光标放在双击处：先放到标题末尾（文末是脚注，里面放不了表格）
  await focusSettled(pg);
  await pg.evaluate(() => { const e = (document.querySelector('.card[data-id="n1"] .md-pm') as any).editor; e.commands.setTextSelection(e.state.doc.firstChild.nodeSize - 1); });
  // 段末打字：**x** 自动变粗体，板子的快捷键不响应（t 不会新建 Text）
  await pg.keyboard.press("Enter");
  await pg.keyboard.type("Hello **world** and t");
  const tables0 = await pg.locator('.card[data-id="n1"] .md-pm table').count();
  const boldNow = await pg.locator('.card[data-id="n1"] .md-pm strong', { hasText: "world" }).count();
  const cards0 = nCards();
  // / 菜单：过滤后回车插入表格
  await pg.keyboard.press("Enter");
  await pg.keyboard.type("/tab");
  await pg.locator(".md-menu button").first().waitFor();
  const slash = await pg.locator(".md-menu button").allTextContents();
  await saveShot(h, "md-edit-slash");
  await pg.keyboard.press("Enter");
  await until(h, "the menu inserts a table", async () => (await pg.locator('.card[data-id="n1"] .md-pm table').count()) !== tables0);
  const table = await pg.locator('.card[data-id="n1"] .md-pm table').count();
  await pg.keyboard.type("cell");
  // 跳出表格：表格后面再来一段（光标在表格最后一格，↓ 出表格）
  for (let i = 0; i < 3; i++) await pg.keyboard.press("ArrowDown");
  // [[ 选卡
  await pg.keyboard.type(" see [[sched");
  await pg.locator(".md-menu button .lb").first().waitFor();
  await idle(h); // the picker's items come from the host's search
  const refItems = await pg.locator(".md-menu button .lb").allTextContents();
  await saveShot(h, "md-edit-ref");
  await pg.keyboard.press("Enter");
  const chip = await pg.locator('.card[data-id="n1"] .md-pm .md-ref').count();
  // 选中几个字：出工具条，点 I 变斜体
  await pg.keyboard.type("tail words");
  for (let i = 0; i < 5; i++) await pg.keyboard.press("Shift+ArrowLeft");
  await pg.locator(".md-bubble").waitFor(); // 选区停住 400ms 后才出工具条
  const bubble = await pg.locator(".md-bubble").count();
  await saveShot(h, "md-edit-bubble");
  await pg.locator('.md-bubble .tbtn[data-tip="Italic"]').click();
  const italic = await pg.locator('.card[data-id="n1"] .md-pm em', { hasText: "words" }).count();
  // ⌘Z：编辑器里的撤销（斜体没了），板子不撤销
  await pg.keyboard.press("ArrowRight");
  await pg.keyboard.press("ControlOrMeta+z");
  const italicAfterUndo = await pg.locator('.card[data-id="n1"] .md-pm em', { hasText: "words" }).count();
  const stillEditing = await pg.locator('.card[data-id="n1"] .md-pm').count();
  // ⌘/ 原文模式（整篇 Markdown 在 CodeMirror 里）
  await pg.keyboard.press("Control+/");
  await pg.locator('.card[data-id="n1"] .md-srcmode .cm-content').waitFor({ timeout: 5000 });
  const rawVal = await pg.evaluate(() => [...document.querySelectorAll('.card[data-id="n1"] .md-srcmode .cm-line')].map((l) => l.textContent).join("\n"));
  await pg.keyboard.type("\nraw line");
  // 切回来时焦点要立刻（同一个按键里）回到编辑器，不然紧接着的 Esc 会落到白板上
  await pg.keyboard.press("Control+/");
  const focusBack = await pg.evaluate(() => !!document.activeElement?.closest(".md-pm"));
  const backWys = await pg.locator('.card[data-id="n1"] .md-pm').isVisible();
  // Esc 保存退出
  await pg.keyboard.press("Escape");
  await until(h, "Esc saves the Note", () => md() !== RICH);
  await idle(h);
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
  put(b, { id: "n1", kind: "note", md: "Plain words in a note with **bold** inside", look: "note" } as NoteCard, 60, 60, 460);
  b.cam = { x: 0, y: 0, z: 1.4 };
  const h = await open({ board: b, light, w: 1000, h: 640 });
  const pg = h.page;
  fs.mkdirSync(SHOTS, { recursive: true });
  const md = () => (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;
  const pm = '.card[data-id="n1"] .md-pm';
  const marks = () => pg.locator(`${pm} mark`).allTextContents();
  await pg.locator('.card[data-id="n1"] .nbody').dblclick({ position: { x: 300, y: 12 } });
  await pg.waitForSelector(pm, { timeout: 5000 });
  // ProseMirror's focus timers put the double-click's caret back over a key pressed within them
  await pg.locator(`${pm}:focus`).waitFor();
  await focusSettled(pg);
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
      // hidden source (the markers away from the caret) is not on screen
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (!n.parentElement?.closest(".md-hide")) ns.push(n as Text);
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
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (!n.parentElement?.closest(".md-hide")) ns.push(n as Text);
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
  await idle(h); // 淡入结束
  const bubble = pg.locator(".md-bubble");
  await bubble.screenshot({ path: path.join(SHOTS, "md-toolbar-1x.png") }).catch(() => {});
  // 放大看的工具条：设备像素比 3 下截一张（看线条落在像素上）
  const cdp = await pg.context().newCDPSession(pg);
  const vp = pg.viewportSize()!;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: vp.width, height: vp.height, deviceScaleFactor: 3, mobile: false });
  await idle(h);
  await bubble.screenshot({ path: path.join(SHOTS, "md-toolbar-3x.png") }).catch(() => {});
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await idle(h);
  const icons = await pg.locator(".md-bubble .tbtn.md-ib svg.md-ico").count();
  const labels = await pg.locator(".md-bubble .tbtn.md-ib").evaluateAll((bs) => bs.map((b) => `${b.getAttribute("aria-label")}`));
  const onBefore = await btn.evaluate((b) => b.classList.contains("on"));
  /** the highlights in the editor changed from `was` */
  const marksChange = (what: string, was: string[]) => until(h, what, async () => JSON.stringify(await marks()) !== JSON.stringify(was));
  let was = await marks();
  await btn.click();
  await marksChange("the toolbar button highlights the selection", was);
  const added = await marks();
  const onAfter = await btn.evaluate((b) => b.classList.contains("on") && b.getAttribute("aria-pressed") === "true");
  await saveShot(h, "md-highlight-toolbar-on");
  await btn.click();
  await marksChange("the toolbar button takes the highlight off", added);
  const removed = await marks();
  const onOff = await btn.evaluate((b) => b.classList.contains("on"));
  await btn.click();
  await marksChange("the toolbar button highlights it again", removed);
  // ⌘⇧H：选中跨过粗体的一段按快捷键
  await sel("note with bold");
  await pmHasSelection(pg);
  was = await marks();
  await pg.keyboard.press("ControlOrMeta+Shift+h");
  await marksChange("⌘⇧H highlights the selection", was);
  const keyed = await marks();
  // 光标放进高亮里：两边的 == 记号显出来（和别的格式一样）
  await pg.evaluate((root) => { const ms = document.querySelectorAll(`${root} mark`); const t = ms[ms.length - 1].firstChild!; const r = document.createRange(); r.setStart(t, 1); r.collapse(true); getSelection()!.removeAllRanges(); getSelection()!.addRange(r); }, pm);
  await pmHasSelection(pg);
  await idle(h); // the markers around the caret show
  // the markers are the source's own characters, shown (not .md-hide) only around the caret
  const reveal = await pg.evaluate((root) => [...document.querySelectorAll(`${root} .md-mk:not(.md-hide)`)].map((e) => e.textContent).join("|"), pm);
  // the highlight's own look: a marker shown inside it (the caret is next to **) is drawn muted, as every marker is
  const look = (q: string) => pg.evaluate((q) => [...document.querySelectorAll(q)].filter((e) => !e.closest(".md-mk")).map((e) => { const c = getComputedStyle(e); return `${c.backgroundImage} ${c.borderRadius} ${c.paddingLeft} ${c.color}`; }), q);
  const editLook = await look(`${pm} mark`);
  const editBand = { phrase: await band(pm, "Plain words"), bold: await band(pm, "note with bold") };
  await pg.locator('.card[data-id="n1"]').screenshot({ path: path.join(SHOTS, "md-highlight-edit-card.png") }).catch(() => {});
  await saveShot(h, "md-highlight-edit");
  await pg.keyboard.press("Escape");
  await until(h, "Esc saves the Note", () => md() !== "Plain words in a note with **bold** inside");
  await idle(h);
  const saved = md();
  const showLook = await look('.card[data-id="n1"] .nbody mark');
  const shown = await pg.locator('.card[data-id="n1"] .nbody mark').allTextContents();
  const showBand = { phrase: await band('.card[data-id="n1"] .nbody', "Plain words"), bold: await band('.card[data-id="n1"] .nbody', "note with bold") };
  await pg.locator('.card[data-id="n1"]').screenshot({ path: path.join(SHOTS, "md-highlight-display-card.png") }).catch(() => {});
  await saveShot(h, "md-highlight-display");
  const r = { before, typed, icons, labels, onBefore, added, onAfter, removed, onOff, keyed, reveal, editLook, showLook, shown, saved, editBand, showBand };
  check("markdownHighlight-typing", before.length === 0 && typed.join() === "hi", r);
  check("markdownHighlight-toolbar", icons === 8 && labels.some((l) => /^Highlight \((⌘⇧|Ctrl\+Shift\+)H\)$/.test(l)) && !onBefore && added.includes("Plain words") && onAfter && !removed.includes("Plain words") && !onOff, r);
  // the caret ends next to the bold, so its ** show inside the highlight
  check("markdownHighlight-shortcut", keyed.join("").includes("note with **bold**") && saved.includes("==note with **bold**=="), r);
  check("markdownHighlight-reveal", reveal.includes("==|=="), r);
  check("markdownHighlight-saved", saved === "==Plain words== in a ==note with **bold**== inside and ==hi==", r);
  check("markdownHighlight-display", shown.join() === "Plain words,note with bold,hi" && showLook.length === 3 && [...showLook, ...editLook].every((l) => l === editLook[0]) && (editLook[0] ?? "").startsWith("linear-gradient("), r);
  check("markdownHighlight-oneBand", [editBand.phrase, editBand.bold, showBand.phrase, showBand.bold].every(solid), r);
  await close(h);
});

/** ==highlight== is a flat marker band under the lower part of the text: no rounded corners or padding,
 *  the upper part of the line stays the card's background, the band runs unbroken under spaces and CJK, and the editor and the static
 *  Note draw it in exactly the same place (no layout shift on entering or leaving edit). Checked in Warm Ink light and dark */
test("markdownHighlightBand", async () => {
  const res: Record<string, unknown> = {};
  const ok: Record<string, boolean> = {};
  for (const lightPass of [true, false]) {
    const b = emptyBoard("b1", "highlight band");
    put(b, { id: "n1", kind: "note", md: "Before ==marker band over words and 中文的某个中间量== end", look: "note" } as NoteCard, 60, 60, 640);
    b.cam = { x: 0, y: 0, z: 1.4 };
    const h = await open({ board: b, light: lightPass, w: 1100, h: 400, settings: { theme: "warm-ink" } as never });
    const pg = h.page;
    const card = '.card[data-id="n1"]';
    /** Where the band is drawn, relative to the card: the mark's boxes, a word inside it, and its computed style */
    const geom = (root: string) => pg.evaluate(([card, root]) => {
      const c = document.querySelector(card)!.getBoundingClientRect(), m = document.querySelector(`${root} mark`) as HTMLElement;
      const rel = (r: DOMRect) => [r.left - c.left, r.top - c.top, r.width, r.height].map((v) => +v.toFixed(2));
      const t = [...m.childNodes].find((n) => n.nodeType === 3) as Text, i = t.data.indexOf("band");
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 4);
      const s = getComputedStyle(m);
      return { boxes: [...m.getClientRects()].map(rel), word: rel(r.getBoundingClientRect()), style: `${s.borderRadius} ${s.paddingLeft} ${s.paddingRight} ${s.marginLeft}` };
    }, [card, root] as const);
    /** Pixels of the mark's line: is the space between "marker" and "band" background on top and band below, is the band's
     *  bottom row unbroken from the mark's first to last pixel. The reference background is the space right after the mark */
    const pixels = async (root: string) => {
      const g = await pg.evaluate((root) => {
        const m = document.querySelector(`${root} mark`) as HTMLElement, box = m.getBoundingClientRect();
        const t = [...m.childNodes].find((n) => n.nodeType === 3) as Text, i = t.data.indexOf(" band");
        const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1);
        const sp = r.getBoundingClientRect();
        // the text after the mark (in the editor, past the hidden closing == of the source)
        let next = m.nextSibling;
        while (next && next.nodeType === 1 && (next as Element).classList.contains("md-hide")) next = next.nextSibling;
        const after = (next?.nodeType === 3 ? next : next?.firstChild) as Text, r2 = document.createRange(); r2.setStart(after, 0); r2.setEnd(after, 1);
        const sp2 = r2.getBoundingClientRect();
        return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, space: (sp.left + sp.right) / 2, after: (sp2.left + sp2.right) / 2 };
      }, root);
      const clip = { x: Math.floor(g.left) - 2, y: Math.floor(g.top), width: Math.ceil(g.after - g.left) + 6, height: Math.floor(g.bottom - g.top) };
      const png = await pg.screenshot({ clip });
      const px = await pg.evaluate(async (b64) => {
        const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
        const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
        const x = cv.getContext("2d")!; x.drawImage(img, 0, 0);
        return { w: img.width, h: img.height, d: [...x.getImageData(0, 0, img.width, img.height).data] };
      }, png.toString("base64"));
      const at = (x: number, y: number) => { const k = (Math.round(y) * px.w + Math.round(x)) * 4; return [px.d[k], px.d[k + 1], px.d[k + 2]]; };
      const diff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
      const bg = at(g.after - clip.x, px.h / 2);
      const sx = g.space - clip.x;
      const rows = [...Array(px.h).keys()];
      const top = rows.filter((y) => y < px.h * 0.3).map((y) => diff(at(sx, y), bg));
      const low = rows.filter((y) => y >= px.h * 0.7).map((y) => diff(at(sx, y), bg));
      const band = at(sx, px.h - 2);
      const bottom = [...Array(Math.floor(g.right - g.left) - 2).keys()].map((x) => diff(at(x + 1 + g.left - clip.x, px.h - 2), bg));
      return { bg, band, topMax: Math.max(...top), lowMin: Math.min(...low), bottomGaps: bottom.filter((d) => d < 4).length, bottomN: bottom.length };
    };
    const look = (p: Awaited<ReturnType<typeof pixels>>) => p.topMax <= 3 && p.lowMin >= 6 && p.bottomGaps === 0 && p.band[0] > p.band[2];
    await idle(h);
    const shown = { geom: await geom(`${card} .nbody`), px: await pixels(`${card} .nbody`) };
    const tag = lightPass ? "light" : "dark";
    fs.mkdirSync(SHOTS, { recursive: true });
    await pg.locator(card).screenshot({ path: path.join(SHOTS, `md-highlight-band-${tag}-display.png`) }).catch(() => {});
    // 进编辑：光标放在高亮后面（不在高亮里，不显出 == 记号）
    await pg.locator(`${card} .nbody`).dblclick({ position: { x: 20, y: 10 } });
    const pm = `${card} .md-pm`;
    await pg.waitForSelector(pm, { timeout: 5000 });
    await focusSettled(pg);
    await pg.keyboard.press("ControlOrMeta+End");
    await pmHasSelection(pg); await idle(h);
    const edit = { geom: await geom(pm), px: await pixels(pm) };
    await pg.locator(card).screenshot({ path: path.join(SHOTS, `md-highlight-band-${tag}-edit.png`) }).catch(() => {});
    const same = (a: number[][], b: number[][]) => a.length === b.length && a.every((r, i) => r.every((v, j) => Math.abs(v - b[i][j]) <= 0.5));
    res[tag] = { shown, edit };
    ok[`${tag}-flat`] = [shown.geom.style, edit.geom.style].every((s) => s === "0px 0px 0px 0px");
    ok[`${tag}-band`] = look(shown.px) && look(edit.px);
    ok[`${tag}-sameGeometry`] = same(shown.geom.boxes, edit.geom.boxes) && same([shown.geom.word], [edit.geom.word]);
    await close(h);
  }
  check("markdownHighlightBand-flat", ok["light-flat"] && ok["dark-flat"], res);
  check("markdownHighlightBand-lowerBand", ok["light-band"] && ok["dark-band"], res);
  check("markdownHighlightBand-sameInEditAndDisplay", ok["light-sameGeometry"] && ok["dark-sameGeometry"], res);
});

/** The selection toolbar waits until the selection holds still: none while drag-selecting or extending with ⇧←, it shows ~400 ms
 *  after the mouse is let go / the last key, and it goes at once when the selection collapses */
test("markdownToolbarWaitsForStillSelection", async () => {
  const b = emptyBoard("b1", "settle");
  put(b, { id: "n1", kind: "note", md: "Select some of these words slowly with the mouse", look: "note" } as NoteCard, 60, 60, 520);
  b.cam = { x: 0, y: 0, z: 1.4 };
  const h = await open({ board: b, light, w: 1000, h: 640 });
  const pg = h.page;
  const pm = '.card[data-id="n1"] .md-pm';
  const has = () => pg.evaluate(() => !!document.querySelector(".md-bubble"));
  await pg.locator('.card[data-id="n1"] .nbody').dblclick({ position: { x: 400, y: 12 } });
  await pg.waitForSelector(pm, { timeout: 5000 });
  await pg.keyboard.press("ControlOrMeta+End");
  await pmHasSelection(pg);
  await idle(h);
  // 字在屏幕上的位置：从 "some" 的开头拖到 "slowly" 的末尾
  const at = (w: string, end: boolean) => pg.evaluate(([root, w, end]) => {
    const t = document.querySelector(root)!.querySelector("p")!.firstChild!, i = t.textContent!.indexOf(w) + (end ? w.length : 0);
    const r = document.createRange(); r.setStart(t, i); r.collapse(true); const b = r.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 };
  }, [pm, w, end] as const);
  const a = await at("some", false), z = await at("slowly", true);
  await pg.mouse.move(a.x, a.y);
  await pg.mouse.down();
  const during: boolean[] = [];
  for (let k = 1; k <= 8; k++) { await pg.mouse.move(a.x + ((z.x - a.x) * k) / 8, a.y, { steps: 2 }); await hold(h, 90, "a slow drag: over all eight steps more than TOOLBAR_SETTLE passes, still no toolbar"); during.push(await has()); }
  await hold(h, TOOLBAR_SETTLE + 200, "the mouse held down and still for longer than TOOLBAR_SETTLE: still selecting, no toolbar"); // 按着鼠标停住：还是在选，不出
  const heldStill = await has();
  const dragged = await pg.evaluate(() => getSelection()!.toString());
  await pg.mouse.up();
  const rightAfterUp = await has(); // the toolbar's timer starts at the release: not shown yet
  await pg.locator(".md-bubble").waitFor(); // and TOOLBAR_SETTLE after it, it shows
  const afterPause = await has();
  await idle(h); // its fade-in
  const opacity = await pg.evaluate(() => getComputedStyle(document.querySelector(".md-bubble")!).opacity);
  // 收拢：立刻收起
  await pg.keyboard.press("End");
  await pmHasSelection(pg); // the editor knows the selection collapsed: the toolbar goes at once
  const afterCollapse = await has();
  // 键盘扩选：⇧← 按着走的途中不出，停下 400ms 后出
  const keys: boolean[] = [];
  for (let k = 0; k < 6; k++) { await pg.keyboard.press("Shift+ArrowLeft"); await pmHasSelection(pg); await hold(h, 120, "a key every 120 ms, under TOOLBAR_SETTLE: no toolbar on the way"); keys.push(await has()); }
  await pg.locator(".md-bubble").waitFor(); // 停下 TOOLBAR_SETTLE 后出
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
  put(b, { id: "n1", kind: "note", md: src, look: "note" } as NoteCard, 60, 60, 560);
  b.cam = { x: 0, y: 0, z: 1.4 };
  const h = await open({ board: b, light, w: 1000, h: 640 });
  const pg = h.page;
  fs.mkdirSync(SHOTS, { recursive: true });
  await idle(h);
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
  await until(h, "Esc saves the Note", () => (h.board().cards.find((c) => c.id === "n1") as NoteCard).md !== src);
  await idle(h);
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
  put(b, { id: "n1", kind: "note", md: src, look: "note" } as NoteCard, 60, 60, 760);
  b.cam = { x: 0, y: 0, z: 1.2 };
  const h = await open({ board: b, light, w: 1100, h: 700 });
  const pg = h.page;
  const pm = '.card[data-id="n1"] .md-pm';
  await pg.locator('.card[data-id="n1"] .nbody').dblclick({ position: { x: 600, y: 12 } });
  await pg.waitForSelector(pm, { timeout: 5000 });
  // the editor has the focus and ProseMirror's focus timers are over: within them it puts its own selection back over the one set below
  await pg.locator(`${pm}:focus`).waitFor();
  await focusSettled(pg);
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
      if (n instanceof Element && n.matches(".md-hide")) return; // hidden source: markers away from the caret, a formula's TeX
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
    ["a \u0000 b", "==a $x$ b==", /<mark>a <span[^>]*class="katex"[\s\S]*<\/mark>/, "mark a $x$ b"],
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
    }, [pm, paras] as const, { timeout: 5000 });
    // 光标处的记号装饰不算：只看格式元素和里面的字（公式写成 $latex$）
    const pasted = await pg.evaluate((root) => {
      const ps = document.querySelector(root)!.querySelectorAll(":scope > p"), p = ps[ps.length - 1].cloneNode(true) as Element;
      p.querySelectorAll(".md-mk, .md-hide").forEach((m) => m.remove());
      // the editor draws a span in pieces (the formula is a widget in its own <mark>): one element per run of the same tag
      for (let k = p.firstChild; k; k = k.nextSibling) {
        while (k instanceof Element && k.nextSibling instanceof Element && k.nextSibling.tagName === k.tagName) { const nx = k.nextSibling; k.append(...nx.childNodes); nx.remove(); }
      }
      p.normalize();
      const el = p.firstElementChild;
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
  await until(h, "Esc saves the Note", () => (h.board().cards.find((c) => c.id === "n1") as NoteCard).md !== src);
  await idle(h);
  const saved = (h.board().cards.find((c) => c.id === "n1") as NoteCard).md;
  check("copyPartialMarkBalanced-saved", saved === [src, ...cases.map((c) => c[1])].join("\n\n"), { saved, out });
  await close(h);
});

/** Copying from a source that shows (an image's opened source line, an inline formula's TeX, a link's address, in a paragraph
 *  and in a table cell): the selection is native, so the clipboard gets exactly the selected characters, as text/plain and as
 *  text/html; only a selection over the whole source copies the whole image */
test("copyInsideShownSource", async () => {
  const b = emptyBoard("b1", "copy");
  const src = `Intro\n\n![](https://e.com/p.png "Fig 5.1: memory types"){width=60%}\n\nSum $a+b+c$ and [the link](https://e.com/page) end\n\n| k | v |\n| - | - |\n| one | $x+y$ |`;
  put(b, { id: "n1", kind: "note", md: src, look: "note" } as NoteCard, 60, 60, 760);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1100, h: 700 });
  const pg = h.page, pm = '.card[data-id="n1"] .md-pm';
  await pg.locator('.card[data-id="n1"] .nbody p').first().dblclick();
  await pg.locator(`${pm}:focus`).waitFor();
  await focusSettled(pg);
  await pg.evaluate(() => { const w = window as any; w.__clip = []; document.addEventListener("copy", (e) => w.__clip.push([e.clipboardData?.getData("text/plain"), e.clipboardData?.getData("text/html")])); });
  // the caret into the source first (so it shows), then the characters selected natively, as a drag does
  const copyOf = async (inside: string, sel: string) => {
    const at = await pg.evaluate(([root, inside, sel]) => {
      const ed = (document.querySelector(root) as any).editor;
      let found: [number, number] | null = null;
      ed.state.doc.descendants((n: any, pos: number) => {
        if (found || !n.isTextblock) return !found;
        const i = n.textContent.indexOf(inside);
        if (i >= 0) { const j = inside.indexOf(sel); found = [pos + 1 + i + j, pos + 1 + i + j + sel.length]; }
        return false;
      });
      if (found) ed.commands.setTextSelection(found[0] + 1);
      return found;
    }, [pm, inside, sel] as const);
    if (!at) return { sel, missing: true };
    await idle(h);
    await pg.evaluate(([root, [from, to]]) => {
      const view = (document.querySelector(root) as any).editor.view, a = view.domAtPos(from), z = view.domAtPos(to), r = document.createRange();
      r.setStart(a.node, a.offset); r.setEnd(z.node, z.offset);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
    }, [pm, at] as const);
    await pg.waitForFunction(([root, [from, to]]) => { const s = (document.querySelector(root) as any)?.editor?.state.selection; return !!s && s.from === from && s.to === to; }, [pm, at] as const, { timeout: 5000 });
    await idle(h);
    const shown = await pg.evaluate((root) => getSelection()!.toString(), pm);
    await pg.keyboard.press("ControlOrMeta+c");
    const [plain, html] = await pg.evaluate(() => (window as any).__clip.pop() ?? []) as [string, string];
    return { sel, shown, plain, html: (html ?? "").replace(/data:[^"]+/g, "…") };
  };
  const cases: [string, string, string, RegExp][] = [
    ['p.png "Fig 5.1: memory types"', "memory types", "memory types", /^(?![\s\S]*<img)[\s\S]*memory types/],
    ["(https://e.com/p.png", "e.com/p", "e.com/p", /^(?![\s\S]*<img)[\s\S]*e\.com\/p/],
    ["$a+b+c$", "b+c", "b+c", /^(?![\s\S]*katex)[\s\S]*b\+c/],
    ["(https://e.com/page)", "e.com/pa", "e.com/pa", /^(?![\s\S]*<a )[\s\S]*e\.com\/pa/],
    ["$x+y$", "+y", "+y", /^(?![\s\S]*katex)[\s\S]*\+y/],
    ['![](https://e.com/p.png "Fig 5.1: memory types"){width=60%}', '![](https://e.com/p.png "Fig 5.1: memory types"){width=60%}', '![](https://e.com/p.png "Fig 5.1: memory types"){width=60%}', /<img[^>]*src="https:\/\/e\.com\/p\.png"/],
  ];
  for (const [inside, sel, plain, html] of cases) {
    const r = await copyOf(inside, sel);
    check(`copyInsideShownSource ${sel}`, "plain" in r && r.plain === plain && html.test(r.html ?? ""), r);
  }
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
  await pg.keyboard.press("ControlOrMeta+0"); await idle(h);
  await pg.locator('.card[data-id="t1"] .tx').dblclick();
  await pm("t1").waitFor({ timeout: 5000 });
  const t1Text = await pm("t1").innerText();
  // 撤销不能撤回上一张 Note 的内容
  for (let i = 0; i < 3; i++) await pg.keyboard.press("ControlOrMeta+z");
  const afterUndo = await pm("t1").innerText();
  const t1Before = mdOf("t1");
  await pg.keyboard.press("Enter"); await pg.keyboard.type("second BBB");
  await pg.keyboard.press("Escape");
  await until(h, "Esc saves the second Note", () => mdOf("t1") !== t1Before);
  await idle(h);
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
    const c: NoteCard = { id: `z${i}`, kind: "note", md: `## Note ${i}\n\nsome **bold** and $x_${i % 9}^2$ text\n\n- [ ] task ${i}\n- item\n\n\`\`\`python\ndef f${i}(x):\n    return x * ${i}\n\`\`\``, look: i % 2 ? "note" : "text" };
    put(b, c, (i % cols) * 460, Math.floor(i / cols) * 520, 400);
  }
  b.cam = { x: 40, y: 40, z: 1 };
  // at once: in idle time the board renders the far Notes too, and the pan must reach some still in the queue
  const h = await open({ board: b, light, w: 1400, h: 900, until: "shown" });
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
          if (e.closest(".card.off")) w.__lz.culled++; // 卡片自己被 cull.ts 藏着，不算
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
  // 马上往远处平移（右下），再缩小、放大（一帧一下，像触控板）
  const WHEEL_STEP = 16;
  for (let i = 0; i < 40; i++) { await pg.mouse.wheel(60, 50); await hold(h, WHEEL_STEP, "wheel steps at 60 Hz, as a trackpad sends them"); }
  await pg.keyboard.down("Control");
  for (let i = 0; i < 12; i++) { await pg.mouse.wheel(0, 40); await hold(h, WHEEL_STEP, "wheel steps at 60 Hz, as a trackpad sends them"); }
  for (let i = 0; i < 12; i++) { await pg.mouse.wheel(0, -40); await hold(h, WHEEL_STEP, "wheel steps at 60 Hz, as a trackpad sends them"); }
  await pg.keyboard.up("Control");
  for (let i = 0; i < 30; i++) { await pg.mouse.wheel(-40, 60); await hold(h, WHEEL_STEP, "wheel steps at 60 Hz, as a trackpad sends them"); }
  // 1.5 秒内全部渲染完
  await until(h, "every Note is rendered within 1.5 s of the last wheel step", () => pg.evaluate(() => !document.querySelectorAll(".md-pend").length && document.querySelectorAll(".card .nbody h2, .card .tx h2").length === 320), 1500);
  await idle(h);
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
  // 双击把光标放在点的位置；这里要从文末开始粘
  await focusSettled(pg);
  await pg.evaluate(() => (document.querySelector('.card[data-id="t1"] .md-pm') as any).editor.commands.focus("end"));
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
  await until(h, "Esc saves the Note", () => (h.board().cards.find((c) => c.id === "t1") as NoteCard).md !== "# Reading notes\nTwo lines, old style\n- a list\n- with block_manager");
  await idle(h);
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
    DIAGRAMS.forEach(([k, src], i) => put(b, { id: `m${i}`, kind: "note", md: `**${k}**\n\n\`\`\`mermaid\n${src}\n\`\`\``, look: "note" } as NoteCard, 40 + (i % 3) * 470, 40 + Math.floor(i / 3) * 880, 440));
    b.cam = { x: 0, y: 0, z: 0.72 };
    const h = await open({ board: b, light: true, w: 1400, h: 1260, settings: { theme } as any });
    const pg = h.page;
    await pg.waitForFunction((n) => document.querySelectorAll(".mmd.ok svg, .mmd-err").length >= n, DIAGRAMS.length, { timeout: 5000 });
    await idle(h);
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
    await until(h, "the diagrams are recoloured for dark", async () => (await look()).text !== lt.text);
    await idle(h);
    const dk = await look();
    const same = await pg.evaluate(() => (window as any).__svg0 === document.querySelector(".mmd.ok svg"));
    await saveShot(h, `mermaid-${theme}-dark`);
    check(`mermaidThemes ${theme}`, lt.ok === DIAGRAMS.length && !lt.shrunk && lt.mind && !lt.err.length && dk.ok === DIAGRAMS.length && same && lt.text !== dk.text, { lt, dk, same });
    await close(h);
  }
  // 换到字体不一样的主题：图按新字体重画
  const b = emptyBoard("b1", "mermaid");
  put(b, { id: "m0", kind: "note", md: `\`\`\`mermaid\n${DIAGRAMS[0][1]}\n\`\`\``, look: "note" } as NoteCard, 40, 40, 440);
  const h = await open({ board: b, light: true, w: 900, h: 700, settings: { theme: "warm-ink" } as any });
  const pg = h.page;
  await pg.waitForSelector(".mmd.ok svg", { timeout: 5000 });
  await pg.evaluate(() => { (window as any).__svg0 = document.querySelector(".mmd.ok svg"); const el = document.documentElement; el.classList.replace("look-warm-ink", "look-newspaper"); el.dataset.look = "newspaper"; });
  await pg.waitForFunction(() => { const s = document.querySelector(".mmd.ok svg"); return !!s && s !== (window as any).__svg0; }, null, { timeout: 5000 }); // drawn again
  const r = await pg.evaluate(() => { const s = document.querySelector(".mmd.ok svg"); return { redrawn: !!s && s !== (window as any).__svg0, font: s ? getComputedStyle(s.querySelector("text")!).fontFamily.split(",")[0] : null }; });
  check("mermaidThemes font switch redraws", r.redrawn && /Old Standard/.test(r.font ?? ""), r);
  await close(h);
  // Note 变宽：放得下了，mindmap 换回横着排
  const b2 = emptyBoard("b1", "mermaid");
  put(b2, { id: "m0", kind: "note", md: `\`\`\`mermaid\n${DIAGRAMS[5][1]}\n\`\`\``, look: "note" } as NoteCard, 40, 40, 300);
  const h2 = await open({ board: b2, light: true, w: 1100, h: 600 });
  await h2.page.waitForSelector(".mmd.ok svg", { timeout: 5000 });
  const size = () => h2.page.evaluate(() => { const s = document.querySelector(".mmd.ok svg")!; return [+s.getAttribute("width")!, +s.getAttribute("height")!]; });
  const narrow = await size();
  await h2.page.evaluate(() => { (document.querySelector('.card[data-id="m0"]') as HTMLElement).style.width = "800px"; });
  await until(h2, "the diagram is laid out again for the wider Note", async () => (await size())[0] !== narrow[0]);
  const wide = await size();
  check("mermaidThemes wider Note lays out left to right", narrow[1] > narrow[0] && wide[0] > wide[1], { narrow, wide });
  await close(h2);
});

/** A theme whose font is not loaded yet: the Mermaid diagrams are laid out again only once that font has loaded, so their boxes
 *  fit the real glyphs and not the fallback font's (the font is served late here, and the fallback is much wider) */
test("mermaidThemeFontLoads", async () => {
  const FONT = path.join(REPO, "extensions/vscode/media/board/fonts/OldStandardTT-400.woff2");
  const CSS = `@font-face { font-family: "SlowTest"; src: url("http://fonts.test/slow.woff2") format("woff2"); }
    :root.look-newspaper { --sys: "SlowTest", monospace !important; }`;
  /** The theme's font from a server that answers once `gate` resolves; `seen.requested` once the page asked for it */
  const slowFont = (gate: Promise<void>, seen: { requested: boolean }, preload: boolean) => async (pg: Page) => {
    await pg.route("http://fonts.test/**", async (r) => {
      seen.requested = true;
      await gate;
      await r.fulfill({ path: FONT, contentType: "font/woff2", headers: { "access-control-allow-origin": "*" } });
    });
    await pg.addInitScript(([css, preload]) => addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style"); st.textContent = css as string; document.head.append(st);
      if (preload) void document.fonts.load('1em "SlowTest"');
    }), [CSS, preload] as const);
  };
  const diagram = () => { const b = emptyBoard("b1", "mermaid"); put(b, { id: "m0", kind: "note", md: `\`\`\`mermaid\n${DIAGRAMS[0][1]}\n\`\`\``, look: "note" } as NoteCard, 40, 40, 440); return b; };
  const size = (pg: Page) => pg.evaluate(() => { const s = document.querySelector(".mmd.ok svg")!; return { w: +s.getAttribute("width")!, h: +s.getAttribute("height")!, rects: [...s.querySelectorAll("rect")].map((r) => +(+r.getAttribute("width")!).toFixed(1)) }; });

  // the diagram drawn with the font loaded from the start
  const ref = await open({ board: diagram(), light: true, w: 900, h: 700, settings: { theme: "newspaper" } as any, beforeLoad: slowFont(Promise.resolve(), { requested: false }, true) });
  await ref.page.waitForSelector(".mmd.ok svg", { timeout: 5000 });
  await idle(ref);
  const want = await size(ref.page);
  await close(ref);

  let release!: () => void;
  const seen = { requested: false };
  const h = await open({ board: diagram(), light: true, w: 900, h: 700, settings: { theme: "warm-ink" } as any, beforeLoad: slowFont(new Promise<void>((r) => { release = r; }), seen, false) });
  const pg = h.page;
  await pg.waitForSelector(".mmd.ok svg", { timeout: 5000 });
  await pg.evaluate(() => { (window as any).__svg0 = document.querySelector(".mmd.ok svg"); const el = document.documentElement; el.classList.replace("look-warm-ink", "look-newspaper"); el.dataset.look = "newspaper"; });
  await until(h, "the page asks for the new theme's font", () => seen.requested);
  // the board gets several frames while the font is still on its way: nothing is laid out with the fallback font
  await frames(pg, 10);
  const early = await pg.evaluate(() => document.querySelector(".mmd.ok svg") !== (window as any).__svg0);
  release();
  await pg.waitForFunction(() => { const s = document.querySelector(".mmd.ok svg"); return !!s && s !== (window as any).__svg0; }, null, { timeout: 5000 });
  await idle(h);
  const got = await size(pg);
  await saveShot(h, "mermaid-font-loads");
  check("mermaidThemeFontLoads-waitsForFont", !early, { early });
  check("mermaidThemeFontLoads-fitsLoadedFont", JSON.stringify(got) === JSON.stringify(want), { got, want });
  await close(h);
});

/** 表格圆角：6px 的外框（separate、0 间距），格子只画右边和下边的线，最后一列、最后一行不画；静态显示和编辑器里一样，宽度和每列宽度也一样（用户拖过的列宽照样生效）*/
test("noteTableRoundedCorners", async () => {
  const b = emptyBoard("b1", "rounded table");
  const md = ["Before.", "| Memory | Scope | Latency |\n|---|---|---|\n| register | thread | 1 |\n| shared | block | 30 |", "After."].join("\n\n");
  put(b, { id: "nb", kind: "note", md, look: "note" } as NoteCard, 80, 80, 420);
  // the same table with column widths the user dragged (mdLayout)
  put(b, { id: "nw", kind: "note", md, look: "note", mdLayout: { tables: [{ cols: [150, null, 120] }] } } as NoteCard, 80, 360, 420);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 900, h: 600 });
  const look = (sel: string) => h.page.evaluate((sel) => {
    const t = document.querySelector<HTMLTableElement>(sel)!, s = getComputedStyle(t), cells = [...t.rows].map((r) => [...r.cells]);
    const last = cells[cells.length - 1], head = cells[0];
    const cs = (el: Element) => getComputedStyle(el);
    return {
      radius: s.borderTopLeftRadius, collapse: s.borderCollapse, spacing: s.borderSpacing, frame: s.borderTopWidth, scroll: s.overflowX,
      inner: cs(head[0]).borderRightWidth, below: cs(head[0]).borderBottomWidth, top: cs(head[0]).borderTopWidth,
      lastCol: cs(head[head.length - 1]).borderRightWidth, lastRow: cs(last[0]).borderBottomWidth, corner: cs(head[0]).borderTopLeftRadius,
      fits: t.getBoundingClientRect().width <= t.parentElement!.getBoundingClientRect().width + 0.5,
    };
  }, sel);
  const want = (x: Awaited<ReturnType<typeof look>>) => x.radius === "6px" && x.collapse === "separate" && /^0px( 0px)?$/.test(x.spacing) && x.frame === "1px"
    && x.inner === "1px" && x.below === "1px" && x.top === "0px" && x.lastCol === "0px" && x.lastRow === "0px" && x.corner === "5px" && x.fits;
  const stat = await look('.card[data-id="nb"] > .cface > .nbody table');
  const tb = (await h.page.locator('.card[data-id="nb"] > .cface > .nbody table').boundingBox())!;
  await h.page.screenshot({ path: path.join(OUT, "note-table-rounded.png"), clip: { x: tb.x - 16, y: tb.y - 16, width: tb.width + 32, height: tb.height + 32 } });
  await h.page.mouse.dblclick(tb.x + 20, tb.y + 10);
  await h.page.locator('.card[data-id="nb"] .md-pm table').waitFor(); await idle(h);
  const ed = await look('.card[data-id="nb"] .md-pm table');
  await shot(h, "note-table-rounded-editor");
  check("table-rounded", want(stat) && want(ed) && stat.scroll === "auto", JSON.stringify({ stat, ed }));
  // read-only and editing: the same table width and column widths, with and without user column widths
  const widths = (sel: string) => h.page.evaluate((sel) => { const t = document.querySelector<HTMLTableElement>(sel)!; return { table: Math.round(t.getBoundingClientRect().width), cols: [...t.rows[0].cells].map((c) => Math.round(c.getBoundingClientRect().width)) }; }, sel);
  const edW = await widths('.card[data-id="nb"] .md-pm table');
  await h.page.keyboard.press("Escape"); await h.page.locator('.card[data-id="nb"] .md-pm').waitFor({ state: "detached" }); await idle(h);
  const statW = await widths('.card[data-id="nb"] > .cface > .nbody table');
  const statL = await widths('.card[data-id="nw"] > .cface > .nbody table');
  const tw = (await h.page.locator('.card[data-id="nw"] > .cface > .nbody table').boundingBox())!;
  await h.page.mouse.dblclick(tw.x + 20, tw.y + 10);
  await h.page.locator('.card[data-id="nw"] .md-pm table').waitFor(); await idle(h);
  const edL = await widths('.card[data-id="nw"] .md-pm table');
  const same = (a: typeof edW, b: typeof edW) => Math.abs(a.table - b.table) <= 1 && a.cols.length === b.cols.length && a.cols.every((w, i) => Math.abs(w - b.cols[i]) <= 1);
  check("table-width-same-reading-and-editing", same(statW, edW) && same(statL, edL) && Math.abs(statL.cols[0] - 150) <= 1 && Math.abs(statL.cols[2] - 120) <= 1, JSON.stringify({ statW, edW, statL, edL }));
  await close(h);
});

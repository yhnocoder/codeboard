// v0.1.8 Markdown: static rendering on Notes / Text / descriptions / sidenotes, the WYSIWYG editor (lazy chunk), slash menu,
// bubble toolbar, [[card refs]], raw mode, task toggle on static notes (node run-harness.mjs v18md v18mdedit … [--light])
// Each scenario prints PASS / FAIL lines and throws when a check fails, so CI catches it.
import * as fs from "node:fs";
import { open, shot, symCard, findSym, put, type Host } from "./harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";

const light = process.argv.includes("--light");
const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
const close = (h: Host) => h.page.context().browser()!.close();
const SHOTS = process.env.MD_SHOTS ?? "/mnt/project-files/v018";

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
  const b = emptyBoard("b1", "v0.1.8 markdown");
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

function check(name: string, ok: boolean, info: unknown) {
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(info));
  if (!ok) throw new Error(`${name} failed: ${JSON.stringify(info)}`);
}
async function saveShot(h: Host, name: string) {
  await shot(h, name);
  try { fs.mkdirSync(SHOTS, { recursive: true }); await h.page.screenshot({ path: `${SHOTS}/${name}.png` }); } catch { /* no project files here */ }
}

export const V018MD: Record<string, () => Promise<void>> = {
  /** Static render: math, code colours, tasks, table, chips, footnote, details; links go to the host, chips jump to the card */
  async v18md() {
    for (const theme of ["warm-ink", "ink-wash", "city"]) {
      const { b } = mdBoard();
      // 视野外很远的一张：先放纯文字，空闲时补渲染
      put(b, { id: "far", kind: "note", md: "far **away** $y^2$", bg: true } as NoteCard, 9000, 6000, 300);
      const h = await open({ board: b, light, w: 1400, h: 950, settings: { theme } as any });
      await h.page.waitForTimeout(500);
      const far = await h.page.evaluate(() => !!document.querySelector('.card[data-id="far"] .nbody strong') && !!document.querySelector('.card[data-id="far"] .katex'));
      check(`v18md-offview ${theme}`, far, { far });
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
      await saveShot(h, `v18-md-${theme}-${light ? "light" : "dark"}`);
      check(`v18md ${theme}`, ok, r);
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
      check(`v18md-click ${theme}`, opened && selId.length === 1 && selId[0] !== "n1" && md.includes("- [x] check"), { opened, selId, task: md.split("\n")[4] });
      await close(h);
    }
  },

  /** WYSIWYG editing: lazy chunk loads, typing with input rules, / menu, [[ picker, bubble toolbar, raw mode, ⌘Z stays in the editor, Esc saves */
  async v18mdedit() {
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
    await saveShot(h, "v18-edit-slash");
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
    await saveShot(h, "v18-edit-ref");
    await pg.keyboard.press("Enter");
    const chip = await pg.locator('.card[data-id="n1"] .md-pm .cref').count();
    // 选中几个字：出工具条，点 I 变斜体
    await pg.keyboard.type("tail words");
    for (let i = 0; i < 5; i++) await pg.keyboard.press("Shift+ArrowLeft");
    await pg.waitForTimeout(150);
    const bubble = await pg.locator(".md-bubble").count();
    await saveShot(h, "v18-edit-bubble");
    await pg.locator(".md-bubble .tbtn", { hasText: /^I$/ }).click();
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
    await saveShot(h, "v18-edit-saved");
    check("v18mdedit", ok, r);
    await close(h);
  },

  /** One editor is reused across Notes: each edit starts from that Note's text with its own undo history */
  async v18mdreuse() {
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
    check("v18mdreuse", r.t1Fresh && r.undoKept && r.n1Saved && r.t1Saved && r.stale === 0, r);
    await close(h);
  },

  /** Large board, pan and zoom straight into areas not rendered yet: a Note in view never shows its raw-text placeholder, every frame */
  async v18mdlazy() {
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
    await saveShot(h, "v18-md-lazy");
    // pendSeen > 0：确实有过排队的（不然这项没测到什么）；1.5 秒后全部渲染完
    check("v18mdlazy", r.pendSeen > 0 && r.rawShown === 0 && r.hiddenInView === 0 && r.blankInView === 0 && r.leftAfter === 0 && r.rendered === 320, r);
    await close(h);
  },

  /** Paste: HTML becomes clean markdown, VS Code code keeps its indentation, markdown text is parsed */
  async v18mdpaste() {
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
    check("v18mdpaste", Object.values(r).every(Boolean), { ...r, md: md.slice(-260) });
    await close(h);
  },
};

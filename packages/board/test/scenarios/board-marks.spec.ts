// Board Marks (core seal.ts) on the real host: a Note's [[refs]] to cards on other boards show the target board's Mark instead of
// its name; one in another book (top-level board) puts that book's Mark first, as the left half of one box; a ref to a book itself
// is only its Mark. Edit Mark… (a ref's menu, the board's More menu) changes a Mark, and every ref follows.
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { shot, OUT, type Host } from "../harness";
import { test, check, until, idle, hostBoards, light } from "../fixtures";

const note = (b: Board, id: string, md: string, x: number, y: number, w = 420) => {
  b.cards.push({ id, kind: "note", md, look: "note" } satisfies NoteCard);
  b.place[id] = { x, y, w };
};
const frame = (b: Board, sub: string, x: number, y: number) => {
  b.cards.push({ id: `f-${sub}`, kind: "board", board: sub });
  b.place[`f-${sub}`] = { x, y, w: 360 };
};

const NOTE = [
  "## 第四章回顾",
  "",
  "第四章介绍了 GPU 的计算架构和相关性能考量，例如 [[Warp 控制流分歧]] 与资源划分。第五章介绍了 [[Memory architecture and data locality › CUDA 内存类型概述]]。tiling 的思路和 [[Convolution › tiled 二维卷积]] 一样。",
  "",
  "DRAM 的 burst 和 cache line 的关系，在 [[The memory hierarchy › Cache 的组织方式]] 里讲过。整本书的目录见 [[pmpp]]，对照着读 [[csapp]]。",
].join("\n");

/** Book pmpp ⊃ Convolution [CNN], Compute architecture and scheduling [CompArch], Memory architecture… [Mem&Data]; book csapp ⊃ The memory hierarchy [MH, the default] */
function books() {
  const pmpp = emptyBoard("bPmpp", "pmpp"),
    conv = emptyBoard("bConv", "Convolution"),
    comp = emptyBoard("bComp", "Compute architecture and scheduling"),
    mem = emptyBoard("bMem", "Memory architecture and data locality"),
    csapp = emptyBoard("bCsapp", "csapp"),
    mh = emptyBoard("bMh", "The memory hierarchy");
  frame(pmpp, "bConv", 0, 0);
  frame(pmpp, "bComp", 420, 0);
  frame(pmpp, "bMem", 840, 0);
  frame(csapp, "bMh", 0, 0);
  pmpp.seal = { color: "graphite" };
  conv.seal = { text: "CNN", color: "olive" };
  comp.seal = { text: "CompArch", color: "ink" };
  mem.seal = { text: "Mem&Data", color: "teal" };
  note(conv, "cv1", "## tiled 二维卷积\n先把输入 tile 搬进 shared memory", 0, 0);
  note(mem, "me1", "## CUDA 内存类型概述\n寄存器、shared memory、global memory", 0, 0);
  note(mh, "mh1", "## Cache 的组织方式\n组相联、行大小、替换策略", 0, 0);
  note(comp, "cp0", "## Warp 控制流分歧\n同一个 warp 里的线程走不同的分支", 40, 360, 360);
  note(comp, "cp1", NOTE, 40, 40, 620);
  comp.cam = { x: 40, y: 40, z: 1 };
  return [comp, pmpp, conv, mem, csapp, mh];
}

const refSel = (label: string) => `.card[data-id="cp1"] .md-ref[data-ref="${label}"]`;
/** What a ref shows: its seal (the book half and the board half, or one), its title, its hover text, the gap after the seal */
async function refLook(h: Host, label: string) {
  return h.page.locator(refSel(label)).evaluate((r) => {
    const s = r.querySelector<HTMLElement>(":scope > .md-seal"),
      t = r.querySelector<HTMLElement>(":scope > .t");
    return {
      seal: s ? (s.classList.contains("two") ? [...s.children].map((x) => x.textContent) : [s.textContent]) : null,
      alone: !!s?.classList.contains("alone"),
      title: t?.textContent ?? (s ? null : r.textContent),
      hint: r.title,
      gap: s && t ? t.getBoundingClientRect().left - s.getBoundingClientRect().right : null,
      fontPx: parseFloat(getComputedStyle(r).fontSize),
    };
  });
}

async function setup(o: { light?: boolean; scale?: number } = {}) {
  const run = await hostBoards(books(), { page: { light: o.light ?? light, w: 1100, h: 720, scale: o.scale } });
  const h = await run.open("bComp");
  await until(h, "the refs to other boards show Marks", () => h.page.locator(`${refSel("csapp")} .md-seal`).count());
  await idle(h);
  return { run, h };
}

test("boardMarksOnRefs", async () => {
  const { h } = await setup();
  const conv = await refLook(h, "Convolution › tiled 二维卷积");
  check("boardMarksSameBook", JSON.stringify(conv.seal) === '["CNN"]' && conv.title === "tiled 二维卷积", conv);
  check("boardMarksPathOnHover", conv.hint === "pmpp › Convolution › tiled 二维卷积", conv.hint);
  // a real margin between the seal and the title (≈ .4em of the seal's .72em text)
  check("boardMarksGap", conv.gap !== null && conv.gap > conv.fontPx * 0.2 && conv.gap < conv.fontPx * 0.5, conv);
  const mh = await refLook(h, "The memory hierarchy › Cache 的组织方式");
  check("boardMarksCrossBook", JSON.stringify(mh.seal) === '["csapp","MH"]' && mh.title === "Cache 的组织方式", mh);
  const book = await refLook(h, "csapp");
  check("boardMarksBookAlone", JSON.stringify(book.seal) === '["csapp"]' && book.alone && book.title === null, book);
  const own = await refLook(h, "pmpp");
  check("boardMarksOwnBookAlone", JSON.stringify(own.seal) === '["pmpp"]' && own.alone, own);
  const here = await refLook(h, "Warp 控制流分歧");
  check("boardMarksThisBoardPlain", here.seal === null && here.title === "Warp 控制流分歧", here);
  await shot(h, "board-marks-refs");
  // the editor draws the same chips
  await h.page.locator('.card[data-id="cp1"] .nbody').dblclick({ position: { x: 300, y: 12 } });
  await h.page.waitForSelector('.card[data-id="cp1"] .md-pm');
  const inEditor = await until(h, "the editor's chips show Marks", async () => {
    const n = await h.page.locator('.card[data-id="cp1"] .md-pm .md-ref > .md-seal').allTextContents();
    return n.length === 5 ? n : null;
  });
  check("boardMarksInEditor", JSON.stringify(inEditor) === '["Mem&Data","CNN","csappMH","pmpp","csapp"]', inEditor);
});

test("boardMarksEdit", async () => {
  const { run, h } = await setup();
  const page = h.page;
  // a ref's menu: Edit Mark… of the board it points into
  await page.locator(refSel("Convolution › tiled 二维卷积")).click({ button: "right" });
  await page.locator(".ctx button", { hasText: "Edit Mark…" }).click();
  const input = page.locator(".pop.k-seal input.seal-in");
  await input.waitFor();
  await until(h, "the box has the keyboard", () => input.evaluate((e) => e === document.activeElement));
  check("boardMarksEditStarts", (await input.inputValue()) === "CNN", await input.inputValue());
  // the same text as another board of the book: a warning, not a stop
  await input.fill("mem&data");
  const hint = page.locator(".pop.k-seal .seal-hint");
  await until(h, "the clash is pointed out", async () => (await hint.getAttribute("class"))?.includes("warn"));
  check(
    "boardMarksClash",
    (await hint.textContent()) === "“Memory architecture and data locality” also uses mem&data",
    await hint.textContent(),
  );
  await shot(h, "board-marks-clash");

  // IME: while composing, the box is left alone (no trimming) and Enter does not save; on compositionend it is cleaned up
  await input.fill("");
  const ime = await input.evaluate(async (el: HTMLInputElement) => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    el.value = "juan ji";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText" }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true, keyCode: 229 }));
    const during = el.value,
      open = el.isConnected;
    el.value = "卷 积";
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "卷积" }));
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: false, inputType: "insertFromComposition" }),
    );
    return { during, open, after: el.value };
  });
  check("boardMarksImeUntouched", ime.during === "juan ji" && ime.open, ime);
  check("boardMarksImeCleaned", ime.after === "卷积", ime);
  await page.locator('.pop.k-seal .seal-sw button[aria-label="vermilion"]').click();
  await page.locator(".pop.k-seal .btn.pri", { hasText: "Save" }).click();
  // another board's file: the host writes it and pushes the boards, and the ref repaints
  await until(h, "the host saves Convolution's Mark", () => run.host.store.peek("bConv")?.seal?.text === "卷积");
  check(
    "boardMarksSaved",
    JSON.stringify(run.host.store.peek("bConv")?.seal) === '{"text":"卷积","color":"vermilion"}',
  );
  await until(
    h,
    "the ref shows the new Mark",
    async () => JSON.stringify((await refLook(h, "Convolution › tiled 二维卷积")).seal) === '["卷积"]',
  );

  // this board's own Mark, from the More menu: a command, undone with ⌘Z
  await page.locator('.bbar button[aria-label="More"]').click();
  await page.locator(".ctx button", { hasText: "Edit Mark…" }).click();
  await input.waitFor();
  check("boardMarksOwnStarts", (await input.inputValue()) === "CompArch", await input.inputValue());
  await input.fill("GPU 架构");
  await until(h, "the box is cleaned up", async () => (await input.inputValue()) === "GPU架构");
  await input.press("Enter");
  await until(h, "this board's Mark is saved", () => run.host.store.peek("bComp")?.seal?.text === "GPU架构");
  await idle(h);
  await page.keyboard.press("ControlOrMeta+z");
  await until(h, "undo brings the Mark back", () => run.host.store.peek("bComp")?.seal?.text === "CompArch");
});

// Screenshots for review (Warm Ink, light and dark, 2×): the refs, and Edit Mark… with a clash
test("boardMarksScreenshots", async () => {
  const dir = path.join(OUT, "board-marks");
  fs.mkdirSync(dir, { recursive: true });
  for (const lit of [true, false]) {
    const { h } = await setup({ light: lit, scale: 2 });
    const tone = lit ? "light" : "dark";
    const box = (await h.page.locator('.card[data-id="cp1"]').boundingBox())!;
    const clip = { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 };
    await h.page.screenshot({ path: path.join(dir, `refs-${tone}.png`), clip });
    await h.page.locator(refSel("Convolution › tiled 二维卷积")).click({ button: "right" });
    await h.page.locator(".ctx button", { hasText: "Edit Mark…" }).click();
    const input = h.page.locator(".pop.k-seal input.seal-in");
    await input.fill("Mem&Data");
    await until(h, "the clash is shown", () => h.page.locator(".pop.k-seal .seal-hint.warn").count());
    await idle(h);
    const pop = (await h.page.locator(".pop.k-seal").boundingBox())!;
    const x = Math.min(box.x, pop.x) - 24,
      y = Math.min(box.y, pop.y) - 24;
    await h.page.screenshot({
      path: path.join(dir, `edit-mark-${tone}.png`),
      clip: {
        x,
        y,
        width: Math.max(box.x + box.width, pop.x + pop.width) + 24 - x,
        height: Math.max(box.y + box.height, pop.y + pop.height) + 24 - y,
      },
    });
    await h.page.context().close();
  }
});

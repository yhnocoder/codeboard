// [[引用]] 跟着改名走：从 [[ / @ 列表选的引用带着目标的 id（[[标题#^id]]），目标改了名，引用照样认得出、显示新名字，
// 别的 Note 和别的白板文件一个字都不改
import { put, shot, type Host } from "../harness";
import type { Page } from "@playwright/test";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, until, idle, focusSettled, hostBoards } from "../fixtures";

const close = (h: Host) => h.page.context().close();
const noteMd = (b: Board, id: string) => (b.cards.find((c) => c.id === id) as NoteCard).md;
const chip = (pg: Page, card: string) => pg.locator(`.card[data-id="${card}"] .nbody .md-ref`).first();
/** 引用现在显示的样子：标题、白板名（别的白板上的）、找不到 / 地方没了 */
const chipLook = (pg: Page, card: string) =>
  chip(pg, card).evaluate((e) => ({
    t: e.querySelector(".t")?.textContent ?? e.textContent,
    bd: e.querySelector(".bd")?.textContent,
    tip: e.getAttribute("title"),
    missing: e.classList.contains("missing"),
    gone: e.classList.contains("gone"),
  }));

/** 双击 Note 进编辑、光标放到最后，打 text，在列表里选中 pick 那一行，Esc 存 */
async function pickRef(h: Host, card: string, text: string, pick: string) {
  const pg = h.page;
  const body = pg.locator(`.card[data-id="${card}"] .nbody`);
  const box = (await body.boundingBox())!;
  await body.dblclick({ position: { x: box.width - 8, y: box.height / 2 } });
  await pg.locator(`.card[data-id="${card}"] .md-pm`).waitFor();
  await focusSettled(pg);
  await pg.evaluate((id) => {
    const e = (document.querySelector(`.card[data-id="${id}"] .md-pm`) as any).editor;
    e.commands.setTextSelection(e.state.doc.content.size - 1);
  }, card);
  await pg.keyboard.type(text);
  await pg.locator(".md-menu button.sel", { hasText: pick }).waitFor();
  await pg.keyboard.press("Enter");
  await pg.keyboard.press("Escape");
}

/** 改了卡的名字（Note 的标题行）：另一张 Note 里选来的 [[引用]] 显示新名字，那张 Note 的原文不变 */
test("noteRefFollowsCardRename", async () => {
  const b = emptyBoard("b1", "refs");
  put(
    b,
    { id: "a", kind: "note", md: "# Allocate\n\nKV pages for a new sequence", look: "note" } as NoteCard,
    60,
    60,
    380,
  );
  put(b, { id: "n", kind: "note", md: "Prefill calls", look: "note" } as NoteCard, 520, 60, 380);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 1000, h: 520, settings: { theme: "warm-ink" } as any });
  const pg = h.page;
  await pickRef(h, "n", " [[alloc", "Allocate");
  await until(h, "the note is saved", () => noteMd(h.board(), "n").includes("[[Allocate"));
  const picked = noteMd(h.board(), "n");
  check("noteRefFollowsCardRename the pick carries the card's id", picked.includes("[[Allocate#^a]]"), { picked });
  await idle(h);
  await shot(h, "note-ref-rename-before");

  // 改 Note a 的标题行（不是 Rename 菜单：那条路以前会顺手改写 [[旧名]]，标题行改了从来没人跟）
  await pg.locator('.card[data-id="a"] .nbody').dblclick();
  await pg.locator('.card[data-id="a"] .md-pm').waitFor();
  await focusSettled(pg);
  await pg.evaluate(() => {
    const e = (document.querySelector('.card[data-id="a"] .md-pm') as any).editor;
    const t = e.state.doc.firstChild.textContent as string;
    const at = t.indexOf("Allocate") + 1;
    e.commands.setTextSelection({ from: at, to: at + "Allocate".length });
  });
  await pg.keyboard.type("Block allocator");
  await pg.keyboard.press("Escape");
  await until(h, "the heading is saved", () => noteMd(h.board(), "a").startsWith("# Block allocator"));
  await until(h, "the reference shows the new title", async () => (await chipLook(pg, "n")).t === "Block allocator");
  const look = await chipLook(pg, "n");
  check(
    "noteRefFollowsCardRename the reference shows the new title and still resolves",
    look.t === "Block allocator" && !look.missing && !look.gone && noteMd(h.board(), "n") === picked,
    { look, md: noteMd(h.board(), "n") },
  );
  await shot(h, "note-ref-rename-after");
  // 点它还是带到那张卡
  await chip(pg, "n").click();
  await until(h, "the reference selects the card", () => pg.locator('.card.sel[data-id="a"]').count());
  await close(h);
});

/** 改了 Section 的名字：@ 选来的引用显示新名字，点它还是选中那个 Section */
test("noteRefFollowsSectionRename", async () => {
  const b = emptyBoard("b1", "refs");
  b.sections.push({ id: "g1", title: "Prefill stage", x: 520, y: 40, w: 420, h: 300 });
  put(b, { id: "n", kind: "note", md: "Read", look: "note" } as NoteCard, 60, 60, 380);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 1000, h: 520, settings: { theme: "warm-ink" } as any });
  const pg = h.page;
  await pickRef(h, "n", " @prefill", "Prefill stage");
  await until(h, "the note is saved", () => noteMd(h.board(), "n").includes("[[Prefill stage"));
  const picked = noteMd(h.board(), "n");
  check("noteRefFollowsSectionRename the pick carries the Section's id", picked.includes("[[Prefill stage#^g1]]"), {
    picked,
  });
  await pg.locator('.slabel[data-sect="g1"] .sname').dblclick();
  const name = pg.locator('.slabel[data-sect="g1"] .sname.editing');
  await name.waitFor();
  await pg.keyboard.press("ControlOrMeta+a");
  await pg.keyboard.type("Chunked prefill");
  await pg.keyboard.press("Enter");
  await until(h, "the Section is renamed", () => h.board().sections[0].title === "Chunked prefill");
  await until(h, "the reference shows the new name", async () => (await chipLook(pg, "n")).t === "Chunked prefill");
  const look = await chipLook(pg, "n");
  check(
    "noteRefFollowsSectionRename the reference shows the new name and still resolves",
    look.t === "Chunked prefill" && !look.missing && noteMd(h.board(), "n") === picked,
    { look, md: noteMd(h.board(), "n") },
  );
  await chip(pg, "n").click();
  await until(h, "the reference selects the Section", () => pg.locator('.sect.sel[data-sect="g1"]').count());
  await close(h);
});

/** 改了别的白板的名字（真的宿主）：[[白板 › 卡]] 照样认得出，带着那块白板的新名字；两块白板的文件里的引用都不改 */
test("noteRefFollowsBoardRename", async () => {
  const a = emptyBoard("ba", "Reading notes");
  put(a, { id: "n", kind: "note", md: "Attention lives in", look: "note" } as NoteCard, 60, 60, 420);
  const k = emptyBoard("bk", "Kernels");
  put(k, { id: "k1", kind: "note", md: "# Flash attention\n\nTiles Q, K, V", look: "note" } as NoteCard, 60, 60, 380);
  const run = await hostBoards([a, k], { page: { light: true, w: 1000, h: 520, settings: { theme: "warm-ink" } } });
  const h = await run.open("ba");
  const pg = h.page;
  await pickRef(h, "n", " [[flash", "Flash attention");
  await until(h, "the note is saved", () => noteMd(h.board(), "n").includes("[[Kernels"));
  const picked = noteMd(h.board(), "n");
  check(
    "noteRefFollowsBoardRename the pick carries the board's and the card's id",
    picked.includes("[[Kernels › Flash attention#^bk/k1]]"),
    { picked },
  );
  // 侧栏的 Rename Board（那块白板没开着）
  run.ws.ui = { ...run.ws.ui, input: async () => "Attention kernels" };
  await run.host.actions["codeboard.renameBoard"]("bk");
  // a ref to another board shows that board's Mark (board-marks.spec.ts) and its path on hover: the path has the new name
  await until(h, "the reference carries the new board name", async () =>
    /^Attention kernels\b/.test((await chipLook(pg, "n")).tip ?? ""),
  );
  const look = await chipLook(pg, "n");
  check(
    "noteRefFollowsBoardRename the reference resolves under the board's new name",
    look.t === "Flash attention" && look.tip === "Attention kernels › Flash attention" && !look.missing && !look.gone,
    look,
  );
  check("noteRefFollowsBoardRename the note is not rewritten", noteMd(h.board(), "n") === picked, {
    md: noteMd(h.board(), "n"),
  });
  await chip(pg, "n").click();
  await until(h, "the reference opens the renamed board at the card", () => run.page("bk"));
  await run.close();
});

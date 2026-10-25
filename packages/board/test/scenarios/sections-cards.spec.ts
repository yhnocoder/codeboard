// Sections and card edits: the Section look (idle, hover, selected), moving a card from one Section into another,
// a Note's title from its first heading, and ⌘X on cards (npm run harness -- sectionLook dragCardIntoOtherSection …)
import { shot, symCard, findSym, put, type Host } from "../harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, light } from "../fixtures";

const close = (h: Host) => h.page.context().close();
const wait = (h: Host, ms: number) => h.page.waitForTimeout(ms);

/** Two Sections side by side: a code card in the left one, a Note with a heading in the right one */
function twoSections(): Board {
  const b = emptyBoard("b1", "nano-vllm · sections");
  const s = findSym("Scheduler.schedule");
  const code = symCard(s.f, s.s);
  put(b, code, 100, 110, 480);
  const note: NoteCard = { id: "n1", kind: "note", bg: true, md: "# KV cache budget\n\nPrefill first, then decode." };
  put(b, note, 760, 110, 320);
  b.sections.push({ id: "S1", title: "异构并行计算", x: 60, y: 60, w: 560, h: 760 });
  b.sections.push({ id: "S2", title: "Scheduling", x: 720, y: 60, w: 520, h: 420 });
  b.place[code.id].section = "S1";
  b.place.n1.section = "S2";
  return b;
}

/** Section frame: a solid hairline (no dashes), no pill behind the title, handle and caret only on hover; selected = accent */
test("sectionLook", async () => {
  const h = await open({ board: twoSections(), light });
  await h.page.keyboard.press("Shift+!"); await wait(h, 600);
  await h.page.mouse.move(1380, 880);
  const look = () => h.page.evaluate(() => {
    const f = document.querySelector('.sect[data-sect="S2"]')!, l = document.querySelector('.slabel[data-sect="S2"]')!;
    const fs = getComputedStyle(f), ls = getComputedStyle(l);
    const op = (sel: string) => { const e = l.querySelector(sel); return e ? +getComputedStyle(e).opacity : -1; };
    return { border: fs.borderTopStyle, radius: parseFloat(fs.borderTopLeftRadius), labelBg: ls.backgroundColor, dots: op(".dots"), chev: op(".chev2"), shadow: fs.boxShadow };
  });
  const idle = await look();
  await shot(h, "sect-look-01-idle");
  await h.page.locator('.slabel[data-sect="S2"] .sname').hover(); await wait(h, 400);
  const hover = await look();
  await shot(h, "sect-look-02-hover");
  await h.page.locator('.slabel[data-sect="S2"] .sname').click(); await wait(h, 400);
  const selected = await look();
  await shot(h, "sect-look-03-selected");
  const clear = (c: string) => c === "rgba(0, 0, 0, 0)" || c === "transparent";
  check("section-look-idle", idle.border !== "dashed" && idle.radius <= 12 && clear(idle.labelBg) && idle.dots === 0 && idle.chev === 0, idle);
  check("section-look-hover", hover.dots > 0.9 && hover.chev > 0.9, hover);
  check("section-look-selected", selected.shadow !== idle.shadow, { idle: idle.shadow, selected: selected.shadow });
  await close(h);
});

/** Drag a card by its title bar from one Section into another: the target Section lights up during the drag, the card joins it, one undo puts it back */
test("dragCardIntoOtherSection", async () => {
  const h = await open({ board: twoSections(), light });
  await h.page.keyboard.press("Shift+!"); await wait(h, 600);
  const head = (await h.page.locator('.card[data-id="n1"] .chead').boundingBox())!;
  const card = (await h.page.locator('.card[data-id="n1"]').boundingBox())!;
  const s1 = (await h.page.locator('.sect[data-sect="S1"]').boundingBox())!;
  const s2a = (await h.page.locator('.sect[data-sect="S2"]').boundingBox())!;
  const grab = { x: head.x + 40, y: head.y + head.height / 2 };
  // put the card's centre in the lower part of S1, below the code card
  const to = { x: s1.x + s1.width / 2, y: s1.y + s1.height - card.height / 2 - 30 };
  const dx = to.x - (card.x + card.width / 2), dy = to.y - (card.y + card.height / 2);
  await h.page.mouse.move(grab.x, grab.y); await h.page.mouse.down();
  await h.page.mouse.move(grab.x + dx / 2, grab.y + dy / 2, { steps: 6 });
  await h.page.mouse.move(grab.x + dx, grab.y + dy, { steps: 10 }); await wait(h, 300);
  const during = await h.page.evaluate(() => [...document.querySelectorAll(".sect.drop, .slabel.drop")].map((e) => (e as HTMLElement).dataset.sect));
  const s2b = (await h.page.locator('.sect[data-sect="S2"]').boundingBox())!;
  await shot(h, "sect-drag-01-over-target");
  await h.page.mouse.up(); await wait(h, 500);
  const after = h.board().place.n1.section;
  const lit = await h.page.locator(".sect.drop").count();
  await shot(h, "sect-drag-02-dropped");
  check("drag-into-section-highlight", during.includes("S1") && !during.includes("S2"), { during });
  // the Section the card leaves keeps its own frame during the drag instead of stretching after the card
  check("drag-source-section-stays", Math.abs(s2b.height - s2a.height) < 2 && Math.abs(s2b.width - s2a.width) < 2, { before: s2a, during: s2b });
  check("drag-into-section-joins", after === "S1" && lit === 0, { after, lit });
  await h.page.keyboard.press("Control+z"); await wait(h, 500);
  check("drag-into-section-undo", h.board().place.n1.section === "S2", { section: h.board().place.n1.section });
  // the same move from the card menu: Move to Section ▸ 异构并行计算 (the card lands inside that Section's frame)
  await h.page.locator('.card[data-id="n1"] .chead').click({ button: "right" }); await wait(h, 200);
  await h.page.locator(".ctx button", { hasText: "Move to Section" }).hover(); await wait(h, 300);
  await shot(h, "sect-menu-01-move-to");
  await h.page.locator(".ctx button", { hasText: "异构并行计算" }).click(); await wait(h, 700);
  const p = h.board().place.n1, f = (await h.page.locator('.sect[data-sect="S1"]').boundingBox())!, c = (await h.page.locator('.card[data-id="n1"]').boundingBox())!;
  await shot(h, "sect-menu-02-moved");
  check("move-to-section-menu", p.section === "S1" && p.y >= 60 && p.y <= 820 && c.x >= f.x && c.x + c.width <= f.x + f.width && c.y >= f.y && c.y + c.height <= f.y + f.height + 1, { p, f, c });
  await close(h);
});

/** A Note whose Markdown starts with a heading shows the heading as its title; a title set by the user wins; no heading = "Note" */
test("noteTitleFromHeading", async () => {
  const b = emptyBoard("b1", "titles");
  put(b, { id: "n1", kind: "note", bg: true, md: "## KV cache **budget**\n\nPrefill first." } as NoteCard, 80, 80, 300);
  put(b, { id: "n2", kind: "note", bg: true, md: "Just a paragraph, no heading." } as NoteCard, 440, 80, 300);
  put(b, { id: "n3", kind: "note", bg: true, md: "# From heading", title: "Chosen by me" } as NoteCard, 800, 80, 300);
  const h = await open({ board: b, light, w: 1200, h: 600 });
  await wait(h, 500);
  const title = (id: string) => h.page.locator(`.card[data-id="${id}"] .chead .ctitle`).textContent();
  const t0 = { n1: await title("n1"), n2: await title("n2"), n3: await title("n3") };
  await shot(h, "note-title-01");
  check("note-title-from-heading", t0.n1 === "KV cache budget" && t0.n2 === "Note" && t0.n3 === "Chosen by me", t0);
  // editing the heading changes the title
  await h.page.locator('.card[data-id="n2"] .nbody').dblclick(); await wait(h, 400);
  await h.page.keyboard.press("Control+a"); await h.page.keyboard.type("# Decode loop\n\nOne token per step.");
  await h.page.keyboard.press("Escape"); await wait(h, 500);
  const t1 = await title("n2");
  await shot(h, "note-title-02-edited");
  check("note-title-follows-edit", t1 === "Decode loop", { t1, md: (h.board().cards.find((c) => c.id === "n2") as NoteCard).md });
  await close(h);
});

/** ⌘X cuts the selected cards (one undo step brings them back); ⌘V on the same board puts them back as they were; ⌘X while editing a Note cuts text only */
test("cutCardsPasteUndo", async () => {
  const b = twoSections();
  const code = b.cards[0].id;
  const h = await open({ board: b, light });
  await h.page.keyboard.press("Shift+!"); await wait(h, 600);
  const p0 = { ...h.board().place.n1 };
  await h.page.locator('.card[data-id="n1"] .chead').click(); await wait(h, 200);
  await h.page.keyboard.press("Control+x"); await wait(h, 600);
  const cut = { n1: !!h.board().cards.find((c) => c.id === "n1"), copied: h.sent.some((m) => m.type === "copyCards") };
  await h.page.keyboard.press("Control+z"); await wait(h, 600);
  const undone = { n1: !!h.board().cards.find((c) => c.id === "n1"), place: h.board().place.n1 };
  await h.page.keyboard.press("Control+Shift+z"); await wait(h, 600);
  const redone = !h.board().cards.some((c) => c.id === "n1");
  check("cut-removes-card", !cut.n1 && cut.copied, cut);
  check("cut-single-undo", undone.n1 && undone.place?.x === p0.x && undone.place?.y === p0.y && undone.place?.section === "S2", { undone, p0 });
  check("cut-redo", redone);
  // paste: the clipboard has the card's text; the same card comes back (same id, its heading intact) at the pointer
  await h.page.mouse.move(1000, 700);
  await h.page.evaluate((t) => { const dt = new DataTransfer(); dt.setData("text/plain", t); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true })); }, (b.cards[1] as NoteCard).md);
  await wait(h, 900);
  const back = h.board().cards.find((c) => c.id === "n1") as NoteCard | undefined;
  await shot(h, "cut-01-pasted");
  check("cut-paste-restores", !!back && back.md === (b.cards[1] as NoteCard).md && h.board().cards.length === 2, { ids: h.board().cards.map((c) => c.id) });
  // ⌘X inside the Note editor: text is cut, the card stays
  await h.page.locator('.card[data-id="n1"] .nbody').dblclick(); await wait(h, 400);
  await h.page.keyboard.press("Control+a"); await h.page.keyboard.press("Control+x"); await wait(h, 300);
  await h.page.keyboard.press("Escape"); await wait(h, 400);
  const ids = h.board().cards.map((c) => c.id);
  check("cut-in-editor-keeps-card", ids.includes(code) && h.sent.filter((m) => m.type === "copyCards").length === 1, { ids, copies: h.sent.filter((m) => m.type === "copyCards").length });
  await close(h);
});

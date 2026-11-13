// Moving whole blocks of the Note being edited with ⌘ (Ctrl) held: ⌘-drag within the Note and into another Note, the blocks a
// selection spans moving together under one outline, ⌘-click picking blocks up beside the Note and putting them back
import * as path from "node:path";
import { OUT, put, type Host } from "../harness";
import { DEFAULT_SETTINGS, emptyBoard, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle } from "../fixtures";

const card = (id: string) => `.card[data-id="${id}"]`;
const md = (h: Host, id: string) => (h.board().cards.find((c) => c.id === id) as NoteCard | undefined)?.md;
const N1 =
  "# Title\n\nPara one.\n\n- a\n- b\n\n```python\nx = 1\n```\n\nSee [the docs](https://example.com) here.\n\nPara two.";
const N2 = "Other one.\n\nOther two.";

async function board(): Promise<Host> {
  const b = emptyBoard("b1", "block moves");
  put(b, { id: "n1", kind: "note", md: N1, look: "note" } as NoteCard, 60, 80, 400);
  put(b, { id: "n2", kind: "note", md: N2, look: "note" } as NoteCard, 560, 80, 300);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1000, h: 560 });
  await idle(h);
  await h.page.locator(`${card("n1")} .nbody`).dblclick({ position: { x: 100, y: 12 } });
  await h.page.waitForSelector(`${card("n1")} .md-pm`);
  await idle(h);
  return h;
}
/** The editor's blocks, by their first words */
const edBlocks = (h: Host) =>
  h.page
    .locator(`${card("n1")} .md-pm > :not(.md-pad)`)
    .evaluateAll((es) => es.map((e) => (e.textContent ?? "").trim().slice(0, 9)).filter(Boolean));
const box = (h: Host, sel: string) =>
  h.page
    .locator(sel)
    .first()
    .boundingBox()
    .then((r) => r!);
const height = (h: Host, id: string) => h.page.locator(card(id)).evaluate((e) => (e as HTMLElement).offsetHeight);
const shot = (h: Host, name: string) => h.page.screenshot({ path: path.join(OUT, `note-block-move-${name}.png`) });

/** ⌘-drag from a point to another: the drag is held there (call the returned function to release) */
async function cmdDrag(h: Host, from: { x: number; y: number }, to: { x: number; y: number }) {
  const m = h.page.mouse;
  await h.page.keyboard.down("ControlOrMeta");
  await m.move(from.x, from.y);
  await m.down();
  await m.move(from.x + 8, from.y + 10, { steps: 2 });
  await m.move(to.x, to.y, { steps: 8 });
  return async () => {
    await m.up();
    await h.page.keyboard.up("ControlOrMeta");
    await idle(h);
  };
}
async function cmdClick(h: Host, at: { x: number; y: number }) {
  await h.page.keyboard.down("ControlOrMeta");
  await h.page.mouse.click(at.x, at.y);
  await h.page.keyboard.up("ControlOrMeta");
  await idle(h);
}

/** ⌘-drag a paragraph below the code block of the same Note: nothing reflows during the drag (a drop line shows where), on
 *  release the editor has it there and keeps editing; ⌘Z in the editor puts it back */
test("noteBlockMoveWithin", async () => {
  const h = await board();
  const p = await box(h, `${card("n1")} .md-pm > p`),
    pre = await box(h, `${card("n1")} .md-pm > pre`);
  const h0 = await height(h, "n1");
  const release = await cmdDrag(h, { x: p.x + 20, y: p.y + 6 }, { x: pre.x + 40, y: pre.y + pre.height - 4 });
  await shot(h, "within-drag");
  const during = {
    height: await height(h, "n1"),
    line: await h.page.locator(".bmv-line.is-on").count(),
    dim: await h.page.locator(`${card("n1")} .md-pm > .md-mv-dim`).count(),
    copy: await h.page.locator(".bmv-g").count(),
  };
  check(
    "noteBlockMoveWithin nothing reflows while dragging",
    during.height === h0 && during.line === 1 && during.dim === 1 && during.copy === 1 && md(h, "n1") === N1,
    { during, h0 },
  );
  await release();
  await until(h, "the copy settles", async () => (await h.page.locator(".bmv-g").count()) === 0);
  const after = await edBlocks(h);
  const editingOn = await h.page.locator(`${card("n1")} .md-pm`).count();
  check(
    "noteBlockMoveWithin lands below the code block, still editing",
    after.indexOf("Para one.") === after.findIndex((t) => t.startsWith("x = 1")) + 1 && editingOn === 1,
    { after, editingOn },
  );
  await h.page.keyboard.press("ControlOrMeta+z");
  await idle(h);
  const undone = await edBlocks(h);
  check("noteBlockMoveWithin ⌘Z in the editor puts it back", undone[1] === "Para one.", undone);
});

/** Two blocks the selection spans get one outline and move together into another Note: one undo step puts both Notes back */
test("noteBlockMoveAcross", async () => {
  const h = await board();
  const p = await box(h, `${card("n1")} .md-pm > p`),
    ul = await box(h, `${card("n1")} .md-pm > ul`);
  await h.page.mouse.click(p.x + 2, p.y + 6);
  await h.page.keyboard.press("Home");
  await h.page.keyboard.press("Shift+ArrowDown");
  await h.page.keyboard.press("Shift+ArrowDown");
  await until(h, "the formatting bubble", async () => (await h.page.locator(".md-bubble:visible").count()) === 1);
  await h.page.keyboard.down("ControlOrMeta");
  await h.page.mouse.move(p.x + 30, p.y + 6);
  await h.page.mouse.move(p.x + 32, p.y + 7);
  await until(h, "the outline", async () => (await h.page.locator(".bmv-box.is-on").count()) === 1);
  const outline = await box(h, ".bmv-box.is-on");
  await shot(h, "across-outline");
  check(
    "noteBlockMoveAcross one outline round both blocks",
    Math.abs(outline.y - p.y) < 1 && Math.abs(outline.y + outline.height - (ul.y + ul.height)) < 1,
    { outline, p, ul },
  );
  const o2 = await box(h, `${card("n2")} .nbody > p:nth-child(2)`);
  const release = await cmdDrag(h, { x: p.x + 30, y: p.y + 6 }, { x: o2.x + 40, y: o2.y + 3 });
  await idle(h);
  await shot(h, "across-drag");
  const thumb = await box(h, ".bmv-g");
  check(
    "noteBlockMoveAcross the formatting bubble stands aside while blocks move",
    (await h.page.locator(".md-bubble:visible").count()) === 0,
    await h.page.locator(".md-bubble").count(),
  );
  check(
    "noteBlockMoveAcross over a Note the copy is a small thumbnail at the pointer's lower right",
    thumb.x > o2.x + 40 && thumb.y > o2.y + 3 && thumb.width <= 133 && thumb.height <= 133,
    thumb,
  );
  await release();
  await until(h, "both Notes written", () => md(h, "n2") !== N2);
  await shot(h, "across-after");
  check(
    "noteBlockMoveAcross the blocks move to the other Note",
    md(h, "n2") === "Other one.\n\nPara one.\n\n- a\n- b\n\nOther two." && !md(h, "n1")!.includes("Para one."),
    { n1: md(h, "n1"), n2: md(h, "n2") },
  );
  await until(h, "the copy settles", async () => (await h.page.locator(".bmv-g").count()) === 0);
  await h.page.keyboard.press("ControlOrMeta+z");
  await until(h, "undone", () => md(h, "n2") === N2);
  check("noteBlockMoveAcross one undo puts both Notes back", md(h, "n1") === N1 && md(h, "n2") === N2, {
    n1: md(h, "n1"),
    n2: md(h, "n2"),
  });
});

/** ⌘-click picks a block up: it floats 24 px right of its Note, which closes up. ⌘Z, Esc and ⌘-click on it each put it back
 *  without an undo step (what was typed stays); dragged into another Note it moves there */
test("noteBlockPickUp", async () => {
  const h = await board();
  await h.page.keyboard.press("ControlOrMeta+End");
  await h.page.keyboard.type(" X");
  const typed = await edBlocks(h);
  const r1 = await box(h, card("n1"));
  const pick = async () => {
    const pre = await box(h, `${card("n1")} .md-pm > pre`);
    await cmdClick(h, { x: pre.x + 40, y: pre.y + 12 });
    return until(h, "it floats", async () => (await h.page.locator(".bmv-g.is-float").count()) === 1);
  };
  const h0 = await height(h, "n1");
  await pick();
  await until(h, "the Note closes up", async () => (await height(h, "n1")) < h0 - 20);
  await shot(h, "picked");
  const g = await box(h, ".bmv-g.is-float");
  check("noteBlockPickUp floats 24 px right of the Note", Math.abs(g.x - (r1.x + r1.width + 24)) < 2, { g, r1 });
  for (const [how, put] of [
    ["⌘Z", () => h.page.keyboard.press("ControlOrMeta+z")],
    ["Esc", () => h.page.keyboard.press("Escape")],
    ["⌘-click", async () => cmdClick(h, { x: g.x + 20, y: g.y + 10 })],
  ] as const) {
    await put();
    await until(h, `${how} puts it back`, async () => (await h.page.locator(".bmv-g").count()) === 0);
    const now = await edBlocks(h);
    check(`noteBlockPickUp ${how} puts it back, nothing undone`, JSON.stringify(now) === JSON.stringify(typed), {
      now,
      typed,
      editing: await h.page.locator(`${card("n1")} .md-pm`).count(),
    });
    if (how !== "⌘-click") await pick();
  }
  await pick();
  const fl = await box(h, ".bmv-g.is-float"),
    o1 = await box(h, `${card("n2")} .nbody > p:nth-child(2)`);
  await h.page.mouse.move(fl.x + 20, fl.y + 10);
  await h.page.mouse.down();
  await h.page.mouse.move(fl.x + 30, fl.y + 20, { steps: 2 });
  await h.page.mouse.move(o1.x + 30, o1.y + 3, { steps: 8 });
  await h.page.mouse.up();
  await until(h, "moved into the other Note", () => md(h, "n2")?.includes("x = 1"));
  check(
    "noteBlockPickUp dropped into the other Note",
    md(h, "n2") === "Other one.\n\n```python\nx = 1\n```\n\nOther two." && !md(h, "n1")!.includes("x = 1"),
    { n1: md(h, "n1"), n2: md(h, "n2") },
  );
});

/** ⌘ over a link outlines nothing and a ⌘-click on it picks nothing up, though the words beside it in the same paragraph do */
test("noteBlockMoveLink", async () => {
  const h = await board();
  const a = await box(h, `${card("n1")} .md-pm a[href]`);
  await h.page.keyboard.down("ControlOrMeta");
  await h.page.mouse.move(a.x - 12, a.y + 4);
  await h.page.mouse.move(a.x - 10, a.y + 5);
  await until(h, "the paragraph outlined", async () => (await h.page.locator(".bmv-box.is-on").count()) === 1);
  await h.page.mouse.move(a.x + 4, a.y + 4);
  await h.page.mouse.move(a.x + 6, a.y + 5);
  const outline = await h.page.locator(".bmv-box.is-on").count();
  await h.page.mouse.click(a.x + 6, a.y + 5);
  await h.page.keyboard.up("ControlOrMeta");
  await idle(h);
  check(
    "noteBlockMoveLink nothing outlined or picked up over a link",
    outline === 0 && (await h.page.locator(".bmv-g").count()) === 0,
    {
      outline,
    },
  );
});

/** A code block is a block like any other while ⌘ (Ctrl) is held, on its code text too: the hover outlines it, ⌘-click picks it
 *  up without adding a cursor, ⌘-drag from the text moves it into the other Note; a plain click there places one caret */
test("noteBlockModOnCodeText", async () => {
  const h = await board();
  /** The selection ranges of the code block's own editor (none: no code editor shown) */
  const ranges = () =>
    h.page.evaluate(() => {
      const c = document.querySelector('.card[data-id="n1"] .md-pm .cm-content') as unknown as {
        cmTile?: { view?: { state: { selection: { ranges: unknown[] } } } };
      } | null;
      return c?.cmTile?.view?.state.selection.ranges.length ?? 0;
    });
  const line = () => box(h, `${card("n1")} .md-pm .cm-editor .cm-line`);
  let c = await line();
  await h.page.mouse.click(c.x + 14, c.y + 5);
  await idle(h);
  check("noteBlockModOnCodeText a plain click places one caret", (await ranges()) === 1, await ranges());
  await h.page.keyboard.down("ControlOrMeta");
  await h.page.mouse.move(c.x + 20, c.y + 4);
  await h.page.mouse.move(c.x + 24, c.y + 5);
  await until(h, "the code block outlined", async () => (await h.page.locator(".bmv-box.is-on").count()) === 1);
  await h.page.mouse.click(c.x + 24, c.y + 5);
  await h.page.keyboard.up("ControlOrMeta");
  await until(h, "it floats", async () => (await h.page.locator(".bmv-g.is-float").count()) === 1);
  check("noteBlockModOnCodeText ⌘-click picks it up, no second cursor", (await ranges()) <= 1, await ranges());
  await h.page.keyboard.press("Escape");
  await until(h, "put back", async () => (await h.page.locator(".bmv-g").count()) === 0);
  check("noteBlockModOnCodeText put back with one caret at most", (await ranges()) <= 1, await ranges());
  c = await line();
  const o2 = await box(h, `${card("n2")} .nbody > p:nth-child(2)`);
  const release = await cmdDrag(h, { x: c.x + 24, y: c.y + 5 }, { x: o2.x + 40, y: o2.y + 3 });
  await release();
  await until(h, "moved into the other Note", () => md(h, "n2")?.includes("x = 1"));
  check(
    "noteBlockModOnCodeText ⌘-drag from the code text moves it",
    md(h, "n2") === "Other one.\n\n```python\nx = 1\n```\n\nOther two." && !md(h, "n1")!.includes("x = 1"),
    { n1: md(h, "n1"), n2: md(h, "n2") },
  );
});

/** Blocks moved out of a Note whose editor is open with nothing typed in it: the blocks left behind keep their source as
 *  written (a setext heading stays one), as a move out of a Note not being edited does */
test("noteBlockMoveKeepsSourceAsWritten", async () => {
  const n1 = "Title\n=====\n\nPara one.\n\nPara *two*.";
  const b = emptyBoard("b1", "block moves");
  put(b, { id: "n1", kind: "note", md: n1, look: "note" } as NoteCard, 60, 80, 400);
  put(b, { id: "n2", kind: "note", md: N2, look: "note" } as NoteCard, 560, 80, 300);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1000, h: 560 });
  await idle(h);
  await h.page
    .locator(`${card("n1")} .nbody p`)
    .last()
    .dblclick();
  await h.page.waitForSelector(`${card("n1")} .md-pm`);
  await idle(h);
  const p = await box(h, `${card("n1")} .md-pm > p:not(.md-pad) >> nth=0`),
    o2 = await box(h, `${card("n2")} .nbody > p:nth-child(2)`);
  const release = await cmdDrag(h, { x: p.x + 30, y: p.y + 6 }, { x: o2.x + 40, y: o2.y + 3 });
  await release();
  await until(h, "both Notes written", () => md(h, "n2") !== N2);
  check(
    "noteBlockMoveKeepsSourceAsWritten",
    md(h, "n1") === "Title\n=====\n\nPara *two*." && md(h, "n2") === "Other one.\n\nPara one.\n\nOther two.",
    { n1: md(h, "n1"), n2: md(h, "n2") },
  );
});

/** A floating copy fits beside its Note on screen at any zoom: zooming the board in shrinks it as it goes, not only when it is
 *  next grabbed */
test("noteBlockFloatRescalesOnZoom", async () => {
  const h = await board();
  await h.page.keyboard.press("ControlOrMeta+a");
  const p = await box(h, `${card("n1")} .md-pm > p:not(.md-pad) >> nth=0`);
  await cmdClick(h, { x: p.x + 20, y: p.y + 6 });
  await until(h, "it floats", async () => (await h.page.locator(".bmv-g.is-float").count()) === 1);
  const fit = 0.6 * 560;
  const tall = async () => (await box(h, ".bmv-g.is-float")).height;
  const before = await tall();
  await h.page.mouse.move(700, 450);
  await h.page.keyboard.down("Control");
  for (let i = 0; i < 12; i++) {
    await h.page.mouse.wheel(0, -120);
    await idle(h);
  }
  await h.page.keyboard.up("Control");
  await idle(h);
  const after = await tall(),
    k = await h.page.locator(".bmv-g.is-float").evaluate((e) => Number((e as HTMLElement).style.scale || 1));
  check("noteBlockFloatRescalesOnZoom fits on screen", k < 1 && after <= fit + 2, { before, after, k, fit });
});

/** A picked-up block floating beside its Note goes with its board: switching to another board leaves nothing of it there (the
 *  copy, the card's bottom edge strip, a height held on the card) */
test("noteBlockFloatBoardSwitch", async () => {
  const h = await board();
  const pre = await box(h, `${card("n1")} .md-pm > pre`);
  await cmdClick(h, { x: pre.x + 40, y: pre.y + 12 });
  await until(h, "it floats", async () => (await h.page.locator(".bmv-g.is-float").count()) === 1);
  const other = emptyBoard("b2", "other");
  put(other, { id: "n1", kind: "note", md: N2, look: "note" } as NoteCard, 60, 80, 400);
  await h.post({
    type: "init",
    board: other,
    boards: [{ id: "b2", name: "other", cards: 1 }],
    views: {},
    stale: {},
    host: { assetBase: "", target: true, settings: DEFAULT_SETTINGS },
  } as never);
  await h.page.locator(`${card("n1")} .nbody`, { hasText: "Other one." }).waitFor();
  await idle(h);
  const left = await h.page.evaluate(() => ({
    copies: document.querySelectorAll(".bmv-g").length,
    edges: document.querySelectorAll(".bmv-edge").length,
    height: (document.querySelector(".card[data-id='n1']") as HTMLElement).style.height,
    hidden: [...document.querySelectorAll("style")].some((s) => /display: none !important/.test(s.textContent ?? "")),
  }));
  check(
    "noteBlockFloatBoardSwitch nothing of the move is left on the new board",
    !left.copies && !left.edges && !left.height && !left.hidden,
    left,
  );
});

/** A picked-up block whose Note goes away (deleted in another window, an undo of its making): the copy goes with it */
test("noteBlockFloatNoteDeleted", async () => {
  const h = await board();
  const pre = await box(h, `${card("n1")} .md-pm > pre`);
  await cmdClick(h, { x: pre.x + 40, y: pre.y + 12 });
  await until(h, "it floats", async () => (await h.page.locator(".bmv-g.is-float").count()) === 1);
  await h.page.locator(`${card("n2")} .nbody`).click({ position: { x: 20, y: 8 } });
  await until(h, "the editor closed", async () => (await h.page.locator(`${card("n1")} .md.editing`).count()) === 0);
  await idle(h);
  await h.post({ type: "merged", patch: { cards: { del: ["n1"] }, place: { del: ["n1"] } } } as never);
  await until(h, "the Note is gone", async () => (await h.page.locator(card("n1")).count()) === 0);
  await idle(h);
  check("noteBlockFloatNoteDeleted the copy goes", (await h.page.locator(".bmv-g").count()) === 0);
});

/** A floating block whose Note changes while it floats (another window, a sync) is found again where it now is: dropped,
 *  the right block moves */
test("noteBlockFloatNoteChanged", async () => {
  const h = await board();
  const pre = await box(h, `${card("n1")} .md-pm > pre`);
  await cmdClick(h, { x: pre.x + 40, y: pre.y + 12 });
  await until(h, "it floats", async () => (await h.page.locator(".bmv-g.is-float").count()) === 1);
  // the editor closes (a click on the other Note): the block stays floating, found in the saved Markdown
  await h.page.locator(`${card("n2")} .nbody`).click({ position: { x: 20, y: 8 } });
  await until(h, "the editor closed", async () => (await h.page.locator(`${card("n1")} .md.editing`).count()) === 0);
  await idle(h);
  // the Note changes elsewhere: a paragraph added at its top
  const n1 = h.board().cards.find((c) => c.id === "n1") as NoteCard;
  await h.post({ type: "merged", patch: { cards: { set: [{ ...n1, md: `New first.\n\n${n1.md}` }] } } } as never);
  await until(h, "the change is shown", async () =>
    (await h.page.locator(`${card("n1")} .nbody`).innerText()).startsWith("New first."),
  );
  await idle(h);
  const shown = await h.page.locator(`${card("n1")} .nbody`).innerText();
  const fl = await box(h, ".bmv-g.is-float"),
    o1 = await box(h, `${card("n2")} .nbody > p:nth-child(2)`);
  await h.page.mouse.move(fl.x + 20, fl.y + 10);
  await h.page.mouse.down();
  await h.page.mouse.move(fl.x + 30, fl.y + 20, { steps: 2 });
  await h.page.mouse.move(o1.x + 30, o1.y + 3, { steps: 8 });
  await h.page.mouse.up();
  await until(h, "moved into the other Note", () => md(h, "n2") !== N2);
  const n1md = md(h, "n1")!;
  check(
    "noteBlockFloatNoteChanged the code block moved, the rest stayed",
    md(h, "n2") === "Other one.\n\n```python\nx = 1\n```\n\nOther two." &&
      !n1md.includes("x = 1") &&
      n1md.includes("- a\n- b") &&
      n1md.includes("See [the docs]") &&
      !shown.includes("x = 1"),
    { n1: n1md, n2: md(h, "n2"), shown },
  );
});

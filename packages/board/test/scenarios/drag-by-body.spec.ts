// Pressing on a card's body (Note text, code lines) and dragging (#15): a card that is not selected, or a multi-selection
// grabbed by any of its cards, moves like when grabbed by the header, with no text selected; the only selected card keeps
// native text selection in its body. A plain click still selects (a multi-selection becomes the clicked card), a double
// click on a Note still edits it. Grabbing an unselected card while others are selected selects and moves just that card.
// Usage: npm run harness -- dragUnselectedCardByBody dragMultiSelectionByBody singleSelectedBodySelectsText
import { emptyBoard, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { put, findSym, symCard, shot, type Host } from "../harness";
import { test, open, check, light, until, idle, frames } from "../fixtures";

const CODE = ["def f(x):", "    y = x + 1", "    return y"];

function board(): Board {
  const b = emptyBoard("b1", "drag by body");
  put(b, { id: "n0", kind: "note", md: "## Plan\n\nalpha brave charlie delta echo\n\nsecond **line** here", bg: true } as NoteCard, 80, 80, 360);
  b.cards.push({ id: "c1", kind: "code", segments: [{ id: "s1", src: { kind: "free" }, path: "", lang: "python", start: 1, end: CODE.length, text: CODE.slice(), version: { kind: "none" } }] } as unknown as CodeCard);
  b.place.c1 = { x: 560, y: 80, w: 420 };
  const s = findSym("Scheduler.schedule");
  const k = symCard(s.f, s.s);
  put(b, k, 80, 420, 520);
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const KID = (h: Host) => h.board().cards.find((c) => c.kind === "code" && c.id !== "c1")!.id;

type Pt = { x: number; y: number };
const placeOf = (h: Host, id: string): Pt => { const p = h.board().place[id]; return { x: p.x, y: p.y }; };
const textSel = (pg: Page) => pg.evaluate(() => window.getSelection()?.toString() ?? "");
const selected = (pg: Page) => pg.evaluate(() => [...document.querySelectorAll<HTMLElement>(".card.sel[data-id]")].map((e) => e.dataset.id!).sort());

/** The middle of the first place `word` shows up in root (it may be split over several text nodes, as in highlighted code) */
async function wordAt(pg: Page, root: string, word: string) {
  const r = await pg.evaluate(([root, word]) => {
    const w = document.createTreeWalker(document.querySelector(root)!, NodeFilter.SHOW_TEXT);
    const ts: Text[] = [];
    for (let t = w.nextNode(); t; t = w.nextNode()) ts.push(t as Text);
    const i = ts.map((t) => t.data).join("").indexOf(word);
    if (i < 0) return null;
    const rg = document.createRange();
    const at = (k: number) => {
      for (const t of ts) { if (k < t.data.length) { rg.setStart(t, k); rg.setEnd(t, k + 1); return rg.getBoundingClientRect(); } k -= t.data.length; }
      throw new Error("past the end");
    };
    const a = at(i), b = at(i + word.length - 1);
    return { x0: a.left + 1, x1: b.right - 1, y: (a.top + a.bottom) / 2 };
  }, [root, word] as const);
  if (!r) throw new Error(`"${word}" is not in ${root}`);
  return r;
}

/** Press at `from`, move by d in small steps (one per frame, as a hand does) and, before releasing, run mid() */
async function drag(pg: Page, from: Pt, d: Pt, mid?: () => Promise<unknown>) {
  await pg.mouse.move(from.x, from.y);
  await pg.mouse.down();
  for (let i = 1; i <= 8; i++) { await pg.mouse.move(from.x + (d.x * i) / 8, from.y + (d.y * i) / 8); await frames(pg); }
  await mid?.();
  await pg.mouse.up();
}

const moved = (a: Pt, b: Pt, d: Pt) => b.x - a.x === d.x && b.y - a.y === d.y;

/** Nothing selected: pressing on a Note's text or on a code line and dragging moves that card (and selects it), no text gets
 *  selected; a click without moving selects the card in place; a double click on the Note's text still edits it */
test("dragUnselectedCardByBody", async () => {
  const h = await open({ board: board(), light, w: 1200, h: 900, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);
  const d = { x: 43, y: 127 };

  const n0 = placeOf(h, "n0");
  const w = await wordAt(pg, '.card[data-id="n0"] .nbody', "brave");
  let midSel = "";
  await drag(pg, { x: w.x0, y: w.y }, d, async () => { midSel = await textSel(pg); });
  await until(h, "the Note's move is saved", () => placeOf(h, "n0").x !== n0.x).catch(() => {}); // not moved: the checks below say so
  await idle(h);
  check("unselectedNoteBodyDragMovesCard", moved(n0, placeOf(h, "n0"), d), { before: n0, after: placeOf(h, "n0"), d });
  check("unselectedNoteBodyDragSelectsNoText", midSel === "" && (await textSel(pg)) === "", { midSel, after: await textSel(pg) });
  check("unselectedNoteBodyDragSelectsCard", JSON.stringify(await selected(pg)) === JSON.stringify(["n0"]), await selected(pg));

  const kid = KID(h), k0 = placeOf(h, kid);
  const kw = await wordAt(pg, `.card[data-id="${kid}"] .src`, "self");
  await drag(pg, { x: kw.x0, y: kw.y }, d, async () => { midSel = await textSel(pg); });
  await until(h, "the code card's move is saved", () => placeOf(h, kid).x !== k0.x).catch(() => {}); // not moved: the checks below say so
  await idle(h);
  check("unselectedCodeBodyDragMovesCard", moved(k0, placeOf(h, kid), d), { before: k0, after: placeOf(h, kid), d });
  check("unselectedCodeBodyDragSelectsNoText", midSel === "" && (await textSel(pg)) === "", { midSel, after: await textSel(pg) });
  check("unselectedCodeBodyDragSelectsOnlyIt", JSON.stringify(await selected(pg)) === JSON.stringify([kid]), await selected(pg));

  // a click without moving: selected, not moved
  const c1 = placeOf(h, "c1");
  const cw = await wordAt(pg, '.card[data-id="c1"] .src', "return");
  await pg.mouse.click(cw.x0, cw.y);
  await until(h, "the clicked card is selected", async () => (await selected(pg)).join() === "c1");
  await idle(h);
  check("unselectedBodyClickSelectsInPlace", JSON.stringify(placeOf(h, "c1")) === JSON.stringify(c1), { before: c1, after: placeOf(h, "c1") });

  // a double click on an unselected Note's text edits it
  await pg.keyboard.press("Escape");
  await until(h, "nothing selected", async () => (await selected(pg)).length === 0);
  const nw = await wordAt(pg, '.card[data-id="n0"] .nbody', "charlie");
  await pg.mouse.dblclick(nw.x0, nw.y);
  const editing = await until(h, "the Note is being edited", async () => (await pg.locator('.card[data-id="n0"] .md-pm').count()) > 0).catch(() => false);
  check("unselectedNoteBodyDoubleClickEdits", editing);
  await h.close();
});

/** Two cards selected: pressing on the code lines of one of them and dragging moves both, no text selected (mid-drag too);
 *  then a click on the Note's text without moving leaves only the Note selected, in place */
test("dragMultiSelectionByBody", async () => {
  const h = await open({ board: board(), light, w: 1200, h: 900, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);
  const kid = KID(h);
  await pg.locator('.card[data-id="n0"] .chead').click();
  await pg.locator(`.card[data-id="${kid}"] .chead`).click({ modifiers: ["Shift"], position: { x: 30, y: 10 } });
  await until(h, "two cards selected", async () => (await selected(pg)).length === 2);
  await idle(h);
  const d = { x: 211, y: 37 };
  const n0 = placeOf(h, "n0"), k0 = placeOf(h, kid), c1 = placeOf(h, "c1");
  const kw = await wordAt(pg, `.card[data-id="${kid}"] .src`, "self");
  let midSel = "";
  await drag(pg, { x: kw.x0, y: kw.y }, d, async () => { midSel = await textSel(pg); await shot(h, "dragMultiSelectionByBody-mid", "now"); });
  await until(h, "the move is saved", () => placeOf(h, "n0").x !== n0.x).catch(() => {}); // not moved: the checks below say so
  await idle(h);
  check("multiBodyDragMovesAll", moved(n0, placeOf(h, "n0"), d) && moved(k0, placeOf(h, kid), d), { n0: [n0, placeOf(h, "n0")], k: [k0, placeOf(h, kid)], d });
  check("multiBodyDragLeavesOthers", JSON.stringify(placeOf(h, "c1")) === JSON.stringify(c1), placeOf(h, "c1"));
  check("multiBodyDragSelectsNoText", midSel === "" && (await textSel(pg)) === "", { midSel, after: await textSel(pg) });
  check("multiBodyDragKeepsSelection", (await selected(pg)).join() === ["n0", kid].sort().join(), await selected(pg));

  // the same grabbing the Note's text
  const n1 = placeOf(h, "n0"), k1 = placeOf(h, kid);
  const w = await wordAt(pg, '.card[data-id="n0"] .nbody', "brave");
  const d2 = { x: -61, y: 53 };
  await drag(pg, { x: w.x0, y: w.y }, d2, async () => { midSel = await textSel(pg); });
  await until(h, "the second move is saved", () => placeOf(h, "n0").x !== n1.x).catch(() => {}); // not moved: the checks below say so
  await idle(h);
  check("multiNoteBodyDragMovesAll", moved(n1, placeOf(h, "n0"), d2) && moved(k1, placeOf(h, kid), d2), { n0: [n1, placeOf(h, "n0")], k: [k1, placeOf(h, kid)], d2 });
  check("multiNoteBodyDragSelectsNoText", midSel === "" && (await textSel(pg)) === "", { midSel, after: await textSel(pg) });

  // a click without moving: only the clicked card stays selected, nothing moves
  const n2 = placeOf(h, "n0");
  const cw = await wordAt(pg, '.card[data-id="n0"] .nbody', "delta");
  await pg.mouse.click(cw.x0, cw.y);
  await until(h, "only the Note is selected", async () => (await selected(pg)).join() === "n0");
  await idle(h);
  check("multiBodyClickSelectsOne", JSON.stringify(placeOf(h, "n0")) === JSON.stringify(n2), { before: n2, after: placeOf(h, "n0") });

  // two selected, grabbing the text of a third, unselected card: that card is selected and moves alone
  await pg.locator(`.card[data-id="${kid}"] .chead`).click({ modifiers: ["Shift"], position: { x: 30, y: 10 } });
  await until(h, "two cards selected again", async () => (await selected(pg)).length === 2);
  await idle(h);
  const n3 = placeOf(h, "n0"), k3 = placeOf(h, kid), c3 = placeOf(h, "c1");
  const fw = await wordAt(pg, '.card[data-id="c1"] .src', "return");
  await drag(pg, { x: fw.x0, y: fw.y }, d2, async () => { midSel = await textSel(pg); });
  await until(h, "the third card's move is saved", () => placeOf(h, "c1").x !== c3.x).catch(() => {}); // not moved: the checks below say so
  await idle(h);
  check("otherBodyDragMovesOnlyIt", moved(c3, placeOf(h, "c1"), d2) && JSON.stringify([placeOf(h, "n0"), placeOf(h, kid)]) === JSON.stringify([n3, k3]), { c1: [c3, placeOf(h, "c1")], n0: placeOf(h, "n0"), k: placeOf(h, kid) });
  check("otherBodyDragSelectsIt", (await selected(pg)).join() === "c1" && midSel === "", { sel: await selected(pg), midSel });
  await h.close();
});

/** The only selected card: dragging over its text selects that text and the card stays where it is (Note and code) */
test("singleSelectedBodySelectsText", async () => {
  const h = await open({ board: board(), light, w: 1200, h: 900, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);
  for (const [id, root, word] of [["n0", ".nbody", "brave charlie"], ["c1", ".src", "x + 1"]] as const) {
    await pg.locator(`.card[data-id="${id}"] .chead`).first().click({ position: { x: 30, y: 10 } });
    await until(h, `${id} selected alone`, async () => (await selected(pg)).join() === id);
    await idle(h);
    const p0 = placeOf(h, id);
    const w = await wordAt(pg, `.card[data-id="${id}"] ${root}`, word);
    await pg.mouse.move(w.x0, w.y);
    await pg.mouse.down();
    await pg.mouse.move(w.x1, w.y, { steps: 6 });
    await pg.mouse.up();
    const got = await until(h, "the text is selected", async () => (await textSel(pg)) === word).catch(() => false);
    await idle(h);
    check(`singleSelectedBodySelectsText ${id}`, got, { sel: await textSel(pg) });
    check(`singleSelectedBodyDragKeepsPlace ${id}`, JSON.stringify(placeOf(h, id)) === JSON.stringify(p0), { before: p0, after: placeOf(h, id) });
  }
  await h.close();
});

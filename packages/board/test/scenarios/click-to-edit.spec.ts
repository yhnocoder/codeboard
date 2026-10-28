// A single click on the body of the only selected card edits it, with the caret where the click was (#30): a Note's text,
// a Text's text, a Free code card's lines. A click on an unselected card only selects it, a click on one card of a
// multi-selection only leaves that card selected, dragging over the selected Note's text still selects text (#15) and
// dragging a selected Text still moves it, none of them editing. A double click on an unselected Note still edits it.
// Usage: npm run harness -- clickSelectedCardEdits
import { emptyBoard, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { put, shot, type Host } from "../harness";
import { test, open, check, light, until, idle, hold, pmHasSelection, focusSettled } from "../fixtures";
import { DBL_CLICK } from "../../src/state/timing";

const CODE = ["def f(x):", "    y = x + 1", "    return y"];

function board(): Board {
  const b = emptyBoard("b1", "click to edit");
  put(b, { id: "n0", kind: "note", md: "alpha brave charlie delta echo", look: "note" } as NoteCard, 80, 80, 360);
  put(b, { id: "n1", kind: "note", md: "foxtrot golf hotel", look: "note" } as NoteCard, 80, 300, 360);
  put(b, { id: "t0", kind: "note", md: "india juliet kilo lima", look: "text" } as NoteCard, 560, 330, 360);
  b.cards.push({ id: "c1", kind: "code", segments: [{ id: "s1", src: { kind: "free" }, path: "", lang: "python", start: 1, end: CODE.length, text: CODE.slice(), version: { kind: "none" } }] } as unknown as CodeCard);
  b.place.c1 = { x: 560, y: 80, w: 420 };
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

type Pt = { x: number; y: number };
const placeOf = (h: Host, id: string): Pt => { const p = h.board().place[id]; return { x: p.x, y: p.y }; };
const selected = (pg: Page) => pg.evaluate(() => [...document.querySelectorAll<HTMLElement>(".card.sel[data-id]")].map((e) => e.dataset.id!).sort().join());
const textSel = (pg: Page) => pg.evaluate(() => window.getSelection()?.toString() ?? "");
const editors = (pg: Page) => pg.locator(".md-pm, .card .cm-editor").count();

/** Just inside the left edge of the first place `word` shows up in root (its text may be split over several text nodes) */
async function wordAt(pg: Page, root: string, word: string) {
  const r = await pg.evaluate(([root, word]) => {
    const w = document.createTreeWalker(document.querySelector(root)!, NodeFilter.SHOW_TEXT);
    const ts: Text[] = [];
    for (let t = w.nextNode(); t; t = w.nextNode()) ts.push(t as Text);
    let i = ts.map((t) => t.data).join("").indexOf(word);
    if (i < 0) return null;
    const rg = document.createRange();
    for (const t of ts) { if (i < t.data.length) { rg.setStart(t, i); rg.setEnd(t, i + 1); break; } i -= t.data.length; }
    const b = rg.getBoundingClientRect();
    return { x: b.left + 1, y: (b.top + b.bottom) / 2, w: b.width };
  }, [root, word] as const);
  if (!r) throw new Error(`"${word}" is not in ${root}`);
  return r;
}

/** Clicks far enough apart in time that two of them on the same spot are not a double click */
const apart = (h: Host) => hold(h, DBL_CLICK + 30, "the next click on the same card is a click of its own, not the second half of a double click");

async function typedNote(h: Host, id: string) {
  const pg = h.page;
  await pg.locator(`.card[data-id="${id}"] .md-pm:focus`).waitFor({ timeout: 5000 });
  await pmHasSelection(pg);
  await focusSettled(pg);
  await pg.keyboard.type("Z");
  const text = await pg.locator(`.card[data-id="${id}"] .md-pm`).innerText();
  await pg.keyboard.press("Escape");
  await until(h, "the editor closed", async () => (await editors(pg)) === 0);
  await idle(h);
  return text;
}

test("clickSelectedCardEdits", async () => {
  const h = await open({ board: board(), light, w: 1200, h: 900, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);

  // Note: a click on it unselected only selects it
  let w = await wordAt(pg, '.card[data-id="n0"] .nbody', "delta");
  await pg.mouse.click(w.x, w.y);
  await until(h, "n0 selected", async () => (await selected(pg)) === "n0");
  await apart(h);
  check("clickUnselectedNoteOnlySelects", (await editors(pg)) === 0, await editors(pg));

  // a click on the selected Note's text: editing, the caret before the clicked "d" of delta
  await pg.mouse.click(w.x, w.y);
  const noteEdits = await until(h, "the Note is being edited", async () => (await pg.locator('.card[data-id="n0"] .md-pm').count()) > 0).catch(() => false);
  check("clickSelectedNoteEdits", noteEdits);
  if (noteEdits) {
    await pg.locator('.card[data-id="n0"] .md-pm:focus').waitFor({ timeout: 5000 });
    await idle(h);
    await shot(h, "clickSelectedCardEdits-note");
    const got = await typedNote(h, "n0");
    check("clickSelectedNoteCaretAtClick", got.includes("charlie Zdelta"), got);
  }

  // two selected: a click on one's text leaves only that one selected, nothing edited
  await pg.locator('.card[data-id="n1"] .chead').click({ position: { x: 30, y: 10 } });
  await pg.locator('.card[data-id="n0"] .chead').click({ modifiers: ["Shift"], position: { x: 30, y: 10 } });
  await until(h, "two Notes selected", async () => (await selected(pg)) === "n0,n1");
  await idle(h);
  w = await wordAt(pg, '.card[data-id="n0"] .nbody', "brave");
  await pg.mouse.click(w.x, w.y);
  await until(h, "only n0 selected", async () => (await selected(pg)) === "n0");
  await apart(h);
  check("clickMultiSelectionSelectsOneNoEdit", (await editors(pg)) === 0, await editors(pg));

  // dragging over the selected Note's text selects that text (#15): no editor, the card stays
  const p0 = placeOf(h, "n0");
  const a = await wordAt(pg, '.card[data-id="n0"] .nbody', "alpha"), z = await wordAt(pg, '.card[data-id="n0"] .nbody', "brave");
  await pg.mouse.move(a.x, a.y);
  await pg.mouse.down();
  await pg.mouse.move(z.x + z.w * 4, z.y, { steps: 6 });
  await pg.mouse.up();
  await until(h, "text selected", async () => (await textSel(pg)).length > 0).catch(() => {}); // not selected: the check below says so
  await apart(h);
  check("dragSelectedNoteTextSelectsNoEdit", (await editors(pg)) === 0 && (await textSel(pg)).startsWith("alpha") && JSON.stringify(placeOf(h, "n0")) === JSON.stringify(p0),
    { editors: await editors(pg), sel: await textSel(pg), before: p0, after: placeOf(h, "n0") });

  // Free code card: a click selects, a second click edits with the caret where clicked
  w = await wordAt(pg, '.card[data-id="c1"] .src', "return");
  await pg.mouse.click(w.x, w.y);
  await until(h, "c1 selected", async () => (await selected(pg)) === "c1");
  await apart(h);
  check("clickUnselectedFreeCodeOnlySelects", (await editors(pg)) === 0, await editors(pg));
  await pg.mouse.click(w.x, w.y);
  const codeEdits = await pg.locator('.card[data-id="c1"] .cm-content:focus').waitFor({ timeout: 5000 }).then(() => true, () => false);
  check("clickSelectedFreeCodeEdits", codeEdits);
  if (codeEdits) {
    await pg.keyboard.type("Z");
    const line = await pg.locator('.card[data-id="c1"] .cm-line').nth(2).innerText();
    check("clickSelectedFreeCodeCaretAtClick", line.trim() === "Zreturn y", line);
    await pg.keyboard.press("Escape");
    await until(h, "the code editor closed", async () => (await editors(pg)) === 0);
    await idle(h);
  }

  // Text: a click selects, a drag on the selected Text moves it without editing, a click edits at the clicked word
  w = await wordAt(pg, '.card[data-id="t0"] .tx', "kilo");
  await pg.mouse.click(w.x, w.y);
  await until(h, "t0 selected", async () => (await selected(pg)) === "t0");
  await apart(h);
  check("clickUnselectedTextOnlySelects", (await editors(pg)) === 0, await editors(pg));
  const t0 = placeOf(h, "t0"), d = { x: 37, y: 41 };
  await pg.mouse.move(w.x, w.y);
  await pg.mouse.down();
  await pg.mouse.move(w.x + d.x, w.y + d.y, { steps: 8 });
  await pg.mouse.up();
  await until(h, "the Text's move is saved", () => placeOf(h, "t0").x !== t0.x).catch(() => {}); // not moved: the check below says so
  await apart(h);
  const t1 = placeOf(h, "t0");
  // it may snap a few pixels to the other cards' edges
  check("dragSelectedTextMovesNoEdit", Math.abs(t1.x - t0.x - d.x) <= 8 && Math.abs(t1.y - t0.y - d.y) <= 8 && (await editors(pg)) === 0, { before: t0, after: t1, editors: await editors(pg) });
  w = await wordAt(pg, '.card[data-id="t0"] .tx', "kilo");
  await pg.mouse.click(w.x, w.y);
  const textEdits = await until(h, "the Text is being edited", async () => (await pg.locator('.card[data-id="t0"] .md-pm').count()) > 0).catch(() => false);
  check("clickSelectedTextEdits", textEdits);
  if (textEdits) {
    const got = await typedNote(h, "t0");
    check("clickSelectedTextCaretAtClick", got.includes("juliet Zkilo"), got);
  }

  // a double click on an unselected Note still edits it
  await pg.keyboard.press("Escape");
  await until(h, "nothing selected", async () => (await selected(pg)) === "");
  w = await wordAt(pg, '.card[data-id="n1"] .nbody', "golf");
  await pg.mouse.dblclick(w.x, w.y);
  const dbl = await until(h, "n1 is being edited", async () => (await pg.locator('.card[data-id="n1"] .md-pm').count()) > 0).catch(() => false);
  check("doubleClickUnselectedNoteEdits", dbl);
  await h.close();
});

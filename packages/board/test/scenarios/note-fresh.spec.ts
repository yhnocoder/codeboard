import * as path from "node:path";
import { OUT, type Host } from "../harness";
import { emptyBoard } from "@codeboard/core";
import { test, open, check, light, until, idle, frames } from "../fixtures";

const notes = (h: Host) => h.page.locator(".card.note").count();
const editing = (h: Host) => h.page.locator(".card.note .md-pm").count();
const focused = (h: Host) => h.page.evaluate(() => !!document.activeElement?.closest(".card.note .md-pm"));
const box = (h: Host, sel: string) => h.page.evaluate((sel) => { const r = document.querySelector(sel)!.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, sel);
async function newNote(h: Host) {
  await h.page.locator('.bbar button[aria-label="Note"]').click();
  await h.page.locator(".card.note .md-pm:focus").waitFor();
  await idle(h); // the pop-in: box() reads where the card ends up
}
async function drag(h: Host, x: number, y: number, dx: number, dy: number, steps = 12) {
  await h.page.mouse.move(x, y);
  await h.page.mouse.down();
  for (let i = 1; i <= steps; i++) { await h.page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps); await frames(h.page); }
  await h.page.mouse.up();
  await idle(h);
}
async function shot(h: Host, name: string) {
  await idle(h);
  const r = await box(h, ".card.note").catch(() => ({ x: 400, y: 300, w: 300, h: 100, r: 700, b: 400 }));
  await h.page.screenshot({ path: path.join(OUT, `note-fresh-${name}.png`), clip: { x: Math.max(0, r.x - 260), y: Math.max(0, r.y - 160), width: r.w + 520, height: r.h + 320 } });
}

/** Dragging a new empty Note by its header moves it, keeps it and goes on editing it; typing then keeps it for good in one undo step */
test("emptyNewNoteSurvivesDrag", async () => {
  const h = await open({ board: emptyBoard("b1", "fresh"), light, w: 1200, h: 800 });
  const pg = h.page;
  await idle(h);

  await newNote(h);
  const a = await box(h, ".card.note .chead");
  await drag(h, a.x + 60, a.y + a.h / 2, -220, -140);
  const moved = await box(h, ".card.note .chead").catch(() => null);
  await shot(h, "15-drag-empty-note");
  check("emptyNewNoteSurvivesDrag kept after move", (await notes(h)) === 1 && !!moved && Math.abs(moved.x - (a.x - 220)) < 3 && Math.abs(moved.y - (a.y - 140)) < 3, { a, moved });
  check("emptyNewNoteSurvivesDrag still editing after move", (await editing(h)) === 1 && (await focused(h)), { editing: await editing(h), focused: await focused(h) });
  await pg.keyboard.type("kept");
  await pg.keyboard.press("Escape");
  await until(h, "the typed text is saved", () => h.board().cards.some((c) => c.kind === "note" && c.md.trim() === "kept"));
  const md = h.board().cards.map((c) => (c.kind === "note" ? c.md.trim() : c.kind));
  check("emptyNewNoteSurvivesDrag typed text saved", md.length === 1 && md[0] === "kept", { md });
  await pg.mouse.click(1100, 760);
  await pg.keyboard.press("Control+z");
  await until(h, "undo takes the note away", async () => (await notes(h)) === 0);
  check("emptyNewNoteSurvivesDrag one undo step", (await notes(h)) === 0, { notes: await notes(h) });

  await newNote(h);
  const g = await box(h, ".card.note .grip");
  await drag(h, g.x + g.w / 2, g.y + g.h / 2, 80, 60);
  check("emptyNewNoteSurvivesDrag kept after resize", (await notes(h)) === 1 && (await editing(h)) === 1, { notes: await notes(h), editing: await editing(h) });

  // editing ends while still empty (click on the board): the Note goes away, nothing to undo
  await pg.mouse.click(1100, 760);
  await until(h, "the empty note goes away", async () => (await notes(h)) === 0);
  await idle(h);
  const left = await notes(h);
  await pg.locator('.bbar button[aria-label="More"]').click();
  const undoOff = await pg.locator(".ctx button", { hasText: /^Undo/ }).isDisabled();
  await pg.keyboard.press("Escape");
  check("emptyNewNoteSurvivesDrag empty note discarded on click away", left === 0 && undoOff, { left, undoOff });

  // moved, then clicked away while still empty: discarded too
  await newNote(h);
  const c = await box(h, ".card.note .chead");
  await drag(h, c.x + 60, c.y + c.h / 2, 150, 90);
  await pg.mouse.click(60, 760);
  await until(h, "the moved empty note goes away", async () => (await notes(h)) === 0);
  check("emptyNewNoteSurvivesDrag moved empty note discarded on click away", (await notes(h)) === 0, { notes: await notes(h) });
});

/** Ending the first edit of a new Text (Esc): by the time the text shows on the board, the change has been posted to the host.
 *  VS Code drops what the webview posts after its tab starts closing, so a send left for a later frame can be lost (e2e closeStep) */
test("newTextReachesHostWhenShown", async () => {
  const h = await open({ board: emptyBoard("b1", "fresh"), light, w: 1200, h: 800 });
  const pg = h.page;
  await idle(h);
  // record what the page posts, in the page (synchronously, at postMessage time)
  await pg.evaluate(() => { const w = window as any, o = w.__host; w.__posted = []; w.__host = (s: string) => { w.__posted.push(s); return o(s); }; });
  const runs: { shown: boolean; posted: boolean }[] = [];
  for (let i = 0; i < 5; i++) {
    await pg.mouse.click(200 + i * 150, 300);
    await pg.keyboard.press("t");
    await pg.waitForFunction(() => !!document.activeElement?.closest(".card[data-id] .md-pm"), null, { timeout: 5000 });
    const word = `typed${i}`;
    await pg.keyboard.type(`${word} then closed`);
    // Esc and the check in one task of the page, as soon as the text shows: no frame and no other task in between
    // (closing the tab is another task, so what the page does in microtasks of this one still counts)
    runs.push(await pg.evaluate((word) => {
      const ed = document.activeElement as HTMLElement;
      ed.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      return new Promise<{ shown: boolean; posted: boolean }>((res) => {
        const look = () => {
          const shown = [...document.querySelectorAll(".card[data-id]")].some((e) => !e.querySelector(".md-pm") && e.textContent!.includes(word));
          if (!shown) return void queueMicrotask(look);
          res({ shown, posted: ((window as any).__posted as string[]).some((s) => s.includes(word)) });
        };
        queueMicrotask(look);
      });
    }, word));
    await idle(h);
  }
  check("newTextReachesHostWhenShown posted when shown", runs.every((r) => r.shown && r.posted), { runs });
});

/** New cards start wide enough to write in: Note 476, Text 544, Free code 816 board px (1.7 times the old 280 / 320 / 480); Box and
 *  Mark keep their size. Each is made at the pointer with its key or the toolbar menu, written in and closed with Esc */
test("newCardsDefaultWidths", async () => {
  const h = await open({ board: emptyBoard("b1", "widths"), light: true, w: 1800, h: 1000, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);
  const made = async (what: string, start: () => Promise<void>, text: string) => {
    const n = h.board().cards.length;
    await start();
    await pg.waitForFunction(() => !!document.activeElement?.closest(".card[data-id] .md-pm, .card[data-id] .cm-content"), null, { timeout: 5000 });
    await pg.keyboard.type(text);
    await pg.keyboard.press("Escape");
    await until(h, `the new ${what} reaches the host`, () => h.board().cards.length > n);
    await idle(h);
    const c = h.board().cards[h.board().cards.length - 1];
    return h.board().place[c.id].w;
  };
  const key = (x: number, y: number, k: string) => async () => { await pg.mouse.click(x, y); await idle(h); await pg.keyboard.press(k); };
  const menu = (tool: string, item: string) => async () => {
    await pg.locator(`.bbar button[aria-label="${tool}"]`).click();
    await pg.locator(".ctx button", { hasText: item }).click();
  };
  const w = {
    note: await made("Note", key(80, 120, "n"), "A new note, wide enough for a sentence or two"),
    text: await made("Text", key(80, 480, "t"), "A new text"),
    box: await made("Box", key(1500, 120, "r"), "Box"),
    mark: await made("Mark", key(1500, 300, "m"), "Mark"),
    code: await made("Free code", menu("Code", "New Code"), "def step(self):\n    return self.scheduler.schedule()"),
  };
  await pg.mouse.click(1700, 950); await idle(h);
  await pg.screenshot({ path: path.join(OUT, "new-card-widths.png") });
  check("newCardsDefaultWidths", w.note === 476 && w.text === 544 && w.code === 816 && w.box === 150 && w.mark === 180, w);
});

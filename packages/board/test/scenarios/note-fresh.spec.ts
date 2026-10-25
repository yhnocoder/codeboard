// A new, still empty Note: moving or resizing it keeps it (and its first edit); it still goes away when editing ends empty.
// Usage: npm run harness -- emptyNewNoteSurvivesDrag
// Screenshots: test-out/harness/note-fresh-*.png (HARNESS_LIGHT=1 for the light theme)
import * as path from "node:path";
import { OUT, type Host } from "../harness";
import { emptyBoard } from "@codeboard/core";
import { test, open, check, light } from "../fixtures";

const notes = (h: Host) => h.page.locator(".card.note").count();
const editing = (h: Host) => h.page.locator(".card.note .md-pm").count();
const focused = (h: Host) => h.page.evaluate(() => !!document.activeElement?.closest(".card.note .md-pm"));
const box = (h: Host, sel: string) => h.page.evaluate((sel) => { const r = document.querySelector(sel)!.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, sel);
async function newNote(h: Host) {
  await h.page.locator('.bbar button[aria-label="Note"]').click();
  await h.page.waitForSelector(".card.note .md-pm", { timeout: 5000 });
  await h.page.waitForTimeout(400);
}
async function drag(h: Host, x: number, y: number, dx: number, dy: number, steps = 12) {
  await h.page.mouse.move(x, y);
  await h.page.mouse.down();
  for (let i = 1; i <= steps; i++) { await h.page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps); await h.page.waitForTimeout(25); }
  await h.page.mouse.up();
  await h.page.waitForTimeout(400);
}
async function shot(h: Host, name: string) {
  await h.page.waitForTimeout(300);
  const r = await box(h, ".card.note").catch(() => ({ x: 400, y: 300, w: 300, h: 100, r: 700, b: 400 }));
  await h.page.screenshot({ path: path.join(OUT, `note-fresh-${name}.png`), clip: { x: Math.max(0, r.x - 260), y: Math.max(0, r.y - 160), width: r.w + 520, height: r.h + 320 } });
}

/** Dragging a new empty Note by its header moves it, keeps it and goes on editing it; typing then keeps it for good in one undo step */
test("emptyNewNoteSurvivesDrag", async () => {
  const h = await open({ board: emptyBoard("b1", "fresh"), light, w: 1200, h: 800 });
  const pg = h.page;
  await pg.waitForTimeout(800);

  // move by the header
  await newNote(h);
  const a = await box(h, ".card.note .chead");
  await drag(h, a.x + 60, a.y + a.h / 2, -220, -140);
  const moved = await box(h, ".card.note .chead").catch(() => null);
  await shot(h, "15-drag-empty-note");
  check("emptyNewNoteSurvivesDrag kept after move", (await notes(h)) === 1 && !!moved && Math.abs(moved.x - (a.x - 220)) < 3 && Math.abs(moved.y - (a.y - 140)) < 3, { a, moved });
  check("emptyNewNoteSurvivesDrag still editing after move", (await editing(h)) === 1 && (await focused(h)), { editing: await editing(h), focused: await focused(h) });
  await pg.keyboard.type("kept");
  await pg.keyboard.press("Escape");
  await pg.waitForTimeout(1300);
  const md = h.board().cards.map((c) => (c.kind === "note" ? c.md.trim() : c.kind));
  check("emptyNewNoteSurvivesDrag typed text saved", md.length === 1 && md[0] === "kept", { md });
  await pg.mouse.click(1100, 760);
  await pg.keyboard.press("Control+z");
  await pg.waitForTimeout(600);
  check("emptyNewNoteSurvivesDrag one undo step", (await notes(h)) === 0, { notes: await notes(h) });

  // resize by the corner: still there, still editing
  await newNote(h);
  const g = await box(h, ".card.note .grip");
  await drag(h, g.x + g.w / 2, g.y + g.h / 2, 80, 60);
  check("emptyNewNoteSurvivesDrag kept after resize", (await notes(h)) === 1 && (await editing(h)) === 1, { notes: await notes(h), editing: await editing(h) });

  // editing ends while still empty (click on the board): the Note goes away, nothing to undo
  await pg.mouse.click(1100, 760);
  await pg.waitForTimeout(900);
  const left = await notes(h);
  await pg.locator('.bbar button[aria-label="More"]').click(); await pg.waitForTimeout(200);
  const undoOff = await pg.locator(".ctx button", { hasText: /^Undo/ }).isDisabled();
  await pg.keyboard.press("Escape");
  check("emptyNewNoteSurvivesDrag empty note discarded on click away", left === 0 && undoOff, { left, undoOff });

  // moved, then clicked away while still empty: discarded too
  await newNote(h);
  const c = await box(h, ".card.note .chead");
  await drag(h, c.x + 60, c.y + c.h / 2, 150, 90);
  await pg.mouse.click(60, 760);
  await pg.waitForTimeout(900);
  check("emptyNewNoteSurvivesDrag moved empty note discarded on click away", (await notes(h)) === 0, { notes: await notes(h) });
});

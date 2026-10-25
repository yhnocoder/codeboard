// Note and Text card sizing: content stays inside a card made smaller, the AI ghost completion stays inside the card,
// Fit Content on Notes and Texts (animated, one undo step), and no ghost completion while a card is moved or resized.
// Usage: npm run harness -- noteResizeClipsContent noteGhostStaysInCard noteTextFitContent noGhostDuringCardGesture
// Screenshots: test-out/harness/note-sizing-*.png (HARNESS_LIGHT=1 for the light theme)
import * as path from "node:path";
import { OUT, type Host } from "../harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, light } from "../fixtures";

const LONG = [
  "## Scheduler notes",
  "",
  "Prefill first: `can_allocate(seq)` checks the free KV blocks, then the sequence moves from **waiting** to **running**.",
  "",
  "- decode steps append one token per sequence",
  "- preemption frees the blocks of the newest sequence",
  "- the block manager hashes full blocks for prefix caching",
  "",
  "Math still renders: $O(n^2)$ for attention, $O(n)$ per decode step.",
  "",
  "The last paragraph is here so the content is clearly taller than the card.",
].join("\n");

/** Notes n0…, each `w` wide; `h` (if given) is a fixed height */
function board(notes: { md: string; h?: number; bg?: boolean }[]): Board {
  const b = emptyBoard("b1", "note sizing");
  notes.forEach((n, i) => {
    b.cards.push({ id: `n${i}`, kind: "note", md: n.md, bg: n.bg ?? true } as NoteCard);
    b.place[`n${i}`] = { x: 60 + i * 460, y: 120, w: 400, ...(n.h ? { h: n.h } : {}) };
  });
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const card = (id: string) => `.card[data-id="${id}"]`;
const rect = (h: Host, sel: string) => h.page.evaluate((sel) => {
  const e = document.querySelector(sel);
  if (!e) throw new Error(`no ${sel}`);
  const r = e.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height };
}, sel);
const placeH = (h: Host, id: string) => h.board().place[id]?.h;
/** A screenshot of one card with a margin around it */
async function cardShot(h: Host, id: string, name: string, keepMouse = false) {
  if (!keepMouse) await h.page.mouse.move(2, 2); // no hover tooltip in the picture
  await h.page.waitForTimeout(keepMouse ? 50 : 500);
  const r = await rect(h, card(id));
  const m = 40, below = 160; // room below the card: shows anything that runs past its bottom edge
  await h.page.screenshot({ path: path.join(OUT, `note-sizing-${name}.png`), clip: { x: Math.max(0, r.left - m), y: Math.max(0, r.top - m), width: r.right - r.left + 2 * m, height: r.bottom - r.top + m + below } });
}
async function editNote(h: Host, id: string) {
  await h.page.locator(`${card(id)} .nbody`).dblclick();
  await h.page.waitForSelector(`${card(id)} .md-pm`, { timeout: 5000 });
}
/** Drags from (x, y) by (dx, dy) in small steps; `during` runs between the steps */
async function drag(h: Host, x: number, y: number, dx: number, dy: number, steps: number, during?: () => Promise<void>) {
  const pg = h.page;
  await pg.mouse.move(x, y);
  await pg.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await pg.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps);
    await pg.waitForTimeout(40);
    await during?.();
  }
  await pg.mouse.up();
}

/** A Note dragged smaller by its corner: the Markdown stays inside the card and scrolls in the body (like a Code card's body) */
test("noteResizeClipsContent", async () => {
  const h = await open({ board: board([{ md: LONG }]), light, w: 1000, h: 700 });
  const pg = h.page;
  await pg.waitForTimeout(1200);
  const g = await rect(h, `${card("n0")} .grip`);
  await drag(h, (g.left + g.right) / 2, (g.top + g.bottom) / 2, 0, -170, 8);
  await pg.waitForTimeout(300);
  const c = await rect(h, card("n0")), body = await rect(h, `${card("n0")} .nbody`);
  const scroll = await pg.locator(`${card("n0")} .nbody`).evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight }));
  await cardShot(h, "n0", "02-resize-overflow");
  check("noteResizeClipsContent fixed height", typeof placeH(h, "n0") === "number", { h: placeH(h, "n0") });
  check("noteResizeClipsContent body inside card", body.bottom <= c.bottom + 0.5, { body, card: c });
  check("noteResizeClipsContent body scrolls", scroll.sh > scroll.ch, scroll);
  // the wheel over the body scrolls the note, not the board
  await pg.mouse.move((body.left + body.right) / 2, (body.top + body.bottom) / 2);
  await pg.mouse.wheel(0, 200);
  await pg.waitForTimeout(400);
  const top = await pg.locator(`${card("n0")} .nbody`).evaluate((e) => e.scrollTop);
  check("noteResizeClipsContent wheel scrolls body", top > 0, { top });
});

/** The ghost completion at the end of a Note with a fixed height stays inside the card (scrolled into view) */
test("noteGhostStaysInCard", async () => {
  const GHOST = " and keeps going for a while, long enough to wrap over several lines of the note so that it would run past the bottom edge of the card";
  const h = await open({
    board: board([{ md: LONG, h: 260 }]), light, w: 1000, h: 700, host: { complete: true },
    on: (m, r) => { if (m.type !== "complete") return false; void r(m.req!, GHOST); return true; },
  });
  const pg = h.page;
  await pg.waitForTimeout(1200);
  await editNote(h, "n0");
  await pg.keyboard.press("Control+End");
  await pg.keyboard.type(" Then");
  // the caret scrolls into view inside the body, the board doesn't move
  const caret = await pg.evaluate(() => { const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  const body0 = await rect(h, `${card("n0")} .nbody`);
  check("noteGhostStaysInCard caret visible", caret.bottom <= body0.bottom + 0.5 && caret.top >= body0.top - 0.5, { caret, body: body0 });
  const shown = await pg.waitForSelector(`${card("n0")} .md-ghost`, { timeout: 4000 }).then(() => true).catch(() => false);
  await pg.waitForTimeout(300);
  const c = await rect(h, card("n0")), body = await rect(h, `${card("n0")} .nbody`);
  const gh = shown ? await rect(h, `${card("n0")} .md-ghost`) : null;
  await cardShot(h, "n0", "10-ghost-overflow");
  check("noteGhostStaysInCard shown", shown);
  check("noteGhostStaysInCard body inside card", body.bottom <= c.bottom + 0.5, { body, card: c });
  check("noteGhostStaysInCard ghost visible in body", !!gh && gh.bottom <= Math.min(body.bottom, c.bottom) + 0.5 && gh.top >= body.top - 0.5, { gh, body, card: c });
});

/** Fit Content is in the menu of a Note and of a Text; it grows the card to its content, animated, in one undo step */
test("noteTextFitContent", async () => {
  const h = await open({ board: board([{ md: LONG, h: 150 }, { md: "A Text card that was a Note with a fixed height.\n\nSecond paragraph.\n\nThird.", h: 40, bg: false }]), light, w: 1100, h: 700 });
  const pg = h.page;
  await pg.waitForTimeout(1200);
  await cardShot(h, "n0", "05-fit-content-before");
  await pg.locator(`${card("n1")} .tx`).click(); // selected: the outline shows the card's box
  await cardShot(h, "n1", "05-fit-content-text-before");
  await pg.keyboard.press("Escape");
  const items = async (sel: string) => {
    await pg.locator(sel).click({ button: "right" });
    await pg.waitForSelector(".ctx", { timeout: 3000 });
    return pg.locator(".ctx button").allTextContents();
  };
  const noteMenu = await items(`${card("n0")} .chead`);
  check("noteTextFitContent note menu", noteMenu.some((t) => t.includes("Fit Content")), { noteMenu });
  const h0 = (await rect(h, card("n0"))).h;
  if (!noteMenu.some((t) => t.includes("Fit Content"))) return;
  await pg.locator(".ctx button", { hasText: "Fit Content" }).click();
  // sample the height over the next frames: it has to pass through values between the start and the end
  const samples = await pg.evaluate((sel) => new Promise<number[]>((res) => {
    const el = document.querySelector(sel)!, out: number[] = [];
    const f = () => { out.push(el.getBoundingClientRect().height); if (out.length < 40) requestAnimationFrame(f); else res(out); };
    requestAnimationFrame(f);
  }), card("n0"));
  await pg.waitForTimeout(400);
  const h1 = (await rect(h, card("n0"))).h;
  const fits = await pg.locator(`${card("n0")} .nbody`).evaluate((e) => e.scrollHeight <= e.clientHeight + 1);
  const mid = samples.filter((v) => v > h0 + 2 && v < h1 - 2).length;
  check("noteTextFitContent note grows to content", h1 > h0 + 40 && fits && placeH(h, "n0") === undefined, { h0, h1, fits, h: placeH(h, "n0") });
  check("noteTextFitContent note animated", mid >= 3, { h0, h1, samples });
  await cardShot(h, "n0", "05-fit-content-after");
  await pg.keyboard.press("Control+z");
  await pg.waitForTimeout(400);
  check("noteTextFitContent one undo step", placeH(h, "n0") === 150, { h: placeH(h, "n0") });

  const textMenu = await items(`${card("n1")} .tx`);
  check("noteTextFitContent text menu", textMenu.some((t) => t.includes("Fit Content")), { textMenu });
  if (!textMenu.some((t) => t.includes("Fit Content"))) return;
  await pg.locator(".ctx button", { hasText: "Fit Content" }).click();
  await pg.waitForTimeout(700);
  const tc = await rect(h, card("n1")), tx = await rect(h, `${card("n1")} .tx`);
  await cardShot(h, "n1", "05-fit-content-text-after");
  check("noteTextFitContent text grows to content", placeH(h, "n1") === undefined && tx.bottom <= tc.bottom + 0.5, { h: placeH(h, "n1"), tc, tx });
});

/** Moving or resizing a card hides a ghost completion that is showing, and none appears until the gesture ends */
test("noGhostDuringCardGesture", async () => {
  let asked = 0;
  const h = await open({
    board: board([{ md: "First line of the note" }]), light, w: 1000, h: 700, host: { complete: true },
    on: (m, r) => { if (m.type !== "complete") return false; asked++; void r(m.req!, " completed by the model"); return true; },
  });
  const pg = h.page;
  await pg.waitForTimeout(1200);
  const ghosts = () => pg.locator(".md-ghost").count();
  await editNote(h, "n0");
  await pg.keyboard.press("Control+End");
  await pg.keyboard.type(" and");
  await pg.waitForSelector(".md-ghost", { timeout: 4000 }).catch(() => {});
  const before = await ghosts();
  // resize by the corner while the ghost shows: it goes away at once
  const g = await rect(h, `${card("n0")} .grip`);
  let seenResize = 0;
  await drag(h, (g.left + g.right) / 2, (g.top + g.bottom) / 2, 60, 80, 6, async () => { seenResize += await ghosts(); });
  // type, then start resizing before the completion is asked (700 ms) and keep going past it: none shows up
  await pg.keyboard.type(" more");
  const asked0 = asked;
  const g2 = await rect(h, `${card("n0")} .grip`);
  let seenLate = 0, step = 0;
  await drag(h, (g2.left + g2.right) / 2, (g2.top + g2.bottom) / 2, -40, -30, 30, async () => {
    seenLate += await ghosts();
    if (++step === 25) await cardShot(h, "n0", "09-ghost-during-resize", true); // past the 700 ms the completion waits for
  });
  const askedDuring = asked - asked0;
  // moving the card by its header: a ghost that shows goes away too
  await pg.keyboard.type(" x");
  await pg.waitForSelector(".md-ghost", { timeout: 4000 }).catch(() => {});
  const before2 = await ghosts();
  const head = await rect(h, `${card("n0")} .chead`);
  let seenMove = 0;
  await drag(h, head.left + 120, (head.top + head.bottom) / 2, 120, 60, 30, async () => { seenMove += await ghosts(); });
  check("noGhostDuringCardGesture shown before", before === 1 && before2 === 1, { before, before2 });
  check("noGhostDuringCardGesture hidden while resizing", seenResize === 0, { seenResize });
  check("noGhostDuringCardGesture not asked while resizing", seenLate === 0 && askedDuring === 0, { seenLate, askedDuring });
  check("noGhostDuringCardGesture hidden while moving", seenMove === 0, { seenMove });
});

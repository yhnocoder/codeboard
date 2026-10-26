// Note and Text card sizing: content stays inside a card made smaller, the AI ghost completion stays inside the card,
// Fit Content on Notes and Texts (animated, one undo step), no ghost completion while a card is moved or resized, a Note
// without a stored height following its content, and a height set by hand being kept.
// Usage: npm run harness -- noteResizeClipsContent noteGhostStaysInCard noteTextFitContent noGhostDuringCardGesture noteShrinksWithContent noteManualHeightSticks
// Screenshots: test-out/harness/note-sizing-*.png (HARNESS_LIGHT=1 for the light theme)
import * as path from "node:path";
import { OUT, type Host } from "../harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle, hold } from "../fixtures";

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
  await idle(h);
  const r = await rect(h, card(id));
  const m = 40, below = 160; // room below the card: shows anything that runs past its bottom edge
  await h.page.screenshot({ path: path.join(OUT, `note-sizing-${name}.png`), clip: { x: Math.max(0, r.left - m), y: Math.max(0, r.top - m), width: r.right - r.left + 2 * m, height: r.bottom - r.top + m + below } });
}
async function editNote(h: Host, id: string) {
  await h.page.locator(`${card(id)} .nbody`).dblclick();
  await h.page.waitForSelector(`${card(id)} .md-pm`, { timeout: 5000 });
}
/** A gesture that has to last: 30 steps this far apart outlast the 700 ms an AI completion waits after typing */
const SLOW_STEP = 40;
/** Drags from (x, y) by (dx, dy) in small steps; `during` runs between the steps; `slow`: SLOW_STEP between the steps */
async function drag(h: Host, x: number, y: number, dx: number, dy: number, steps: number, during?: () => Promise<void>, slow = false) {
  const pg = h.page;
  await pg.mouse.move(x, y);
  await pg.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await pg.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps);
    if (slow) await hold(h, SLOW_STEP, "the gesture goes on past the completion's delay");
    await during?.();
  }
  await pg.mouse.up();
}
const scrollTop = (h: Host, sel: string) => h.page.locator(sel).evaluate((e) => e.scrollTop);

/** A Note dragged smaller by its corner: the Markdown stays inside the card and scrolls in the body (like a Code card's body) */
test("noteResizeClipsContent", async () => {
  const h = await open({ board: board([{ md: LONG }]), light, w: 1000, h: 700 });
  const pg = h.page;
  await idle(h);
  const g = await rect(h, `${card("n0")} .grip`);
  await drag(h, (g.left + g.right) / 2, (g.top + g.bottom) / 2, 0, -170, 8);
  await idle(h);
  const c = await rect(h, card("n0")), body = await rect(h, `${card("n0")} .nbody`);
  const scroll = await pg.locator(`${card("n0")} .nbody`).evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight }));
  await cardShot(h, "n0", "02-resize-overflow");
  check("noteResizeClipsContent fixed height", typeof placeH(h, "n0") === "number", { h: placeH(h, "n0") });
  check("noteResizeClipsContent body inside card", body.bottom <= c.bottom + 0.5, { body, card: c });
  check("noteResizeClipsContent body scrolls", scroll.sh > scroll.ch, scroll);
  // the wheel over the body scrolls the note, not the board
  await pg.mouse.move((body.left + body.right) / 2, (body.top + body.bottom) / 2);
  await pg.mouse.wheel(0, 200);
  await until(h, "the wheel scrolls the note's body", async () => (await scrollTop(h, `${card("n0")} .nbody`)) > 0);
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
  await idle(h);
  await editNote(h, "n0");
  await pg.keyboard.press("Control+End");
  await pg.keyboard.type(" Then");
  // the caret scrolls into view inside the body, the board doesn't move
  const caret = await pg.evaluate(() => { const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  const body0 = await rect(h, `${card("n0")} .nbody`);
  check("noteGhostStaysInCard caret visible", caret.bottom <= body0.bottom + 0.5 && caret.top >= body0.top - 0.5, { caret, body: body0 });
  const shown = await pg.waitForSelector(`${card("n0")} .md-ghost`, { timeout: 4000 }).then(() => true);
  await idle(h);
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
  await idle(h);
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
  await idle(h);
  const h1 = (await rect(h, card("n0"))).h;
  const fits = await pg.locator(`${card("n0")} .nbody`).evaluate((e) => e.scrollHeight <= e.clientHeight + 1);
  const mid = samples.filter((v) => v > h0 + 2 && v < h1 - 2).length;
  check("noteTextFitContent note grows to content", h1 > h0 + 40 && fits && placeH(h, "n0") === undefined, { h0, h1, fits, h: placeH(h, "n0") });
  check("noteTextFitContent note animated", mid >= 3, { h0, h1, samples });
  await cardShot(h, "n0", "05-fit-content-after");
  await pg.keyboard.press("Control+z");
  await idle(h);
  check("noteTextFitContent one undo step", placeH(h, "n0") === 150, { h: placeH(h, "n0") });

  const textMenu = await items(`${card("n1")} .tx`);
  check("noteTextFitContent text menu", textMenu.some((t) => t.includes("Fit Content")), { textMenu });
  if (!textMenu.some((t) => t.includes("Fit Content"))) return;
  await pg.locator(".ctx button", { hasText: "Fit Content" }).click();
  await idle(h);
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
  await idle(h);
  const ghosts = () => pg.locator(".md-ghost").count();
  await editNote(h, "n0");
  await pg.keyboard.press("Control+End");
  await pg.keyboard.type(" and");
  await pg.waitForSelector(".md-ghost", { timeout: 4000 });
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
  }, true);
  const askedDuring = asked - asked0;
  // moving the card by its header: a ghost that shows goes away too
  await pg.keyboard.type(" x");
  await pg.waitForSelector(".md-ghost", { timeout: 4000 });
  const before2 = await ghosts();
  const head = await rect(h, `${card("n0")} .chead`);
  let seenMove = 0;
  await drag(h, head.left + 120, (head.top + head.bottom) / 2, 120, 60, 30, async () => { seenMove += await ghosts(); });
  check("noGhostDuringCardGesture shown before", before === 1 && before2 === 1, { before, before2 });
  check("noGhostDuringCardGesture hidden while resizing", seenResize === 0, { seenResize });
  check("noGhostDuringCardGesture not asked while resizing", seenLate === 0 && askedDuring === 0, { seenLate, askedDuring });
  check("noGhostDuringCardGesture hidden while moving", seenMove === 0, { seenMove });
});

/** A Note that follows its content (no height set by hand): deleting text makes the card follow the content down (no empty
 *  space left), writing more grows it again; undo brings the text back */
test("noteShrinksWithContent", async () => {
  const h = await open({ board: board([{ md: LONG }]), light, w: 1000, h: 700 });
  const pg = h.page;
  await idle(h);
  const gap = async () => { const c = await rect(h, card("n0")), b = await rect(h, `${card("n0")} .nbody`); return { card: c.h, gap: c.bottom - b.bottom }; };
  const full = await gap();
  await cardShot(h, "n0", "18-delete-shrinks-before");
  await editNote(h, "n0");
  await pg.keyboard.press("Control+a");
  await pg.keyboard.type("Short now.");
  await idle(h);
  const typing = await gap();
  await pg.keyboard.press("Escape");
  await idle(h);
  const done = await gap();
  await cardShot(h, "n0", "18-delete-shrinks-after");
  check("noteShrinksWithContent follows content down while typing", typing.card < full.card - 100 && typing.gap <= 2, { full, typing });
  check("noteShrinksWithContent no empty space after editing", done.card < full.card - 100 && done.gap <= 2 && placeH(h, "n0") === undefined, { full, done, h: placeH(h, "n0") });
  // more text: grows with it, nothing scrolls
  await editNote(h, "n0");
  await pg.keyboard.press("Control+End");
  for (let i = 0; i < 12; i++) await pg.keyboard.type(" More words to make it long again.");
  await idle(h);
  const grown = await gap();
  const scrolls = await pg.locator(`${card("n0")} .nbody`).evaluate((e) => e.scrollHeight > e.clientHeight + 1);
  await pg.keyboard.press("Escape");
  await idle(h);
  check("noteShrinksWithContent grows with more text", grown.card > done.card + 40 && grown.gap <= 2 && !scrolls, { done, grown, scrolls });
  // two undo steps: the long text is back, at its full height
  await pg.mouse.click(900, 650);
  await pg.keyboard.press("Control+z");
  await pg.keyboard.press("Control+z");
  await idle(h);
  const back = await gap();
  check("noteShrinksWithContent undo restores", Math.abs(back.card - full.card) < 1 && placeH(h, "n0") === undefined, { back, full, h: placeH(h, "n0") });
});

/** A Note whose body scrolls fades out at the edge that has more content (top, bottom or both); the fade is only a mask on
 *  the body, so moving cards, arrows, marquee, wheel and resize over it work as anywhere else */
test("noteScrollFades", async () => {
  const b = board([{ md: LONG, h: 170 }, { md: "Other card" }]);
  b.place.n1 = { x: 620, y: 460, w: 220 };
  const h = await open({ board: b, light, w: 1000, h: 700 });
  const pg = h.page;
  await idle(h);
  const body = `${card("n0")} .nbody`;
  const fades = () => pg.locator(body).evaluate((e) => { const s = getComputedStyle(e); return [parseFloat(s.getPropertyValue("--fade-t")), parseFloat(s.getPropertyValue("--fade-b"))]; });
  const scrollTo = (y: number | "end") => pg.locator(body).evaluate((e, y) => { e.scrollTop = y === "end" ? e.scrollHeight : y; }, y);
  const top = await fades();
  await cardShot(h, "n0", "21-fade-top");
  await scrollTo(60); await idle(h); // the fades follow the scroll event
  const mid = await fades();
  await cardShot(h, "n0", "21-fade-middle");
  await scrollTo("end"); await idle(h);
  const end = await fades();
  await cardShot(h, "n0", "21-fade-bottom");
  const other = await pg.locator(`${card("n1")} .nbody`).evaluate((e) => getComputedStyle(e).maskImage);
  check("noteScrollFades top: only the bottom fades", top[0] === 0 && top[1] > 15, { top });
  check("noteScrollFades middle: both edges fade", mid[0] > 15 && mid[1] > 15, { mid });
  check("noteScrollFades bottom: only the top fades", end[0] > 15 && end[1] === 0, { end });
  check("noteScrollFades no mask on an auto-height note", other === "none", { other });
  await scrollTo(60); await idle(h); // the fades follow the scroll event

  const r0 = await rect(h, card("n0"));
  const fx = r0.left + 200, fy = r0.bottom - 8; // inside the bottom fade
  // another card dragged onto the faded area (and back again with undo)
  const o = await rect(h, `${card("n1")} .chead`);
  const ox = o.left + 40, oy = (o.top + o.bottom) / 2;
  await drag(h, ox, oy, fx - ox, fy - oy, 14);
  await idle(h); // the drop is sent at once
  const moved = { ...h.board().place.n1 };
  check("noteScrollFades drag another card onto the fade", Math.abs(moved.x - (620 + fx - ox)) < 3 && Math.abs(moved.y - (460 + fy - oy)) < 3, { moved });
  await pg.keyboard.press("Control+z");
  await idle(h);
  // an arrow dragged from the other card onto the faded area links to this Note
  await pg.locator(card("n1")).hover();
  const port = await rect(h, `${card("n1")} .eport.t`);
  const px = (port.left + port.right) / 2, py = (port.top + port.bottom) / 2;
  await drag(h, px, py, fx - 80 - px, fy - py, 14);
  await idle(h);
  const links = h.board().links.map((l) => [(l.from as { card: string }).card, (l.to as { card: string }).card]);
  check("noteScrollFades arrow dropped on the fade", links.some(([a, z]) => a === "n1" && z === "n0"), { links });
  // wheel over the faded area scrolls the body once the Note is selected
  await pg.mouse.click(r0.left + 100, r0.top + 15);
  const st0 = await pg.locator(body).evaluate((e) => e.scrollTop);
  await pg.mouse.move(fx, fy);
  await pg.mouse.wheel(0, 60);
  await until(h, "the wheel scrolls the selected note's body", async () => (await scrollTop(h, body)) > st0);
  const st1 = await pg.locator(body).evaluate((e) => e.scrollTop);
  check("noteScrollFades wheel on the fade scrolls the body", st1 > st0, { st0, st1 });
  // resize by the corner (inside the fade)
  const g = await rect(h, `${card("n0")} .grip`);
  await drag(h, (g.left + g.right) / 2, (g.top + g.bottom) / 2, 0, -40, 8);
  await idle(h);
  check("noteScrollFades resize in the faded corner", Math.abs((h.board().place.n0.h ?? 0) - 130) < 3, { h: h.board().place.n0.h });
  // move the Note by its header
  const p0 = { ...h.board().place.n0 };
  const hd = await rect(h, `${card("n0")} .chead`);
  await drag(h, hd.left + 80, (hd.top + hd.bottom) / 2, 30, 30, 8);
  await idle(h);
  const p1 = h.board().place.n0;
  check("noteScrollFades header drag moves", p1.x === p0.x + 30 && p1.y === p0.y + 30, { p0, p1 });
  // marquee from the empty board across the faded area selects the Note
  await pg.mouse.click(950, 680);
  const r1 = await rect(h, card("n0"));
  await drag(h, r1.right + 30, r1.bottom + 30, -(r1.right - r1.left) / 2 - 30, -40, 10);
  const selected = await pg.locator(`${card("n0")}.sel`).count();
  check("noteScrollFades marquee across the fade selects", selected === 1, { selected });
});

/** A Note's height set by hand is kept: dragging the corner below the content makes it taller (empty space below the text),
 *  editing and leaving the editor keep it, deleting text doesn't shrink it; Fit Content returns it to following its content */
test("noteManualHeightSticks", async () => {
  const h = await open({ board: board([{ md: "Short note.\n\nTwo lines." }]), light, w: 1000, h: 700 });
  const pg = h.page;
  const md = () => (h.board().cards.find((c) => c.id === "n0") as NoteCard).md;
  /** the stored height changed from `was`, and the board has settled */
  const newH = async (what: string, was: number | undefined) => { await until(h, what, () => placeH(h, "n0") !== was); await idle(h); };
  await idle(h);
  const h0 = (await rect(h, card("n0"))).h;
  const g = await rect(h, `${card("n0")} .grip`);
  await drag(h, (g.left + g.right) / 2, (g.top + g.bottom) / 2, 0, 160, 10);
  await newH("the dragged height is saved", undefined);
  const taller = (await rect(h, card("n0"))).h;
  await cardShot(h, "n0", "24-manual-height-taller");
  check("noteManualHeightSticks drag taller", Math.abs(taller - (h0 + 160)) < 3 && Math.abs((placeH(h, "n0") ?? 0) - taller) < 3, { h0, taller, h: placeH(h, "n0") });
  // edit, add a line, leave the editor: still the height set by hand
  await editNote(h, "n0");
  await pg.keyboard.press("Control+End");
  await pg.keyboard.type(" Three.");
  await idle(h);
  const editing = (await rect(h, card("n0"))).h;
  await pg.keyboard.press("Escape");
  await pg.mouse.click(900, 650); // blur
  await until(h, "the edit is saved", () => md().includes("Three.")); await idle(h);
  const after = (await rect(h, card("n0"))).h;
  check("noteManualHeightSticks survives edit and blur", Math.abs(editing - taller) < 1 && Math.abs(after - taller) < 1 && Math.abs((placeH(h, "n0") ?? 0) - taller) < 3, { taller, editing, after, h: placeH(h, "n0") });
  // deleting text: the card keeps its height (only cards that follow their content shrink)
  await editNote(h, "n0");
  await pg.keyboard.press("Control+a");
  await pg.keyboard.type("x");
  await pg.keyboard.press("Escape");
  await until(h, "the emptied Note is saved", () => md() === "x"); await idle(h);
  const emptied = (await rect(h, card("n0"))).h;
  check("noteManualHeightSticks no shrink after deleting text", Math.abs(emptied - taller) < 1, { taller, emptied });
  // Fit Content: back to the content's height, following it again
  await pg.locator(`${card("n0")} .chead`).click({ button: "right" });
  const hand = placeH(h, "n0");
  await pg.locator(".ctx button", { hasText: "Fit Content" }).click();
  await newH("Fit Content is saved", hand);
  const fit = (await rect(h, card("n0"))).h;
  await cardShot(h, "n0", "24-manual-height-fit");
  check("noteManualHeightSticks fit content follows content again", placeH(h, "n0") === undefined && fit < taller - 100, { fit, taller, h: placeH(h, "n0") });
  // the bottom edge also sets the height (the width stays)
  const c0 = await rect(h, card("n0"));
  await pg.mouse.move(2, 2);
  await drag(h, c0.left + 120, c0.bottom, 30, 90, 8);
  await newH("the height set with the bottom edge is saved", undefined);
  const c1 = await rect(h, card("n0"));
  check("noteManualHeightSticks bottom edge", Math.abs(c1.h - (c0.h + 90)) < 3 && Math.abs((c1.right - c1.left) - (c0.right - c0.left)) < 1 && Math.abs((placeH(h, "n0") ?? 0) - c1.h) < 3, { c0, c1, h: placeH(h, "n0") });
});

// Code cards on the canvas: what the user can see is what selection, Delete, Fit and Reveal act on; keyboard and pointer details.
//  tabKeepsCanvasStill        — Tab walking focus to a button of a card past the edge does not scroll the canvas (Fit and box select stay right)
//  nudgeIsOneUndoStep         — a run of arrow-key nudges of the same selection is one undo step
//  farClicksNotDoubleClick    — two quick clicks far apart on empty canvas are not a double-click (no Text note)
// Usage: node packages/board/test/run-harness.mjs tabKeepsCanvasStill hiddenCardsNotSelectable …
import { emptyBoard, type Board, type CodeCard } from "@codeboard/core";
import { open, put, symCard, findSym, viewOf, type Host } from "./harness";

const wait = (h: Host, ms = 600) => h.page.waitForTimeout(ms);
const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; return s.start + s.text.findIndex((t) => re.test(t)); };
const run = async (name: string, f: (res: Record<string, unknown>) => Promise<boolean>) => {
  const res: Record<string, unknown> = {};
  let ok = false;
  try { ok = await f(res); } catch (e) { console.log("FAIL", name, (e as Error).message.split("\n")[0], JSON.stringify(res)); process.exit(1); }
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(res));
  if (!ok) process.exitCode = 1;
};
const close = (h: Host) => h.page.context().browser()!.close();
/** The last selection the board reported to the host (hidden cards are not in the DOM, so read it from there) */
const lastSel = (h: Host) => [...h.sent].reverse().find((m) => m.type === "selection") as { cards: string[] } | undefined;
const shownIds = (h: Host) => h.page.evaluate(() => [...document.querySelectorAll(".card[data-id]")].map((e) => (e as HTMLElement).dataset.id!));
const zoom = (h: Host) => h.page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".world")!).transform).a);
/** Click empty canvas (focus in the board, nothing selected) */
const clickCanvas = async (h: Host, x = 20, y = 860) => { await h.page.mouse.click(x, y); await wait(h, 300); };
const clickHead = async (h: Host, id: string) => {
  const r = await h.page.locator(`.card[data-id="${id}"] .chead .ctitle`).first().boundingBox();
  await h.page.mouse.click(r!.x + 10, r!.y + r!.height / 2); await wait(h, 300);
};

/** LLMEngine.step calling schedule and postprocess (Call arrows); collapsed = the two callees are hidden */
function callTree(collapsed: boolean) {
  const b = emptyBoard("bTree", "step");
  const step = nv("LLMEngine.step"), sch = nv("Scheduler.schedule"), post = nv("Scheduler.postprocess");
  put(b, step, 80, 80, 560); put(b, sch, 80, 520, 560); put(b, post, 700, 520, 560);
  for (const [to, re, name] of [[sch, /scheduler\.schedule\(/, "schedule"], [post, /scheduler\.postprocess\(/, "postprocess"]] as const)
    b.links.push({ id: `l-${name}`, from: { card: step.id, seg: step.segments[0].id, line: lineOf(step, re) }, to: { card: to.id }, call: { name, col: 0 } });
  if (collapsed) b.place[step.id].collapsed = true;
  return { b, step, sch, post };
}

export const CODE_CARDS: Record<string, () => Promise<void>> = {
  tabKeepsCanvasStill: () => run("tabKeepsCanvasStill", tabKeepsCanvasStill),
  nudgeIsOneUndoStep: () => run("nudgeIsOneUndoStep", nudgeIsOneUndoStep),
  farClicksNotDoubleClick: () => run("farClicksNotDoubleClick", farClicksNotDoubleClick),
};

async function tabKeepsCanvasStill(res: Record<string, unknown>) {
  // three cards in a row, the last one past the right edge of a narrow panel
  const b = emptyBoard("bTab", "tab");
  const cs = ["LLMEngine.step", "Scheduler.schedule", "Scheduler.postprocess"].map(nv);
  cs.forEach((c, i) => put(b, c, 40 + i * 600, 60, 560));
  const h = await open({ board: b, w: 900, h: 700 });
  await clickCanvas(h, 20, 680);
  const scrolled = () => h.page.evaluate(() => [document.getElementById("board")!, document.scrollingElement!].map((e) => e.scrollLeft + e.scrollTop).reduce((a, x) => a + x, 0));
  let worst = 0;
  for (let i = 0; i < 40; i++) {
    await h.page.keyboard.press("Tab"); await wait(h, 80); worst = Math.max(worst, await scrolled());
  }
  res.scrolled = worst;
  // box select around the first card (hit-testing in world coordinates must match what is drawn)
  await clickCanvas(h, 20, 680); await wait(h, 500);
  const r = (await h.page.locator(`.card[data-id="${cs[0].id}"]`).boundingBox())!;
  await h.page.mouse.move(r.x - 20, r.y - 20); await h.page.mouse.down();
  await h.page.mouse.move(r.x + r.width / 2, r.y + 40, { steps: 6 }); await h.page.mouse.up(); await wait(h, 300);
  res.boxed = lastSel(h)?.cards;
  await close(h);
  return worst === 0 && JSON.stringify(res.boxed) === JSON.stringify([cs[0].id]);
}

async function nudgeIsOneUndoStep(res: Record<string, unknown>) {
  const b = emptyBoard("bNudge", "nudge");
  const a = nv("LLMEngine.step"), c = nv("Scheduler.schedule");
  put(b, a, 80, 80, 560); put(b, c, 700, 80, 560);
  const h = await open({ board: b });
  // an earlier step: delete the second card
  await clickHead(h, c.id);
  await h.page.keyboard.press("Delete"); await wait(h, 300);
  await clickHead(h, a.id);
  for (let i = 0; i < 5; i++) await h.page.keyboard.press("ArrowRight");
  for (let i = 0; i < 3; i++) await h.page.keyboard.press("Shift+ArrowDown");
  await wait(h, 1000);
  res.moved = [h.board().place[a.id].x, h.board().place[a.id].y];
  await h.page.keyboard.press("Meta+z"); await wait(h, 1000);
  res.afterUndo = [h.board().place[a.id].x, h.board().place[a.id].y];
  await h.page.keyboard.press("Meta+z"); await wait(h, 1000);
  res.deletedBack = h.board().cards.some((k) => k.id === c.id);
  await close(h);
  return JSON.stringify(res.moved) === "[85,110]" && JSON.stringify(res.afterUndo) === "[80,80]" && !!res.deletedBack;
}

async function farClicksNotDoubleClick(res: Record<string, unknown>) {
  const b = emptyBoard("bDbl", "dbl");
  put(b, nv("LLMEngine.step"), 80, 80, 560);
  const h = await open({ board: b });
  const notes = () => h.page.locator(".card.text, .card.note").count();
  // click, then quickly start a selection box far away
  await h.page.mouse.click(900, 700);
  await h.page.mouse.move(200, 500); await h.page.mouse.down(); await h.page.mouse.move(400, 650, { steps: 4 }); await h.page.mouse.up();
  await wait(h, 400);
  res.far = await notes();
  // a real double-click still makes a Text note
  await h.page.keyboard.press("Escape");
  await h.page.mouse.dblclick(900, 400); await wait(h, 400);
  res.near = await notes();
  await close(h);
  return res.far === 0 && res.near === 1;
}

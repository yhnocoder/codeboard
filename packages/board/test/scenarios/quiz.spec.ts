// Walkthrough Quiz (Q while walking): the steps ahead lie face down with the arrows to them hidden; clicking the line that calls
// the next step turns it up, a wrong line shakes and the step no longer counts as found on the first try; → turns a card up too
import { emptyBoard, type CodeCard } from "@codeboard/core";
import { shot, symCard, findSym, put } from "../harness";
import { test, open, check, light, expect, idle } from "../fixtures";

const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; return s.start + s.text.findIndex((t) => re.test(t)); };

test("walkthroughQuizGuessesTheCallingLine", async () => {
  const b = emptyBoard("b1", "quiz");
  const step = card("LLMEngine.step"), sch = card("Scheduler.schedule"), alloc = card("BlockManager.allocate");
  put(b, step, 80, 80, 600); put(b, sch, 780, 60, 560); put(b, alloc, 1420, 60, 520);
  b.cards.push({ id: "note", kind: "note", md: "Why batches", look: "note" }); b.place.note = { x: 140, y: 620, w: 280 };
  const s0 = step.segments[0];
  b.links.push({ id: "P", from: { card: step.id, seg: s0.id, line: lineOf(step, /return outputs/) }, to: { card: "note" } });
  b.links.push({ id: "C1", from: { card: step.id, seg: s0.id, line: lineOf(step, /scheduler\.schedule\(/) }, to: { card: sch.id }, call: { name: "schedule", col: 0 } });
  b.links.push({ id: "C2", from: { card: sch.id, seg: sch.segments[0].id, line: lineOf(sch, /block_manager\.allocate\(/) }, to: { card: alloc.id }, call: { name: "allocate", col: 0 } });
  b.cam = { x: 0, y: 0, z: 0.6 };
  const h = await open({ board: b, light, w: 1500, h: 950 }), pg = h.page;
  const line = (id: string, re: RegExp) => pg.locator(`.card[data-id="${id}"] .src .l`, { hasText: re }).first();
  const score = pg.locator(".present .pquiz .qscore");
  await pg.locator(`.card[data-id="${step.id}"] .chead .ctitle`).click(); await pg.locator(`.card.sel[data-id="${step.id}"]`).waitFor();
  await pg.keyboard.press("p"); await expect(pg.locator(".present .cnt")).toHaveText("1 / 4");
  await pg.keyboard.press("q");
  await expect(pg.locator(".card.facedown")).toHaveCount(3);
  // every arrow leads to a face-down card: all hidden, and their calling lines are not marked as arrow sources
  const hid = await pg.locator(".quizhide .link").count(), origins = await pg.locator(`.card[data-id="${step.id}"] .rowbg.origin`).count();
  check("quiz-hides-arrows", hid === 3 && origins === 0, { hid, origins });
  check("quiz-asks", /Which line in LLMEngine\.step leads to step 2\?/.test((await pg.locator(".present .qask").textContent()) ?? ""));
  await idle(h); await shot(h, "quiz-1-facedown");
  await pg.keyboard.press("Shift+Digit1"); await idle(h); await shot(h, "quiz-1-all-facedown");
  await pg.keyboard.press("ArrowLeft"); await idle(h); // back on step 1
  // a wrong line: it shakes, the step is counted as asked
  await line(step.id, /def step/).click();
  await expect(pg.locator(`.card[data-id="${step.id}"] .rowbg.miss`)).toHaveCount(1);
  await expect(score).toHaveText("0 / 1");
  await expect(pg.locator(".present .cnt")).toHaveText("1 / 4");
  // the right line: the card turns up (flips) and the walk moves on; the miss keeps it from counting as found
  await line(step.id, /scheduler\.schedule\(/).click();
  await expect(pg.locator(".present .cnt")).toHaveText("2 / 4");
  check("quiz-flips", (await pg.locator(`.card.reveal[data-id="${sch.id}"]`).count()) === 1);
  await expect(pg.locator(".card.facedown")).toHaveCount(2);
  await expect(score).toHaveText("0 / 1");
  // right on the first try
  await idle(h);
  await line(sch.id, /block_manager\.allocate\(/).click();
  await expect(pg.locator(".present .cnt")).toHaveText("3 / 4");
  await expect(score).toHaveText("1 / 2");
  await idle(h); await shot(h, "quiz-2-found");
  // → turns the last card up without a guess: asked, not found
  await pg.keyboard.press("ArrowRight");
  await expect(pg.locator(".present .cnt")).toHaveText("4 / 4");
  await expect(score).toHaveText("1 / 3");
  await expect(pg.locator(".card.facedown")).toHaveCount(0);
  await expect(pg.locator(".toast")).toContainText("Quiz done · 1 of 3 steps found on the first try");
  // Q again ends the Quiz; the arrows are back
  await pg.keyboard.press("q");
  await expect(pg.locator(".quizhide .link")).toHaveCount(0);
  await expect(pg.locator(".present .pquiz")).toHaveCount(0);
  await pg.context().close();
});

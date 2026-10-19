// Boards and their storage: changes reach the host as they happen, copying connected cards between boards, empty questions,
// undo across sub-boards (history per board, Turn into Board), arrows into a deleted sub-board card, crumbs to a deleted board.
// Usage: npm run harness -- <scenario…>   (the test names below)
import { emptyBoard, type Board } from "@codeboard/core";
import { put, symCard, findSym, type Host } from "../harness";
import { subHost } from "../subhost";
import { test, open, verdict } from "../fixtures";

const wait = (h: Host, ms = 600) => h.page.waitForTimeout(ms);
const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };

test("changesreachhost", () => verdict("changes-reach-host-at-once", changesReachHost));

test("emptyquestion", () => verdict("empty-new-question-is-dropped", emptyQuestion));

test("undoafterpeek", () => verdict("undo-history-survives-a-visit-to-a-sub-board", undoAfterPeek));

test("undoturnintoboard", () => verdict("undoing-turn-into-board-removes-the-new-board", undoTurnIntoBoard));

test("expandlostcall", () => verdict("a-call-whose-sub-board-card-was-deleted-expands-again", expandLostCall));

test("deletedparentcrumb", () => verdict("a-deleted-parent-board-leaves-the-breadcrumbs", deletedParentCrumb));

/** Inside a sub-board, its parent board is deleted (from the sidebar): the breadcrumb to it goes, Esc doesn't try to go back there */
async function deletedParentCrumb(res: Record<string, unknown>) {
  const { P, C } = parentAndChild();
  const t = await subHost(P, [C]), h = t.h, page = h.page;
  await wait(h, 800);
  await enter(h, "fC");
  res.crumbsIn = await page.locator(".crumbs .crumb").allTextContents();
  await t.store.remove("bParent"); await wait(h, 600);
  res.crumbsAfter = await page.locator(".crumbs .crumb").count();
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.mouse.click(1000, 700); await page.keyboard.press("Escape"); await wait(h, 1000);
  res.stillOn = t.cur();
  res.errors = errors.length;
  await page.context().close();
  return JSON.stringify(res.crumbsIn) === '["Parent","Child"]' && res.crumbsAfter === 0 && res.stillOn === "bChild" && res.errors === 0;
}

/** The call's arrow goes into a sub-board card that was deleted there: clicking the call expands it again and the broken arrow goes */
async function expandLostCall(res: Record<string, unknown>) {
  const P: Board = emptyBoard("bParent", "Parent"), C: Board = emptyBoard("bChild", "Child");
  const step = nv("LLMEngine.step"), post = nv("Scheduler.postprocess");
  put(P, step, 60, 80, 600);
  put(C, post, 60, 80, 600);
  P.cards.push({ id: "fC", kind: "board", board: C.id }); P.place.fC = { x: 760, y: 80, w: 520, h: 360 };
  const s = step.segments[0], line = s.start + s.text.findIndex((x) => /schedule\(\)/.test(x));
  P.links.push({ id: "lGone", from: { card: step.id, seg: s.id, line }, to: { card: "fC", sub: "cDeletedThere" }, call: { name: "schedule", col: 0 } });
  const t = await subHost(P, [C]), h = t.h, page = h.page;
  await wait(h, 1500);
  res.lost = !!t.store.peek("bParent")!.links.find((l) => l.id === "lGone")?.lost?.to;
  await page.locator(`.card[data-id="${step.id}"] .src .call`, { hasText: /^schedule$/ }).first().click(); await wait(h, 1800);
  const b = t.store.peek("bParent")!;
  const calls = b.links.filter((l) => l.call?.name === "schedule");
  res.calls = calls.map((l) => ({ to: b.cards.find((c) => c.id === l.to.card)?.kind, lost: !!l.lost }));
  await page.context().close();
  return res.lost === true && JSON.stringify(res.calls) === '[{"to":"code","lost":false}]';
}

/** Undo of Turn into Board puts the cards back and the new board goes away; redo makes it again */
async function undoTurnIntoBoard(res: Record<string, unknown>) {
  const P: Board = emptyBoard("bParent", "Parent");
  const step = nv("LLMEngine.step"), post = nv("Scheduler.postprocess");
  put(P, step, 60, 80, 600); put(P, post, 760, 80, 600);
  const t = await subHost(P, []), h = t.h, page = h.page;
  await wait(h, 800);
  const boards = async () => (await t.store.list()).map((m) => m.id).filter((id) => id !== "bParent");
  await page.locator(`.card[data-id="${post.id}"] .chead`).click({ position: { x: 120, y: 10 } });
  await page.keyboard.press("Meta+Shift+b"); await wait(h, 400);
  await page.locator(".dialog input").fill("Post");
  await page.locator(".dialog button", { hasText: "Create Board" }).click(); await wait(h, 1800);
  const made = await boards();
  res.made = made.length;
  await page.mouse.click(1000, 700); await wait(h, 200);
  await page.keyboard.press("Meta+z"); await wait(h, 1600);
  res.afterUndo = { boards: (await boards()).length, cardBack: t.store.peek("bParent")!.cards.map((c) => c.kind).join(",") };
  await page.keyboard.press("Meta+Shift+z"); await wait(h, 1600);
  const frame = t.store.peek("bParent")!.cards.find((c) => c.kind === "board");
  res.afterRedo = { boards: await boards(), frameTo: frame?.kind === "board" ? frame.board : null, childCards: made[0] ? t.store.peek(made[0])?.cards.length : null };
  res.skel = await page.locator(`.card[data-id="${frame?.id}"] .skel [data-sub]`).count();
  await page.context().close();
  const a = res.afterUndo as { boards: number; cardBack: string }, r = res.afterRedo as { boards: string[]; frameTo: string | null; childCards: number | null };
  return res.made === 1 && a.boards === 0 && a.cardBack === "code,code" && r.boards.length === 1 && r.frameTo === made[0] && r.childCards === 1 && (res.skel as number) >= 1;
}

/** A parent board with a frame of a one-card child board */
function parentAndChild() {
  const P: Board = emptyBoard("bParent", "Parent"), C: Board = emptyBoard("bChild", "Child");
  const step = nv("LLMEngine.step");
  put(C, step, 60, 80, 600);
  P.cards.push({ id: "fC", kind: "board", board: C.id }); P.place.fC = { x: 60, y: 80, w: 520, h: 360 };
  return { P, C, step };
}
const enter = async (h: Host, frame: string) => { await h.page.locator(`.card[data-id="${frame}"] .sbhead`).dblclick({ position: { x: 200, y: 12 } }); await wait(h, 1600); };
const leave = async (h: Host) => { await h.page.locator(".crumbs .crumb", { hasText: "Parent" }).click(); await wait(h, 1600); };

/** Undo on a board still undoes its own last change after entering a sub-board and coming back */
async function undoAfterPeek(res: Record<string, unknown>) {
  const { P, C } = parentAndChild();
  const t = await subHost(P, [C]), h = t.h, page = h.page;
  await wait(h, 800);
  await page.mouse.click(1000, 600); await wait(h, 200);
  await page.keyboard.press("t"); await wait(h, 400);
  await page.keyboard.type("hello text"); await page.keyboard.press("Escape"); await wait(h, 300);
  await page.keyboard.press("Escape"); await wait(h, 800);
  const hasText = () => t.store.peek("bParent")!.cards.some((c) => c.kind === "note" && c.md === "hello text");
  res.typed = hasText();
  await enter(h, "fC");
  res.inChild = t.cur() === "bChild";
  await leave(h);
  res.back = t.cur() === "bParent";
  await page.mouse.click(1000, 600); await wait(h, 200);
  await page.keyboard.press("Meta+z"); await wait(h, 1400);
  res.undone = !hasText();
  await page.keyboard.press("Meta+Shift+z"); await wait(h, 1400);
  res.redone = hasText();
  await page.context().close();
  return res.typed === true && res.inChild === true && res.back === true && res.undone === true && res.redone === true;
}

/** Right-click a code line and pick a line-menu item (under Edit when it isn't on the first level) */
async function lineMenu(h: Host, card: string, line: number, label: string) {
  const page = h.page;
  const l = page.locator(`.card[data-id="${card}"] .gutter .no`, { hasText: new RegExp(`^${line}$`) }).first();
  await l.evaluate((el) => (el as HTMLElement).click()); await wait(h, 200);
  const b = (await l.boundingBox())!;
  await page.mouse.click(b.x + b.width + 260, b.y + b.height / 2, { button: "right" }); await wait(h, 300);
  if (!(await page.locator(".ctx button", { hasText: label }).count())) { await page.locator(".ctx button", { hasText: /^Edit/ }).hover(); await wait(h, 300); }
  await page.locator(".ctx button", { hasText: label }).first().click(); await wait(h, 700);
}

/** Ask a Question, then close it without writing anything: no question is left behind and nothing goes on the undo stack.
 *  A written question is one undo step (asking + text together) */
async function emptyQuestion(res: Record<string, unknown>) {
  const b: Board = emptyBoard("bEq", "Questions");
  const step = nv("LLMEngine.step");
  put(b, step, 60, 80, 600);
  const h = await open({ board: b }), page = h.page;
  const line = step.segments[0].start + 2;
  await lineMenu(h, step.id, line, "Ask a Question");
  res.editor = await page.locator(".pop.k-question .ProseMirror").count();
  await page.keyboard.press("Escape"); await wait(h, 300);
  await page.mouse.click(1000, 700); await wait(h, 1400);
  res.emptyLeft = h.board().stickers.length;
  res.emptyShown = await page.locator("[data-sticker]").count();
  await lineMenu(h, step.id, line, "Ask a Question");
  await page.keyboard.type("why?"); await page.keyboard.press("Escape"); await wait(h, 300);
  await page.mouse.click(1000, 700); await wait(h, 1400);
  res.written = h.board().stickers.map((s) => s.q?.md);
  await page.keyboard.press("Meta+z"); await wait(h, 1400);
  res.afterUndo = h.board().stickers.length;
  await page.keyboard.press("Meta+z"); await wait(h, 1400);
  res.afterSecondUndo = h.board().stickers.length;
  await page.context().close();
  return res.editor === 1 && res.emptyLeft === 0 && res.emptyShown === 0 && JSON.stringify(res.written) === '["why?"]' && res.afterUndo === 0 && res.afterSecondUndo === 0;
}

/** Each change goes to the host right away (the host writes it to disk and finishes the write when the panel closes), so closing the tab can't lose it; pagehide sends what is still waiting */
async function changesReachHost(res: Record<string, unknown>) {
  const b: Board = emptyBoard("bSave", "Save");
  const step = nv("LLMEngine.step");
  put(b, step, 60, 80, 600);
  const got: { t: number; patch: any }[] = [];
  const h = await open({ board: b, on: (m) => { if (m.type === "patch") got.push({ t: Date.now(), patch: m.patch }); return false; } });
  const page = h.page;
  await page.locator(`.card[data-id="${step.id}"] .chead`).click({ position: { x: 120, y: 10 } }); await wait(h, 900);
  got.length = 0;
  // Wrap Lines on the selected card
  let t0 = Date.now();
  await page.keyboard.press("Alt+z");
  for (let i = 0; i < 40 && !got.length; i++) await page.waitForTimeout(25);
  res.wrapMs = got.length ? got[0].t - t0 : null;
  res.wrapSent = !!got[0]?.patch.cards?.set?.some((c: any) => c.id === step.id);
  // A new Text card: typed text, Esc
  await page.mouse.click(900, 600); await wait(h, 300);
  got.length = 0;
  await page.keyboard.press("t"); await wait(h, 400);
  await page.keyboard.type("typed then closed");
  t0 = Date.now();
  await page.keyboard.press("Escape");
  const typed = () => got.find((g) => g.patch.cards?.set?.some((c: any) => c.kind === "note" && c.md === "typed then closed"));
  for (let i = 0; i < 40 && !typed(); i++) await page.waitForTimeout(25);
  res.textMs = typed() ? typed()!.t - t0 : null;
  // A settled camera (600 ms after panning) is sent 800 ms later; closing the panel (pagehide) in between sends it at once
  await page.mouse.move(700, 500); await wait(h, 300);
  got.length = 0;
  await page.mouse.wheel(0, 200); await page.waitForTimeout(750);
  res.camBefore = got.some((g) => g.patch.cam);
  t0 = Date.now();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  for (let i = 0; i < 20 && !got.some((g) => g.patch.cam); i++) await page.waitForTimeout(10);
  const cam = got.find((g) => g.patch.cam);
  res.pagehideMs = cam ? cam.t - t0 : null;
  await page.context().close();
  return res.wrapSent === true && (res.wrapMs as number) < 300 && res.textMs !== null && (res.textMs as number) < 300 && res.camBefore === false && res.pagehideMs !== null && (res.pagehideMs as number) < 150;
}

// Boards and their storage: changes reach the host as they happen, copying connected cards between boards, empty questions,
// undo across sub-boards (history per board, Turn into Board), arrows into a deleted sub-board card, crumbs to a deleted board.
// Usage: npm run harness -- <scenario…>   (the test names below)
import { emptyBoard, type Board } from "@codeboard/core";
import { put, symCard, findSym, type Host } from "../harness";
import { subHost } from "../subhost";
import { test, open, verdict, expect, until, idle, hold } from "../fixtures";
import { CAM_SETTLE, LIVE_DELAY } from "../../src/state/timing";

type Sub = Awaited<ReturnType<typeof subHost>>;
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
  await idle(h);
  await enter(t, "fC");
  res.crumbsIn = await page.locator(".crumbs .crumb:not(.back)").allTextContents();
  await t.store.remove("bParent");
  await expect(page.locator(".crumbs .crumb")).toHaveCount(0);
  res.crumbsAfter = await page.locator(".crumbs .crumb").count();
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  // Esc must not go back: a leaveBoard would be in flight (or handled) by the time the board is idle
  await page.mouse.click(1000, 700); await page.keyboard.press("Escape"); await idle(h);
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
  const gone = () => t.store.peek("bParent")!.links.find((l) => l.id === "lGone");
  // the first skeletons mark the arrow lost
  await until(h, "the arrow into the deleted card is marked lost", () => gone()?.lost?.to);
  res.lost = !!gone()?.lost?.to;
  await idle(h);
  await page.locator(`.card[data-id="${step.id}"] .src .call`, { hasText: /^schedule$/ }).first().click();
  await until(h, "the call expands into a new card", () => t.store.peek("bParent")!.cards.some((c) => c.kind === "code" && c.id !== step.id));
  await idle(h);
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
  await idle(h);
  const boards = async () => (await t.store.list()).map((m) => m.id).filter((id) => id !== "bParent");
  const frame = () => t.store.peek("bParent")!.cards.find((c) => c.kind === "board");
  await page.locator(`.card[data-id="${post.id}"] .chead`).click({ position: { x: 120, y: 10 } });
  await page.keyboard.press("Meta+Shift+b");
  await page.locator(".dialog input").fill("Post");
  await page.locator(".dialog button", { hasText: "Create Board" }).click();
  await until(h, "Turn into Board makes the board and its frame", async () => (await boards()).length && frame());
  await idle(h);
  const made = await boards();
  res.made = made.length;
  await page.mouse.click(1000, 700);
  await page.keyboard.press("Meta+z");
  await until(h, "undo removes the new board", async () => !(await boards()).length);
  await idle(h);
  res.afterUndo = { boards: (await boards()).length, cardBack: t.store.peek("bParent")!.cards.map((c) => c.kind).join(",") };
  await page.keyboard.press("Meta+Shift+z");
  await until(h, "redo makes the board again", async () => (await boards()).length && frame());
  await idle(h);
  const f = frame();
  res.afterRedo = { boards: await boards(), frameTo: f?.kind === "board" ? f.board : null, childCards: made[0] ? t.store.peek(made[0])?.cards.length : null };
  // the host pushes the frame's skeleton after the save (subhost.ts, debounced): not a board message idle() could see
  const skel = page.locator(`.card[data-id="${f?.id}"] .skel [data-sub]`);
  await until(h, "the frame shows its board's cards", () => skel.count());
  res.skel = await skel.count();
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
/** The panel switched boards: the host sent the next board's init and the board has shown it */
async function switched(t: Sub, n: number, what: string) {
  await until(t.h, what, () => t.inits.length > n);
  await idle(t.h);
}
const enter = async (t: Sub, frame: string) => {
  const n = t.inits.length;
  await t.h.page.locator(`.card[data-id="${frame}"] .sbhead`).dblclick({ position: { x: 200, y: 12 } });
  await switched(t, n, `entering ${frame} opens its board`);
};
const leave = async (t: Sub) => {
  const n = t.inits.length;
  await t.h.page.locator(".crumbs .crumb", { hasText: "Parent" }).click();
  await switched(t, n, "the crumb goes back to Parent");
};

/** Undo on a board still undoes its own last change after entering a sub-board and coming back */
async function undoAfterPeek(res: Record<string, unknown>) {
  const { P, C } = parentAndChild();
  const t = await subHost(P, [C]), h = t.h, page = h.page;
  await idle(h);
  await page.mouse.click(1000, 600);
  await page.keyboard.press("t");
  await page.locator(".md-pm:focus").waitFor();
  await page.keyboard.type("hello text"); await page.keyboard.press("Escape");
  await expect(page.locator(".md-pm:focus")).toHaveCount(0);
  await page.keyboard.press("Escape");
  const hasText = () => t.store.peek("bParent")!.cards.some((c) => c.kind === "note" && c.md === "hello text");
  await until(h, "the typed text is saved", hasText);
  await idle(h);
  res.typed = hasText();
  await enter(t, "fC");
  res.inChild = t.cur() === "bChild";
  await leave(t);
  res.back = t.cur() === "bParent";
  await page.mouse.click(1000, 600);
  await page.keyboard.press("Meta+z");
  await until(h, "undo removes the text", () => !hasText());
  res.undone = !hasText();
  await page.keyboard.press("Meta+Shift+z");
  await until(h, "redo brings the text back", hasText);
  res.redone = hasText();
  await page.context().close();
  return res.typed === true && res.inChild === true && res.back === true && res.undone === true && res.redone === true;
}

/** Right-click a code line and pick a line-menu item (under Edit when it isn't on the first level) */
async function lineMenu(h: Host, card: string, line: number, label: string) {
  const page = h.page;
  const l = page.locator(`.card[data-id="${card}"] .gutter .no`, { hasText: new RegExp(`^${line}$`) }).first();
  await l.evaluate((el) => (el as HTMLElement).click());
  await expect(page.locator(`.card[data-id="${card}"] .gutter .no.sel`, { hasText: new RegExp(`^${line}$`) })).toHaveCount(1);
  const b = (await l.boundingBox())!;
  await page.mouse.click(b.x + b.width + 260, b.y + b.height / 2, { button: "right" });
  await page.locator(".ctx button").first().waitFor();
  if (!(await page.locator(".ctx button", { hasText: label }).count())) await page.locator(".ctx button", { hasText: /^Edit/ }).hover();
  await page.locator(".ctx button", { hasText: label }).first().click();
}

/** Ask a Question, then close it without writing anything: no question is left behind and nothing goes on the undo stack.
 *  A written question is one undo step (asking + text together) */
async function emptyQuestion(res: Record<string, unknown>) {
  const b: Board = emptyBoard("bEq", "Questions");
  const step = nv("LLMEngine.step");
  put(b, step, 60, 80, 600);
  const h = await open({ board: b }), page = h.page;
  const line = step.segments[0].start + 2;
  const editor = page.locator(".pop.k-question .ProseMirror");
  await lineMenu(h, step.id, line, "Ask a Question");
  await editor.waitFor();
  res.editor = await editor.count();
  await page.keyboard.press("Escape"); await idle(h);
  // the empty question must not stay: closing it is the trigger, so the board is idle once whatever it does is sent
  await page.mouse.click(1000, 700); await idle(h);
  res.emptyLeft = h.board().stickers.length;
  res.emptyShown = await page.locator("[data-sticker]").count();
  await lineMenu(h, step.id, line, "Ask a Question");
  await page.locator(".pop.k-question .ProseMirror:focus").waitFor();
  await page.keyboard.type("why?"); await page.keyboard.press("Escape"); await idle(h);
  await page.mouse.click(1000, 700);
  await until(h, "the written question is saved", () => h.board().stickers.length);
  await idle(h);
  res.written = h.board().stickers.map((s) => s.q?.md);
  await page.keyboard.press("Meta+z");
  await until(h, "undo removes the question", () => !h.board().stickers.length);
  res.afterUndo = h.board().stickers.length;
  // nothing else is on the undo stack: a second undo changes nothing
  await page.keyboard.press("Meta+z"); await idle(h);
  res.afterSecondUndo = h.board().stickers.length;
  await page.context().close();
  return res.editor === 1 && res.emptyLeft === 0 && res.emptyShown === 0 && JSON.stringify(res.written) === '["why?"]' && res.afterUndo === 0 && res.afterSecondUndo === 0;
}

/** Each change goes to the host right away (the host writes it to disk and finishes the write when the panel closes), so closing the tab right after a change can't lose it; a settled camera waits for the live debounce */
async function changesReachHost(res: Record<string, unknown>) {
  const b: Board = emptyBoard("bSave", "Save");
  const step = nv("LLMEngine.step");
  put(b, step, 60, 80, 600);
  const got: { t: number; patch: any }[] = [];
  const h = await open({ board: b, on: (m) => { if (m.type === "patch") got.push({ t: Date.now(), patch: m.patch }); return false; } });
  const page = h.page;
  await page.locator(`.card[data-id="${step.id}"] .chead`).click({ position: { x: 120, y: 10 } }); await idle(h);
  got.length = 0;
  // Wrap Lines on the selected card
  let t0 = Date.now();
  await page.keyboard.press("Alt+z");
  await until(h, "Wrap Lines reaches the host", () => got.length, 1000);
  res.wrapMs = got.length ? got[0].t - t0 : null;
  res.wrapSent = !!got[0]?.patch.cards?.set?.some((c: any) => c.id === step.id);
  // A new Text card: typed text, Esc
  await page.mouse.click(900, 600); await idle(h);
  got.length = 0;
  await page.keyboard.press("t");
  await page.locator(".md-pm:focus").waitFor();
  await page.keyboard.type("typed then closed");
  t0 = Date.now();
  await page.keyboard.press("Escape");
  const typed = () => got.find((g) => g.patch.cards?.set?.some((c: any) => c.kind === "note" && c.md === "typed then closed"));
  await until(h, "the closed Text card reaches the host", typed, 1000);
  res.textMs = typed() ? typed()!.t - t0 : null;
  // A settled camera (CAM_SETTLE after panning) is not sent per frame: it goes out once, LIVE_DELAY after it settles
  await page.mouse.move(700, 500); await idle(h);
  got.length = 0;
  await page.mouse.wheel(0, 200);
  await hold(h, CAM_SETTLE + 150, "the camera has settled but LIVE_DELAY is not over: no camera patch yet");
  res.camBefore = got.some((g) => g.patch.cam);
  await until(h, "the settled camera is sent", () => got.some((g) => g.patch.cam), LIVE_DELAY + 1700);
  res.camSent = got.filter((g) => g.patch.cam).length;
  await hold(h, 300, "no second camera patch follows");
  res.camSends = got.filter((g) => g.patch.cam).length;
  await page.context().close();
  return res.wrapSent === true && (res.wrapMs as number) < 300 && res.textMs !== null && (res.textMs as number) < 300 && res.camBefore === false && res.camSent === 1 && res.camSends === 1;
}

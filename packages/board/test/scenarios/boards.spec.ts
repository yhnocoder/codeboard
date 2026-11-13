import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type Board } from "@codeboard/core";
import { put, symCard, findSym, shot, type Host } from "../harness";
import { subHost } from "../subhost";
import { test, open, verdict, expect, until, idle, hold, pauseClock, check, hostBoards, light } from "../fixtures";
import { CAM_SETTLE, LIVE_DELAY } from "../../src/state/timing";

type Sub = Awaited<ReturnType<typeof subHost>>;
const nv = (qual: string) => {
  const s = findSym(qual);
  return symCard(s.f, s.s);
};

test("changesreachhost", () => verdict("changes-reach-host", changesReachHost));

// how long they take, alone (tiers.json solo): a timing on a shared CPU says nothing
test("changesReachHostTime", () => verdict("changes-reach-host-within-300ms", changesReachHostTime));

test("emptyquestion", () => verdict("empty-new-question-is-dropped", emptyQuestion));

test("undoafterpeek", () => verdict("undo-history-survives-a-visit-to-a-sub-board", undoAfterPeek));

test("undoturnintoboard", () => verdict("undoing-turn-into-board-removes-the-new-board", undoTurnIntoBoard));

test("copyLinkPointsIntoBoardFile", copyLinkPointsIntoBoardFile);

test("deletedparentcrumb", () => verdict("a-deleted-parent-board-leaves-the-breadcrumbs", deletedParentCrumb));

/** Inside a sub-board, its parent board is deleted (from the sidebar): the breadcrumb to it goes, Esc doesn't try to go back there */
async function deletedParentCrumb(res: Record<string, unknown>) {
  const { P, C } = parentAndChild();
  const t = await subHost(P, [C]),
    h = t.h,
    page = h.page;
  await idle(h);
  await enter(t, "fC");
  res.crumbsIn = await page.locator(".crumbs .crumb:not(.back)").allTextContents();
  await t.store.remove("bParent");
  await expect(page.locator(".crumbs .crumb")).toHaveCount(0);
  res.crumbsAfter = await page.locator(".crumbs .crumb").count();
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  // Esc must not go back: a leaveBoard would be in flight (or handled) by the time the board is idle
  await page.mouse.click(1000, 700);
  await page.keyboard.press("Escape");
  await idle(h);
  res.stillOn = t.cur();
  res.errors = errors.length;
  await page.context().close();
  return (
    JSON.stringify(res.crumbsIn) === '["Parent","Child"]' &&
    res.crumbsAfter === 0 &&
    res.stillOn === "bChild" &&
    res.errors === 0
  );
}

/** Undo of Turn into Board puts the cards back and the new board goes away; redo makes it again */
async function undoTurnIntoBoard(res: Record<string, unknown>) {
  const P: Board = emptyBoard("bParent", "Parent");
  const step = nv("LLMEngine.step"),
    post = nv("Scheduler.postprocess");
  put(P, step, 60, 80, 600);
  put(P, post, 760, 80, 600);
  const t = await subHost(P, []),
    h = t.h,
    page = h.page;
  await idle(h);
  const boards = async () => (await t.store.list()).map((m) => m.id).filter((id) => id !== "bParent");
  const frame = () => t.store.peek("bParent")!.cards.find((c) => c.kind === "board");
  await page.locator(`.card[data-id="${post.id}"] .chead`).click({ position: { x: 120, y: 10 } });
  await page.keyboard.press("ControlOrMeta+Shift+b");
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
  res.afterUndo = {
    boards: (await boards()).length,
    cardBack: t.store
      .peek("bParent")!
      .cards.map((c) => c.kind)
      .join(","),
  };
  await page.keyboard.press("Meta+Shift+z");
  await until(h, "redo makes the board again", async () => (await boards()).length && frame());
  await idle(h);
  const f = frame();
  res.afterRedo = {
    boards: await boards(),
    frameTo: f?.kind === "board" ? f.board : null,
    childCards: made[0] ? t.store.peek(made[0])?.cards.length : null,
  };
  // the host pushes the frame's skeleton after the save (subhost.ts, debounced): not a board message idle() could see
  const skel = page.locator(`.card[data-id="${f?.id}"] .skel [data-sub]`);
  await until(h, "the frame shows its board's cards", () => skel.count());
  res.skel = await skel.count();
  await page.context().close();
  const a = res.afterUndo as { boards: number; cardBack: string },
    r = res.afterRedo as { boards: string[]; frameTo: string | null; childCards: number | null };
  return (
    res.made === 1 &&
    a.boards === 0 &&
    a.cardBack === "code,code" &&
    r.boards.length === 1 &&
    r.frameTo === made[0] &&
    r.childCards === 1 &&
    (res.skel as number) >= 1
  );
}

/** A parent board with a frame of a one-card child board */
function parentAndChild() {
  const P: Board = emptyBoard("bParent", "Parent"),
    C: Board = emptyBoard("bChild", "Child");
  const step = nv("LLMEngine.step");
  put(C, step, 60, 80, 600);
  P.cards.push({ id: "fC", kind: "board", board: C.id });
  P.place.fC = { x: 60, y: 80, w: 520, h: 360 };
  return { P, C, step };
}
/** The panel switched boards: the host sent the next board's init and the board has shown it */
async function switched(t: Sub, n: number, what: string) {
  await until(t.h, what, () => t.inits.length > n);
  await idle(t.h);
}
const enter = async (t: Sub, frame: string) => {
  const n = t.inits.length;
  await t.h.page.locator(`.card[data-id="${frame}"] .sbname`).dblclick();
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
  const t = await subHost(P, [C]),
    h = t.h,
    page = h.page;
  await idle(h);
  await page.mouse.click(1000, 600);
  await page.keyboard.press("t");
  await page.locator(".md-pm:focus").waitFor();
  await page.keyboard.type("hello text");
  await page.keyboard.press("Escape");
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
  await expect(
    page.locator(`.card[data-id="${card}"] .gutter .no.sel`, { hasText: new RegExp(`^${line}$`) }),
  ).toHaveCount(1);
  const b = (await l.boundingBox())!;
  await page.mouse.click(b.x + b.width + 260, b.y + b.height / 2, { button: "right" });
  await page.locator(".ctx:not(.closing) button").first().waitFor();
  // the line menu has it; the card menu (the right-click missed the line) has it under Add ▸ without "Ask a"
  if (await page.locator(".ctx:not(.closing) button", { hasText: label }).count())
    await page.locator(".ctx:not(.closing) button", { hasText: label }).first().click();
  else {
    await page.locator('.ctx:not(.closing) button:has(.lb:text-is("Add"))').hover();
    await page.locator(`.ctx:not(.closing) button:has(.lb:text-is("${label.replace(/^Ask a /, "")}"))`).click();
  }
}

/** Ask a Question, then close it without writing anything: no question is left behind and nothing goes on the undo stack.
 *  A written question is one undo step (asking + text together) */
async function emptyQuestion(res: Record<string, unknown>) {
  const b: Board = emptyBoard("bEq", "Questions");
  const step = nv("LLMEngine.step");
  put(b, step, 60, 80, 600);
  const h = await open({ board: b }),
    page = h.page;
  const line = step.segments[0].start + 2;
  const editor = page.locator(".pop.k-question .ProseMirror");
  await lineMenu(h, step.id, line, "Ask a Question");
  await editor.waitFor();
  res.editor = await editor.count();
  await page.keyboard.press("Escape");
  await idle(h);
  // the empty question must not stay: closing it is the trigger, so the board is idle once whatever it does is sent
  await page.mouse.click(1000, 700);
  await idle(h);
  res.emptyLeft = h.board().stickers.length;
  res.emptyShown = await page.locator("[data-sticker]").count();
  await lineMenu(h, step.id, line, "Ask a Question");
  await page.locator(".pop.k-question .ProseMirror:focus").waitFor();
  await page.keyboard.type("why?");
  await page.keyboard.press("Escape");
  await idle(h);
  await page.mouse.click(1000, 700);
  await until(h, "the written question is saved", () => h.board().stickers.length);
  await idle(h);
  res.written = h.board().stickers.map((s) => s.q?.md);
  await page.keyboard.press("Meta+z");
  await until(h, "undo removes the question", () => !h.board().stickers.length);
  res.afterUndo = h.board().stickers.length;
  // nothing else is on the undo stack: a second undo changes nothing
  await page.keyboard.press("Meta+z");
  await idle(h);
  res.afterSecondUndo = h.board().stickers.length;
  await page.context().close();
  return (
    res.editor === 1 &&
    res.emptyLeft === 0 &&
    res.emptyShown === 0 &&
    JSON.stringify(res.written) === '["why?"]' &&
    res.afterUndo === 0 &&
    res.afterSecondUndo === 0
  );
}

// Each change goes to the host right away (the host writes it to disk and finishes the write when the panel closes), so closing the tab right after a change can't lose it; a settled camera waits for the live debounce
/** A board whose patches to the host are recorded with the time they arrived */
async function saveBoard() {
  const b: Board = emptyBoard("bSave", "Save");
  const step = nv("LLMEngine.step");
  put(b, step, 60, 80, 600);
  const got: { patch: any }[] = [];
  const h = await open({
    board: b,
    on: (m) => {
      if (m.type === "patch") got.push({ patch: m.patch });
      return false;
    },
  });
  await h.page.locator(`.card[data-id="${step.id}"] .chead`).click({ position: { x: 120, y: 10 } });
  await idle(h);
  got.length = 0;
  return { h, page: h.page, step, got };
}

/** Clicks the empty canvas under the card: nothing is selected after it */
async function clickBelow(page: Host["page"], card: string) {
  const b = (await page.locator(`.card[data-id="${card}"]`).boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height + 80);
}

/** Wrap Lines on the selected card, then a new Text card typed and closed with Esc: each reaches the host */
async function wrapAndText(
  { h, page, step, got }: Awaited<ReturnType<typeof saveBoard>>,
  res: Record<string, unknown>,
) {
  await page.keyboard.press("Alt+z");
  await until(h, "Wrap Lines reaches the host", () =>
    got.find((g) => g.patch.cards?.set?.some((c: any) => c.id === step.id && c.wrap === true)),
  );
  res.wrapSent = true;
  await clickBelow(page, step.id);
  await idle(h);
  got.length = 0;
  await page.keyboard.press("t");
  await page.locator(".md-pm:focus").waitFor();
  await page.keyboard.type("typed then closed");
  await page.keyboard.press("Escape");
  await until(h, "the closed Text card reaches the host", () =>
    got.find((g) => g.patch.cards?.set?.some((c: any) => c.kind === "note" && c.md === "typed then closed")),
  );
  res.textSent = true;
}

/** Wrap Lines, a closed Text card and a settled camera reach the host; the camera only once, LIVE_DELAY after it settled */
async function changesReachHost(res: Record<string, unknown>) {
  const s = await saveBoard(),
    { h, page, got } = s;
  await wrapAndText(s, res);
  // A settled camera (CAM_SETTLE after panning) is not sent per frame: it goes out once, LIVE_DELAY after it settles
  await page.mouse.move(700, 500);
  await idle(h);
  got.length = 0;
  await page.mouse.wheel(0, 200);
  await hold(h, CAM_SETTLE + 150, "the camera has settled but LIVE_DELAY is not over: no camera patch yet");
  res.camBefore = got.some((g) => g.patch.cam);
  await until(h, "the settled camera is sent", () => got.some((g) => g.patch.cam), LIVE_DELAY + 1700);
  res.camSent = got.filter((g) => g.patch.cam).length;
  await hold(h, 300, "no second camera patch follows");
  res.camSends = got.filter((g) => g.patch.cam).length;
  await page.context().close();
  return (
    res.wrapSent === true && res.textSent === true && res.camBefore === false && res.camSent === 1 && res.camSends === 1
  );
}

/**
 * Wrap Lines, then a Text card closed with Esc: each change leaves the board within 300 ms. Timed on the page's clock (Playwright's,
 * paused before the key and run 300 ms on), so it is the board's own delays that count, not how busy the machine is
 */
async function changesReachHostTime(res: Record<string, unknown>) {
  const { h, page, step, got } = await saveBoard();
  await page.clock.install();
  const within300 = async (key: string, what: string, sent: () => unknown) => {
    await pauseClock(page);
    await page.keyboard.press(key);
    await page.clock.runFor(300);
    // the clock stays paused: a change the board holds back longer never leaves it
    res[what] = await until(h, `${what} within 300 ms of page time`, sent).then(
      () => true,
      () => false,
    );
    await page.clock.resume();
  };
  await within300("Alt+z", "wrapSent", () =>
    got.find((g) => g.patch.cards?.set?.some((c: any) => c.id === step.id && c.wrap === true)),
  );
  await clickBelow(page, step.id);
  await idle(h);
  got.length = 0;
  await page.keyboard.press("t");
  await page.locator(".md-pm:focus").waitFor();
  await page.keyboard.type("typed then closed");
  await within300("Escape", "textSent", () =>
    got.find((g) => g.patch.cards?.set?.some((c: any) => c.kind === "note" && c.md === "typed then closed")),
  );
  await page.context().close();
  return res.wrapSent && res.textSent;
}

/**
 * Copy Link (#126) on the real host: a card's menu, a Section's, two cards selected, a shared card and the board's ⋯ menu each put
 * <file>#<id> (the board: just the file) on the clipboard, with a toast. Every line names a file that exists and holds that id, as
 * Claude Code in a terminal would open and grep it: the board's JSON, and the card library's file for the shared card
 */
async function copyLinkPointsIntoBoardFile() {
  const B = emptyBoard("bPath", "Attention");
  const step = nv("LLMEngine.step");
  put(B, step, 80, 120);
  B.cards.push({ id: "nPath", kind: "note", md: "## Prefill\nthe first pass", look: "note" });
  B.place.nPath = { x: 720, y: 120, w: 260 };
  B.cards.push({ id: "nShared", kind: "note", md: "a shared note", look: "note" });
  B.place.nShared = { x: 720, y: 420, w: 260 };
  B.sections.push({ id: "sPath", title: "Engine", x: 40, y: 60, w: 620, h: 560 });
  B.place[step.id].section = "sPath";
  const run = await hostBoards([B], { page: { light, w: 1300, h: 820 } });
  await run.host.store.share("bPath", ["nShared"]);
  const copied: string[] = [];
  run.ws.ui.copy = async (text) => void copied.push(text);
  const h = await run.open("bPath");
  const pg = h.page;
  const pick = async (label: string) => {
    const n = copied.length;
    await pg.locator(".ctx:not(.closing) button", { hasText: new RegExp(`^${label}$`) }).click();
    return until(h, `${label} copies a link`, () => copied[n]);
  };
  const toast = () => pg.locator(".toast").last().innerText();

  await pg.locator(`.card[data-id="${step.id}"] .chead`).click({ button: "right", position: { x: 200, y: 12 } });
  await pg.locator(".ctx:not(.closing) button", { hasText: /^Copy Link$/ }).waitFor();
  await shot(h, "126-copy-link");
  const card = await pick("Copy Link");
  const file = run.host.store.fileOf("bPath")!;
  check("card-path", card === `${file}#${step.id}`, card, file);
  check("card-link-toast", (await toast()).includes("Copied link"), await toast());
  await pg.keyboard.press("Escape");

  await pg.locator('.slabel[data-sect="sPath"]').click({ button: "right" });
  const sect = await pick("Copy Link");
  check("section-path", sect === `${file}#sPath`, sect);
  await pg.keyboard.press("Escape");

  await pg.locator('.card[data-id="nPath"]').click();
  await pg.locator(`.card[data-id="${step.id}"] .chead`).click({ modifiers: ["Shift"], position: { x: 200, y: 12 } });
  await pg.locator('.card[data-id="nPath"]').click({ button: "right" });
  const two = await pick("Copy Links");
  check("multi-path-toast", (await toast()).includes("Copied 2 links"), await toast());
  check("multi-path", two === `${file}#nPath\n${file}#${step.id}` || two === `${file}#${step.id}\n${file}#nPath`, two);
  await pg.keyboard.press("Escape");
  await pg.mouse.click(1200, 780);

  await pg.locator('.card[data-id="nShared"]').click({ button: "right" });
  const shared = await pick("Copy Link");
  check("shared-path", shared === `${path.join(path.dirname(file), "cards", "nShared.json")}#nShared`, shared);

  await pg.locator('.bbar button[aria-label="More"]').click();
  const board = await pick("Copy Link");
  check("board-path", board === file, board);

  for (const line of [card, sect, ...two.split("\n"), shared, board]) {
    const [f, id] = line.split("#");
    const body = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    check("path-file-holds-id", body && (!id || body.includes(`"id": "${id}"`)), line);
  }
}

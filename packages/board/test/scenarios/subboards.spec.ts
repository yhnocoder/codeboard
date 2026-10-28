// Sub-boards: one browser plays a board panel; the host (subhost.ts) is core Storage on a temp dir and switches
// the panel between boards like BoardHub.switchBoard (crumbs, cameras, walkthrough hops), pushes skeletons after saves.
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS, emptyBoard, subBoardsOf, type Board } from "@codeboard/core";
import { subHost } from "../subhost";
import { shot, symCard, findSym, viewOf, put, OUT, type Host } from "../harness";
import { test, open, check, light, verdict, expect, until, idle, hold } from "../fixtures";
import { DBL_CLICK } from "../../src/state/timing";

type Sub = Awaited<ReturnType<typeof subHost>>;
/** The panel switched boards: the host sent the next board's init and the board has shown it */
async function switched(t: Sub, n: number, what: string) {
  await until(t.h, what, () => t.inits.length > n);
  await idle(t.h);
}
/** A step that may switch boards (a Walkthrough hop): if the host sent an init, let the board show it too */
async function settled(t: Sub, n: number) {
  await idle(t.h);
  if (t.inits.length > n) await idle(t.h);
}
const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
/** first line of a card whose text matches re */
const lineOf = (c: ReturnType<typeof card>, re: RegExp) => { const s = c.segments[0]; return s.start + Math.max(0, s.text.findIndex((t) => re.test(t))); };

/** Screenshot also into the PR shots folder when SHOTS_DIR is set */
async function shotPr(h: Host, name: string) {
  await shot(h, name);
  const d = process.env.SHOTS_DIR;
  if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`)); }
}

test("subboards", () => verdict("subboards", run));

/** Turn into Board, edit the new board, go back, ⌘Z: the parent goes back, the sub-board keeps the edit; ⌘⇧Z links to it again. Unedited: ⌘Z trashes it, ⌘⇧Z brings it back */
test("turnIntoBoardUndo", async () => {
  const E = emptyBoard("bUndo", "Undo");
  const a = card("Scheduler.schedule"), c = card("BlockManager.allocate"), d = card("BlockManager.can_allocate");
  put(E, a, 60, 60, 560); put(E, c, 700, 60, 480); put(E, d, 700, 500, 480);
  const t = await subHost(E, []);
  const h = t.h, page = h.page;
  const turn = async (ids: string[], name: string) => {
    await page.keyboard.press("Shift+Digit1"); await idle(h);
    for (const [i, id] of ids.entries()) await page.locator(`.card[data-id="${id}"] .chead`).click({ position: { x: 120, y: 10 }, modifiers: i ? ["Shift"] : [] });
    await page.keyboard.press("Meta+Shift+b");
    await page.locator(".dialog input").fill(name);
    const made = () => t.store.peek("bUndo")!.cards.find((k) => k.kind === "board" && !E.cards.some((x) => x.id === k.id) && k.board && t.store.peek(k.board)?.name === name);
    await page.locator(".dialog button", { hasText: "Create Board" }).click();
    await until(h, `Turn into Board makes ${name}`, made); await idle(h);
    const f = made();
    return f?.kind === "board" ? f : undefined;
  };
  const has = (id: string) => t.store.peek("bUndo")!.cards.some((k) => k.id === id);
  /** ⌘Z takes the frame `id` off the parent; ⌘⇧Z puts it back. idle() then waits for the rest (dropping / restoring the board file) */
  // undo clicks the same empty spot each time: a second click there within DBL_CLICK would be a double-click (a new Text)
  const undo = async (id: string) => { await hold(h, DBL_CLICK, "not a double-click with the previous undo's click"); await page.mouse.click(5, 880); await page.keyboard.press("Meta+z"); await until(h, "undo takes the frame off", () => !has(id)); await idle(h); };
  const redo = async (id: string) => { await page.keyboard.press("Meta+Shift+z"); await until(h, "redo puts the frame back", () => has(id)); await idle(h); };
  await verdict("turnIntoBoardUndo", async (res) => {
    // edited: enter, delete a card, come back, undo
    const f1 = (await turn([c.id, d.id], "Alloc"))!;
    let n = t.inits.length;
    await page.locator(`.card[data-id="${f1.id}"] .sbname`).dblclick(); await switched(t, n, "entering Alloc opens its board");
    res.entered = t.cur() === f1.board;
    await page.keyboard.press("Shift+Digit1"); await idle(h);
    await page.locator(`.card[data-id="${d.id}"] .chead`).click({ position: { x: 120, y: 10 } });
    await page.keyboard.press("Backspace"); await idle(h);
    // nothing is selected after ⌫, so the first Esc already leaves; the second one lands on the parent
    n = t.inits.length;
    await page.keyboard.press("Escape"); await idle(h);
    await page.keyboard.press("Escape"); await switched(t, n, "Esc goes back to the parent");
    res.back = t.cur() === "bUndo";
    await undo(f1.id);
    res.parentBack = t.store.peek("bUndo")!.cards.map((k) => k.id).sort().join() === [a.id, c.id, d.id].sort().join();
    res.childKept = t.store.peek(f1.board)?.cards.map((k) => k.id);
    await redo(f1.id);
    const again = t.store.peek("bUndo")!.cards.find((k) => k.id === f1.id);
    res.relinked = again?.kind === "board" && again.board === f1.board && t.store.peek(f1.board)?.cards.length === 1;
    // unedited: undo trashes it, redo brings the file back
    await undo(f1.id);
    const kept = t.store.peek(f1.board); // the edited Alloc board stays after a second undo too
    res.stillKept = kept?.cards.length === 1;
    await redo(f1.id);
    const f2 = (await turn([a.id], "Sched"))!;
    await undo(f2.id);
    res.trashed = !t.store.peek(f2.board);
    await redo(f2.id);
    res.restored = !!t.store.peek(f2.board) && t.store.peek("bUndo")!.cards.some((k) => k.id === f2.id);
    return res.entered && res.back && res.parentBack && JSON.stringify(res.childKept) === JSON.stringify([c.id]) && res.relinked && res.stillKept && res.trashed && res.restored;
  });
  await h.page.context().close();
});

/** Lines selected on a sub-board, then back to the parent: the line selection was the sub-board's, so S on the parent has no lines to
 *  attach to */
test("lineSelectionStaysOnItsBoard", async () => {
  const C = emptyBoard("bLsChild", "Child"), P = emptyBoard("bLsParent", "Parent");
  const a = card("Scheduler.schedule"), c = card("BlockManager.allocate");
  put(C, c, 60, 60, 560);
  put(P, a, 60, 60, 560);
  P.cards.push({ id: "frLs", kind: "board", board: C.id });
  P.place.frLs = { x: 700, y: 60, w: 480, h: 360 };
  const t = await subHost(P, [C]);
  const h = t.h, page = h.page;
  let n = t.inits.length;
  await page.locator(`.card[data-id="frLs"] .sbname`).dblclick(); await switched(t, n, "entering Child opens its board");
  await page.locator(`.card[data-id="${c.id}"] .gutter .no`).nth(2).click();
  await expect(page.locator(`.card[data-id="${c.id}"] .gutter .no.sel`)).toHaveCount(1);
  n = t.inits.length;
  await page.locator(".crumbs .crumb", { hasText: "Parent" }).click(); await switched(t, n, "the breadcrumb goes back to Parent");
  await page.keyboard.press("s");
  await expect(page.locator(".toast")).toContainText("Select lines in a card first");
  check("lineSelectionStaysOnItsBoard", (await page.locator(".pop.k-addNote").count()) === 0, "no Add Sidenote for the sub-board's card");
  await h.page.context().close();
});

// A Walkthrough hop into a sub-board frames the start card by its measured size (a tall Note with no saved height: its estimate is
// far too short) and moves the camera as soon as the new board's cards are measured, a few frames after the board arrives
test("walkHopWaitsForMeasure", async () => {
  const P = emptyBoard("bWP", "Parent");
  put(P, card("Scheduler.schedule"), 60, 60, 560);
  const h = await open({ board: P, light, w: 1400, h: 900 });
  const pg = h.page;
  const C = emptyBoard("bWC", "Child");
  const md = Array.from({ length: 18 }, (_, i) => `Line ${i + 1} of a tall Note whose height was never saved`).join("\n\n");
  C.cards.push({ id: "nTall", kind: "note", md, look: "note" });
  C.place.nTall = { x: 2600, y: 1800, w: 420 };
  C.cam = { x: 0, y: 0, z: 1 };
  // counts the board's frames from the init to the first camera move after it
  await pg.evaluate(() => {
    const w = window as unknown as { __hop?: number | null };
    w.__hop = null;
    const world = () => (document.querySelector(".world") as HTMLElement).style.transform;
    addEventListener("message", (e) => {
      if (e.data?.type !== "init") return;
      let n = 0, at = "";
      const f = () => { n++; if (n === 1) at = world(); else if (world() !== at) { w.__hop = n - 1; return; } if (n < 600) requestAnimationFrame(f); };
      requestAnimationFrame(f);
    });
  });
  const views: Record<string, never> = {};
  await h.post({ type: "init", board: C, boards: [{ id: P.id, name: P.name, cards: 1 }, { id: C.id, name: C.name, cards: 1 }], views, stale: {}, host: { isMac: true, assetBase: "", target: true, settings: DEFAULT_SETTINGS } as never, crumbs: [{ id: P.id, name: P.name }], walk: { into: { root: "x", i: 0 } } } as never);
  await until(h, "the walk moves the camera", () => pg.evaluate(() => (window as unknown as { __hop?: number | null }).__hop != null));
  await idle(h);
  const r = await pg.evaluate(() => {
    const c = document.querySelector('.card[data-id="nTall"]')!.getBoundingClientRect();
    return { frames: (window as unknown as { __hop: number }).__hop, top: Math.round(c.top), bottom: Math.round(c.bottom), left: Math.round(c.left), right: Math.round(c.right), vw: innerWidth, vh: innerHeight };
  });
  await shot(h, "walk-hop-measured");
  check("walkHopWaitsForMeasure-framesMeasured", r.top >= 0 && r.left >= 0 && r.right <= r.vw && r.bottom <= r.vh && r.bottom - r.top > 400, r);
  check("walkHopWaitsForMeasure-soon", r.frames <= 4, r);
  await h.page.context().close();
});

// A card that renders 0×0 may get no ResizeObserver notification (the spec starts an observation at 0×0; Chromium reports it anyway,
// so the test drops it), so it is never measured: the hop must not wait for it
test("walkHopSkipsUnmeasuredCard", async () => {
  const P = emptyBoard("bZP", "Parent");
  put(P, card("Scheduler.schedule"), 60, 60, 560);
  const h = await open({ board: P, light, w: 1400, h: 900 });
  const pg = h.page;
  await pg.addStyleTag({ content: '.card[data-id="nZero"] { display: none !important; }' });
  await pg.evaluate(() => {
    const observe = ResizeObserver.prototype.observe;
    // decided a microtask later: the ref that observes runs before Solid sets data-id
    ResizeObserver.prototype.observe = function (el, o) { queueMicrotask(() => { if (!el.matches('[data-id="nZero"]')) observe.call(this, el, o); }); };
  });
  const C = emptyBoard("bZC", "Child");
  C.cards.push({ id: "nStart", kind: "note", md: "# Start\n\nThe walk starts here.", look: "note" });
  C.place.nStart = { x: 2600, y: 1800, w: 420 };
  C.cards.push({ id: "nZero", kind: "note", md: "Never laid out", look: "note" });
  C.place.nZero = { x: 200, y: 200, w: 300 };
  C.cam = { x: 0, y: 0, z: 1 };
  const world = () => pg.evaluate(() => (document.querySelector(".world") as HTMLElement).style.transform);
  await h.post({ type: "init", board: C, boards: [{ id: P.id, name: P.name, cards: 1 }, { id: C.id, name: C.name, cards: 2 }], views: {}, stale: {}, host: { isMac: true, assetBase: "", target: true, settings: DEFAULT_SETTINGS } as never, crumbs: [{ id: P.id, name: P.name }], walk: { into: { root: "x", i: 0 } } } as never);
  const at = await world();
  const moved = await until(h, "the walk moves the camera although one card is never measured", async () => (await world()) !== at, 3000).catch(() => false);
  check("walkHopSkipsUnmeasuredCard-moves", moved, { at });
  if (moved) {
    await idle(h);
    const r = await pg.evaluate(() => {
      const c = document.querySelector('.card[data-id="nStart"]')!.getBoundingClientRect();
      return { top: Math.round(c.top), bottom: Math.round(c.bottom), left: Math.round(c.left), right: Math.round(c.right), vw: innerWidth, vh: innerHeight };
    });
    check("walkHopSkipsUnmeasuredCard-frames", r.top >= 0 && r.left >= 0 && r.right <= r.vw && r.bottom <= r.vh, r);
  }
  await h.page.context().close();
});

async function run(res: Record<string, unknown>) {
  {
    // Engine: LLMEngine.step calls schedule / postprocess; schedule calls can_allocate, allocate, preempt (call marks)
    const E = emptyBoard("bEngine", "Engine");
    const step = card("LLMEngine.step"), sch = card("Scheduler.schedule"), can = card("BlockManager.can_allocate"), alloc = card("BlockManager.allocate"), pre = card("Scheduler.preempt"), post = card("Scheduler.postprocess");
    put(E, step, 60, 120, 600);
    put(E, sch, 820, 60); put(E, can, 1460, 60, 480); put(E, alloc, 1460, 420, 480); put(E, pre, 1460, 760, 480); put(E, post, 820, 900);
    const s0 = step.segments[0], c0 = sch.segments[0];
    const L = (id: string, from: typeof step, re: RegExp, to: string, name: string) => E.links.push({ id, from: { card: from.id, seg: from.segments[0].id, line: lineOf(from, re) }, to: { card: to }, call: { name, col: 0 } });
    L("l1", step, /schedule\(\)/, sch.id, "schedule");
    L("l2", step, /postprocess\(/, post.id, "postprocess");
    L("l3", sch, /can_allocate\(/, can.id, "can_allocate");
    L("l4", sch, /\.allocate\(/, alloc.id, "allocate");
    L("l5", sch, /preempt\(/, pre.id, "preempt");
    E.sections.push({ id: "secS", title: "Scheduling", x: 790, y: 20, w: 1180, h: 1300, color: "blue" });
    for (const c of [sch, can, alloc, pre, post]) E.place[c.id].section = "secS";
    // Ops: one dispatch line with 7 branches (folds into "+N" in the skeleton)
    const O = emptyBoard("bOps", "Ops");
    const disp = card("LLMEngine.step");
    put(O, disp, 60, 60);
    for (let i = 0; i < 7; i++) {
      const id = `op${i}`;
      O.cards.push({ id, kind: "note", md: `handler_${i}`, look: "note" }); O.place[id] = { x: 760, y: 40 + i * 190, w: 260 };
      O.links.push({ id: `ol${i}`, from: { card: disp.id, seg: disp.segments[0].id, line: lineOf(disp, /schedule\(\)/) }, to: { card: id }, call: { name: "schedule", col: 0 } });
    }
    const t = await subHost(E, [O]);
    const h = t.h, page = h.page;
    void s0; void c0;
    await idle(h);
    await page.keyboard.press("Shift+Digit1"); await idle(h);

    // 1. Turn into Board: select the Scheduling cards (marquee would catch the section; select through the store API instead)
    for (const [i, c] of [sch, can, alloc, pre, post].entries()) await page.locator(`.card[data-id="${c.id}"] .chead`).click({ position: { x: 120, y: 10 }, modifiers: i ? ["Shift"] : [] });
    await page.keyboard.press("Meta+Shift+b");
    await page.locator(".dialog input").fill("Scheduler");
    await page.locator(".dialog button", { hasText: "Create Board" }).click();
    await until(h, "Turn into Board makes the frame", () => t.store.peek("bEngine")!.cards.some((c) => c.kind === "board"));
    const eng = t.store.peek("bEngine")!;
    const frame = eng.cards.find((c) => c.kind === "board");
    // the host pushes the frame's skeleton after the save (subhost.ts, debounced): not a board message idle() could see
    await until(h, "the frame shows its board's cards", () => page.locator(`.card[data-id="${frame?.id}"] .skel [data-sub]`).count()); await idle(h);
    const child = frame?.kind === "board" ? t.store.peek(frame.board) : undefined;
    res.frame = !!frame && eng.cards.length === 2;
    res.child = child ? child.cards.length : 0;
    res.childLinks = child?.links.length;
    // the calls into schedule / postprocess now go to the frame itself
    res.inLinks = eng.links.filter((l) => l.to.card === frame?.id).map((l) => JSON.stringify(l.to));
    res.skelCards = await page.locator(`.card[data-id="${frame?.id}"] .skel [data-sub]`).count();
    res.title = await page.locator(`.card[data-id="${frame?.id}"] .sbhead`).textContent();
    res.tip = await page.locator(`.card[data-id="${frame?.id}"] .sbname`).getAttribute("title");
    await page.keyboard.press("Escape"); await page.keyboard.press("Shift+Digit1"); await idle(h);
    await shotPr(h, "subboards-1-frame");

    // 2. Far zoom: grey blocks with Section colour, name above
    // 滚轮一点一点缩到刚进地图档（< 25%），框还看得清
    for (let i = 0; i < 30 && !(await page.locator(`.card.board.lo-map`).count()); i++) {
      await page.evaluate(() => document.querySelector("#board")!.dispatchEvent(new WheelEvent("wheel", { deltaY: 30, ctrlKey: true, clientX: 700, clientY: 400, bubbles: true, cancelable: true })));
      await idle(h);
    }
    res.far = await page.locator(`.card.board.lo-map[data-id="${frame?.id}"]`).count();
    await shotPr(h, "subboards-2-far");
    await page.keyboard.press("Shift+Digit1"); await idle(h);

    // 3. Insert Ops (canvas menu ▸ Insert Board) → its dispatch line folds into "+N more"
    await page.mouse.click(700, 820, { button: "right" });
    await page.locator(".ctx button", { hasText: "Insert Board" }).hover();
    await page.locator(".ctx button", { hasText: /^Ops/ }).click();
    const opsFrame = await until(h, "Insert Board adds the Ops frame", () => t.store.peek("bEngine")!.cards.find((c) => c.kind === "board" && c.board === "bOps"));
    await page.locator(`.card[data-id="${opsFrame.id}"] .skel .sk-more`).waitFor(); await idle(h); // with the skeleton push
    res.more = await page.locator(`.card[data-id="${opsFrame.id}"] .skel .sk-more`).textContent();

    // 4. A new arrow from LLMEngine.step: Arrow tool, then click a mini card inside the frame: the arrow goes to the frame itself
    await page.keyboard.press("Escape");
    await page.keyboard.press("Shift+Digit1"); await idle(h);
    await page.locator(`.card[data-id="${step.id}"] .chead`).click({ timeout: 5000, position: { x: 120, y: 10 } });
    await page.locator('.bbar button[aria-label="Arrow"]').click(); await idle(h);
    await page.locator(`.card[data-id="${frame?.id}"] .skel [data-sub]`).first().click({ force: true });
    const plainIn = () => t.store.peek("bEngine")!.links.find((l) => l.from.card === step.id && l.to.card === frame?.id && !l.call);
    await until(h, "the arrow into the frame is saved", plainIn); await idle(h);
    res.newArrow = JSON.stringify(plainIn()?.to);
    await expect(page.locator(".toast.show")).toHaveCount(0);
    // 骨架里那张卡在视口外时 Playwright 的点击会先把 #board 滚过去（线那层的 .wext 把世界层撑大了）：滚回来，后面按屏幕坐标点的地方才对得上
    await page.evaluate(() => { const b = document.querySelector("#board")!; b.scrollLeft = 0; b.scrollTop = 0; });
    await page.mouse.move(5, 5); await idle(h);
    await shotPr(h, "subboards-4-arrow-into-skeleton");

    // 5. Double-click enters the sub-board (same panel) with a breadcrumb; cycle refused; Esc returns
    let n = t.inits.length;
    await page.locator(`.card[data-id="${frame?.id}"] .sbname`).dblclick(); await switched(t, n, "entering Scheduler opens its board");
    res.entered = t.cur() === (frame as any)?.board && t.crumbs().length === 1;
    res.crumbs = await page.locator(".crumbs").textContent();
    await shotPr(h, "subboards-3-breadcrumb");
    await page.mouse.click(700, 820, { button: "right" });
    await page.locator(".ctx button", { hasText: "Insert Board" }).hover();
    await page.locator(".ctx button", { hasText: /^Engine/ }).click();
    await page.locator(".toast").waitFor(); await idle(h);
    res.cycleToast = await page.locator(".toast").textContent();
    res.noCycle = !subBoardsOf(t.store.peek(t.cur())!).includes("bEngine");
    res.lo = await page.locator(".card.lo-ov, .card.lo-map").count();
    // nothing is selected: Esc leaves
    n = t.inits.length;
    await page.keyboard.press("Escape"); await switched(t, n, "Esc goes back to Engine");
    res.back = t.cur() === "bEngine" && !(await page.locator(".crumbs").count());

    // 6. Walkthrough from LLMEngine.step: enters Scheduler at schedule, walks there, returns to Engine and goes on
    await page.locator(`.card[data-id="${step.id}"] .chead`).click({ timeout: 5000, position: { x: 120, y: 10 } });
    await page.keyboard.press("p"); await page.locator(".present").waitFor(); await idle(h);
    const before = t.inits.length;
    await page.keyboard.press("ArrowRight"); await switched(t, before, "the walkthrough goes into the frame"); // → the frame: camera goes in, panel switches
    res.walkIn = t.cur() !== "bEngine" && (t.inits.at(-1)?.walk as any)?.into !== undefined;
    const bar = page.locator(".present .ptitle");
    res.walkBar = (await bar.count()) ? await bar.textContent() : "";
    for (let i = 0; i < 6 && t.cur() !== "bEngine"; i++) { n = t.inits.length; await page.keyboard.press("ArrowRight"); await settled(t, n); }
    res.walkOut = t.cur() === "bEngine" && t.inits.length >= before + 2 && (t.inits.at(-1)?.walk as any)?.resume !== undefined;
    const cnt = page.locator(".present .cnt");
    res.walkAfter = (await cnt.count()) ? await cnt.textContent() : "";
    await page.keyboard.press("Escape"); await idle(h);

    // 7. Remove only the frame: the Ops board stays in the library
    await page.keyboard.press("Shift+Digit1"); await idle(h);
    await page.locator(`.card[data-id="${opsFrame?.id}"] .sbname`).click();
    await page.keyboard.press("Backspace");
    await until(h, "the Ops frame is removed", () => !t.store.peek("bEngine")!.cards.some((c) => c.id === opsFrame?.id)); await idle(h);
    res.removedFrame = !t.store.peek("bEngine")!.cards.some((c) => c.id === opsFrame?.id) && !!t.store.peek("bOps");

    const into = JSON.stringify({ card: frame?.id });
    const ok = res.frame && res.child === 5 && res.childLinks === 3 && JSON.stringify(res.inLinks) === JSON.stringify([into, into])
      && (res.skelCards as number) >= 1 && /Scheduler\s*5$/.test(String(res.title)) && res.tip === "Scheduler · bb823b3" && res.far === 1
      && /\+4 more/.test(String(res.more)) && res.newArrow === into && res.entered && /Engine.*Scheduler/.test(String(res.crumbs))
      && /Can’t put Engine inside Scheduler: Scheduler is already inside Engine/.test(String(res.cycleToast)) && res.noCycle && res.back
      && res.walkIn && res.walkOut && res.removedFrame && res.lo === 0;
    check("subboards", ok, JSON.stringify(res));
    await h.page.context().close();
  }
}

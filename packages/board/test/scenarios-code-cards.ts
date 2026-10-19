// Code cards on the canvas: what the user can see is what selection, Delete, Fit and Reveal act on; keyboard and pointer details.
//  tabKeepsCanvasStill        — Tab walking focus to a button of a card past the edge does not scroll the canvas (Fit and box select stay right)
//  hiddenCardsNotSelectable   — cards hidden in a collapsed call subtree: box select and Select All skip them, Delete never removes them
//  revealShowsHiddenCard      — Reveal on Board / clicking the already-expanded call on a card in a collapsed subtree expands it
//  fitFramesVisibleContent    — Fit to Window frames what is shown: no hidden call-tree cards, a collapsed section counts as its title pill
//  nudgeHoldIsOneUndoStep     — holding an arrow key is one undo step; each separate press is its own step
//  farClicksNotDoubleClick    — two quick clicks far apart on empty canvas are not a double-click (no Text note)
//  implPickerKeyboard         — the Go to Implementation picker takes ↑ / ↓ / Enter instead of nudging the card behind it
//  shortcutHelpComplete       — the shortcut help lists Fit Content, Turn into Board and Open board frame (Mac order: ⇧⌘B)
//  undoAddKeepsLaterWork      — the editor's undo of an add removes only those cards, even after the board changed
//  secondCallBelowCaller      — in a short panel the second expanded call still goes below its caller, not above it
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
  hiddenCardsNotSelectable: () => run("hiddenCardsNotSelectable", hiddenCardsNotSelectable),
  revealShowsHiddenCard: () => run("revealShowsHiddenCard", revealShowsHiddenCard),
  fitFramesVisibleContent: () => run("fitFramesVisibleContent", fitFramesVisibleContent),
  nudgeHoldIsOneUndoStep: () => run("nudgeHoldIsOneUndoStep", nudgeHoldIsOneUndoStep),
  farClicksNotDoubleClick: () => run("farClicksNotDoubleClick", farClicksNotDoubleClick),
  implPickerKeyboard: () => run("implPickerKeyboard", implPickerKeyboard),
  shortcutHelpComplete: () => run("shortcutHelpComplete", shortcutHelpComplete),
  undoAddKeepsLaterWork: () => run("undoAddKeepsLaterWork", undoAddKeepsLaterWork),
  secondCallBelowCaller: () => run("secondCallBelowCaller", secondCallBelowCaller),
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

async function hiddenCardsNotSelectable(res: Record<string, unknown>) {
  const { b, step, sch, post } = callTree(true);
  const names = (h: Host) => h.board().cards.map((c) => c.id === sch.id ? "schedule" : c.id === post.id ? "postprocess" : c.id === step.id ? "step" : c.id);
  let h = await open({ board: structuredClone(b) });
  res.shown = (await shownIds(h)).length;
  // a box over the empty space where the hidden callees are, then Delete
  await h.page.mouse.move(60, 480); await h.page.mouse.down();
  await h.page.mouse.move(1380, 880, { steps: 8 }); await h.page.mouse.up(); await wait(h, 300);
  res.boxed = lastSel(h)?.cards;
  await h.page.keyboard.press("Delete"); await wait(h, 1200);
  res.afterBoxDelete = names(h);
  // Select All
  await clickCanvas(h);
  await h.page.keyboard.press("Meta+a"); await wait(h, 300);
  res.all = lastSel(h)?.cards;
  await close(h);
  // dragging the call graph mark moves the whole subtree, hidden callees too (they stay selected); Delete only removes what is shown
  h = await open({ board: structuredClone(b) });
  const mk = (await h.page.locator(`.card[data-id="${step.id}"] .chead .step`).first().boundingBox())!;
  await h.page.mouse.move(mk.x + mk.width / 2, mk.y + mk.height / 2); await h.page.mouse.down();
  await h.page.mouse.move(mk.x + 60, mk.y + 40, { steps: 6 }); await h.page.mouse.up(); await wait(h, 400);
  res.dragSel = lastSel(h)?.cards.length;
  await h.page.keyboard.press("Delete"); await wait(h, 1200);
  res.afterDragDelete = names(h);
  await close(h);
  return res.shown === 1 && (res.boxed as string[]).length === 0 && JSON.stringify(res.afterBoxDelete) === JSON.stringify(["step", "schedule", "postprocess"])
    && JSON.stringify(res.all) === JSON.stringify([step.id]) && res.dragSel === 3 && JSON.stringify(res.afterDragDelete) === JSON.stringify(["schedule", "postprocess"]);
}

async function revealShowsHiddenCard(res: Record<string, unknown>) {
  const { b, step, sch } = callTree(true);
  const h = await open({ board: b });
  // Reveal on Board (editor command / CodeLens) on the hidden callee
  await h.post({ type: "reveal", card: sch.id }); await wait(h, 700);
  res.revealShown = (await shownIds(h)).includes(sch.id);
  res.revealSel = await h.page.locator(`.card.sel[data-id="${sch.id}"]`).count();
  // collapse again, then click the already-expanded call in the caller
  await h.page.keyboard.press("Meta+z"); await wait(h, 500);
  res.collapsedAgain = !(await shownIds(h)).includes(sch.id);
  await h.page.locator(`.card[data-id="${step.id}"] .src .call:text-is("schedule")`).first().click(); await wait(h, 700);
  res.clickShown = (await shownIds(h)).includes(sch.id);
  res.clickSel = await h.page.locator(`.card.sel[data-id="${sch.id}"]`).count();
  await close(h);
  return !!res.revealShown && res.revealSel === 1 && !!res.collapsedAgain && !!res.clickShown && res.clickSel === 1;
}

async function fitFramesVisibleContent(res: Record<string, unknown>) {
  const { b } = callTree(true);
  // the hidden callees far away; a collapsed section with a big stored frame and a member far away
  b.place[b.cards[1].id] = { x: 4000, y: 3000, w: 560 };
  b.place[b.cards[2].id] = { x: 5000, y: 3600, w: 560 };
  b.sections.push({ id: "sec", title: "Later", x: 700, y: 80, w: 6000, h: 5000, collapsed: true });
  const m = nv("BlockManager.allocate"); put(b, m, 6000, 4500, 560); b.place[m.id].section = "sec";
  const h = await open({ board: b });
  await clickCanvas(h);
  await h.page.keyboard.press("Shift+Digit1"); await wait(h, 900);
  res.zoom = await zoom(h);
  await close(h);
  return (res.zoom as number) > 0.6;
}

async function nudgeHoldIsOneUndoStep(res: Record<string, unknown>) {
  const b = emptyBoard("bNudge", "nudge");
  const a = nv("LLMEngine.step"), c = nv("Scheduler.schedule");
  put(b, a, 80, 80, 560); put(b, c, 700, 80, 560);
  const h = await open({ board: b });
  // an earlier step: delete the second card
  await clickHead(h, c.id);
  await h.page.keyboard.press("Delete"); await wait(h, 300);
  await clickHead(h, a.id);
  // hold → (the browser repeats the key down while it is held: Playwright sends repeats for a key already down)
  for (let i = 0; i < 5; i++) await h.page.keyboard.down("ArrowRight");
  await h.page.keyboard.up("ArrowRight");
  // then two separate presses of ↓
  for (let i = 0; i < 2; i++) await h.page.keyboard.press("ArrowDown");
  await wait(h, 1000);
  const at = () => [h.board().place[a.id].x, h.board().place[a.id].y];
  res.moved = at();
  const undos: number[][] = [];
  for (let i = 0; i < 3; i++) { await h.page.keyboard.press("Meta+z"); await wait(h, 600); undos.push(at()); }
  res.undos = undos;
  await h.page.keyboard.press("Meta+z"); await wait(h, 1000);
  res.deletedBack = h.board().cards.some((k) => k.id === c.id);
  await close(h);
  return JSON.stringify(res.moved) === "[85,82]" && JSON.stringify(undos) === "[[85,81],[85,80],[80,80]]" && !!res.deletedBack;
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

async function implPickerKeyboard(res: Record<string, unknown>) {
  const b = emptyBoard("bImpl", "impl");
  const step = nv("LLMEngine.step");
  put(b, step, 80, 80, 560);
  const impl = (q: string) => { const s = findSym(q); return { label: s.s.qual, detail: `${s.f}:${s.s.defLine}`, path: s.f, line: s.s.defLine, qual: s.s.qual }; };
  const h = await open({
    board: b,
    on: async (m, reply) => {
      if (m.type !== "expand" || m.pick || m.name !== "schedule") return false;
      await reply(m.req!, { impls: [impl("Scheduler.schedule"), impl("Scheduler.postprocess")], base: "Scheduler.schedule" });
      return true;
    },
  });
  await clickHead(h, step.id);
  await h.page.locator(`.card[data-id="${step.id}"] .src .call:text-is("schedule")`).first().click(); await wait(h, 600);
  res.open = await h.page.locator(".pop.k-impls").count();
  await h.page.keyboard.press("ArrowDown"); await wait(h, 100);
  res.on = await h.page.locator(".pop.k-impls .cand.on .lb").textContent().catch(() => null);
  await h.page.keyboard.press("Enter"); await wait(h, 1200);
  res.closed = (await h.page.locator(".pop.k-impls").count()) === 0;
  res.cards = h.board().cards.map((c) => (c as CodeCard).segments?.[0]?.symbol?.qual);
  res.stepAt = [h.board().place[step.id].x, h.board().place[step.id].y];
  res.opened = h.sent.some((m) => m.type === "open");
  await close(h);
  return res.open === 1 && res.on === "Scheduler.postprocess" && !!res.closed && (res.cards as string[]).includes("Scheduler.postprocess")
    && JSON.stringify(res.stepAt) === "[80,80]" && !res.opened;
}

async function shortcutHelpComplete(res: Record<string, unknown>) {
  const h = await open({ board: emptyBoard("bKeys", "keys") });
  await clickCanvas(h);
  await h.page.keyboard.press("Shift+Slash"); await wait(h, 400);
  const rows = await h.page.locator(".keys tr").allTextContents();
  await close(h);
  const has = (k: string) => rows.some((r) => r.startsWith(k));
  res.missing = ["⌥F", "⇧⌘B", "⌘↵"].filter((k) => !has(k));
  return rows.length > 10 && !(res.missing as string[]).length;
}

async function undoAddKeepsLaterWork(res: Record<string, unknown>) {
  const b = emptyBoard("bAdd", "add");
  const old = nv("LLMEngine.step");
  put(b, old, 80, 80, 560);
  const h = await open({ board: b });
  // the editor adds a card, then the user keeps working on the board (moves the old card)
  const add = nv("Scheduler.schedule");
  await h.post({ type: "add", cards: [{ card: add, views: { [add.segments[0].id]: viewOf(add.segments[0]) }, w: 560 }] }); await wait(h, 500);
  await clickHead(h, old.id);
  await h.page.keyboard.press("Shift+ArrowRight"); await wait(h, 300);
  // the notification's Undo (or ⌘Z in the editor) for that add
  await h.post({ type: "undoAdd", cards: [add.id] }); await wait(h, 1200);
  res.cards = h.board().cards.map((c) => c.id === old.id ? "old" : c.id === add.id ? "added" : c.id);
  res.oldX = h.board().place[old.id].x;
  await close(h);
  return JSON.stringify(res.cards) === JSON.stringify(["old"]) && res.oldX === 90;
}

async function secondCallBelowCaller(res: Record<string, unknown>) {
  const b: Board = emptyBoard("bNarrow", "narrow");
  const step = nv("LLMEngine.step");
  put(b, step, 40, 560, 520);
  const h = await open({ board: b, w: 600, h: 1000 });
  await h.page.locator(`.card[data-id="${step.id}"] .src .call:text-is("schedule")`).first().click(); await wait(h, 1200);
  await clickCanvas(h, 10, 990);
  await h.page.locator(`.card[data-id="${step.id}"] .src .call:text-is("postprocess")`).first().click({ force: true }); await wait(h, 1500);
  const cards = h.board().cards as CodeCard[];
  const at = (q: string) => { const c = cards.find((k) => k.segments?.[0]?.symbol?.qual === q); return c && h.board().place[c.id]; };
  res.step = at("LLMEngine.step"); res.schedule = at("Scheduler.schedule"); res.postprocess = at("Scheduler.postprocess");
  await close(h);
  const s = res.step as { y: number } | undefined, p = res.postprocess as { y: number } | undefined;
  return !!s && !!p && p.y > s.y;
}

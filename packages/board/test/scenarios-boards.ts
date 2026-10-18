// Boards and their storage: changes reach the host as they happen, copying connected cards between boards, empty questions,
// undo across sub-boards (history per board, Turn into Board), arrows into a deleted sub-board card, crumbs to a deleted board.
// Usage: node packages/board/test/run-harness.mjs <scenario…>   (names in BOARDS below)
import { emptyBoard, type Board } from "@codeboard/core";
import { open, put, symCard, findSym, type Host } from "./harness";

const wait = (h: Host, ms = 600) => h.page.waitForTimeout(ms);
const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };
const run = async (name: string, f: (res: Record<string, unknown>) => Promise<boolean>) => {
  const res: Record<string, unknown> = {};
  let ok = false;
  try { ok = await f(res); } catch (e) { console.log("FAIL", name, (e as Error).message.split("\n")[0], JSON.stringify(res)); process.exit(1); }
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(res));
  if (!ok) process.exitCode = 1;
};

export const BOARDS: Record<string, () => Promise<void>> = {
  changesreachhost: () => run("changes-reach-host-at-once", changesReachHost),
  emptyquestion: () => run("empty-new-question-is-dropped", emptyQuestion),
};

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
  await page.context().browser()!.close();
  return res.editor === 1 && res.emptyLeft === 0 && res.emptyShown === 0 && JSON.stringify(res.written) === '["why?"]' && res.afterUndo === 0 && res.afterSecondUndo === 0;
}

/** Each change goes to the host right away (the host writes it to disk and finishes the write when the panel closes), so closing the tab can't lose it */
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
  await page.context().browser()!.close();
  return res.wrapSent === true && (res.wrapMs as number) < 300 && res.textMs !== null && (res.textMs as number) < 300;
}

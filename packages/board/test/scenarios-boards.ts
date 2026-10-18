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
};

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

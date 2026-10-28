//  fitIncludesLinkLabelsAndAltBar — Fit to Window frames what is drawn beside the cards too: a long label on a line that bulges
//                                    out to the right and the grey alternatives column beside the call's target stay on screen
import { emptyBoard, type CodeCard } from "@codeboard/core";
import { put, symCard, findSym, shot, type Host } from "../harness";
import { test, open, check, idle } from "../fixtures";

const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; return s.start + s.text.findIndex((t) => re.test(t)); };
const close = (h: Host) => h.page.context().close();

test("fitIncludesLinkLabelsAndAltBar", async () => {
  // Two cards one above the other in a narrow panel (the VS Code side panel of the report): the line leaves and enters on the
  // right, so it bulges out past both cards, and the alternatives column sits right of the lower card
  const b = emptyBoard("bFit", "fit");
  const step = nv("LLMEngine.step"), sch = nv("Scheduler.schedule");
  put(b, step, 80, 80, 560); put(b, sch, 80, 700, 560);
  b.links.push({
    id: "l-sch", from: { card: step.id, seg: step.segments[0].id, line: lineOf(step, /scheduler\.schedule\(/) }, to: { card: sch.id },
    sides: { from: "right", to: "right" }, label: "picks the sequences to run in this step, prefill first",
    call: { name: "schedule", col: 0, impls: 3, alts: [
      { label: "PriorityScheduler.schedule", detail: "engine/priority.py:41", qual: "PriorityScheduler.schedule" },
      { label: "ChunkedScheduler.schedule", detail: "engine/chunked.py:18", qual: "ChunkedScheduler.schedule" },
    ] },
  });
  const h = await open({ board: b, w: 700, h: 900 });
  await h.page.locator(".altcol").waitFor();
  await h.page.locator(".vchips .vlabel").waitFor();
  await h.page.mouse.click(40, 600); await idle(h); // empty canvas: focus in the board, nothing selected
  await h.page.keyboard.press("Shift+Digit1"); await idle(h);
  await shot(h, "fit-labels-altbar");
  const got = await h.page.evaluate(() => {
    const box = (e: Element) => { const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; };
    return { w: innerWidth, h: innerHeight, labels: [...document.querySelectorAll(".vchips")].map(box), alts: [...document.querySelectorAll(".altcol")].map(box), cards: [...document.querySelectorAll(".card[data-id]")].map(box) };
  });
  const inside = (r: { l: number; t: number; r: number; b: number }) => r.l >= 0 && r.t >= 0 && r.r <= got.w && r.b <= got.h;
  check("fitIncludesLinkLabelsAndAltBar label on screen", got.labels.length === 1 && got.labels.every(inside), got);
  check("fitIncludesLinkLabelsAndAltBar alternatives column on screen", got.alts.length === 1 && got.alts.every(inside), got);
  check("fitIncludesLinkLabelsAndAltBar cards on screen", got.cards.length === 2 && got.cards.every(inside), got);
  await close(h);
});

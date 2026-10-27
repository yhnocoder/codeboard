import { shot, put, type Host } from "../harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, until, idle, frames } from "../fixtures";

/** 7 Notes scattered around: a → b, a → c, c → d have arrows; e, f, g have none */
function scattered(): Board {
  const b = emptyBoard("b1", "nano-vllm · tidy");
  const note = (id: string, md: string, x: number, y: number, w = 240) => put(b, { id, kind: "note", bg: true, md } as NoteCard, x, y, w);
  note("a", "# generate\n\nTakes the prompts and runs steps until every sequence is done.", 520, 160);
  note("b", "# add_request\n\nTokenizes and queues.", 140, 520, 220);
  note("c", "# step\n\nOne scheduler pass, then one model run.", 900, 420);
  note("d", "# postprocess\n\nAppends the sampled tokens.", 260, 260, 220);
  note("e", "# Sampler\n\nTemperature only.", 980, 140, 200);
  note("f", "# KV cache\n\nBlocks of 256 tokens.", 620, 640, 220);
  note("g", "# Config\n\nmax_num_seqs, max_model_len.", 120, 140, 200);
  b.links.push({ id: "L1", from: { card: "a" }, to: { card: "b" } });
  b.links.push({ id: "L2", from: { card: "a" }, to: { card: "c" } });
  b.links.push({ id: "L3", from: { card: "c" }, to: { card: "d" } });
  return b;
}

type R = { x: number; y: number; w: number; h: number };
const rects = (h: Host) => h.page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>(".card[data-id]")].map((e) => {
  const r = e.getBoundingClientRect();
  return [e.dataset.id!, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }];
}))) as Promise<Record<string, R>>;
const places = (h: Host) => Object.fromEntries(Object.entries(h.board().place).map(([id, p]) => [id, { x: p.x, y: p.y }]));

/** Four buttons; ··· opens Align / Distribute and they still align; Tidy Up: linked cards in columns left to right (a caller centered on its callees, a column keeps its top-to-bottom order), the rest in rows below; one ⌘Z */
test("multiSelectToolbarTidyUp", async () => {
  const h = await open({ board: scattered(), light: true, w: 1400, h: 900, settings: { theme: "warm-ink" } as never });
  const { page } = h;
  const placed = () => JSON.stringify(places(h));
  /** act, then wait until the host has the cards' places changed and the board has settled */
  const moves = async (what: string, act: () => Promise<unknown>) => { const p0 = placed(); await act(); await until(h, what, () => placed() !== p0); await idle(h); };
  await page.mouse.click(1300, 860);
  await page.keyboard.press("Meta+a");
  await page.locator(".alignbar").waitFor(); await idle(h);
  const bar = page.locator(".alignbar");
  const labels = await bar.evaluate((el) => [...el.querySelectorAll(":scope > button")].map((b) => b.textContent?.trim() || b.getAttribute("aria-label")));
  check("toolbarFourButtons", JSON.stringify(labels) === JSON.stringify(["Create Section", "Create Sub-board", "Tidy Up", "More"]), labels);
  check("toolbarAlignHidden", !(await page.locator(".alignmore").isVisible()), "the align buttons are inside ···");
  await shot(h, "multiSelect-before");

  await bar.locator('button[aria-label="More"]').click();
  await page.locator(".alignmore").waitFor(); await idle(h);
  const more = page.locator(".alignmore");
  const tips = await more.evaluate((el) => [...el.querySelectorAll("button")].map((b) => b.getAttribute("data-tip")));
  const titles = await more.evaluate((el) => [...el.querySelectorAll(".t")].map((t) => t.textContent));
  check("moreOpensAlign", (await more.isVisible()) && tips.length === 7 && tips.includes("Align Left") && tips.includes("Distribute Vertically") && titles.join() === "Align,Distribute", { tips, titles });
  await shot(h, "multiSelect-more");
  const before = places(h);
  await moves("Align Top is saved", () => more.locator('button[aria-label="Align Top"]').click());
  const ys = new Set(Object.values(places(h)).map((p) => p.y));
  check("moreAlignTop", ys.size === 1, [...ys]);
  await page.keyboard.press("Escape");
  await idle(h);
  check("moreClosesOnEscape", !(await more.isVisible()));
  await moves("the undo is saved", () => page.keyboard.press("Meta+z"));
  check("alignUndo", JSON.stringify(places(h)) === JSON.stringify(before), places(h));

  // Tidy Up: the cards slide (arrows follow), then linked cards stand in columns by depth and the rest in rows below them
  const start = await rects(h);
  const pathBefore = await page.locator('path.lhit[data-link="L2"]').first().getAttribute("d");
  const p0 = placed();
  await bar.getByRole("button", { name: "Tidy Up" }).click();
  // mid-slide: a couple of frames after the first frame in which card b has left where it was
  await page.waitForFunction((s) => { const r = document.querySelector('.card[data-id="b"]')!.getBoundingClientRect(); return Math.round(r.x) !== s.x || Math.round(r.y) !== s.y; }, start.b, { polling: "raf" });
  await frames(page, 2);
  const mid = await rects(h);
  const pathMid = await page.locator('path.lhit[data-link="L2"]').first().getAttribute("d");
  await until(h, "Tidy Up is saved", () => placed() !== p0); await idle(h);
  const end = await rects(h);
  const pathEnd = await page.locator('path.lhit[data-link="L2"]').first().getAttribute("d");
  const between = (k: "x" | "y", id: string) => Math.min(start[id][k], end[id][k]) < mid[id][k] && mid[id][k] < Math.max(start[id][k], end[id][k]);
  check("tidyAnimates", between("x", "b") || between("y", "b"), { start: start.b, mid: mid.b, end: end.b });
  check("tidyArrowsFollow", !!pathMid && pathMid !== pathBefore && pathMid !== pathEnd, { pathBefore, pathMid, pathEnd });
  const linkedBottom = Math.max(...["a", "b", "c", "d"].map((id) => end[id].y + end[id].h));
  const cy = (id: string) => end[id].y + end[id].h / 2;
  check("tidyColumns", end.a.x < end.b.x && end.b.x === end.c.x && end.c.x < end.d.x && end.c.y + end.c.h < end.b.y && cy("c") < cy("a") && cy("a") < cy("b"), end);
  const p1 = places(h);
  check("tidyColumnGap", p1.c.x - (p1.a.x + 240) === 56 && p1.d.x - (p1.c.x + 240) === 56, p1);
  check("tidyRowsBelow", ["e", "f", "g"].every((id) => end[id].y > linkedBottom), { linkedBottom, e: end.e, f: end.f, g: end.g });
  check("tidyRowOrder", end.g.x < end.e.x && end.g.y === end.e.y && end.f.y > end.e.y, { e: end.e, f: end.f, g: end.g });
  const corner = (ps: Record<string, { x: number; y: number }>) => [Math.min(...Object.values(ps).map((p) => p.x)), Math.min(...Object.values(ps).map((p) => p.y))];
  check("tidyAnchorTopLeft", JSON.stringify(corner(p1)) === JSON.stringify(corner(before)) && p1.a.x === corner(before)[0], { p1 });
  await shot(h, "multiSelect-after");

  await moves("the undo is saved", () => page.keyboard.press("Meta+z"));
  check("tidyOneUndo", JSON.stringify(places(h)) === JSON.stringify(before), places(h));

  // ⌥T does the same; a locked card stays where it is
  await page.mouse.click(1300, 860);
  await page.locator('.card[data-id="f"]').click();
  await page.keyboard.press("Meta+Shift+l");
  await page.mouse.click(1300, 860);
  await page.keyboard.press("Meta+a");
  await page.locator('.card[data-id="f"]').click({ modifiers: ["Shift"] });
  await idle(h);
  await moves("Tidy Up is saved", () => page.keyboard.press("Alt+KeyT"));
  const locked = places(h);
  check("tidyKey", locked.b.x !== before.b.x || locked.b.y !== before.b.y, locked.b);
  check("tidyLockedStays", locked.f.x === before.f.x && locked.f.y === before.f.y, locked.f);
});

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

/** Near any edge of the view the toolbar keeps its one-line width and slides inward instead of shrinking and wrapping its labels:
 *  8px from the left / right edge, clear of the title bar on top and of the toolbar and zoom controls at the bottom (56px) */
test("selectionToolbarAtEdge", async () => {
  const W = 1400, H = 900, PAD = 8, CHROME_Y = 56;
  const b = emptyBoard("b1", "nano-vllm · edge");
  const long = Array.from({ length: 70 }, (_, i) => `Line ${i + 1} of the scheduler notes.`).join("\n\n");
  put(b, { id: "a", kind: "note", bg: true, md: `# Scheduler\n\n${long}` } as NoteCard, 0, 0, 240);
  put(b, { id: "b", kind: "note", bg: true, md: "# Sampler\n\nTemperature only." } as NoteCard, 300, 0, 240);
  const h = await open({ board: b, light: true, w: W, h: H, settings: { theme: "warm-ink" } as never });
  const { page } = h;
  await page.keyboard.press("Meta+a");
  await page.locator(".alignbar").waitFor(); await idle(h);
  type Box = { x: number; y: number; w: number; h: number };
  type Bar = Box & { btnH: number[]; iconW: number[]; lines: number[]; sel: Box; covered: boolean };
  const measure = () => page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".alignbar")!.getBoundingClientRect();
    const btns = [...document.querySelectorAll<HTMLElement>(".alignbar > .tbtn")];
    // a label's line count: the distinct line tops of its text
    const lines = btns.map((el) => { const r = document.createRange(); r.selectNodeContents([...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)!); return new Set([...r.getClientRects()].map((q) => Math.round(q.top))).size; });
    const cs = [...document.querySelectorAll<HTMLElement>(".card[data-id]")].map((e) => e.getBoundingClientRect());
    const x0 = Math.min(...cs.map((r) => r.left)), y0 = Math.min(...cs.map((r) => r.top)), x1 = Math.max(...cs.map((r) => r.right)), y1 = Math.max(...cs.map((r) => r.bottom));
    // overlaps the board's own toolbars (bottom bar, zoom dock, parent-board crumbs)
    const covered = [...document.querySelectorAll<HTMLElement>(".over .pill, .crumbs")].some((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left < bar.right && bar.left < r.right && r.top < bar.bottom && bar.top < r.bottom; });
    return { covered, x: bar.x, y: bar.y, w: bar.width, h: bar.height, btnH: btns.map((e) => e.getBoundingClientRect().height), iconW: btns.map((e) => e.querySelector("svg")!.getBoundingClientRect().width), lines, sel: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
  }) as Promise<Bar>;
  const normal = await measure();
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  check("edgeToolbarCenteredWhenRoom", near(normal.x + normal.w / 2, normal.sel.x + normal.sel.w / 2) && normal.lines.every((n) => n === 1), normal);
  /** pan the camera (wheel over empty canvas) so the selection's top-left corner lands at (sx, sy), then check the bar */
  const at = async (name: string, sx: number, sy: number, overflow: (s: Box) => boolean) => {
    const s = (await measure()).sel;
    await page.mouse.move(s.x + s.w / 2 > W / 2 ? 60 : W - 60, 450);
    await page.mouse.wheel(s.x - sx, s.y - sy);
    await until(h, `${name}: the camera has panned`, async () => { const t = (await measure()).sel; return near(t.x, sx) && near(t.y, sy); });
    await idle(h);
    const m = await measure();
    check(`${name}-wouldOverflow`, overflow(m.sel), "the centred bar would cross the edge here", m.sel);
    check(`${name}-oneLine`, near(m.w, normal.w) && near(m.h, normal.h) && m.lines.every((n) => n === 1) && m.btnH.every((v, i) => near(v, normal.btnH[i])) && m.iconW.every((v, i) => near(v, normal.iconW[i])), { normal, m });
    check(`${name}-inside`, m.x >= PAD - 0.5 && m.y >= CHROME_Y - 0.5 && m.x + m.w <= W - PAD + 0.5 && m.y + m.h <= H - CHROME_Y + 0.5 && !m.covered, m);
    return m;
  };
  // right edge, the bar above the cards
  const r = await at("edgeRight", W - 280, 200, (s) => s.x + s.w / 2 + normal.w / 2 > W);
  check("edgeRight-hugsEdge", near(r.x + r.w, W - PAD), r);
  await shot(h, "selectionToolbar-right");
  // left edge
  const l = await at("edgeLeft", -260, 200, (s) => s.x + s.w / 2 - normal.w / 2 < 0);
  check("edgeLeft-hugsEdge", near(l.x, PAD), l);
  // the cards' top under the title bar: the bar goes below them, and that is past the bottom toolbar
  const d = await at("edgeBottom", 400, 20, (s) => s.y + s.h + 12 + normal.h > H - CHROME_Y);
  check("edgeBottom-hugsEdge", near(d.y + d.h, H - CHROME_Y), d);
  await shot(h, "selectionToolbar-bottom");
  // the cards just above the top edge: the bar below them would be above it
  const u = await at("edgeTop", 400, -20 - d.sel.h, (s) => s.y + s.h + 12 < 0);
  check("edgeTop-hugsEdge", near(u.y, CHROME_Y), u);
});

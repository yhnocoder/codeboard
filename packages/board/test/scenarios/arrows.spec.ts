import { shot, symCard, findSym, put, OUT, type Host } from "../harness";
import { emptyBoard, type Board, type CodeCard, type Link } from "@codeboard/core";
import * as fs from "node:fs";
import * as path from "node:path";
import { test, open, check, light, until, idle, hold } from "../fixtures";
import { LINK_LEAVE } from "../../src/state/timing";

const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; const i = s.text.findIndex((t) => re.test(t)); return s.start + Math.max(0, i); };
const close = (h: Host) => h.page.context().close();
const selected = (h: Host) => h.page.locator(".card.sel").evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.id));

/** step → schedule, step → postprocess, postprocess → schedule (schedule has two callers) */
function graphBoard(): { b: Board; step: CodeCard; sch: CodeCard; post: CodeCard } {
  const b = emptyBoard("b1", "arrows");
  const step = card("LLMEngine.step"), sch = card("Scheduler.schedule"), post = card("Scheduler.postprocess");
  put(b, step, 80, 80, 600); put(b, sch, 780, 60, 560); put(b, post, 140, 520, 560);
  const s0 = step.segments[0];
  b.links.push({ id: "L1", from: { card: step.id, seg: s0.id, line: lineOf(step, /scheduler\.schedule\(/) }, to: { card: sch.id }, call: { name: "schedule", col: 0 } });
  b.links.push({ id: "L2", from: { card: step.id, seg: s0.id, line: lineOf(step, /scheduler\.postprocess\(/) }, to: { card: post.id }, call: { name: "postprocess", col: 0 } });
  b.links.push({ id: "L3", from: { card: post.id, seg: post.segments[0].id, line: post.segments[0].start + 1 }, to: { card: sch.id }, call: { name: "schedule", col: 0 } });
  b.cam = { x: 0, y: 0, z: 0.8 };
  return { b, step, sch, post };
}

/** One mark per graph on every card; "← 2" on a card with two incoming arrows; jump from the list, then ⌃- / ⌃⇧- */
test("graphMarksLinked", async () => {
  const { b, step, sch } = graphBoard();
  const h = await open({ board: b, light, w: 1500, h: 950 });
  const marks = await h.page.locator(".card .chead .step").allTextContents();
  const badge = await h.page.locator(`.card[data-id="${sch.id}"] .linkedin`).textContent();
  await h.page.locator(`.card[data-id="${sch.id}"] .chead .ctitle`).click(); await h.page.locator(`.card.sel[data-id="${sch.id}"]`).waitFor();
  await h.page.locator(`.card[data-id="${sch.id}"] .linkedin`).click(); await h.page.locator(".pop .cand .lb").first().waitFor(); await idle(h);
  const items = await h.page.locator(".pop .cand .lb").allTextContents();
  await shot(h, "arrows-linked-1");
  await h.page.locator(".pop .cand", { hasText: "LLMEngine.step" }).click(); await idle(h);
  const s1 = await selected(h);
  const bar = await h.page.locator(".navbar").count();
  await h.page.keyboard.press("Control+Alt+Minus"); await idle(h);
  const s2 = await selected(h);
  await h.page.keyboard.press("Control+Alt+Shift+Minus"); await idle(h);
  const s3 = await selected(h);
  const ok = marks.length === 3 && marks.every((m) => m === "A") && badge?.trim() === "← 2" && items.length === 2
    && s1.join() === step.id && s2.join() === sch.id && s3.join() === step.id && bar === 0;
  check("linked-here", ok, JSON.stringify({ marks, badge, items, s1: s1.join() === step.id, s2: s2.join() === sch.id, s3: s3.join() === step.id, bar }));
  await close(h);
});

/** Click the mark → picker; a letter is stored on the board under the graph's oldest card and shown on every card; Auto puts it back */
test("graphMarkPicker", async () => {
  const { b, step } = graphBoard();
  const h = await open({ board: b, light, w: 1500, h: 950 });
  await h.page.locator(`.card[data-id="${step.id}"] .chead .step`).click(); await h.page.locator(".pop.k-mark").waitFor();
  const pop = await h.page.locator(".pop.k-mark").count();
  await shot(h, "arrows-mark-1");
  await h.page.locator(".pop.k-mark .markgrid button", { hasText: /^Q$/ }).click();
  await until(h, "the picked letter is saved", () => h.board().marks); await idle(h);
  const stored = JSON.stringify(h.board().marks);
  const marks = await h.page.locator(".card .chead .step").allTextContents();
  await h.page.locator(`.card[data-id="${step.id}"] .chead .step`).click();
  await h.page.locator(".pop.k-mark .markgrid.icons button").first().click(); await idle(h);
  const icons = await h.page.locator(".card .chead .step .glyph").count();
  await shot(h, "arrows-mark-2");
  await h.page.locator(`.card[data-id="${step.id}"] .chead .step`).click();
  await h.page.locator(".pop.k-mark .cand", { hasText: "Auto" }).click();
  await until(h, "Auto clears the stored mark", () => !h.board().marks); await idle(h);
  const back = await h.page.locator(".card .chead .step").allTextContents();
  const ok = pop === 1 && stored === JSON.stringify({ [step.id]: { letter: "Q" } }) && marks.join() === "Q,Q,Q" && icons === 3 && back.join() === "A,A,A" && !h.board().marks;
  check("graph-mark", ok, JSON.stringify({ pop, stored, marks, icons, back, after: h.board().marks }));
  await close(h);
});

/** Walkthrough from the selected card: Call arrows depth-first, then plain arrows */
test("walkthroughOrder", async () => {
  const b = emptyBoard("b1", "walk");
  const step = card("LLMEngine.step"), sch = card("Scheduler.schedule"), alloc = card("BlockManager.allocate");
  put(b, step, 80, 80, 600); put(b, sch, 780, 60, 560); put(b, alloc, 1420, 60, 520);
  b.cards.push({ id: "note", kind: "note", md: "Why batches", bg: true }); b.place.note = { x: 140, y: 620, w: 280 };
  const s0 = step.segments[0];
  b.links.push({ id: "P", from: { card: step.id, seg: s0.id, line: s0.start + 1 }, to: { card: "note" } });
  b.links.push({ id: "C1", from: { card: step.id, seg: s0.id, line: lineOf(step, /scheduler\.schedule\(/) }, to: { card: sch.id }, call: { name: "schedule", col: 0 } });
  b.links.push({ id: "C2", from: { card: sch.id, seg: sch.segments[0].id, line: lineOf(sch, /allocate\(/) }, to: { card: alloc.id }, call: { name: "allocate", col: 0 } });
  b.cam = { x: 0, y: 0, z: 0.6 };
  const h = await open({ board: b, light, w: 1500, h: 950 });
  await h.page.locator(`.card[data-id="${step.id}"] .chead .ctitle`).click(); await h.page.locator(`.card.sel[data-id="${step.id}"]`).waitFor();
  await h.page.keyboard.press("p"); await h.page.locator(".present .ptitle").waitFor(); await idle(h);
  const titles: string[] = [];
  for (let i = 0; i < 4; i++) { titles.push((await h.page.locator(".present .ptitle").textContent()) ?? ""); await h.page.keyboard.press("ArrowRight"); await idle(h); }
  const cnt = await h.page.locator(".present .cnt").textContent();
  await h.page.keyboard.press("Escape");
  const ok = titles.join() === "LLMEngine.step,Scheduler.schedule,BlockManager.allocate,Why batches" && cnt === "4 / 4";
  check("walk-order", ok, JSON.stringify({ titles, cnt }));
  await close(h);
});

/**
 * Arrow sides: the 4×4 grid of A (line/card ends × target right / left / below-right / below-left), hysteresis while dragging (B),
 * converging arrows merged into one head (C), Compare column sides and the gutter line (E), plus review screenshots
 */
test("arrowSides", async () => {
  const out = process.env.ROUTING_OUT ?? path.join(OUT, "arrow-routing");
  fs.mkdirSync(out, { recursive: true });
  const save = async (h: Host, name: string, clip?: { x: number; y: number; width: number; height: number }) => { await idle(h); await h.page.screenshot({ path: path.join(out, `${name}.png`), clip }); };
  const sidesOf = (h: Host) => h.page.evaluate(() => Object.fromEntries([...document.querySelectorAll<SVGGElement>("g.link")].map((g) => [g.dataset.lk!, g.dataset.sides!])));
  const results: Record<string, boolean> = {};
  const ln = (c: CodeCard, d: number) => c.segments[0].start + d;
  const end = (c: CodeCard, line?: number) => (line === undefined ? { card: c.id } : { card: c.id, seg: c.segments[0].id, line });

  // A: 4 rows (line→line, line→card, card→line, card→card) × 4 columns (right, left, below-right, below-left)
  {
    const b = emptyBoard("b1", "sides");
    const CW = 1000, CH = 640;
    const lay: [number, number, number, number][] = [[0, 0, 520, 80], [520, 0, 0, 80], [0, 0, 200, 340], [300, 0, 100, 340]];
    const rows = [["line", "line"], ["line", "card"], ["card", "line"], ["card", "card"]] as const;
    const want = [["right|left", "left|right", "right|right", "left|left"], ["right|left", "left|right", "right|right", "left|left"], ["right|left", "left|right", "right|right", "left|left"], ["right|left", "left|right", "bottom|top", "bottom|top"]];
    rows.forEach(([fk, tk], ri) => lay.forEach(([sx, sy, tx, ty], ci) => {
      const s = card("Sequence.append_token"), t = card("Block.update");
      const ox = 60 + ci * CW, oy = 60 + ri * CH;
      put(b, s, ox + sx, oy + sy, 320); put(b, t, ox + tx, oy + ty, 300);
      b.links.push({ id: `A${ri}${ci}`, from: end(s, fk === "line" ? ln(s, 2) : undefined), to: end(t, tk === "line" ? ln(t, 1) : undefined) });
    }));
    b.cam = { x: 0, y: 0, z: 0.6 };
    const h = await open({ board: b, light: true, w: 2440, h: 1600 });
    await idle(h);
    const got = await sidesOf(h);
    const bad: string[] = [];
    rows.forEach((_, ri) => lay.forEach((_, ci) => { const g = got[`A${ri}${ci}`]; if (g !== want[ri][ci]) bad.push(`A${ri}${ci}: ${g} ≠ ${want[ri][ci]}`); }));
    results.gridSides = !bad.length;
    check("w03-a-sides", !(bad.length), JSON.stringify(bad.length ? bad : got));
    await save(h, "w03-a-grid");
    const z = 0.6;
    for (let ri = 0; ri < 4; ri++) for (let ci = 0; ci < 4; ci++) await save(h, `w03-a-${["ll", "lc", "cl", "cc"][ri]}-${["right", "left", "below-right", "below-left"][ci]}`, { x: (30 + ci * CW) * z, y: (30 + ri * CH) * z, width: CW * z, height: CH * z });
    await close(h);
  }

  // B: hysteresis while dragging the target (line → line)
  {
    const b = emptyBoard("b1", "hyst");
    const s = card("Sequence.append_token"), t = card("Block.update");
    put(b, s, 400, 100, 320); put(b, t, 820, 160, 300);
    b.links.push({ id: "H", from: end(s, ln(s, 2)), to: end(t, ln(t, 1)) });
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light: true, w: 1300, h: 700 });
    const hd = (await h.page.locator(`.card[data-id="${t.id}"] .chead`).boundingBox())!;
    const x0 = hd.x + 60, y0 = hd.y + 10;
    const seq: [number, string][] = [];
    await h.page.mouse.move(x0, y0); await h.page.mouse.down();
    const step = async (dx: number, name: string) => {
      for (let i = 1; i <= 3; i++) await h.page.mouse.move(x0 + dx, y0 + 2 * i);
      await idle(h); // the card has followed the pointer and the arrow's ends have slid to their sides
      seq.push([dx, (await sidesOf(h)).H]);
      await save(h, `w03-b-${name}`);
    };
    await step(0, "1-right");          // gap 100: facing sides
    await step(-92, "2-in-buffer");    // gap 8: inside the 16px buffer, no switch yet
    await step(-150, "3-past-buffer"); // overlap: same side (C shape)
    await step(-92, "3b-back-into-buffer"); // gap 8 again: stays on the same side
    // slide: right after the switch the end is still on its way
    await h.page.mouse.move(x0 - 70, y0 + 8);
    const early = await h.page.evaluate(() => document.querySelector<SVGPathElement>('g.link[data-lk="H"] path.edge')!.getAttribute("d"));
    await idle(h);
    const late = await h.page.evaluate(() => document.querySelector<SVGPathElement>('g.link[data-lk="H"] path.edge')!.getAttribute("d"));
    seq.push([-70, (await sidesOf(h)).H]);
    await step(-800, "4-left");        // far left: start left, end right
    await h.page.mouse.up(); await idle(h);
    const want = ["right|left", "right|left", "right|right", "right|right", "right|left", "left|right"];
    results.hysteresis = seq.map((x) => x[1]).join() === want.join();
    check("w03-b-hysteresis", results.hysteresis, JSON.stringify(seq));
    results.slide = early !== late;
    check("w03-b-slide", results.slide, JSON.stringify({ early, late }));
    await close(h);
  }

  // C: converging arrows → one stub and one head (to a card heading, and to one line); several from one line share the start
  {
    const b = emptyBoard("b1", "merge");
    const dst = card("BlockManager.allocate"), dl = card("BlockManager.deallocate");
    put(b, dst, 600, 120, 420); put(b, dl, 1700, 120, 420);
    const srcs = [0, 1, 2].map((i) => { const c = card("Block.update"); put(b, c, 80, 60 + i * 230, 300); return c; });
    const srcs2 = [0, 1, 2].map((i) => { const c = card("Block.reset"); put(b, c, 1180, 60 + i * 230, 300); return c; });
    srcs.forEach((c, i) => b.links.push({ id: `M${i}`, from: end(c, ln(c, 1)), to: end(dst) }));
    srcs2.forEach((c, i) => b.links.push({ id: `N${i}`, from: end(c, i === 1 ? undefined : ln(c, 1)), to: end(dl, ln(dl, 3)) }));
    // one line, three targets: share one start point
    const fan = card("Sequence.append_token"); put(b, fan, 80, 820, 320);
    const tg = [0, 1, 2].map((i) => { const c = card("Block.reset"); put(b, c, 640, 760 + i * 170, 280); return c; });
    tg.forEach((c, i) => b.links.push({ id: `F${i}`, from: end(fan, ln(fan, 2)), to: end(c) }));
    b.cam = { x: 0, y: 0, z: 0.7 };
    const h = await open({ board: b, light: true, w: 1700, h: 1100 });
    await idle(h);
    const info = await h.page.evaluate(() => ({
      merges: [...document.querySelectorAll<SVGGElement>("g.merge")].map((g) => ({ card: g.dataset.card, line: g.dataset.line ?? null, n: g.dataset.n, heads: g.querySelectorAll(".ahead.end").length })),
      ownHeads: [...document.querySelectorAll<SVGGElement>("g.link")].filter((g) => /^[MN]/.test(g.dataset.lk!)).map((g) => g.querySelectorAll(".ahead.end").length).reduce((a, b) => a + b, 0),
      starts: [...new Set([...document.querySelectorAll<SVGGElement>("g.link")].filter((g) => /^F/.test(g.dataset.lk!)).map((g) => g.querySelector("path.edge")!.getAttribute("d")!.split(" C")[0]))],
    }));
    results.merged = info.merges.length === 2 && info.merges.every((m) => m.n === "3" && m.heads === 1) && info.ownHeads === 0 && info.starts.length === 1;
    check("w03-c-merged-heads", results.merged, JSON.stringify(info));
    await save(h, "w03-c-merged");
    await close(h);
  }

  // D: slight misalignment, the arrow comes in at an angle (≤ 45°) instead of bending hard
  {
    const b = emptyBoard("b1", "tilt");
    const pairs: [number, number, number, number][] = [[420, 80, 80, 140], [1060, 60, 720, 200], [1560, 40, 1300, 230]];
    pairs.forEach(([sx, sy, tx, ty], i) => { const s = card("Block.update"), t = card("Block.reset"); put(b, s, sx, sy, 220); put(b, t, tx, ty, 220); b.links.push({ id: `D${i}`, from: end(s, ln(s, 1)), to: end(t, ln(t, 1)) }); });
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light: true, w: 1900, h: 500 });
    await save(h, "w03-d-tilt");
    await close(h);
  }

  // E: Compare columns (left column → left side only, right → right), gutter line between columns, self-link arc, styles
  {
    const b = emptyBoard("b1", "compare");
    const cl = card("BlockManager.can_allocate"), cr = card("BlockManager.allocate");
    b.cards.push(cl, cr, { id: "K", kind: "compare", cols: [cl.id, cr.id] });
    b.place.K = { x: 500, y: 80, w: 1000 };
    const src = card("Block.update"); put(b, src, 60, 500, 300);
    const dst = card("Block.reset"); put(b, dst, 1700, 200, 300);
    const self = card("Sequence.append_token"); put(b, self, 60, 120, 340);
    b.links.push({ id: "EL", from: end(src, ln(src, 1)), to: end(cl, ln(cl, 3)) });
    b.links.push({ id: "ER", from: end(src, ln(src, 2)), to: end(cr, ln(cr, 4)) });
    b.links.push({ id: "EO", from: end(cr, ln(cr, 6)), to: end(dst) });
    b.links.push({ id: "EG", from: end(cl, ln(cl, 5)), to: end(cr, ln(cr, 8)) });
    b.links.push({ id: "ES", from: end(self, ln(self, 1)), to: end(self, ln(self, 4)), style: { width: 3, dash: true, color: "blue", head: { start: true, end: true } } });
    b.cam = { x: 0, y: 0, z: 0.75 };
    const h = await open({ board: b, light: true, w: 1600, h: 900 });
    await idle(h);
    const got = await sidesOf(h);
    const gutterHeads = await h.page.locator('g.link[data-lk="EG"] .ahead').count();
    const cmpline = await h.page.locator('g.link[data-lk="EG"] path.edge.cmpline').count();
    results.compare = got.EL?.endsWith("|left") && got.ER?.endsWith("|right") && got.EO?.startsWith("right|") && gutterHeads === 0 && cmpline === 1 && got.ES === "right|right";
    check("w03-e-compare", results.compare, JSON.stringify({ got, gutterHeads, cmpline }));
    await save(h, "w03-e-compare-self");
    // hidden target line (overview → map zoom): lands on the heading, same look
    await close(h);
  }
  {
    const b = emptyBoard("b1", "hidden");
    const s = card("Block.update"), t = card("BlockManager.allocate");
    put(b, s, 60, 160, 300); put(b, t, 560, 80, 420);
    t.segments[0].hidden = [[t.segments[0].start + 2, t.segments[0].start + 8]];
    b.links.push({ id: "HL", from: end(s, ln(s, 1)), to: end(t, ln(t, 5)) });
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light: true, w: 1100, h: 500 });
    await save(h, "w03-e-hidden-line");
    await close(h);
  }
  const ok = Object.values(results).every(Boolean);
  check("arrowSides", ok, JSON.stringify(results), "screenshots in", out);
});

/** Dots on a card's left / right edge sit on the heading row; a hand-dragged link starts on the dot it was dragged from */
test("dragLinkSide", async () => {
  const b = emptyBoard("b1", "dragside");
  const a = card("Sequence.append_token"), t = card("Block.update");
  put(b, a, 120, 120, 320); put(b, t, 760, 160, 300);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1300, h: 800 });
  const ca = h.page.locator(`.card[data-id="${a.id}"]`);
  const box = (await ca.boundingBox())!;
  await h.page.mouse.move(box.x + 100, box.y + 10); await ca.locator(".eport.l").waitFor(); await idle(h);
  const dot = (await ca.locator(".eport.l").boundingBox())!;
  const head = (await ca.locator(".chead").boundingBox())!;
  const onHead = dot.y + dot.height / 2 >= head.y && dot.y + dot.height / 2 <= head.y + head.height;
  const tb = (await h.page.locator(`.card[data-id="${t.id}"]`).boundingBox())!;
  const drag = async (from: { x: number; y: number; width: number; height: number }) => {
    const n = h.board().links.length;
    await h.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await h.page.mouse.down();
    await h.page.mouse.move(tb.x + 150, tb.y + 80, { steps: 10 }); await h.page.mouse.up();
    await until(h, "the dragged arrow is saved", () => h.board().links.length > n); await idle(h);
  };
  await drag(dot);
  // 行尾左边的圆点：先悬停那一行让圆点出来
  const row = (await ca.locator(".src .l").nth(2).boundingBox())!;
  await h.page.mouse.move(row.x + 100, row.y + row.height / 2); await ca.locator(".lport.l").waitFor(); await idle(h);
  await drag((await ca.locator(".lport.l").boundingBox())!);
  const links = h.board().links as Link[];
  const sides = await h.page.evaluate(() => [...document.querySelectorAll<SVGGElement>("g.link")].map((g) => g.dataset.sides));
  await shot(h, "arrows-dragside");
  const ok = onHead && links.length === 2 && links.every((l) => l.sides?.from === "left") && sides.every((x) => x?.startsWith("left|"));
  check("drag-side", ok, JSON.stringify({ onHead, dot: dot.y, head: [head.y, head.height], sides: links.map((l) => l.sides), drawn: sides }));
  await close(h);
});

/** Deep snippet: common indentation hidden, code starts near the left edge, fold lines show the hidden levels */
test("commonIndentHidden", async () => {
  const b = emptyBoard("b1", "dedent");
  const lm = card("load_model"), s = lm.segments[0];
  const k = s.text.findIndex((t) => /if k in weight_name/.test(t));
  s.text = s.text.slice(k, k + 7); s.start += k; s.end = s.start + 6;
  const plain = card("load_model");
  put(b, lm, 80, 80, 560); put(b, plain, 80, 360, 560);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 900, h: 640 });
  await idle(h);
  const left = (id: string) => h.page.evaluate((id) => { const c = document.querySelector(`.card[data-id="${id}"]`)!; const l = c.querySelector(".src .l")!; const r = document.createRange(); r.selectNodeContents(l); const tx = [...r.getClientRects()].find((q) => q.width > 0)!; const t = l.textContent!; const ind = t.length - t.trimStart().length; const sp = document.createRange(); sp.setStart(l.firstChild ?? l, 0); return { codeX: Math.round(c.querySelector(".src")!.getBoundingClientRect().left), firstX: Math.round(tx.left), ind, marks: c.querySelectorAll(".dedm").length }; }, id);
  const a = await left(lm.id), p = await left(plain.id);
  await shot(h, "arrows-dedent");
  const cw = await h.page.evaluate(() => { const s = document.createElement("span"); s.textContent = "x".repeat(100); document.querySelector(".src")!.appendChild(s); const w = s.getBoundingClientRect().width / 100; s.remove(); return w; });
  // 第一行 "if k in…" 的字落在离代码左边 ~16px 的地方，而不是 16 个空格之后
  const firstText = await h.page.evaluate((id) => { const l = document.querySelector(`.card[data-id="${id}"] .src .l`)!; const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT); let n: Node | null; while ((n = w.nextNode())) { const i = n.textContent!.search(/\S/); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); return Math.round(r.getBoundingClientRect().left); } } return -1; }, lm.id);
  const ok = a.marks === 1 && p.marks === 0 && firstText - a.codeX <= 18 && firstText - a.codeX >= 14;
  check("dedent", ok, JSON.stringify({ a, p, firstText, cw }));
  await close(h);
});

/** ModelRunner(...) links to ModelRunner.__init__ as a call: hand-drawn arrow gets the Call mark, both cards share a graph mark */
test("constructorCall", async () => {
  const b = emptyBoard("b1", "ctor");
  const eng = card("LLMEngine.__init__"), mr = card("ModelRunner.__init__");
  put(b, eng, 80, 80, 640); put(b, mr, 820, 300, 560);
  b.cam = { x: 0, y: 0, z: 0.8 };
  const h = await open({ board: b, light, w: 1500, h: 900 });
  const ce = h.page.locator(`.card[data-id="${eng.id}"]`);
  const row = ce.locator(".src .l", { hasText: "self.model_runner = ModelRunner(" });
  const rb = (await row.boundingBox())!;
  await h.page.mouse.move(rb.x + 100, rb.y + rb.height / 2); await ce.locator(".lport.r").waitFor(); await idle(h);
  const p = (await ce.locator(".lport.r").boundingBox())!;
  const tb = (await h.page.locator(`.card[data-id="${mr.id}"]`).boundingBox())!;
  await h.page.mouse.move(p.x + p.width / 2, p.y + p.height / 2); await h.page.mouse.down();
  await h.page.mouse.move(tb.x + 300, tb.y + 12, { steps: 10 }); await h.page.mouse.up();
  await until(h, "the drawn arrow is saved", () => h.board().links.length); await idle(h);
  const l = h.board().links[0] as Link | undefined;
  const marks = await h.page.locator(".card .chead .step").allTextContents();
  await shot(h, "arrows-ctor");
  const ok = !!l?.call && l.call.name === "ModelRunner" && marks.length === 2;
  check("ctor-call", ok, JSON.stringify({ call: l?.call, marks }));
  await close(h);
});

/** File path and version in the heading: drag moves the card, a plain click still opens */
test("headingDrag", async () => {
  const b = emptyBoard("b1", "headdrag");
  const a = card("load_model");
  put(b, a, 120, 120, 560);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1100, h: 700 });
  const ca = h.page.locator(`.card[data-id="${a.id}"]`);
  const moved: Record<string, number> = {};
  for (const sel of [".cpath", ".rev"]) {
    const x0 = h.board().place[a.id].x;
    const r = (await ca.locator(`.chead ${sel}`).first().boundingBox())!;
    await h.page.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await h.page.mouse.down();
    await h.page.mouse.move(r.x + r.width / 2 + 80, r.y + r.height / 2 + 40, { steps: 8 }); await h.page.mouse.up(); await idle(h); // the drop is sent at once
    moved[sel] = h.board().place[a.id].x - x0;
  }
  const menuAfterDrag = await h.page.locator(".pop").count();
  const r = (await ca.locator(".chead .rev").first().boundingBox())!;
  await h.page.mouse.click(r.x + r.width / 2, r.y + r.height / 2); await idle(h);
  const menuOnClick = await h.page.locator(".pop").count();
  const ok = moved[".cpath"] === 80 && moved[".rev"] === 80 && menuAfterDrag === 0 && menuOnClick > 0;
  check("head-drag", ok, JSON.stringify({ moved, menuAfterDrag, menuOnClick }));
  await close(h);
});

/** An arrow the code doesn't show as a call (Process(target=…), cross-language, string dispatch): right-click → Call Mark still marks it */
test("manualCallMark", async () => {
  const b = emptyBoard("b1", "manualcall");
  const eng = card("LLMEngine.__init__"), sch = card("Scheduler.schedule");
  put(b, eng, 80, 80, 640); put(b, sch, 860, 120, 560);
  b.links.push({ id: "LM", from: { card: eng.id, seg: eng.segments[0].id, line: lineOf(eng, /ctx\.Process\(/) }, to: { card: sch.id } });
  b.cam = { x: 0, y: 0, z: 0.8 };
  const h = await open({ board: b, light, w: 1500, h: 900 });
  const pt = await h.page.evaluate(() => {
    const p = document.querySelector<SVGPathElement>('path.lhit[data-link="LM"]')!, m = p.getScreenCTM()!;
    for (const f of [0.5, 0.4, 0.6, 0.3, 0.7]) { const q = p.getPointAtLength(p.getTotalLength() * f); const x = q.x * m.a + q.y * m.c + m.e, y = q.x * m.b + q.y * m.d + m.f; if ((document.elementFromPoint(x, y) as Element | null)?.closest("[data-link]")) return { x, y }; }
    return null;
  });
  await h.page.mouse.click(pt!.x, pt!.y, { button: "right" });
  await h.page.locator(".ctx").first().locator(":scope > button").first().waitFor(); await idle(h);
  const items = await h.page.locator(".ctx").first().locator(":scope > button").allTextContents();
  await h.page.locator(".ctx button", { hasText: "Call Mark" }).first().click();
  await until(h, "the Call Mark is saved", () => (h.board().links[0] as Link).call); await idle(h);
  const call = (h.board().links[0] as Link).call;
  const marks = await h.page.locator(".card .chead .step").allTextContents();
  await shot(h, "arrows-manualcall");
  const ok = items.some((t) => t.includes("Call Mark")) && call?.name === "schedule" && call.col === 0 && marks.length === 2;
  check("manual-call", ok, JSON.stringify({ items, call, marks }));
  await close(h);
});

/** 悬停一行、鼠标往右移到这一行的圆点：圆点一直在、行不变，邻行右边圆点上已经有箭头 */
test("linePortHover", async () => {
  const b = emptyBoard("b1", "lporthold");
  const eng = card("LLMEngine.__init__"), mr = card("ModelRunner.__init__");
  put(b, eng, 80, 80, 640); put(b, mr, 900, 60, 520);
  const s0 = eng.segments[0];
  b.links.push({ id: "A", from: { card: eng.id, seg: s0.id, line: s0.start + 2 }, to: { card: mr.id } });
  b.links.push({ id: "B", from: { card: eng.id, seg: s0.id, line: s0.start + 4 }, to: { card: mr.id } });
  b.links.push({ id: "C", from: { card: mr.id }, to: { card: eng.id } });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1500, h: 800 });
  const ce = h.page.locator(`.card[data-id="${eng.id}"]`);
  const row = (await ce.locator(".src .l").nth(3).boundingBox())!;
  // 停在行首缩进上（不在名字上，不弹 Peek）
  await h.page.mouse.move(row.x + 20, row.y + row.height / 2); await ce.locator(".lport.r").waitFor(); await idle(h);
  const port = () => ce.evaluate((c) => { const e = c.querySelector(".lport.r"); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const p = (await port())!;
  const py = p.y + p.height / 2, px = p.x + p.width / 2;
  // 一路往右挪到圆点中心，每一步记下圆点还在不在、在不在原来那一行
  const trail: string[] = [];
  let ok = true, shotAt = false;
  for (let x = row.x + 20; x <= px; x += 6) {
    await h.page.mouse.move(Math.min(x, px), py); await idle(h);
    const q = await port();
    const top = await h.page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y) as HTMLElement | null; return e ? e.tagName + "." + (e.getAttribute("class") ?? "") : "-"; }, [Math.min(x, px), py]);
    const same = !!q && Math.abs(q.y + q.height / 2 - py) < 1;
    if (!same) ok = false;
    if (Math.min(x, px) > px - 12 && !shotAt) { shotAt = true; await shot(h, "arrows-lporthold-1"); }
    trail.push(`${Math.round(Math.min(x, px) - px)}:${same ? "ok" : q ? "moved" : "gone"}:${top}`);
  }
  await hold(h, LINK_LEAVE + 100, "the port must still be there once a hover-leave delay would be over");
  const still = await port();
  if (!still || Math.abs(still.y + still.height / 2 - py) >= 1) ok = false;
  await shot(h, "arrows-lporthold-2");
  check("lport-hold", ok, JSON.stringify(trail.filter((t, i) => !t.includes(":ok:") || i > trail.length - 6)));
  await close(h);
});

/** 卡头那一行：有线头落在右边那个点上 → 右边圆点不画（不盖在箭头上），自己悬停时还亮；没有线头的一边照常 */
test("headPortHidden", async () => {
  const b = emptyBoard("b1", "eportland");
  const eng = card("LLMEngine.__init__"), mr = card("ModelRunner.__init__");
  put(b, eng, 80, 80, 640); put(b, mr, 900, 60, 520);
  b.links.push({ id: "C", from: { card: mr.id }, to: { card: eng.id } });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1500, h: 800 });
  const ce = h.page.locator(`.card[data-id="${eng.id}"]`), cm = h.page.locator(`.card[data-id="${mr.id}"]`);
  const op = (c: typeof ce, s: string) => c.locator(`.eport.${s}`).evaluate((e) => getComputedStyle(e).opacity);
  const sides = await h.page.locator("g.link").getAttribute("data-sides");
  const box = (await ce.boundingBox())!;
  await h.page.mouse.move(box.x + 200, box.y + 10); await idle(h);
  const r = await op(ce, "r"), l = await op(ce, "l");
  await shot(h, "arrows-eportland-1");
  const mb = (await cm.boundingBox())!;
  await h.page.mouse.move(mb.x + 200, mb.y + 10); await idle(h);
  const ml = await op(cm, "l"), mrr = await op(cm, "r");
  const dot = (await ce.locator(".eport.r").boundingBox())!;
  // 圆点外半边被线的点击区盖着，靠卡里的那半边悬停
  await h.page.mouse.move(dot.x + 2, dot.y + dot.height / 2); await idle(h);
  const rh = await op(ce, "r");
  await shot(h, "arrows-eportland-2");
  const ok = sides === "left|right" && r === "0" && l === "1" && ml === "0" && mrr === "1" && rh === "1";
  check("eport-land", ok, JSON.stringify({ sides, r, l, ml, mr: mrr, rh }));
  await close(h);
});

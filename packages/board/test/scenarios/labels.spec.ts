// one label box per arrow (↺ + own text, then arguments), drag along the arrow, Arrow / Label right-click menus (npm run harness -- arrowLabelsMenus)
import * as fs from "node:fs";
import { symCard, findSym, put, OUT, type Host } from "../harness";
import * as path from "node:path";
import { emptyBoard, type Board, type CodeCard, type Link } from "@codeboard/core";
import { test, open, check, light } from "../fixtures";

const SHOTS = process.env.LABEL_SHOTS ?? path.join(OUT, "arrow-labels");
const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; return s.start + s.text.findIndex((t) => re.test(t)); };
const colOf = (c: CodeCard, line: number, name: string) => c.segments[0].text[line - c.segments[0].start].indexOf(name);
const close = (h: Host) => h.page.context().close();
const SAVE = 1300; // the board saves after a quiet second; h.board() is the last save
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");


async function snap(h: Host, name: string) {
  await h.page.waitForTimeout(400);
  try { fs.mkdirSync(SHOTS, { recursive: true }); await h.page.screenshot({ path: `${SHOTS}/${name}.png` }); }
  catch (e) { console.log("(no screenshot)", (e as Error).message); }
}

/**
 * Scheduler.schedule with three arrows:
 *  LA allocate(seq, num_cached_blocks) → BlockManager.allocate: Call, ↺, own text, two arguments and one that is no longer in the code
 *  LB can_allocate(seq) → BlockManager.can_allocate: Call with ↺ only ("in a loop")
 *  LC a plain arrow to a Note with only own text
 */
function labelBoard() {
  const b = emptyBoard("b1", "labels");
  const sch = card("Scheduler.schedule"), alloc = card("BlockManager.allocate"), can = card("BlockManager.can_allocate");
  put(b, sch, 60, 60, 640); put(b, alloc, 1000, 40, 520); put(b, can, 1000, 560, 520);
  b.cards.push({ id: "note", kind: "note", md: "Why batches?", bg: true }); b.place.note = { x: 320, y: 1180, w: 240 };
  const s0 = sch.segments[0];
  const la = lineOf(sch, /block_manager\.allocate\(/), lb = lineOf(sch, /block_manager\.can_allocate\(/), lc = lineOf(sch, /remaining = /);
  b.links.push({ id: "LA", from: { card: sch.id, seg: s0.id, line: la }, to: { card: alloc.id }, label: "prefill only",
    call: { name: "allocate", col: colOf(sch, la, "allocate"), loop: true, vars: [{ a: "seq" }, { a: "num_cached_blocks" }, { a: "seq_group", b: "seq" }], cands: [{ a: "seq" }, { a: "num_cached_blocks" }] } });
  b.links.push({ id: "LB", from: { card: sch.id, seg: s0.id, line: lb }, to: { card: can.id }, call: { name: "can_allocate", col: colOf(sch, lb, "can_allocate"), loop: true } });
  b.links.push({ id: "LC", from: { card: sch.id, seg: s0.id, line: lc }, to: { card: "note" }, label: "why batches" });
  b.cam = { x: 20, y: 10, z: 0.72 };
  return { b, sch, alloc, can, lines: { la, lb, lc } };
}

const linkOf = (h: Host, id: string) => h.board().links.find((l) => l.id === id) as Link | undefined;
const box = (h: Host, id: string) => h.page.locator(`.vchips[data-link="${id}"]`);

/** A screen point on the arrow at fraction f of its length */
async function onArrow(h: Host, id: string, f: number) {
  return h.page.evaluate(([id, f]) => {
    const p = document.querySelector<SVGPathElement>(`path.lhit[data-link="${id}"]`)!;
    const q = p.getPointAtLength(p.getTotalLength() * (f as number)), m = p.getScreenCTM()!;
    return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f };
  }, [id, f] as const);
}
/** Screen distance from the label box centre to the nearest point of its arrow, and whether the box overlaps either card */
async function boxOnArrow(h: Host, id: string, cards: string[]) {
  return h.page.evaluate(([id, cards]) => {
    const p = document.querySelector<SVGPathElement>(`path.lhit[data-link="${id}"]`)!;
    const r = document.querySelector(`.vchips[data-link="${id}"]`)!.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, m = p.getScreenCTM()!, n = p.getTotalLength();
    let d = Infinity;
    for (let i = 0; i <= 400; i++) { const q = p.getPointAtLength((n * i) / 400); d = Math.min(d, Math.hypot(q.x * m.a + q.y * m.c + m.e - cx, q.x * m.b + q.y * m.d + m.f - cy)); }
    const hit = (cards as string[]).some((c) => { const k = document.querySelector(`.card[data-id="${c}"]`)!.getBoundingClientRect(); return r.right > k.left && r.left < k.right && r.bottom > k.top && r.top < k.bottom; });
    return { d: Math.round(d * 10) / 10, hit };
  }, [id, cards] as const);
}
/** Click a menu path: ["Width", "Bold 3px"] hovers Width and clicks Bold 3px */
async function pick(h: Host, path: string[]) {
  for (let i = 0; i < path.length; i++) {
    const btn = h.page.locator(".ctx").nth(i).locator("button", { has: h.page.locator(".lb", { hasText: new RegExp(`^${esc(path[i])}$`) }) });
    if (i < path.length - 1) { await btn.hover(); await h.page.waitForTimeout(150); } else await btn.click();
  }
  await h.page.waitForTimeout(SAVE);
}
const menuLabels = (h: Host, n = 0) => h.page.locator(".ctx").nth(n).locator("button .lb").allTextContents();
async function arrowMenu(h: Host, id: string, f = 0.2) {
  // a point on the arrow that nothing covers (label box, card)
  let p = await onArrow(h, id, f);
  for (const g of [f, 0.15, 0.25, 0.35, 0.65, 0.75, 0.85, 0.1, 0.9]) {
    const q = await onArrow(h, id, g);
    const top = await h.page.evaluate(([x, y]) => (document.elementFromPoint(x, y) as Element | null)?.closest("[data-link]")?.tagName ?? "", [q.x, q.y] as const);
    if (top === "path") { p = q; break; }
  }
  await h.page.mouse.click(p.x, p.y, { button: "right" }); await h.page.waitForTimeout(250);
}
async function labelMenu(h: Host, id: string) { await box(h, id).click({ button: "right", position: { x: 8, y: 6 } }); await h.page.waitForTimeout(250); }

test("arrowLabelsMenus", async () => {
  const { b, sch, alloc, can, lines } = labelBoard();
  const h = await open({ board: b, light, w: 1500, h: 950 });

  // ---- the three kinds (W01 C 13–16) and vanished arguments ----
  const A = box(h, "LA"), B = box(h, "LB"), C = box(h, "LC");
  const kinds = {
    boxes: await h.page.locator(".vchips").count(),
    aLoop: await A.locator(".vloop").count(), aText: await A.locator(".vlabel").textContent(), aRows: await A.locator(".vrow").allTextContents(), aGone: await A.locator(".vrow.gone").allTextContents(),
    bText: await B.locator(".vloop").textContent(), bRows: await B.locator(".vrow").count(), bTip: await B.locator(".vloop").getAttribute("data-tip"),
    cText: await C.locator(".vlabel").textContent(), cLoop: await C.locator(".vloop").count(),
  };
  check("label-kinds", kinds.boxes === 3 && kinds.aLoop === 1 && kinds.aText === "prefill only" && kinds.aRows.length === 3 && kinds.aGone.length === 1 && /seq_group/.test(kinds.aGone[0])
    && kinds.bText === "↺in a loop" && kinds.bRows === 0 && /^In a loop · L30 /.test(kinds.bTip ?? "") && kinds.cText === "why batches" && kinds.cLoop === 0, kinds);
  // same name once, a → b when the names differ
  check("arg-rows", kinds.aRows[0] === "seq" && kinds.aRows[2] === "seq_group→seq", kinds.aRows);
  await snap(h, "labels-1-kinds");
  {
    // close-up of the boxes for review
    const a = (await A.boundingBox())!;
    await h.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 60);
    await h.page.keyboard.down("Control"); for (let i = 0; i < 2; i++) await h.page.mouse.wheel(0, -40); await h.page.keyboard.up("Control");
    await h.page.waitForTimeout(300);
    await snap(h, "labels-1b-closeup");
    await h.page.keyboard.down("Control"); for (let i = 0; i < 2; i++) await h.page.mouse.wheel(0, 40); await h.page.keyboard.up("Control");
    await h.page.waitForTimeout(300);
  }

  // hover an argument: its names light up in both cards (W01 C 17)
  await A.locator(".vrow").first().hover(); await h.page.waitForTimeout(150);
  const hiFrom = await h.page.locator(`.card[data-id="${sch.id}"] .rowbg.vhi`).count(), hiTo = await h.page.locator(`.card[data-id="${alloc.id}"] .rowbg.vhi`).count();
  check("arg-hover-highlight", hiFrom > 0 && hiTo > 0, { hiFrom, hiTo });
  await snap(h, "labels-2-arg-hover");
  await h.page.mouse.move(5, 900); await h.page.waitForTimeout(400);

  // hover the arrow: "+" opens the Arguments picker with the candidates (W01 C 18)
  const pB = await onArrow(h, "LB", 0.3);
  await h.page.mouse.move(pB.x, pB.y); await h.page.waitForTimeout(150);
  await h.page.locator(".vplus").first().click(); await h.page.waitForTimeout(300);
  const picker = { title: await h.page.locator(".pop.k-vars .picker-h").textContent(), n: await h.page.locator(".pop.k-vars").count() };
  check("plus-opens-arguments", picker.n === 1 && picker.title === "Arguments", picker);
  await h.page.keyboard.press("Escape"); await h.page.mouse.click(5, 900); await h.page.waitForTimeout(200);

  // zoomed out: arguments collapse, ↺ and own text stay
  {
    const lb = h.page.locator(".lyr").first();
    await h.page.mouse.move(700, 500);
    await h.page.keyboard.down("Control"); for (let i = 0; i < 2; i++) await h.page.mouse.wheel(0, 20); await h.page.keyboard.up("Control");
    await h.page.waitForTimeout(500);
    const lod = await lb.getAttribute("class");
    const rowsShown = await A.locator(".vbox").evaluate((e) => getComputedStyle(e).display !== "none");
    const headShown = await A.locator(".vhead").evaluate((e) => getComputedStyle(e).display !== "none");
    check("lod-collapses-args", /lod-overview/.test(lod ?? "") && !rowsShown && headShown, { lod, rowsShown, headShown });
    await snap(h, "labels-3-zoomed-out");
    await h.page.keyboard.down("Control"); for (let i = 0; i < 2; i++) await h.page.mouse.wheel(0, -20); await h.page.keyboard.up("Control");
    await h.page.waitForTimeout(500);
  }

  // ---- drag along the arrow, ratio kept when a card moves (W01 C 19–20) ----
  const r0 = (await A.boundingBox())!;
  await h.page.mouse.move(r0.x + 12, r0.y + 8); await h.page.mouse.down();
  await h.page.mouse.move(r0.x + 400, r0.y - 300, { steps: 10 }); await h.page.mouse.up(); await h.page.waitForTimeout(SAVE);
  const at1 = linkOf(h, "LA")?.at;
  const on1 = await boxOnArrow(h, "LA", [sch.id, alloc.id]);
  check("drag-along-arrow", at1 !== undefined && at1 > 0.5 && on1.d < 4 && !on1.hit, { at1, ...on1 });
  // pull it hard onto the target card: it stops before the card
  const r1 = (await A.boundingBox())!;
  await h.page.mouse.move(r1.x + 12, r1.y + 8); await h.page.mouse.down();
  await h.page.mouse.move(r1.x + 900, r1.y - 200, { steps: 10 }); await h.page.mouse.up(); await h.page.waitForTimeout(SAVE);
  const at2 = linkOf(h, "LA")?.at;
  const on2 = await boxOnArrow(h, "LA", [sch.id, alloc.id]);
  check("drag-stops-off-card", at2 !== undefined && at2 < 1 && on2.d < 4 && !on2.hit, { at2, ...on2 });
  // move the target card: the ratio stays and the box rides the arrow
  const hd = h.page.locator(`.card[data-id="${alloc.id}"] .chead`);
  const hb = (await hd.boundingBox())!;
  await h.page.mouse.move(hb.x + 60, hb.y + 10); await h.page.mouse.down();
  await h.page.mouse.move(hb.x + 60 + 150, hb.y + 10 + 220, { steps: 8 }); await h.page.mouse.up(); await h.page.waitForTimeout(SAVE);
  const at3 = linkOf(h, "LA")?.at;
  const on3 = await boxOnArrow(h, "LA", [sch.id, alloc.id]);
  const moved = h.board().place[alloc.id].y !== b.place[alloc.id].y;
  check("ratio-after-card-move", moved && at3 === at2 && on3.d < 4 && !on3.hit, { moved, at3, ...on3 });
  await snap(h, "labels-4-dragged");

  // ---- Label menu (W01 D 23) ----
  await labelMenu(h, "LA");
  const lm = await menuLabels(h);
  check("label-menu-items", lm.join("|") === "Edit Label|Arguments…|Loop Mark|Reset Label Position|Delete Label", lm);
  await snap(h, "labels-5-label-menu");
  await pick(h, ["Reset Label Position"]);
  check("reset-label-position", linkOf(h, "LA")?.at === undefined, { at: linkOf(h, "LA")?.at });
  await labelMenu(h, "LA"); await pick(h, ["Loop Mark"]);
  const loopOff = linkOf(h, "LA")?.call?.loop, loopEl = await A.locator(".vloop").count();
  await labelMenu(h, "LA"); await pick(h, ["Loop Mark"]);
  check("loop-mark-toggle", !loopOff && loopEl === 0 && linkOf(h, "LA")?.call?.loop === true, { loopOff, loopEl, back: linkOf(h, "LA")?.call?.loop });
  await labelMenu(h, "LA"); await pick(h, ["Arguments…"]);
  check("label-menu-arguments", await h.page.locator(".pop.k-vars").count() === 1, {});
  await h.page.keyboard.press("Escape"); await h.page.mouse.click(5, 900); await h.page.waitForTimeout(200);
  await labelMenu(h, "LC");
  const lmPlain = await menuLabels(h);
  await pick(h, ["Edit Label"]);
  const editingNow = await C.locator(".vlabel.editing").count();
  await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(200);
  check("label-menu-plain", lmPlain.join("|") === "Edit Label|Reset Label Position|Delete Label" && editingNow === 1, { lmPlain, editingNow });
  await labelMenu(h, "LC"); await pick(h, ["Delete Label"]);
  const delLabel = linkOf(h, "LC")?.label;
  await h.page.keyboard.press("Meta+z"); await h.page.waitForTimeout(SAVE);
  check("delete-label-undo", delLabel === undefined && linkOf(h, "LC")?.label === "why batches", { delLabel, back: linkOf(h, "LC")?.label });
  // Enter on a selected arrow edits its label
  await C.click({ position: { x: 8, y: 6 } }); await h.page.keyboard.press("Enter"); await h.page.waitForTimeout(150);
  const enterEdits = await C.locator(".vlabel.editing").count();
  await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(150);
  check("enter-edits-label", enterEdits === 1, { enterEdits });

  // ---- Arrow menu (W01 D 22, 24, 25) ----
  await arrowMenu(h, "LA");
  const am = await menuLabels(h);
  // Mark as RPC…, ↩ Back to Start (call chains) and the Style presets
  check("arrow-menu-items", am.join("|") === "Call Mark|Mark as RPC…|↩ Back to Start|Style|Line|Width|Start|End|Color|Start Side|End Side|Reset Sides|Edit Label|Delete", am);
  await h.page.locator(".ctx").first().locator("button", { hasText: "End Side" }).hover(); await h.page.waitForTimeout(200);
  const endSides = await menuLabels(h, 1);
  await snap(h, "labels-6-arrow-menu");
  await h.page.locator(".ctx").first().locator("button", { hasText: "Start Side" }).hover(); await h.page.waitForTimeout(200);
  const startSides = await menuLabels(h, 1);
  check("side-options", endSides.join() === "Auto,Left,Right,Top,Bottom" && startSides.join() === "Auto,Left,Right", { startSides, endSides });
  await h.page.keyboard.press("Escape");
  const steps: [string[], (l: Link) => unknown, unknown][] = [
    [["Line", "Dashed"], (l) => l.style?.dash, true],
    [["Width", "Bold 3px"], (l) => l.style?.width, 3],
    [["Width", "Thin 1px"], (l) => l.style?.width, 1],
    [["Start", "Arrowhead"], (l) => l.style?.head?.start, true],
    [["End", "None"], (l) => l.style?.head?.end, false],
    [["Color", "Blue"], (l) => l.style?.color, "blue"],
    [["Start Side", "Left"], (l) => l.sides?.from, "left"],
    [["End Side", "Top"], (l) => l.sides?.to, "top"],
    [["Reset Sides"], (l) => l.sides, undefined],
    [["Line", "Solid"], (l) => l.style?.dash, undefined],
    [["Width", "Regular 2px"], (l) => l.style?.width, undefined],
  ];
  for (const [path, get, want] of steps) {
    await arrowMenu(h, "LA"); await pick(h, path);
    const got = get(linkOf(h, "LA")!);
    check(`arrow-menu ${path.join(" ▸ ")}`, got === want, { got, want });
  }
  await snap(h, "labels-7-styled");

  // Call Mark off: arguments and ↺ go, own text stays; on again: the mark comes back
  await arrowMenu(h, "LA"); await pick(h, ["Call Mark"]);
  const off = { call: linkOf(h, "LA")?.call, label: linkOf(h, "LA")?.label, rows: await A.locator(".vrow").count(), loop: await A.locator(".vloop").count(), text: await A.locator(".vlabel").textContent() };
  check("call-mark-off-keeps-text", off.call === undefined && off.label === "prefill only" && off.rows === 0 && off.loop === 0 && off.text === "prefill only", off);
  await snap(h, "labels-8-call-off");
  await arrowMenu(h, "LA");
  const offered = await menuLabels(h);
  await pick(h, ["Call Mark"]);
  check("call-mark-on", offered[0] === "Call Mark" && linkOf(h, "LA")?.call?.name === "allocate", { offered: offered[0], call: linkOf(h, "LA")?.call });
  // no Call Mark on an arrow whose from line does not call the target (a Note)
  await arrowMenu(h, "LC", 0.5);
  const noteMenu = await menuLabels(h);
  check("call-mark-only-when-calls", !noteMenu.includes("Call Mark") && noteMenu.includes("Edit Label"), noteMenu);
  await h.page.keyboard.press("Escape");
  // Add Label on an arrow without text, then Delete
  await arrowMenu(h, "LB", 0.3);
  await pick(h, ["Add Label"]);
  const adding = await B.locator(".vlabel.editing").count();
  await h.page.keyboard.type("checks free blocks"); await h.page.keyboard.press("Enter"); await h.page.waitForTimeout(SAVE);
  check("add-label", adding === 1 && linkOf(h, "LB")?.label === "checks free blocks", { adding, label: linkOf(h, "LB")?.label });
  await arrowMenu(h, "LB", 0.3); await pick(h, ["Delete"]);
  check("delete-arrow", !linkOf(h, "LB"), { left: h.board().links.map((l) => l.id) });
  void can; void lines;

  await close(h);
});

// Mark cards (the handwritten note beside Text and Note) and their hand-drawn arrows: no frame, handwriting font, the color dots,
// the width handle (text wraps, font size stays), double-click to edit, arrows drawn hand-style in the Mark's color and the
// same shape every time the cards come back to the same place.
// Usage: npm run harness -- markCard markArrowStable
// Screenshots: test-out/harness/marks-*.png (HARNESS_LIGHT=1 for the light theme)
import { shot, symCard, findSym, put, type Host } from "../harness";
import { emptyBoard, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import { test, open, check, light } from "../fixtures";

const sym = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; const i = s.text.findIndex((t) => re.test(t)); return s.start + Math.max(0, i); };
const card = (id: string) => `.card[data-id="${id}"]`;

/** LLMEngine.step and Scheduler.schedule, three Marks: m1 → a line of schedule, m2 → step's card, m3 with no arrow */
function markBoard(): { b: Board; step: CodeCard; sch: CodeCard } {
  const b = emptyBoard("b1", "marks");
  const step = sym("LLMEngine.step"), sch = sym("Scheduler.schedule");
  put(b, step, 60, 160, 560); put(b, sch, 780, 120, 560);
  const mark = (id: string, md: string, hand: NoteCard["hand"], x: number, y: number, w: number) => {
    b.cards.push({ id, kind: "note", md, bg: false, hand } as NoteCard);
    b.place[id] = { x, y, w };
  };
  mark("m1", "picks this batch", "blue", 420, 40, 200);
  mark("m2", "prefill / decode never share a batch", "purple", 300, 640, 180);
  mark("m3", "先挑这一批", "orange", 980, 640, 160);
  b.links.push({ id: "L1", from: { card: "m1" }, to: { card: sch.id, seg: sch.segments[0].id, line: lineOf(sch, /while/) } });
  b.links.push({ id: "L2", from: { card: "m2" }, to: { card: step.id } });
  b.links.push({ id: "L3", from: { card: step.id, seg: step.segments[0].id, line: lineOf(step, /scheduler\.schedule\(/) }, to: { card: sch.id }, call: { name: "schedule", col: 0 } });
  b.cam = { x: 0, y: 0, z: 0.9 };
  return { b, step, sch };
}
const linkPaths = (h: Host, id: string) => h.page.evaluate((id) => {
  const g = document.querySelector(`.link[data-lk="${id}"]`);
  return g ? [...g.querySelectorAll("path:not(.lhit)")].map((p) => ({ cls: p.getAttribute("class") ?? "", d: p.getAttribute("d") ?? "", stroke: getComputedStyle(p).stroke })) : [];
}, id);

/** A Mark has no frame and the handwriting font; its arrows are hand-drawn in its color; color dots, width handle, double-click */
test("markCard", async () => {
  const { b } = markBoard();
  const h = await open({ board: b, light, w: 1500, h: 950 });
  const pg = h.page;
  await pg.evaluate(() => document.fonts.ready);
  const look = await pg.evaluate((sel) => {
    const c = document.querySelector<HTMLElement>(sel)!, t = c.querySelector<HTMLElement>(".tx")!, cs = getComputedStyle(c), ts = getComputedStyle(t);
    return { cls: c.className, bg: cs.backgroundColor, shadow: cs.boxShadow, font: ts.fontFamily, size: ts.fontSize, color: ts.color };
  }, card("m1"));
  check("markNoFrame", /\bmark\b/.test(look.cls) && /rgba\(0, 0, 0, 0\)|transparent/.test(look.bg) && look.shadow === "none", look);
  check("markHandFont", /Shantell Sans/.test(look.font) && look.size === "18px", look);
  const fontsOk = await pg.evaluate(() => document.fonts.check('18px "Shantell Sans"') && document.fonts.check('18px "LXGW WenKai Lite"', "先挑"));
  check("markFontsBundled", fontsOk);
  const l1 = await linkPaths(h, "L1"), l3 = await linkPaths(h, "L3");
  const edge = l1.filter((p) => /\bedge\b/.test(p.cls));
  check("markArrowHand", edge.length === 2 && edge.every((p) => /\bhand\b/.test(p.cls)) && edge.some((p) => /\bp2\b/.test(p.cls)) && l1.some((p) => /\bahead\b/.test(p.cls)), l1.map((p) => p.cls));
  check("markArrowColor", edge[0]?.stroke === look.color, { arrow: edge[0]?.stroke, mark: look.color });
  check("plainArrowNotHand", l3.length > 0 && l3.every((p) => !/\bhand\b/.test(p.cls)), l3.map((p) => p.cls));
  check("markArrowNoMerge", (await pg.locator(`.link[data-lk="L1"]`).getAttribute("data-merged")) === null);
  await shot(h, "marks-board");

  // select: the color dots; purple → the Mark and its arrow change color
  await pg.locator(`${card("m1")} .tx`).click();
  await pg.waitForTimeout(200);
  check("markColorDots", (await pg.locator(`${card("m1")} .hdots .hdot`).count()) === 4);
  await shot(h, "marks-selected");
  await pg.locator(`${card("m1")} .hdot.hc-purple`).click();
  await pg.waitForTimeout(200);
  const after = await pg.evaluate((sel) => getComputedStyle(document.querySelector(sel)!).color, `${card("m1")} .tx`);
  const l1b = (await linkPaths(h, "L1")).find((p) => /\bedge\b/.test(p.cls));
  check("markRecolor", h.board().cards.find((c) => c.id === "m1")?.kind === "note" && (h.board().cards.find((c) => c.id === "m1") as NoteCard).hand === "purple" && after !== look.color && l1b?.stroke === after, { after, arrow: l1b?.stroke });

  // width handle: narrower → wraps onto more lines, font size unchanged
  const before = await pg.locator(card("m1")).boundingBox();
  const grip = await pg.locator(`${card("m1")} .mkgrip`).boundingBox();
  check("markGripShown", !!grip);
  if (grip && before) {
    await pg.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await pg.mouse.down();
    for (let i = 1; i <= 8; i++) await pg.mouse.move(grip.x + grip.width / 2 - i * 12, grip.y + grip.height / 2);
    await pg.mouse.up();
    await pg.waitForTimeout(250);
    const now = await pg.locator(card("m1")).boundingBox();
    const size = await pg.evaluate((sel) => getComputedStyle(document.querySelector(sel)!).fontSize, `${card("m1")} .tx`);
    check("markWidthWraps", (h.board().place.m1?.w ?? 999) < 200 && !!now && now.height > before.height + 10 && size === "18px", { w: h.board().place.m1?.w, before: before.height, after: now?.height, size });
  }

  // double-click edits in place
  await pg.locator(`${card("m3")} .tx`).dblclick();
  await pg.waitForSelector(`${card("m3")} .md-pm`, { timeout: 5000 });
  await pg.keyboard.press("End");
  await pg.keyboard.type(" ok");
  await pg.mouse.click(700, 880);
  await pg.waitForTimeout(300);
  const md3 = (h.board().cards.find((c) => c.id === "m3") as NoteCard | undefined)?.md;
  check("markEdit", md3 === "先挑这一批 ok", { md3 });
  await h.close();
});

/** The same arrow keeps the same hand-drawn shape: drag a card away and back, the path is the same string */
test("markArrowStable", async () => {
  const { b, sch } = markBoard();
  const h = await open({ board: b, light, w: 1500, h: 950 });
  const pg = h.page;
  const d0 = (await linkPaths(h, "L1")).map((p) => p.d).join("|");
  const head = await pg.locator(`${card(sch.id)} .chead .ctitle`).boundingBox();
  let moved = "";
  if (head) {
    const x = head.x + 20, y = head.y + head.height / 2;
    await pg.mouse.move(x, y); await pg.mouse.down();
    for (let i = 1; i <= 6; i++) await pg.mouse.move(x + i * 10, y + i * 15);
    moved = (await linkPaths(h, "L1")).map((p) => p.d).join("|");
    for (let i = 5; i >= 0; i--) await pg.mouse.move(x + i * 10, y + i * 15);
    await pg.mouse.up();
    await pg.waitForTimeout(300);
  }
  const d1 = (await linkPaths(h, "L1")).map((p) => p.d).join("|");
  check("markArrowFollows", !!moved && moved !== d0);
  check("markArrowStable", d0 === d1 && d0.length > 0, { d0: d0.slice(0, 120), d1: d1.slice(0, 120) });
  await h.close();
});

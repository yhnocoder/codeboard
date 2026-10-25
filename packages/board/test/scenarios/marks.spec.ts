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

/** {text|note} annotations in a Note: a label above (or below) the words in the hand font and color, only that line taller;
 *  typing the syntax in the editor turns it into an annotation */
test("noteAnnotations", async () => {
  const b = emptyBoard("b1", "annotations");
  const md = [
    "每一步先由 {Scheduler|决定谁先跑} 挑出这一批要跑的序列，再交给 ModelRunner {做一次前向|prefill / decode 二选一|purple below}，最后 postprocess 把新 token 接到序列后面。",
    "",
    "Prefill and decode {never share a batch|like this|green} in ==nano-vllm==.",
    "",
    "A plain line without annotations.",
  ].join("\n");
  b.cards.push({ id: "n1", kind: "note", md, bg: true } as NoteCard);
  b.place.n1 = { x: 80, y: 80, w: 520 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 900, h: 700 });
  const pg = h.page;
  await pg.evaluate(() => document.fonts.ready);
  const info = await pg.evaluate(() => [...document.querySelectorAll<HTMLElement>(".card .md-annot")].map((e) => {
    const b4 = getComputedStyle(e, "::before"), r = e.getBoundingClientRect();
    return { note: e.dataset.note, color: e.dataset.color ?? "blue", below: e.hasAttribute("data-below"), label: b4.content, font: b4.fontFamily, labelColor: b4.color, pt: getComputedStyle(e).paddingTop, pb: getComputedStyle(e).paddingBottom, h: r.height };
  }));
  check("annotRendered", info.length === 3 && info[0].note === "决定谁先跑" && info[1].below && info[2].color === "green", info);
  check("annotLabel", info.every((i) => i.label.includes(i.note!) && /Shantell Sans/.test(i.font)), info.map((i) => [i.label, i.font]));
  check("annotRail", parseFloat(info[0].pt) > 10 && parseFloat(info[1].pb) > 10 && parseFloat(info[1].pt) === 0, info.map((i) => [i.pt, i.pb]));
  check("annotHighlightSeparate", (await pg.locator(".card mark").count()) === 1);
  const lineH = await pg.evaluate(() => { const ps = [...document.querySelectorAll<HTMLElement>(".card .nbody p")]; return ps.map((p) => p.getBoundingClientRect().height); });
  check("annotOnlyAnnotatedLinesTaller", lineH.length === 3 && lineH[2] < lineH[1], lineH);
  await shot(h, "marks-note-annotations");

  // typing the syntax in the editor
  await pg.locator(`${card("n1")} .nbody p`).last().dblclick();
  await pg.waitForSelector(`${card("n1")} .md-pm`, { timeout: 5000 });
  await pg.keyboard.press("Control+End");
  await pg.keyboard.type(" Then {decode|one token each|orange}.");
  await pg.waitForTimeout(150);
  const live = await pg.locator(`${card("n1")} .md-pm .md-annot`).count();
  await pg.mouse.click(800, 650);
  await pg.waitForTimeout(400);
  const saved = (h.board().cards[0] as NoteCard).md;
  check("annotTyped", saved.includes("{decode|one token each|orange}") && (await pg.locator(`${card("n1")} .md-annot`).count()) === 4, { live, tail: saved.slice(-80) });
  await h.close();
});

/** Annotations on a code card: a rail above / below the line, the label over the words (by column, tabs and hidden indent
 *  included), the line's links still land on it; select words → right-click → Annotate Selection… → type → Enter */
test("codeAnnotations", async () => {
  const b = emptyBoard("b1", "code annotations");
  const sch = sym("Scheduler.schedule");
  const s = sch.segments[0];
  const lw = lineOf(sch, /while self\.waiting/), la = lineOf(sch, /block_manager\.can_allocate\(/);
  const tw = s.text[lw - s.start], ta = s.text[la - s.start];
  s.annots = [
    { line: lw, from: tw.indexOf("self.waiting"), to: tw.indexOf("self.waiting") + 12, text: "还没跑的请求" },
    { line: la, from: ta.indexOf("can_allocate"), to: ta.indexOf("can_allocate") + 12, text: "KV cache blocks", color: "purple", below: true },
  ];
  put(b, sch, 80, 60, 640);
  b.links.push({ id: "L1", from: { card: sch.id, seg: s.id, line: la }, to: { card: sch.id, seg: s.id, line: lw } });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1100, h: 900 });
  const pg = h.page;
  await pg.evaluate(() => document.fonts.ready);
  const geo = await pg.evaluate(({ id, lw, la }) => {
    const card = document.querySelector(`.card[data-id="${id}"]`)!;
    const rails = [...card.querySelectorAll<HTMLElement>(".arail")].map((r) => ({ below: r.classList.contains("below"), text: r.textContent, top: r.getBoundingClientRect().top }));
    const no = (n: number) => [...card.querySelectorAll<HTMLElement>(".gutter .no")].find((e) => e.textContent === String(n))!;
    const lineEl = (n: number) => card.querySelector<HTMLElement>(`.src > .l[data-r="${no(n).dataset.r}"]`)!;
    // where "self.waiting" actually is on the line
    const at = (el: HTMLElement, word: string) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n: Node | null, off = 0; const full = el.textContent!, i = full.indexOf(word);
      while ((n = w.nextNode())) { const len = (n as Text).length; if (off + len > i) { const r = document.createRange(); r.setStart(n, i - off); r.setEnd(n, i - off + 1); return r.getBoundingClientRect().left; } off += len; }
      return NaN;
    };
    const bgs = [...card.querySelectorAll<HTMLElement>(".abg")].map((e) => e.getBoundingClientRect());
    const labs = [...card.querySelectorAll<HTMLElement>(".alab")].map((e) => e.getBoundingClientRect());
    const lwEl = lineEl(lw), laEl = lineEl(la);
    return { rails, wordX: at(lwEl, "self.waiting"), allocX: at(laEl, "can_allocate"), bgs: bgs.map((r) => ({ left: r.left, top: r.top })), labs: labs.map((r) => ({ left: r.left, top: r.top, bottom: r.bottom })),
      lwTop: lwEl.getBoundingClientRect().top, laBottom: laEl.getBoundingClientRect().bottom, noTop: no(lw).getBoundingClientRect().top };
  }, { id: sch.id, lw, la });
  check("codeAnnotRails", geo.rails.length === 2 && !geo.rails[0].below && geo.rails[1].below && geo.rails[0].text?.includes("还没跑的请求"), geo.rails);
  check("codeAnnotAligned", Math.abs(geo.bgs[0].left - geo.wordX) < 2 && Math.abs(geo.labs[0].left - geo.wordX) < 4 && Math.abs(geo.bgs[1].left - geo.allocX) < 2, geo);
  check("codeAnnotRailPlace", geo.labs[0].bottom <= geo.lwTop + 1 && geo.labs[1].top >= geo.laBottom - 1, geo);
  check("codeAnnotGutterFollows", Math.abs(geo.noTop - geo.lwTop) < 2, geo);
  await shot(h, "marks-code-annotations");

  // select "scheduled_seqs" on the first body line, right-click, Annotate Selection…
  const l2 = s.start + 1;
  await pg.evaluate(({ id, l2 }) => {
    const card = document.querySelector(`.card[data-id="${id}"]`)!;
    const no = [...card.querySelectorAll<HTMLElement>(".gutter .no")].find((e) => e.textContent === String(l2))!;
    const el = card.querySelector<HTMLElement>(`.src > .l[data-r="${no.dataset.r}"]`)!;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let n: Node | null, off = 0; const i = el.textContent!.indexOf("scheduled_seqs");
    const r = document.createRange();
    while ((n = w.nextNode())) { const len = (n as Text).length; if (off + len > i) { r.setStart(n, i - off); break; } off += len; }
    const w2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); off = 0;
    while ((n = w2.nextNode())) { const len = (n as Text).length; if (off + len >= i + 14) { r.setEnd(n, i + 14 - off); break; } off += len; }
    getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
  }, { id: sch.id, l2 });
  await pg.waitForTimeout(150);
  const box = await pg.evaluate(() => { const r = getSelection()!.getRangeAt(0).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await pg.mouse.click(box.x, box.y, { button: "right" });
  await pg.waitForTimeout(200);
  const item = pg.locator(".ctx button[role=menuitem]", { hasText: "Annotate Selection" });
  check("codeAnnotMenu", (await item.count()) === 1);
  if (await item.count()) {
    await item.click();
    await pg.waitForTimeout(150);
    await pg.keyboard.type("先清空");
    await pg.keyboard.press("Enter");
    await pg.waitForTimeout(250);
  }
  const got = (h.board().cards[0] as CodeCard).segments[0].annots ?? [];
  const t2 = s.text[l2 - s.start];
  check("codeAnnotAdd", got.length === 3 && got.some((a) => a.line === l2 && a.text === "先清空" && a.from === t2.indexOf("scheduled_seqs") && a.to === a.from + 14), got);
  // right-click a label → Remove
  await pg.locator(`${card(sch.id)} .alab`, { hasText: "KV cache blocks" }).click({ button: "right" });
  await pg.waitForTimeout(150);
  await pg.locator(".ctx button[role=menuitem]", { hasText: "Remove Annotation" }).click();
  await pg.waitForTimeout(200);
  const left = (h.board().cards[0] as CodeCard).segments[0].annots ?? [];
  check("codeAnnotRemove", left.length === 2 && !left.some((a) => a.text === "KV cache blocks") && (await pg.locator(`${card(sch.id)} .arail.below`).count()) === 0, left);
  await h.close();
});

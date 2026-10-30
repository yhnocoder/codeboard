import { shot, symCard, findSym, put, type Host } from "../harness";
import { emptyBoard, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle, frames, pmHasSelection, focusSettled } from "../fixtures";

const sym = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; const i = s.text.findIndex((t) => re.test(t)); return s.start + Math.max(0, i); };
const card = (id: string) => `.card[data-id="${id}"]`;

/** LLMEngine.step and Scheduler.schedule, three Marks: m1 → a line of schedule, m2 → step's card, m3 with no arrow */
function markBoard(): { b: Board; step: CodeCard; sch: CodeCard } {
  const b = emptyBoard("b1", "marks");
  const step = sym("LLMEngine.step"), sch = sym("Scheduler.schedule");
  put(b, step, 60, 160, 560); put(b, sch, 780, 120, 560);
  const mark = (id: string, md: string, hand: NoteCard["hand"], x: number, y: number, w: number) => {
    b.cards.push({ id, kind: "note", md, look: "mark", hand } as NoteCard);
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
    // 卡片的框和阴影画在 ::after / ::before 上
    const shadow = [cs, getComputedStyle(c, "::before"), getComputedStyle(c, "::after")].map((s) => s.boxShadow).filter((v) => v !== "none").join(" | ") || "none";
    return { cls: c.className, bg: cs.backgroundColor, shadow, font: ts.fontFamily, size: ts.fontSize, color: ts.color };
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
  await pg.locator(`${card("m1")} .hdots .hdot`).first().waitFor();
  check("markColorDots", (await pg.locator(`${card("m1")} .hdots .hdot`).count()) === 4);
  await shot(h, "marks-selected");
  await pg.locator(`${card("m1")} .hdot.hc-purple`).click();
  await until(h, "the new color is saved", () => (h.board().cards.find((c) => c.id === "m1") as NoteCard | undefined)?.hand !== "blue");
  await idle(h); // the color transition
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
    await until(h, "the new width is saved", () => h.board().place.m1?.w !== 200);
    await idle(h);
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
  await until(h, "the edit is saved", () => (h.board().cards.find((c) => c.id === "m3") as NoteCard | undefined)?.md !== "先挑这一批");
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
    await idle(h);
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
    "每一步先由 {Scheduler|决定谁先跑} 挑出这一批要跑的序列，再交给 ModelRunner {做一次前向|prefill / decode 二选一，不混在一批|purple below}，最后 postprocess 把新 token 接到序列后面。",
    "",
    "Prefill and decode {never share a batch|like this|green} in ==nano-vllm==.",
    "",
    "A plain line without annotations.",
  ].join("\n");
  b.cards.push({ id: "n1", kind: "note", md, look: "note" } as NoteCard);
  b.place.n1 = { x: 80, y: 80, w: 520 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 900, h: 700 });
  const pg = h.page;
  await pg.evaluate(() => document.fonts.ready);
  const info = await pg.evaluate(() => [...document.querySelectorAll<HTMLElement>(".card .md-annot")].map((e) => {
    const n = e.querySelector(":scope > .md-annot-n")!, b4 = getComputedStyle(n), r = e.getBoundingClientRect();
    return { note: e.dataset.note, color: e.dataset.color ?? "blue", below: e.hasAttribute("data-below"), label: n.textContent ?? "", font: b4.fontFamily, labelColor: b4.color, pt: getComputedStyle(e).paddingTop, pb: getComputedStyle(e).paddingBottom, h: r.height };
  }));
  check("annotRendered", info.length === 3 && info[0].note === "决定谁先跑" && info[1].below && info[2].color === "green", info);
  check("annotLabel", info.every((i) => i.label.includes(i.note!) && /Shantell Sans/.test(i.font)), info.map((i) => [i.label, i.font]));
  check("annotRail", parseFloat(info[0].pt) > 10 && parseFloat(info[1].pb) > 10 && parseFloat(info[1].pt) === 0, info.map((i) => [i.pt, i.pb]));
  check("annotHighlightSeparate", (await pg.locator(".card mark").count()) === 1);
  const lineH = await pg.evaluate(() => { const ps = [...document.querySelectorAll<HTMLElement>(".card .nbody p")]; return ps.map((p) => p.getBoundingClientRect().height); });
  check("annotOnlyAnnotatedLinesTaller", lineH.length === 3 && lineH[2] < lineH[1], lineH);
  // a label at the end of a line is pulled back inside the paragraph, measured once the handwriting font has loaded
  // (view.ts fitAnnots measures again when a label changes size): every label's font is there, then the board is idle
  await pg.waitForFunction(() => [...document.querySelectorAll<HTMLElement>(".card .md-annot > .md-annot-n")].every((n) => {
    const lb = getComputedStyle(n);
    return document.fonts.check(`${lb.fontWeight} ${lb.fontSize} ${lb.fontFamily}`, n.textContent ?? "");
  }), null, { timeout: 5000 });
  await idle(h);
  const fit = await pg.evaluate(() => {
    const e = [...document.querySelectorAll<HTMLElement>(".card .md-annot")][1], p = e.closest("p")!;
    const right = e.querySelector(":scope > .md-annot-n")!.getBoundingClientRect().right;
    return { right, pRight: p.getBoundingClientRect().right, ax: e.style.getPropertyValue("--ax") };
  });
  // centered, the label would run past the paragraph (natural right = right - ax): it is pulled back inside, and only then
  check("annotLabelInsideBlock", fit.right <= fit.pRight + 0.5 && (fit.right - parseFloat(fit.ax) > fit.pRight) === parseFloat(fit.ax) < 0, fit);
  await shot(h, "marks-note-annotations");

  // typing the syntax in the editor
  await pg.locator(`${card("n1")} .nbody p`).last().dblclick();
  await pg.waitForSelector(`${card("n1")} .md-pm`, { timeout: 5000 });
  await pg.keyboard.press("Control+End");
  await pg.keyboard.type(" Then {decode|one token each|orange}.");
  await idle(h);
  const live = await pg.locator(`${card("n1")} .md-pm .md-annot`).count();
  await pg.mouse.click(800, 650);
  await until(h, "the edit is saved", () => (h.board().cards[0] as NoteCard).md !== md);
  await idle(h);
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
  // the card takes the DOM selection as its line selection (CodeBody's selectionchange)
  await pg.locator(`${card(sch.id)} .gutter .no.sel`, { hasText: new RegExp(`^${l2}$`) }).waitFor();
  const box = await pg.evaluate(() => { const r = getSelection()!.getRangeAt(0).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await pg.mouse.click(box.x, box.y, { button: "right" });
  await pg.locator(".ctx button").first().waitFor();
  const item = pg.locator(".ctx button[role=menuitem]", { hasText: "Annotate Selection" });
  check("codeAnnotMenu", (await item.count()) === 1);
  if (await item.count()) {
    await item.click();
    await pg.locator(`${card(sch.id)} .alt:focus`).waitFor();
    await pg.keyboard.type("先清空");
    await pg.keyboard.press("Enter");
    await until(h, "the annotation is saved", () => ((h.board().cards[0] as CodeCard).segments[0].annots ?? []).length !== 2);
  }
  const got = (h.board().cards[0] as CodeCard).segments[0].annots ?? [];
  const t2 = s.text[l2 - s.start];
  check("codeAnnotAdd", got.length === 3 && got.some((a) => a.line === l2 && a.text === "先清空" && a.from === t2.indexOf("scheduled_seqs") && a.to === a.from + 14), got);
  // right-click a label → Remove
  await pg.locator(`${card(sch.id)} .alab`, { hasText: "KV cache blocks" }).click({ button: "right" });
  await pg.locator(".ctx button[role=menuitem]", { hasText: "Remove Annotation" }).click();
  await until(h, "the annotation is removed", () => ((h.board().cards[0] as CodeCard).segments[0].annots ?? []).length !== 3);
  await idle(h);
  const left = (h.board().cards[0] as CodeCard).segments[0].annots ?? [];
  check("codeAnnotRemove", left.length === 2 && !left.some((a) => a.text === "KV cache blocks") && (await pg.locator(`${card(sch.id)} .arail.below`).count()) === 0, left);
  await h.close();
});

/** The CUDA sentence: an annotation at the start of a line, one in the middle of a line, and one inside bold */
const CUDA_MD = [
  "{CUDA C++ 程序的结构|异构计算}反映了计算机中==主机（host，即 CPU）与一个或多个设备（device，即 GPU）共存==的情况。",
  "",
  "每个 kernel 由 {很多个线程|thread}同时执行，**线程按 {block|线程块|purple} 分组**。",
].join("\n");
/** Each annotation's span, label and arrow on screen */
const annotGeo = (pg: Host["page"], sel: string) => pg.evaluate((sel) => [...document.querySelectorAll<HTMLElement>(`${sel} .md-annot`)].map((e) => {
  const r = e.getBoundingClientRect(), lr = e.querySelector(":scope > .md-annot-n")!.getBoundingClientRect(), ar = getComputedStyle(e, "::after");
  const w = lr.width, left = lr.left;
  const block = e.parentElement!.closest("p")!.getBoundingClientRect();
  return { note: e.dataset.note!, spanCenter: r.left + r.width / 2, labelCenter: left + w / 2, arrowCenter: r.left + parseFloat(ar.left) + parseFloat(ar.width) / 2,
    labelLeft: left, labelRight: left + w, atLineStart: Math.abs(r.left - block.left) < 1, inBlock: left >= block.left - 0.5 && left + w <= block.right + 0.5 };
}), sel);

/** {text|note} labels are centered over the annotated words (and their arrow), whether the words start the line or sit in the middle of it,
 *  in the static Note and in its editor */
test("noteAnnotationLabelCentered", async () => {
  const b = emptyBoard("b1", "annotations");
  b.cards.push({ id: "n1", kind: "note", md: CUDA_MD, look: "note" } as NoteCard);
  b.place.n1 = { x: 80, y: 80, w: 520 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 760, h: 420, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await pg.evaluate(() => document.fonts.ready);
  await idle(h);
  const centered = (g: Awaited<ReturnType<typeof annotGeo>>) => g.length === 3 && g.every((a) => Math.abs(a.labelCenter - a.spanCenter) <= 2 && Math.abs(a.arrowCenter - a.spanCenter) <= 2 && a.inBlock);
  const geo = await annotGeo(pg, card("n1"));
  check("annotFirstAtLineStart", geo[0]?.atLineStart && !geo[1]?.atLineStart, geo);
  check("annotLabelCentered", centered(geo), geo);
  await shot(h, "marks-annotation-centered");
  await pg.locator(`${card("n1")} .nbody p`).first().dblclick({ position: { x: 300, y: 40 } });
  await pg.waitForSelector(`${card("n1")} .md-pm .md-annot`, { timeout: 5000 });
  await idle(h);
  const ed = await annotGeo(pg, `${card("n1")} .md-pm`);
  check("annotLabelCenteredInEditor", centered(ed), ed);
  await h.close();
});

/** The note of a {text|note} annotation is inline Markdown: $a$ in it is a KaTeX formula, the rest stays text, in the static Note and in
 *  its editor; the label stays centered over the words; the toolbar's Handwritten Note field still edits the note's source */
test("noteAnnotationMath", async () => {
  const b = emptyBoard("b1", "annotations");
  const md = "数与能够同时执行的 thread block 数之比，称为 {==wave count==|$a$#num_total/#num_concurrent}。例如，图 4.5 左侧示例有四个 wave。";
  b.cards.push({ id: "n1", kind: "note", md, look: "note" } as NoteCard);
  b.place.n1 = { x: 80, y: 80, w: 520 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 760, h: 360, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await pg.evaluate(() => document.fonts.ready);
  await idle(h);
  await shot(h, "marks-annotation-math");
  const label = (root: string) => pg.evaluate((root) => {
    const n = document.querySelector<HTMLElement>(`${root} .md-annot > .md-annot-n`);
    return n && { text: n.textContent, katex: n.querySelector(".katex")?.textContent ?? null, editable: n.isContentEditable };
  }, root);
  const shown = await label(card("n1"));
  const geo = await annotGeo(pg, card("n1"));
  const ok = (l: typeof shown) => !!l && l.katex === "a" && l.text!.includes("#num_total/#num_concurrent") && !l.text!.includes("$");
  const centered = geo.length === 1 && Math.abs(geo[0].labelCenter - geo[0].spanCenter) <= 2 && geo[0].inBlock;
  check("annotMathStatic", ok(shown) && centered, { shown, geo });
  const pm = `${card("n1")} .md-pm`;
  await pg.locator(`${card("n1")} .nbody p`).dblclick({ position: { x: 20, y: 40 } });
  await pg.waitForSelector(`${pm} .md-annot`, { timeout: 5000 });
  await idle(h);
  const edit = await label(pm);
  const egeo = await annotGeo(pg, pm);
  check("annotMathEditor", ok(edit) && !edit!.editable && egeo.length === 1 && Math.abs(egeo[0].labelCenter - egeo[0].spanCenter) <= 2, { edit, egeo });
  await shot(h, "marks-annotation-math-editing");
  await focusSettled(pg);
  await pg.evaluate((pm) => {
    const w = document.createTreeWalker(document.querySelector(`${pm} .md-annot > :not(.md-annot-n)`)!, NodeFilter.SHOW_TEXT);
    const t = w.nextNode() as Text, r = document.createRange();
    r.setStart(t, 0); r.setEnd(t, t.data.length);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
  }, pm);
  await pmHasSelection(pg);
  const btn = pg.locator('.md-bubble .tbtn[data-tip="Handwritten Note"]');
  await btn.waitFor({ timeout: 2000 });
  await btn.click();
  const input = pg.locator(".md-bubble input.md-annotin");
  await input.waitFor({ timeout: 2000 });
  const src = await input.inputValue();
  await pg.keyboard.press("Escape");
  check("annotMathSourceInToolbar", src === "$a$#num_total/#num_concurrent", { src });
  await h.close();
});

/** The annotation label is drawn in the bundled handwriting fonts (Shantell Sans for Latin, LXGW WenKai Lite for Chinese):
 *  the computed font is the hand font, both faces are loaded, and the glyphs really come from them (not a system fallback) */
test("noteAnnotationHandFont", async () => {
  const b = emptyBoard("b1", "annotations");
  b.cards.push({ id: "n1", kind: "note", md: CUDA_MD, look: "note" } as NoteCard);
  b.place.n1 = { x: 80, y: 80, w: 520 };
  const h = await open({ board: b, light: true, w: 760, h: 420, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await pg.evaluate(() => document.fonts.ready);
  const f = await pg.evaluate(() => {
    const labels = [...document.querySelectorAll<HTMLElement>(".card .md-annot")].map((e) => {
      const lb = getComputedStyle(e.querySelector(":scope > .md-annot-n")!), font = `${lb.fontWeight} ${lb.fontSize} ${lb.fontFamily}`;
      return { note: e.dataset.note!, family: lb.fontFamily, checked: document.fonts.check(font, e.dataset.note) };
    });
    const faces = Object.fromEntries([...document.fonts].filter((x) => /Shantell Sans|LXGW WenKai Lite/.test(x.family)).map((x) => [x.family.replace(/"/g, ""), x.status]));
    // glyphs drawn with the label's font stack vs the same stack without the bundled face: they differ only if the bundled face is used
    const draw = (font: string, t: string) => { const c = document.createElement("canvas"); c.width = 160; c.height = 40; const x = c.getContext("2d")!; x.font = font; x.fillText(t, 2, 30); return x.getImageData(0, 0, 160, 40).data; };
    const differ = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let n = 0; for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) n++; return n; };
    const stack = labels[0]?.family ?? "";
    const without = (name: string) => stack.split(",").filter((s) => !s.includes(name)).join(",");
    return { labels, faces, cjk: differ(draw(`24px ${stack}`, "异构计算"), draw(`24px ${without("LXGW")}`, "异构计算")), latin: differ(draw(`24px ${stack}`, "thread"), draw(`24px ${without("Shantell")}`, "thread")) };
  });
  check("annotHandFontFamily", f.labels.length === 3 && f.labels.every((l) => /^"?Shantell Sans"?,\s*"?LXGW WenKai Lite"?/.test(l.family)), f.labels);
  check("annotHandFontsLoaded", f.faces["Shantell Sans"] === "loaded" && f.faces["LXGW WenKai Lite"] === "loaded" && f.labels.every((l) => l.checked), f);
  check("annotHandGlyphsFromBundledFonts", f.cjk > 50 && f.latin > 50, f);
  await h.close();
});

/** Handwritten Note in the Note editor's selection toolbar: select words → the button → type the note (the label shows on the words
 *  as you type) → Enter; one undo takes it off; on an annotated selection the button is on and opens with its note, Escape keeps it */
test("noteAnnotationFromToolbar", async () => {
  const b = emptyBoard("b1", "annotations");
  b.cards.push({ id: "n1", kind: "note", md: "Prefill and decode never share a batch in nano-vllm.", look: "note" } as NoteCard);
  b.place.n1 = { x: 80, y: 80, w: 460 };
  b.cam = { x: 0, y: 0, z: 1.25 };
  const h = await open({ board: b, light: true, w: 820, h: 420, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  const pm = `${card("n1")} .md-pm`;
  const md = () => (h.board().cards[0] as NoteCard).md;
  await pg.locator(`${card("n1")} .nbody p`).dblclick({ position: { x: 20, y: 8 } });
  await pg.waitForSelector(pm, { timeout: 5000 });
  const sel = (w: string) => pg.evaluate(([root, w]) => {
    const t = [...document.querySelector(root)!.querySelectorAll("p")].map((p) => p.firstChild as Text).find((n) => n?.data.includes(w))!;
    const r = document.createRange(), i = t.data.indexOf(w); r.setStart(t, i); r.setEnd(t, i + w.length);
    getSelection()!.removeAllRanges(); getSelection()!.addRange(r);
  }, [pm, w] as const);
  await focusSettled(pg); // a selection set by script within ProseMirror's focus window would be undone
  await sel("never share a batch");
  await pmHasSelection(pg);
  const btn = pg.locator('.md-bubble .tbtn[data-tip="Handwritten Note"]');
  await btn.waitFor({ timeout: 2000 });
  await idle(h);
  const tip = await btn.evaluate((b) => ({ label: b.getAttribute("aria-label"), on: b.classList.contains("on"), ico: !!b.querySelector("svg.md-ico path")?.getAttribute("d") }));
  check("annotButton", tip.label === "Handwritten Note" && !tip.on && tip.ico, tip);
  await btn.hover();
  await pg.locator(".tip").waitFor(); await idle(h); // its tooltip is in the picture
  await shot(h, "marks-annotation-toolbar-button");
  await btn.click();
  const input = pg.locator(".md-bubble input.md-annotin");
  await input.waitFor({ timeout: 2000 });
  check("annotInputFocused", await input.evaluate((i) => document.activeElement === i));
  await pg.keyboard.type("not mixed");
  await pg.locator(`${pm} .md-annot`).first().waitFor(); await frames(pg);
  const live = await pg.locator(`${pm} .md-annot`).evaluateAll((es) => es.map((e) => [[...e.childNodes].filter((k) => !(k as Element).classList?.contains("md-annot-n")).map((k) => k.textContent).join(""), (e as HTMLElement).dataset.note]));
  check("annotLivePreview", live.length === 1 && live[0][0] === "never share a batch" && live[0][1] === "not mixed", live);
  await shot(h, "marks-annotation-toolbar-typing");
  await pg.keyboard.press("Enter");
  await input.waitFor({ state: "detached" });
  check("annotEditorFocusedAfterEnter", await pg.evaluate((pm) => document.activeElement === document.querySelector(`${pm} .ProseMirror`) || !!document.activeElement?.closest(pm), pm));
  // the button is on for the annotated words; it opens with the note, Escape leaves it as it was. The toolbar comes back
  // TOOLBAR_SETTLE after the editor has the focus again: wait (up to 5 s) for it with its button on
  const on = await until(h, "the toolbar is back with Handwritten Note on", () => btn.evaluate((b) => b.classList.contains("on")).catch(() => false)).catch(() => false);
  await btn.click();
  await input.waitFor({ timeout: 2000 });
  const prefilled = await input.inputValue();
  await pg.keyboard.press("Escape");
  await input.waitFor({ state: "detached" }); await frames(pg);
  const kept = await pg.locator(`${pm} .md-annot`).evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.note));
  check("annotButtonEditsExisting", on && prefilled === "not mixed" && kept.length === 1 && kept[0] === "not mixed", { on, prefilled, kept });
  // one undo takes the annotation off (the live preview steps are not separate undo steps)
  await pg.keyboard.press("ControlOrMeta+z");
  await frames(pg); // ProseMirror's undo changes the DOM on the key press
  const undone = await pg.evaluate((pm) => ({ annots: document.querySelectorAll(`${pm} .md-annot`).length, text: document.querySelector(pm)!.textContent }), pm);
  await pg.keyboard.press("ControlOrMeta+Shift+z");
  await frames(pg);
  const redone = await pg.evaluate((pm) => document.querySelector(pm)!.innerHTML, pm);
  check("annotOneUndoStep", undone.annots === 0 && undone.text === "Prefill and decode never share a batch in nano-vllm." && /data-note="not mixed"/.test(redone), { undone, redone });
  await pg.mouse.click(760, 380);
  await pg.locator(pm).waitFor({ state: "detached" }); await idle(h); // the editor has closed and its save reached the host
  check("annotSaved", md() === "Prefill and decode {never share a batch|not mixed} in nano-vllm.", md());
  await shot(h, "marks-annotation-toolbar-saved");
  await h.close();
});

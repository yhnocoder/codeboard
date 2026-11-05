import { shot, symCard, findSym, put, cpuSpans, type Host } from "../harness";
import { emptyBoard, TEXT_FS, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle, frames, pmHasSelection, focusSettled } from "../fixtures";

const sym = (q: string) => {
  const s = findSym(q);
  return symCard(s.f, s.s);
};
const lineOf = (c: CodeCard, re: RegExp) => {
  const s = c.segments[0];
  const i = s.text.findIndex((t) => re.test(t));
  return s.start + Math.max(0, i);
};
const card = (id: string) => `.card[data-id="${id}"]`;

/** LLMEngine.step and Scheduler.schedule, three Marks: m1 → a line of schedule, m2 → step's card, m3 with no arrow */
function markBoard(): { b: Board; step: CodeCard; sch: CodeCard } {
  const b = emptyBoard("b1", "marks");
  const step = sym("LLMEngine.step"),
    sch = sym("Scheduler.schedule");
  put(b, step, 60, 160, 560);
  put(b, sch, 780, 120, 560);
  const mark = (id: string, md: string, hand: NoteCard["hand"], x: number, y: number, w: number) => {
    b.cards.push({ id, kind: "note", md, look: "mark", hand } as NoteCard);
    b.place[id] = { x, y, w };
  };
  mark("m1", "picks this batch", "blue", 420, 40, 200);
  mark("m2", "prefill / decode never share a batch", "purple", 300, 640, 180);
  mark("m3", "先挑这一批", "orange", 980, 640, 160);
  b.links.push({
    id: "L1",
    from: { card: "m1" },
    to: { card: sch.id, seg: sch.segments[0].id, line: lineOf(sch, /while/) },
  });
  b.links.push({ id: "L2", from: { card: "m2" }, to: { card: step.id } });
  b.links.push({
    id: "L3",
    from: { card: step.id, seg: step.segments[0].id, line: lineOf(step, /scheduler\.schedule\(/) },
    to: { card: sch.id },
    call: { name: "schedule", col: 0 },
  });
  b.cam = { x: 0, y: 0, z: 0.9 };
  return { b, step, sch };
}
const linkPaths = (h: Host, id: string) =>
  h.page.evaluate((id) => {
    const g = document.querySelector(`.link[data-lk="${id}"]`);
    return g
      ? [...g.querySelectorAll("path:not(.lhit)")].map((p) => ({
          cls: p.getAttribute("class") ?? "",
          d: p.getAttribute("d") ?? "",
          stroke: getComputedStyle(p).stroke,
        }))
      : [];
  }, id);

/** A Mark has no frame and the handwriting font; its arrows are hand-drawn in its color; color dots, width handle, double-click */
test("markCard", async () => {
  const { b } = markBoard();
  const h = await open({ board: b, light, w: 1500, h: 950 });
  const pg = h.page;
  await pg.evaluate(() => document.fonts.ready);
  const look = await pg.evaluate((sel) => {
    const c = document.querySelector<HTMLElement>(sel)!,
      t = c.querySelector<HTMLElement>(".tx")!,
      cs = getComputedStyle(c),
      ts = getComputedStyle(t);
    // 卡片的框和阴影画在 ::after / ::before 上
    const shadow =
      [cs, getComputedStyle(c, "::before"), getComputedStyle(c, "::after")]
        .map((s) => s.boxShadow)
        .filter((v) => v !== "none")
        .join(" | ") || "none";
    return {
      cls: c.className,
      bg: cs.backgroundColor,
      shadow,
      font: ts.fontFamily,
      size: ts.fontSize,
      color: ts.color,
    };
  }, card("m1"));
  check(
    "markNoFrame",
    /\bmark\b/.test(look.cls) && /rgba\(0, 0, 0, 0\)|transparent/.test(look.bg) && look.shadow === "none",
    look,
  );
  check("markHandFont", /Shantell Sans/.test(look.font) && look.size === "18px", look);
  const fontsOk = await pg.evaluate(
    () => document.fonts.check('18px "Shantell Sans"') && document.fonts.check('18px "Yozai"', "先挑"),
  );
  check("markFontsBundled", fontsOk);
  const l1 = await linkPaths(h, "L1"),
    l3 = await linkPaths(h, "L3");
  const edge = l1.filter((p) => /\bedge\b/.test(p.cls));
  check(
    "markArrowHand",
    edge.length === 2 &&
      edge.every((p) => /\bhand\b/.test(p.cls)) &&
      edge.some((p) => /\bp2\b/.test(p.cls)) &&
      l1.some((p) => /\bahead\b/.test(p.cls)),
    l1.map((p) => p.cls),
  );
  check("markArrowColor", edge[0]?.stroke === look.color, { arrow: edge[0]?.stroke, mark: look.color });
  check(
    "plainArrowNotHand",
    l3.length > 0 && l3.every((p) => !/\bhand\b/.test(p.cls)),
    l3.map((p) => p.cls),
  );
  check("markArrowNoMerge", (await pg.locator(`.link[data-lk="L1"]`).getAttribute("data-merged")) === null);
  await shot(h, "marks-board");

  // select: the color dots; purple → the Mark and its arrow change color
  await pg.locator(`${card("m1")} .tx`).click();
  await pg
    .locator(`${card("m1")} .hdots .hdot`)
    .first()
    .waitFor();
  check("markColorDots", (await pg.locator(`${card("m1")} .hdots .hdot`).count()) === 4);
  await shot(h, "marks-selected");
  await pg.locator(`${card("m1")} .hdot.hc-purple`).click();
  await until(
    h,
    "the new color is saved",
    () => (h.board().cards.find((c) => c.id === "m1") as NoteCard | undefined)?.hand !== "blue",
  );
  await idle(h); // the color transition
  const after = await pg.evaluate((sel) => getComputedStyle(document.querySelector(sel)!).color, `${card("m1")} .tx`);
  const l1b = (await linkPaths(h, "L1")).find((p) => /\bedge\b/.test(p.cls));
  check(
    "markRecolor",
    h.board().cards.find((c) => c.id === "m1")?.kind === "note" &&
      (h.board().cards.find((c) => c.id === "m1") as NoteCard).hand === "purple" &&
      after !== look.color &&
      l1b?.stroke === after,
    { after, arrow: l1b?.stroke },
  );

  // width handles (the left edge here, the right one has the arrow; the corner grip scales the text, markScaleText): narrower →
  // wraps onto more lines, font size unchanged
  const before = await pg.locator(card("m1")).boundingBox();
  check("markGripShown", !!(await pg.locator(`${card("m1")} .mkgrip`).boundingBox()));
  const grip = await pg.locator(`${card("m1")} .hw.l`).boundingBox();
  if (grip && before) {
    await pg.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await pg.mouse.down();
    for (let i = 1; i <= 8; i++) await pg.mouse.move(grip.x + grip.width / 2 + i * 12, grip.y + grip.height / 2);
    await pg.mouse.up();
    await until(h, "the new width is saved", () => h.board().place.m1?.w !== 200);
    await idle(h);
    const now = await pg.locator(card("m1")).boundingBox();
    const size = await pg.evaluate(
      (sel) => getComputedStyle(document.querySelector(sel)!).fontSize,
      `${card("m1")} .tx`,
    );
    check(
      "markWidthWraps",
      (h.board().place.m1?.w ?? 999) < 200 && !!now && now.height > before.height + 10 && size === "18px",
      { w: h.board().place.m1?.w, before: before.height, after: now?.height, size },
    );
  }

  // double-click edits in place
  await pg.locator(`${card("m3")} .tx`).dblclick();
  await pg.waitForSelector(`${card("m3")} .md-pm`, { timeout: 5000 });
  // End is the browser moving the caret: within ProseMirror's focus window it is undone, and ProseMirror reads it from the
  // asynchronous selectionchange (the caret stays where the double-click put it: "先挑这一 ok批")
  await focusSettled(pg);
  await pg.keyboard.press("End");
  await pmHasSelection(pg);
  await pg.keyboard.type(" ok");
  await pg.mouse.click(700, 880);
  await until(
    h,
    "the edit is saved",
    () => (h.board().cards.find((c) => c.id === "m3") as NoteCard | undefined)?.md !== "先挑这一批",
  );
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
    const x = head.x + 20,
      y = head.y + head.height / 2;
    await pg.mouse.move(x, y);
    await pg.mouse.down();
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
  const info = await pg.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".card .md-annot")].map((e) => {
      const n = e.querySelector(":scope > .md-annot-n")!,
        b4 = getComputedStyle(n),
        r = e.getBoundingClientRect();
      return {
        note: e.dataset.note,
        color: e.dataset.color ?? "blue",
        below: e.hasAttribute("data-below"),
        label: n.textContent ?? "",
        font: b4.fontFamily,
        labelColor: b4.color,
        pt: getComputedStyle(e).paddingTop,
        pb: getComputedStyle(e).paddingBottom,
        h: r.height,
      };
    }),
  );
  check(
    "annotRendered",
    info.length === 3 && info[0].note === "决定谁先跑" && info[1].below && info[2].color === "green",
    info,
  );
  check(
    "annotLabel",
    info.every((i) => i.label.includes(i.note!) && /Shantell Sans/.test(i.font)),
    info.map((i) => [i.label, i.font]),
  );
  check(
    "annotRail",
    parseFloat(info[0].pt) > 10 && parseFloat(info[1].pb) > 10 && parseFloat(info[1].pt) === 0,
    info.map((i) => [i.pt, i.pb]),
  );
  check("annotHighlightSeparate", (await pg.locator(".card mark").count()) === 1);
  const lineH = await pg.evaluate(() => {
    const ps = [...document.querySelectorAll<HTMLElement>(".card .nbody p")];
    return ps.map((p) => p.getBoundingClientRect().height);
  });
  check("annotOnlyAnnotatedLinesTaller", lineH.length === 3 && lineH[2] < lineH[1], lineH);
  // a label at the end of a line is pulled back inside the paragraph, measured once the handwriting font has loaded
  // (view.ts fitAnnots measures again when a label changes size): every label's font is there, then the board is idle
  await pg.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLElement>(".card .md-annot > .md-annot-n")].every((n) => {
        const lb = getComputedStyle(n);
        return document.fonts.check(`${lb.fontWeight} ${lb.fontSize} ${lb.fontFamily}`, n.textContent ?? "");
      }),
    null,
    { timeout: 5000 },
  );
  await idle(h);
  const fit = await pg.evaluate(() => {
    const e = [...document.querySelectorAll<HTMLElement>(".card .md-annot")][1],
      p = e.closest("p")!;
    const right = e.querySelector(":scope > .md-annot-n")!.getBoundingClientRect().right;
    return { right, pRight: p.getBoundingClientRect().right, ax: e.style.getPropertyValue("--ax") };
  });
  // centered, the label would run past the paragraph (natural right = right - ax): it is pulled back inside, and only then
  check(
    "annotLabelInsideBlock",
    fit.right <= fit.pRight + 0.5 && fit.right - parseFloat(fit.ax) > fit.pRight === parseFloat(fit.ax) < 0,
    fit,
  );
  await shot(h, "marks-note-annotations");

  // typing the syntax in the editor
  await pg
    .locator(`${card("n1")} .nbody p`)
    .last()
    .dblclick();
  await pg.waitForSelector(`${card("n1")} .md-pm`, { timeout: 5000 });
  await pg.keyboard.press("Control+End");
  await pg.keyboard.type(" Then {decode|one token each|orange}.");
  await idle(h);
  const live = await pg.locator(`${card("n1")} .md-pm .md-annot`).count();
  await pg.mouse.click(800, 650);
  await until(h, "the edit is saved", () => (h.board().cards[0] as NoteCard).md !== md);
  await idle(h);
  const saved = (h.board().cards[0] as NoteCard).md;
  check(
    "annotTyped",
    saved.includes("{decode|one token each|orange}") && (await pg.locator(`${card("n1")} .md-annot`).count()) === 4,
    { live, tail: saved.slice(-80) },
  );
  await h.close();
});

/** Annotations on a code card: a rail above / below the line, the label over the words (by column, tabs and hidden indent
 *  included), the line's links still land on it; select words → right-click → Annotate Selection… → type → Enter */
test("codeAnnotations", async () => {
  const b = emptyBoard("b1", "code annotations");
  const sch = sym("Scheduler.schedule");
  const s = sch.segments[0];
  const lw = lineOf(sch, /while self\.waiting/),
    la = lineOf(sch, /block_manager\.can_allocate\(/);
  const tw = s.text[lw - s.start],
    ta = s.text[la - s.start];
  s.annots = [
    { line: lw, from: tw.indexOf("self.waiting"), to: tw.indexOf("self.waiting") + 12, text: "还没跑的请求" },
    {
      line: la,
      from: ta.indexOf("can_allocate"),
      to: ta.indexOf("can_allocate") + 12,
      text: "KV cache blocks",
      color: "purple",
      below: true,
    },
  ];
  put(b, sch, 80, 60, 640);
  b.links.push({ id: "L1", from: { card: sch.id, seg: s.id, line: la }, to: { card: sch.id, seg: s.id, line: lw } });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light, w: 1100, h: 900 });
  const pg = h.page;
  await pg.evaluate(() => document.fonts.ready);
  const geo = await pg.evaluate(
    ({ id, lw, la }) => {
      const card = document.querySelector(`.card[data-id="${id}"]`)!;
      const rails = [...card.querySelectorAll<HTMLElement>(".arail")].map((r) => ({
        below: r.classList.contains("below"),
        text: r.textContent,
        top: r.getBoundingClientRect().top,
      }));
      const no = (n: number) =>
        [...card.querySelectorAll<HTMLElement>(".gutter .no")].find((e) => e.textContent === String(n))!;
      const lineEl = (n: number) => card.querySelector<HTMLElement>(`.src > .l[data-r="${no(n).dataset.r}"]`)!;
      // where "self.waiting" actually is on the line
      const at = (el: HTMLElement, word: string) => {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n: Node | null,
          off = 0;
        const full = el.textContent!,
          i = full.indexOf(word);
        while ((n = w.nextNode())) {
          const len = (n as Text).length;
          if (off + len > i) {
            const r = document.createRange();
            r.setStart(n, i - off);
            r.setEnd(n, i - off + 1);
            return r.getBoundingClientRect().left;
          }
          off += len;
        }
        return NaN;
      };
      const bgs = [...card.querySelectorAll<HTMLElement>(".abg")].map((e) => e.getBoundingClientRect());
      const labs = [...card.querySelectorAll<HTMLElement>(".alab")].map((e) => e.getBoundingClientRect());
      const lwEl = lineEl(lw),
        laEl = lineEl(la);
      return {
        rails,
        wordX: at(lwEl, "self.waiting"),
        allocX: at(laEl, "can_allocate"),
        bgs: bgs.map((r) => ({ left: r.left, top: r.top })),
        labs: labs.map((r) => ({ left: r.left, top: r.top, bottom: r.bottom })),
        lwTop: lwEl.getBoundingClientRect().top,
        laBottom: laEl.getBoundingClientRect().bottom,
        noTop: no(lw).getBoundingClientRect().top,
      };
    },
    { id: sch.id, lw, la },
  );
  check(
    "codeAnnotRails",
    geo.rails.length === 2 && !geo.rails[0].below && geo.rails[1].below && geo.rails[0].text?.includes("还没跑的请求"),
    geo.rails,
  );
  check(
    "codeAnnotAligned",
    Math.abs(geo.bgs[0].left - geo.wordX) < 2 &&
      Math.abs(geo.labs[0].left - geo.wordX) < 4 &&
      Math.abs(geo.bgs[1].left - geo.allocX) < 2,
    geo,
  );
  check("codeAnnotRailPlace", geo.labs[0].bottom <= geo.lwTop + 1 && geo.labs[1].top >= geo.laBottom - 1, geo);
  check("codeAnnotGutterFollows", Math.abs(geo.noTop - geo.lwTop) < 2, geo);
  await shot(h, "marks-code-annotations");

  // select "scheduled_seqs" on the first body line, right-click, Annotate Selection…
  const l2 = s.start + 1;
  await pg.evaluate(
    ({ id, l2 }) => {
      const card = document.querySelector(`.card[data-id="${id}"]`)!;
      const no = [...card.querySelectorAll<HTMLElement>(".gutter .no")].find((e) => e.textContent === String(l2))!;
      const el = card.querySelector<HTMLElement>(`.src > .l[data-r="${no.dataset.r}"]`)!;
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n: Node | null,
        off = 0;
      const i = el.textContent!.indexOf("scheduled_seqs");
      const r = document.createRange();
      while ((n = w.nextNode())) {
        const len = (n as Text).length;
        if (off + len > i) {
          r.setStart(n, i - off);
          break;
        }
        off += len;
      }
      const w2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      off = 0;
      while ((n = w2.nextNode())) {
        const len = (n as Text).length;
        if (off + len >= i + 14) {
          r.setEnd(n, i + 14 - off);
          break;
        }
        off += len;
      }
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
    },
    { id: sch.id, l2 },
  );
  // the card takes the DOM selection as its line selection (CodeBody's selectionchange)
  await pg.locator(`${card(sch.id)} .gutter .no.sel`, { hasText: new RegExp(`^${l2}$`) }).waitFor();
  const box = await pg.evaluate(() => {
    const r = getSelection()!.getRangeAt(0).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await pg.mouse.click(box.x, box.y, { button: "right" });
  await pg.locator(".ctx button").first().waitFor();
  const item = pg.locator(".ctx button[role=menuitem]", { hasText: "Annotate Selection" });
  check("codeAnnotMenu", (await item.count()) === 1);
  if (await item.count()) {
    await item.click();
    await pg.locator(`${card(sch.id)} .alt:focus`).waitFor();
    await pg.keyboard.type("先清空");
    await pg.keyboard.press("Enter");
    await until(
      h,
      "the annotation is saved",
      () => ((h.board().cards[0] as CodeCard).segments[0].annots ?? []).length !== 2,
    );
  }
  const got = (h.board().cards[0] as CodeCard).segments[0].annots ?? [];
  const t2 = s.text[l2 - s.start];
  check(
    "codeAnnotAdd",
    got.length === 3 &&
      got.some(
        (a) => a.line === l2 && a.text === "先清空" && a.from === t2.indexOf("scheduled_seqs") && a.to === a.from + 14,
      ),
    got,
  );
  // right-click a label → Remove
  await pg.locator(`${card(sch.id)} .alab`, { hasText: "KV cache blocks" }).click({ button: "right" });
  await pg.locator(".ctx button[role=menuitem]", { hasText: "Remove Annotation" }).click();
  await until(
    h,
    "the annotation is removed",
    () => ((h.board().cards[0] as CodeCard).segments[0].annots ?? []).length !== 3,
  );
  await idle(h);
  const left = (h.board().cards[0] as CodeCard).segments[0].annots ?? [];
  check(
    "codeAnnotRemove",
    left.length === 2 &&
      !left.some((a) => a.text === "KV cache blocks") &&
      (await pg.locator(`${card(sch.id)} .arail.below`).count()) === 0,
    left,
  );
  await h.close();
});

/** The CUDA sentence: an annotation at the start of a line, one in the middle of a line, and one inside bold */
const CUDA_MD = [
  "{CUDA C++ 程序的结构|异构计算}反映了计算机中==主机（host，即 CPU）与一个或多个设备（device，即 GPU）共存==的情况。",
  "",
  "每个 kernel 由 {很多个线程|thread}同时执行，**线程按 {block|线程块|purple} 分组**。",
].join("\n");
/** Each annotation's span, label and arrow on screen */
const annotGeo = (pg: Host["page"], sel: string) =>
  pg.evaluate(
    (sel) =>
      [...document.querySelectorAll<HTMLElement>(`${sel} .md-annot`)].map((e) => {
        const r = e.getBoundingClientRect(),
          lr = e.querySelector(":scope > .md-annot-n")!.getBoundingClientRect(),
          ar = getComputedStyle(e, "::after");
        const w = lr.width,
          left = lr.left;
        const block = e.parentElement!.closest("p")!.getBoundingClientRect();
        return {
          note: e.dataset.note!,
          spanCenter: r.left + r.width / 2,
          labelCenter: left + w / 2,
          arrowCenter: r.left + parseFloat(ar.left) + parseFloat(ar.width) / 2,
          labelLeft: left,
          labelRight: left + w,
          atLineStart: Math.abs(r.left - block.left) < 1,
          inBlock: left >= block.left - 0.5 && left + w <= block.right + 0.5,
        };
      }),
    sel,
  );

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
  const centered = (g: Awaited<ReturnType<typeof annotGeo>>) =>
    g.length === 3 &&
    g.every(
      (a) => Math.abs(a.labelCenter - a.spanCenter) <= 2 && Math.abs(a.arrowCenter - a.spanCenter) <= 2 && a.inBlock,
    );
  const geo = await annotGeo(pg, card("n1"));
  check("annotFirstAtLineStart", geo[0]?.atLineStart && !geo[1]?.atLineStart, geo);
  check("annotLabelCentered", centered(geo), geo);
  await shot(h, "marks-annotation-centered");
  await pg
    .locator(`${card("n1")} .nbody p`)
    .first()
    .dblclick({ position: { x: 300, y: 40 } });
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
  const md =
    "数与能够同时执行的 thread block 数之比，称为 {==wave count==|$a$#num_total/#num_concurrent}。例如，图 4.5 左侧示例有四个 wave。";
  b.cards.push({ id: "n1", kind: "note", md, look: "note" } as NoteCard);
  b.place.n1 = { x: 80, y: 80, w: 520 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 760, h: 360, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await pg.evaluate(() => document.fonts.ready);
  await idle(h);
  await shot(h, "marks-annotation-math");
  const label = (root: string) =>
    pg.evaluate((root) => {
      const n = document.querySelector<HTMLElement>(`${root} .md-annot > .md-annot-n`);
      return (
        n && {
          text: n.textContent,
          katex: n.querySelector(".katex")?.textContent ?? null,
          editable: n.isContentEditable,
        }
      );
    }, root);
  const shown = await label(card("n1"));
  const geo = await annotGeo(pg, card("n1"));
  const ok = (l: typeof shown) =>
    !!l && l.katex === "a" && l.text!.includes("#num_total/#num_concurrent") && !l.text!.includes("$");
  const centered = geo.length === 1 && Math.abs(geo[0].labelCenter - geo[0].spanCenter) <= 2 && geo[0].inBlock;
  check("annotMathStatic", ok(shown) && centered, { shown, geo });
  const pm = `${card("n1")} .md-pm`;
  await pg.locator(`${card("n1")} .nbody p`).dblclick({ position: { x: 20, y: 40 } });
  await pg.waitForSelector(`${pm} .md-annot`, { timeout: 5000 });
  await idle(h);
  const edit = await label(pm);
  const egeo = await annotGeo(pg, pm);
  check(
    "annotMathEditor",
    ok(edit) && !edit!.editable && egeo.length === 1 && Math.abs(egeo[0].labelCenter - egeo[0].spanCenter) <= 2,
    { edit, egeo },
  );
  await shot(h, "marks-annotation-math-editing");
  await focusSettled(pg);
  // select the annotated words in the source (the drawn annotation is not editable text)
  await pg.evaluate((pm) => {
    const e = (document.querySelector(pm) as any).editor,
      w = "{==wave count==|";
    let at = -1;
    e.state.doc.descendants((n: any, pos: number) => {
      if (at < 0 && n.isText && n.text.includes(w)) at = pos + n.text.indexOf(w);
    });
    e.commands.setTextSelection({ from: at + 1, to: at + 1 + "==wave count==".length });
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

/** #121: a note with \frac{a}{b} ({ } pairs in its formula). Typed as source in the editor, and written in the toolbar's
 *  Handwritten Note field: both become annotations whose label typesets the fraction, in the editor and the static Note, and
 *  the saved Markdown keeps the formula as typed, the same after the board is opened again */
test("noteAnnotationFraction", async () => {
  const b = emptyBoard("b1", "annotations");
  const md = "所以 3.2 GHz 的总线带宽是 DDR5-6400 的几倍。";
  b.cards.push({ id: "n1", kind: "note", md, look: "note" } as NoteCard);
  b.place.n1 = { x: 80, y: 80, w: 560 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 800, h: 380, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  const pm = `${card("n1")} .md-pm`;
  const fracs = (root: string) =>
    pg.evaluate(
      (root) =>
        [...document.querySelectorAll<HTMLElement>(`${root} .md-annot > .md-annot-n`)].map((n) => ({
          frac: !!n.querySelector(".katex .mfrac"),
          text: n.textContent ?? "",
        })),
      root,
    );
  await pg.locator(`${card("n1")} .nbody p`).dblclick({ position: { x: 20, y: 10 } });
  await pg.waitForSelector(pm, { timeout: 5000 });
  await pg.keyboard.press("Control+End");
  await pg.keyboard.type(" 合计 {==64 位==|$\\frac{a}{b}$ 倍}。");
  await idle(h);
  const typed = await fracs(pm);
  check("annotFracTypedInEditor", typed.length === 1 && typed[0].frac && typed[0].text.includes("倍"), typed);
  // the toolbar's Handwritten Note on "DDR5-6400"
  await focusSettled(pg);
  await pg.evaluate((pm) => {
    const e = (document.querySelector(pm) as any).editor,
      w = "DDR5-6400";
    let at = -1;
    e.state.doc.descendants((n: any, pos: number) => {
      if (at < 0 && n.isText && n.text.includes(w)) at = pos + n.text.indexOf(w);
    });
    e.commands.setTextSelection({ from: at, to: at + w.length });
  }, pm);
  await pmHasSelection(pg);
  const btn = pg.locator('.md-bubble .tbtn[data-tip="Handwritten Note"]');
  await btn.waitFor({ timeout: 2000 });
  await btn.click();
  const input = pg.locator(".md-bubble input.md-annotin");
  await input.waitFor({ timeout: 2000 });
  await input.fill("$\\frac{1}{2}$ 周期");
  await input.press("Enter");
  await idle(h);
  const both = await fracs(pm);
  check("annotFracFromToolbar", both.length === 2 && both.every((f) => f.frac), both);
  await pg.mouse.click(760, 360);
  await until(h, "the edit is saved", () => (h.board().cards[0] as NoteCard).md !== md);
  await idle(h);
  const saved = (h.board().cards[0] as NoteCard).md;
  check(
    "annotFracSaved",
    saved.includes("{==64 位==|$\\frac{a}{b}$ 倍}。") && saved.includes("{DDR5-6400|$\\frac{1}{2}$ 周期}"),
    { saved },
  );
  const shown = await fracs(card("n1"));
  check("annotFracStatic", shown.length === 2 && shown.every((f) => f.frac), shown);
  await shot(h, "marks-annotation-fraction");
  const board = h.board();
  await h.close();
  // opened again from what was saved
  const h2 = await open({ board, light: true, w: 800, h: 380, settings: { theme: "warm-ink" } as never });
  await idle(h2);
  const again = await h2.page.evaluate(
    () => [...document.querySelectorAll(".card .md-annot > .md-annot-n .katex .mfrac")].length,
  );
  check("annotFracReopened", again === 2 && (h2.board().cards[0] as NoteCard).md === saved, {
    again,
    md: (h2.board().cards[0] as NoteCard).md,
  });
  await h2.close();
});

/** #115: annotations close together on one line. Their labels never overlap: two that would are spread apart (the earlier
 *  one left, the later one right), and when that is not enough one goes up a row, with the line keeping room for it above
 *  (it does not cover the line before). Every label stays over its own arrow and inside its paragraph; static and editing */
test("noteAnnotationsApart", async () => {
  const b = emptyBoard("b1", "annotations");
  const md = [
    "DDR 在每个时钟周期**传输两次数据**，分别发生在时钟的上升沿和下降沿。",
    "",
    "所以 3.2 GHz 的 {==64 位==|8 字节}{==DDR5-6400==|双倍数据速率} 总线，带宽是 $8 \\times 2 \\times 3.2$ GHz。",
    "",
    "挤在一起：{==a==|很长的一条批注} {==b==|$x^2$ 也在这里|purple}{==c==|第三条|green} 之后。",
  ].join("\n");
  b.cards.push({ id: "n1", kind: "note", md, look: "note" } as NoteCard);
  b.place.n1 = { x: 80, y: 80, w: 520 };
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 760, h: 460, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await pg.evaluate(() => document.fonts.ready);
  const settled = async (root: string) => {
    await pg.waitForFunction(
      (root) =>
        [...document.querySelectorAll<HTMLElement>(`${root} .md-annot > .md-annot-n`)].every((n) => {
          const lb = getComputedStyle(n);
          return document.fonts.check(`${lb.fontWeight} ${lb.fontSize} ${lb.fontFamily}`, n.textContent ?? "");
        }),
      root,
      { timeout: 5000 },
    );
    await idle(h);
  };
  const layout = (root: string) =>
    pg.evaluate((root) => {
      const ps = [...document.querySelectorAll<HTMLElement>(`${root} p`)];
      return ps.map((p, k) => {
        const prev = k ? ps[k - 1].getBoundingClientRect().bottom : -Infinity;
        return {
          prev,
          right: p.getBoundingClientRect().right,
          left: p.getBoundingClientRect().left,
          labels: [...p.querySelectorAll<HTMLElement>(".md-annot")].map((e) => {
            const r = e.getBoundingClientRect(),
              l = e.querySelector(":scope > .md-annot-n")!.getBoundingClientRect();
            return {
              note: e.dataset.note,
              arrow: r.left + r.width / 2,
              l: l.left,
              r: l.right,
              t: l.top,
              b: l.bottom,
              rise: e.style.getPropertyValue("--rise"),
            };
          }),
        };
      });
    }, root);
  const verdict = (ps: Awaited<ReturnType<typeof layout>>) => {
    const bad: string[] = [];
    for (const p of ps)
      p.labels.forEach((a, i) => {
        if (!(a.l < a.arrow - 2 && a.r > a.arrow + 2)) bad.push(`${a.note}: off its arrow`);
        if (a.l < p.left - 0.5 || a.r > p.right + 0.5) bad.push(`${a.note}: outside its paragraph`);
        if (a.t < p.prev - 0.5) bad.push(`${a.note}: over the line before`);
        for (const o of p.labels.slice(i + 1))
          if (a.l < o.r - 0.5 && o.l < a.r - 0.5 && a.t < o.b - 0.5 && o.t < a.b - 0.5)
            bad.push(`${a.note} overlaps ${o.note}`);
      });
    return bad;
  };
  await settled(card("n1"));
  const shown = await layout(`${card("n1")} .nbody`);
  check("annotApartCount", shown.flatMap((p) => p.labels).length === 5, shown);
  check("annotApartStatic", verdict(shown).length === 0, { bad: verdict(shown), shown });
  check(
    "annotApartRaised",
    shown[2]?.labels.some((a) => parseFloat(a.rise) > 0),
    shown[2],
  );
  await shot(h, "marks-annotations-apart");
  await pg
    .locator(`${card("n1")} .nbody p`)
    .first()
    .dblclick({ position: { x: 20, y: 10 } });
  await pg.waitForSelector(`${card("n1")} .md-pm .md-annot`, { timeout: 5000 });
  await settled(`${card("n1")} .md-pm`);
  const ed = await layout(`${card("n1")} .md-pm`);
  check("annotApartEditorCount", ed.flatMap((p) => p.labels).length === 5, ed);
  check("annotApartEditor", verdict(ed).length === 0, { bad: verdict(ed), ed });
  await shot(h, "marks-annotations-apart-editing");
  await h.close();
});

/** The annotation label is drawn in the bundled handwriting fonts (Shantell Sans for Latin, Yozai for Chinese):
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
      const lb = getComputedStyle(e.querySelector(":scope > .md-annot-n")!),
        font = `${lb.fontWeight} ${lb.fontSize} ${lb.fontFamily}`;
      return { note: e.dataset.note!, family: lb.fontFamily, checked: document.fonts.check(font, e.dataset.note) };
    });
    // a family is loaded when one of its faces is (Yozai is split into chunks by characters; only the ones shown load)
    const faces: Record<string, string> = {};
    for (const x of document.fonts)
      if (/Shantell Sans|Yozai/.test(x.family) && faces[x.family.replace(/"/g, "")] !== "loaded")
        faces[x.family.replace(/"/g, "")] = x.status;
    // glyphs drawn with the label's font stack vs the same stack without the bundled face: they differ only if the bundled face is used
    const draw = (font: string, t: string) => {
      const c = document.createElement("canvas");
      c.width = 160;
      c.height = 40;
      const x = c.getContext("2d")!;
      x.font = font;
      x.fillText(t, 2, 30);
      return x.getImageData(0, 0, 160, 40).data;
    };
    const differ = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let n = 0;
      for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) n++;
      return n;
    };
    const stack = labels[0]?.family ?? "";
    const without = (name: string) =>
      stack
        .split(",")
        .filter((s) => !s.includes(name))
        .join(",");
    return {
      labels,
      faces,
      cjk: differ(draw(`24px ${stack}`, "异构计算"), draw(`24px ${without("Yozai")}`, "异构计算")),
      latin: differ(draw(`24px ${stack}`, "thread"), draw(`24px ${without("Shantell")}`, "thread")),
    };
  });
  check(
    "annotHandFontFamily",
    f.labels.length === 3 && f.labels.every((l) => /^"?Shantell Sans"?,\s*"?Yozai"?/.test(l.family)),
    f.labels,
  );
  check(
    "annotHandFontsLoaded",
    f.faces["Shantell Sans"] === "loaded" && f.faces.Yozai === "loaded" && f.labels.every((l) => l.checked),
    f,
  );
  check("annotHandGlyphsFromBundledFonts", f.cjk > 50 && f.latin > 50, f);
  await h.close();
});

/** Handwritten Note in the Note editor's selection toolbar: select words → the button → type the note (the label shows on the words
 *  as you type) → Enter; one undo takes it off; on an annotated selection the button is on and opens with its note, Escape keeps it */
test("noteAnnotationFromToolbar", async () => {
  const b = emptyBoard("b1", "annotations");
  b.cards.push({
    id: "n1",
    kind: "note",
    md: "Prefill and decode never share a batch in nano-vllm.",
    look: "note",
  } as NoteCard);
  b.place.n1 = { x: 80, y: 80, w: 460 };
  b.cam = { x: 0, y: 0, z: 1.25 };
  const h = await open({ board: b, light: true, w: 820, h: 420, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  const pm = `${card("n1")} .md-pm`;
  const md = () => (h.board().cards[0] as NoteCard).md;
  await pg.locator(`${card("n1")} .nbody p`).dblclick({ position: { x: 20, y: 8 } });
  await pg.waitForSelector(pm, { timeout: 5000 });
  const sel = (w: string) =>
    pg.evaluate(
      ([root, w]) => {
        const t = [...document.querySelector(root)!.querySelectorAll("p")]
          .map((p) => p.firstChild as Text)
          .find((n) => n?.data.includes(w))!;
        const r = document.createRange(),
          i = t.data.indexOf(w);
        r.setStart(t, i);
        r.setEnd(t, i + w.length);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(r);
      },
      [pm, w] as const,
    );
  await focusSettled(pg); // a selection set by script within ProseMirror's focus window would be undone
  await sel("never share a batch");
  await pmHasSelection(pg);
  const btn = pg.locator('.md-bubble .tbtn[data-tip="Handwritten Note"]');
  await btn.waitFor({ timeout: 2000 });
  await idle(h);
  const tip = await btn.evaluate((b) => ({
    label: b.getAttribute("aria-label"),
    on: b.classList.contains("on"),
    ico: !!b.querySelector("svg.md-ico path")?.getAttribute("d"),
  }));
  check("annotButton", tip.label === "Handwritten Note" && !tip.on && tip.ico, tip);
  await btn.hover();
  await pg.locator(".tip").waitFor();
  await idle(h); // its tooltip is in the picture
  await shot(h, "marks-annotation-toolbar-button");
  await btn.click();
  const input = pg.locator(".md-bubble input.md-annotin");
  await input.waitFor({ timeout: 2000 });
  check("annotInputFocused", await input.evaluate((i) => document.activeElement === i));
  await pg.keyboard.type("not mixed");
  await pg.locator(`${pm} .md-annot`).first().waitFor();
  await frames(pg);
  const live = await pg.locator(`${pm} .md-annot`).evaluateAll((es) =>
    es.map((e) => [
      [...e.childNodes]
        .filter((k) => !(k as Element).classList?.contains("md-annot-n"))
        .map((k) => k.textContent)
        .join(""),
      (e as HTMLElement).dataset.note,
    ]),
  );
  check(
    "annotLivePreview",
    live.length === 1 && live[0][0] === "never share a batch" && live[0][1] === "not mixed",
    live,
  );
  await shot(h, "marks-annotation-toolbar-typing");
  await pg.keyboard.press("Enter");
  await input.waitFor({ state: "detached" });
  check(
    "annotEditorFocusedAfterEnter",
    await pg.evaluate(
      (pm) =>
        document.activeElement === document.querySelector(`${pm} .ProseMirror`) ||
        !!document.activeElement?.closest(pm),
      pm,
    ),
  );
  // the button is on for the annotated words; it opens with the note, Escape leaves it as it was. The toolbar comes back
  // TOOLBAR_SETTLE after the editor has the focus again: wait (up to 5 s) for it with its button on
  const on = await until(h, "the toolbar is back with Handwritten Note on", () =>
    btn.evaluate((b) => b.classList.contains("on")).catch(() => false),
  ).catch(() => false);
  await btn.click();
  await input.waitFor({ timeout: 2000 });
  const prefilled = await input.inputValue();
  await pg.keyboard.press("Escape");
  await input.waitFor({ state: "detached" });
  await frames(pg);
  const kept = await pg.locator(`${pm} .md-annot`).evaluateAll((es) => es.map((e) => (e as HTMLElement).dataset.note));
  check("annotButtonEditsExisting", on && prefilled === "not mixed" && kept.length === 1 && kept[0] === "not mixed", {
    on,
    prefilled,
    kept,
  });
  // one undo takes the annotation off (the live preview steps are not separate undo steps)
  await pg.keyboard.press("ControlOrMeta+z");
  await frames(pg); // ProseMirror's undo changes the DOM on the key press
  const undone = await pg.evaluate(
    (pm) => ({
      annots: document.querySelectorAll(`${pm} .md-annot`).length,
      text: document.querySelector(pm)!.textContent,
    }),
    pm,
  );
  await pg.keyboard.press("ControlOrMeta+Shift+z");
  await frames(pg);
  // redo puts the caret back in the annotation, which then shows as its source
  const redone = await pg.evaluate((pm) => document.querySelector(pm)!.textContent, pm);
  check(
    "annotOneUndoStep",
    undone.annots === 0 &&
      undone.text === "Prefill and decode never share a batch in nano-vllm." &&
      redone === "Prefill and decode {never share a batch|not mixed} in nano-vllm.",
    { undone, redone },
  );
  await pg.mouse.click(760, 380);
  await pg.locator(pm).waitFor({ state: "detached" });
  await idle(h); // the editor has closed and its save reached the host
  check("annotSaved", md() === "Prefill and decode {never share a batch|not mixed} in nano-vllm.", md());
  await shot(h, "marks-annotation-toolbar-saved");
  await h.close();
});

/** A Mark m1 at (80, 80) in Warm Ink, and `more` Marks below it (for the picture) */
async function oneMark(md: string, extra: Partial<NoteCard> = {}, w = 1000, hgt = 420, more: Partial<NoteCard>[] = []) {
  const b = emptyBoard("b1", "marks");
  b.cards.push({ id: "m1", kind: "note", md, look: "mark", hand: "blue", ...extra } as NoteCard);
  b.place.m1 = { x: 80, y: 80, w: 420 };
  more.forEach((c, i) => {
    const id = `mm${i}`;
    b.cards.push({ id, kind: "note", md, look: "mark", hand: "blue", ...c } as NoteCard);
    b.place[id] = { x: 80, y: 170 + i * 70, w: 700 };
  });
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w, h: hgt, settings: { theme: "warm-ink" } as never });
  await h.page.evaluate(() => document.fonts.ready);
  return h;
}
const mark = (h: Host) => h.board().cards.find((c) => c.id === "m1") as NoteCard;

/** The bundled Chinese faces (Yozai): which chunks are loaded (their weights), and how the Mark's glyphs are drawn with and
 *  without them (canvas: the stack as computed vs the same stack without Yozai differ only when Yozai draws them) */
const yozaiOf = (h: Host, text: string) =>
  h.page.evaluate(
    ({ sel, text }) => {
      const t = document.querySelector<HTMLElement>(sel)!,
        cs = getComputedStyle(t);
      const faces = [...document.fonts].filter((x) => x.family.replace(/"/g, "") === "Yozai");
      const draw = (font: string) => {
        const c = document.createElement("canvas");
        c.width = 260;
        c.height = 40;
        const x = c.getContext("2d")!;
        x.font = font;
        x.fillText(text, 2, 30);
        return x.getImageData(0, 0, 260, 40).data;
      };
      const stack = cs.fontFamily,
        without = stack
          .split(",")
          .filter((s) => !s.includes("Yozai"))
          .join(",");
      const a = draw(`${cs.fontWeight} 24px ${stack}`),
        b = draw(`${cs.fontWeight} 24px ${without}`);
      let differ = 0;
      for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) differ++;
      return {
        family: stack,
        weight: cs.fontWeight,
        faces: faces.length,
        loaded: faces.filter((x) => x.status === "loaded").map((x) => x.weight),
        differ,
      };
    },
    { sel: `${card("m1")} .tx`, text },
  );

/** #117: Chinese in a Mark is handwriting too: the bundled Yozai next to Shantell Sans, split into chunks by characters so only the
 *  few chunks of the characters shown are downloaded, and the glyphs really come from it (not a system fallback) */
test("markCjkHandFont", async () => {
  const h = await oneMark("Hello 你好 共享内存 warp 调度", {}, 1000, 420, [{ fs: 36 }]);
  const f = await until(h, "the Chinese chunks are loaded", async () => {
    const r = await yozaiOf(h, "你好共享内存调度");
    return r.loaded.length ? r : undefined;
  });
  check("markCjkFontFamily", /^"?Shantell Sans"?,\s*"?Yozai"?/.test(f.family), f);
  // 90 faces (45 chunks × Regular and Bold); "你好共享内存调度" is in 3 chunks of Regular
  check("markCjkFontChunked", f.faces >= 80 && f.loaded.length >= 1 && f.loaded.length <= 4, f);
  check("markCjkGlyphsFromBundledFont", f.differ > 80, f);
  await shot(h, "117-mark-cjk");
  await h.close();
});

/** #118: dragging a Mark's corner scales its whole text (font size and width together, so it wraps at the same words) with a real
 *  font size (crisp, no transform), within limits, as one undo step, and each move's work fits in a frame */
test("markScaleText", async () => {
  const h = await oneMark("prefill / decode never share a batch", {}, 1100, 640);
  const pg = h.page;
  await pg.locator(`${card("m1")} .tx`).click();
  const grip = (await pg.locator(`${card("m1")} .mkgrip`).boundingBox())!;
  const box0 = (await pg.locator(card("m1")).boundingBox())!;
  const lines = () =>
    pg.evaluate(
      (sel) => {
        const t = document.querySelector<HTMLElement>(sel)!;
        return Math.round(t.offsetHeight / parseFloat(getComputedStyle(t).lineHeight));
      },
      `${card("m1")} .tx`,
    );
  const lines0 = await lines();
  const gx = grip.x + grip.width / 2,
    gy = grip.y + grip.height / 2;
  await pg.mouse.move(gx, gy);
  await pg.mouse.down();
  await pg.mouse.move(gx + 4, gy + 2);
  // the pointer moves along the card's diagonal: the CPU time of each move's change and layout
  const spans = await cpuSpans(pg, () =>
    pg.evaluate(
      async ({ gx, gy, w, hh }) => {
        for (let i = 1; i <= 24; i++) {
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
          performance.mark("cpu:start");
          const k = (i * 10) / Math.hypot(w, hh);
          window.dispatchEvent(
            new PointerEvent("pointermove", { clientX: gx + w * k, clientY: gy + hh * k, bubbles: true, buttons: 1 }),
          );
          document.querySelector(".card.mark")!.getBoundingClientRect();
          performance.mark("cpu:end");
        }
      },
      { gx, gy, w: box0.width, hh: box0.height },
    ),
  );
  await pg.mouse.move(gx + box0.width * 0.6, gy + box0.height * 0.6);
  await pg.mouse.up();
  const m = await until(h, "the new size is saved", () => (mark(h).fs ? mark(h) : undefined));
  await idle(h);
  const t = await pg.evaluate(
    (sel) => {
      const e = document.querySelector<HTMLElement>(sel)!,
        cs = getComputedStyle(e),
        c = getComputedStyle(e.closest(".card")!);
      return { size: cs.fontSize, transform: cs.transform, cardScale: c.scale, cardTransform: c.transform };
    },
    `${card("m1")} .tx`,
  );
  const w = h.board().place.m1.w;
  check(
    "markScaleFontSize",
    m.fs! > 25 &&
      t.size === `${m.fs}px` &&
      t.transform === "none" &&
      t.cardTransform === "none" &&
      t.cardScale === "none",
    { fs: m.fs, t },
  );
  check("markScaleWidthFollows", Math.abs(w / 420 - m.fs! / 18) < 0.02, { w, fs: m.fs });
  const lines1 = await lines();
  check("markScaleSameLines", lines1 === lines0, { before: lines0, after: lines1 });
  spans.sort((a, b) => a - b);
  check("markScaleFrameCpu", spans.length >= 20 && spans[Math.floor(spans.length / 2)] < 8, spans);
  await shot(h, "118-mark-scaled");
  // one undo step back to the default size and the old width
  await pg.keyboard.press("Meta+z");
  await until(h, "the scale is undone", () => mark(h).fs === undefined);
  check("markScaleUndo", mark(h).fs === undefined && h.board().place.m1.w === 420, {
    m: mark(h),
    w: h.board().place.m1.w,
  });
  // far past the smallest size: it stops at the limit
  await pg.locator(`${card("m1")} .tx`).click();
  const g2 = (await pg.locator(`${card("m1")} .mkgrip`).boundingBox())!;
  await pg.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
  await pg.mouse.down();
  for (let i = 1; i <= 10; i++) await pg.mouse.move(g2.x - i * 60, g2.y - i * 20);
  await pg.mouse.up();
  await until(h, "the small size is saved", () => mark(h).fs);
  check("markScaleMin", mark(h).fs === TEXT_FS.min, mark(h));
  await h.close();
});

/** #120: a Mark's weight, Light / Regular / Bold, from its toolbar beside the colour dots: one step each, undoable, and both the
 *  Latin (Shantell Sans, a variable font) and the Chinese (Yozai's own Bold, not a synthesized one; Light keeps Regular) follow it */
test("markWeight", async () => {
  const h = await oneMark("Hello 你好 共享内存", {}, 1000, 420, [
    { fs: 32, weight: "light" },
    { fs: 32 },
    { fs: 32, weight: "bold" },
  ]);
  const pg = h.page;
  await pg.locator(`${card("m1")} .tx`).click();
  await pg
    .locator(`${card("m1")} .hdots .hwt`)
    .first()
    .waitFor();
  const btns = await pg
    .locator(`${card("m1")} .hdots .hwt`)
    .evaluateAll((bs) => bs.map((b) => ({ tip: b.getAttribute("data-tip"), on: b.classList.contains("on") })));
  check(
    "markWeightButtons",
    btns.map((b) => b.tip).join("|") === "Light|Regular|Bold" && btns[1].on && !btns[0].on && !btns[2].on,
    btns,
  );
  await shot(h, "120-mark-weight-toolbar");
  await pg.locator(`${card("m1")} .hwt[data-tip="Bold"]`).click();
  await until(h, "the weight is saved", () => mark(h).weight === "bold");
  const bold = await until(h, "Yozai Bold is loaded", async () => {
    const r = await yozaiOf(h, "你好共享内存");
    return r.loaded.includes("700") ? r : undefined;
  });
  const latin = await pg.evaluate(
    (sel) => {
      const t = document.querySelector<HTMLElement>(sel)!;
      const shantell = [...document.fonts].find((x) => x.family.replace(/"/g, "") === "Shantell Sans");
      return { weight: getComputedStyle(t).fontWeight, axis: shantell?.weight, status: shantell?.status };
    },
    `${card("m1")} .tx`,
  );
  check("markWeightBold", bold.weight === "700" && bold.differ > 80, bold);
  check(
    "markWeightLatinVariable",
    latin.weight === "700" && latin.axis === "300 800" && latin.status === "loaded",
    latin,
  );
  await pg.locator(`${card("m1")} .hwt[data-tip="Light"]`).click();
  await until(h, "Light is saved", () => mark(h).weight === "light");
  // Yozai ships Regular and Bold only: a Light Mark's Latin is Shantell Sans at 300, its Chinese is Yozai Regular as it is (the
  // same pixels as at 400, nothing synthesized), still Yozai and not a system font
  const thin = await yozaiOf(h, "你好共享内存");
  const light = await pg.evaluate(
    (sel) => {
      const t = document.querySelector<HTMLElement>(sel)!,
        cs = getComputedStyle(t);
      const draw = (font: string, text: string) => {
        const c = document.createElement("canvas");
        c.width = 260;
        c.height = 40;
        const x = c.getContext("2d")!;
        x.font = font;
        x.fillText(text, 2, 30);
        return x.getImageData(0, 0, 260, 40).data;
      };
      const differ = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let n = 0;
        for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) n++;
        return n;
      };
      return {
        cjk300vs400: differ(
          draw(`300 24px ${cs.fontFamily}`, "你好共享内存"),
          draw(`400 24px ${cs.fontFamily}`, "你好共享内存"),
        ),
        latin300vs400: differ(draw(`300 24px ${cs.fontFamily}`, "Hello"), draw(`400 24px ${cs.fontFamily}`, "Hello")),
        synthesis: cs.getPropertyValue("font-synthesis-weight"),
        lightFaces: [...document.fonts].filter((x) => x.family.replace(/"/g, "") === "Yozai" && x.weight === "300")
          .length,
      };
    },
    `${card("m1")} .tx`,
  );
  check(
    "markWeightLight",
    thin.weight === "300" &&
      thin.differ > 80 &&
      light.cjk300vs400 === 0 &&
      light.latin300vs400 > 20 &&
      light.lightFaces === 0 &&
      light.synthesis === "auto",
    { thin, light },
  );
  await pg.keyboard.press("Meta+z");
  await until(h, "Light is undone", () => mark(h).weight === "bold");
  await pg.keyboard.press("Meta+z");
  await until(h, "Bold is undone", () => mark(h).weight === undefined);
  check("markWeightUndo", mark(h).weight === undefined, mark(h));
  await pg.mouse.click(900, 60);
  await shot(h, "120-mark-weights");
  await h.close();
});

/** #123: S / M / L / XL on a Mark's toolbar, after the weights: each sets the font size in one undo step, the width scaled with it
 *  as a corner drag scales it; the current size's button is lit, none for a size dragged off the steps */
test("markSizes", async () => {
  const h = await oneMark("picks this batch 先挑这一批", {}, 1400, 560);
  const pg = h.page;
  const sizeOf = () => pg.locator(`${card("m1")} .tx`).evaluate((t) => parseFloat(getComputedStyle(t).fontSize));
  const lit = () =>
    pg
      .locator(`${card("m1")} .hdots .hsz`)
      .evaluateAll((bs) => bs.filter((b) => b.classList.contains("on")).map((b) => b.textContent));
  await pg.locator(`${card("m1")} .tx`).click();
  await pg
    .locator(`${card("m1")} .hdots .hsz`)
    .first()
    .waitFor({ timeout: 3000 });
  const btns = await pg.locator(`${card("m1")} .hdots .hsz`).evaluateAll((bs) => bs.map((b) => b.textContent));
  check("markSizeButtons", btns.join("|") === "S|M|L|XL", btns);
  // a Mark never resized is at S, the default size
  check("markSizeDefaultLit", (await lit()).join() === "S", await lit());
  await shot(h, "123-mark-size-s");
  const steps = { M: 24, L: 32, XL: 48 } as const;
  for (const [k, px] of Object.entries(steps)) {
    await pg.locator(`${card("m1")} .hsz`, { hasText: new RegExp(`^${k}$`) }).click();
    await until(h, `${k} is saved`, () => mark(h).fs === px);
    await until(h, `${k} is drawn`, async () => (await sizeOf()) === px);
    // the width scales step by step from 420 at 18px, so it can be a pixel off from rounding once
    check(`markSize${k}`, (await lit()).join() === k && Math.abs(h.board().place.m1.w - (420 * px) / 18) <= 1, {
      lit: await lit(),
      w: h.board().place.m1.w,
    });
    await shot(h, `123-mark-size-${k.toLowerCase()}`);
  }
  // one step each: undoing XL is back at L with L's width
  await pg.keyboard.press("ControlOrMeta+z");
  await until(h, "XL is undone", () => mark(h).fs === 32);
  check("markSizeUndo", Math.abs(h.board().place.m1.w - (420 * 32) / 18) <= 1 && (await lit()).join() === "L", {
    m: mark(h),
    w: h.board().place.m1.w,
  });
  // the corner grip still scales it, off the steps: no button lit (it is still selected: a click on its text would edit it)
  const g = (await pg.locator(`${card("m1")} .mkgrip`).boundingBox())!;
  await pg.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await pg.mouse.down();
  for (let i = 1; i <= 4; i++) await pg.mouse.move(g.x + i * 9, g.y + i * 3);
  await pg.mouse.up();
  await until(h, "the dragged size is saved", () => mark(h).fs !== 32);
  const dragged = mark(h).fs;
  check("markSizeDragOffSteps", !!dragged && ![18, 24, 32, 48].includes(dragged), mark(h));
  await until(
    h,
    "no size is lit",
    async () => (await pg.locator(`${card("m1")} .hdots .hsz`).count()) === 4 && (await lit()).length === 0,
  );
  // and S takes it back to the default size, which is not written
  await pg.locator(`${card("m1")} .hsz`, { hasText: /^S$/ }).click();
  await until(h, "S is saved", () => mark(h).fs === undefined);
  check("markSizeS", (await sizeOf()) === TEXT_FS.mark && (await lit()).join() === "S", await lit());
  await h.close();
});

/** A Mark written as a heading ("# Basic Concepts", at a dragged size): Light / Regular / Bold from its toolbar set the heading's
 *  weight too, not the Markdown heading's own 600 */
test("markHeadingWeight", async () => {
  const b = emptyBoard("bMH", "mh");
  put(
    b,
    { id: "m1", kind: "note", md: "# Basic Concepts", look: "mark", hand: "blue", fs: 38.5 } as NoteCard,
    60,
    60,
    500,
  );
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 900, h: 500, settings: { theme: "warm-ink" } });
  const pg = h.page,
    sel = '.card[data-id="m1"]';
  await pg.locator(`${sel} .tx`).click();
  const seen: Record<string, string> = {};
  for (const [tip, w] of [
    ["Bold", "bold"],
    ["Light", "light"],
    ["Regular", "regular"],
  ] as const) {
    await pg.locator(`${sel} .hwt[data-tip="${tip}"]`).click();
    await until(
      h,
      `${tip} is saved`,
      () => (h.board().cards[0] as NoteCard).weight === (w === "regular" ? undefined : w),
    );
    await idle(h);
    seen[tip] = await pg.locator(`${sel} .tx h1`).evaluate((e) => getComputedStyle(e).fontWeight);
  }
  check(
    "markHeadingWeight each weight reaches the heading",
    seen.Bold === "700" && seen.Light === "300" && seen.Regular === "400",
    seen,
  );
  await h.close();
});

// Text and Box: one card in two looks (a Box adds a fill and a rounded frame). Markdown at a size of its own (S M L XL or any size
// its corner is dragged to), as wide as its text until a side edge sets the width it wraps at, never narrower than its longest
// word, always as tall as its text.
//   textBoxMigratedLooks     the old Text levels, Free Text, Mark and Box open as Texts and Boxes at the pixels they had, in one layer
//   textBoxSwitchKeepsText   Text ↔ Box from the bar: the first line stays where it was, the size and the line breaks too; one undo step;
//                            a Box takes the fill it had, yellow the first time
//   textBoxSizes             S M L XL from the bar (the lit one follows), a corner drag to any size (none lit), on a Box too, one undo step
//   textBoxEdgeWraps         a side edge sets the width it wraps at, not past its longest word; double-clicking an edge and Fit Content
//                            do nothing
//   textBoxCreateAndEmptyGoes  a double-click on empty board makes a Text to type in; a new Text or Box left empty goes with no undo step
//   textBoxCommonContent     words, bold, inline code, a formula, a list and headings at the card's size, in a Text and a Box
import { shot, put, type Host } from "../harness";
import { DEFAULT_SETTINGS, emptyBoard, migrateBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle } from "../fixtures";

const card = (id: string) => `.card[data-id="${id}"]`;
const byId = (h: Host, id: string) => h.board().cards.find((c) => c.id === id) as NoteCard | undefined;
const note = (id: string, md: string, o: Partial<NoteCard> = {}): NoteCard => ({
  id,
  kind: "note",
  md,
  look: "text",
  ...o,
});
const board = (name: string) => ({ ...emptyBoard("b1", name), cam: { x: 0, y: 0, z: 1 } }) as Board;
/** Selects the card alone (a click on a card already selected alone would start writing in it) */
const select = async (h: Host, id: string) => {
  const sel = await h.page
    .locator(card(id))
    .evaluate((e) => e.classList.contains("sel") && e.classList.contains("solo"));
  if (!sel) await h.page.locator(`${card(id)} > .cface > .tx`).click();
  await h.page.locator(`${card(id)} .ttb.tbar`).waitFor();
  await idle(h);
};
const undo = (h: Host) => h.page.keyboard.press("ControlOrMeta+z");

/** Each glyph's box on screen (whitespace left out), the text's font size and which glyphs start a line */
const glyphs = (h: Host, id: string) =>
  h.page.evaluate((sel) => {
    const tx = document.querySelector<HTMLElement>(`${sel} > .cface > .tx`)!;
    const walk = document.createTreeWalker(tx, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    const at: { x: number; y: number }[] = [];
    for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null)
      for (let i = 0; i < n.data.length; i++) {
        if (!n.data[i].trim()) continue;
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        const b = r.getBoundingClientRect();
        at.push({ x: b.left, y: b.top });
      }
    const starts = at.flatMap((g, i) => (i === 0 || g.y > at[i - 1].y + 2 ? [i] : []));
    return { first: at[0], starts, fs: getComputedStyle(tx).fontSize, n: at.length };
  }, card(id));

/** The card on screen: its width and height, its classes, the font size and weight of what it shows, and whether the text fits */
const shown = (h: Host, id: string, inner = "p") =>
  h.page.evaluate(
    ({ sel, inner }) => {
      const c = document.querySelector<HTMLElement>(sel)!,
        tx = c.querySelector<HTMLElement>(":scope > .cface > .tx")!,
        e = tx.querySelector<HTMLElement>(inner) ?? tx,
        cs = getComputedStyle(e);
      return {
        cls: c.className,
        w: c.offsetWidth,
        h: c.offsetHeight,
        fs: parseFloat(cs.fontSize),
        weight: +cs.fontWeight,
        text: tx.textContent,
        fits: tx.scrollWidth <= tx.clientWidth + 1,
        layer: c.parentElement?.className ?? "",
        bg: getComputedStyle(c).backgroundColor,
      };
    },
    { sel: card(id), inner },
  );

/** A v13 board with every old look: the Text levels and bold, Free Text (plain text, levels, its own size), a Mark, a Box with the
 *  least height it had */
test("textBoxMigratedLooks", async () => {
  const old = {
    ...emptyBoard("b1", "old looks"),
    version: 13,
    cards: [
      { id: "tt", kind: "note", look: "text", size: "title", md: "Scheduler step" },
      { id: "tb", kind: "note", look: "text", size: "body", bold: true, md: "keep the batch" },
      { id: "f1", kind: "note", look: "freetext", level: 1, md: "Attention" },
      { id: "fp", kind: "note", look: "freetext", md: "a*b* <c> # d ==e==" },
      { id: "mk", kind: "note", look: "mark", hand: "orange", weight: "bold", fs: 24, md: "picks **this**" },
      { id: "bx", kind: "note", look: "box", fill: "blue", md: "prefill" },
    ],
    place: {
      tt: { x: 40, y: 40, w: 360 },
      tb: { x: 40, y: 140, w: 360 },
      f1: { x: 480, y: 40, w: 200 },
      fp: { x: 480, y: 160, w: 200 },
      mk: { x: 40, y: 240, w: 300 },
      bx: { x: 480, y: 260, w: 160, h: 90 },
    },
  };
  const b = migrateBoard(JSON.parse(JSON.stringify(old)));
  const h = await open({ board: { ...b, cam: { x: 0, y: 0, z: 1 } } as Board, light, w: 900, h: 480 });
  const tt = await shown(h, "tt", "h1"),
    tb = await shown(h, "tb", "strong"),
    f1 = await shown(h, "f1", "h1"),
    fp = await shown(h, "fp"),
    mk = await shown(h, "mk"),
    bx = await shown(h, "bx");
  const all = { tt, tb, f1, fp, mk, bx };
  check(
    "textBoxMigrated each is a Text or a Box, none a Mark or a Free Text",
    Object.values(all).every((s) => /\btext\b/.test(s.cls) && !/\b(mark|freetext)\b/.test(s.cls)) &&
      /\bbox\b/.test(bx.cls) &&
      Object.entries(all).every(([k, s]) => (k === "bx") === /\bbox\b/.test(s.cls)),
    all,
  );
  check(
    "textBoxMigrated the old pixel sizes: title 26, bold body 13.5, H1 40, plain Free Text 20, Mark 24, Box 13.5",
    Math.abs(tt.fs - 26) < 0.5 &&
      tb.fs === 13.5 &&
      tb.weight >= 600 &&
      Math.abs(f1.fs - 40) < 0.5 &&
      fp.fs === 20 &&
      mk.fs === 24 &&
      bx.fs === 13.5,
    all,
  );
  check("textBoxMigrated a Free Text's plain text shows as it was", fp.text === "a*b* <c> # d ==e==", fp);
  check(
    "textBoxMigrated old Texts and Marks wrap at their width, a Free Text is as wide as its text",
    tt.w === 360 && tb.w === 360 && mk.w === 300 && f1.w < 200 && /\bwrapw\b/.test(tt.cls) && !/\bwrapw\b/.test(f1.cls),
    all,
  );
  check(
    "textBoxMigrated the Box keeps its fill and width, as tall as its text (no least height)",
    bx.w === 160 && bx.h < 60 && bx.bg !== "rgba(0, 0, 0, 0)" && h.board().place.bx.h === undefined,
    { bx, place: h.board().place.bx },
  );
  check(
    "textBoxMigrated Texts and the Box draw in one layer, above the cards'",
    Object.values(all).every((s) => /\bkeeplay\b/.test(s.layer)),
    Object.fromEntries(Object.entries(all).map(([k, s]) => [k, s.layer])),
  );
  await shot(h, "text-box-migrated");
  await h.close();
});

/** Text → Box → Text from the bar: one step each, the text where it was (first glyph, size, line breaks) */
test("textBoxSwitchKeepsText", async () => {
  const b = board("switch");
  put(
    b,
    note("w", "prefill admits waiting sequences until the token budget runs out", { wrap: true, fs: 24 }),
    80,
    80,
    360,
  );
  put(b, note("u", "Model Runner"), 80, 320, 200);
  const h = await open({ board: b, light, w: 900, h: 520 });
  const pg = h.page;
  const same = (a: Awaited<ReturnType<typeof glyphs>>, z: Awaited<ReturnType<typeof glyphs>>) =>
    a.n === z.n &&
    a.fs === z.fs &&
    a.starts.join() === z.starts.join() &&
    Math.abs(a.first.x - z.first.x) <= 0.6 &&
    Math.abs(a.first.y - z.first.y) <= 0.6;
  for (const id of ["w", "u"]) {
    const g0 = await glyphs(h, id);
    const p0 = { ...h.board().place[id] };
    await select(h, id);
    await pg.locator(`${card(id)} .tbar button[aria-label="Box"]`).click();
    await until(h, `${id} is a Box`, () => byId(h, id)?.look === "box");
    await idle(h);
    const g1 = await glyphs(h, id);
    check(`textBoxSwitch ${id} to a Box: the text stays put`, same(g0, g1), { g0, g1 });
    check(`textBoxSwitch ${id} a first Box is yellow`, !("fill" in byId(h, id)!), byId(h, id));
    if (id === "w") await shot(h, "text-box-switched");
    await pg.locator(`${card(id)} .tbar .bdot.bf-pink`).click();
    await until(h, "the fill is pink", () => byId(h, id)?.fill === "pink");
    await pg.locator(`${card(id)} .tbar button[aria-label="Text"]`).click();
    await until(h, `${id} is a Text again`, () => byId(h, id)?.look === "text");
    await idle(h);
    const g2 = await glyphs(h, id);
    check(`textBoxSwitch ${id} back to a Text: the text stays put`, same(g0, g2), { g0, g2 });
    await pg.locator(`${card(id)} .tbar button[aria-label="Box"]`).click();
    await until(h, `${id} is a Box once more`, () => byId(h, id)?.look === "box");
    check(`textBoxSwitch ${id} a Box again takes its last fill`, byId(h, id)?.fill === "pink", byId(h, id));
    // undo: Box → Text, then pink → yellow, then Text → Box, then back to the Text it started as, where it was
    for (let i = 0; i < 4; i++) await undo(h);
    await until(h, `${id} is back as it was`, () => byId(h, id)?.look === "text" && !("fill" in byId(h, id)!));
    await idle(h);
    const p = h.board().place[id];
    check(
      `textBoxSwitch ${id} each switch is one undo step`,
      p.x === p0.x && p.y === p0.y && p.w === p0.w && same(g0, await glyphs(h, id)),
      { p, p0 },
    );
    await pg.mouse.click(700, 480);
    await idle(h);
  }
  await h.close();
});

/** S M L XL: 20 24 30 40 px, one step each, the lit one follows; a corner drag scales to any size (none lit) and is one step; a Box's
 *  corner scales its text, never its frame alone */
test("textBoxSizes", async () => {
  const b = board("sizes");
  put(b, note("t", "Scheduler"), 80, 80, 200);
  put(b, note("x", "Model Runner", { look: "box", fill: "green" }), 80, 300, 200);
  const h = await open({ board: b, light, w: 900, h: 560 });
  const pg = h.page;
  const lit = (id: string) => pg.locator(`${card(id)} .tbar .hsz.on:not(.hlook)`).allTextContents();
  await select(h, "t");
  check("textBoxSizes S is lit on a new Text", (await lit("t")).join() === "S", await lit("t"));
  const got: Record<string, unknown> = {};
  for (const [k, px] of [
    ["M", 24],
    ["L", 30],
    ["XL", 40],
    ["S", 20],
  ] as const) {
    await pg.locator(`${card("t")} .tbar .hsz`, { hasText: new RegExp(`^${k}$`) }).click();
    await until(h, `${k} is saved`, () => (byId(h, "t")?.fs ?? 20) === px);
    await idle(h);
    got[k] = { s: await shown(h, "t"), lit: await lit("t") };
    check(
      `textBoxSizes ${k} is ${px}px and lit`,
      (await shown(h, "t")).fs === px && (await lit("t")).join() === k,
      got[k],
    );
  }
  check("textBoxSizes S writes no size", !("fs" in byId(h, "t")!), byId(h, "t"));

  const drag = async (id: string, dx: number, dy: number) => {
    await select(h, id);
    const g = (await pg.locator(`${card(id)} .mkgrip`).boundingBox())!;
    await pg.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await pg.mouse.down();
    for (let i = 1; i <= 8; i++)
      await pg.mouse.move(g.x + g.width / 2 + (dx * i) / 8, g.y + g.height / 2 + (dy * i) / 8);
    await pg.mouse.up();
    await idle(h);
  };
  await drag("t", 70, 30);
  const big = await until(h, "the dragged size is saved", () => byId(h, "t")?.fs);
  check(
    "textBoxSizes a corner drag scales to a size of its own, none lit",
    big > 24 && ![20, 24, 30, 40].includes(big) && (await shown(h, "t")).fs === big && (await lit("t")).length === 0,
    { big, lit: await lit("t") },
  );
  await shot(h, "text-box-scaled");
  await undo(h);
  await until(h, "the drag is undone", () => !("fs" in byId(h, "t")!));
  check("textBoxSizes the drag is one undo step", (await shown(h, "t")).fs === 20);

  const x0 = await shown(h, "x");
  await drag("x", 80, 20);
  const bx = await until(h, "the Box's size is saved", () => byId(h, "x")?.fs);
  const x1 = await shown(h, "x");
  check(
    "textBoxSizes a Box's corner scales its text and its frame with it",
    bx > 20 && x1.fs === bx && x1.h > x0.h && x1.w > x0.w && h.board().place.x.h === undefined,
    { x0, x1, bx },
  );
  await h.close();
});

/** A side edge sets the width a Text wraps at; it stops at the longest word, which is never broken. A double-click on an edge and
 *  Fit Content (⌥F) do nothing */
test("textBoxEdgeWraps", async () => {
  const b = board("edges");
  put(b, note("t", "the block_manager_allocation_table keeps one entry per block"), 80, 80, 200);
  const h = await open({ board: b, light, w: 1100, h: 520 });
  const pg = h.page;
  const s0 = await shown(h, "t");
  await select(h, "t");
  const edge = async (dx: number) => {
    const r = (await pg.locator(`${card("t")} .hw.r`).boundingBox())!;
    await pg.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await pg.mouse.down();
    for (let i = 1; i <= 6; i++) await pg.mouse.move(r.x + r.width / 2 + (dx * i) / 6, r.y + r.height / 2);
    await pg.mouse.up();
    await idle(h);
  };
  check("textBoxEdge one line at first, as wide as its text", s0.h < 60 && s0.w > 400, s0);
  await edge(-s0.w / 2);
  await until(h, "the width is saved", () => byId(h, "t")?.wrap);
  const s1 = await shown(h, "t");
  check(
    "textBoxEdge a side edge sets the width it wraps at",
    Math.abs(s1.w - h.board().place.t.w) <= 1 && s1.w < s0.w && s1.h > s0.h && s1.fits && /\bwrapw\b/.test(s1.cls),
    { s0, s1, w: h.board().place.t.w },
  );
  const word = await pg.evaluate((sel) => {
    const tx = document.querySelector<HTMLElement>(`${sel} > .cface > .tx`)!,
      r = document.createRange(),
      n = [...tx.querySelectorAll("p")].flatMap((p) => [...p.childNodes])[0] as Text,
      i = n.data.indexOf("block_manager");
    r.setStart(n, i);
    r.setEnd(n, i + "block_manager_allocation_table".length);
    return r.getBoundingClientRect().width;
  }, card("t"));
  await edge(-s1.w);
  const s2 = await shown(h, "t");
  const g = await glyphs(h, "t");
  check(
    "textBoxEdge stops at the longest word, never breaking it",
    s2.fits && s2.w >= word && s2.w < word + 20 && h.board().place.t.w === s2.w,
    { s2, word, w: h.board().place.t.w, starts: g.starts },
  );
  await shot(h, "text-box-narrowest");
  const before = JSON.stringify({ c: byId(h, "t"), p: h.board().place.t });
  const r = (await pg.locator(`${card("t")} .hw.r`).boundingBox())!;
  await pg.mouse.dblclick(r.x + r.width / 2, r.y + r.height / 2);
  await idle(h);
  await pg.keyboard.press("Alt+f");
  await idle(h);
  check(
    "textBoxEdge a double-click on an edge and Fit Content leave it as it is",
    JSON.stringify({ c: byId(h, "t"), p: h.board().place.t }) === before && (await pg.locator(".md-pm").count()) === 0,
    { before, now: { c: byId(h, "t"), p: h.board().place.t } },
  );
  await h.close();
});

/** A double-click on empty board makes a Text to type in at once; a new Text or Box with nothing written goes when left, with no undo
 *  step (the next undo is the edit before it) */
test("textBoxCreateAndEmptyGoes", async () => {
  const b = board("create");
  put(b, note("t", "first"), 80, 80, 200);
  const h = await open({ board: b, light, w: 1000, h: 600, settings: { ...DEFAULT_SETTINGS, dblClick: "text" } });
  const pg = h.page;
  const n0 = h.board().cards.length;
  await pg.mouse.dblclick(500, 300);
  await pg.locator(".md-pm").waitFor();
  await pg.keyboard.type("from a double-click");
  await pg.keyboard.press("Escape");
  const made = await until(h, "the Text is saved", () =>
    h.board().cards.find((c): c is NoteCard => c.kind === "note" && c.md === "from a double-click"),
  );
  check("textBoxCreate a double-click makes a Text", made.look === "text" && h.board().cards.length === n0 + 1, made);
  await idle(h);
  for (const label of ["Text", "Box"]) {
    await pg.locator(`.bbar button[aria-label="${label}"]`).click();
    await pg.locator(".md-pm").waitFor();
    await idle(h);
    check(`textBoxCreate a new ${label} is on the board while written`, (await pg.locator(".card.text").count()) === 3);
    await pg.keyboard.press("Escape");
    await until(h, `the empty ${label} is gone`, async () => (await pg.locator(".card.text").count()) === 2);
    await idle(h);
    check(`textBoxCreate an empty ${label} goes`, h.board().cards.length === n0 + 1, h.board().cards);
  }
  await undo(h);
  await until(h, "the double-clicked Text is undone", () => h.board().cards.length === n0);
  check("textBoxCreate the empty ones left no undo step", h.board().cards.length === n0, h.board().cards);
  await h.close();
});

/** Common content at the card's size, in a Text and a Box and two themes: words, **bold** at the same size, inline code a little
 *  smaller, a formula, a list, # at 1.8 times and ## at 1.35; a Box centres its words and keeps a list to the left */
test("textBoxCommonContent", async () => {
  const md = "# Head\n\n## Sub\n\nPlain **bold** `code` and $x^2$\n\n- one\n- two";
  const b = board("content");
  put(b, note("t", md, { fs: 30 }), 60, 40, 300);
  put(b, note("x", md, { look: "box", fill: "blue", fs: 30 }), 520, 40, 300);
  const h = await open({ board: b, light, w: 1000, h: 760, settings: { theme: "warm-ink" } as never });
  const read = (id: string) =>
    h.page.evaluate((sel) => {
      const tx = document.querySelector<HTMLElement>(`${sel} > .cface > .tx`)!;
      const q = (s: string) => {
        const e = tx.querySelector<HTMLElement>(s);
        return e ? { fs: parseFloat(getComputedStyle(e).fontSize), weight: +getComputedStyle(e).fontWeight } : null;
      };
      const p = [...tx.querySelectorAll<HTMLElement>("p")].find((e) => e.querySelector("strong"))!;
      return {
        p: q("p"),
        strong: q("strong"),
        code: q("code"),
        katex: q(".katex"),
        li: q("li"),
        h1: q("h1"),
        h2: q("h2"),
        align: getComputedStyle(p).textAlign,
        list: getComputedStyle(tx.querySelector("ul")!).textAlign,
        fits: tx.scrollWidth <= tx.clientWidth + 1,
      };
    }, card(id));
  for (const theme of ["warm-ink", "ink-wash"] as const) {
    await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, theme } } as never });
    await idle(h);
    for (const id of ["t", "x"]) {
      const r = await read(id);
      const ok =
        r.p?.fs === 30 &&
        r.strong?.fs === 30 &&
        (r.strong?.weight ?? 0) >= 600 &&
        !!r.code &&
        r.code.fs < 30 &&
        r.code.fs > 20 &&
        !!r.katex &&
        r.katex.fs >= 30 &&
        r.li?.fs === 30 &&
        Math.abs((r.h1?.fs ?? 0) - 54) < 0.5 &&
        Math.abs((r.h2?.fs ?? 0) - 40.5) < 0.5 &&
        r.fits;
      check(`textBoxContent ${theme} ${id === "t" ? "Text" : "Box"} at the card's size`, ok, r);
      if (id === "x")
        check(
          `textBoxContent ${theme} a Box centres its words, a list stays left`,
          r.align === "center" && r.list !== "center",
          r,
        );
    }
    await shot(h, `text-box-content-${theme}`);
  }
  await h.close();
});

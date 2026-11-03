// Captions for images in a Note: right-click the image → Add Caption… / Edit Caption…; the caption is the image's Markdown title
// (![alt](src "caption")) and shows centred right under the image in small muted type, the same in the static render and while
// editing. Each change is one undo step. Tables get the same captions, kept as a "Table: …" line after the table.
//   noteImageCaption                 add, render (static and editing), edit, undo, remove
//   noteOpenedImageCaptionNoGap      a clicked image (its source open, the framed picture under it): the caption under the frame,
//                                    and no empty line between it and the next paragraph
//   noteSizedImageCaptionBodyWidth   a narrowed image's caption keeps the body's width, centred under it, in smaller type
//   noteCaptionInlineMath            $…$ in a caption is typeset, in the static render and while editing
//   noteTableCaption                 right-click a table → Add Caption…: a "Table: …" line, drawn under the table like an image's
//                                    caption, the same while editing; edits in the editor keep it; edit, remove, undo
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { png } from "@codeboard/host/testing";
import { put, shot, type Host } from "../harness";
import { test, open, check, light, until, idle } from "../fixtures";

const BASE = "https://cb-assets.test/res";
const SRC = "assets/0123456789abcdef-320x160.png";
/** Two rows of lanes, orange where a thread runs (the if), grey where it waits */
const PNG = png(320, 160, (x, y) => {
  const lane = Math.floor(x / 40),
    row = Math.floor(y / 80),
    on = (lane % 2 === 0) === (row === 0);
  return x % 40 < 34 && y % 80 > 12 && y % 80 < 68
    ? on
      ? row
        ? [126, 164, 207, 255]
        : [217, 138, 100, 255]
      : [239, 237, 232, 255]
    : [255, 255, 255, 255];
});
const MD = `When threads of one warp take different branches, both paths run one after the other.\n\n![warp](${SRC})\n\nThe idle lanes still hold their slots.`;

function board(): Board {
  const b = emptyBoard("b1", "captions");
  put(b, { id: "n", kind: "note", md: MD, look: "note" } as NoteCard, 80, 60, 381);
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const md = (h: Host) => (h.board().cards.find((c) => c.id === "n") as NoteCard).md;
const img = (h: Host) => h.page.locator('.card[data-id="n"] .nbody img').first();
async function menu(h: Host, label: string) {
  await img(h).click({ button: "right" });
  await h.page.locator(".ctx button").first().waitFor();
  await idle(h);
  const items = await h.page.locator(".ctx button .lb").allTextContents();
  const b = h.page.locator(".ctx button", { hasText: label });
  if (await b.count()) await b.first().click();
  else await h.page.keyboard.press("Escape");
  return items;
}
async function prompt(h: Host, text: string) {
  await h.page.locator(".dialog input").fill(text);
  await h.page.keyboard.press("Enter");
  await idle(h);
}
/** The caption against its image: text, centres, gap, font size and colour against the Note's body text */
const layout = (h: Host, scope: string) =>
  h.page.locator(`.card[data-id="n"] ${scope}`).evaluate((root) => {
    const cap = root.querySelector<HTMLElement>(".md-cap"),
      im = cap?.parentElement?.querySelector(":scope > img");
    if (!cap || !im || cap.hidden) return null;
    const a = cap.getBoundingClientRect(),
      r = im.getBoundingClientRect(),
      cs = getComputedStyle(cap),
      body = getComputedStyle(root.querySelector("p")!);
    return {
      text: cap.textContent,
      dx: Math.round(a.left + a.width / 2 - (r.left + r.width / 2)),
      gap: Math.round(a.top - r.bottom),
      within: a.width <= r.width + 0.5,
      small: parseFloat(cs.fontSize) < parseFloat(body.fontSize),
      muted: cs.color !== body.color,
      center: cs.textAlign === "center",
      top: Math.round(a.top - root.closest(".card")!.getBoundingClientRect().top),
    };
  });

test("noteImageCaption", async () => {
  const h = await open({
    board: board(),
    light,
    w: 1000,
    h: 760,
    host: { assetBase: BASE },
    beforeLoad: (p) => p.route(`${BASE}/**`, (r) => r.fulfill({ body: PNG, contentType: "image/png" })),
  });
  const pg = h.page;
  await until(h, "the image is decoded", () =>
    img(h).evaluate((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0),
  );

  // add
  const items = await menu(h, "Add Caption…");
  check("noteImageCaption the image menu offers Add Caption", items[0] === "Add Caption…", items);
  await prompt(h, 'Figure 4.9: a warp at an "if-else"');
  await until(h, "the caption is saved", () => md(h).includes("Figure 4.9"));
  check(
    "noteImageCaption stored as the image title",
    md(h) === MD.replace(`(${SRC})`, `(${SRC} "Figure 4.9: a warp at an \\"if-else\\"")`),
    md(h),
  );
  await idle(h);
  const still = await layout(h, ".nbody");
  check(
    "noteImageCaption shown under the image, centred, small and muted",
    !!still &&
      still.text === 'Figure 4.9: a warp at an "if-else"' &&
      Math.abs(still.dx) <= 1 &&
      still.gap >= 0 &&
      still.gap <= 10 &&
      still.within &&
      still.small &&
      still.muted &&
      still.center,
    still,
  );
  await shot(h, "note-captions-static");

  // while editing: the same caption in the same place
  await pg.locator('.card[data-id="n"] .nbody p').last().dblclick();
  await pg.locator('.card[data-id="n"] .md-pm').waitFor();
  await idle(h);
  const editing = await layout(h, ".md-pm");
  check(
    "noteImageCaption shown the same while editing",
    !!editing &&
      !!still &&
      editing.text === still.text &&
      Math.abs(editing.dx) <= 1 &&
      Math.abs(editing.gap - still.gap) <= 1 &&
      Math.abs(editing.top - still.top) <= 2 &&
      editing.small &&
      editing.muted,
    { editing, still },
  );
  await shot(h, "note-captions-editing");
  await pg.keyboard.press("Escape");
  await pg.locator('.card[data-id="n"] .md-pm').waitFor({ state: "detached" });
  await idle(h);
  check(
    "noteImageCaption leaving the editor keeps the Markdown",
    md(h).includes(`"Figure 4.9: a warp at an \\"if-else\\""`),
    md(h),
  );

  // edit: the dialog starts with the caption
  const items2 = await menu(h, "Edit Caption…");
  check(
    "noteImageCaption Edit Caption and Remove Caption once it has one",
    items2[0] === "Edit Caption…" && items2[1] === "Remove Caption",
    items2,
  );
  const v = await pg.locator(".dialog input").inputValue();
  check("noteImageCaption Edit Caption starts with the caption", v === 'Figure 4.9: a warp at an "if-else"', v);
  await prompt(h, "Figure 4.9");
  await until(h, "the edit is saved", () => md(h).includes('"Figure 4.9")'));
  check("noteImageCaption edited caption shown", (await layout(h, ".nbody"))?.text === "Figure 4.9");

  // undo: one step back to the first caption, another to none
  await pg.keyboard.press("Meta+z");
  await until(h, "undo is saved", () => md(h).includes("if-else"));
  await idle(h);
  check(
    "noteImageCaption undo brings the first caption back",
    (await layout(h, ".nbody"))?.text === 'Figure 4.9: a warp at an "if-else"',
  );
  await pg.keyboard.press("Meta+z");
  await until(h, "second undo is saved", () => md(h) === MD);
  await idle(h);
  check(
    "noteImageCaption undo again removes it",
    (await layout(h, ".nbody")) === null && (await pg.locator('.card[data-id="n"] .md-fig').count()) === 0,
  );

  // remove
  await pg.keyboard.press("Meta+Shift+z");
  await until(h, "redo is saved", () => md(h).includes("if-else"));
  await menu(h, "Remove Caption");
  await until(h, "the removal is saved", () => md(h) === MD);
  check("noteImageCaption Remove Caption", md(h) === MD, md(h));
});

/** A 1222 × 535 diagram, as a figure taken from a book */
const FIG_SRC = "assets/c329e0660dabb92d-1222x535.svg";
const FIG = `<svg xmlns="http://www.w3.org/2000/svg" width="1222" height="535" viewBox="0 0 1222 535"><rect width="1222" height="535" fill="#e9e4da"/><rect x="60" y="60" width="320" height="200" rx="12" fill="#d98a64"/><rect x="460" y="60" width="320" height="200" rx="12" fill="#7ea4cf"/><rect x="860" y="60" width="300" height="400" rx="12" fill="#8fb98a"/></svg>`;
/** A Note of the given Markdown on the fixture host, its assets/ answered with FIG */
async function figNote(md: string, w = 560) {
  const b = emptyBoard("b1", "captions");
  put(b, { id: "n", kind: "note", md, look: "note" } as NoteCard, 80, 60, w);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({
    board: b,
    light,
    w: 1000,
    h: 900,
    host: { assetBase: BASE },
    beforeLoad: (p) => p.route(`${BASE}/**`, (r) => r.fulfill({ body: FIG, contentType: "image/svg+xml" })),
  });
  await idle(h);
  return h;
}
const card = (h: Host) => h.page.locator('.card[data-id="n"]');
async function editAtEnd(h: Host) {
  await card(h).locator(".nbody p").last().dblclick();
  await card(h).locator(".md-pm").waitFor();
  await idle(h);
}
/** Opens the image's source in the editor (a click on the drawn image) and waits for the framed picture under it to load */
async function openImage(h: Host) {
  await card(h).locator(".md-pm .md-img:not(.below) img").first().click();
  const im = card(h).locator(".md-pm .md-img.below img");
  await im.waitFor();
  await until(h, "the opened image loads", () =>
    im.evaluate((e) => (e as HTMLImageElement).complete && (e as HTMLImageElement).naturalWidth > 0),
  );
  await idle(h);
}
type Box = { top: number; bottom: number; left: number; right: number; w: number; cx: number };
/** Boxes relative to the card: the figure's image (or opened frame), its caption, the paragraph it sits in, the last paragraph */
const figGeo = (h: Host, fig: string) =>
  card(h).evaluate((c, fig) => {
    const o = c.getBoundingClientRect();
    const box = (e: Element | null | undefined): Box | null => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return {
        top: r.top - o.top,
        bottom: r.bottom - o.top,
        left: r.left - o.left,
        right: r.right - o.left,
        w: r.width,
        cx: r.left + r.width / 2 - o.left,
      };
    };
    const f = c.querySelector(fig),
      cap = f?.querySelector(":scope > .md-cap"),
      body = c.querySelector(".nbody p, .md-pm p")!;
    return {
      img: box(f?.querySelector(":scope > .md-imgframe") ?? f?.querySelector("img")),
      cap: box(cap),
      para: box(f?.closest("p")),
      last: box([...c.querySelectorAll(".nbody > p, .md-pm > p")].at(-1)),
      capText: cap?.textContent ?? null,
      katex: cap?.querySelectorAll(".katex").length ?? 0,
      capFont: cap ? parseFloat(getComputedStyle(cap).fontSize) : 0,
      bodyFont: parseFloat(getComputedStyle(body).fontSize),
    };
  }, fig);
type FigGeo = Awaited<ReturnType<typeof figGeo>>;
const near = (a: number | undefined | null, b: number | undefined | null, d = 1) =>
  a != null && b != null && Math.abs(a - b) <= d;

test("noteOpenedImageCaptionNoGap", async () => {
  const h = await figNote(
    `The blocks of a grid run in any order.\n\n![](${FIG_SRC} "Figure 4.5: thread blocks without synchronisation scale transparently")\n\nWhen blocks are at different barriers they still run in any order.`,
  );
  const still = await figGeo(h, ".nbody .md-fig");
  await editAtEnd(h);
  await openImage(h);
  const open = await figGeo(h, ".md-pm .md-img.below");
  await shot(h, "noteOpenedImageCaptionNoGap");
  const capGap = (g: FigGeo) => g.cap && g.img && g.cap.top - g.img.bottom;
  const after = (g: FigGeo) => g.cap && g.last && g.last.top - g.cap.bottom;
  check(
    "noteOpenedImageCaptionNoGap laid out as when not editing: the caption under the frame, no empty line before the next paragraph",
    !!open.cap &&
      !!open.img &&
      open.cap.top >= open.img.bottom - 0.5 &&
      near(capGap(open), capGap(still)) &&
      near(after(open), after(still)),
    { still, open },
  );
});

test("noteSizedImageCaptionBodyWidth", async () => {
  const cap = "Figure 4.6: a thread block is split into warps for scheduling, each warp issued as one unit";
  const h = await figNote(`Warps:\n\n![](${FIG_SRC} "${cap}"){width=40%}\n\nEach warp has 32 threads.`);
  const ok = (g: FigGeo) =>
    !!g.cap &&
    !!g.img &&
    !!g.para &&
    g.capText === cap &&
    near(g.cap.w, g.para.w) &&
    near(g.cap.cx, g.img.cx) &&
    g.img.w < g.para.w * 0.5 &&
    g.capFont <= g.bodyFont * 0.78;
  const still = await figGeo(h, ".nbody .md-fig");
  await shot(h, "noteSizedImageCaptionBodyWidth-static");
  check(
    "noteSizedImageCaptionBodyWidth static: the body's width, centred under the image, smaller type",
    ok(still),
    still,
  );
  await editAtEnd(h);
  const shown = await figGeo(h, ".md-pm .md-img:not(.below)");
  check("noteSizedImageCaptionBodyWidth editing: the same", ok(shown) && near(shown.cap?.top, still.cap?.top, 2), {
    shown,
    still,
  });
  await openImage(h);
  const open = await figGeo(h, ".md-pm .md-img.below");
  await shot(h, "noteSizedImageCaptionBodyWidth-opened");
  check("noteSizedImageCaptionBodyWidth opened image: the same", ok(open), open);
});

test("noteCaptionInlineMath", async () => {
  const h = await figNote(`Tiling:\n\n![](${FIG_SRC} "Figure 5.7: tiling $M$ and $N$ to use shared memory")\n\nEnd.`);
  const ok = (g: FigGeo) =>
    g.katex === 2 && !!g.capText && !g.capText.includes("$") && g.capText.includes("to use shared memory");
  const still = await figGeo(h, ".nbody .md-fig");
  await shot(h, "noteCaptionInlineMath-static");
  check("noteCaptionInlineMath static: the formulas typeset", ok(still), still);
  await editAtEnd(h);
  const shown = await figGeo(h, ".md-pm .md-img:not(.below)");
  check("noteCaptionInlineMath editing: the same", ok(shown), shown);
  await openImage(h);
  const open = await figGeo(h, ".md-pm .md-img.below");
  check("noteCaptionInlineMath opened image: the same", ok(open), open);
});

const TABLE = "| tile | M   | N   |\n| ---- | --- | --- |\n| 1    | 64  | 64  |\n| 2    | 128 | 64  |";
const TMD = `Tile sizes per block:\n\n${TABLE}\n\nThe end.`;
const CAP = "Table 2: tile sizes of $M$ and $N$";
async function tableMenu(h: Host, cell: string, label: string) {
  await card(h).locator(cell).first().click({ button: "right" });
  await h.page.locator(".ctx button").first().waitFor();
  await idle(h);
  const items = await h.page.locator(".ctx button .lb").allTextContents();
  const b = h.page.locator(".ctx button", { hasText: label });
  if (await b.count()) await b.first().click();
  else await h.page.keyboard.press("Escape");
  return items;
}
/** The table, its caption and the paragraph before it, relative to the card */
const tableGeo = (h: Host, scope: string) =>
  card(h).evaluate((c, scope) => {
    const o = c.getBoundingClientRect(),
      root = c.querySelector(scope)!;
    const box = (e: Element | null) => {
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { top: r.top - o.top, bottom: r.bottom - o.top, w: r.width, cx: r.left + r.width / 2 - o.left };
    };
    const cap = root.querySelector(".md-tfig > .md-cap"),
      p = root.querySelector("p")!;
    return {
      table: box(root.querySelector("table")),
      cap: box(cap),
      para: box(p),
      capText: cap?.textContent ?? null,
      katex: cap?.querySelectorAll(".katex").length ?? 0,
      small: !!cap && parseFloat(getComputedStyle(cap).fontSize) <= parseFloat(getComputedStyle(p).fontSize) * 0.78,
      muted: !!cap && getComputedStyle(cap).color !== getComputedStyle(p).color,
    };
  }, scope);

test("noteTableCaption", async () => {
  const h = await figNote(TMD, 460);
  const pg = h.page,
    md = () => (h.board().cards.find((c) => c.id === "n") as NoteCard).md;

  const items = await tableMenu(h, ".nbody td", "Add Caption…");
  check("noteTableCaption the table menu offers Add Caption", items[0] === "Add Caption…", items);
  await prompt(h, CAP);
  await until(h, "the caption is saved", () => md().includes("Table 2"));
  check(
    "noteTableCaption stored as a Table: line after the table",
    md() === TMD.replace(TABLE, `${TABLE}\n\nTable: ${CAP}`),
    md(),
  );
  await idle(h);
  const still = await tableGeo(h, ".nbody");
  check(
    "noteTableCaption shown under the table, centred, at the body's width, small, muted, formulas typeset",
    !!still.table &&
      !!still.cap &&
      !!still.para &&
      still.cap.top >= still.table.bottom &&
      still.cap.top - still.table.bottom <= 10 &&
      near(still.cap.cx, still.table.cx) &&
      near(still.cap.w, still.para.w) &&
      still.katex === 2 &&
      still.small &&
      still.muted,
    still,
  );
  await shot(h, "noteTableCaption-static");

  // while editing: in the same place; an edit in a cell keeps the caption
  await editAtEnd(h);
  const editing = await tableGeo(h, ".md-pm");
  check(
    "noteTableCaption shown the same while editing",
    !!editing.cap &&
      !!still.cap &&
      editing.capText === still.capText &&
      editing.katex === 2 &&
      near(editing.cap.top, still.cap.top, 2) &&
      near(editing.cap.cx, still.cap.cx) &&
      near(editing.table?.cx, still.table?.cx),
    { editing, still },
  );
  await shot(h, "noteTableCaption-editing");
  await card(h).locator(".md-pm td").last().click();
  await pg.keyboard.press("End");
  await pg.keyboard.type("0");
  await pg.keyboard.press("Escape");
  await card(h).locator(".md-pm").waitFor({ state: "detached" });
  await until(h, "the cell edit is saved", () => md().includes("640"));
  check(
    "noteTableCaption an edit in the editor keeps the caption",
    md().includes(`\n\nTable: ${CAP}\n\nThe end.`),
    md(),
  );

  // edit, while editing: the editor closes and the change lands
  await editAtEnd(h);
  const items2 = await tableMenu(h, ".md-pm td", "Edit Caption…");
  check(
    "noteTableCaption Edit Caption and Remove Caption once it has one, also while editing",
    items2[0] === "Edit Caption…" && items2[1] === "Remove Caption",
    items2,
  );
  const v = await pg.locator(".dialog input").inputValue();
  check("noteTableCaption Edit Caption starts with the caption", v === CAP, v);
  await prompt(h, "Table 2");
  await until(h, "the edit is saved", () => md().includes("Table: Table 2\n"));
  check("noteTableCaption edited caption shown", (await tableGeo(h, ".nbody")).capText === "Table 2");

  // remove, undo
  await tableMenu(h, ".nbody td", "Remove Caption");
  await until(h, "the removal is saved", () => !md().includes("Table:"));
  check(
    "noteTableCaption Remove Caption",
    (await tableGeo(h, ".nbody")).cap === null && md().includes("640") && md().endsWith("|\n\nThe end."),
    md(),
  );
  await pg.keyboard.press("Meta+z");
  await until(h, "undo is saved", () => md().includes("Table: Table 2\n"));
  await idle(h);
  check("noteTableCaption undo brings it back", (await tableGeo(h, ".nbody")).capText === "Table 2");
});

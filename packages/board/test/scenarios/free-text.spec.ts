// Free Text: a heading written on the board. Plain text (line breaks only), no frame, the theme's title font, its size dragged
// freely from its corner (the Mark's mechanism), edited in place in a plain text box (no Markdown editor)
import { shot, type Host } from "../harness";
import { DEFAULT_SETTINGS, emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, until, idle } from "../fixtures";

const card = (id: string) => `.card[data-id="${id}"]`;
const frees = (h: Host) =>
  h.board().cards.filter((c): c is NoteCard => c.kind === "note" && c.look === "freetext") as NoteCard[];
const byId = (h: Host, id: string) => h.board().cards.find((c) => c.id === id) as NoteCard | undefined;

/** A title-sized Text to compare the theme's title font with */
function titleBoard(): Board {
  const b = emptyBoard("b1", "free text");
  b.cards.push({ id: "t1", kind: "note", md: "Title reference", look: "text", size: "title" } as NoteCard);
  b.place.t1 = { x: 640, y: 60, w: 300 };
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

/** The text's font next to the title Text's, and the Free Text's frame */
const lookOf = (h: Host, id: string) =>
  h.page.evaluate(
    ({ sel, ref }) => {
      const c = document.querySelector<HTMLElement>(sel)!,
        t = c.querySelector<HTMLElement>(".tx")!,
        r = document.querySelector<HTMLElement>(ref)!,
        ts = getComputedStyle(t),
        rs = getComputedStyle(r),
        cs = getComputedStyle(c);
      // letter spacing in em: the theme gives it relative to the size
      const em = (s: CSSStyleDeclaration) =>
        s.letterSpacing === "normal" ? "normal" : (parseFloat(s.letterSpacing) / parseFloat(s.fontSize)).toFixed(3);
      const font = (s: CSSStyleDeclaration) => [s.fontFamily, s.fontWeight, em(s), s.textTransform].join(" | ");
      return {
        font: font(ts),
        title: font(rs),
        size: ts.fontSize,
        bg: cs.backgroundColor,
        shadow: [cs, getComputedStyle(c, "::before"), getComputedStyle(c, "::after")]
          .map((s) => s.boxShadow)
          .filter((v) => v !== "none"),
        w: c.offsetWidth,
        fits: t.scrollWidth <= t.clientWidth + 1,
        text: t.textContent,
        rich: t.querySelectorAll("em, strong, p").length,
        lines: Math.round(t.offsetHeight / parseFloat(ts.lineHeight)),
      };
    },
    { sel: card(id), ref: `${card("t1")} .tx` },
  );

/** #119: New Free Text from the toolbar's T ▾ menu and the board menu; plain text edited in place; the theme's title font in
 *  every theme; frameless and as wide as its text; resized from its corner (font size, one undo step); an empty one goes without
 *  an undo step; Duplicate and copy / paste keep its text and size */
test("freeTextCard", async () => {
  const h = await open({ board: titleBoard(), light: true, w: 1200, h: 760, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await pg.locator('.bbar button[aria-label="Text"]').click();
  await pg.locator(".ctx button").first().waitFor();
  const items = await pg.locator(".ctx button .lb").allTextContents();
  check("freeTextInWriteMenu", items.includes("New Free Text"), items);
  await pg.locator(".ctx button", { hasText: "New Free Text" }).click();
  await pg.locator(".card.freetext .tx.ft[contenteditable]").waitFor();
  check("freeTextPlainEditor", (await pg.locator(".md-pm").count()) === 0);
  await pg.keyboard.type("Scheduler");
  await pg.keyboard.press("Escape");
  const ft = await until(h, "the Free Text is saved", () => frees(h).find((c) => c.md === "Scheduler"));
  await idle(h);
  const id = ft.id;
  const l0 = await lookOf(h, id);
  check("freeTextSaved", ft.fs === undefined && l0.size === "40px", { ft, size: l0.size });
  check("freeTextTitleFont", l0.font === l0.title, l0);
  check("freeTextFrameless", /rgba\(0, 0, 0, 0\)|transparent/.test(l0.bg) && l0.shadow.length === 0, l0);
  check("freeTextFitsItsText", l0.w < 381 && l0.fits, l0);

  // the theme's title font in every theme
  const themes: Record<string, unknown> = {};
  for (const theme of ["drafting", "ink-wash", "newspaper", "poster", "graphite"] as const) {
    await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, theme } } as never });
    await idle(h);
    const l = await lookOf(h, id);
    themes[theme] = l;
    check(`freeTextThemeFont ${theme}`, l.font === l.title && l.size === "40px", l);
    if (theme === "drafting") await shot(h, "119-free-text-drafting");
  }
  await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, theme: "warm-ink" } } as never });
  await idle(h);

  // double-click: a plain text box; Markdown stays text, Enter is a line break
  await pg.locator(`${card(id)} .tx`).dblclick();
  await pg.locator(`${card(id)} .tx.ft[contenteditable]`).waitFor();
  await pg.keyboard.press("End");
  await pg.keyboard.type(" *loop*");
  await pg.keyboard.press("Enter");
  await pg.keyboard.type("prefill");
  await pg.keyboard.press("Escape");
  await until(h, "the edit is saved", () => byId(h, id)?.md === "Scheduler *loop*\nprefill");
  await idle(h);
  const l1 = await lookOf(h, id);
  check("freeTextPlainText", l1.text === "Scheduler *loop*\nprefill" && l1.rich === 0 && l1.lines === 2, l1);

  // the corner: the text size, one undo step
  await pg.mouse.click(400, 600);
  await pg.locator(`${card(id)} .tx`).click();
  const grip = (await pg.locator(`${card(id)} .mkgrip`).boundingBox())!;
  await pg.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await pg.mouse.down();
  for (let i = 1; i <= 10; i++) await pg.mouse.move(grip.x + i * 14, grip.y + i * 8);
  await pg.mouse.up();
  const big = await until(h, "the new size is saved", () => byId(h, id)?.fs);
  await idle(h);
  const l2 = await lookOf(h, id);
  check("freeTextResized", big > 48 && l2.size === `${big}px` && l2.lines === 2 && l2.fits, { big, l2 });
  await shot(h, "119-free-text");
  await pg.keyboard.press("Meta+z");
  await until(h, "the resize is undone", () => byId(h, id)?.fs === undefined);
  check("freeTextResizeUndo", byId(h, id)?.md === "Scheduler *loop*\nprefill", byId(h, id));

  // an empty one, from the board menu, goes without a step: the next undo is the text edit before it
  const n0 = h.board().cards.length;
  await pg.mouse.click(300, 500, { button: "right" });
  await pg.locator(".ctx button", { hasText: "New Free Text" }).click();
  await pg.locator(".card.freetext .tx.ft[contenteditable]").waitFor();
  await pg.keyboard.press("Escape");
  await until(h, "the empty one is gone", async () => (await pg.locator(".card.freetext").count()) === 1);
  await idle(h);
  check("freeTextEmptyGoes", h.board().cards.length === n0, h.board().cards.length);
  await pg.keyboard.press("Meta+z");
  await until(h, "the text edit is undone", () => byId(h, id)?.md === "Scheduler");
  check("freeTextEmptyNoUndoStep", byId(h, id)?.md === "Scheduler" && h.board().cards.length === n0);

  // Duplicate and copy / paste: a Free Text with the same text and size
  await pg.keyboard.press("Meta+Shift+z");
  await until(h, "redone", () => byId(h, id)?.md === "Scheduler *loop*\nprefill");
  await pg.mouse.click(400, 600);
  await pg.locator(`${card(id)} .tx`).click();
  await pg.keyboard.press("ControlOrMeta+d");
  const dup = await until(h, "the duplicate is saved", () => frees(h).find((c) => c.id !== id));
  check("freeTextDuplicate", dup.md === "Scheduler *loop*\nprefill" && dup.look === "freetext", dup);
  await pg.keyboard.press("Meta+c");
  const copied = await until(
    h,
    "the copy reaches the host",
    () => [...h.sent].reverse().find((m) => m.type === "copyCards") as { text: string } | undefined,
  );
  await pg.mouse.move(300, 560);
  await pg.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, copied.text);
  const pasted = await until(h, "the paste is saved", () => (frees(h).length === 3 ? frees(h).at(-1) : undefined));
  check("freeTextPaste", pasted.md === dup.md && pasted.look === "freetext", pasted);
  await h.close();
});

/** #119: a Free Text exports as it shows: the HTML snapshot keeps its class and size and carries only the font chunks the board
 *  loaded (the Chinese handwriting of a Mark beside it: a few of Yozai's chunks, not all of them); PNG export draws it */
test("freeTextExport", async () => {
  const b = titleBoard();
  b.cards.push({ id: "f1", kind: "note", md: "Attention 注意力", look: "freetext", fs: 64 } as NoteCard);
  b.place.f1 = { x: 60, y: 60, w: 200 };
  b.cards.push({ id: "m1", kind: "note", md: "先挑这一批", look: "mark", hand: "blue" } as NoteCard);
  b.place.m1 = { x: 80, y: 220, w: 200 };
  const h = await open({ board: b, light: true, w: 1100, h: 600, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await pg.evaluate(() => document.fonts.ready);
  const loaded = await until(h, "the Mark's Chinese chunks are loaded", () =>
    pg.evaluate(
      () => [...document.fonts].filter((x) => x.family.replace(/"/g, "") === "Yozai" && x.status === "loaded").length,
    ),
  );
  await pg.locator('.bbar [aria-label="More"]').click();
  await pg.locator(".ctx button", { hasText: "Export…" }).click();
  await pg.locator(".xdlg").waitFor();
  await pg.locator(".xdlg .seg button", { hasText: "HTML Snapshot" }).click();
  await pg.locator(".xdlg button.def").click();
  const html = await until(
    h,
    "the HTML snapshot is sent",
    () => (h.sent.find((m) => m.type === "exportFile") as { text: string } | undefined)?.text,
    20000,
  );
  const yozai = html.match(/fonts\/Yozai-\d+-\d+\.woff2/g) ?? [];
  check(
    "freeTextExportHtml",
    /class="[^"]*\bfreetext\b/.test(html) && /--tfs:\s*64px/.test(html) && html.includes("Attention 注意力"),
    { len: html.length },
  );
  check("freeTextExportFontChunks", yozai.length === loaded && loaded >= 1 && loaded <= 6, { yozai, loaded });
  await pg.keyboard.press("Escape");
  await idle(h);
  // PNG: the export's picture has the Free Text's ink where it is on the board
  await pg.locator('.bbar [aria-label="More"]').click();
  await pg.locator(".ctx button", { hasText: "Export…" }).click();
  await pg.locator(".xdlg").waitFor();
  await pg.locator(".xdlg .seg button", { hasText: "PNG" }).click();
  await pg.locator(".xdlg button.def").click();
  const png = await until(
    h,
    "the PNG is sent",
    () => (h.sent.find((m) => m.type === "exportPng") as { dataUrl: string } | undefined)?.dataUrl,
    20000,
  );
  const ink = await pg.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    // the board's top-left card is the Free Text (40 px of padding, at scale 2): its first band of the picture
    const d = g.getImageData(80, 80, 600, 140).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 300) dark++;
    return { w: img.width, h: img.height, dark };
  }, png);
  check("freeTextExportPng", ink.dark > 2000, ink);
  await h.close();
});

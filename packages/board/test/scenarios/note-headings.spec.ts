// Headings in the Note editor: a heading's level is its block's, never `#` characters in its text. While the caret is in a
// heading a level chip ("H2") sits in the card's left padding on the heading's baseline and opens a menu of levels; the
// keys that edit, select, copy and paste a heading keep it a heading (or make it plain text) without leaving a literal `##`
import { put, shot, type Host } from "../harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, until, idle, pmHasSelection, focusSettled } from "../fixtures";

const close = (h: Host) => h.page.context().close();

/** Types a sequence: {Enter}, {ControlOrMeta+l} and the like are keys, {triple} a triple click on the heading, the rest text */
async function keys(h: Host, id: string, seq: string) {
  const pg = h.page;
  for (const part of seq.split(/(\{[A-Za-z0-9+]+\})/)) {
    if (!part) continue;
    if (part === "{triple}") {
      await pg.locator(`.card[data-id="${id}"] .md-pm h2`).click({ clickCount: 3 });
      await pmHasSelection(pg);
    } else if (/^\{.+\}$/.test(part)) {
      // the browser moves the caret for these, and ProseMirror learns of it from selectionchange: wait for it both ways
      const nav = /Home|End|Arrow|Shift/.test(part);
      if (nav) {
        await focusSettled(pg);
        await pmHasSelection(pg);
      }
      await pg.keyboard.press(part.slice(1, -1));
      if (nav) await pmHasSelection(pg);
    } else await pg.keyboard.type(part);
  }
}
function board(init: string[]): Board {
  const b = emptyBoard("b1", "headings");
  init.forEach((md, i) =>
    put(
      b,
      { id: `n${i}`, kind: "note", md, look: "note" } as NoteCard,
      60 + (i % 4) * 480,
      60 + Math.floor(i / 4) * 320,
      420,
    ),
  );
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const md = (h: Host, id: string) =>
  ((h.board().cards.find((c) => c.id === id) as NoteCard | undefined)?.md ?? "").trim();
/** Opens the Note for editing; at: then a click on that element of it (the caret lands where the click is) */
async function editNote(h: Host, id: string, at?: string) {
  await h.page.emulateMedia({ reducedMotion: "reduce" });
  await h.post({ type: "reveal", card: id } as any);
  await idle(h);
  await h.page.emulateMedia({ reducedMotion: "no-preference" });
  await h.page.keyboard.press("Escape");
  await until(h, "nothing selected", async () => (await h.page.locator(".card.sel").count()) === 0);
  await h.page.locator(`.card[data-id="${id}"] .nbody`).dblclick({ position: { x: 380, y: 12 } });
  await h.page.waitForSelector(`.card[data-id="${id}"] .md-pm`, { timeout: 5000 });
  if (at) {
    await h.page.locator(`.card[data-id="${id}"] .md-pm ${at}`).first().click();
    await idle(h);
  }
}
async function exitEdit(h: Host) {
  for (let k = 0; k < 3 && (await h.page.locator(".md-pm").count()); k++) {
    await h.page.keyboard.press("Escape");
    await idle(h);
  }
}
type Case = { name: string; init: string; at?: string; seq: string; md: string; copy?: true; paste?: string };
/** One Note per case: keys, an optional copy or paste, leave; then every Note's Markdown (and copy) is checked */
async function cases(prefix: string, all: Case[]) {
  const h = await open({ board: board(all.map((c) => c.init)) });
  await idle(h);
  const copied: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    await editNote(h, `n${i}`, c.at);
    await keys(h, `n${i}`, c.seq);
    if (c.copy)
      copied[i] = await h.page.evaluate(() => {
        const dt = new DataTransfer();
        document
          .querySelector(".md-pm")!
          .dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
        return dt.getData("text/plain");
      });
    if (c.paste)
      await h.page.evaluate((t) => {
        const dt = new DataTransfer();
        dt.setData("text/plain", t);
        document
          .querySelector(".md-pm")!
          .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, c.paste);
    await idle(h);
    await exitEdit(h);
  }
  await idle(h); // every Note's Markdown has reached the host
  all.forEach((c, i) => {
    const got = c.copy ? copied[i] : md(h, `n${i}`);
    check(`${prefix} ${c.name}`, got === c.md, { got, want: c.md });
  });
  await close(h);
}

const H = "intro\n\n## Head\n\npara";

/** Backspace, Enter, Delete, Shift+Enter, `###` + space, selecting a heading's text and ⌘B across paragraphs */
test("headingKeysKeepBlock", async () => {
  await cases("headingKeysKeepBlock", [
    { name: "backspace at start", init: H, at: "h2", seq: "{Home}{Backspace}", md: "intro\n\nHead\n\npara" },
    {
      name: "backspace in empty heading",
      init: H,
      at: "h2",
      seq: "{End}{Shift+Home}{Backspace}{Backspace}y",
      md: "intro\n\ny\n\npara",
    },
    {
      name: "enter at start",
      init: H,
      at: "h2",
      seq: "{Home}{Enter}{ArrowUp}y",
      md: "intro\n\ny\n\n## Head\n\npara",
    },
    {
      name: "enter in middle",
      init: H,
      at: "h2",
      seq: "{Home}{ArrowRight}{ArrowRight}{Enter}",
      md: "intro\n\n## He\n\nad\n\npara",
    },
    { name: "enter at end", init: H, at: "h2", seq: "{End}{Enter}y", md: "intro\n\n## Head\n\ny\n\npara" },
    {
      name: "enter at end of bold text",
      init: "intro\n\n## **Head**\n\npara",
      at: "h2",
      seq: "{End}{ArrowLeft}{ArrowLeft}{Enter}y",
      md: "intro\n\n## **Head**\n\ny\n\npara",
    },
    { name: "enter at end in a list item", init: "- ## Head", at: "h2", seq: "{End}{Enter}y", md: "- ## Head\n- y" },
    { name: "delete joins", init: H, at: "p", seq: "{End}{Delete}", md: "introHead\n\npara" },
    { name: "relevel", init: H, at: "h2", seq: "{Home}### ", md: "intro\n\n### Head\n\npara" },
    { name: "paragraph to heading", init: H, at: "p", seq: "{Home}#### ", md: "#### intro\n\n## Head\n\npara" },
    { name: "shift enter", init: H, at: "h2", seq: "{End}{Shift+Enter}y", md: "intro\n\n## Heady\n\npara" },
    { name: "triple click", init: H, seq: "{triple}Z", md: "intro\n\n## Z\n\npara" },
    { name: "shift home", init: H, at: "h2", seq: "{End}{Shift+Home}Z", md: "intro\n\n## Z\n\npara" },
    { name: "select line", init: H, at: "h2", seq: "{ControlOrMeta+l}Z", md: "intro\n\n## Z\n\npara" },
    {
      name: "bold across paragraphs",
      init: "one two\n\nthree four",
      at: "p",
      seq: "{ControlOrMeta+a}{ControlOrMeta+b}",
      md: "**one two**\n\n**three four**",
    },
  ]);
});

/** A copy of a whole heading is its Markdown, of part of it just the text; a pasted heading line makes a heading in an empty
 *  paragraph and is plain words inside text */
test("headingCopyPaste", async () => {
  await cases("headingCopyPaste", [
    { name: "copy whole", init: H, at: "h2", seq: "{ControlOrMeta+l}", copy: true, md: "## Head" },
    { name: "copy part", init: H, at: "h2", seq: "{End}{Shift+ArrowLeft}{Shift+ArrowLeft}", copy: true, md: "ad" },
    {
      name: "paste into empty",
      init: H,
      at: "p",
      seq: "{End}{Enter}",
      paste: "## Pasted",
      md: "intro\n\n## Pasted\n\n## Head\n\npara",
    },
    {
      name: "paste into text",
      init: H,
      at: "p",
      seq: "{End}{ArrowLeft}{ArrowLeft}",
      paste: "## Pasted",
      md: "intPastedro\n\n## Head\n\npara",
    },
  ]);
});

/** The chip: in the left padding, on the heading's first baseline, while the caret is in the heading; the heading's text stays
 *  where it is when the caret comes and goes; the chip's menu sets the level, Text makes it a paragraph */
test("headingLevelChip", async () => {
  const h = await open({ board: board([H]) });
  await idle(h);
  const pg = h.page;
  /** The heading's first character and the chip: where they are, and each one's baseline (from the font's ascent) */
  const look = () =>
    pg.evaluate(() => {
      const card = document.querySelector('.card[data-id="n0"]')!,
        hd = card.querySelector(".md-pm :is(h1, h2, h3, h4, h5, h6)") as HTMLElement | null,
        chip = card.querySelector(".md-hchip-b") as HTMLElement | null;
      const ctx = document.createElement("canvas").getContext("2d")!;
      const base = (t: Text, at: number) => {
        const r = document.createRange();
        r.setStart(t, at);
        r.setEnd(t, at + 1);
        const box = r.getBoundingClientRect();
        // from its parts: the shorthand is empty when the element sets font-variant-numeric (the chip does)
        const st = getComputedStyle(t.parentElement!);
        ctx.font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
        return { x: box.left, base: box.top + ctx.measureText("H").fontBoundingBoxAscent };
      };
      const text = hd && [...hd.childNodes].find((n): n is Text => n instanceof Text && !!n.data);
      const chipText = chip && [...chip.childNodes].find((n): n is Text => n instanceof Text && !!n.data);
      const c = chip?.getBoundingClientRect(),
        k = card.getBoundingClientRect();
      return {
        tag: hd?.tagName ?? "",
        head: text ? base(text, 0) : null,
        chip:
          chip && chipText && c
            ? { text: chip.textContent, left: c.left - k.left, right: c.right, ...base(chipText, 0) }
            : null,
      };
    });
  await editNote(h, "n0", "p");
  const out = await look();
  await pg.locator('.card[data-id="n0"] .md-pm h2').click();
  await until(h, "chip shown", async () => (await pg.locator(".md-hchip-b").count()) === 1);
  await idle(h);
  const inside = await look();
  await shot(h, "headingLevelChip-shown");
  check("headingLevelChip text stays", !!out.head && !!inside.head && Math.abs(out.head.x - inside.head.x) < 0.5, {
    out,
    inside,
  });
  check(
    "headingLevelChip in padding on baseline",
    out.chip === null &&
      inside.chip?.text === "H2" &&
      inside.chip.left >= 0 &&
      inside.chip.right <= inside.head!.x - 1 &&
      Math.abs(inside.chip.base - inside.head!.base) <= 0.75,
    inside,
  );
  await pg.locator(".md-hchip-b").click();
  const items = pg.locator(".md-hmenu button");
  await until(h, "level menu", async () => (await items.count()) === 7);
  await shot(h, "headingLevelChip-menu");
  const checked = await pg.locator('.md-hmenu button[aria-checked="true"]').textContent();
  await items.filter({ hasText: "Heading 4" }).click();
  await until(h, "an h4", async () => (await pg.locator('.card[data-id="n0"] .md-pm h4').count()) === 1);
  const h4 = await look();
  check(
    "headingLevelChip menu sets the level",
    /Heading 2/.test(checked ?? "") && h4.chip?.text === "H4" && (await pg.locator(".md-hmenu").count()) === 0,
    { checked, h4 },
  );
  await pg.locator(".md-hchip-b").click();
  await until(h, "level menu", async () => (await items.count()) === 7);
  await pg.keyboard.press("Escape");
  await until(h, "menu closed", async () => (await pg.locator(".md-hmenu").count()) === 0);
  check("headingLevelChip escape keeps editing", (await pg.locator(".md-pm").count()) === 1);
  await pg.locator(".md-hchip-b").click();
  await items.filter({ hasText: "Text" }).click();
  await until(h, "no heading", async () => (await pg.locator('.card[data-id="n0"] .md-pm h4').count()) === 0);
  await keys(h, "n0", "{End}!");
  await exitEdit(h);
  await idle(h);
  check("headingLevelChip text level", md(h, "n0") === "intro\n\nHead!\n\npara", { md: md(h, "n0") });
  await close(h);
});

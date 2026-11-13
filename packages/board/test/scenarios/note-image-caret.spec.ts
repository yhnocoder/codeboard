import * as path from "node:path";
import { emptyBoard, type NoteCard } from "@codeboard/core";
import { png } from "@codeboard/host/testing";
import type { Page } from "playwright-core";
import { OUT, put } from "../harness";
import { test, open, check, idle, until } from "../fixtures";

const pic = (w: number, h: number) =>
  `data:image/png;base64,${png(w, h, (x, y) => (x < 4 || y < 4 || x >= w - 4 || y >= h - 4 ? [70, 110, 200, 255] : [236, 240, 248, 255])).toString("base64")}`;
const LONE = `![](${pic(360, 200)})`,
  INLINE = `![](${pic(60, 40)})`;
const MD = `Text above the picture.\n\n${LONE}\n\nSee ${INLINE} inline here.\n\nEnd text.`;

type Rect = { x: number; y: number; w: number; h: number };
type Pm = {
  state: {
    doc: { descendants(f: (n: { isTextblock: boolean; textContent: string }, pos: number) => boolean): void };
  };
  commands: { setTextSelection(p: number): boolean; focus(): boolean };
};
/** Where an image's source starts and ends in the document */
const range = (pg: Page, md: string) =>
  pg.evaluate((md) => {
    const e = (document.querySelector(".md-pm") as unknown as { editor: Pm }).editor;
    let at = -1;
    e.state.doc.descendants((n, pos) => {
      if (at < 0 && n.isTextblock && n.textContent.includes(md)) at = pos + 1 + n.textContent.indexOf(md);
      return at < 0;
    });
    return [at, at + md.length] as const;
  }, md);
const caretAt = (pg: Page, pos: number) =>
  pg.evaluate((pos) => {
    const e = (document.querySelector(".md-pm") as unknown as { editor: Pm }).editor;
    e.commands.setTextSelection(pos);
    e.commands.focus();
  }, pos);
const head = (pg: Page) =>
  pg.evaluate(
    () =>
      (document.querySelector(".md-pm") as unknown as { editor: { state: { selection: { head: number } } } }).editor
        .state.selection.head,
  );

/** The drawn caret (its line, from the zero-size box and its ::after), the image beside it, the paragraph's own caret colour,
 *  the body text's line (a collapsed range in "End text": the height the browser's caret has in text) */
const look = (pg: Page, which: number) =>
  pg.evaluate((which) => {
    const rect = (r: DOMRect): Rect => ({ x: r.x, y: r.y, w: r.width, h: r.height });
    const img = document.querySelectorAll(".md-pm .md-img:not(.below) img")[which] as HTMLElement;
    const c = document.querySelector(".md-pm .md-icaret") as HTMLElement | null;
    let caret: Rect | null = null;
    if (c) {
      const b = c.getBoundingClientRect(),
        a = getComputedStyle(c, "::after"),
        w = Number.parseFloat(a.width),
        left = c.classList.contains("md-icaret-l") ? Number.parseFloat(a.left) : -Number.parseFloat(a.right) - w;
      caret =
        a.content === "none"
          ? null
          : { x: b.x + left, y: b.y + Number.parseFloat(a.top), w, h: Number.parseFloat(a.height) };
    }
    const end = [...document.querySelectorAll(".md-pm p")].find((p) => p.textContent === "End text.")!;
    const r = document.createRange();
    r.setStart(end.firstChild!, 3);
    r.collapse(true);
    return {
      img: rect(img.getBoundingClientRect()),
      caret,
      side: c?.className ?? null,
      caretColor: getComputedStyle(img.closest("p")!).caretColor,
      line: r.getBoundingClientRect().height,
    };
  }, which);

/** In an edited Note the caret beside an image is one text line tall and a few pixels off the image, not as tall as the image
 *  and against its edge: before and after an image alone in its (centred) paragraph and an image inline in text. The image
 *  does not move when the caret comes or goes; ← → still step over the image whole; elsewhere the browser's own caret is
 *  drawn; an IME composing beside the image writes where the caret is */
test("noteCaretBesideImage", async () => {
  const b = emptyBoard("b1", "caret beside image");
  put(b, { id: "n0", kind: "note", md: MD, look: "note" } as NoteCard, 60, 60, 520);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 760, h: 760, scale: 2, settings: { theme: "warm-ink" } as never });
  const pg = h.page,
    card = pg.locator('.card[data-id="n0"]');
  await idle(h);
  await card.locator(".nbody p").last().dblclick();
  await card.locator(".md-pm:focus").waitFor();
  await idle(h);
  const lone = await range(pg, LONE),
    inl = await range(pg, INLINE);
  const rest = [await look(pg, 0), await look(pg, 1)];
  check(
    "noteCaretBesideImage none in text",
    rest[0].caret === null && rest[0].caretColor !== "rgba(0, 0, 0, 0)",
    rest[0],
  );
  const cases: [string, number, number, "l" | "r"][] = [
    ["before the lone image", lone[0], 0, "r"],
    ["after the lone image", lone[1], 0, "l"],
    ["before the inline image", inl[0], 1, "r"],
    ["after the inline image", inl[1], 1, "l"],
  ];
  for (const [name, pos, which, side] of cases) {
    await caretAt(pg, pos);
    await card.locator(`.md-pm .md-icaret-${side}`).waitFor({ state: "attached" });
    await idle(h);
    const l = await look(pg, which);
    const c = l.caret,
      img = l.img;
    const gap = c ? (side === "r" ? img.x - (c.x + c.w) : c.x - (img.x + img.w)) : -1;
    check(`noteCaretBesideImage ${name}: one text line tall`, c && Math.abs(c.h - l.line) <= 3 && c.h < img.h - 4, {
      caret: c,
      line: l.line,
      img,
    });
    check(`noteCaretBesideImage ${name}: off the image`, gap >= 3 && gap <= 8, { gap, caret: c, img });
    check(
      `noteCaretBesideImage ${name}: centred on the image`,
      c && Math.abs(c.y + c.h / 2 - (img.y + img.h / 2)) <= 2,
      { caret: c, img },
    );
    check(
      `noteCaretBesideImage ${name}: the browser's caret hidden`,
      l.caretColor === "rgba(0, 0, 0, 0)",
      l.caretColor,
    );
    const was = rest[which].img;
    check(
      `noteCaretBesideImage ${name}: the image stays put`,
      Math.abs(img.x - was.x) < 0.5 && Math.abs(img.y - was.y) < 0.5 && Math.abs(img.w - was.w) < 0.5,
      { img, was },
    );
    if (name === "before the lone image") {
      const r = (await card.boundingBox())!;
      await pg.screenshot({
        path: path.join(OUT, "note-caret-beside-image.png"),
        clip: { x: r.x - 12, y: r.y - 12, width: r.width + 24, height: r.height + 24 },
        animations: "disabled",
      });
    }
  }
  // ← → step over an image whole, and the drawn caret follows
  await caretAt(pg, inl[0]);
  await pg.keyboard.press("ArrowRight");
  await card.locator(".md-pm .md-icaret-l").waitFor({ state: "attached" });
  check("noteCaretBesideImage → steps over the image", (await head(pg)) === inl[1], await head(pg));
  // one more step and the caret is in the text: the browser draws it
  await pg.keyboard.press("ArrowRight");
  await until(h, "the drawn caret goes", async () => (await card.locator(".md-pm .md-icaret").count()) === 0);
  await pg.keyboard.press("ArrowLeft");
  await card.locator(".md-pm .md-icaret-l").waitFor({ state: "attached" });
  // an IME starting to compose there: the browser's own caret is back at once, before any composed character
  const atStart = await pg.evaluate(() => {
    const pm = document.querySelector(".md-pm")!;
    pm.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    const p = [...pm.querySelectorAll("p")].find((x) => x.textContent?.includes("inline here"))!;
    const r = { drawn: pm.querySelectorAll(".md-icaret").length, color: getComputedStyle(p).caretColor };
    pm.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    return r;
  });
  check(
    "noteCaretBesideImage composition start shows the browser's caret",
    atStart.drawn === 0 && atStart.color !== "rgba(0, 0, 0, 0)",
    atStart,
  );
  await card.locator(".md-pm .md-icaret-l").waitFor({ state: "attached" });
  // an IME composing right after the image: the text goes where the caret is
  const cdp = await pg.context().newCDPSession(pg);
  await cdp.send("Input.imeSetComposition", { text: "字", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.insertText", { text: "字" });
  await idle(h);
  const text = await pg.evaluate(
    () => [...document.querySelectorAll(".md-pm p")].map((p) => p.textContent).find((t) => t?.includes("inline")) ?? "",
  );
  check(
    "noteCaretBesideImage IME text after the image",
    text.startsWith("See ") && text.endsWith("字 inline here."),
    text,
  );
  await pg.keyboard.press("Escape");
  await until(h, "Esc saves the Note", () =>
    (h.board().cards.find((c) => c.id === "n0") as NoteCard).md.includes(`${INLINE}字 inline`),
  );
});

/** An IME typing on a selected image writes after the image, as a typed character does: its first key (Process, 229) does
 *  not let the composition replace the image */
test("noteImeOnSelectedImage", async () => {
  const b = emptyBoard("b1", "ime on image");
  put(
    b,
    { id: "n0", kind: "note", md: `See ${INLINE} inline here.\n\nEnd text.`, look: "note" } as NoteCard,
    60,
    60,
    520,
  );
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 760, h: 500 });
  const pg = h.page,
    card = pg.locator('.card[data-id="n0"]');
  await idle(h);
  await card.locator(".nbody p").last().dblclick();
  await card.locator(".md-pm:focus").waitFor();
  await idle(h);
  await card.locator(".md-pm .md-img img").first().click();
  await card.locator(".md-pm .md-img.md-picked").waitFor();
  await idle(h);
  const cdp = await pg.context().newCDPSession(pg);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Process",
    code: "KeyZ",
    windowsVirtualKeyCode: 229,
  });
  await cdp.send("Input.imeSetComposition", { text: "字", selectionStart: 1, selectionEnd: 1 });
  await cdp.send("Input.insertText", { text: "字" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
  await idle(h);
  await pg.keyboard.press("Escape");
  const md = () => (h.board().cards.find((c) => c.id === "n0") as NoteCard).md;
  await until(h, "Esc saves the Note", () => md().includes("字"));
  check("noteImeOnSelectedImage text after the image", md().startsWith(`See ${INLINE}字 inline here.`), md());
});

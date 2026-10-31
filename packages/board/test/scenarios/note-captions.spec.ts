// Captions for images in a Note: right-click the image → Add Caption… / Edit Caption…; the caption is the image's Markdown title
// (![alt](src "caption")) and shows centred right under the image in small muted type, the same in the static render and while
// editing. Each change is one undo step.
//   noteImageCaption   add, render (static and editing), edit, undo, remove
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

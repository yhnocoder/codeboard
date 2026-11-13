import { shot, symCard, findSym, put, type Host } from "../harness";
import { emptyBoard, type Board, type Card, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle } from "../fixtures";

// Note is a card; Text and Box are one card in two looks, written on the board (a Box adds a fill and a frame); each has its own
// toolbar button and key (T, R)
const card = (id: string) => `.card[data-id="${id}"]`;
const notes = (h: Host) => h.board().cards.filter((c): c is NoteCard => c.kind === "note");
const byId = (h: Host, id: string) => h.board().cards.find((c) => c.id === id) as NoteCard | undefined;
const menuItems = (h: Host) => h.page.locator(".ctx:not(.closing) button .lb").allTextContents();
const commitEdit = async (h: Host) => {
  await h.page.keyboard.press("Escape");
  await h.page.locator(".md-pm").waitFor({ state: "detached" });
  await idle(h);
};

/** One Note, one Text, one Box (yellow) linked from the Note */
function threeBoard(): Board {
  const b = emptyBoard("b1", "writing");
  const add = (c: NoteCard, x: number, y: number, w: number) => {
    b.cards.push(c);
    b.place[c.id] = { x, y, w };
  };
  add(
    { id: "note", kind: "note", md: "先 prefill，再 decode；显存不够就 preempt。", look: "note", title: "Scheduler" },
    60,
    120,
    200,
  );
  add({ id: "text", kind: "note", md: "Block Manager", look: "text" }, 330, 260, 160);
  add({ id: "box", kind: "note", md: "Model Runner", look: "box", fill: "yellow" }, 580, 150, 150);
  b.links.push({ id: "L1", from: { card: "note" }, to: { card: "box" } });
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

/** The toolbar's Note, Text and Box buttons each make that kind and start writing in it, and so do N, T and R; M makes nothing */
test("writeButtonsAndKeysCreateTextBox", async () => {
  const h = await open({ board: emptyBoard("b1", "writing"), light, w: 1200, h: 800 });
  const pg = h.page;
  check(
    "writeButtons one button each for Note, Text and Box, none for Mark",
    (await pg.locator('.bbar button[aria-label="Mark"]').count()) === 0 &&
      (await pg.locator('.bbar button[aria-label="Text"]').count()) === 1 &&
      (await pg.locator('.bbar button[aria-label="Box"]').count()) === 1,
  );
  const made: Record<string, NoteCard | undefined> = {};
  for (const [label, look] of [
    ["Text", "text"],
    ["Box", "box"],
    ["Note", "note"],
  ] as const) {
    const before = new Set(h.board().cards.map((c) => c.id));
    await pg.locator(`.bbar button[aria-label="${label}"]`).click();
    await pg.locator(".md-pm").waitFor();
    await pg.keyboard.type(`from ${label}`);
    await commitEdit(h);
    made[label] = await until(h, `${label} makes a ${look}`, () =>
      notes(h).find((c) => !before.has(c.id) && c.md === `from ${label}`),
    );
    check(`writeButton ${label} makes a ${look}`, made[label]?.look === look, made[label]);
  }
  check(
    "writeButton a new Text or Box has no size, fill or set width of its own",
    [made.Text, made.Box].every((c) => !!c && !("fs" in c) && !("fill" in c) && !("wrap" in c)),
    made,
  );
  await shot(h, "writing-made");

  for (const [key, look, x] of [
    ["t", "text", 200],
    ["r", "box", 500],
  ] as const) {
    await pg.mouse.click(x, 560);
    await idle(h);
    const before = new Set(h.board().cards.map((c) => c.id));
    await pg.keyboard.press(key);
    await pg.locator(".md-pm").waitFor();
    await pg.keyboard.type(`by ${key}`);
    await commitEdit(h);
    const c = await until(h, `${key} makes a ${look}`, () =>
      notes(h).find((k) => !before.has(k.id) && k.md === `by ${key}`),
    );
    check(`writeKey ${key.toUpperCase()} makes a ${look}`, c.look === look, c);
  }
  await pg.mouse.click(800, 560);
  await idle(h);
  const n0 = h.board().cards.length;
  await pg.keyboard.press("m");
  await idle(h);
  check(
    "writeKey M makes nothing",
    h.board().cards.length === n0 && (await pg.locator(".md-pm").count()) === 0,
    h.board().cards.slice(n0),
  );
  await h.close();
});

/** A Box: no card frame but its own rounded frame and fill (yellow by default), centred text, arrows attach like on a card. Selected,
 *  a Text and a Box show the same bar (S M L XL, Text and Box) and a Box its five fill dots too; their menus and a Note's are the short
 *  one: AI ▸, Arrange ▸, Copy Path, Delete */
test("boxFillEditAndToolbars", async () => {
  const h = await open({ board: threeBoard(), light, w: 1100, h: 520 });
  const pg = h.page;
  const look = await pg.evaluate((sel) => {
    const c = document.querySelector<HTMLElement>(sel)!,
      t = c.querySelector<HTMLElement>(".tx")!;
    const cs = getComputedStyle(c);
    return {
      cls: c.className,
      bg: cs.backgroundColor,
      shadow: getComputedStyle(c, "::after").boxShadow,
      align: getComputedStyle(t).textAlign,
      head: !!c.querySelector(".chead"),
    };
  }, card("box"));
  check(
    "boxLook frame and fill, no card header, centered",
    /\bbox\b/.test(look.cls) &&
      look.bg !== "rgba(0, 0, 0, 0)" &&
      look.shadow !== "none" &&
      !look.head &&
      look.align === "center",
    look,
  );
  check("boxArrow attaches", (await pg.locator('.link[data-lk="L1"] path:not(.lhit)').count()) > 0);

  const bar = async (id: string) =>
    pg
      .locator(`${card(id)} .ttb.tbar > *`)
      .evaluateAll((es) =>
        es.map((e) =>
          e.classList.contains("hsep")
            ? "|"
            : `${e.textContent?.trim() || e.getAttribute("aria-label")}${e.classList.contains("on") ? "*" : ""}`,
        ),
      );
  await pg.locator(card("box")).click();
  await idle(h);
  const boxBar = await bar("box");
  check(
    "boxToolbar sizes, looks and fill dots, S, Box and yellow lit",
    boxBar.join(",") === "S*,M,L,XL,|,Text,Box*,|,yellow*,paper,blue,green,pink",
    boxBar,
  );
  check("boxCorner one corner handle", (await pg.locator(`${card("box")} .mkgrip`).isVisible()) === true);
  await shot(h, "writing-box-selected");
  await pg.locator(`${card("box")} .bdot.bf-blue`).click();
  await until(h, "the fill is saved", () => byId(h, "box")?.fill === "blue");
  await pg.locator(`${card("box")} .bdot.bf-yellow`).click();
  await until(h, "the fill is back to yellow", () => byId(h, "box")?.fill === "yellow");

  // double-click writes in the box
  await pg.locator(`${card("box")} .tx`).dblclick();
  await pg.locator(`${card("box")} .md-pm`).waitFor();
  await pg.keyboard.press("End");
  await pg.keyboard.type(" 2");
  await commitEdit(h);
  await until(h, "the edit is saved", () => byId(h, "box")?.md === "Model Runner 2");
  check("boxEdit double-click", byId(h, "box")?.md === "Model Runner 2");
  const menu = async (id: string) => {
    await pg.locator(card(id)).click({ button: "right" });
    await pg.locator(".ctx:not(.closing) button").first().waitFor();
    const m = await menuItems(h);
    await pg.keyboard.press("Escape");
    await idle(h);
    return m;
  };
  const SHORT = "Add Sidenote|AI|Arrange|Copy Path|Delete";
  const boxMenu = await menu("box");
  check("boxMenu the short menu", boxMenu.join("|") === SHORT, boxMenu);

  await pg.locator(`${card("text")} .tx`).click();
  await idle(h);
  const textBar = await bar("text");
  check("textToolbar sizes and looks, S and Text lit", textBar.join(",") === "S*,M,L,XL,|,Text*,Box", textBar);
  const textMenu = await menu("text");
  check("textMenu the short menu", textMenu.join("|") === SHORT, textMenu);
  const noteMenu = await menu("note");
  check("noteMenu the short menu", noteMenu.join("|") === SHORT, noteMenu);
  await pg.locator(card("note")).click();
  await idle(h);
  check("noteToolbar none", (await pg.locator(`${card("note")} .ttb.tbar`).count()) === 0);
  await h.close();
});

/** #116: the bar above a selected Box holds every swatch with its ring (the selected one's dark ring, the others'
 *  halo) inside the strip, and no ring touches the next swatch's; in every theme (some of them restyle .pill's padding and gap) */
const swatchRings = async (themes: readonly string[]) => {
  const rings = (sel: string) => {
    const dots = [...document.querySelectorAll<HTMLElement>(sel)];
    const strip = dots[0].parentElement!.getBoundingClientRect();
    const boxes = dots.map((d) => {
      const r = d.getBoundingClientRect();
      const spread = Math.max(
        0,
        ...[...getComputedStyle(d).boxShadow.matchAll(/((?:-?\d*\.?\d+px\s*){4})/g)].map((m) => {
          const n = m[1].trim().split(/\s+/).map(parseFloat);
          return n[3] + Math.abs(n[0]) + Math.abs(n[1]);
        }),
      );
      return {
        l: r.left - spread,
        r: r.right + spread,
        t: r.top - spread,
        b: r.bottom + spread,
        on: d.classList.contains("on"),
      };
    });
    return { strip: { l: strip.left, r: strip.right, t: strip.top, b: strip.bottom }, boxes };
  };
  const bad: unknown[] = [];
  for (const theme of themes) {
    const h = await open({ board: threeBoard(), light, w: 1200, h: 800, settings: { theme } as never });
    const pg = h.page;
    for (const [id, dots, pick] of [["box", ".tbar .bdot", card("box")]] as const) {
      await pg.locator(pick).click();
      await idle(h);
      await pg
        .locator(`${card(id)} ${dots}`)
        .first()
        .waitFor();
      const { strip, boxes } = await pg.evaluate(rings, `${card(id)} ${dots}`);
      const outside = boxes.some((b) => b.l < strip.l || b.r > strip.r || b.t < strip.t || b.b > strip.b);
      const touching = boxes.some((b, i) => i > 0 && boxes[i - 1].r + 1 > b.l);
      if (outside || touching || !boxes.some((b) => b.on)) bad.push({ theme, id, outside, touching, strip, boxes });
      if (id === "box" && (theme === "warm-ink" || theme === "ink-wash")) await shot(h, `writing-swatches-${theme}`);
      await pg.mouse.click(600, 600);
      await idle(h);
    }
    await h.close();
  }
  check("swatchRings inside the strip, none touching the next", bad.length === 0, bad);
};
test("writingSwatchRingsClearWarm", () => swatchRings(["warm-ink", "graphite", "classic", "newspaper", "poster"]));
test("writingSwatchRingsClearStyled", () => swatchRings(["ink-wash", "soft-light", "drafting", "colorful", "city"]));

/** Code card View ▸ Background: checked by default (the card frame); unchecking it puts the code on the canvas, checking brings it back */
test("codeBackgroundToggle", async () => {
  const b = emptyBoard("b1", "code bg");
  const s = findSym("Scheduler.schedule"),
    c = symCard(s.f, s.s);
  put(b, c, 60, 60, 560);
  const h = await open({ board: b, light, w: 1100, h: 700 });
  const pg = h.page;
  const code = () => h.board().cards.find((k) => k.id === c.id) as Card & { bg?: false };
  const view = async () => {
    await pg.locator(`${card(c.id)} .chead`).click({ button: "right", position: { x: 300, y: 12 } });
    await pg.locator(".ctx:not(.closing) button", { hasText: /^View$/ }).hover();
    const item = pg.locator(".ctx:not(.closing) button", { hasText: /^Background$/ });
    await item.waitFor();
    await idle(h);
    return item;
  };
  let item = await view();
  check("codeBackground checked by default", (await item.locator(".ck svg").count()) === 1, await item.innerHTML());
  check(
    "codeBackground no old No Background item",
    (await pg.locator(".ctx:not(.closing) button", { hasText: "No Background" }).count()) === 0,
  );
  await shot(h, "writing-code-view-menu");
  await item.click();
  await until(h, "bg: false is saved", () => code().bg === false);
  await idle(h);
  check("codeBackground off: no frame", await pg.locator(card(c.id)).evaluate((e) => e.classList.contains("nobg")));
  item = await view();
  check("codeBackground unchecked when off", (await item.locator(".ck svg").count()) === 0, await item.innerHTML());
  await item.click();
  await until(h, "the frame is back (no bg field)", () => !("bg" in code()));
  check("codeBackground on again", !(await pg.locator(card(c.id)).evaluate((e) => e.classList.contains("nobg"))));
  await h.close();
});

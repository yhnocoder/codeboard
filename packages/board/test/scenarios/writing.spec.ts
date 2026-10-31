import { shot, symCard, findSym, put, type Host } from "../harness";
import { emptyBoard, type Board, type Card, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle } from "../fixtures";

// Note is a card; Text, Box and Mark are written on the board (no card frame) and come from the toolbar's T ▾ menu or T / R / M
const card = (id: string) => `.card[data-id="${id}"]`;
const notes = (h: Host) => h.board().cards.filter((c): c is NoteCard => c.kind === "note");
const byId = (h: Host, id: string) => h.board().cards.find((c) => c.id === id) as NoteCard | undefined;
const menuItems = (h: Host) => h.page.locator(".ctx button .lb").allTextContents();
const commitEdit = async (h: Host) => {
  await h.page.keyboard.press("Escape");
  await h.page.locator(".md-pm").waitFor({ state: "detached" });
  await idle(h);
};

/** One Note, one Text, one Box (yellow) linked from the Note, one Mark */
function fourBoard(): Board {
  const b = emptyBoard("b1", "writing");
  const add = (c: NoteCard, x: number, y: number, w: number, h?: number) => {
    b.cards.push(c);
    b.place[c.id] = { x, y, w, ...(h ? { h } : {}) };
  };
  add(
    { id: "note", kind: "note", md: "先 prefill，再 decode；显存不够就 preempt。", look: "note", title: "Scheduler" },
    60,
    120,
    200,
  );
  add({ id: "text", kind: "note", md: "Block Manager", look: "text", size: "body" }, 330, 260, 160);
  add({ id: "box", kind: "note", md: "Model Runner", look: "box", fill: "yellow" }, 580, 150, 150, 60);
  add({ id: "mark", kind: "note", md: "这里会 preempt!", look: "mark", hand: "blue" }, 820, 150, 160);
  b.links.push({ id: "L1", from: { card: "note" }, to: { card: "box" } });
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

/** The toolbar's T ▾ only opens a menu (like Code): New Text (T), New Box (R), New Mark (M); each makes its kind, and so do the keys */
test("writeMenuAndKeysCreateTextBoxMark", async () => {
  const h = await open({ board: emptyBoard("b1", "writing"), light, w: 1200, h: 800 });
  const pg = h.page;
  const btn = pg.locator('.bbar button[aria-label="Text"]');
  check(
    "writeMenu one button for Text, Box and Mark",
    (await pg.locator('.bbar button[aria-label="Mark"]').count()) === 0 && (await btn.locator(".ico").count()) === 2,
  );
  await btn.click();
  await pg.locator(".ctx button").first().waitFor();
  await idle(h);
  const items = await pg
    .locator(".ctx button")
    .evaluateAll((bs) =>
      bs.map((b) => `${b.querySelector(".lb")?.textContent} ${b.querySelector("small")?.textContent ?? ""}`.trim()),
    );
  check("writeMenu items", items.join("|") === "New Text T|New Box R|New Mark M", items);
  check("writeMenu made nothing yet", notes(h).length === 0);
  await shot(h, "writing-menu");
  await pg.locator(".ctx button", { hasText: "New Box" }).click();
  await pg.locator(".md-pm").waitFor();
  await pg.keyboard.type("Model Runner");
  await commitEdit(h);
  const box = await until(h, "the Box is saved", () =>
    notes(h).find((c) => c.look === "box" && c.md === "Model Runner"),
  );
  check(
    "writeMenu New Box: yellow, 381 × 60",
    box.fill === "yellow" && h.board().place[box.id].w === 381 && h.board().place[box.id].h === 60,
    { box, place: h.board().place[box.id] },
  );

  const made: Record<string, NoteCard | undefined> = {};
  for (const [key, look, x] of [
    ["t", "text", 200],
    ["r", "box", 500],
    ["m", "mark", 800],
  ] as const) {
    await pg.mouse.click(x, 560);
    await idle(h);
    const before = new Set(h.board().cards.map((c) => c.id));
    await pg.keyboard.press(key);
    await pg.locator(".md-pm").waitFor();
    await pg.keyboard.type(`by ${key}`);
    await commitEdit(h);
    made[key] = await until(h, `${key} makes a ${look}`, () =>
      notes(h).find((c) => !before.has(c.id) && c.md === `by ${key}`),
    );
    check(`writeKey ${key.toUpperCase()} makes a ${look}`, made[key]?.look === look, made[key]);
  }
  check("writeKey R Box is yellow", made.r?.fill === "yellow", made.r);
  check("writeKey M Mark has a hand color", !!made.m?.hand, made.m);
  // an empty Box stays (it is a frame of its own); an empty Text goes
  await pg.mouse.click(300, 700);
  await idle(h);
  const n0 = h.board().cards.length;
  await pg.keyboard.press("r");
  await pg.locator(".md-pm").waitFor();
  await commitEdit(h);
  await pg.keyboard.press("t");
  await pg.locator(".md-pm").waitFor();
  await commitEdit(h);
  await until(h, "the empty Box is saved", () => h.board().cards.length === n0 + 1);
  check(
    "writeKey empty Box stays, empty Text goes",
    h.board().cards.length === n0 + 1 && (h.board().cards.at(-1) as NoteCard).look === "box",
    h.board().cards.slice(n0),
  );
  await h.close();
});

/** A Box: no card frame but its own rounded frame and fill (yellow by default), the fill dots as its only toolbar, corner handles,
 *  double-click to write (centered), arrows attach like on a card. A Text has no toolbar at all; a Mark keeps its color dots */
test("boxFillEditAndToolbars", async () => {
  const h = await open({ board: fourBoard(), light, w: 1100, h: 520 });
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

  await pg.locator(card("box")).click();
  await idle(h);
  const dots = await pg
    .locator(`${card("box")} .bdots .bdot`)
    .evaluateAll((ds) => ds.map((d) => `${d.getAttribute("aria-label")}${d.classList.contains("on") ? "*" : ""}`));
  check(
    "boxToolbar fill dots only, yellow on",
    dots.join(",") === "yellow*,paper,blue,green,pink" && (await pg.locator(`${card("box")} .ttb .tbtn`).count()) === 0,
    dots,
  );
  check("boxCorners four handles", (await pg.locator(`${card("box")} .bxh`).count()) === 4);
  await shot(h, "writing-box-selected");
  await pg.locator(`${card("box")} .bdot.bf-blue`).click();
  await until(h, "the fill is saved", () => byId(h, "box")?.fill === "blue");
  await pg.locator(`${card("box")} .bdot.bf-yellow`).click();
  await until(h, "the fill is back to yellow", () => byId(h, "box")?.fill === "yellow");

  // resize from the top-left corner: the bottom-right corner stays
  const r0 = (await pg.locator(card("box")).boundingBox())!,
    nw = (await pg.locator(`${card("box")} .bxh-nw`).boundingBox())!;
  await pg.mouse.move(nw.x + 4, nw.y + 4);
  await pg.mouse.down();
  await pg.mouse.move(nw.x - 16, nw.y - 26, { steps: 4 });
  await pg.mouse.up();
  await idle(h);
  const p = h.board().place.box;
  check("boxResize from a corner", p.w === 170 && p.h === 90 && p.x === 560 && p.y === 120, { p, r0 });

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
    await pg.locator(".ctx button").first().waitFor();
    const m = await menuItems(h);
    await pg.keyboard.press("Escape");
    await idle(h);
    return m;
  };
  const boxMenu = await menu("box");
  check(
    "boxMenu no Turn into, no Background",
    !boxMenu.some((l) => /Turn into (Text|Note)|Background/.test(l)) && boxMenu.includes("Edit"),
    boxMenu,
  );

  // Text: selected, no toolbar; its menu turns it into a Note, never shows or hides a background
  await pg.locator(`${card("text")} .tx`).click();
  await idle(h);
  check(
    "textNoToolbar",
    (await pg.locator(`${card("text")} .ttb`).count()) === 0,
    await pg.locator(card("text")).innerHTML(),
  );
  const textMenu = await menu("text");
  check(
    "textMenu Turn into Note, no background",
    textMenu.includes("Turn into Note") && !textMenu.some((l) => /Background/.test(l)),
    textMenu,
  );

  // Mark: the color dots stay
  await pg.locator(`${card("mark")} .tx`).click();
  await idle(h);
  check("markDotsStay", (await pg.locator(`${card("mark")} .hdots .hdot`).count()) === 4);
  await shot(h, "writing-mark-selected");
  await pg.mouse.click(600, 420);
  await idle(h);
  await pg.locator('.bbar button[aria-label="Text"]').click();
  await pg.locator(".ctx button").first().waitFor();
  await shot(h, "writing-menu-board");
  await h.close();
});

/** Turn into Text puts the Note's title on the first line as a # heading (shown big and bold, Markdown kept); Turn into Note moves it
 *  back into the header. The round trip looks the same and loses nothing */
test("noteTextRoundTripKeepsTitle", async () => {
  const b = fourBoard();
  (b.cards[0] as NoteCard).md = "先 prefill，再 decode；显存不够就 **preempt**。";
  const h = await open({ board: b, light, w: 1100, h: 520 });
  const pg = h.page;
  const head = () => pg.locator(`${card("note")} .chead .ctitle`).textContent();
  check("noteRoundTrip starts with the title in the header", (await head()) === "Scheduler");
  const before = await pg.locator(card("note")).boundingBox();
  await pg.locator(`${card("note")} .chead button[aria-label="Note Menu"]`).click();
  await pg.locator(".ctx button").first().waitFor();
  await idle(h);
  const items = await menuItems(h);
  check(
    "noteMenu Turn into Text first, Fit Content, Edit, no background",
    items[0] === "Turn into Text" &&
      items.includes("Fit Content") &&
      items.includes("Edit") &&
      !items.some((l) => /Background/.test(l)),
    items,
  );
  await shot(h, "writing-note-menu");
  await pg.locator(".ctx button", { hasText: "Turn into Text" }).click();
  await until(h, "the Note is a Text", () => byId(h, "note")?.look === "text");
  await pg.mouse.click(600, 480);
  await idle(h);
  const t = byId(h, "note")!;
  check(
    "noteToText title is the first line",
    t.md === "# Scheduler\n\n先 prefill，再 decode；显存不够就 **preempt**。" && !t.title,
    t,
  );
  const h1 = await pg.evaluate((sel) => {
    const e = document.querySelector<HTMLElement>(`${sel} .tx > h1:first-child`);
    const p = document.querySelector<HTMLElement>(`${sel} .tx strong`);
    return (
      e && {
        text: e.textContent,
        size: parseFloat(getComputedStyle(e).fontSize),
        weight: +getComputedStyle(e).fontWeight,
        body: p ? parseFloat(getComputedStyle(p).fontSize) : 0,
        frame: !!document.querySelector(`${sel} .chead`),
      }
    );
  }, card("note"));
  check(
    "noteToText heading shown bigger and bold, no card frame",
    !!h1 && h1.text === "Scheduler" && h1.size > h1.body && h1.weight >= 600 && !h1.frame,
    h1,
  );
  await shot(h, "writing-note-as-text");

  await pg.locator(card("note")).click({ button: "right" });
  await pg.locator(".ctx button", { hasText: "Turn into Note" }).click();
  await until(h, "the Text is a Note again", () => byId(h, "note")?.look === "note");
  await pg.mouse.click(600, 480);
  await idle(h);
  const shown = await pg.evaluate(
    (sel) =>
      [...document.querySelector(`${sel} .nbody`)!.children]
        .filter((e) => getComputedStyle(e).display !== "none")
        .map((e) => e.tagName),
    card("note"),
  );
  const after = await pg.locator(card("note")).boundingBox();
  check("noteRoundTrip title back in the header, not twice", (await head()) === "Scheduler" && !shown.includes("H1"), {
    head: await head(),
    shown,
  });
  check(
    "noteRoundTrip same place and size",
    !!before &&
      !!after &&
      Math.abs(before.x - after.x) <= 1 &&
      Math.abs(before.y - after.y) <= 1 &&
      Math.abs(before.width - after.width) <= 1 &&
      Math.abs(before.height - after.height) <= 2,
    { before, after },
  );
  await h.close();
});

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
    await pg.locator(".ctx button", { hasText: /^View$/ }).hover();
    const item = pg.locator(".ctx button", { hasText: /^Background$/ });
    await item.waitFor();
    await idle(h);
    return item;
  };
  let item = await view();
  check("codeBackground checked by default", (await item.locator(".ck svg").count()) === 1, await item.innerHTML());
  check(
    "codeBackground no old No Background item",
    (await pg.locator(".ctx button", { hasText: "No Background" }).count()) === 0,
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

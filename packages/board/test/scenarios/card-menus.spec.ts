// Card context menus and the hover buttons that took some of their items.
//   codeHoverFitWrap          the pointer over a code card (repo and Free code) shows Fit Content and Wrap Lines left of Copy Code; Wrap Lines
//                             wraps the card and shows on (accent), Fit Content fits it; both with label + shortcut tooltips; neither is
//                             there (no width) without the pointer
//   noteHoverFitSplit         the pointer over a Note shows Fit Content and Split by Headings in its header; Fit Content brings a fixed
//                             height back to the content's, Split by Headings splits it
//   sectionHoverFitColorLock  the pointer over a Section's title shows Fit Content, Color and Lock right after it; Color opens five
//                             swatches inline (the current one ringed), a swatch recolours the Section, Color again folds them; Lock locks
//                             (on); Fit Content fits the frame; showing them does not change the title's size
//   hoverButtonsStayWithMenu  a card's and a Section's hover buttons stay while its context menu is open and the pointer is on the menu
//   cardMenusLeaveMovedItems  each kind's menu: Move to Section / New Section / Shelf, Turn into Board, Tilt, Lock, Rename (but on a Link List), Edit ▸ and
//                             the items now on hover buttons or toolbars are gone; Tilt and Lock are in Arrange ▸; the code card's and
//                             the Section's menus are exactly the decided ones
import {
  emptyBoard,
  type Board,
  type CodeCard,
  type ImageCard,
  type LinksCard,
  type NoteCard,
  type WebCard,
} from "@codeboard/core";
import type { Page } from "playwright-core";
import { put, symCard, findSym, type Host } from "../harness";
import { test, open, check, light, until, idle } from "../fixtures";

const repo = (qual: string, id: string): CodeCard => {
  const s = findSym(qual);
  const c = symCard(s.f, s.s);
  c.id = id;
  return c;
};
const LONG = "        C_h[i] = A_h[i] + B_h[i] + A_h[i] * B_h[i] - A_h[i] / (B_h[i] + 1.0f) + 0.5f; // a long line";
const free = (id: string): CodeCard =>
  ({
    id,
    kind: "code",
    title: "vecAdd",
    segments: [
      {
        id: `s${id}`,
        src: { kind: "free" },
        path: "",
        lang: "c",
        start: 1,
        end: 3,
        text: ["void vecAdd(float* A, int n) {", LONG, "}"],
        version: { kind: "none" },
      },
    ],
  }) as CodeCard;
const NOTE_MD = "## Prefill\n\nChecks the free KV blocks.\n\n## Decode\n\nOne token per step.";
const SVG = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#e8a33d"/></svg>',
).toString("base64")}`;

function board(): Board {
  const b = emptyBoard("b1", "card menus");
  put(b, repo("Scheduler.preempt", "r1"), 60, 60, 480);
  put(b, free("f1"), 60, 330, 300);
  put(b, { id: "n1", kind: "note", md: NOTE_MD, look: "note" } as NoteCard, 620, 60, 300);
  b.place.n1.h = 320; // a fixed height Fit Content gives back
  put(b, { id: "n2", kind: "note", md: "Inside the Section.", look: "note" } as NoteCard, 640, 560, 260);
  b.sections.push({ id: "S", title: "Scheduling", x: 610, y: 500, w: 420, h: 260 });
  b.place.n2.section = "S";
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
/** one of each other kind, for the menus */
function kinds(): Board {
  const b = board();
  put(b, { id: "t1", kind: "note", md: "A Text", look: "text" } as NoteCard, 1100, 60, 200);
  put(b, { id: "ft", kind: "note", md: "Free", look: "freetext", level: 1 } as NoteCard, 1100, 140, 200);
  put(b, { id: "mk", kind: "note", md: "a mark", look: "mark", hand: "blue" } as NoteCard, 1100, 240, 160);
  put(b, { id: "bx", kind: "note", md: "Box", look: "box", fill: "yellow" } as NoteCard, 1100, 300, 140);
  put(b, { id: "im", kind: "image", src: SVG } as ImageCard, 1100, 380, 200);
  put(b, { id: "wb", kind: "web", url: "https://example.com/a" } as WebCard, 1100, 540, 300);
  put(
    b,
    { id: "ln", kind: "links", items: [{ id: "i1", url: "https://example.com/b", title: "B" }] } as LinksCard,
    1100,
    720,
    300,
  );
  return b;
}

const card = (id: string) => `.card[data-id="${id}"]`;
/** a header button's box, opacity and state, by its aria-label ("" / 0 when it isn't there) */
const btn = (pg: Page, scope: string, label: string) =>
  pg.evaluate(
    ([scope, label]) => {
      const b = document.querySelector<HTMLElement>(`${scope} .ib[aria-label="${label}"]`);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      // the width that shows: clipped by every ancestor that hides its overflow (the header's hover group shuts to 0)
      let vl = r.left,
        vr = r.right;
      for (let e = b.parentElement; e && !e.matches(".card, .world"); e = e.parentElement)
        if (getComputedStyle(e).overflowX !== "visible") {
          const q = e.getBoundingClientRect();
          vl = Math.max(vl, q.left);
          vr = Math.min(vr, q.right);
        }
      let o = 1;
      for (let e: HTMLElement | null = b; e && !e.matches(".card, .slabel"); e = e.parentElement)
        o *= +getComputedStyle(e).opacity;
      return {
        w: Math.max(0, Math.round(vr - vl)),
        l: r.left,
        r: r.right,
        o,
        on: b.classList.contains("on"),
        tip: b.dataset.tip ?? "",
        kbd: b.dataset.kbd ?? "",
        hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".ib") === b,
      };
    },
    [scope, label],
  );
const away = async (h: Host) => {
  await h.page.mouse.click(1500, 880);
  await h.page.mouse.move(1500, 890);
  await idle(h);
};
const menuLabels = (pg: Page, level: "first" | "last" = "first") =>
  pg.locator(".ctx.open")[level]().locator("button .lb").allInnerTexts();
async function menuOf(h: Host, sel: string) {
  await h.page.locator(sel).first().click({ button: "right" });
  await h.page.locator(".ctx.open").first().waitFor();
  await idle(h);
  return menuLabels(h.page);
}
async function sub(h: Host, label: string) {
  await h.page.locator(`.ctx.open button:has(.lb:text-is("${label}"))`).first().hover();
  await until(h, `the ${label} submenu`, async () => (await h.page.locator(".ctx.open").count()) > 1);
  return menuLabels(h.page, "last");
}
const closeMenu = async (h: Host) => {
  await h.page.keyboard.press("Escape");
  await idle(h);
};

test("codeHoverFitWrap", async () => {
  const h = await open({ board: board(), light, w: 1600, h: 900, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  for (const id of ["r1", "f1"]) {
    await away(h);
    const rest = await btn(pg, card(id), "Fit Content");
    await pg.hover(`${card(id)} .cbody`);
    await idle(h);
    const fit = await btn(pg, card(id), "Fit Content"),
      wrap = await btn(pg, card(id), "Wrap Lines"),
      copy = await btn(pg, card(id), "Copy Code");
    check(`codeHoverFitWrap ${id} hidden without the pointer`, !!rest && rest.w === 0 && rest.o === 0, rest);
    check(
      `codeHoverFitWrap ${id} Fit Content and Wrap Lines show left of Copy Code`,
      !!fit && !!wrap && !!copy && fit.o === 1 && wrap.o === 1 && fit.w === 26 && fit.r <= wrap.l && wrap.r <= copy.l,
      { fit, wrap, copy },
    );
    check(
      `codeHoverFitWrap ${id} tooltips: label and shortcut`,
      fit?.tip === "Fit Content" && !!fit.kbd && wrap?.tip === "Wrap Lines" && !!wrap.kbd,
      { fit, wrap },
    );
  }
  // f1: its long line runs past the card; Wrap Lines wraps it, Fit Content then fits the card
  await pg.locator(`${card("f1")} .ib[aria-label="Wrap Lines"]`).click();
  await until(h, "Wrap Lines is saved", () => (h.board().cards.find((c) => c.id === "f1") as CodeCard).wrap);
  await idle(h);
  const on = await btn(pg, card("f1"), "Wrap Lines");
  check("codeHoverFitWrap Wrap Lines wraps the card and shows on", !!on?.on, on);
  const w0 = h.board().place.f1.w;
  await pg.locator(`${card("f1")} .ib[aria-label="Fit Content"]`).click();
  await until(h, "Fit Content is saved", () => h.board().place.f1.w !== w0);
  check("codeHoverFitWrap Fit Content fits the card", h.board().place.f1.w !== w0, { w0, w: h.board().place.f1.w });
  await pg.keyboard.press("ControlOrMeta+z");
  await pg.keyboard.press("ControlOrMeta+z");
  await until(h, "both undone", () => !(h.board().cards.find((c) => c.id === "f1") as CodeCard).wrap);
  await idle(h);
  check("codeHoverFitWrap each is one undo step", h.board().place.f1.w === w0, h.board().place.f1);
  await h.close();
});

test("noteHoverFitSplit", async () => {
  const h = await open({ board: board(), light, w: 1600, h: 900, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await away(h);
  const rest = await btn(pg, card("n1"), "Split by Headings");
  await pg.hover(`${card("n1")} .chead .ctitle`);
  await idle(h);
  const fit = await btn(pg, card("n1"), "Fit Content"),
    split = await btn(pg, card("n1"), "Split by Headings"),
    more = await btn(pg, card("n1"), "Note Menu");
  check("noteHoverFitSplit hidden without the pointer", !!rest && rest.w === 0 && rest.o === 0, rest);
  check(
    "noteHoverFitSplit Fit Content and Split by Headings show left of ···",
    !!fit &&
      !!split &&
      !!more &&
      fit.o === 1 &&
      split.o === 1 &&
      fit.hit &&
      split.hit &&
      fit.r <= split.l &&
      split.r <= more.l,
    { fit, split, more },
  );
  check("noteHoverFitSplit Fit Content's tooltip has its shortcut", fit?.tip === "Fit Content" && !!fit.kbd, fit);
  await pg.locator(`${card("n1")} .ib[aria-label="Fit Content"]`).click();
  await until(h, "Fit Content drops the fixed height", () => !h.board().place.n1.h);
  check("noteHoverFitSplit Fit Content follows the content again", !h.board().place.n1.h, h.board().place.n1);
  const n0 = h.board().cards.length;
  await pg.hover(`${card("n1")} .chead .ctitle`);
  await pg.locator(`${card("n1")} .ib[aria-label="Split by Headings"]`).click();
  await until(h, "the split is saved", () => h.board().cards.length > n0);
  check(
    "noteHoverFitSplit Split by Headings splits the Note",
    h.board().cards.length === n0 + 1,
    h.board().cards.length,
  );
  await h.close();
});

test("sectionHoverFitColorLock", async () => {
  const h = await open({ board: board(), light, w: 1600, h: 900, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  const label = '.slabel[data-sect="S"]';
  await away(h);
  const size0 = (await pg.locator(label).boundingBox())!;
  const rest = await btn(pg, label, "Fit Content");
  await pg.hover(`${label} .sname`);
  await idle(h);
  const size1 = (await pg.locator(label).boundingBox())!;
  const fit = await btn(pg, label, "Fit Content"),
    color = await btn(pg, label, "Color"),
    lock = await btn(pg, label, "Lock"),
    name = (await pg.locator(`${label} .sname`).boundingBox())!;
  check("sectionHoverFitColorLock hidden without the pointer", !!rest && rest.o === 0 && !rest.hit, rest);
  check(
    "sectionHoverFitColorLock Fit Content, Color, Lock right after the title",
    !!fit &&
      !!color &&
      !!lock &&
      [fit, color, lock].every((b) => b.o === 1 && b.hit) &&
      fit.l >= name.x + name.width &&
      fit.r <= color.l &&
      color.r <= lock.l,
    { fit, color, lock, name },
  );
  check(
    "sectionHoverFitColorLock showing them leaves the title's size alone",
    size0.width === size1.width && size0.height === size1.height,
    { size0, size1 },
  );
  // Color: the swatches open to its right, the current one (None) ringed; Light Blue recolours; Color again folds them
  const swatches = () =>
    pg.locator(`${label} .sw`).evaluateAll((es) =>
      es.map((e) => {
        const r = e.getBoundingClientRect(),
          row = e.closest(".swrow")!.getBoundingClientRect();
        // the width that shows inside the row, which shuts to 0
        const w = Math.max(0, Math.min(r.right, row.right) - Math.max(r.left, row.left));
        return { label: e.getAttribute("aria-label"), w, cur: e.classList.contains("cur") };
      }),
    );
  const shut = await swatches();
  await pg.locator(`${label} .ib[aria-label="Color"]`).click();
  await idle(h);
  const opened = await swatches();
  const lock2 = await btn(pg, label, "Lock");
  check(
    "sectionHoverFitColorLock Color opens the five swatches, None ringed",
    opened.length === 5 &&
      opened.every((s) => s.w > 15.5) &&
      opened.map((s) => s.label).join() === "None,Warm Sand,Light Blue,Light Green,Light Pink" &&
      opened[0].cur &&
      opened.filter((s) => s.cur).length === 1 &&
      !!lock2 &&
      lock2.l > (lock?.l ?? 0),
    { opened, lock2 },
  );
  check(
    "sectionHoverFitColorLock folded until Color is clicked",
    shut.every((s) => s.w < 16),
    shut,
  );
  await pg.locator(`${label} .sw[aria-label="Light Blue"]`).click();
  await until(h, "the colour is saved", () => h.board().sections[0].color === "blue");
  await idle(h);
  check(
    "sectionHoverFitColorLock a swatch recolours the Section and is ringed",
    (await swatches()).find((s) => s.cur)?.label === "Light Blue" &&
      (await pg.locator('.sect[data-sect="S"]').evaluate((e) => e.classList.contains("c-blue"))),
  );
  await pg.locator(`${label} .ib[aria-label="Color"]`).click();
  await idle(h);
  check(
    "sectionHoverFitColorLock Color again folds the swatches",
    (await swatches()).every((s) => s.w < 1),
  );
  // Fit Content, then Lock (a locked Section does not fit)
  const w0 = h.board().sections[0].w;
  await pg.locator(`${label} .ib[aria-label="Fit Content"]`).click();
  await until(h, "Fit Content is saved", () => h.board().sections[0].w !== w0);
  check("sectionHoverFitColorLock Fit Content fits the frame", h.board().sections[0].w !== w0, h.board().sections[0]);
  await pg.locator(`${label} .ib[aria-label="Lock"]`).click();
  await until(h, "the lock is saved", () => h.board().sections[0].locked);
  await idle(h);
  const locked = await btn(pg, label, "Unlock");
  check("sectionHoverFitColorLock Lock locks and shows on", !!locked?.on && locked.o === 1, locked);
  await h.close();
});

test("hoverButtonsStayWithMenu", async () => {
  const h = await open({ board: board(), light, w: 1600, h: 900, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  const onMenu = async () => {
    const r = (await pg.locator(".ctx.open").first().boundingBox())!;
    await pg.mouse.move(r.x + r.width / 2, r.y + r.height - 10);
    await idle(h);
  };
  for (const [what, open, scope, label] of [
    ["code card", `${card("r1")} .chead .ctitle`, card("r1"), "Wrap Lines"],
    ["Note", `${card("n1")} .chead .ctitle`, card("n1"), "Split by Headings"],
    ["Section", '.slabel[data-sect="S"] .sname', '.slabel[data-sect="S"]', "Color"],
  ] as const) {
    await away(h);
    await pg.locator(open).click({ button: "right" });
    await pg.locator(".ctx.open").first().waitFor();
    await onMenu();
    const b = await btn(pg, scope, label),
      onIt = await pg.evaluate((s) => !!document.querySelector(`${s}:hover`), scope),
      menuOpen = (await pg.locator(".ctx.open").count()) > 0;
    check(
      `hoverButtonsStayWithMenu ${what}: shown while its menu is open and the pointer is on the menu`,
      menuOpen && !onIt && !!b && b.o === 1 && b.w === 26,
      { b, onIt, menuOpen },
    );
    await closeMenu(h);
  }
  await h.close();
});

test("cardMenusLeaveMovedItems", async () => {
  const h = await open({ board: kinds(), light, w: 1700, h: 900, settings: { theme: "warm-ink" } as never });
  const GONE = [
    "Move to Section",
    "Move to New Section",
    "Move to Shelf",
    "Turn into Board…",
    "Tilt",
    "Lock",
    "Unlock",
    "Rename",
    "Edit",
    "Open in Editor",
    "Wrap Lines",
    "Split by Headings",
    "Copy Image",
    "Background",
    "Level",
    "Bold",
    "Color",
    "Weight",
    "Size",
  ];
  const menus: Record<string, string[]> = {};
  const targets: [string, string][] = [
    ["code", `${card("r1")} .chead .ctitle`],
    ["free", `${card("f1")} .chead .ctitle`],
    ["note", `${card("n1")} .chead .ctitle`],
    ["text", `${card("t1")} .tx`],
    ["freetext", `${card("ft")} .tx`],
    ["mark", `${card("mk")} .tx`],
    ["box", `${card("bx")} .tx`],
    ["image", `${card("im")} .imgb`],
    ["web", card("wb")],
    ["links", `${card("ln")} .chead`],
  ];
  for (const [k, sel] of targets) {
    await away(h);
    menus[k] = await menuOf(h, sel);
    const arrange = menus[k].includes("Arrange") ? await sub(h, "Arrange") : [];
    await closeMenu(h);
    const gone = menus[k].filter(
      (l) => (GONE.includes(l) && !(k === "links" && l === "Rename")) || (k !== "text" && l === "Fit Content"),
    );
    check(`cardMenusLeaveMovedItems ${k}: none of the moved items`, gone.length === 0, gone, menus[k]);
    check(
      `cardMenusLeaveMovedItems ${k}: Arrange ▸ ends with Tilt and Lock, then Copy Path and Delete`,
      arrange.slice(-2).join() === "Tilt,Lock" && menus[k].slice(-3).join() === "Arrange,Copy Path,Delete",
      arrange,
      menus[k],
    );
  }
  check(
    "cardMenusLeaveMovedItems code card: Add, View, Add Variant…, then the tail",
    menus.code.join("|") === "Add|View|Add Variant…|Arrange|Copy Path|Delete",
    menus.code,
  );
  check(
    "cardMenusLeaveMovedItems Free code: Add, View, the tail",
    menus.free.join("|") === "Add|View|Arrange|Copy Path|Delete",
    menus.free,
  );
  check(
    "cardMenusLeaveMovedItems Note: Turn into Text, AI, the tail",
    menus.note.join("|") === "Turn into Text|AI|Arrange|Copy Path|Delete",
    menus.note,
  );
  check(
    "cardMenusLeaveMovedItems Text: Fit Content, Turn into Note, AI, the tail",
    menus.text.join("|") === "Fit Content|Turn into Note|AI|Arrange|Copy Path|Delete",
    menus.text,
  );
  check(
    "cardMenusLeaveMovedItems Free Text and Mark: the tail only",
    menus.freetext.join("|") === "Arrange|Copy Path|Delete" && menus.mark.join("|") === "Arrange|Copy Path|Delete",
    menus.freetext,
    menus.mark,
  );
  check(
    "cardMenusLeaveMovedItems image: Add Description, AI, the tail",
    menus.image.join("|") === "Add Description|AI|Arrange|Copy Path|Delete",
    menus.image,
  );
  check(
    "cardMenusLeaveMovedItems web: Open, Refresh, View, Edit Title, Edit Description, the tail",
    menus.web.join("|") === "Open in Browser|Refresh Preview|View|Edit Title|Edit Description|Arrange|Copy Path|Delete",
    menus.web,
  );
  check(
    "cardMenusLeaveMovedItems links: Open All, View, Rename, the tail",
    menus.links.join("|") === "Open All in Browser|View|Rename|Arrange|Copy Path|Delete",
    menus.links,
  );
  // the code card's submenus
  await away(h);
  await menuOf(h, `${card("r1")} .chead .ctitle`);
  const add = await sub(h, "Add");
  await h.page.locator('.ctx.open button:has(.lb:text-is("View"))').first().hover();
  await until(h, "the View submenu", async () => (await menuLabels(h.page, "last")).includes("Hide Comments"));
  const view = await menuLabels(h.page, "last");
  await closeMenu(h);
  check(
    "cardMenusLeaveMovedItems code card Add ▸",
    add.join("|") === "Sidenote|Question|Description|Generated Code|Process Tag…|Thread / Stream Tag…",
    add,
  );
  check(
    "cardMenusLeaveMovedItems code card View ▸ without Wrap Lines",
    view.join("|") === "Hide Blank Lines|Hide Comments|Hide Docstrings|Show All Hidden Lines|Background",
    view,
  );
  // the Section: Collapse, Copy Path, Remove Section
  await away(h);
  const sect = await menuOf(h, '.slabel[data-sect="S"] .sname');
  await closeMenu(h);
  check(
    "cardMenusLeaveMovedItems Section: Collapse, Copy Path, Remove Section",
    sect.join("|") === "Collapse|Copy Path|Remove Section",
    sect,
  );
  await h.close();
});

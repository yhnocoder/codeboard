// Sidenotes on a whole card, a Note's paragraph, a Section and free on the canvas (ui/SnBadge.tsx, ui/pops/notes.tsx NotesPop),
// each added from the right-click menu of what it goes on, with the mouse:
//  sidenoteSpotCard     a code card's menu starts with Add Sidenote: its popup opens beside the card (not over it or its badge),
//                       titled by the card, the input ready; ↵ adds a whole-card sidenote and its badge shows past the card's
//                       right edge, at the header; a click on the badge closes the popup, another opens it again
//  sidenoteSpotBlock    a right-click on a Note's paragraph → Add Sidenote: the sidenote is on that paragraph, its badge at the
//                       paragraph's first line; a paragraph written above it moves it along, as an arrow's end on a block
//  sidenoteSpotSection  a Section's menu has Add Sidenote: the badge sits after its title; removing the Section deletes it
//  sidenoteSpotFree     the empty canvas's menu has Add Sidenote: a free badge where the menu was opened, its popup dragged away with a
//                       dashed line back to it; the badge dragged, it moves; dropped
//                       onto a Note's paragraph (tinted while over it) it sits on that paragraph
import type { Page } from "@playwright/test";
import { blockSig, emptyBoard, type Board, type CodeCard } from "@codeboard/core";
import { put, shot, type Host } from "../harness";
import { test, open, check, light, expect, until, idle } from "../fixtures";

const CODE = Array.from({ length: 16 }, (_, i) =>
  i % 4 === 0 ? `def step_${i}(seq):` : `    total += seq.len * ${i}`,
);
const NOTE = "First paragraph about blocks.\n\nSecond paragraph: the KV cache.\n\nThird paragraph, on preemption.";

function board(): Board {
  const b = emptyBoard("bS", "sidenote spots");
  const seg = {
    id: "s1",
    src: { kind: "free" },
    path: "",
    lang: "python",
    start: 1,
    end: CODE.length,
    text: CODE.slice(),
    version: { kind: "none" },
  };
  put(b, { id: "k1", kind: "code", title: "schedule", segments: [seg] } as unknown as CodeCard, 60, 60, 420);
  put(b, { id: "nc", kind: "note", look: "note", md: NOTE } as never, 620, 60, 320);
  b.sections.push({ id: "sec", title: "Prefix cache", x: 40, y: 520, w: 460, h: 220 });
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

type Box = { x: number; y: number; r: number; b: number };
const box = (pg: Page, sel: string): Promise<Box> =>
  pg
    .locator(sel)
    .first()
    .evaluate((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left, y: r.top, r: r.right, b: r.bottom };
    });
const overlaps = (a: Box, b: Box) => a.x < b.r - 0.5 && b.x < a.r - 0.5 && a.y < b.b - 0.5 && b.y < a.b - 0.5;
const menuItems = (pg: Page) => pg.locator(".ctx:not(.closing) button .lb").allTextContents();
const pick = (pg: Page, label: string) =>
  pg.locator(".ctx:not(.closing) button", { has: pg.locator(`.lb:text-is("${label}")`) }).click();
const typing = (pg: Page) => pg.locator(".pop.k-notes .ncomp .md-pm:focus");
const notes = (h: Host) => h.board().sidenotes;

async function write(h: Host, text: string) {
  await typing(h.page).waitFor();
  const n = notes(h).length;
  await h.page.keyboard.type(text);
  await h.page.keyboard.press("Enter");
  await until(h, "the sidenote is added", () => notes(h).length > n);
  await idle(h);
}

test("sidenoteSpotCard", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 860 });
  const pg = h.page;
  await pg.locator('.card[data-id="k1"] .chead').click({ button: "right", position: { x: 120, y: 12 } });
  const items = await menuItems(pg);
  await pick(pg, "Add Sidenote");
  await write(h, "Runs once per step.");
  const n = notes(h)[0];
  const badge = '.snb[data-spot="c:k1"]';
  await pg.locator(badge).waitFor();
  const card = await box(pg, '.card[data-id="k1"]'),
    mk = await box(pg, badge),
    head = await box(pg, '.card[data-id="k1"] .chead'),
    pop = await box(pg, ".pop.k-notes");
  const title = await pg.locator(".pop.k-notes .hh .ttl").textContent();
  await shot(h, "sidenoteSpotCard");
  check(
    "sidenoteSpotCard Add Sidenote is the card menu's first item; ↵ adds a whole-card sidenote",
    items[0] === "Add Sidenote" &&
      n?.kind === "text" &&
      n.md === "Runs once per step." &&
      JSON.stringify(n.at) === '{"card":"k1"}',
    { items, n },
  );
  check(
    "sidenoteSpotCard the badge is past the card's right edge, at its header; the popup, titled by the card, covers neither",
    mk.x >= card.r &&
      mk.y < head.b &&
      mk.b > head.y &&
      !overlaps(pop, card) &&
      !overlaps(pop, mk) &&
      title === "schedule",
    { card, mk, head, pop, title },
  );
  // the badge toggles its popup
  await pg.locator(badge).click();
  await expect(pg.locator(".pop.k-notes")).toHaveCount(0);
  await pg.locator(badge).click();
  await pg.locator(".pop.k-notes .slip").waitFor();
  check("sidenoteSpotCard a click on the badge closes the popup and another opens it", true);
  await h.close();
});

test("sidenoteSpotBlock", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 860 });
  const pg = h.page;
  const para = (i: number) => pg.locator('.card[data-id="nc"] .nbody > *').nth(i);
  await para(1).click({ button: "right" });
  const items = await menuItems(pg);
  await pick(pg, "Add Sidenote");
  await write(h, "Where the blocks live.");
  const n = notes(h)[0];
  const key = `b:nc:1:${blockSig("Second paragraph: the KV cache.")}`;
  await pg.locator(`.snb[data-spot="${key}"]`).waitFor();
  const at = async () => ({
    mk: await box(pg, ".snb[data-spot^='b:nc:']"),
    p: await box(pg, ".card[data-id='nc'] .nbody > :nth-child(2)"),
  });
  const first = await at();
  await shot(h, "sidenoteSpotBlock");
  check(
    "sidenoteSpotBlock a right-click on a paragraph → Add Sidenote (first item) puts the sidenote on that paragraph, its badge at its first line",
    items[0] === "Add Sidenote" &&
      JSON.stringify(n?.at) ===
        JSON.stringify({ card: "nc", block: { i: 1, h: blockSig("Second paragraph: the KV cache.") } }) &&
      first.mk.y < first.p.y + 20 &&
      first.mk.b > first.p.y,
    { items, n, first },
  );
  // a paragraph written above it: the sidenote follows its paragraph
  await pg.keyboard.press("Escape");
  await idle(h);
  await para(0).dblclick();
  await pg.locator('.card[data-id="nc"] .ProseMirror:focus').waitFor();
  // the caret to the start of the first paragraph, with a click in the editor once it is up
  await idle(h);
  await pg
    .locator('.card[data-id="nc"] .ProseMirror > p')
    .first()
    .click({ position: { x: 1, y: 6 } });
  await pg.keyboard.press("Home");
  await pg.keyboard.type("A new first paragraph.");
  await pg.keyboard.press("Enter");
  await expect(pg.locator('.card[data-id="nc"] .ProseMirror')).toContainText("A new first paragraph.");
  await pg.keyboard.press("Escape");
  await until(h, "the Note is saved", () =>
    (h.board().cards.find((c) => c.id === "nc") as { md: string }).md.startsWith("A new"),
  );
  await idle(h);
  const moved = notes(h)[0];
  const after = {
    mk: await box(pg, ".snb[data-spot^='b:nc:']"),
    p: await box(pg, ".card[data-id='nc'] .nbody > :nth-child(3)"),
  };
  await shot(h, "sidenoteSpotBlock-edited");
  check(
    "sidenoteSpotBlock a paragraph written above moves the sidenote along with its paragraph, badge and all",
    moved?.at.block?.i === 2 && after.mk.y < after.p.y + 20 && after.mk.b > after.p.y && after.mk.y > first.mk.y + 10,
    { moved: moved?.at, after, first },
  );
  await h.close();
});

test("sidenoteSpotSection", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 860 });
  const pg = h.page;
  await pg.locator('.slabel[data-sect="sec"] .sname').click({ button: "right" });
  const items = await menuItems(pg);
  await pick(pg, "Add Sidenote");
  await write(h, "Why a Section here.");
  const n = notes(h)[0];
  await pg.locator('.slabel[data-sect="sec"] .snb[data-spot="s:sec"]').waitFor();
  const title = await pg.locator(".pop.k-notes .hh .ttl").textContent();
  await shot(h, "sidenoteSpotSection");
  check(
    "sidenoteSpotSection the Section's menu has Add Sidenote; its badge sits after the title; the popup is titled by the Section",
    items.includes("Add Sidenote") && JSON.stringify(n?.at) === '{"section":"sec"}' && title === "Prefix cache",
    { items, n, title },
  );
  await pg.keyboard.press("Escape");
  await idle(h);
  await pg.locator('.slabel[data-sect="sec"] .sname').click({ button: "right" });
  await pick(pg, "Remove Section");
  await until(h, "the Section is deleted", () => !h.board().sections.length);
  check("sidenoteSpotSection removing the Section deletes its sidenotes", !notes(h).length, notes(h));
  await h.close();
});

test("sidenoteSpotFree", async () => {
  const h = await open({ board: board(), light, w: 1300, h: 860 });
  const pg = h.page;
  await pg.mouse.click(1100, 600, { button: "right" });
  const items = await menuItems(pg);
  await pick(pg, "Add Sidenote");
  await write(h, "A thought for later.");
  const n = notes(h)[0];
  const free = ".snb.free";
  await pg.locator(free).waitFor();
  const at = await box(pg, free);
  await shot(h, "sidenoteSpotFree");
  check(
    "sidenoteSpotFree the canvas menu's Add Sidenote puts a free sidenote where the menu was opened",
    items.includes("Add Sidenote") &&
      n?.at.card === undefined &&
      n?.at.section === undefined &&
      Math.abs((at.x + at.r) / 2 - 1100) < 4 &&
      Math.abs((at.y + at.b) / 2 - 600) < 4,
    { items, n, at },
  );
  // its popup dragged by the title bar: a dashed line back to the badge
  const hh = await box(pg, ".pop.k-notes .hh");
  await pg.mouse.move((hh.x + hh.r) / 2, (hh.y + hh.b) / 2);
  await pg.mouse.down();
  await pg.mouse.move((hh.x + hh.r) / 2 - 240, (hh.y + hh.b) / 2 - 260, { steps: 8 });
  await pg.mouse.up();
  await idle(h);
  const held = { pop: await box(pg, ".pop.k-notes"), line: await pg.locator(".popline").count() };
  await shot(h, "sidenoteSpotFree-held");
  check(
    "sidenoteSpotFree its popup dragged away draws a dashed line back to the badge",
    held.line === 1 && !overlaps(held.pop, at),
    held,
  );
  await pg.locator('.pop.k-notes [aria-label="Close"]').click();
  await expect(pg.locator(".pop.k-notes")).toHaveCount(0);
  await idle(h);
  // dragged to another point, it moves there
  await pg.mouse.move((at.x + at.r) / 2, (at.y + at.b) / 2);
  await pg.mouse.down();
  await pg.mouse.move(1150, 700, { steps: 6 });
  await pg.mouse.up();
  await until(h, "the free sidenote moves", () => {
    const a = notes(h)[0]?.at;
    return a && a.card === undefined && a.section === undefined && a.x > 1120;
  });
  await idle(h);
  // then onto the Note's third paragraph: tinted while over it, and on it once dropped
  const p3 = await box(pg, ".card[data-id='nc'] .nbody > :nth-child(3)");
  await pg.mouse.move(1150, 700);
  await pg.mouse.down();
  await pg.mouse.move((p3.x + p3.r) / 2, p3.y + 6, { steps: 10 });
  await pg.locator(".card[data-id='nc'] .sntint").waitFor();
  await shot(h, "sidenoteSpotFree-aim", "now");
  await pg.mouse.up();
  await until(h, "the free sidenote is on the paragraph", () => notes(h)[0]?.at.card === "nc");
  await idle(h);
  const on = notes(h)[0];
  check(
    "sidenoteSpotFree dropped onto a Note's paragraph it sits on that paragraph",
    on?.at.block?.i === 2 &&
      (await pg.locator(".snb.free").count()) === 0 &&
      (await pg.locator(".snb[data-spot^='b:nc:2:']").count()) === 1,
    on,
  );
  await h.close();
});

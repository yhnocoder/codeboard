// The Shelf: Move to Shelf from the menu and the key, Put Back, dragging a row out onto the board, dragging a card onto the
// dock's Shelf button, undo, and the arrows that are hidden while their card is shelved
import { shot, symCard, findSym, put, type Host } from "../harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle } from "../fixtures";

const close = (h: Host) => h.page.context().close();

/**
 * Scheduling (Scheduler.schedule) and Block manager (BlockManager.allocate, a Note) Sections, a Note outside; arrows
 * schedule → allocate (between the Sections) and allocate → the Note (inside Block manager)
 */
function board(o: { runner?: boolean } = {}): { b: Board; sched: string; alloc: string; runner?: string } {
  const b = emptyBoard("b1", "nano-vllm · shelf");
  const s1 = findSym("Scheduler.schedule");
  const c1 = symCard(s1.f, s1.s);
  put(b, c1, 80, 120, 470);
  const s2 = findSym("BlockManager.allocate");
  const c2 = symCard(s2.f, s2.s);
  put(b, c2, 700, 120, 440);
  const n1: NoteCard = {
    id: "n1",
    kind: "note",
    look: "note",
    md: "# Prefix cache\n\nBlocks are hashed by their token ids; a hit skips prefill for that block.",
  };
  put(b, n1, 700, 470, 300);
  const n2: NoteCard = {
    id: "n2",
    kind: "note",
    look: "note",
    md: "# CUDA graph capture\n\nOnly decode batches ≤ 512 use captured graphs.",
  };
  put(b, n2, 1180, 120, 240);
  let runner: string | undefined;
  if (o.runner) {
    const s3 = findSym("ModelRunner.run_model");
    const c3 = symCard(s3.f, s3.s);
    put(b, c3, 1180, 360, 420);
    runner = c3.id;
  }
  b.sections.push({ id: "S1", title: "Scheduling", x: 50, y: 70, w: 530, h: 700 });
  b.sections.push({ id: "S2", title: "Block manager", x: 670, y: 70, w: 500, h: 600 });
  b.place[c1.id].section = "S1";
  b.place[c2.id].section = "S2";
  b.place.n1.section = "S2";
  b.links.push({ id: "L1", from: { card: c1.id }, to: { card: c2.id } });
  b.links.push({ id: "L2", from: { card: c2.id }, to: { card: "n1" } });
  b.cam = { x: 0, y: 0, z: 1 };
  return { b, sched: c1.id, alloc: c2.id, runner };
}

/** Places compared whatever order their keys are in */
const places = (p: Board["place"]) => JSON.stringify(Object.entries(p).sort(([a], [b]) => a.localeCompare(b)));
const arrowsDrawn = (h: Host) =>
  h.page.evaluate(() => [...document.querySelectorAll<SVGElement>("path.lhit[data-link]")].map((p) => p.dataset.link));

/** A Section ▸ Move to Shelf takes it with its cards and arrows; Put Back brings it all back where it was; each is one undo step */
test("shelfMenuPutBack", async () => {
  const { b: b0, alloc } = board();
  const h = await open({ board: structuredClone(b0), light, w: 1440, h: 900 });
  await idle(h);
  await h.page.locator('.slabel[data-sect="S2"] .sname').click({ button: "right" });
  const item = h.page.locator(".ctx:not(.closing) button", { hasText: "Move to Shelf" });
  check("shelf-menu-item", (await item.count()) === 1, {
    items: await h.page.locator(".ctx:not(.closing) button").allTextContents(),
  });
  await item.click();
  await until(h, "the Section is on the Shelf", () => h.board().shelf?.length === 1);
  await idle(h);
  const b = h.board();
  const e = b.shelf![0];
  check(
    "shelf-menu-takes-section",
    !b.sections.some((s) => s.id === "S2") &&
      !b.place[alloc] &&
      !b.place.n1 &&
      b.links.length === 0 &&
      Object.keys(e.place).sort().join() === [alloc, "n1"].sort().join() &&
      e.links.length === 2,
    { sections: b.sections.map((s) => s.id), place: Object.keys(b.place), shelf: e },
  );
  const dom = {
    cards: await h.page.locator(`.card[data-id="${alloc}"], .card[data-id="n1"]`).count(),
    sect: await h.page.locator('.sect[data-sect="S2"]').count(),
    arrows: await arrowsDrawn(h),
    badge: await h.page.locator(".dock .shelf-btn .sbadge").textContent(),
  };
  check("shelf-menu-off-canvas", !dom.cards && !dom.sect && !dom.arrows.length && dom.badge === "1", dom);
  await h.page.locator(".dock .shelf-btn").click();
  const row = h.page.locator(".cpanel.shelf .srow");
  await row.first().waitFor();
  const text = await row.first().innerText();
  check("shelf-row-label", text.includes("Block manager") && text.includes("Section · 2 cards · 1 arrow"), { text });
  await row.first().locator(".sback").click();
  await until(h, "put back", () => !h.board().shelf && !!h.board().place[alloc]);
  await idle(h);
  const back = h.board();
  check(
    "shelf-put-back-where-it-was",
    places(back.place) === places(b0.place) &&
      JSON.stringify(back.sections) === JSON.stringify(b0.sections) &&
      back.links.length === 2,
    { place: back.place, sections: back.sections },
  );
  check("shelf-put-back-arrows-drawn", (await arrowsDrawn(h)).sort().join() === "L1,L2", await arrowsDrawn(h));
  check("shelf-panel-empty", (await h.page.locator(".cpanel.shelf .empty").count()) === 1);
  await h.page.keyboard.press("ControlOrMeta+z");
  await until(h, "undo Put Back: on the Shelf again", () => h.board().shelf?.length === 1);
  await h.page.keyboard.press("ControlOrMeta+z");
  await until(h, "undo Move to Shelf: as it was", () => !h.board().shelf && !!h.board().place.n1);
  await idle(h);
  check(
    "shelf-undo",
    places(h.board().place) === places(b0.place) && (await arrowsDrawn(h)).length === 2,
    h.board().place,
  );
  await close(h);
});

/** A card shelved with ⌥S and dragged out of the panel: a dashed outline follows the pointer, the card lands under it */
test("shelfDragRowOut", async () => {
  const { b } = board();
  const h = await open({ board: b, light, w: 1440, h: 900 });
  await idle(h);
  await h.page.locator('.card[data-id="n2"] .chead').click();
  await h.page.keyboard.press("Alt+KeyS");
  await until(h, "n2 on the Shelf", () => h.board().shelf?.length === 1 && !h.board().place.n2);
  await h.page.locator(".dock .shelf-btn").click();
  const row = (await h.page.locator(".cpanel.shelf .srow").first().boundingBox())!;
  const off = await h.page.evaluate(() => {
    const r = document.getElementById("board")!.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  await h.page.mouse.move(row.x + 40, row.y + row.height / 2);
  await h.page.mouse.down();
  await h.page.mouse.move(row.x - 100, row.y + 80, { steps: 4 });
  await h.page.mouse.move(760, 740, { steps: 8 });
  await h.page.locator(".shelf-outline").waitFor();
  const lifted = await h.page.locator(".cpanel.shelf .srow.lift").count();
  check("shelf-drag-outline", lifted === 1, { lifted });
  await h.page.mouse.up();
  await until(h, "n2 placed", () => !h.board().shelf && h.board().place.n2);
  const p = h.board().place.n2;
  // held just inside its top left (28, 14 on screen at zoom 1)
  check(
    "shelf-drop-under-pointer",
    Math.abs(p.x - (760 - off.x - 28)) <= 2 && Math.abs(p.y - (740 - off.y - 14)) <= 2,
    {
      p,
      off,
    },
  );
  check("shelf-outline-gone", (await h.page.locator(".shelf-outline").count()) === 0);
  await idle(h);
  check("shelf-dropped-drawn", (await h.page.locator('.card[data-id="n2"]').count()) === 1);
  await h.page.keyboard.press("ControlOrMeta+z");
  await until(h, "undo: back on the Shelf", () => h.board().shelf?.length === 1 && !h.board().place.n2);
  await close(h);
});

/** Dragging a card onto the dock's Shelf button lights it up; let go, the card goes onto the Shelf (undo: back where it was) */
test("shelfDragOntoDock", async () => {
  const { b } = board();
  const at = { ...b.place.n2 };
  const h = await open({ board: b, light, w: 1440, h: 900 });
  await idle(h);
  const head = (await h.page.locator('.card[data-id="n2"] .chead').boundingBox())!;
  const btn = (await h.page.locator(".dock .shelf-btn").boundingBox())!;
  await h.page.mouse.move(head.x + 40, head.y + head.height / 2);
  await h.page.mouse.down();
  await h.page.mouse.move(head.x + 20, head.y + 200, { steps: 6 });
  const armed = await h.page.locator(".dock .shelf-btn.armed").count();
  await h.page.mouse.move(btn.x + btn.width / 2, btn.y + btn.height / 2, { steps: 10 });
  await h.page.locator(".dock .shelf-btn.hot").waitFor();
  check("shelf-dock-armed-while-dragging", armed === 1, { armed });
  await h.page.mouse.up();
  await until(h, "n2 on the Shelf", () => h.board().shelf?.length === 1 && !h.board().place.n2);
  await idle(h);
  check("shelf-dock-took-card", (await h.page.locator('.card[data-id="n2"]').count()) === 0);
  check("shelf-dock-unlit", (await h.page.locator(".dock .shelf-btn.hot, .dock .shelf-btn.armed").count()) === 0);
  check("shelf-dock-kept-place", JSON.stringify(h.board().shelf![0].place.n2) === JSON.stringify(at), {
    at,
    kept: h.board().shelf![0].place.n2,
  });
  await h.page.keyboard.press("ControlOrMeta+z");
  await until(h, "undo: n2 back", () => !h.board().shelf && h.board().place.n2);
  check(
    "shelf-dock-undo-where-it-was",
    h.board().place.n2.x === at.x && h.board().place.n2.y === at.y,
    h.board().place.n2,
  );
  await close(h);
});

/** A shelved card's arrows are hidden; one whose other card is deleted meanwhile does not come back; the rest come back */
test("shelfArrows", async () => {
  const { b, alloc } = board();
  const h = await open({ board: b, light, w: 1440, h: 900 });
  await idle(h);
  await h.page.locator(`.card[data-id="${alloc}"] .chead`).click({ button: "right" });
  await h.page.locator(".ctx:not(.closing) button", { hasText: "Move to Shelf" }).click();
  await until(h, "allocate on the Shelf", () => h.board().shelf?.length === 1);
  await idle(h);
  check("shelf-arrows-hidden", (await arrowsDrawn(h)).length === 0, await arrowsDrawn(h));
  await h.page.locator('.card[data-id="n1"] .chead').click();
  await h.page.keyboard.press("Delete");
  await until(h, "n1 deleted", () => !h.board().cards.some((c) => c.id === "n1"));
  check(
    "shelf-arrow-to-deleted-card-goes",
    h
      .board()
      .shelf![0].links.map((l) => l.id)
      .join() === "L1",
    h.board().shelf,
  );
  await h.page.locator(".dock .shelf-btn").click();
  await h.page.locator(".cpanel.shelf .srow .sback").click();
  await until(h, "put back", () => !h.board().shelf);
  await idle(h);
  check("shelf-arrows-back", (await arrowsDrawn(h)).join() === "L1", await arrowsDrawn(h));
  await close(h);
});

/** Warm Ink screenshots at 2× for review: the menu, the panel with three entries, a row dragged out, a card over the dock */
/** Resting the pointer on a Shelf row shows the entry beside the panel as it was: the Section with its title, its cards with their
 *  content; the next row's shows at once, and it goes when the pointer leaves the rows or a row is dragged */
test("shelfRowPreview", async () => {
  const { b } = board();
  const h = await open({ board: b, light, w: 1440, h: 900 });
  await idle(h);
  await h.page.locator('.card[data-id="n2"] .chead').click();
  await h.page.keyboard.press("Alt+KeyS");
  await until(h, "n2 on the Shelf", () => h.board().shelf?.length === 1);
  await h.page.locator('.slabel[data-sect="S2"] .sname').click({ button: "right" });
  await h.page.locator(".ctx:not(.closing) button", { hasText: "Move to Shelf" }).click();
  await until(h, "S2 on the Shelf", () => h.board().shelf?.length === 2);
  await h.page.locator(".dock .shelf-btn").click();
  const rows = h.page.locator(".cpanel.shelf .srow");
  const r0 = (await rows.nth(0).boundingBox())!; // newest first: Block manager
  await h.page.mouse.move(r0.x + 120, r0.y + r0.height / 2);
  const peek = h.page.locator(".shelf-peek");
  await peek.waitFor();
  await idle(h);
  const got = await h.page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".shelf-peek")!;
    const r = el.getBoundingClientRect(),
      panel = document.querySelector(".cpanel.shelf")!.getBoundingClientRect();
    return {
      sections: [...el.querySelectorAll(".spk-sec")].map((s) => s.textContent),
      cards: el.querySelectorAll(".spk-card").length,
      text: el.textContent ?? "",
      code: el.querySelectorAll(".spk-card.k-code .pcode").length,
      beside: r.right <= panel.left && r.left >= 0 && r.top >= 0 && r.bottom <= innerHeight,
    };
  });
  check(
    "shelf-preview-entry",
    got.sections.join() === "Block manager" &&
      got.cards === 2 &&
      got.text.includes("Blocks are hashed") &&
      got.text.includes("def allocate") &&
      got.code === 1,
    got,
  );
  check("shelf-preview-beside-panel", got.beside, got);
  await shot(h, "shelf-row-preview");
  const r1 = (await rows.nth(1).boundingBox())!;
  await h.page.mouse.move(r1.x + 120, r1.y + r1.height / 2, { steps: 3 });
  await until(h, "the next row's preview, at once", async () =>
    ((await peek.textContent()) ?? "").includes("CUDA graph capture"),
  );
  check("shelf-preview-one", (await peek.count()) === 1);
  await h.page.mouse.move(600, 600, { steps: 3 });
  await peek.waitFor({ state: "detached" });
  // a drag out of a row takes no preview with it
  await h.page.mouse.move(r1.x + 40, r1.y + r1.height / 2);
  await peek.waitFor();
  await h.page.mouse.down();
  await h.page.mouse.move(r1.x - 100, r1.y + 80, { steps: 4 });
  await h.page.locator(".shelf-outline").waitFor();
  check("shelf-preview-gone-on-drag", (await peek.count()) === 0);
  await h.page.mouse.up();
  await close(h);
});

test("shelfScreenshots", async () => {
  const { b, runner } = board({ runner: true });
  const h = await open({ board: b, light: true, w: 1440, h: 900, scale: 2, settings: { theme: "warm-ink" } });
  await idle(h);
  await h.page.locator(`.card[data-id="${runner}"] .chead`).click();
  await h.page.keyboard.press("Alt+KeyS");
  await until(h, "runner shelved", () => h.board().shelf?.length === 1);
  await h.page.locator('.card[data-id="n2"] .chead').click();
  await h.page.keyboard.press("Alt+KeyS");
  await until(h, "n2 shelved", () => h.board().shelf?.length === 2);
  await h.page.locator('.slabel[data-sect="S2"] .sname').click({ button: "right" });
  await h.page.locator(".ctx:not(.closing) button", { hasText: "Move to Shelf" }).hover();
  await shot(h, "shelf-impl-1-menu");
  await h.page.locator(".ctx:not(.closing) button", { hasText: "Move to Shelf" }).click();
  await until(h, "S2 shelved", () => h.board().shelf?.length === 3);
  await h.page.locator(".dock .shelf-btn").click();
  await h.page.mouse.move(900, 600);
  await shot(h, "shelf-impl-2-panel");
  const row = (await h.page.locator(".cpanel.shelf .srow").first().boundingBox())!;
  await h.page.mouse.move(row.x + 40, row.y + row.height / 2);
  await h.page.mouse.down();
  await h.page.mouse.move(row.x - 120, row.y + 100, { steps: 4 });
  await h.page.mouse.move(640, 150, { steps: 8 });
  await h.page.locator(".shelf-outline").waitFor();
  await shot(h, "shelf-impl-3-drag-out");
  await h.page.mouse.up();
  await until(h, "S2 back", () => h.board().shelf?.length === 2);
  await idle(h);
  await h.page.locator(".dock .shelf-btn").click(); // close the panel
  await h.page.locator('.card[data-id="n1"] .chead').click(); // only the Note selected: only it is dragged
  await idle(h);
  const head = (await h.page.locator('.card[data-id="n1"] .chead').boundingBox())!;
  const btn = (await h.page.locator(".dock .shelf-btn").boundingBox())!;
  // held near its right end, the Note hangs to the left of the dock button
  await h.page.mouse.move(head.x + head.width * 0.55, head.y + head.height / 2);
  await h.page.mouse.down();
  await h.page.mouse.move(head.x + head.width + 100, head.y + 100, { steps: 4 });
  await h.page.mouse.move(btn.x + btn.width / 2 - 6, btn.y + btn.height / 2 - 4, { steps: 12 });
  await h.page.locator(".dock .shelf-btn.hot").waitFor();
  await shot(h, "shelf-impl-4-drag-to-dock");
  await h.page.mouse.up();
  await until(h, "n1 shelved", () => h.board().shelf?.length === 3);
  await close(h);
});

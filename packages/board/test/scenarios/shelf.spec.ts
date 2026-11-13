// The Shelf: Move to Shelf with the key, the menu and a drag onto the dock's Shelf button or the open panel (flying into the
// entry's thumbnail), the panel's thumbnails (pictures, no words, in board order), the large picture with its one Put Back button,
// dragging a thumbnail out, the outline of where an entry returns to, the camera on Put Back, search taking an entry back out,
// undo, and the arrows that are hidden while their card is shelved
import { shot, symCard, findSym, put, type Host } from "../harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle, hostBoards } from "../fixtures";
import { watch } from "../watch";

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
  put(b, n1, 700, 600, 300);
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
  b.sections.push({ id: "S2", title: "Block manager", x: 670, y: 70, w: 500, h: 700 });
  b.place[c1.id].section = "S1";
  b.place[c2.id].section = "S2";
  b.place.n1.section = "S2";
  b.links.push({ id: "L1", from: { card: c1.id }, to: { card: c2.id } });
  b.links.push({ id: "L2", from: { card: c2.id }, to: { card: "n1" } });
  b.cam = { x: 0, y: 0, z: 1 };
  return { b, sched: c1.id, alloc: c2.id, runner };
}

/** Places compared whatever order their keys are in, without the heights the board measured (Place.mh, kept on shelving) */
const places = (p: Board["place"]) =>
  JSON.stringify(
    Object.entries(p)
      .map(([id, { mh: _, ...q }]) => [id, q])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
const arrowsDrawn = (h: Host) =>
  h.page.evaluate(() => [...document.querySelectorAll<SVGElement>("path.lhit[data-link]")].map((p) => p.dataset.link));
/** The camera as the board draws it (the world's transform) */
const camOf = (h: Host) =>
  h.page.evaluate(() => {
    const m = /translate\(([-\d.e+]+)px, ([-\d.e+]+)px\) scale\(([-\d.e+]+)\)/.exec(
      document.querySelector<HTMLElement>(".board > .world")!.style.transform,
    )!;
    return { x: +m[1], y: +m[2], z: +m[3] };
  });
/** Screen boxes of the elements a selector finds, rounded to tenths */
const boxes = (h: Host, sel: string) =>
  h.page.evaluate(
    (s) =>
      [...document.querySelectorAll(s)].map((e) => {
        const r = e.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10);
      }),
    sel,
  );
/** Screen boxes in world coordinates, with the camera the board draws now */
const inWorld = async (h: Host, l: number[][]) => {
  const c = await camOf(h);
  return l.map(([x, y, w, hh]) => [(x - c.x) / c.z, (y - c.y) / c.z, w / c.z, hh / c.z]);
};
const near = (a: number[][], b: number[][], d = 1) =>
  a.length === b.length && a.every((r, i) => r.every((v, j) => Math.abs(v - b[i][j]) <= d));
const thumbs = (h: Host) => h.page.locator(".cpanel.shelf .shthumb");
const select = async (h: Host, sel: string) => {
  await h.page.locator(sel).click();
  await h.page.keyboard.press("Alt+KeyS");
};

/**
 * A Section selected, ⌥S (its own menu has no Move to Shelf) takes it with its cards and arrows; its thumbnail is a picture of
 * it, no words; the large picture's one button puts it back where it was, its cards in front and selected; each is one undo step
 */
test("shelfMenuPutBack", async () => {
  const { b: b0, alloc } = board();
  const h = await open({ board: structuredClone(b0), light, w: 1440, h: 900 });
  await idle(h);
  // the Section's menu leaves it to ⌥S (and the selection's menu): right-click selects the Section, ⌥S shelves it
  await h.page.locator('.slabel[data-sect="S2"] .sname').click({ button: "right" });
  await h.page.locator(".ctx:not(.closing) button").first().waitFor();
  const item = h.page.locator(".ctx:not(.closing) button", { hasText: "Move to Shelf" });
  check("shelf-key-not-in-section-menu", (await item.count()) === 0, {
    items: await h.page.locator(".ctx:not(.closing) button").allTextContents(),
  });
  await h.page.keyboard.press("Escape");
  await h.page.keyboard.press("Alt+KeyS");
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
  await thumbs(h).first().waitFor();
  const pic = await thumbs(h)
    .first()
    .evaluate((t) => ({
      only: [...t.childNodes].every((n) => n instanceof HTMLElement && n.classList.contains("shmini")),
      cards: t.querySelectorAll(".shmini .card").length,
      frames: t.querySelectorAll(".shmini .sect").length,
      title: t.querySelector(".shmini .slabel .sname")?.textContent,
      code: t.querySelectorAll(".shmini .card.ccard .src .l").length,
      text: t.textContent ?? "",
    }));
  check(
    "shelf-thumbnail-is-a-picture",
    pic.only && pic.cards === 2 && pic.frames === 1 && pic.title === "Block manager" && pic.code > 10,
    pic,
  );
  check(
    "shelf-thumbnail-draws-content",
    pic.text.includes("Blocks are hashed") && pic.text.includes("def allocate"),
    pic,
  );
  await thumbs(h).first().click();
  const peek = h.page.locator(".shelf-peek");
  await peek.waitFor();
  const btns = await peek
    .locator("button")
    .evaluateAll((l) =>
      l.map((x) => ({ label: x.getAttribute("aria-label"), text: x.textContent, icon: !!x.querySelector("svg") })),
    );
  check(
    "shelf-peek-one-icon-button",
    btns.length === 1 && btns[0].label === "Put Back" && !btns[0].text && btns[0].icon,
    btns,
  );
  await peek.locator("button").click();
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
  const order = back.cards.map((c) => c.id);
  check("shelf-put-back-in-front", order.slice(-2).sort().join() === [alloc, "n1"].sort().join(), order);
  check(
    "shelf-put-back-selected",
    (await h.page.locator('.sect[data-sect="S2"].sel, .slabel[data-sect="S2"].sel').count()) > 0,
  );
  check("shelf-put-back-arrows-drawn", (await arrowsDrawn(h)).sort().join() === "L1,L2", await arrowsDrawn(h));
  check("shelf-panel-empty", (await h.page.locator(".cpanel.shelf .empty").count()) === 1);
  check("shelf-peek-gone", (await peek.count()) === 0);
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

/**
 * A thumbnail dragged out of the panel: a dashed outline follows the pointer, held where the picture was grabbed; the entry lands
 * under it and the camera does not move
 */
test("shelfDragThumbOut", async () => {
  const { b } = board();
  const h = await open({ board: b, light, w: 1440, h: 900 });
  await idle(h);
  await select(h, '.card[data-id="n2"] .chead');
  await until(h, "n2 on the Shelf", () => h.board().shelf?.length === 1 && !h.board().place.n2);
  await h.page.locator(".dock .shelf-btn").click();
  await thumbs(h).first().waitFor();
  await idle(h);
  const mini = (await thumbs(h).first().locator(".shmini").boundingBox())!;
  const w = h.board().shelf![0].place.n2.w;
  const k = mini.width / w;
  const press = { x: mini.x + mini.width * 0.4, y: mini.y + mini.height * 0.3 };
  const cam0 = await camOf(h);
  await h.page.mouse.move(press.x, press.y);
  await h.page.mouse.down();
  await h.page.mouse.move(press.x - 100, press.y + 80, { steps: 4 });
  await h.page.mouse.move(760, 740, { steps: 8 });
  await h.page.locator(".shelf-outline:not(.home)").waitFor();
  const lifted = await h.page.locator(".cpanel.shelf .shthumb.lift").count();
  check("shelf-drag-outline", lifted === 1, { lifted });
  await h.page.mouse.up();
  await until(h, "n2 placed", () => !h.board().shelf && h.board().place.n2);
  const p = h.board().place.n2;
  const off = await h.page.evaluate(() => {
    const r = document.getElementById("board")!.getBoundingClientRect();
    return { x: r.left, y: r.top };
  });
  const want = { x: 760 - off.x - (press.x - mini.x) / k, y: 740 - off.y - (press.y - mini.y) / k };
  check("shelf-drop-under-pointer", Math.abs(p.x - want.x) <= 2 && Math.abs(p.y - want.y) <= 2, { p, want });
  check("shelf-outline-gone", (await h.page.locator(".shelf-outline").count()) === 0);
  await idle(h);
  check("shelf-dropped-drawn", (await h.page.locator('.card[data-id="n2"]').count()) === 1);
  const cam1 = await camOf(h);
  check("shelf-drop-camera-stays", JSON.stringify(cam0) === JSON.stringify(cam1), { cam0, cam1 });
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
  const kept = h.board().shelf![0].place.n2;
  check("shelf-dock-kept-place", kept.x === at.x && kept.y === at.y && kept.w === at.w, { at, kept });
  await h.page.keyboard.press("ControlOrMeta+z");
  await until(h, "undo: n2 back", () => !h.board().shelf && h.board().place.n2);
  check(
    "shelf-dock-undo-where-it-was",
    h.board().place.n2.x === at.x && h.board().place.n2.y === at.y,
    h.board().place.n2,
  );
  await close(h);
});

/**
 * With the panel open, what goes onto the Shelf (⌥S, a drag let go over the panel) flies into its thumbnail over the panel,
 * watched frame by frame in Warm Ink and Ink Wash: nothing else on the board moves, nothing flashes; the copies cross-fade into
 * the thumbnail by design. The thumbnails are in board order, not the order they were shelved in
 */
test("shelfFlyIn", async () => {
  for (const theme of ["warm-ink", "ink-wash"]) {
    const { b, sched, alloc } = board();
    const h = await open({ board: b, light, w: 1440, h: 900, settings: { theme } as never });
    await idle(h);
    await h.page.locator(".dock .shelf-btn").click();
    await h.page.locator(".cpanel.shelf .empty").waitFor();
    await h.page.locator('.card[data-id="n2"] .chead').click();
    await idle(h);
    const still = [`card:${sched}`, `card:${alloc}`, "card:n1", "sect:S1", "sect:S2", "link:L1", "link:L2"];
    const watched = {
      moves: [new RegExp(`^(?!(${still.join("|")})$)`)],
      ignore: [".shelf-ghost", ".shelf-fly"],
      frames: 32,
    };
    let lifted: unknown;
    await watch(h, `shelfFlyIn ${theme} key`, watched, async () => {
      await h.page.keyboard.press("Alt+KeyS");
      // the copies fly on a layer over the panel, into the new thumbnail
      lifted = await h.page.evaluate(() => {
        const fly = document.querySelector<HTMLElement>(".shelf-fly");
        const z = (s: string) => +getComputedStyle(document.querySelector(s)!).zIndex;
        return {
          copies: fly?.querySelectorAll(".shelf-ghost").length ?? 0,
          over: !!fly && z(".shelf-fly") > z(".cpanel.shelf"),
          thumbs: document.querySelectorAll(".cpanel.shelf .shthumb").length,
        };
      });
    });
    check(
      `shelfFlyIn ${theme} over the panel`,
      JSON.stringify(lifted) === '{"copies":1,"over":true,"thumbs":1}',
      lifted,
    );
    await until(h, "n2 on the Shelf", () => h.board().shelf?.length === 1);
    await idle(h);
    check(`shelfFlyIn ${theme} copies gone`, (await h.page.locator(".shelf-ghost, .shelf-fly").count()) === 0);
    check(`shelfFlyIn ${theme} thumbnail shown`, (await thumbs(h).count()) === 1);
    // the Note n1 dragged out of its Section and let go over the panel
    const head = (await h.page.locator('.card[data-id="n1"] .chead').boundingBox())!;
    const panel = (await h.page.locator(".cpanel.shelf").boundingBox())!;
    await h.page.mouse.move(head.x + 40, head.y + head.height / 2);
    await h.page.mouse.down();
    await h.page.mouse.move(head.x + 120, head.y + 40, { steps: 4 });
    await h.page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 2, { steps: 10 });
    await h.page.locator(".cpanel.shelf.hot").waitFor();
    await idle(h);
    const still2 = still.filter((k) => k !== "card:n1" && k !== "link:L2");
    await watch(h, `shelfFlyIn ${theme} drop`, { ...watched, moves: [new RegExp(`^(?!(${still2.join("|")})$)`)] }, () =>
      h.page.mouse.up(),
    );
    await until(h, "n1 on the Shelf", () => h.board().shelf?.length === 2 && !h.board().place.n1);
    await idle(h);
    // n2 (top right) was shelved first, n1 (below it) last: the panel shows them as the board read them, n2 first
    const shown = await thumbs(h).evaluateAll((l) => l.map((t) => (t as HTMLElement).dataset.entry));
    const ids = h.board().shelf!.map((e) => Object.keys(e.place)[0]);
    const byEntry = Object.fromEntries(h.board().shelf!.map((e) => [e.id, Object.keys(e.place)[0]]));
    check(`shelfFlyIn ${theme} board order`, shown.map((id) => byEntry[id!]).join() === "n2,n1", { shown, ids });
    check(
      `shelfFlyIn ${theme} kept where it was`,
      h.board().shelf![1].place.n1.x === 700 && h.board().shelf![1].place.n1.y === 600,
      h.board().shelf![1].place.n1,
    );
    await close(h);
  }
});

/** A shelved card's arrows are hidden; one whose other card is deleted meanwhile does not come back; the rest come back */
test("shelfArrows", async () => {
  const { b, alloc } = board();
  const h = await open({ board: b, light, w: 1440, h: 900 });
  await idle(h);
  await select(h, `.card[data-id="${alloc}"] .chead`);
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
  // the thumbnail's menu puts it back too
  await thumbs(h).first().click({ button: "right" });
  await h.page.locator(".ctx:not(.closing) button", { hasText: "Put Back" }).click();
  await until(h, "put back", () => !h.board().shelf);
  await idle(h);
  check("shelf-arrows-back", (await arrowsDrawn(h)).join() === "L1", await arrowsDrawn(h));
  await close(h);
});

/**
 * A thumbnail clicked shows its entry large left of the panel, level with the thumbnail, over neither the panel nor the toolbars
 * (watched: nothing on the board moves or flashes); the same thumbnail, Esc or a click elsewhere closes it, the panel stays. In a
 * narrow window it is under the panel
 */
test("shelfPeek", async () => {
  const { b } = board();
  const h = await open({ board: b, light, w: 1440, h: 900 });
  await idle(h);
  await select(h, '.slabel[data-sect="S2"] .sname');
  await until(h, "S2 on the Shelf", () => h.board().shelf?.length === 1);
  await select(h, '.card[data-id="n2"] .chead');
  await until(h, "n2 on the Shelf", () => h.board().shelf?.length === 2);
  await h.page.locator(".dock .shelf-btn").click();
  await thumbs(h).nth(1).waitFor();
  await idle(h);
  const t0 = thumbs(h).nth(0),
    t1 = thumbs(h).nth(1);
  const peek = h.page.locator(".shelf-peek");
  await watch(h, "shelfPeek open", { frames: 12 }, () => t0.click());
  await peek.waitFor();
  await idle(h);
  const where = () =>
    h.page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const p = r(".shelf-peek"),
        panel = r(".cpanel.shelf"),
        on = r(".shthumb.on");
      const bars = [...document.querySelectorAll(".over.bbar > .pill, .over.dock > .pill")].map((e) =>
        e.getBoundingClientRect(),
      );
      const hits = (q: DOMRect) => p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom;
      return {
        left: p.right <= panel.left,
        under: p.top >= panel.bottom,
        level: Math.abs(p.top - on.top) <= 1,
        clear: !hits(panel) && !bars.some(hits) && p.left >= 0 && p.top >= 0 && p.bottom <= innerHeight,
        text: document.querySelector(".shelf-peek")!.textContent ?? "",
      };
    });
  const w0 = await where();
  check("shelf-peek-beside-panel", w0.left && w0.level && w0.clear, w0);
  check("shelf-peek-entry", w0.text.includes("Block manager") && w0.text.includes("Blocks are hashed"), w0);
  await t0.click();
  await peek.waitFor({ state: "detached" });
  await t0.click();
  await peek.waitFor();
  await h.page.keyboard.press("Escape");
  await peek.waitFor({ state: "detached" });
  await t1.click();
  await until(h, "the other entry, large", async () =>
    ((await peek.textContent()) ?? "").includes("CUDA graph capture"),
  );
  check("shelf-peek-one", (await peek.count()) === 1);
  await h.page.mouse.click(400, 820);
  await peek.waitFor({ state: "detached" });
  check("shelf-peek-panel-stays", (await h.page.locator(".cpanel.shelf").count()) === 1);
  // a narrow window: under the panel
  await h.page.setViewportSize({ width: 520, height: 900 });
  await idle(h);
  await t0.click();
  await peek.waitFor();
  await idle(h);
  const w1 = await where();
  check("shelf-peek-under-panel-when-narrow", w1.under && w1.clear, w1);
  await close(h);
});

/**
 * Resting on a thumbnail outlines on the board where its entry returns to, exactly where it lands, also on a board opened again
 * (the heights kept with the entry); none while that place is out of view
 */
test("shelfHoverOutline", async () => {
  const { b } = board();
  const h = await open({ board: b, light, w: 1440, h: 900 });
  await idle(h);
  await select(h, '.slabel[data-sect="S2"] .sname');
  await until(h, "S2 on the Shelf", () => h.board().shelf?.length === 1);
  await h.page.locator(".dock .shelf-btn").click();
  await thumbs(h).first().hover();
  await h.page.locator(".shelf-outline.home").waitFor();
  await idle(h);
  const cards = await inWorld(h, await boxes(h, ".shelf-outline.home .soc")),
    frames = await inWorld(h, await boxes(h, ".shelf-outline.home .sos"));
  // the same board opened again: the outline from what the entry kept
  const again = await open({ board: h.board(), light, w: 1440, h: 900 });
  await idle(again);
  await again.page.locator(".dock .shelf-btn").click();
  await thumbs(again).first().hover();
  await again.page.locator(".shelf-outline.home").waitFor();
  await idle(again);
  const cards2 = await inWorld(again, await boxes(again, ".shelf-outline.home .soc"));
  await close(again);
  await h.page.locator(".shelf-outline.home").waitFor();
  await thumbs(h).first().click();
  await h.page.locator(".shelf-peek button").click();
  await until(h, "put back", () => !h.board().shelf);
  await idle(h);
  const ids = Object.keys(b.place).filter((id) => b.place[id].section === "S2");
  const real = await inWorld(h, await boxes(h, ids.map((id) => `.world .card[data-id="${id}"]`).join(", "))),
    realFrame = await inWorld(h, await boxes(h, '.world .sect[data-sect="S2"]'));
  const sorted = (l: number[][]) => [...l].sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  check("shelf-outline-where-it-lands", near(sorted(cards), sorted(real)) && near(frames, realFrame), {
    cards,
    real,
    frames,
    realFrame,
  });
  check("shelf-outline-after-reopen", near(sorted(cards2), sorted(real)), { cards2, real });
  // shelved again (it came back selected) and the board panned away: no outline
  await h.page.keyboard.press("Alt+KeyS");
  await until(h, "S2 on the Shelf again", () => h.board().shelf?.length === 1);
  await h.page.mouse.move(1000, 760);
  for (let i = 0; i < 6; i++) await h.page.mouse.wheel(0, 400);
  await idle(h);
  const cam = await camOf(h);
  await thumbs(h).first().hover();
  await idle(h);
  check("shelf-outline-not-when-out-of-view", (await h.page.locator(".shelf-outline").count()) === 0, cam);
  await close(h);
});

/**
 * Put Back and the camera: where the entry returns to wholly in the part of the board that is seen (left of the panel, above the
 * toolbars), the camera stays (watched: the entry flies out of its picture, nothing else moves, nothing flashes); out of view, the
 * camera pans by the least that brings it in, 24 px from the edge, at the same zoom; larger than that part, its top at 24 px
 */
test("shelfPutBackCamera", async () => {
  const { b, sched } = board();
  b.sections[1] = { ...b.sections[1], x: 600 }; // Block manager wholly left of the panel
  for (const id of Object.keys(b.place)) if (b.place[id].section === "S2") b.place[id].x -= 70;
  const h = await open({ board: structuredClone(b), light, w: 1440, h: 900 });
  await idle(h);
  await select(h, '.slabel[data-sect="S2"] .sname');
  await until(h, "S2 on the Shelf", () => h.board().shelf?.length === 1);
  await h.page.locator(".dock .shelf-btn").click();
  await thumbs(h).first().click();
  await h.page.locator(".shelf-peek").waitFor();
  await idle(h);
  const cam0 = await camOf(h);
  await watch(
    h,
    "shelfPutBackCamera in view",
    { moves: [new RegExp(`^(?!card:${sched}$|sect:S1$)`)], frames: 32 },
    () => h.page.locator(".shelf-peek button").click(),
  );
  await until(h, "put back", () => !h.board().shelf);
  await idle(h);
  const cam1 = await camOf(h);
  check("shelf-camera-stays-when-in-view", JSON.stringify(cam0) === JSON.stringify(cam1), { cam0, cam1 });
  // shelved again (it came back selected), panned so that it is off to the left: back, it comes in 24 px from the left edge
  await h.page.keyboard.press("Alt+KeyS");
  await until(h, "S2 on the Shelf again", () => h.board().shelf?.length === 1);
  await h.page.mouse.move(1000, 760);
  for (let i = 0; i < 4; i++) await h.page.mouse.wheel(400, 0);
  await idle(h);
  const cam2 = await camOf(h);
  await thumbs(h).first().click({ button: "right" });
  await h.page.locator(".ctx:not(.closing) button", { hasText: "Put Back" }).click();
  await until(h, "put back again", () => !h.board().shelf);
  await idle(h);
  const cam3 = await camOf(h);
  const frame = (await boxes(h, '.world .sect[data-sect="S2"]'))[0];
  check(
    "shelf-camera-pans-just-enough",
    cam2.x < -600 && cam3.z === cam2.z && cam3.y === cam2.y && Math.abs(frame[0] - 24) <= 1,
    { cam2, cam3, frame },
  );
  await close(h);
  // zoomed in, Block manager is taller than what is seen: its top at 24 px, its left where it was (it fits across)
  const z = { ...b, cam: { x: -1100, y: -100, z: 2 } };
  const h2 = await open({ board: z, light, w: 1440, h: 900 });
  await idle(h2);
  await select(h2, '.slabel[data-sect="S2"] .sname');
  await until(h2, "S2 on the Shelf", () => h2.board().shelf?.length === 1);
  await h2.page.mouse.move(400, 500);
  for (let i = 0; i < 4; i++) await h2.page.mouse.wheel(0, -400);
  await idle(h2);
  await h2.page.locator(".dock .shelf-btn").click();
  await thumbs(h2).first().click({ button: "right" });
  await h2.page.locator(".ctx:not(.closing) button", { hasText: "Put Back" }).click();
  await until(h2, "put back", () => !h2.board().shelf);
  await idle(h2);
  const cam4 = await camOf(h2);
  const big = (await boxes(h2, '.world .sect[data-sect="S2"]'))[0];
  check("shelf-camera-larger-top-at-margin", cam4.z === 2 && Math.abs(big[1] - 24) <= 1, { cam4, big });
  await close(h2);
});

/** Search finds a card in a shelved Section from its board; picking it brings the whole Section back, with the card selected */
test("shelfSearchSection", async () => {
  const b = emptyBoard("b1", "shelf search");
  const notes: [string, string, number, number][] = [
    ["a", "# Prefix cache\n\nBlocks are hashed by their token ids.", 100, 120],
    ["b", "# Eviction\n\nThe least recently used block goes first.", 100, 360],
    ["c", "# Elsewhere\n\nNot in the Section.", 600, 120],
  ];
  for (const [id, md, x, y] of notes) put(b, { id, kind: "note", look: "note", md } as NoteCard, x, y, 300);
  b.sections.push({ id: "S", title: "Block manager", x: 60, y: 70, w: 380, h: 520 });
  b.place.a.section = "S";
  b.place.b.section = "S";
  b.cam = { x: 0, y: 0, z: 1 };
  const run = await hostBoards([b], { page: { light, w: 1300, h: 820 } });
  const h = await run.open(b.id);
  await idle(h);
  await select(h, '.slabel[data-sect="S"] .sname');
  await until(h, "S on the Shelf", () => h.board().shelf?.length === 1);
  await h.page.keyboard.press("ControlOrMeta+k");
  await h.page.locator(".palette input:focus").waitFor();
  await h.page.keyboard.type("least recently");
  const hit = h.page.locator(".palette .cand", { hasText: "Eviction" });
  await hit.waitFor();
  check("shelf-search-finds-shelved", (await hit.locator(".kind svg").count()) === 1);
  await hit.click();
  await until(h, "the Section back", () => !h.board().shelf && !!h.board().place.a && !!h.board().place.b);
  await idle(h);
  check(
    "shelf-search-whole-section",
    h.board().sections.some((s) => s.id === "S") && h.board().place.b.section === "S",
  );
  check("shelf-search-card-selected", (await h.page.locator('.world .card[data-id="b"].sel').count()) === 1);
  await run.close();
});

/** Screenshots at 2× for review, Warm Ink light and Ink Wash dark: the panel with a Section and cards, a thumbnail's outline on
 *  the board, the large picture with its Put Back button */
test("shelfScreenshots", async () => {
  for (const [theme, lit] of [
    ["warm-ink", true],
    ["ink-wash", false],
  ] as const) {
    const { b, runner } = board({ runner: true });
    const h = await open({ board: b, light: lit, w: 1440, h: 900, scale: 2, settings: { theme } as never });
    await idle(h);
    await select(h, `.card[data-id="${runner}"] .chead`);
    await until(h, "runner shelved", () => h.board().shelf?.length === 1);
    await select(h, '.card[data-id="n2"] .chead');
    await until(h, "n2 shelved", () => h.board().shelf?.length === 2);
    await select(h, '.slabel[data-sect="S2"] .sname');
    await until(h, "S2 shelved", () => h.board().shelf?.length === 3);
    await h.page.locator(".dock .shelf-btn").click();
    await h.page.mouse.move(600, 820);
    await shot(h, `shelf-${theme}-1-panel`);
    await thumbs(h).first().hover();
    await h.page.locator(".shelf-outline.home").waitFor();
    await shot(h, `shelf-${theme}-2-outline`);
    await thumbs(h).first().click();
    await h.page.locator(".shelf-peek").waitFor();
    await h.page.locator(".shelf-peek button").hover();
    await shot(h, `shelf-${theme}-3-peek`);
    await close(h);
  }
});

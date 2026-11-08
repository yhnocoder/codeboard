//  summaryTitleZoomsToItem — Fit to Window on a board of a dozen code cards lands below the summary cut (the cards are hidden,
//                            so they cannot be double-clicked): double-clicking a loose card's summary title
//                            flies to that card at 100 % with the card level back and its calls clickable, nothing new on the
//                            board; double-clicking a Section's title fits the Section's frame, an outer Section's own
//                            column (own:, the cards placed directly in it beside a child Section) fits those cards
//  zoomedOutSimplifiesCards — zoomed out below Simplify Below (codeboard.zoom.simplifyBelow, 0.5) and above the summary cut,
//                            stopped: a Note's prose is drawn as bars (its text transparent, the underline bar shown), the
//                            bodies of Notes and code cards take no pointer (no line or block ports, no hover on lines and
//                            calls), the card edges' ports stay; at 100 % none of it; with the setting at 0 none of it either
//  summaryImageCopy        — an Image card's picture at the summary level is the smaller copy the card itself would show
//                            (md.showImage, picked by the size the summary shows it at times the display scale), not the
//                            full-size original: a 3200 × 1600 PNG shown 480 px wide at 20 % decodes a copy at least that
//                            wide, and the end-of-scenario image budget (fixtures.ts budgets) holds
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type Board, type NoteCard, type Section } from "@codeboard/core";
import { png } from "@codeboard/host/testing";
import { put, symCard, findSym, type Host } from "../harness";
import { test, open, check, idle, until, hostBoards } from "../fixtures";
import { watch } from "../watch";

const nv = (qual: string) => {
  const s = findSym(qual);
  return symCard(s.f, s.s);
};
const zoomOf = (h: Host) =>
  h.page.evaluate(() => {
    const m = /scale\(([\d.e-]+)\)/.exec((document.querySelector(".world") as HTMLElement).style.transform);
    return m ? +m[1] : NaN;
  });

test("summaryTitleZoomsToItem", async () => {
  const b = emptyBoard("bSumZoom", "summary zoom");
  const quals = [
    "LLMEngine.step",
    "Scheduler.schedule",
    "ModelRunner.run",
    "BlockManager.allocate",
    "Sampler.forward",
    "LLMEngine.add_request",
  ];
  const cards = quals.map(nv);
  cards.forEach((c, i) => put(b, c, 80 + i * 640, 80, 560));
  const sec: Section = { id: "s1", title: "Runner", x: 40, y: 1500, w: 1300, h: 900 };
  b.sections.push(sec);
  const inner = [nv("ModelRunner.prepare_prefill"), nv("ModelRunner.prepare_decode")];
  inner.forEach((c, i) => {
    put(b, c, 80 + i * 640, 1600, 560);
    b.place[c.id].section = sec.id;
  });
  // an outer Section with a child Section and a card of its own: that card is the outer Section's own column (own:)
  const outer: Section = { id: "s2", title: "Engine", x: 1500, y: 1500, w: 2700, h: 1000 };
  const child: Section = { id: "s3", title: "Blocks", x: 2200, y: 1560, w: 1300, h: 800, parent: outer.id };
  b.sections.push(outer, child);
  const direct = nv("BlockManager.deallocate"),
    nested = nv("BlockManager.may_append");
  put(b, direct, 1560, 1600, 560);
  b.place[direct.id].section = outer.id;
  put(b, nested, 2260, 1640, 560);
  b.place[nested.id].section = child.id;
  const h = await open({ board: b, w: 1280, h: 800, light: true });
  await h.page.keyboard.press("Shift+Digit1");
  await until(h, "the summary level shows after Fit to Window", () => h.page.locator(".cardlay.gone").count());
  const target = cards[1];
  const title = h.page.locator(`.sumcol[data-sum="card:${target.id}"] .sumhd code`);
  check(
    "summaryTitleZoomsToItem Fit to Window lands at the summary level, the card's title showing",
    (await zoomOf(h)) < 0.3 && (await title.isVisible()),
    await zoomOf(h),
  );
  const nCards = h.board().cards.length;
  await title.dblclick();
  await until(h, "the camera reaches 100 %", async () => (await zoomOf(h)) === 1);
  await until(h, "the card level is back", async () =>
    h.page
      .locator(".cardlay")
      .evaluate((e) => !e.classList.contains("gone") && (e as HTMLElement).style.opacity === "1"),
  );
  await idle(h);
  const card = h.page.locator(`.card[data-id="${target.id}"]`);
  const box = await card.boundingBox();
  check(
    "summaryTitleZoomsToItem double-clicking a card's summary title flies to the card at 100 %, in view",
    !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y < 200,
    box,
  );
  check(
    "summaryTitleZoomsToItem the card's calls are visible and clickable again",
    await card.locator(".src .call").first().isVisible(),
  );
  check("summaryTitleZoomsToItem the double-click adds nothing to the board", h.board().cards.length === nCards);
  // back out, then a Section's title fits its frame
  await h.page.keyboard.press("Shift+Digit1");
  await until(h, "the summary level shows again", () => h.page.locator(".cardlay.gone").count());
  await h.page.locator(`.sumcol[data-sum="sec:${sec.id}"] .sumhd .sumt`).dblclick();
  await until(h, "the card level is back after the Section zoom", () =>
    h.page
      .locator(".cardlay")
      .evaluate((e) => !e.classList.contains("gone") && (e as HTMLElement).style.opacity === "1"),
  );
  await idle(h);
  const fr = await h.page.locator(`.sframe[data-sect="${sec.id}"], [data-sect="${sec.id}"]`).first().boundingBox();
  const z = await zoomOf(h);
  check(
    "summaryTitleZoomsToItem double-clicking a Section's summary title fits its frame",
    !!fr && z > 0.6 && z <= 1 && fr.x >= 0 && fr.x + fr.width <= 1280 + 1,
    { z, fr },
  );
  // an outer Section's own column fits its direct cards
  await h.page.keyboard.press("Shift+Digit1");
  await until(h, "the summary level shows a third time", () => h.page.locator(".cardlay.gone").count());
  const ownCol = h.page.locator(`.sumcol[data-sum="own:${outer.id}"]`);
  await ownCol.locator(".sumhd").dblclick({ position: { x: 4, y: 4 } });
  await until(h, "the card level is back after the own-cards zoom", () =>
    h.page
      .locator(".cardlay")
      .evaluate((e) => !e.classList.contains("gone") && (e as HTMLElement).style.opacity === "1"),
  );
  await idle(h);
  const db = await h.page.locator(`.card[data-id="${direct.id}"]`).boundingBox();
  check(
    "summaryTitleZoomsToItem double-clicking an outer Section's own column fits its direct cards",
    !!db && db.x >= 0 && db.y >= 0 && db.x + db.width <= 1281 && db.y + db.height <= 801 && (await zoomOf(h)) > 0.6,
    { db, z: await zoomOf(h) },
  );
  check("summaryTitleZoomsToItem nothing new on the board", h.board().cards.length === nCards);
  await h.page.context().close();
});

test("summaryImageCopy", async () => {
  const b = emptyBoard("bSumImg", "summary image");
  b.cards.push({ id: "big", kind: "image", src: "big.png" } as Board["cards"][number]);
  b.place.big = { x: 80, y: 80, w: 2400 };
  // code cards beside it: a board wide enough to be seen at 20 %, below the summary cut. Opened there, so that the card's own
  // picture is a copy too (a picture never steps down while it stays on the page: picture.ts)
  ["LLMEngine.step", "Scheduler.schedule", "ModelRunner.run", "BlockManager.allocate", "Sampler.forward"].forEach(
    (q, i) => put(b, nv(q), 2600 + i * 640, 80, 560),
  );
  b.cam = { x: 0, y: 0, z: 0.2 };
  const run = await hostBoards([b], { page: { light: true, w: 1100, h: 760 } });
  const assets = run.host.store.assetsDir();
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(
    path.join(assets, "big.png"),
    png(3200, 1600, (x, y) => (x % 50 === 0 || y % 50 === 0 ? [40, 40, 48, 255] : [248, 247, 242, 255])),
  );
  const h = await run.open(b.id);
  await until(h, "the summary level shows", () => h.page.locator(".sumlay.live").count());
  await idle(h);
  const z = await zoomOf(h);
  // the original may show for a moment, until the host has made the copy (picture.ts): the copy then replaces it (beside other
  // scenarios the host takes a while to make it)
  const seen = await until(
    h,
    "the summary's picture shows a copy",
    () =>
      h.page.evaluate(() => {
        const i = document.querySelector<HTMLImageElement>(".sumlay .sumimg");
        if (!i?.complete || !i.naturalWidth || i.naturalWidth === 3200) return null;
        const r = i.getBoundingClientRect();
        return { src: i.getAttribute("src") ?? "", natural: i.naturalWidth, w: r.width, h: r.height };
      }),
    20_000,
  );
  check("summaryImageCopy the summary shows a smaller copy, not the original", /\/thumbs\//.test(seen.src), {
    ...seen,
    z,
  });
  check("summaryImageCopy the picture is shown at the card's size", Math.abs(seen.w - 2400 * z) < 2, { ...seen, z });
  // picked by the size it is seen at (its board size times the zoom), not by the box it is laid out in inside the summary layer
  // (1 / K of that): the copy is at least as wide as it shows (1x screen)
  check("summaryImageCopy the copy is sharp at the size shown", seen.natural >= seen.w, { ...seen, z });
  await idle(h);
});

/**
 * Across the summary cut and back, watched frame by frame (watch.ts): Fit to Window from 100 % flies below the cut (the mist
 * covers the switch to the summary level), double-clicking a card's summary title flies back to it at 100 %. Nothing flashes
 * (shown, gone and back within a few frames), no card's place or size in the world changes while the camera moves, and no
 * title shows twice over itself
 */
test("summaryCutWatched", async () => {
  const b = emptyBoard("bSumCut", "summary cut");
  const cards = [
    "LLMEngine.step",
    "Scheduler.schedule",
    "ModelRunner.run",
    "BlockManager.allocate",
    "Sampler.forward",
    "LLMEngine.add_request",
  ].map(nv);
  cards.forEach((c, i) => put(b, c, 80 + i * 1000, 80, 560));
  const h = await open({ board: b, w: 1280, h: 800, light: true });
  await idle(h);
  await watch(h, "summaryCutWatched fit", { moves: [/^link:/], frames: 45 }, () =>
    h.page.keyboard.press("Shift+Digit1"),
  );
  await until(h, "the summary level shows after Fit to Window", () => h.page.locator(".cardlay.gone").count());
  await idle(h);
  const title = h.page.locator(`.sumcol[data-sum="card:${cards[1].id}"] .sumhd code`);
  await watch(h, "summaryCutWatched back", { moves: [/^link:/], frames: 45 }, () => title.dblclick());
  await until(h, "the camera reaches 100 %", async () => (await zoomOf(h)) === 1);
  await idle(h);
});

test("zoomedOutSimplifiesCards", async () => {
  const mk = () => {
    const b = emptyBoard("bSimple", "simplify");
    put(
      b,
      {
        id: "n1",
        kind: "note",
        md: "# Grids\n\n每个 block 有 256 个 thread，grid 按块排列。",
        look: "note",
      } as NoteCard,
      80,
      80,
      460,
    );
    put(b, nv("LLMEngine.step"), 640, 80, 560);
    // far away, so the board's minimum zoom (fit-all ÷ 1.3) lies below the summary cut
    put(b, { id: "n2", kind: "note", md: "far", look: "note" } as NoteCard, 7000, 5000, 300);
    return b;
  };
  const look = (h: Host) =>
    h.page.evaluate(() => {
      const p = document.querySelector<HTMLElement>('.card[data-id="n1"] .nbody p')!;
      const cs = getComputedStyle(p);
      const code = document.querySelector<HTMLElement>(".card.ccard .cbody")!;
      return {
        greek: !!document.querySelector(".world.greek"),
        color: cs.color,
        bar: cs.textDecorationLine,
        noteBody: getComputedStyle(p.closest(".nbody")!).pointerEvents,
        codeBody: getComputedStyle(code).pointerEvents,
        eport: getComputedStyle(document.querySelector(".card.ccard .eport")!).pointerEvents,
      };
    });
  const outTo = async (h: Host, z: number) => {
    await h.page.mouse.move(640, 400);
    for (let i = 0; i < 40 && (await zoomOf(h)) > z; i++) {
      await h.page.keyboard.down("Control");
      await h.page.mouse.wheel(0, 20);
      await h.page.keyboard.up("Control");
      await idle(h);
    }
  };
  const h = await open({ board: mk(), w: 1280, h: 800, light: true });
  const at100 = await look(h);
  check(
    "at 100 % the cards are drawn whole",
    !at100.greek && at100.color !== "rgba(0, 0, 0, 0)" && at100.codeBody !== "none",
    at100,
  );
  await outTo(h, 0.45);
  const z = await zoomOf(h);
  check("stopped between the summary cut and 50 %", z < 0.5 && !(await h.page.locator(".cardlay.gone").count()), z);
  const out = await look(h);
  check(
    "a Note's prose is drawn as bars",
    out.greek && out.color === "rgba(0, 0, 0, 0)" && out.bar === "underline",
    out,
  );
  check("card bodies take no pointer", out.noteBody === "none" && out.codeBody === "none", out);
  check("the card edges' ports stay", out.eport !== "none", out);
  await h.page.close();
  const off = await open({ board: mk(), w: 1280, h: 800, light: true, settings: { simpleBelow: 0 } });
  await outTo(off, 0.45);
  const never = await look(off);
  check(
    "Simplify Below 0 leaves the cards whole",
    !never.greek && never.color !== "rgba(0, 0, 0, 0)" && never.codeBody !== "none",
    never,
  );
});

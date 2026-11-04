//  summaryTitleZoomsToItem — Fit to Window on a board of a dozen code cards lands below the summary cut (the cards are hidden,
//                            so they cannot be double-clicked as in the overview): double-clicking a loose card's summary title
//                            flies to that card at 100 % with the card level back and its calls clickable, nothing new on the
//                            board; double-clicking a Section's title fits the Section's frame
import { emptyBoard, type Section } from "@codeboard/core";
import { put, symCard, findSym, type Host } from "../harness";
import { test, open, check, idle, until } from "../fixtures";

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
  const h = await open({ board: b, w: 1280, h: 800, light: true });
  await h.page.keyboard.press("Shift+Digit1");
  await until(h, "the summary level shows after Fit to Window", () => h.page.locator(".cardlay.gone").count());
  const target = cards[1];
  const title = h.page.locator(`.sumcol[data-sum="card:${target.id}"] .sumhd`);
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
  await h.page.locator(`.sumcol[data-sum="sec:${sec.id}"] .sumhd`).dblclick();
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
  check("summaryTitleZoomsToItem nothing new on the board", h.board().cards.length === nCards);
  await h.page.context().close();
});

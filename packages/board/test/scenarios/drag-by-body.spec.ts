// Pressing on a card's body (Note text, code lines) and dragging: a card that is not selected, or a multi-selection
// grabbed by any of its cards, moves like when grabbed by the header, with no text selected; the only selected card keeps
// native text selection in its body. A plain click still selects (a multi-selection becomes the clicked card), a double
// click on a Note still edits it. Grabbing an unselected card while others are selected selects and moves just that card.
// A click on a card's header selects it without lifting it (no .lift, no scale, no lift shadow); only a real drag lifts it,
// and it settles back (.landing) after it is put down. Lifted, it is a compositor layer of its own (will-change), raster again
// after a zoom in the middle of the drag.
// Usage: npm run harness -- dragUnselectedCardByBody dragMultiSelectionByBody singleSelectedBodySelectsText clickSelectsWithoutLift
import { emptyBoard, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { put, findSym, symCard, shot, type Host } from "../harness";
import { test, open, check, light, until, idle, frames } from "../fixtures";
import { watch } from "../watch";

const CODE = ["def f(x):", "    y = x + 1", "    return y"];

function board(): Board {
  const b = emptyBoard("b1", "drag by body");
  put(
    b,
    {
      id: "n0",
      kind: "note",
      md: "## Plan\n\nalpha brave charlie delta echo\n\nsecond **line** here",
      look: "note",
    } as NoteCard,
    80,
    80,
    360,
  );
  b.cards.push({
    id: "c1",
    kind: "code",
    segments: [
      {
        id: "s1",
        src: { kind: "free" },
        path: "",
        lang: "python",
        start: 1,
        end: CODE.length,
        text: CODE.slice(),
        version: { kind: "none" },
      },
    ],
  } as unknown as CodeCard);
  b.place.c1 = { x: 560, y: 80, w: 420 };
  const s = findSym("Scheduler.schedule");
  const k = symCard(s.f, s.s);
  put(b, k, 80, 420, 520);
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const KID = (h: Host) => h.board().cards.find((c) => c.kind === "code" && c.id !== "c1")!.id;

type Pt = { x: number; y: number };
const placeOf = (h: Host, id: string): Pt => {
  const p = h.board().place[id];
  return { x: p.x, y: p.y };
};
const textSel = (pg: Page) => pg.evaluate(() => window.getSelection()?.toString() ?? "");
const selected = (pg: Page) =>
  pg.evaluate(() => [...document.querySelectorAll<HTMLElement>(".card.sel[data-id]")].map((e) => e.dataset.id!).sort());

/** The middle of the first place `word` shows up in root (it may be split over several text nodes, as in highlighted code) */
async function wordAt(pg: Page, root: string, word: string) {
  const r = await pg.evaluate(
    ([root, word]) => {
      const w = document.createTreeWalker(document.querySelector(root)!, NodeFilter.SHOW_TEXT);
      const ts: Text[] = [];
      for (let t = w.nextNode(); t; t = w.nextNode()) ts.push(t as Text);
      const i = ts
        .map((t) => t.data)
        .join("")
        .indexOf(word);
      if (i < 0) return null;
      const rg = document.createRange();
      const at = (k: number) => {
        for (const t of ts) {
          if (k < t.data.length) {
            rg.setStart(t, k);
            rg.setEnd(t, k + 1);
            return rg.getBoundingClientRect();
          }
          k -= t.data.length;
        }
        throw new Error("past the end");
      };
      const a = at(i),
        b = at(i + word.length - 1);
      return { x0: a.left + 1, x1: b.right - 1, y: (a.top + a.bottom) / 2 };
    },
    [root, word] as const,
  );
  if (!r) throw new Error(`"${word}" is not in ${root}`);
  return r;
}

/** Press at `from`, move by d in small steps (one per frame, as a hand does) and, before releasing, run mid() */
async function drag(pg: Page, from: Pt, d: Pt, mid?: () => Promise<unknown>) {
  await pg.mouse.move(from.x, from.y);
  await pg.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await pg.mouse.move(from.x + (d.x * i) / 8, from.y + (d.y * i) / 8);
    await frames(pg);
  }
  await mid?.();
  await pg.mouse.up();
}

const moved = (a: Pt, b: Pt, d: Pt) => b.x - a.x === d.x && b.y - a.y === d.y;

/** Nothing selected: pressing on a Note's text or on a code line and dragging moves that card (and selects it), no text gets
 *  selected; a click without moving selects the card in place; a double click on the Note's text still edits it */
test("dragUnselectedCardByBody", async () => {
  const h = await open({ board: board(), light, w: 1200, h: 900, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);
  const d = { x: 43, y: 127 };

  const n0 = placeOf(h, "n0");
  const w = await wordAt(pg, '.card[data-id="n0"] .nbody', "brave");
  let midSel = "";
  await drag(pg, { x: w.x0, y: w.y }, d, async () => {
    midSel = await textSel(pg);
  });
  await until(h, "the Note's move is saved", () => placeOf(h, "n0").x !== n0.x).catch(() => {}); // not moved: the checks below say so
  await idle(h);
  check("unselectedNoteBodyDragMovesCard", moved(n0, placeOf(h, "n0"), d), { before: n0, after: placeOf(h, "n0"), d });
  check("unselectedNoteBodyDragSelectsNoText", midSel === "" && (await textSel(pg)) === "", {
    midSel,
    after: await textSel(pg),
  });
  check(
    "unselectedNoteBodyDragSelectsCard",
    JSON.stringify(await selected(pg)) === JSON.stringify(["n0"]),
    await selected(pg),
  );

  const kid = KID(h),
    k0 = placeOf(h, kid);
  const kw = await wordAt(pg, `.card[data-id="${kid}"] .src`, "self");
  await drag(pg, { x: kw.x0, y: kw.y }, d, async () => {
    midSel = await textSel(pg);
  });
  await until(h, "the code card's move is saved", () => placeOf(h, kid).x !== k0.x).catch(() => {}); // not moved: the checks below say so
  await idle(h);
  check("unselectedCodeBodyDragMovesCard", moved(k0, placeOf(h, kid), d), { before: k0, after: placeOf(h, kid), d });
  check("unselectedCodeBodyDragSelectsNoText", midSel === "" && (await textSel(pg)) === "", {
    midSel,
    after: await textSel(pg),
  });
  check(
    "unselectedCodeBodyDragSelectsOnlyIt",
    JSON.stringify(await selected(pg)) === JSON.stringify([kid]),
    await selected(pg),
  );

  // a click without moving: selected, not moved
  const c1 = placeOf(h, "c1");
  const cw = await wordAt(pg, '.card[data-id="c1"] .src', "return");
  await pg.mouse.click(cw.x0, cw.y);
  await until(h, "the clicked card is selected", async () => (await selected(pg)).join() === "c1");
  await idle(h);
  check("unselectedBodyClickSelectsInPlace", JSON.stringify(placeOf(h, "c1")) === JSON.stringify(c1), {
    before: c1,
    after: placeOf(h, "c1"),
  });

  // a double click on an unselected Note's text edits it
  await pg.keyboard.press("Escape");
  await until(h, "nothing selected", async () => (await selected(pg)).length === 0);
  const nw = await wordAt(pg, '.card[data-id="n0"] .nbody', "charlie");
  await pg.mouse.dblclick(nw.x0, nw.y);
  const editing = await until(
    h,
    "the Note is being edited",
    async () => (await pg.locator('.card[data-id="n0"] .md-pm').count()) > 0,
  ).catch(() => false);
  check("unselectedNoteBodyDoubleClickEdits", editing);
  await h.close();
});

/** Two cards selected: pressing on the code lines of one of them and dragging moves both, no text selected (mid-drag too);
 *  then a click on the Note's text without moving leaves only the Note selected, in place */
test("dragMultiSelectionByBody", async () => {
  const h = await open({ board: board(), light, w: 1200, h: 900, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);
  const kid = KID(h);
  await pg.locator('.card[data-id="n0"] .chead').click();
  await pg.locator(`.card[data-id="${kid}"] .chead`).click({ modifiers: ["Shift"], position: { x: 30, y: 10 } });
  await until(h, "two cards selected", async () => (await selected(pg)).length === 2);
  await idle(h);
  const d = { x: 211, y: 37 };
  const n0 = placeOf(h, "n0"),
    k0 = placeOf(h, kid),
    c1 = placeOf(h, "c1");
  const kw = await wordAt(pg, `.card[data-id="${kid}"] .src`, "self");
  let midSel = "";
  await drag(pg, { x: kw.x0, y: kw.y }, d, async () => {
    midSel = await textSel(pg);
    await shot(h, "dragMultiSelectionByBody-mid", "now");
  });
  await until(h, "the move is saved", () => placeOf(h, "n0").x !== n0.x).catch(() => {}); // not moved: the checks below say so
  await idle(h);
  check("multiBodyDragMovesAll", moved(n0, placeOf(h, "n0"), d) && moved(k0, placeOf(h, kid), d), {
    n0: [n0, placeOf(h, "n0")],
    k: [k0, placeOf(h, kid)],
    d,
  });
  check("multiBodyDragLeavesOthers", JSON.stringify(placeOf(h, "c1")) === JSON.stringify(c1), placeOf(h, "c1"));
  check("multiBodyDragSelectsNoText", midSel === "" && (await textSel(pg)) === "", {
    midSel,
    after: await textSel(pg),
  });
  check("multiBodyDragKeepsSelection", (await selected(pg)).join() === ["n0", kid].sort().join(), await selected(pg));

  // the same grabbing the Note's text
  const n1 = placeOf(h, "n0"),
    k1 = placeOf(h, kid);
  const w = await wordAt(pg, '.card[data-id="n0"] .nbody', "brave");
  const d2 = { x: -61, y: 53 };
  await drag(pg, { x: w.x0, y: w.y }, d2, async () => {
    midSel = await textSel(pg);
  });
  await until(h, "the second move is saved", () => placeOf(h, "n0").x !== n1.x).catch(() => {}); // not moved: the checks below say so
  await idle(h);
  check("multiNoteBodyDragMovesAll", moved(n1, placeOf(h, "n0"), d2) && moved(k1, placeOf(h, kid), d2), {
    n0: [n1, placeOf(h, "n0")],
    k: [k1, placeOf(h, kid)],
    d2,
  });
  check("multiNoteBodyDragSelectsNoText", midSel === "" && (await textSel(pg)) === "", {
    midSel,
    after: await textSel(pg),
  });

  // a click without moving: only the clicked card stays selected, nothing moves
  const n2 = placeOf(h, "n0");
  const cw = await wordAt(pg, '.card[data-id="n0"] .nbody', "delta");
  await pg.mouse.click(cw.x0, cw.y);
  await until(h, "only the Note is selected", async () => (await selected(pg)).join() === "n0");
  await idle(h);
  check("multiBodyClickSelectsOne", JSON.stringify(placeOf(h, "n0")) === JSON.stringify(n2), {
    before: n2,
    after: placeOf(h, "n0"),
  });

  // two selected, grabbing the text of a third, unselected card: that card is selected and moves alone
  await pg.locator(`.card[data-id="${kid}"] .chead`).click({ modifiers: ["Shift"], position: { x: 30, y: 10 } });
  await until(h, "two cards selected again", async () => (await selected(pg)).length === 2);
  await idle(h);
  const n3 = placeOf(h, "n0"),
    k3 = placeOf(h, kid),
    c3 = placeOf(h, "c1");
  const fw = await wordAt(pg, '.card[data-id="c1"] .src', "return");
  await drag(pg, { x: fw.x0, y: fw.y }, d2, async () => {
    midSel = await textSel(pg);
  });
  await until(h, "the third card's move is saved", () => placeOf(h, "c1").x !== c3.x).catch(() => {}); // not moved: the checks below say so
  await idle(h);
  check(
    "otherBodyDragMovesOnlyIt",
    moved(c3, placeOf(h, "c1"), d2) && JSON.stringify([placeOf(h, "n0"), placeOf(h, kid)]) === JSON.stringify([n3, k3]),
    { c1: [c3, placeOf(h, "c1")], n0: placeOf(h, "n0"), k: placeOf(h, kid) },
  );
  check("otherBodyDragSelectsIt", (await selected(pg)).join() === "c1" && midSel === "", {
    sel: await selected(pg),
    midSel,
  });
  await h.close();
});

/** The only selected card: dragging over its text selects that text and the card stays where it is (Note and code) */
test("singleSelectedBodySelectsText", async () => {
  const h = await open({ board: board(), light, w: 1200, h: 900, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);
  for (const [id, root, word] of [
    ["n0", ".nbody", "brave charlie"],
    ["c1", ".src", "x + 1"],
  ] as const) {
    await pg
      .locator(`.card[data-id="${id}"] .chead`)
      .first()
      .click({ position: { x: 30, y: 10 } });
    await until(h, `${id} selected alone`, async () => (await selected(pg)).join() === id);
    await idle(h);
    const p0 = placeOf(h, id);
    const w = await wordAt(pg, `.card[data-id="${id}"] ${root}`, word);
    await pg.mouse.move(w.x0, w.y);
    await pg.mouse.down();
    await pg.mouse.move(w.x1, w.y, { steps: 6 });
    await pg.mouse.up();
    const got = await until(h, "the text is selected", async () => (await textSel(pg)) === word).catch(() => false);
    await idle(h);
    check(`singleSelectedBodySelectsText ${id}`, got, { sel: await textSel(pg) });
    check(`singleSelectedBodyDragKeepsPlace ${id}`, JSON.stringify(placeOf(h, id)) === JSON.stringify(p0), {
      before: p0,
      after: placeOf(h, id),
    });
  }
  await h.close();
});

/** A click on a card's header (press and release without moving past the drag threshold) selects it and never lifts it: no
 *  .lift class at any point, no scale, no lift shadow. A real drag lifts it (.lift, scaled up a little, its own compositor layer,
 *  which a zoom mid-drag takes off for a frame and puts back) and, put down, it settles back (.landing, then neither, no layer) */
test("clickSelectsWithoutLift", async () => {
  const h = await open({ board: board(), light, w: 1200, h: 900, settings: { theme: "warm-ink" } as never });
  const pg = h.page;
  await idle(h);
  const card = '.card[data-id="c1"]';
  // every class the card gets, as it gets it (a lift that came and went within a frame shows up too), and the transitions of
  // the card itself still running when it stops landing
  await pg.evaluate((sel) => {
    const el = document.querySelector(sel)!;
    const w = window as unknown as { __cls: string[]; __landEnd: string[][] };
    w.__cls = [];
    w.__landEnd = [];
    new MutationObserver(() => {
      if (/\blanding\b/.test(w.__cls.at(-1) ?? "") && !el.classList.contains("landing"))
        w.__landEnd.push(
          el
            .getAnimations()
            .filter((a) => a.playState === "running")
            .map((a) => (a as CSSTransition).transitionProperty),
        );
      w.__cls.push(el.className);
    }).observe(el, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }, card);
  const seen = () => pg.evaluate(() => (window as unknown as { __cls: string[] }).__cls);
  const look = () =>
    pg.evaluate((sel) => {
      const el = document.querySelector(sel)!;
      return {
        scale: getComputedStyle(el).scale,
        ring: getComputedStyle(el, "::after").boxShadow,
        layer: getComputedStyle(el).willChange,
      };
    }, card);
  const rest = await look();
  const hd = (await pg.locator(`${card} .chead`).boundingBox())!;
  const at = { x: hd.x + 40, y: hd.y + hd.height / 2 };
  await pg.mouse.move(at.x, at.y);
  await pg.mouse.down();
  await frames(pg);
  const pressed = await look();
  await pg.mouse.up();
  await until(h, "the clicked card is selected", async () => (await selected(pg)).join() === "c1");
  await idle(h);
  const clicked = await seen();
  check("clickDoesNotLiftCard", clicked.every((c) => !/\b(lift|landing)\b/.test(c)) && pressed.scale === rest.scale, {
    clicked,
    rest,
    pressed,
  });

  // a real drag lifts it, and putting it down settles it back (pressed away from the click: not a double-click)
  at.x += 60;
  await pg.mouse.move(at.x, at.y);
  await pg.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await pg.mouse.move(at.x + 5 * i, at.y + 3 * i);
    await frames(pg);
  }
  const lifted = await until(h, "the dragged card lifts", async () => {
    const l = await look();
    return (await pg.locator(`${card}.lift`).count()) === 1 && l.scale !== "none" && parseFloat(l.scale) > 1;
  }).catch(() => false);
  // lifted, the card is a compositor layer of its own (moving it does not re-raster the world's layer under it); when the camera
  // stops at another zoom mid-drag the hint goes for a frame (.board.relift) and comes back, so it is rastered at the new scale
  const liftLayer = (await look()).layer;
  await pg.evaluate(() => {
    const b = document.querySelector(".board")!;
    const w = window as unknown as { __relift: boolean[] };
    w.__relift = [];
    new MutationObserver(() => w.__relift.push(b.classList.contains("relift"))).observe(b, {
      attributes: true,
      attributeFilter: ["class"],
    });
  });
  const z0 = await pg.evaluate(() => (document.querySelector(".world") as HTMLElement).style.transform);
  await pg.keyboard.down("ControlOrMeta");
  await pg.mouse.wheel(0, -60);
  await pg.keyboard.up("ControlOrMeta");
  const relifted = await until(h, "the camera stops at the new zoom and the lifted card is a layer again", async () =>
    pg.evaluate(() => {
      const r = (window as unknown as { __relift: boolean[] }).__relift;
      return r.includes(true) && !document.querySelector(".board.relift, .world.moving");
    }),
  ).catch(() => false);
  const zoomed = await pg.evaluate(
    (z0) => (document.querySelector(".world") as HTMLElement).style.transform !== z0,
    z0,
  );
  const reLayer = (await look()).layer;
  check("liftedCardIsOwnLayer", liftLayer === "transform" && reLayer === "transform" && relifted && zoomed, {
    liftLayer,
    reLayer,
    relifted,
    zoomed,
  });
  await pg.mouse.up();
  const landing = (await seen()).some((c) => /\blanding\b/.test(c));
  const flat = (s: string) => (s === "none" ? 1 : parseFloat(s));
  await until(
    h,
    "the card has settled",
    async () =>
      !(await pg.locator(`${card}:is(.lift, .landing)`).count()) && flat((await look()).scale) === flat(rest.scale),
  ).catch(() => {}); // not settled: the check below says so
  const after = await look();
  // .landing (its own layer) lasts until the card's transitions have ended: taken off while its scale still eased, the card was
  // a running transform animation among the other cards, and Chromium gave every card painted after it a layer of its own and
  // rastered them all, twice (4-21 viewports after a drop on real boards)
  const landEnd = await pg.evaluate(() => (window as unknown as { __landEnd: string[][] }).__landEnd);
  check("landingEndsWhenSettled", landEnd.length === 1 && landEnd[0].length === 0, { landEnd });
  check(
    "dragLiftsCardAndSettlesBack",
    lifted && landing && flat(after.scale) === flat(rest.scale) && after.layer === "auto",
    {
      lifted,
      landing,
      rest,
      after,
    },
  );
  await h.close();
});

/**
 * A card drag, watched frame by frame (watch.ts) in Warm Ink and Ink Wash: the lift, the moves (each a frame of its own, the card
 * and its arrows following the pointer) and the drop. The other cards stay where they are in every frame, the dropped card lands
 * without a jump, nothing flashes
 */
test("dragWatched", async () => {
  for (const theme of ["warm-ink", "ink-wash"]) {
    const b = emptyBoard("b1", "drag watched");
    for (let i = 0; i < 3; i++)
      put(
        b,
        { id: `n${i}`, kind: "note", look: "note", md: `## Note ${i}\n\nwords ${i}` } as NoteCard,
        80 + i * 340,
        80,
        300,
      );
    b.links.push({ id: "L1", from: { card: "n0" }, to: { card: "n1" } } as never);
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light, w: 1200, h: 700, settings: { theme } as never });
    const pg = h.page;
    await idle(h);
    const box = (await pg.locator('.card[data-id="n0"] .chead').boundingBox())!;
    const x = box.x + 40,
      y = box.y + box.height / 2;
    await pg.mouse.move(x, y);
    const carried = ["card:n0", /^link:/];
    await watch(
      h,
      `dragWatched ${theme} lift`,
      { free: carried, keep: ['.card[data-id="n0"]'], frames: 16 },
      async () => {
        await pg.mouse.down();
        for (let i = 1; i <= 4; i++) await pg.mouse.move(x + i * 12, y + i * 14);
      },
    );
    await watch(h, `dragWatched ${theme} drop`, { moves: carried, keep: ['.card[data-id="n0"]'], frames: 32 }, () =>
      pg.mouse.up(),
    );
    await idle(h);
    check(`dragWatched ${theme} the card moved`, h.board().place.n0.y > 100, h.board().place.n0);
    await h.close();
  }
});

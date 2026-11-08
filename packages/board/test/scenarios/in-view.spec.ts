// Nothing in view is hidden, and nothing hidden comes into view before it is shown (state/lead.ts, state/cull.ts).
// The page's clock is paused and moved one frame at a time, each frame read after its animation frame callbacks ran (what that
// frame paints): a card in view must not be hidden in that frame, nor in the frame before (shown in the very frame it came into
// view, its tiles are rastered for the frame that has to show them; on a GPU short of tile memory that frame was blank).
//   culledCardsShownBeforeInView   a board of 240 code cards in rows of 12, at rest with the far ones culled (.off, .far): mouse
//                                  wheel notches out and a flight back to 100 %, a pinch out to the summary cut, fast pans and a
//                                  fling there, notches out and a fast pan: no card in view is culled in its frame or the one
//                                  before
import { emptyBoard, type Board } from "@codeboard/core";
import type { Page } from "@playwright/test";
import { files, put, symCard, type Host } from "../harness";
import { test, open, check, idle, pauseClock } from "../fixtures";

const W = 1280,
  H = 800;

/** The page's clock paused: `frame()` moves it on one frame (its timers and animation frame callbacks) and reads what that
 *  frame paints with `read`; the frames read, the first one before `act` */
async function stepped<T>(h: Host, read: (pg: Page) => Promise<T>, act: (frame: () => Promise<T>) => Promise<void>) {
  const pg = h.page;
  await pg.clock.install();
  await pauseClock(pg);
  const out: T[] = [await read(pg)];
  const frame = async () => {
    await pg.clock.runFor(16);
    const f = await read(pg);
    out.push(f);
    return f;
  };
  try {
    await act(frame);
  } finally {
    await pg.clock.resume();
  }
  return out;
}

/** A frame's cards: those in view and those culled (cull.ts .off: content hidden, .far: not drawn at all) */
type Cards = { z: number; view: string[]; culled: string[] };
const cardsOf = (pg: Page) =>
  pg.evaluate((): Cards => {
    const view: string[] = [],
      culled: string[] = [];
    for (const c of document.querySelectorAll<HTMLElement>(".world .card")) {
      const r = c.getBoundingClientRect();
      if (r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight) view.push(c.dataset.id!);
      if (c.matches(".off, .far")) culled.push(c.dataset.id!);
    }
    const world = document.querySelector(".world") as HTMLElement;
    return { z: +(/scale\(([\d.e-]+)\)/.exec(world.style.transform)?.[1] ?? 1), view, culled };
  });

/** Code cards in rows of 12, as the perf board has them (perf.ts bigBoard) */
function codeGrid(): Board {
  const b = emptyBoard("bCull", "cull");
  const defs = [...files.entries()].flatMap(([f, x]) =>
    x.a.symbols.filter((s) => s.kind === "def").map((s) => ({ f, s })),
  );
  for (let i = 0; i < 240; i++) {
    const d = defs[i % defs.length];
    put(b, symCard(d.f, d.s), (i % 12) * 620, Math.floor(i / 12) * 700, 560);
  }
  b.cam = { x: 40, y: 40, z: 1 };
  return b;
}

test("culledCardsShownBeforeInView", async () => {
  const h = await open({ board: codeGrid(), w: W, h: H });
  await idle(h);
  const pg = h.page,
    m = pg.mouse;
  const fs = await stepped(h, cardsOf, async (frame) => {
    const frames = async (n: number) => {
      for (let i = 0; i < n; i++) await frame();
    };
    // the camera's stop (CAM_STILL) and the hides after it, a few a frame: the next move starts with the far cards culled
    const rest = () => frames(40);
    const pan = async (dx: number, dy: number, n: number) => {
      for (let i = 0; i < n; i++) {
        await m.wheel(dx, dy);
        await frame();
      }
      await rest();
    };
    /** Ctrl + wheel at the middle, a step a frame: 30 is a mouse wheel's notch (about 0.74, as zoom-perf.cjs zooms), 8 a pinch */
    const zoomOut = async (n: number, dy: number) => {
      await m.move(W / 2, H / 2);
      await pg.keyboard.down("Control");
      for (let i = 0; i < n; i++) {
        await m.wheel(0, dy);
        await frame();
      }
      await pg.keyboard.up("Control");
      await rest();
    };
    const to100 = async () => {
      await pg.keyboard.press("ControlOrMeta+1");
      await frames(40);
      await rest();
    };
    await zoomOut(5, 30);
    await to100();
    // to the summary cut, the card level's lowest zoom, where a pan brings the most cards into view a frame
    await zoomOut(15, 8);
    await pan(0, 150, 24);
    await pan(60, -150, 24);
    await m.move(W - 100, H - 100);
    await m.down({ button: "middle" });
    for (let i = 1; i <= 6; i++) {
      await m.move(W - 100 - i * 120, H - 100 - i * 40);
      await frame();
    }
    await m.up({ button: "middle" });
    await frames(60);
    await rest();
    await to100();
    await zoomOut(2, 30);
    await pan(150, 40, 20);
  });
  const blank: string[] = [],
    late: string[] = [];
  fs.forEach((f, i) => {
    if (!i) return;
    const now = new Set(f.culled),
      before = new Set(fs[i - 1].culled);
    for (const id of f.view) {
      if (now.has(id)) blank.push(`${i}:${id}@${f.z.toFixed(3)}`);
      else if (before.has(id)) late.push(`${i}:${id}@${f.z.toFixed(3)}`);
    }
  });
  const zMin = Math.min(...fs.map((f) => f.z));
  check(
    "culledCardsShownBeforeInView the far cards are culled at rest, and the moves bring them into view",
    fs[0].culled.length > 30 && zMin < 0.35 && fs.some((f, i) => i && f.view.some((id) => fs[0].culled.includes(id))),
    { culled: fs[0].culled.length, zMin, frames: fs.length },
  );
  check("culledCardsShownBeforeInView no card in view is culled", !blank.length, blank.length, blank.slice(0, 12));
  check(
    "culledCardsShownBeforeInView no culled card comes into view in the frame it is shown",
    !late.length,
    late.length,
    late.slice(0, 12),
  );
  await h.page.context().close();
});

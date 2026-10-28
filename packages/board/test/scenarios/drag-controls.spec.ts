// Drags and pans that pass over cards and their controls: nothing under the pointer takes the gesture over.
// dragPassesOverCardControls: moving a card, a marquee and dragging an arrow out of a card's edge port across another card's
// ··· (More Actions) button, its resize grip and its edge port keep following the pointer to where they are released, no
// tooltip shows and none of those controls shows hover. panKeepsGoingOverCards: a wheel (two-finger) pan and a middle-button
// drag pan keep moving the canvas while a card's edge and body come under the pointer.
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { type Host } from "../harness";
import { test, open, check, light, idle, hold, frames } from "../fixtures";

function board(): Board {
  const b = emptyBoard("b1", "drag over controls");
  const put = (id: string, x: number, y: number, w: number, h: number) => {
    b.cards.push({ id, kind: "note", md: `Note ${id}`, look: "note" } as NoteCard);
    b.place[id] = { x, y, w, h };
  };
  put("n0", 60, 400, 300, 160);
  put("n1", 520, 120, 300, 200);
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

type Pt = { x: number; y: number };
const box = (h: Host, sel: string) => h.page.evaluate((sel) => {
  const e = document.querySelector(sel);
  if (!e) throw new Error(`no ${sel}`);
  const r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}, sel);
const N0 = `.card[data-id="n0"]`, N1 = `.card[data-id="n1"]`;
const CONTROLS = [`${N1} .ib[data-tip="More Actions"]`, `${N1} .grip`, `${N1} .eport.l`];

/** What the pointer's passing left behind: a tooltip, controls of n1 in :hover */
const leaks = (h: Host) => h.page.evaluate((controls) => ({
  tip: document.querySelector(".tip")?.textContent ?? null,
  hover: controls.filter((s) => document.querySelector(s)?.matches(":hover")),
}), CONTROLS);
type Seen = { tip: string | null; hover: string[]; off?: number | null };
const clean = (seen: Seen[]) => seen.every((m) => m.tip === null && m.hover.length === 0);

/** The tooltip shows this long after the pointer comes to rest on a control (TooltipLayer, ui/Menu.tsx) */
const TIP_DELAY = 500;
/** Moves the held pointer to `to` in a few large steps, a rendered frame each (each step's hit test sees the dragged card where
 *  the step before left it), then, with `rest`, rests there longer than the tooltip delay */
async function glide(h: Host, from: Pt, to: Pt, steps = 4, rest = true) {
  for (let i = 1; i <= steps; i++) {
    await h.page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await frames(h.page);
  }
  if (rest) await hold(h, TIP_DELAY + 200, "resting on the control longer than the tooltip delay: a tooltip or hover would show by now");
  else await frames(h.page, 2);
}

/** Holds the pointer down at `start`, passes it over n1's ···, grip and left port, then over `end` and releases it there;
 *  `follow` measures at each stop how far the drag is from the pointer */
async function across(h: Host, start: Pt, end: Pt, follow: (at: Pt) => Promise<number | null>): Promise<Seen[]> {
  const stops = [];
  for (const s of CONTROLS) stops.push(await box(h, s));
  await h.page.mouse.move(start.x, start.y);
  await h.page.mouse.down();
  let at = start;
  const seen: Seen[] = [];
  for (const s of stops) {
    await glide(h, at, s);
    at = s;
    seen.push({ ...(await leaks(h)), off: await follow(s) });
  }
  await glide(h, at, end, 3, false);
  await h.page.mouse.up();
  await idle(h);
  return seen;
}

test("dragPassesOverCardControls", async () => {
  const h = await open({ board: board(), light, w: 1100, h: 700 });
  const pg = h.page;

  // 1. moving n0 by its header, grabbed near its right end: at each large step the pointer is past the card's right edge
  const n0 = await box(h, N0);
  const grab = await pg.evaluate((sel) => { // the header's right-most point that is not one of its buttons
    const r = document.querySelector(`${sel} .chead`)!.getBoundingClientRect(), y = r.top + r.height / 2;
    for (let x = r.right - 2; x > r.left; x -= 2) if (!document.elementFromPoint(x, y)?.closest("button, [data-nodrag]")) return { x, y };
    throw new Error("no free spot in the header");
  }, N0);
  const target = { x: 655, y: 615 };
  const moved = await across(h, grab, target, async (s) => { const r = await box(h, N0); return Math.round(Math.hypot(r.left + grab.x - n0.left - s.x, r.top + grab.y - n0.top - s.y)); });
  const p0 = h.board().place.n0;
  const want = { x: Math.round(60 + target.x - grab.x), y: Math.round(400 + target.y - grab.y) };
  check("dragPassesOverCardControls card move: no tooltip, no hover", clean(moved), moved);
  check("dragPassesOverCardControls card move: the card follows the pointer", moved.every((m) => m.off !== null && m.off! <= 8), moved); // snapping moves it by up to 6 px
  check("dragPassesOverCardControls card move: lands where released", Math.abs(p0.x - want.x) <= 6 && Math.abs(p0.y - want.y) <= 6, { place: p0, want });

  // 2. a marquee from the empty canvas across the same controls
  const corner = async (s: Pt) => pg.evaluate((s) => {
    const e = document.querySelector(".marquee");
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return Math.round(Math.hypot(r.left - s.x, r.bottom - s.y));
  }, s);
  const boxed = await across(h, { x: 1000, y: 40 }, { x: 900, y: 380 }, corner);
  check("dragPassesOverCardControls marquee: no tooltip, no hover", clean(boxed), boxed);
  check("dragPassesOverCardControls marquee: follows the pointer", boxed.every((m) => m.off !== null && m.off! <= 2), boxed);

  // 3. an arrow dragged out of n0's top edge port across the controls, released on n1's body: an arrow n0 → n1
  await pg.mouse.click(1000, 660); // nothing selected
  const n0now = await box(h, N0);
  await pg.mouse.move(n0now.x, n0now.y); // hovering n0 shows its ports
  await pg.locator(`${N0} .eport.t`).waitFor({ state: "visible" }); await idle(h);
  const port = await box(h, `${N0} .eport.t`);
  const rubber = async () => (await pg.locator(".edge.rubber").count()) === 1 ? 0 : null;
  const linked = await across(h, port, await box(h, `${N1} .nbody`), rubber);
  const links = h.board().links.map((l) => `${l.from.card}>${l.to.card}`);
  check("dragPassesOverCardControls arrow: no tooltip, no hover", clean(linked), linked);
  check("dragPassesOverCardControls arrow: links to the card it is released on", links.includes("n0>n1") && linked.every((m) => m.off === 0), { links, linked });
});

/** A Note shorter than its text, which scrolls in its body */
function panBoard(): Board {
  const b = emptyBoard("b2", "pan over cards");
  const md = Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of a long note that scrolls inside its body.`).join("\n\n");
  b.cards.push({ id: "n0", kind: "note", md, look: "note" } as NoteCard);
  b.place.n0 = { x: 300, y: 60, w: 420, h: 240 };
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
/** A wheel pan that is going on keeps going while wheel events come within this long of each other (interact.ts canvasWheel) */
const WHEEL_GESTURE = 200;
/** A pan released within this long of its last move flings on (interact.ts startPan) */
const FLING_WINDOW = 60;
const camOf = (h: Host) => h.page.evaluate(() => {
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec((document.querySelector(".world") as HTMLElement).style.transform);
  return { x: Number(m![1]), y: Number(m![2]) };
});

/** Panning the canvas while a card comes under the pointer: a two-finger (wheel) pan that started on the empty canvas below a
 *  Note brings the Note down under the pointer, across its bottom edge (edge port, height handle, resize grip) and its
 *  scrolling body, and keeps going, slow and fast. A pan dragged with the middle button follows the pointer to the release */
test("panKeepsGoingOverCards", async () => {
  const h = await open({ board: panBoard(), light, w: 1100, h: 700 });
  const pg = h.page;
  const TOTAL = 420; // more than the card is tall: the pointer goes in at its bottom edge and out at its top
  const wheelRuns: { where: string; step: number; moved: number; want: number; under: string[] }[] = [];
  for (const [where, step] of [["middle", 6], ["corner", 6], ["middle", 42]] as const) {
    const r = await box(h, N0);
    const at = { x: where === "middle" ? r.x : r.right - 5, y: r.bottom + 60 }; // below the bottom edge port / the resize grip
    await pg.mouse.move(at.x, at.y);
    await idle(h);
    await hold(h, WHEEL_GESTURE + 200, "a new wheel gesture: longer than the gap that ends one");
    const c0 = await camOf(h);
    const under: string[] = [];
    let n = 0;
    for (let done = 0; done < TOTAL; done += step) {
      await pg.mouse.wheel(0, -step);
      await frames(pg);
      if (n++ % Math.ceil(42 / step) === 0) under.push(await pg.evaluate((p) => String(document.elementFromPoint(p.x, p.y)?.className ?? ""), at));
    }
    await idle(h);
    const c1 = await camOf(h);
    wheelRuns.push({ where, step, moved: Math.round(c1.y - c0.y), want: Math.ceil(TOTAL / step) * step, under: [...new Set(under)] });
    // back where it was, as a separate gesture from the empty canvas above the card
    await pg.mouse.move(at.x, 20);
    await hold(h, WHEEL_GESTURE + 200, "a new wheel gesture: longer than the gap that ends one");
    await pg.mouse.wheel(0, c1.y - c0.y);
    await idle(h);
  }
  check("panKeepsGoingOverCards wheel pan crosses the card", wheelRuns.every((w) => w.moved === w.want), wheelRuns);

  // a pan dragged with the middle button from the empty canvas below the card, slow and fast
  const dragRuns: { steps: number; moved: Pt; want: Pt }[] = [];
  for (const steps of [60, 4]) {
    const r = await box(h, N0);
    const from = { x: r.x, y: r.bottom + 40 }, to = { x: r.x - 120, y: r.top - 30 };
    const c0 = await camOf(h);
    await pg.mouse.move(from.x, from.y);
    await pg.mouse.down({ button: "middle" });
    for (let i = 1; i <= steps; i++) { await pg.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps); await frames(pg); }
    await hold(h, FLING_WINDOW + 90, "held still before the release, longer than the fling window: no fling");
    await pg.mouse.up({ button: "middle" });
    await idle(h);
    const c1 = await camOf(h);
    dragRuns.push({ steps, moved: { x: Math.round(c1.x - c0.x), y: Math.round(c1.y - c0.y) }, want: { x: Math.round(to.x - from.x), y: Math.round(to.y - from.y) } });
  }
  check("panKeepsGoingOverCards drag pan follows the pointer", dragRuns.every((d) => d.moved.x === d.want.x && d.moved.y === d.want.y), dragRuns);
});

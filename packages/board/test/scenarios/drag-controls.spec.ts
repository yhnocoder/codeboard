// Drags that pass over another card's controls: nothing under the pointer takes the drag over. Moving a card, a marquee and
// dragging an arrow out of a card's edge port across another card's ··· (More Actions) button, its resize grip and its edge
// port: the drag keeps following the pointer to where it is released, no tooltip shows and none of those controls shows hover.
// Usage: npm run harness -- dragPassesOverCardControls
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { type Host } from "../harness";
import { test, open, check, light } from "../fixtures";

function board(): Board {
  const b = emptyBoard("b1", "drag over controls");
  const put = (id: string, x: number, y: number, w: number, h: number) => {
    b.cards.push({ id, kind: "note", md: `Note ${id}`, bg: true } as NoteCard);
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

/** Moves the held pointer to `to` in a few large steps (each step's hit test sees the dragged card where the step before left
 *  it), then rests there longer than the tooltip delay (500 ms) */
async function glide(h: Host, from: Pt, to: Pt, steps = 4, rest = 700) {
  for (let i = 1; i <= steps; i++) {
    await h.page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await h.page.waitForTimeout(16);
  }
  await h.page.waitForTimeout(rest);
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
  await glide(h, at, end, 3, 200);
  await h.page.mouse.up();
  await h.page.waitForTimeout(300);
  return seen;
}

test("dragPassesOverCardControls", async () => {
  const h = await open({ board: board(), light, w: 1100, h: 700 });
  const pg = h.page;
  await pg.waitForTimeout(600);

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
  await pg.waitForTimeout(300);
  const port = await box(h, `${N0} .eport.t`);
  const rubber = async () => (await pg.locator(".edge.rubber").count()) === 1 ? 0 : null;
  const linked = await across(h, port, await box(h, `${N1} .nbody`), rubber);
  const links = h.board().links.map((l) => `${l.from.card}>${l.to.card}`);
  check("dragPassesOverCardControls arrow: no tooltip, no hover", clean(linked), linked);
  check("dragPassesOverCardControls arrow: links to the card it is released on", links.includes("n0>n1") && linked.every((m) => m.off === 0), { links, linked });
});

// Tilted cards: Tilt in the card menu / right-click menu / ⇧⌥T (also for a multi-selection) turns a card -1.2° like a sticky note,
// as one undo step; the selection ring and the link ports turn with it and an arrow leaves from the turned edge. While the card is
// edited it turns straight (and back when editing ends), and the arrow stays on the edge in every frame of that turn.
import * as path from "node:path";
import { symCard, findSym, put, OUT, type Host } from "../harness";
import { emptyBoard, THEMES, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle } from "../fixtures";

const TILT = -1.2;

/** A tall Note n (so the arrow's start, level with its title row, is far from the card's center) → a code card */
function board(tilt = false): Board {
  const b = emptyBoard("b1", "tilt");
  const n: NoteCard = { id: "n", kind: "note", md: "Why is the block size **256**?\n\nA multiple of 32 that leaves each thread enough registers.", look: "note", ...(tilt ? { tilt: true } : {}) };
  b.cards.push(n);
  b.place.n = { x: 80, y: 120, w: 320, h: 380 };
  const s = findSym("LLMEngine.step");
  put(b, symCard(s.f, s.s), 620, 80, 480);
  b.links.push({ id: "L", from: { card: "n" }, to: { card: b.cards[1].id } });
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

/** The card's angle (deg, from its computed rotate), how far the arrow's start is from the line through the card's right edge
 *  (turned by that angle, through the right link port), and the angle of the line from the top port to the bottom port */
const probe = (h: Host) => h.page.evaluate(() => {
  const el = document.querySelector<HTMLElement>('.card[data-id="n"]')!;
  const r = getComputedStyle(el).rotate;
  const deg = r === "none" ? 0 : parseFloat(r);
  const c = (s: string) => { const q = el.querySelector(s)!.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; };
  const E = c(".eport.r"), T = c(".eport.t"), B = c(".eport.b");
  const p = document.querySelector<SVGPathElement>('g.link[data-lk="L"] path.edge')!;
  const m = p.getScreenCTM()!, q = p.getPointAtLength(0);
  const P = { x: q.x * m.a + m.e, y: q.y * m.d + m.f };
  const a = (deg * Math.PI) / 180, dx = -Math.sin(a), dy = Math.cos(a);
  return { deg, off: Math.abs((P.x - E.x) * dy - (P.y - E.y) * dx), ports: (Math.atan2(-(B.x - T.x), B.y - T.y) * 180) / Math.PI };
});

async function shot(h: Host, name: string) {
  await h.page.mouse.move(2, 2);
  await idle(h);
  await h.page.screenshot({ path: path.join(OUT, `tilt-${name}.png`), clip: { x: 40, y: 60, width: 1100, height: 500 } });
}

test("tiltCardFromMenu", async () => {
  const h = await open({ board: board(), light, w: 1200, h: 700 });
  const pg = h.page;
  const before = await probe(h);
  check("tilt-starts-straight", before.deg === 0 && before.off < 0.75, before);
  await pg.locator('.card[data-id="n"] .nbody').click({ button: "right" });
  await pg.locator(".ctx button[role=menuitem]", { hasText: /^Tilt/ }).click();
  await until(h, "the host's board has n tilted", () => h.board().cards.find((c) => c.id === "n")?.tilt === true);
  await idle(h);
  const on = await probe(h);
  check("tilt-card-turns", Math.abs(on.deg - TILT) < 0.01, on);
  check("tilt-ports-turn-with-card", Math.abs(on.ports - TILT) < 0.3, on);
  check("tilt-arrow-on-turned-edge", on.off < 0.75, on);
  // still tilted while merely selected
  await pg.locator('.card[data-id="n"] .nbody').click();
  await idle(h);
  check("tilt-stays-when-selected", Math.abs((await probe(h)).deg - TILT) < 0.01);
  await shot(h, "selected");
  // the menu shows it checked; one undo step takes it off
  await pg.locator('.card[data-id="n"] .nbody').click({ button: "right" });
  const item = pg.locator(".ctx button[role=menuitem]", { hasText: /^Tilt/ });
  check("tilt-menu-checked", await item.locator(".ck svg").count() === 1);
  await pg.keyboard.press("Escape");
  await pg.keyboard.press("Meta+z");
  await until(h, "undo takes the tilt off", () => !h.board().cards.find((c) => c.id === "n")?.tilt);
  await idle(h);
  check("tilt-undo-straightens", (await probe(h)).deg === 0);
});

test("tiltStraightensWhileEditing", async () => {
  const h = await open({ board: board(true), light, w: 1200, h: 700 });
  const pg = h.page;
  check("tilt-loaded-tilted", Math.abs((await probe(h)).deg - TILT) < 0.01);
  /** Every frame until the card's angle has been `to` for a few frames: the angle and the arrow's distance from the turned edge */
  const watch = (to: number) => pg.evaluate((to) => new Promise<{ deg: number; off: number }[]>((done) => {
    const out: { deg: number; off: number }[] = [];
    let still = 0;
    const step = () => {
      const el = document.querySelector<HTMLElement>('.card[data-id="n"]')!;
      const r = getComputedStyle(el).rotate, deg = r === "none" ? 0 : parseFloat(r);
      const q0 = el.querySelector(".eport.r")!.getBoundingClientRect(), E = { x: q0.left + q0.width / 2, y: q0.top + q0.height / 2 };
      const p = document.querySelector<SVGPathElement>('g.link[data-lk="L"] path.edge')!;
      const m = p.getScreenCTM()!, q = p.getPointAtLength(0), P = { x: q.x * m.a + m.e, y: q.y * m.d + m.f };
      const a = (deg * Math.PI) / 180;
      out.push({ deg, off: Math.abs((P.x - E.x) * Math.cos(a) + (P.y - E.y) * Math.sin(a)) });
      still = Math.abs(deg - to) < 1e-6 ? still + 1 : 0;
      if (still >= 3 || out.length > 120) done(out); else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), to);
  const turning = watch(0);
  await pg.locator('.card[data-id="n"] .nbody').dblclick();
  const down = await turning;
  await until(h, "the Note is being edited", () => pg.locator('.card[data-id="n"].editing').count());
  const mid = down.filter((f) => f.deg < -0.05 && f.deg > TILT + 0.05);
  check("tilt-edit-straightens", down.at(-1)!.deg === 0, down.at(-1));
  check("tilt-edit-turn-animates", mid.length >= 2, down.map((f) => f.deg));
  check("tilt-arrow-follows-turn", down.every((f) => f.off < 0.75), down);
  await shot(h, "editing");
  const back = watch(TILT);
  await pg.keyboard.press("Escape");
  const up = await back;
  check("tilt-edit-end-retilts", Math.abs(up.at(-1)!.deg - TILT) < 1e-6, up.at(-1));
  check("tilt-arrow-follows-retilt", up.every((f) => f.off < 0.75), up);
  check("tilt-edit-no-undo-step", h.board().cards.find((c) => c.id === "n")?.tilt === true);
});

test("tiltShortcutMultiSelect", async () => {
  const h = await open({ board: board(), light, w: 1200, h: 700 });
  const pg = h.page;
  const ids = h.board().cards.map((c) => c.id);
  await pg.mouse.click(600, 640);
  await pg.keyboard.press("Meta+a");
  await pg.keyboard.press("Alt+Shift+KeyT");
  await until(h, "both cards tilted", () => h.board().cards.every((c) => c.tilt));
  await idle(h);
  const turned = await pg.evaluate((ids) => ids.map((id) => getComputedStyle(document.querySelector(`.card[data-id="${id}"]`)!).rotate), ids);
  check("tilt-shortcut-turns-all", turned.every((r) => Math.abs(parseFloat(r) - TILT) < 0.01), turned);
  await shot(h, "multi");
  // the menu for a multi-selection has it too, checked; it turns them all back
  await pg.locator('.card[data-id="n"] .nbody').click({ button: "right" });
  const item = pg.locator(".ctx button[role=menuitem]", { hasText: /^Tilt/ });
  check("tilt-multi-menu-checked", await item.locator(".ck svg").count() === 1);
  await item.click();
  await until(h, "both cards straight again", () => h.board().cards.every((c) => !c.tilt));
  // ⌥T stays Tidy Up
  await pg.keyboard.press("Meta+a");
  await pg.keyboard.press("Alt+KeyT");
  await idle(h);
  check("tilt-alt-t-is-not-tilt", h.board().cards.every((c) => !c.tilt));
});

test("tiltAcrossThemes", async () => {
  // the angle and the arrow's edge are shared geometry: every theme turns the card and keeps the arrow on its turned edge
  for (const [theme] of THEMES) {
    const h = await open({ board: board(true), light, w: 1200, h: 700, settings: { theme } });
    const p = await probe(h);
    check(`tilt-theme-${theme}`, Math.abs(p.deg - TILT) < 0.01 && Math.abs(p.ports - TILT) < 0.3 && p.off < 0.75, p);
    await shot(h, `theme-${theme}`);
    await h.close();
  }
});

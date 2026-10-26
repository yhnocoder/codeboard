// Arrows sit under the cards (npm run harness -- arrowsUnderCards [--light], HARNESS_CITY=1 for the City theme): every arrow is drawn below all cards, so any card it
// crosses covers it, whatever the b.cards order; the line port dots stay visible above their card; the selected arrow, the arrows of the
// hovered card and the arrow being dragged float above all cards while that lasts. Checks look at what is really on top (hit test).
import * as fs from "node:fs";
import * as path from "node:path";
import { symCard, findSym, put, OUT, type Host } from "../harness";
import { emptyBoard, type CodeCard } from "@codeboard/core";
import { test, open, check, light, until, idle } from "../fixtures";

const city = !!process.env.HARNESS_CITY;
const SHOTS = process.env.STACK_SHOTS ?? path.join(OUT, "arrows-under-cards");
const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; return s.start + Math.max(0, s.text.findIndex((t) => re.test(t))); };

async function snap(h: Host, name: string) {
  await idle(h);
  try { fs.mkdirSync(SHOTS, { recursive: true }); await h.page.screenshot({ path: `${SHOTS}/${name}${city ? "-city" : ""}-${light ? "light" : "dark"}.png` }); }
  catch (e) { console.log("(no screenshot)", (e as Error).message); }
}

test("arrowsUnderCards", async () => {
  // A → B is one arrow. On its way it crosses D (first in b.cards, below A and B) and then C (last in b.cards, in front)
  const b = emptyBoard("b1", "stacking");
  const A = card("LLMEngine.step"), B = card("Scheduler.schedule"), C = card("ModelRunner.__init__"), D = card("Sequence.__len__");
  put(b, D, 650, 100, 260); put(b, A, 80, 80, 500); put(b, B, 1400, 80, 480); put(b, C, 990, 20, 330);
  const s0 = A.segments[0];
  b.links.push({ id: "AB", from: { card: A.id, seg: s0.id, line: lineOf(A, /scheduler\.schedule\(/) }, to: { card: B.id }, call: { name: "schedule", col: 0 } });
  b.cam = { x: 0, y: 0, z: 0.7 };
  const h = await open({ board: b, light, w: 1400, h: 800, settings: city ? { theme: "city" } as any : undefined });
  await idle(h);
  const lifted = () => h.page.evaluate(() => !!document.querySelector('g.link[data-lk="AB"]')?.closest(".lyr.top"));
  /** Whether the arrow is in the top layer, once it is where it should be: dropping comes linkLeave after the pointer left a card */
  const settled = async (top: boolean) => {
    await until(h, top ? "the arrow is lifted above the cards" : "the arrow is back under the cards", async () => (await lifted()) === top);
    await idle(h);
  };
  /** Pointer to an empty corner; `top`: the arrow stays lifted (it is selected) */
  const away = async (top = false) => { await h.page.mouse.move(6, 790); await settled(top); };
  // What is really on top of the arrow inside C, inside D and in the gap between A and D; whether the arrow is lifted;
  // whether the line port at A's edge paints above A
  const probe = () => h.page.evaluate(([a, c, d]) => {
    const g = document.querySelector<SVGGElement>('g.link[data-lk="AB"]')!;
    const p = g.querySelector<SVGPathElement>("path.edge")!;
    const m = p.getScreenCTM()!, at = (f: number) => { const q = p.getPointAtLength(p.getTotalLength() * f); return { x: q.x * m.a + m.e, y: q.y * m.d + m.f }; };
    const box = (id: string) => document.querySelector(`.card[data-id="${id}"]`)!.getBoundingClientRect();
    const inside = (q: { x: number; y: number }, r: DOMRect, k: number) => q.x > r.left + k && q.x < r.right - k && q.y > r.top + k && q.y < r.bottom - k;
    const ra = box(a), rc = box(c), rd = box(d);
    let onC: { x: number; y: number } | null = null, onD: { x: number; y: number } | null = null, gap: { x: number; y: number } | null = null;
    for (let f = 0.01; f < 1; f += 0.005) {
      const q = at(f);
      if (!onC && inside(q, rc, 12)) onC = q;
      if (!onD && inside(q, rd, 12)) onD = q;
      if (!gap && q.x > ra.right + 14 && q.x < rd.left - 14) gap = q;
    }
    const hit = (q: { x: number; y: number } | null) => {
      if (!q) return "none";
      const e = document.elementFromPoint(q.x, q.y);
      return e?.closest("[data-link]")?.getAttribute("data-link") ?? e?.closest(".card")?.getAttribute("data-id") ?? e?.tagName ?? "";
    };
    const slot = (x: Element) => { while (x.parentElement && !x.parentElement.classList.contains("world")) x = x.parentElement; return x; };
    const zi = (x: Element) => { const z = getComputedStyle(x).zIndex; return z === "auto" ? 0 : +z; };
    const above = (x: Element, y: Element) => { const sx = slot(x), sy = slot(y); return zi(sx) !== zi(sy) ? zi(sx) > zi(sy) : !!(sy.compareDocumentPosition(sx) & Node.DOCUMENT_POSITION_FOLLOWING); };
    const port = document.querySelector('[data-lk="AB"] path.port');
    return {
      onC: hit(onC), onD: hit(onD), gap: hit(gap),
      top: !!g.closest(".lyr.top"),
      portUp: !port || getComputedStyle(port).display === "none" || above(port, document.querySelector(`.card[data-id="${a}"]`)!),
      near: gap ?? at(0.03),
    };
  }, [A.id, C.id, D.id]);
  const name = (s: string) => (s === "AB" ? "arrow" : s === A.id ? "A" : s === B.id ? "B" : s === C.id ? "C" : s === D.id ? "D" : s);
  const look = async () => { const p = await probe(); return { ...p, onC: name(p.onC), onD: name(p.onD), gap: name(p.gap) }; };
  const order = () => h.board().cards.map((c) => name(c.id)).join("");
  const pick = async (id: string) => {
    const k = (await h.page.locator(`.card[data-id="${id}"] .chead .kind`).boundingBox())!;
    await h.page.mouse.click(k.x + 4, k.y + 4);
    await h.page.locator(`.card.sel[data-id="${id}"]`).waitFor();
  };
  const arrange = async (id: string, keys: string) => {
    const was = order();
    await pick(id); await h.page.keyboard.press(keys);
    await until(h, `${keys} reorders the cards`, () => order() !== was);
    await away();
  };

  await away();
  let p = await look();
  check("front-card-covers-arrow", p.onC === "C" && p.gap === "arrow" && !p.top, { ...p, order: order() });
  await snap(h, "1-front-card-covers");
  check("lower-unrelated-card-covers-arrow", p.onD === "D", { ...p, order: order() });
  await snap(h, "2-lower-card-covers");
  check("line-port-above-its-card", p.portUp, p);

  // Lifting / dropping is a cross-fade, not a cut: a copy stays in the old layer while the arrow fades in on top (or the copy fades out
  // on top). Samples every frame for 800 ms (the drop comes linkLeave = 300 ms after the pointer leaves): the arrow's own opacity, and where the copies are
  const watch = () => h.page.evaluate(() => { (window as any).__fade = new Promise((done) => {
    const out: { op: number; ghostTop: number; ghostBottom: number }[] = [], t0 = performance.now();
    const tick = () => {
      const g = document.querySelector('g.link[data-lk="AB"]')!.parentElement!;
      out.push({ op: +getComputedStyle(g).opacity, ghostTop: document.querySelectorAll(".lyr.top .ghost").length, ghostBottom: document.querySelectorAll(".lyr.bottom .ghost").length });
      if (performance.now() - t0 < 800) requestAnimationFrame(tick); else done(out);
    };
    requestAnimationFrame(tick);
  }); });
  const fade = async () => {
    const f = (await h.page.evaluate(() => (window as any).__fade)) as { op: number; ghostTop: number; ghostBottom: number }[];
    const last = f[f.length - 1];
    return { mid: f.some((x) => x.op > 0.05 && x.op < 0.95), up: f.some((x) => x.ghostBottom > 0), down: f.some((x) => x.ghostTop > 0), clean: !last.ghostTop && !last.ghostBottom && last.op === 1, frames: f.length };
  };

  // hover an endpoint card: its arrows float to the top, and go back when the pointer leaves
  const ab = (await h.page.locator(`.card[data-id="${A.id}"]`).boundingBox())!;
  await watch();
  await h.page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2);
  let fd = await fade();
  check("lift-fades-in", fd.mid && fd.up && !fd.down && fd.clean, fd);
  p = await look();
  check("hover-card-lifts-its-arrows", p.onC === "arrow" && p.onD === "arrow" && p.top, p);
  await snap(h, "3-hover-lifts");
  await watch();
  await away();
  fd = await fade();
  check("drop-fades-out", fd.down && !fd.up && fd.clean, fd);
  p = await look();
  check("hover-ends-arrow-back", p.onC === "C" && !p.top, p);

  // The browser does not always deliver pointerleave (card moved / re-ordered under the pointer, pointer capture just released, a busy
  // machine): the hover must still end once the pointer moves somewhere outside the card. Swallow every pointerleave before it reaches
  // the card (window, capture phase), hover A, move away: the arrows still drop, with the same fade
  await h.page.evaluate(() => { (window as any).__eat = (e: Event) => e.stopPropagation(); window.addEventListener("pointerleave", (window as any).__eat, true); });
  await h.page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2); await settled(true);
  p = await look();
  check("lost-leave-hover-lifts", p.top, p);
  await watch();
  await h.page.mouse.move(6, 790);
  fd = await fade();
  await settled(false);
  p = await look();
  check("lost-leave-hover-still-ends", p.onC === "C" && !p.top && fd.down && !fd.up && fd.clean, { ...p, ...fd });
  await h.page.evaluate(() => window.removeEventListener("pointerleave", (window as any).__eat, true));

  // hover the unrelated card C: nothing changes
  const cb = (await h.page.locator(`.card[data-id="${C.id}"]`).boundingBox())!;
  // a lift would start on pointerenter (no delay): the board is idle once it would have run its fade
  await h.page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height - 20); await idle(h);
  p = await look();
  check("hover-other-card-no-lift", p.onC === "C" && !p.top, p);
  await away();

  // select the arrow (click it in the gap between A and D): it floats to the top until the selection goes
  await h.page.mouse.click(p.near.x, p.near.y); await away(true);
  p = await look();
  check("selected-arrow-lifts", p.onC === "arrow" && p.top, p);
  await snap(h, "4-selected-lifts");
  await h.page.keyboard.press("Escape"); await away();
  p = await look();
  check("deselect-arrow-back", p.onC === "C" && !p.top, p);

  // Arrange does not matter: the arrow stays under every card it crosses
  await arrange(C.id, "Meta+Shift+BracketLeft"); // C to back: CDAB
  p = await look();
  check("card-sent-back-still-covers", order() === "CDAB" && p.onC === "C" && p.onD === "D" && p.gap === "arrow", { order: order(), ...p });
  await arrange(A.id, "Meta+Shift+BracketRight"); // CDBA: an endpoint card to front does not take its arrow along
  p = await look();
  check("endpoint-to-front-arrow-stays-under", order() === "CDBA" && p.onC === "C" && p.onD === "D" && p.gap === "arrow", { order: order(), ...p });
  await snap(h, "5-after-arrange");
  await h.page.context().close();
});

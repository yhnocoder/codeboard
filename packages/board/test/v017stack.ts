// Arrows sit under the cards (node run-harness.mjs v17stack [--light] [--city]): every arrow is drawn below all cards, so any card it
// crosses covers it, whatever the b.cards order; the line port dots stay visible above their card; the selected arrow, the arrows of the
// hovered card and the arrow being dragged float above all cards while that lasts. Checks look at what is really on top (hit test).
import * as fs from "node:fs";
import * as path from "node:path";
import { open, symCard, findSym, put, OUT, type Host } from "./harness";
import { emptyBoard, type CodeCard } from "@codeboard/core";

const light = process.argv.includes("--light");
const city = process.argv.includes("--city");
const SHOTS = process.env.STACK_SHOTS ?? path.join(OUT, "v017-stack");
const card = (q: string) => { const s = findSym(q); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; return s.start + Math.max(0, s.text.findIndex((t) => re.test(t))); };

let fails = 0;
const check = (ok: boolean, name: string, data: unknown) => { if (!ok) fails++; console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(data)); };
async function snap(h: Host, name: string) {
  await h.page.waitForTimeout(300);
  try { fs.mkdirSync(SHOTS, { recursive: true }); await h.page.screenshot({ path: `${SHOTS}/${name}${city ? "-city" : ""}-${light ? "light" : "dark"}.png` }); }
  catch (e) { console.log("(no screenshot)", (e as Error).message); }
}

export const V017STACK: Record<string, () => Promise<void>> = {
  async v17stack() {
    // A → B is one arrow. On its way it crosses D (first in b.cards, below A and B) and then C (last in b.cards, in front)
    const b = emptyBoard("b1", "stacking");
    const A = card("LLMEngine.step"), B = card("Scheduler.schedule"), C = card("ModelRunner.__init__"), D = card("Sequence.__len__");
    put(b, D, 650, 100, 260); put(b, A, 80, 80, 500); put(b, B, 1400, 80, 480); put(b, C, 990, 20, 330);
    const s0 = A.segments[0];
    b.links.push({ id: "AB", from: { card: A.id, seg: s0.id, line: lineOf(A, /scheduler\.schedule\(/) }, to: { card: B.id }, call: { name: "schedule", col: 0 } });
    b.cam = { x: 0, y: 0, z: 0.7 };
    const h = await open({ board: b, light, w: 1400, h: 800, settings: city ? { theme: "city" } as any : undefined });
    await h.page.waitForTimeout(600);
    const away = async () => { await h.page.mouse.move(6, 790); await h.page.waitForTimeout(500); };
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
      await h.page.mouse.click(k.x + 4, k.y + 4); await h.page.waitForTimeout(150);
    };
    const arrange = async (id: string, keys: string) => { await pick(id); await h.page.keyboard.press(keys); await away(); await h.page.waitForTimeout(900); };

    await away();
    let p = await look();
    check(p.onC === "C" && p.gap === "arrow" && !p.top, "front-card-covers-arrow", { ...p, order: order() });
    await snap(h, "1-front-card-covers");
    check(p.onD === "D", "lower-unrelated-card-covers-arrow", { ...p, order: order() });
    await snap(h, "2-lower-card-covers");
    check(p.portUp, "line-port-above-its-card", p);

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
    check(fd.mid && fd.up && !fd.down && fd.clean, "lift-fades-in", fd);
    p = await look();
    check(p.onC === "arrow" && p.onD === "arrow" && p.top, "hover-card-lifts-its-arrows", p);
    await snap(h, "3-hover-lifts");
    await watch();
    await away();
    fd = await fade();
    check(fd.down && !fd.up && fd.clean, "drop-fades-out", fd);
    p = await look();
    check(p.onC === "C" && !p.top, "hover-ends-arrow-back", p);

    // hover the unrelated card C: nothing changes
    const cb = (await h.page.locator(`.card[data-id="${C.id}"]`).boundingBox())!;
    await h.page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height - 20); await h.page.waitForTimeout(150);
    p = await look();
    check(p.onC === "C" && !p.top, "hover-other-card-no-lift", p);
    await away();

    // select the arrow (click it in the gap between A and D): it floats to the top until the selection goes
    await h.page.mouse.click(p.near.x, p.near.y); await away();
    p = await look();
    check(p.onC === "arrow" && p.top, "selected-arrow-lifts", p);
    await snap(h, "4-selected-lifts");
    await h.page.keyboard.press("Escape"); await away();
    p = await look();
    check(p.onC === "C" && !p.top, "deselect-arrow-back", p);

    // Arrange does not matter: the arrow stays under every card it crosses
    await arrange(C.id, "Meta+Shift+BracketLeft"); // C to back: CDAB
    p = await look();
    check(order() === "CDAB" && p.onC === "C" && p.onD === "D" && p.gap === "arrow", "card-sent-back-still-covers", { order: order(), ...p });
    await arrange(A.id, "Meta+Shift+BracketRight"); // CDBA: an endpoint card to front does not take its arrow along
    p = await look();
    check(order() === "CDBA" && p.onC === "C" && p.onD === "D" && p.gap === "arrow", "endpoint-to-front-arrow-stays-under", { order: order(), ...p });
    await snap(h, "5-after-arrange");
    console.log(fails ? "FAIL" : "PASS", "v17stack", fails ? `${fails} failed` : "all");
    await h.page.context().browser()!.close();
  },
};

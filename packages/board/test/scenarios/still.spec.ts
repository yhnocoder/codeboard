//  stillBoardPicture — a board booted as a still picture (BoardOptions.still, the phone viewer's tiles): none of the editing
//                      chrome (toolbar, dock, breadcrumbs, pan shield, the detent's mist), no link ports, grips or card menus
//                      shown; the still API's view() moves the camera and resolves drawn, below Simplify Below with the
//                      prose still text (no .greek), at the board's smallest zoom with the summary level shown, and further
//                      out than someone zooming can go;
//                      layout() covers every card, Section and measured summary column (as the page draws them), names the
//                      sub-board card with its board and rect, and gives the paper colour
import { emptyBoard, putSummary, summarySig, type NoteCard, type Section } from "@codeboard/core";
import { put, type Host } from "../harness";
import { test, open, check } from "../fixtures";
import type { StillCam, StillLayout } from "../../src/still";

const note = (id: string, md: string): NoteCard => ({ id, kind: "note", md, look: "note" });

function board() {
  const b = emptyBoard("bStill", "still");
  ["并行", "内存"].forEach((t, i) => {
    const s: Section = { id: `s${i}`, title: t, x: 80 + i * 1700, y: 80, w: 1500, h: 900 };
    b.sections.push(s);
    for (let j = 0; j < 2; j++) {
      const n = note(`n${i}${j}`, `# ${t} ${j + 1}\n\nGPU 用大量小算术单元换**吞吐**，CPU 用大缓存换延迟。`);
      put(b, n, s.x + 60 + j * 700, s.y + 100, 620);
      b.place[n.id].section = s.id;
    }
  });
  b.cards.push({ id: "fSub", kind: "board", board: "bChild" });
  b.place.fSub = { x: 80, y: 1200, w: 620, h: 420 };
  b.links.push({ id: "l1", from: { card: "n00" }, to: { card: "n10" } });
  for (const k of ["sec:s0", "sec:s1"])
    putSummary(b, k, { text: `众线程押**吞吐量**（${k}）。`, at: Date.now(), sig: summarySig(b, k)! });
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

const still = {
  view: (h: Host, c: StillCam) => h.page.evaluate((c) => (window as any).__still.view(c) as Promise<StillCam>, c),
  layout: (h: Host) => h.page.evaluate(() => (window as any).__still.layout() as StillLayout),
};
const inside = (o: { x: number; y: number; w: number; h: number }, r: { x: number; y: number; w: number; h: number }) =>
  r.x >= o.x - 0.5 && r.y >= o.y - 0.5 && r.x + r.w <= o.x + o.w + 0.5 && r.y + r.h <= o.y + o.h + 0.5;

test("stillBoardPicture", async () => {
  const b = board();
  const h = await open({ board: b, still: true, light: true, w: 1024, h: 1024 });
  const p = h.page;
  check("stillBoardPicture the board is marked still", (await p.locator(".app.still").count()) === 1);
  const chrome = await p.evaluate(() =>
    [".bbar", ".dock", ".crumbs", ".pshield", ".cutmist", ".cutseal", ".toast", ".mast", ".banner"].filter((s) =>
      document.querySelector(s),
    ),
  );
  check("stillBoardPicture no editing chrome", chrome.length === 0, chrome);
  const shown = await p.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".port, .porthit, .eport, .lport, .grip, .sgrip, .cmenu")]
      .filter((e) => e.checkVisibility())
      .map((e) => e.className.baseVal ?? e.className),
  );
  check("stillBoardPicture no ports, grips or card menus shown", shown.length === 0, shown);

  const l = await still.layout(h);
  const cards = Object.entries(b.place).map(([id, q]) => ({ id, x: q.x, y: q.y, w: q.w, h: 0 }));
  check(
    "stillBoardPicture layout covers every card and Section",
    [...cards, ...b.sections].every((r) => inside(l.world, r)),
    l.world,
  );
  check(
    "stillBoardPicture layout names the sub-board card",
    l.subs.length === 1 && l.subs[0].board === "bChild" && l.subs[0].rect.x === 80 && l.subs[0].rect.y === 1200,
    l.subs,
  );
  check("stillBoardPicture layout gives the paper colour", /^#[0-9a-f]{6}$/.test(l.bg), l.bg);

  const mid = await still.view(h, { x: 0, y: 0, z: 0.3 });
  check(
    "stillBoardPicture below Simplify Below the prose stays text",
    mid.z === 0.3 &&
      (await p.locator(".world.greek").count()) === 0 &&
      (await p.locator(".world.settle").count()) === 1,
    mid,
  );

  const floor = await still.view(h, { x: 0, y: 0, z: l.minZoom });
  check("stillBoardPicture views the board's own smallest zoom", Math.abs(floor.z - l.minZoom) < 1e-9, { floor, l });
  check(
    "stillBoardPicture at its smallest zoom the summary level shows",
    (await p.locator(".cardlay.gone").count()) === 1,
  );
  const low = await still.view(h, { x: 0, y: 0, z: l.minZoom / 4 });
  check("stillBoardPicture views further out than someone can zoom", Math.abs(low.z - l.minZoom / 4) < 1e-9, low);
  const l2 = await still.layout(h);
  const cols = await p.evaluate((c) => {
    const br = document.getElementById("board")!.getBoundingClientRect();
    return [...document.querySelectorAll(".sumcol")].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        x: (r.left - br.left - c.x) / c.z,
        y: (r.top - br.top - c.y) / c.z,
        w: r.width / c.z,
        h: r.height / c.z,
      };
    });
  }, low);
  check(
    "stillBoardPicture layout covers the summary columns as drawn",
    cols.length === 2 && cols.every((r) => inside(l2.world, r)),
    { cols, world: l2.world },
  );
});

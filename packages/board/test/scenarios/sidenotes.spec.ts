// Sidenotes on code cards:
//  sidenoteAlwaysShowFits       an Always Show sidenote (shown under its line) wraps inside the card's visible width, not the code's
//                               scroll width: never past the card's right edge, never widens the code (no horizontal scrollbar).
//                               ⌥F counts it at the fitted width: from a wide and from a narrow card, the fitted 30-line card (taller
//                               than the cap, so its height is stored) ends right under its last line, no scrollbar (Warm Ink)
//  sidenoteAlwaysShowResize     dragging the corner of that card down and up: its height follows the pointer, it never drops to the
//                               cap for cards without a stored height
//  sidenotePopoverBelowLines    clicking a gutter marker opens the Highlight popover below the lines it marks (not over them); near the
//                               bottom of the window, above them. Its text has no "Double-click to edit" tip
//  sidenoteCardPreview          a Card sidenote's eye in the popover: resting on it shows, beside the popover, a copy of that Note card as
//                               the board draws it, with its text; leaving the eye hides it
//  sidenoteAlwaysShowRefits     a card fitted to its content (⌥F; taller than the cap, so its height is stored) grows and shrinks with
//                               its sidenote as Always Show is turned off and on in the popover, and as the shown sidenote's text is
//                               edited: it still ends right under its last line, no scrollbar; each is one undo step. A card with a
//                               height set by hand keeps it
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS, emptyBoard, type Board, type CodeCard } from "@codeboard/core";
import { put, OUT, type Host } from "../harness";
import { test, open, check, light, until, idle } from "../fixtures";

const KERNEL = [
  "#define TILE_WIDTH 16",
  "__global__ void matrixMulKernel(float* M, float* N, float* P, int Width) {",
  "",
  "    __shared__ float Mds[TILE_WIDTH][TILE_WIDTH];",
  "    __shared__ float Nds[TILE_WIDTH][TILE_WIDTH];",
  "",
  "    int bx = blockIdx.x; int by = blockIdx.y;",
  "    int tx = threadIdx.x; int ty = threadIdx.y;",
  "",
  "    // Determine the row and column of the P element to work on",
  "    int Row = by * TILE_WIDTH + ty;",
  "    int Col = bx * TILE_WIDTH + tx;",
  "",
  "    // Loop over the M and N tiles required to compute P element",
  "    float Pvalue = 0;",
  "    for (int ph = 0; ph < Width/TILE_WIDTH; ++ph) {",
  "",
  "        // Collaborative loading of M and N tiles into shared memory",
  "        Mds[ty][tx] = M[Row*Width + ph*TILE_WIDTH + tx];",
  "        Nds[ty][tx] = N[(ph*TILE_WIDTH + ty)*Width + Col];",
  "        __syncthreads();",
  "",
  "        for (int k = 0; k < TILE_WIDTH; ++k) {",
  "            Pvalue += Mds[ty][k] * Nds[k][tx];",
  "        }",
  "        __syncthreads();",
  "",
  "    }",
  "    P[Row*Width + Col] = Pvalue;",
  "}",
];
const NOTE =
  "循环遍历计算 $P$ 元素所需的所有阶段。循环变量 `ph` 表示已经完成的阶段数量；每个阶段使用一个 $M$ tile 和一个 $N$ tile，" +
  "因此在阶段开始时，前面阶段已经处理了 `ph*TILE_WIDTH` 对 $M$、$N$ 元素。";

function board(w: number, y = 40): Board {
  const b = emptyBoard("b1", "sidenotes");
  const c = {
    id: "k1",
    kind: "code",
    title: "matrixMulKernel",
    segments: [
      {
        id: "s1",
        src: { kind: "free" },
        path: "",
        lang: "cuda",
        start: 1,
        end: KERNEL.length,
        text: KERNEL.slice(),
        version: { kind: "none" },
        hl: [
          [7, 8],
          [16, 16],
        ],
      },
    ],
  } as CodeCard;
  put(b, c, 60, y, w);
  b.sidenotes.push({
    id: "n1",
    kind: "text",
    md: NOTE,
    alwaysShow: true,
    at: { card: "k1", seg: "s1", lines: [16, 16] },
  });
  b.sidenotes.push({
    id: "n2",
    kind: "text",
    md: "自动标量变量位于寄存器，作用域是单个线程。",
    at: { card: "k1", seg: "s1", lines: [7, 8] },
  });
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
async function save(h: Host, name: string, sel = '.card[data-id="k1"]') {
  const file = path.join(OUT, `${name}.png`);
  const bs = (await Promise.all((await h.page.locator(sel).all()).map((l) => l.boundingBox()))).filter((b) => !!b);
  const x = Math.max(0, Math.min(...bs.map((b) => b.x)) - 24),
    y = Math.max(0, Math.min(...bs.map((b) => b.y)) - 24);
  await h.page.screenshot({
    path: file,
    clip: {
      x,
      y,
      width: Math.max(...bs.map((b) => b.x + b.width)) + 24 - x,
      height: Math.min(Math.max(...bs.map((b) => b.y + b.height)) + 24 - y, 900),
    },
  });
  const d = process.env.SHOTS_DIR;
  if (d) {
    fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(file, path.join(d, `${name}.png`));
  }
}
/** The card's code area and its Always Show sidenote, on screen */
const layout = (h: Host) =>
  h.page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.card[data-id="k1"]')!,
      b = card.querySelector<HTMLElement>(".cbody")!,
      n = b.querySelector<HTMLElement>(".inote");
    const br = b.getBoundingClientRect(),
      nr = n?.getBoundingClientRect() ?? { right: 0, height: 0 };
    const ls = [...b.querySelectorAll<HTMLElement>(".src > .l")];
    const last = ls[ls.length - 1].getBoundingClientRect();
    return {
      w: card.offsetWidth,
      h: card.offsetHeight,
      noteRight: Math.round(nr.right),
      noteH: Math.round(nr.height),
      // the visible right edge of the code area (without a vertical scrollbar)
      visRight: Math.round(br.left + b.clientLeft + b.clientWidth),
      lastBottom: Math.round(last.bottom),
      visBottom: Math.round(br.top + b.clientTop + b.clientHeight),
      hscroll: b.scrollWidth > b.clientWidth + 1,
      vscroll: b.scrollHeight > b.clientHeight + 1,
    };
  });
async function setWarmInk(h: Host) {
  await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, theme: "warm-ink" } } as never });
  await idle(h);
}
async function fit(h: Host) {
  const hd = (await h.page.locator('.card[data-id="k1"] .chead').boundingBox())!;
  await h.page.mouse.click(hd.x + 40, hd.y + hd.height / 2);
  await idle(h);
  await h.page.keyboard.press("Alt+KeyF");
  await idle(h);
}

test("sidenoteAlwaysShowFits", async () => {
  const out: Record<string, unknown> = {};
  let ok = true;
  // a card narrower than its code (the code scrolls sideways) and one much wider
  for (const w0 of [380, 900]) {
    const h = await open({ board: board(w0), light, w: 1200, h: 1000, settings: { theme: "warm-ink" } as never });
    await setWarmInk(h);
    const before = await layout(h);
    if (w0 === 380) await save(h, "sidenotes-alwaysshow-narrow");
    // inside the card's visible width, 28px or more from its right edge (the code's right room and its own margin)
    const inside = before.noteRight <= before.visRight - 28;
    await fit(h);
    const after = await layout(h);
    const place = h.board().place.k1;
    if (w0 === 380) await save(h, "sidenotes-alwaysshow-fitted");
    const fitted =
      !after.hscroll &&
      !after.vscroll &&
      after.lastBottom <= after.visBottom &&
      // and no room left under it: the code area's bottom padding (8px) only, measured with the sidenote at the fitted width
      after.visBottom - after.lastBottom <= 9 &&
      after.noteRight <= after.visRight - 28 &&
      typeof place.h === "number";
    out[w0] = { before, after, place, inside, fitted };
    ok &&= inside && fitted;
    await h.close();
  }
  check("sidenoteAlwaysShowFits the sidenote wraps inside the card; ⌥F shows every line, no scrollbar", ok, out);
});

test("sidenoteAlwaysShowResize", async () => {
  const h = await open({ board: board(380), light, w: 1200, h: 1000, settings: { theme: "warm-ink" } as never });
  await setWarmInk(h);
  await fit(h);
  const pg = h.page;
  await pg.hover('.card[data-id="k1"] .cbody');
  await idle(h);
  const g = (await pg.locator('.card[data-id="k1"] .grip').boundingBox())!;
  const h0 = (await layout(h)).h;
  const x = g.x + g.width / 2,
    y = g.y + g.height / 2;
  await pg.mouse.move(x, y);
  await pg.mouse.down();
  // down 40px, then up 120px, 4px a move: the card's height follows the pointer the whole way
  const bad: unknown[] = [];
  const steps = [
    ...Array.from({ length: 10 }, (_, i) => (i + 1) * 4),
    ...Array.from({ length: 30 }, (_, i) => 36 - i * 4),
  ];
  for (const dy of steps) {
    await pg.mouse.move(x, y + dy);
    await idle(h);
    const now = (await layout(h)).h;
    // snapping to other cards' edges may move it a few px
    if (Math.abs(now - (h0 + dy)) > 10) bad.push({ dy, now, want: h0 + dy });
  }
  await pg.mouse.up();
  await idle(h);
  check("sidenoteAlwaysShowResize the card's height follows the dragged corner", bad.length === 0, { h0, bad });
});

test("sidenotePopoverBelowLines", async () => {
  const res: Record<string, unknown> = {};
  let ok = true;
  // near the top of the window (room below the lines) and with lines 7–8 near its bottom (no room below)
  for (const [where, y] of [
    ["top", 40],
    ["bottom", 640],
  ] as const) {
    const h = await open({ board: board(560, y), light, w: 1200, h: 900, settings: { theme: "warm-ink" } as never });
    await setWarmInk(h);
    const pg = h.page;
    await pg.locator('.card[data-id="k1"] .hxm[data-hl="k1:s1:7-8"]').click();
    await until(h, "the Highlight popover is open", () => pg.locator(".pop.k-highlight").count());
    await idle(h);
    const r = await pg.evaluate(() => {
      const p = document.querySelector<HTMLElement>(".pop.k-highlight")!.getBoundingClientRect();
      const ls = [...document.querySelectorAll<HTMLElement>('.card[data-id="k1"] .src > .l')];
      const lines = [ls[6], ls[7]].map((l) => l.getBoundingClientRect());
      const hit = lines.some((l) => l.top < p.bottom && l.bottom > p.top && l.left < p.right && l.right > p.left);
      return {
        pop: { top: Math.round(p.top), bottom: Math.round(p.bottom), left: Math.round(p.left) },
        lines: lines.map((l) => ({ top: Math.round(l.top), bottom: Math.round(l.bottom) })),
        hit,
        below: p.top >= lines[1].bottom,
        above: p.bottom <= lines[0].top,
        inWindow: p.top >= 0 && p.bottom <= innerHeight,
        tips: document.querySelectorAll(".pop.k-highlight .nbody[data-tip]").length,
      };
    });
    if (where === "top") await save(h, "sidenotes-popover-below");
    res[where] = r;
    ok &&= !r.hit && r.inWindow && (where === "top" ? r.below : r.above) && r.tips === 0;
    await h.close();
  }
  check(
    "sidenotePopoverBelowLines the popover leaves the marked lines visible: below them, above near the bottom",
    ok,
    res,
  );
});

test("sidenoteCardPreview", async () => {
  const b = board(560);
  put(
    b,
    {
      id: "nc",
      kind: "note",
      look: "note",
      md: "## 声明变量所处的内存\n\n把 `Mds` 和 `Nds` 声明为 shared memory 数组。",
    } as never,
    700,
    40,
    360,
  );
  (b.cards[0] as CodeCard).segments[0].hl!.unshift([4, 4]);
  b.sidenotes.push({ id: "n3", kind: "card", card: "nc", at: { card: "k1", seg: "s1", lines: [4, 4] } });
  const h = await open({ board: b, light, w: 1400, h: 900, settings: { theme: "warm-ink" } as never });
  await setWarmInk(h);
  const pg = h.page;
  await pg.locator('.card[data-id="k1"] .hxm[data-hl="k1:s1:4-4"]').click();
  await until(h, "the Highlight popover is open", () => pg.locator(".pop.k-highlight").count());
  await idle(h);
  const eye = pg.locator(".pop.k-highlight .sn-peek");
  if ((await eye.count()) !== 1) {
    check("sidenoteCardPreview the Card sidenote has a preview eye", false);
    return;
  }
  await eye.hover();
  await pg.locator(".cpeek.show").waitFor({ timeout: 5000 });
  await idle(h);
  const shown = await pg.evaluate(() => {
    const pk = document.querySelector<HTMLElement>(".cpeek")!,
      pop = document.querySelector<HTMLElement>(".pop.k-highlight")!.getBoundingClientRect(),
      r = pk.getBoundingClientRect();
    return {
      text: pk.textContent ?? "",
      // a copy of the card as the board draws it, which nothing looking for the board's cards finds
      card: !!pk.querySelector(".card .nbody") && !pk.querySelector("[data-id]"),
      w: Math.round(r.width),
      h: Math.round(r.height),
      beside: r.left >= pop.right || r.right <= pop.left,
      cards: document.querySelectorAll('.card[data-id="nc"]').length,
    };
  });
  await save(h, "sidenotes-card-preview", ".pop.k-highlight, .cpeek");
  await pg.mouse.move(20, 880);
  await until(h, "the preview is gone", async () => (await pg.locator(".cpeek").count()) === 0);
  check(
    "sidenoteCardPreview resting on the eye shows the card beside the popover, leaving hides it",
    shown.text.includes("shared memory") &&
      shown.card &&
      shown.beside &&
      shown.cards === 1 &&
      shown.w <= 444 &&
      shown.h <= 384,
    shown,
  );
});

test("sidenoteAlwaysShowRefits", async () => {
  const h = await open({ board: board(380), light, w: 1200, h: 1000, settings: { theme: "warm-ink" } as never });
  await setWarmInk(h);
  const pg = h.page;
  await fit(h);
  const snap = async () => ({
    ...(await layout(h)),
    ph: h.board().place.k1.h ?? null,
    on: !!(h.board().sidenotes[0] as { alwaysShow?: boolean }).alwaysShow,
  });
  /** ends right under its last line (the code area's 8px bottom padding), no scrollbar */
  const fits = (s: Awaited<ReturnType<typeof snap>>) =>
    !s.vscroll && !s.hscroll && s.lastBottom <= s.visBottom && s.visBottom - s.lastBottom <= 9;
  const fitted = await snap();
  await save(h, "sidenotes-refit-on-before");
  const toggle = async () => {
    const was = !!(h.board().sidenotes[0] as { alwaysShow?: boolean }).alwaysShow;
    if (!(await pg.locator(".pop.k-highlight").count())) {
      await pg.locator('.card[data-id="k1"] .hxm[data-hl="k1:s1:16-16"]').click();
      await until(h, "the Highlight popover is open", () => pg.locator(".pop.k-highlight").count());
    }
    await pg.locator('.pop.k-highlight .slip button[aria-label="Always Show"]').click();
    await until(
      h,
      "Always Show is toggled",
      () => !!(h.board().sidenotes[0] as { alwaysShow?: boolean }).alwaysShow !== was,
    );
    await idle(h);
    return snap();
  };
  const off = await toggle();
  await pg.keyboard.press("Escape");
  await idle(h);
  await save(h, "sidenotes-refit-off-after");
  const on = await toggle();
  await pg.keyboard.press("Escape");
  await idle(h);
  await save(h, "sidenotes-refit-on-after");
  // one undo step: Always Show and the height together
  await pg.mouse.click(1150, 950);
  await pg.keyboard.press("ControlOrMeta+z");
  await until(h, "the toggle is undone", () => !(h.board().sidenotes[0] as { alwaysShow?: boolean }).alwaysShow);
  await idle(h);
  const undone = await snap();
  await pg.keyboard.press("ControlOrMeta+Shift+z");
  await until(h, "the toggle is redone", () => !!(h.board().sidenotes[0] as { alwaysShow?: boolean }).alwaysShow);
  await idle(h);
  // the shown sidenote's text written twice as long: the card grows with it
  await pg.locator('.card[data-id="k1"] .hxm[data-hl="k1:s1:16-16"]').click();
  await until(h, "the Highlight popover is open", () => pg.locator(".pop.k-highlight").count());
  await pg.locator('.pop.k-highlight .slip button[aria-label="Edit"]').click();
  const ta = pg.locator(".pop.k-highlight .sn-edit textarea");
  await ta.waitFor();
  await pg.keyboard.press("ControlOrMeta+End");
  await pg.keyboard.insertText(
    " 每个阶段结束时，所有线程都要等其他线程用完共享内存里的这一块 tile，才能开始加载下一块。",
  );
  await pg.keyboard.press("Escape");
  await until(h, "the longer text is saved", () => (h.board().sidenotes[0] as { md: string }).md.includes("下一块"));
  await pg.keyboard.press("Escape");
  await idle(h);
  const longer = await snap();
  check(
    "sidenoteAlwaysShowRefits a fitted card grows and shrinks with its Always Show sidenote, in one undo step",
    fits(fitted) &&
      !off.on &&
      fits(off) &&
      off.h < fitted.h - 40 &&
      on.on &&
      fits(on) &&
      Math.abs(on.h - fitted.h) <= 1 &&
      !undone.on &&
      Math.abs(undone.h - off.h) <= 1 &&
      fits(undone) &&
      fits(longer) &&
      longer.h > on.h,
    { fitted, off, on, undone, longer },
  );
  await h.close();
  // a height set by hand (shorter than the content: the code scrolls) stays
  const b = board(560);
  b.place.k1.h = 300;
  const h2 = await open({ board: b, light, w: 1200, h: 1000, settings: { theme: "warm-ink" } as never });
  await setWarmInk(h2);
  await h2.page.locator('.card[data-id="k1"] .hxm[data-hl="k1:s1:16-16"]').click();
  await until(h2, "the Highlight popover is open", () => h2.page.locator(".pop.k-highlight").count());
  await h2.page.locator('.pop.k-highlight .slip button[aria-label="Always Show"]').click();
  await until(h2, "Always Show is off", () => !(h2.board().sidenotes[0] as { alwaysShow?: boolean }).alwaysShow);
  await idle(h2);
  check(
    "sidenoteAlwaysShowRefits a card with a height set by hand keeps it",
    h2.board().place.k1.h === 300,
    h2.board().place.k1,
  );
});

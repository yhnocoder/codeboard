// Sidenotes on code cards:
//  sidenoteAlwaysShowFits       an Always Show sidenote (shown under its line) wraps inside the card's visible width, not the code's
//                               scroll width: never past the card's right edge, never widens the code (no horizontal scrollbar).
//                               ⌥F counts it at the fitted width: from a wide and from a narrow card, the fitted 30-line card (taller
//                               than the cap, so its height is stored) ends right under its last line, no scrollbar (Warm Ink)
//  sidenoteAlwaysShowResize     dragging the corner of that card down and up: its height follows the pointer, it never drops to the
//                               cap for cards without a stored height
//  sidenotePopupBesideCard      clicking a gutter marker opens the Highlight popup right of the card, its top level with the lines;
//                               a card too wide for it to fit there: over the card, inside the window. Its text has no tip
//  sidenoteAlwaysShowRefits     a card fitted to its content (⌥F; taller than the cap, so its height is stored) grows and shrinks with
//                               its sidenote as Always Show is turned off and on in the popover, and as the shown sidenote's text is
//                               edited: it still ends right under its last line, no scrollbar; each is one undo step. A card with a
//                               height set by hand keeps it
//  sidenoteAlwaysShowGrowsAutoCard a card with no stored height that shows all its code (under the cap) grows with the Always Show
//                               notes turned on in the popover, past the cap: every line stays in view, no scrollbar; turned off
//                               again it shrinks back to following its content (no stored height), each one undo step
//  sidenoteAlwaysShowGrowsAutoCardCodeEdit the same card grown by its notes, then two lines added to its Free code: it fits the new
//                               code (every line in view); the notes turned off, it follows its content again (no stored height)
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

test("sidenotePopupBesideCard", async () => {
  const res: Record<string, unknown> = {};
  let ok = true;
  // a card with room on its right, and one too wide for the popup to fit beside it in the window
  for (const [where, w] of [
    ["beside", 560],
    ["wide", 1060],
  ] as const) {
    const h = await open({ board: board(w), light, w: 1200, h: 900, settings: { theme: "warm-ink" } as never });
    await setWarmInk(h);
    const pg = h.page;
    await pg.locator('.card[data-id="k1"] .hxm[data-hl="k1:s1:7-8"]').click();
    await until(h, "the Highlight popup is open", () => pg.locator(".pop.k-highlight").count());
    await idle(h);
    const r = await pg.evaluate(() => {
      const p = document.querySelector<HTMLElement>(".pop.k-highlight")!.getBoundingClientRect();
      const c = document.querySelector<HTMLElement>('.card[data-id="k1"]')!.getBoundingClientRect();
      const m = document
        .querySelector<HTMLElement>('.card[data-id="k1"] .hxm[data-hl="k1:s1:7-8"]')!
        .getBoundingClientRect();
      const l = document.querySelectorAll<HTMLElement>('.card[data-id="k1"] .src > .l')[6].getBoundingClientRect();
      const apart = (a: DOMRect, b: DOMRect) =>
        a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
      return {
        pop: {
          left: Math.round(p.left),
          right: Math.round(p.right),
          top: Math.round(p.top),
          bottom: Math.round(p.bottom),
        },
        card: {
          left: Math.round(c.left),
          right: Math.round(c.right),
          top: Math.round(c.top),
          bottom: Math.round(c.bottom),
        },
        line: Math.round(l.top),
        outside: p.left >= c.right,
        clear: apart(p, c) && apart(p, m),
        aligned: Math.abs(p.top - l.top) <= 12,
        inWindow: p.left >= 0 && p.right <= innerWidth && p.top >= 0 && p.bottom <= innerHeight,
        tips: document.querySelectorAll(".pop.k-highlight .nbody[data-tip]").length,
      };
    });
    if (where === "beside") await save(h, "sidenotes-popup-beside", '.card[data-id="k1"], .pop.k-highlight');
    else await save(h, "sidenotes-popup-wide");
    res[where] = r;
    // with room: right of the card, its top at the lines; without: still clear of the card and its count (another side, or the
    // board slid a little to make room), in the window
    ok &&= r.clear && r.inWindow && r.tips === 0 && (where === "beside" ? r.outside && r.aligned : true);
    await h.close();
  }
  check(
    "sidenotePopupBesideCard the popup is right of the card, its top at the lines; with no room there it still covers neither the card nor its count, in the window",
    ok,
    res,
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
  await pg.locator(".pop.k-highlight .sn-edit .md-pm:focus").waitFor();
  await pg.keyboard.press("ControlOrMeta+End");
  await pg.keyboard.insertText(
    " 每个阶段结束时，所有线程都要等其他线程用完共享内存里的这一块 tile，才能开始加载下一块。",
  );
  await pg.keyboard.press("Enter");
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

const VECADD = [
  "void vecAdd(float* A_h, float* B_h, float* C_h, int n) {",
  "    int size = n * sizeof(float);",
  "    float *A_d, *B_d, *C_d;",
  "",
  "    cudaMalloc((void **)&A_d, size);",
  "    cudaMalloc((void **)&B_d, size);",
  "    cudaMalloc((void **)&C_d, size);",
  "",
  "    cudaMemcpy(A_d, A_h, size, cudaMemcpyHostToDevice);",
  "    cudaMemcpy(B_d, B_h, size, cudaMemcpyHostToDevice);",
  "    // Part2: Call kernel - to launch a grid of kernel",
  "    // to perform the actual vector addition",
  "",
  "    cudaMemcpy(C_h, C_d, size, cudaMemcpyDeviceToHost);",
  "",
  "    cudaFree(A_d);",
  "    cudaFree(B_d);",
  "    cudaFree(C_d);",
  "}",
];

/** The vecAdd Free code card at w=640 with no stored height (all its code shown, under the cap), notes on 5–7 and 9–10 not
 *  shown yet; toggle flips one's Always Show in its Highlight's popover */
async function vecAddCard() {
  const b = emptyBoard("b1", "vecadd");
  put(
    b,
    {
      id: "k1",
      kind: "code",
      title: "vecAdd - CUDA - stub",
      segments: [
        {
          id: "s1",
          src: { kind: "free" },
          path: "",
          lang: "cuda",
          start: 1,
          end: VECADD.length,
          text: VECADD.slice(),
          version: { kind: "none" },
          hl: [
            [5, 7],
            [9, 10],
            [14, 14],
            [16, 18],
          ],
        },
      ],
    } as CodeCard,
    60,
    40,
    640,
  );
  const at = (a: number, z: number) => ({ card: "k1", seg: "s1", lines: [a, z] as [number, number] });
  b.sidenotes.push(
    {
      id: "n1",
      kind: "text",
      md: "注意 size 的单位是 bytes，且需要“指针的指针”，因为这里要让 CUDA 帮忙分配内存，且把内存块的起始地址赋值给 `A_d`",
      at: at(5, 7),
    },
    { id: "n2", kind: "text", md: "Host -> Device", at: at(9, 10) },
  );
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({
    board: b,
    light,
    w: 1000,
    h: 1000,
    scale: process.env.SHOTS_DIR ? 2 : 1,
    settings: { theme: "warm-ink" } as never,
  });
  // the user's look: the margin bracket
  await h.post({
    type: "host",
    host: { settings: { ...DEFAULT_SETTINGS, theme: "warm-ink", highlightLook: "bracket" } } as never,
  });
  await idle(h);
  const pg = h.page;
  const shown = (id: string) => !!(h.board().sidenotes.find((n) => n.id === id) as { alwaysShow?: boolean }).alwaysShow;
  const snap = async () => ({ ...(await layout(h)), ph: h.board().place.k1.h ?? null });
  /** every line in view: ends right under its last line (the code area's bottom padding), no scrollbar */
  const all = (s: Awaited<ReturnType<typeof snap>>) =>
    !s.vscroll && s.lastBottom <= s.visBottom && s.visBottom - s.lastBottom <= 9;
  const toggle = async (id: string, hl: string) => {
    const was = shown(id);
    await pg.locator(`.card[data-id="k1"] .hxm[data-hl="k1:s1:${hl}"]`).click();
    await until(h, "the Highlight popover is open", () => pg.locator(".pop.k-highlight").count());
    await pg.locator('.pop.k-highlight .slip button[aria-label="Always Show"]').click();
    await until(h, `Always Show of ${id} is toggled`, () => shown(id) !== was);
    await pg.keyboard.press("Escape");
    await idle(h);
  };
  return { h, pg, shown, snap, all, toggle };
}

test("sidenoteAlwaysShowGrowsAutoCard", async () => {
  const { h, pg, shown, snap, all, toggle } = await vecAddCard();
  const plain = await snap();
  await toggle("n1", "5-7");
  await toggle("n2", "9-10");
  const on = await snap();
  await save(h, "sidenotes-autogrow-on");
  check(
    "sidenoteAlwaysShowGrowsAutoCard a card that showed all its code grows with its Always Show notes, past the cap",
    all(plain) && plain.ph === null && all(on) && on.h > plain.h + 40 && on.ph !== null,
    { plain, on },
  );
  // one undo step each: the second note and the height together
  await pg.mouse.click(950, 950);
  await pg.keyboard.press("ControlOrMeta+z");
  await until(h, "the toggle is undone", () => !shown("n2"));
  await idle(h);
  const undone = await snap();
  await pg.keyboard.press("ControlOrMeta+Shift+z");
  await until(h, "the toggle is redone", () => shown("n2"));
  await idle(h);
  await toggle("n2", "9-10");
  await toggle("n1", "5-7");
  const off = await snap();
  check(
    "sidenoteAlwaysShowGrowsAutoCard turned off again it follows its content, with no stored height",
    all(undone) && undone.h < on.h && all(off) && off.ph === null && Math.abs(off.h - plain.h) <= 1,
    { undone, off },
  );
  await h.close();
});

test("sidenoteAlwaysShowGrowsAutoCardCodeEdit", async () => {
  const { h, pg, snap, all, toggle } = await vecAddCard();
  const plain = await snap();
  await toggle("n1", "5-7");
  await toggle("n2", "9-10");
  // the card grew with its notes (its height stored): add two lines at the end of the code
  await pg.locator('.card[data-id="k1"] .src .l').nth(1).dblclick();
  await pg.waitForSelector('.card[data-id="k1"] .cm-content');
  await pg.keyboard.press("ControlOrMeta+End");
  await pg.keyboard.press("Enter");
  await pg.keyboard.type("// one");
  await pg.keyboard.press("Enter");
  await pg.keyboard.type("// two");
  await pg.keyboard.press("Escape");
  const text = () => (h.board().cards.find((c) => c.id === "k1") as CodeCard).segments[0].text;
  await until(h, "the code is written with two more lines", () => text().length === VECADD.length + 2);
  await idle(h);
  const edited = await snap();
  check(
    "sidenoteAlwaysShowGrowsAutoCardCodeEdit the grown card fits its new code: every line in view",
    all(edited) && edited.ph !== null,
    { edited },
  );
  await toggle("n2", "9-10");
  await toggle("n1", "5-7");
  const off = await snap();
  check(
    "sidenoteAlwaysShowGrowsAutoCardCodeEdit notes turned off again it follows its content, with no stored height",
    all(off) && off.ph === null && off.h > plain.h,
    { plain, off },
  );
  await h.close();
});

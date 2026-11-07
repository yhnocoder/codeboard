// Highlights on code cards (a range of lines that can carry notes):
//  highlightNoOverlap       Highlight Lines on lines that cross a Highlight makes one Highlight of their union, and the note on the old
//                           one moves to it: Highlights never overlap, a note's lines are always a Highlight's
//  highlightNotesLikeNote   an Always Show note is rendered as a Note is: its Mermaid diagram drawn, its task list with checkboxes
//                           (ticking one writes the note), headings at the Note ratios of 12.5px
//  highlightHoverGutter     resting on a Highlight's code opens nothing; on its line numbers its popup opens (the band lights up, the
//                           numbers turn accent), and moving into the popup keeps it open; leaving both closes it. A right-click
//                           on its numbers opens only the menu (an open popup closes), and with a menu open its gutter opens nothing
//  highlightLookSetting     the setting switches the look in place: a band (R3), a margin bracket (R4) and the bracket with the hand,
//                           which only changes the notes' font; the marker shows the note count in each
//  highlightNoteIndent      an Always Show note starts where the least-indented line of its range starts, after the card's dedent,
//                           with spaces and with tabs
//  highlightRemoveToastUndo removing a Highlight with notes says so with an Undo of that step only: it brings them back; once
//                           another step came after it the Undo is off and does nothing
//  highlightKeepsCardSize   a Highlight takes no room, in every look: adding, removing and switching the look leave the card's
//                           width and height and every line's top as they were; lines 9, 10 and 11 highlighted one by one read
//                           as three bands with a gap between them at the same line pitch
//  highlightSelectionBand   a Line Selection over Highlights is drawn with the band's geometry: the same left and right edges,
//                           radius and insets, one run over the selected lines
//  highlightExport          the HTML export leaves board-only notes out as if they were not there: no empty note row, no band
//                           or marker for a Highlight only they made, bands no longer than their code, line numbers on their lines
import { DEFAULT_SETTINGS, THEMES, emptyBoard, type Board, type CodeCard, type HighlightLook } from "@codeboard/core";
import type { Page } from "playwright-core";
import type { Host } from "../harness";
import { NOTE_HOVER } from "../../src/state/timing";
import * as fs from "node:fs";
import * as path from "node:path";
import { OUT } from "../harness";
import { test, open, check, light, until, idle, hold, hostBoards } from "../fixtures";
import { watch } from "../watch";

// every line indented by at least 4: the card hides that much (its dedent)
const KERNEL = [
  "    __global__ void conv2d(float *N, float *P, int width, int height) {",
  "        int col = blockIdx.x * OUT_TILE_DIM + threadIdx.x - FILTER_RADIUS;",
  "        int row = blockIdx.y * OUT_TILE_DIM + threadIdx.y - FILTER_RADIUS;",
  "        __shared__ float N_s[IN_TILE_DIM][IN_TILE_DIM];",
  "        if (row >= 0 && row < height && col >= 0 && col < width) {",
  "            N_s[threadIdx.y][threadIdx.x] = N[row * width + col];",
  "        } else {",
  "            N_s[threadIdx.y][threadIdx.x] = 0.0;",
  "        }",
  "        __syncthreads();",
  "        float Pvalue = 0.0f;",
  "        for (int fRow = 0; fRow < 2 * FILTER_RADIUS + 1; fRow++) {",
  "            for (int fCol = 0; fCol < 2 * FILTER_RADIUS + 1; fCol++) {",
  "                Pvalue += F_c[fRow][fCol] * N_s[tileRow + fRow][tileCol + fCol];",
  "            }",
  "        }",
  "        P[row * width + col] = Pvalue;",
  "    }",
];
const RICH = [
  "## 读进 tile",
  "",
  "### 边界",
  "",
  "- [x] 核对 halo 宽度",
  "- [ ] 测 bank conflict",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[读 tile] --> B[__syncthreads] --> C[卷积]",
  "```",
].join("\n");

/** Highlights 2–3 (a note), 5–9 (an Always Show note that has everything a Note has), 13–15 (an Always Show note, nested lines) */
function board(): Board {
  const b = emptyBoard("b1", "highlights");
  b.cards.push({
    id: "k1",
    kind: "code",
    title: "conv2d",
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
          [2, 3],
          [5, 9],
          [13, 15],
        ],
      },
    ],
  } as CodeCard);
  b.place.k1 = { x: 40, y: 40, w: 760 };
  const at = (a: number, z: number) => ({ card: "k1", seg: "s1", lines: [a, z] as [number, number] });
  b.sidenotes.push(
    { id: "n1", kind: "text", md: "`col` / `row`：这个线程在整张输入图里的坐标。", at: at(2, 3) },
    { id: "n2", kind: "text", md: RICH, alwaysShow: true, at: at(5, 9) },
    { id: "n3", kind: "text", md: "内层循环：一个输出点的卷积。", alwaysShow: true, at: at(13, 15) },
  );
  // the same Markdown as a Note on the board, to compare with
  b.cards.push({ id: "t1", kind: "note", look: "note", md: RICH } as never);
  b.place.t1 = { x: 860, y: 40, w: 420 };
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const openBoard = (look: HighlightLook = "band", b = board()) =>
  open({ board: b, light, w: 1400, h: 1000, settings: { theme: "warm-ink", highlightLook: look } as never });
const seg = (h: Host) => (h.board().cards.find((c) => c.id === "k1") as CodeCard).segments[0];
const no = (pg: Page, line: number) =>
  pg.locator('.card[data-id="k1"] .gutter .no', { hasText: new RegExp(`^${line}$`) });
const mermaidDrawn = (h: Host) =>
  until(h, "both Mermaid diagrams are drawn", async () => (await h.page.locator(".mmd.ok svg").count()) === 2);

test("highlightNoOverlap", async () => {
  const h = await openBoard();
  const pg = h.page;
  await idle(h);
  // lines 3–4: across the end of 2–3
  await no(pg, 3).click();
  await no(pg, 4).click({ modifiers: ["Shift"] });
  await no(pg, 4).click({ button: "right" });
  await pg.locator(".ctx:not(.closing) button", { hasText: "Highlight Lines" }).click();
  await until(h, "the Highlights merge", () => JSON.stringify(seg(h).hl?.[0]) === "[2,4]");
  await idle(h);
  const n1 = h.board().sidenotes.find((n) => n.id === "n1")!;
  const hit = await pg
    .locator('.card[data-id="k1"] .hxhit')
    .evaluateAll((es) => es.map((e) => e.getAttribute("data-hl")));
  check(
    "highlightNoOverlap crossing lines merge into one Highlight, which keeps the note",
    JSON.stringify(seg(h).hl) === "[[2,4],[5,9],[13,15]]" &&
      JSON.stringify(n1.at.lines) === "[2,4]" &&
      hit.includes("k1:s1:2-4") &&
      !hit.includes("k1:s1:2-3"),
    { hl: seg(h).hl, n1: n1.at.lines, hit },
  );
  // Remove Highlight on lines that are all highlighted removes the touched Highlight whole, with its note, in one undo step
  await no(pg, 6).click();
  await no(pg, 6).click({ button: "right" });
  await pg.locator(".ctx:not(.closing) button", { hasText: "Remove Highlight" }).click();
  await until(h, "the Highlight is removed", () => !seg(h).hl?.some((r) => r[0] === 5));
  const removed = { hl: seg(h).hl, notes: h.board().sidenotes.map((n) => n.id) };
  await pg.locator("#board").click({ position: { x: 1340, y: 700 } });
  await pg.keyboard.press("ControlOrMeta+z");
  await until(h, "the removal is undone", () => h.board().sidenotes.some((n) => n.id === "n2"));
  await idle(h);
  check(
    "highlightNoOverlap removing a Highlight removes its note; one undo brings both back",
    JSON.stringify(removed.hl) === "[[2,4],[13,15]]" &&
      JSON.stringify(removed.notes) === '["n1","n3"]' &&
      JSON.stringify(seg(h).hl) === "[[2,4],[5,9],[13,15]]",
    { removed, after: seg(h).hl },
  );
  await h.close();
});

test("highlightNotesLikeNote", async () => {
  const h = await openBoard();
  const pg = h.page;
  await mermaidDrawn(h);
  await idle(h);
  const r = await pg.evaluate(() => {
    const inote = document.querySelector<HTMLElement>('.card[data-id="k1"] .inote[data-note="n2"] .nbody')!;
    const card = document.querySelector<HTMLElement>('.card[data-id="t1"] .nbody')!;
    const shape = (el: HTMLElement) =>
      [...el.children].map((e) => e.tagName + (e.classList.contains("mmd") ? ".mmd" : ""));
    const px = (el: Element | null) => (el ? Number.parseFloat(getComputedStyle(el).fontSize) : 0);
    return {
      shape: shape(inote),
      noteShape: shape(card),
      boxes: inote.querySelectorAll('input[type="checkbox"]').length,
      checked: inote.querySelectorAll('input[type="checkbox"]:checked').length,
      mermaid: !!inote.querySelector(".mmd.ok svg"),
      body: px(inote),
      h2: px(inote.querySelector("h2")),
      h3: px(inote.querySelector("h3")),
    };
  });
  const near = (a: number, b: number) => Math.abs(a - b) < 0.2;
  check(
    "highlightNotesLikeNote the note has the Note's blocks: headings, task list, Mermaid diagram",
    JSON.stringify(r.shape) === JSON.stringify(r.noteShape) && r.mermaid && r.boxes === 2 && r.checked === 1,
    r,
  );
  check(
    "highlightNotesLikeNote text at 12.5px, headings at 1.25 / 1.1 em",
    near(r.body, 12.5) && near(r.h2, 12.5 * 1.25) && near(r.h3, 12.5 * 1.1),
    r,
  );
  await pg.locator('.inote[data-note="n2"] input[type="checkbox"]:not(:checked)').click();
  await until(h, "ticking the box writes the note", () =>
    h.board().sidenotes.some((n) => n.id === "n2" && n.kind === "text" && n.md.includes("- [x] 测 bank conflict")),
  );
  await h.close();
});

test("highlightHoverGutter", async () => {
  const h = await openBoard();
  const pg = h.page;
  await idle(h);
  const pops = () => pg.locator(".pop.k-highlight").count();
  // the code of line 3 (in the Highlight 2–3)
  await pg
    .locator('.card[data-id="k1"] .src > .l')
    .nth(2)
    .hover({ position: { x: 120, y: 8 } });
  await hold(h, NOTE_HOVER * 3, "resting on a Highlight's code must not open its popup");
  const fromCode = await pops();
  await no(pg, 3).hover();
  await pg.locator(".pop.k-highlight").waitFor();
  await idle(h);
  const lit = await pg.evaluate(() => ({
    band: document.querySelectorAll('.card[data-id="k1"] .hxb.on').length,
    nums: [...document.querySelectorAll('.card[data-id="k1"] .gutter .no.hxon')].map((e) => e.textContent),
    head: document.querySelector(".pop.k-highlight .hh")?.textContent ?? "",
  }));
  const p = (await pg.locator(".pop.k-highlight").boundingBox())!;
  await pg.mouse.move(p.x + p.width / 2, p.y + 12, { steps: 6 });
  await hold(h, NOTE_HOVER * 3, "the pointer in the popup keeps it open");
  const kept = await pops();
  await pg.mouse.move(1300, 960, { steps: 4 });
  await until(h, "leaving the popup closes it", async () => (await pops()) === 0);
  check(
    "highlightHoverGutter only the line numbers open the popup, which lights its lines and stays while the pointer is in it",
    fromCode === 0 &&
      lit.band === 1 &&
      JSON.stringify(lit.nums) === '["2","3"]' &&
      /2–3/.test(lit.head) &&
      /1 note/.test(lit.head) &&
      kept === 1,
    { fromCode, lit, kept },
  );
  // right-clicking a Highlight's line number opens only its menu; with the menu open its gutter opens nothing either
  const menus = () => pg.locator(".ctx:not(.closing)").count();
  await no(pg, 3).click({ button: "right" });
  await pg.locator(".ctx:not(.closing)").waitFor();
  await hold(h, NOTE_HOVER * 3, "a right-click on a Highlight's number must open no popup");
  const onRight = { menus: await menus(), pops: await pops() };
  await no(pg, 13).hover();
  await hold(h, NOTE_HOVER * 3, "hovering a Highlight's numbers while a menu is open must open no popup");
  const underMenu = { menus: await menus(), pops: await pops() };
  await pg.keyboard.press("Escape");
  await until(h, "the menu closes", async () => (await menus()) === 0);
  // a popup already open closes on the right-click
  await pg.mouse.move(1300, 960);
  await no(pg, 2).hover();
  await pg.locator(".pop.k-highlight").waitFor();
  await no(pg, 2).click({ button: "right" });
  await until(h, "the popup closes as the menu opens", async () => (await pops()) === 0 && (await menus()) === 1);
  await hold(h, NOTE_HOVER * 3, "the popup must not open again under the menu");
  const closed = { menus: await menus(), pops: await pops() };
  check(
    "highlightHoverGutter a right-click on a Highlight's numbers shows only the menu, and its gutter opens nothing while it is open",
    [onRight, underMenu, closed].every((x) => x.menus === 1 && x.pops === 0),
    { onRight, underMenu, closed },
  );
  await h.close();
});

test("highlightLookSetting", async () => {
  const h = await openBoard("band");
  const pg = h.page;
  await mermaidDrawn(h);
  await idle(h);
  const look = () =>
    pg.evaluate(() => {
      const code = document.querySelector<HTMLElement>('.card[data-id="k1"] .code')!;
      const band = code.querySelector<HTMLElement>(".hxb")!.getBoundingClientRect();
      const first = code.querySelector<HTMLElement>(".src > .l.hx-first")!;
      const nb = code.querySelector<HTMLElement>(".inote .nbody")!;
      const h2 = nb.querySelector("h2")!;
      return {
        cls: ["hx-band", "hx-bracket", "hx-hand"].filter((c) => code.classList.contains(c)),
        bandW: Math.round(band.width),
        gap:
          Number.parseFloat(getComputedStyle(first).marginTop) +
          Number.parseFloat(getComputedStyle(first).marginBottom),
        marks: [...code.querySelectorAll(".hxm")].map((e) => e.textContent),
        font: getComputedStyle(nb).fontFamily,
        headFont: getComputedStyle(h2).fontFamily,
        hand: getComputedStyle(document.documentElement).getPropertyValue("--hand").trim(),
      };
    });
  const set = async (highlightLook: HighlightLook) => {
    await h.post({
      type: "host",
      host: { settings: { ...DEFAULT_SETTINGS, theme: "warm-ink", highlightLook } } as never,
    });
    await idle(h);
    return look();
  };
  const band = await look();
  const bracket = await set("bracket");
  const hand = await set("bracket-hand");
  const first = (f: string) => f.split(",")[0].trim();
  check(
    "highlightLookSetting band: a wide band, no space added around its lines",
    JSON.stringify(band.cls) === '["hx-band"]' && band.bandW > 300 && band.gap === 0,
    band,
  );
  check(
    "highlightLookSetting bracket: a 4px bracket, no space added around its lines, the same fonts as the band",
    JSON.stringify(bracket.cls) === '["hx-bracket"]' &&
      bracket.bandW <= 5 &&
      bracket.gap === 0 &&
      bracket.font === band.font &&
      !bracket.font.includes(first(band.hand)),
    bracket,
  );
  check(
    "highlightLookSetting bracket with the hand: the notes and their headings in the hand font, the rest as the bracket",
    JSON.stringify(hand.cls) === '["hx-bracket","hx-hand"]' &&
      hand.bandW === bracket.bandW &&
      hand.gap === 0 &&
      first(hand.font) === first(hand.hand) &&
      first(hand.headFont) === first(hand.hand),
    hand,
  );
  check(
    "highlightLookSetting the marker shows the note count in every look",
    [band, bracket, hand].every((l) => JSON.stringify(l.marks) === '["1","1","1"]'),
    { band: band.marks, bracket: bracket.marks, hand: hand.marks },
  );
  // the hand is one rule for every theme, light and dark: the body and its headings in the hand font and the pen's tint
  const off: unknown[] = [];
  for (const [theme] of THEMES)
    for (const dark of [false, true]) {
      await pg.evaluate((d) => {
        document.body.classList.remove("vscode-light", "vscode-dark");
        document.body.classList.add(d ? "vscode-dark" : "vscode-light");
      }, dark);
      await h.post({
        type: "host",
        host: { settings: { ...DEFAULT_SETTINGS, theme, highlightLook: "bracket-hand" } } as never,
      });
      await idle(h);
      const r = await pg.evaluate(() => {
        const nb = document.querySelector<HTMLElement>('.card[data-id="k1"] .inote .nbody')!;
        const [b, t] = [getComputedStyle(nb), getComputedStyle(nb.querySelector("h2")!)];
        return {
          theme: document.documentElement.dataset.theme,
          hand: getComputedStyle(document.documentElement).getPropertyValue("--hand").trim().split(",")[0],
          fonts: [b.fontFamily.split(",")[0], t.fontFamily.split(",")[0]],
          colors: [b.color, t.color],
        };
      });
      if (r.theme !== (dark ? "dark" : "light") || r.fonts.some((f) => f !== r.hand) || r.colors[0] !== r.colors[1])
        off.push({ look: theme, ...r });
    }
  check("highlightLookSetting the hand looks the same in every theme, light and dark", off.length === 0, off);
  await h.close();
});

/** The kernel alone, no Highlights and no notes, its height following its content (no stored h) */
function plain(): Board {
  const b = board();
  b.cards = b.cards.filter((c) => c.id === "k1");
  delete b.place.t1;
  delete (b.cards[0] as CodeCard).segments[0].hl;
  b.sidenotes = [];
  return b;
}
/** The card's size, its lines' tops (in the card) and where each Highlight's band or bracket is */
const geometry = (pg: Page) =>
  pg.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.card[data-id="k1"]')!;
    const r = card.getBoundingClientRect();
    const box = (e: Element) => {
      const q = e.getBoundingClientRect();
      return { top: q.top - r.top, bottom: q.bottom - r.top, left: q.left - r.left, right: q.right - r.left };
    };
    return {
      size: [r.width, r.height],
      tops: [...card.querySelectorAll(".src > .l")].map((e) => e.getBoundingClientRect().top - r.top),
      bands: [...card.querySelectorAll(".hxb")].map(box),
      sel: [...card.querySelectorAll(".lselb")].map((e) => ({ ...box(e), radius: getComputedStyle(e).borderRadius })),
      radius: [...card.querySelectorAll(".hxb")].map((e) => getComputedStyle(e).borderRadius),
    };
  });
/** Select lines a..z by their numbers, and Highlight Lines (or Remove Highlight, when all are highlighted) from their menu */
async function highlightLines(h: Host, a: number, z: number, want: string) {
  await no(h.page, a).click();
  if (z !== a) await no(h.page, z).click({ modifiers: ["Shift"] });
  await no(h.page, z).click({ button: "right" });
  await h.page.locator(".ctx:not(.closing) button", { hasText: /^(Highlight Lines|Remove Highlight)/ }).click();
  await until(h, `Highlights ${want}`, () => JSON.stringify(seg(h).hl ?? []) === want);
  await h.page.keyboard.press("Escape");
  await idle(h);
}

test("highlightKeepsCardSize", async () => {
  const h = await openBoard("band", plain());
  const pg = h.page;
  await idle(h);
  const base = await geometry(pg);
  const same = (g: Awaited<ReturnType<typeof geometry>>) =>
    JSON.stringify(g.size) === JSON.stringify(base.size) && JSON.stringify(g.tops) === JSON.stringify(base.tops);
  const setLook = async (highlightLook: HighlightLook) => {
    await h.post({
      type: "host",
      host: { settings: { ...DEFAULT_SETTINGS, theme: "warm-ink", highlightLook } } as never,
    });
    await idle(h);
  };
  const looks: HighlightLook[] = ["band", "bracket", "bracket-hand"];
  for (const look of looks) {
    await setLook(look);
    await highlightLines(h, 3, 4, "[[3,4]]");
    for (const l of [9, 10, 11])
      await highlightLines(h, l, l, JSON.stringify([[3, 4], ...[9, 10, 11].filter((x) => x <= l).map((x) => [x, x])]));
    const on = await geometry(pg);
    check(
      `highlightKeepsCardSize ${look}: highlighting leaves the card's size and its lines where they were`,
      same(on),
      {
        base: base.size,
        on: on.size,
        moved: on.tops.flatMap((t, i) => (t === base.tops[i] ? [] : [{ line: i + 1, from: base.tops[i], to: t }])),
      },
    );
    // lines 9, 10, 11 (rows 8–10): three bands apart, at the line pitch of lines without Highlights
    const [b9, b10, b11] = on.bands.slice(1);
    const pitch = base.tops[1] - base.tops[0];
    check(
      `highlightKeepsCardSize ${look}: adjacent one-line Highlights read apart with no space between their lines`,
      on.bands.length === 4 &&
        b10.top - b9.bottom >= 3 &&
        b11.top - b10.bottom >= 3 &&
        on.tops[9] - on.tops[8] === pitch &&
        on.tops[10] - on.tops[9] === pitch,
      { pitch, bands: on.bands.slice(1), tops: on.tops.slice(8, 11) },
    );
    // switching the look with Highlights on the card
    for (const other of looks.filter((x) => x !== look)) {
      await setLook(other);
      const g = await geometry(pg);
      check(`highlightKeepsCardSize switching ${look} to ${other} with Highlights leaves the card as it was`, same(g), {
        base: base.size,
        size: g.size,
      });
    }
    await setLook(look);
    await highlightLines(h, 3, 4, "[[9,9],[10,10],[11,11]]");
    await highlightLines(h, 9, 11, "[]");
    const off = await geometry(pg);
    check(
      `highlightKeepsCardSize ${look}: removing them leaves the card as it was`,
      same(off) && !off.bands.length,
      off.size,
    );
  }
  check(
    "highlightKeepsCardSize the board stores no size for the card",
    h.board().place.k1.h === undefined,
    h.board().place.k1,
  );
  await h.close();
});

test("highlightSelectionBand", async () => {
  const b = plain();
  (b.cards[0] as CodeCard).segments[0].hl = [
    [9, 9],
    [10, 10],
    [11, 11],
  ];
  const h = await openBoard("band", b);
  const pg = h.page;
  await idle(h);
  await no(pg, 9).click();
  await no(pg, 11).click({ modifiers: ["Shift"] });
  await until(h, "lines 9–11 are selected", async () => (await pg.locator('.card[data-id="k1"] .lselb').count()) === 1);
  const g = await geometry(pg);
  const [sel] = g.sel,
    [b9, , b11] = g.bands;
  check(
    "highlightSelectionBand a selection over Highlights has the band's edges, radius and insets, one run",
    g.sel.length === 1 &&
      sel.left === b9.left &&
      sel.right === b9.right &&
      sel.top === b9.top &&
      sel.bottom === b11.bottom &&
      sel.radius === g.radius[0],
    { sel: g.sel, bands: g.bands, radius: g.radius },
  );
  // beside the Highlights (lines 12–13): the same geometry, inset inside its own rows
  await no(pg, 12).click();
  await no(pg, 13).click({ modifiers: ["Shift"] });
  await idle(h);
  const g2 = await geometry(pg);
  const pitch = g2.tops[1] - g2.tops[0];
  check(
    "highlightSelectionBand a selection beside them is drawn the same way, inside its rows",
    g2.sel.length === 1 &&
      g2.sel[0].left === b9.left &&
      g2.sel[0].right === b9.right &&
      g2.sel[0].top === b11.top + pitch &&
      // two rows less the insets a one-row band has
      g2.sel[0].bottom - g2.sel[0].top === pitch + (b11.bottom - b11.top),
    { sel: g2.sel, b11 },
  );
  await h.close();
});

// indented with tabs, all by at least two: the card hides them (its dedent)
const TABBED = ["\t\tfor (;;) {", "\t\t\tif (a) {", "\t\t\t\tb();", "\t\t\t}", "\t\t}"];
test("highlightNoteIndent", async () => {
  for (const look of ["band", "bracket"] as const) {
    const b = board();
    b.cards.push({
      id: "k2",
      kind: "code",
      title: "tabbed",
      segments: [
        {
          id: "s2",
          src: { kind: "free" },
          path: "",
          lang: "cuda",
          start: 1,
          end: TABBED.length,
          text: TABBED.slice(),
          version: { kind: "none" },
          hl: [[2, 4]],
        },
      ],
    } as CodeCard);
    b.place.k2 = { x: 860, y: 700, w: 420 };
    b.sidenotes.push({
      id: "n4",
      kind: "text",
      md: "跳出前先看 a。",
      alwaysShow: true,
      at: { card: "k2", seg: "s2", lines: [2, 4] },
    });
    const h = await openBoard(look, b);
    const pg = h.page;
    await mermaidDrawn(h);
    await idle(h);
    // n2 on 5–9: least indented are 5, 7 and 9 (8 spaces); n3 on 13–15: line 13 (12 spaces); the card hides 4
    const r = await pg.evaluate(() => {
      const card = document.querySelector('.card[data-id="k1"]')!;
      const lines = card.querySelectorAll<HTMLElement>(".src > .l");
      /** where the first character that is not a space starts on a line */
      const textAt = (l: HTMLElement) => {
        const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
        for (let t = w.nextNode() as Text | null; t; t = w.nextNode() as Text | null) {
          const i = t.data.search(/\S/);
          if (i < 0) continue;
          const rg = document.createRange();
          rg.setStart(t, i);
          rg.setEnd(t, i + 1);
          return rg.getBoundingClientRect().left;
        }
        return Number.NaN;
      };
      const noteAt = (id: string) => card.querySelector(`.inote[data-note="${id}"]`)!.getBoundingClientRect().left;
      const tab = document.querySelector('.card[data-id="k2"]')!;
      const tl = tab.querySelectorAll<HTMLElement>(".src > .l");
      return {
        n2: noteAt("n2"),
        line5: textAt(lines[4]),
        line6: textAt(lines[5]),
        n3: noteAt("n3"),
        line13: textAt(lines[12]),
        line1: textAt(lines[0]),
        // the tabbed card: n4 on 2–4, least indented 2 and 4 (three tabs, one after the dedent)
        n4: tab.querySelector('.inote[data-note="n4"]')!.getBoundingClientRect().left,
        tab1: textAt(tl[0]),
        tab2: textAt(tl[1]),
        tab3: textAt(tl[2]),
      };
    });
    check(
      `highlightNoteIndent ${look}: each note starts at its range's least-indented code, not at the gutter or a deeper line`,
      Math.abs(r.n2 - r.line5) <= 1.5 && Math.abs(r.n3 - r.line13) <= 1.5 && r.line6 > r.n2 + 10 && r.n2 > r.line1 + 10,
      r,
    );
    check(
      `highlightNoteIndent ${look}: indented with tabs, in a card that hides some of them`,
      Math.abs(r.n4 - r.tab2) <= 1.5 && r.tab3 > r.n4 + 10 && r.n4 > r.tab1 + 10,
      r,
    );
    await h.close();
  }
});

test("highlightRemoveToastUndo", async () => {
  const h = await openBoard();
  const pg = h.page;
  await idle(h);
  const notes = () =>
    h
      .board()
      .sidenotes.map((n) => n.id)
      .join(",");
  const remove = async (line: number) => {
    await no(pg, line).hover();
    await pg.locator(".pop.k-highlight").waitFor();
    await pg.locator('.pop.k-highlight [aria-label="Remove Highlight"]').click();
  };
  await remove(2);
  await until(h, "the Highlight and its note go", () => notes() === "n2,n3");
  const toast = pg.locator(".toast");
  const said = await toast.textContent();
  await toast.locator("button", { hasText: "Undo" }).click();
  await until(h, "Undo brings them back", () => notes() === "n1,n2,n3" && seg(h).hl?.length === 3);
  await idle(h);
  // again, then another step after it: the toast's Undo is off, and clicking it changes nothing
  await remove(2);
  await until(h, "removed again", () => notes() === "n2,n3");
  await pg.locator('.card[data-id="t1"] .chead').click({ position: { x: 40, y: 10 } });
  await pg.keyboard.press("Alt+Shift+KeyT"); // Tilt: a step of its own
  await until(h, "the Note is tilted", () => !!(h.board().cards.find((c) => c.id === "t1") as { tilt?: unknown }).tilt);
  const off = await toast.locator("button", { hasText: "Undo" }).isDisabled();
  await toast.locator("button", { hasText: "Undo" }).click({ force: true });
  await idle(h);
  check(
    "highlightRemoveToastUndo the toast's Undo undoes that removal only, and is off once another step came after it",
    /Removed the Highlight and its 1 note/.test(said ?? "") &&
      off &&
      notes() === "n2,n3" &&
      !!(h.board().cards.find((c) => c.id === "t1") as { tilt?: unknown }).tilt,
    { said, off, notes: notes() },
  );
  await h.close();
});

test("highlightExport", async () => {
  const b = board();
  // n3 board-only: its Highlight (13–15) is on this board only, and an export without board-only notes has neither
  const s = (b.cards[0] as CodeCard).segments[0];
  s.hl = s.hl!.filter((r) => r[0] !== 13);
  (b.sidenotes.find((n) => n.id === "n3") as { boardOnly?: true }).boardOnly = true;
  const files: Record<string, string> = {};
  const run = await hostBoards([b], {
    page: { light, w: 1400, h: 1000, settings: { theme: "warm-ink" } as never },
  });
  let saving = "";
  run.ws.ui = {
    ...run.ws.ui,
    saveDialog: async (o) => (saving = path.join(OUT, `hx-export-${process.pid}-${path.basename(o.defaultPath)}`)),
    info: async (text) => {
      if (text.startsWith("Exported ")) files[path.extname(saving).slice(1)] = saving;
      return undefined;
    },
  };
  const h = await run.open(b.id),
    page = h.page;
  await mermaidDrawn(h);
  await idle(h);
  const before = await page.locator('.card[data-id="k1"] .hxm').count();
  await page.locator('.bbar [aria-label="More"]').click();
  await page.locator(".ctx:not(.closing) button", { hasText: "Export…" }).click();
  await page.locator(".xdlg").waitFor();
  await page.locator(".xdlg .seg button", { hasText: "Whole Board" }).click();
  await page.locator(".xdlg button.def").click();
  await until(h, "the HTML snapshot is written", () => files.html, 20000);
  const v = await page.context().browser()!.newPage();
  await v.setViewportSize({ width: 1400, height: 1000 });
  await v.goto(`file://${files.html}`);
  await v.waitForFunction(() => document.querySelector(".world .card[data-id]") && document.fonts.status === "loaded");
  const r = await v.evaluate(() => {
    const card = document.querySelector('.world .card[data-id="k1"]')!;
    const box = (e: Element) => e.getBoundingClientRect();
    const lines = [...card.querySelectorAll<HTMLElement>(".src > [data-r]")];
    const rowTop = (i: string) => lines.find((l) => l.dataset.r === i)?.getBoundingClientRect().top ?? Number.NaN;
    // each band ends by its last line or note row (data-hxe) plus the 3px it reaches beyond
    const ends = Object.fromEntries(
      [...card.querySelectorAll<HTMLElement>(".src > [data-hxe]")].map((e) => [e.dataset.hxe!, box(e).bottom]),
    );
    const hits = [...card.querySelectorAll<HTMLElement>(".hxhit")].map((e) => e.dataset.hl!);
    return {
      notes: [...card.querySelectorAll<HTMLElement>(".inote")].map((e) => e.dataset.note),
      emptyRows: card.querySelectorAll(".inotes:not(:has(.inote))").length,
      marks: [...card.querySelectorAll<HTMLElement>(".hxm")].map((e) => e.dataset.hl),
      hits,
      bandOver: [...card.querySelectorAll<HTMLElement>(".hxb")].map((e, i) => box(e).bottom - (ends[hits[i]] ?? 0)),
      numbersOff: [...card.querySelectorAll<HTMLElement>(".gutter .no")].map((n) =>
        Math.abs(box(n).top - rowTop(n.dataset.r!)),
      ),
    };
  });
  await v.screenshot({ path: path.join(OUT, "highlight-export.png") });
  await v.close();
  check(
    "highlightExport board-only notes left out as if never there: their row, band and marker go, the rest lines up",
    before === 3 &&
      JSON.stringify(r.notes) === '["n2"]' &&
      r.emptyRows === 0 &&
      JSON.stringify(r.marks) === '["k1:s1:2-3","k1:s1:5-9"]' &&
      !r.hits.includes("k1:s1:13-15") &&
      r.bandOver.every((d) => d <= 3.5) &&
      r.numbersOff.every((d) => d <= 3),
    r,
  );
  if (fs.existsSync(files.html)) fs.rmSync(files.html);
});

/**
 * Highlighting, removing a Highlight and switching the look, watched frame by frame (watch.ts): the card does not change size
 * and none of its lines moves in any frame (#171: Highlights never change a card's size or its lines' places), and nothing
 * flashes. highlightKeepsCardSize checks the same at rest
 */
test("highlightWatched", async () => {
  const h = await openBoard("band", plain());
  const pg = h.page;
  await idle(h);
  const watched = { follow: ['.card[data-id="k1"] .src > .l'], ignore: [".ctx"], frames: 12 };
  const fromMenu = async (a: number, z: number, item: RegExp, name: string) => {
    await no(pg, a).click();
    if (z !== a) await no(pg, z).click({ modifiers: ["Shift"] });
    await no(pg, z).click({ button: "right" });
    await idle(h);
    await watch(h, `highlightWatched ${name}`, watched, () =>
      pg.locator(".ctx:not(.closing) button", { hasText: item }).first().click(),
    );
    await pg.keyboard.press("Escape");
    await idle(h);
  };
  await fromMenu(3, 4, /^Highlight Lines/, "highlight 3-4");
  await fromMenu(9, 9, /^Highlight Lines/, "highlight 9");
  for (const highlightLook of ["bracket-hand", "band"] as HighlightLook[])
    await watch(h, `highlightWatched look ${highlightLook}`, watched, () =>
      h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, theme: "warm-ink", highlightLook } } as never }),
    );
  await idle(h);
  await fromMenu(3, 4, /^Remove Highlight/, "remove 3-4");
  check("highlightWatched the Highlights are as asked", JSON.stringify(seg(h).hl ?? []) === "[[9,9]]", seg(h).hl);
  await h.close();
});

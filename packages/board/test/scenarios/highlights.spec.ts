// Highlights on code cards (a range of lines that can carry notes):
//  highlightNoOverlap       Highlight Lines on lines that cross a Highlight makes one Highlight of their union, and the note on the old
//                           one moves to it: Highlights never overlap, a note's lines are always a Highlight's
//  highlightNotesLikeNote   an Always Show note is rendered as a Note is: its Mermaid diagram drawn, its task list with checkboxes
//                           (ticking one writes the note), headings at the Note ratios of 12.5px
//  highlightHoverGutter     resting on a Highlight's code opens nothing; on its line numbers its popup opens (the band lights up, the
//                           numbers turn accent), and moving into the popup keeps it open; leaving both closes it
//  highlightLookSetting     the setting switches the look in place: a band (R3), a margin bracket (R4) and the bracket with the hand,
//                           which only changes the notes' font; the marker shows the note count in each
//  highlightNoteIndent      an Always Show note starts where the least-indented line of its range starts, after the card's dedent
import { DEFAULT_SETTINGS, emptyBoard, type Board, type CodeCard, type HighlightLook } from "@codeboard/core";
import type { Page } from "playwright-core";
import type { Host } from "../harness";
import { NOTE_HOVER } from "../../src/state/timing";
import { test, open, check, light, until, idle, hold } from "../fixtures";

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
        gap: Number.parseFloat(getComputedStyle(first).marginTop),
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
    "highlightLookSetting band: a wide band, 10px before a range",
    JSON.stringify(band.cls) === '["hx-band"]' && band.bandW > 300 && band.gap === 10,
    band,
  );
  check(
    "highlightLookSetting bracket: a 4px bracket, 4px before a range, the same fonts as the band",
    JSON.stringify(bracket.cls) === '["hx-bracket"]' &&
      bracket.bandW <= 5 &&
      bracket.gap === 4 &&
      bracket.font === band.font &&
      !bracket.font.includes(first(band.hand)),
    bracket,
  );
  check(
    "highlightLookSetting bracket with the hand: the notes and their headings in the hand font, the rest as the bracket",
    JSON.stringify(hand.cls) === '["hx-bracket","hx-hand"]' &&
      hand.bandW === bracket.bandW &&
      hand.gap === 4 &&
      first(hand.font) === first(hand.hand) &&
      first(hand.headFont) === first(hand.hand),
    hand,
  );
  check(
    "highlightLookSetting the marker shows the note count in every look",
    [band, bracket, hand].every((l) => JSON.stringify(l.marks) === '["1","1","1"]'),
    { band: band.marks, bracket: bracket.marks, hand: hand.marks },
  );
  await h.close();
});

test("highlightNoteIndent", async () => {
  for (const look of ["band", "bracket"] as const) {
    const h = await openBoard(look);
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
      return {
        n2: noteAt("n2"),
        line5: textAt(lines[4]),
        line6: textAt(lines[5]),
        n3: noteAt("n3"),
        line13: textAt(lines[12]),
        line1: textAt(lines[0]),
      };
    });
    check(
      `highlightNoteIndent ${look}: each note starts at its range's least-indented code, not at the gutter or a deeper line`,
      Math.abs(r.n2 - r.line5) <= 1.5 && Math.abs(r.n3 - r.line13) <= 1.5 && r.line6 > r.n2 + 10 && r.n2 > r.line1 + 10,
      r,
    );
    await h.close();
  }
});

// 代码卡一行的底色条（显示时的 .rowbg：hl、选中的行；编辑时 CodeMirror 的当前行）从卡的左边经过行号栏一直连到行尾，
// 行号格和代码之间没有空白：缩进很深的续行、藏了公共缩进的卡、折行的长行都一样
import * as path from "node:path";
import { emptyBoard, type Board } from "@codeboard/core";
import type { Page } from "playwright-core";
import { OUT, type Host } from "../harness";
import { test, open, check, idle } from "../fixtures";

const KERNEL = [
  "constexpr int BLUR_SIZE = 5;",
  "constexpr int NCHANNEL = 3;",
  "",
  "__global__ void blurKernel(unsigned char* in, unsigned char* out,",
  "                           int w, int h) {",
  "    int col = blockIdx.x * blockDim.x + threadIdx.x;",
  "    int row = blockIdx.y * blockDim.y + threadIdx.y;",
];
// 每行都缩进 8：显示时藏起公共缩进
const NESTED = [
  "        if (col < w && row < h) {",
  "            float v = blurAt(in, col, row,",
  "                             w, h);",
  "        }",
];
const LONG = [
  "void f() {",
  `    launch(${Array.from({ length: 14 }, (_, i) => `argument_number_${i}`).join(", ")});`,
  "}",
];

function board(): Board {
  const b = emptyBoard("b1", "free");
  const card = (id: string, text: string[], hl: number[], y: number, extra: object = {}) => {
    b.cards.push({
      id,
      kind: "code",
      title: id,
      ...extra,
      segments: [
        {
          id: `s-${id}`,
          src: { kind: "free" },
          path: "",
          lang: "cuda",
          start: 1,
          end: text.length,
          text: text.slice(),
          version: { kind: "none" },
          hl,
        },
      ],
    } as any);
    b.place[id] = { x: 60, y, w: 560 };
  };
  card("kernel", KERNEL, [5], 40);
  card("nested", NESTED, [3], 300);
  card("long", LONG, [2], 480, { wrap: true });
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

type Box = { l: number; r: number; t: number; b: number };
const box = (r: DOMRect): Box => ({
  l: Math.round(r.left * 2) / 2,
  r: Math.round(r.right * 2) / 2,
  t: Math.round(r.top * 2) / 2,
  b: Math.round(r.bottom * 2) / 2,
});

/** 显示时第 n 行的底色条和 .code 的左右边、这一行的字 */
const shownBand = (pg: Page, card: string, row: number, cls: string) =>
  pg.evaluate(
    ([card, row, cls]) => {
      const bx = (r: DOMRect) => ({
        l: Math.round(r.left * 2) / 2,
        r: Math.round(r.right * 2) / 2,
        t: Math.round(r.top * 2) / 2,
        b: Math.round(r.bottom * 2) / 2,
      });
      const root = document.querySelector(`.card[data-id="${card}"]`)!;
      const bands = [...root.querySelectorAll(`.rowbg.${cls}`)].map((e) => bx(e.getBoundingClientRect()));
      const no = root.querySelectorAll(".gutter .no")[row];
      const line = root.querySelectorAll(".src .l")[row];
      return {
        code: bx(root.querySelector(".code")!.getBoundingClientRect()),
        no: no && bx(no.getBoundingClientRect()),
        line: line && bx(line.getBoundingClientRect()),
        bands,
      };
    },
    [card, row, cls] as const,
  );

/** 编辑时当前行：行号格的底色和行的底色（有颜色的才算） */
const editBand = (pg: Page, card: string) =>
  pg.evaluate((card) => {
    const bx = (r: DOMRect) => ({
      l: Math.round(r.left * 2) / 2,
      r: Math.round(r.right * 2) / 2,
      t: Math.round(r.top * 2) / 2,
      b: Math.round(r.bottom * 2) / 2,
    });
    const root = document.querySelector(`.card[data-id="${card}"]`)!;
    const painted = (e: Element | null) => !!e && getComputedStyle(e).backgroundColor !== "rgba(0, 0, 0, 0)";
    const g = root.querySelector(".cm-activeLineGutter"),
      l = root.querySelector(".cm-activeLine");
    return {
      code: bx(root.querySelector(".code")!.getBoundingClientRect()),
      gutter: g && painted(g) ? bx(g.getBoundingClientRect()) : null,
      line: l && painted(l) ? bx(l.getBoundingClientRect()) : null,
      text: l?.textContent ?? "",
    };
  }, card);

/** 一条（或首尾相接的两条）底色从 a 连到 b，中间没有空隙 */
const covers = (parts: Box[], from: number, to: number) => {
  const s = [...parts].sort((x, y) => x.l - y.l);
  let at = from;
  for (const p of s) {
    if (p.l > at + 0.5) return false;
    at = Math.max(at, p.r);
  }
  return at >= to - 0.5;
};

async function shown(h: Host, card: string, row: number, what: string) {
  const s = await shownBand(h.page, card, row, "hl");
  const band = s.bands.find((b) => s.line && Math.abs(b.t - s.line.t) < 1);
  const ok =
    !!band &&
    !!s.no &&
    !!s.line &&
    covers([band], s.code.l, s.line.r) &&
    band.l <= s.no.l &&
    band.b - band.t >= s.line.b - s.line.t - 0.5;
  check(
    `codeLineBandContinuous shown hl band, ${what}: one band from the card's left edge past the line number to the line's end`,
    ok,
    { band, no: s.no, line: s.line, code: s.code },
  );
}

async function edited(h: Host, card: string, row: number, what: string, shot?: string) {
  const pg = h.page;
  await pg.locator(`.card[data-id="${card}"] .src .l`).nth(row).dblclick();
  await pg.waitForSelector(`.card[data-id="${card}"] .cm-activeLineGutter`, { timeout: 8000 });
  await idle(h);
  const e = await editBand(pg, card);
  const ok =
    !!e.gutter &&
    !!e.line &&
    covers([e.gutter, e.line], e.code.l, e.line.r) &&
    Math.abs(e.gutter.t - e.line.t) < 1 &&
    Math.abs(e.gutter.b - e.line.b) < 1;
  check(
    `codeLineBandContinuous editing, current line band ${what}: line-number cell meets the line, no gap, same height`,
    ok,
    { gutter: e.gutter, line: e.line, code: e.code, text: e.text.slice(0, 40) },
  );
  if (shot) {
    await pg.mouse.move(900, 680);
    const g = (await pg.locator(`.card[data-id="${card}"] .cm-activeLine`).boundingBox())!;
    const c = (await pg.locator(`.card[data-id="${card}"]`).boundingBox())!;
    await pg.screenshot({
      path: path.join(OUT, `${shot}.png`),
      clip: { x: c.x - 8, y: g.y - 60, width: c.width + 16, height: g.height + 120 },
    });
  }
  await pg.keyboard.press("Escape");
  await pg.waitForSelector(`.card[data-id="${card}"] .src .l`);
  await idle(h);
}

test("codeLineBandContinuous", async () => {
  for (const [theme, light] of [
    ["warm-ink", true],
    ["warm-ink", false],
    ["graphite", true],
    ["soft-light", true],
  ] as const) {
    const h = await open({ board: board(), light, w: 1000, h: 760, settings: { theme } as any });
    await idle(h);
    const t = `${theme} ${light ? "light" : "dark"}`;
    await shown(h, "kernel", 4, `${t}, deeply indented continuation line`);
    await shown(h, "nested", 2, `${t}, common indent hidden`);
    await shown(h, "long", 1, `${t}, wrapped line`);
    await edited(
      h,
      "kernel",
      4,
      `${t}, deeply indented continuation line`,
      theme === "warm-ink" && light ? "codeLineBandContinuous-warm-ink" : undefined,
    );
    await edited(h, "nested", 2, `${t}, common indent hidden`);
    await edited(h, "long", 1, `${t}, wrapped line`);
    await h.page.context().close();
  }
});

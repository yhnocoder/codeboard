// Code card header (Free code and repo code cards) and the code area around it:
//  codeHeaderHoverOnly          Copy Code and the language label (Free cards) take no width until the card is hovered, then open
//                               and fade in together, right of the title, left of ···; the label opens the language menu.
//                               A short title that fits the row without them is not cut while the card isn't hovered
//  freeCodeLanguageDetect       typed C code is detected as C; a language picked from the menu sticks when the code changes again;
//                               Auto-detect goes back to detecting
//  softLightCodeHeaderOneRow    Soft Light: the header is one 40px row (like the Note's) with a long title, which ellipsizes;
//                               the repo card's path ellipsizes before its title
//  codeAreaPadding              the code area's paddings: Soft Light 7px left of the line numbers (in the well), 4 / 6 above and below,
//                               8 right; Warm Ink (no well) 17px left of the numbers, 6 / 8, 18 right; the numbers end 22px before the code
//  fitContentWidthCodeCard      ⌥F fits a code card's width to its longest line and its height to its lines (animated), in Warm Ink and Soft Light
//  fitContentSameInEveryTheme   ⌥F gives the same Place (card width, code area height) in every look (one shared code area geometry), so a card
//                               fitted in Warm Ink fits exactly in Soft Light and the others and the other way round: no wrapped line, no
//                               scroll. A 5-line card, a 105-line card (3-digit numbers) and a too-wide card with Wrap Lines on (shrinks to
//                               its longest line, wrap stays on) and a too-narrow one whose long line wraps before ⌥F. Fitted cards keep
//                               no height (follow their content) unless taller than the cap for cards without one
//  fitContentFollowsCodeEdits   after ⌥F a Free code card follows its content: 3 lines added while editing grow it by 3 × 20px with no
//                               scroll (Warm Ink, Soft Light); a height dragged with the corner handle is stored and stays fixed
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS, emptyBoard, type Board, type CodeCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { put, symCard, findSym, OUT, type Host } from "../harness";
import { test, open, check, light, until, idle } from "../fixtures";

const C_CODE = [
  "void vecAdd(float* A_h, float* B_h, float* C_h, int n) {",
  "    for (int i = 0; i < n; ++i) {",
  "        C_h[i] = A_h[i] + B_h[i];",
  "    }",
  "}",
];
const LONG = [
  ...C_CODE.slice(0, 2),
  "        C_h[i] = A_h[i] + B_h[i] + A_h[i] * B_h[i] - A_h[i] / (B_h[i] + 1.0f) + 0.5f;",
  ...C_CODE.slice(3),
];

const free = (id: string, text: string[], o: { lang?: string; title?: string } = {}): CodeCard =>
  ({
    id,
    kind: "code",
    title: o.title,
    segments: [
      {
        id: `s${id}`,
        src: { kind: "free" },
        path: "",
        lang: o.lang ?? "c",
        start: 1,
        end: text.length,
        text: text.slice(),
        version: { kind: "none" },
      },
    ],
  }) as CodeCard;
const repo = (qual: string, id: string) => {
  const s = findSym(qual);
  const c = symCard(s.f, s.s);
  c.id = id;
  return c;
};

function board(): Board {
  const b = emptyBoard("b1", "cchead");
  put(b, free("f1", C_CODE, { title: "vecAdd - cpu" }), 60, 60, 480);
  put(
    b,
    {
      id: "n1",
      kind: "note",
      md: "The plain way: one loop, **one pair of elements at a time**.\n\nNext step: a CUDA kernel where each thread computes one `C_h[i]`.",
      look: "note",
    } as never,
    600,
    60,
    360,
  );
  put(b, repo("Scheduler.preempt", "r1"), 60, 300, 480);
  put(b, free("f2", LONG, { title: "vecAdd - fit" }), 60, 520, 320);
  b.place.f2.h = 70; // set too short by hand: Fit Content has to bring the height back too
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const setTheme = async (h: Host, theme: string) => {
  await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, theme } } as never });
  await idle(h); // the look's transitions are over
};
async function save(h: Host, name: string, sel?: string) {
  const file = path.join(OUT, `${name}.png`);
  if (sel) {
    // all the elements the selector matches, with a margin
    const bs = (await Promise.all((await h.page.locator(sel).all()).map((l) => l.boundingBox()))).filter((b) => !!b);
    const x = Math.max(0, Math.min(...bs.map((b) => b.x)) - 24),
      y = Math.max(0, Math.min(...bs.map((b) => b.y)) - 24);
    await h.page.screenshot({
      path: file,
      clip: {
        x,
        y,
        width: Math.max(...bs.map((b) => b.x + b.width)) + 24 - x,
        height: Math.max(...bs.map((b) => b.y + b.height)) + 24 - y,
      },
    });
  } else await h.page.screenshot({ path: file });
  const d = process.env.SHOTS_DIR;
  if (d) {
    fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(file, path.join(d, `${name}.png`));
  }
}
/** Header items of a card: rects, whether the title is cut, the hover group's width and opacity */
const head = (pg: Page, id: string) =>
  pg.evaluate((id) => {
    const hd = document.querySelector<HTMLElement>(`.card[data-id="${id}"] > .cface > .chead`)!;
    const q = (s: string) => hd.querySelector<HTMLElement>(s);
    const rect = (el: HTMLElement | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        l: Math.round(r.left * 10) / 10,
        r: Math.round(r.right * 10) / 10,
        t: Math.round(r.top),
        h: Math.round(r.height),
        w: Math.round(r.width * 10) / 10,
      };
    };
    const cut = (el: HTMLElement | null) => {
      if (!el) return false;
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.getBoundingClientRect().width > el.getBoundingClientRect().width + 0.01;
    };
    const hov = q(".hov");
    return {
      headH: hd.offsetHeight,
      head: rect(hd),
      title: rect(q(".ctitle")),
      titleCut: cut(q(".ctitle")),
      path: rect(q(".cpath")),
      pathCut: cut(q(".cpath .rl")),
      hovW: hov ? hov.getBoundingClientRect().width : -1,
      hovO: hov ? +getComputedStyle(hov).opacity : -1,
      copy: rect(q(".ib.cpy")),
      lang: rect(q(".lang")),
      langText: q(".lang")?.textContent ?? null,
      more: rect(q('.ib[aria-label="Card Menu"]')),
      kind: !!q(".kind")?.getClientRects().length,
    };
  }, id);
/** Pointer off the cards and nothing selected (a selected card shows its hover-only buttons too) */
const away = async (h: Host) => {
  await h.page.mouse.click(1000, 780);
  await h.page.mouse.move(1000, 790);
  await idle(h);
};

test("codeHeaderHoverOnly", async () => {
  const h = await open({ board: board(), light, w: 1100, h: 800, settings: { theme: "warm-ink" } as never });
  for (const theme of ["warm-ink", "soft-light"]) {
    await setTheme(h, theme);
    await away(h);
    const rest = await head(h.page, "f1");
    await save(h, `cchead-${theme}-free`, '.card[data-id="f1"]');
    await h.page.hover('.card[data-id="f1"] .cbody');
    await idle(h); // the hover group has opened and faded in
    const hov = await head(h.page, "f1");
    await save(h, `cchead-${theme}-free-hover`, '.card[data-id="f1"]');
    // the language label is what's under the pointer at its centre (not the header's drag area), and it opens the language menu
    const top = await h.page.evaluate(() => {
      const l = document.querySelector<HTMLElement>('.card[data-id="f1"] .chead .lang')!;
      const r = l.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === l;
    });
    await h.page.locator('.card[data-id="f1"] .chead .lang').click();
    await h.page.locator(".ctx button").first().waitFor();
    await idle(h);
    const menu = await h.page.evaluate(() =>
      [...document.querySelectorAll(".ctx button")].map((b) => b.textContent?.trim() ?? ""),
    );
    await h.page.keyboard.press("Escape");
    await idle(h);
    check(
      `codeHeaderHoverOnly hidden until hover (${theme})`,
      rest.hovW < 1 && rest.hovO === 0 && !rest.kind && rest.title!.r <= rest.more!.l,
      rest,
    );
    check(
      `codeHeaderHoverOnly copy and language on hover (${theme})`,
      hov.hovW > 30 &&
        hov.hovO === 1 &&
        hov.langText === "C" &&
        hov.title!.r <= hov.copy!.l &&
        hov.copy!.r <= hov.lang!.l &&
        hov.lang!.r <= hov.more!.l &&
        hov.more!.r <= hov.head!.r,
      hov,
    );
    check(
      `codeHeaderHoverOnly language label opens the menu (${theme})`,
      top && menu.some((t) => t.startsWith("Auto-detect")) && menu.includes("C") && menu.includes("Python"),
      { top, menu },
    );
    // leaving the card closes the group gently: the resting state's transition fades first, then eases the width shut over 200+ ms
    await away(h);
    const closing = await h.page.evaluate(() => {
      const t = getComputedStyle(document.querySelector('.card[data-id="f1"] .chead > .hov')!);
      return { prop: t.transitionProperty, dur: t.transitionDuration, delay: t.transitionDelay };
    });
    const durs = closing.dur.split(",").map((d) => parseFloat(d) * 1000),
      delays = closing.delay.split(",").map((d) => parseFloat(d) * 1000);
    const wi = closing.prop
      .split(",")
      .map((p) => p.trim())
      .indexOf("grid-template-columns");
    check(
      `codeHeaderHoverOnly closes with an animation (${theme})`,
      wi >= 0 && durs[wi] >= 200 && delays[wi] > 0,
      closing,
    );
    // repo card: copy is hover-only too, the path follows the title
    await away(h);
    const r0 = await head(h.page, "r1");
    await save(h, `cchead-${theme}-repo`, '.card[data-id="r1"]');
    check(
      `codeHeaderHoverOnly repo card (${theme})`,
      r0.hovW < 1 && r0.lang === null && r0.path!.l >= r0.title!.r && r0.path!.r <= r0.more!.l,
      r0,
    );
    // a narrow card whose title fits the row minus the always-visible buttons: not cut until hovered (then the hover buttons take room)
    const w = await h.page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('.card[data-id="f1"]')!,
        hd = card.querySelector<HTMLElement>(".chead")!;
      const t = hd.querySelector<HTMLElement>(".ctitle")!,
        more = hd.querySelector<HTMLElement>('.ib[aria-label="Card Menu"]')!;
      // the room between the title and ··· now, less one gap and 2px: the title just fits next to ··· but not next to copy + language too
      const free =
        more.getBoundingClientRect().left -
        t.getBoundingClientRect().right -
        parseFloat(getComputedStyle(hd).columnGap) -
        2;
      const w = Math.ceil(card.offsetWidth - free);
      card.style.width = `${w}px`;
      return w;
    });
    await idle(h);
    const narrow = await head(h.page, "f1");
    await h.page.hover('.card[data-id="f1"] .cbody');
    await idle(h);
    const narrowHov = await head(h.page, "f1");
    await away(h);
    await h.page.evaluate(() => {
      document.querySelector<HTMLElement>('.card[data-id="f1"]')!.style.width = "";
    });
    check(
      `codeHeaderHoverOnly short title not cut in a narrow card (${theme})`,
      !narrow.titleCut && narrow.hovW < 1 && narrowHov.titleCut && narrowHov.more!.r <= narrowHov.head!.r + 0.5,
      { w, narrow, narrowHov },
    );
  }
  await setTheme(h, "warm-ink");
  await save(h, "cchead-warm-ink-free-note", '.card[data-id="f1"], .card[data-id="n1"]');
  await h.page.screenshot({ path: path.join(OUT, "cchead-warm-ink-board.png") });
  await setTheme(h, "soft-light");
  await save(h, "cchead-soft-light-free-note", '.card[data-id="f1"], .card[data-id="n1"]');
  await h.page.screenshot({ path: path.join(OUT, "cchead-soft-light-board.png") });
});

test("freeCodeLanguageDetect", async () => {
  const h = await open({ board: emptyBoard("b1", "lang"), light, w: 1300, h: 700 });
  const seg = () => {
    const c = h.board().cards[0] as CodeCard | undefined;
    return c?.segments[0];
  };
  /** act, then wait until the host has the card's code changed and the board has settled */
  const saved = async (what: string, act: () => Promise<unknown>) => {
    const s0 = JSON.stringify(seg() ?? null);
    await act();
    await until(h, what, () => JSON.stringify(seg() ?? null) !== s0);
    await idle(h);
  };
  await h.page.mouse.click(300, 200, { button: "right" });
  await h.page.locator(".ctx button", { hasText: "New Code" }).click();
  await h.page.locator(".card .cm-content:focus").waitFor();
  await h.page.keyboard.insertText(C_CODE.join("\n"));
  await h.page.mouse.click(900, 650);
  await until(h, "the typed code is saved", () => seg()?.text.join("\n") === C_CODE.join("\n"));
  await idle(h);
  const id = h.board().cards[0]?.id;
  const detected = { lang: seg()?.lang, label: id ? (await head(h.page, id)).langText : null };
  // pick Python by hand, then change the code: stays Python
  await h.page.hover(`.card[data-id="${id}"] .cbody`);
  await idle(h);
  await h.page.locator(`.card[data-id="${id}"] .chead .lang`).click();
  await saved("the picked language is saved", () => h.page.locator(".ctx button", { hasText: /^Python$/ }).click());
  const picked = { lang: seg()?.lang, src: seg()?.src };
  await h.page.locator(`.card[data-id="${id}"] .src`).dblclick();
  await h.page.locator(`.card[data-id="${id}"] .cm-content:focus`).waitFor();
  await h.page.keyboard.press("ControlOrMeta+End");
  await h.page.keyboard.insertText("\n// changed");
  await saved("the changed code is saved", () => h.page.mouse.click(900, 650));
  const kept = { lang: seg()?.lang, last: seg()?.text.at(-1) };
  // Auto-detect: back to C
  await h.page.hover(`.card[data-id="${id}"] .cbody`);
  await idle(h);
  await h.page.locator(`.card[data-id="${id}"] .chead .lang`).click();
  await saved("Auto-detect is saved", () => h.page.locator(".ctx button", { hasText: "Auto-detect" }).click());
  const auto = { lang: seg()?.lang, src: seg()?.src };
  check("freeCodeLanguageDetect typed C code is C", detected.lang === "c" && detected.label === "C", detected);
  check(
    "freeCodeLanguageDetect a picked language sticks",
    picked.lang === "python" &&
      (picked.src as { langPicked?: boolean })?.langPicked === true &&
      kept.lang === "python" &&
      kept.last === "// changed",
    { picked, kept },
  );
  check(
    "freeCodeLanguageDetect Auto-detect detects again",
    auto.lang === "c" && !(auto.src as { langPicked?: boolean })?.langPicked,
    auto,
  );
});

test("softLightCodeHeaderOneRow", async () => {
  const b = board();
  const long = "a very long title for this vector addition on the cpu that cannot fit";
  (b.cards.find((c) => c.id === "f1") as CodeCard).title = long;
  (b.cards.find((c) => c.id === "r1") as CodeCard).title = long;
  const h = await open({ board: b, light, w: 1100, h: 800, settings: { theme: "soft-light" } as never });
  await setTheme(h, "soft-light");
  await away(h);
  const f = await head(h.page, "f1"),
    r = await head(h.page, "r1");
  const note = await h.page.evaluate(
    () => document.querySelector<HTMLElement>('.card[data-id="n1"] > .cface > .chead')!.offsetHeight,
  );
  await save(h, "cchead-soft-light-long-title", '.card[data-id="f1"], .card[data-id="r1"]');
  const oneRow = (x: typeof f) =>
    x.headH === 40 &&
    x.title!.h < 20 &&
    x.titleCut &&
    x.title!.r <= x.more!.l &&
    x.more!.t >= x.head!.t &&
    x.more!.t + x.more!.h <= x.head!.t + 40;
  check("softLightCodeHeaderOneRow free card", oneRow(f) && note === 40, { f, note });
  check(
    "softLightCodeHeaderOneRow repo card, path cut before the title",
    oneRow(r) && r.pathCut && r.path!.l >= r.title!.r - 0.5,
    r,
  );
});

/** The code area's paddings: line numbers' left edge to the well's, code padding top / bottom, the longest line to the right edge */
const pads = (pg: Page, id: string) =>
  pg.evaluate((id) => {
    const card = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!;
    const body = card.querySelector<HTMLElement>(".cbody")!,
      code = body.querySelector<HTMLElement>(".code")!,
      src = code.querySelector<HTMLElement>(".src")!;
    const nos = [...code.querySelectorAll<HTMLElement>(".gutter .no")];
    const left = Math.min(
      ...nos.map((n) => {
        const r = document.createRange();
        r.selectNodeContents(n);
        return r.getBoundingClientRect().left;
      }),
    );
    const right = Math.max(
      ...nos.map((n) => {
        const r = document.createRange();
        r.selectNodeContents(n);
        return r.getBoundingClientRect().right;
      }),
    );
    const cs = getComputedStyle(code);
    return {
      noLeft: Math.round((left - body.getBoundingClientRect().left) * 10) / 10,
      gap: Math.round((src.getBoundingClientRect().left - right) * 10) / 10,
      top: parseFloat(cs.paddingTop),
      bottom: parseFloat(cs.paddingBottom),
      right: parseFloat(getComputedStyle(src).paddingRight),
    };
  }, id);

test("codeAreaPadding", async () => {
  const h = await open({ board: board(), light, w: 1100, h: 800, settings: { theme: "warm-ink" } as never });
  const out: Record<string, unknown> = {};
  for (const theme of ["warm-ink", "soft-light"]) {
    await setTheme(h, theme);
    out[theme] = { free: await pads(h.page, "f1"), repo: await pads(h.page, "r1") };
  }
  const sl = out["soft-light"] as { free: Awaited<ReturnType<typeof pads>>; repo: Awaited<ReturnType<typeof pads>> };
  const wi = out["warm-ink"] as typeof sl;
  const gapOk = [sl.free, sl.repo, wi.free, wi.repo].every((p) => Math.abs(p.gap - 22) < 0.6);
  const slOk = [sl.free, sl.repo].every(
    (p) => Math.abs(p.noLeft - 7) < 0.6 && p.top === 4 && p.bottom === 6 && p.right === 8,
  );
  const wiOk = [wi.free, wi.repo].every(
    (p) => Math.abs(p.noLeft - 17) < 0.6 && p.top === 6 && p.bottom === 8 && p.right === 18,
  );
  check(
    "codeAreaPadding Soft Light 7 left of the numbers, 4 / 6, 8 right; Warm Ink 17, 6 / 8, 18 right; 22 from numbers to code",
    slOk && wiOk && gapOk,
    out,
  );
});

test("fitContentWidthCodeCard", async () => {
  const h = await open({ board: board(), light, w: 1100, h: 800, settings: { theme: "warm-ink" } as never });
  for (const theme of ["warm-ink", "soft-light"]) {
    await setTheme(h, theme);
    const w0 = await h.page.evaluate(() => document.querySelector<HTMLElement>('.card[data-id="f2"]')!.offsetWidth);
    const scroll0 = await h.page.evaluate(() => {
      const b = document.querySelector<HTMLElement>('.card[data-id="f2"] .cbody')!;
      return b.scrollWidth > b.clientWidth + 1;
    });
    const hd = (await h.page.locator('.card[data-id="f2"] .chead').boundingBox())!;
    await h.page.mouse.click(hd.x + hd.width - 60, hd.y + hd.height / 2);
    await idle(h);
    await save(h, `cchead-${theme}-fit-before`, '.card[data-id="f2"]');
    await h.page.keyboard.press("Alt+KeyF");
    // the width mid-way: the first frame in which the fit animation has moved the card off its old width
    const mid = (await (
      await h.page.waitForFunction(
        (w0) => {
          const w = document.querySelector<HTMLElement>('.card[data-id="f2"]')!.offsetWidth;
          return w !== w0 && w;
        },
        w0,
        { polling: "raf" },
      )
    ).jsonValue()) as number;
    await idle(h);
    const after = await h.page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('.card[data-id="f2"]')!,
        b = card.querySelector<HTMLElement>(".cbody")!;
      const ls = [...b.querySelectorAll<HTMLElement>(".src .l")];
      const right = Math.max(
        ...ls.map((l) => {
          const r = document.createRange();
          r.selectNodeContents(l);
          return r.getBoundingClientRect().right;
        }),
      );
      return {
        w: card.offsetWidth,
        hscroll: b.scrollWidth > b.clientWidth + 1,
        vscroll: b.scrollHeight > b.clientHeight + 1,
        gap: b.clientHeight - b.scrollHeight,
        room: Math.round(b.getBoundingClientRect().right - right),
      };
    });
    const pw = h.board().place.f2.w;
    await save(h, `cchead-${theme}-fit-after`, '.card[data-id="f2"]');
    const pr = theme === "soft-light" ? 8 : 18;
    check(
      `fitContentWidthCodeCard ${theme}`,
      scroll0 &&
        !after.hscroll &&
        !after.vscroll &&
        after.gap <= 2 &&
        after.w > w0 &&
        pw === after.w &&
        mid > w0 &&
        mid < after.w &&
        after.room >= pr &&
        after.room <= pr + 8,
      { w0, mid, after, pw, scroll0 },
    );
    // back to the narrow width for the next theme
    await h.page.keyboard.press("ControlOrMeta+z");
    await until(h, "the undone width is saved", () => h.board().place.f2.w !== pw);
    await idle(h);
  }
});

/** The looks to check (City is experimental) */
const LOOKS = [
  "warm-ink",
  "soft-light",
  "classic",
  "drafting",
  "graphite",
  "colorful",
  "newspaper",
  "poster",
  "ink-wash",
];
// 105 lines: 3-digit line numbers, lines of different lengths
const MANY = Array.from({ length: 105 }, (_, i) =>
  i === 61
    ? "    total = total + values[i] * weights[i] - offsets[i] / (scale + 1.0f); // longest"
    : `    total += values[${i}];${" ".repeat(i % 7)}`,
);
function fitBoard(): Board {
  const b = emptyBoard("b1", "fitthemes");
  put(b, free("f1", C_CODE, { title: "five lines" }), 60, 60, 300);
  const wrap = free("w1", LONG, { title: "wrapped" });
  wrap.wrap = true;
  put(b, wrap, 60, 300, 1000);
  // wrap on and too narrow: the long line wraps before ⌥F (the fitted height is the unwrapped one)
  const narrow = free("w2", LONG, { title: "wrapped narrow" });
  narrow.wrap = true;
  put(b, narrow, 760, 60, 300);
  put(b, free("m1", MANY, { title: "many lines" }), 60, 560, 320);
  b.place.m1.h = 300;
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const FIT_IDS = ["f1", "w1", "w2", "m1"] as const;
/** What a fitted card looks like now: width, code area height, wrapped lines, scrollbars */
const fitState = (pg: Page) =>
  pg.evaluate(
    (ids) =>
      Object.fromEntries(
        ids.map((id) => {
          const card = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!,
            b = card.querySelector<HTMLElement>(".cbody")!;
          const ls = [...b.querySelectorAll<HTMLElement>(".src .l")];
          return [
            id,
            {
              w: card.offsetWidth,
              h: card.querySelector<HTMLElement>(":scope > .cface > .carea")!.offsetHeight,
              lines: ls.length,
              wrapped: ls.filter((l) => l.getClientRects().length && l.offsetHeight > 21).length,
              hscroll: b.scrollWidth > b.clientWidth + 1,
              vscroll: b.scrollHeight > b.clientHeight + 1,
              wrapOn: b.classList.contains("wrap"),
            },
          ];
        }),
      ),
    FIT_IDS as unknown as string[],
  );
async function fitAll(h: Host) {
  await h.page.mouse.click(1050, 40);
  await idle(h);
  await h.page.keyboard.press("ControlOrMeta+a");
  await h.page.keyboard.press("Alt+KeyF");
  await idle(h); // fitted, the animation over
  const st = await fitState(h.page);
  // h: the stored code area height (none = follows its content, only a card taller than the cap stores one); ca: the code area's height on screen
  return Object.fromEntries(
    FIT_IDS.map((id) => [id, { w: h.board().place[id].w!, h: h.board().place[id].h ?? null, ca: st[id].h }]),
  );
}
const same = (a: { w: number; h: number | null; ca: number }, b: typeof a) =>
  Math.abs(a.w - b.w) <= 1 &&
  Math.abs(a.ca - b.ca) <= 1 &&
  (a.h === null) === (b.h === null) &&
  (a.h === null || Math.abs(a.h - b.h!) <= 1);

test("fitContentSameInEveryTheme", async () => {
  const h = await open({ board: fitBoard(), light, w: 1100, h: 800, settings: { theme: "warm-ink" } as never });
  const fits: Record<string, Record<string, { w: number; h: number | null; ca: number }>> = {};
  const bad: unknown[] = [];
  const PADS = 14; // code area height: 6 + lines + 8 (Soft Light: 4 + lines + 6 + 4 under the well)
  // ⌥F in each look on its own
  for (const theme of LOOKS) {
    await setTheme(h, theme);
    fits[theme] = await fitAll(h);
    const st = await fitState(h.page);
    for (const id of FIT_IDS) {
      const s = st[id];
      if (
        s.wrapped ||
        s.hscroll ||
        s.vscroll ||
        Math.abs(s.h - (s.lines * 20 + PADS)) > 1 ||
        Math.abs(s.w - fits[theme][id].w) > 1
      )
        bad.push({ theme, id, s, fit: fits[theme][id] });
    }
    if (!st.w1.wrapOn || !st.w2.wrapOn) bad.push({ theme, wrapOff: true });
    if (theme === "warm-ink" || theme === "soft-light")
      await save(h, `fitthemes-${theme}`, '.card[data-id="f1"], .card[data-id="w1"]');
  }
  const ref = fits["warm-ink"];
  const diff = LOOKS.flatMap((t) =>
    FIT_IDS.filter((id) => !same(fits[t][id], ref[id])).map((id) => ({ t, id, got: fits[t][id], ref: ref[id] })),
  );
  check("fitContentSameInEveryTheme every look fits to the same Place", diff.length === 0, { diff, ref });
  check(
    "fitContentSameInEveryTheme short cards follow their content, the 105-line card stores its height",
    ref.f1.h === null && ref.w1.h === null && ref.w2.h === null && ref.m1.h === 105 * 20 + 14,
    ref,
  );
  check(
    "fitContentSameInEveryTheme fitted, no wrapped line, no scroll, carea = lines × 20 + 14",
    bad.length === 0,
    bad,
  );
  // the wrapped card shrank from 1000 to its longest line
  check(
    "fitContentSameInEveryTheme a too-wide / too-narrow wrapped card fits its longest line",
    ref.w1.w < 700 && ref.w1.w > ref.f1.w && same(ref.w2, ref.w1),
    ref,
  );
  // fitted in one, switched to the others: still fits exactly (both directions)
  const moved: unknown[] = [];
  for (const from of ["warm-ink", "soft-light"]) {
    await setTheme(h, from);
    await fitAll(h);
    for (const theme of LOOKS) {
      if (theme === from) continue;
      await setTheme(h, theme);
      const st = await fitState(h.page);
      for (const id of FIT_IDS) {
        const s = st[id];
        if (
          s.wrapped ||
          s.hscroll ||
          s.vscroll ||
          Math.abs(s.w - fits[theme][id].w) > 1 ||
          Math.abs(s.h - fits[theme][id].ca) > 1
        )
          moved.push({ from, theme, id, s, fit: fits[theme][id] });
      }
      if (from === "warm-ink" && theme === "soft-light")
        await save(h, "fitthemes-warm-ink-to-soft-light", '.card[data-id="f1"], .card[data-id="w1"]');
    }
  }
  check(
    "fitContentSameInEveryTheme fitted in Warm Ink / Soft Light, fits exactly in every other look",
    moved.length === 0,
    moved,
  );
  // the 105-line card, for the screenshots
  for (const theme of ["warm-ink", "soft-light"]) {
    await setTheme(h, theme);
    await h.page.mouse.click(1050, 40);
    await idle(h);
    // pan down to the card's longest line (line 62)
    await h.page.mouse.move(700, 400);
    await h.page.mouse.wheel(0, 1200);
    await idle(h);
    await save(h, `fitthemes-${theme}-many`);
    await h.page.mouse.wheel(0, -1200);
    await idle(h);
  }
});

test("fitContentFollowsCodeEdits", async () => {
  for (const theme of ["warm-ink", "soft-light"]) {
    const b = emptyBoard("b1", "fitedit");
    put(b, free("f1", C_CODE, { title: "grows" }), 80, 80, 300);
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light, w: 1100, h: 800, settings: { theme } as never });
    await setTheme(h, theme);
    const pg = h.page;
    const size = () =>
      pg.evaluate(() => {
        const c = document.querySelector<HTMLElement>('.card[data-id="f1"]')!,
          bd = c.querySelector<HTMLElement>(".cbody")!;
        return { h: c.offsetHeight, vscroll: bd.scrollHeight > bd.clientHeight + 1 };
      });
    const addLines = async (n: number) => {
      await pg.locator('.card[data-id="f1"] .src .l').nth(1).dblclick();
      await pg.waitForSelector('.card[data-id="f1"] .cm-content', { timeout: 8000 });
      await pg.keyboard.press("ControlOrMeta+End");
      const lines0 = await pg.locator('.card[data-id="f1"] .cm-line').count();
      for (let i = 0; i < n; i++) await pg.keyboard.insertText(`\n// added ${i}`);
      await until(
        h,
        "the added lines are in the editor",
        async () => (await pg.locator('.card[data-id="f1"] .cm-line').count()) === lines0 + n,
      );
      await idle(h);
      const editing = await size();
      const saved0 = (h.board().cards[0] as CodeCard).segments[0].text.length;
      await pg.mouse.click(1000, 760);
      await until(
        h,
        "the added lines are saved",
        () => (h.board().cards[0] as CodeCard).segments[0].text.length === saved0 + n,
      );
      await idle(h);
      return { editing, after: await size() };
    };
    const hd = (await pg.locator('.card[data-id="f1"] .chead').boundingBox())!;
    await pg.mouse.click(hd.x + 40, hd.y + hd.height / 2);
    await idle(h);
    await pg.keyboard.press("Alt+KeyF");
    await idle(h);
    const fitted = { ...(await size()), place: { ...h.board().place.f1 } };
    const grown = await addLines(3);
    check(
      `fitContentFollowsCodeEdits ${theme} a fitted card grows by 3 lines while editing and after`,
      fitted.place.h === undefined &&
        !fitted.vscroll &&
        Math.abs(grown.editing.h - fitted.h - 60) <= 1 &&
        Math.abs(grown.after.h - fitted.h - 60) <= 1 &&
        !grown.editing.vscroll &&
        !grown.after.vscroll,
      { fitted, grown },
    );
    // drag the corner handle down 60px (Ctrl: no snapping): the height is stored and stays
    await pg.hover('.card[data-id="f1"] .cbody');
    await idle(h);
    const g = (await pg.locator('.card[data-id="f1"] .grip').boundingBox())!;
    await pg.keyboard.down("Control");
    await pg.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await pg.mouse.down();
    await pg.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + 30, { steps: 4 });
    await pg.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + 60, { steps: 4 });
    await pg.mouse.up();
    await pg.keyboard.up("Control");
    await until(h, "the dragged height is saved", () => typeof h.board().place.f1.h === "number");
    await idle(h);
    const dragged = { ...(await size()), place: { ...h.board().place.f1 } };
    const fixed = await addLines(1);
    check(
      `fitContentFollowsCodeEdits ${theme} a dragged height stays when a line is added`,
      typeof dragged.place.h === "number" &&
        Math.abs(dragged.h - grown.after.h - 60) <= 1 &&
        Math.abs(fixed.after.h - dragged.h) <= 1 &&
        h.board().place.f1.h === dragged.place.h,
      { dragged, fixed, h: h.board().place.f1.h },
    );
    await h.close();
  }
});

// Code card header (Free code and repo code cards) and the code area around it:
//  codeHeaderHoverOnly          Copy Code and the language label (Free cards) take no width until the card is hovered, then open
//                               and fade in together, right of the title, left of ···; the label opens the language menu.
//                               A short title that fits the row without them is not cut while the card isn't hovered
//  freeCodeLanguageDetect       typed C code is detected as C; a language picked from the menu sticks when the code changes again;
//                               Auto-detect goes back to detecting
//  softLightCodeHeaderOneRow    Soft Light: the header is one 40px row (like the Note's) with a long title, which ellipsizes;
//                               the repo card's path ellipsizes before its title
//  codeAreaPadding              the code area's paddings: Soft Light 7px left of the line numbers, 4 / 6 above and below, 8 right;
//                               Warm Ink unchanged (6 / 8, 24 right)
//  fitContentWidthCodeCard      ⌥F fits a code card's width to its longest line and its height to its lines (animated), in Warm Ink and Soft Light
// Usage: npm run harness -- codeHeaderHoverOnly …   screenshots: test-out/harness/cchead-*.png (SHOTS_DIR=… copies them)
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS, emptyBoard, type Board, type CodeCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { put, symCard, findSym, OUT, type Host } from "../harness";
import { test, open, check, light } from "../fixtures";

const C_CODE = ["void vecAdd(float* A_h, float* B_h, float* C_h, int n) {", "    for (int i = 0; i < n; ++i) {", "        C_h[i] = A_h[i] + B_h[i];", "    }", "}"];
const LONG = [...C_CODE.slice(0, 2), "        C_h[i] = A_h[i] + B_h[i] + A_h[i] * B_h[i] - A_h[i] / (B_h[i] + 1.0f) + 0.5f;", ...C_CODE.slice(3)];

const free = (id: string, text: string[], o: { lang?: string; title?: string } = {}): CodeCard =>
  ({ id, kind: "code", title: o.title, segments: [{ id: `s${id}`, src: { kind: "free" }, path: "", lang: o.lang ?? "c", start: 1, end: text.length, text: text.slice(), version: { kind: "none" } }] }) as CodeCard;
const repo = (qual: string, id: string) => { const s = findSym(qual); const c = symCard(s.f, s.s); c.id = id; return c; };

function board(): Board {
  const b = emptyBoard("b1", "cchead");
  put(b, free("f1", C_CODE, { title: "vecAdd - cpu" }), 60, 60, 480);
  put(b, { id: "n1", kind: "note", md: "The plain way: one loop, **one pair of elements at a time**.\n\nNext step: a CUDA kernel where each thread computes one `C_h[i]`.", bg: true } as never, 600, 60, 360);
  put(b, repo("Scheduler.preempt", "r1"), 60, 300, 480);
  put(b, free("f2", LONG, { title: "vecAdd - fit" }), 60, 520, 320);
  b.place.f2.h = 70; // set too short by hand: Fit Content has to bring the height back too
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const setTheme = async (h: Host, theme: string) => {
  await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, theme } } as never });
  await h.page.waitForTimeout(450);
};
async function save(h: Host, name: string, sel?: string) {
  const file = path.join(OUT, `${name}.png`);
  if (sel) {
    // all the elements the selector matches, with a margin
    const bs = (await Promise.all((await h.page.locator(sel).all()).map((l) => l.boundingBox()))).filter((b) => !!b);
    const x = Math.max(0, Math.min(...bs.map((b) => b.x)) - 24), y = Math.max(0, Math.min(...bs.map((b) => b.y)) - 24);
    await h.page.screenshot({ path: file, clip: { x, y, width: Math.max(...bs.map((b) => b.x + b.width)) + 24 - x, height: Math.max(...bs.map((b) => b.y + b.height)) + 24 - y } });
  } else await h.page.screenshot({ path: file });
  const d = process.env.SHOTS_DIR;
  if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(file, path.join(d, `${name}.png`)); }
}
/** Header items of a card: rects, whether the title is cut, the hover group's width and opacity */
const head = (pg: Page, id: string) => pg.evaluate((id) => {
  const hd = document.querySelector<HTMLElement>(`.card[data-id="${id}"] > .cface > .chead`)!;
  const q = (s: string) => hd.querySelector<HTMLElement>(s);
  const rect = (el: HTMLElement | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left * 10) / 10, r: Math.round(r.right * 10) / 10, t: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width * 10) / 10 }; };
  const cut = (el: HTMLElement | null) => { if (!el) return false; const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width > el.getBoundingClientRect().width + 0.01; };
  const hov = q(".hov");
  return {
    headH: hd.offsetHeight, head: rect(hd), title: rect(q(".ctitle")), titleCut: cut(q(".ctitle")), path: rect(q(".cpath")), pathCut: cut(q(".cpath .rl")),
    hovW: hov ? hov.getBoundingClientRect().width : -1, hovO: hov ? +getComputedStyle(hov).opacity : -1,
    copy: rect(q(".ib.cpy")), lang: rect(q(".lang")), langText: q(".lang")?.textContent ?? null, more: rect(q('.ib[aria-label="Card Menu"]')),
    kind: !!q(".kind")?.getClientRects().length,
  };
}, id);
/** Pointer off the cards and nothing selected (a selected card shows its hover-only buttons too) */
const away = async (pg: Page) => { await pg.mouse.click(1000, 780); await pg.mouse.move(1000, 790); await pg.waitForTimeout(250); };

test("codeHeaderHoverOnly", async () => {
  const h = await open({ board: board(), light, w: 1100, h: 800, settings: { theme: "warm-ink" } as never });
  for (const theme of ["warm-ink", "soft-light"]) {
    await setTheme(h, theme);
    await away(h.page); await h.page.waitForTimeout(300);
    const idle = await head(h.page, "f1");
    await save(h, `cchead-${theme}-free`, '.card[data-id="f1"]');
    await h.page.hover('.card[data-id="f1"] .cbody'); await h.page.waitForTimeout(400);
    const hov = await head(h.page, "f1");
    await save(h, `cchead-${theme}-free-hover`, '.card[data-id="f1"]');
    // the language label is what's under the pointer at its centre (not the header's drag area), and it opens the language menu
    const top = await h.page.evaluate(() => { const l = document.querySelector<HTMLElement>('.card[data-id="f1"] .chead .lang')!; const r = l.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === l; });
    await h.page.locator('.card[data-id="f1"] .chead .lang').click(); await h.page.waitForTimeout(300);
    const menu = await h.page.evaluate(() => [...document.querySelectorAll(".ctx button")].map((b) => b.textContent?.trim() ?? ""));
    await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(200);
    check(`codeHeaderHoverOnly hidden until hover (${theme})`, idle.hovW < 1 && idle.hovO === 0 && !idle.kind && idle.title!.r <= idle.more!.l, idle);
    check(`codeHeaderHoverOnly copy and language on hover (${theme})`, hov.hovW > 30 && hov.hovO === 1 && hov.langText === "C"
      && hov.title!.r <= hov.copy!.l && hov.copy!.r <= hov.lang!.l && hov.lang!.r <= hov.more!.l && hov.more!.r <= hov.head!.r, hov);
    check(`codeHeaderHoverOnly language label opens the menu (${theme})`, top && menu.some((t) => t.startsWith("Auto-detect")) && menu.includes("C") && menu.includes("Python"), { top, menu });
    // leaving the card closes the group gently: 100 ms later it is still part open and fading
    await away(h.page); await h.page.waitForTimeout(300);
    await h.page.hover('.card[data-id="f1"] .cbody'); await h.page.waitForTimeout(400);
    await h.page.mouse.move(1000, 790); await h.page.waitForTimeout(100);
    const closing = await head(h.page, "f1");
    check(`codeHeaderHoverOnly closes with an animation (${theme})`, closing.hovW > 10 && closing.hovO < 1, closing);
    // repo card: copy is hover-only too, the path follows the title
    await away(h.page); await h.page.waitForTimeout(300);
    const r0 = await head(h.page, "r1");
    await save(h, `cchead-${theme}-repo`, '.card[data-id="r1"]');
    check(`codeHeaderHoverOnly repo card (${theme})`, r0.hovW < 1 && r0.lang === null && r0.path!.l >= r0.title!.r && r0.path!.r <= r0.more!.l, r0);
    // a narrow card whose title fits the row minus the always-visible buttons: not cut until hovered (then the hover buttons take room)
    const w = await h.page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('.card[data-id="f1"]')!, hd = card.querySelector<HTMLElement>(".chead")!;
      const t = hd.querySelector<HTMLElement>(".ctitle")!, more = hd.querySelector<HTMLElement>('.ib[aria-label="Card Menu"]')!;
      // the room between the title and ··· now, less one gap and 2px: the title just fits next to ··· but not next to copy + language too
      const free = more.getBoundingClientRect().left - t.getBoundingClientRect().right - parseFloat(getComputedStyle(hd).columnGap) - 2;
      const w = Math.ceil(card.offsetWidth - free);
      card.style.width = `${w}px`;
      return w;
    });
    await h.page.waitForTimeout(100);
    const narrow = await head(h.page, "f1");
    await h.page.hover('.card[data-id="f1"] .cbody'); await h.page.waitForTimeout(400);
    const narrowHov = await head(h.page, "f1");
    await away(h.page);
    await h.page.evaluate(() => { document.querySelector<HTMLElement>('.card[data-id="f1"]')!.style.width = ""; });
    check(`codeHeaderHoverOnly short title not cut in a narrow card (${theme})`, !narrow.titleCut && narrow.hovW < 1 && narrowHov.titleCut && narrowHov.more!.r <= narrowHov.head!.r + 0.5, { w, narrow, narrowHov });
  }
  await setTheme(h, "warm-ink");
  await save(h, "cchead-warm-ink-free-note", '.card[data-id="f1"], .card[data-id="n1"]');
  await h.page.screenshot({ path: path.join(OUT, "cchead-warm-ink-board.png") });
  await setTheme(h, "soft-light");
  await save(h, "cchead-soft-light-free-note", '.card[data-id="f1"], .card[data-id="n1"]');
  await h.page.screenshot({ path: path.join(OUT, "cchead-soft-light-board.png") });
});

test("freeCodeLanguageDetect", async () => {
  const h = await open({ board: emptyBoard("b1", "lang"), light, w: 1000, h: 700 });
  await h.page.mouse.click(300, 200, { button: "right" }); await h.page.waitForTimeout(300);
  await h.page.locator(".ctx button", { hasText: "New Code" }).click(); await h.page.waitForTimeout(500);
  await h.page.keyboard.insertText(C_CODE.join("\n"));
  await h.page.mouse.click(900, 650); await h.page.waitForTimeout(600);
  const seg = () => { const c = h.board().cards[0] as CodeCard | undefined; return c?.segments[0]; };
  const id = h.board().cards[0]?.id;
  const detected = { lang: seg()?.lang, label: id ? (await head(h.page, id)).langText : null };
  // pick Python by hand, then change the code: stays Python
  await h.page.hover(`.card[data-id="${id}"] .cbody`); await h.page.waitForTimeout(300);
  await h.page.locator(`.card[data-id="${id}"] .chead .lang`).click(); await h.page.waitForTimeout(300);
  await h.page.locator(".ctx button", { hasText: /^Python$/ }).click(); await h.page.waitForTimeout(400);
  const picked = { lang: seg()?.lang, src: seg()?.src };
  await h.page.locator(`.card[data-id="${id}"] .src`).dblclick(); await h.page.waitForTimeout(500);
  await h.page.keyboard.press("ControlOrMeta+End"); await h.page.keyboard.insertText("\n// changed");
  await h.page.mouse.click(900, 650); await h.page.waitForTimeout(600);
  const kept = { lang: seg()?.lang, last: seg()?.text.at(-1) };
  // Auto-detect: back to C
  await h.page.hover(`.card[data-id="${id}"] .cbody`); await h.page.waitForTimeout(300);
  await h.page.locator(`.card[data-id="${id}"] .chead .lang`).click(); await h.page.waitForTimeout(300);
  await h.page.locator(".ctx button", { hasText: "Auto-detect" }).click(); await h.page.waitForTimeout(400);
  const auto = { lang: seg()?.lang, src: seg()?.src };
  check("freeCodeLanguageDetect typed C code is C", detected.lang === "c" && detected.label === "C", detected);
  check("freeCodeLanguageDetect a picked language sticks", picked.lang === "python" && (picked.src as { langPicked?: boolean })?.langPicked === true && kept.lang === "python" && kept.last === "// changed", { picked, kept });
  check("freeCodeLanguageDetect Auto-detect detects again", auto.lang === "c" && !(auto.src as { langPicked?: boolean })?.langPicked, auto);
});

test("softLightCodeHeaderOneRow", async () => {
  const b = board();
  const long = "a very long title for this vector addition on the cpu that cannot fit";
  (b.cards.find((c) => c.id === "f1") as CodeCard).title = long;
  (b.cards.find((c) => c.id === "r1") as CodeCard).title = long;
  const h = await open({ board: b, light, w: 1100, h: 800, settings: { theme: "soft-light" } as never });
  await setTheme(h, "soft-light"); await away(h.page);
  const f = await head(h.page, "f1"), r = await head(h.page, "r1");
  const note = await h.page.evaluate(() => document.querySelector<HTMLElement>('.card[data-id="n1"] > .cface > .chead')!.offsetHeight);
  await save(h, "cchead-soft-light-long-title", '.card[data-id="f1"], .card[data-id="r1"]');
  const oneRow = (x: typeof f) => x.headH === 40 && x.title!.h < 20 && x.titleCut && x.title!.r <= x.more!.l && x.more!.t >= x.head!.t && x.more!.t + x.more!.h <= x.head!.t + 40;
  check("softLightCodeHeaderOneRow free card", oneRow(f) && note === 40, { f, note });
  check("softLightCodeHeaderOneRow repo card, path cut before the title", oneRow(r) && r.pathCut && r.path!.l >= r.title!.r - 0.5, r);
});

/** The code area's paddings: line numbers' left edge to the well's, code padding top / bottom, the longest line to the right edge */
const pads = (pg: Page, id: string) => pg.evaluate((id) => {
  const card = document.querySelector<HTMLElement>(`.card[data-id="${id}"]`)!;
  const body = card.querySelector<HTMLElement>(".cbody")!, code = body.querySelector<HTMLElement>(".code")!, src = code.querySelector<HTMLElement>(".src")!;
  const nos = [...code.querySelectorAll<HTMLElement>(".gutter .no")];
  const left = Math.min(...nos.map((n) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect().left; }));
  const cs = getComputedStyle(code);
  return { noLeft: Math.round((left - body.getBoundingClientRect().left) * 10) / 10, top: parseFloat(cs.paddingTop), bottom: parseFloat(cs.paddingBottom), right: parseFloat(getComputedStyle(src).paddingRight) };
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
  const slOk = [sl.free, sl.repo].every((p) => Math.abs(p.noLeft - 7) < 0.6 && p.top === 4 && p.bottom === 6 && p.right === 8);
  const wiOk = [wi.free, wi.repo].every((p) => p.top === 6 && p.bottom === 8 && p.right === 24);
  check("codeAreaPadding Soft Light 7 left of the numbers, 4 / 6, 8 right; Warm Ink unchanged", slOk && wiOk, out);
});

test("fitContentWidthCodeCard", async () => {
  const h = await open({ board: board(), light, w: 1100, h: 800, settings: { theme: "warm-ink" } as never });
  for (const theme of ["warm-ink", "soft-light"]) {
    await setTheme(h, theme);
    const w0 = await h.page.evaluate(() => document.querySelector<HTMLElement>('.card[data-id="f2"]')!.offsetWidth);
    const scroll0 = await h.page.evaluate(() => { const b = document.querySelector<HTMLElement>('.card[data-id="f2"] .cbody')!; return b.scrollWidth > b.clientWidth + 1; });
    const hd = (await h.page.locator('.card[data-id="f2"] .chead').boundingBox())!;
    await h.page.mouse.click(hd.x + hd.width - 60, hd.y + hd.height / 2); await h.page.waitForTimeout(200);
    await save(h, `cchead-${theme}-fit-before`, '.card[data-id="f2"]');
    await h.page.keyboard.press("Alt+KeyF");
    await h.page.waitForTimeout(70);
    const mid = await h.page.evaluate(() => document.querySelector<HTMLElement>('.card[data-id="f2"]')!.offsetWidth);
    await h.page.waitForTimeout(700);
    const after = await h.page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('.card[data-id="f2"]')!, b = card.querySelector<HTMLElement>(".cbody")!;
      const ls = [...b.querySelectorAll<HTMLElement>(".src .l")];
      const right = Math.max(...ls.map((l) => { const r = document.createRange(); r.selectNodeContents(l); return r.getBoundingClientRect().right; }));
      return { w: card.offsetWidth, hscroll: b.scrollWidth > b.clientWidth + 1, vscroll: b.scrollHeight > b.clientHeight + 1, gap: b.clientHeight - b.scrollHeight, room: Math.round(b.getBoundingClientRect().right - right) };
    });
    const pw = h.board().place.f2.w;
    await save(h, `cchead-${theme}-fit-after`, '.card[data-id="f2"]');
    const pr = theme === "soft-light" ? 8 : 24;
    check(`fitContentWidthCodeCard ${theme}`, scroll0 && !after.hscroll && !after.vscroll && after.gap <= 2 && after.w > w0 && pw === after.w && mid > w0 && mid < after.w && after.room >= pr && after.room <= pr + 8, { w0, mid, after, pw, scroll0 });
    // back to the narrow width for the next theme
    await h.page.keyboard.press("ControlOrMeta+z"); await h.page.waitForTimeout(700);
  }
});

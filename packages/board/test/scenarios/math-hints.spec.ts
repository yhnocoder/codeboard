// 写公式时的提示和公式预设：\ 命令补全、实时预览和大白话报错（一键修正）、设置 codeboard.math.preamble 里的 \newcommand。
// Usage: npm run harness -- mathCommandAutocomplete mathInlineAutocomplete mathPreviewPlainErrors mathInlinePreviewBubble
//          mathPreambleMacros mathPreambleSetting mathHintsKeystrokeTime
import * as path from "node:path";
import { put, shot, OUT, type Host } from "../harness";
import { DEFAULT_SETTINGS, emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { test, open, check, light, until, idle, frames } from "../fixtures";

const close = (h: Host) => h.page.context().close();
const PRE = "\\newcommand{\\tid}{\\text{threadIdx.x}}\n\\newcommand{\\bid}{\\text{blockIdx.x}}\n\\newcommand{\\R}{\\mathbb{R}}";

function board(notes: string[]): Board {
  const b = emptyBoard("b1", "math hints");
  notes.forEach((md, i) => put(b, { id: `n${i}`, kind: "note", md, bg: true } as NoteCard, 60 + i * 600, 60, 540));
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const md = (h: Host, id: string) => ((h.board().cards.find((c) => c.id === id) as NoteCard | undefined)?.md ?? "").trim();
const card = (id = "n0") => `.card[data-id="${id}"]`;

/** 双击 Note 进编辑，点公式块：展开原文，光标在最后 */
async function openBlock(h: Host, id = "n0") {
  const pg = h.page;
  await pg.locator(`${card(id)} .nbody p`).first().dblclick();
  await pg.waitForSelector(`${card(id)} .md-pm`, { timeout: 5000 });
  await pg.locator(`${card(id)} .md-pm [data-type=block-math]`).click();
  await pg.locator(`${card(id)} [data-type=block-math].is-open textarea:focus`).waitFor();
}
/** 双击 Note 进编辑，点第 n 个行内公式：换成 $…$ 原文 */
async function openInline(h: Host, id = "n0", n = 0) {
  const pg = h.page;
  await pg.locator(`${card(id)} .nbody p`).first().dblclick();
  await pg.waitForSelector(`${card(id)} .md-pm`, { timeout: 5000 });
  const left = await pg.locator(`${card(id)} .md-pm [data-type=inline-math]`).count();
  const b = (await pg.locator(`${card(id)} .md-pm [data-type=inline-math] .katex-base`).nth(n).boundingBox())!;
  await pg.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await until(h, "the clicked formula opens as its source", async () => (await pg.locator(`${card(id)} .md-pm [data-type=inline-math]`).count()) < left);
}
async function exitEdit(h: Host) {
  for (let k = 0; k < 3 && (await h.page.locator(".md-pm").count()); k++) { await h.page.keyboard.press("Escape"); await idle(h); }
}
const acNames = (pg: Page) => pg.locator(".md-mathac .it .nm b").evaluateAll((bs) => bs.map((b) => (b.firstChild?.textContent ?? "") + [...b.childNodes].slice(1).filter((n) => !(n as Element).classList?.contains("tag")).map((n) => n.textContent).join("")));
const acTags = (pg: Page) => pg.locator(".md-mathac .it").evaluateAll((rs) => rs.map((r) => r.querySelector(".tag")?.textContent ?? ""));
const acOn = (pg: Page) => pg.locator(".md-mathac .it").evaluateAll((rs) => rs.findIndex((r) => r.classList.contains("on")));
const ta = (pg: Page) => pg.evaluate(() => { const t = document.querySelector<HTMLTextAreaElement>("[data-type=block-math].is-open textarea")!; return { value: t.value, caret: t.selectionStart }; });

/** 公式块里打 \f：列出 \frac（带排出来的样子和中文说明），↓↑ 移动，回车插入，光标落进第一个 {}；Esc 只关列表不退出公式 */
test("mathCommandAutocomplete", async () => {
  const h = await open({ board: board(["Index:\n\n$$\ni = 1\n$$\n\nend"]), light });
  const pg = h.page;
  await idle(h);
  await openBlock(h);
  await pg.keyboard.type(" + \\f");
  await pg.locator(".md-mathac").waitFor();
  const first = { names: await acNames(pg), desc: await pg.locator(".md-mathac .it").first().locator(".nm > span").textContent(), pv: await pg.locator(".md-mathac .it .pv .katex").count(), on: await acOn(pg) };
  await shot(h, "mathCommandAutocomplete-list");
  const list = await pg.locator(".md-mathac").boundingBox(), src = await pg.locator(`${card()} [data-type=block-math] textarea`).boundingBox();
  await pg.keyboard.press("ArrowDown");
  const down = await acOn(pg);
  await pg.keyboard.press("ArrowUp");
  await pg.keyboard.press("Enter");
  await until(h, "the list closes after inserting", async () => !(await pg.locator(".md-mathac").count()));
  const inserted = await ta(pg);
  await pg.keyboard.type("a");
  const typed = await ta(pg);
  // Esc closes the list, the formula stays open
  await pg.keyboard.press("End");
  await pg.keyboard.type(" \\al");
  await pg.locator(".md-mathac").waitFor();
  await pg.keyboard.press("Escape");
  const escaped = { list: await pg.locator(".md-mathac").count(), open: await pg.locator(`${card()} [data-type=block-math].is-open`).count() };
  await pg.keyboard.press("Backspace"); await pg.keyboard.press("Backspace"); await pg.keyboard.press("Backspace"); await pg.keyboard.press("Backspace");
  await exitEdit(h);
  await idle(h);
  const saved = md(h, "n0");
  check("mathCommandAutocomplete lists \\frac first with its look and a Chinese description", first.names[0] === "\\frac" && first.desc === "分数" && first.pv >= first.names.length && first.on === 0, first);
  check("mathCommandAutocomplete opens under the caret", !!list && !!src && list.y >= src.y + 4 && list.y < src.y + src.height + 40, { list, src });
  check("mathCommandAutocomplete arrows move, Enter inserts with the caret in the first {}", down === 1 && inserted.value === "i = 1 + \\frac{}{}" && inserted.caret === "i = 1 + \\frac{".length && typed.value === "i = 1 + \\frac{a}{}", { down, inserted, typed });
  check("mathCommandAutocomplete Esc closes only the list", escaped.list === 0 && escaped.open === 1, escaped);
  check("mathCommandAutocomplete saved", saved === "Index:\n\n$$\ni = 1 + \\frac{a}{}\n$$\n\nend", { saved });
  await close(h);
});

/** 行内公式（展开成 $…$ 原文）里也有补全：Tab 插入 */
test("mathInlineAutocomplete", async () => {
  const h = await open({ board: board(["a $x$ b"]), light });
  const pg = h.page;
  await idle(h);
  await openInline(h); // clicked in the middle: the caret is at the end of the LaTeX, before the closing $
  await pg.keyboard.type(" + \\al");
  await pg.locator(".md-mathac").waitFor();
  const names = await acNames(pg);
  await shot(h, "mathInlineAutocomplete");
  await pg.keyboard.press("Tab");
  await until(h, "the list closes after inserting", async () => !(await pg.locator(".md-mathac").count()));
  await pg.keyboard.type("y");
  await exitEdit(h);
  await idle(h);
  const saved = md(h, "n0");
  check("mathInlineAutocomplete", names[0] === "\\alpha" && saved === "a $x + \\alpha y$ b", { names, saved });
  await close(h);
});

/** 写错时：预览留着上一次排对的样子（淡下去），下面用中文说错在哪、标出位置；一键改（拼错的命令、少了 }）。还在打命令名时不报错 */
test("mathPreviewPlainErrors", async () => {
  const h = await open({ board: board(["$$\na \\times b\n$$\n\nend"]), light });
  const pg = h.page, blk = `${card()} [data-type=block-math]`;
  await idle(h);
  await openBlock(h);
  const err = () => pg.evaluate((blk) => {
    const b = document.querySelector(blk)!, e = b.querySelector(".md-matherr");
    return { text: e?.textContent ?? null, fix: e?.querySelector(".fix")?.textContent ?? null, where: e?.querySelector(".where u")?.textContent ?? null,
      stale: b.querySelector(".block-math-inner")!.classList.contains("md-mathstale"), tex: b.querySelector(".block-math-inner annotation")?.textContent ?? null };
  }, blk);
  // still typing a command name that can complete: no error yet
  await pg.keyboard.type(" + \\fr");
  await frames(pg, 2);
  const typing = await err();
  await pg.keyboard.press("Escape"); // close the list
  // a typo: \tims
  await pg.keyboard.press("Control+a");
  await pg.keyboard.type("a \\tims b");
  await until(h, "the error shows", async () => (await err()).text);
  const typo = await err();
  await shot(h, "mathPreviewPlainErrors-typo");
  await pg.locator(`${blk} .md-matherr .fix`).click();
  await until(h, "the fix applies", async () => !(await err()).text);
  const fixed = { ...(await ta(pg)), ...(await err()) };
  // a missing }
  await pg.keyboard.press("Control+a");
  await pg.keyboard.type("\\frac{n + 255}{256");
  await until(h, "the error shows", async () => (await err()).text);
  const brace = await err();
  await shot(h, "mathPreviewPlainErrors-brace");
  await pg.locator(`${blk} .md-matherr .fix`).click();
  await until(h, "the fix applies", async () => !(await err()).text);
  const braced = { ...(await ta(pg)), ...(await err()) };
  await exitEdit(h);
  await idle(h);
  const left = await pg.locator(`${card()} .md-matherr`).count();
  check("mathPreviewPlainErrors no error while a command name can still complete", typing.text === null && !!typing.tex?.startsWith("a \\times b"), typing);
  check("mathPreviewPlainErrors typo: last good render dimmed, plain message, where, nearest command", typo.stale && !!typo.tex && /不认识\s*\\tims\s*这个命令/.test(typo.text ?? "") && typo.fix === "\\times" && typo.where === "\\", typo);
  check("mathPreviewPlainErrors one click fixes the typo", fixed.value === "a \\times b" && !fixed.stale && fixed.tex === "a \\times b", fixed);
  check("mathPreviewPlainErrors missing } explained and fixed", /少了一个\s*}/.test(brace.text ?? "") && brace.fix === "补上 }" && braced.value === "\\frac{n + 255}{256}" && braced.tex === "\\frac{n + 255}{256}", { brace, braced });
  check("mathPreviewPlainErrors only while editing", left === 0 && md(h, "n0") === "$$\n\\frac{n + 255}{256}\n$$\n\nend", { left, md: md(h, "n0") });
  await close(h);
});

/** 行内公式：编辑时下面有预览气泡，写错时气泡里报错（拼错的预设命令提示最近的预设）；离开公式气泡就没了 */
test("mathInlinePreviewBubble", async () => {
  const h = await open({ board: board(["Index $i = \\bid$ here.\n\nnext line"]), light, settings: { mathPreamble: PRE } as never });
  const pg = h.page;
  await idle(h);
  await openInline(h);
  await pg.locator(".md-mathtip .md-mathpv .katex").waitFor();
  const ok = await pg.evaluate(() => ({ tex: document.querySelector(".md-mathtip annotation")?.textContent, err: !!document.querySelector(".md-mathtip .md-matherr") }));
  const tip = await pg.locator(".md-mathtip").boundingBox(), src = await pg.locator(".md-pm .md-src").boundingBox();
  await pg.keyboard.type(" + \\tidd");
  await until(h, "the bubble shows the error", async () => pg.locator(".md-mathtip .md-matherr").count());
  const bad = await pg.evaluate(() => ({ text: document.querySelector(".md-mathtip .md-matherr")?.textContent, fix: document.querySelector(".md-mathtip .fix")?.textContent }));
  await shot(h, "mathInlinePreviewBubble");
  await pg.locator(".md-mathtip .fix").click();
  await until(h, "the fix applies", async () => !(await pg.locator(".md-mathtip .md-matherr").count()));
  await pg.keyboard.press("ArrowDown");
  await until(h, "the bubble goes when the caret leaves the formula", async () => !(await pg.locator(".md-mathtip").count()));
  await exitEdit(h);
  await idle(h);
  check("mathInlinePreviewBubble shows the formula under its source", ok.tex === "i = \\bid" && !ok.err && !!tip && !!src && tip.y >= src.y + src.height, { ok, tip, src });
  check("mathInlinePreviewBubble explains a typo of a preamble command", /不认识\s*\\tidd/.test(bad.text ?? "") && bad.fix === "\\tid" && md(h, "n0") === "Index $i = \\bid + \\tid$ here.\n\nnext line", { bad, md: md(h, "n0") });
  await close(h);
});

/**
 * 公式预设（codeboard.math.preamble）：静态显示、编辑都认里面的 \newcommand；改了设置已经显示着的 Note 马上重画；
 * 补全里预设的命令标「预设」，公式里自己定义的标「本式」，后者不漏到别的公式
 */
test("mathPreambleMacros", async () => {
  const h = await open({ board: board(["Grid $\\bid \\times \\R^n$ and $\\newcommand{\\two}{2}\\two$ and $\\two$.\n\n$$\nx\n$$"]), light, settings: { mathPreamble: PRE } as never });
  const pg = h.page;
  await idle(h);
  const shown = () => pg.evaluate((c) => ({ errors: [...document.querySelectorAll(`${c} .nbody :is(.katex-error, .mord.text[style*="#cc0000"])`)].map((e) => e.textContent), text: document.querySelector(`${c} .nbody .katex`)?.textContent ?? "" }), card());
  const before = await shown();
  await shot(h, "mathPreambleMacros-static");
  // the setting changes: the Note on the board re-renders with the new definition
  await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, mathPreamble: PRE.replace("blockIdx.x", "BLOCK") } } as never });
  await until(h, "the Note re-renders with the new preamble", async () => (await shown()).text.includes("BLOCK"));
  const after = await shown();
  // completion lists preamble and in-formula commands
  await openBlock(h);
  await pg.keyboard.press("Control+a");
  await pg.keyboard.type("\\newcommand{\\half}{\\frac12} \\");
  await pg.locator(".md-mathac").waitFor();
  const names = await acNames(pg), tags = await acTags(pg);
  await pg.keyboard.type("ti");
  const ti = await acNames(pg);
  await shot(h, "mathPreambleMacros-list");
  await pg.keyboard.press("Enter");
  await pg.keyboard.press("Escape");
  await exitEdit(h);
  await idle(h);
  const saved = md(h, "n0"), end = await shown();
  check("mathPreambleMacros static render knows the preamble; \\newcommand stays in its formula", before.errors.length === 1 && before.errors[0] === "\\two" && before.text.includes("blockIdx.x"), before);
  check("mathPreambleMacros a setting change re-renders the board", after.text.includes("BLOCK") && after.errors.length === 1, after);
  check("mathPreambleMacros completion tags preamble and in-formula commands", names.slice(0, 4).join() === "\\tid,\\bid,\\R,\\half" && tags.slice(0, 5).join() === "预设,预设,预设,本式," && ti[0] === "\\tid" && ti.includes("\\times"), { names, tags, ti });
  check("mathPreambleMacros saved", saved.endsWith("$$\n\\newcommand{\\half}{\\frac12} \\tid \n$$") && end.errors.length === 1, { saved, end });
  await close(h);
});

/** Settings → Math preamble：写进 codeboard.math.preamble；写错的定义列在下面 */
test("mathPreambleSetting", async () => {
  const h = await open({ board: board(["$\\R$"]), light });
  const pg = h.page;
  await idle(h);
  await pg.keyboard.press("Meta+Comma");
  await pg.waitForSelector(".settings");
  const sec = pg.locator('.settings [data-sec="math"]');
  await sec.scrollIntoViewIfNeeded();
  await sec.locator("textarea").fill("\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\bad}{\\frac{1}");
  await sec.locator("textarea").blur();
  await until(h, "the setting is sent", () => h.sent.some((m) => m.type === "setSetting" && (m as { key: string }).key === "mathPreamble"));
  const sent = h.sent.filter((m) => m.type === "setSetting" && (m as { key: string }).key === "mathPreamble").map((m) => (m as { value: string }).value);
  await until(h, "the bad line is reported", async () => sec.locator(".st-warn").count());
  const warn = await sec.locator(".st-warn").allTextContents();
  await sec.screenshot({ path: path.join(OUT, "mathPreambleSetting.png") });
  await pg.keyboard.press("Escape");
  await pg.locator(".settings").waitFor({ state: "detached" });
  await idle(h);
  const errs = await pg.locator(`${card()} .nbody :is(.katex-error, .mord.text[style*="#cc0000"])`).count();
  check("mathPreambleSetting", sent[sent.length - 1] === "\\newcommand{\\R}{\\mathbb{R}}\n\\newcommand{\\bad}{\\frac{1}" && warn.length === 1 && errs === 0, { sent, warn, errs });
  await close(h);
});

/** 打字跟得上（60 fps）：长公式里每按一下，插字、补全、下一帧的预览排版加起来不到一帧 */
test("mathHintsKeystrokeTime", async () => {
  const long = Array.from({ length: 12 }, (_, i) => `\\frac{a_{${i}}}{\\sqrt{b_${i}^2 + c}}`).join(" + ");
  const h = await open({ board: board([`$$\n${long}\n$$\n\nend`]), light: true, w: 1300, h: 800 });
  const pg = h.page;
  await idle(h);
  await openBlock(h);
  const lat = await pg.evaluate(async () => {
    const t = document.querySelector<HTMLTextAreaElement>("[data-type=block-math].is-open textarea")!;
    const ts: number[] = [];
    const chars = " + \\sum_{i}^{n} x_i".split("");
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      // the frame's work: our rAF runs between a and b (callbacks run in the order they were asked for)
      let a = 0;
      requestAnimationFrame(() => { a = performance.now(); });
      const t0 = performance.now();
      document.execCommand("insertText", false, chars[i % chars.length]);
      t.getBoundingClientRect();
      const sync = performance.now() - t0;
      const frame = await new Promise<number>((r) => requestAnimationFrame(() => { document.body.getBoundingClientRect(); r(performance.now() - a); }));
      ts.push(sync + frame);
    }
    ts.sort((x, y) => x - y);
    return { p50: +ts[20].toFixed(2), p80: +ts[32].toFixed(2), p90: +ts[36].toFixed(2), max: +ts[39].toFixed(2) };
  });
  const pv = await pg.locator("[data-type=block-math] .block-math-inner .katex").count();
  // 大公式的预览攒着排（停手或每 400ms 一次）：排的那几帧会长，其余的按键都在一帧里
  check("mathHintsKeystrokeTime keystrokes in a long formula (insert + hints + preview) stay inside a frame", pv > 0 && lat.p50 < 8 && lat.p80 < 16, lat);
  await close(h);
});

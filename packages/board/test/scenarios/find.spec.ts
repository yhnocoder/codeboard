// 编辑时的查找 / 替换（ui/find.ts 的查找条）：Note（ProseMirror + prosemirror-search）和 Free code 卡（CodeMirror + @codemirror/search）。
// ⌘F 打开、高亮全部、第几个 / 几个、Enter / ⇧Enter 上下、区分大小写、⌥⌘F 替换、全部替换一次撤销、Esc 关上焦点回编辑器
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { put, shot, type Host } from "../harness";
import { test, open, check, until, idle } from "../fixtures";

const close = (h: Host) => h.page.context().close();
const md = (h: Host, id: string) => ((h.board().cards.find((c) => c.id === id) as NoteCard | undefined)?.md ?? "").trim();
const count = (pg: Page) => pg.locator(".md-find .md-findn").textContent();
/** 查找条里有焦点的是哪个框（md-findq / md-findr），不在条里给 null */
const focusIn = (pg: Page) => pg.evaluate(() => { const a = document.activeElement; return a?.closest(".md-find") ? a.className : a?.closest(".md-pm, .cm-content") ? "editor" : (a?.className ?? null); });

function noteBoard(texts: string[]): Board {
  const b = emptyBoard("b1", "find");
  texts.forEach((t, i) => put(b, { id: `n${i}`, kind: "note", md: t, look: "note" } as NoteCard, 60 + i * 580, 60, 540));
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
async function editNote(h: Host, id: string) {
  await h.page.locator(`.card[data-id="${id}"] .nbody`).dblclick();
  await h.page.waitForSelector(`.card[data-id="${id}"] .md-pm`, { timeout: 5000 });
}

const NOTE = "alpha beta Alpha\n\n**alpha** in bold and `alpha` in code\n\n```python\nalpha = 1\n```\n\nend alpha";

/** Note：六个 alpha（一个大写、一个粗体、一个行内代码、一个在代码块里） */
test("noteFindReplace", async () => {
  const h = await open({ board: noteBoard([NOTE]), light: true, w: 1100, h: 700, settings: { theme: "warm-ink" } as never });
  await idle(h);
  const pg = h.page;
  await editNote(h, "n0");
  const y0 = await pg.locator('.card[data-id="n0"] .md-pm p').first().boundingBox();
  await pg.keyboard.press("Control+f");
  await pg.locator(".md-find .md-findq").waitFor();
  const opened = await focusIn(pg);
  await pg.keyboard.type("alpha");
  await until(h, "matches are counted", async () => (await count(pg)) === "1/6");
  /** 画出来的匹配：正文里的是 CSS Custom Highlight 的 Range，代码块里的是 CodeMirror 的装饰 */
  const marks = () => pg.evaluate(() => {
    const n = (k: string) => CSS.highlights.get(k)?.size ?? 0, code = document.querySelectorAll('.card[data-id="n0"] .md-pm pre :is(.md-find-hit, .md-find-on)').length;
    const texts = [...(CSS.highlights.get("md-find") ?? []), ...(CSS.highlights.get("md-find-cur") ?? [])].map((r) => (r as Range).toString());
    return { all: n("md-find") + n("md-find-cur") + code, active: n("md-find-cur"), inCode: code, texts };
  });
  const found = await marks();
  // 查找条浮着，不挤动正文
  const y1 = await pg.locator('.card[data-id="n0"] .md-pm p').first().boundingBox();
  await shot(h, "noteFindReplace");
  await pg.keyboard.press("Enter");
  const n2 = await count(pg);
  await pg.keyboard.press("Shift+Enter");
  await pg.keyboard.press("Shift+Enter");
  const nLast = await count(pg);
  await pg.keyboard.press("Enter");
  await pg.locator(".md-find .md-case").click();
  const caseOn = await count(pg);
  await pg.locator(".md-find .md-case").click();
  // 替换：⌥⌘F 打开替换框；Enter 换掉选中的这一个（第一个），⌘↵ 全部换掉
  await pg.keyboard.press("Control+Alt+f");
  const replFocus = await focusIn(pg);
  await pg.keyboard.type("omega");
  await pg.keyboard.press("Enter");
  const afterOne = await count(pg);
  await pg.keyboard.press("Control+Enter");
  const afterAll = await count(pg);
  const allText = await pg.locator('.card[data-id="n0"] .md-pm').textContent();
  // Esc：关上，焦点回编辑器；一次撤销撤回全部替换（第一次单个的替换还在）
  await pg.keyboard.press("Escape");
  const closed = { bar: await pg.locator(".md-find").count(), focus: await focusIn(pg), marks: (await marks()).all };
  await pg.keyboard.press("Control+z");
  const undone = (await pg.locator('.card[data-id="n0"] .md-pm').textContent())?.match(/alpha/gi)?.length ?? 0;
  await pg.keyboard.press("Escape");
  await idle(h);
  const r = { opened, found, moved: y1!.y - y0!.y, n2, nLast, caseOn, replFocus, afterOne, afterAll, allAlpha: /alpha/i.test(allText ?? ""), closed, undone, md: md(h, "n0") };
  check("noteFindReplace", opened === "md-findq" && found.all === 6 && found.active === 1 && found.inCode === 1 && found.texts.every((t) => /^alpha$/i.test(t)) && r.moved === 0
    && n2 === "2/6" && nLast === "6/6" && caseOn === "1/5" && replFocus === "md-findr" && afterOne === "1/5" && afterAll === "No results" && !r.allAlpha
    && closed.bar === 0 && closed.focus === "editor" && closed.marks === 0 && undone === 5 && r.md === NOTE.replace("alpha", "omega"), r);
  await close(h);
});

/** 长 Note 里在查找框打字：每打一个字（重新查找、高亮、数个数、排版）一帧之内。量时间，单独跑（tiers.json 的 solo） */
test("noteFindTypingLatency", async () => {
  const para = (i: number) => `Paragraph ${i}: the scheduler picks a **sequence** from the waiting queue, then \`allocate\` blocks for it; see $x_${i}$ and the kernel launch.`;
  const LONG = Array.from({ length: 250 }, (_, i) => para(i)).join("\n\n");
  const h = await open({ board: noteBoard([LONG]), light: true, w: 1100, h: 700, settings: { theme: "warm-ink" } as never });
  await idle(h);
  const pg = h.page;
  await editNote(h, "n0");
  await pg.keyboard.press("Control+f");
  await pg.locator(".md-find .md-findq").waitFor();
  const lat = await pg.evaluate(async () => {
    const q = document.querySelector(".md-find .md-findq") as HTMLInputElement, ts: number[] = [];
    const words = ["s", "se", "seq", "sequ", "seque", "sequen", "sequenc", "sequence", "sequenc", "sequen", "seque", "sequ", "seq", "se", "s", "k", "ke", "ker", "kern", "kerne", "kernel"];
    for (const w of [...words, ...words]) {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const t0 = performance.now();
      q.value = w;
      q.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector(".md-pm")!.getBoundingClientRect();
      ts.push(performance.now() - t0);
    }
    ts.sort((a, b) => a - b);
    return { p50: +ts[Math.floor(ts.length / 2)].toFixed(2), p90: +ts[Math.floor(ts.length * 0.9)].toFixed(2), max: +ts[ts.length - 1].toFixed(2), n: document.querySelector(".md-find .md-findn")!.textContent };
  });
  await pg.keyboard.press("Escape");
  await pg.keyboard.press("Escape");
  await idle(h);
  check("noteFindTypingLatency one keystroke in the find field on a 250-paragraph Note well inside a frame", lat.n === "1/250" && lat.p50 < 8 && lat.p90 < 16, lat);
  await close(h);
});

const CODE = ["def f(x):", "    y = x + 1  # one", "    return y", "", "print(f(2))"];
function freeBoard(): Board {
  const b = emptyBoard("b1", "free");
  b.cards.push({ id: "c1", kind: "code", segments: [{ id: "s1", src: { kind: "free" }, path: "", lang: "python", start: 1, end: CODE.length, text: CODE.slice(), version: { kind: "none" } }] } as any);
  b.place.c1 = { x: 80, y: 80, w: 480 };
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const codeText = (pg: Page) => pg.evaluate(() => [...document.querySelectorAll('.card[data-id="c1"] .cm-line')].map((l) => l.textContent).join("\n"));

/** Free code 卡：同一个查找条（CodeMirror 的面板里，浮着不挤动代码） */
test("codeFindReplace", async () => {
  const h = await open({ board: freeBoard(), light: true, w: 1000, h: 700, settings: { theme: "warm-ink" } as never });
  await idle(h);
  const pg = h.page;
  await pg.locator('.card[data-id="c1"] .src .l').nth(0).dblclick();
  await pg.waitForSelector('.card[data-id="c1"] .cm-content', { timeout: 8000 });
  const y0 = await pg.locator('.card[data-id="c1"] .cm-line').first().boundingBox();
  await pg.keyboard.press("Control+f");
  await pg.locator('.card[data-id="c1"] .md-find .md-findq').waitFor();
  const opened = await focusIn(pg);
  await pg.keyboard.type("y");
  await until(h, "matches are counted", async () => /^\d\/2$/.test((await count(pg)) ?? ""));
  const found = await pg.locator('.card[data-id="c1"] .cm-searchMatch').count();
  const y1 = await pg.locator('.card[data-id="c1"] .cm-line').first().boundingBox();
  await shot(h, "codeFindReplace");
  const n1 = await count(pg);
  await pg.keyboard.press("Enter");
  const n2 = await count(pg);
  await pg.keyboard.press("Control+Alt+f");
  const replFocus = await focusIn(pg);
  await pg.keyboard.type("z");
  await pg.keyboard.press("Control+Enter");
  const replaced = await codeText(pg);
  await pg.keyboard.press("Escape");
  const closed = { bar: await pg.locator(".md-find").count(), focus: await focusIn(pg) };
  await pg.keyboard.press("Control+z");
  const undone = await codeText(pg);
  await pg.keyboard.press("Escape");
  await idle(h);
  const r = { opened, found, moved: y1!.y - y0!.y, n1, n2, replFocus, replaced, closed, undone };
  check("codeFindReplace", opened === "md-findq" && found === 2 && r.moved === 0 && n1 === "1/2" && n2 === "2/2" && replFocus === "md-findr"
    && replaced === CODE.join("\n").replaceAll("y", "z") && closed.bar === 0 && closed.focus === "editor" && undone === CODE.join("\n"), r);
  await close(h);
});

import * as fs from "node:fs";
import * as path from "node:path";
import { put, findSym, symCard, shot, OUT, type Host } from "../harness";
import { emptyBoard, DEFAULT_SETTINGS, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { test, open, check, light, expect, until, idle, pmHasSelection, focusSettled } from "../fixtures";

const close = (h: Host) => h.page.context().close();

/** 打一串：{Enter}、{Control+z} 之类是按键，其余是字 */
async function keys(pg: Page, seq: string, delay = 0) {
  for (const part of seq.split(/(\{[A-Za-z0-9+]+\})/)) {
    if (!part) continue;
    if (/^\{.+\}$/.test(part)) {
      // 方向键是浏览器自己移光标，ProseMirror 要等 selectionchange 才知道：前后各等它读到选区
      const nav = /Home|End|Arrow/.test(part);
      if (nav) { await focusSettled(pg); await pmHasSelection(pg); }
      await pg.keyboard.press(part.slice(1, -1));
      if (nav) await pmHasSelection(pg);
    } else await pg.keyboard.type(part, { delay });
  }
}
/** 一块白板：一张代码卡（Sidenote 挂在它上面）和 n 张 Note */
function board(init: string[] = []): Board {
  const b = emptyBoard("b1", "note editing");
  const s = findSym("Scheduler.schedule");
  put(b, symCard(s.f, s.s), 2400, 60, 420);
  init.forEach((md, i) => put(b, { id: `n${i}`, kind: "note", md, look: "note" } as NoteCard, 60 + (i % 4) * 560, 60 + Math.floor(i / 4) * 360, 520));
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const md = (h: Host, id: string) => ((h.board().cards.find((c) => c.id === id) as NoteCard | undefined)?.md ?? "").trim();
const editing = (h: Host, id: string) => h.page.locator(`.card[data-id="${id}"] .md-pm`).count();
async function editNote(h: Host, id: string) {
  await h.post({ type: "reveal", card: id } as any);
  await idle(h); // the camera flies to the card
  // reveal selects the card, and a click on the only selected card already edits with the caret where clicked: deselect it
  // first, so the double click opens the editor with the caret at the end as these cases expect
  await h.page.keyboard.press("Escape");
  await until(h, "nothing selected", async () => (await h.page.locator(".card.sel").count()) === 0);
  await h.page.locator(`.card[data-id="${id}"] .nbody`).dblclick();
  await h.page.waitForSelector(`.card[data-id="${id}"] .md-pm`, { timeout: 5000 });
}
async function exitEdit(h: Host) {
  for (let k = 0; k < 3 && (await h.page.locator(".md-pm").count()); k++) { await h.page.keyboard.press("Escape"); await idle(h); }
}
/** 每条一张 Note：打一串键、退出，最后一起看写回的 Markdown */
async function typeCases(name: string, cases: { name: string; init?: string; seq: string; md: string; delay?: number }[]) {
  const h = await open({ board: board(cases.map((c) => c.init ?? "")) });
  await idle(h);
  for (let i = 0; i < cases.length; i++) {
    await editNote(h, `n${i}`);
    if (cases[i].init) await keys(h.page, "{Control+End}");
    await keys(h.page, cases[i].seq, cases[i].delay);
    await idle(h);
    await exitEdit(h);
  }
  await idle(h); // every Note's Markdown has reached the host
  cases.forEach((c, i) => check(`${name} ${c.name}`, md(h, `n${i}`) === c.md, { got: md(h, `n${i}`), want: c.md }));
  await close(h);
}

/** 最后一块是图片的 Note（打的、粘贴的截图）：退出以后还能再双击编辑 */
test("noteImageReopens", async () => {
  const h = await open({ board: board(["a\n\n![i](https://x.y/a.png)", ""]) });
  await idle(h);
  let first = 0;
  try { await editNote(h, "n0"); first = await editing(h, "n0"); } catch { /* 打不开 */ }
  await exitEdit(h);
  await editNote(h, "n1");
  await keys(h.page, "![cat](https://x.y/c.png)");
  await exitEdit(h);
  let again = 0;
  try { await editNote(h, "n1"); again = await editing(h, "n1"); } catch { /* 打不开 */ }
  await exitEdit(h);
  check("noteImageReopens", first === 1 && again === 1 && md(h, "n1") === "![cat](https://x.y/c.png)", { first, again, md: md(h, "n1") });
  await close(h);
});

/** 自动配对的右括号、引号被盖过去时，里面的链接、行内代码照常变，括号不多不少 */
test("noteAutoPairOvertype", async () => {
  const S = ["(and [cat](http://c.at)) x", "\"[d](u)\" x", "(`c`) x", "f(g(x)) y", "($x$) z", "(x **b** y)"];
  await typeCases("noteAutoPairOvertype", [
    ...S.map((s) => ({ name: `fast ${s}`, seq: s, md: s })),
    ...S.map((s) => ({ name: `slow ${s}`, seq: s, md: s, delay: 60 })),
  ]);
});

/** 段落、标题里按 Tab 不离开编辑器（后面打的字照样进来）；列表里照样缩进 */
test("noteTabStaysInEditor", async () => {
  const h = await open({ board: board(["", "", ""]) });
  await idle(h);
  const runs: { seq: string; want: string }[] = [{ seq: "x{Tab}y", want: "xy" }, { seq: "# h{Tab}{Shift+Tab}i", want: "# hi" }, { seq: "- a{Enter}{Tab}b", want: "- a\n  - b" }];
  const still: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    await editNote(h, `n${i}`);
    await keys(h.page, runs[i].seq);
    still.push(await h.page.evaluate((id) => (document.activeElement?.closest(`.card[data-id="${id}"] .md-pm`) ? 1 : 0), `n${i}`));
    await exitEdit(h);
  }
  await idle(h);
  runs.forEach((r, i) => check(`noteTabStaysInEditor ${r.seq}`, still[i] === 1 && md(h, `n${i}`) === r.want, { focused: still[i], got: md(h, `n${i}`) }));
  await close(h);
});

/** 最后一块是代码块、公式块时，方向键能走到它后面接着写（后面总有一个空段落） */
test("noteTrailingBlockExit", async () => {
  await typeCases("noteTrailingBlockExit", [
    { name: "typed fence", seq: "```{Enter}x{ArrowDown}after", md: "```\nx\n```\n\nafter" },
    { name: "slash menu", seq: "/code{Enter}y{ArrowDown}after", md: "```\ny\n```\n\nafter" },
    { name: "existing code", init: "```\nz\n```", seq: "{Control+End}{ArrowUp}{ArrowDown}after", md: "```\nz\n```\n\nafter" },
  ]);
});

/** 往表格格子里粘贴多行（VS Code 的代码、普通的字）：表格不拆开，几行用硬换行连起来 */
test("notePasteIntoTableCell", async () => {
  const T = "| a | b |\n| - | - |\n| 1 | 2 |";
  const h = await open({ board: board([T, T]) });
  await idle(h);
  const paste = (vs: boolean) => h.page.evaluate((vs) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "x = 1\nif x:\n    y()\n");
    if (vs) dt.setData("vscode-editor-data", JSON.stringify({ mode: "python" }));
    document.querySelector(".md-pm")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, vs);
  for (const [i, vs] of [[0, true], [1, false]] as const) {
    await editNote(h, `n${i}`);
    await h.page.locator(`.card[data-id="n${i}"] .md-pm td`).first().click();
    await keys(h.page, "{End}");
    await paste(vs);
    await expect(h.page.locator(`.card[data-id="n${i}"] .md-pm td`).first()).toContainText("y()");
    await exitEdit(h);
  }
  await idle(h);
  for (const i of [0, 1]) {
    const got = md(h, `n${i}`), rows = got.split("\n");
    check(`notePasteIntoTableCell ${i ? "plain text" : "VS Code"}`, rows.length === 3 && /^\| 1x = 1<br>if x:<br>\s*y\(\)\s*\| 2\s*\|$/.test(rows[2]), { got });
  }
  await close(h);
});

/** 编辑 Note、代码卡时，VS Code 的命令面板、快速打开（F1、⌃⇧P、⌃P）的按键照样交给 VS Code（webview 在 window 上收） */
test("editorKeysReachVsCode", async () => {
  const b = board([""]);
  b.cards.push({ id: "c1", kind: "code", segments: [{ id: "s1", src: { kind: "free" }, path: "", lang: "python", start: 1, end: 1, text: ["x = 1"], version: { kind: "none" } }] } as CodeCard);
  b.place.c1 = { x: 700, y: 400, w: 400 };
  const h = await open({ board: b });
  await idle(h);
  await h.page.evaluate(() => { (window as any).__keys = []; window.addEventListener("keydown", (e) => (window as any).__keys.push(`${e.ctrlKey ? "C+" : ""}${e.shiftKey ? "S+" : ""}${e.key}`)); });
  const KEYS = ["F1", "Control+Shift+P", "Control+P"];
  const got = async () => { const k = await h.page.evaluate(() => (window as any).__keys.splice(0)); return k as string[]; };
  await editNote(h, "n0");
  await got();
  for (const k of KEYS) await h.page.keyboard.press(k);
  const inNote = await got();
  await exitEdit(h);
  await h.page.locator('.card[data-id="c1"] .src .l').first().dblclick();
  await h.page.waitForSelector('.card[data-id="c1"] .cm-content', { timeout: 8000 });
  await got();
  for (const k of KEYS) await h.page.keyboard.press(k);
  const inCode = await got();
  const want = ["F1", "C+S+P", "C+P"];
  check("editorKeysReachVsCode note", JSON.stringify(inNote) === JSON.stringify(want), { inNote });
  check("editorKeysReachVsCode code card", JSON.stringify(inCode) === JSON.stringify(want), { inCode });
  await close(h);
});

/** Sidenote 的字：Esc、点到外面都保存（和 Note、问题一样）；字删光了保存就删掉这条；Add Sidenote 的 Text 页 Esc 也加上 */
test("sidenoteTextEditSaves", async () => {
  const b = board();
  const C = b.cards[0] as CodeCard, s = C.segments[0];
  b.place[C.id] = { x: 300, y: 60, w: 520 };
  b.sidenotes.push({ id: "sn1", kind: "text", md: "original", at: { card: C.id, seg: s.id, lines: [s.start + 2, s.start + 2] } });
  const h = await open({ board: b });
  await idle(h);
  const texts = () => h.board().sidenotes.map((n) => (n.kind === "text" ? n.md : n.kind));
  /** the host's sidenotes changed from what they were before the edit */
  const saved = async (what: string, before: string) => { await until(h, what, () => JSON.stringify(texts()) !== before); await idle(h); };
  const openEdit = async () => {
    await h.page.locator(".mk").first().click();
    await h.page.locator("button.tbtn", { hasText: /^Edit$/ }).click();
    await h.page.locator(".sn-edit textarea:focus").waitFor();
    return JSON.stringify(texts());
  };
  let before = await openEdit(); await keys(h.page, " +esc{Escape}"); await saved("Esc saves the sidenote", before);
  const afterEsc = texts();
  await h.page.keyboard.press("Escape"); await idle(h);
  before = await openEdit(); await keys(h.page, " +click"); await h.page.mouse.click(1200, 800); await saved("a click outside saves the sidenote", before);
  const afterClick = texts();
  await h.page.keyboard.press("Escape"); await idle(h);
  // Cancel must not save: it is the trigger, so once the board is idle whatever it sends has reached the host
  await openEdit(); await keys(h.page, " +cancel"); await h.page.locator(".sn-edit button", { hasText: "Cancel" }).click(); await idle(h);
  const afterCancel = texts();
  // Add Sidenote → Text：写了字按 Esc
  await h.page.keyboard.press("Escape"); await idle(h);
  await h.page.locator(".mk").first().click();
  await h.page.locator("button.tbtn", { hasText: "+ Add" }).click();
  await h.page.locator(".addnote .tab", { hasText: "Text" }).click();
  await h.page.locator(".addnote textarea:focus").waitFor();
  before = JSON.stringify(texts());
  await keys(h.page, "added by esc{Escape}"); await saved("Esc adds the text sidenote", before);
  const afterAdd = texts();
  before = await openEdit(); await keys(h.page, "{Control+a}{Backspace}{Control+Enter}"); await saved("saving an emptied sidenote deletes it", before);
  const afterClear = texts();
  const ok = JSON.stringify(afterEsc) === '["original +esc"]' && JSON.stringify(afterClick) === '["original +esc +click"]' && JSON.stringify(afterCancel) === '["original +esc +click"]'
    && JSON.stringify(afterAdd) === '["original +esc +click","added by esc"]' && JSON.stringify(afterClear) === '["added by esc"]';
  check("sidenoteTextEditSaves", ok, { afterEsc, afterClick, afterCancel, afterAdd, afterClear });
  await close(h);
});

/** Note 里的代码块编辑完：退出编辑时它在宿主那边的语言服务文档（.codeboard-note-code-* 隐藏文件）关掉 */
test("noteCodeScratchClosed", async () => {
  const h = await open({ board: board(["```python\nx = 1\n```"]) });
  await idle(h);
  await editNote(h, "n0");
  await h.page.locator('.card[data-id="n0"] .md-pm pre .cm-content').click();
  await keys(h.page, "{End}{Enter}y = x");
  // 改动停一下才同步给宿主（开文档）
  await until(h, "the code block's document is opened on the host", () => h.sent.some((m) => m.type === "codeDoc"));
  await exitEdit(h);
  await until(h, "the code block's document is closed on the host", () => h.sent.some((m) => m.type === "codeDocClose"));
  await idle(h);
  const opened = [...new Set(h.sent.filter((m) => m.type === "codeDoc").map((m: any) => m.id as string))];
  const closed = h.sent.filter((m) => m.type === "codeDocClose").map((m: any) => m.id as string);
  check("noteCodeScratchClosed", opened.length === 1 && opened.every((id) => closed.includes(id)), { opened, closed });
  await close(h);
});

/** 光标在 Note 的代码块（CodeMirror）里：点别的卡、点画布空白，和在正文里一样保存并结束编辑 */
test("noteCodeBlockClickAwayEnds", async () => {
  const h = await open({ board: board(["```python\nx = 1\n```", "other note"]) });
  await idle(h);
  const cases: { name: string; away: () => Promise<void>; md: string }[] = [
    { name: "otherCard", away: () => h.page.locator('.card[data-id="n1"] .nbody').click(), md: "```python\nx = 1 # a\n```" },
    { name: "otherCardHead", away: () => h.page.locator('.card[data-id="n1"] .chead .kind').click(), md: "```python\nx = 1 # a # b\n```" },
    { name: "canvas", away: () => h.page.mouse.click(300, 700), md: "```python\nx = 1 # a # b # c\n```" },
  ];
  for (const [i, c] of cases.entries()) {
    await editNote(h, "n0");
    await h.page.locator('.card[data-id="n0"] .md-pm pre .cm-content').click();
    await keys(h.page, `{End} # ${"abc"[i]}`);
    await idle(h);
    const inCode = await h.page.evaluate(() => !!document.activeElement?.closest(".cm-content"));
    const was = md(h, "n0");
    await c.away();
    await until(h, `the edit is saved (${c.name})`, () => md(h, "n0") !== was); await idle(h);
    const still = await editing(h, "n0");
    check(`noteCodeBlockClickAwayEnds ${c.name}`, inCode && still === 0 && md(h, "n0") === c.md, { inCode, still, got: md(h, "n0"), want: c.md });
    await exitEdit(h);
  }
  await close(h);
});

/** 一个动作一次撤销：Sidenote → Place on Board；Note 的字删光（Note 跟着删掉） */
test("undoIsOneStep", async () => {
  const b = board(["hello world"]);
  const C = b.cards[0] as CodeCard, s = C.segments[0];
  b.place[C.id] = { x: 700, y: 60, w: 520 };
  b.sidenotes.push({ id: "sn1", kind: "text", md: "side text", at: { card: C.id, seg: s.id, lines: [s.start + 2, s.start + 2] } });
  const h = await open({ board: b });
  await idle(h);
  const st = () => { const B = h.board(); return `${B.cards.map((c) => c.kind).sort().join(",")} sn${B.sidenotes.length} l${B.links.length}`; };
  /** the host's board changed from `was` */
  const changed = async (what: string, was: string) => { await until(h, what, () => st() !== was); await idle(h); };
  const undo = async () => { const was = st(); await h.page.locator("#board").click({ position: { x: 600, y: 760 } }); await h.page.keyboard.press("Control+z"); await changed("undo reaches the host", was); };
  const start = st();
  await h.page.locator(".mk").first().click();
  await h.page.locator("button.tbtn", { hasText: "Place on Board" }).click(); await changed("the sidenote is placed on the board", start);
  const placed = st();
  await undo();
  const placeUndone = st();
  await editNote(h, "n0"); await keys(h.page, "{Control+a}{Backspace}"); await exitEdit(h); await changed("the emptied Note is deleted", placeUndone);
  const cleared = st();
  await undo();
  const clearUndone = st(), text = md(h, "n0");
  check("undoIsOneStep place sidenote", placed === "code,note,note sn0 l1" && placeUndone === start, { start, placed, placeUndone });
  check("undoIsOneStep clear note", cleared === "code sn1 l0" && clearUndone === start && text === "hello world", { cleared, clearUndone, text });
  await close(h);
});

/** 一行里打完 $$m$$（不按回车、不离开编辑）：马上就是公式块，位置、大小和退出编辑后显示的一样（居中，不是行内的小公式）；接着打的字在下一段 */
test("noteDisplayMathTypedAsBlock", async () => {
  const h = await open({ board: board([""]), light });
  await idle(h);
  const geo = () => h.page.evaluate(() => {
    const body = document.querySelector('.card[data-id="n0"] .nbody')!, base = body.querySelector(".katex-html .katex-base");
    const b = body.getBoundingClientRect(), r = base?.getBoundingClientRect();
    return {
      block: body.querySelectorAll("[data-type=block-math], .math").length, inline: body.querySelectorAll("[data-type=inline-math], p .katex").length,
      display: body.querySelectorAll(".katex-display").length,
      ...(r ? { x: Math.round(r.left - b.left), y: Math.round(r.top - b.top), w: Math.round(r.width), h: Math.round(r.height), dx: Math.round(r.left + r.width / 2 - (b.left + b.width / 2)) } : {}),
    };
  });
  await editNote(h, "n0");
  await h.page.keyboard.type("$$\\frac{200}{10}$$", { delay: 20 }); // 不走 keys()：{200} 会被当成按键
  await idle(h);
  const typed = await geo();
  await shot(h, "noteDisplayMathTypedAsBlock-typed");
  await keys(h.page, "after");
  await exitEdit(h);
  const shown = await geo(), text = md(h, "n0");
  await shot(h, "noteDisplayMathTypedAsBlock-shown");
  const same = (["x", "y", "w", "h"] as const).every((k) => typed[k] !== undefined && Math.abs(typed[k]! - shown[k]!) <= 1);
  check("noteDisplayMathTypedAsBlock", typed.block === 1 && typed.inline === 0 && typed.display === 1 && Math.abs(typed.dx ?? 99) <= 2 && same && text === "$$\n\\frac{200}{10}\n$$\n\nafter", { typed, shown, text });
  await close(h);
});

/** 双击进编辑：卡片高度、每一块的位置都不变，字形（连字）不变；选中的底色两边一样，是主题的强调色而不是浏览器的蓝色 */
test("noteEditKeepsLayout", async () => {
  const docs = [
    "# Heading\n\nA paragraph with **bold**, `code` and $x^2$ math.\n\n- one\n- two\n\n> quote line\n\n```python\nx = 1\n```\n\n$$\n\\frac{200}{10}\n$$\n\nLast paragraph.",
    // 正文、一整行的公式、再几段，最后一行是一段的结尾（公式上下的空、最后一段下面的边距）
    "The rate is **20 per second** when we split it.\n\n$$\\frac{200\\ s}{10\\ s}=20$$\n\nSo the batch takes **ten** seconds,\nand the queue drains.\n\nLast line ends here.",
  ];
  // the heading shown in the body too (by default a leading heading that is the title is hidden there: noteTitleHeadingHiddenInBody)
  const h = await open({ board: board(docs), light, settings: { noteHeadingInBody: true } });
  await idle(h);
  const geo = (id: string) => h.page.evaluate((id) => {
    const card = document.querySelector(`.card[data-id="${id}"]`)!, body = card.querySelector(".nbody")!, root = body.querySelector(".md-pm") ?? body;
    const box = card.getBoundingClientRect(), p = root.querySelector("p")!;
    return {
      h: Math.round(box.height), ys: [...root.children].map((e) => Math.round(e.getBoundingClientRect().top - box.top)),
      below: Math.round(box.bottom - root.lastElementChild!.getBoundingClientRect().bottom),
      sel: getComputedStyle(p, "::selection").backgroundColor, lig: getComputedStyle(p).fontVariantLigatures,
    };
  }, id);
  for (const i of docs.keys()) {
    const id = `n${i}`, shown = await geo(id);
    await h.page.locator(`.card[data-id="${id}"] .nbody p`).last().dblclick();
    await h.page.waitForSelector(`.card[data-id="${id}"] .md-pm`, { timeout: 5000 });
    await h.page.mouse.move(5, 5);
    await idle(h);
    const edit = await geo(id);
    check(`noteEditKeepsLayout ${id}`, JSON.stringify(shown) === JSON.stringify(edit) && shown.sel !== "rgba(0, 0, 0, 0)", { shown, edit });
    await exitEdit(h);
  }
  await close(h);
});

/** 打完 "## " 这一行马上是标题的字号、行高，"##" 也是标题的字号；接着打字时这一行、卡片的高度都不再变 */
test("headingMarkerTypedAtHeadingSize", async () => {
  const h = await open({ board: board([""]), light });
  await idle(h);
  await editNote(h, "n0");
  const line = () => h.page.evaluate(() => {
    const c = document.querySelector('.card[data-id="n0"]')!, e = c.querySelector(".md-pm")!.firstElementChild as HTMLElement;
    return { tag: e.tagName, fs: getComputedStyle(e).fontSize, mk: getComputedStyle(e, "::before").fontSize, mkText: getComputedStyle(e, "::before").content, lh: Math.round(e.getBoundingClientRect().height), card: Math.round(c.getBoundingClientRect().height) };
  });
  await keys(h.page, "## ");
  await idle(h);
  const space = await line();
  await shot(h, "headingMarkerTypedAtHeadingSize-space");
  await keys(h.page, "Title");
  await idle(h);
  const typed = await line();
  await shot(h, "headingMarkerTypedAtHeadingSize-typed");
  check("headingMarkerTypedAtHeadingSize", space.tag === "H2" && space.mkText === '"## "' && space.mk === space.fs && typed.lh === space.lh && typed.card === space.card, { space, typed });
  await close(h);
});

/** 占位字只在整篇 Note 空着时显示；有内容的 Note 里新起的空行不显示 */
test("placeholderOnlyWhenNoteEmpty", async () => {
  const h = await open({ board: board(["", "first line"]), light });
  await idle(h);
  const ph = (id: string) => h.page.evaluate((id) => [...document.querySelectorAll(`.card[data-id="${id}"] .md-pm > *`)].map((e) => getComputedStyle(e, "::before").content), id);
  await editNote(h, "n0");
  const empty = await ph("n0");
  await exitEdit(h);
  await editNote(h, "n1");
  await keys(h.page, "{Control+End}{Enter}");
  await idle(h);
  const line = await ph("n1");
  await shot(h, "placeholderOnlyWhenNoteEmpty");
  check("placeholderOnlyWhenNoteEmpty", empty.length === 1 && empty[0] !== "none" && line.length === 2 && line.every((c) => c === "none"), { empty, line });
  await close(h);
});

/** A leading heading that is the Note's title isn't shown again in the body (display only: the Markdown keeps it); editing shows it,
 *  sliding in while the header folds away (same card height); a title set by the user or the setting keeps it in the body */
test("noteTitleHeadingHiddenInBody", async () => {
  const doc = "# KV cache budget\n\nPrefill first, then decode.\n\nOne block per sequence.";
  const b = board([doc, doc]);
  (b.cards.find((c) => c.id === "n1") as NoteCard).title = "My own title";
  const h = await open({ board: b, light });
  await idle(h);
  const look = () => h.page.evaluate(() => [0, 1].map((i) => {
    const card = document.querySelector(`.card[data-id="n${i}"]`)!, head = card.querySelector(".nbody h1") as HTMLElement | null;
    return { title: card.querySelector(".chead .ctitle")!.textContent, h1: !!head && head.getBoundingClientRect().height > 0, h: Math.round(card.getBoundingClientRect().height) };
  }));
  const shown = await look();
  await shot(h, "note-heading-01-hidden");
  check("note-heading-hidden", shown[0].title === "KV cache budget" && !shown[0].h1 && shown[1].title === "My own title" && shown[1].h1 && md(h, "n0") === doc.trim(), shown);
  // enter editing: the heading is there to edit and slides in while the header folds away, so the card keeps its height
  await h.page.evaluate(() => { const w = window as any; w.__hs = []; w.__hsDone = false; const card = document.querySelector('.card[data-id="n0"]')!; const t0 = performance.now();
    const f = () => { w.__hs.push(card.getBoundingClientRect().height); if (performance.now() - t0 < 1500) requestAnimationFrame(f); else w.__hsDone = true; }; requestAnimationFrame(f); });
  await h.page.locator('.card[data-id="n0"] .nbody p').last().dblclick();
  await h.page.waitForSelector('.card[data-id="n0"] .md-pm h1', { timeout: 5000 });
  await shot(h, "note-heading-02-editing");
  await h.page.waitForFunction(() => (window as any).__hsDone, null, { timeout: 5000 }); // the heights recorded over 1.5 s
  const hs: number[] = await h.page.evaluate(() => (window as any).__hs);
  const steps = hs.slice(1).map((v, i) => v - hs[i]), grow = hs[hs.length - 1] - hs[0], jump = Math.max(...steps);
  const edit = await h.page.evaluate(() => { const e = document.querySelector('.card[data-id="n0"] .md-pm h1') as HTMLElement | null; return { text: e?.textContent, op: e ? getComputedStyle(e).opacity : "" }; });
  check("note-heading-editable", edit.text === "KV cache budget" && edit.op === "1", edit);
  check("note-heading-slides-in", hs.length > 5 && Math.abs(grow) <= 0.5 && Math.max(...steps.map(Math.abs)) <= 0.5, { grow, jump, frames: hs.length });
  // leave: hidden again, card back to its height; while it slides out, the part above the body's top edge is clipped (never over the card header)
  await h.page.evaluate(() => { const w = window as any; w.__over = []; w.__overDone = false; const t0 = performance.now();
    const f = () => { const body = document.querySelector('.card[data-id="n0"] .nbody') as HTMLElement, e = body.querySelector("h1"); if (e && e.getBoundingClientRect().height > 0) { const out = body.getBoundingClientRect().top - e.getBoundingClientRect().top; if (out > 1) w.__over.push({ out: Math.round(out), clip: getComputedStyle(body).clipPath }); }
      if (performance.now() - t0 < 600) requestAnimationFrame(f); else w.__overDone = true; }; requestAnimationFrame(f); });
  await exitEdit(h); await h.page.waitForFunction(() => (window as any).__overDone, null, { timeout: 5000 }); // recorded over 0.6 s
  const over: { out: number; clip: string }[] = await h.page.evaluate(() => (window as any).__over);
  check("note-heading-slide-stays-in-body", over.length > 0 && over.every((o) => o.clip.startsWith("inset")), over);
  const after = await look();
  check("note-heading-hidden-after-edit", !after[0].h1 && Math.abs(after[0].h - shown[0].h) <= 1 && md(h, "n0") === doc.trim(), { after, shown });
  await close(h);
  // Settings → Notes: keep the heading in the body
  const h2 = await open({ board: board([doc]), light, settings: { noteHeadingInBody: true } });
  await idle(h2);
  const kept = await h2.page.evaluate(() => (document.querySelector('.card[data-id="n0"] .nbody h1') as HTMLElement | null)?.getBoundingClientRect().height ?? 0);
  await shot(h2, "note-heading-03-setting-show");
  check("note-heading-setting-shows", kept > 0, { kept });
  await close(h2);
});

/**
 * 公式在原处展开 LaTeX 原文（Typora 一样），没有浮出来的公式框：点行内公式，它换成 $…$ 原文，光标离开时变回公式；
 * 方向键走进公式块，原文在块里展开、预览在下面边打边变；Esc 收起写回（和显示时一样高），一次 ⌘Z 撤回这次修改
 */
test("mathSourceInPlace", async () => {
  const h = await open({ board: board(["a $x^2$ b\n\n$$\n\\frac{1}{2}\n$$\n\nend"]), light });
  const pg = h.page, card = '.card[data-id="n0"]';
  await idle(h);
  const blockH = () => pg.evaluate((card) => Math.round(document.querySelector(`${card} :is(.math, [data-type=block-math])`)!.getBoundingClientRect().height), card);
  const tex = () => pg.evaluate((card) => [...document.querySelectorAll(`${card} annotation`)].map((a) => a.textContent), card);
  const shownH = await blockH();
  await pg.locator(`${card} .nbody p`).last().dblclick();
  await pg.waitForSelector(`${card} .md-pm`, { timeout: 5000 });
  // 行内：点一下，换成原文，光标在里面
  { const b = (await pg.locator(`${card} .md-pm [data-type=inline-math] .katex-base`).boundingBox())!; await pg.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }
  await until(h, "the clicked formula opens as its source", async () => !(await pg.locator(`${card} .md-pm [data-type=inline-math]`).count()));
  const inline = await pg.evaluate((card) => ({ text: (document.querySelector(`${card} .md-pm p`) as HTMLElement).innerText, math: document.querySelectorAll(`${card} .md-pm [data-type=inline-math]`).length }), card);
  await shot(h, "mathSourceInPlace-inline");
  await pg.keyboard.type("+1");
  // 方向键往下：离开行内原文（变回公式），走进公式块（展开原文）
  await keys(pg, "{ArrowDown}");
  await pg.locator(`${card} [data-type=block-math].is-open textarea:focus`).waitFor();
  const open1 = await pg.evaluate((card) => {
    const b = document.querySelector(`${card} [data-type=block-math]`)!, t = b.querySelector("textarea")!, pv = b.querySelector(".block-math-inner")!;
    return { open: b.classList.contains("is-open"), focus: document.activeElement === t, value: t.value, above: t.getBoundingClientRect().bottom <= pv.getBoundingClientRect().top + 1, inline: document.querySelectorAll(`${card} .md-pm [data-type=inline-math]`).length };
  }, card);
  await pg.keyboard.press("Control+a");
  await pg.keyboard.type("\\frac{3}{4}");
  await until(h, "the preview follows the typing", async () => (await tex()).includes("\\frac{3}{4}"));
  const live = await tex();
  await shot(h, "mathSourceInPlace-block");
  await pg.keyboard.press("Escape");
  await expect(pg.locator(`${card} .is-open`)).toHaveCount(0);
  await idle(h);
  const closed = await pg.evaluate((card) => ({ open: document.querySelectorAll(`${card} .is-open`).length, inEditor: !!document.activeElement?.closest(".md-pm") && document.activeElement?.tagName !== "TEXTAREA" }), card);
  const closedH = await blockH(), after = await tex();
  await pg.keyboard.press("Control+z");
  await until(h, "undo takes the formula edit back", async () => (await tex()).includes("\\frac{1}{2}"));
  const undone = await tex();
  await exitEdit(h);
  const text = md(h, "n0"), pops = await pg.locator(".md-mathpop").count();
  const r = { inline, open1, live, closed, shownH, closedH, after, undone, text, pops };
  check("mathSourceInPlace", inline.text.includes("$x^2$") && inline.math === 0 && open1.open && open1.focus && open1.value === "\\frac{1}{2}" && open1.above && open1.inline === 1
    && live.includes("\\frac{3}{4}") && closed.open === 0 && closed.inEditor && closedH === shownH && after.includes("\\frac{3}{4}") && undone.includes("\\frac{1}{2}")
    && text === "a $x^2+1$ b\n\n$$\n\\frac{1}{2}\n$$\n\nend" && pops === 0, r);
  await close(h);
});

/** 编辑时没有块左边的拖动把手（⋮⋮）：白板不开 dragHandle */
test("noteEditorHasNoDragHandle", async () => {
  const h = await open({ board: board(["# Title\n\nfirst\n\nsecond"]), light });
  await idle(h);
  await editNote(h, "n0");
  for (const p of await h.page.locator('.card[data-id="n0"] .md-pm > *').all()) { await p.hover(); await idle(h); } // a drag handle would show on hover
  await shot(h, "noteEditorHasNoDragHandle");
  const handles = await h.page.locator(".md-handle").count();
  check("noteEditorHasNoDragHandle", handles === 0, { handles });
  await close(h);
});

/** Settings → Notes → Font size: body text and H1 set in the Settings page apply at once to every Note (same element, no re-render),
 *  the same while editing; headings left at Theme scale with the body; Text cards keep their size; the Note re-measures and pushes
 *  the card below it down; Reset All goes back to the theme's sizes. Screenshots to FONT_SHOTS (default test-out/harness/fonts) */
test("noteFontSizeSettings", async () => {
  const SHOTS = process.env.FONT_SHOTS ?? path.join(OUT, "fonts");
  try { fs.mkdirSync(SHOTS, { recursive: true }); } catch { /* harness output only */ }
  const b = emptyBoard("b1", "note fonts");
  const doc = "# Scheduler\n\n## Prefill first\n\nEach step picks waiting sequences while the KV cache has room, then decodes the running ones.\n\n### Preemption\n\nWhen blocks run out, the newest sequence goes back to waiting.";
  put(b, { id: "n0", kind: "note", md: doc, look: "note" } as NoteCard, 60, 60, 420);
  put(b, { id: "n1", kind: "note", md: "Below the first Note.", look: "note" } as NoteCard, 60, 305, 420);
  put(b, { id: "t0", kind: "note", md: "A Text card", look: "text" } as NoteCard, 560, 60, 240);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, light: true, w: 1200, h: 820, settings: { theme: "warm-ink", noteHeadingInBody: true } as never });
  const pg = h.page;
  await idle(h);
  type Mark = HTMLElement & { __mark?: number };
  const sizes = () => pg.evaluate(() => {
    const card = document.querySelector('.card[data-id="n0"]') as HTMLElement, body = card.querySelector(".nbody") as HTMLElement & { __mark?: number };
    const root = body.querySelector(".md-pm") ?? body;
    const px = (sel: string) => parseFloat(getComputedStyle(root.querySelector(sel)!).fontSize);
    return { body: px(":scope > p"), h1: px("h1"), h2: px("h2"), h3: px("h3"), text: parseFloat(getComputedStyle(document.querySelector('.card[data-id="t0"] .tx')!).fontSize),
      cardH: Math.round(card.getBoundingClientRect().height), same: body.__mark === 1, editing: !!body.querySelector(".md-pm") };
  });
  const below = () => h.board().place.n1?.y ?? 0;
  const before = await sizes(), belowBefore = below();
  await pg.evaluate(() => { (document.querySelector('.card[data-id="n0"] .nbody') as Mark).__mark = 1; });
  await pg.screenshot({ path: path.join(SHOTS, "note-before.png"), clip: { x: 40, y: 40, width: 800, height: 560 } });

  // Settings → Notes: one row per level; untouched levels show the theme's size
  await pg.keyboard.press("Meta+Comma");
  await pg.waitForSelector(".settings");
  const sec = pg.locator('.settings [data-sec="notes"]');
  await sec.scrollIntoViewIfNeeded();
  const rows = () => sec.locator(".st-fr").evaluateAll((rs) => rs.map((r) => ({ level: (r as HTMLElement).dataset.level, value: (r.querySelector("input") as HTMLInputElement).value, theme: !!r.querySelector(".st-def") })));
  const rows0 = await rows();
  const setRow = async (level: string, v: string) => { const inp = sec.locator(`.st-fr[data-level="${level}"] input`); await inp.fill(v); await inp.press("Enter"); await idle(h); };
  await setRow("body", "16");
  await setRow("h1", "32");
  await pg.mouse.move(5, 5);
  await pg.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await idle(h);
  const rows1 = await rows();
  await sec.screenshot({ path: path.join(SHOTS, "settings-notes.png") });
  const sent = h.sent.filter((m) => m.type === "setSetting" && (m as { key: string }).key === "noteFontSize").map((m) => (m as { value: unknown }).value);
  await pg.keyboard.press("Escape");
  await pg.locator(".settings").waitFor({ state: "detached" }); await idle(h);
  const after = await sizes(), belowAfter = below();
  await pg.screenshot({ path: path.join(SHOTS, "note-after.png"), clip: { x: 40, y: 40, width: 800, height: 560 } });

  // the same sizes in the editor
  await pg.locator('.card[data-id="n0"] .nbody p').last().dblclick();
  await pg.waitForSelector('.card[data-id="n0"] .md-pm', { timeout: 5000 });
  await pg.mouse.move(5, 5);
  await idle(h);
  const edit = await sizes();
  await exitEdit(h);

  // Reset All: back to the theme
  await pg.keyboard.press("Meta+Comma");
  await pg.waitForSelector(".settings");
  await pg.locator('.settings [data-sec="notes"] button', { hasText: "Reset All" }).click();
  await pg.keyboard.press("Escape");
  await pg.locator(".settings").waitFor({ state: "detached" }); await idle(h);
  const reset = await sizes();

  const near = (a: number, b: number) => Math.abs(a - b) < 0.1;
  check("noteFont-themeDefaults", near(before.body, 13.5) && near(before.h1, 13.5 * 1.8) && near(before.h2, 13.5 * 1.35)
    && rows0.length === 7 && rows0.every((r) => r.theme) && rows0[0].value === "13.5" && rows0[1].value === "24.3", { before, rows0 });
  check("noteFont-settingsRows", rows1[0]?.value === "16" && !rows1[0]?.theme && rows1[1]?.value === "32" && !rows1[1]?.theme && rows1[2]?.theme && rows1[2]?.value === "21.6"
    && JSON.stringify(sent[sent.length - 1]) === JSON.stringify({ body: 16, h1: 32, h2: null, h3: null, h4: null, h5: null, h6: null }), { rows1, sent });
  check("noteFont-appliesLive", near(after.body, 16) && near(after.h1, 32) && near(after.h2, 16 * 1.35) && near(after.h3, 16 * 1.1) && after.same && near(after.text, before.text), { after, before });
  check("noteFont-cardRemeasures", after.cardH > before.cardH + 20 && belowAfter > belowBefore, { before: before.cardH, after: after.cardH, belowBefore, belowAfter });
  check("noteFont-sameWhileEditing", edit.editing && near(edit.body, 16) && near(edit.h1, 32) && near(edit.h2, after.h2) && Math.abs(edit.cardH - after.cardH) <= 1, { edit, after });
  check("noteFont-resetAll", near(reset.body, 13.5) && near(reset.h1, 13.5 * 1.8) && Math.abs(reset.cardH - before.cardH) <= 1, { reset, before });
  await close(h);
});

const FOLD_TEXT = "计算系统 A 相对于计算系统 B 的应用加速比。\n\nSpeedup is the time on B over the time on A.";
const FOLD_NOTES = [`# 加速比、Amdahl's Law\n\n${FOLD_TEXT}`, FOLD_TEXT, `### Amdahl's Law\n\n${FOLD_TEXT}`];
/** Editing a Note whose header shows its leading heading folds the whole header away (··· stays, still clickable) while the heading
 *  slides in, and the card keeps its height every frame (H1 and H3); a Note without a heading keeps its header and its height.
 *  Warm Ink and Soft Light; screenshots of both states go to test-out/harness/noteFold-<theme>-*.png */
test("noteEditKeepsHeightWithHeaderFolded", async () => {
  for (const theme of ["warm-ink", "soft-light"]) {
    const b = emptyBoard("b1", "fold");
    FOLD_NOTES.forEach((m, i) => put(b, { id: `n${i}`, kind: "note", md: m, look: "note" } as NoteCard, 60 + i * 420, 60, 380));
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light: true, w: 1400, h: 520, settings: { theme } as never });
    const pg = h.page;
    await idle(h);
    const hOf = (id: string) => pg.evaluate((id) => document.querySelector(`.card[data-id="${id}"]`)!.getBoundingClientRect().height, id);
    await pg.screenshot({ path: path.join(OUT, `noteFold-${theme}-display.png`), clip: { x: 40, y: 40, width: 1300, height: 260 } });
    const res: Record<string, unknown>[] = [];
    for (const id of ["n0", "n1", "n2"]) {
      const before = await hOf(id);
      await pg.evaluate((id) => { const w = window as any; w.__hs = []; const card = document.querySelector(`.card[data-id="${id}"]`)!; const t0 = performance.now();
        const f = () => { w.__hs.push(card.getBoundingClientRect().height); if (performance.now() - t0 < 700) requestAnimationFrame(f); else w.__hsDone = true; }; w.__hsDone = false; requestAnimationFrame(f); }, id);
      await pg.locator(`.card[data-id="${id}"] .nbody p`).last().dblclick();
      await pg.waitForSelector(`.card[data-id="${id}"] .md-pm`, { timeout: 5000 });
      await pg.mouse.move(5, 5);
      await pg.waitForFunction(() => (window as any).__hsDone); // every frame of the 700 ms from the double-click is recorded
      await idle(h);
      const hs: number[] = await pg.evaluate(() => (window as any).__hs);
      const st = await pg.evaluate((id) => {
        const card = document.querySelector(`.card[data-id="${id}"]`)!, head = card.querySelector(".chead")!, ib = head.querySelector<HTMLElement>(".ib")!, r = ib.getBoundingClientRect();
        const hd = card.querySelector<HTMLElement>(".md-pm > :is(h1, h3)");
        return { folded: head.classList.contains("fold"), title: getComputedStyle(head.querySelector(".ctitle")!).opacity,
          ibHit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".ib") === ib, heading: hd ? getComputedStyle(hd).opacity : null };
      }, id);
      if (id !== "n1") await pg.screenshot({ path: path.join(OUT, `noteFold-${theme}-editing-${id === "n0" ? "h1" : "h3"}.png`), clip: { x: 40, y: 40, width: 1300, height: 260 } });
      await exitEdit(h);
      const after = await hOf(id), unfolded = await pg.evaluate((id) => !document.querySelector(`.card[data-id="${id}"] .chead`)!.classList.contains("fold"), id);
      const dev = Math.max(...hs.map((v) => Math.abs(v - before)));
      res.push({ id, before, dev: +dev.toFixed(2), frames: hs.length, after, unfolded, ...st });
    }
    const [h1, none, h3] = res as any[];
    check(`noteFold-keepsHeight-${theme}`, res.every((r: any) => r.dev <= 0.5 && r.frames > 5 && Math.abs(r.after - r.before) <= 0.5 && r.unfolded), res);
    check(`noteFold-onlyWhenHeaderIsHeading-${theme}`, h1.folded && h3.folded && !none.folded && h1.title === "0" && none.title === "1" && h1.heading === "1" && h3.heading === "1", res);
    check(`noteFold-moreButtonStaysClickable-${theme}`, h1.ibHit && h3.ibHit, res);
    await close(h);
  }
});

/** The same Note text at the same width is the same height in Warm Ink and Soft Light (same font size, header and padding) */
test("noteHeightSameInWarmInkAndSoftLight", async () => {
  const heights: Record<string, number[]> = {};
  for (const theme of ["warm-ink", "soft-light"]) {
    const b = emptyBoard("b1", "same height");
    const notes = ["# Title\n\nShort line one.\n\nShort line two.\n\n- item a\n- item b", "一行中文和 English.\n\n第二段。", "### Small title\n\nOne line."];
    notes.forEach((m, i) => put(b, { id: `n${i}`, kind: "note", md: m, look: "note" } as NoteCard, 60 + i * 420, 60, 380));
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light: true, w: 1400, h: 520, settings: { theme } as never });
    await idle(h);
    heights[theme] = await h.page.evaluate(() => ["n0", "n1", "n2"].map((id) => +document.querySelector(`.card[data-id="${id}"]`)!.getBoundingClientRect().height.toFixed(2)));
    await close(h);
  }
  check("noteHeight-sameInWarmInkAndSoftLight", heights["warm-ink"].every((v, i) => Math.abs(v - heights["soft-light"][i]) <= 1), heights);
});

const THEMES = ["warm-ink", "soft-light"] as const;
/** Notes in a row, `w` wide each */
function noteRow(notes: string[], w = 380): Board {
  const b = emptyBoard("b1", "notes");
  notes.forEach((m, i) => put(b, { id: `n${i}`, kind: "note", md: m, look: "note" } as NoteCard, 60 + i * (w + 40), 60, w));
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
/** A screenshot of one card with a margin around it, no hover on it */
async function cardShot(h: Host, id: string, name: string) {
  await h.page.mouse.move(2, 2);
  await idle(h);
  const r = await h.page.locator(`.card[data-id="${id}"]`).boundingBox();
  if (r) await h.page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: r.x - 24, y: r.y - 24, width: r.width + 48, height: r.height + 48 } });
}

/** A [[card reference]] chip in Note text sits on the text's baseline (its label's baseline is the line's), and its box is no taller
 *  than the line: the paragraph is exactly its lines tall, displayed and while editing. Warm Ink and Soft Light; screenshots:
 *  test-out/harness/noteRefChipOnBaseline-<theme>-<display|edit>.png */
test("noteRefChipOnBaseline", async () => {
  const text = "对于向量加法 kernel，调用 kernel 之前，程序员需要在 [[Global Memory]] 中分配空间，并把数据从主机内存传送到设备 global memory 中的已分配空间。";
  for (const theme of THEMES) {
    const h = await open({ board: noteRow([text, "# Global Memory\n\nThe device's DRAM."]), light: true, w: 1000, h: 420, settings: { theme } as never });
    const pg = h.page;
    await idle(h);
    // baselines from the text boxes (a text box's top is its baseline less the font's ascent): nothing is added to the page, so it
    // is the same measurement in the editor (ProseMirror would read a node put into its DOM)
    const geo = () => pg.evaluate(async () => {
      await document.fonts.ready;
      const chip = document.querySelector<HTMLElement>('.card[data-id="n0"] .md-ref')!, p = chip.closest("p")!;
      const ctx = document.createElement("canvas").getContext("2d")!;
      const base = (t: Node) => {
        const r = document.createRange();
        r.selectNodeContents(t);
        const cs = getComputedStyle(t.parentElement!);
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        return r.getClientRects()[0].top + ctx.measureText(t.textContent!).fontBoundingBoxAscent;
      };
      const label = [...chip.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)!, next = chip.nextSibling!;
      const lh = parseFloat(getComputedStyle(p).lineHeight), ph = p.getBoundingClientRect().height, lines = Math.round(ph / lh);
      return { chip: +base(label).toFixed(2), text: +base(next).toFixed(2), chipH: +chip.getBoundingClientRect().height.toFixed(2), lh, ph: +ph.toFixed(2), lines,
        missing: chip.classList.contains("missing") };
    });
    const shown = await geo();
    await cardShot(h, "n0", `noteRefChipOnBaseline-${theme}-display`);
    await pg.locator('.card[data-id="n0"] .nbody p').dblclick({ position: { x: 4, y: 4 } });
    await pg.waitForSelector('.card[data-id="n0"] .md-pm .md-ref', { timeout: 5000 });
    await idle(h);
    const edit = await geo();
    await cardShot(h, "n0", `noteRefChipOnBaseline-${theme}-edit`);
    await exitEdit(h);
    for (const [mode, g] of [["display", shown], ["edit", edit]] as const)
      check(`noteRefChipOnBaseline ${theme} ${mode}`, !g.missing && Math.abs(g.chip - g.text) <= 0.5 && g.chipH <= g.lh && g.lines >= 2 && Math.abs(g.ph - g.lines * g.lh) <= 0.5, g);
    await close(h);
  }
});

/** A Note whose last block is a code block has as much room below it as one ending in a paragraph (no trailing margin, no extra
 *  blank line), and keeps its height when editing starts and ends, with the caret at the very end too (the editor's empty paragraph
 *  after the code block, where typing goes on, takes no room until something is typed into it). Warm Ink and Soft Light;
 *  screenshots: test-out/harness/noteEndingInCodeBlockNoExtraSpace-<theme>-<display|edit>.png */
test("noteEndingInCodeBlockNoExtraSpace", async () => {
  const notes = ["`cudaFree()`: frees object from device global memory\n\n```\nDF\n```", "`cudaFree()`: frees object from device global memory\n\nLast paragraph."];
  for (const theme of THEMES) {
    const h = await open({ board: noteRow(notes), light: true, w: 1000, h: 420, settings: { theme } as never });
    const pg = h.page;
    await idle(h);
    const geo = (id: string) => pg.evaluate((id) => {
      const card = document.querySelector(`.card[data-id="${id}"]`)!, body = card.querySelector(".nbody")!;
      const last = id === "n0" ? body.querySelector("pre")! : [...body.querySelectorAll("p")].pop()!;
      const c = card.getBoundingClientRect();
      return { h: +c.height.toFixed(2), below: +(c.bottom - last.getBoundingClientRect().bottom).toFixed(2) };
    }, id);
    const para = await geo("n1"), shown = await geo("n0");
    await cardShot(h, "n0", `noteEndingInCodeBlockNoExtraSpace-${theme}-display`);
    await pg.locator('.card[data-id="n0"] .nbody p').first().dblclick();
    await pg.waitForSelector('.card[data-id="n0"] .md-pm pre', { timeout: 5000 });
    await idle(h);
    const edit = await geo("n0");
    await keys(pg, "{Control+End}"); // the caret after the code block, where typing goes on
    await idle(h);
    const atEnd = await geo("n0");
    await cardShot(h, "n0", `noteEndingInCodeBlockNoExtraSpace-${theme}-edit`);
    await exitEdit(h);
    const after = await geo("n0");
    check(`noteEndingInCodeBlockNoExtraSpace ${theme} display`, Math.abs(shown.below - para.below) <= 0.5, { shown, para });
    check(`noteEndingInCodeBlockNoExtraSpace ${theme} edit`, [edit, atEnd, after].every((g) => Math.abs(g.h - shown.h) <= 0.5 && Math.abs(g.below - shown.below) <= 0.5), { shown, edit, atEnd, after });
    check(`noteEndingInCodeBlockNoExtraSpace ${theme} unchanged`, md(h, "n0") === notes[0], { got: md(h, "n0") });
    await close(h);
  }
});

/** Note 代码块右上角的语言名（照 Typora）：光标在块里时淡淡地显示（Plain text、Python），右上角、没有底色和边框；
 *  悬停时出现 ▾。点它在下面打开列表，筛选框里打字筛出语言，↵ 定下来（马上换着色，一次撤销回去），Esc 不改，点列表里的一项也行，
 *  Plain text 那一行 = 纯文字；列表开着时点了别处：照筛出的定下来，保存退出。写回成 ```语言 */
test("noteCodeBlockLanguagePicker", async () => {
  const CODE = "def f():\n    return 1";
  const h = await open({ board: board([`Intro\n\n\`\`\`\n${CODE}\n\`\`\`\n\nafter`, "other note"]), light });
  await idle(h);
  const pg = h.page, n0 = '.card[data-id="n0"]';
  const pre = pg.locator(`${n0} .md-pm pre`), label = pg.locator(`${n0} .md-pm pre .md-lang`);
  const list = pg.locator(".md-langbox .md-lo"), filter = pg.locator(".md-langbox .md-langq");
  const kws = () => pg.locator(`${n0} .md-pm pre .cm-content .kw`).count();
  const style = (sel: string, k: string) => pg.locator(sel).first().evaluate((e, k) => getComputedStyle(e).getPropertyValue(k), k);
  const opacity = () => style(`${n0} .md-pm pre .md-lang`, "opacity");
  const chevron = () => style(`${n0} .md-pm pre .md-lang .md-lang-v`, "opacity");
  const name = () => label.innerText();
  const inCode = () => pg.evaluate(() => !!document.activeElement?.closest(".cm-content"));
  /** 这张 Note 的截图，鼠标留在原处（悬停的样子） */
  const snap = async (n: string) => {
    await idle(h);
    const r = (await pg.locator(n0).boundingBox())!, l = (await pg.locator(".md-langbox").count()) ? await pg.locator(".md-langbox").boundingBox() : null;
    const bottom = Math.max(r.y + r.height, l ? l.y + l.height : 0);
    await pg.screenshot({ path: path.join(OUT, `noteCodeBlockLanguagePicker-${n}.png`), clip: { x: r.x - 24, y: r.y - 24, width: r.width + 48, height: bottom - r.y + 48 } });
  };
  const res: Record<string, unknown> = { inDisplay: await pg.locator(`${n0} .md-lang`).count() }; // 只在编辑时有
  await editNote(h, "n0");
  // 光标在代码里：显示 Plain text（纯文字）；鼠标不在块上：没有 ▾
  await pg.locator(`${n0} .md-pm pre .cm-content`).click();
  await pg.mouse.move(2, 2);
  await until(h, "the language label shows while the caret is in the block", async () => (await opacity()) === "1");
  await idle(h);
  res.plain = { name: await name(), kw: await kws(), chevron: await chevron() };
  // 右上角（离右边 10px、上边 6px），一行淡色小字：没有底色、边框、阴影
  const [lr, pr] = [(await label.boundingBox())!, (await pre.boundingBox())!];
  const look = await label.evaluate((e) => { const s = getComputedStyle(e); return { bg: s.backgroundColor, border: s.borderTopWidth + s.borderTopStyle, shadow: s.boxShadow, font: s.fontSize }; });
  res.place = { right: +(pr.x + pr.width - lr.x - lr.width).toFixed(1), top: +(lr.y - pr.y).toFixed(1), ...look };
  check("noteCodeBlockLanguagePicker label at the top right, plain text", Math.abs((res.place as any).right - 10) <= 1 && Math.abs((res.place as any).top - 6) <= 1
    && look.bg === "rgba(0, 0, 0, 0)" && /^0px/.test(look.border) && look.shadow === "none" && look.font === "11px", res.place);
  await snap("rest");
  // 悬停：▾ 淡入
  await pre.hover();
  await until(h, "the chevron fades in on hover", async () => +(await chevron()) > 0.5);
  await snap("hover");
  // 点开：筛选框拿到焦点，现在的（Plain text）打 ✓、选中
  await label.click();
  await expect(filter).toBeFocused();
  res.open = { placeholder: await filter.getAttribute("placeholder"), sel: await pg.locator(".md-langbox .md-lo.sel .lb").innerText(), ck: await pg.locator(".md-langbox .md-lo.sel .ck").innerText() };
  await snap("list");
  // 打 py：Python 在最前面、选中；↵ 定下来，着色马上换，焦点回到代码
  await pg.keyboard.type("py");
  await expect(list.first()).toHaveText(/Python/);
  res.list = { first: await list.first().innerText(), sel: await pg.locator(".md-langbox .md-lo.sel").innerText() };
  await snap("filtered");
  await pg.keyboard.press("Enter");
  await expect(pg.locator(".md-langbox")).toHaveCount(0);
  await until(h, "python keywords colored", kws);
  res.python = { name: await name(), inCode: await inCode() };
  await snap("python");
  // 一次撤销回到纯文字，重做又是 Python
  await pg.keyboard.press("Control+z");
  await until(h, "undo: back to plain text", async () => (await kws()) === 0 && (await name()) === "Plain text");
  await pg.keyboard.press("Control+Shift+z");
  await until(h, "redo: python again", async () => (await kws()) > 0 && (await name()) === "Python");
  // Esc：不改，回到代码里，还在编辑
  await label.click();
  await expect(filter).toBeFocused();
  await pg.keyboard.type("rust");
  await pg.keyboard.press("Escape");
  await expect(pg.locator(".md-langbox")).toHaveCount(0);
  res.esc = { name: await name(), editing: await editing(h, "n0"), inCode: await inCode() };
  // ↑↓ 在列表里挪；Plain text 那一行：纯文字
  await label.click();
  await expect(filter).toBeFocused();
  await pg.keyboard.type("c");
  const first = await pg.locator(".md-langbox .md-lo.sel .lb").innerText();
  await pg.keyboard.press("ArrowDown");
  res.arrow = first !== (await pg.locator(".md-langbox .md-lo.sel .lb").innerText());
  await pg.keyboard.press("Escape");
  await label.click();
  await expect(filter).toBeFocused();
  await pg.keyboard.type("plain");
  await expect(pg.locator(".md-langbox .md-lo.sel .lb")).toHaveText("Plain text");
  await pg.keyboard.press("Enter");
  await until(h, "plain text row: no language", async () => (await kws()) === 0 && (await name()) === "Plain text");
  // 点列表里的一项
  await label.click();
  await expect(filter).toBeFocused();
  await pg.keyboard.type("cu");
  await pg.locator(".md-langbox .md-lo", { hasText: "CUDA" }).click();
  await until(h, "picked CUDA", async () => (await name()) === "CUDA");
  // 光标离开这一块、鼠标也不在上面：不显示
  await pg.mouse.move(5, 5);
  await keys(pg, "{ArrowDown}{ArrowDown}{ArrowDown}");
  await until(h, "the language label hides when the caret leaves the block", async () => (await opacity()) === "0");
  await exitEdit(h);
  await idle(h);
  res.saved = md(h, "n0");
  // 列表开着时点了别的卡片：照筛出的定下来，保存退出
  await editNote(h, "n0");
  await pg.locator(`${n0} .md-pm pre .cm-content`).click();
  await label.click();
  await expect(filter).toBeFocused();
  await pg.keyboard.type("rust");
  await pg.locator('.card[data-id="n1"] .nbody').click();
  await until(h, "the edit is saved", () => md(h, "n0").startsWith("Intro\n\n```rust"));
  await idle(h);
  res.away = { md: md(h, "n0"), editing: await editing(h, "n0"), list: await pg.locator(".md-langbox").count() };
  const ok = res.inDisplay === 0
    && JSON.stringify(res.plain) === JSON.stringify({ name: "Plain text", kw: 0, chevron: "0" })
    && JSON.stringify(res.open) === JSON.stringify({ placeholder: "Filter languages", sel: "Plain text", ck: "✓" })
    && /^Python\s+python$/.test(String((res.list as any).first)) && /Python/.test(String((res.list as any).sel))
    && JSON.stringify(res.python) === JSON.stringify({ name: "Python", inCode: true })
    && JSON.stringify(res.esc) === JSON.stringify({ name: "Python", editing: 1, inCode: true })
    && res.arrow === true
    && res.saved === `Intro\n\n\`\`\`cuda\n${CODE}\n\`\`\`\n\nafter`
    && JSON.stringify(res.away) === JSON.stringify({ md: `Intro\n\n\`\`\`rust\n${CODE}\n\`\`\`\n\nafter`, editing: 0, list: 0 });
  check("noteCodeBlockLanguagePicker", ok, res);
  await close(h);
});

/** 语言列表开着（焦点在筛选框里）时编辑被宿主那边结束（换了白板）：拆掉代码块时列表跟着拿掉，不报错，
 *  那一个编辑器还能接着用（下一次编辑照常进、照常保存） */
test("noteLanguagePickerOpenWhenBoardChanges", async () => {
  const h = await open({ board: board(["Intro\n\n```\nx = 1\n```\n\nafter"]), light });
  const errors: string[] = [];
  h.page.on("pageerror", (e) => errors.push(e.message));
  await idle(h);
  const pg = h.page;
  await editNote(h, "n0");
  await pg.locator('.card[data-id="n0"] .md-pm pre .cm-content').click();
  await pg.locator('.card[data-id="n0"] .md-pm pre .md-lang').click();
  await expect(pg.locator(".md-langbox .md-langq")).toBeFocused();
  const b2 = emptyBoard("b2", "other");
  put(b2, { id: "m0", kind: "note", md: "second", look: "note" } as NoteCard, 60, 60, 520);
  await h.post({ type: "init", board: b2, boards: [{ id: "b2", name: "other", cards: 1 }], views: {}, stale: {}, host: { isMac: true, assetBase: "", target: true, settings: { ...DEFAULT_SETTINGS } } });
  await pg.locator('.card[data-id="n0"]').waitFor({ state: "detached" });
  await idle(h);
  const list = await pg.locator(".md-langbox").count();
  await editNote(h, "m0");
  await keys(pg, "{Control+End} board");
  await exitEdit(h);
  await until(h, "the second board's note is saved", () => h.sent.some((m) => JSON.stringify(m).includes("second board")));
  check("noteLanguagePickerOpenWhenBoardChanges", !errors.length && list === 0, { errors, list });
  await close(h);
});

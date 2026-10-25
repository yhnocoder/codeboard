// 在白板上改字：Note 的 Markdown 编辑器、Sidenote 的字、撤销。每个场景查一件事，名字就是查的那件事。
// Usage: npm run harness -- noteImageReopens noteAutoPairOvertype noteTabStaysInEditor noteTrailingBlockExit
//          notePasteIntoTableCell editorKeysReachVsCode sidenoteTextEditSaves noteCodeScratchClosed undoIsOneStep
//          noteDisplayMathTypedAsBlock noteEditKeepsLayout noteTitleHeadingHiddenInBody
import { put, findSym, symCard, shot, type Host } from "../harness";
import { emptyBoard, type Board, type CodeCard, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { test, open, check, light } from "../fixtures";

const close = (h: Host) => h.page.context().close();

/** 打一串：{Enter}、{Control+z} 之类是按键，其余是字 */
async function keys(pg: Page, seq: string, delay = 0) {
  for (const part of seq.split(/(\{[A-Za-z0-9+]+\})/)) {
    if (!part) continue;
    if (/^\{.+\}$/.test(part)) {
      // 方向键是浏览器自己移光标，ProseMirror 要等 selectionchange 才知道：前后各等一下
      const nav = /Home|End|Arrow/.test(part);
      if (nav) await pg.waitForTimeout(300);
      await pg.keyboard.press(part.slice(1, -1));
      await pg.waitForTimeout(nav ? 120 : 30);
    } else await pg.keyboard.type(part, { delay });
  }
}
/** 一块白板：一张代码卡（Sidenote 挂在它上面）和 n 张 Note */
function board(init: string[] = []): Board {
  const b = emptyBoard("b1", "note editing");
  const s = findSym("Scheduler.schedule");
  put(b, symCard(s.f, s.s), 2400, 60, 420);
  init.forEach((md, i) => put(b, { id: `n${i}`, kind: "note", md, bg: true } as NoteCard, 60 + (i % 4) * 560, 60 + Math.floor(i / 4) * 360, 520));
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const md = (h: Host, id: string) => ((h.board().cards.find((c) => c.id === id) as NoteCard | undefined)?.md ?? "").trim();
const editing = (h: Host, id: string) => h.page.locator(`.card[data-id="${id}"] .md-pm`).count();
async function editNote(h: Host, id: string) {
  await h.post({ type: "reveal", card: id } as any);
  await h.page.waitForTimeout(450);
  await h.page.locator(`.card[data-id="${id}"] .nbody`).dblclick();
  await h.page.waitForSelector(`.card[data-id="${id}"] .md-pm`, { timeout: 5000 });
}
async function exitEdit(h: Host) {
  for (let k = 0; k < 3 && (await h.page.locator(".md-pm").count()); k++) { await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(80); }
}
/** 每条一张 Note：打一串键、退出，最后一起看写回的 Markdown */
async function typeCases(name: string, cases: { name: string; init?: string; seq: string; md: string; delay?: number }[]) {
  const h = await open({ board: board(cases.map((c) => c.init ?? "")) });
  await h.page.waitForTimeout(1500);
  for (let i = 0; i < cases.length; i++) {
    await editNote(h, `n${i}`);
    if (cases[i].init) await keys(h.page, "{Control+End}");
    await keys(h.page, cases[i].seq, cases[i].delay);
    await h.page.waitForTimeout(150);
    await exitEdit(h);
  }
  await h.page.waitForTimeout(1500);
  cases.forEach((c, i) => check(`${name} ${c.name}`, md(h, `n${i}`) === c.md, { got: md(h, `n${i}`), want: c.md }));
  await close(h);
}

/** 最后一块是图片的 Note（打的、粘贴的截图）：退出以后还能再双击编辑 */
test("noteImageReopens", async () => {
  const h = await open({ board: board(["a\n\n![i](https://x.y/a.png)", ""]) });
  await h.page.waitForTimeout(1500);
  let first = 0;
  try { await editNote(h, "n0"); first = await editing(h, "n0"); } catch { /* 打不开 */ }
  await exitEdit(h);
  await editNote(h, "n1");
  await keys(h.page, "![cat](https://x.y/c.png)");
  await exitEdit(h);
  await h.page.waitForTimeout(800);
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
  await h.page.waitForTimeout(1500);
  const runs: { seq: string; want: string }[] = [{ seq: "x{Tab}y", want: "xy" }, { seq: "# h{Tab}{Shift+Tab}i", want: "# hi" }, { seq: "- a{Enter}{Tab}b", want: "- a\n  - b" }];
  const still: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    await editNote(h, `n${i}`);
    await keys(h.page, runs[i].seq);
    still.push(await h.page.evaluate((id) => (document.activeElement?.closest(`.card[data-id="${id}"] .md-pm`) ? 1 : 0), `n${i}`));
    await exitEdit(h);
  }
  await h.page.waitForTimeout(1200);
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
  await h.page.waitForTimeout(1500);
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
    await h.page.waitForTimeout(200);
    await exitEdit(h);
  }
  await h.page.waitForTimeout(1200);
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
  await h.page.waitForTimeout(1500);
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
  await h.page.waitForTimeout(1500);
  const texts = () => h.board().sidenotes.map((n) => (n.kind === "text" ? n.md : n.kind));
  const openEdit = async () => {
    await h.page.locator(".mk").first().click(); await h.page.waitForTimeout(500);
    await h.page.locator("button.tbtn", { hasText: /^Edit$/ }).click(); await h.page.waitForTimeout(400);
  };
  await openEdit(); await keys(h.page, " +esc{Escape}"); await h.page.waitForTimeout(1500);
  const afterEsc = texts();
  await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(300);
  await openEdit(); await keys(h.page, " +click"); await h.page.mouse.click(1200, 800); await h.page.waitForTimeout(1500);
  const afterClick = texts();
  await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(300);
  await openEdit(); await keys(h.page, " +cancel"); await h.page.locator(".sn-edit button", { hasText: "Cancel" }).click(); await h.page.waitForTimeout(1500);
  const afterCancel = texts();
  // Add Sidenote → Text：写了字按 Esc
  await h.page.keyboard.press("Escape"); await h.page.waitForTimeout(300);
  await h.page.locator(".mk").first().click(); await h.page.waitForTimeout(500);
  await h.page.locator("button.tbtn", { hasText: "+ Add" }).click(); await h.page.waitForTimeout(400);
  await h.page.locator(".addnote .tab", { hasText: "Text" }).click(); await h.page.waitForTimeout(200);
  await keys(h.page, "added by esc{Escape}"); await h.page.waitForTimeout(1500);
  const afterAdd = texts();
  await openEdit(); await keys(h.page, "{Control+a}{Backspace}{Control+Enter}"); await h.page.waitForTimeout(1500);
  const afterClear = texts();
  const ok = JSON.stringify(afterEsc) === '["original +esc"]' && JSON.stringify(afterClick) === '["original +esc +click"]' && JSON.stringify(afterCancel) === '["original +esc +click"]'
    && JSON.stringify(afterAdd) === '["original +esc +click","added by esc"]' && JSON.stringify(afterClear) === '["added by esc"]';
  check("sidenoteTextEditSaves", ok, { afterEsc, afterClick, afterCancel, afterAdd, afterClear });
  await close(h);
});

/** Note 里的代码块编辑完：退出编辑时它在宿主那边的语言服务文档（.codeboard-note-code-* 隐藏文件）关掉 */
test("noteCodeScratchClosed", async () => {
  const h = await open({ board: board(["```python\nx = 1\n```"]) });
  await h.page.waitForTimeout(1500);
  await editNote(h, "n0");
  await h.page.locator('.card[data-id="n0"] .md-pm pre .cm-content').click();
  await keys(h.page, "{End}{Enter}y = x");
  await h.page.waitForTimeout(1500); // 改动停一下才同步给宿主（开文档）
  await exitEdit(h);
  await h.page.waitForTimeout(800);
  const opened = [...new Set(h.sent.filter((m) => m.type === "codeDoc").map((m: any) => m.id as string))];
  const closed = h.sent.filter((m) => m.type === "codeDocClose").map((m: any) => m.id as string);
  check("noteCodeScratchClosed", opened.length === 1 && opened.every((id) => closed.includes(id)), { opened, closed });
  await close(h);
});

/** 一个动作一次撤销：Sidenote → Place on Board；Note 的字删光（Note 跟着删掉） */
test("undoIsOneStep", async () => {
  const b = board(["hello world"]);
  const C = b.cards[0] as CodeCard, s = C.segments[0];
  b.place[C.id] = { x: 700, y: 60, w: 520 };
  b.sidenotes.push({ id: "sn1", kind: "text", md: "side text", at: { card: C.id, seg: s.id, lines: [s.start + 2, s.start + 2] } });
  const h = await open({ board: b });
  await h.page.waitForTimeout(1500);
  const st = () => { const B = h.board(); return `${B.cards.map((c) => c.kind).sort().join(",")} sn${B.sidenotes.length} l${B.links.length}`; };
  const undo = async () => { await h.page.locator("#board").click({ position: { x: 600, y: 760 } }); await h.page.waitForTimeout(200); await h.page.keyboard.press("Control+z"); await h.page.waitForTimeout(1500); };
  const start = st();
  await h.page.locator(".mk").first().click(); await h.page.waitForTimeout(600);
  await h.page.locator("button.tbtn", { hasText: "Place on Board" }).click(); await h.page.waitForTimeout(1200);
  const placed = st();
  await undo();
  const placeUndone = st();
  await editNote(h, "n0"); await keys(h.page, "{Control+a}{Backspace}"); await exitEdit(h); await h.page.waitForTimeout(1200);
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
  await h.page.waitForTimeout(1500);
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
  await h.page.waitForTimeout(150);
  const typed = await geo();
  await shot(h, "noteDisplayMathTypedAsBlock-typed");
  await keys(h.page, "after");
  await exitEdit(h);
  await h.page.waitForTimeout(1500);
  const shown = await geo(), text = md(h, "n0");
  await shot(h, "noteDisplayMathTypedAsBlock-shown");
  const same = (["x", "y", "w", "h"] as const).every((k) => typed[k] !== undefined && Math.abs(typed[k]! - shown[k]!) <= 1);
  check("noteDisplayMathTypedAsBlock", typed.block === 1 && typed.inline === 0 && typed.display === 1 && Math.abs(typed.dx ?? 99) <= 2 && same && text === "$$\n\\frac{200}{10}\n$$\n\nafter", { typed, shown, text });
  await close(h);
});

/** 双击进编辑：卡片高度、每一块的位置都不变，字形（连字）不变；选中的底色两边一样，是主题的强调色而不是浏览器的蓝色 */
test("noteEditKeepsLayout", async () => {
  const doc = "# Heading\n\nA paragraph with **bold**, `code` and $x^2$ math.\n\n- one\n- two\n\n> quote line\n\n```python\nx = 1\n```\n\n$$\n\\frac{200}{10}\n$$\n\nLast paragraph.";
  // the heading shown in the body too (by default a leading heading that is the title is hidden there: noteTitleHeadingHiddenInBody)
  const h = await open({ board: board([doc]), light, settings: { noteHeadingInBody: true } });
  await h.page.waitForTimeout(1500);
  const geo = () => h.page.evaluate(() => {
    const card = document.querySelector('.card[data-id="n0"]')!, body = card.querySelector(".nbody")!, root = body.querySelector(".md-pm") ?? body;
    const top = card.getBoundingClientRect().top, p = root.querySelector("p")!;
    return {
      h: Math.round(card.getBoundingClientRect().height), ys: [...root.children].map((e) => Math.round(e.getBoundingClientRect().top - top)),
      sel: getComputedStyle(p, "::selection").backgroundColor, lig: getComputedStyle(p).fontVariantLigatures,
    };
  });
  const shown = await geo();
  await h.page.locator('.card[data-id="n0"] .nbody p').last().dblclick();
  await h.page.waitForSelector('.card[data-id="n0"] .md-pm', { timeout: 5000 });
  await h.page.mouse.move(5, 5);
  await h.page.waitForTimeout(300);
  const edit = await geo();
  check("noteEditKeepsLayout", JSON.stringify(shown) === JSON.stringify(edit) && shown.sel !== "rgba(0, 0, 0, 0)", { shown, edit });
  await close(h);
});

/** A leading heading that is the Note's title isn't shown again in the body (display only: the Markdown keeps it); editing shows it,
 *  sliding in without a jump; a title set by the user or the setting keeps it in the body */
test("noteTitleHeadingHiddenInBody", async () => {
  const doc = "# KV cache budget\n\nPrefill first, then decode.\n\nOne block per sequence.";
  const b = board([doc, doc]);
  (b.cards.find((c) => c.id === "n1") as NoteCard).title = "My own title";
  const h = await open({ board: b, light });
  await h.page.waitForTimeout(1200);
  const look = () => h.page.evaluate(() => [0, 1].map((i) => {
    const card = document.querySelector(`.card[data-id="n${i}"]`)!, head = card.querySelector(".nbody h1") as HTMLElement | null;
    return { title: card.querySelector(".chead .ctitle")!.textContent, h1: !!head && head.getBoundingClientRect().height > 0, h: Math.round(card.getBoundingClientRect().height) };
  }));
  const shown = await look();
  await shot(h, "note-heading-01-hidden");
  check("note-heading-hidden", shown[0].title === "KV cache budget" && !shown[0].h1 && shown[1].title === "My own title" && shown[1].h1 && md(h, "n0") === doc.trim(), shown);
  // enter editing: the heading is there to edit and slides in (card height grows in small steps, no jump)
  await h.page.evaluate(() => { const w = window as any; w.__hs = []; const card = document.querySelector('.card[data-id="n0"]')!; const t0 = performance.now();
    const f = () => { w.__hs.push(card.getBoundingClientRect().height); if (performance.now() - t0 < 1500) requestAnimationFrame(f); }; requestAnimationFrame(f); });
  await h.page.locator('.card[data-id="n0"] .nbody p').last().dblclick();
  await h.page.waitForSelector('.card[data-id="n0"] .md-pm h1', { timeout: 5000 });
  await h.page.waitForTimeout(80);
  await shot(h, "note-heading-02-editing");
  await h.page.waitForTimeout(1500);
  const hs: number[] = await h.page.evaluate(() => (window as any).__hs);
  const steps = hs.slice(1).map((v, i) => v - hs[i]), grow = hs[hs.length - 1] - hs[0], jump = Math.max(...steps);
  const edit = await h.page.evaluate(() => { const e = document.querySelector('.card[data-id="n0"] .md-pm h1') as HTMLElement | null; return { text: e?.textContent, op: e ? getComputedStyle(e).opacity : "" }; });
  check("note-heading-editable", edit.text === "KV cache budget" && edit.op === "1", edit);
  check("note-heading-slides-in", grow > 20 && jump < grow * 0.6, { grow, jump, frames: hs.length });
  // leave: hidden again, card back to its height
  await exitEdit(h); await h.page.waitForTimeout(600);
  const after = await look();
  check("note-heading-hidden-after-edit", !after[0].h1 && Math.abs(after[0].h - shown[0].h) <= 1 && md(h, "n0") === doc.trim(), { after, shown });
  await close(h);
  // Settings → Notes: keep the heading in the body
  const h2 = await open({ board: board([doc]), light, settings: { noteHeadingInBody: true } });
  await h2.page.waitForTimeout(1200);
  const kept = await h2.page.evaluate(() => (document.querySelector('.card[data-id="n0"] .nbody h1') as HTMLElement | null)?.getBoundingClientRect().height ?? 0);
  await shot(h2, "note-heading-03-setting-show");
  check("note-heading-setting-shows", kept > 0, { kept });
  await close(h2);
});

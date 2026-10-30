import type { Page } from "playwright-core";
import { put, shot, type Host } from "../harness";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import { test, open, check, light, until, idle, focusSettled, pmHasSelection } from "../fixtures";

// The Note editor keeps each paragraph's Markdown source as its text and only draws it: the markers show near the caret,
// moving the caret never changes the document, and selecting is the browser's own (nothing is laid out again while the
// mouse is down or a selection is being extended). Structure blocks have a small toolbar: code blocks a pill, tables a bar.

const close = (h: Host) => h.page.context().close();
const card = (id: string) => `.card[data-id="${id}"]`;

function board(init: string[]): Board {
  const b = emptyBoard("b1", "note source");
  init.forEach((md, i) => put(b, { id: `n${i}`, kind: "note", md, look: "note" } as NoteCard, 60 + (i % 2) * 620, 60 + Math.floor(i / 2) * 420, 560));
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}
const md = (h: Host, id: string) => ((h.board().cards.find((c) => c.id === id) as NoteCard | undefined)?.md ?? "").trim();
const layoutOf = (h: Host, id: string) => (h.board().cards.find((c) => c.id === id) as NoteCard | undefined)?.mdLayout;
async function editNote(h: Host, id: string) {
  await h.page.locator(`${card(id)} .nbody :is(p, td)`).last().dblclick();
  await h.page.locator(`${card(id)} .md-pm:focus`).waitFor();
  await focusSettled(h.page);
}
async function exitEdit(h: Host) {
  for (let k = 0; k < 3 && (await h.page.locator(".md-pm").count()); k++) { await h.page.keyboard.press("Escape"); await idle(h); }
}
/** The editor's document as Markdown-ish JSON (to see that it did not change), its selected text and selection */
const pm = (pg: Page) => pg.evaluate(() => {
  const e = (document.querySelector(".md-pm") as any).editor, s = e.state.selection;
  return { doc: JSON.stringify(e.state.doc.toJSON()), sel: e.state.doc.textBetween(s.from, s.to) as string, from: s.from as number, to: s.to as number, empty: s.empty as boolean };
});
/** Moves the caret with a key and waits until ProseMirror has it */
async function key(pg: Page, k: string) {
  await pmHasSelection(pg);
  await pg.keyboard.press(k);
  await pmHasSelection(pg);
}
/** The screen point of character i (its left edge + dx) of the text `word` inside the editor's element matching sel */
const charAt = (pg: Page, sel: string, word: string, i: number, dx = 1) => pg.evaluate(([sel, word, i, dx]) => {
  const root = document.querySelector(sel as string)!, walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const k = n.textContent!.indexOf(word as string);
    if (k < 0) continue;
    const r = document.createRange();
    r.setStart(n, k + (i as number)); r.setEnd(n, k + (i as number) + 1);
    const b = r.getBoundingClientRect();
    return { x: b.left + (dx as number), y: b.top + b.height / 2 };
  }
  return null;
}, [sel, word, i, dx] as const);
/** Where a word is drawn (to see that nothing is laid out again) */
const wordX = async (pg: Page, word: string) => (await charAt(pg, ".md-pm", word, 0, 0))?.x ?? null;
const visibleMarkers = (pg: Page) => pg.locator(".md-pm .md-mk:not(.md-hide)").count();

/** A drag that starts in the middle of a highlighted phrase selects from there: the markers don't show and nothing moves while
 *  the mouse is down, so the selection ends where the mouse is let go */
test("noteDragSelectFromHighlight", async () => {
  const h = await open({ board: board(["Plain start ==highlighted words here== and the tail of the line"]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  await key(pg, "Control+End");
  await idle(h);
  const from = (await charAt(pg, ".md-pm mark", "words", 0))!, to = (await charAt(pg, ".md-pm", "tail of", 4, 1))!;
  const tail0 = await wordX(pg, "tail");
  await pg.mouse.move(from.x, from.y);
  await pg.mouse.down();
  const moved: (number | null)[] = [], shown: number[] = [];
  for (let i = 1; i <= 8; i++) {
    await pg.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y);
    moved.push(await wordX(pg, "tail"));
    shown.push(await visibleMarkers(pg));
  }
  await pg.mouse.up();
  await pmHasSelection(pg);
  const s = await pm(pg);
  await shot(h, "noteDragSelectFromHighlight");
  check("noteDragSelectFromHighlight nothing moves while dragging", moved.every((x) => x === tail0) && shown.every((n) => n === 0), { tail0, moved, shown });
  // the selection is of the source: the hidden closing == lies between the press and the release
  check("noteDragSelectFromHighlight selects from the press to the release", s.sel === "words here== and the tail", s.sel);
  await exitEdit(h);
  check("noteDragSelectFromHighlight leaves the Markdown alone", md(h, "n0") === "Plain start ==highlighted words here== and the tail of the line", md(h, "n0"));
  await close(h);
});

/** Double-clicking a word in bold selects that word: the first click doesn't show the markers before the second lands */
test("noteDoubleClickSelectsWord", async () => {
  const h = await open({ board: board(["Some **bold words** in a line, then more words after it"]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  await key(pg, "Control+End");
  await idle(h);
  const at = (await charAt(pg, ".md-pm strong", "words", 2))!, x0 = await wordX(pg, "words");
  await pg.mouse.dblclick(at.x, at.y);
  await pmHasSelection(pg);
  const s = await pm(pg), x1 = await wordX(pg, "words"), shownNow = await visibleMarkers(pg);
  await shot(h, "noteDoubleClickSelectsWord");
  check("noteDoubleClickSelectsWord", s.sel === "words" && x1 === x0 && shownNow === 0, { s: s.sel, x0, x1, shownNow });
  // a single click in the bold shows its markers once the double-click time is over (on the other word: a click on the
  // same spot this soon would count as a third click)
  const other = (await charAt(pg, ".md-pm strong", "bold", 1))!;
  await pg.mouse.click(other.x, other.y);
  await pmHasSelection(pg);
  const shownAfter = await until(h, "the markers show after a single click", async () => (await visibleMarkers(pg)) === 2).then(() => true, () => false);
  check("noteDoubleClickSelectsWord single click shows the markers", shownAfter, await visibleMarkers(pg));
  await close(h);
});

/** ⇧← / ⇧→ step over hidden markers in one press, and a drawn formula counts as one character; plain arrows after a click
 *  first show the markers there and then move on that layout */
test("noteArrowsCrossHiddenMarkers", async () => {
  const src = "ab **cd** $x$ e";
  const h = await open({ board: board([src, "tail line"]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  await key(pg, "Control+Home");
  await key(pg, "Home");
  await idle(h);
  const sels: string[] = [];
  for (let i = 0; i < 9; i++) { await key(pg, "Shift+ArrowRight"); sels.push((await pm(pg)).sel); }
  await shot(h, "noteArrowsCrossHiddenMarkers");
  check("noteArrowsCrossHiddenMarkers shift", sels[3] === "ab **c" && sels[6] === "ab **cd** $x$" && sels[8] === src, sels);
  // back over them: from the end, ⇧← seven times; hidden markers go with the character next to them
  await key(pg, "End");
  await idle(h);
  const back: string[] = [];
  for (let i = 0; i < 7; i++) { await key(pg, "Shift+ArrowLeft"); back.push((await pm(pg)).sel); }
  check("noteArrowsCrossHiddenMarkers shift back", back[1] === " e" && back[2] === "$x$ e" && back[4] === "d** $x$ e" && back[6] === " **cd** $x$ e", back);
  await exitEdit(h);
  check("noteArrowsCrossHiddenMarkers unchanged", md(h, "n0") === src, md(h, "n0"));
  await close(h);
});

/** Moving the caret through formatted text (markers showing and hiding) never changes the document: one ⌘Z after moving
 *  around takes back the last typing, not a caret move */
test("noteCaretMovesNoUndo", async () => {
  const src = "A **bold** word, a [link](https://e.com) and $x^2$ math\n\n## Heading with `code`";
  const h = await open({ board: board([src]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  await key(pg, "Control+End");
  await pg.keyboard.type("!");
  await idle(h);
  const before = await pm(pg);
  for (const k of ["Control+Home", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "End", "ArrowLeft", "ArrowLeft", "ArrowDown", "Home", "ArrowRight", "ArrowUp"]) await key(pg, k);
  await idle(h);
  const after = await pm(pg);
  await pg.keyboard.press("ControlOrMeta+z");
  await idle(h);
  const undone = await pm(pg);
  await exitEdit(h);
  check("noteCaretMovesNoUndo document unchanged by moves", after.doc === before.doc, { before: before.doc.slice(0, 300), after: after.doc.slice(0, 300) });
  check("noteCaretMovesNoUndo one undo takes the typing back", md(h, "n0") === src && !undone.doc.includes("code`!"), md(h, "n0"));
  await close(h);
});

/** A code block's pill: language, copy, wrap (kept as the Note's layout, also in the static render) and a menu that turns the
 *  block into paragraphs or deletes it */
test("noteCodeBlockPill", async () => {
  const code = "```python\nvery_long_name = compute_something(with_a, rather_long, list_of, arguments, that_keeps_going, past_the_edge)\nx = 1\n```";
  const h = await open({ board: board([`Intro\n\n${code}\n\nafter`, `${code}`]), light });
  const pg = h.page;
  await idle(h);
  await pg.locator(`${card("n0")} .nbody p`).first().dblclick();
  await pg.locator(`${card("n0")} .md-pm:focus`).waitFor();
  const block = `${card("n0")} .md-pm .md-code`;
  await pg.locator(block).hover();
  const pill = `${block} .md-cbpill`;
  await pg.locator(pill).waitFor({ state: "visible" });
  const tips = await pg.locator(`${pill} .md-cbb`).evaluateAll((bs) => bs.map((b) => b.getAttribute("data-tip")));
  const lang = (await pg.locator(pill).innerText()).trim();
  // the demo's look: a 12px-round panel, 18 / 22px around 12.5px code on 1.7 lines, a 34px pill with a hair line after the language;
  // in Warm Ink the demo's number colour (the board's code cards keep theirs)
  await until(h, "the code is coloured", async () => (await pg.locator(`${block} .cm-content .num`).count()) > 0);
  const look = await pg.locator(block).evaluate((e) => {
    const s = getComputedStyle(e), p = e.querySelector(".md-cbpill")!, num = e.querySelector(".cm-content .num");
    return { radius: s.borderTopLeftRadius, pad: `${s.paddingTop} ${s.paddingLeft}`, font: s.fontSize, lh: s.lineHeight, pill: Math.round(p.getBoundingClientRect().height), sep: !!p.querySelector(".md-lang + .md-cbsep"), num: num ? getComputedStyle(num).color : null };
  });
  const h0 = await pg.locator(block).evaluate((e) => e.getBoundingClientRect().height);
  await pg.locator(`${pill} .md-cbb[data-tip="Wrap lines"]`).click();
  await until(h, "wrap turns on", async () => (await pg.locator(`${pill} .md-cbb.on[data-tip="Wrap lines"]`).count()) === 1);
  const h1 = await pg.locator(block).evaluate((e) => e.getBoundingClientRect().height);
  await shot(h, "noteCodeBlockPill-wrap");
  await exitEdit(h);
  await until(h, "the wrap is saved as layout", () => JSON.stringify(layoutOf(h, "n0")?.wrap) === "[0]");
  const staticWrap = await pg.locator(`${card("n0")} .nbody pre.md-code.wrap`).count();
  const mdAfterWrap = md(h, "n0");
  // ⋯ → Convert to paragraph on the second Note
  await pg.locator(`${card("n1")} .nbody`).dblclick();
  await pg.locator(`${card("n1")} .md-pm`).waitFor();
  await pg.locator(`${card("n1")} .md-code`).hover();
  await pg.locator(`${card("n1")} .md-cbb[data-tip="More"]`).click();
  const items = await pg.locator(".md-cbmenu button").allInnerTexts();
  await pg.locator(".md-cbmenu button", { hasText: "Convert to paragraph" }).click();
  await until(h, "the block became paragraphs", async () => (await pg.locator(`${card("n1")} .md-pm .md-code`).count()) === 0);
  await exitEdit(h);
  check("noteCodeBlockPill look", look.radius === "12px" && look.pad === "18px 22px" && look.font === "12.5px" && Math.abs(parseFloat(look.lh) - 21.25) < .5 && look.pill === 34 && look.sep
    && look.num === (light ? "rgb(163, 22, 107)" : "rgb(224, 140, 192)"), look);
  check("noteCodeBlockPill pill", lang.startsWith("Python") && JSON.stringify(tips) === JSON.stringify(["Copy code", "Wrap lines", "More"]), { lang, tips });
  check("noteCodeBlockPill wrap", h1 > h0 + 10 && staticWrap === 1 && mdAfterWrap === `Intro\n\n${code}\n\nafter`, { h0, h1, staticWrap, mdAfterWrap });
  check("noteCodeBlockPill menu", JSON.stringify(items.map((t) => t.trim())) === JSON.stringify(["Convert to paragraph", "Delete code block"]) && !md(h, "n1").includes("```") && md(h, "n1").includes("x = 1"), { items, md: md(h, "n1") });
  await close(h);
});

const TABLE = "| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |";
const cellText = (pg: Page, id: string) => pg.locator(`${card(id)} .md-pm table tr`).evaluateAll((rs) => rs.map((r) => [...r.children].map((c) => (c as HTMLElement).innerText.trim()).join(",")));
async function intoCell(h: Host, id: string, text: string) {
  await h.page.locator(`${card(id)} .md-pm :is(td, th)`, { hasText: new RegExp(`^${text}$`) }).click();
  await pmHasSelection(h.page);
  await key(h.page, "End");
}

/** The table bar above the table's top-right corner: rows, columns, alignment written as :-: and --:, and the size grid whose
 *  shrink preview marks the cells that would go in red */
test("noteTableToolbar", async () => {
  // the Note on the right: the bar (wider than this small table) has room to end at the table's right edge
  const h = await open({ board: board(["other note", `Before\n\n${TABLE}\n\nAfter`]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n1");
  await intoCell(h, "n1", "5");
  const bar = pg.locator(".md-tbar");
  await bar.waitFor({ state: "visible" });
  const pos = await pg.evaluate(() => {
    const b = document.querySelector(".md-tbar")!.getBoundingClientRect(), t = document.querySelector(".md-pm table")!.getBoundingClientRect();
    const right = Math.min(t.right, document.querySelector(".md-pm")!.getBoundingClientRect().right);
    return { above: b.bottom <= t.top + 1, right: Math.abs(b.right - right) <= 2, bar: [b.left, b.right, b.width], table: [t.left, t.right] };
  });
  const count0 = (await pg.locator(".md-tbar .md-tcount").innerText()).trim();
  await bar.locator('[data-act="colRight"]').click();
  await bar.locator('[data-act="rowBelow"]').click();
  await bar.locator('[data-act="center"]').click();
  const grown = await cellText(pg, "n1");
  await shot(h, "noteTableToolbar-bar");
  // its edge shows on a dark Note too: a 1px ring under the float shadow (the shadow's own .5px hair is lost there)
  const ring = await bar.evaluate((b) => getComputedStyle(b).boxShadow);
  check("noteTableToolbar outline visible", light || /^rgba\(255, 240, 220, 0\.15\) 0px 0px 0px 1px/.test(ring), ring);
  // the grid: pointing at 2 × 2 marks the cells with content outside it
  await bar.locator('[data-act="grid"]').click();
  await pg.locator(".md-gpick").waitFor({ state: "visible" });
  await pg.locator(".md-gpick .md-gc").nth(10 + 1).hover();
  await until(h, "the preview marks doomed cells", async () => (await pg.locator(".md-pm .md-doom").count()) > 0);
  const doomed = await pg.locator(".md-pm .md-doom").evaluateAll((cs) => cs.map((c) => (c as HTMLElement).innerText.trim()));
  const red = await pg.locator(".md-gpick .md-gc.doom").count();
  // red, not the amber of a warning: r high, g well below it (amber's g is close to r)
  const hue = await pg.locator(".md-pm .md-doom").first().evaluate((c) => getComputedStyle(c).backgroundColor.match(/[\d.]+/g)!.map(Number));
  const warn = (await pg.locator(".md-gpick .md-gp-warn").innerText()).trim();
  await shot(h, "noteTableToolbar-grid");
  check("noteTableToolbar grid preview cells that lose content are red", hue[0] > 150 && hue[1] < hue[0] * 0.5, hue);
  await pg.locator(".md-gpick .md-gc").nth(10 + 1).click();
  await until(h, "the table is 2 × 2", async () => (await pg.locator(".md-pm table tr").count()) === 2);
  const small = await cellText(pg, "n1");
  await exitEdit(h);
  const saved = md(h, "n1");
  check("noteTableToolbar placed above the top-right corner", pos.above && pos.right && count0 === "3×3", { pos, count0 });
  check("noteTableToolbar rows, columns, alignment", grown.length === 4 && grown[0].split(",").length === 4 && grown[2] === "4,5,,6", grown);
  check("noteTableToolbar grid preview", doomed.includes("c") && doomed.includes("6") && !doomed.includes("1") && red === doomed.length && /removed/.test(warn), { doomed, red, warn });
  check("noteTableToolbar shrink", JSON.stringify(small) === JSON.stringify(["a,b", "1,2"]) && /^Before\n\n\| a +\| b +\|\n/.test(saved) && saved.endsWith("After"), { small, saved });
  await close(h);
});

/** Table keys: ⌘↵ adds a row below, ⌘⇧↵ above, ⌘⇧⌫ deletes the row, Tab goes to the next cell, Enter down a row, ⇧↵ is a
 *  line break in the cell (saved as <br>); column alignment from the bar is written as :-: */
test("noteTableShortcuts", async () => {
  const h = await open({ board: board([TABLE]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  await intoCell(h, "n0", "1");
  // ⌘↵ / ⌘⇧↵ add a row below / above and leave the caret where it was (typing goes on in the same cell)
  await pg.keyboard.press("ControlOrMeta+Enter");
  await pg.keyboard.type("x");
  await pg.keyboard.press("ControlOrMeta+Shift+Enter");
  await pg.keyboard.type("y");
  const added = await cellText(pg, "n0");
  await pg.keyboard.press("ControlOrMeta+Shift+Backspace");
  const deleted = await cellText(pg, "n0");
  await intoCell(h, "n0", "4");
  await pg.keyboard.press("Tab");
  await key(pg, "End");
  await pg.keyboard.type("T");
  await pg.keyboard.press("Enter");
  await pg.keyboard.type("E");
  await intoCell(h, "n0", "6");
  await pg.keyboard.press("Shift+Enter");
  await pg.keyboard.type("two");
  await pg.locator('.md-tbar [data-act="center"]').click();
  await shot(h, "noteTableShortcuts");
  await exitEdit(h);
  const saved = md(h, "n0"), rows = saved.split("\n");
  check("noteTableShortcuts rows", JSON.stringify(added.slice(1)) === JSON.stringify([",,", "1xy,2,3", ",,", "4,5,6"]) && JSON.stringify(deleted.slice(1)) === JSON.stringify([",,", ",,", "4,5,6"]), { added, deleted });
  check("noteTableShortcuts saved", rows.length === 6 && /^:-+:$/.test(rows[1].split("|")[3].trim())
    && /\| *5T *\| *6<br>two *\|/.test(saved) && /\| *\| *E *\| *\|$/.test(saved), { saved });
  await close(h);
});

/** Column widths and row heights dragged in the editor: one undo step each, the caret stays where it was, kept as the Note's
 *  layout next to the Markdown (which doesn't change) and drawn the same in the static render */
/** The cursor the page shows at a point: that of the element under it */
const cursorAt = (pg: Page, x: number, y: number) => pg.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, [x, y] as const);
test("noteTableResizePersists", async () => {
  const h = await open({ board: board([TABLE]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  await intoCell(h, "n0", "5");
  const caret0 = (await pm(pg)).from;
  const th = (await pg.locator(`${card("n0")} .md-pm th`).first().boundingBox())!;
  const colW0 = th.width;
  const textCursor = await cursorAt(pg, th.x + th.width / 2, th.y + th.height / 2);
  // column: prosemirror-tables' handle at the cell's right edge
  await pg.mouse.move(th.x + th.width - 2, th.y + th.height / 2);
  await until(h, "the column handle shows", async () => (await pg.locator(`${card("n0")} .md-pm.resize-cursor, ${card("n0")} .md-pm .resize-cursor`).count()) > 0);
  const colCursor = await cursorAt(pg, th.x + th.width - 2, th.y + th.height / 2);
  await pg.mouse.down();
  for (let i = 1; i <= 6; i++) await pg.mouse.move(th.x + th.width - 2 + i * 10, th.y + th.height / 2);
  await pg.mouse.up();
  await until(h, "the column is wider", async () => ((await pg.locator(`${card("n0")} .md-pm th`).first().boundingBox())!.width) > colW0 + 40);
  // row: the bottom edge of the second row
  const tr = (await pg.locator(`${card("n0")} .md-pm tr`).nth(1).boundingBox())!;
  const rowH0 = tr.height;
  await pg.mouse.move(tr.x + tr.width / 2, tr.y + tr.height - 1);
  await until(h, "the row edge is marked", async () => (await pg.locator(`${card("n0")} .md-pm.md-row-resize`).count()) > 0);
  const rowCursor = await cursorAt(pg, tr.x + tr.width / 2, tr.y + tr.height - 1);
  await pg.mouse.down();
  for (let i = 1; i <= 5; i++) await pg.mouse.move(tr.x + tr.width / 2, tr.y + tr.height - 1 + i * 8);
  await pg.mouse.up();
  await until(h, "the row is taller", async () => ((await pg.locator(`${card("n0")} .md-pm tr`).nth(1).boundingBox())!.height) > rowH0 + 30);
  const caret1 = (await pm(pg)).from;
  const edit = await pg.evaluate(() => ({ col: document.querySelector(".md-pm th")!.getBoundingClientRect().width, row: document.querySelectorAll(".md-pm tr")[1].getBoundingClientRect().height }));
  // one undo per drag: the row, then the column
  await pg.keyboard.press("ControlOrMeta+z");
  await until(h, "undo takes the row back", async () => Math.abs(((await pg.locator(`${card("n0")} .md-pm tr`).nth(1).boundingBox())!.height) - rowH0) < 2);
  const colAfterOne = (await pg.locator(`${card("n0")} .md-pm th`).first().boundingBox())!.width;
  await pg.keyboard.press("ControlOrMeta+Shift+z");
  await until(h, "redo puts it back", async () => ((await pg.locator(`${card("n0")} .md-pm tr`).nth(1).boundingBox())!.height) > rowH0 + 30);
  await exitEdit(h);
  await until(h, "the layout is saved", () => !!layoutOf(h, "n0")?.tables?.[0]);
  const l = layoutOf(h, "n0")!.tables![0]!;
  const shown = await pg.evaluate(() => ({ col: document.querySelector(".nbody th")!.getBoundingClientRect().width, row: document.querySelectorAll(".nbody tr")[1].getBoundingClientRect().height }));
  await shot(h, "noteTableResizePersists");
  check("noteTableResizePersists resize cursors on the edges", colCursor === "col-resize" && rowCursor === "row-resize" && textCursor === "text", { colCursor, rowCursor, textCursor });
  check("noteTableResizePersists caret stays", caret1 === caret0, { caret0, caret1 });
  check("noteTableResizePersists one step each", colAfterOne > colW0 + 40, { colAfterOne, colW0 });
  check("noteTableResizePersists saved as layout", md(h, "n0") === TABLE && (l.cols?.[0] ?? 0) > colW0 + 40 && (l.rows?.[1] ?? 0) > rowH0 + 30, { md: md(h, "n0"), l });
  check("noteTableResizePersists same in the static render", Math.abs(shown.col - edit.col) <= 1 && Math.abs(shown.row - edit.row) <= 1, { shown, edit });
  // editing again starts from the saved layout
  await editNote(h, "n0");
  const again = await pg.evaluate(() => document.querySelector(".md-pm th")!.getBoundingClientRect().width);
  await exitEdit(h);
  check("noteTableResizePersists editing again", Math.abs(again - edit.col) <= 1, { again, edit });
  await close(h);
});

/** A long image address folds to its head and tail while the caret is in it, the image shows under its source; Expand shows
 *  the whole address; clicking the drawn image puts the caret in its source */
test("noteImageFold", async () => {
  const url = "https://example.com/some/very/long/path/to/an/image/file/that/goes/on/and/on/picture.png";
  const h = await open({ board: board([`Text before\n\n![a cat](${url})\n\nText after`]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  const img = pg.locator(`${card("n0")} .md-pm .md-img:not(.below) img`);
  await img.waitFor();
  await img.click();
  await until(h, "the source opens with the image under it", async () => (await pg.locator(`${card("n0")} .md-pm .md-img.below`).count()) === 1);
  const caret = await pm(pg);
  const folded = await pg.evaluate(() => {
    const p = [...document.querySelectorAll(".md-pm p")].find((e) => e.textContent!.includes("![a cat]")) as HTMLElement;
    return { text: p.innerText.split("\n")[0], ell: p.querySelectorAll(".md-ell").length, btn: (p.querySelector(".md-fold") as HTMLElement | null)?.innerText.trim() ?? "" };
  });
  await shot(h, "noteImageFold-folded");
  await pg.locator(`${card("n0")} .md-pm .md-fold`).click();
  await until(h, "the address expands", async () => (await pg.locator(`${card("n0")} .md-pm .md-ell`).count()) === 0);
  const expanded = await pg.evaluate(() => ([...document.querySelectorAll(".md-pm p")].find((e) => e.textContent!.includes("![a cat]")) as HTMLElement).innerText.split("\n")[0]);
  await shot(h, "noteImageFold-expanded");
  await exitEdit(h);
  check("noteImageFold caret in the source", caret.empty && caret.from > 0, caret);
  check("noteImageFold folded", folded.ell === 1 && folded.text.includes("https://example.com/s") && folded.text.includes("icture.png") && !folded.text.includes("/goes/on/") && folded.btn === "Expand", folded);
  check("noteImageFold expanded", expanded.includes(url), expanded);
  check("noteImageFold unchanged", md(h, "n0") === `Text before\n\n![a cat](${url})\n\nText after`, md(h, "n0"));
  await close(h);
});

/** ⇧↵ in a table cell is a line break inside the cell (saved as <br>, the table stays one table) */
test("noteCellShiftEnter", async () => {
  const h = await open({ board: board([TABLE]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  await intoCell(h, "n0", "6");
  await pg.keyboard.press("Shift+Enter");
  await pg.keyboard.type("seven");
  const lines = await pg.locator(`${card("n0")} .md-pm td`).last().evaluate((e) => (e as HTMLElement).innerText.split("\n").map((s) => s.trim()).filter(Boolean));
  const rows = await pg.locator(`${card("n0")} .md-pm tr`).count();
  // the line break is the cell's own source text, not a node
  const cellSrc = await pg.evaluate(() => { const e = (document.querySelector(".md-pm") as any).editor; let t = ""; e.state.doc.descendants((n: any) => { if (n.type.name === "tableCell") t = n.textContent; }); return t as string; });
  await exitEdit(h);
  const saved = md(h, "n0");
  const shownLines = await pg.locator(`${card("n0")} .nbody td`).last().evaluate((e) => (e as HTMLElement).innerText.split("\n").map((s) => s.trim()).filter(Boolean));
  check("noteCellShiftEnter source", cellSrc === "6<br>seven", cellSrc);
  check("noteCellShiftEnter", JSON.stringify(lines) === JSON.stringify(["6", "seven"]) && rows === 3 && /\| *6<br>seven *\|$/.test(saved) && JSON.stringify(shownLines) === JSON.stringify(["6", "seven"]), { lines, rows, saved, shownLines });
  await close(h);
});

/** ⌘/ (or the M↓ button in the card header) shows the whole Note as Markdown in a code editor with the caret at the same
 *  place, and back; one ⌘Z takes the whole source edit back; table widths survive the round trip */
test("noteSourceModeRoundTrip", async () => {
  const src = "# Title\n\nSome **bold** text here\n\n| a | b |\n| - | - |\n| 1 | 2 |";
  const b = board([src]);
  (b.cards[0] as NoteCard).mdLayout = { tables: [{ cols: [180, null] }] };
  const h = await open({ board: b, light });
  const pg = h.page;
  await idle(h);
  // into the paragraph (with the caret in the table its bar would sit over the line above it)
  await pg.locator(`${card("n0")} .nbody p`).first().dblclick();
  await pg.locator(`${card("n0")} .md-pm:focus`).waitFor();
  await focusSettled(pg);
  // the caret before "text"
  const at = (await charAt(pg, ".md-pm", "text here", 0, 1))!;
  await pg.mouse.click(at.x, at.y);
  await pmHasSelection(pg);
  const toggle = pg.locator(`${card("n0")} .chead .mdsrc`);
  await toggle.waitFor({ state: "visible" });
  const tip = { tip: await toggle.getAttribute("data-tip"), kbd: await toggle.getAttribute("data-kbd"), text: (await toggle.innerText()).trim() };
  await pg.keyboard.press("ControlOrMeta+/");
  const cm = `${card("n0")} .md-srcmode .cm-content`;
  await pg.locator(cm).waitFor();
  await until(h, "the toggle shows pressed", async () => (await toggle.getAttribute("aria-pressed")) === "true");
  await pg.keyboard.type("NEW ");
  const srcText = await pg.evaluate((q) => [...document.querySelectorAll(`${q} .cm-line`)].map((l) => l.textContent).join("\n"), cm);
  await shot(h, "noteSourceModeRoundTrip-source");
  await toggle.click();
  await pg.locator(`${card("n0")} .md-pm:focus`).waitFor();
  await pmHasSelection(pg);
  const back = await pm(pg);
  const backText = await pg.evaluate(() => { const e = (document.querySelector(".md-pm") as any).editor, s = e.state.selection; return e.state.doc.textBetween(s.from, Math.min(s.from + 4, e.state.doc.content.size)) as string; });
  const col = await pg.evaluate(() => Math.round(document.querySelector(".md-pm th")!.getBoundingClientRect().width));
  await pg.keyboard.press("ControlOrMeta+z");
  await idle(h);
  const undone = await pg.evaluate(() => (document.querySelector(".md-pm") as any).editor.state.doc.textContent as string);
  await pg.keyboard.press("ControlOrMeta+Shift+z");
  await exitEdit(h);
  const saved = md(h, "n0");
  check("noteSourceModeRoundTrip toggle", tip.tip === "Markdown Source" && /\/$/.test(tip.kbd ?? "") && tip.text === "M↓", tip);
  check("noteSourceModeRoundTrip caret into the source", srcText.includes("Some **bold** NEW text here"), srcText);
  check("noteSourceModeRoundTrip caret back", back.empty && backText === "text", { back, backText });
  check("noteSourceModeRoundTrip one undo", !undone.includes("NEW") && undone.includes("Some **bold** text here"), undone);
  check("noteSourceModeRoundTrip saved with layout", saved.startsWith("# Title\n\nSome **bold** NEW text here\n\n| a") && layoutOf(h, "n0")?.tables?.[0]?.cols?.[0] === 180 && Math.abs(col - 180) <= 1, { saved, layout: layoutOf(h, "n0"), col });
  await close(h);
});

/** Enter and Backspace (joining paragraphs) in a 200-paragraph Note cost about what they cost in a short one: nothing on the
 *  page restyles every block of the Note when one is inserted or removed (each key's time: keydown to the frame after it) */
test("noteLongNoteKeysScale", async () => {
  const para = (i: number) => `Para ${i}: the SM also has ==registers==, **shared memory**, \`code ${i}\` and $x_{${i}} = ${i}$, *italic* and [a link](https://example.com/${i}), long enough to wrap onto a second line of the Note.`;
  const long = Array.from({ length: 200 }, (_, i) => para(i + 1)).join("\n\n"), short = Array.from({ length: 6 }, (_, i) => para(i + 1)).join("\n\n");
  const h = await open({ board: board([long, short]), light, w: 1400, h: 900 });
  const pg = h.page;
  await idle(h);
  await pg.evaluate(() => {
    const w = window as any; w.__lat = [];
    document.addEventListener("keydown", () => { const t = performance.now(); requestAnimationFrame(() => setTimeout(() => w.__lat.push(performance.now() - t), 0)); }, true);
  });
  const timed = async (id: string, at: string) => {
    await h.page.locator(`${card(id)} .nbody p`).first().dblclick();
    await pg.locator(`${card(id)} .md-pm:focus`).waitFor();
    await focusSettled(pg);
    await pg.evaluate((at) => {
      const e = (document.querySelector(".md-pm") as any).editor; let p = -1;
      e.state.doc.descendants((n: any, pos: number) => { if (p < 0 && n.isText && n.text.startsWith(at)) p = pos + at.length; return p < 0; });
      e.commands.setTextSelection(p);
    }, at);
    const out: Record<string, number> = {};
    for (const [k, n] of [["Enter", 7], ["Backspace", 7]] as const) {
      await pg.evaluate(() => { (window as any).__lat = []; });
      for (let i = 0; i < n; i++) {
        await pg.keyboard.press(k);
        await pg.waitForFunction((i) => (window as any).__lat.length > i, i);
      }
      const l = await pg.evaluate(() => ((window as any).__lat as number[]).slice(1).sort((a, b) => a - b));
      out[k] = +l[Math.floor(l.length / 2)].toFixed(1);
    }
    // MathML (KaTeX's default) turns on Chrome's MathML stylesheet, whose :nth-child rules restyle all later blocks on each insert
    out.mathml = await pg.locator(".md-pm math").count();
    await exitEdit(h);
    return out;
  };
  const s = await timed("n1", "Para 3: the SM"), l = await timed("n0", "Para 100: the SM");
  // a few ms of noise on a fast machine is not a regression: compare with at least 12 ms
  const ok = (k: "Enter" | "Backspace") => l[k] <= 3 * Math.max(s[k], 12);
  check("noteLongNoteKeysScale", ok("Enter") && ok("Backspace"), { short: s, long: l });
  check("noteLongNoteKeysScale no MathML in the editor", l.mathml === 0, l.mathml);
  await close(h);
});

/** A web image shows at its natural size up to the column width, no taller than 340px; a width the user set wins; one that
 *  fails to load is a quiet line naming it, in the static view and in the editor */
test("noteImageSizing", async () => {
  const svg = (w: number, hh: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hh}"><rect width="100%" height="100%" fill="#8ab"/></svg>`;
  const src = "Small ![s](https://img.test/small.svg)\n\n![big](https://img.test/big.svg)\n\n![tall](https://img.test/tall.svg){width=50%}\n\n![a broken one](https://img.invalid/gone.png)\n\nend";
  const h = await open({ board: board([src]), light, h: 1500, beforeLoad: async (p) => {
    await p.route("https://img.test/**", (r) => r.fulfill({ contentType: "image/svg+xml", body: r.request().url().includes("small") ? svg(80, 40) : r.request().url().includes("big") ? svg(1600, 1200) : svg(400, 1000) }));
  } });
  const pg = h.page, body = `${card("n0")} .nbody`;
  await until(h, "the images decode", () => pg.evaluate((b) => [...document.querySelectorAll<HTMLImageElement>(`${b} img`)].filter((i) => i.complete && i.naturalWidth).length === 3, body));
  await until(h, "the broken image is a placeholder", async () => (await pg.locator(`${body} .md-imgerr`).count()) === 1);
  const sizes = (root: string) => pg.evaluate((root) => {
    const col = [...document.querySelectorAll(`${root} p`)].at(-1)!.getBoundingClientRect().width; // the text column
    const box = (alt: string) => { const r = document.querySelector(`${root} img[alt="${alt}"]`)!.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; };
    const err = document.querySelector(`${root} .md-imgerr`) as HTMLElement | null;
    return { col: Math.round(col), small: box("s"), big: box("big"), tall: box("tall"), err: err?.innerText.trim() ?? null, errH: err ? Math.round(err.getBoundingClientRect().height) : 0 };
  }, root);
  const stat = await sizes(body);
  await shot(h, "noteImageSizing-static");
  const ok = (s: typeof stat) => s.small[0] === 80 && s.small[1] === 40 && s.big[1] <= 341 && s.big[0] <= s.col && Math.abs(s.big[0] / s.big[1] - 4 / 3) < 0.02
    && Math.abs(s.tall[0] - s.col / 2) <= 3 && s.tall[1] > 341 && s.err === "Image failed to load · a broken one" && s.errH < 40;
  check("noteImageSizing static: natural size, capped height, the set width, a placeholder", ok(stat), stat);
  await pg.locator(`${body} p`, { hasText: "end" }).dblclick();
  await pg.locator(`${card("n0")} .md-pm:focus`).waitFor();
  await focusSettled(pg);
  const root = `${card("n0")} .md-pm`;
  await until(h, "the editor's images decode", () => pg.evaluate((b) => [...document.querySelectorAll<HTMLImageElement>(`${b} img`)].filter((i) => i.complete && i.naturalWidth).length === 3, root));
  await until(h, "the editor's broken image is a placeholder", async () => (await pg.locator(`${root} .md-imgerr`).count()) === 1);
  const edit = await sizes(root);
  await shot(h, "noteImageSizing-edit");
  check("noteImageSizing editor: the same sizes and placeholder", ok(edit), edit);
  await exitEdit(h);
  await close(h);
});

/** $$…$$ inside a paragraph or a cell is a display formula: centred on a line of its own, the same in the static view and the editor */
test("noteInlineDisplayMath", async () => {
  const h = await open({ board: board(["before $$\\sum_i x_i$$ after\n\n| a |\n| - |\n| x $$y^2$$ z |\n\nend"]), light });
  const pg = h.page;
  await idle(h);
  const look = (root: string) => pg.evaluate((root) => [...document.querySelectorAll(`${root} .md-dmath`)].map((d) => {
    const box = d.getBoundingClientRect(), k = d.querySelector(".katex")!.getBoundingClientRect(), line = (d.closest("p, td, th") as HTMLElement).getBoundingClientRect();
    return { display: getComputedStyle(d).display, wide: Math.round(box.width - line.width) >= -24, centre: Math.round(k.left + k.width / 2 - (box.left + box.width / 2)), shown: !!d.querySelector(".katex-display") };
  }), root);
  const stat = await look(`${card("n0")} .nbody`);
  await shot(h, "noteInlineDisplayMath-static");
  const ok = (ls: typeof stat) => ls.length === 2 && ls.every((l) => l.display === "block" && l.wide && Math.abs(l.centre) <= 2 && l.shown);
  check("noteInlineDisplayMath static centred on its own line", ok(stat), stat);
  await pg.locator(`${card("n0")} .nbody p`).last().dblclick();
  await pg.locator(`${card("n0")} .md-pm:focus`).waitFor();
  await focusSettled(pg);
  const edit = await look(`${card("n0")} .md-pm`);
  await shot(h, "noteInlineDisplayMath-edit");
  check("noteInlineDisplayMath editor centred on its own line", ok(edit), edit);
  await exitEdit(h);
  await close(h);
});

/** Esc with a popup of the editor open (the table's size grid, a code block's language list or ⋯ menu) closes only that popup:
 *  the Note stays in edit mode, and the next Esc leaves it */
test("noteEscClosesPopupOnly", async () => {
  const h = await open({ board: board([`${TABLE}\n\n\`\`\`python\nx = 1\n\`\`\`\n\nend`]), light });
  const pg = h.page;
  await idle(h);
  await editNote(h, "n0");
  const editing = () => pg.locator(`${card("n0")} .md-pm`).count();
  const res: Record<string, unknown> = {};
  await intoCell(h, "n0", "5");
  await pg.locator('.md-tbar [data-act="grid"]').click();
  await pg.locator(".md-gpick").waitFor({ state: "visible" });
  await pg.keyboard.press("Escape");
  await idle(h);
  res.grid = { open: await pg.locator(".md-gpick").count(), editing: await editing() };
  const block = `${card("n0")} .md-pm .md-code`;
  await pg.locator(`${block} .cm-content`).click();
  await pg.locator(`${block} .md-lang`).click();
  await pg.locator(".md-langbox .md-langq").waitFor();
  await pg.keyboard.press("Escape");
  await idle(h);
  res.lang = { open: await pg.locator(".md-langbox").count(), editing: await editing() };
  await pg.locator(block).hover();
  await pg.locator(`${block} .md-cbb[data-tip="More"]`).click();
  await pg.locator(".md-cbmenu").waitFor();
  await pg.keyboard.press("Escape");
  await idle(h);
  res.more = { open: await pg.locator(".md-cbmenu").count(), editing: await editing() };
  await pg.keyboard.press("Escape");
  await idle(h);
  res.after = await editing();
  check("noteEscClosesPopupOnly", JSON.stringify(res) === JSON.stringify({ grid: { open: 0, editing: 1 }, lang: { open: 0, editing: 1 }, more: { open: 0, editing: 1 }, after: 0 }), res);
  await close(h);
});

/** ⌘/ source mode colours the Markdown lightly (headings bold with "##" dimmed, markers, table pipes and fences dimmed, code,
 *  math and link text in colour), tints the caret's line, and wraps long lines between words, never inside one */
test("noteSourceModeLook", async () => {
  const words = "occupancy depends on registers shared memory thread block slots and thread slots which are divided dynamically between resident threads".split(" ");
  const src = `## Heading\n\n${words.join(" ")} with $x^2$ and [a link](https://example.com)\n\n| a | b |\n| - | - |\n| 1 | \`c\` |\n\n\`\`\`python\nx = 1\n\`\`\`\n\n$$\ny = 2\n$$`;
  const h = await open({ board: board([src]), light });
  const pg = h.page;
  await idle(h);
  await pg.locator(`${card("n0")} .nbody p`).first().dblclick();
  await pg.locator(`${card("n0")} .md-pm:focus`).waitFor();
  await focusSettled(pg);
  await pg.keyboard.press("ControlOrMeta+/");
  const cm = `${card("n0")} .md-srcmode .cm-content`;
  await pg.locator(cm).waitFor();
  await idle(h);
  const r = await pg.evaluate((cm) => {
    const root = document.querySelector(cm)!, all = (c: string) => [...root.querySelectorAll(`.md-s-${c}`)].map((e) => e.textContent);
    // where each line box of the long paragraph line starts: the character before it must be a space
    const line = [...root.querySelectorAll(".cm-line")].find((l) => l.textContent!.startsWith("occupancy"))!;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT), chars: { c: string; top: number }[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) for (let i = 0; i < n.textContent!.length; i++) {
      const rg = document.createRange(); rg.setStart(n, i); rg.setEnd(n, i + 1);
      const b = rg.getClientRects()[0]; if (b) chars.push({ c: n.textContent![i], top: Math.round(b.top) });
    }
    const breaks: string[] = [];
    for (let i = 1; i < chars.length; i++) if (chars[i].top > chars[i - 1].top + 4) breaks.push(chars[i - 1].c + "|" + chars[i].c);
    const active = root.querySelector(".cm-activeLine");
    return { mk: all("mk"), h: all("h"), code: all("code"), math: all("math"), link: all("link"), breaks, active: active ? getComputedStyle(active).backgroundColor : null };
  }, cm);
  await shot(h, "noteSourceModeLook");
  await pg.keyboard.press("ControlOrMeta+/");
  await exitEdit(h);
  check("noteSourceModeLook colours", r.mk.includes("## ") && r.h.includes("Heading") && r.mk.includes("|") && r.mk.some((m) => /^\| -+ \| -+ \|$/.test(m ?? "")) && r.mk.includes("```python") && r.mk.includes("$$")
    && r.code.includes("x = 1") && r.code.includes("c") && r.math.includes("$x^2$") && r.math.includes("y = 2") && r.link.includes("a link"), r);
  check("noteSourceModeLook wraps between words", r.breaks.length > 0 && r.breaks.every((b) => b.startsWith(" |")), r.breaks);
  check("noteSourceModeLook tints the caret's line", !!r.active && r.active !== "rgba(0, 0, 0, 0)", r.active);
  await close(h);
});

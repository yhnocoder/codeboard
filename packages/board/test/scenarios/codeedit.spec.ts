// 编辑代码（CodeMirror）：Free code 卡进出编辑时字、行号、颜色的位置一点不动（所有主题、亮暗）；打字、缩进、注释、保存；
// 语言服务（宿主是假的）：补全菜单、签名提示、悬停、虚拟文档的消息；Note 里的代码块编辑时也和显示时一样。
// LOOKS=warm-ink,graphite 只看这几个主题；SHOTS_DIR=… 存截图
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type Board, type NoteCard } from "@codeboard/core";
import type { Page } from "playwright-core";
import { put, OUT, type Host, type OnMsg } from "../harness";
import { test, open, check, light, until, idle } from "../fixtures";

const close = (h: Host) => h.page.context().close();
const CODE = ["def f(x):", "    y = x + 1  # one", "    return y", "", "print(f(2))"];

function freeBoard(): Board {
  const b = emptyBoard("b1", "free");
  b.cards.push({ id: "c1", kind: "code", segments: [{ id: "s1", src: { kind: "free" }, path: "", lang: "python", start: 1, end: CODE.length, text: CODE.slice(), version: { kind: "none" } }] } as any);
  b.place.c1 = { x: 80, y: 80, w: 480 };
  b.cam = { x: 0, y: 0, z: 1 };
  return b;
}

/** 卡上每个字的位置和颜色（每行一组）、行号的字的位置、卡片大小 */
const geo = (pg: Page, card: string, lineSel: string, noSel: string) => pg.evaluate(([card, lineSel, noSel]) => {
  const root = document.querySelector(`.card[data-id="${card}"]`)!;
  const glyphs = (el: Element) => {
    const out: (string | number)[][] = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) for (let i = 0; i < t.textContent!.length; i++) {
      if (!/\S/.test(t.textContent![i]) || t.textContent![i] === "\u200b") continue;
      const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1);
      const b = r.getBoundingClientRect();
      const cs = getComputedStyle(t.parentElement!);
      out.push([Math.round(b.x * 2) / 2, Math.round(b.y * 2) / 2, cs.color, cs.fontWeight, cs.fontStyle]);
    }
    return out;
  };
  const visible = (e: Element) => getComputedStyle(e).visibility !== "hidden" && (e as HTMLElement).offsetParent !== null && /\S/.test(e.textContent ?? "");
  const cb = root.getBoundingClientRect();
  return {
    lines: [...root.querySelectorAll(lineSel)].map(glyphs),
    nos: [...root.querySelectorAll(noSel)].filter(visible).map((n) => glyphs(n).map((g) => g.slice(0, 2))),
    size: [Math.round(cb.width), Math.round(cb.height)],
    cur: root.querySelectorAll(".cm-activeLine").length,
  };
}, [card, lineSel, noSel] as const);
const SHOW = [".src .l", ".gutter .no"] as const, EDIT = [".cm-line", ".cm-lineNumbers .cm-gutterElement"] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const firstDiff = (a: any, b: any) => { for (const k of ["lines", "nos", "size"]) if (!same(a[k], b[k])) return { k, a: JSON.stringify(a[k]).slice(0, 600), b: JSON.stringify(b[k]).slice(0, 600) }; return null; };
/** The board asked the host for signature help on a document like this (signature help re-asks SIG_MS = 60 ms after a change while open, packages/markdown/src/cm/lsp.ts; only waited on as state here) */
const askedSig = (h: Host, re: RegExp) => until(h, `signature help is asked for ${re}`, () => h.sent.some((m) => m.type === "lspSignature" && re.test((m as { text: string }).text)));
const text = (pg: Page) => pg.evaluate(() => [...document.querySelectorAll('.card[data-id="c1"] .cm-line')].map((l) => l.textContent).join("\n"));

async function save(h: Host, name: string) {
  const d = process.env.SHOTS_DIR;
  if (!d) return;
  fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`));
}
/** 一个元素周围的截图（留点边） */
async function clipShot(pg: Page, sel: string, pad = 24): Promise<Buffer> {
  const b = (await pg.locator(sel).first().boundingBox())!;
  return pg.screenshot({ clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + pad * 2, height: b.height + pad * 2 } });
}
/** 两张图并排（显示 | 编辑） */
async function sideBySide(pg: Page, a: Buffer, b: Buffer, la: string, lb: string, name: string) {
  const p2 = await (await pg.context().browser()!.newContext({ deviceScaleFactor: 1 })).newPage();
  const bg = await pg.evaluate(() => getComputedStyle(document.querySelector(".board") ?? document.body).backgroundColor);
  await p2.setContent(`<body style="margin:0;background:${bg};font:13px -apple-system,Segoe UI,sans-serif;color:#888"><div style="display:flex;gap:24px;padding:16px;align-items:flex-start">
    <figure style="margin:0"><figcaption style="margin-bottom:6px">${la}</figcaption><img src="data:image/png;base64,${a.toString("base64")}"></figure>
    <figure style="margin:0"><figcaption style="margin-bottom:6px">${lb}</figcaption><img src="data:image/png;base64,${b.toString("base64")}"></figure></div></body>`);
  await p2.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await p2.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  await p2.context().close();
}
const editing = async (pg: Page) => {
  try { await pg.waitForSelector('.card[data-id="c1"] .cm-content', { timeout: 8000 }); }
  catch (e) { console.log("DEBUG", await pg.evaluate(() => document.querySelector('.card[data-id="c1"]')?.outerHTML.slice(0, 1500))); throw e; }
};

/** 假的语言服务：补全给几个固定的、签名按逗号数算当前参数、悬停回一段 Markdown */
const lspStub: OnMsg = async (m, reply) => {
  if (m.type === "lspComplete") {
    await new Promise((r) => setTimeout(r, 30));
    await reply(m.req!, [
      { label: "range", kind: "class", detail: "class range" , doc: "range(stop) -> range object\n\nReturn an object that produces a sequence of integers." },
      { label: "repr", kind: "function", detail: "(obj: object, /) -> str" },
      { label: "reversed", kind: "class", detail: "class reversed" },
      { label: "round", kind: "function", detail: "(number, ndigits=None)" },
      { label: "raise", kind: "keyword" },
    ]);
    return true;
  }
  if (m.type === "lspSignature") {
    const line = m.text.split("\n")[m.line].slice(0, m.col);
    const open = line.lastIndexOf("range(");
    if (open < 0 || line.slice(open).includes(")")) { await reply(m.req!, null); return true; }
    const commas = (line.slice(open).match(/,/g) ?? []).length;
    const label = "range(start: SupportsIndex, stop: SupportsIndex, step: SupportsIndex = ...)";
    const p = (s: string) => { const i = label.indexOf(s); return { at: [i, i + s.length] as [number, number] }; };
    await reply(m.req!, { label, doc: "Return an object that produces a sequence of integers from start (inclusive) to stop (exclusive) by step.", params: [p("start: SupportsIndex"), p("stop: SupportsIndex"), p("step: SupportsIndex = ...")], active: Math.min(commas, 2) });
    return true;
  }
  if (m.type === "lspHover") {
    await reply(m.req!, ["```python\n(function) def print(*values: object, sep: str | None = \" \", end: str | None = \"\\n\") -> None\n```", "Prints the values to a stream, or to sys.stdout by default."]);
    return true;
  }
  return false;
};

async function looks() {
  const all: [string, boolean][] = [];
  for (const t of ["warm-ink", "graphite", "soft-light", "drafting", "colorful", "newspaper", "poster", "classic", "ink-wash", "city"]) for (const light of [true, false]) all.push([t, light]);
  const only = process.env.LOOKS ? all.filter(([t]) => process.env.LOOKS!.split(",").includes(t)) : all;
  for (const [theme, light] of only) {
    const h = await open({ board: freeBoard(), light, w: 1000, h: 700, settings: { theme } as any });
    const pg = h.page;
    await idle(h);
    const a = await geo(pg, "c1", ...SHOW);
    const shotA = theme === "warm-ink" && light ? await clipShot(pg, '.card[data-id="c1"]') : null;
    await pg.locator('.card[data-id="c1"] .src .l').nth(2).dblclick();
    await editing(pg);
    await idle(h);
    const b = await geo(pg, "c1", ...EDIT);
    const ok = same(a.lines, b.lines) && same(a.nos, b.nos) && same(a.size, b.size) && b.cur === 1;
    check(`codeedit ${theme} ${light ? "light" : "dark"} entering edit: same glyphs, colours, line numbers, size`, ok, ok ? { size: b.size, glyphs: b.lines.flat().length } : { diff: firstDiff(a, b), cur: b.cur });
    // 光标落在双击的那一行
    const curLine = await pg.evaluate(() => { const l = document.querySelector('.card[data-id="c1"] .cm-activeLine'); return l ? [...l.parentElement!.children].indexOf(l) : -1; });
    if (theme === "warm-ink") check(`codeedit ${light ? "light" : "dark"} caret on the double-clicked line`, curLine === 2, { curLine });
    // CodeMirror rewrites the editor's class attribute on focus: the package's classes must survive it (the .cbcm rules apply)
    if (theme === "warm-ink") {
      const cls = await pg.evaluate(() => document.querySelector('.card[data-id="c1"] .cm-editor')?.className ?? "");
      check(`codeedit ${light ? "light" : "dark"} focused editor keeps cbcm classes`, /\bcm-focused\b/.test(cls) && /\bcbcm\b/.test(cls) && /\bcbcm-card\b/.test(cls), { cls });
    }
    if (shotA) {
      await pg.mouse.move(900, 650);
      const shotB = await clipShot(pg, '.card[data-id="c1"]');
      await sideBySide(pg, shotA, shotB, "Displayed", "Editing (CodeMirror)", "pr9-1-display-vs-edit");
      await save(h, "pr9-1-display-vs-edit");
    }
    await pg.keyboard.press("Escape");
    await pg.waitForSelector('.card[data-id="c1"] .src .l');
    await idle(h);
    const c = await geo(pg, "c1", ...SHOW);
    const ok2 = same(a, c);
    check(`codeedit ${theme} ${light ? "light" : "dark"} leaving edit: back where it was`, ok2, ok2 ? {} : { diff: firstDiff(a, c) });
    await close(h);
  }
}

async function typing() {
  const h = await open({ board: freeBoard(), light: true, w: 1000, h: 700, settings: { theme: "warm-ink" } as any, on: lspStub });
  const pg = h.page;
  await idle(h);
  await pg.locator('.card[data-id="c1"] .src .l').nth(2).dblclick();
  await editing(pg);
  // 打字：新的一行很快就着色；回车保持缩进（: 结尾多一级）
  await pg.keyboard.press("Control+End");
  await pg.keyboard.press("Enter");
  await pg.keyboard.type("for i in range(", { delay: 15 });
  await pg.waitForSelector(".cbcm-sig", { timeout: 4000 });
  // 签名提示开着、刚打的字的补全还在问（看不见）：一次 Esc 关掉看得见的签名提示，不退出，提示也不会被还在路上的回复再打开
  await pg.keyboard.type("3");
  await pg.keyboard.press("Escape");
  // the signature help asked again after "3" and the completion still being asked must not reopen anything:
  // wait for that request to be sent, then idle waits until the host has answered everything
  await askedSig(h, /range\(3$/m);
  await idle(h);
  const stillEditing = await pg.locator('.card[data-id="c1"] .cm-content').count() === 1, sigClosed = await pg.locator(".cbcm-sig").count() === 0;
  await pg.keyboard.type("):");
  await pg.keyboard.press("End");
  await pg.keyboard.press("Enter");
  await pg.keyboard.type("pass");
  await until(h, "the typed lines are in the editor", async () => (await text(pg)).endsWith("\n    pass"));
  const v1 = await text(pg);
  const kws = () => pg.evaluate(() => [...document.querySelectorAll('.card[data-id="c1"] .cm-line')].slice(-2).map((l) => l.querySelectorAll("span.kw").length));
  // the highlighter parses in the background: the new lines are coloured soon after
  await until(h, "the new lines are highlighted", async () => (await kws()).every((n) => n > 0));
  const colored = await kws();
  // 选中两行 Tab / ⇧Tab；⌘/ 注释再取消
  await pg.keyboard.press("Control+End");
  await pg.keyboard.press("Shift+ArrowUp");
  await pg.keyboard.press("Shift+Home");
  await pg.keyboard.press("Shift+Home");
  await pg.keyboard.press("Tab");
  const v2 = await text(pg);
  await pg.keyboard.press("Shift+Tab");
  const v3 = await text(pg);
  await pg.keyboard.press("Control+/");
  const v4 = await text(pg);
  await pg.keyboard.press("Control+/");
  const v5 = await text(pg);
  const tail = (v: string) => v.split("\n").slice(-2).join("|");
  const ok = stillEditing && sigClosed && tail(v1) === "for i in range(3):|    pass" && colored.every((n) => n > 0)
    && tail(v2) === "    for i in range(3):|        pass" && tail(v3) === tail(v1) && tail(v4) === "# for i in range(3):|#     pass" && tail(v5) === tail(v1);
  check("codeedit typing: highlight, indent, Tab, comment, Esc closes popups first", ok, { stillEditing, sigClosed, v1: tail(v1), colored, v2: tail(v2), v3: tail(v3), v4: tail(v4), v5: tail(v5) });
  const doc = h.sent.filter((m) => m.type === "codeDoc") as any[];
  check("codeedit the host gets a virtual document for the card (python)", doc.length > 0 && doc[doc.length - 1].lang === "python" && doc[doc.length - 1].id === "free-c1", { n: doc.length, last: doc[doc.length - 1] && { id: doc[doc.length - 1].id, lang: doc[doc.length - 1].lang } });

  // 补全菜单：打 r 就问宿主，菜单画在卡旁边；Tab 接受
  await pg.keyboard.press("Control+End");
  await pg.keyboard.press("Enter");
  await pg.keyboard.press("Shift+Tab");
  await pg.keyboard.type("r");
  await pg.waitForSelector(".cbcm-ac li", { timeout: 4000 });
  const items = await pg.locator(".cbcm-ac li .cm-completionLabel").allTextContents();
  const asked = h.sent.filter((m) => m.type === "lspComplete").length;
  check("codeedit completion menu from the language service", items.length === 5 && items[0] === "range" && asked > 0, { items, asked });
  await idle(h);
  await pg.screenshot({ path: path.join(OUT, "pr9-2-completion.png") });
  await save(h, "pr9-2-completion");
  await pg.keyboard.press("Tab");
  await pg.keyboard.type("(1, ");
  await pg.waitForSelector(".cbcm-sig", { timeout: 4000 });
  // "," asks at once; the space re-asks 60 ms later only if the help was already open by then.
  // Once the ask after the comma is answered the help marks the active parameter
  await askedSig(h, /range\(1, ?$/m);
  await idle(h);
  const sig = await pg.evaluate(() => ({ l: document.querySelector(".cbcm-sig-l")?.textContent, b: document.querySelector(".cbcm-sig-l b")?.textContent }));
  const v6 = await text(pg);
  check("codeedit Tab accepts; signature help shows the active parameter", /\nrange\(1, $/.test(v6) && sig.b === "stop: SupportsIndex", { last: v6.split("\n").pop(), sig });
  await pg.screenshot({ path: path.join(OUT, "pr9-3-signature.png") });
  await save(h, "pr9-3-signature");
  await pg.keyboard.type("5)");
  await askedSig(h, /range\(1, 5\)$/m);
  await idle(h);
  const sigGone = await pg.locator(".cbcm-sig").count() === 0;
  check("codeedit signature help closes after )", sigGone, {});
  // 悬停
  const pr = pg.locator('.card[data-id="c1"] .cm-line', { hasText: "print(f(2))" });
  const pb = (await pr.boundingBox())!;
  await pg.mouse.move(pb.x + 12, pb.y + 10);
  await pg.waitForSelector(".cbcm-hover", { timeout: 4000 });
  const hov = await pg.locator(".cbcm-hover").textContent();
  check("codeedit hover from the language service", !!hov && /def print/.test(hov), { hov: hov?.slice(0, 80) });
  await idle(h);
  await pg.screenshot({ path: path.join(OUT, "pr9-3b-hover.png") });
  await save(h, "pr9-3b-hover");
  await pg.mouse.move(900, 650);
  await pg.keyboard.press("Escape");
  await until(h, "leaving the editor saves the code", () => (h.board().cards[0] as any).segments[0].text.join("\n").endsWith("range(1, 5)"));
  await idle(h);
  const saved = (h.board().cards[0] as any).segments[0].text.join("\n");
  check("codeedit saved; the virtual document is closed", saved === `${CODE.join("\n")}\nfor i in range(3):\n    pass\nrange(1, 5)` && h.sent.some((m) => m.type === "codeDocClose"), { saved: saved.split("\n").slice(-3) });

  await close(h);
}

async function note() {
  for (const light of [true, false]) {
    const b = emptyBoard("b1", "note");
    put(b, { id: "n0", kind: "note", md: "intro\n\n```python\ndef f(x):\n    return x + 1\n```\n\nend", look: "note" } as NoteCard, 60, 60, 520);
    b.cam = { x: 0, y: 0, z: 1 };
    const h = await open({ board: b, light, w: 1200, h: 800, on: lspStub });
    const pg = h.page;
    await idle(h);
    // the code's glyphs (the language label shown while editing is not code)
    const pos = () => pg.evaluate(() => {
      const pre = document.querySelector('.card[data-id="n0"] pre')!;
      const out: (number | string)[][] = [];
      const w = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t; t = w.nextNode()) if (!t.parentElement!.closest(".md-lang")) for (let i = 0; i < t.textContent!.length; i++) { if (!/\S/.test(t.textContent![i])) continue; const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + 1); const b = r.getBoundingClientRect(); out.push([Math.round(b.x * 2) / 2, Math.round(b.y * 2) / 2, getComputedStyle(t.parentElement!).color]); }
      const cs = getComputedStyle(pre), pb = pre.getBoundingClientRect();
      return { out, font: cs.font, pad: cs.padding, bg: cs.backgroundColor, box: [Math.round(pb.width), Math.round(pb.height)], cm: !!pre.querySelector(".cm-content") };
    });
    const a = await pos();
    const shotA = light ? await clipShot(pg, '.card[data-id="n0"]', 12) : null;
    await pg.locator('.card[data-id="n0"] .nbody').dblclick({ position: { x: 10, y: 8 } });
    await pg.waitForSelector('.card[data-id="n0"] .md-pm pre .cm-content', { timeout: 8000 });
    await idle(h);
    const c = await pos();
    const ok = same(a.out, c.out) && a.font === c.font && a.bg === c.bg && same(a.box, c.box) && c.cm;
    check(`codeedit Note code block ${light ? "light" : "dark"}: CodeMirror, same glyphs and colours`, ok, ok ? { glyphs: c.out.length } : { a: { ...a, out: JSON.stringify(a.out).slice(0, 400) }, c: { ...c, out: JSON.stringify(c.out).slice(0, 400) } });
    if (light) {
      // 点进代码块打字：写回 Markdown；方向键走出代码块
      const l = pg.locator('.card[data-id="n0"] .md-pm pre .cm-line', { hasText: "return x + 1" });
      const lb = (await l.boundingBox())!;
      await pg.mouse.click(lb.x + 60, lb.y + 8);
      await pg.mouse.move(1100, 700, { steps: 4 }); // 不停在代码上（悬停提示）
      await pg.locator('.card[data-id="n0"] pre .cm-editor.cm-focused').waitFor();
      await pg.keyboard.press("End");
      await pg.keyboard.type("  # add");
      await pg.keyboard.press("Enter");
      await pg.keyboard.type("r");
      await pg.waitForSelector(".cbcm-ac li", { timeout: 4000 });
      const items = await pg.locator(".cbcm-ac li").count();
      await pg.keyboard.press("Escape");
      // r、缩进（一次删一级）、换行
      for (let i = 0; i < 3; i++) await pg.keyboard.press("Backspace");
      await pg.mouse.move(1100, 700, { steps: 8 });
      await idle(h);
      const shotB = await clipShot(pg, '.card[data-id="n0"]', 12);
      if (shotA) { await sideBySide(pg, shotA, shotB, "Note · displayed", "Note · editing the code block", "pr9-4-note-code-block"); await save(h, "pr9-4-note-code-block"); }
      await pg.keyboard.press("ArrowDown");
      await pg.keyboard.type("!");
      await pg.keyboard.press("Escape");
      await until(h, "leaving the note saves it", () => ((h.board().cards[0] as NoteCard).md ?? "").includes("!end"));
      await idle(h);
      const md = ((h.board().cards[0] as NoteCard).md ?? "").trim();
      check("codeedit Note code block: edits write back, menu in the block, arrows leave it", md === "intro\n\n```python\ndef f(x):\n    return x + 1  # add\n```\n\n!end" && items > 0, { md, items });
    }
    await close(h);
  }
}

/** 折行的卡：长行折成几行，进出编辑也一样 */
async function wrapLook() {
  const b = freeBoard();
  const c = b.cards[0] as any;
  c.wrap = true;
  c.segments[0].text = ["def f(x):", "    return some_function_with_a_long_name(argument_one, argument_two, argument_three, argument_four) + x", "", "print(f(2))"];
  c.segments[0].end = 4;
  for (const light of [true, false]) {
    const h = await open({ board: b, light, w: 1000, h: 700 });
    const pg = h.page;
    await idle(h);
    const a = await geo(pg, "c1", ...SHOW);
    await pg.locator('.card[data-id="c1"] .src .l').nth(0).dblclick();
    await editing(pg);
    await idle(h);
    const e = await geo(pg, "c1", ...EDIT);
    const ok = same(a.lines, e.lines) && same(a.nos, e.nos) && same(a.size, e.size);
    check(`codeedit wrapped card ${light ? "light" : "dark"}: same glyphs entering edit`, ok, ok ? { size: e.size, rows: new Set(e.lines[1].map((g) => g[1])).size } : { diff: firstDiff(a, e) });
    await close(h);
  }
}

/** 画布右键 New Code：空卡直接进编辑（CodeMirror 可能还没加载），马上就能打字 */
async function newCode() {
  const h = await open({ board: freeBoard(), light: true, w: 1000, h: 700, on: lspStub });
  const pg = h.page;
  await idle(h);
  await pg.mouse.click(300, 450, { button: "right" });
  await pg.locator(".ctx button", { hasText: /^New Code/ }).first().click();
  await pg.waitForSelector(".card .cm-content:focus", { timeout: 8000 });
  await pg.keyboard.type("import os", { delay: 20 });
  await idle(h);
  const st = await pg.evaluate(() => ({ cm: [...document.querySelectorAll(".card .cm-content")].map((e) => e.textContent), active: document.activeElement?.className, texts: document.querySelectorAll(".card.text").length }));
  check("codeedit New Code: an empty card is edited at once", st.cm.length === 1 && st.cm[0] === "import os" && st.texts === 0, st);
  await close(h);
}

/** 灰字补全（和 Note 一样走宿主的 complete）：停笔后光标后出现灰字，Tab 接受 */
async function ghost() {
  const h = await open({ board: freeBoard(), light: true, w: 1000, h: 700, host: { complete: true }, on: async (m, reply) => {
    if (m.type === "complete") { await reply(m.req!, /print\(f$/.test(m.before) && m.after === "" ? "(3))" : null); return true; }
    if (m.type === "lspComplete") { await reply(m.req!, []); return true; }
    return false;
  } });
  const pg = h.page;
  await idle(h);
  await pg.locator('.card[data-id="c1"] .src .l').nth(4).dblclick();
  await editing(pg);
  await pg.keyboard.press("Control+End");
  await pg.keyboard.press("Enter");
  await pg.keyboard.type("print(f");
  await pg.waitForSelector('.card[data-id="c1"] .md-ghost', { timeout: 3000 });
  const g = await pg.locator('.card[data-id="c1"] .md-ghost').textContent();
  await pg.screenshot({ path: path.join(OUT, "pr9-5-ghost.png") });
  await save(h, "pr9-5-ghost");
  await pg.keyboard.press("Tab");
  await idle(h);
  const last = (await text(pg)).split("\n").pop();
  const asked = h.sent.filter((m) => m.type === "complete") as any[];
  check("codeedit gray inline completion in code: shown after a pause, Tab accepts", g === "(3))" && last === "print(f(3))" && asked.length > 0, { g, last, before: asked[0]?.before.slice(-12) });
  await close(h);
}

test("codeedit", async () => {
  if (!process.env.ONLY || process.env.ONLY === "looks") { await looks(); await wrapLook(); }
  if (!process.env.ONLY || process.env.ONLY === "typing") await typing();
  if (!process.env.ONLY || process.env.ONLY === "note") await note();
  if (!process.env.ONLY || process.env.ONLY === "new") await newCode();
  if (!process.env.ONLY || process.env.ONLY === "ghost") await ghost();
});

// 一帧之内：编辑器自己处理一次按键（不算宿主）。量时间，单独跑（tiers.json 的 solo）
test("codeEditKeystrokeLatency", async () => {
  const h = await open({ board: freeBoard(), light: true, w: 1000, h: 700, settings: { theme: "warm-ink" } as any, on: lspStub });
  const pg = h.page;
  await idle(h);
  await pg.locator('.card[data-id="c1"] .src .l').nth(0).dblclick();
  await editing(pg);
  await pg.keyboard.press("Control+End");
  // 每次按键编辑器自己花的时间：插入一个字（含 CodeMirror 读 DOM、更新视图）到排版完，不等宿主
  const lat = await pg.evaluate(async () => {
    const el = document.querySelector('.card[data-id="c1"] .cm-content') as HTMLElement;
    const ts: number[] = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const t0 = performance.now();
      document.execCommand("insertText", false, "x");
      await Promise.resolve();
      el.getBoundingClientRect();
      ts.push(performance.now() - t0);
    }
    ts.sort((a, b) => a - b);
    return { p50: +ts[20].toFixed(2), p90: +ts[36].toFixed(2), max: +ts[39].toFixed(2) };
  });
  const typed = (await text(pg)).endsWith("x".repeat(40));
  check("codeEditKeystrokeLatency one keystroke in the editor (insert + layout) well inside a frame", typed && lat.p90 < 8, { typed, ...lat });
  await close(h);
});

// v0.2 questions, export and settings (wireframes 06, 08, 09): ? stickers with a written question, Mark Answered / Link Answer (✓),
// the Questions panel across boards, Copy as List, the welcome-back hint; the Export dialog, an offline HTML snapshot opened in Chromium,
// a Markdown export; the new settings rows.
// Usage: node packages/board/test/run-harness.mjs questions export settingsPage [--light]   screenshots: test-out/harness/{questions,export,settings}-*.png
// SHOTS_DIR=… also copies them there.
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, type Board, type BoardToHost, type CodeCard, type HostToBoard, type QuestionItem, type SegView } from "@codeboard/core";
import { open, shot, put, symCard, findSym, viewOf, OUT, REPO, type Host } from "./harness";
import { inlineFor, setMediaDir } from "../../../extensions/vscode/src/exports";

const light = process.argv.includes("--light");
const MEDIA = path.join(REPO, "extensions/vscode/media/board");
const wait = (h: Host, ms = 600) => h.page.waitForTimeout(ms);
async function shotPr(h: Host, name: string) {
  await shot(h, name);
  const d = process.env.SHOTS_DIR;
  if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`)); }
}
async function until(h: Host, f: () => unknown, ms = 6000) {
  for (let t = 0; t < ms && !f(); t += 200) await h.page.waitForTimeout(200);
}
const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; return s.start + s.text.findIndex((t) => re.test(t)); };
const run = async (name: string, f: (res: Record<string, unknown>) => Promise<boolean>) => {
  const res: Record<string, unknown> = {};
  let ok = false;
  try { ok = await f(res); } catch (e) { console.log("FAIL", name, (e as Error).message.split("\n")[0], JSON.stringify(res)); process.exit(1); }
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(res));
  if (!ok) process.exitCode = 1;
};

export const QUESTIONS: Record<string, () => Promise<void>> = {
  questions: () => run("questions", questions),
  export: () => run("export", exportScenario),
  settingsPage: () => run("settingsPage", settings),
};

const initOf = (b: Board, extra: Partial<Extract<HostToBoard, { type: "init" }>> = {}): HostToBoard => {
  const views: Record<string, SegView> = {};
  for (const k of b.cards) if (k.kind === "code") for (const sg of k.segments) views[sg.id] = viewOf(sg);
  return { type: "init", board: b, boards: [{ id: b.id, name: b.name, cards: b.cards.length }], views, stale: {}, host: { isMac: true, assetBase: "", target: true, settings: { theme: "warm-ink", hideOnNew: { blank: false }, studyScope: [], stickerDir: "", zoomOverview: 0.6, zoomMap: 0.25, dblClick: "text" } }, ...extra };
};

/** Right-click a code line and pick a line-menu item */
async function lineMenu(h: Host, card: string, line: number, label: string) {
  const page = h.page;
  await page.locator(`.card[data-id="${card}"] .gutter .no`, { hasText: new RegExp(`^${line}$`) }).first().evaluate((el) => (el as HTMLElement).click()); await wait(h, 200);
  const l = page.locator(`.card[data-id="${card}"] .gutter .no`, { hasText: new RegExp(`^${line}$`) }).first();
  const b = (await l.boundingBox())!;
  await page.mouse.click(b.x + b.width + 260, b.y + b.height / 2, { button: "right" }); await wait(h, 300);
  if (!(await page.locator(".ctx button", { hasText: label }).count())) { await page.locator(".ctx button", { hasText: /^Edit/ }).hover(); await wait(h, 300); }
  await page.locator(".ctx button", { hasText: label }).first().click(); await wait(h, 700);
}

async function questions(res: Record<string, unknown>) {
  const b = emptyBoard("bQ", "nano-vllm · Scheduler");
  const alloc = nv("BlockManager.allocate");
  put(b, alloc, 60, 80, 640);
  const note = { id: "nAns", kind: "note" as const, md: "**prefix caching 是一条链**\n\n每块的 hash 带上前一块的 h：block_manager 只认整条前缀，中间一块不同后面全不命中。", bg: true };
  b.cards.push(note); b.place[note.id] = { x: 760, y: 80, w: 360 };
  const other: QuestionItem[] = [
    { board: "bMR", boardName: "nano-vllm · ModelRunner", sticker: "k1", card: "c1", title: "ModelRunner.capture_cudagraph", file: "model_runner.py", line: 216, md: "CUDA graph 为什么只在 decode 用？", done: false },
    { board: "bMR", boardName: "nano-vllm · ModelRunner", sticker: "k2", card: "c2", title: "ModelRunner.prepare_prefill", file: "model_runner.py", line: 130, md: "prepare_prefill 里 cu_seqlens 是什么 shape？", done: false },
    { board: "bEP", boardName: "DeepEP", sticker: "k3", card: "c3", title: "intranode::dispatch", file: "intranode.cu", line: 88, md: "sm_id % 2 决定 sender，为什么？", done: true },
    { board: "bQ", boardName: "nano-vllm · Scheduler", sticker: "stale", md: "stale copy from disk (must be replaced by the live board)", done: false },
  ];
  const h = await open({ board: b, light, w: 1500, h: 900, on: (m, reply) => (m.type === "questions" ? (void reply(m.req!, other), true) : false) }), page = h.page;
  await page.keyboard.press("Shift+Digit1"); await wait(h, 800);
  const L1 = lineOf(alloc, /compute_hash/), L2 = lineOf(alloc, /block_id in self\.used_block_ids/);
  // 1. Right-click a line → Ask a Question: ? sticker on the line, the Markdown editor opens in the popover
  await lineMenu(h, alloc.id, L1, "Ask a Question");
  res.editor = await page.locator(".pop.k-question .ProseMirror").count();
  await page.keyboard.type("为什么 hash 要把前一块的 h 也算进去？`block_manager` 里 $h_i = f(h_{i-1})$");
  await wait(h, 300);
  await shotPr(h, "questions-1-edit");
  await page.keyboard.press("Escape"); await wait(h, 500);
  await until(h, () => h.board().stickers.some((s) => s.q?.md));
  const q1 = h.board().stickers.find((s) => s.q?.md)!;
  res.q1 = q1 && { at: q1.at, md: q1.q?.md };
  // 2. A second question on another line
  await page.keyboard.press("Escape"); await wait(h, 200);
  await lineMenu(h, alloc.id, L2, "Ask a Question");
  await page.keyboard.type("ref_count 什么时候减到 0？"); await page.keyboard.press("Escape"); await wait(h, 500);
  await until(h, () => h.board().stickers.filter((s) => s.q?.md).length === 2);
  res.headCount = await page.locator(`.card[data-id="${alloc.id}"] .qcount`).textContent().catch(() => "");
  // 3. Link Answer… → click the Note: resolved, the sticker becomes ✓
  await page.keyboard.press("Escape"); await wait(h, 200);
  await page.locator(`[data-sticker="${q1.id}"]`).first().click(); await wait(h, 500);
  await page.locator(".pop.k-question button", { hasText: "Link Answer…" }).click(); await wait(h, 300);
  await page.locator(`.card[data-id="${note.id}"]`).click({ position: { x: 180, y: 60 } }); await wait(h, 900);
  const r1 = h.board().stickers.find((s) => s.id === q1.id)?.q;
  res.answered = r1 && { done: r1.done, answer: r1.answer };
  res.check = await page.locator(`[data-sticker="${q1.id}"] .glyph`).first().evaluate((el) => el.querySelector("path")?.getAttribute("d") ?? "").catch(() => "");
  res.ansText = await page.locator(".pop.k-question .qans").textContent().catch(() => "");
  res.headCount2 = await page.locator(`.card[data-id="${alloc.id}"] .qcount`).textContent().catch(() => "");
  await shotPr(h, "questions-2-resolved");
  // 4. Questions panel: this board (live) + the host's other boards; Open / All
  await page.keyboard.press("Escape"); await wait(h, 200);
  await page.locator('.dock [aria-label="Questions"]').click(); await wait(h, 700);
  res.openRows = await page.locator(".qpanel .qrow").count();
  res.groups = await page.locator(".qpanel .qg").allTextContents();
  res.staleShown = await page.locator(".qpanel .qrow", { hasText: "stale copy" }).count();
  await shotPr(h, "questions-3-panel");
  await page.locator(".qpanel .qtabs button", { hasText: "All" }).click(); await wait(h, 300);
  res.allRows = await page.locator(".qpanel .qrow").count();
  // 5. Click a row on another board → host opens that board at the line, with the question
  await page.locator(".qpanel .qrow", { hasText: "cu_seqlens" }).click(); await wait(h, 300);
  res.openBoard = h.sent.filter((m) => m.type === "openBoard").at(-1);
  // a row on this board → select the card and open the question
  await page.locator(".qpanel .qrow", { hasText: "ref_count" }).click(); await wait(h, 900);
  res.popFromPanel = await page.locator(".pop.k-question .qtext").textContent().catch(() => "");
  // 6. Copy as List: a Markdown checklist, identifiers not escaped
  await page.locator(".qpanel .qtabs button", { hasText: "Open" }).click(); await wait(h, 200);
  await page.locator(".qpanel button", { hasText: "Copy as List" }).click(); await wait(h, 300);
  const copied = (h.sent.filter((m) => m.type === "copyText").at(-1) as Extract<BoardToHost, { type: "copyText" }> | undefined)?.text ?? "";
  res.copied = copied;
  // 7. Welcome back: the host says this board was last opened 5 days ago
  await page.locator('.qpanel [aria-label="Close Questions"]').click(); await wait(h, 200);
  await h.post(initOf(h.board(), { welcome: { days: 5, open: 1 } })); await wait(h, 900);
  res.welcome = await page.locator(".welcome").textContent().catch(() => "");
  await shotPr(h, "questions-4-welcome");
  await page.locator(".welcome button", { hasText: "Show" }).click(); await wait(h, 500);
  res.welcomePanel = await page.locator(".qpanel").count();
  const ok = res.editor === 1 && (res.q1 as { md?: string })?.md?.startsWith("为什么 hash") && (res.q1 as { at: { kind: string; line: number } }).at.kind === "line" && (res.q1 as { at: { line: number } }).at.line === L1
    && res.headCount === "? 2" && (res.answered as { done?: boolean; answer?: string })?.done === true && (res.answered as { answer?: string }).answer === note.id
    && String(res.check).startsWith("M16.125") && String(res.ansText).includes("prefix caching") && res.headCount2 === "? 1"
    && res.openRows === 3 && res.staleShown === 0 && res.allRows === 5 && (res.openBoard as { id?: string; sticker?: string })?.id === "bMR" && (res.openBoard as { sticker?: string }).sticker === "k2"
    && res.popFromPanel === "ref_count 什么时候减到 0？" && copied.includes(`- [ ] [BlockManager.allocate] ref_count 什么时候减到 0？ (block_manager.py:${L2})`) && copied.includes("## DeepEP") === false && copied.includes("## nano-vllm · ModelRunner") && !copied.includes("\\_")
    && String(res.welcome).includes("5 days ago") && String(res.welcome).includes("1 open question") && res.welcomePanel === 1;
  await page.context().browser()!.close();
  return !!ok;
}

/** nano-vllm Scheduler board: schedule (Start) → can_allocate, allocate (calls); can_allocate → Note; Section; sidenotes; a question */
function schedBoard() {
  const b = emptyBoard("bSch", "Scheduler");
  const sch = nv("Scheduler.schedule"), can = nv("BlockManager.can_allocate"), alloc = nv("BlockManager.allocate");
  put(b, sch, 60, 80, 640); put(b, can, 780, 80, 600); put(b, alloc, 780, 640, 600);
  b.place[sch.id].start = true;
  const note = { id: "nPC", kind: "note" as const, md: "## prefix caching\n\n`block_manager.can_allocate` 只认整条前缀：cost $O(n)$ per seq, see __init__.", bg: true };
  b.cards.push(note); b.place[note.id] = { x: 1460, y: 80, w: 380 };
  b.sections.push({ id: "secPC", title: "Prefix caching", x: 1430, y: 30, w: 440, h: 360 });
  b.place[note.id].section = "secPC";
  const s0 = sch.segments[0];
  b.links.push(
    { id: "lCan", from: { card: sch.id, seg: s0.id, line: lineOf(sch, /can_allocate\(/) }, to: { card: can.id }, call: { name: "can_allocate", col: 0 } },
    { id: "lAlloc", from: { card: sch.id, seg: s0.id, line: lineOf(sch, /\.allocate\(/) }, to: { card: alloc.id }, call: { name: "allocate", col: 0 } },
    { id: "lSee", from: { card: can.id }, to: { card: note.id }, label: "why" },
  );
  b.sidenotes.push({ id: "snA", kind: "text", at: { card: sch.id, seg: s0.id, lines: [lineOf(sch, /# prefill/), lineOf(sch, /# prefill/)] }, md: "先 prefill 再 decode" });
  b.sidenotes.push({ id: "snPriv", kind: "text", at: { card: sch.id }, md: "PRIVATE draft: ask Linda", boardOnly: true });
  b.stickers.push({ id: "kQ", icon: { pack: "builtin", name: "question" }, at: { kind: "line", card: can.id, seg: can.segments[0].id, line: lineOf(can, /compute_hash/) }, q: { md: "为什么 hash 要把前一块的 h 也算进去？" } });
  return { b, ids: { sch: sch.id, can: can.id, alloc: alloc.id, note: note.id } };
}

async function exportScenario(res: Record<string, unknown>) {
  setMediaDir(MEDIA);
  const { b, ids } = schedBoard();
  const files: Record<string, string> = {};
  const store = { assetsDir: () => path.join(OUT, "no-assets") } as unknown as Parameters<typeof inlineFor>[0];
  const h = await open({ board: b, light, w: 1500, h: 900, on: async (m, reply) => {
    if (m.type === "permalinks") { await reply(m.req!, Object.fromEntries(m.segs.filter((s) => s.src.kind === "repo").map((s) => [s.id, `https://github.com/GeeeekExplorer/nano-vllm/blob/bb823b3c0ffee/${s.path}#L${s.start}-L${s.end}`]))); return true; }
    if (m.type === "exportFile") {
      const text = m.kind === "html" ? await inlineFor(store, m.text) : m.text;
      const f = path.join(OUT, `export-${m.name.toLowerCase().replace(/\W+/g, "-")}.${m.kind}`);
      fs.writeFileSync(f, text); files[m.kind] = f;
      await reply(m.req!, true); return true;
    }
    return false;
  } }), page = h.page;
  await page.keyboard.press("Shift+Digit1"); await wait(h, 900);
  // 1. ⋯ → Export…: format, scope (Walkthrough A from the Start card), include, look, file
  await page.locator('.bbar [aria-label="More"]').click(); await wait(h, 300);
  await page.locator(".ctx button", { hasText: "Export…" }).click(); await wait(h, 500);
  res.dialog = await page.locator(".xdlg").count();
  await page.locator(".xdlg .seg button", { hasText: "Walkthrough A" }).click(); await wait(h, 200);
  res.defaults = await page.locator(".xdlg input[type=checkbox]").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked));
  await shotPr(h, "export-1-dialog");
  // 2. HTML snapshot of walkthrough A
  const t0 = Date.now();
  await page.locator(".xdlg button.def").click();
  await until(h, () => files.html, 20000);
  res.htmlMs = Date.now() - t0;
  res.closed = await page.locator(".xdlg").count();
  const html = fs.readFileSync(files.html, "utf8");
  res.htmlKB = Math.round(html.length / 1024);
  res.cbres = (html.match(/cbres:/g) ?? []).length;
  res.fontData = (html.match(/url\("data:font\/woff2;base64,/g) ?? []).length;
  res.noScriptSrc = !/<script[^>]+src=/.test(html);
  res.privateInHtml = html.includes("PRIVATE draft");
  // 3. Markdown of the whole board with questions
  await page.locator('.bbar [aria-label="More"]').click(); await wait(h, 300);
  await page.locator(".ctx button", { hasText: "Export…" }).click(); await wait(h, 400);
  await page.locator(".xdlg .seg button", { hasText: "Markdown" }).click();
  await page.locator(".xdlg .seg button", { hasText: "Whole Board" }).click();
  await page.locator(".xdlg label", { hasText: "Questions" }).locator("input").check(); await wait(h, 200);
  await page.locator(".xdlg button.def").click();
  await until(h, () => files.md, 10000);
  const md = fs.readFileSync(files.md, "utf8");
  res.md = {
    order: [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
    permalink: md.includes("[permalink](https://github.com/GeeeekExplorer/nano-vllm/blob/bb823b3c0ffee/nanovllm/engine/scheduler.py#L"),
    fence: md.includes("```python\ndef schedule(self)"),
    arrow: md.includes("→ BlockManager.can_allocate · from line"),
    sidenote: md.includes("> 先 prefill 再 decode"),
    question: md.includes("- [ ] **Question** (line"),
    escaped: md.includes("\\_"), priv: md.includes("PRIVATE"),
  };
  // 4. Open the snapshot in Chromium: renders offline (no network), pans, zooms, walks, shows sidenotes on hover; nothing is editable
  const v = await page.context().browser()!.newPage();
  await v.setViewportSize({ width: 1400, height: 860 });
  const net: string[] = [];
  v.on("request", (r) => { if (!/^(file|data|blob):/.test(r.url())) net.push(r.url()); });
  const errs: string[] = [];
  v.on("pageerror", (e) => errs.push(e.message));
  await v.goto(`file://${files.html}`); await v.waitForTimeout(1200);
  res.view = await v.evaluate(() => ({
    cards: [...document.querySelectorAll(".world .card[data-id]")].map((c) => (c as HTMLElement).dataset.id),
    lines: document.querySelectorAll(".world .card .src .l").length,
    links: document.querySelectorAll(".world [data-lk]").length,
    look: document.documentElement.dataset.look,
    editable: document.querySelectorAll("[contenteditable]").length,
    fontsOk: [...document.fonts].filter((f) => f.status === "loaded").length,
    walk: !(document.querySelector(".xv-walk") as HTMLElement).hidden,
  }));
  const tf = () => v.evaluate(() => (document.querySelector(".world") as HTMLElement).style.transform);
  const t1 = await tf();
  await v.mouse.move(200, 700); await v.mouse.down(); await v.mouse.move(120, 640, { steps: 4 }); await v.mouse.up();
  const t2 = await tf();
  await v.mouse.move(700, 430); await v.keyboard.down("Control"); await v.mouse.wheel(0, -200); await v.keyboard.up("Control"); await v.waitForTimeout(200);
  const t3 = await tf();
  res.pan = t1 !== t2; res.zoom = t2 !== t3;
  await v.locator(".xv-wt").click(); await v.waitForTimeout(300);
  await v.locator('.xv-walk [data-w="next"]').click(); await v.waitForTimeout(400);
  res.walkStep = await v.locator(".xv-walk .cnt").textContent();
  res.cur = await v.evaluate(() => (document.querySelector(".xv-cur") as HTMLElement | null)?.dataset.id);
  await v.locator('.xv-walk [data-w="prev"]').click(); await v.waitForTimeout(400);
  const mk = v.locator(`.card[data-id="${ids.sch}"] .gutter .mk`).first();
  await mk.hover(); await v.waitForTimeout(300);
  res.tip = await v.locator(".xv-tip").textContent().catch(() => "");
  res.net = net; res.errs = errs;
  await v.screenshot({ path: path.join(OUT, "export-2-html.png") });
  if (process.env.SHOTS_DIR) fs.copyFileSync(path.join(OUT, "export-2-html.png"), path.join(process.env.SHOTS_DIR, "export-2-html.png"));
  // 5. The Markdown sample, shown as text
  await v.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fbfaf7"><pre style="margin:0;padding:20px 28px;font:12.5px/1.55 ui-monospace,Menlo,monospace;white-space:pre-wrap;color:#2b2b2b">${md.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre></body>`);
  await v.setViewportSize({ width: 1000, height: 1300 });
  await v.screenshot({ path: path.join(OUT, "export-3-markdown.png") });
  if (process.env.SHOTS_DIR) fs.copyFileSync(path.join(OUT, "export-3-markdown.png"), path.join(process.env.SHOTS_DIR, "export-3-markdown.png"));
  const view = res.view as { cards: string[]; lines: number; links: number; editable: number; fontsOk: number; walk: boolean; look: string };
  const m = res.md as Record<string, unknown>;
  const ok = res.dialog === 1 && JSON.stringify(res.defaults) === "[false,false]" && res.closed === 0 && res.cbres === 0 && (res.fontData as number) > 0 && res.noScriptSrc && !res.privateInHtml
    && JSON.stringify(view.cards.sort()) === JSON.stringify([ids.sch, ids.can, ids.alloc, ids.note].sort()) && view.lines > 40 && view.links >= 3 && view.editable === 0 && view.fontsOk > 0 && view.walk && view.look === "warm-ink"
    && res.pan && res.zoom && res.walkStep === "2 / 4" && res.cur === ids.can && String(res.tip).includes("先 prefill 再 decode") && !(res.net as string[]).length && !(res.errs as string[]).length
    && JSON.stringify(m.order) === JSON.stringify(["A · Scheduler.schedule", "A · BlockManager.can_allocate", "A · BlockManager.allocate", "prefix caching"])
    && m.permalink && m.fence && m.arrow && m.sidenote && m.question && !m.escaped && !m.priv;
  await page.context().browser()!.close();
  return !!ok;
}

async function settings(res: Record<string, unknown>) {
  const { b } = schedBoard();
  const h = await open({ board: b, light, w: 1400, h: 1000 }), page = h.page;
  await page.keyboard.press("Meta+Comma").catch(() => undefined); await wait(h, 300);
  if (!(await page.locator(".settings").count())) { await page.locator('.bbar [aria-label="More"]').click(); await wait(h, 300); await page.locator(".ctx button", { hasText: "Settings…" }).click(); await wait(h, 500); }
  await page.locator('.settings [data-sec="shared"]').evaluate((el) => el.scrollIntoView({ block: "start" })); await wait(h, 300);
  res.secs = await page.locator(".settings .st-sec h3").allTextContents();
  await page.locator('.settings [data-sec="shared"] .st-chip', { hasText: "Title Only" }).click();
  await page.locator('.settings [data-sec="questions"] .st-chip', { hasText: "Always" }).click();
  await page.locator('.settings [data-sec="export"] .st-chip', { hasText: "Walkthrough" }).click();
  await page.locator('.settings [data-sec="export"] .st-chip', { hasText: /^On$/ }).first().click();
  await wait(h, 300);
  await shotPr(h, "settings-1-v02");
  res.set = h.sent.filter((m) => m.type === "setSetting").map((m) => `${(m as { key: string }).key}=${JSON.stringify((m as { value: unknown }).value)}`);
  const ok = ["Boards", "Questions", "Export"].every((t) => (res.secs as string[]).includes(t))
    && JSON.stringify(res.set) === JSON.stringify(['subPreview="title"', 'welcomeBack="always"', 'exportScope="walk"', "exportQuestions=true"]);
  await page.context().browser()!.close();
  return ok;
}

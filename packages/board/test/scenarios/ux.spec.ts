import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, DEFAULT_SETTINGS, type CodeCard, type SegView, type HostToBoard, type NameHit } from "@codeboard/core";
import { shot, put, symCard, findSym, REPO, type Host } from "../harness";
import { startAnalysis, analysisOf } from "@codeboard/host/analysis";
import { cardForFileSym } from "@codeboard/host/cards";
import { callVars, expand, peek } from "@codeboard/host/resolve";
import { viewsFor } from "@codeboard/host/views";
import { search, searchName, searchPick } from "@codeboard/host/search";
import type { Storage } from "@codeboard/host/storage";
import { resetIndex, startNameIndex, nameIndexReady } from "@codeboard/host/nameindex";
import { langOf, useWorkspace } from "@codeboard/host/ws";
import { nodeWorkspace } from "@codeboard/host/test/node-workspace";
import { test, open, verdict, expect, until, idle } from "../fixtures";

const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };

test("dock-fits-narrow-board", () => verdict("dock-fits-narrow-board", dockFits));

test("narrow-board-expands-below-and-stays-readable", () => verdict("narrow-board-expands-below-and-stays-readable", expandFollow));

test("expanded-calls-go-in-columns-to-the-right", () => verdict("expanded-calls-go-in-columns-to-the-right", expandColumns));

test("string-dispatch-offers-receiver-method", () => verdict("string-dispatch-offers-receiver-method", dispatchByName));

test("right-click-line-opens-line-menu", () => verdict("right-click-line-opens-line-menu", lineMenu));

test("editing-tiny-note-zooms-to-readable", () => verdict("editing-tiny-note-zooms-to-readable", readableNote));

test("search-lists-symbols-containing-the-query", () => verdict("search-lists-symbols-containing-the-query", searchStep));

test("turn-into-board-names-after-the-calling-card", () => verdict("turn-into-board-names-after-the-calling-card", turnName));

/** 底部工具条：每个宽度都是一行，彼此不重叠，也不出窗口 */
async function dockFits(res: Record<string, unknown>) {
  let ok = true;
  for (const w of [540, 640, 760, 900, 1080, 1400]) {
    const b = emptyBoard("bN", "narrow");
    const c = nv("LLMEngine.step"); put(b, c, 40, 40, 460);
    const h = await open({ board: b, w, h: 700 });
    await idle(h);
    const m = await h.page.evaluate(() => {
      const rs = [...document.querySelectorAll(".over.bbar .pill, .over.dock .pill")].filter((e) => (e as HTMLElement).offsetParent).map((e) => e.getBoundingClientRect());
      return { pills: rs.map((r) => ({ l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) })), vw: innerWidth };
    });
    // 一行：所有的条在同一条水平带上
    const oneRow = Math.max(...m.pills.map((p) => p.t)) < Math.min(...m.pills.map((p) => p.b));
    const overlap = m.pills.some((a, i) => m.pills.some((b, j) => i < j && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b));
    const inside = m.pills.every((p) => p.l >= 8 && p.r <= m.vw - 8);
    res[w] = { pills: m.pills.length, oneRow, overlap, inside };
    if (overlap || !inside || !oneRow) ok = false;
    if (w === 540) {
      // 收起来的按钮在 ⋯ 里：New Web Card 能用，Call Tree 能开
      await h.page.locator('.bbar button[aria-label="More"]').click();
      await h.page.locator(".ctx button").first().waitFor(); await idle(h);
      res.folded = await h.page.locator(".ctx button").allInnerTexts().then((t) => t.filter((x) => /New Web Card|Call Tree|Arrow Legend|Add a Sticker/.test(x)).length);
      await h.page.locator(".ctx button", { hasText: "Call Tree" }).click(); await idle(h);
      res.tree = await h.page.locator(".cpanel.ctree").count();
      if (res.folded !== 4 || res.tree !== 1) ok = false;
    }
    await shot(h, `ux-dock-${w}`);
    await h.page.context().close();
  }
  return ok;
}

const callEl = (h: Host, card: string, name: string) => h.page.locator(`.card[data-id="${card}"] .src .call`, { hasText: new RegExp(`^${name}$`) }).first();
const zoomOf = (h: Host) => h.page.evaluate(() => parseInt(document.querySelector(".zoom")!.textContent!) / 100);
/** 屏幕上的矩形在不在视口里（ys：只看顶部这么高） */
const inView = (b: { x: number; y: number; width: number; height: number } | null, vw: number, vh: number, top = Infinity) =>
  !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= vw && b.y + Math.min(b.height, top) <= vh;

/** 白板在编辑器旁边（窄）、100%：连着展开 step 的两个调用，子卡放在下面，新卡大半在视野里；之后 Fit 不低于概览 */
async function expandFollow(res: Record<string, unknown>) {
  const b = emptyBoard("bE", "expand");
  const step = nv("LLMEngine.step"); put(b, step, 40, 80, 480);
  b.cam = { x: 0, y: 0, z: 1 };
  const W = 560, H = 800;
  const h = await open({ board: b, w: W, h: H });
  await idle(h);
  let ok = true;
  for (const name of ["schedule", "postprocess"]) {
    const n0 = h.board().cards.length;
    // 窄白板放不下父卡和右边一列的新卡：上一次展开后 step 可能出了视野，像用户那样往左平移回来
    if (!inView(await callEl(h, step.id, name).boundingBox(), W, H)) { await h.page.mouse.move(60, 120); await h.page.mouse.wheel(-600, 0); await idle(h); }
    await callEl(h, step.id, name).click();
    await until(h, `${name} expands into a new card`, () => h.board().cards.length > n0); await idle(h);
    const nid = h.board().cards[n0]?.id;
    const card = await h.page.locator(`.card[data-id="${nid}"]`).boundingBox();
    const z = await zoomOf(h);
    const shown = card ? (Math.min(card.x + card.width, W) - Math.max(card.x, 0)) * (Math.min(card.y + card.height, H) - Math.max(card.y, 0)) / (card.width * card.height) : 0;
    res[name] = { shown: Math.round(shown * 100) / 100, z };
    if (!nid || shown <= 0.5 || z < 0.6) ok = false;
  }
  // 窄白板放不下并排：子卡缩进放在 step 下面，Fit 时代码还能读
  const P = h.board().place, ids = h.board().cards.map((c) => c.id);
  res.below = ids.slice(1).every((id) => P[id].x === P[step.id].x + 56 && P[id].y > P[step.id].y);
  await h.page.keyboard.press("Shift+Digit1"); await idle(h);
  res.fitZ = await zoomOf(h);
  await shot(h, "ux-expand-follow");
  await h.page.context().close();
  return ok && !!res.below && (res.fitZ as number) >= 0.6;
}

/** 每深一层调用放右边一列，同一层按出发行从上到下；Fit 后缩放不低于概览，代码还能读 */
async function expandColumns(res: Record<string, unknown>) {
  const b = emptyBoard("bC", "columns");
  const step = nv("LLMEngine.step"); put(b, step, 40, 80, 480);
  b.cam = { x: 0, y: 0, z: 1 };
  const h = await open({ board: b, w: 1400, h: 900 });
  await idle(h);
  const expandOn = async (card: string, name: string) => {
    const n0 = h.board().cards.length;
    await callEl(h, card, name).click();
    await until(h, `${name} expands into a new card`, () => h.board().cards.length > n0); await idle(h);
    return h.board().cards[n0]?.id;
  };
  const sched = await expandOn(step.id, "schedule");
  const post = await expandOn(step.id, "postprocess");
  const alloc = await expandOn(sched, "can_allocate");
  const P = h.board().place;
  const r = (id: string) => P[id];
  res.place = { step: r(step.id), sched: r(sched), post: r(post), alloc: r(alloc) };
  await h.page.keyboard.press("Shift+Digit1"); await idle(h);
  const z = await zoomOf(h);
  res.z = z;
  await shot(h, "ux-expand-columns");
  await h.page.context().close();
  if (!sched || !post || !alloc) return false;
  const right = (a: string, c: string) => r(c).x >= r(a).x + r(a).w;
  return right(step.id, sched) && right(sched, alloc) && r(post).x === r(sched).x && r(post).y > r(sched).y && z >= 0.6;
}

/** 真的宿主（resolve.ts、名字索引）读 examples/nano-vllm */
async function nanoHost(cards: { rel: string; qual: string; x: number; y: number }[], o: { w?: number; h?: number; names?: (hs: NameHit[]) => NameHit[] } = {}) {
  const NV = path.join(REPO, "examples/nano-vllm");
  useWorkspace(nodeWorkspace(NV));
  await startAnalysis();
  resetIndex(); startNameIndex(); await nameIndexReady();
  const B = emptyBoard("bNv", "nano-vllm");
  const ids: string[] = [];
  for (const c of cards) {
    const abs = path.join(NV, c.rel);
    const sym = analysisOf(langOf(abs), fs.readFileSync(abs, "utf8")).symbols.find((s) => s.qual === c.qual)!;
    const card = (await cardForFileSym(abs, sym))!.card as CodeCard;
    put(B, card, c.x, c.y, 560); ids.push(card.id);
  }
  const views: Record<string, SegView> = await viewsFor(B.cards.flatMap((c) => (c.kind === "code" ? c.segments : [])));
  const h = await open({
    board: B, w: o.w ?? 1400, h: o.h ?? 900,
    on: async (m, reply) => {
      switch (m.type) {
        case "ready": return true;
        case "expand": await reply(m.req, await expand(m)); return true;
        case "peek": await reply(m.req, await peek(m)); return true;
        case "views": await reply(m.req, await viewsFor(m.segs)); return true;
        case "callVars": await reply(m.req, await callVars(m)); return true;
        case "searchName": { const hs = await searchName(m.name); await reply(m.req, o.names ? o.names(hs) : hs); return true; }
        case "searchPick": await reply(m.req, await searchPick(m.item)); return true;
        case "prefetch": return true;
        default: return false;
      }
    },
  });
  const init: HostToBoard = { type: "init", board: B, boards: [{ id: B.id, name: B.name, cards: B.cards.length }], views, stale: {}, host: { isMac: true, assetBase: "", target: true, settings: { ...DEFAULT_SETTINGS } } };
  await h.post(init); await h.page.locator(".card").first().waitFor(); await idle(h);
  return { h, ids };
}

/** model_runner.call("run", …)：点 call 列出按名字 run 搜到的定义，ModelRunner.run 排第一；选它建卡，箭头从那一行出发 */
async function dispatchByName(res: Record<string, unknown>) {
  // 另一个类里也有 run（排在前面）：接收者 self.model_runner 的类 ModelRunner 要排到它前面
  const decoy: NameHit = { lang: "py", label: "def run(self)", detail: "nanovllm/engine/sequence.py:1", path: "nanovllm/engine/sequence.py", line: 1, def: true, qual: "Sequence.run" };
  const { h, ids: [step] } = await nanoHost([{ rel: "nanovllm/engine/llm_engine.py", qual: "LLMEngine.step", x: 80, y: 80 }], { names: (hs) => [decoy, ...hs] });
  await callEl(h, step, "call").click();
  const first = h.page.locator(".pop .sres.names .cand").first();
  await first.waitFor(); await idle(h); // the names come with the host's searchName reply
  const head = h.page.locator(".pop .ph, .pop h3, .pop .head").first();
  res.title = (await head.count()) ? await head.textContent() : "";
  res.first = await first.textContent();
  res.n = await h.page.locator(".pop .sres.names .cand").count();
  await first.click();
  await until(h, "the picked definition's card and arrow are saved", () => h.board().cards.some((c) => c.kind === "code" && c.segments[0]?.symbol?.qual === "ModelRunner.run") && h.board().links.length); await idle(h);
  const run = h.board().cards.find((c) => c.kind === "code" && c.segments[0]?.symbol?.qual === "ModelRunner.run");
  const stepCard = h.board().cards.find((c) => c.id === step) as CodeCard;
  const callLine = stepCard.segments[0].start + stepCard.segments[0].text.findIndex((t) => /model_runner\.call\(/.test(t));
  const link = run && h.board().links.find((l) => l.to.card === run.id);
  res.card = !!run; res.link = link ? { line: link.from.line, call: link.call?.name, via: link.call?.ev?.via } : null;
  await shot(h, "ux-dispatch");
  await h.page.context().close();
  return /model_runner\.py/.test(String(res.first)) && /\brun\b/.test(String(res.first)) && !!run && link?.from.line === callLine && link?.call?.name === "call" && link?.call?.ev?.via === 'call("run")';
}

const menuTexts = (h: Host) => h.page.locator(".ctx.open button").allInnerTexts();
const selNos = (h: Host) => h.page.locator(".card .gutter .no.sel").allInnerTexts();

/** 右键代码行 / 行号 = 选中这一行 + 行菜单（卡片菜单在 Card ▸ 里）；已选的几行里右键保留选择；↵ 在编辑器里打开到第一行；右键调用还是调用菜单 */
async function lineMenu(res: Record<string, unknown>) {
  const b = emptyBoard("bL", "lines");
  const step = nv("LLMEngine.step"); put(b, step, 80, 80, 620);
  const h = await open({ board: b }), page = h.page;
  await idle(h);
  /** The context menu is open and settled (its items read without waiting) */
  const menuOpen = async () => { await page.locator(".ctx.open button").first().waitFor(); await idle(h); };
  const menuClosed = () => expect(page.locator(".ctx.open")).toHaveCount(0);
  const row = page.locator(`.card[data-id="${step.id}"] .src > [data-r]`, { hasText: "num_tokens = sum" }).first();
  const rb = (await row.boundingBox())!;
  await page.mouse.click(rb.x + 6, rb.y + rb.height / 2, { button: "right" }); await menuOpen();
  const m1 = await menuTexts(h);
  res.code = { sel: await selNos(h), hide: m1.some((t) => /Hide Lines/.test(t)), ask: m1.some((t) => /Ask a Question/.test(t)), card: m1.some((t) => /^Card/.test(t)) };
  await page.locator(".ctx.open button", { hasText: /^Card/ }).hover(); await idle(h); // its submenu opens on pointerenter
  res.cardSub = (await menuTexts(h)).some((t) => /Open in Editor/.test(t));
  await page.keyboard.press("Escape"); await menuClosed();
  const no = (n: number) => page.locator(`.card[data-id="${step.id}"] .gutter .no`, { hasText: new RegExp(`^${n}$`) }).first();
  await no(50).click({ button: "right" }); await menuOpen();
  res.gutter = { sel: await selNos(h), hide: (await menuTexts(h)).some((t) => /Hide Lines/.test(t)) };
  await page.keyboard.press("Escape"); await menuClosed();
  await no(52).click({ modifiers: ["Shift"] }); await idle(h);
  await no(51).click({ button: "right" }); await menuOpen();
  res.kept = await selNos(h);
  await page.keyboard.press("Escape"); await menuClosed();
  await page.keyboard.press("Enter");
  await until(h, "Enter asks the host to open the editor", () => h.sent.some((m) => m.type === "open"));
  const o = h.sent.filter((m) => m.type === "open").at(-1) as { line?: number } | undefined;
  res.open = o?.line;
  await callEl(h, step.id, "schedule").click({ button: "right" }); await menuOpen();
  res.call = (await menuTexts(h)).some((t) => /^Expand/.test(t));
  await shot(h, "ux-linemenu");
  await page.context().close();
  const c = res.code as { sel: string[]; hide: boolean; ask: boolean; card: boolean }, g = res.gutter as { sel: string[]; hide: boolean };
  return c.sel.join() === "51" && c.hide && c.ask && c.card && res.cardSub === true && g.sel.join() === "50" && g.hide
    && (res.kept as string[]).join() === "50,51,52" && res.open === 50 && res.call === true;
}

/** 缩到 48% 按 N 新建 Note：镜头放大到字至少 11px（不超过 100%），Note 在视野里；退出编辑不缩回去。双击一段很小的 Text 也一样 */
async function readableNote(res: Record<string, unknown>) {
  const b = emptyBoard("bR", "read");
  const step = nv("LLMEngine.step"); put(b, step, 80, 80, 560);
  b.cards.push({ id: "t1", kind: "note", md: "far away text", look: "text", size: "body" }); b.place.t1 = { x: 1400, y: 900, w: 320 };
  b.cam = { x: 40, y: 40, z: 0.48 };
  const h = await open({ board: b, w: 1200, h: 800 }), page = h.page;
  await idle(h);
  const px = (sel: string) => page.evaluate((q) => { const el = document.querySelector(q) as HTMLElement | null; return el ? parseFloat(getComputedStyle(el).fontSize) * el.getBoundingClientRect().height / el.offsetHeight : 0; }, sel);
  await page.mouse.move(700, 600);
  await page.keyboard.press("n");
  await page.locator(".md-pm:focus").waitFor(); await idle(h); // the camera zooms in to the new Note
  const nid = await page.evaluate(() => document.querySelector(".card.sel")?.getAttribute("data-id"));
  const z1 = await zoomOf(h);
  const font1 = await px(`.card[data-id="${nid}"] .nbody`);
  const box = await page.locator(`.card[data-id="${nid}"]`).boundingBox();
  await page.keyboard.type("hello"); await page.keyboard.press("Escape"); await idle(h);
  const z2 = await zoomOf(h);
  res.note = { z1, z2, font: +font1.toFixed(1), inView: inView(box, 1200, 800) };
  // 缩到 64%（还不是概览），双击远处的 Text 进入编辑
  for (let i = 0; i < 2; i++) { await page.locator('button[aria-label="Zoom Out"]').click(); await idle(h); }
  const z3 = await zoomOf(h);
  const tb = (await page.locator('.card[data-id="t1"] .tx').boundingBox())!;
  await page.mouse.dblclick(tb.x + 10, tb.y + tb.height / 2);
  await page.locator('.card[data-id="t1"] :focus').waitFor(); await idle(h);
  const editingT = await page.evaluate(() => !!document.activeElement?.closest('.card[data-id="t1"]'));
  const font2 = await px('.card[data-id="t1"] .tx');
  res.text = { z3, z4: await zoomOf(h), font: +font2.toFixed(1), editing: editingT };
  await shot(h, "ux-readable");
  await page.context().close();
  return z1 > 0.48 && z1 <= 1 && font1 >= 10.9 && inView(box, 1200, 800) && z2 === z1 && z3 >= 0.6 && z3 < 0.8 && editingT && font2 >= 10.9;
}

/** ⌘K 在 nano-vllm 里搜 step：只列名字 / 全名里有 step 的符号（不列 main、Context、get_context、…__init__） */
async function searchStep(res: Record<string, unknown>) {
  useWorkspace(nodeWorkspace(path.join(REPO, "examples/nano-vllm")));
  await startAnalysis();
  resetIndex(); startNameIndex(); await nameIndexReady();
  const items = await search(null as unknown as Storage, "step", "symbols");
  res.labels = items.map((i) => i.label);
  return items.length > 0 && items.every((i) => i.label.toLowerCase().includes("step")) && items[0].label.endsWith(".step");
}

/** Turn into Board 的默认名字：选中的卡里调用图最上面的那张（Scheduler.schedule），不是最后点的、也不是位置最靠上的被调卡 */
async function turnName(res: Record<string, unknown>) {
  const b = emptyBoard("bT", "turn");
  const sch = nv("Scheduler.schedule"), can = nv("BlockManager.can_allocate"), note = "nT";
  put(b, can, 80, 60, 480); put(b, sch, 700, 300, 560);
  b.cards.push({ id: note, kind: "note", md: "aside", look: "note", size: "body" }); b.place[note] = { x: 700, y: 10, w: 200 };
  b.links.push({ id: "lT", from: { card: sch.id, seg: sch.segments[0].id, line: sch.segments[0].start + sch.segments[0].text.findIndex((t) => /can_allocate\(/.test(t)) }, to: { card: can.id }, call: { name: "can_allocate", col: 0 } });
  const h = await open({ board: b }), page = h.page;
  await page.keyboard.press("Shift+Digit1"); await idle(h);
  const name = async (ids: string[]) => {
    for (const [i, id] of ids.entries()) await page.locator(`.card[data-id="${id}"] .chead`).click({ position: { x: 60, y: 10 }, modifiers: i ? ["Shift"] : [] });
    await page.keyboard.press("Meta+Shift+b");
    await page.locator(".dialog input").waitFor();
    const v = await page.locator(".dialog input").inputValue();
    await page.keyboard.press("Escape"); await page.mouse.click(1380, 20);
    await expect(page.locator(".dialog")).toHaveCount(0); await idle(h);
    return v;
  };
  res.called = await name([sch.id, can.id]);
  res.withNote = await name([note, can.id, sch.id]);
  res.unlinked = await name([sch.id, note]);
  await page.context().close();
  return res.called === "Scheduler.schedule" && res.withNote === "Scheduler.schedule" && res.unlinked === "aside";
}

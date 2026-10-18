// 真机试用（nano-vllm、白板放在编辑器旁边）后的体验修正
// Usage: node packages/board/test/run-harness.mjs <scenario>   screenshots: test-out/harness/ux-*.png
import * as fs from "node:fs";
import * as path from "node:path";
import { emptyBoard, DEFAULT_SETTINGS, type CodeCard, type SegView, type HostToBoard, type NameHit } from "@codeboard/core";
import { open, shot, put, symCard, findSym, REPO, type Host } from "./harness";
import { startAnalysis, analysisOf } from "../../../extensions/vscode/src/analysis";
import { cardForFileSym } from "../../../extensions/vscode/src/cards";
import { callVars, expand, peek } from "../../../extensions/vscode/src/resolve";
import { viewsFor } from "../../../extensions/vscode/src/views";
import { searchName, searchPick } from "../../../extensions/vscode/src/search";
import { resetIndex, startNameIndex, nameIndexReady } from "../../../extensions/vscode/src/nameindex";
import { langOf, useWorkspace } from "../../../extensions/vscode/src/ws";
import { nodeWorkspace } from "../../../extensions/vscode/test/node-workspace";

const wait = (h: Host, ms = 600) => h.page.waitForTimeout(ms);
const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };
const run = async (name: string, f: (res: Record<string, unknown>) => Promise<boolean>) => {
  const res: Record<string, unknown> = {};
  let ok = false;
  try { ok = await f(res); } catch (e) { console.log("FAIL", name, (e as Error).message.split("\n")[0], JSON.stringify(res)); process.exit(1); }
  console.log(ok ? "PASS" : "FAIL", name, JSON.stringify(res));
  if (!ok) process.exitCode = 1;
};

export const UX: Record<string, () => Promise<void>> = {
  "dock-fits-narrow-board": () => run("dock-fits-narrow-board", dockFits),
  "expand-keeps-call-line-in-view": () => run("expand-keeps-call-line-in-view", expandFollow),
  "string-dispatch-offers-receiver-method": () => run("string-dispatch-offers-receiver-method", dispatchByName),
  "right-click-line-opens-line-menu": () => run("right-click-line-opens-line-menu", lineMenu),
};

/** 底部工具条：每个宽度都是一行，彼此不重叠，也不出窗口 */
async function dockFits(res: Record<string, unknown>) {
  let ok = true;
  for (const w of [540, 640, 760, 900, 1080, 1400]) {
    const b = emptyBoard("bN", "narrow");
    const c = nv("LLMEngine.step"); put(b, c, 40, 40, 460);
    const h = await open({ board: b, w, h: 700 });
    await wait(h, 400);
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
      await h.page.locator('.bbar button[aria-label="More"]').click(); await wait(h, 400);
      res.folded = await h.page.locator(".ctx button").allInnerTexts().then((t) => t.filter((x) => /New Web Card|Call Tree|Arrow Legend|Add a Sticker/.test(x)).length);
      await h.page.locator(".ctx button", { hasText: "Call Tree" }).click(); await wait(h, 400);
      res.tree = await h.page.locator(".cpanel.ctree").count();
      if (res.folded !== 4 || res.tree !== 1) ok = false;
    }
    await shot(h, `ux-dock-${w}`);
    await h.page.context().browser()!.close();
  }
  return ok;
}

const callEl = (h: Host, card: string, name: string) => h.page.locator(`.card[data-id="${card}"] .src .call`, { hasText: new RegExp(`^${name}$`) }).first();
const zoomOf = (h: Host) => h.page.evaluate(() => parseInt(document.querySelector(".zoom")!.textContent!) / 100);
/** 屏幕上的矩形在不在视口里（ys：只看顶部这么高） */
const inView = (b: { x: number; y: number; width: number; height: number } | null, vw: number, vh: number, top = Infinity) =>
  !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= vw && b.y + Math.min(b.height, top) <= vh;

/** 白板在编辑器旁边（窄）、100%：连着展开 step 的两个调用，出发的那一行和新卡都在视野里，缩放不低于概览 */
async function expandFollow(res: Record<string, unknown>) {
  const b = emptyBoard("bE", "expand");
  const step = nv("LLMEngine.step"); put(b, step, 40, 80, 480);
  b.cam = { x: 0, y: 0, z: 1 };
  const W = 560, H = 800;
  const h = await open({ board: b, w: W, h: H });
  await wait(h, 500);
  let ok = true;
  for (const name of ["schedule", "postprocess"]) {
    const n0 = h.board().cards.length;
    await callEl(h, step.id, name).click(); await wait(h, 1400);
    const nid = h.board().cards[n0]?.id;
    const line = await callEl(h, step.id, name).boundingBox();
    const card = await h.page.locator(`.card[data-id="${nid}"]`).boundingBox();
    const z = await zoomOf(h);
    res[name] = { line: inView(line, W, H), card: inView(card, W, H, 120), z };
    if (!nid || !inView(line, W, H) || !inView(card, W, H, 120) || z < 0.6) ok = false;
  }
  await shot(h, "ux-expand-follow");
  await h.page.context().browser()!.close();
  return ok;
}

/** 真的宿主（resolve.ts、名字索引）读 examples/nano-vllm */
async function nanoHost(cards: { rel: string; qual: string; x: number; y: number }[], o: { w?: number; h?: number; names?: (hs: NameHit[]) => NameHit[] } = {}) {
  const NV = path.join(REPO, "examples/nano-vllm");
  useWorkspace(nodeWorkspace(NV));
  await startAnalysis(path.join(REPO, "node_modules/@vscode/tree-sitter-wasm/wasm"));
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
  await h.post(init); await wait(h, 900);
  return { h, ids };
}

/** model_runner.call("run", …)：点 call 列出按名字 run 搜到的定义，ModelRunner.run 排第一；选它建卡，箭头从那一行出发 */
async function dispatchByName(res: Record<string, unknown>) {
  // 另一个类里也有 run（排在前面）：接收者 self.model_runner 的类 ModelRunner 要排到它前面
  const decoy: NameHit = { lang: "py", label: "def run(self)", detail: "nanovllm/engine/sequence.py:1", path: "nanovllm/engine/sequence.py", line: 1, def: true, qual: "Sequence.run" };
  const { h, ids: [step] } = await nanoHost([{ rel: "nanovllm/engine/llm_engine.py", qual: "LLMEngine.step", x: 80, y: 80 }], { names: (hs) => [decoy, ...hs] });
  await callEl(h, step, "call").click(); await wait(h, 1500);
  res.title = await h.page.locator(".pop .ph, .pop h3, .pop .head").first().textContent().catch(() => "");
  const first = h.page.locator(".pop .sres.names .cand").first();
  res.first = await first.textContent();
  res.n = await h.page.locator(".pop .sres.names .cand").count();
  await first.click(); await wait(h, 1800);
  const run = h.board().cards.find((c) => c.kind === "code" && c.segments[0]?.symbol?.qual === "ModelRunner.run");
  const stepCard = h.board().cards.find((c) => c.id === step) as CodeCard;
  const callLine = stepCard.segments[0].start + stepCard.segments[0].text.findIndex((t) => /model_runner\.call\(/.test(t));
  const link = run && h.board().links.find((l) => l.to.card === run.id);
  res.card = !!run; res.link = link ? { line: link.from.line, call: link.call?.name, via: link.call?.ev?.via } : null;
  await shot(h, "ux-dispatch");
  await h.page.context().browser()!.close();
  return /model_runner\.py/.test(String(res.first)) && /\brun\b/.test(String(res.first)) && !!run && link?.from.line === callLine && link?.call?.name === "call" && link?.call?.ev?.via === 'call("run")';
}

const menuTexts = (h: Host) => h.page.locator(".ctx.open button").allInnerTexts();
const selNos = (h: Host) => h.page.locator(".card .gutter .no.sel").allInnerTexts();

/** 右键代码行 / 行号 = 选中这一行 + 行菜单（卡片菜单在 Card ▸ 里）；已选的几行里右键保留选择；↵ 在编辑器里打开到第一行；右键调用还是调用菜单 */
async function lineMenu(res: Record<string, unknown>) {
  const b = emptyBoard("bL", "lines");
  const step = nv("LLMEngine.step"); put(b, step, 80, 80, 620);
  const h = await open({ board: b }), page = h.page;
  await wait(h, 500);
  const row = page.locator(`.card[data-id="${step.id}"] .src > [data-r]`, { hasText: "num_tokens = sum" }).first();
  const rb = (await row.boundingBox())!;
  await page.mouse.click(rb.x + 6, rb.y + rb.height / 2, { button: "right" }); await wait(h, 400);
  const m1 = await menuTexts(h);
  res.code = { sel: await selNos(h), hide: m1.some((t) => /Hide Lines/.test(t)), ask: m1.some((t) => /Ask a Question/.test(t)), card: m1.some((t) => /^Card/.test(t)) };
  await page.locator(".ctx.open button", { hasText: /^Card/ }).hover(); await wait(h, 400);
  res.cardSub = (await menuTexts(h)).some((t) => /Open in Editor/.test(t));
  await page.keyboard.press("Escape"); await wait(h, 300);
  const no = (n: number) => page.locator(`.card[data-id="${step.id}"] .gutter .no`, { hasText: new RegExp(`^${n}$`) }).first();
  await no(50).click({ button: "right" }); await wait(h, 400);
  res.gutter = { sel: await selNos(h), hide: (await menuTexts(h)).some((t) => /Hide Lines/.test(t)) };
  await page.keyboard.press("Escape"); await wait(h, 300);
  await no(52).click({ modifiers: ["Shift"] }); await wait(h, 300);
  await no(51).click({ button: "right" }); await wait(h, 400);
  res.kept = await selNos(h);
  await page.keyboard.press("Escape"); await wait(h, 300);
  await page.keyboard.press("Enter"); await wait(h, 400);
  const o = h.sent.filter((m) => m.type === "open").at(-1) as { line?: number } | undefined;
  res.open = o?.line;
  await callEl(h, step.id, "schedule").click({ button: "right" }); await wait(h, 400);
  res.call = (await menuTexts(h)).some((t) => /^Expand/.test(t));
  await shot(h, "ux-linemenu");
  await page.context().browser()!.close();
  const c = res.code as { sel: string[]; hide: boolean; ask: boolean; card: boolean }, g = res.gutter as { sel: string[]; hide: boolean };
  return c.sel.join() === "51" && c.hide && c.ask && c.card && res.cardSub === true && g.sel.join() === "50" && g.hide
    && (res.kept as string[]).join() === "50,51,52" && res.open === 50 && res.call === true;
}

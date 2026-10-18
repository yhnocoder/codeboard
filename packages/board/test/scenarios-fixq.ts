// v0.2 fixes from Linda's first try in VS Code:
//  qpop     — the question popover in every theme, light and dark: the placeholder is not clipped, the buttons never wrap
//  dataclass — nano-vllm utils/context.py: a fields-only @dataclass class card shows its code (decorator + fields), not an empty member list
//  segsep   — multi-segment cards show every segment boundary (⋯ N lines / a divider); a class card merges into one, segments by line
//  varmenu  — Add Variant menu: a long worktree path does not wrap "Other Worktree", it is cut with an ellipsis
// Usage: node packages/board/test/run-harness.mjs qpop dataclass segsep varmenu   screenshots: test-out/harness/fixq-*.png (SHOTS_DIR=… copies them)
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS, THEMES, emptyBoard, type CodeCard } from "@codeboard/core";
import { open, shot, put, symCard, findSym, OUT, REPO, type Host } from "./harness";
import { uid, type Segment } from "@codeboard/core";

const wait = (h: Host, ms = 600) => h.page.waitForTimeout(ms);
async function shotTo(h: Host, name: string) {
  await shot(h, name);
  const d = process.env.SHOTS_DIR;
  if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`)); }
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

export const FIXQ: Record<string, () => Promise<void>> = {
  qpop: () => run("qpop", qpop),
  dataclass: () => run("dataclass", dataclass),
  varmenu: () => run("varmenu", varmenu),
  segsep: () => run("segsep", segsep),
};

const setTheme = async (h: Host, theme: string, light: boolean) => {
  await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, theme } } as never });
  await h.page.evaluate((l) => { document.body.className = l ? "vscode-light" : "vscode-dark"; }, light);
  await wait(h, 400);
};

/** The open question popover: is anything clipped or wrapped? */
const measure = (h: Host) => h.page.evaluate(() => {
  const pop = document.querySelector(".pop.k-question") as HTMLElement;
  const body = pop.querySelector(".qbody") as HTMLElement;
  const p = pop.querySelector(".qtext p") as HTMLElement | null;
  const ph = p?.getAttribute("data-placeholder") ?? "";
  const cs = p && getComputedStyle(p, "::before");
  // how many lines the placeholder needs at this width (measured with its own font)
  const ctx = document.createElement("canvas").getContext("2d")!;
  if (cs) ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const lh = cs ? parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5 : 0;
  const need = p ? Math.ceil(ctx.measureText(ph).width / p.clientWidth) : 0;
  const pr = pop.getBoundingClientRect();
  // text lines of an element: distinct tops of its text's client rects
  const lines = (el: Element) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size; };
  const btns = [...pop.querySelectorAll(".qacts .tbtn")].map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent, h: Math.round(r.height), one: lines(b) === 1 && b.scrollWidth <= b.clientWidth + 1, inside: r.right <= pr.right + 0.5 }; });
  const hintEl = pop.querySelector(".qhint");
  const hint = hintEl?.getBoundingClientRect();
  return {
    need, pH: p ? Math.round(p.getBoundingClientRect().height) : 0, lh: Math.round(lh),
    phFits: !!p && p.getBoundingClientRect().height >= need * lh - 2,
    bodyClips: body.scrollHeight > body.clientHeight + 1,
    btns, hintInside: !!hint && hint.right <= pr.right + 0.5 && hint.left >= pr.left && lines(hintEl!) === 1,
    popW: Math.round(pr.width),
  };
});

async function qpop(res: Record<string, unknown>) {
  const b = emptyBoard("bQ", "nano-vllm · Scheduler");
  const alloc = nv("BlockManager.allocate");
  put(b, alloc, 60, 80, 640);
  const L = lineOf(alloc, /compute_hash/);
  b.stickers.push({ id: "kQ", icon: { pack: "builtin", name: "question" }, at: { kind: "line", card: alloc.id, seg: alloc.segments[0].id, line: L }, q: { md: "" } });
  const h = await open({ board: b, light: true, w: 1300, h: 800, settings: { theme: "drafting" } as never }), page = h.page;
  await page.keyboard.press("Shift+Digit1"); await wait(h, 800);
  // open the question and start editing it (empty: the placeholder shows)
  await page.locator(`[data-sticker="kQ"]`).first().click(); await wait(h, 500);
  await page.locator(".pop.k-question .qbody").dblclick(); await wait(h, 600);
  res.editing = await page.locator(".pop.k-question .ProseMirror").count();
  const bad: unknown[] = [];
  for (const light of [true, false]) for (const [theme] of THEMES) {
    await setTheme(h, theme, light);
    const m = await measure(h);
    if (!m.phFits || m.bodyClips || !m.btns.every((x) => x.one && x.inside) || !m.hintInside) bad.push({ theme, light, ...m });
    if (light && (theme === "drafting" || theme === "warm-ink")) await shotPopover(h, `fixq-qpop-${theme}`);
  }
  res.bad = bad;
  // with text: the box grows with the content, the footer still fits
  await setTheme(h, "drafting", true);
  await page.keyboard.type("Why does the hash chain include the previous block's h? $h_i = f(h_{i-1})$ and what if two prefixes share a block?");
  await wait(h, 300);
  const t = await measure(h);
  res.typed = { bodyClips: t.bodyClips, btns: t.btns.map((x) => x.h) };
  await shotPopover(h, "fixq-qpop-drafting-typed");
  await page.context().browser()!.close();
  return res.editing === 1 && bad.length === 0 && !t.bodyClips;
}
async function shotPopover(h: Host, name: string) {
  const r = await h.page.locator(".pop.k-question").boundingBox();
  await h.page.waitForTimeout(300);
  if (!r) return shotTo(h, name);
  await h.page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: Math.max(0, r.x - 40), y: Math.max(0, r.y - 40), width: r.width + 80, height: r.height + 80 } });
  const d = process.env.SHOTS_DIR;
  if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`)); }
}

async function dataclass(res: Record<string, unknown>) {
  // The class card as v0.2 hosts made it (members set): the board shows its code when the class has no methods
  const b = emptyBoard("bD", "nano-vllm · context");
  const ctx = nv("Context"), sch = nv("Scheduler");
  put(b, ctx, 60, 80, 560); put(b, sch, 700, 80, 560);
  const h = await open({ board: b, light: true, w: 1300, h: 800 }), page = h.page;
  await page.keyboard.press("Shift+Digit1"); await wait(h, 900);
  const card = page.locator(`.card[data-id="${ctx.id}"]`);
  res.lines = await card.locator(".src .no, .gutter .no").count();
  res.text = (await card.locator(".cbody").innerText()).replace(/\s+/g, " ");
  res.members = await card.locator(".members").count();
  res.schedMembers = await page.locator(`.card[data-id="${sch.id}"] .members .mrow`).count();
  await shotTo(h, "fixq-dataclass");
  await page.context().browser()!.close();
  const t = String(res.text);
  return res.members === 0 && t.includes("@dataclass(slots=True)") && t.includes("is_prefill: bool = False") && t.includes("block_tables") && (res.schedMembers as number) > 3;
}

async function varmenu(res: Record<string, unknown>) {
  const b = emptyBoard("bV", "nano-vllm");
  const sch = nv("Scheduler.schedule");
  put(b, sch, 60, 80, 640);
  const long = "/home/linda/src/very/deep/folder/for/experiments/nano-vllm-overlap-experiment";
  const h = await open({ board: b, light: true, w: 1300, h: 800, on: (m, reply) => {
    if (m.type === "variantSources") { void reply(m.req!, { worktrees: [{ dir: long, branch: "exp-overlap-scheduling-with-a-long-name", label: `exp-overlap-scheduling-with-a-long-name · ~/src/very/deep/folder/for/experiments/nano-vllm-overlap-experiment` }], branches: ["main"], current: "main", pr: "GeeeekExplorer/nano-vllm" }); return true; }
    return false;
  } }), page = h.page;
  await page.keyboard.press("Shift+Digit1"); await wait(h, 800);
  await page.locator(`.card[data-id="${sch.id}"] .chead`).click({ button: "right", position: { x: 140, y: 12 } }); await wait(h, 400);
  await page.locator(".ctx button", { hasText: /^Add Variant/ }).first().click(); await wait(h, 800);
  const it = page.locator(".ctx button", { hasText: "Other Worktree" }).first();
  res.item = await it.evaluate((el) => {
    const lb = el.querySelector(".lb") as HTMLElement, sm = el.querySelector("small") as HTMLElement;
    const menu = el.closest(".ctx")!.getBoundingClientRect();
    return { h: Math.round(el.getBoundingClientRect().height), lbH: Math.round(lb.getBoundingClientRect().height), cut: sm.scrollWidth > sm.clientWidth, title: sm.title, tip: (el as HTMLElement).title, menuW: Math.round(menu.width) };
  });
  await shotTo(h, "fixq-varmenu");
  await page.context().browser()!.close();
  const r = res.item as { h: number; lbH: number; cut: boolean; title: string; tip: string; menuW: number };
  return r.h <= 30 && r.lbH <= 20 && r.cut && r.title.includes("nano-vllm-overlap") && r.tip === long && r.menuW <= 310;
}

/** context.py lines a..b as a segment (as the host's ⌥B one-card path makes them) */
function ctxSeg(a: number, b: number, symbol?: Segment["symbol"]): Segment {
  const text = fs.readFileSync(path.join(REPO, "examples/nano-vllm/nanovllm/utils/context.py"), "utf8").split("\n");
  return { id: uid("s"), src: { kind: "repo", repo: "" }, path: "nanovllm/utils/context.py", lang: "python", start: a, end: b, text: text.slice(a - 1, b), version: { kind: "git", commit: "bb823b3c0ffee" }, symbol };
}

async function segsep(res: Record<string, unknown>) {
  const b = emptyBoard("bS", "nano-vllm · context");
  // Linda's board: the class card (made as a class card) above a card merged from get_context, set_context, reset_context
  const ctx = nv("Context");
  const three: CodeCard = { id: "cThree", kind: "code", segments: [nv("get_context"), nv("set_context"), nv("reset_context")].map((c) => c.segments[0]) };
  // ⌥B over lines 5–27 (one card): the class, _CONTEXT = Context() and the three functions
  const one: CodeCard = { id: "cOne", kind: "code", segments: [ctxSeg(5, 14, { qual: "Context", kind: "class" }), ctxSeg(16, 16, { qual: "<module>", kind: "module" }), ctxSeg(18, 19, { qual: "get_context", kind: "function" }), ctxSeg(21, 23, { qual: "set_context", kind: "function" }), ctxSeg(25, 27, { qual: "reset_context", kind: "function" })] };
  // two segments back to back: a divider with the definition's name
  const touch: CodeCard = { id: "cTouch", kind: "code", segments: [ctxSeg(18, 20, { qual: "get_context", kind: "function" }), ctxSeg(21, 23, { qual: "set_context", kind: "function" })] };
  put(b, ctx, 60, 60, 620); put(b, three, 60, 330, 900); put(b, one, 1000, 60, 900); put(b, touch, 1000, 640, 900);
  const h = await open({ board: b, light: true, w: 1900, h: 1000 }), page = h.page;
  await page.keyboard.press("Shift+Digit1"); await wait(h, 900);
  const sepOf = (id: string) => page.locator(`.card[data-id="${id}"] .src`).evaluate((el) => [...el.children].filter((k) => k.matches(".gap, .fnbar")).map((k) => (k.textContent ?? "").replace(/\s+/g, " ").trim()));
  res.three = await sepOf("cThree");
  res.one = await sepOf("cOne");
  res.touch = await sepOf("cTouch");
  await shotTo(h, "fixq-segsep");
  // merge the class card into the three-segment card: Context's segment comes first
  await page.locator(`.card[data-id="${ctx.id}"] .chead`).click({ position: { x: 300, y: 10 } }); await wait(h, 200);
  await page.locator(`.card[data-id="cThree"] .chead`).click({ position: { x: 400, y: 10 }, modifiers: ["Shift"] }); await wait(h, 300);
  await page.locator(`.card[data-id="cThree"] .chead`).click({ position: { x: 400, y: 10 }, button: "right" }); await wait(h, 400);
  const item = page.locator(".ctx button", { hasText: "Merge into One Card" });
  res.mergeDisabled = await item.isDisabled();
  await item.click(); await wait(h, 900);
  const m = h.board().cards.find((c) => c.kind === "code" && c.segments.length === 4) as CodeCard | undefined;
  res.merged = m?.segments.map((sg) => `${sg.symbol?.qual}:${sg.start}-${sg.end}`);
  res.mergedSep = m ? await sepOf(m.id) : null;
  res.mergedMembers = m ? await page.locator(`.card[data-id="${m.id}"] .members`).count() : -1;
  await shotTo(h, "fixq-segsep-merged");
  await page.context().browser()!.close();
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return eq(res.three, ["⋯ 1 line hidden (20)", "⋯ 1 line hidden (24)"])
    && eq(res.one, ["⋯ 1 line hidden (15)", "⋯ 1 line hidden (17)", "⋯ 1 line hidden (20)", "⋯ 1 line hidden (24)"])
    && eq(res.touch, ["set_context"])
    && res.mergeDisabled === false && eq(res.merged, ["Context:5-14", "get_context:18-19", "set_context:21-23", "reset_context:25-27"])
    && eq(res.mergedSep, ["⋯ 3 lines hidden (15–17)", "⋯ 1 line hidden (20)", "⋯ 1 line hidden (24)"]) && res.mergedMembers === 0;
}

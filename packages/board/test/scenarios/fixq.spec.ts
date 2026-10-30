//  qpop     — the question popover in every theme, light and dark: the placeholder is not clipped, the buttons never wrap
//  dataclass — nano-vllm utils/context.py: a fields-only @dataclass class card shows its code (decorator + fields), not an empty member list
//  segsep   — multi-segment cards show every segment boundary (⋯ N lines / a divider); a class card merges into one, segments by line
//  varmenu  — Add Variant menu: a long worktree path does not wrap "Other Worktree", it is cut with an ellipsis
//  fithide  — Fit Content on a card with Hide Docstrings / Comments / Blank Lines on: the width follows only the lines shown
//             (torch Module.get_parameter: the long docstring line and a long trailing comment must not count)
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SETTINGS, THEMES, emptyBoard, type CodeCard } from "@codeboard/core";
import { shot, put, symCard, findSym, files, ready, OUT, REPO, type Host } from "../harness";
import { analyze } from "@codeboard/analysis";
import { uid, type Segment } from "@codeboard/core";
import { test, open, light, verdict, expect, until, idle, check } from "../fixtures";

async function shotTo(h: Host, name: string) {
  await shot(h, name);
  const d = process.env.SHOTS_DIR;
  if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`)); }
}
const nv = (qual: string) => { const s = findSym(qual); return symCard(s.f, s.s); };
const lineOf = (c: CodeCard, re: RegExp) => { const s = c.segments[0]; return s.start + s.text.findIndex((t) => re.test(t)); };

test("qpop", () => verdict("qpop", qpop));

/** The question's text starts right at the top of its box: no browser paragraph margin above it, while editing (the placeholder)
 *  and when shown (usage feedback #88) */
test("questionTextNoTopGap", async () => {
  const b = emptyBoard("bQ", "q");
  const alloc = nv("BlockManager.allocate");
  put(b, alloc, 60, 80, 640);
  const L = alloc.segments[0].start + 3;
  b.stickers.push({ id: "kQ", icon: { pack: "builtin", name: "question" }, at: { kind: "line", card: alloc.id, seg: alloc.segments[0].id, line: L }, q: { md: "" } },
    { id: "kW", icon: { pack: "builtin", name: "question" }, at: { kind: "line", card: alloc.id, seg: alloc.segments[0].id, line: L + 4 }, q: { md: "Why here?\n\nSecond paragraph." } });
  const h = await open({ board: b, light: true, w: 1300, h: 800, settings: { theme: "warm-ink" } as never }), page = h.page;
  // gap between the text box's content edge and its first line
  const gap = () => page.evaluate(() => {
    const q = document.querySelector<HTMLElement>(".pop.k-question .qtext")!, p = q.querySelector("p")!;
    return +(p.getBoundingClientRect().top - q.getBoundingClientRect().top - parseFloat(getComputedStyle(q).paddingTop)).toFixed(1);
  });
  await page.locator('[data-sticker="kW"]').first().click();
  await page.locator(".pop.k-question .qtext p").first().waitFor(); await idle(h);
  const shown = await gap();
  await page.keyboard.press("Escape"); await idle(h);
  await page.locator('[data-sticker="kQ"]').first().click();
  await page.locator(".pop.k-question .qbody").dblclick();
  await page.locator(".pop.k-question .ProseMirror:focus").waitFor(); await idle(h);
  const editing = await gap();
  await shot(h, "questionTextNoTopGap");
  check("questionTextNoTopGap", Math.abs(shown) <= 0.5 && Math.abs(editing) <= 0.5, { shown, editing });
});

test("dataclass", () => verdict("dataclass", dataclass));

test("varmenu", () => verdict("varmenu", varmenu));

test("segsep", () => verdict("segsep", segsep));

test("fithide", () => verdict("fithide", fithide));

const setTheme = async (h: Host, theme: string, light: boolean) => {
  await h.post({ type: "host", host: { settings: { ...DEFAULT_SETTINGS, theme } } as never });
  await h.page.evaluate((l) => { document.body.className = l ? "vscode-light" : "vscode-dark"; }, light);
  await idle(h);
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
  await page.keyboard.press("Shift+Digit1"); await idle(h);
  // open the question and start editing it (empty: the placeholder shows)
  await page.locator(`[data-sticker="kQ"]`).first().click();
  await page.locator(".pop.k-question .qbody").dblclick();
  await page.locator(".pop.k-question .ProseMirror:focus").waitFor(); await idle(h);
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
  await expect(page.locator(".pop.k-question .ProseMirror")).toContainText("share a block?"); await idle(h);
  const t = await measure(h);
  res.typed = { bodyClips: t.bodyClips, btns: t.btns.map((x) => x.h) };
  await shotPopover(h, "fixq-qpop-drafting-typed");
  await page.context().close();
  return res.editing === 1 && bad.length === 0 && !t.bodyClips;
}
async function shotPopover(h: Host, name: string) {
  await idle(h);
  const r = await h.page.locator(".pop.k-question").boundingBox();
  if (!r) return shotTo(h, name);
  await h.page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { x: Math.max(0, r.x - 40), y: Math.max(0, r.y - 40), width: r.width + 80, height: r.height + 80 } });
  const d = process.env.SHOTS_DIR;
  if (d) { fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(OUT, `${name}.png`), path.join(d, `${name}.png`)); }
}

async function dataclass(res: Record<string, unknown>) {
  // The class card as hosts make it (members set): the board shows its code when the class has no methods
  const b = emptyBoard("bD", "nano-vllm · context");
  const ctx = nv("Context"), sch = nv("Scheduler");
  put(b, ctx, 60, 80, 560); put(b, sch, 700, 80, 560);
  const h = await open({ board: b, light: true, w: 1300, h: 800 }), page = h.page;
  await page.keyboard.press("Shift+Digit1"); await idle(h);
  const card = page.locator(`.card[data-id="${ctx.id}"]`);
  res.lines = await card.locator(".src .no, .gutter .no").count();
  res.text = (await card.locator(".cbody").innerText()).replace(/\s+/g, " ");
  res.members = await card.locator(".members").count();
  res.schedMembers = await page.locator(`.card[data-id="${sch.id}"] .members .mrow`).count();
  await shotTo(h, "fixq-dataclass");
  await page.context().close();
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
  await page.keyboard.press("Shift+Digit1"); await idle(h);
  await page.locator(`.card[data-id="${sch.id}"] .chead`).click({ button: "right", position: { x: 140, y: 12 } });
  await page.locator(".ctx button", { hasText: /^Add Variant/ }).first().click();
  const it = page.locator(".ctx button", { hasText: "Other Worktree" }).first();
  await it.waitFor(); await idle(h); // the submenu comes from the host's variantSources reply
  res.item = await it.evaluate((el) => {
    const lb = el.querySelector(".lb") as HTMLElement, sm = el.querySelector("small") as HTMLElement;
    const menu = el.closest(".ctx")!.getBoundingClientRect();
    return { h: Math.round(el.getBoundingClientRect().height), lbH: Math.round(lb.getBoundingClientRect().height), cut: sm.scrollWidth > sm.clientWidth, title: sm.title, tip: (el as HTMLElement).title, menuW: Math.round(menu.width) };
  });
  await shotTo(h, "fixq-varmenu");
  await page.context().close();
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
  // the class card (made as a class card) above a card merged from get_context, set_context, reset_context
  const ctx = nv("Context");
  const three: CodeCard = { id: "cThree", kind: "code", segments: [nv("get_context"), nv("set_context"), nv("reset_context")].map((c) => c.segments[0]) };
  // ⌥B over lines 5–27 (one card): the class, _CONTEXT = Context() and the three functions
  const one: CodeCard = { id: "cOne", kind: "code", segments: [ctxSeg(5, 14, { qual: "Context", kind: "class" }), ctxSeg(16, 16, { qual: "<module>", kind: "module" }), ctxSeg(18, 19, { qual: "get_context", kind: "function" }), ctxSeg(21, 23, { qual: "set_context", kind: "function" }), ctxSeg(25, 27, { qual: "reset_context", kind: "function" })] };
  // two segments back to back: a divider with the definition's name
  const touch: CodeCard = { id: "cTouch", kind: "code", segments: [ctxSeg(18, 20, { qual: "get_context", kind: "function" }), ctxSeg(21, 23, { qual: "set_context", kind: "function" })] };
  put(b, ctx, 60, 60, 620); put(b, three, 60, 330, 900); put(b, one, 1000, 60, 900); put(b, touch, 1000, 640, 900);
  const h = await open({ board: b, light: true, w: 1900, h: 1000 }), page = h.page;
  await page.keyboard.press("Shift+Digit1"); await idle(h);
  const sepOf = (id: string) => page.locator(`.card[data-id="${id}"] .src`).evaluate((el) => [...el.children].filter((k) => k.matches(".gap, .fnbar")).map((k) => (k.textContent ?? "").replace(/\s+/g, " ").trim()));
  res.three = await sepOf("cThree");
  res.one = await sepOf("cOne");
  res.touch = await sepOf("cTouch");
  await shotTo(h, "fixq-segsep");
  // merge the class card into the three-segment card: Context's segment comes first
  await page.locator(`.card[data-id="${ctx.id}"] .chead`).click({ position: { x: 300, y: 10 } });
  await page.locator(`.card.sel[data-id="${ctx.id}"]`).waitFor();
  await page.locator(`.card[data-id="cThree"] .chead`).click({ position: { x: 400, y: 10 }, modifiers: ["Shift"] });
  await expect(page.locator(".card.sel")).toHaveCount(2);
  await page.locator(`.card[data-id="cThree"] .chead`).click({ position: { x: 400, y: 10 }, button: "right" });
  const item = page.locator(".ctx button", { hasText: "Merge into One Card" });
  await item.waitFor();
  res.mergeDisabled = await item.isDisabled();
  await item.click();
  await until(h, "the merged card is saved", () => h.board().cards.some((c) => c.kind === "code" && c.segments.length === 4)); await idle(h);
  const m = h.board().cards.find((c) => c.kind === "code" && c.segments.length === 4) as CodeCard | undefined;
  res.merged = m?.segments.map((sg) => `${sg.symbol?.qual}:${sg.start}-${sg.end}`);
  res.mergedSep = m ? await sepOf(m.id) : null;
  res.mergedMembers = m ? await page.locator(`.card[data-id="${m.id}"] .members`).count() : -1;
  await shotTo(h, "fixq-segsep-merged");
  await page.context().close();
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return eq(res.three, ["⋯ 1 line hidden (20)", "⋯ 1 line hidden (24)"])
    && eq(res.one, ["⋯ 1 line hidden (15)", "⋯ 1 line hidden (17)", "⋯ 1 line hidden (20)", "⋯ 1 line hidden (24)"])
    && eq(res.touch, ["set_context"])
    && res.mergeDisabled === false && eq(res.merged, ["Context:5-14", "get_context:18-19", "set_context:21-23", "reset_context:25-27"])
    && eq(res.mergedSep, ["⋯ 3 lines hidden (15–17)", "⋯ 1 line hidden (20)", "⋯ 1 line hidden (24)"]) && res.mergedMembers === 0;
}

// torch/nn/modules/module.py, Module.get_parameter (trimmed): the docstring's first line is the longest line of the method,
// one code line has a long trailing comment, and the body sits 8 spaces deep (the card hides 4 of them)
const GET_PARAMETER = `class Module:
    def get_parameter(self, target: str) -> "Parameter":
        """Return the parameter given by \`\`target\`\` if it exists, otherwise throw an error.

        See the docstring for \`\`get_submodule\`\` for a more detailed
        explanation of this method's functionality as well as how to
        correctly specify \`\`target\`\`.
        """
        module_path, _, param_name = target.rpartition(".")

        # look up the module that owns the parameter; get_submodule raises if any part of the path is missing
        mod = self.get_submodule(module_path)

        if not hasattr(mod, param_name):
            raise AttributeError(param_name)  # the trailing comment is long enough to be the widest line if it counted

        param = getattr(mod, param_name)

        if not isinstance(param, torch.nn.Parameter):
            raise AttributeError("not an nn.Parameter")

        return param
`;

async function fithide(res: Record<string, unknown>) {
  await ready();
  const file = "torch/nn/modules/module.py";
  const text = GET_PARAMETER;
  const a = analyze("python", text);
  files.set(file, { text: text.split("\n"), a });
  const sym = a.symbols.find((s) => s.qual === "Module.get_parameter")!;
  const c = symCard(file, sym);
  c.hide = { docstrings: true, comments: true, blank: true };
  const b = emptyBoard("bF", "torch · module");
  put(b, c, 60, 60, 500);
  const h = await open({ board: b, light: true, w: 1400, h: 900 }), page = h.page;
  await idle(h);
  const card = page.locator(`.card[data-id="${c.id}"]`);
  const w0 = await card.evaluate((el) => (el as HTMLElement).offsetWidth);
  await card.locator(".chead").click({ position: { x: 200, y: 10 }, button: "right" });
  await page.locator(".ctx button", { hasText: "Fit Content" }).click();
  await until(h, "Fit Content changes the card's width", () => card.evaluate((el, w0) => (el as HTMLElement).offsetWidth !== w0, w0)); await idle(h);
  res.w = await card.evaluate((el) => (el as HTMLElement).offsetWidth); // the board's copy reaches the host later (patches are batched)
  // where the shown text really ends: the right edge of the rendered text of every code row, in board units, plus .src's right padding
  const m = await card.evaluate((el) => {
    const r0 = el.getBoundingClientRect(), z = r0.width / (el as HTMLElement).offsetWidth;
    const src = el.querySelector(".src") as HTMLElement;
    let right = 0;
    for (const l of src.querySelectorAll(":scope > .l")) {
      const r = document.createRange(); r.selectNodeContents(l);
      for (const x of r.getClientRects()) right = Math.max(right, (x.right - r0.left) / z);
    }
    const sc = el.querySelector(".cbody") as HTMLElement;
    return { rows: src.querySelectorAll(":scope > .l").length, textRight: Math.round(right), pad: parseFloat(getComputedStyle(src).paddingRight), overflow: sc.scrollWidth - sc.clientWidth };
  });
  Object.assign(res, m);
  const want = m.textRight + m.pad;
  res.want = Math.round(want);
  await shotTo(h, "fixq-fithide");
  await page.context().close();
  // fits the shown lines: no wider than the longest shown line plus padding (a few px of slack), and nothing cut off
  return m.rows === 9 && typeof res.w === "number" && Math.abs((res.w as number) - want) <= 12 && m.overflow <= 1;
}

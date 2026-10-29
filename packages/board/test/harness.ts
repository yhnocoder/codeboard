import * as fs from "node:fs";
import * as path from "node:path";
import type { Browser, Page } from "playwright-core";
import { launch } from "./chromium";
import { uid, emptyBoard, loadBoard, applyPatch, DEFAULT_SETTINGS, renderLine, type Board, type BoardToHost, type Card, type CodeCard, type Segment, type SegView, type HostToBoard, type CallSpan } from "@codeboard/core";
import { F_BLANK } from "@codeboard/analysis/basics";
import { tidy } from "@codeboard/core/tidy";
import { initAnalysis, analyze, varCandidates, importPkg, peekPlan, type FileAnalysis, type Sym } from "@codeboard/analysis";

/** The repo's root, defined by the builds that bundle this file (playwright.config.ts, run-perf.mjs) */
declare const REPO_ROOT: string;
export const REPO = REPO_ROOT;
const NV = path.join(REPO, "examples/nano-vllm");
// HARNESS_BOARD: another build of the board (harness.mjs --against=<ref> runs the scenarios on the build of an older commit)
const MEDIA = process.env.HARNESS_BOARD || path.join(REPO, "extensions/vscode/media/board");
export const OUT = path.join(REPO, "test-out/harness");

export const files = new Map<string, { text: string[]; a: FileAnalysis }>();
function walk(dir: string, out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (p.endsWith(".py")) out.push(p);
  }
  return out;
}
function load() {
  for (const p of walk(path.join(NV, "nanovllm"))) {
    const text = fs.readFileSync(p, "utf8");
    files.set(path.relative(NV, p), { text: text.split("\n"), a: analyze("python", text) });
  }
}
const allSyms = () => [...files.entries()].flatMap(([f, x]) => x.a.symbols.map((s) => ({ f, s })));

export function viewOf(seg: Segment): SegView {
  const f = files.get(seg.path);
  const a = f?.a;
  const html: string[] = [], flags: number[] = [], calls: CallSpan[] = [];
  const bare: Record<number, string> = {};
  for (let l = seg.start; l <= seg.end; l++) {
    const t = seg.text[l - seg.start] ?? "";
    const cs = (a?.calls ?? []).filter((c) => c.line === l);
    const marks = cs.map((c) => {
      // The workspace is only nanovllm: other imported packages are libraries
      const p = a && importPkg(a, c), pkg = p && p !== "nanovllm" ? p : undefined;
      calls.push({ line: l, col: c.col, end: c.end, name: c.name, recv: c.recv, loop: c.loop, dispatch: c.dispatch, pkg });
      return { col: c.col, end: c.end, idx: calls.length - 1, pkg };
    });
    const toks = tokenize(t);
    html.push(renderLine(toks, marks));
    flags.push(a?.flags[l - 1] ?? (t.trim() ? 0 : F_BLANK));
    const tr = a?.trailing[l];
    if (tr !== undefined) bare[l] = renderLine(toks, marks, tr);
  }
  const defs = (a?.symbols ?? []).filter((s) => s.defLine >= seg.start && s.defLine <= seg.end).map((s) => ({ line: s.defLine, name: s.name, qual: s.qual }));
  return { html, flags, calls, defs, bare };
}
// Crude Python highlighting: keywords, strings, comments, numbers
const KW = new Set("def return for in if else elif while and or not is None True False class break continue del import from as with lambda yield assert pass raise try except finally global nonlocal async await".split(" "));
function tokenize(t: string) {
  const out: { text: string; cls?: string }[] = [];
  const re = /(#.*$)|("""|'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_]\w*\b)|(\s+)|(.)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m[1]) out.push({ text: m[1], cls: "com" });
    else if (m[2]) out.push({ text: m[2], cls: "str" });
    else if (m[3]) out.push({ text: m[3], cls: "num" });
    else if (m[4]) out.push({ text: m[4], cls: KW.has(m[4]) ? "kw" : m[4] === "self" ? "self" : undefined });
    else out.push({ text: m[0], cls: m[6] ? "p" : undefined });
  }
  return out;
}

export function symCard(f: string, s: Sym): CodeCard {
  const file = files.get(f)!;
  const seg: Segment = {
    id: uid("s"), src: { kind: "repo", repo: "" }, path: f, lang: "python", start: s.start, end: s.end,
    text: file.text.slice(s.start - 1, s.end), version: { kind: "git", commit: "bb823b3c0ffee" },
    symbol: { qual: s.qual, kind: s.kind === "class" ? "class" : "function" },
  };
  return { id: uid("c"), kind: "code", segments: [seg], members: s.kind === "class" ? { shown: [] } : undefined };
}
export function put(b: Board, c: Card, x: number, y: number, w = 560) { b.cards.push(c); b.place[c.id] = { x, y, w }; }
export const findSym = (qual: string) => allSyms().find((x) => x.s.qual === qual)!;

export type PageCoverage = { url: string; source?: string; functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[] }[];

/**
 * Which functions of the page's scripts ran: V8's function-level precise coverage (binary, no block counters). The impact map only
 * needs "a function of this file ran"; Playwright's startJSCoverage records block counts, which slows hot code several times over
 * and so changes what the timing scenarios measure (noteFindTypingLatency: p50 3 ms → 16 ms)
 */
async function functionCoverage(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.startPreciseCoverage", { callCount: false, detailed: false });
  return {
    async take(): Promise<PageCoverage> {
      const { result } = await cdp.send("Profiler.takePreciseCoverage");
      return result.filter((r) => r.url.startsWith("file://")).map((r) => {
        let source: string | undefined;
        try { source = fs.readFileSync(new URL(r.url), "utf8"); } catch { source = undefined; }
        return { url: r.url, source, functions: r.functions };
      });
    },
  };
}

export type Host = { page: Page; board: () => Board; sent: BoardToHost[]; post: (m: HostToBoard) => Promise<void>; close: () => Promise<void> };

export async function ready() { await initAnalysis(); if (!files.size) load(); }

/** Lets a scenario play part of the host: return true if handled */
export type OnMsg = (m: BoardToHost & { req?: number }, reply: (req: number, data?: unknown, error?: string) => Promise<void>) => boolean | Promise<boolean>;

export type OpenOptions = { board?: Board; settings?: Partial<typeof DEFAULT_SETTINGS>; light?: boolean; w?: number; h?: number; beforeLoad?: (p: Page) => Promise<void>; on?: OnMsg; host?: Record<string, unknown>;
  /** "shown": return as soon as the board is on the page, without waiting for idle() (a scenario about the board's first moments,
   *  e.g. acting while the lazy Markdown queue is still filling in idle time) */
  until?: "idle" | "shown" };
/** What the caller does with the board's self-checks (a failed one is named by `check`) and, if given, with the page's coverage */
export type Watch = { fail: (check: string, detail: string) => void; coverage?: (entries: PageCoverage) => void };

export { launch };

/**
 * The sandbox is offline: a web address in a Note (an image at https://x.y/cat.png) can't load. Chromium reports that as a console
 * error "Failed to load resource: net::ERR_…" (never as a page error), with the address as its location. Only these network errors,
 * and only for http(s) addresses, are expected; anything else that doesn't load (a file of the board's own) fails the scenario
 */
const OFFLINE = /^Failed to load resource: net::(ERR_NAME_NOT_RESOLVED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_ADDRESS_UNREACHABLE)$/;

let pages = 0;
/** Opens the board in a new context of `browser`; closing the host (or its context) ends it */
export async function openBoard(browser: Browser, o: OpenOptions = {}, watch: Watch = { fail: (check, detail) => console.log("FAIL", check, detail) }): Promise<Host> {
  await ready();
  fs.mkdirSync(OUT, { recursive: true });
  // one page file per board: several Playwright workers run side by side
  const html = path.join(OUT, `index-${process.pid}-${++pages}.html`);
  // Like VS Code's webview wrapper (workbench/contrib/webview/browser/pre/index.html), the page cancels every dragover and drop on
  // the board's window with listeners added before the board's own
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${MEDIA}/board.css"></head>
<body class="${o.light ? "vscode-light" : "vscode-dark"}"><div id="root"></div>
<script>addEventListener("message", (e) => { if (e.data?.type === "init") window.__tInit = performance.now(); }, true); addEventListener("pointerdown", () => { window.__tDown = performance.now(); }, true);</script>
<script>addEventListener("dragover", (e) => e.preventDefault()); addEventListener("drop", (e) => e.preventDefault());</script>
<script>window.__inflight = 0; window.acquireVsCodeApi = () => ({ postMessage: (m) => { window.__inflight++; window.__host(JSON.stringify(m)).finally(() => window.__inflight--); } });</script>
<script type="module" src="file://${MEDIA}/board.js"></script></body></html>`);
  const context = await browser.newContext({ viewport: { width: o.w ?? 1400, height: o.h ?? 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  // coverage (nightly): which board code the scenario runs, for picking scenarios by changed file
  const cov = watch.coverage && (await functionCoverage(page));
  const closeContext = context.close.bind(context);
  let closed = false;
  context.close = async (opts) => {
    if (closed) return;
    closed = true;
    if (cov) watch.coverage!(await cov.take().catch(() => []));
    await closeContext(opts);
    fs.rmSync(html, { force: true });
  };
  // CPU_THROTTLE=4：把页面的 CPU 放慢几倍（CDP），在本机复现 CI 慢机器上才出现的时序问题
  if (+(process.env.CPU_THROTTLE ?? 0) > 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: +process.env.CPU_THROTTLE! });
  let board = o.board ?? emptyBoard("b1", "nano-vllm · generate");
  const sent: BoardToHost[] = [];
  const post = (m: HostToBoard) => page.evaluate((s) => window.postMessage(JSON.parse(s), "*"), JSON.stringify(m));
  const reply = (req: number, data?: unknown, error?: string) => post({ type: "reply", req, data, error });
  page.on("console", async (m) => {
    const text = m.text();
    // mutate's self-check (core danglingRefs): any hit is a failure in every scenario
    if (text.includes("dangling references")) return watch.fail("dangling-refs", text);
    if (m.type() !== "error" && m.type() !== "warning") return;
    const url = m.location().url;
    if (OFFLINE.test(text) && /^https?:/.test(url)) return; // expected here, see OFFLINE
    console.log(`[page ${m.type()}]`, text, url && !text.includes(url) ? `(${url})` : "");
    // an exception the board caught and only logged (console.error("mutate failed", e)), or a file of its own that didn't load
    const caught = (await Promise.all(m.args().map((a) => a.evaluate((v) => v instanceof Error).catch(() => false)))).some(Boolean);
    if (page.isClosed()) return; // the scenario is over
    if (caught) watch.fail("page-exception-logged", text);
    else if (text.startsWith("Failed to load resource")) watch.fail("page-resource-failed", `${text} ${url}`);
  });
  // an exception the board didn't catch (an event handler, a timer, a rejected promise): a failure in every scenario
  page.on("pageerror", (e) => watch.fail("page-error", e.stack || `${e.name}: ${e.message}`));
  await page.exposeFunction("__host", async (s: string) => {
    const m = JSON.parse(s) as BoardToHost & { req?: number };
    sent.push(m);
    if (o.on && (await o.on(m, reply))) return;
    switch (m.type) {
      case "ready": {
        const views: Record<string, SegView> = {};
        for (const k of board.cards) if (k.kind === "code") for (const sg of k.segments) views[sg.id] = viewOf(sg);
        for (const n of board.sidenotes) if (n.kind === "code") views[n.code.id] = viewOf(n.code);
        await post({ type: "init", board, boards: [{ id: board.id, name: board.name, cards: board.cards.length }], views, stale: {}, host: { isMac: true, assetBase: "", target: true, settings: { ...DEFAULT_SETTINGS, ...(o.settings ?? {}) }, ...(o.host ?? {}) } as any });
        break;
      }
      case "patch": {
        // The host's copy follows the patches; every version must load back through loadBoard (schema check)
        const next = structuredClone(board);
        applyPatch(next, m.patch);
        try { loadBoard(structuredClone(next)); } catch (e) { watch.fail("board-schema", (e as Error).message); }
        board = next; return reply(m.req, { skipped: 0 });
      }
      case "expand": {
        const want = m.pick ? allSyms().find((x) => x.f === m.pick!.path && (x.s.defLine === m.pick!.line || x.s.qual === m.pick!.qual)) : undefined;
        let cands = want ? [want] : allSyms().filter((x) => x.s.name === m.name || (m.name === x.s.qual.split(".")[0] && x.s.kind === "class"));
        if (m.name === "__init__" || /^[A-Z]/.test(m.name)) cands = cands.filter((x) => x.s.kind === "class" ? true : x.s.name === m.name);
        if (!cands.length) return reply(m.req, { none: true, reason: `No definition found for ${m.name}()` });
        if (cands.length > 1 && m.recv) { const r = cands.filter((x) => x.s.qual.toLowerCase().includes(m.recv!.replace(/^self\./, "").replace(/_/g, "").toLowerCase())); if (r.length) cands = r; }
        if (cands.length > 1) return reply(m.req, { pick: cands.map((x) => ({ label: x.s.qual, detail: `${x.f}:${x.s.defLine}`, path: x.f, line: x.s.defLine })) });
        const c = symCard(cands[0].f, cands[0].s);
        const call = files.get(m.seg.path)?.a.calls.find((k) => k.line === m.line && k.col === m.col);
        const vars = call ? varCandidates(call, cands[0].s) : [];
        return reply(m.req, { card: c, views: { [c.segments[0].id]: viewOf(c.segments[0]) }, vars, w: 560 });
      }
      case "views": return reply(m.req, Object.fromEntries(m.segs.map((s) => [s.id, viewOf(s)])));
      case "search": {
        const q = m.q.toLowerCase();
        const syms = allSyms().filter((x) => x.s.qual.toLowerCase().includes(q)).slice(0, 12).map((x) => ({ kind: "symbol" as const, label: x.s.qual, detail: `${x.f}:${x.s.defLine}`, path: x.f, line: x.s.defLine, sym: x.s.qual, glyph: x.s.kind === "class" ? "C" : "ƒ" }));
        const fl = [...files.keys()].filter((f) => f.toLowerCase().includes(q)).slice(0, 5).map((f) => ({ kind: "file" as const, label: path.basename(f), detail: path.dirname(f), path: f }));
        return reply(m.req, [...syms, ...fl]);
      }
      case "tidy": return reply(m.req, Object.fromEntries(await tidy(m.cards, m.links, m.fixed)));
      case "entryPoints": return reply(m.req, [{ kind: "entry", label: "LLM.generate", detail: "nanovllm/__init__.py export", path: "nanovllm/engine/llm_engine.py", line: 60, sym: "LLMEngine.generate" }]);
      case "searchPick": {
        const it = m.item as any;
        const x = allSyms().find((k) => k.s.qual === it.sym) ?? allSyms().find((k) => k.f === it.path);
        if (!x) return reply(m.req, null);
        const c = symCard(x.f, x.s);
        return reply(m.req, { card: c, views: { [c.segments[0].id]: viewOf(c.segments[0]) }, w: 560 });
      }
      case "peek": return reply(m.req, peekMock(m.seg, m.word));
      case "callVars": {
        const call = files.get(m.seg.path)?.a.calls.find((k) => k.line === m.line && k.col === m.col);
        const t = m.target.symbol && allSyms().find((x) => x.s.qual === m.target.symbol!.qual);
        if (!call || !t) return reply(m.req, []);
        const callee = t.s.kind === "class" ? allSyms().find((x) => x.s.qual === `${t.s.qual}.__init__`)?.s ?? t.s : t.s;
        return reply(m.req, varCandidates(call, callee));
      }
      case "diff": {
        const seg = m.seg;
        const right = seg.text.map((l, i) => (i === 3 ? l + "  # changed" : l));
        const ns = { ...seg, text: right, version: { kind: "git" as const, commit: "f64d8210" } };
        return reply(m.req, { title: `New Version · ${seg.symbol?.qual ?? seg.path}`, left: { label: "Pinned bb823b3", path: seg.path, start: seg.start, text: seg.text, html: viewOf(seg).html }, right: { label: "HEAD f64d821", path: seg.path, start: seg.start, text: right, html: viewOf(ns).html }, lastChange: "Last changed in f64d821 · fix chunked prefill · 2026-04-26", canUpdate: true, newSeg: ns, newView: viewOf(ns) });
      }
      case "commits": return reply(m.req, [{ commit: "f64d8210aa", msg: "fix chunked prefill bugs", date: "2026-04-26", head: true }, { commit: "bb823b3c0ffee", msg: "support chunked prefill", date: "2026-04-20" }]);
      case "paste": return reply(m.req, null);
      case "searchName": return reply(m.req, []);
      default: if (m.req) return reply(m.req, null);
    }
  });
  await o.beforeLoad?.(page);
  await page.goto(`file://${html}`);
  await page.waitForFunction(() => document.querySelector(".board"));
  const h: Host = { page, board: () => board, sent, post, close: () => context.close() };
  if (o.until !== "shown") await idle(h); // the board's first requests to the host answered, its first render and the camera at rest
  return h;
}

// Definition preview: lines taken per peekPlan, hover faked with docstrings (libraries use the fake data below)

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TORCH_MP = "torch.multiprocessing is a wrapper around the native [multiprocessing](https://docs.python.org/3/library/multiprocessing.html) module.\n\nIt registers custom reducers, that use shared memory to provide shared views on the same data in different processes. Once the tensor/storage is moved to shared_memory (see `share_memory_()`), it will be possible to send it to other processes without making any copies.\n\nThe API is 100% compatible with the original module - it's enough to change `import multiprocessing` to `import torch.multiprocessing` to have all the tensors sent through the queues or shared via other mechanisms, moved to shared memory.";
const LIB_FN = ["    def get_context(self, method=None):", "        if method is None:", "            if self._actual_context is None:", "                self._actual_context = self._default_context", "            return self._actual_context", "        else:", "            return super().get_context(method)"];
const libSeg = (path: string, text: string[], start: number): Segment => ({ id: uid("s"), src: { kind: "external", root: "/usr/lib/python3.12" }, path, lang: "python", start, end: start + text.length - 1, text, version: { kind: "hash", hash: "3a7b" } });

export function peekMock(seg: Segment, word: string): any {
  const src = files.get(seg.path);
  const im = src?.a.imports.find((i) => i.name === word && !i.from);
  if (im) {
    const lib = im.module.split(".")[0];
    return { path: im.module.replace(/\./g, "/") + "/__init__.py", line: 1, start: 1, text: [], html: [], seg: libSeg("torch/multiprocessing/__init__.py", ["# mypy: allow-untyped-defs"], 1), kind: "module", rows: [], sig: `(module) ${word}`, sigHtml: `<span class="p">(</span>module<span class="p">)</span> ${esc(word)}`, doc: im.module === "torch.multiprocessing" ? TORCH_MP : undefined, lib, title: im.module.replace(/\./g, "/") };
  }
  if (word === "get_context" && src?.text.some((l) => /mp\.get_context/.test(l))) {
    const s = libSeg("multiprocessing/context.py", LIB_FN, 186);
    return { path: "/usr/lib/python3.12/multiprocessing/context.py", line: 186, start: 186, text: LIB_FN.slice(0, 4), html: LIB_FN.slice(0, 4).map((t) => renderLine(tokenize(t))), seg: s, kind: "function", rows: [186, 187, 188, 189], more: 3, sig: "(method) def get_context(method: str | None = None) -> BaseContext", sigHtml: renderLine(tokenize("(method) def get_context(method: str | None = None) -> BaseContext")), lib: "multiprocessing" };
  }
  // Where it's defined: function / class → class field → self.x assignment
  let at: { f: string; line: number } | undefined;
  const sym = allSyms().find((k) => k.s.name === word);
  if (sym) at = { f: sym.f, line: sym.s.defLine };
  const re = new RegExp(`^\\s+(self\\.)?${word}\\s*(:[^=]*)?=(?!=)`);
  if (!at) for (const [f, x] of files) { const i = x.text.findIndex((l) => re.test(l)); if (i >= 0) { at = { f, line: i + 1 }; break; } }
  if (!at) return { none: "No definition found", word };
  const f = files.get(at.f)!;
  const plan = peekPlan(f.a, f.text, at.line, { word });
  const rows = plan.rows;
  const s: Segment = { id: uid("s"), src: { kind: "repo", repo: "" }, path: at.f, lang: "python", start: rows[0], end: rows[rows.length - 1], text: f.text.slice(rows[0] - 1, rows[rows.length - 1]), version: { kind: "git", commit: "bb823b3" } };
  return {
    path: at.f, line: at.line, start: rows[0], rows, text: rows.map((l) => f.text[l - 1]), html: rows.map((l) => renderLine(tokenize(f.text[l - 1] ?? ""))), seg: s,
    kind: plan.kind, head: plan.head, more: plan.more, sig: plan.sig, sigHtml: plan.sig ? renderLine(tokenize(plan.sig)) : undefined, doc: plan.doc,
  };
}

/** A screenshot into test-out/harness/, once the board is idle(). `at: "now"` takes it at once: a picture of something on its
 *  way (mid-animation), the moment chosen by the caller */
export async function shot(h: Host, name: string, at: "idle" | "now" = "idle") {
  if (at === "idle") await idle(h);
  await h.page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

/**
 * Waits until the board has settled: no board message still being handled by the host (window.__inflight, counted in the page
 * file above until the handler returns, i.e. after its reply was posted), the camera at rest (.world neither .moving nor
 * .settle), no finite Web Animation or CSS transition running (infinite ones, like spinners and animated stickers, don't count),
 * fonts loaded, and no card moved or resized (their inline styles: the pop-in, slide, fold and grow springs) for `frames` frames
 * in a row. Throws after `ms`, saying what was still busy.
 */
export async function idle(h: Host, ms = 5000, frames = 3) {
  const t0 = Date.now();
  await h.page.evaluate(() => { (window as any).__quiet = { n: 0, key: "\0", busy: [] }; });
  try {
    await h.page.waitForFunction((need) => {
      const w = window as any, q = w.__quiet;
      const world = document.querySelector(".world") as HTMLElement | null;
      const anims = document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime));
      q.busy = [
        w.__inflight > 0 && `${w.__inflight} message(s) waiting on the host`,
        document.fonts.status !== "loaded" && "fonts loading",
        world?.matches(".moving, .settle") && "camera moving",
        anims.length > 0 && `animations: ${anims.map((a) => (a as CSSTransition).transitionProperty ?? (a as CSSAnimation).animationName ?? "?").join(", ")}`,
      ].filter(Boolean);
      let key = world?.style.transform ?? "";
      for (const el of document.querySelectorAll<HTMLElement>(".card, .carea")) key += "|" + el.style.cssText;
      if (key !== q.key) q.busy.push("cards moving");
      q.n = q.busy.length ? 0 : q.n + 1;
      q.key = key;
      return q.n >= need;
    }, frames, { polling: "raf", timeout: ms });
    if (process.env.IDLE_DEBUG) console.log("IDLE", Date.now() - t0, "ms", new Error().stack!.split("\n")[2].trim()); // which waits take long
  } catch (e) {
    if (h.page.isClosed()) throw e;
    const busy = await h.page.evaluate(() => (window as any).__quiet.busy as string[]).catch(() => ["page gone"]);
    throw new Error(`idle: the board did not settle within ${ms} ms (${busy.join("; ") || "?"})`);
  }
}

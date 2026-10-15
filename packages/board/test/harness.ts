// 浏览器里测白板：Chromium 打开白板页面，Node 这边扮演宿主（读 nano-vllm、分析、回消息）。
// 不需要 VS Code，改白板界面时快速看效果、截图、跑交互脚本。
// 用法：node packages/board/test/run-harness.mjs <脚本名> [--light]   截图在 test-out/harness/
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, type Page } from "playwright-core";
import { uid, emptyBoard, F_BLANK, F_COMMENT, F_DOCSTRING, renderLine, type Board, type BoardToHost, type CodeCard, type Segment, type SegView, type HostToBoard, type CallSpan } from "@codeboard/core";
import { initAnalysis, analyze, symbolAt, varCandidates, type FileAnalysis, type Sym } from "@codeboard/core/analysis";

export const REPO = path.resolve(__dirname, "../.."); // 打包后在 test-out/harness/
const NV = path.join(REPO, "examples/nano-vllm");
const MEDIA = path.join(REPO, "extensions/vscode/media/board");
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
    const marks = cs.map((c) => { calls.push({ line: l, col: c.col, end: c.end, name: c.name, recv: c.recv, loop: c.loop, dispatch: c.dispatch }); return { col: c.col, end: c.end, idx: calls.length - 1 }; });
    const toks = tokenize(t);
    html.push(renderLine(toks, marks));
    flags.push(a?.flags[l - 1] ?? (t.trim() ? 0 : F_BLANK));
    const tr = a?.trailing[l];
    if (tr !== undefined) bare[l] = renderLine(toks, marks, tr);
  }
  const defs = (a?.symbols ?? []).filter((s) => s.defLine >= seg.start && s.defLine <= seg.end).map((s) => ({ line: s.defLine, name: s.name, qual: s.qual }));
  return { html, flags, calls, defs, bare };
}
// 粗糙的 Python 着色：关键字、字符串、注释、数字
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
  return { id: uid("c"), kind: "code", segments: [seg], x: 0, y: 0, w: 560, members: s.kind === "class" ? { shown: [] } : undefined };
}
export const findSym = (qual: string) => allSyms().find((x) => x.s.qual === qual)!;

export type Host = { page: Page; board: () => Board; sent: BoardToHost[]; post: (m: HostToBoard) => Promise<void> };

export async function ready() { await initAnalysis(path.join(REPO, "node_modules/@vscode/tree-sitter-wasm/wasm")); if (!files.size) load(); }

export async function open(o: { board?: Board; light?: boolean; w?: number; h?: number; beforeLoad?: (p: Page) => Promise<void> } = {}): Promise<Host> {
  await ready();
  if (!files.size) load();
  fs.mkdirSync(OUT, { recursive: true });
  const html = path.join(OUT, "index.html");
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="file://${MEDIA}/board.css"></head>
<body class="${o.light ? "vscode-light" : "vscode-dark"}"><div id="root"></div>
<script>addEventListener("message", (e) => { if (e.data?.type === "init") window.__tInit = performance.now(); }, true); addEventListener("pointerdown", () => { window.__tDown = performance.now(); }, true);</script>
<script>window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__host(JSON.stringify(m)) });</script>
<script src="file://${MEDIA}/board.js"></script></body></html>`);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--allow-file-access-from-files"] });
  const page = await browser.newPage({ viewport: { width: o.w ?? 1400, height: o.h ?? 900 }, deviceScaleFactor: 1 });
  let board = o.board ?? emptyBoard("b1", "nano-vllm · generate");
  const sent: BoardToHost[] = [];
  const post = (m: HostToBoard) => page.evaluate((s) => window.postMessage(JSON.parse(s), "*"), JSON.stringify(m));
  const reply = (req: number, data?: unknown, error?: string) => post({ type: "reply", req, data, error });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[page ${m.type()}]`, m.text()); });
  page.on("pageerror", (e) => console.log("[page error]", e.message));
  await page.exposeFunction("__host", async (s: string) => {
    const m = JSON.parse(s) as BoardToHost & { req?: number };
    sent.push(m);
    switch (m.type) {
      case "ready": {
        const views: Record<string, SegView> = {};
        for (const c of board.cards) for (const k of c.kind === "compare" ? c.cols : [c]) if (k.kind === "code") for (const sg of k.segments) views[sg.id] = viewOf(sg);
        for (const n of board.sidenotes) if (n.kind === "code") views[n.code.id] = viewOf(n.code);
        await post({ type: "init", board, boards: [{ id: board.id, name: board.name, cards: board.cards.length }], views, stale: {}, host: { isMac: true, assetBase: "", target: true } });
        break;
      }
      case "save": board = m.board; break;
      case "expand": {
        const want = m.pick ? allSyms().find((x) => x.f === m.pick!.path && x.s.defLine === m.pick!.line) : undefined;
        let cands = want ? [want] : allSyms().filter((x) => x.s.name === m.name || (m.name === x.s.qual.split(".")[0] && x.s.kind === "class"));
        if (m.name === "__init__" || /^[A-Z]/.test(m.name)) cands = cands.filter((x) => x.s.kind === "class" ? true : x.s.name === m.name);
        if (!cands.length) return reply(m.req, { none: true, reason: `No definition found for ${m.name}()` });
        if (cands.length > 1 && m.recv) { const r = cands.filter((x) => x.s.qual.toLowerCase().includes(m.recv!.replace(/^self\./, "").replace(/_/g, "").toLowerCase())); if (r.length) cands = r; }
        if (cands.length > 1) return reply(m.req, { pick: cands.map((x) => ({ label: x.s.qual, detail: `${x.f}:${x.s.defLine}`, path: x.f, line: x.s.defLine })) });
        const c = symCard(cands[0].f, cands[0].s);
        const call = files.get(m.seg.path)?.a.calls.find((k) => k.line === m.line && k.col === m.col);
        const vars = call ? varCandidates(call, cands[0].s) : [];
        return reply(m.req, { card: c, views: { [c.segments[0].id]: viewOf(c.segments[0]) }, vars });
      }
      case "views": return reply(m.req, Object.fromEntries(m.segs.map((s) => [s.id, viewOf(s)])));
      case "search": {
        const q = m.q.toLowerCase();
        const syms = allSyms().filter((x) => x.s.qual.toLowerCase().includes(q)).slice(0, 12).map((x) => ({ kind: "symbol" as const, label: x.s.qual, detail: `${x.f}:${x.s.defLine}`, path: x.f, line: x.s.defLine, sym: x.s.qual, glyph: x.s.kind === "class" ? "C" : "ƒ" }));
        const fl = [...files.keys()].filter((f) => f.toLowerCase().includes(q)).slice(0, 5).map((f) => ({ kind: "file" as const, label: path.basename(f), detail: path.dirname(f), path: f }));
        return reply(m.req, [...syms, ...fl]);
      }
      case "entryPoints": return reply(m.req, [{ kind: "entry", label: "LLM.generate", detail: "nanovllm/__init__.py export", path: "nanovllm/engine/llm_engine.py", line: 60, sym: "LLMEngine.generate" }]);
      case "searchPick": {
        const it = m.item as any;
        const x = allSyms().find((k) => k.s.qual === it.sym) ?? allSyms().find((k) => k.f === it.path);
        if (!x) return reply(m.req, null);
        const c = symCard(x.f, x.s);
        return reply(m.req, { card: c, views: { [c.segments[0].id]: viewOf(c.segments[0]) } });
      }
      case "peek": {
        const x = allSyms().find((k) => k.s.name === m.word);
        if (!x) return reply(m.req, { none: "No definition found", word: m.word });
        const f = files.get(x.f)!;
        const start = Math.max(1, x.s.defLine - 1), end = Math.min(f.text.length, x.s.defLine + 3);
        const seg: Segment = { id: uid("s"), src: { kind: "repo", repo: "" }, path: x.f, lang: "python", start, end, text: f.text.slice(start - 1, end), version: { kind: "git", commit: "bb823b3" } };
        return reply(m.req, { path: x.f, line: x.s.defLine, start, html: viewOf(seg).html, text: seg.text, seg });
      }
      case "diff": {
        const seg = m.seg;
        const right = seg.text.map((l, i) => (i === 3 ? l + "  # changed" : l));
        const ns = { ...seg, text: right, version: { kind: "git" as const, commit: "f64d8210" } };
        return reply(m.req, { title: `New Version · ${seg.symbol?.qual ?? seg.path}`, left: { label: "Pinned bb823b3", path: seg.path, start: seg.start, text: seg.text, html: viewOf(seg).html }, right: { label: "HEAD f64d821", path: seg.path, start: seg.start, text: right, html: viewOf(ns).html }, lastChange: "Last changed in f64d821 · fix chunked prefill · 2026-04-26", canUpdate: true, newSeg: ns, newView: viewOf(ns) });
      }
      case "commits": return reply(m.req, [{ commit: "f64d8210aa", msg: "fix chunked prefill bugs", date: "2026-04-26", head: true }, { commit: "bb823b3c0ffee", msg: "support chunked prefill", date: "2026-04-20" }]);
      case "paste": return reply(m.req, null);
      case "source": return reply(m.req, { html: viewOf({ ...m.seg, start: 1, end: files.get(m.seg.path)!.text.length, text: files.get(m.seg.path)!.text }).html, start: 1 });
      default: if (m.req) return reply(m.req, null);
    }
  });
  await o.beforeLoad?.(page);
  await page.goto(`file://${html}`);
  await page.waitForFunction(() => document.querySelector(".board"));
  await page.waitForTimeout(300);
  return { page, board: () => board, sent, post };
}

export async function shot(h: Host, name: string) {
  await h.page.waitForTimeout(450);
  await h.page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

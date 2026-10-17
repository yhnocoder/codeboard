// Host resolution without a language service (as in the cloud sandbox): #33 members of a class card outside the workspace, #32 Qwen3ForCausalLM variable candidates, #3 #4 preview fallbacks, #34 library calls.
// Usage: node extensions/vscode/test/run-host-resolve.mjs (runs on a copy of nano-vllm)
import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { CodeCard, ExpandPick, ExpandResult, PeekDef, Segment } from "@codeboard/core";
import { startAnalysis, analysisOf, segAnalysis } from "../src/analysis";
import { clipAnalysis } from "@codeboard/core/analysis";
import { cardForFileSym } from "../src/cards";
import { callVars, expand, forgetLspSeen, peek } from "../src/resolve";
import { viewsFor } from "../src/views";
import { forgetDefs } from "../src/defcache";
import { prefetchCall, warmBoard } from "../src/prefetch";
import { langOf, useWorkspace } from "../src/ws";
import { searchName } from "../src/search";
import { allNames, lookupName, nameIndexReady, resetIndex, startNameIndex, watchNameIndex, type IndexEntry } from "../src/nameindex";
import { WS, nodeWorkspace } from "./node-workspace";
import { emptyBoard, skeletonOf, type BoardToHost, type Camera, type Crumb, type HostToBoard, type WalkHop } from "@codeboard/core";
import { Storage } from "@codeboard/core/storage";
import { nodeFs } from "../src/nodefs";
import { makeHandler } from "../src/handlers";
import { BoardPanel, type BoardHost, type BoardView } from "../src/boards";
import { treeChildren } from "../src/boardtree";

const W = nodeWorkspace();
useWorkspace(W);

const REPO = path.resolve(__dirname, ".."); // bundled into test-out/
const EXT = "/tmp/codeboard-perf/ext/multiprocessing"; // not git, not in site-packages: external root = this folder
let failed = 0;
const check = (ok: unknown, what: string, extra?: unknown) => { console.log(`${ok ? "✓" : "✗"} ${what}${!ok && extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 400) : ""}`); if (!ok) failed++; };

async function card(abs: string, qual: string): Promise<{ card: CodeCard; seg: Segment }> {
  const text = fs.readFileSync(abs, "utf8");
  const sym = analysisOf("python", text).symbols.find((s) => s.qual === qual)!;
  const nc = (await cardForFileSym(abs, sym))!;
  const c = nc.card as CodeCard;
  return { card: c, seg: c.segments[0] };
}
const lineOf = (seg: Segment, re: RegExp) => seg.start + seg.text.findIndex((l) => re.test(l));

void (async () => {
  if (!fs.existsSync(WS)) execFileSync("git", ["clone", "-q", path.join(REPO, "examples/nano-vllm"), WS]);
  fs.mkdirSync(EXT, { recursive: true });
  fs.writeFileSync(path.join(EXT, "__init__.py"), "");
  fs.writeFileSync(path.join(EXT, "shared_memory.py"), `import os\n\n\nclass SharedMemory:\n    """Creates a new shared memory block."""\n\n    _name = None\n\n    def __init__(self, name=None, create=False, size=0):\n        if not size >= 0:\n            raise ValueError("bad size")\n        self._size = size\n\n    def close(self):\n        os.close(self._fd)\n`);
  await startAnalysis(path.join(REPO, "node_modules/@vscode/tree-sitter-wasm/wasm"));

  // #33: class card from a file outside the workspace, click member __init__
  const shm = await card(path.join(EXT, "shared_memory.py"), "SharedMemory");
  check(shm.seg.src.kind === "external" && shm.seg.path === "shared_memory.py", "Class card outside workspace: path relative to external root", shm.seg);
  const pick = { path: shm.seg.path, line: 9 };
  const bad = await expand({ seg: shm.seg, line: 9, col: 0, name: "__init__", pick });
  check("none" in bad, "Old pick (treated as workspace path) is not found (reproduces #33)");
  const ok = await expand({ seg: shm.seg, line: 9, col: 0, name: "__init__", pick: { ...pick, rel: true, qual: "SharedMemory.__init__" } });
  check("card" in ok && ok.card.segments[0].symbol?.qual === "SharedMemory.__init__", "rel pick: expands SharedMemory.__init__", ok);
  const moved = await expand({ seg: shm.seg, line: 3, col: 0, name: "__init__", pick: { ...pick, line: 3, rel: true, qual: "SharedMemory.__init__" } });
  check("card" in moved, "Pinned version line moved: found by qual");

  // #32: self.model = Qwen3ForCausalLM(hf_config), click to expand → variable candidates
  const mr = await card(path.join(WS, "nanovllm/engine/model_runner.py"), "ModelRunner.__init__");
  const l31 = lineOf(mr.seg, /Qwen3ForCausalLM\(hf_config\)/);
  const col = mr.seg.text[l31 - mr.seg.start].indexOf("Qwen3ForCausalLM");
  const r = await expand({ seg: mr.seg, line: l31, col, name: "Qwen3ForCausalLM" }) as ExpandResult;
  check("card" in r && r.card.segments[0].symbol?.qual === "Qwen3ForCausalLM", "Click Qwen3ForCausalLM expands a class card", r);
  const want = [{ a: "hf_config", b: "config" }, { a: "self.model", ret: true }];
  check("card" in r && JSON.stringify(r.vars) === JSON.stringify(want), "Expand by click carries variable candidates hf_config → config, self.model", "card" in r ? r.vars : r);
  // Still matches when the segment text differs from the workspace (only the segment can be analyzed)
  const snip = { ...mr.seg, version: { kind: "hash" as const, hash: "x" }, text: mr.seg.text.map((t, i) => (i === 0 ? t + "  " : t)) };
  const r2 = await expand({ seg: snip, line: l31, col, name: "Qwen3ForCausalLM" }) as ExpandResult;
  check("card" in r2 && r2.vars.length === 2, "callSite matches with segment text only", "card" in r2 ? r2.vars : r2);
  // Drag onto an existing card
  const q = await card(path.join(WS, "nanovllm/models/qwen3.py"), "Qwen3ForCausalLM");
  const vs = await callVars({ seg: mr.seg, line: l31, col, name: "Qwen3ForCausalLM", target: q.seg });
  check(JSON.stringify(vs) === JSON.stringify(want), "Drag onto existing class card: variable candidates", vs);
  const lm = await card(path.join(WS, "nanovllm/utils/loader.py"), "load_model");
  const l32 = lineOf(mr.seg, /load_model\(self\.model/);
  const vs2 = await callVars({ seg: mr.seg, line: l32, col: mr.seg.text[l32 - mr.seg.start].indexOf("load_model"), name: "load_model", target: lm.seg });
  check(JSON.stringify(vs2) === JSON.stringify([{ a: "self.model", b: "model" }, { a: "config.model", b: "path" }]), "Drag onto existing function card: variable candidates", vs2);

  // #3 #4: preview fallbacks (docstring / field / function / module)
  const eng = await card(path.join(WS, "nanovllm/engine/llm_engine.py"), "LLMEngine.__init__");
  const at = (seg: Segment, re: RegExp, word: string) => { const line = lineOf(seg, re); return { seg, line, col: seg.text[line - seg.start].indexOf(word), word }; };
  const fld = await peek(at(eng.seg, /config\.kvcache_block_size/, "kvcache_block_size")) as PeekDef;
  check(fld?.kind === "field" && fld.rows?.length === 11 && fld.head === "class Config" && fld.line === 17, "Field: all fields of the class", fld && { kind: fld.kind, rows: fld.rows, head: fld.head });
  const fn = await peek(at(mr.seg, /load_model\(self\.model/, "load_model")) as PeekDef;
  check(fn?.kind === "function" && fn.more && fn.sig?.startsWith("(function) def load_model") && !fn.lib, "Function: signature + first lines + ⋯ more", fn && { kind: fn.kind, sig: fn.sig, more: fn.more });
  const mod = await peek(at(eng.seg, /mp\.get_context/, "mp")) as PeekDef;
  check(mod?.kind === "module" && !mod.html.length && mod.lib === "torch" && mod.title === "torch/multiprocessing", "Module: signature / docs only, marked library", mod);
  const sch = await card(path.join(WS, "nanovllm/engine/scheduler.py"), "Scheduler.schedule");
  const self = await peek(at(sch.seg, /self\.max_num_seqs/, "self.max_num_seqs")) as PeekDef;
  check(self?.kind === "field" && (self.rows?.length ?? 0) > 2, "self.x: all self assignments in __init__", self && { kind: self.kind, rows: self.rows });

  // #34: library calls carry the package name
  const v = (await viewsFor([mr.seg]))[mr.seg.id];
  const pk = (n: string) => v.calls.find((c) => c.name === n)?.pkg;
  check(pk("set_device") === "torch" && pk("init_process_group") === "torch" && pk("SharedMemory") === "multiprocessing", "torch.* / multiprocessing.* are library", v.calls.map((c) => [c.name, c.pkg]));
  check(!pk("Qwen3ForCausalLM") && !pk("load_model") && !pk("warmup_model"), "nanovllm and self.x are project");
  check(v.html.some((h) => h.includes('data-p="torch"')), "Library calls carry data-p in HTML");
  const ve = (await viewsFor([shm.seg]))[shm.seg.id];
  check(ve.calls.length > 0 && ve.calls.every((c) => c.pkg === "multiprocessing" || c.pkg === "os"), "Calls in files outside the workspace are all library", ve.calls.map((c) => [c.name, c.pkg]));

  // Hover prefetch: the definition request is shared with the click, keyed by file + position + content
  {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const schAbs = path.join(WS, "nanovllm/engine/scheduler.py");
    const defLine = analysisOf("python", fs.readFileSync(schAbs, "utf8")).symbols.find((x) => x.qual === "Scheduler.schedule")!.defLine;
    let calls = 0, live = 0, maxLive = 0, delay = 60, empty = false;
    const orig = W.language.definitions;
    W.language.definitions = async () => {
      calls++; live++; maxLive = Math.max(maxLive, live);
      await sleep(delay);
      live--;
      return empty ? [] : [{ abs: schAbs, line: defLine, col: 8 }];
    };
    const step = await card(path.join(WS, "nanovllm/engine/llm_engine.py"), "LLMEngine.step");
    const sl = lineOf(step.seg, /self\.scheduler\.schedule\(\)/);
    const req = { seg: step.seg, line: sl, col: step.seg.text[sl - step.seg.start].indexOf("schedule("), name: "schedule" };
    const isSchedule = (r: ExpandResult) => "card" in r && r.card.segments[0].symbol?.qual === "Scheduler.schedule";
    forgetDefs();
    prefetchCall(req);
    await sleep(5);
    const r1 = await expand(req);
    check(isSchedule(r1) && calls === 1, "Click during an in-flight prefetch reuses its definition request", { calls });
    const r2 = await expand(req);
    check(isSchedule(r2) && calls === 1, "Second click uses the cached definition", { calls });
    check("card" in r1 && "card" in r2 && r1.card.id !== r2.card.id, "Each click still builds a fresh card (no reused ids)");
    forgetDefs();
    await expand(req);
    check(calls === 2, "forgetDefs (file changed) drops cached definitions", { calls });
    // The calling file's content changed (open editor with unsaved edits): different key, asks again
    const llmAbs = path.join(WS, "nanovllm/engine/llm_engine.py");
    const edited = fs.readFileSync(llmAbs, "utf8") + "\n# edited\n";
    W.open.set(llmAbs, edited);
    const r3 = await expand(req);
    check(isSchedule(r3) && calls === 3, "Changed file content is a cache miss", { calls });
    W.open.clear();
    // Empty answers (language server still starting) are not cached
    forgetDefs(); empty = true;
    prefetchCall(req);
    await sleep(delay + 30);
    empty = false;
    const r4 = await expand(req);
    check(isSchedule(r4) && calls === 5, "Empty prefetch answer is not reused by the click", { calls });
    // Concurrency cap: many hovers in a row run at most 2 at a time and drop the oldest queued ones
    forgetDefs(); calls = 0; maxLive = 0; delay = 80;
    const sites = analysisOf("python", fs.readFileSync(llmAbs, "utf8")).calls.filter((c) => c.line >= step.seg.start && c.line <= step.seg.end);
    for (let i = 0; i < 12; i++) { const c = sites[i % sites.length]; prefetchCall({ seg: step.seg, line: c.line, col: c.col, name: c.name }); }
    await sleep(800);
    check(maxLive <= 2 && calls <= 6, "Prefetch queue: at most 2 running, older queued hovers dropped", { maxLive, calls, sites: sites.length });
    // Board open warm-up: one definition request per distinct file, in the background, sequential
    forgetDefs(); calls = 0; maxLive = 0; delay = 20;
    const t0 = Date.now();
    warmBoard([step.seg, eng.seg, mr.seg, sch.seg], () => true);
    check(calls === 0 && Date.now() - t0 < 50, "warmBoard returns at once and waits before asking");
    await sleep(2500);
    check(calls === 3 && maxLive === 1, "warmBoard: one request per distinct file, one at a time", { calls, maxLive });
    W.language.definitions = orig;
  }

  // Name index: looking a name up does not wait for the whole index, gives the same entries as a full scan, and follows file changes
  {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    watchNameIndex();
    resetIndex();
    const finds = W.finds;
    const files = await W.files.findFiles("**/*.{py,pyi,cu,cuh,cc,cpp,cxx,c,h,hpp}");
    const full = new Map<string, string[]>();
    for (const f of files) for (const s of analysisOf("python", fs.readFileSync(f, "utf8")).symbols) (full.get(s.name) ?? full.set(s.name, []).get(s.name)!).push(`${f}:${s.qual}:${s.defLine}`);
    const key = (es: IndexEntry[]) => es.map((e) => `${e.abs}:${e.qual}:${e.defLine}`);
    const sched = await lookupName("Scheduler");
    check(JSON.stringify(key(sched)) === JSON.stringify(full.get("Scheduler")), "Lookup before the index is built finds the same definitions as a full scan", key(sched));
    let same = true;
    for (const [name, want] of full) if (JSON.stringify(key(await lookupName(name))) !== JSON.stringify(want)) { same = false; console.log("  differs:", name); break; }
    check(same, `Every name (${full.size}) matches the full scan`);
    check(W.finds === finds + 2, "The workspace file list is read once (plus the test's own scan)", { finds: W.finds - finds });
    await nameIndexReady();
    const all = await allNames();
    check(all.reduce((n, l) => n + l.length, 0) === [...full.values()].reduce((n, l) => n + l.length, 0), "allNames has every entry once");
    // Created / changed / deleted files update just that file
    const tmp = path.join(WS, "nanovllm/zz_index_probe.py");
    fs.writeFileSync(tmp, "def probe_one():\n    pass\n");
    W.fire.create.fire([tmp]);
    check((await lookupName("probe_one")).length === 1, "New file is indexed");
    fs.writeFileSync(tmp, "def probe_two():\n    pass\n");
    W.fire.change.fire(tmp);
    const c1 = (await lookupName("probe_one")).length, c2 = (await lookupName("probe_two")).length;
    check(c1 === 0 && c2 === 1, "Changed file is re-indexed", { c1, c2 });
    W.open.set(tmp, "def probe_three():\n    pass\n");
    W.fire.save.fire(tmp);
    check((await lookupName("probe_three")).length === 1, "Saved editor buffer is re-indexed");
    W.open.clear();
    fs.rmSync(tmp);
    W.fire.delete.fire([tmp]);
    check((await lookupName("probe_two")).length === 0 && (await lookupName("probe_three")).length === 0 && W.finds === finds + 2, "Deleted file leaves the index without a rescan");
    // Background build yields between files
    resetIndex();
    let ticks = 0;
    const t = setInterval(() => ticks++, 1);
    startNameIndex();
    await nameIndexReady();
    clearInterval(t);
    check(ticks > 3, "Background build lets timers run while indexing", { ticks });

    // Pylance still starting: an empty answer is retried before falling back to the name index
    const step = await card(path.join(WS, "nanovllm/engine/llm_engine.py"), "LLMEngine.step");
    const sl = lineOf(step.seg, /self\.scheduler\.schedule\(\)/);
    const req = { seg: step.seg, line: sl, col: step.seg.text[sl - step.seg.start].indexOf("schedule("), name: "schedule" };
    const schAbs = path.join(WS, "nanovllm/engine/scheduler.py");
    const defLine = analysisOf("python", fs.readFileSync(schAbs, "utf8")).symbols.find((x) => x.qual === "Scheduler.schedule")!.defLine;
    let asks = 0;
    const orig = W.language.definitions, origHas = W.about.hasExtension;
    W.about.hasExtension = (id) => id === "ms-python.vscode-pylance";
    forgetLspSeen();
    W.language.definitions = async () => (++asks < 3 ? [] : [{ abs: schAbs, line: defLine, col: 8 }]);
    forgetDefs();
    const r = await expand(req);
    check("card" in r && r.card.segments[0].symbol?.qual === "Scheduler.schedule" && asks === 3, "Empty answers while Pylance starts are retried", { asks });
    asks = 0;
    W.language.definitions = async () => { asks++; return []; };
    forgetDefs();
    await expand(req);
    check(asks === 1, "Once Pylance has answered, an empty answer is not retried", { asks });
    W.language.definitions = orig; W.about.hasExtension = origHas;
    await sleep(0);
  }

  // 卡片的段只分析那几行：和整文件分析再裁剪一样；整文件分析过以后直接裁剪
  {
    const t = fs.readFileSync(path.join(WS, "nanovllm/engine/llm_engine.py"), "utf8") + "\n# segment test\n"; // 新内容：不在缓存里
    const s1 = segAnalysis("python", t, 20, 45, "seg-test");
    const full = analysisOf("python", t, "seg-test");
    check(s1.calls.length > 0 && JSON.stringify(s1) === JSON.stringify(clipAnalysis(full, 20, 45)), "segAnalysis = whole-file analysis clipped to the segment");
    check(JSON.stringify(segAnalysis("python", t, 20, 45)) === JSON.stringify(s1), "segAnalysis after the whole file was analyzed: same result");
    check(JSON.stringify(segAnalysis("python", t, 1, 0).imports) === JSON.stringify(full.imports), "segAnalysis with no lines still has the file's imports");
  }

  // 子白板（线框 05）：进入 / 返回换的是同一个面板（面包屑、镜头、讲解带过去）、不能套成环、Turn into Board 存到父白板的组、侧栏的树
  {
    const dir = fs.mkdtempSync("/tmp/codeboard-sub-");
    const store = new Storage(nodeFs, { dir: () => dir });
    const E = emptyBoard("bE", "Engine"), S = emptyBoard("bS", "Scheduler"), X = emptyBoard("bX", "Other");
    E.cards.push({ id: "f", kind: "board", board: "bS" }); E.place.f = { x: 0, y: 0, w: 560, h: 360 };
    S.cards.push({ id: "n", kind: "note", md: "hi", bg: true }); S.place.n = { x: 0, y: 0, w: 200 };
    await store.save(E, { group: "g1" }); await store.save(S); await store.save(X);
    const switches: { to: string; crumbs: Crumb[]; cams: Camera[]; walk?: WalkHop; cam?: Camera }[] = [];
    const toasts: string[] = [];
    const view: BoardView = { postMessage: (m: HostToBoard) => { if (m.type === "toast") toasts.push(m.text); }, title: "", visible: true, active: true, reveal: () => undefined, dispose: () => undefined, resourceUrl: () => "" };
    const panels: BoardHost = {
      store, target: undefined, clip: undefined,
      get: () => undefined, all: () => [], metas: () => store.list(), show: async () => undefined, setTarget: () => undefined, broadcast: () => undefined,
      pushBoards: async () => undefined, staleChanged: () => undefined, refreshStale: async () => undefined, refreshShared: () => undefined, refreshSkeletons: () => undefined,
      skeleton: (id) => { const b = store.peek(id); return b ? skeletonOf(b, (x) => store.peek(x)?.name) : null; },
      switchBoard: async (p, to, o) => { switches.push({ to, ...o }); p.id = to; p.crumbs = o.crumbs; p.cams = o.cams; return true; },
    };
    const h = makeHandler(panels);
    const p = new BoardPanel("bE", view, panels);
    p.ready = true;
    p.board = store.peek("bE");
    const send = (m: BoardToHost) => h(p, m);
    const sk = await send({ type: "skeletons", req: 1, ids: ["bS", "nope"] }) as Record<string, unknown>;
    check((sk.bS as { n: number }).n === 1 && sk.nope === null, "Skeletons: the child board's skeleton, null for a missing board", sk);
    await send({ type: "enterBoard", id: "bS", frame: "f", cam: { x: 1, y: 2, z: 0.5 }, walk: { into: { root: "r", i: 2 }, start: "n" } });
    check(p.id === "bS" && JSON.stringify(switches[0].crumbs) === JSON.stringify([{ id: "bE", name: "Engine", frame: "f" }]) && switches[0].cams[0].z === 0.5 && switches[0].walk?.start === "n", "Enter: same panel switches to the child with a breadcrumb, the parent camera and the walkthrough hop", switches[0]);
    // 在子白板里放父白板：成环，拒绝（白板那边先拦；宿主这边进入时也查）
    S.cards.push({ id: "g", kind: "board", board: "bE" }); S.place.g = { x: 0, y: 400, w: 560, h: 360 };
    await send({ type: "enterBoard", id: "bE", frame: "g", cam: { x: 0, y: 0, z: 1 } });
    check(switches.length === 1 && /inside itself/.test(toasts.at(-1) ?? ""), "Enter refuses a cycle", toasts);
    await send({ type: "leaveBoard", walk: { resume: { root: "r", i: 3 } } });
    check(p.id === "bE" && switches[1].crumbs.length === 0 && switches[1].cam?.z === 0.5 && switches[1].walk?.resume?.i === 3, "Leave: back to the parent with its camera and the walkthrough resume", switches[1]);
    const nb = emptyBoard("bN", "New"); nb.cards.push({ id: "c1", kind: "note", md: "x", bg: true }); nb.place.c1 = { x: 80, y: 80, w: 200 };
    const made = await send({ type: "newBoard", req: 2, board: nb });
    check(made === true && store.groupOf("bN") === "g1" && (await store.load("bN"))?.cards.length === 1, "Turn into Board: the new board is saved in the parent's group");
    // 侧栏：Scheduler 缩进在 Engine 下面，不在顶层；Other 在顶层
    const metas = await store.list();
    const top = treeChildren(metas, ["g1"]);
    const g1 = treeChildren(metas, ["g1"], top.find((n) => n.kind === "group"));
    const eng = g1.find((n) => n.kind === "board" && n.id === "bE")!;
    const kids = treeChildren(metas, [], eng);
    check(top.some((n) => n.kind === "board" && n.id === "bX") && !top.some((n) => n.kind === "board" && n.id === "bS") && kids.length === 1 && kids[0].kind === "board" && kids[0].id === "bS" && kids[0].path.join("/") === "bE/bS",
      "Sidebar: child boards nest under their parents", { top, kids });
    // 同一块白板在两块父白板下面各出现一次
    X.cards.push({ id: "h", kind: "board", board: "bS" }); X.place.h = { x: 0, y: 0, w: 560, h: 360 };
    await store.save(X);
    const m2 = await store.list();
    const ox = treeChildren(m2, ["g1"]).find((n) => n.kind === "board" && n.id === "bX")!;
    check(treeChildren(m2, [], ox).some((n) => n.kind === "board" && n.id === "bS"), "Sidebar: a board can appear under several parents");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // 接上断掉的调用链、跨语言（线框 01、02）：test/fixtures/crosslang 里的小仓库（DeepEP v1 / 新版 JIT、torch.ops、Triton、TileLang、PyO3、动态分发）
  {
    const FIX = fs.mkdtempSync("/tmp/codeboard-cross-");
    fs.cpSync(path.join(REPO, "extensions/vscode/test/fixtures/crosslang"), FIX, { recursive: true });
    const W2 = nodeWorkspace(FIX);
    useWorkspace(W2);
    resetIndex();
    const at = async (rel: string, qual: string) => {
      const abs = path.join(FIX, rel);
      const sym = analysisOf(langOf(abs), fs.readFileSync(abs, "utf8")).symbols.find((s) => s.qual === qual)!;
      const c = (await cardForFileSym(abs, sym))!.card as CodeCard;
      return c.segments[0];
    };
    const click = async (seg: Segment, re: RegExp, name: string, pick?: ExpandPick) => {
      const line = lineOf(seg, re);
      return expand({ seg, line, col: seg.text[line - seg.start].indexOf(name), name, pick });
    };
    const qualOf = (r: ExpandResult) => ("card" in r ? r.card.segments[0].symbol?.qual : undefined);
    const vals = (r: ExpandResult) => ("card" in r ? (r.mark?.vals ?? []).map((v) => `${v.name}=${v.value}`).join(" ") : "");

    // pybind：Buffer.dispatch → Buffer::intranode_dispatch
    const buf = await at("deep_ep/buffer.py", "Buffer.dispatch");
    const r1 = await click(buf, /intranode_dispatch\(/, "intranode_dispatch");
    check(qualOf(r1) === "deep_ep::Buffer::intranode_dispatch" && "card" in r1 && r1.mark?.bound === "pybind · deep_ep.cpp .def", "pybind: Python call into the C++ method registered with .def", "card" in r1 ? r1.mark : r1);
    // launch macro：SWITCH_RANKS(DISPATCH_LAUNCH_CASE) → dispatch<8, 768, 8192>
    const host = await at("csrc/kernels/intranode.cu", "deep_ep::intranode::dispatch");
    const hostSeg = host.text.some((l) => /SWITCH_RANKS\(DISPATCH/.test(l)) ? host : await (async () => {
      const abs = path.join(FIX, "csrc/kernels/intranode.cu");
      const syms = analysisOf("cuda-cpp", fs.readFileSync(abs, "utf8")).symbols.filter((s) => s.qual === "deep_ep::intranode::dispatch");
      return ((await cardForFileSym(abs, syms[syms.length - 1]))!.card as CodeCard).segments[0];
    })();
    const r2 = await click(hostSeg, /SWITCH_RANKS\(DISPATCH/, "SWITCH_RANKS");
    const k2 = "card" in r2 ? r2.mark?.vals?.[0] : undefined;
    check("card" in r2 && r2.card.segments[0].text.some((l) => /__global__/.test(l)) && r2.mark?.bound === "launch macro · SWITCH_RANKS" && vals(r2) === "kNumRanks=8 kNumThreads=768 kNumTMABytesPerWarp=8192"
      && JSON.stringify(k2?.opts) === '["2","4","8"]' && k2?.from === "SWITCH_RANKS(num_ranks)" && r2.title === "dispatch<8, 768, 8192>", "Launch macro: SWITCH_RANKS(CASE) → __global__ kernel with template values and the rank picker", "card" in r2 ? { mark: r2.mark, title: r2.title } : r2);
    // CUDA <<<>>>
    const add = await at("csrc/kernels/intranode.cu", "deep_ep::intranode::add");
    const r3 = await click(add, /add_kernel<kThreads><<</, "add_kernel");
    check(qualOf(r3) === "deep_ep::intranode::add_kernel" && "card" in r3 && r3.mark?.bound === "kernel<<<…>>>" && vals(r3) === "kBlock=256", "CUDA <<<>>> launch: kernel card with its template value", "card" in r3 ? r3.mark : r3);
    // JIT 编译（DeepEP 新版）：两个分支，第一个选中，另一个是备选
    const jit = await at("csrc/jit/dispatch.hpp", "deep_ep::launch_dispatch");
    const r4 = await click(jit, /jit->compile/, "compile");
    check(qualOf(r4) === "deep_ep::ep::dispatch_impl" && "card" in r4 && r4.mark?.bound === "JIT compile · dispatch.cuh" && vals(r4) === "kNumSMs=num_sms kNumTokens=num_tokens"
      && r4.mark?.alts?.length === 1 && r4.mark.alts[0].qual === "deep_ep::ep::hybrid_dispatch_impl", "JIT compile: the kernel the format string names, the other branch as an alternative", "card" in r4 ? r4.mark : r4);
    // torch.ops → TORCH_LIBRARY 的 m.impl
    const norm = await at("ops/norm.py", "rms_norm");
    const r5 = await click(norm, /torch\.ops\.my_ext/, "rms_norm");
    check(qualOf(r5) === "rms_norm_cuda" && "card" in r5 && r5.mark?.bound === "torch.ops · ext.cc m.impl", "torch.ops: the C++ function registered with TORCH_LIBRARY m.impl", "card" in r5 ? r5.mark : r5);
    // Triton：kernel[grid] → @triton.jit，constexpr、autotune 的 config
    const inv = await at("ops/kern.py", "invoke_fused_moe_kernel");
    const r6 = await click(inv, /fused_moe_kernel\[grid\]/, "fused_moe_kernel");
    check(qualOf(r6) === "fused_moe_kernel" && "card" in r6 && r6.mark?.bound === "kernel[grid]" && vals(r6) === "BLOCK_K=32 BLOCK_M=64 BLOCK_N=128 stages=3 warps=4" && r6.mark?.alts?.length === 2
      && r6.mark.alts[0].label === "config 2 · BLOCK_M=128 BLOCK_N=64 stages=4 warps=8", "Triton: kernel[grid] → @triton.jit kernel, constexpr values, other autotune configs as alternatives", "card" in r6 ? r6.mark : r6);
    // TileLang：工厂 → prim_func
    const mla = await at("ops/mla.py", "run_mla_decode");
    const r7 = await click(mla, /flashmla_decode\(heads/, "flashmla_decode");
    check(qualOf(r7) === "flashmla_decode.main" && "card" in r7 && r7.mark?.bound === "tilelang.jit factory" && vals(r7) === "heads=heads block_N=64 num_stages=2" && r7.title === "flashmla_decode → main", "TileLang: the factory call goes straight to the prim_func; factory arguments as values", "card" in r7 ? { mark: r7.mark, title: r7.title } : r7);
    // PyO3
    const tok = await at("ops/tok.py", "count");
    const r8 = await click(tok, /fasttok\.tokenize/, "tokenize");
    check(qualOf(r8) === "tokenize" && "card" in r8 && r8.card.segments[0].lang === "rust" && r8.mark?.bound === "PyO3 · lib.rs #[pyfunction]", "PyO3: Python call into the #[pyfunction] in Rust", "card" in r8 ? r8.mark : r8);
    // 解析不到：回 none 带名字（白板给 Search in All Languages / Draw Manually）
    const lay = await at("vllm/layer.py", "Attention.forward");
    const r9 = await expand({ seg: { ...lay, text: lay.text.map((l) => l.replace("unified_attention", "missing_op")) }, line: lineOf(lay, /unified_attention/), col: lay.text[lineOf(lay, /unified_attention/) - lay.start].indexOf("unified_attention"), name: "missing_op" });
    check("none" in r9 && r9.name === "missing_op", "Unresolvable call: none with the name to search", r9);
    const hits = await searchName("unified_attention");
    check(hits.length === 2 && hits[0].def && hits[0].lang === "py" && hits[0].qual === "unified_attention" && !hits[1].def && /direct_register_custom_op\("unified_attention"/.test(hits[1].label), "Search in all languages: the def and the string registration", hits);
    const hits2 = await searchName("rms_norm");
    check(hits2.some((h) => h.lang === "py" && h.def) && hits2.some((h) => h.lang === "cpp" && !h.def && /m\.impl\("rms_norm"/.test(h.label)), "Search in all languages: grouped py before cpp, registrations included", hits2.map((h) => [h.lang, h.def, h.label]));

    // 动态分发：定义 = 基类的方法，实现 = 两个子类（语言服务用桩代替 Pylance）
    const baseAbs = path.join(FIX, "vllm/base.py"), implAbs = path.join(FIX, "vllm/impls.py");
    W2.language.definitions = async () => [{ abs: baseAbs, line: 2, col: 8 }];
    W2.language.implementations = async (abs, line) => (abs === baseAbs && line === 2 ? [{ abs: implAbs, line: 5, col: 8 }, { abs: implAbs, line: 10, col: 8 }] : []);
    forgetDefs();
    const r10 = await click(lay, /self\.impl\.forward/, "forward");
    check("impls" in r10 && r10.base === "AttentionImpl.forward" && r10.impls.map((i) => i.qual).join(",") === "FlashAttentionImpl.forward,TritonAttentionImpl.forward", "Dynamic dispatch: all implementations (abstract base left out)", r10);
    const pk = await click(lay, /self\.impl\.forward/, "forward", "impls" in r10 ? { path: r10.impls[1].path, line: r10.impls[1].line, qual: r10.impls[1].qual } : undefined);
    check(qualOf(pk) === "TritonAttentionImpl.forward", "Dynamic dispatch: picking one expands it", pk);
    const pv = await peek({ seg: lay, line: lineOf(lay, /self\.impl\.forward/), col: lay.text[lineOf(lay, /self\.impl\.forward/) - lay.start].indexOf("forward"), word: "self.impl.forward" }) as PeekDef;
    check(pv?.dispatch?.n === 2 && pv.dispatch.base === "AttentionImpl" && pv.dispatch.abstract, "Hover: Dynamic dispatch · 2 implementations", pv?.dispatch);
    // 没有覆盖的普通方法：照常展开
    W2.language.implementations = async () => [];
    forgetDefs();
    const r11 = await click(lay, /self\.impl\.forward/, "forward");
    check(qualOf(r11) === "AttentionImpl.forward", "No overrides: a plain method expands as before", r11);
    W2.language.definitions = async () => []; W2.language.implementations = async () => [];
    forgetDefs();
    fs.rmSync(FIX, { recursive: true, force: true });
  }

  console.log(failed ? `${failed} failed` : "All passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

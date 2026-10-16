// Host resolution without a language service (as in the cloud sandbox): #33 members of a class card outside the workspace, #32 Qwen3ForCausalLM variable candidates, #3 #4 preview fallbacks, #34 library calls.
// Usage: node extensions/vscode/test/run-host-resolve.mjs (runs on a copy of nano-vllm)
import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { CodeCard, ExpandResult, PeekDef, Segment } from "@codeboard/core";
import { startAnalysis, analysisOf, segAnalysis } from "../src/analysis";
import { clipAnalysis } from "@codeboard/core/analysis";
import { cardForFileSym } from "../src/cards";
import { callVars, expand, peek } from "../src/resolve";
import { viewsFor } from "../src/views";
import { forgetDefs } from "../src/defcache";
import { prefetchCall, warmBoard } from "../src/prefetch";
import { WS, commands, workspace } from "./vscode-stub";

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
    const orig = commands.executeCommand;
    (commands as { executeCommand: unknown }).executeCommand = async (cmd: string) => {
      if (cmd !== "vscode.executeDefinitionProvider") return undefined;
      calls++; live++; maxLive = Math.max(maxLive, live);
      await sleep(delay);
      live--;
      return empty ? [] : [{ uri: { fsPath: schAbs, scheme: "file" }, range: { start: { line: defLine - 1, character: 8 } } }];
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
    workspace.textDocuments.push({ uri: { scheme: "file", fsPath: llmAbs }, getText: () => edited });
    const r3 = await expand(req);
    check(isSchedule(r3) && calls === 3, "Changed file content is a cache miss", { calls });
    workspace.textDocuments.length = 0;
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
    (commands as { executeCommand: unknown }).executeCommand = orig;
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

  console.log(failed ? `${failed} failed` : "All passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

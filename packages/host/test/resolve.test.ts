// Expanding calls and previews without a language service (as in the cloud sandbox): members of a class card outside the workspace,
// variable candidates, preview fallbacks, library calls, and retrying while Pylance starts
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExpandResult, PeekDef, Segment } from "@codeboard/core";
import { callVars, expand, forgetLspSeen, peek } from "../src/resolve";
import { forgetDefs } from "../src/defcache";
import { analysisOf } from "../src/analysis";
import { viewsFor } from "../src/views";
import { useWorkspace } from "../src/ws";
import { WS, nodeWorkspace } from "./node-workspace";
import { at, card, startTreeSitter } from "./helpers";

const W = nodeWorkspace();
const EXT = "/tmp/codeboard-perf/ext/multiprocessing"; // not git, not in site-packages: external root = this folder
const SHM = `import os\n\n\nclass SharedMemory:\n    """Creates a new shared memory block."""\n\n    _name = None\n\n    def __init__(self, name=None, create=False, size=0):\n        if not size >= 0:\n            raise ValueError("bad size")\n        self._size = size\n\n    def close(self):\n        os.close(self._fd)\n`;
let shm: Awaited<ReturnType<typeof card>>, mr: Awaited<ReturnType<typeof card>>;
const qualOf = (r: ExpandResult) => ("card" in r ? r.card.segments[0].symbol?.qual : undefined);

beforeAll(async () => {
  useWorkspace(W);
  fs.mkdirSync(EXT, { recursive: true });
  fs.writeFileSync(path.join(EXT, "__init__.py"), "");
  fs.writeFileSync(path.join(EXT, "shared_memory.py"), SHM);
  await startTreeSitter();
  shm = await card(path.join(EXT, "shared_memory.py"), "SharedMemory");
  mr = await card(path.join(WS, "nanovllm/engine/model_runner.py"), "ModelRunner.__init__");
});

describe("class card outside the workspace", () => {
  it("keeps the path relative to the external root", () => {
    expect(shm.seg.src.kind).toBe("external");
    expect(shm.seg.path).toBe("shared_memory.py");
  });
  it("expands a member through a pick relative to the card's root, found by qual when the line moved", async () => {
    const pick = { path: shm.seg.path, line: 9 };
    expect("none" in (await expand({ seg: shm.seg, line: 9, col: 0, name: "__init__", pick }))).toBe(true); // read as a workspace path: not found
    expect(qualOf(await expand({ seg: shm.seg, line: 9, col: 0, name: "__init__", pick: { ...pick, rel: true, qual: "SharedMemory.__init__" } }))).toBe("SharedMemory.__init__");
    expect("card" in (await expand({ seg: shm.seg, line: 3, col: 0, name: "__init__", pick: { ...pick, line: 3, rel: true, qual: "SharedMemory.__init__" } }))).toBe(true);
  });
});

describe("variable candidates", () => {
  const want = [{ a: "hf_config", b: "config" }, { a: "self.model", ret: true }];
  const click = () => at(mr.seg, /Qwen3ForCausalLM\(hf_config\)/, "Qwen3ForCausalLM");

  it("come with a class card expanded by click", async () => {
    const r = await expand({ ...click(), name: "Qwen3ForCausalLM" });
    expect(qualOf(r)).toBe("Qwen3ForCausalLM");
    expect("card" in r && r.vars).toEqual(want);
  });
  it("match the call site from the segment text alone when it differs from the workspace", async () => {
    const snip = { ...mr.seg, version: { kind: "hash" as const, hash: "x" }, text: mr.seg.text.map((t, i) => (i === 0 ? t + "  " : t)) };
    const r = await expand({ ...click(), seg: snip, name: "Qwen3ForCausalLM" });
    expect("card" in r && r.vars).toHaveLength(2);
  });
  it("come with a drag onto an existing class or function card", async () => {
    const q = await card(path.join(WS, "nanovllm/models/qwen3.py"), "Qwen3ForCausalLM");
    expect(await callVars({ ...click(), name: "Qwen3ForCausalLM", target: q.seg })).toEqual(want);
    const lm = await card(path.join(WS, "nanovllm/utils/loader.py"), "load_model");
    expect(await callVars({ ...at(mr.seg, /load_model\(self\.model/, "load_model"), name: "load_model", target: lm.seg })).toEqual([{ a: "self.model", b: "model" }, { a: "config.model", b: "path" }]);
  });
});

describe("preview fallbacks", () => {
  const pk = async (seg: Segment, re: RegExp, word: string) => (await peek({ ...at(seg, re, word), word })) as PeekDef;
  it("shows all fields of the class for a field", async () => {
    const eng = await card(path.join(WS, "nanovllm/engine/llm_engine.py"), "LLMEngine.__init__");
    const fld = await pk(eng.seg, /config\.kvcache_block_size/, "kvcache_block_size");
    expect({ kind: fld.kind, rows: fld.rows?.length, head: fld.head, line: fld.line }).toEqual({ kind: "field", rows: 11, head: "class Config", line: 17 });
  });
  it("shows the signature, first lines and ⋯ more for a function", async () => {
    const fn = await pk(mr.seg, /load_model\(self\.model/, "load_model");
    expect(fn.kind).toBe("function");
    expect(fn.more).toBeTruthy();
    expect(fn.sig).toMatch(/^\(function\) def load_model/);
    expect(fn.lib).toBeFalsy();
  });
  it("shows only the signature and docs for a library module", async () => {
    const eng = await card(path.join(WS, "nanovllm/engine/llm_engine.py"), "LLMEngine.__init__");
    const mod = await pk(eng.seg, /mp\.get_context/, "mp");
    expect({ kind: mod.kind, html: mod.html.length, lib: mod.lib, title: mod.title }).toEqual({ kind: "module", html: 0, lib: "torch", title: "torch/multiprocessing" });
  });
  it("shows all self assignments in __init__ for self.x", async () => {
    const sch = await card(path.join(WS, "nanovllm/engine/scheduler.py"), "Scheduler.schedule");
    const self = await pk(sch.seg, /self\.max_num_seqs/, "self.max_num_seqs");
    expect(self.kind).toBe("field");
    expect(self.rows?.length).toBeGreaterThan(2);
  });
});

describe("library calls", () => {
  it("carry the package name; project calls don't", async () => {
    const v = (await viewsFor([mr.seg]))[mr.seg.id];
    const pkg = (n: string) => v.calls.find((c) => c.name === n)?.pkg;
    expect([pkg("set_device"), pkg("init_process_group"), pkg("SharedMemory")]).toEqual(["torch", "torch", "multiprocessing"]);
    expect([pkg("Qwen3ForCausalLM"), pkg("load_model"), pkg("warmup_model")]).toEqual([undefined, undefined, undefined]);
    expect(v.html.some((h) => h.includes('data-p="torch"'))).toBe(true);
  });
  it("are all calls in a file outside the workspace", async () => {
    const ve = (await viewsFor([shm.seg]))[shm.seg.id];
    expect(ve.calls.length).toBeGreaterThan(0);
    expect(ve.calls.map((c) => c.pkg).filter((p) => p !== "multiprocessing" && p !== "os")).toEqual([]);
  });
});

describe("while Pylance starts", () => {
  it("retries empty answers, and stops retrying once Pylance has answered", async () => {
    const step = await card(path.join(WS, "nanovllm/engine/llm_engine.py"), "LLMEngine.step");
    const req = { ...at(step.seg, /self\.scheduler\.schedule\(\)/, "schedule("), name: "schedule" };
    const schAbs = path.join(WS, "nanovllm/engine/scheduler.py");
    const defLine = analysisOf("python", fs.readFileSync(schAbs, "utf8")).symbols.find((x) => x.qual === "Scheduler.schedule")!.defLine;
    let asks = 0;
    const orig = W.language.definitions, origHas = W.about.hasExtension;
    W.about.hasExtension = (id) => id === "ms-python.vscode-pylance";
    try {
      forgetLspSeen();
      W.language.definitions = async () => (++asks < 3 ? [] : [{ abs: schAbs, line: defLine, col: 8 }]);
      forgetDefs();
      expect(qualOf(await expand(req))).toBe("Scheduler.schedule");
      expect(asks).toBe(3);
      asks = 0;
      W.language.definitions = async () => { asks++; return []; };
      forgetDefs();
      await expand(req);
      expect(asks).toBe(1);
    } finally {
      W.language.definitions = orig; W.about.hasExtension = origHas;
    }
  });
});

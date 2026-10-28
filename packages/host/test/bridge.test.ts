import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodeCard, ExpandPick, ExpandResult, PeekDef, Segment } from "@codeboard/core";
import { analysisOf } from "../src/analysis";
import { cardForFileSym } from "../src/cards";
import { dispatchAt, expand, peek } from "../src/resolve";
import { forgetDefs } from "../src/defcache";
import { searchName } from "../src/search";
import { resetIndex } from "../src/nameindex";
import { useWorkspace } from "../src/ws";
import { nodeWorkspace } from "./node-workspace";
import { at, card, startTreeSitter } from "./helpers";

const FIX = fs.mkdtempSync("/tmp/codeboard-cross-");
fs.cpSync(path.join(__dirname, "fixtures/crosslang"), FIX, { recursive: true });
const W = nodeWorkspace(FIX);
const seg = async (rel: string, qual: string) => (await card(path.join(FIX, rel), qual)).seg;
const click = (s: Segment, re: RegExp, name: string, pick?: ExpandPick) => expand({ ...at(s, re, name), name, pick });
const qualOf = (r: ExpandResult) => ("card" in r ? r.card.segments[0].symbol?.qual : undefined);
const markOf = (r: ExpandResult) => ("card" in r ? r.mark : undefined);
const vals = (r: ExpandResult) => ("card" in r ? (r.mark?.vals ?? []).map((v) => `${v.name}=${v.value}`).join(" ") : "");

beforeAll(async () => {
  useWorkspace(W);
  resetIndex();
  await startTreeSitter();
});
afterAll(() => fs.rmSync(FIX, { recursive: true, force: true }));

describe("cross-language bridges", () => {
  it("pybind: a Python call goes into the C++ method registered with .def", async () => {
    const r = await click(await seg("deep_ep/buffer.py", "Buffer.dispatch"), /intranode_dispatch\(/, "intranode_dispatch");
    expect(qualOf(r)).toBe("deep_ep::Buffer::intranode_dispatch");
    expect(markOf(r)?.bound).toBe("pybind · deep_ep.cpp .def");
  });
  it("launch macro: SWITCH_RANKS(CASE) goes to the __global__ kernel with template values and the rank picker", async () => {
    const abs = path.join(FIX, "csrc/kernels/intranode.cu");
    const syms = analysisOf("cuda-cpp", fs.readFileSync(abs, "utf8")).symbols.filter((s) => s.qual === "deep_ep::intranode::dispatch");
    const segs = await Promise.all(syms.map(async (s) => ((await cardForFileSym(abs, s))!.card as CodeCard).segments[0]));
    const host = segs.find((s) => s.text.some((l) => /SWITCH_RANKS\(DISPATCH/.test(l)))!;
    const r = await click(host, /SWITCH_RANKS\(DISPATCH/, "SWITCH_RANKS");
    expect("card" in r && r.card.segments[0].text.some((l) => /__global__/.test(l))).toBe(true);
    expect(markOf(r)?.bound).toBe("launch macro · SWITCH_RANKS");
    expect(vals(r)).toBe("kNumRanks=8 kNumThreads=768 kNumTMABytesPerWarp=8192");
    expect(markOf(r)?.vals?.[0]).toMatchObject({ opts: ["2", "4", "8"], from: "SWITCH_RANKS(num_ranks)" });
    expect("card" in r && r.title).toBe("dispatch<8, 768, 8192>");
  });
  it("CUDA <<<>>> launch: the kernel card with its template value", async () => {
    const r = await click(await seg("csrc/kernels/intranode.cu", "deep_ep::intranode::add"), /add_kernel<kThreads><<</, "add_kernel");
    expect(qualOf(r)).toBe("deep_ep::intranode::add_kernel");
    expect(markOf(r)?.bound).toBe("kernel<<<…>>>");
    expect(vals(r)).toBe("kBlock=256");
  });
  it("JIT compile: the kernel the format string names, the other branch as an alternative", async () => {
    const r = await click(await seg("csrc/jit/dispatch.hpp", "deep_ep::launch_dispatch"), /jit->compile/, "compile");
    expect(qualOf(r)).toBe("deep_ep::ep::dispatch_impl");
    expect(markOf(r)?.bound).toBe("JIT compile · dispatch.cuh");
    expect(vals(r)).toBe("kNumSMs=num_sms kNumTokens=num_tokens");
    expect(markOf(r)?.alts?.map((a) => a.qual)).toEqual(["deep_ep::ep::hybrid_dispatch_impl"]);
  });
  it("torch.ops: the C++ function registered with TORCH_LIBRARY m.impl", async () => {
    const r = await click(await seg("ops/norm.py", "rms_norm"), /torch\.ops\.my_ext/, "rms_norm");
    expect(qualOf(r)).toBe("rms_norm_cuda");
    expect(markOf(r)?.bound).toBe("torch.ops · ext.cc m.impl");
  });
  it("Triton: kernel[grid] goes to the @triton.jit kernel, constexpr values, other autotune configs as alternatives", async () => {
    const r = await click(await seg("ops/kern.py", "invoke_fused_moe_kernel"), /fused_moe_kernel\[grid\]/, "fused_moe_kernel");
    expect(qualOf(r)).toBe("fused_moe_kernel");
    expect(markOf(r)?.bound).toBe("kernel[grid]");
    expect(vals(r)).toBe("BLOCK_K=32 BLOCK_M=64 BLOCK_N=128 stages=3 warps=4");
    expect(markOf(r)?.alts).toHaveLength(2);
    expect(markOf(r)?.alts?.[0].label).toBe("config 2 · BLOCK_M=128 BLOCK_N=64 stages=4 warps=8");
  });
  it("TileLang: the factory call goes straight to the prim_func, factory arguments as values", async () => {
    const r = await click(await seg("ops/mla.py", "run_mla_decode"), /flashmla_decode\(heads/, "flashmla_decode");
    expect(qualOf(r)).toBe("flashmla_decode.main");
    expect(markOf(r)?.bound).toBe("tilelang.jit factory");
    expect(vals(r)).toBe("heads=heads block_N=64 num_stages=2");
    expect("card" in r && r.title).toBe("flashmla_decode → main");
  });
  it("PyO3: a Python call goes into the #[pyfunction] in Rust", async () => {
    const r = await click(await seg("ops/tok.py", "count"), /fasttok\.tokenize/, "tokenize");
    expect(qualOf(r)).toBe("tokenize");
    expect("card" in r && r.card.segments[0].lang).toBe("rust");
    expect(markOf(r)?.bound).toBe("PyO3 · lib.rs #[pyfunction]");
  });
});

describe("unresolvable calls", () => {
  it("come back as none with the name to search", async () => {
    const lay = await seg("vllm/layer.py", "Attention.forward");
    const r = await expand({ ...at(lay, /unified_attention/, "unified_attention"), seg: { ...lay, text: lay.text.map((l) => l.replace("unified_attention", "missing_op")) }, name: "missing_op" });
    expect(r).toMatchObject({ none: expect.anything(), name: "missing_op" });
  });
  it("Search in All Languages finds the def and the string registration", async () => {
    const hits = await searchName("unified_attention");
    expect(hits.map((h) => [h.lang, !!h.def, h.def ? h.qual : undefined])).toEqual([["python", true, "unified_attention"], [hits[1]?.lang, false, undefined]]);
    expect(hits[1].label).toMatch(/direct_register_custom_op\("unified_attention"/);
  });
  it("Search in All Languages groups Python before C++, registrations included", async () => {
    const hits = await searchName("rms_norm");
    expect(hits.some((h) => h.lang === "python" && h.def)).toBe(true);
    expect(hits.some((h) => h.lang === "cpp" && !h.def && /m\.impl\("rms_norm"/.test(h.label))).toBe(true);
  });
});

describe("dynamic dispatch", () => {
  // definition = the base class method, implementations = two subclasses (a stub language service in place of Pylance)
  const baseAbs = path.join(FIX, "vllm/base.py"), implAbs = path.join(FIX, "vllm/impls.py");
  const impls = async (abs: string, line: number) => (abs === baseAbs && line === 2 ? [{ abs: implAbs, line: 5, col: 8 }, { abs: implAbs, line: 10, col: 8 }] : []);
  let lay: Segment;
  beforeAll(async () => {
    lay = await seg("vllm/layer.py", "Attention.forward");
    W.language.definitions = async () => [{ abs: baseAbs, line: 2, col: 8 }];
  });
  afterAll(() => { W.language.definitions = async () => []; W.language.implementations = async () => []; forgetDefs(); });
  const site = () => at(lay, /self\.impl\.forward/, "forward");

  it("lists all implementations (abstract base left out), and picking one expands it", async () => {
    W.language.implementations = impls;
    forgetDefs();
    const r = await click(lay, /self\.impl\.forward/, "forward");
    expect(r).toMatchObject({ base: "AttentionImpl.forward" });
    expect("impls" in r && r.impls.map((i) => i.qual)).toEqual(["FlashAttentionImpl.forward", "TritonAttentionImpl.forward"]);
    const pick = "impls" in r ? { path: r.impls[1].path, line: r.impls[1].line, qual: r.impls[1].qual } : undefined;
    expect(qualOf(await click(lay, /self\.impl\.forward/, "forward", pick))).toBe("TritonAttentionImpl.forward");
  });
  it("shows Dynamic dispatch · 2 implementations on hover", async () => {
    const pv = await peek({ ...site(), word: "self.impl.forward" }) as PeekDef;
    expect(pv.dispatch).toMatchObject({ n: 2, base: "AttentionImpl", abstract: true });
  });
  it("expands the definition at once when Go to Implementation is slow, and gives the implementations once they arrive", async () => {
    // Go to Implementation answers only when the test lets it: the click must not wait for it
    let answer!: () => void, answered = false;
    const gate = new Promise<void>((r) => { answer = r; });
    let asked = 0;
    W.language.implementations = async (abs, line) => { asked++; await gate; answered = true; return impls(abs, line); };
    forgetDefs();
    const r = await click(lay, /self\.impl\.forward/, "forward");
    expect(asked).toBe(1);
    expect(answered).toBe(false); // the card came before the implementations
    expect(qualOf(r)).toBe("AttentionImpl.forward");
    expect("card" in r && r.dispatching).toBe(true);
    answer();
    const da = await dispatchAt({ ...site(), name: "forward" });
    expect(asked).toBe(1); // the board's follow-up shares the click's request
    expect(da).toMatchObject({ base: "AttentionImpl.forward", abstract: true });
    expect(da?.impls.map((i) => i.qual)).toEqual(["FlashAttentionImpl.forward", "TritonAttentionImpl.forward"]);
  });
  it("expands a method with no overrides as a plain method", async () => {
    W.language.implementations = async () => [];
    forgetDefs();
    expect(qualOf(await click(lay, /self\.impl\.forward/, "forward"))).toBe("AttentionImpl.forward");
  });
});

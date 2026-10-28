// Symbols, calls, line flags, selections, call variables and entry points: snippets and the repo's nano-vllm submodule
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { initAnalysis, analyze, planSelection, listsMembers, varCandidates, symbolAt, pyprojectScripts, initExports, BLANK, COMMENT, DOCSTRING, type FileAnalysis } from "../src";

const repo = fileURLToPath(new URL("../../../examples/nano-vllm", import.meta.url));
const show = (rev: string, path: string) => execFileSync("git", ["-C", repo, "show", `${rev}:${path}`], { encoding: "utf8" });
const NEW = "bb823b3";
const SCHED = "nanovllm/engine/scheduler.py", RUNNER = "nanovllm/engine/model_runner.py", ENGINE = "nanovllm/engine/llm_engine.py";

beforeAll(() => initAnalysis());

const sym = (a: FileAnalysis, q: string) => a.symbols.find((s) => s.qual === q)!;

describe("analyze (python)", () => {
  it("finds methods with qualified names, decorators and signatures", () => {
    const a = analyze("python", show(NEW, SCHED));
    const s = sym(a, "Scheduler.schedule");
    expect(s.start).toBe(25);
    expect(s.sig).toBe("def schedule(self) -> tuple[list[Sequence], bool]");
    expect(s.parent).toBe("Scheduler");
    const f = sym(analyze("python", show(NEW, "nanovllm/layers/sampler.py")), "Sampler.forward");
    expect(f.start).toBe(f.defLine - 1); // @torch.compile
  });
  it("flags comments, docstrings, blank lines and trailing comments", () => {
    const src = 'def f(a):\n    """doc\n    more"""\n    # note\n\n    x = 1  # tail\n    return x\n';
    const a = analyze("python", src);
    expect(a.flags[1] & DOCSTRING).toBeTruthy();
    expect(a.flags[2] & DOCSTRING).toBeTruthy();
    expect(a.flags[3] & COMMENT).toBeTruthy();
    expect(a.flags[4] & BLANK).toBeTruthy();
    expect(a.flags[5]).toBe(0);
    expect(a.trailing[6]).toBe(11);
  });
  it("finds calls with receivers, loops and who takes the return value", () => {
    const a = analyze("python", show(NEW, ENGINE));
    const step = sym(a, "LLMEngine.step");
    const calls = a.calls.filter((c) => c.line >= step.start && c.line <= step.end);
    const sched = calls.find((c) => c.name === "schedule")!;
    expect(sched).toMatchObject({ recv: "self.scheduler", loop: false, assigned: ["seqs", "is_prefill"] });
    // call("run", …) records the string, but the callee is call
    const call = calls.find((c) => c.name === "call")!;
    expect(call.dispatch).toBe("run");
    const gen = sym(a, "LLMEngine.generate");
    const stepCall = a.calls.find((c) => c.name === "step" && c.line > gen.start && c.line <= gen.end)!;
    expect(stepCall.loop).toBe(true); // while not self.is_finished()
  });
  it("does not treat the for-loop iterable as inside the loop", () => {
    const a = analyze("python", "def f(xs):\n    for x in g(xs):\n        h(x)\n");
    expect(a.calls.find((c) => c.name === "g")!.loop).toBe(false);
    expect(a.calls.find((c) => c.name === "h")!.loop).toBe(true);
  });
  it("finds the __main__ block", () => {
    const a = analyze("python", show(NEW, "example.py"));
    expect(a.mainBlocks.length).toBe(1);
  });
  it("handles CJK text before a comment", () => {
    const a = analyze("python", 'x = "中文"  # 注释\n');
    expect(a.trailing[1]).toBe('x = "中文"  '.length);
  });
});

describe("analyze (c++ / cuda)", () => {
  it("finds functions, classes and calls", () => {
    const src = "template <typename T>\n__global__ void add(T* a, int n) {\n  for (int i = 0; i < n; i++) { foo(a, i); }\n}\nstruct S {\n  int f(int x) { return bar(x); }\n};\n";
    const a = analyze("cuda-cpp", src);
    expect(a.symbols.map((s) => [s.qual, s.start, s.end])).toEqual([["add", 1, 4], ["S", 5, 7], ["S::f", 6, 6]]);
    expect(a.calls.find((c) => c.name === "foo")!.loop).toBe(true);
    expect(a.calls.find((c) => c.name === "bar")!.loop).toBe(false);
  });
  it("names functions returning references, TORCH_IMPL_FUNC kernels, specialized and nested classes, friends and nested templates", () => {
    const src = [
      "namespace at::native {",
      "Tensor& adaptive_out_cuda(const Tensor& x, Tensor& out) { return out; }",
      "TORCH_IMPL_FUNC(softmax_cuda_out) (const Tensor& input, const Tensor& output) {",
      "  host_softmax(input, output);",
      "}",
      "template <> struct Holder<float> { void run() {} };",
      "struct Outer { struct Inner { int g() { return 1; } } inner; };",
      "class F { friend bool operator==(const F& a, const F& b) { return true; } };",
      "template <typename A> template <typename B> void W<A>::m(B b) {}",
      "}",
    ].join("\n");
    expect(analyze("cuda-cpp", src).symbols.map((s) => s.qual)).toEqual([
      "at::native::adaptive_out_cuda", "at::native::softmax_cuda_out", "at::native::Holder", "at::native::Holder::run", "at::native::Outer",
      "at::native::Outer::Inner", "at::native::Outer::Inner::g", "at::native::F", "at::native::F::operator==", "at::native::W<A>::m",
    ]);
  });
});

describe("analyze (c++ / cuda), half-written templates", () => {
  it("names nothing for a template with no declaration after it", () => {
    for (const src of ["template", "template <>", "template <typename T>", "template <> template <>", "namespace a { template <class T> }", "struct S { template <typename T> };"]) {
      expect(analyze("cuda-cpp", src).symbols.filter((s) => s.kind === "def")).toEqual([]);
    }
  });
});

describe("varCandidates", () => {
  it("pairs args with params, keeps names that differ, and adds the return value", () => {
    const eng = analyze("python", show(NEW, ENGINE));
    const gen = sym(eng, "LLMEngine.generate");
    const add = eng.calls.find((c) => c.name === "add_request" && c.line > gen.start)!;
    expect(varCandidates(add, sym(eng, "LLMEngine.add_request"))).toEqual([{ a: "prompt" }, { a: "sp", b: "sampling_params" }]);
    const sched = eng.calls.find((c) => c.name === "schedule")!;
    expect(varCandidates(sched, sym(analyze("python", show(NEW, SCHED)), "Scheduler.schedule"))).toEqual([{ a: "seqs, is_prefill", ret: true }]);
  });
  it("gives nothing for string dispatch", () => {
    const eng = analyze("python", show(NEW, ENGINE));
    const call = eng.calls.find((c) => c.name === "call")!;
    expect(varCandidates(call, sym(analyze("python", show(NEW, RUNNER)), "ModelRunner.call"))).toEqual([]);
  });
});

describe("planSelection", () => {
  const a = () => analyze("python", show(NEW, SCHED));
  const sel = (s: number, e: number, endCol = 1) => ({ startLine: s, startCol: 4, endLine: e, endCol });
  it("takes whole lines and trims blank edges", () => {
    expect(planSelection([sel(28, 33)], a())).toEqual({ kind: "segments", ranges: [{ start: 29, end: 33, scope: "Scheduler.schedule" }] });
  });
  it("does not include the next line when the selection stops at its column 0", () => {
    expect(planSelection([sel(30, 32, 0)], a())).toMatchObject({ ranges: [{ start: 30, end: 31 }] });
  });
  it("upgrades to a function card at >= 90% coverage", () => {
    const s = sym(a(), "Scheduler.schedule");
    expect(planSelection([sel(s.start + 1, s.end)], a())).toMatchObject({ kind: "function", sym: { qual: "Scheduler.schedule" } });
  });
  it("makes a class card when several methods of one class are selected", () => {
    const an = a();
    const p = sym(an, "Scheduler.preempt"), post = sym(an, "Scheduler.postprocess");
    expect(planSelection([sel(p.start, post.end)], an)).toMatchObject({ kind: "class", sym: { qual: "Scheduler" }, members: ["Scheduler.preempt", "Scheduler.postprocess"] });
  });
  it("asks when two top-level functions are selected", () => {
    const an = analyze("python", "def a():\n    pass\n\ndef b():\n    pass\n\nx = 1\ny = 2\n");
    expect(planSelection([sel(1, 8)], an)).toMatchObject({ kind: "split", syms: [{ qual: "a" }, { qual: "b" }] });
  });
  it("keeps the tail of one function and head of the next as one snippet", () => {
    const an = a();
    const p = sym(an, "Scheduler.preempt");
    expect(planSelection([sel(p.start - 3, p.start + 1)], an)).toMatchObject({ kind: "segments", ranges: [{ scope: "Scheduler.schedule" }] });
  });
  it("names module-level code as top", () => {
    expect(planSelection([sel(1, 3)], a())).toMatchObject({ ranges: [{ module: true }] });
  });
  it("turns multiple selections into one multi-segment card", () => {
    const p = planSelection([sel(31, 32), sel(44, 45)], a());
    expect(p).toMatchObject({ kind: "segments", ranges: [{ start: 31, end: 32 }, { start: 44, end: 45 }] });
  });
  it("a fields-only dataclass is a code card, not an empty member list", () => {
    // nano-vllm utils/context.py: @dataclass(slots=True) class Context with only annotated fields
    const an = analyze("python", show(NEW, "nanovllm/utils/context.py"));
    const ctx = sym(an, "Context");
    expect(ctx).toMatchObject({ kind: "class", start: 5, defLine: 6, end: 14 });
    expect(listsMembers(an, ctx)).toBe(false);
    expect(listsMembers(a(), sym(a(), "Scheduler"))).toBe(true);
  });
  it("splits a selection of several definitions without losing a line", () => {
    // context.py lines 5–27: the dataclass (decorator + fields), _CONTEXT = Context() at line 16, then three functions
    const an = analyze("python", show(NEW, "nanovllm/utils/context.py"));
    const p = planSelection([sel(5, 27)], an);
    expect(p).toMatchObject({ kind: "split" });
    const parts = (p as Extract<typeof p, { kind: "split" }>).parts.map((x) => "sym" in x ? `${x.sym.qual}:${x.sym.start}-${x.sym.end}` : `${x.range.module ? "<module>" : x.range.scope}:${x.range.start}-${x.range.end}`);
    expect(parts).toEqual(["Context:5-14", "<module>:16-16", "get_context:18-19", "set_context:21-23", "reset_context:25-27"]);
    // a selection that starts mid-function keeps the partial lines too
    const q = planSelection([sel(19, 27)], an) as Extract<ReturnType<typeof planSelection>, { kind: "split" }>;
    expect(q.parts.map((x) => "sym" in x ? x.sym.qual : `${x.range.scope}:${x.range.start}-${x.range.end}`)).toEqual(["get_context:19-19", "set_context", "reset_context"]);
  });
});

describe("entry points", () => {
  it("reads pyproject scripts and package exports", () => {
    expect(pyprojectScripts('[project]\nname="x"\n[project.scripts]\nnv = "nanovllm.cli:main"\n')).toEqual([{ name: "nv", module: "nanovllm.cli", func: "main" }]);
    expect(initExports(show(NEW, "nanovllm/__init__.py")).map((e) => e.name)).toEqual(["LLM", "SamplingParams"]);
  });
});

it("symbolAt picks the innermost", () => {
  const a = analyze("python", show(NEW, SCHED));
  expect(symbolAt(a.symbols, 30)!.qual).toBe("Scheduler.schedule");
});

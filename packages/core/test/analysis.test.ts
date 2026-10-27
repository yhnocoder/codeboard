// tree-sitter 查询版分析 vs 旧的逐节点遍历（test/oracle）：结果必须逐字段一致。
// 另外核对：按行分析 = 整文件分析裁剪；增量解析 = 重新解析。
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initAnalysis, analyze, clipAnalysis, diffEdit, forgetTree, setTreeCacheSize, type FileAnalysis } from "../src/analysis";
import { cachedTrees } from "../src/analysis/tree";
import { analyzeOld } from "./oracle/analysis-old";

const repo = fileURLToPath(new URL("../../../examples/nano-vllm", import.meta.url));
function pyFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) pyFiles(p, out);
    else if (e.name.endsWith(".py")) out.push(p);
  }
  return out;
}
const PY = pyFiles(repo).sort().map((p) => ({ name: p.slice(repo.length + 1), lang: "python", text: readFileSync(p, "utf8") }));

const CPP = [
  { name: "kernel.cu", lang: "cuda-cpp", text: `// 简单的 kernel
#include <cuda_runtime.h>
#include "utils.h"

namespace flash {
namespace detail {

template <typename T, int N>
__global__ void add_kernel(T* __restrict__ out, const T* a, const T* b, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;  // 全局下标
  for (int k = i; k < n; k += gridDim.x * blockDim.x) {
    out[k] = combine<T>(a[k], b[k]);
    if (k % 2) { atomicAdd(out, a[k]); }
  }
  while (i < n) { i = next(i); }
  do { sync(); } while (cond(i));
  auto f = [&](int x) { for (;;) { return helper(x); } };
  int r = std::max(f(1), compute(a, b));
}

/* 多行
   注释 */
struct Params {
  int n;
  float scale = default_scale();
  int size() const { return n * stride(); }
  struct Inner { void g() { h(); } };
};

}  // namespace detail

void launch(float* out, const float* a, const float* b, int n, cudaStream_t s) {
  dim3 grid(div_up(n, 256));
  detail::add_kernel<float, 4><<<grid, 256, 0, s>>>(out, a, b, n);
  C10_CUDA_KERNEL_LAUNCH_CHECK();
  for (auto& x : items(n)) process(x);
  Params p; p.size();
  auto* q = make_ptr(n);
  value = obj->method(1, "s");
}

}  // namespace flash

extern "C" {
int c_api(int x) { return flash::launch_count(x); }
}

#ifdef USE_ROCM
static void rocm_only() { hipInit(0); }
#endif

class Engine : public Base {
 public:
  Engine() : Base(init()) {}
  template <class U> U get(U u) { return convert<U>(u); }
  ~Engine();
};
Engine::~Engine() { cleanup(); }
int Engine::helper(int v) { return v ? sizeof(v) : printf("x"); }
` },
  { name: "ops.cpp", lang: "cpp", text: `#include <torch/extension.h>

torch::Tensor rms_norm(torch::Tensor x, torch::Tensor w, double eps) {
  TORCH_CHECK(x.is_cuda(), "x must be CUDA");
  auto out = torch::empty_like(x);
  for (int64_t i = 0; i < x.size(0); ++i)
    out[i] = x[i] * torch::rsqrt(x[i].pow(2).mean() + eps) * w;
  return out;
}

PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
  m.def("rms_norm", &rms_norm, "RMSNorm");  // 绑定
}
` },
  { name: "broken.h", lang: "c", text: "struct A { int x; \nvoid f( { g(); }\n#define M(x) ((x) + 1)\nint h(void) { return M(k()); }\n" },
];

beforeAll(() => initAnalysis());

const same = (a: FileAnalysis, b: FileAnalysis) => {
  expect(a).toStrictEqual(b);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
};

describe("query-based analysis matches the v0.1.5 node walk", () => {
  it(`nano-vllm: ${PY.length} python files`, () => {
    expect(PY.length).toBeGreaterThan(20);
    for (const f of PY) same(analyze(f.lang, f.text), analyzeOld(f.lang, f.text));
  });
  it("python edge cases", () => {
    const src = [
      '"""Module doc."""', "import os, torch.nn as nn", "from .a import b as c, d", "try:", "    import numpy as np", "except ImportError:", "    np = None",
      "@decorator(x=f(1))", "class A(Base):", "    '''A doc.'''", "    x = [g(i) for i in range(3)]", "    if True:", "        def m(self, a, *args, k=1, **kw):", "            return [h(j) for j in a]",
      "    @staticmethod", "    def s(*, q): return lambda: inner(q)",
      "def outer():", "    import sys", "    def inner2(): pass", "    for x in it(y):", "        r = call('run', x)", "        a, b = self.do(x).tolist()", "    else:", "        z()",
      "    while w(): v()", "    return (await k() for _ in z)",
      "for i in q():", "    lambda: p()", "    f = lambda: [t() for _ in u]", "    def d(): e()",
      "if __name__ == '__main__':", "    main()  # run", "x = '中文'  # 注释", "# 整行注释", "s = getattr(o, 'name')",
    ].join("\n");
    same(analyze("python", src), analyzeOld("python", src));
    const bad = "def f(:\n    g()\nclass B\n    def h(self): i()\n";
    same(analyze("python", bad), analyzeOld("python", bad));
  });
  for (const f of CPP) it(`c++ / cuda: ${f.name}`, () => {
    const a = analyze(f.lang, f.text);
    expect(a.calls.length).toBeGreaterThan(1);
    same(a, analyzeOld(f.lang, f.text));
  });
  it("unknown languages only mark blank lines", () => same(analyze("go", "func main() {}\n\n"), analyzeOld("go", "func main() {}\n\n")));
});

describe("v0.2 call kinds", () => {
  it("Triton kernel[grid](…) is a call to kernel, marked as a grid launch", () => {
    const a = analyze("python", "def f(x):\n    grid = (4,)\n    my_kernel[grid](x, BLOCK=64)\n    mod.k2[(1, 2)](x)\n");
    const k = a.calls.find((c) => c.name === "my_kernel")!;
    expect(k).toMatchObject({ line: 3, col: 4, launch: "grid" });
    expect(k.args.map((x) => x.kw ?? x.text)).toEqual(["x", "BLOCK"]);
    expect(a.calls.find((c) => c.name === "k2")).toMatchObject({ recv: "mod", launch: "grid" });
  });
  it("CUDA kernel<<<…>>>(…) is a call marked as a launch", () => {
    const a = analyze("cuda-cpp", "void go(int* p) {\n  dispatch<8, 768><<<grid, 256, 0, s>>>(p);\n  plain<<<1, 1>>>();\n}\n");
    expect(a.calls.filter((c) => c.launch === "<<<").map((c) => [c.name, c.line, c.col])).toEqual([["dispatch", 2, 2], ["plain", 3, 2]]);
  });
  it("Rust: functions, impl methods, attributes in the start line, calls", () => {
    const src = "use pyo3::prelude::*;\n\n#[pyfunction]\n#[pyo3(name = \"tok\")]\nfn tokenize(s: &str) -> Vec<u32> {\n    let v = encode(s);\n    v\n}\n\nstruct Tree { n: u32 }\n\nimpl Tree {\n    pub fn insert(&mut self, k: u32) {\n        self.grow(k);\n        helpers::fix(k);\n    }\n}\n";
    const a = analyze("rust", src);
    expect(a.symbols.map((s) => [s.qual, s.kind, s.start, s.defLine, s.end])).toEqual([["tokenize", "def", 3, 5, 8], ["Tree", "class", 10, 10, 10], ["Tree::insert", "def", 13, 13, 16]]);
    expect(a.symbols[2].params.map((p) => p.kind)).toEqual(["self", "pos"]);
    expect(a.calls.map((c) => [c.name, c.recv, c.line])).toEqual([["encode", undefined, 6], ["grow", "self", 14], ["fix", "helpers", 15]]);
    expect(a.calls[0].assigned).toEqual(["v"]);
  });
});

describe("segment analysis", () => {
  const ranges = (a: FileAnalysis, n: number) => {
    const out: [number, number][] = a.symbols.map((s) => [s.start, s.end]);
    for (let i = 1; i <= n; i += 7) out.push([i, Math.min(n, i + 11)], [i, i]);
    out.push([1, n], [n + 1, n + 5]);
    return out;
  };
  for (const f of [...PY, ...CPP]) it(`${f.name}: lines = clipped whole-file result`, () => {
    const full = analyze(f.lang, f.text);
    for (const [s, e] of ranges(full, full.flags.length)) same(analyze(f.lang, f.text, { lines: { start: s, end: e } }), clipAnalysis(full, s, e));
  });
});

describe("incremental parsing", () => {
  it("edits on a kept tree give the same result as a fresh parse", () => {
    const f = PY.find((x) => x.name.endsWith("scheduler.py"))!;
    const key = "test:scheduler";
    let text = f.text;
    same(analyze("python", text, { key }), analyze("python", text));
    const steps: ((t: string) => string)[] = [
      (t) => t.replace("def schedule(self)", "def schedule(self, budget=1)"), // 改一行
      (t) => t.replace("\n", "\nimport json\n"), // 加一行
      (t) => t.replace(/\n\s*def [^\n]*\n/, "\n"), // 删一行（破坏缩进）
      (t) => t + "\n\ndef tail():\n    return 中文()\n", // 末尾追加，带非 ASCII
      (t) => t.replace("中文", "😀x"), // 代理对
      (t) => t.replace(/\(/g, "( "), // 很多处
    ];
    for (const step of steps) {
      const prev = text;
      text = step(text);
      same(analyze("python", text, { key }), analyze("python", text));
      // 调用方给出编辑
      forgetTree(key);
      analyze("python", prev, { key });
      same(analyze("python", text, { key, edit: diffEdit(prev, text) }), analyze("python", text));
    }
    // 给错的编辑：退回按前后缀算
    same(analyze("python", f.text, { key, edit: { startIndex: 0, oldEndIndex: 1, newEndIndex: 1, startPosition: { row: 0, column: 0 }, oldEndPosition: { row: 0, column: 1 }, newEndPosition: { row: 0, column: 1 } } }), analyze("python", f.text));
    // 换语言：重新解析
    same(analyze("cuda-cpp", CPP[0].text, { key }), analyze("cuda-cpp", CPP[0].text));
    forgetTree(key);
  });
  it("the tree cache is bounded", () => {
    setTreeCacheSize(3);
    for (let i = 0; i < 6; i++) analyze("python", `x = ${i}\n`, { key: `k${i}` });
    expect(cachedTrees()).toEqual(["k3", "k4", "k5"]);
    forgetTree();
    expect(cachedTrees()).toEqual([]);
    setTreeCacheSize(16);
  });
  it("diffEdit covers the changed span", () => {
    expect(diffEdit("ab\ncd\nef", "ab\ncXd\nef")).toEqual({ startIndex: 4, oldEndIndex: 4, newEndIndex: 5, startPosition: { row: 1, column: 1 }, oldEndPosition: { row: 1, column: 1 }, newEndPosition: { row: 1, column: 2 } });
    expect(diffEdit("aaa", "aaa")).toMatchObject({ startIndex: 3, oldEndIndex: 3, newEndIndex: 3 });
    expect(diffEdit("x😀y", "x😃y")).toMatchObject({ startIndex: 1, oldEndIndex: 3, newEndIndex: 3 });
  });
});

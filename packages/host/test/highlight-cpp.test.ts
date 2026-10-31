// C / C++ / CUDA are coloured from tree-sitter's highlight query (packages/analysis/src/highlight.ts), with the board's classes
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { langInfo } from "@codeboard/analysis/langs";
import type { Tok } from "@codeboard/core";
import { highlight, tokensOf } from "../src/views";
import { REPO, startTreeSitter } from "./helpers";

beforeAll(startTreeSitter);

const SRC = `#include <cstdint>
#include "launch.cuh"
#define LAUNCH(kernel, n) { auto k = kernel; k<<<n, 128>>>(nullptr); } while (0)

namespace ep {

/* Reduce one tile
   per block */
template <int kNumThreads, typename T>
__global__ void __launch_bounds__(kNumThreads, 1)
reduce(const T* __restrict__ x, float* out, int64_t n) {
    __shared__ float smem[32];
    const auto tid = static_cast<int>(threadIdx.x);
    float acc = 0.5f; unsigned long long mask = 0xffull;
    for (int i = tid; i < n; i += kNumThreads) acc += x[i];  // strided
    if (tid == 0 && out != nullptr) out[blockIdx.x] = acc;
    printf("done %d\\n", tid);
}

struct Buffer : public Base {
    std::vector<torch::Tensor> tensors;
    int size() const noexcept { return this->tensors.size(); }
};

void launch(const float* x, float* out, int n, cudaStream_t s) {
    reduce<256, float><<<n / 256, 256, 0, s>>>(x, out, n);
    at::cuda::getCurrentCUDAStream();
}

}  // namespace ep
`;

const lines = SRC.split("\n");
/** The class of the token that starts at the n-th (default first) occurrence of word on the line containing marker */
function clsOf(toks: Tok[][], marker: string, word: string, nth = 0): string | undefined {
  const row = lines.findIndex((l) => l.includes(marker));
  let at = -1;
  for (let k = 0; k <= nth; k++) at = lines[row].indexOf(word, at + 1);
  let col = 0;
  for (const t of toks[row]) {
    if (at >= col && at < col + t.text.length) return t.cls;
    col += t.text.length;
  }
  throw new Error(`${word} not on ${marker}`);
}

describe("tree-sitter highlighting for C / C++ / CUDA", () => {
  it("is the one highlighter of C, C++ and CUDA in the language table; Python stays on shiki", () => {
    for (const l of ["c", "cpp", "cuda-cpp"]) expect(langInfo(l)?.highlight).toEqual({ by: "tree-sitter" });
    expect(langInfo("python")?.highlight).toEqual({ by: "shiki", lang: "python" });
  });

  it("colours keywords, types, functions, literals, comments and the preprocessor", async () => {
    const t = await tokensOf("cuda-cpp", SRC);
    const want: [marker: string, word: string, cls: string | undefined, nth?: number][] = [
      ["#include <cstdint>", "#include", "kw"],
      ["#include <cstdint>", "<cstdint>", "str"],
      ['#include "launch', '"launch.cuh"', "str"],
      ["namespace ep", "namespace", "kw"],
      ["template <", "template", "kw"],
      ["template <", "typename", "kw"],
      ["template <", "int", "kw"],
      ["reduce(const", "reduce", "fn"],
      ["reduce(const", "const", "kw"],
      ["reduce(const", "T", "fn"],
      ["reduce(const", "int64_t", "kw"],
      ["reduce(const", "float", "kw"],
      ["const auto tid", "auto", "kw"],
      ["const auto tid", "static_cast", "kw"],
      ["float acc", "0.5f", "num"],
      ["float acc", "0xffull", "num"],
      ["float acc", "unsigned long long", "kw"],
      ["for (int i", "for", "kw"],
      ["for (int i", "+=", "kw"],
      ["for (int i", "// strided", "com"],
      ["for (int i", "x[i]", undefined],
      ["if (tid == 0", "nullptr", "num"],
      ["if (tid == 0", "0", "num"],
      ['printf("done', "printf", "fn"],
      ['printf("done', '"done', "str"],
      ['printf("done', "\\n", "str"],
      ["struct Buffer", "struct", "kw"],
      ["struct Buffer", "Buffer", "fn"],
      ["struct Buffer", "public", "kw"],
      ["std::vector", "vector", "fn"],
      ["std::vector", "Tensor", "fn"],
      ["std::vector", "std", undefined],
      ["std::vector", "::", "p"],
      ["int size()", "size", "fn"],
      ["int size()", "noexcept", "kw"],
      ["int size()", "this", "self"],
      ["int size()", "size", "fn", 1],
      ["int size()", "return", "kw"],
      ["void launch", "launch", "fn"],
      ["void launch", "cudaStream_t", "fn"],
      ["at::cuda::get", "getCurrentCUDAStream", "fn"],
      ["at::cuda::get", "cuda", undefined],
      ["Reduce one tile", "Reduce", "com"],
      ["per block", "per", "com"],
    ];
    for (const [m, w, c, nth = 0] of want) expect([m, w, clsOf(t, m, w, nth)]).toEqual([m, w, c]);
  });

  it("colours CUDA qualifiers, builtins, launch bounds and the <<< >>> launch", async () => {
    const t = await tokensOf("cuda-cpp", SRC);
    expect(clsOf(t, "__global__", "__global__")).toBe("kw");
    expect(clsOf(t, "__global__", "__launch_bounds__")).toBe("kw");
    expect(clsOf(t, "__global__", "kNumThreads")).toBeUndefined();
    expect(clsOf(t, "__restrict__", "__restrict__")).toBe("kw");
    expect(clsOf(t, "__shared__", "__shared__")).toBe("kw");
    expect(clsOf(t, "threadIdx", "threadIdx")).toBe("num");
    expect(clsOf(t, "out[blockIdx", "blockIdx")).toBe("num");
    expect(clsOf(t, "reduce<256", "reduce")).toBe("fn");
    expect(clsOf(t, "reduce<256", "<<<")).toBe("kw");
    expect(clsOf(t, "reduce<256", ">>>")).toBe("kw");
    // the template's angle brackets are not operators, and a call's template arguments are not coloured as types
    expect(clsOf(t, "reduce<256", "<")).toBeUndefined();
    expect(clsOf(t, "reduce<256", "256")).toBe("num");
    expect(clsOf(t, "reduce<256", "float")).toBe("kw");
  });

  it("colours a #define's body as code", async () => {
    const t = await tokensOf("cuda-cpp", SRC);
    expect(clsOf(t, "#define", "#define")).toBe("kw");
    expect(clsOf(t, "#define", "LAUNCH")).toBe("fn");
    expect(clsOf(t, "#define", "auto")).toBe("kw");
    expect(clsOf(t, "#define", "<<<")).toBe("kw");
    expect(clsOf(t, "#define", "128")).toBe("num");
    expect(clsOf(t, "#define", "nullptr")).toBe("num");
    expect(clsOf(t, "#define", "while")).toBe("kw");
  });

  it("highlights lines in the middle of a block comment from the whole file", async () => {
    const snippet = ["   per block */"];
    expect(await highlight(snippet, "cpp", SRC)).toEqual(['<span class="com">   per block */</span>']);
  });

  it("keeps every character of real C++ / CUDA files, line by line", async () => {
    const dir = path.join(REPO, "packages/host/test/fixtures/crosslang");
    for (const f of [
      "csrc/kernels/intranode.cu",
      "csrc/kernels/launch.cuh",
      "csrc/deep_ep.cpp",
      "csrc/jit/dispatch.hpp",
    ]) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      const toks = await tokensOf(f.endsWith(".cpp") || f.endsWith(".hpp") ? "cpp" : "cuda-cpp", text);
      expect(toks.map((l) => l.map((x) => x.text).join(""))).toEqual(text.split(/\r?\n/));
      expect(toks.flat().some((x) => x.cls === "kw")).toBe(true);
    }
  });
});

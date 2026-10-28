// Language chips, hidden-language labels, generated-card kinds and template instance names (chip.ts)
import { describe, expect, it } from "vitest";
import { segChip, hiddenLang, genWhat, instName } from "../src";

describe("chips and card names", () => {
  const seg = (lang: string, text: string[], path = "x") => ({ lang, text, path });
  it("PY / TRITON / TILELANG / C++ / CUDA / RUST", () => {
    expect(segChip(seg("python", ["def f():", "  pass"]))).toBe("PY");
    expect(segChip(seg("python", ["@triton.jit", "def k(x):"]))).toBe("TRITON");
    expect(segChip(seg("python", ["@T.prim_func", "def main(Q):"]))).toBe("TILELANG");
    expect(segChip(seg("python", ["@tilelang.jit(out_idx=[-1])", "def f(h):"]))).toBe("TILELANG");
    expect(segChip(seg("cpp", ["torch::Tensor f() {"], "a.cpp"))).toBe("C++");
    expect(segChip(seg("cpp", ["template <int N>", "__global__ void k() {"], "a.hpp"))).toBe("CUDA");
    expect(segChip(seg("cpp", ["void f() {"], "k.cuh"))).toBe("CUDA");
    expect(segChip(seg("cuda-cpp", ["void f() {"]))).toBe("CUDA");
    expect(segChip(seg("rust", ["fn f() {}"]))).toBe("RUST");
    expect(segChip(seg("plaintext", ["x"]))).toBeUndefined();
    expect(hiddenLang(seg("python", ["def f():"], "a.py"))).toBeUndefined();
    expect(hiddenLang(seg("python", ["@triton.jit", "def k(x):"], "k.py"))).toBe("Triton");
    expect(hiddenLang(seg("cpp", ["__global__ void k() {"], "a.hpp"))).toBe("CUDA");
    expect(hiddenLang(seg("cpp", ["void f() {"], "a.cpp"))).toBeUndefined();
    expect(hiddenLang(seg("cuda-cpp", ["void f() {"], "k.cu"))).toBeUndefined();
  });
  it("template instance name", () => {
    expect(instName("dispatch", [{ value: "8" }, { value: "768" }, { value: "8192" }])).toBe("dispatch<8, 768, 8192>");
    expect(instName("plain", [])).toBe("plain");
  });
  it("Generated card: what it is", () => {
    expect(genWhat("cuda-cpp", "kernel.cu")).toBe("CUDA source");
    expect(genWhat("python", "/tmp/torchinductor_root/ab/cab.py")).toBe("Inductor output");
    expect(genWhat("plaintext", "k.ptx")).toBe("PTX");
  });
});

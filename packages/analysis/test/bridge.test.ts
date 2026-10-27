// 跨语言边界的文本识别（线框 02）：pybind、TORCH_LIBRARY、PyO3、launch macro、JIT 编译、Triton、TileLang
import { beforeAll, describe, expect, it } from "vitest";
import {
  initAnalysis, analyze, pybindDefs, torchLibDefs, torchOpOf, pyo3Defs, macroDefs, launchMacro, launchVals, templateParams, constexprs,
  jitKernels, tritonInfo, tritonVals, tilelangInner, factoryVals, launchTemplateArgs, bindLaunch, splitArgs,
} from "../src";

beforeAll(() => initAnalysis());

const PYBIND = `#include <pybind11/pybind11.h>
PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
    pybind11::class_<deep_ep::Buffer>(m, "Buffer")
        .def(pybind11::init<int, int, int64_t, int64_t, bool, bool, bool, bool>())
        .def("is_available", &deep_ep::Buffer::is_available)
        .def("intranode_dispatch", &deep_ep::Buffer::intranode_dispatch)
        .def("get_size", [](deep_ep::Buffer& b) { return b.size; });
    m.def("get_low_latency_rdma_size_hint", &deep_ep::get_low_latency_rdma_size_hint);
}
`;

describe("pybind", () => {
  it("finds .def and m.def registrations with their C++ targets", () => {
    expect(pybindDefs(PYBIND, "intranode_dispatch")).toEqual([{ line: 6, target: "deep_ep::Buffer::intranode_dispatch", how: ".def" }]);
    expect(pybindDefs(PYBIND, "get_low_latency_rdma_size_hint")).toEqual([{ line: 8, target: "deep_ep::get_low_latency_rdma_size_hint", how: "m.def" }]);
    expect(pybindDefs(PYBIND, "get_size")).toEqual([{ line: 7, lambda: true, how: ".def" }]);
    expect(pybindDefs(PYBIND, "nope")).toEqual([]);
    expect(pybindDefs("void f() { x.def(\"intranode_dispatch\", &g); }", "intranode_dispatch")).toEqual([]); // 不是 pybind 文件
  });
});

describe("torch.ops / TORCH_LIBRARY", () => {
  const src = `TORCH_LIBRARY_FRAGMENT(sgl_kernel, m) {
  m.def("dispose", &dispose);
  m.def(
      "init_custom_ar(int[] ipc_tensors, Tensor rank_data, "
      "int rank, bool full_nvlink) -> int");
  m.impl("init_custom_ar", torch::kCUDA, &init_custom_ar);
  m.def("rms(Tensor x) -> ()", TORCH_FN(rms_norm));
}`;
  it("m.def with a function, schema + m.impl, TORCH_FN", () => {
    expect(torchLibDefs(src, "dispose")).toEqual([{ line: 2, target: "dispose", how: "m.def" }]);
    expect(torchLibDefs(src, "init_custom_ar")).toEqual([{ line: 6, target: "init_custom_ar", how: "m.impl" }]);
    expect(torchLibDefs(src, "rms")).toEqual([{ line: 7, target: "rms_norm", how: "m.def" }]);
  });
  it("torch.ops.ns.op(…) and .default", () => {
    expect(torchOpOf({ name: "awq_marlin_repack", recv: "torch.ops.sgl_kernel" })).toEqual({ ns: "sgl_kernel", op: "awq_marlin_repack" });
    expect(torchOpOf({ name: "default", recv: "torch.ops.sgl_kernel.awq_marlin_repack" })).toEqual({ ns: "sgl_kernel", op: "awq_marlin_repack" });
    expect(torchOpOf({ name: "forward", recv: "self.impl" })).toBeNull();
  });
});

describe("PyO3", () => {
  const src = `use pyo3::prelude::*;

#[pyfunction]
fn tokenize(s: &str) -> usize { s.len() }

#[pyfunction]
#[pyo3(name = "radix_insert")]
fn insert_impl(k: u32) {}

#[pyclass]
struct Tree {}

#[pymethods]
impl Tree {
    fn match_prefix(&self) {}
}

fn private_helper() {}
`;
  it("#[pyfunction], renamed by #[pyo3(name)], #[pymethods] methods", () => {
    const syms = analyze("rust", src).symbols;
    expect(pyo3Defs(src, syms, "tokenize").map((s) => s.qual)).toEqual(["tokenize"]);
    expect(pyo3Defs(src, syms, "radix_insert").map((s) => s.qual)).toEqual(["insert_impl"]);
    expect(pyo3Defs(src, syms, "match_prefix").map((s) => s.qual)).toEqual(["Tree::match_prefix"]);
    expect(pyo3Defs(src, syms, "private_helper")).toEqual([]);
  });
});

// DeepEP v1.2.1 csrc/kernels/intranode.cu + launch.cuh（删减）
const LAUNCH_CUH = `#define SWITCH_RANKS(case_macro) \\
    switch (num_ranks) { \\
        case 2: case_macro(2); \\
        case 4: case_macro(4); \\
        case 8: case_macro(8); \\
        default: EP_HOST_ASSERT(false and "Unsupported ranks"); \\
    } while (false)
`;
const INTRANODE = `template <int kNumRanks, int kNumThreads, int kNumTMABytesPerWarp>
__global__ void __launch_bounds__(kNumThreads, 1)
dispatch(int4* recv_x, int num_tokens) {
}

void dispatch(void* recv_x, int num_tokens, int num_ranks, cudaStream_t stream, int num_sms) {
    constexpr int kNumThreads = 768;
    constexpr int kNumTMABytesPerWarp = 8192;
#define DISPATCH_LAUNCH_CASE(ranks) { \\
    auto kernel = dispatch<ranks, kNumThreads, kNumTMABytesPerWarp>; \\
    SET_SHARED_MEMORY_FOR_TMA(kernel); \\
    LAUNCH_KERNEL(&cfg, kernel, \\
        reinterpret_cast<int4*>(recv_x), num_tokens); \\
    } break

    SETUP_LAUNCH_CONFIG(num_sms, kNumThreads, stream);
    SWITCH_RANKS(DISPATCH_LAUNCH_CASE);
#undef DISPATCH_LAUNCH_CASE
}
`;

describe("launch macro", () => {
  it("SWITCH_RANKS(DISPATCH_LAUNCH_CASE) → dispatch<ranks, …> with the switch cases", () => {
    const a = analyze("cuda-cpp", INTRANODE);
    const call = a.calls.find((c) => c.name === "SWITCH_RANKS")!;
    expect(call).toBeTruthy();
    const lm = launchMacro(call, macroDefs(INTRANODE), macroDefs(LAUNCH_CUH))!;
    expect(lm).toMatchObject({ kernel: "dispatch", targs: ["ranks", "kNumThreads", "kNumTMABytesPerWarp"], param: "ranks", cases: ["2", "4", "8"], on: "num_ranks" });
    expect(templateParams(INTRANODE.split("\n").slice(0, 3).join("\n"))).toEqual(["kNumRanks", "kNumThreads", "kNumTMABytesPerWarp"]);
    expect(constexprs(INTRANODE)).toEqual({ kNumThreads: "768", kNumTMABytesPerWarp: "8192" });
    const vals = launchVals(lm, INTRANODE.split("\n").slice(0, 3).join("\n"), INTRANODE);
    expect(vals).toEqual([
      { name: "kNumRanks", value: "8", opts: ["2", "4", "8"], from: "SWITCH_RANKS(num_ranks)" },
      { name: "kNumThreads", value: "768" },
      { name: "kNumTMABytesPerWarp", value: "8192" },
    ]);
  });
  it("kernel<…><<<…>>>: template arguments at the launch", () => {
    const line = "  dispatch<8, kNumThreads><<<grid, 256>>>(p);";
    expect(launchTemplateArgs(line, 2)).toEqual(["8", "kNumThreads"]);
    expect(bindLaunch("template <int kNumRanks, int kNumThreads>\n__global__ void dispatch(", ["8", "kNumThreads"], "constexpr int kNumThreads = 768;")).toEqual([{ name: "kNumRanks", value: "8" }, { name: "kNumThreads", value: "768" }]);
    expect(launchTemplateArgs("  plain<<<1, 1>>>();", 2)).toEqual([]);
    expect(templateParams("template <bool kLow, int kNumRDMARanks,\n          int kNumTopk = get_num(kNumRDMARanks)>\n__global__ void __launch_bounds__(((kW + 1) * 32), 1)")).toEqual(["kLow", "kNumRDMARanks", "kNumTopk"]);
  });
});

describe("JIT compile (DeepEP main)", () => {
  const fn = `static void launch_dispatch(int num_scaleout_ranks) {
    std::string header_name, func_name;
    if (num_scaleout_ranks == 1) {
        header_name = "dispatch";
        func_name = std::format("dispatch_impl<{}, {}, {}>",
            is_scaleup_nvlink, num_sms, num_scaleup_ranks);
    } else {
        header_name = "hybrid_dispatch";
        func_name = std::format("hybrid_dispatch_impl<{}, {}>",
            num_sms, num_scaleout_ranks);
    }
    const auto kernel = jit->compile("dispatch", std::format(R"(
#include <deep_ep/impls/ep/{}.cuh>

static void __instantiate_kernel() {{
    auto ptr = reinterpret_cast<void*>(&deep_ep::ep::{});
}}
)", header_name, func_name));
}`;
  it("both branches, header and kernel names, template arguments", () => {
    const at = fn.indexOf("jit->compile");
    const call = fn.slice(at, fn.indexOf("));", at) + 3);
    expect(jitKernels(call, fn)).toEqual([
      { header: "deep_ep/impls/ep/dispatch.cuh", kernel: "dispatch_impl", targs: ["is_scaleup_nvlink", "num_sms", "num_scaleup_ranks"], ns: "deep_ep::ep" },
      { header: "deep_ep/impls/ep/hybrid_dispatch.cuh", kernel: "hybrid_dispatch_impl", targs: ["num_sms", "num_scaleout_ranks"], ns: "deep_ep::ep" },
    ]);
  });
});

describe("Triton / TileLang", () => {
  const src = `import triton
import triton.language as tl

@triton.autotune(
    configs=[
        triton.Config({"BLOCK_M": 64, "BLOCK_N": 128}, num_stages=3, num_warps=4),
        triton.Config({"BLOCK_M": 128, "BLOCK_N": 64}, num_stages=4, num_warps=8),
    ],
    key=["N"],
)
@triton.jit
def fused_kernel(a_ptr, N, group_n: tl.constexpr, BLOCK_K: tl.constexpr, BLOCK_M: tl.constexpr, BLOCK_N: tl.constexpr):
    pid = tl.program_id(0)


def launch(a, n):
    grid = (n,)
    fused_kernel[grid](a, n, 0, BLOCK_K=32)
`;
  it("constexpr arguments, autotune configs as alternatives", () => {
    const a = analyze("python", src);
    const sym = a.symbols.find((s) => s.name === "fused_kernel")!;
    const info = tritonInfo(src.split("\n"), sym);
    expect(info.jit).toBe(true);
    expect(info.constexprs).toEqual(["group_n", "BLOCK_K", "BLOCK_M", "BLOCK_N"]);
    expect(info.configs.length).toBe(2);
    const call = a.calls.find((c) => c.name === "fused_kernel")!;
    expect(call.launch).toBe("grid");
    const { vals, alts } = tritonVals(info, sym.params.map((p) => p.name), call.args);
    expect(vals.map((v) => `${v.name}=${v.value}`)).toEqual(["group_n=0", "BLOCK_K=32", "BLOCK_M=64", "BLOCK_N=128", "stages=3", "warps=4"]);
    expect(alts).toEqual([{ label: "config 2 · BLOCK_M=128 BLOCK_N=64 stages=4 warps=8", vals: [{ name: "group_n", value: "0" }, { name: "BLOCK_K", value: "32" }, { name: "BLOCK_M", value: "128" }, { name: "BLOCK_N", value: "64" }, { name: "stages", value: "4" }, { name: "warps", value: "8" }] }]);
  });
  it("TileLang factory → inner prim_func, factory parameters as values", () => {
    const tl = `import tilelang
import tilelang.language as T

@tilelang.jit(out_idx=[-1])
def flashmla_decode(h, block_N=64, num_stages=2):
    blk = 32

    @T.prim_func
    def main(Q: T.Tensor):
        with T.Kernel(1) as bx:
            pass

    return main


def run(q):
    kernel = flashmla_decode(16, block_N=128, num_stages=2)
    return kernel(q)
`;
    const a = analyze("python", tl);
    const f = a.symbols.find((s) => s.qual === "flashmla_decode")!;
    const inner = tilelangInner(tl.split("\n"), f, a.symbols)!;
    expect(inner.qual).toBe("flashmla_decode.main");
    const call = a.calls.find((c) => c.name === "flashmla_decode")!;
    expect(factoryVals(f.params, call.args)).toEqual([{ name: "h", value: "16" }, { name: "block_N", value: "128" }, { name: "num_stages", value: "2" }]);
    expect(tilelangInner(tl.split("\n"), a.symbols.find((s) => s.qual === "run")!, a.symbols)).toBeUndefined();
  });
  it("splitArgs keeps nested brackets and strings", () => {
    expect(splitArgs(`a, f(b, c), "x, y", [1, 2], t<int, 2>`)).toEqual(["a", "f(b, c)", `"x, y"`, "[1, 2]", "t<int, 2>"]);
  });
});

describe("dynamic dispatch", () => {
  it("abstract base methods", async () => {
    const { isAbstractBody } = await import("../src");
    const src = `class Base:
    def forward(self, x):
        """Run it."""
        raise NotImplementedError

    @abstractmethod
    def other(self):
        return 1

    def real(self, x):
        return x + 1

    def dots(self): ...
`;
    const a = analyze("python", src);
    const by = (q: string) => a.symbols.find((s) => s.qual === q)!;
    const ls = src.split("\n");
    expect(["Base.forward", "Base.other", "Base.real", "Base.dots"].map((q) => isAbstractBody(ls, by(q)))).toEqual([true, true, false, true]);
  });
});

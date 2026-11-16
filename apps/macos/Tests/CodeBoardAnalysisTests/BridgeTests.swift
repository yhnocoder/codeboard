import Testing

@testable import CodeBoardAnalysis

// As packages/analysis/test/bridge.test.ts, with its sources inline and analysed by `analyze` as there.

private let pybind = """
  #include <pybind11/pybind11.h>
  PYBIND11_MODULE(TORCH_EXTENSION_NAME, m) {
      pybind11::class_<deep_ep::Buffer>(m, "Buffer")
          .def(pybind11::init<int, int, int64_t, int64_t, bool, bool, bool, bool>())
          .def("is_available", &deep_ep::Buffer::is_available)
          .def("intranode_dispatch", &deep_ep::Buffer::intranode_dispatch)
          .def("get_size", [](deep_ep::Buffer& b) { return b.size; });
      m.def("get_low_latency_rdma_size_hint", &deep_ep::get_low_latency_rdma_size_hint);
  }

  """

@Suite struct PybindTests {
  @Test func findsDefAndModuleDefRegistrationsWithTheirCppTargets() {
    #expect(
      pybindDefs(pybind, "intranode_dispatch") == [
        Registration(line: 6, target: "deep_ep::Buffer::intranode_dispatch", how: ".def")
      ])
    #expect(
      pybindDefs(pybind, "get_low_latency_rdma_size_hint") == [
        Registration(line: 8, target: "deep_ep::get_low_latency_rdma_size_hint", how: "m.def")
      ])
    #expect(pybindDefs(pybind, "get_size") == [Registration(line: 7, lambda: true, how: ".def")])
    #expect(pybindDefs(pybind, "nope") == [])
    // not a pybind file
    #expect(pybindDefs(#"void f() { x.def("intranode_dispatch", &g); }"#, "intranode_dispatch") == [])
  }

  @Test func linesCountInUTF16AfterNonASCIIText() {
    let src = "// 绑定 😀\n#include <pybind11/pybind11.h>\n// 注释\nm.def(\"ä\", &f);\n  m.def(\"run\", &ns::run);\n"
    #expect(pybindDefs(src, "run") == [Registration(line: 5, target: "ns::run", how: "m.def")])
    // \w is ASCII only in JavaScript, so a non-ASCII name is not found by the whole-file scan
    #expect(pybindAll(src).map(\.name) == ["run"])
  }
}

@Suite struct PyTorchBindingTests {
  @Test func pybindDefsInAFileThatOnlyIncludesTorchsPybindHeaderThroughWrapPybindFunction() {
    let src =
      "#include <torch/csrc/utils/pybind.h>\nvoid init(py::module& m) {\n  m.def(\"_a\", torch::wrap_pybind_function(is_available));\n  m.def(\"_b\", wrap_pybind_function_no_gil(&ns::f));\n}\n"
    #expect(pybindDefs(src, "_a") == [Registration(line: 3, target: "is_available", how: "m.def")])
    #expect(pybindDefs(src, "_b") == [Registration(line: 4, target: "ns::f", how: "m.def")])
    #expect(pybindAll(src).map(\.name) == ["_a", "_b"])
  }

  @Test func pyMethodDefTablesPlainCastAndTypeErrorToNotImplemented() {
    let src =
      "static PyMethodDef methods[] = {\n  {\"_get_cudnn_enabled\", THPModule_userEnabledCuDNN, METH_NOARGS, nullptr},\n  {\"_set\", castPyCFunctionWithKeywords(THPModule_set), METH_VARARGS | METH_KEYWORDS, nullptr},\n  {\"__add__\", castPyCFunctionWithKeywords(TypeError_to_NotImplemented_<THPVariable_add>), METH_VARARGS, NULL},\n};\n"
    #expect(
      pyMethodDefs(src, "_get_cudnn_enabled") == [
        Registration(line: 2, target: "THPModule_userEnabledCuDNN", how: "PyMethodDef")
      ])
    #expect(pyMethodDefs(src, "_set").first?.target == "THPModule_set")
    #expect(pyMethodDefs(src, "__add__").first?.target == "THPVariable_add")
    #expect(pyMethodDefs(src, "nope") == [])
    #expect(
      pyMethodAll(src).map { "\($0.name) → \($0.target ?? "")" } == [
        "_get_cudnn_enabled → THPModule_userEnabledCuDNN",
        "_set → THPModule_set",
        "__add__ → THPVariable_add",
      ])
  }

  @Test func dispatchStubRegistrationsAndTheirDevice() {
    let src =
      "#define REGISTER_DISPATCH(name, fn) X(name, fn)\nREGISTER_DISPATCH(abs_stub, &abs_kernel_cuda)\nREGISTER_ARCH_DISPATCH(abs_stub, DEFAULT, &abs_kernel)\nREGISTER_NO_CPU_DISPATCH(abs_stub);\nREGISTER_CUDA_DISPATCH(abs_stub, &qadd_kernel<false>);\n"
    #expect(
      dispatchAll(src).map { "\($0.name) \($0.line) \($0.macro) \($0.target)" } == [
        "abs_stub 2 REGISTER_DISPATCH abs_kernel_cuda",
        "abs_stub 3 REGISTER_ARCH_DISPATCH abs_kernel",
        "abs_stub 5 REGISTER_CUDA_DISPATCH qadd_kernel",
      ])
    #expect(stubDevice("REGISTER_DISPATCH", "aten/src/ATen/native/cuda/AbsKernel.cu") == "CUDA")
    #expect(stubDevice("REGISTER_DISPATCH", "aten/src/ATen/native/cpu/AbsKernel.cpp") == "CPU")
    #expect(stubDevice("REGISTER_DISPATCH", "aten/src/ATen/native/mps/operations/Unary.mm") == "MPS")
    #expect(stubDevice("REGISTER_AVX512_DISPATCH", "x.cpp") == "CPU")
    #expect(stubDevice("REGISTER_XPU_DISPATCH", "x.cpp") == "XPU")
  }

  @Test func windowsPathsAndRegistrationsAfterADefineLine() {
    #expect(stubDevice("REGISTER_DISPATCH", #"aten\native\cuda\X.cpp"#) == "CUDA")
    #expect(stubDevice("ALSO_REGISTER_MPS_DISPATCH", "x.cpp") == "MPS")
    // a #define line counts as the line of everything after it up to the next newline only
    let src = "// 中文\n#define R(x) x\n\n#  define Q REGISTER_DISPATCH(a_stub, &a)\nREGISTER_DISPATCH(b_stub, &b);\n"
    #expect(dispatchAll(src).map(\.name) == ["b_stub"])
  }
}

@Suite struct TorchLibraryTests {
  private let src = """
    TORCH_LIBRARY_FRAGMENT(sgl_kernel, m) {
      m.def("dispose", &dispose);
      m.def(
          "init_custom_ar(int[] ipc_tensors, Tensor rank_data, "
          "int rank, bool full_nvlink) -> int");
      m.impl("init_custom_ar", torch::kCUDA, &init_custom_ar);
      m.def("rms(Tensor x) -> ()", TORCH_FN(rms_norm));
    }
    """

  @Test func moduleDefWithAFunctionSchemaWithImplAndTorchFn() {
    #expect(torchLibDefs(src, "dispose") == [Registration(line: 2, target: "dispose", how: "m.def")])
    #expect(torchLibDefs(src, "init_custom_ar") == [Registration(line: 6, target: "init_custom_ar", how: "m.impl")])
    #expect(torchLibDefs(src, "rms") == [Registration(line: 7, target: "rms_norm", how: "m.def")])
  }

  @Test func torchOpsNamespaceOpAndDefault() {
    #expect(
      torchOpOf(name: "awq_marlin_repack", recv: "torch.ops.sgl_kernel")
        == TorchOp(ns: "sgl_kernel", op: "awq_marlin_repack"))
    #expect(
      torchOpOf(name: "default", recv: "torch.ops.sgl_kernel.awq_marlin_repack")
        == TorchOp(ns: "sgl_kernel", op: "awq_marlin_repack"))
    #expect(torchOpOf(name: "forward", recv: "self.impl") == nil)
    #expect(torchOpOf(name: "Tensor", recv: "torch.ops.aten.add") == TorchOp(ns: "aten", op: "add", overload: "Tensor"))
  }

  @Test func lambdasAndBuiltinTargets() {
    let src = "TORCH_LIBRARY(ns, m) {\n  m.impl(\"f\", [](Tensor x) { return x; });\n  m.impl(\"g\", kCPU);\n}\n"
    #expect(torchLibDefs(src, "f") == [Registration(line: 2, lambda: true, how: "m.impl")])
    #expect(torchLibDefs(src, "g") == [])
    #expect(torchOpOf(name: "x", recv: nil) == nil)
  }
}

private let pyo3 = """
  use pyo3::prelude::*;

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

  """

@Suite struct PyO3Tests {
  @Test func pyfunctionRenamedByPyo3NameAndPymethodsMethods() throws {
    let src = pyo3
    let a = analyze("rust", src)
    #expect(pyo3Defs(src, a.symbols, "tokenize").map(\.qual) == ["tokenize"])
    #expect(pyo3Defs(src, a.symbols, "radix_insert").map(\.qual) == ["insert_impl"])
    #expect(pyo3Defs(src, a.symbols, "match_prefix").map(\.qual) == ["Tree::match_prefix"])
    #expect(pyo3Defs(src, a.symbols, "private_helper") == [])
  }
}

// DeepEP v1.2.1 csrc/kernels/intranode.cu and launch.cuh (cut down)
private let intranode = #"""
  template <int kNumRanks, int kNumThreads, int kNumTMABytesPerWarp>
  __global__ void __launch_bounds__(kNumThreads, 1)
  dispatch(int4* recv_x, int num_tokens) {
  }

  void dispatch(void* recv_x, int num_tokens, int num_ranks, cudaStream_t stream, int num_sms) {
      constexpr int kNumThreads = 768;
      constexpr int kNumTMABytesPerWarp = 8192;
  #define DISPATCH_LAUNCH_CASE(ranks) { \
      auto kernel = dispatch<ranks, kNumThreads, kNumTMABytesPerWarp>; \
      SET_SHARED_MEMORY_FOR_TMA(kernel); \
      LAUNCH_KERNEL(&cfg, kernel, \
          reinterpret_cast<int4*>(recv_x), num_tokens); \
      } break

      SETUP_LAUNCH_CONFIG(num_sms, kNumThreads, stream);
      SWITCH_RANKS(DISPATCH_LAUNCH_CASE);
  #undef DISPATCH_LAUNCH_CASE
  }

  """#

private let launchCuh = """
  #define SWITCH_RANKS(case_macro) \\
      switch (num_ranks) { \\
          case 2: case_macro(2); \\
          case 4: case_macro(4); \\
          case 8: case_macro(8); \\
          default: EP_HOST_ASSERT(false and "Unsupported ranks"); \\
      } while (false)

  """

@Suite struct LaunchMacroTests {
  @Test func switchRanksOfACaseMacroLaunchesTheKernelWithTheSwitchCases() throws {
    let src = intranode
    let a = analyze("cuda-cpp", src)
    let call = try #require(a.calls.first { $0.name == "SWITCH_RANKS" })
    let lm = try #require(
      launchMacro(name: call.name, args: call.args, defs: macroDefs(src), switches: macroDefs(launchCuh)))
    #expect(lm.kernel == "dispatch")
    #expect(lm.targs == ["ranks", "kNumThreads", "kNumTMABytesPerWarp"])
    #expect(lm.param == "ranks")
    #expect(lm.cases == ["2", "4", "8"])
    #expect(lm.on == "num_ranks")
    let head = src.jsSplit("\n").prefix(3).joined(separator: "\n")
    #expect(templateParams(head) == ["kNumRanks", "kNumThreads", "kNumTMABytesPerWarp"])
    #expect(constexprs(src) == ["kNumThreads": "768", "kNumTMABytesPerWarp": "8192"])
    #expect(
      launchVals(lm, head, src) == [
        BoundVal(name: "kNumRanks", value: "8", opts: ["2", "4", "8"], from: "SWITCH_RANKS(num_ranks)"),
        BoundVal(name: "kNumThreads", value: "768"),
        BoundVal(name: "kNumTMABytesPerWarp", value: "8192"),
      ])
  }

  @Test func theCaseMacroItselfAndLaunchKernelWithAKernelArgument() throws {
    let src = intranode
    let defs = macroDefs(src)
    let own = try #require(
      launchMacro(name: "DISPATCH_LAUNCH_CASE", args: [Arg(text: "8")], defs: defs, switches: NameMap()))
    #expect(
      own
        == LaunchMacro(
          kernel: "dispatch", targs: ["ranks", "kNumThreads", "kNumTMABytesPerWarp"],
          param: "ranks", cases: ["8"], switchName: "DISPATCH_LAUNCH_CASE"))
    let direct = launchMacro(
      name: "LAUNCH_KERNEL", args: [Arg(text: "&cfg"), Arg(text: "k<4, 2>"), Arg(text: "x")], defs: defs,
      switches: NameMap())
    #expect(direct == LaunchMacro(kernel: "k", targs: ["4", "2"], switchName: "LAUNCH_KERNEL"))
    #expect(launchMacro(name: "NOPE", args: [Arg(text: "a")], defs: defs, switches: NameMap()) == nil)
  }

  @Test func templateArgumentsAtAChevronLaunch() {
    let line = "  dispatch<8, kNumThreads><<<grid, 256>>>(p);"
    #expect(launchTemplateArgs(line, 2) == ["8", "kNumThreads"])
    #expect(
      bindLaunch(
        "template <int kNumRanks, int kNumThreads>\n__global__ void dispatch(", ["8", "kNumThreads"],
        "constexpr int kNumThreads = 768;")
        == [BoundVal(name: "kNumRanks", value: "8"), BoundVal(name: "kNumThreads", value: "768")])
    #expect(launchTemplateArgs("  plain<<<1, 1>>>();", 2) == [])
    #expect(
      templateParams(
        "template <bool kLow, int kNumRDMARanks,\n          int kNumTopk = get_num(kNumRDMARanks)>\n__global__ void __launch_bounds__(((kW + 1) * 32), 1)"
      ) == ["kLow", "kNumRDMARanks", "kNumTopk"])
  }

  @Test func launchColumnsCountInUTF16() {
    let line = "/*注😀*/ k<2, kN><<<1, 1>>>();"
    #expect(launchTemplateArgs(line, 8) == ["2", "kN"])
    #expect(
      bindLaunch("template <int A>", ["some_quite_long_expression(with, args, inside)"], "")
        == [BoundVal(name: "A", value: "some_quite_long_expression(with…")])
  }
}

@Suite struct JitCompileTests {
  private let fn = """
    static void launch_dispatch(int num_scaleout_ranks) {
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
    }
    """

  @Test func bothBranchesWithHeaderAndKernelNamesAndTemplateArguments() {
    let t = JSText(fn)
    let at = t.indexOf("jit->compile")
    let call = t.slice(at, t.indexOf("));", from: at) + 3)
    #expect(
      jitKernels(call, fn) == [
        JitKernel(
          header: "deep_ep/impls/ep/dispatch.cuh", kernel: "dispatch_impl",
          targs: ["is_scaleup_nvlink", "num_sms", "num_scaleup_ranks"], ns: "deep_ep::ep"),
        JitKernel(
          header: "deep_ep/impls/ep/hybrid_dispatch.cuh", kernel: "hybrid_dispatch_impl",
          targs: ["num_sms", "num_scaleout_ranks"], ns: "deep_ep::ep"),
      ])
  }
}

private let triton = """
  import triton
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

  """

private let tilelang = """
  import tilelang
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

  """

@Suite struct TritonTileLangTests {
  @Test func constexprArgumentsAndAutotuneConfigsAsAlternatives() throws {
    let src = triton
    let a = analyze("python", src)
    let sym = try #require(a.symbols.first { $0.name == "fused_kernel" })
    let info = tritonInfo(src.jsSplit("\n"), sym)
    #expect(info.jit)
    #expect(info.constexprs == ["group_n", "BLOCK_K", "BLOCK_M", "BLOCK_N"])
    #expect(info.configs.count == 2)
    let call = try #require(a.calls.first { $0.name == "fused_kernel" })
    #expect(call.launch == .grid)
    let (vals, alts) = tritonVals(info, sym.params.map(\.name), call.args)
    #expect(
      vals.map { "\($0.name)=\($0.value)" } == [
        "group_n=0", "BLOCK_K=32", "BLOCK_M=64", "BLOCK_N=128", "stages=3", "warps=4",
      ])
    #expect(
      alts == [
        CallAlt(
          label: "config 2 · BLOCK_M=128 BLOCK_N=64 stages=4 warps=8",
          vals: [
            BoundVal(name: "group_n", value: "0"), BoundVal(name: "BLOCK_K", value: "32"),
            BoundVal(name: "BLOCK_M", value: "128"), BoundVal(name: "BLOCK_N", value: "64"),
            BoundVal(name: "stages", value: "4"), BoundVal(name: "warps", value: "8"),
          ])
      ])
  }

  @Test func withoutConstantsAtMostThreeExpressionsAreShown() {
    let info = TritonInfo(jit: true, constexprs: ["A", "B", "C", "D"], configs: [])
    let args = [Arg(text: "x"), Arg(text: "n * 2"), Arg(text: "m"), Arg(text: "k", kw: "D"), Arg(text: "z", kw: "C")]
    let (vals, alts) = tritonVals(info, ["p", "A", "B"], args)
    #expect(
      vals == [BoundVal(name: "A", value: "n * 2"), BoundVal(name: "B", value: "m"), BoundVal(name: "D", value: "k")])
    #expect(alts.isEmpty)
  }

  @Test func tileLangFactoryLeadsToItsPrimFuncWithFactoryParametersAsValues() throws {
    let src = tilelang
    let a = analyze("python", src)
    let lines = src.jsSplit("\n")
    let f = try #require(a.symbols.first { $0.qual == "flashmla_decode" })
    #expect(tilelangInner(lines, f, a.symbols)?.qual == "flashmla_decode.main")
    let call = try #require(a.calls.first { $0.name == "flashmla_decode" })
    #expect(
      factoryVals(f.params, call.args) == [
        BoundVal(name: "h", value: "16"), BoundVal(name: "block_N", value: "128"),
        BoundVal(name: "num_stages", value: "2"),
      ])
    let run = try #require(a.symbols.first { $0.qual == "run" })
    #expect(tilelangInner(lines, run, a.symbols) == nil)
  }

  @Test func splitArgsKeepsNestedBracketsAndStrings() {
    #expect(
      splitArgs(#"a, f(b, c), "x, y", [1, 2], t<int, 2>"#) == ["a", "f(b, c)", #""x, y""#, "[1, 2]", "t<int, 2>"])
    #expect(splitArgs(#" 名字, "引号\", 里", 😀 "#) == ["名字", #""引号\", 里""#, "😀"])
    #expect(splitArgs("  ") == [])
  }
}

private let abstract = #"""
  class Base:
      def forward(self, x):
          """Run it."""
          raise NotImplementedError

      @abstractmethod
      def other(self):
          return 1

      def real(self, x):
          return x + 1

      def dots(self): ...

  """#

@Suite struct DynamicDispatchTests {
  @Test func abstractBaseMethods() throws {
    let src = abstract
    let a = analyze("python", src)
    let lines = src.jsSplit("\n")
    let results = try ["Base.forward", "Base.other", "Base.real", "Base.dots"].map { q in
      isAbstractBody(lines, try #require(a.symbols.first { $0.qual == q }))
    }
    #expect(results == [true, true, false, true])
  }
}

@Suite struct TokenPastingTests {
  private let src = """
    #define CREATE_COMPARISON_SCALAR_TENSOR_IMPL_FUNC(func)            \\
      TORCH_IMPL_FUNC(func##_Tensor_out)                                \\
      (const Tensor& self, const Tensor& other, const Tensor& result) { \\
        func##_stub(device_type(), *this);                              \\
      }                                                                 \\
      TORCH_IMPL_FUNC(func ## _Scalar_out)                              \\
      (const Tensor& self, const Scalar& other, const Tensor& result) { \\
        INNER_CALL(func);                                               \\
      }

    #define FOREACH_BINARY_OP_SCALAR(FUNCTION, NAME, OP)                   \\
      std::vector<Tensor> foreach_tensor_##NAME##_scalar_kernel_cuda(      \\
          TensorList tensors, const Scalar& scalar) {                      \\
        return FUNCTION<OP>(tensors, scalar);                               \\
      }

    #define PLAIN(x) x

    CREATE_COMPARISON_SCALAR_TENSOR_IMPL_FUNC(eq);
    FOREACH_BINARY_OP_SCALAR(all_types_complex_bool_half_bfloat16, add, std::plus<opmath_t>);
    FOREACH_BINARY_OP_SCALAR(all_types, mul(x), std::multiplies);

    """

  @Test func findsTheNamesADefinePastesFromItsParametersNotMacrosWithoutPasting() throws {
    let ps = pasteMacros(src)
    #expect(ps.keys == ["CREATE_COMPARISON_SCALAR_TENSOR_IMPL_FUNC", "FOREACH_BINARY_OP_SCALAR"])
    #expect(
      try #require(ps["CREATE_COMPARISON_SCALAR_TENSOR_IMPL_FUNC"]).names == [
        [.param(0), .text("_Tensor_out")], [.param(0), .text("_stub")], [.param(0), .text("_Scalar_out")],
      ])
  }

  @Test func makesEachCallsNamesAtItsLineSkippingNonIdentifierArgumentsAndCallsInADefine() throws {
    let ps = pasteMacros(src)
    let calls = macroCalls(src) { ps[$0] != nil }
    let made = try calls.map { c in "\(c.macro) \(c.line) \(pastedNames(try #require(ps[c.macro]), c.args))" }
    #expect(
      made == [
        #"CREATE_COMPARISON_SCALAR_TENSOR_IMPL_FUNC 19 ["eq_Tensor_out", "eq_stub", "eq_Scalar_out"]"#,
        #"FOREACH_BINARY_OP_SCALAR 20 ["foreach_tensor_add_scalar_kernel_cuda"]"#,
        "FOREACH_BINARY_OP_SCALAR 21 []",
      ])
    #expect(calls[1].sig == "FOREACH_BINARY_OP_SCALAR(all_types_complex_bool_half_bfloat16, add, std::plus<opmath_t>);")
    #expect(macroCalls(src) { $0 == "TORCH_IMPL_FUNC" || $0 == "INNER_CALL" } == [])
  }

  @Test func macroDefinitionsJoinContinuedLinesAndKeepTheirLine() throws {
    let defs = macroDefs("// 中文 😀\r\n#define A(x, y) x + \\\r\n  y\r\n#define B() 1\n")
    #expect(defs.keys == ["A", "B"])
    #expect(try #require(defs["A"]) == MacroDef(params: ["x", "y"], body: "x +    y", line: 2))
    #expect(try #require(defs["B"]) == MacroDef(params: [], body: "1", line: 4))
  }
}

@Suite struct BracketTests {
  @Test func matchCloseSkipsStringsRawStringsAndLineComments() {
    let s = #"f(a, ")", 'x', R"(raw ) )", // ) comment"# + "\n" + #"  g(b)) tail"#
    let close = matchClose(s, 1)
    #expect(close == JSText(s).indexOf(") tail"))
    #expect(matchClose("(\"unterminated", 0) == -1)
    #expect(matchClose("x", -1) == -1)
    #expect(matchClose("中(😀)", 1) == 4)
  }

  @Test func lineIndexCountsUTF16Offsets() {
    let at = lineIndex("😀\n中\nx")
    #expect([0, 2, 3, 4, 5, 99].map(at) == [1, 1, 2, 2, 3, 3])
  }
}

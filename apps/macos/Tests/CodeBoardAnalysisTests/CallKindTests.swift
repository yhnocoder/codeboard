import CodeBoardAnalysis
import Testing

// Kernel launches and C++, CUDA and Rust calls and symbols, as packages/analysis/test/analysis.test.ts checks them

private struct Launch: Equatable {
  var name: String
  var recv: String?
  var line: Int
  var col: Int
  var loop: Bool
  var args: [String]
}

private func launches(_ src: String) -> [Launch] {
  analyze("cuda-cpp", src).calls.filter { $0.launch == .chevrons }.map {
    Launch(name: $0.name, recv: $0.recv, line: $0.line, col: $0.col, loop: $0.loop, args: $0.args.map(\.text))
  }
}

@Suite struct CallKindTests {
  @Test func tritonsKernelGridCallIsACallToTheKernelMarkedAsAGridLaunch() throws {
    let a = analyze("python", "def f(x):\n    grid = (4,)\n    my_kernel[grid](x, BLOCK=64)\n    mod.k2[(1, 2)](x)\n")
    let k = try #require(a.calls.first { $0.name == "my_kernel" })
    #expect(k.line == 3 && k.col == 4 && k.launch == .grid)
    #expect(k.args.map { $0.kw ?? $0.text } == ["x", "BLOCK"])
    let k2 = try #require(a.calls.first { $0.name == "k2" })
    #expect(k2.recv == "mod" && k2.launch == .grid)
  }

  @Test func cudasChevronCallIsACallMarkedAsALaunch() {
    let a = analyze(
      "cuda-cpp", "void go(int* p) {\n  dispatch<8, 768><<<grid, 256, 0, s>>>(p);\n  plain<<<1, 1>>>();\n}\n")
    let got = a.calls.filter { $0.launch == .chevrons }.map { "\($0.name) \($0.line) \($0.col)" }
    #expect(got == ["dispatch 2 2", "plain 3 2"])
  }

  @Test func aCudaLaunchWithNameAndChevronsOnDifferentLinesQualifiedAndTemplated() {
    let src =
      "void go(int* p) {\n  sgl::act::act_and_mul_kernel<c_type, silu>\n      <<<grid, block, 0,\n         stream>>>(p, n);\n}\n"
    #expect(
      launches(src) == [
        Launch(name: "act_and_mul_kernel", recv: "sgl::act", line: 2, col: 12, loop: false, args: ["p", "n"])
      ])
  }

  @Test func aCudaLaunchInsideALoopIsMarkedAsInALoop() {
    #expect(
      launches("void go(int* p) {\n  for (int i = 0; i < n; ++i)\n    step<<<1, 32>>>(p, i);\n}\n") == [
        Launch(name: "step", recv: nil, line: 3, col: 4, loop: true, args: ["p", "i"])
      ])
  }

  @Test func chevronsInACommentAreNoLaunch() {
    #expect(launches("// runs in a <<<1, 32>>> kernel\nvoid go() {\n  /* with <<<g, b>>> */ f();\n}\n") == [])
  }

  @Test func aCppCallOfAQualifiedOrMemberTemplateFunctionIsNamedWithoutTemplateArguments() {
    let a = analyze(
      "cpp",
      "void go() {\n  auto c = std::make_shared<comm::Context>(n);\n  ns::f<T>(x);\n  a::B<x::Y>::g(1);\n"
        + "  fa->allreduce<float>(s);\n  t.template pivot<false>(k);\n}\n")
    let got = a.calls.map { "\($0.name) \($0.recv ?? "-") \($0.col)" }
    #expect(got == ["make_shared std 16", "f ns 6", "g a::B<x::Y> 14", "allreduce fa 6", "pivot t 13"])
  }

  @Test func aCudaKernelWithLaunchBoundsInsideAnIfBetweenSpecifiersAndNameIsASymbol() {
    let src =
      "template <typename scalar_t, bool need_check>\nstatic __global__ void\n#if defined(USE_ROCM)\n"
      + "__launch_bounds__(WARP_SIZE * NWARPS, 2)\n#endif\n"
      + "    mul_mat_q4_0(const void* __restrict__ vx, scalar_t* __restrict__ dst) {\n  go(vx);\n}\n"
    let got = analyze("cuda-cpp", src).symbols.map { "\($0.qual) \($0.start) \($0.defLine) \($0.end)" }
    #expect(got == ["mul_mat_q4_0 1 2 8"])
  }

  @Test func aCudaKernelWithLaunchBoundsAndClusterDimsIsASymbol() {
    let src =
      "namespace k3 {\ntemplate <uint32_t kWorldSize, uint32_t kClusterSize>\n"
      + "__global__ __launch_bounds__(kRows / kClusterSize) __cluster_dims__(kClusterSize, 1, 1)  //\n"
      + "    void all_reduce_kernel(const __grid_constant__ Params params) {\n  go(params);\n}\n}\n"
    let got = analyze("cuda-cpp", src).symbols.map { "\($0.qual) \($0.name) \($0.start) \($0.end)" }
    #expect(got == ["k3::all_reduce_kernel all_reduce_kernel 2 6"])
  }

  @Test func aFunctionDeclaredWithAModifierMacroGetsACleanName() {
    let src = "SGL_DEVICE float compute_rstd(const float* x, int n) {\n  return rsqrtf(sum(x, n));\n}\n"
    let got = analyze("cuda-cpp", src).symbols.map { "\($0.qual) \($0.name) \($0.start) \($0.end)" }
    #expect(got == ["compute_rstd compute_rstd 1 3"])
  }

  @Test func rustFunctionsImplMethodsAttributesInTheStartLineAndCalls() {
    let src =
      "use pyo3::prelude::*;\n\n#[pyfunction]\n#[pyo3(name = \"tok\")]\nfn tokenize(s: &str) -> Vec<u32> {\n"
      + "    let v = encode(s);\n    v\n}\n\nstruct Tree { n: u32 }\n\nimpl Tree {\n"
      + "    pub fn insert(&mut self, k: u32) {\n        self.grow(k);\n        helpers::fix(k);\n    }\n}\n"
    let a = analyze("rust", src)
    #expect(
      a.symbols.map { "\($0.qual) \($0.kind) \($0.start) \($0.defLine) \($0.end)" } == [
        "tokenize def 3 5 8", "Tree class 10 10 10", "Tree::insert def 13 13 16",
      ])
    #expect(a.symbols[2].params.map(\.kind) == [.self, .pos])
    #expect(
      a.calls.map { "\($0.name) \($0.recv ?? "-") \($0.line)" } == ["encode - 6", "grow self 14", "fix helpers 15"])
    #expect(a.calls[0].assigned == ["v"])
  }
}

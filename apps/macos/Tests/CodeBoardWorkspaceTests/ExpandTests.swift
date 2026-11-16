import CodeBoardAnalysis
import Foundation
import Testing

@testable import CodeBoardWorkspace

// packages/host/src/resolve.ts's expand with bridge.ts's routes: packages/host/test/bridge.test.ts on the same fixture
// (Fixtures/crosslang, copied from packages/host/test/fixtures/crosslang), with the scripted language server in place
// of its stub one, and clicks on nano-vllm's calls found by the name index alone (no language server, as on the Mac)
@Suite(.timeLimit(.minutes(1)))
struct ExpandTests {
  /// The fixture copied into a folder of its own, as the host test copies it
  private func withCross(_ body: (LangHost) async throws -> Void) async throws {
    let fixture = URL(filePath: #filePath).deletingLastPathComponent()
      .appending(path: "Fixtures/crosslang").standardizedFileURL.path
    try await withFolder { dir in
      let root = realPath(dir) + "/crosslang"
      try FileManager.default.copyItem(atPath: fixture, toPath: root)
      let h = LangHost(root)
      try await body(h)
      await h.lookup.index.dispose()
    }
  }

  private func withNanoHost(_ body: (LangHost) async throws -> Void) async throws {
    try await withNano { root in
      let h = LangHost(realPath(root))
      try await body(h)
      await h.lookup.index.dispose()
    }
  }

  /// A click on `word` on the segment's first line matching `pattern` (at.ts's `at`)
  private func click(
    _ h: LangHost, _ s: CodeSegment, _ pattern: String, _ name: String, word: String? = nil, pick: ExpandPick? = nil
  ) async throws -> Expanded {
    let i = try #require(s.text.firstIndex { JSRegex(pattern).test($0) }, "no line matching \(pattern)")
    return await h.resolver.expand(
      ExpandRequest(seg: s, line: s.start + i, col: unitIndex(s.text[i], word ?? name), name: name, pick: pick))
  }

  private func seg(_ h: LangHost, _ rel: String, _ qual: String) async throws -> CodeSegment {
    try await CodeBoardWorkspaceTests.card(h.sources, h.abs(rel), qual)
  }

  private func card(_ r: Expanded) -> ExpandedCard? {
    if case .card(let c) = r { return c }
    return nil
  }

  private func vals(_ r: Expanded) -> String {
    (card(r)?.mark.vals ?? []).map { "\($0.name)=\($0.value)" }.joined(separator: " ")
  }

  @Test func pybindAPythonCallGoesIntoTheCppMethodRegisteredWithDef() async throws {
    try await withCross { h in
      let r = try await click(
        h, try await seg(h, "deep_ep/buffer.py", "Buffer.dispatch"), #"intranode_dispatch\("#,
        "intranode_dispatch")
      #expect(card(r)?.segment.symbol?.qual == "deep_ep::Buffer::intranode_dispatch")
      #expect(card(r)?.mark.bound == "pybind · deep_ep.cpp .def")
    }
  }

  @Test func aLaunchMacroGoesToTheGlobalKernelWithItsTemplateValuesAndTheRankPicker() async throws {
    try await withCross { h in
      let abs = h.abs("csrc/kernels/intranode.cu")
      let text = try #require(await h.lookup.readText(abs))
      let syms = h.lookup.analysis.analysisOf(h.lookup.langOf(abs), text).symbols.filter {
        $0.qual == "deep_ep::intranode::dispatch"
      }
      var host: CodeSegment?
      for s in syms {
        let c = try #require(await h.resolver.cardSegment(Target(abs: abs, sym: s)))
        if c.text.contains(where: { $0.contains("SWITCH_RANKS(DISPATCH") }) { host = c }
      }
      let r = try await click(h, try #require(host), #"SWITCH_RANKS\(DISPATCH"#, "SWITCH_RANKS")
      #expect(card(r)?.segment.text.contains { $0.contains("__global__") } == true)
      #expect(card(r)?.mark.bound == "launch macro · SWITCH_RANKS")
      #expect(vals(r) == "kNumRanks=8 kNumThreads=768 kNumTMABytesPerWarp=8192")
      #expect(card(r)?.mark.vals.first?.opts == ["2", "4", "8"])
      #expect(card(r)?.mark.vals.first?.from == "SWITCH_RANKS(num_ranks)")
      #expect(card(r)?.title == "dispatch<8, 768, 8192>")
    }
  }

  @Test func aCudaChevronLaunchGivesTheKernelCardWithItsTemplateValue() async throws {
    try await withCross { h in
      let r = try await click(
        h, try await seg(h, "csrc/kernels/intranode.cu", "deep_ep::intranode::add"), #"add_kernel<kThreads><<<"#,
        "add_kernel")
      #expect(card(r)?.segment.symbol?.qual == "deep_ep::intranode::add_kernel")
      #expect(card(r)?.mark.bound == "kernel<<<…>>>")
      #expect(vals(r) == "kBlock=256")
    }
  }

  @Test func aJitCompileGoesToTheKernelItsFormatStringNamesTheOtherBranchAnAlternative() async throws {
    try await withCross { h in
      let r = try await click(
        h, try await seg(h, "csrc/jit/dispatch.hpp", "deep_ep::launch_dispatch"), #"jit->compile"#, "compile")
      #expect(card(r)?.segment.symbol?.qual == "deep_ep::ep::dispatch_impl")
      #expect(card(r)?.mark.bound == "JIT compile · dispatch.cuh")
      #expect(vals(r) == "kNumSMs=num_sms kNumTokens=num_tokens")
      #expect(card(r)?.mark.alts.map(\.qual) == ["deep_ep::ep::hybrid_dispatch_impl"])
    }
  }

  @Test func torchOpsGoesToTheCppFunctionRegisteredWithTorchLibrary() async throws {
    try await withCross { h in
      let r = try await click(h, try await seg(h, "ops/norm.py", "rms_norm"), #"torch\.ops\.my_ext"#, "rms_norm")
      #expect(card(r)?.segment.symbol?.qual == "rms_norm_cuda")
      #expect(card(r)?.mark.bound == "torch.ops · ext.cc m.impl")
    }
  }

  @Test func tritonGridGoesToTheJitKernelWithItsConstexprsAndTheOtherConfigsAsAlternatives() async throws {
    try await withCross { h in
      let r = try await click(
        h, try await seg(h, "ops/kern.py", "invoke_fused_moe_kernel"), #"fused_moe_kernel\[grid\]"#,
        "fused_moe_kernel")
      #expect(card(r)?.segment.symbol?.qual == "fused_moe_kernel")
      #expect(card(r)?.mark.bound == "kernel[grid]")
      #expect(vals(r) == "BLOCK_K=32 BLOCK_M=64 BLOCK_N=128 stages=3 warps=4")
      #expect(card(r)?.mark.alts.count == 2)
      #expect(card(r)?.mark.alts.first?.label == "config 2 · BLOCK_M=128 BLOCK_N=64 stages=4 warps=8")
    }
  }

  @Test func aTileLangFactoryCallGoesStraightToThePrimFuncWithItsArgumentsAsValues() async throws {
    try await withCross { h in
      let r = try await click(
        h, try await seg(h, "ops/mla.py", "run_mla_decode"), #"flashmla_decode\(heads"#, "flashmla_decode")
      #expect(card(r)?.segment.symbol?.qual == "flashmla_decode.main")
      #expect(card(r)?.mark.bound == "tilelang.jit factory")
      #expect(vals(r) == "heads=heads block_N=64 num_stages=2")
      #expect(card(r)?.title == "flashmla_decode → main")
    }
  }

  @Test func pyO3APythonCallGoesIntoThePyfunctionInRust() async throws {
    try await withCross { h in
      let r = try await click(h, try await seg(h, "ops/tok.py", "count"), #"fasttok\.tokenize"#, "tokenize")
      #expect(card(r)?.segment.symbol?.qual == "tokenize")
      #expect(card(r)?.segment.lang == "rust")
      #expect(card(r)?.mark.bound == "PyO3 · lib.rs #[pyfunction]")
    }
  }

  @Test func anUnresolvableCallComesBackAsNoneWithTheNameToSearch() async throws {
    try await withCross { h in
      var lay = try await seg(h, "vllm/layer.py", "Attention.forward")
      let i = try #require(lay.text.firstIndex { $0.contains("unified_attention") })
      let col = unitIndex(lay.text[i], "unified_attention")
      lay.text = lay.text.map { $0.replacingOccurrences(of: "unified_attention", with: "missing_op") }
      let r = await h.resolver.expand(ExpandRequest(seg: lay, line: lay.start + i, col: col, name: "missing_op"))
      #expect(r == .none(reason: "No definition found for “missing_op”.", name: "missing_op"))
    }
  }

  // Dynamic dispatch: the definition is the base class's method, two subclasses implement it

  private func dispatching(_ h: LangHost) {
    h.fake.answer([Def(abs: h.abs("vllm/base.py"), line: 2, col: 8)])
    h.fake.answerImpls([
      h.abs("vllm/base.py") + ":2": [
        Def(abs: h.abs("vllm/impls.py"), line: 5, col: 8), Def(abs: h.abs("vllm/impls.py"), line: 10, col: 8),
      ]
    ])
  }

  @Test func listsEveryImplementationTheAbstractBaseLeftOutAndPickingOneExpandsIt() async throws {
    try await withCross { h in
      dispatching(h)
      let lay = try await seg(h, "vllm/layer.py", "Attention.forward")
      // the test clock never reaches the click's wait, so the implementations come first
      let r = try await click(h, lay, #"self\.impl\.forward"#, "forward")
      guard case .impls(let impls, let base) = r else {
        Issue.record("no implementations: \(r)")
        return
      }
      #expect(base == "AttentionImpl.forward")
      #expect(impls.map(\.qual) == ["FlashAttentionImpl.forward", "TritonAttentionImpl.forward"])
      let p = ExpandPick(path: impls[1].path, line: impls[1].line, qual: impls[1].qual)
      let picked = try await click(h, lay, #"self\.impl\.forward"#, "forward", pick: p)
      #expect(card(picked)?.segment.symbol?.qual == "TritonAttentionImpl.forward")
    }
  }

  @Test func expandsTheDefinitionAtOnceWhenImplementationsAreSlowAndGivesThemOnceTheyArrive() async throws {
    try await withCross { h in
      dispatching(h)
      let lay = try await seg(h, "vllm/layer.py", "Attention.forward")
      let gate = h.fake.hold(.implementations)
      let i = try #require(lay.text.firstIndex { $0.contains("self.impl.forward") })
      let col = unitIndex(lay.text[i], "forward")
      let req = ExpandRequest(seg: lay, line: lay.start + i, col: col, name: "forward")
      let r = Task { await h.resolver.expand(req) }
      await gate.untilArrived()
      await h.clock.untilSleeping(1)
      h.clock.advance(by: dispatchWait)
      let c = card(await r.value)
      #expect(c?.segment.symbol?.qual == "AttentionImpl.forward")
      #expect(c?.dispatching == true)
      gate.open()
      let at = try #require(await h.resolver.dispatchAt(lay, line: req.line, col: col, name: "forward"))
      #expect(h.fake.count(.implementations) == 1, "the board's follow-up shares the click's request")
      #expect(at.base == "AttentionImpl.forward" && at.abstract)
      #expect(at.impls.map(\.qual) == ["FlashAttentionImpl.forward", "TritonAttentionImpl.forward"])
    }
  }

  @Test func expandsAMethodWithNoOverridesAsAPlainMethod() async throws {
    try await withCross { h in
      h.fake.answer([Def(abs: h.abs("vllm/base.py"), line: 2, col: 8)])
      let r = try await click(
        h, try await seg(h, "vllm/layer.py", "Attention.forward"), #"self\.impl\.forward"#,
        "forward")
      #expect(card(r)?.segment.symbol?.qual == "AttentionImpl.forward")
      #expect(card(r)?.dispatching == false)
    }
  }

  // nano-vllm, by the name index alone

  @Test func aCallOnAnAttributeGoesToTheMethodOfTheClassItIsNamedLike() async throws {
    try await withNanoHost { h in
      let step = try await seg(h, "nanovllm/engine/llm_engine.py", "LLMEngine.step")
      let r = try await click(h, step, #"self\.scheduler\.postprocess"#, "postprocess")
      let c = try #require(card(r))
      #expect(c.segment.symbol == SymbolRef(qual: "Scheduler.postprocess", kind: .function))
      #expect(c.segment.path == "nanovllm/engine/scheduler.py" && c.segment.src == .repo(repo: ""))
      #expect(c.segment.text.first?.contains("def postprocess(") == true)
      #expect(c.vars.map(\.a) == ["seqs", "token_ids", "is_prefill"])
      #expect(c.mark == CrossMark() && c.title == nil)
    }
  }

  @Test func aCallOnSelfGoesToTheCurrentClasssMethod() async throws {
    try await withNanoHost { h in
      let gen = try await seg(h, "nanovllm/engine/llm_engine.py", "LLMEngine.generate")
      let r = try await click(h, gen, #"= self\.step\(\)"#, "step")
      #expect(card(r)?.segment.symbol?.qual == "LLMEngine.step")
      #expect(card(r)?.vars.map(\.a) == ["output, num_tokens"])
    }
  }

  @Test func aNameDefinedInSeveralClassesNoneStandingOutIsAPick() async throws {
    try await withNanoHost { h in
      let step = try await seg(h, "nanovllm/engine/llm_engine.py", "LLMEngine.step")
      // no call of that name on the line: the name and receiver alone
      let r = await h.resolver.expand(ExpandRequest(seg: step, line: step.start, col: 0, name: "forward", recv: "x"))
      guard case .pick(let defs) = r else {
        Issue.record("no pick: \(r)")
        return
      }
      #expect(defs.count > 1 && defs.count <= 20)
      #expect(defs.contains { $0.label == "Qwen3Model.forward" && $0.path == "nanovllm/models/qwen3.py" })
      #expect(defs.allSatisfy { $0.detail == "\($0.path):\($0.line)" })
    }
  }

  @Test func aBuiltinOrFreeCodeIsNoneWithWhy() async throws {
    try await withNanoHost { h in
      let step = try await seg(h, "nanovllm/engine/llm_engine.py", "LLMEngine.step")
      #expect(
        try await click(h, step, #"sum\("#, "sum")
          == .none(reason: "No definition found for “sum”.", name: "sum"))
      var free = step
      free.src = .free
      #expect(
        await h.resolver.expand(ExpandRequest(seg: free, line: step.start + 1, col: 8, name: "schedule"))
          == .none(reason: "Free code has no source to follow.", name: nil))
    }
  }
}

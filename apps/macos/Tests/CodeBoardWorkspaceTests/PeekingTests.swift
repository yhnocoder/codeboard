import CodeBoardAnalysis
import Foundation
import Testing

@testable import CodeBoardWorkspace

// packages/host/src/resolve.ts's peek: resolve.test.ts's preview fallbacks on nano-vllm (no language server, as on
// the Mac), and bridge.test.ts's dynamic dispatch hint on its fixture with the scripted server
@Suite(.timeLimit(.minutes(1)))
struct PeekingTests {
  private func withNanoHost(_ body: (LangHost) async throws -> Void) async throws {
    try await withNano { root in
      let h = LangHost(realPath(root))
      try await body(h)
      await h.lookup.index.dispose()
    }
  }

  /// A peek of `word` on the segment's first line containing `marker` (at.ts's `at`)
  private func peek(_ h: LangHost, _ s: CodeSegment, _ marker: String, _ word: String) async throws -> PeekDef {
    let i = try #require(s.text.firstIndex { $0.contains(marker) }, "no line with \(marker)")
    return try #require(
      await h.resolver.peek(PeekRequest(seg: s, line: s.start + i, col: unitIndex(s.text[i], word), word: word)))
  }

  private func seg(_ h: LangHost, _ rel: String, _ qual: String) async throws -> CodeSegment {
    try await card(h.sources, h.abs(rel), qual)
  }

  @Test func aFieldShowsEveryFieldOfItsClass() async throws {
    try await withNanoHost { h in
      let eng = try await seg(h, "nanovllm/engine/llm_engine.py", "LLMEngine.__init__")
      let f = try await peek(h, eng, "config.kvcache_block_size", "kvcache_block_size")
      #expect(f.kind == .field && f.rows.count == 11 && f.head == "class Config" && f.line == 17)
      #expect(f.path == "nanovllm/config.py" && f.text.count == f.rows.count)
    }
  }

  @Test func aFunctionShowsItsSignatureFirstLinesAndMore() async throws {
    try await withNanoHost { h in
      let mr = try await seg(h, "nanovllm/engine/model_runner.py", "ModelRunner.__init__")
      let f = try await peek(h, mr, "load_model(self.model", "load_model")
      #expect(f.kind == .function)
      #expect((f.more ?? 0) > 0)
      #expect(f.sig?.hasPrefix("(function) def load_model") == true)
      #expect(f.lib == nil)
      // Pin and Place make the function's card
      #expect(f.segment.symbol == SymbolRef(qual: "load_model", kind: .function))
    }
  }

  @Test func aLibraryModuleShowsOnlyItsSignature() async throws {
    try await withNanoHost { h in
      let eng = try await seg(h, "nanovllm/engine/llm_engine.py", "LLMEngine.__init__")
      let m = try await peek(h, eng, "mp.get_context", "mp")
      #expect(m.kind == .module && m.text.isEmpty && m.lib == "torch" && m.title == "torch/multiprocessing")
      #expect(m.sig == "(module) mp")
    }
  }

  @Test func selfXShowsItsAssignmentsInTheClassAndTheNextHop() async throws {
    try await withNanoHost { h in
      let sch = try await seg(h, "nanovllm/engine/scheduler.py", "Scheduler.schedule")
      let s = try await peek(h, sch, "self.max_num_seqs", "self.max_num_seqs")
      #expect(s.kind == .field && s.rows.count > 2)
      #expect(s.line == 11 && s.follow?.label == "config.max_num_seqs")
    }
  }

  @Test func aDispatchedMethodSaysHowManyImplementations() async throws {
    let fixture = URL(filePath: #filePath).deletingLastPathComponent()
      .appending(path: "Fixtures/crosslang").standardizedFileURL.path
    try await withFolder { dir in
      let root = realPath(dir) + "/crosslang"
      try FileManager.default.copyItem(atPath: fixture, toPath: root)
      let h = LangHost(root)
      h.fake.answer([Def(abs: h.abs("vllm/base.py"), line: 2, col: 8)])
      h.fake.answerImpls([
        h.abs("vllm/base.py") + ":2": [
          Def(abs: h.abs("vllm/impls.py"), line: 5, col: 8), Def(abs: h.abs("vllm/impls.py"), line: 10, col: 8),
        ]
      ])
      let lay = try await seg(h, "vllm/layer.py", "Attention.forward")
      let p = try await peek(h, lay, "self.impl.forward", "forward")
      #expect(p.dispatch == PeekDispatch(n: 2, base: "AttentionImpl", abstract: true))
      #expect(p.path == "vllm/base.py" && p.line == 2)
      await h.lookup.index.dispose()
    }
  }
}

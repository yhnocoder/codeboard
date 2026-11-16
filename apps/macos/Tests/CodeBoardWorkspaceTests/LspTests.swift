import CodeBoardAnalysis
import Foundation
import Synchronization
import Testing

@testable import CodeBoardWorkspace

// packages/host/src/defcache.ts and lsp.ts. Ported from the host's tests where they check these directly (the
// definition cache of two-hosts.test.ts, prefetch.test.ts's reuse and misses, resolve.test.ts's while Pylance
// starts, there through expand); the rest recorded by running the TypeScript on the same files with a scripted
// language service and vitest's fake timers
@Suite(.timeLimit(.minutes(1)))
struct LspTests {
  private let sch = "nanovllm/engine/scheduler.py"

  @Test func keepsAnswersButNotEmptyOnesImplementationsEmptyTooForSixtySecondsAndByContent() async throws {
    try await withNano { root in
      let h = LangHost(root)
      let sch = h.abs(self.sch)
      let n = Mutex(0)
      let answer = Mutex<[Def]>([])
      let ask: @Sendable () async throws(LanguageError) -> [Def] = {
        n.withLock { $0 += 1 }
        return answer.withLock { $0 }
      }
      let s = { (kind: DefCache.Kind, line: Int) in
        _ = try await h.defs.shared(sch, line: line, col: 0, kind: kind, ask: ask)
        return n.withLock { $0 }
      }
      var seen: [Int] = []
      seen += [try await s(.def, 1), try await s(.def, 1)]
      answer.withLock { $0 = [Def(abs: sch, line: 2, col: 0)] }
      seen += [try await s(.def, 1), try await s(.def, 1)]
      answer.withLock { $0 = [] }
      seen += [try await s(.impl, 3), try await s(.impl, 3)]
      h.clock.advance(by: defTTL - .milliseconds(1))
      seen.append(try await s(.impl, 3))
      h.clock.advance(by: .milliseconds(1))
      seen.append(try await s(.impl, 3))
      let text = try String(contentsOfFile: sch, encoding: .utf8)
      h.ws.setUnsaved(sch, text + "\n# x\n")
      seen.append(try await s(.impl, 3))
      h.ws.setUnsaved(sch, nil)
      seen.append(try await s(.impl, 3))
      // a file that is gone: never kept
      for _ in 0..<2 {
        _ = try await h.defs.shared(h.abs("gone.py"), line: 1, col: 0, ask: ask)
        seen.append(n.withLock { $0 })
      }
      #expect(seen == [1, 2, 3, 3, 4, 4, 4, 5, 6, 6, 7, 8])
    }
  }

  @Test func asksAgainWhenAFileChangesWhileItAsks() async throws {
    try await withNano { root in
      let h = LangHost(root)
      let sch = h.abs(self.sch)
      let k = Mutex(0)
      let gate = Gate()
      let held: @Sendable () async throws(LanguageError) -> [Def] = {
        let i = k.withLock { k in
          k += 1
          return k
        }
        if i == 1 { await gate.wait() }
        return [Def(abs: sch, line: 100 + i, col: 0)]
      }
      let p = Task { try? await h.defs.shared(sch, line: 9, col: 0, ask: held) }
      await gate.untilArrived()
      h.defs.forget()
      gate.open()
      #expect(await p.value?.map(\.line) == [102])
      #expect(k.withLock { $0 } == 2)
    }
  }

  @Test func keepsAFailedRequestAndSharesOneInFlight() async throws {
    try await withNano { root in
      let h = LangHost(root)
      let sch = h.abs(self.sch)
      let fails = Mutex(0)
      let failing: @Sendable () async throws(LanguageError) -> [Def] = { () async throws(LanguageError) -> [Def] in
        fails.withLock { $0 += 1 }
        throw LanguageError("boom")
      }
      for _ in 0..<2 {
        await #expect(throws: LanguageError("boom")) {
          try await h.defs.shared(sch, line: 11, col: 0, kind: .impl, ask: failing)
        }
      }
      #expect(fails.withLock { $0 } == 1)
      let m = Mutex(0)
      let gate = Gate()
      let slow: @Sendable () async throws(LanguageError) -> [Def] = {
        m.withLock { $0 += 1 }
        await gate.wait()
        return [Def(abs: sch, line: 7, col: 0)]
      }
      let p1 = Task { try? await h.defs.shared(sch, line: 12, col: 0, ask: slow) }
      await gate.untilArrived()
      let p2 = Task { try? await h.defs.shared(sch, line: 12, col: 0, ask: slow) }
      await turns(30)
      gate.open()
      #expect(await p1.value?.count == 1)
      #expect(await p2.value?.count == 1)
      #expect(m.withLock { $0 } == 1)
    }
  }

  // prefetch.test.ts's hover prefetch, on the requests it makes (its lane and the cards are not ported)
  @Test func isReusedWhileInFlightAndDroppedByForgetAContentChangeOrAnEmptyAnswer() async throws {
    try await withNano { root in
      let h = LangHost(root)
      let llm = h.abs("nanovllm/engine/llm_engine.py")
      let target = Def(abs: h.abs(self.sch), line: 25, col: 8)
      h.fake.answer([target])
      let gate = h.fake.hold(.definitions)
      let hover = Task { await h.lsp.defs(llm, line: 52, col: 23) }
      await gate.untilArrived()
      let click = Task { await h.lsp.clickDefs(llm, line: 52, col: 23) }
      await turns(30)
      gate.open()
      #expect(await hover.value == [target])
      #expect(await click.value == [target])
      #expect(await h.lsp.clickDefs(llm, line: 52, col: 23) == [target])
      #expect(h.fake.count(.definitions) == 1)
      h.defs.forget()
      _ = await h.lsp.defs(llm, line: 52, col: 23)
      #expect(h.fake.count(.definitions) == 2)
      h.ws.setUnsaved(llm, try String(contentsOfFile: llm, encoding: .utf8) + "\n# edited\n")
      #expect(await h.lsp.defs(llm, line: 52, col: 23) == [target])
      #expect(h.fake.count(.definitions) == 3)
      h.ws.setUnsaved(llm, nil)
      h.defs.forget()
      h.fake.answer([])
      #expect(await h.lsp.defs(llm, line: 52, col: 23) == [])
      h.fake.answer([target])
      #expect(await h.lsp.clickDefs(llm, line: 52, col: 23) == [target])
      #expect(h.fake.count(.definitions) == 5)
    }
  }

  // two-hosts.test.ts: each host's definition cache is its own
  @Test func keepsEachHostsAnswersToItself() async throws {
    try await withFolder { dir in
      try write(dir + "/a/m.py", "def alpha():\n    return 1\n")
      try write(dir + "/b/m.py", "def beta():\n    return 1\n")
      let a = LangHost(dir + "/a")
      let b = LangHost(dir + "/b")
      a.fake.answer([Def(abs: "/a.py", line: 1, col: 0)])
      b.fake.answer([Def(abs: "/b.py", line: 1, col: 0)])
      #expect(await a.lsp.defs(a.abs("m.py"), line: 1, col: 4) == [Def(abs: "/a.py", line: 1, col: 0)])
      #expect(await b.lsp.defs(b.abs("m.py"), line: 1, col: 4) == [Def(abs: "/b.py", line: 1, col: 0)])
      _ = await a.lsp.defs(a.abs("m.py"), line: 1, col: 4)
      let asks: [Int] = [a.fake.count(.definitions), b.fake.count(.definitions)]
      #expect(asks == [1, 1])
      a.defs.forget()
      _ = await b.lsp.defs(b.abs("m.py"), line: 1, col: 4)
      #expect(b.fake.count(.definitions) == 1)
    }
  }

  // resolve.test.ts's while Pylance starts
  @Test func retriesEmptyAnswersAndStopsRetryingOnceTheServerHasAnswered() async throws {
    try await withNano { root in
      let h = LangHost(root)
      let llm = h.abs("nanovllm/engine/llm_engine.py")
      let target = Def(abs: h.abs(self.sch), line: 25, col: 8)
      h.fake.setStarting(true)
      h.fake.answerDefs { n, _, _, _ in .success(n < 3 ? [] : [target]) }
      #expect(await h.settle { await h.lsp.clickDefs(llm, line: 52, col: 23) } == [target])
      #expect(h.fake.count(.definitions) == 3)
      #expect(
        h.ws.takeLogs() == [
          "info definition at nanovllm/engine/llm_engine.py:52:23 answered after retry (language server starting)"
        ])
      h.fake.resetAsked()
      h.fake.answer([])
      h.defs.forget()
      #expect(await h.settle { await h.lsp.clickDefs(llm, line: 52, col: 23) } == [])
      #expect(h.fake.count(.definitions) == 1)
    }
  }

  @Test func waitsForAStartingPythonServerOnTheFirstThreeClicksOnly() async throws {
    try await withNano { root in
      let h = LangHost(root)
      let sch = h.abs(self.sch)
      h.fake.setStarting(true)
      var asks: [Int] = []
      for i in 0..<4 {
        h.fake.resetAsked()
        _ = await h.settle { await h.lsp.clickDefs(sch, line: 30 + i, col: 4) }
        asks.append(h.fake.count(.definitions))
      }
      #expect(asks == [4, 4, 4, 1])
      let other = LangHost(root)
      other.fake.setStarting(true)
      _ = await other.lsp.clickDefs(other.abs("LICENSE"), line: 1, col: 0)
      #expect(other.fake.count(.definitions) == 1)
      let none = LangHost(root)
      _ = await none.lsp.clickDefs(none.abs(self.sch), line: 1, col: 0)
      #expect(none.fake.count(.definitions) == 1)
      // ready gives up at once once the server has answered anything
      none.fake.answer([Def(abs: sch, line: 1, col: 0)])
      _ = await none.lsp.defs(none.abs(self.sch), line: 2, col: 0)
      #expect(await none.lsp.ready([], ask: { [] }, wait: .seconds(9)) == [])
      #expect(none.clock.sleeping == 0)
    }
  }

  @Test func dropsADefinitionAtTheCallItselfAndLogsAFailedRequest() async throws {
    try await withNano { root in
      let h = LangHost(root)
      let other = Def(abs: h.abs("nanovllm/config.py"), line: 1, col: 6)
      h.fake.answerDefs { _, abs, line, _ in
        line == 99 ? .failure(LanguageError("server stopped")) : .success([Def(abs: abs, line: line, col: 0), other])
      }
      #expect(await h.lsp.defs(h.abs("bench.py"), line: 5, col: 15) == [other])
      #expect(await h.lsp.defs(h.abs("bench.py"), line: 99, col: 1) == [])
      #expect(h.ws.takeLogs() == ["warn definition provider failed at bench.py:99:1: server stopped"])
      h.fake.answerImpls([h.abs(self.sch) + ":25": [other]])
      let impls = try await h.lsp.impls(Def(abs: h.abs(self.sch), line: 25, col: 8))
      #expect(impls == [other])
      #expect(h.ws.takeLogs() == ["info implementations at nanovllm/engine/scheduler.py:25 → 1, 0 ms"])
    }
  }
}

import Foundation
import Testing

@testable import CodeBoardAnalysis

// As packages/analysis/test/peek.test.ts. Each source (a nano-vllm file in Fixtures/nano-vllm, or a snippet in
// Fixtures/peek) comes with the TypeScript `analyze` result for it in Fixtures/peek, so these test only peek.ts.

private func fixture(_ path: String) throws -> String {
  let url = try #require(Bundle.module.url(forResource: "Fixtures", withExtension: nil)).appendingPathComponent(path)
  return try String(contentsOf: url, encoding: .utf8)
}

private struct Analyzed: Decodable {
  var lang: String
  var symbols: [Sym]
  var flags: [Int]
  var calls: [CallSite]
  var doc: String?
}

/// A source and its analysis: `source` under Fixtures, `name` the analysis's file in Fixtures/peek
private func peekFixture(_ source: String, _ name: String) throws -> (a: FileAnalysis, lines: [String]) {
  let text = try fixture(source)
  let d = try JSONDecoder().decode(Analyzed.self, from: Data(try fixture("peek/\(name).json").utf8))
  let a = FileAnalysis(lang: d.lang, symbols: d.symbols, flags: d.flags, calls: d.calls, doc: d.doc)
  return (a, text.jsSplit("\n"))
}

@Suite struct PeekPlanTests {
  @Test func aFieldShowsEveryFieldOfItsClass() throws {
    let (a, lines) = try peekFixture("nano-vllm/nanovllm/config.py", "config")
    let p = peekPlan(a, lines, 17, word: "config.kvcache_block_size")
    #expect(p.kind == .field)
    #expect(p.rows == [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])
    #expect(p.head == "class Config")
    #expect(p.sig == "(variable) kvcache_block_size: int = 256")
  }

  @Test func aFunctionShowsItsSignatureAndFirstLinesWithoutTheDocstring() throws {
    let (a, lines) = try peekFixture("nano-vllm/nanovllm/utils/loader.py", "loader")
    let p = peekPlan(a, lines, 12)
    #expect(p.kind == .function)
    #expect(p.rows == [12, 13, 14, 15])
    #expect(p.more == 28 - 15)
    #expect(p.sig == "(function) def load_model(model: nn.Module, path: str)")
  }

  @Test func aFieldOrModuleAssignmentOverSeveralLinesIsShownWhole() throws {
    let (a, lines) = try peekFixture("peek/fields.py", "fields")
    let f = peekPlan(a, lines, 2)
    #expect([2, 3, 4, 5].allSatisfy(f.rows.contains))
    let m = peekPlan(a, lines, 8)
    #expect([8, 9, 10, 11].allSatisfy(m.rows.contains))
    #expect(
      f
        == PeekPlan(
          kind: .field, rows: [2, 3, 4, 5, 6], head: "class Qwen3ForCausalLM",
          sig: "(variable) packed_modules_mapping = {"))
    #expect(m == PeekPlan(kind: .other, rows: [7, 8, 9, 10, 11, 12], sig: "(variable) TABLE = ["))
  }

  @Test func selfAssignmentsInInitShowEverySelfAssignmentOfThatMethod() throws {
    let (a, lines) = try peekFixture("nano-vllm/nanovllm/engine/scheduler.py", "scheduler")
    let l = try #require(lines.firstIndex { JSRegex(#"self\.max_num_seqs\s*="#).test($0) }) + 1
    let p = peekPlan(a, lines, l)
    #expect(p.kind == .field)
    #expect(p.rows.contains(l))
    #expect(p.rows.count > 2)
    #expect(p.rows.allSatisfy { JSRegex(#"^\s*self\."#).test(lines[$0 - 1]) })
  }

  @Test func aModuleHasOnlyDocsNoSource() throws {
    let (a, lines) = try peekFixture("peek/module.py", "module")
    #expect(isModuleDef(lines, 1, 0, "mp"))
    #expect(!isModuleDef(["mp = 1"], 1, 0, "mp"))
    let p = peekPlan(a, lines, 1, word: "mp", module: true)
    #expect(p.kind == .module)
    #expect(p.rows == [])
    #expect(p.sig == "(module) mp")
    #expect(
      p.doc
        == "torch.multiprocessing is a wrapper around the native `multiprocessing` module.\n\nIt registers custom reducers, that use shared memory to provide shared views on the same data in different processes."
    )
  }

  @Test func moduleDefinitionsLookAtTheLastPartOfTheName() {
    #expect(isModuleDef(["import x"], 1, 0, "torch.mp"))
    #expect(!isModuleDef(["# 模块 mp"], 1, 0, "a.mp"))
    #expect(!isModuleDef(["x"], 2, 0, "mp"))
    // ASCII word boundaries: a Chinese character next to the name is not a word character in JavaScript
    #expect(!isModuleDef(["中mp中"], 1, 0, "mp"))
  }
}

@Suite struct DocstringTests {
  @Test func docToMdKeepsArgumentListsAndExamples() {
    #expect(
      docToMd("Load it.\n\nArgs:\n    model: the model\n    path: dir\n\n>>> load(m, p)")
        == "Load it.\n\nArgs:\n- model: the model\n- path: dir\n\n```\n>>> load(m, p)\n```")
  }

  @Test func docToMdUnderlinesItemsAndRoles() {
    #expect(
      docToMd("Notes\n-----\n加载 :class:`~torch.nn.Module` and ``x``\nsecond line\n\n\n\n1. one\n* two")
        == "**Notes**\n加载 `torch.nn.Module` and `x` second line\n\n1. one\n* two")
  }

  @Test func splitHoverTakesTheFirstCodeBlockAsSignatureAndUnescapesTheRest() {
    let h = splitHover(
      "```python\n(function) def f(a_b)\n```\n---\nDoes \\_this\\_&nbsp;now\n```\nkeep \\_ here\n```\n")
    #expect(h.sig == "(function) def f(a_b)")
    #expect(h.doc == "Does _this_ now\n```\nkeep \\_ here\n```")
    let plain = splitHover("just \\*text\\*")
    #expect(plain.sig == nil)
    #expect(plain.doc == "just *text*")
    let empty = splitHover("```\n\n```")
    #expect(empty.sig == nil)
    #expect(empty.doc == nil)
  }
}

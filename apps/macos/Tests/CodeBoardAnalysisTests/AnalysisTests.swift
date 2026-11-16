import CodeBoardAnalysis
import Foundation
import Testing
import TreeSitterCore

// The whole-file analysis of nano-vllm's Python files and of packages/analysis/test/analysis.test.ts's samples equals
// what the TypeScript analysis gives, field by field (Fixtures, from tools/analysis/fixtures.mjs). Also: analysis by
// lines equals the whole-file result clipped, and incremental parsing equals a fresh parse.

@Suite struct RecordedAnalysisTests {
  @Test func nanoVllmIsInTheFixtures() {
    #expect(Fixtures.cases.filter { $0.name.hasPrefix("nano-vllm/") }.count > 20)
  }

  @Test(arguments: Fixtures.cases)
  func analysisMatchesTheTypeScriptResult(_ c: Fixtures.Case) throws {
    expectSame(analyze(c.lang, Fixtures.text(c.source)), try Fixtures.expected(c), c.name)
  }
}

@Suite struct SegmentAnalysisTests {
  static let files = Fixtures.cases.filter { $0.name.hasPrefix("nano-vllm/") || $0.name.hasPrefix("cpp/") }

  private func ranges(_ a: FileAnalysis, _ n: Int) -> [(Int, Int)] {
    var out = a.symbols.map { ($0.start, $0.end) }
    for i in stride(from: 1, through: n, by: 7) { out += [(i, min(n, i + 11)), (i, i)] }
    return out + [(1, n), (n + 1, n + 5)]
  }

  @Test(arguments: files)
  func analysisOfSomeLinesIsTheClippedWholeFileResult(_ c: Fixtures.Case) {
    let text = Fixtures.text(c.source)
    let full = analyze(c.lang, text)
    for (s, e) in ranges(full, full.flags.count) {
      expectSame(
        analyze(c.lang, text, AnalyzeOptions(lines: LineSpan(start: s, end: e))), clipAnalysis(full, start: s, end: e),
        "\(c.name), lines \(s)–\(e)")
    }
  }
}

private func replacingFirst(_ s: String, _ target: String, _ with: String) -> String {
  guard let r = s.range(of: target, options: .literal) else { return s }
  return s.replacingCharacters(in: r, with: with)
}

private func replacingFirstMatch(_ s: String, _ pattern: String, _ with: String) throws -> String {
  let re = try NSRegularExpression(pattern: pattern)
  guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: s.utf16.count)),
    let r = Range(m.range, in: s)
  else { return s }
  return s.replacingCharacters(in: r, with: with)
}

@Suite struct IncrementalParsingTests {
  @Test func editsOnAKeptTreeGiveTheSameResultAsAFreshParse() throws {
    let source = Fixtures.nano("nanovllm/engine/scheduler.py")
    let cache = TreeCache()
    let key = "test:scheduler"
    let tree = TreeAt(cache: cache, key: key)
    var text = source
    expectSame(analyze("python", text, AnalyzeOptions(tree: tree)), analyze("python", text), "first parse")
    let steps: [(String, (String) throws -> String)] = [
      ("one line changed", { replacingFirst($0, "def schedule(self)", "def schedule(self, budget=1)") }),
      ("a line added", { replacingFirst($0, "\n", "\nimport json\n") }),
      ("a line removed, breaking the indentation", { try replacingFirstMatch($0, "\\n\\s*def [^\\n]*\\n", "\n") }),
      ("text added at the end, not ASCII", { $0 + "\n\ndef tail():\n    return 中文()\n" }),
      ("a surrogate pair", { replacingFirst($0, "中文", "😀x") }),
      ("many places", { $0.replacingOccurrences(of: "(", with: "( ") }),
    ]
    for (what, step) in steps {
      let prev = text
      text = try step(text)
      #expect(text != prev, "\(what) changed nothing")
      expectSame(analyze("python", text, AnalyzeOptions(tree: tree)), analyze("python", text), what)
      // with the edit given by the caller
      cache.forget(key)
      _ = analyze("python", prev, AnalyzeOptions(tree: tree))
      var edited = tree
      edited.edit = diffEdit(prev, text)
      expectSame(analyze("python", text, AnalyzeOptions(tree: edited)), analyze("python", text), "\(what), edit given")
    }
    // A wrong edit: the common prefix and suffix are used instead
    var wrong = tree
    wrong.edit = TreeEdit(
      startIndex: 0, oldEndIndex: 1, newEndIndex: 1, startPosition: .init(row: 0, column: 0),
      oldEndPosition: .init(row: 0, column: 1), newEndPosition: .init(row: 0, column: 1))
    expectSame(analyze("python", source, AnalyzeOptions(tree: wrong)), analyze("python", source), "a wrong edit")
    // Another language: parsed again
    let kernel = Fixtures.text("samples/cpp/kernel.cu")
    expectSame(
      analyze("cuda-cpp", kernel, AnalyzeOptions(tree: tree)), analyze("cuda-cpp", kernel), "another language")
    cache.forget()
  }

  @Test func theTreeCacheIsBounded() {
    let cache = TreeCache(max: 3)
    for i in 0..<6 { _ = analyze("python", "x = \(i)\n", AnalyzeOptions(tree: TreeAt(cache: cache, key: "k\(i)"))) }
    #expect(cache.keys == ["k3", "k4", "k5"])
    cache.forget()
    #expect(cache.keys == [])
  }

  @Test func twoTreeCachesKeepTheSameKeyApart() {
    let a = TreeCache(max: 1)
    let b = TreeCache(max: 1)
    _ = analyze("python", "x = 1\n", AnalyzeOptions(tree: TreeAt(cache: a, key: "f.py")))
    _ = analyze("python", "y = 2\n", AnalyzeOptions(tree: TreeAt(cache: b, key: "f.py")))
    _ = analyze("python", "z = 3\n", AnalyzeOptions(tree: TreeAt(cache: b, key: "g.py")))
    #expect(a.keys == ["f.py"])
    #expect(b.keys == ["g.py"])
    b.forget()
    #expect(a.keys == ["f.py"])
  }

  @Test func diffEditCoversTheChangedSpan() {
    #expect(
      diffEdit("ab\ncd\nef", "ab\ncXd\nef")
        == TreeEdit(
          startIndex: 4, oldEndIndex: 4, newEndIndex: 5, startPosition: .init(row: 1, column: 1),
          oldEndPosition: .init(row: 1, column: 1), newEndPosition: .init(row: 1, column: 2)))
    let same = diffEdit("aaa", "aaa")
    #expect(same.startIndex == 3 && same.oldEndIndex == 3 && same.newEndIndex == 3)
    let pair = diffEdit("x😀y", "x😃y")
    #expect(pair.startIndex == 1 && pair.oldEndIndex == 3 && pair.newEndIndex == 3)
  }
}

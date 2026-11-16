import CodeBoardAnalysis
import CodeBoardWorkspace
import Foundation
import Testing

#if canImport(Darwin)
  import Darwin
#else
  import Glibc
#endif

/// nano-vllm's scheduler.py at bb823b3 (the analysis's fixture) and at 9e8507e (this target's)
private func scheduler(_ rev: String) throws -> [String] {
  let here = URL(filePath: #filePath).deletingLastPathComponent()
  let url =
    rev == "bb823b3"
    ? here.appending(path: "../CodeBoardAnalysisTests/Fixtures/nano-vllm/nanovllm/engine/scheduler.py")
    : here.appending(path: "Fixtures/scheduler-\(rev).py")
  return String(decoding: try Data(contentsOf: url), as: UTF8.self).components(separatedBy: "\n")
}

private func symbols(_ lines: [String]) -> [Sym] { analyze("python", lines.joined(separator: "\n")).symbols }

private func segAt(_ lines: [String], _ qual: String?, _ start: Int, _ end: Int, rev: String) -> CodeSegment {
  CodeSegment(
    id: "s1", src: .repo(repo: ""), path: "nanovllm/engine/scheduler.py", lang: "python", start: start, end: end,
    text: Array(lines[(start - 1)..<end]), version: .git(commit: rev),
    symbol: qual.map { SymbolRef(qual: $0, kind: .function) })
}

private func at(_ c: String) -> Against { Against(label: c, version: .git(commit: c)) }

// packages/core/test/host.test.ts
@Suite struct TrackSegTests {
  @Test func isOkWhenNothingChangedAndReportsChangesInASymbolBetweenCommits() throws {
    let old = try scheduler("9e8507e")
    let s = try #require(symbols(old).first { $0.qual == "Scheduler.schedule" })
    let seg = segAt(old, "Scheduler.schedule", s.start, s.end, rev: "9e8507e")
    #expect(trackSeg(seg, old, symbols(old), at("x")).stale == .ok)
    let head = try scheduler("bb823b3")
    #expect(trackSeg(seg, head, symbols(head), at("bb823b3")).stale == .changed(hiddenOnly: false, head: "bb823b3"))
  }

  @Test func reportsMovedPinnedToTheVersionItWasFoundInWhenOnlyThePositionChanged() throws {
    let text = try scheduler("bb823b3")
    let s = try #require(symbols(text).first { $0.qual == "Scheduler.postprocess" })
    let seg = segAt(text, "Scheduler.postprocess", s.start, s.end, rev: "bb823b3")
    let moved = ["# one", "# two"] + text
    #expect(
      trackSeg(seg, moved, symbols(moved), at("h")).stale
        == .moved(start: s.start + 2, end: s.end + 2, version: .git(commit: "h")))
  }

  @Test func tracksSnippetsByContentAndReportsLostSymbols() throws {
    let text = try scheduler("bb823b3")
    let seg = segAt(text, nil, 30, 33, rev: "bb823b3")
    #expect(locateSeg(seg, ["x"] + text, []) == .at(Located(start: 31, end: 34)))
    let fn = segAt(text, "Scheduler.nope", 30, 33, rev: "bb823b3")
    #expect(trackSeg(fn, text, [], at("h")).stale == .lost)
  }

  @Test func noticesWhenOnlyHiddenLinesChanged() {
    let old = ["a", "b", "c", "d"]
    #expect(onlyHiddenChanged(old, 10, ["a", "B", "c", "d"], [11...11]))
    #expect(!onlyHiddenChanged(old, 10, ["a", "b", "C", "d"], [11...11]))
    #expect(onlyHiddenChanged(old, 10, ["a", "b", "x", "c", "d"], [11...12]))
    #expect(!onlyHiddenChanged(old, 10, ["a", "b", "x", "c", "d"], []))
  }
}

// packages/core/test/core.test.ts, diff and alignment
@Suite struct FindBlockTests {
  @Test func findsABlockByContentOrByFirstAndLastLine() throws {
    let n = try scheduler("bb823b3")
    #expect(findBlock(["x"] + n, Array(n[40..<43])) == .at(Located(start: 42, end: 44)))
    let edited = Array(n[0..<41]) + ["    # inserted"] + Array(n[41...])
    #expect(findBlock(edited, Array(n[40..<45])) == .at(Located(start: 41, end: 46)))
  }

  @Test func diffsLines() {
    #expect(diffLines(["a", "b"], ["a", "c"]).map(\.op.rawValue).joined() == " -+")
  }

  /// A card's lines now: followed from its commit's text through the line diff (the lines still there), by their text
  /// without that text, nowhere when neither finds them; the recorded lines checked where they say
  @Test func linesAreFollowedFromAnOlderTextOrFoundByTheirOwn() {
    let old = "a\nb\nc\nd"
    let now = ["new", "a", "b", "changed", "d"]
    #expect(followLines(2...3, from: ["a", "b", "c", "d"], to: now) == 3...3, "b moved down, c is gone")
    #expect(followLines(3...3, from: ["a", "b", "c", "d"], to: now) == nil)
    #expect(linesNow(start: 1, lines: ["a", "b"], old: old, in: now) == 2...3)
    #expect(linesNow(start: 1, lines: ["a", "b"], old: nil, in: now) == 2...3, "by their text")
    #expect(linesNow(start: 3, lines: ["c"], old: nil, in: now) == nil, "not by line number")
    #expect(sameLinesAt(2, ["a", "b"], in: now) && !sameLinesAt(1, ["a", "b"], in: now))
  }

  // Strings are compared as JavaScript compares them, by UTF-16 code unit: é and e + U+0301 are two lines
  @Test func comparesLinesByCodeUnitAsJavaScriptDoes() {
    #expect(!sameLines(["\u{e9}"], ["e\u{301}"]))
    #expect(diffLines(["\u{e9}"], ["e\u{301}"]).map(\.op.rawValue).joined() == "-+")
  }
}

/// LCS length, only to compare with
private func lcsLength(_ a: [String], _ b: [String]) -> Int {
  var prev = [Int](repeating: 0, count: b.count + 1)
  var cur = prev
  for x in a {
    for j in 1..<(b.count + 1) { cur[j] = x == b[j - 1] ? prev[j - 1] + 1 : max(prev[j], cur[j - 1]) }
    swap(&prev, &cur)
  }
  return prev[b.count]
}

/// The edit script is valid: without + it is a, without - it is b, line numbers in a row
private func valid(_ d: [DiffLine], _ a: [String], _ b: [String]) {
  #expect(d.filter { $0.op != .add }.map(\.text) == a)
  #expect(d.filter { $0.op != .del }.map(\.text) == b)
  #expect(d.filter { $0.op != .add }.map(\.a) == a.indices.map { $0 + 1 })
  #expect(d.filter { $0.op != .del }.map(\.b) == b.indices.map { $0 + 1 })
}

/// CPU time of this thread, in milliseconds: other work on a busy machine does not count against it
private func threadCPU() -> Double {
  var t = timespec()
  clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t)
  return Double(t.tv_sec) * 1000 + Double(t.tv_nsec) / 1e6
}

// packages/core/test/diff.test.ts, diff on 10k-line inputs (its nano-vllm history checks need the repository's
// history, which the Mac app's CI does not check out)
@Suite struct DiffTests {
  private let n = 10_000
  private var a: [String] { (0..<n).map { "line \($0) \($0 % 7)" } }

  /// An uncapped diff (an n·m table) would take many seconds of it
  private func check(_ b: [String]) -> [DiffLine] {
    let a = a
    let t = threadCPU()
    let d = diffLines(a, b)
    #expect(threadCPU() - t < 3000)
    valid(d, a, b)
    return d
  }

  @Test func scatteredEditsAreExact() {
    let d = check(a.enumerated().map { $0 % 50 == 0 ? $1 + " changed" : $1 })
    #expect(d.filter { $0.op == .same }.count == n - n / 50)
  }

  @Test func completelyDifferentInputsFallBackToDeleteAndAddWithNoTable() {
    let d = check((0..<n).map { "other \($0)" })
    #expect(d.map(\.op.rawValue).joined() == String(repeating: "-", count: n) + String(repeating: "+", count: n))
  }

  @Test func mostlyDifferentWithSharedLinesOrReversedIsStillAValidScriptInTime() {
    let a = a
    _ = check((0..<n).map { $0 % 100 == 0 ? a[$0] : $0 % 3 != 0 ? "x \($0)" : "" })
    _ = check(a.reversed())
  }

  @Test func smallButVeryDifferentInputsAreStillExact() {
    let x = (0..<600).map { "l \($0 % 40)" }
    let y = (0..<600).map { "l \(($0 * 7) % 45)" }
    let d = diffLines(x, y)
    valid(d, x, y)
    #expect(d.filter { $0.op == .same }.count == lcsLength(x, y))
  }
}

// core's parseDistInfo (packages/core/test/host.test.ts, small parsers)
@Test func parsesDistInfoNames() {
  #expect(parseDistInfo("torch-2.5.1.dist-info") == InstalledPackage(name: "torch", version: "2.5.1"))
  #expect(
    parseDistInfo("typing_extensions-4.12.2.dist-info")
      == InstalledPackage(name: "typing_extensions", version: "4.12.2"))
}

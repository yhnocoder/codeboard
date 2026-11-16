import CodeBoardAnalysis
import CodeBoardWorkspace
import Foundation
import Testing

// packages/core/test/diff.test.ts (alignRows, mapLines, wordDiff) and the host's diff request (handlers.ts diff): the
// pinned lines against HEAD or the working tree, and the segment Update takes

@Suite struct AlignTests {
  /// Pairs of a file before and after a change, as the TypeScript test reads them from a repository's history
  static let pairs: [(a: [String], b: [String])] = [
    (
      ["def f():", "    x = 1", "    y = 2", "    return x + y"],
      ["import os", "", "def f():", "    y = 2", "    return x + y"]
    ),
    (["a", "b", "c", "d"], ["a", "B", "c", "d", "e"]),
    (["x = 1", "y = 2"], ["completely", "different", "lines"]),
    ([], ["new"]),
    (["gone"], []),
    (
      ["    input_ids.extend(seq[start:end])", "    positions.extend(range(start, end))", "return x"],
      ["    input_ids.append(seq.last_token)", "    positions.append(len(seq))", "return x"]
    ),
  ]

  @Test func alignedRowsCoverBothSidesInOrderAndLineMappingFollowsTheRows() {
    for p in Self.pairs {
      let rows = alignRows(p.a, p.b)
      #expect(rows.compactMap(\.l) == Array(p.a.indices))
      #expect(rows.compactMap(\.r) == Array(p.b.indices))
      for r in rows where r.kind == .same { #expect(p.a[r.l!] == p.b[r.r!]) }
      let strict = mapLines(p.a, 1, p.b, 1, fuzzy: false)
      for (x, y) in strict { #expect(p.a[x - 1] == p.b[y - 1]) }
      let fuzzy = mapLines(p.a, 1, p.b, 1)
      let paired = rows.filter { $0.l != nil && $0.r != nil }
      #expect(fuzzy.count == paired.count)
      for r in paired { #expect(fuzzy[r.l! + 1] == r.r! + 1) }
    }
  }

  @Test func aNewVersionsLinesMapToWhereTheyWent() {
    let p = Self.pairs[0]
    #expect(mapLines(p.a, 10, p.b, 20) == [10: 22, 12: 23, 13: 24], "x = 1 removed, two lines added above")
    // a changed line is paired with the similar one
    #expect(mapLines(["a(b)", "z"], 1, ["a(c)", "z"], 1) == [1: 1, 2: 2])
    #expect(mapLines(["a(b)", "z"], 1, ["a(c)", "z"], 1, fuzzy: false) == [2: 2])
  }

  @Test func wordDiffMarksExactlyWhatChanged() {
    func cut(_ s: String, _ rs: [Range<Int>]) -> String {
      var u = Array(s.utf16)
      for r in rs.reversed() { u.removeSubrange(r) }
      return String(decoding: u, as: UTF16.self)
    }
    for (x, y) in [
      ("    input_ids.extend(seq[start:end])", "    input_ids.append(seq.last_token)"), ("a b c", "a c"), ("", "x"),
      ("foo(bar)", "foo(baz)"),
    ] {
      let w = wordDiff(x, y)
      #expect(cut(x, w.a) == cut(y, w.b))
    }
    let w = wordDiff("foo(bar)", "foo(baz)")
    #expect(w.a == [4..<7] && w.b == [4..<7])
  }
}

private let engine = """
  def schedule(seqs):
      out = []
      for s in seqs:
          out.append(s)
      return out
  """

@Suite struct VersionDiffTests {
  @Test func theNewVersionIsHeadsLinesWithTheSegmentUpdateTakes() async throws {
    let r = try tempRepo(["e.py": engine])
    defer { remove(r) }
    let s = makeSources(TestWorkspace(r))
    let seg = try await card(s, r + "/e.py", "schedule")
    try write(
      r + "/e.py", "import os\n\n" + engine.replacingOccurrences(of: "out.append(s)", with: "out.append(s * 2)"))
    try sh(r, "commit", "-qam", "double")
    let head = try sh(r, "rev-parse", "HEAD")
    let d = try await s.diff(seg)
    #expect(d.title == "New Version · schedule")
    #expect(d.left.label == "Pinned \(versionLabel(seg.version))" && d.left.start == 1 && d.left.text == seg.text)
    #expect(d.right.label == "HEAD \(head.prefix(7))" && d.right.start == 3 && d.note == nil)
    #expect(d.right.text[3] == "        out.append(s * 2)")
    let ns = try #require(d.newSeg)
    #expect(ns.id == seg.id && ns.start == 3 && ns.end == 7 && ns.version == .git(commit: head))
  }

  @Test func uncommittedChangesAreTheWorkingTreesWithHeadAsTheirVersion() async throws {
    let r = try tempRepo(["e.py": engine])
    defer { remove(r) }
    let s = makeSources(TestWorkspace(r))
    let seg = try await card(s, r + "/e.py", "schedule")
    let head = try sh(r, "rev-parse", "HEAD")
    try write(r + "/e.py", engine.replacingOccurrences(of: "return out", with: "return list(out)"))
    #expect(try await s.staleFor([seg])[seg.id] == .uncommitted)
    let d = try await s.diff(seg, worktree: true)
    #expect(d.title == "Uncommitted Changes · schedule" && d.left.label == String(head.prefix(7)))
    #expect(d.right.label == "Working Tree" && d.newSeg?.version == .git(commit: head, uncommitted: true))
    #expect(d.newSeg?.text.last == "    return list(out)")
  }

  @Test func aSymbolGoneSaysSoAndCannotBeUpdated() async throws {
    let r = try tempRepo(["e.py": engine])
    defer { remove(r) }
    let s = makeSources(TestWorkspace(r))
    let seg = try await card(s, r + "/e.py", "schedule")
    try write(r + "/e.py", "def other():\n    pass\n")
    try sh(r, "commit", "-qam", "gone")
    #expect(try await s.staleFor([seg])[seg.id] == .lost)
    let d = try await s.diff(seg)
    #expect(d.newSeg == nil && d.note == "Symbol not found (removed or renamed)" && d.right.text.isEmpty)
  }
}

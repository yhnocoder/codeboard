import CodeBoardAnalysis
import CodeBoardWorkspace
import Foundation
import Testing

private func src(_ body: String) -> String { ["def g(x):", "    return \(body)", ""].joined(separator: "\n") }

private func stale(_ s: Sources, _ seg: CodeSegment) async throws -> Stale? {
  try await s.staleFor([seg])[seg.id]
}

// packages/host/test/versions.test.ts
@Suite struct NewVersionCheckTests {
  @Test func showsNoNewVersionWhenAnOlderCommitIsCheckedOutAndOneWhenANewerCommitIs() async throws {
    let r = try tempRepo(["f.py": src("x")])
    defer { remove(r) }
    let old = try sh(r, "rev-parse", "HEAD")
    try write(r + "/f.py", src("x + 1"))
    try sh(r, "commit", "-qam", "pinned")
    let s = makeSources(TestWorkspace(r))
    let seg = try await card(s, r + "/f.py", "g")
    #expect(try await stale(s, seg) == .ok)
    try sh(r, "checkout", "-q", old)
    #expect(try await stale(s, seg) == .ok)
    try sh(r, "checkout", "-q", "main")
    try write(r + "/f.py", src("x + 2"))
    try sh(r, "commit", "-qam", "newer")
    guard case .changed? = try await stale(s, seg) else {
      Issue.record("not changed")
      return
    }
  }

  @Test func pinsACardOnAFileGitIgnoresByItsContentNotAsUncommittedAndTheCardStaysCurrent() async throws {
    let r = try tempRepo([".gitignore": "build/\n", "f.py": "def f():\n    return 1\n"])
    defer { remove(r) }
    let gen = r + "/build/gen.py"
    try write(gen, "def kernel(x):\n    return x\n")
    let s = makeSources(TestWorkspace(r))
    let seg = try await card(s, gen, "kernel")
    guard case .hash = seg.version else {
      Issue.record("\(seg.version)")
      return
    }
    #expect(try await stale(s, seg) == .ok)
    try write(r + "/new.py", "def g():\n    return 2\n")
    guard case .git(_, true) = try await card(s, r + "/new.py", "g").version else {
      Issue.record("not uncommitted")
      return
    }
  }

  @Test func asksGitWhetherAFileIsIgnoredOnceUntilTheIgnoreRulesMayHaveChanged() async throws {
    let r = try tempRepo([".gitignore": "build/\n"])
    defer { remove(r) }
    let git = GitCache()
    #expect(try await git.isIgnored(r, "build/gen.py"))
    try write(r + "/.gitignore", "")
    #expect(try await git.isIgnored(r, "build/gen.py"))
    await git.forgetIgnored()
    #expect(try await !git.isIgnored(r, "build/gen.py"))
  }

  @Test func movesTheCardToTheNewLinesWithTheNewCommitAsItsPinWhenACommitOnlyMovesTheCode() async throws {
    let f = [
      "def can_allocate(x):", "    return x > 0", "", "", "def allocate(x):", "    y = x + 1", "    return y", "",
    ]
    let r = try tempRepo(["blocks.py": f.joined(separator: "\n")])
    defer { remove(r) }
    let base = try sh(r, "rev-parse", "HEAD")
    let s = makeSources(TestWorkspace(r))
    let seg = try await card(s, r + "/blocks.py", "allocate")
    #expect(seg.start == 5)
    #expect(seg.version == .git(commit: base))
    try write(r + "/blocks.py", f[4...].joined(separator: "\n"))
    try sh(r, "commit", "-qam", "drop can_allocate")
    let head = try sh(r, "rev-parse", "HEAD")
    #expect(try await stale(s, seg) == .moved(start: 1, end: 3, version: .git(commit: head)))
  }
}

// packages/host/test/stale-head.test.ts: a commit right after an edit. The edited file's check can still be running
// when the commit's check starts, which must compare with the new HEAD
@Test func aCheckStartedAfterACommitComparesWithTheNewHeadWhileAnOlderCheckIsStillRunning() async throws {
  let r = try tempRepo(["f.py": src("x")])
  defer { remove(r) }
  let git = GatedGit()
  let s = makeSources(TestWorkspace(r), runner: git)
  let abs = r + "/f.py"
  // Made by another host, so that the check's `git show` of the pinned commit is not answered from the cache
  let seg = try await card(makeSources(TestWorkspace(r)), abs, "g")
  try write(abs, src("x + 1"))
  git.arm()
  // The saved edit: HEAD is still the pinned commit
  let edited = Task { try await s.staleFor([seg]) }
  await git.gate.untilArrived()
  try sh(r, "commit", "-qam", "newer")
  let committed = Task { try await s.staleFor([seg]) }
  let newer = try await committed.value
  git.gate.open()
  _ = try await edited.value
  guard case .changed? = newer[seg.id] else {
    Issue.record("\(String(describing: newer[seg.id]))")
    return
  }
}

// packages/host/test/relocate.test.ts, without the board's dialog: after a rename the function is offered in the
// renamed file only, and the card is pinned to it at HEAD
@Test func afterARenameTheFunctionIsFoundInTheRenamedFileAndPinnedToItAtHead() async throws {
  let r = try tempRepo([
    "engine/scheduler.py": [
      "class Scheduler:", "    def schedule(self):", "        return 1", "", "    def other(self):", "        return 2",
      "",
    ].joined(separator: "\n")
  ])
  defer { remove(r) }
  let ws = TestWorkspace(r)
  let analysis = AnalysisCache()
  let index = NameIndex(ws, analysis: analysis, sched: Scheduler())
  let s = Sources(CodeLookup(ws, analysis: analysis, index: index), git: GitCache(), githubDir: "")
  let old = try await card(s, r + "/engine/scheduler.py", "Scheduler.schedule")
  try sh(r, "mv", "engine/scheduler.py", "engine/cx.sched.py")
  try sh(r, "commit", "-qm", "rename")
  let head = try sh(r, "rev-parse", "HEAD")
  let name = try #require(old.symbol?.qual.split(separator: ".").last.map(String.init))
  let spots = await index.lookupName(name)
  #expect(spots.map(\.abs) == [r + "/engine/cx.sched.py"])
  let to = try #require(spots.first)
  let text = try #require(await s.lookup.readText(to.abs))
  let seg = try await s.makeSegment(
    id: old.id, await s.locOfFile(to.abs), lines: text.components(separatedBy: "\n"), start: to.start, end: to.end,
    symbol: SymbolRef(qual: to.qual, kind: .function), lang: s.lookup.langOf(to.abs))
  #expect(seg.path == "engine/cx.sched.py")
  #expect(seg.symbol?.qual == "Scheduler.schedule")
  #expect(seg.version == .git(commit: head))
  await index.dispose()
}

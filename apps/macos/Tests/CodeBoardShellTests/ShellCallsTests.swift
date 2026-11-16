import CodeBoardModel
import CodeBoardWorkspace
import Foundation
import Testing

@testable import CodeBoardReading
@testable import CodeBoardShell

// Expanding a call on a code card (ShellCalls.swift), on a small git repository made here: the card's segment read
// back as the workspace's, the call resolved by the name index, and the definition's card as the model keeps it, its
// source the repository's remote and commit as Add Function records them; a card from no repository on this Mac says
// what it takes instead

@discardableResult
private func git(_ dir: String, _ args: String...) throws -> String {
  let p = Process()
  p.executableURL = URL(filePath: "/usr/bin/env")
  p.arguments = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"] + args
  p.currentDirectoryURL = URL(filePath: dir)
  p.environment = ProcessInfo.processInfo.environment.merging(["GIT_TERMINAL_PROMPT": "0"]) { _, x in x }
  let out = Pipe()
  p.standardOutput = out
  p.standardError = Pipe()
  try p.run()
  let data = out.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  struct Failed: Error { let args: [String] }
  guard p.terminationStatus == 0 else { throw Failed(args: args) }
  return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

private let engine = """
  class Engine:
      def step(self):
          return self.scheduler.schedule(2)
  """

private let scheduler = """
  class Scheduler:
      def schedule(self, n):
          return n


  class Runner:
      def run(self):
          return 1
  """

@MainActor @Suite struct ShellCallsTests {
  @Test func aCallExpandsIntoTheDefinitionsCardPinnedToTheRepositorysRemoteAndCommit() async throws {
    let r = ShellCode.realPath(FileManager.default.temporaryDirectory.appending(path: "cb-calls-\(UUID())").path)
    defer { try? FileManager.default.removeItem(atPath: r) }
    for (f, t) in ["pkg/engine.py": engine, "pkg/scheduler.py": scheduler] {
      try FileManager.default.createDirectory(atPath: r + "/pkg", withIntermediateDirectories: true)
      try t.write(toFile: r + "/" + f, atomically: true, encoding: .utf8)
    }
    try git(r, "-c", "init.defaultBranch=main", "init", "-q")
    try git(r, "add", "-A")
    try git(r, "commit", "-qm", "base")
    try git(r, "remote", "add", "origin", "git@github.com:acme/engine.git")
    let head = try git(r, "rev-parse", "HEAD")
    let code = ShellCode(git: GitCache(), board: { nil })
    let f = CodeFile(repository: r, name: "engine", path: "pkg/engine.py")
    let step = try #require(
      await code.segment(
        f, CodePick(text: engine, lines: 2...3, symbol: Symbol(name: "Engine.step", kind: .function), scope: nil)))
    let col = try #require(step.lines[1].range(of: "schedule(")).lowerBound.utf16Offset(in: step.lines[1])
    let got = await code.expand(step, in: f, line: 3, col: col, name: "schedule")
    guard case .card(let s, let vars, let mark, let title, let dispatching) = got else {
      Issue.record("no card: \(got)")
      return
    }
    #expect(
      s.source
        == .git(
          repository: "git@github.com:acme/engine.git", commit: head, path: "pkg/scheduler.py", uncommitted: false,
          checkout: nil))
    #expect(s.symbol == Symbol(name: "Scheduler.schedule", kind: .function))
    #expect(s.firstLine == 2 && s.lines == ["    def schedule(self, n):", "        return n"])
    #expect(s.language == "python" && s.id.rawValue.hasPrefix("s"))
    #expect(vars.map(\.a) == ["2"] && mark == CrossMark() && title == nil && !dispatching)
    // a name nothing defines: why, with the name to search by
    #expect(
      await code.expand(step, in: f, line: 3, col: 0, name: "nowhere")
        == .none("No definition found for “nowhere”.", name: "nowhere"))
  }

  @Test func aCardFromNoRepositoryOnThisMacSaysWhatItTakes() async throws {
    let code = ShellCode(git: GitCache(), board: { nil })
    let s = Segment(
      id: SegmentID(rawValue: "s1"), source: .package(name: "torch", version: "2.5.0", path: "torch/nn/f.py"),
      language: "python", firstLine: 1, lines: ["def f():", "    g()"])
    guard case .missing(let m) = await code.expand(s, line: 2, col: 4, name: "g") else {
      Issue.record("not missing")
      return
    }
    #expect(m.message == "This card's code is from torch 2.5.0, an installed package, which is not opened here yet.")
  }

  /// What the card's file name says (ShellCodeCards' open), for the same card
  private func opening(_ code: ShellCode, _ s: Segment) async -> ShellCode.Missing? {
    var said: ShellCode.Missing?
    await code.open(s) { said = $0 }
    return said
  }

  @Test func aCallOnACardWhoseRepositoryOrCommitIsNotHereSaysWhatItsFileNameSays() async throws {
    let data = ShellCode.realPath(FileManager.default.temporaryDirectory.appending(path: "cb-calls-\(UUID())").path)
    defer { try? FileManager.default.removeItem(atPath: data) }
    let r = data + "/engine"
    try FileManager.default.createDirectory(atPath: r, withIntermediateDirectories: true)
    try engine.write(toFile: r + "/engine.py", atomically: true, encoding: .utf8)
    try git(r, "-c", "init.defaultBranch=main", "init", "-q")
    try git(r, "add", "-A")
    try git(r, "commit", "-qm", "base")
    let repositories = RepositoriesModel(
      folder: URL(filePath: data + "/data"), runner: ProcessGitRunner(), defaults: nil)
    let code = ShellCode(git: GitCache(), board: { nil })
    code.repositories = repositories
    let card = { (repository: String?, commit: String, checkout: String?) in
      Segment(
        id: SegmentID(rawValue: "s1"),
        source: .git(repository: repository, commit: commit, path: "engine.py", uncommitted: false, checkout: checkout),
        language: "python", firstLine: 2, lines: ["    def step(self):", "        return self.scheduler.schedule(2)"])
    }
    // a repository not added
    let away = card("git@github.com:acme/elsewhere.git", "0123456789abcdef0123456789abcdef01234567", nil)
    guard case .missing(let m) = await code.expand(away, line: 3, col: 30, name: "schedule") else {
      Issue.record("not missing")
      return
    }
    #expect(
      m.message == "acme/elsewhere is not added on this Mac." && m.offer == .clone("git@github.com:acme/elsewhere.git"))
    let said = await opening(code, away)
    #expect(m == said)
    // read in a folder added here, which has no remote to fetch the commit from: the file as it is now is offered
    await repositories.addFolder(r)
    let old = card(nil, "0123456789abcdef0123456789abcdef01234567", r)
    guard case .missing(let n) = await code.expand(old, line: 3, col: 30, name: "schedule") else {
      Issue.record("not missing")
      return
    }
    let saidOld = await opening(code, old)
    #expect(n.message.hasPrefix("Commit 0123456 is not in ") && n == saidOld, "\(n)")
    #expect(n.offer == .current(CodeFile(repository: r, name: "engine", path: "engine.py")))
  }
}

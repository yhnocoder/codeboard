import AppKit
import CodeBoardModel
import CodeBoardWorkspace
import Foundation
import Testing

@testable import CodeBoardCanvas
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
    // the calls its lines show, by its file at its version
    #expect(
      await code.calls(of: step, in: f)
        == [CallSpan(line: 3, col: col, end: col + 8, name: "schedule", recv: "self.scheduler")])
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
    #expect(await code.calls(of: s) == nil, "no marks where the source is not here")
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

  /// The calls the board's marks give a segment once its answers have all come
  private func settled(_ marks: ShellCallMarks, _ s: Segment) async -> [CallSpan]? {
    _ = marks.calls(s)
    await until("answered") { !marks.isAsking }
    return marks.calls(s)
  }

  private func until(_ what: String, _ f: () -> Bool) async {
    let deadline = ContinuousClock.now + .seconds(20)
    while !f() {
      if ContinuousClock.now > deadline {
        Issue.record("\(what): not within 20 s")
        return
      }
      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  /// A repository made here with engine.py, committed: its folder (in a folder of its own) and HEAD
  private func engineRepository() throws -> (data: String, root: String, head: String) {
    let data = ShellCode.realPath(FileManager.default.temporaryDirectory.appending(path: "cb-calls-\(UUID())").path)
    let r = data + "/engine"
    try FileManager.default.createDirectory(atPath: r, withIntermediateDirectories: true)
    try engine.write(toFile: r + "/engine.py", atomically: true, encoding: .utf8)
    try git(r, "-c", "init.defaultBranch=main", "init", "-q")
    try git(r, "add", "-A")
    try git(r, "commit", "-qm", "base")
    return (data, r, try git(r, "rev-parse", "HEAD"))
  }

  /// Engine.step's lines as a card of engine.py has them, its id `id`
  private func step(_ id: String, _ source: CodeSource) -> Segment {
    Segment(
      id: SegmentID(rawValue: id), source: source, language: "python", firstLine: 2,
      lines: ["    def step(self):", "        return self.scheduler.schedule(2)"])
  }

  private let schedule = CallSpan(line: 3, col: 30, end: 38, name: "schedule", recv: "self.scheduler")

  @Test func aSegmentWhoseFileWasNotHereGetsItsCallsOnceItsRepositoryIsAddedOrTheAppComesToTheFront() async throws {
    let (data, r, head) = try engineRepository()
    defer { try? FileManager.default.removeItem(atPath: data) }
    let repositories = RepositoriesModel(
      folder: URL(filePath: data + "/data"), runner: ProcessGitRunner(), defaults: nil)
    let code = ShellCode(git: GitCache(), board: { nil })
    code.repositories = repositories
    let marks = ShellCallMarks(code)
    var told = 0
    marks.onCallsChanged = { told += 1 }
    // read in a folder not added yet: none, and not asked again at every refresh
    let s = step("s1", .git(repository: nil, commit: head, path: "engine.py", uncommitted: false, checkout: r))
    #expect(await settled(marks, s) == nil && !marks.isAsking && told == 0)
    await repositories.addFolder(r)
    // the list read at the start may come first: told at each change, asked again once told
    await until("its calls once the repository came") {
      _ = marks.calls(s)
      return marks.calls(s) == [schedule]
    }
    #expect(told >= 2)
    // uncommitted, its lines not in the file as it is: none; the file put right elsewhere, the app brought to the front
    try engine.replacingOccurrences(of: "schedule(2)", with: "plan(2)")
      .write(toFile: r + "/engine.py", atomically: true, encoding: .utf8)
    let u = step("s2", .git(repository: nil, commit: head, path: "engine.py", uncommitted: true, checkout: r))
    #expect(await settled(marks, u) == nil)
    try engine.write(toFile: r + "/engine.py", atomically: true, encoding: .utf8)
    told = 0
    NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: nil)
    #expect(told == 1)
    #expect(await settled(marks, u) == [schedule] && told == 2)
    #expect(marks.calls(s) == [schedule], "a commit's calls are kept")
  }

  @Test func aBoardOfManyCodeCardsIsToldOnceAndItsRefreshAsksInLittleTime() async throws {
    let (data, r, head) = try engineRepository()
    defer { try? FileManager.default.removeItem(atPath: data) }
    let repositories = RepositoriesModel(
      folder: URL(filePath: data + "/data"), runner: ProcessGitRunner(), defaults: nil)
    await repositories.addFolder(r)
    let code = ShellCode(git: GitCache(), board: { nil })
    code.repositories = repositories
    let marks = ShellCallMarks(code)
    var told = 0
    marks.onCallsChanged = { told += 1 }
    let segments = (0..<200).map {
      step("s\($0)", .git(repository: nil, commit: head, path: "engine.py", uncommitted: false, checkout: r))
    }
    let board = Board(
      id: BoardID(rawValue: "many"),
      cards: segments.enumerated().map { i, s in
        Card(
          id: CardID(rawValue: "c\(i)"), x: 0, y: Double(i) * 100, width: 420,
          content: .own(CardContent(body: .code(CodeCard(segments: [s])))))
      })
    #expect(CanvasView.callInfo(board, marks).isEmpty)
    await until("answered") { !marks.isAsking }
    #expect(told == 1, "told once for the 200 asked together")
    #expect(CanvasView.callInfo(board, marks).count == 200)
    // a refresh: the main thread's time asking for all 200
    let n: UInt64 = 200
    let start = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
    for _ in 0..<n { _ = CanvasView.callInfo(board, marks) }
    let each = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - start) / Double(n) / 1e6
    print("callInfo of 200 code cards: \(each) ms of CPU per refresh")
    #expect(each < 1, "\(each) ms")
    #expect(told == 1)
  }
}

/// A shell that knows no calls, the segments it is asked of kept
@MainActor private final class AskedCalls: CallHost {
  var onCallsChanged: (() -> Void)?
  var asked: Set<SegmentID> = []
  func calls(_ s: Segment) -> [CallSpan]? {
    asked.insert(s.id)
    return nil
  }
}

@MainActor @Suite(.serialized) struct SharedCallsTests {
  @Test func aSharedCodeCardOnAnOpenBoardIsAskedForItsCalls() async throws {
    let fm = FileManager.default
    let vault = Vault(root: fm.temporaryDirectory.appending(path: "calls-shared-\(UUID().uuidString)"))
    defer { try? fm.removeItem(at: vault.root) }
    try fm.createDirectory(at: vault.sharedFolderURL, withIntermediateDirectories: true)
    let s = CardID(rawValue: "s")
    let seg = Segment(
      id: SegmentID(rawValue: "shared1"), source: .file(path: "engine.py", hash: nil), language: "python",
      firstLine: 1, lines: ["f()"])
    try SharedCard(id: s, content: CardContent(body: .code(CodeCard(segments: [seg])))).encoded()
      .write(to: vault.sharedFolderURL.appending(path: "s.json"))
    try vault.newBoard(
      in: "", title: "A",
      board: Board(id: BoardID(rawValue: "a"), cards: [Card(id: s, x: 0, y: 0, width: 420, content: .shared)]))
    let shell = Shell()
    shell.open(vault, restoring: nil)
    shell.apply(.success(try vault.tree()))
    let panes = BoardPanes(shell: shell)
    panes.frame = CGRect(x: 0, y: 0, width: 1000, height: 700)
    shell.show(BoardID(rawValue: "a"))
    panes.sync()
    let tab = try #require(shell.selected)
    let pane = try #require(panes.panes[tab])
    let host = AskedCalls()
    pane.canvas.callHost = host
    let deadline = ContinuousClock.now + .seconds(20)
    while !host.asked.contains(seg.id) && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
    #expect(host.asked.contains(seg.id))
  }
}

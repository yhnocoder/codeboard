import CodeBoardModel
import CodeBoardReading
import CodeBoardWorkspace
import Foundation
import Testing

@testable import CodeBoardShell

// What code tabs ask of the shell (ShellCode.swift), on small git repositories made here: the source a card from a
// repository's file records (the remote URL, HEAD, the path from the git root, uncommitted when the lines are not
// HEAD's; a file in a folder of no repository by its path and fingerprint), the cards of the board in front showing a
// function's lines, and a name's definitions by the name index

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

/// A folder of these files, links resolved; a repository committed on main when `repo`
private func folder(_ files: [String: String], repo: Bool) throws -> String {
  let d = FileManager.default.temporaryDirectory.appending(path: "cb-code-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
  let r = ShellCode.realPath(d.path)
  for (f, t) in files {
    try FileManager.default.createDirectory(
      atPath: (r + "/" + f as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try t.write(toFile: r + "/" + f, atomically: true, encoding: .utf8)
  }
  if repo {
    try git(r, "-c", "init.defaultBranch=main", "init", "-q")
    try git(r, "add", "-A")
    try git(r, "commit", "-qm", "base")
  }
  return r
}

private let engine = """
  class Engine:
      def step(self):
          return schedule(self)

  def schedule(e):
      return e
  """

private let other = """
  class Runner:
      def step(self):
          return 1
  """

/// The board in front, as the test sets it
@MainActor private final class Front {
  var board: Board?
}

@MainActor @Suite struct ShellCodeTests {
  func pick(_ text: String, _ lines: ClosedRange<Int>, _ symbol: Symbol? = nil, scope: String? = nil) -> CodePick {
    CodePick(text: text, lines: lines, symbol: symbol, scope: scope)
  }

  /// In a repository with a remote: its URL, HEAD, the path from the git root (the folder added below it), not
  /// uncommitted; changed and not committed, uncommitted, the working tree's lines
  @Test func aCardOfARepositorysFileRecordsItsRemoteCommitAndPath() async throws {
    let r = try folder(["src/pkg/engine.py": engine, "README.md": "r\n"], repo: true)
    defer { try? FileManager.default.removeItem(atPath: r) }
    try git(r, "remote", "add", "origin", "git@github.com:acme/engine.git")
    let head = try git(r, "rev-parse", "HEAD")
    let code = ShellCode(git: GitCache(), board: { nil })
    let f = CodeFile(repository: r + "/src", name: "src", path: "pkg/engine.py")
    let fn = Symbol(name: "Engine.step", kind: .function)
    let s = try #require(await code.segment(f, pick(engine, 2...3, fn)))
    #expect(
      s.source
        == .git(
          repository: "git@github.com:acme/engine.git", commit: head, path: "src/pkg/engine.py", uncommitted: false,
          checkout: nil))
    #expect(s.firstLine == 2 && s.lines == ["    def step(self):", "        return schedule(self)"])
    #expect(s.symbol == fn && s.language == "python" && s.scope == nil)
    // changed in the working tree: the lines as shown, not committed
    let changed = engine.replacingOccurrences(of: "return schedule(self)", with: "return schedule(self, 2)")
    try changed.write(toFile: r + "/src/pkg/engine.py", atomically: true, encoding: .utf8)
    let u = try #require(await code.segment(f, pick(changed, 2...3, fn)))
    #expect(
      u.source
        == .git(
          repository: "git@github.com:acme/engine.git", commit: head, path: "src/pkg/engine.py", uncommitted: true,
          checkout: nil))
    #expect(u.lines.last == "        return schedule(self, 2)")
    // a change elsewhere in the file leaves these lines HEAD's
    let above = "# a new first line\n" + engine
    try above.write(toFile: r + "/src/pkg/engine.py", atomically: true, encoding: .utf8)
    let moved = try #require(await code.segment(f, pick(above, 6...7, scope: "schedule")))
    if case .git(_, _, _, let uncommitted, _)? = moved.source {
      #expect(!uncommitted && moved.firstLine == 5, "HEAD's line numbers: \(moved.firstLine)")
    } else {
      Issue.record("not a git source: \(String(describing: moved.source))")
    }
    #expect(moved.scope == "schedule")
  }

  /// A repository with no remote is recorded by its git root, where it was read
  @Test func aRepositoryWithoutARemoteIsRecordedByItsFolder() async throws {
    let r = try folder(["a.py": engine], repo: true)
    defer { try? FileManager.default.removeItem(atPath: r) }
    let code = ShellCode(git: GitCache(), board: { nil })
    let s = try #require(await code.segment(CodeFile(repository: r, name: "a", path: "a.py"), pick(engine, 5...6)))
    #expect(
      s.source
        == .git(
          repository: nil, commit: try git(r, "rev-parse", "HEAD"), path: "a.py", uncommitted: false, checkout: r))
  }

  /// A folder that is no git repository: a file source, its path in the folder and a fingerprint of its content
  @Test func aFileOfAFolderOfNoRepositoryIsAFileSource() async throws {
    let r = try folder(["lib/a.py": engine], repo: false)
    defer { try? FileManager.default.removeItem(atPath: r) }
    let code = ShellCode(git: GitCache(), board: { nil })
    let s = try #require(await code.segment(CodeFile(repository: r, name: "x", path: "lib/a.py"), pick(engine, 1...3)))
    guard case .file(let path, let hash)? = s.source else {
      Issue.record("not a file source: \(String(describing: s.source))")
      return
    }
    #expect(path == "lib/a.py" && hash?.isEmpty == false && s.firstLine == 1 && s.lines.count == 3)
  }

  /// The board's cards whose segments show lines of a function: by repository and path, any overlap; nothing
  /// without a board, and adding is off then
  @Test func theCountsAreTheBoardsCardsShowingTheLines() async throws {
    let r = try folder(["e.py": engine, "o.py": other], repo: true)
    defer { try? FileManager.default.removeItem(atPath: r) }
    try git(r, "remote", "add", "origin", "https://github.com/acme/engine")
    let front = Front()
    let code = ShellCode(git: GitCache(), board: { front.board })
    #expect(!code.canAdd && code.counts(CodeFile(repository: r, name: "e", path: "e.py"), [1...3]) == [0])
    let f = CodeFile(repository: r, name: "e", path: "e.py")
    let step = try #require(await code.segment(f, pick(engine, 2...3)))
    let both = try #require(await code.segment(f, pick(engine, 1...6)))
    let elsewhere = try #require(
      await code.segment(CodeFile(repository: r, name: "e", path: "o.py"), pick(other, 1...3)))
    func card(_ id: String, _ segs: [Segment]) -> Card {
      Card(
        id: CardID(rawValue: id), x: 0, y: 0, width: 400,
        content: .own(CardContent(body: .code(CodeCard(segments: segs)))))
    }
    var b = Board(id: BoardID(rawValue: "b"), cards: [card("c1", [step]), card("c2", [both]), card("c3", [elsewhere])])
    // the same repository by another spelling of its URL
    if case .git(_, let c, let p, let u, let k)? = step.source {
      var s = step
      s.source = .git(repository: "git@github.com:acme/engine.git", commit: c, path: p, uncommitted: u, checkout: k)
      b.cards.append(card("c4", [s]))
    }
    front.board = b
    #expect(code.canAdd)
    #expect(code.counts(f, [1...3, 5...6, 2...2]) == [3, 1, 3])
  }

  /// A name by the index: one that stands out alone (the receiver's class), several to choose from, the name's own
  /// definition no answer, none for an unknown name
  @Test func definitionsAreFoundByNameAndRankedByTheReceiver() async throws {
    let r = try folder(["e.py": engine, "sub/o.py": other], repo: false)
    defer { try? FileManager.default.removeItem(atPath: r) }
    let code = ShellCode(git: GitCache(), board: { nil })
    let f = CodeFile(repository: r, name: "x", path: "e.py")
    code.opened(r)
    let call = try #require(await code.definitions(f, CodeName(name: "schedule", line: 3), scan: true).first)
    #expect(call == CodeDefinition(path: "e.py", line: 5, label: "schedule", detail: "e.py:5"))
    let elsewhere = CodeFile(repository: r, name: "x", path: "main.py")
    let all = await code.definitions(elsewhere, CodeName(name: "step", line: 9), scan: true)
    #expect(Set(all.map(\.label)) == ["Engine.step", "Runner.step"], "several")
    let runner = await code.definitions(f, CodeName(name: "step", receiver: "runner", line: 9), scan: true)
    #expect(runner.map(\.path) == ["sub/o.py"], "the receiver names the class")
    let own = await code.definitions(f, CodeName(name: "schedule", line: 5), scan: true)
    #expect(own.isEmpty, "its own definition")
    #expect(await code.definitions(f, CodeName(name: "nothing_here", line: 1), scan: true).isEmpty)
  }
}

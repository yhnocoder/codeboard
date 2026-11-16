import CodeBoardModel
import CodeBoardWorkspace
import Foundation
import Testing

@testable import CodeBoardReading
@testable import CodeBoardShell

// What code tabs ask of the shell (ShellCode.swift), on small git repositories made here: the source a card from a
// repository's file records (the remote URL, HEAD, the path from the git root, uncommitted when the lines are not
// HEAD's; a file in a folder of no repository by its path and fingerprint), the cards of the board in front showing a
// function's lines, and a name's definitions by the name index; where a file's lines are on the vault's boards, a
// card's file opened, what keeps it from opening, and ⌘K's functions and classes (ShellCodeCards.swift)

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

  // MARK: Lines on boards

  /// A segment's source with another commit, or other lines
  func moved(_ s: Segment, commit: String? = nil, lines: [String]? = nil) -> Segment {
    var m = s
    if case .git(let r, let c, let p, let u, let k)? = s.source {
      m.source = .git(repository: r, commit: commit ?? c, path: p, uncommitted: u, checkout: k)
    }
    if let lines { m.lines = lines }
    return m
  }

  /// A card's lines: its recorded ones when it is of the version shown; from an older commit followed through the
  /// line diff to where they are now, that commit said; from a commit not on this Mac found by their text, and left
  /// out when their text is not there (never placed by line number alone). The board in front's first, by the tree
  @Test func linesOnBoardsAreFollowedFromTheCardsCommitOrFoundByTheirText() async throws {
    let r = try folder(["e.py": engine], repo: true)
    defer { try? FileManager.default.removeItem(atPath: r) }
    let f = CodeFile(repository: r, name: "e", path: "e.py")
    let maker = ShellCode(git: GitCache(), board: { nil })
    let old = try #require(await maker.segment(f, pick(engine, 2...3)))
    let a = try git(r, "rev-parse", "HEAD")
    let now = "import os\n\n" + engine
    try now.write(toFile: r + "/e.py", atomically: true, encoding: .utf8)
    try git(r, "commit", "-qam", "imports")
    let same = try #require(await maker.segment(f, pick(now, 4...5)))
    let absent = "0123456789abcdef0123456789abcdef01234567"
    let boards = try TwoBoards(
      a: [card("old", [old]), card("same", [same])],
      b: [
        card("gone", [moved(old, commit: absent)]),
        card("lost", [moved(old, commit: absent, lines: ["    def nowhere(self):", "        pass"])]),
      ])
    defer { boards.close() }
    let code = ShellCode(git: GitCache(), board: { boards.a.board }, boards: { boards.boards })
    let on = await code.onBoards(f, text: now)
    #expect(on.map(\.card.rawValue) == ["old", "same", "gone"], "lost: its text is nowhere")
    #expect(on.map(\.lines) == [4...5, 4...5, 4...5])
    #expect(on.map(\.commit) == [String(a.prefix(7)), nil, "0123456"])
    #expect(on.map(\.here) == [true, true, false] && on.map(\.boardName) == ["A", "A", "B"])
    #expect(on.map(\.range) == ["2–3", "4–5", "2–3"])
    // the file as the working tree has it, not committed: the recorded lines where they still are
    let edited = now + "\nx = 1\n"
    let again = await code.onBoards(f, text: edited)
    #expect(again.map(\.lines) == [4...5, 4...5, 4...5])
    #expect(await code.onBoards(CodeFile(repository: r, name: "e", path: "o.py"), text: other).isEmpty)
  }

  /// What is on boards follows their changes: a card added, removed and undone on an open board is told to the code
  /// tabs once a turn (a selection is not), and a board only on disk read again once another window wrote it
  @Test func theBoardsCardsAreFollowedThroughEditsUndoAndOtherWindowsWrites() async throws {
    let r = try folder(["e.py": engine], repo: true)
    defer { try? FileManager.default.removeItem(atPath: r) }
    let f = CodeFile(repository: r, name: "e", path: "e.py")
    let maker = ShellCode(git: GitCache(), board: { nil })
    let step = try #require(await maker.segment(f, pick(engine, 2...3)))
    let boards = try TwoBoards(a: [card("x", [step])], b: [])
    defer { boards.close() }
    let code = ShellCode(git: GitCache(), board: { boards.a.board }, boards: { boards.boards })
    let pane = ReadingPane()
    code.pane = pane
    let told = Told()
    let token = NotificationCenter.default.addObserver(forName: CodeReading.boardsChanged, object: pane, queue: nil) {
      _ in told.n += 1
    }
    defer { NotificationCenter.default.removeObserver(token) }
    func cards() async -> [String] { await code.onBoards(f, text: engine).map(\.card.rawValue) }
    #expect(await cards() == ["x"])
    boards.a.select([.card(CardID(rawValue: "x"))])
    #expect(!code.telling, "a selection changes no card")
    boards.a.edit("Add") {
      $0.cards.append(card("y", [step]))
      $0.cards.append(card("z", [step]))
    }
    try await until("told") { told.n == 1 }
    #expect(await cards() == ["x", "y", "z"])
    boards.a.undo()
    try await until("told again") { told.n == 2 }
    #expect(await cards() == ["x"])
    boards.a.edit("Delete") { $0.cards.removeAll() }
    try await until("told of the delete") { told.n == 3 }
    #expect(await cards().isEmpty)
    // another window writes board B
    try Board(id: BoardID(rawValue: "b"), cards: [card("w", [step])]).encoded().write(to: boards.file("B"))
    let on = await code.onBoards(f, text: engine)
    #expect(on.map(\.card.rawValue) == ["w"] && on.first?.here == false)
  }

  /// What keeps a card's file from opening, said, and the one way on offered
  @Test func eachWayARepositoryIsMissingSaysWhatAndOffersTheWayOn() throws {
    func repo(_ json: String) throws -> Repository { try JSONDecoder().decode(Repository.self, from: Data(json.utf8)) }
    let clone = try repo(
      #"{"kind":{"clone":{"lightweight":true}},"path":"/c/engine","remote":"https://github.com/acme/engine"}"#)
    let bare = try repo(#"{"kind":{"folder":{}},"path":"/w/local"}"#)
    let c = "0123456789abcdef"
    let here = CodeFile(repository: "/c/engine", name: "acme/engine", path: "e.py")
    #expect(ShellCode.missing(.found(clone, root: "/c/engine"), commit: c, current: nil) == nil)
    #expect(
      ShellCode.missing(.commitMissing(clone), commit: c, current: here)
        == .init(
          message: "Commit 0123456 cannot be found in acme/engine, not even on its remote.", offer: .current(here)))
    #expect(
      ShellCode.missing(.commitMissing(bare), commit: c, current: nil)
        == .init(message: "Commit 0123456 is not in local, which has no remote to fetch it from.", offer: nil))
    #expect(
      ShellCode.missing(
        .notAdded(address: "git@github.com:acme/engine.git", folder: "/w/engine"), commit: c, current: nil)
        == .init(
          message: "This card was read in /w/engine, which is not added on this Mac.", offer: .folder("/w/engine")))
    #expect(
      ShellCode.missing(.notAdded(address: "git@github.com:acme/engine.git", folder: nil), commit: c, current: nil)
        == .init(message: "acme/engine is not added on this Mac.", offer: .clone("git@github.com:acme/engine.git")))
    #expect(
      ShellCode.missing(.notAdded(address: "https://git.example/x.git", folder: nil), commit: c, current: nil)
        == .init(
          message: "https://git.example/x.git is not added on this Mac. Clone it and add its folder.", offer: nil))
    #expect(ShellCode.missing(.notAdded(address: nil, folder: nil), commit: c, current: nil)?.offer == nil)
  }

  /// A card's file opened from its header: in a kept tab of the reading pane at the card's lines, from an older commit
  /// at the lines followed to the working tree, its bar saying the commit
  @Test func aCardsFileOpensAtItsLinesAndAnOlderCommitIsSaid() async throws {
    let r = try folder(["e.py": engine], repo: true)
    defer { try? FileManager.default.removeItem(atPath: r) }
    let f = CodeFile(repository: r, name: "e", path: "e.py")
    let code = ShellCode(git: GitCache(), board: { nil })
    let old = try #require(await code.segment(f, pick(engine, 5...6)))
    let a = try git(r, "rev-parse", "HEAD")
    try ("import os\n\n" + engine).write(toFile: r + "/e.py", atomically: true, encoding: .utf8)
    try git(r, "commit", "-qam", "imports")
    let pane = ReadingPane()
    code.pane = pane
    await code.show(old, in: f, root: r)
    let tab = try #require(pane.tabs.first)
    #expect(pane.tabs.count == 1 && !tab.preview && pane.currentCode == f)
    #expect(CodeTabView.pendingLocate[tab.id]?.0 == 7...8)
    #expect(CodeTabView.pendingLocate[tab.id]?.1 == "Card from \(a.prefix(7))")
    CodeTabView.pendingLocate[tab.id] = nil
  }

  // MARK: ⌘K's functions and classes

  /// Scored as the VS Code palette scores them: the name's match first, then the qualified name's; the best 60; a
  /// repository's name before the path when more than one is indexed
  @Test func functionsAndClassesAreRankedByNameThenQualifiedName() {
    func e(_ qual: String, _ abs: String, isClass: Bool = false) -> IndexEntry {
      IndexEntry(
        name: String(qual.split(separator: ".").last!), qual: qual, kind: isClass ? .class : .def, abs: abs, start: 3,
        end: 9, defLine: 4,
        sig: "")
    }
    let one = [
      e("Engine.step", "/r/e.py"), e("Stepper", "/r/s.py", isClass: true), e("step_all", "/r/a.py"),
      e("Runner.walk", "/r/step/w.py"), e("Elsewhere.step", "/other/x.py"),
    ]
    let got = ShellCode.ranked("step", [(folder: "/r", root: "/r", name: "r", entries: one)])
    #expect(got.map(\.label) == ["Engine.step", "Stepper", "step_all"], "not out of the root, nor by its path")
    #expect(got.first?.detail == "e.py:4" && got.first?.path == "e.py" && got.first?.start == 3 && got.first?.end == 9)
    #expect(got[1].isClass && got[1].glyph == "C" && got[0].glyph == "ƒ" && !got[0].isClass)
    let two = ShellCode.ranked(
      "step",
      [
        (folder: "/r", root: "/r", name: "r", entries: one),
        (folder: "/q", root: "/q", name: "q", entries: [e("q.step", "/q/q.py")]),
      ])
    #expect(two.first { $0.label == "q.step" }?.detail == "q › q.py:4")
    let many = (0..<80).map { e("m.step\($0)", "/r/m\($0).py") }
    #expect(ShellCode.ranked("step", [(folder: "/r", root: "/r", name: "r", entries: many)]).count == 60)
  }

  /// Only repositories already indexed are searched: none before a code tab or the sidebar opens one
  @Test func onlyIndexedRepositoriesAreSearched() async throws {
    let r = try folder(["e.py": engine, "sub/o.py": other], repo: false)
    defer { try? FileManager.default.removeItem(atPath: r) }
    let code = ShellCode(git: GitCache(), board: { nil })
    #expect(await code.symbols("step").isEmpty)
    code.opened(r)
    try await until("indexed") { await code.symbols("step").count == 2 }
    #expect(Set(await code.symbols("step").map(\.label)) == ["Engine.step", "Runner.step"])
    let step = try #require(await code.symbols("step").first { $0.label == "Engine.step" })
    #expect(
      step.preview == "```python\n    def step(self):\n        return schedule(self)\n```", "its lines, for the preview"
    )
    #expect(await code.symbols("  ").isEmpty)
  }
}

private func card(_ id: String, _ segs: [Segment]) -> Card {
  Card(
    id: CardID(rawValue: id), x: 0, y: 0, width: 400, content: .own(CardContent(body: .code(CodeCard(segments: segs)))))
}

/// Until `ok` holds, polled; 20 s at most
@MainActor private func until(_ what: String, _ ok: () async -> Bool) async throws {
  let deadline = ContinuousClock.now + .seconds(20)
  while !(await ok()) {
    if ContinuousClock.now > deadline {
      Issue.record("\(what): not within 20 s")
      return
    }
    try await Task.sleep(for: .milliseconds(5))
  }
}

/// Notifications counted (posted on the main thread)
private final class Told: @unchecked Sendable {
  var n = 0
}

/// A vault of board A, open as a document, and board B, only its file
@MainActor private final class TwoBoards {
  let vault: Vault
  let a: BoardDocument

  init(a: [Card], b: [Card]) throws {
    let vault = Vault(root: FileManager.default.temporaryDirectory.appending(path: "cb-onboards-\(UUID().uuidString)"))
    for (name, cards) in [("A", a), ("B", b)] {
      try FileManager.default.createDirectory(at: vault.url(of: "\(name).board"), withIntermediateDirectories: true)
      try Board(id: BoardID(rawValue: name.lowercased()), cards: cards).encoded().write(to: Self.file(vault, name))
    }
    self.vault = vault
    let file = Self.file(vault, "A")
    self.a = try BoardDocument(file: { file })
  }

  nonisolated static func file(_ vault: Vault, _ name: String) -> URL {
    vault.url(of: "\(name).board").appending(path: Vault.boardFileName)
  }

  func file(_ name: String) -> URL { Self.file(vault, name) }

  var boards: ShellCode.Boards {
    ShellCode.Boards(
      vault: vault,
      all: [
        VaultBoard(id: BoardID(rawValue: "a"), title: "A", path: "A.board"),
        VaultBoard(id: BoardID(rawValue: "b"), title: "B", path: "B.board"),
      ],
      open: [BoardID(rawValue: "a"): a])
  }

  func close() { try? FileManager.default.removeItem(at: vault.root) }
}

import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardWorkspace
import Foundation
import Testing

@testable import CodeBoardReading
@testable import CodeBoardShell

// Which code cards have a newer version and moving them to it (ShellVersions.swift), on small git repositories made
// here, added to a list of repositories of the test's own: a commit that changes a card's lines marks it, Update
// follows its lines in one undo step and undo puts everything back; code that only moved is followed with no step; a
// change not committed, a file deleted; a repository taken off the list takes its marks; a commit not here is fetched
// when asked for; a commit touching fifty cards marks them in one check; a commit seen by the repository's watcher

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

private func temp(_ name: String) throws -> String {
  let d = FileManager.default.temporaryDirectory.appending(path: "cb-versions-\(name)-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
  return ShellCode.realPath(d.path)
}

private func repo(_ files: [String: String]) throws -> String {
  let r = try temp("repo")
  for (f, t) in files { try t.write(toFile: r + "/" + f, atomically: true, encoding: .utf8) }
  try git(r, "-c", "init.defaultBranch=main", "init", "-q")
  try git(r, "add", "-A")
  try git(r, "commit", "-qm", "base")
  return r
}

private func fn(_ name: String, _ body: String = "return x") -> String { "def \(name)(x):\n    y = x\n    \(body)\n" }

private let engine = fn("schedule") + "\n" + fn("other")

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

/// A repository added to a list of the test's own, a board of cards from it open as a document, shown on a canvas of
/// no window, its version checks waiting no pause
@MainActor private final class Rig {
  let repo: String
  let data: String
  let model: RepositoriesModel
  let code: ShellCode
  let versions: ShellVersions
  let canvas: CanvasView
  var doc: BoardDocument!
  var vault: String = ""

  init(_ repo: String) async throws {
    self.repo = repo
    data = try temp("data")
    model = RepositoriesModel(folder: URL(filePath: data), runner: ProcessGitRunner(), defaults: nil)
    await model.addFolder(repo)
    code = ShellCode(git: try #require(model.git), board: { nil })
    code.repositories = model
    versions = code.versions
    versions.pause = { _ in }
    canvas = CanvasView(frame: CGRect(x: 0, y: 0, width: 800, height: 600), noteCache: URL(filePath: data + "/notes"))
  }

  /// A card of a function of a file, as a code tab makes it
  func card(_ path: String, _ name: String, id: String) async throws -> Card {
    let text = try String(contentsOfFile: repo + "/" + path, encoding: .utf8)
    let lines = text.components(separatedBy: "\n")
    let start = try #require(lines.firstIndex { $0.hasPrefix("def \(name)(") }) + 1
    let f = CodeFile(repository: repo, name: "r", path: path)
    let pick = CodePick(text: text, lines: start...(start + 2), symbol: Symbol(name: name, kind: .function))
    let s = try #require(await code.segment(f, pick))
    return Card(
      id: CardID(rawValue: id), x: 0, y: 0, width: 400, content: .own(CardContent(body: .code(CodeCard(segments: [s]))))
    )
  }

  /// The board open and shown, its first check done
  func open(_ board: Board) async throws {
    vault = try temp("vault")
    let file = URL(filePath: vault + "/b.board/" + Vault.boardFileName)
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try board.encoded().write(to: file)
    doc = try BoardDocument(file: { file })
    let (canvas, doc) = (canvas, doc!)
    versions.shown = { [(canvas, doc)] }
    versions.follow()
    await versions.settled()
  }

  var states: [SegmentID: VersionState] { versions.states[doc.id] ?? [:] }
  func seg(_ card: String) -> Segment { doc.board.codeCards.first { $0.id.rawValue == card }!.code.segments[0] }
  func commit(_ path: String, _ text: String, _ msg: String = "change") throws {
    try text.write(toFile: repo + "/" + path, atomically: true, encoding: .utf8)
    try git(repo, "commit", "-qam", msg)
  }

  /// The diff Update takes, as the chip's popover gets it
  func diff(_ card: String) async throws -> VersionDiff {
    let l = try #require(await versions.local(seg(card)))
    return try await l.sources.diff(l.seg)
  }

  func close() {
    for d in [repo, data, vault] where !d.isEmpty { try? FileManager.default.removeItem(atPath: d) }
  }
}

@MainActor @Suite(.serialized) struct ShellVersionsTests {
  @Test func aCommitChangingACardsLinesMarksItAndUpdateFollowsItsLinesInOneUndoStep() async throws {
    let r = try await Rig(try repo(["e.py": engine]))
    defer { r.close() }
    var card = try await r.card("e.py", "schedule", id: "c")
    let s = r.seg0(card)
    // a highlight with a sidenote on the last line, an arrow from the middle one, a sticker on the first
    card = r.edited(card) { $0.highlights = [s.firstLine + 2...s.firstLine + 2] }
    let other = try await r.card("e.py", "other", id: "o")
    let board = Board(
      id: BoardID(rawValue: "b"), cards: [card, other],
      arrows: [
        Arrow(
          id: ArrowID(rawValue: "a"), from: Endpoint(card: card.id, segment: s.id, line: s.firstLine + 1),
          to: Endpoint(card: other.id))
      ],
      sidenotes: [
        Sidenote(
          id: SidenoteID(rawValue: "n"),
          anchor: .card(card.id, segment: s.id, lines: s.firstLine + 2...s.firstLine + 2),
          body: .text(TextNote(text: "why")))
      ],
      stickers: [
        Sticker(
          id: StickerID(rawValue: "k"), glyph: .builtin(.star), anchor: .line(card.id, segment: s.id, line: s.firstLine)
        )
      ])
    try await r.open(board)
    #expect(r.states.isEmpty && r.canvas.versions.isEmpty, "pinned to HEAD: nothing to say")

    try r.commit("e.py", "import os\n\n" + fn("schedule", "return x * 2") + "\n" + fn("other"))
    let head = try git(r.repo, "rev-parse", "HEAD")
    r.versions.check(r.doc.id)
    await r.versions.settled()
    #expect(r.states[s.id] == .changed(hiddenOnly: false, label: String(head.prefix(7))))
    #expect(r.canvas.versions == r.states && r.doc.board.staleCount(r.states) == 1)
    #expect(r.states[other.code.segments[0].id] == nil, "other only moved: followed")
    #expect(r.seg("o").firstLine == 7)
    #expect(r.doc.undoName == nil, "following a move is no undo step")

    let before = r.doc.board
    let d = try await r.diff("c")
    #expect(d.right.label == "HEAD \(head.prefix(7))" && d.newSeg != nil)
    #expect(
      ShellVersions.impact(r.doc.board, card.id, s.id)
        == "On update: 1 highlight, 1 link, 1 sidenote move with their lines; anything on a removed line attaches to the whole card."
    )
    let seat = r.doc.seat(for: r)
    #expect(r.versions.update(card.id, s.id, to: d, in: seat, on: nil))
    let now = r.seg("c")
    #expect(now.firstLine == 3 && now.lines.last == "    return x * 2" && now.highlights == [5...5])
    if case .git(_, let commit, _, false, _)? = now.source { #expect(commit == head) } else { Issue.record("source") }
    #expect(r.doc.board.arrows[0].from.line == 4 && r.doc.board.sidenotes[0].anchor.lines?.range == 5...5)
    #expect(r.doc.board.sidenotes[0].review == String(head.prefix(7)), "its line changed: a second look")
    #expect(r.doc.board.stickers[0].anchor == .line(card.id, segment: s.id, line: 3))
    #expect(r.states.isEmpty && r.doc.undoName == "Update to New Version")
    await r.versions.settled()
    #expect(r.states.isEmpty, "checked again: current")

    seat.undo()
    #expect(r.doc.board.arrows == before.arrows && r.doc.board.sidenotes == before.sidenotes)
    #expect(r.doc.board.cards == before.cards && r.doc.board.stickers == before.stickers && r.doc.undoName == nil)
    await r.versions.settled()
    #expect(
      r.states[s.id] == .changed(hiddenOnly: false, label: String(head.prefix(7))), "undone: the new version again")
  }

  @Test func linesInsertedAboveAreFollowedWithTheNewCommitAndNoStep() async throws {
    let r = try await Rig(try repo(["e.py": engine]))
    defer { r.close() }
    try await r.open(Board(id: BoardID(rawValue: "b"), cards: [try await r.card("e.py", "schedule", id: "c")]))
    try r.commit("e.py", "# a\n# b\n# c\n" + engine)
    let head = try git(r.repo, "rev-parse", "HEAD")
    r.versions.check(r.doc.id)
    await r.versions.settled()
    #expect(r.states.isEmpty && r.seg("c").firstLine == 4 && r.doc.undoName == nil)
    if case .git(_, let commit, _, _, _)? = r.seg("c").source { #expect(commit == head) }
  }

  @Test func aChangeNotCommittedAndAFileDeletedAreMarked() async throws {
    let r = try await Rig(try repo(["e.py": engine, "f.py": fn("lone")]))
    defer { r.close() }
    try await r.open(
      Board(
        id: BoardID(rawValue: "b"),
        cards: [try await r.card("e.py", "schedule", id: "c"), try await r.card("f.py", "lone", id: "l")]))
    try (fn("schedule", "return 0") + "\n" + fn("other")).write(
      toFile: r.repo + "/e.py", atomically: true, encoding: .utf8)
    let gd = r.repo + "/.git"
    // as the repository's watcher hears it
    r.versions.repoChanged(r.repo, gitDir: gd, [r.repo + "/e.py"], git: r.code.git)
    try await until("uncommitted") { r.states[r.seg("c").id] == .uncommitted }
    let c = r.doc.board.codeCards.first { $0.id.rawValue == "c" }!.code
    #expect(c.uncommitted(r.states) && c.version(r.states) == nil)
    try git(r.repo, "rm", "-q", "f.py")
    try git(r.repo, "commit", "-qm", "rm")
    r.versions.repoChanged(r.repo, gitDir: gd, [gd + "/HEAD", gd + "/refs/heads/main"], git: r.code.git)
    try await until("lost") { r.states[r.seg("l").id] == .lost }
  }

  @Test func aRepositoryTakenOffTheListTakesItsMarksAndNothingIsSaid() async throws {
    let r = try await Rig(try repo(["e.py": engine]))
    defer { r.close() }
    try await r.open(Board(id: BoardID(rawValue: "b"), cards: [try await r.card("e.py", "schedule", id: "c")]))
    try r.commit("e.py", fn("schedule", "return 1") + "\n" + fn("other"))
    r.versions.check(r.doc.id)
    await r.versions.settled()
    #expect(r.states.count == 1)
    let added = try #require(r.model.list.first)
    await r.model.remove(added, confirm: { _ in true })
    try await until("no marks") { r.states.isEmpty && r.canvas.versions.isEmpty }
    #expect(r.model.notice == nil)
  }

  @Test func aCardFromNoRepositoryHereShowsNothingUntilAskedThenSaysWhatIsMissing() async throws {
    let r = try await Rig(try repo(["e.py": engine]))
    defer { r.close() }
    let s = Segment(
      id: SegmentID(rawValue: "s"),
      source: .git(
        repository: "https://github.com/o/n", commit: String(repeating: "a", count: 40), path: "e.py",
        uncommitted: false, checkout: nil),
      language: "python", firstLine: 1, lines: ["def schedule(x):"])
    let card = Card(
      id: CardID(rawValue: "c"), x: 0, y: 0, width: 400,
      content: .own(CardContent(body: .code(CodeCard(segments: [s])))))
    try await r.open(Board(id: BoardID(rawValue: "b"), cards: [card]))
    #expect(r.states.isEmpty)
    var said: [ShellCode.Missing?] = []
    #expect(await r.versions.reach(s, say: { said.append($0) }) == nil)
    #expect(
      said == [ShellCode.Missing(message: "o/n is not added on this Mac.", offer: .clone("https://github.com/o/n"))])
  }

  @Test func aCommitNotHereIsFetchedFromTheRemoteWhenItsNewVersionIsAsked() async throws {
    let origin = try repo(["e.py": engine])
    let mine = try temp("mine")
    try git(mine, "clone", "-q", origin, ".")
    let r = try await Rig(mine)
    defer {
      r.close()
      try? FileManager.default.removeItem(atPath: origin)
    }
    // a card made in the origin after the clone: its commit is not in mine
    try (fn("schedule", "return 2") + "\n" + fn("other")).write(
      toFile: origin + "/e.py", atomically: true, encoding: .utf8)
    try git(origin, "commit", "-qam", "later")
    let later = try git(origin, "rev-parse", "HEAD")
    let s = Segment(
      id: SegmentID(rawValue: "s"),
      source: .git(repository: origin, commit: later, path: "e.py", uncommitted: false, checkout: nil),
      language: "python", firstLine: 1, lines: ["def schedule(x):", "    y = x", "    return 2"],
      symbol: Symbol(name: "schedule", kind: .function))
    let card = Card(
      id: CardID(rawValue: "c"), x: 0, y: 0, width: 400,
      content: .own(CardContent(body: .code(CodeCard(segments: [s])))))
    try await r.open(Board(id: BoardID(rawValue: "b"), cards: [card]))
    #expect((try? git(mine, "cat-file", "-e", later + "^{commit}")) == nil)
    var said: [ShellCode.Missing?] = []
    let l = await r.versions.reach(s, say: { said.append($0) })
    #expect(l != nil && said.first??.busy == true && said.last == .some(nil))
    #expect(said.first??.message == "Fetching \(later.prefix(7)) from \(URL(filePath: mine).lastPathComponent)…")
    #expect((try? git(mine, "cat-file", "-e", later + "^{commit}")) != nil, "fetched")
    await r.versions.settled()
    #expect(r.states.isEmpty, "checked again with the commit: HEAD is older than the card, no new version")
  }

  @Test func aCommitTouchingFiftyCardsMarksThemAllInOneCheck() async throws {
    let names = (0..<50).map { "f\($0)" }
    let r = try await Rig(try repo(["m.py": names.map { fn($0) }.joined(separator: "\n")]))
    defer { r.close() }
    var cards: [Card] = []
    for n in names { cards.append(try await r.card("m.py", n, id: n)) }
    try await r.open(Board(id: BoardID(rawValue: "b"), cards: cards))
    try r.commit("m.py", names.map { fn($0, "return x + 1") }.joined(separator: "\n"))
    r.versions.check(r.doc.id)
    await r.versions.settled()
    #expect(r.doc.board.staleCount(r.states) == 50 && r.canvas.versions.count == 50)
  }

  @Test func aCommitIsSeenByTheRepositorysWatcher() async throws {
    let r = try await Rig(try repo(["e.py": engine]))
    defer { r.close() }
    try await r.open(Board(id: BoardID(rawValue: "b"), cards: [try await r.card("e.py", "schedule", id: "c")]))
    try r.commit("e.py", fn("schedule", "return 3") + "\n" + fn("other"))
    try await until("marked by the watcher") { r.states.count == 1 }
  }
}

extension Rig {
  func seg0(_ c: Card) -> Segment {
    guard case .own(let k) = c.content, case .code(let code) = k.body else { fatalError() }
    return code.segments[0]
  }

  func edited(_ c: Card, _ f: (inout Segment) -> Void) -> Card {
    guard case .own(var k) = c.content, case .code(var code) = k.body else { return c }
    f(&code.segments[0])
    k.body = .code(code)
    var out = c
    out.content = .own(k)
    return out
  }
}

extension Card {
  fileprivate var code: CodeCard {
    guard case .own(let k) = content, case .code(let c) = k.body else { fatalError() }
    return c
  }
}

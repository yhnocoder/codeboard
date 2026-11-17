import AppKit
import CodeBoardModel
import CodeBoardWorkspace
import Foundation
import Testing

@testable import CodeBoardReading
@testable import CodeBoardShell

// A code tab's Highlights and sidenotes (ShellCodeNotes.swift), on a small git repository with a remote made here: they
// go into the vault's file of the repository, under its remote's key, show on a board's card of those lines, are found
// again where lines inserted above moved them, and changed and removed there

@discardableResult
private func git(_ dir: String, _ args: String...) throws -> String {
  let p = Process()
  p.executableURL = URL(filePath: "/usr/bin/env")
  p.arguments = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"] + args
  p.currentDirectoryURL = URL(filePath: dir)
  p.environment = ProcessInfo.processInfo.environment.merging(["GIT_TERMINAL_PROMPT": "0"]) { _, x in x }
  p.standardOutput = Pipe()
  p.standardError = Pipe()
  try p.run()
  p.waitUntilExit()
  struct Failed: Error { let args: [String] }
  guard p.terminationStatus == 0 else { throw Failed(args: args) }
  return ""
}

private func temp(_ name: String) throws -> URL {
  let d = FileManager.default.temporaryDirectory.appending(path: "cb-codenotes-\(name)-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
  return URL(filePath: ShellCode.realPath(d.path))
}

private let engine = """
  class Engine:
      def step(self):
          return schedule(self)

  def schedule(e):
      return e

  """

@MainActor @Suite(.serialized) struct ShellCodeNotesTests {
  @Test func aCodeTabsAnnotationsAreTheRepositorysAndShowOnTheBoardsCardsOfThoseLines() async throws {
    let repo = try temp("repo")
    let root = repo.path(percentEncoded: false).replacing(/\/$/, with: "")
    let vault = Vault(root: try temp("vault"))
    defer {
      try? FileManager.default.removeItem(at: repo)
      try? FileManager.default.removeItem(at: vault.root)
    }
    try engine.write(to: repo.appending(path: "e.py"), atomically: true, encoding: .utf8)
    try git(root, "-c", "init.defaultBranch=main", "init", "-q")
    try git(root, "remote", "add", "origin", "https://github.com/O/N.git")
    try git(root, "add", "-A")
    try git(root, "commit", "-qm", "base")
    let store = CodeNotes(
      vault: vault,
      key: { s in
        guard case .git(let r?, _, _, _, _) = s else { return nil }
        return repositoryKey(r)
      }, lineMap: { mapLines($0, $1, $2, $3) })
    let code = ShellCode(
      git: GitCache(), board: { nil }, boards: { ShellCode.Boards(vault: vault, all: [], open: [:], notes: store) })
    let f = CodeFile(repository: root, name: "n", path: "e.py")
    let key = "github.com/o/n"

    #expect(await code.annotate(f, CodePick(text: engine, lines: 5...6), note: "Why e?", ask: true))
    let got = await code.annotations(f, text: engine)
    #expect(got.highlights.map(\.lines) == [5...6] && got.notes.map(\.lines) == [5...6])
    #expect(got.notes.first?.note.text == "Why e?" && got.notes.first?.note.question?.done == false)
    #expect(store.notes(key, "e.py").highlights.first?.place.text == ["def schedule(e):", "    return e"])
    try store.flush()
    let folder = CodeFiles.folder(vault)
    let names = try FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false))
    try #require(names.count == 1)
    let json = try #require(
      try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appending(path: names[0]))) as? [String: Any])
    #expect(json["repository"] as? String == key && (json["files"] as? [String: Any])?.keys.sorted() == ["e.py"])

    // a board's card of those lines shows them
    let seg = try #require(
      await code.segment(f, CodePick(text: engine, lines: 5...6, symbol: Symbol(name: "schedule", kind: .function))))
    let card = Card(
      id: CardID(rawValue: "c"), x: 0, y: 0, width: 400,
      content: .own(CardContent(body: .code(CodeCard(segments: [seg])))))
    let file = vault.url(of: "A.board").appending(path: Vault.boardFileName)
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Board(id: BoardID(rawValue: "a"), cards: [card]).encoded().write(to: file)
    let doc = try BoardDocument(file: { file }, vault: vault, code: store)
    func shown() -> Segment? { doc.board.segment(card.id, seg.id) }
    #expect(shown()?.highlights == [5...6] && doc.board.sidenotes.map(\.id) == got.notes.map(\.id))

    // lines inserted above and not committed: found where they went
    let moved = "# a\n# b\n" + engine
    let again = await code.annotations(f, text: moved)
    #expect(again.highlights.map(\.lines) == [7...8] && again.notes.map(\.lines) == [7...8])

    // answered, then removed: from the repository's file and the board's card
    let id = try #require(got.notes.first?.id)
    await code.changeNote(f, id) { n in
      var m = n
      m.question?.done = true
      return m
    }
    #expect(store.notes(key, "e.py").sidenotes.first?.question?.done == true)
    if case .text(let n)? = doc.board.sidenotes.first?.body {
      #expect(n.question?.done == true)
    } else {
      Issue.record("the board's sidenote")
    }
    await code.remove(f, highlights: Set(got.highlights.map(\.id)), notes: [id])
    #expect(store.notes(key, "e.py").isEmpty && shown()?.highlights == [] && doc.board.sidenotes.isEmpty)
    try store.flush()
    #expect(try FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false)).isEmpty)
  }
}

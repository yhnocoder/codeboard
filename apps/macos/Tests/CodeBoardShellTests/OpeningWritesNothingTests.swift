import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// Opening a vault and looking at its boards writes nothing in it: no file changes, none is added or removed, whether
// the boards are of this format or of step 1's (refused, never rewritten). The one write opening makes is a folder
// board catching up with its folder (an automatic card for a board or folder its cards do not show yet); a test of its
// own says so, and that it is that board's file alone. Cameras are the app's own state, outside the vault.

@MainActor @Suite(.serialized) struct OpeningWritesNothingTests {
  let env = FullWindowEditTests()
  let fm = FileManager.default

  /// Every file under the vault: its bytes and when it was last written
  func files(_ root: URL) -> [String: (Data, Date)] {
    var all: [String: (Data, Date)] = [:]
    let keys: [URLResourceKey] = [.isRegularFileKey, .contentModificationDateKey]
    guard let e = fm.enumerator(at: root, includingPropertiesForKeys: keys) else { return all }
    let base = root.standardizedFileURL.path
    for case let u as URL in e {
      guard let v = try? u.resourceValues(forKeys: Set(keys)), v.isRegularFile == true,
        let data = try? Data(contentsOf: u), let date = v.contentModificationDate
      else { continue }
      all[String(u.standardizedFileURL.path.dropFirst(base.count))] = (data, date)
    }
    return all
  }

  /// The paths whose file is new, gone, or changed in its bytes or its date
  func changed(_ a: [String: (Data, Date)], _ b: [String: (Data, Date)]) -> [String] {
    Set(a.keys).union(b.keys).filter { a[$0]?.0 != b[$0]?.0 || a[$0]?.1 != b[$0]?.1 }.sorted()
  }

  /// The vault of the full-window tests (Notes, a Text and a Box with no height of their own, Free code, a Section,
  /// labelled arrows, a second board), with a folder of two boards and its folder board
  func vault() throws -> (Vault, folderBoard: BoardID) {
    let v = try env.vault()
    try v.newFolder(in: "", name: "Book")
    try v.newBoard(
      in: "Book", title: "Prefill",
      board: Board(
        id: BoardID(rawValue: "p"),
        cards: [
          Card(
            id: CardID(rawValue: "pn"), x: 0, y: 0, width: 240,
            content: .own(CardContent(body: .note(Note(text: "# Prefill\n\nBatches *wait*.")))))
        ]))
    try v.newBoard(in: "Book", title: "Decode")
    let fb = try v.newFolderBoard(in: "Book")
    return (v, fb.id)
  }

  /// Shows each board in turn, gives it frames to draw and measure, then writes every open board that changed: none
  /// may have
  func showEveryBoard(_ w: FullWindowEditTests.Window) async throws {
    let tree = try w.vault.tree()
    for b in tree.allBoards {
      w.shell.show(b.id)
      w.panes.sync()
      await env.until("\(b.title) shown", in: w) { w.shell.current?.board == b.id }
      await w.frames(12)
    }
    await w.frames(12)
    for (id, doc) in w.panes.documents {
      #expect(!doc.isDirty, "\(w.shell.board(id)?.title ?? id.rawValue) changed by being opened")
      doc.flush()
    }
  }

  /// A folder board brought up to its folder once, as the first opening does
  func inStep(_ v: Vault, _ fb: BoardID) async throws {
    let w = try await env.opened(v)
    w.shell.show(fb)
    w.panes.sync()
    await env.until("the folder board's cards", in: w) {
      w.panes.documents[fb]?.board.autoCards.count == 2
    }
    for doc in w.panes.documents.values { doc.flush() }
    w.close(keepingVault: true)
  }

  @Test func openingAVaultAndShowingEveryBoardWritesNoFile() async throws {
    let (v, fb) = try vault()
    defer { try? fm.removeItem(at: v.root) }
    try await inStep(v, fb)
    let before = files(v.root)
    #expect(before.count >= 5, "\(before.keys.sorted())")
    let w = try await env.opened(v)
    try await showEveryBoard(w)
    w.close(keepingVault: true)
    #expect(changed(before, files(v.root)) == [])
  }

  @Test func aStepOneBoardIsListedAndNeverWritten() async throws {
    let v = try env.vault()
    defer { try? fm.removeItem(at: v.root) }
    let old = v.root.appending(path: "Old.board")
    try fm.createDirectory(at: old, withIntermediateDirectories: true)
    try Data(
      #"{"version":1,"id":"old","cards":[{"id":"c","x":0,"y":0,"width":240,"content":{"note":{"text":"kept"}}}],"arrows":[],"sections":[],"hideComments":false}"#
        .utf8
    ).write(to: old.appending(path: Vault.boardFileName))
    let before = files(v.root)
    let w = try await env.opened(v)
    try await showEveryBoard(w)
    #expect(w.panes.documents[BoardID(rawValue: "old")]?.isDirty != true)
    w.close(keepingVault: true)
    #expect(changed(before, files(v.root)) == [])
  }

  /// The one write opening makes: a board put in a folder from outside the app gets its automatic card on the folder
  /// board when that opens, in that board's file only
  @Test func aFolderBoardBehindItsFolderIsTheOneFileOpeningWrites() async throws {
    let (v, fb) = try vault()
    defer { try? fm.removeItem(at: v.root) }
    try await inStep(v, fb)
    let added = try v.newBoard(in: "Book", title: "Sampling")
    let before = files(v.root)
    let w = try await env.opened(v)
    w.shell.show(fb)
    w.panes.sync()
    await env.until("its card for the new board", in: w) {
      w.panes.documents[fb]?.board.autoCards.contains { $0.target == .board(added.id) } == true
    }
    for doc in w.panes.documents.values { doc.flush() }
    w.close(keepingVault: true)
    let file = try #require(w.shell.board(fb)).path
    #expect(changed(before, files(v.root)) == ["/\(file)/\(Vault.boardFileName)"])
  }

  /// Resources in the vault and in a folder with a folder board: listed, and nothing written, the folder board taking no
  /// card for them (its cards are for boards and folders)
  @Test func aVaultWithResourcesOpensWithoutWritingAnything() async throws {
    let (v, fb) = try vault()
    defer { try? fm.removeItem(at: v.root) }
    for (path, id) in [("Papers.resource", "r1"), ("Book/Reading.resource", "r2")] {
      let pkg = v.url(of: path)
      try fm.createDirectory(at: pkg.appending(path: "Attention Is All You Need"), withIntermediateDirectories: true)
      try Data(#"{"fields": [], "id": "\#(id)", "preset": "papers", "version": 1}"#.utf8)
        .write(to: pkg.appending(path: Vault.resourceFileName))
      try Data("{}".utf8).write(to: pkg.appending(path: "Attention Is All You Need/\(Vault.entryFileName)"))
      try Data("%PDF".utf8).write(to: pkg.appending(path: "notes.pdf"))
    }
    try await inStep(v, fb)
    let before = files(v.root)
    let w = try await env.opened(v)
    #expect(w.shell.tree?.allFolders.flatMap(\.resources).map(\.entryCount) == [2, 2])
    try await showEveryBoard(w)
    w.close(keepingVault: true)
    #expect(changed(before, files(v.root)) == [])
  }
}

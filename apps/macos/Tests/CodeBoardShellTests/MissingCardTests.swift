import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// A folder board's automatic card whose board vanished outside the app (Finder, a git checkout, a sync) stays where it
// is with all on it, drawn as missing, and the folder board's file is not written for it; the same card shows the board
// again when it is back. Only the app's own Delete or move takes a card with nothing on it away.
@MainActor @Suite(.serialized) struct MissingCardTests {
  let fm = FileManager.default

  struct Rig {
    let vault: Vault
    let shell: Shell
    let panes: BoardPanes
    let fb: VaultBoard
    let a: VaultBoard
    let b: VaultBoard
    let doc: BoardDocument
    var file: URL { vault.url(of: fb.path).appending(path: Vault.boardFileName) }
  }

  /// A book: its folder board with an automatic card for each of A and B; on A's card an arrow from a Note, a sidenote and
  /// a sticker; B's bare
  func rig() async throws -> Rig {
    let root = fm.temporaryDirectory.appending(path: "missing-\(UUID().uuidString)")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    let v = Vault(root: root)
    try v.newFolder(in: "", name: "书")
    let a = try v.newBoard(in: "书", title: "Prefill 预填充")
    let b = try v.newBoard(in: "书", title: "Decode")
    let fb = try v.newFolderBoard(in: "书")
    let shell = Shell()
    shell.open(v, restoring: nil)
    shell.apply(.success(try v.tree()))
    shell.trasher = { url in
      let to = root.deletingLastPathComponent().appending(path: "trash-\(UUID().uuidString)")
      try FileManager.default.moveItem(at: url, to: to)
      return to
    }
    let panes = BoardPanes(shell: shell)
    panes.frame = CGRect(x: 0, y: 0, width: 1000, height: 700)
    shell.show(fb.id)
    panes.sync()
    let doc = try #require(panes.documents[fb.id])
    let card = try #require(doc.board.autoCards.first { $0.target == .board(a.id) }?.card.id)
    doc.edit("Attach") { board in
      board.cards.append(
        Card(
          id: CardID(rawValue: "mine"), x: -600, y: 0, width: 240,
          content: .own(CardContent(body: .note(Note(text: "mine"))))))
      board.arrows.append(
        Arrow(id: ArrowID(rawValue: "ar"), from: Endpoint(card: CardID(rawValue: "mine")), to: Endpoint(card: card)))
      board.sidenotes.append(
        Sidenote(id: SidenoteID(rawValue: "sn"), anchor: .card(card), body: .text(TextNote(text: "why"))))
      board.stickers.append(
        Sticker(id: StickerID(rawValue: "st"), glyph: .builtin(.star), anchor: .card(card, x: 10, y: 10, size: nil)))
    }
    panes.flush()
    return Rig(vault: v, shell: shell, panes: panes, fb: fb, a: a, b: b, doc: doc)
  }

  func until(_ what: String, _ f: () -> Bool) async {
    let deadline = ContinuousClock.now + .seconds(20)
    while !f() {
      if ContinuousClock.now > deadline {
        Issue.record("\(what): not within 20 s")
        return
      }
      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  /// The watcher's reload: the tree read again, the open boards take it in
  func reload(_ r: Rig) throws {
    r.shell.apply(.success(try r.vault.tree()))
    r.panes.sync(reload: true)
  }

  /// A package moved out of the vault and back, as a checkout does it
  func away(_ r: Rig, _ b: VaultBoard) throws -> () throws -> Void {
    let from = r.vault.url(of: b.path)
    let to = r.vault.root.deletingLastPathComponent().appending(path: "away-\(UUID().uuidString)")
    try fm.moveItem(at: from, to: to)
    return { try self.fm.moveItem(at: to, to: from) }
  }

  @Test func aBoardGoneOutsideTheAppLeavesItsCardAndAllOnItAndTheFileUntouchedAndComesBackToTheSameCard() async throws {
    let r = try await rig()
    defer { try? fm.removeItem(at: r.vault.root) }
    let bytes = try Data(contentsOf: r.file)
    let board = r.doc.board
    let back = try away(r, r.a)
    try reload(r)
    r.panes.flush()
    #expect(try Data(contentsOf: r.file) == bytes, "the folder board's file is not written")
    #expect(r.doc.board == board, "the card, its arrow, sidenote and sticker where they were")
    // drawn as missing: double-click does nothing
    let tab = try #require(r.shell.selected)
    let pane = try #require(r.panes.panes[tab])
    let card = try #require(board.autoCards.first { $0.target == .board(r.a.id) }?.card.id)
    await until("drawn missing") { pane.canvas.isGone(card) }
    var opened = false
    pane.canvas.onOpenBoard = { _, _ in opened = true }
    #expect(pane.canvas.openSubBoard(card) && !opened)
    // back: the same card shows it, no second one
    try back()
    try reload(r)
    r.panes.flush()
    #expect(try Data(contentsOf: r.file) == bytes)
    #expect(r.doc.board == board && r.doc.board.autoCards.count == 2)
    await until("drawn again") { !pane.canvas.isGone(card) }
  }

  @Test func boardsGoneAndBackInOneBurstWriteNothing() async throws {
    let r = try await rig()
    defer { try? fm.removeItem(at: r.vault.root) }
    let bytes = try Data(contentsOf: r.file)
    // a branch switch: both away, read, both back, read once more
    let backA = try away(r, r.a)
    let backB = try away(r, r.b)
    try reload(r)
    try backA()
    try backB()
    try reload(r)
    r.panes.flush()
    #expect(try Data(contentsOf: r.file) == bytes)
    #expect(r.doc.history.undoSteps.map(\.name) == ["Attach"])
  }

  @Test func deletedInTheAppACardWithNothingOnItGoesAndOneWithSomethingOnItStaysMissing() async throws {
    let r = try await rig()
    defer { try? fm.removeItem(at: r.vault.root) }
    #expect(r.shell.trash(r.b.path))
    #expect(r.doc.board.autoCards.map(\.target) == [.board(r.a.id)])
    #expect(try r.vault.board(at: r.fb.path).autoCards.count == 1, "written")
    #expect(r.shell.trash(r.a.path))
    #expect(r.doc.board.autoCards.map(\.target) == [.board(r.a.id)], "an arrow is on it")
    #expect(r.doc.board.arrows.count == 1 && r.doc.board.sidenotes.count == 1 && r.doc.board.stickers.count == 1)
  }

  @Test func aMissingCardIsDeletedAsAnyCardInOneUndoStep() async throws {
    let r = try await rig()
    defer { try? fm.removeItem(at: r.vault.root) }
    _ = try away(r, r.a)
    try reload(r)
    let tab = try #require(r.shell.selected)
    let pane = try #require(r.panes.panes[tab])
    let card = try #require(r.doc.board.autoCards.first { $0.target == .board(r.a.id) }?.card.id)
    let present = try #require(r.doc.board.autoCards.first { $0.target == .board(r.b.id) }?.card.id)
    await until("drawn missing") { pane.canvas.isGone(card) }
    let before = r.doc.board
    // a card whose board is there cannot be deleted on the board; the missing one can
    r.doc.select([.card(present)])
    pane.canvas.delete(nil)
    #expect(r.doc.board == before)
    r.doc.select([.card(card)])
    pane.canvas.delete(nil)
    #expect(r.doc.board.card(card) == nil && r.doc.board.arrows.isEmpty && r.doc.board.stickers.isEmpty)
    #expect(r.doc.board.sidenotes.isEmpty)
    #expect(r.doc.history.undoSteps.map(\.name) == ["Attach", "Delete"])
    r.doc.undo()
    #expect(r.doc.board == before)
  }
}

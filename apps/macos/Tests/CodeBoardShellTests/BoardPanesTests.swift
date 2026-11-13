import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardShell

// The open boards behind the tabs: one document per board, kept across tab switches, written when its tab closes, and
// taking in what changed on disk
@MainActor @Suite(.serialized) struct BoardPanesTests {
  @Test func aClosedTabsBoardIsWrittenAtOnceAndItsHistoryOutlivesTheTab() throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "panes-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: root) }
    let id = BoardID(rawValue: "b")
    let card = CardID(rawValue: "n")
    let board = Board(
      id: id,
      cards: [
        Card(id: card, x: 0, y: 0, width: 200, height: 100, content: .own(CardContent(body: .note(Note(text: "n")))))
      ])
    let package = root.appending(path: "B.board")
    try fm.createDirectory(at: package, withIntermediateDirectories: true)
    let file = package.appending(path: Vault.boardFileName)
    try board.encoded().write(to: file)

    let shell = Shell()
    let vault = Vault(root: root)
    shell.open(vault, restoring: nil)
    shell.apply(.success(try vault.tree()))
    let panes = BoardPanes(shell: shell)
    shell.show(id)
    panes.sync()
    let doc = try #require(panes.documents[id])
    doc.edit("Move") { $0.move([.card(card)], dx: 30, dy: 0) }
    #expect(try Board(decoding: Data(contentsOf: file), file: file).card(card)?.x == 0, "not before the pause")

    // closing the tab writes it now
    shell.close(try #require(shell.selected))
    panes.sync()
    #expect(try Board(decoding: Data(contentsOf: file), file: file).card(card)?.x == 30)

    // opened again: the same document, its undo still there
    shell.show(id)
    panes.sync()
    #expect(panes.documents[id] === doc && doc.undoName == "Move")

    // another writer moved it: the vault watcher's reload merges it in, no step
    var theirs = try Board(decoding: Data(contentsOf: file), file: file)
    theirs.move([.card(card)], dx: 0, dy: 50)
    try theirs.encoded().write(to: file)
    panes.sync(reload: true)
    #expect(doc.board.card(card)?.y == 50 && doc.history.undoSteps.count == 1)

    // quitting writes what is not saved yet
    doc.edit("Lock") { $0.setLocked([.card(card)], true) }
    panes.flush()
    #expect(try Board(decoding: Data(contentsOf: file), file: file).card(card)?.locked == true)
  }
}

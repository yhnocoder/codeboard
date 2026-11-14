import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas
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
    #expect(panes.flush().isEmpty)
    #expect(try Board(decoding: Data(contentsOf: file), file: file).card(card)?.locked == true)

    // a board that would not read back is not written, and flush names it (quitting asks first)
    doc.edit("Broken") {
      $0.arrows.append(
        Arrow(id: ArrowID(rawValue: "a"), from: Endpoint(card: card), to: Endpoint(card: CardID(rawValue: "gone"))))
    }
    #expect(panes.flush().map(\.title) == ["B"])
  }

  /// Until `f` holds, the main actor free meanwhile (boards load in tasks)
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

  @Test func aSubBoardCardOpensItsBoardInTheTabAndBackReturnsWhereTheViewWas() async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "panes-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: root) }
    let vault = Vault(root: root)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    let a = BoardID(rawValue: "a")
    let b = BoardID(rawValue: "b")
    let frame = CardID(rawValue: "f")
    try vault.newBoard(in: "", title: "里面 Inner", board: Board(id: b))
    try vault.newBoard(
      in: "", title: "Outer",
      board: Board(
        id: a,
        cards: [
          Card(id: frame, x: 0, y: 0, width: 400, content: .own(CardContent(body: .board(SubBoard(board: b))))),
          Card(
            id: CardID(rawValue: "n"), x: 2000, y: 900, width: 200, height: 100,
            content: .own(CardContent(body: .note(Note(text: "far"))))),
        ]))
    let shell = Shell()
    shell.open(vault, restoring: nil)
    shell.apply(.success(try vault.tree()))
    let panes = BoardPanes(shell: shell)
    panes.frame = CGRect(x: 0, y: 0, width: 1000, height: 700)
    shell.show(a)
    panes.sync()
    let tab = try #require(shell.selected)
    let pane = try #require(panes.panes[tab])
    pane.canvas.onOpenBoard = { id, _ in
      shell.show(id)
      panes.sync()
    }
    await until("Outer shown") { pane.canvas.scene != nil && pane.document?.id == a }
    pane.canvas.place(zoom: 0.62, centre: CGPoint(x: 333, y: 211))
    let was = pane.canvas.currentCamera
    // a double-click on the card: its board, in this tab
    #expect(pane.canvas.openSubBoard(frame))
    await until("Inner shown") { pane.document?.id == b && pane.canvas.shown?.board.id == b }
    #expect(shell.current?.board == b && shell.tabs.count == 1)
    #expect(shell.current?.back == [Tab.Visit(board: a, camera: was)])
    // back (⌘[): Outer again, where its view was
    shell.goBack()
    panes.sync()
    await until("Outer again") { pane.canvas.shown?.board.id == a }
    #expect(pane.canvas.currentCamera == was)
    #expect(shell.current?.forward.map(\.board) == [b])
  }

  @Test func anOpenFolderBoardKeepsACardForEachBoardAndSubfolderAndTheyCannotBeDeleted() async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "panes-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: root) }
    let vault = Vault(root: root)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    try vault.newFolder(in: "", name: "调度")
    let step = try vault.newBoard(in: "调度", title: "Step")
    let fb = try vault.newFolderBoard(in: "调度")
    let shell = Shell()
    shell.open(vault, restoring: nil)
    shell.apply(.success(try vault.tree()))
    let panes = BoardPanes(shell: shell)
    shell.show(fb.id)
    panes.sync()
    let doc = try #require(panes.documents[fb.id])
    #expect(doc.board.autoCards.map(\.target) == [.board(step.id)])
    #expect(doc.history.undoSteps.isEmpty, "no undo step")
    // a board and a subfolder come: their cards after the first; the user's own Note stays
    doc.edit("Add") {
      $0.cards.append(
        Card(
          id: CardID(rawValue: "mine"), x: -500, y: 0, width: 200,
          content: .own(CardContent(body: .note(Note(text: "mine"))))))
    }
    let more = try vault.newBoard(in: "调度", title: "Prefill")
    try vault.newFolder(in: "调度", name: "Kernels")
    shell.apply(.success(try vault.tree()))
    panes.sync(reload: true)
    #expect(Set(doc.board.autoCards.map(\.target)) == [.board(step.id), .board(more.id), .folder("Kernels")])
    #expect(doc.board.card(CardID(rawValue: "mine")) != nil)
    // deleting them on the board does nothing; the board moved out in the app: its card goes
    let auto = Set(doc.board.autoCards.map { Item.card($0.card.id) })
    doc.edit("Delete") { $0.delete(auto) }
    #expect(doc.board.autoCards.count == 3)
    #expect(shell.move(more.path, into: "") != nil, "moved away in the app")
    shell.apply(.success(try vault.tree()))
    panes.sync(reload: true)
    #expect(Set(doc.board.autoCards.map(\.target)) == [.board(step.id), .folder("Kernels")])
    // written to its file
    panes.flush()
    #expect(try vault.board(at: fb.path).autoCards.count == 2)
  }
}

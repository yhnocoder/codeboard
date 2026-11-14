import AppKit
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

  /// The bottom toolbar never covers the dock at the bottom right (main overlaps them from about 1000 pt): centred while
  /// there is room, else left of the dock, else over it
  @Test func theToolbarStaysClearOfTheDock() {
    let bar = CanvasToolbar()
    let view = bar.intrinsicContentSize
    let m = CanvasToolbar.margin
    let dock = CGSize(width: 185, height: 34)
    for width: CGFloat in [1400, 1000, 760, 600, 470, 420] {
      let pane = CGSize(width: width, height: 700)
      let d = CGRect(x: width - 12 - dock.width, y: 700 - 12 - dock.height, width: dock.width, height: dock.height)
      let f = Pane.toolbarFrame(view, in: pane, dock: d).insetBy(dx: m, dy: m)
      // y-up in the pane: the dock's rect turned
      let dockUp = CGRect(x: d.minX, y: pane.height - d.maxY, width: d.width, height: d.height)
      #expect(
        !f.insetBy(dx: -4, dy: -4).intersects(dockUp), "at \(width) pt the toolbar \(f) reaches the dock \(dockUp)")
      #expect(f.minX >= 12 && f.maxX <= width - 12, "at \(width) pt the toolbar leaves the pane")
      if width >= 1000 { #expect(abs(f.midX - width / 2) <= 1 && f.minY == 12, "centred and 12 up at \(width) pt") }
    }
  }

  /// Boards "A" and "B" in a new vault, both showing shared card "s" (a Note with an image from the shared images
  /// folder and a sidenote that travels with it)
  func sharedVault() throws -> (Vault, BoardID, BoardID) {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "panes-\(UUID().uuidString)")
    let vault = Vault(root: root)
    try fm.createDirectory(at: vault.sharedFolderURL, withIntermediateDirectories: true)
    let s = CardID(rawValue: "s")
    try SharedCard(
      id: s, content: CardContent(body: .note(Note(text: "before ![](images/p.png)"))),
      sidenotes: [Sidenote(id: SidenoteID(rawValue: "n1"), anchor: .card(s), body: .text(TextNote(text: "travels")))]
    ).encoded().write(to: vault.sharedFolderURL.appending(path: "s.json"))
    for name in ["A", "B"] {
      try vault.newBoard(
        in: "", title: name,
        board: Board(
          id: BoardID(rawValue: name.lowercased()),
          cards: [Card(id: s, x: 0, y: 0, width: 200, height: 120, content: .shared)]))
    }
    return (vault, BoardID(rawValue: "a"), BoardID(rawValue: "b"))
  }

  @Test func aSharedCardEditedOnOneBoardShowsOnTheOtherWithItsImagesAndTravellingSidenote() async throws {
    let (vault, a, b) = try sharedVault()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let s = CardID(rawValue: "s")
    let shell = Shell()
    shell.open(vault, restoring: nil)
    shell.apply(.success(try vault.tree()))
    let panes = BoardPanes(shell: shell)
    panes.frame = CGRect(x: 0, y: 0, width: 1000, height: 700)
    shell.show(a)
    panes.sync()
    let tab = try #require(shell.selected)
    let pane = try #require(panes.panes[tab])
    await until("A shown") { pane.canvas.scene != nil && pane.canvas.shown?.board.id == a }
    // written in on A, as the canvas writes a Note
    let doc = try #require(panes.documents[a])
    doc.edit("Write") { $0.write(s, text: "after ![](images/p.png)", layout: nil) }
    doc.flush()
    #expect(try vault.sharedCard(s).content.body == .note(Note(text: "after ![](images/p.png)")))
    // B shows it as A left it, its image from the shared folder, the sidenote that travels with it once
    shell.show(b)
    panes.sync(reload: true)
    await until("B shown") { pane.canvas.shown?.board.id == b && pane.canvas.scene != nil }
    let scene = try #require(pane.canvas.scene)
    #expect(scene.parts[s]?.content.body == .note(Note(text: "after ![](images/p.png)")))
    let item = try #require(scene.items.first { $0.owner == .card(s) })
    guard case .note(let n) = item.drawing else {
      Issue.record("not drawn as a Note")
      return
    }
    #expect(n.folder == vault.sharedFolderURL)
    #expect(scene.notes.map(\.id.rawValue) == ["n1"])
  }

  @Test func aBoardOpensWhereItWasLeftAndAtTheCameraItsImportBrought() async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "panes-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: root) }
    let vault = Vault(root: root)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    let a = BoardID(rawValue: "a")
    let b = BoardID(rawValue: "b")
    let far = Card(
      id: CardID(rawValue: "n"), x: 2000, y: 900, width: 200, height: 100,
      content: .own(CardContent(body: .note(Note(text: "far")))))
    try vault.newBoard(in: "", title: "A", board: Board(id: a, cards: [far]))
    try vault.newBoard(in: "", title: "B", board: Board(id: b, cards: [far]))
    // this machine's own state, never the vault: B was looked at in VS Code, its import kept where
    let store = CameraStore(folder: fm.temporaryDirectory.appending(path: "cameras-\(UUID().uuidString)"))
    defer { try? fm.removeItem(at: store.folder) }
    try store.keep([b: BoardCamera(x: 1900, y: 850, zoom: 1.5)], for: vault)
    func open() -> (Shell, BoardPanes) {
      let shell = Shell()
      shell.open(vault, restoring: nil)
      shell.apply(.success(try! vault.tree()))
      let panes = BoardPanes(shell: shell)
      panes.cameras = store
      panes.frame = CGRect(x: 0, y: 0, width: 1000, height: 700)
      return (shell, panes)
    }
    let (shell, panes) = open()
    shell.show(b)
    panes.sync()
    let tab = try #require(shell.selected)
    let pane = try #require(panes.panes[tab])
    await until("B shown") { pane.canvas.scene != nil && pane.canvas.shown?.board.id == b }
    #expect(pane.canvas.currentCamera == Camera(origin: CGPoint(x: 1900, y: 850), zoom: 1.5))
    // A moved to and left at rest; B, then A again from the sidebar: where it was
    shell.show(a)
    panes.sync()
    await until("A shown") { pane.canvas.shown?.board.id == a && pane.canvas.scene != nil }
    pane.canvas.place(zoom: 0.62, centre: CGPoint(x: 333, y: 211))
    let was = pane.canvas.currentCamera
    shell.show(b)
    panes.sync()
    await until("B again") { pane.canvas.shown?.board.id == b }
    shell.show(a)
    panes.sync()
    await until("A again") { pane.canvas.shown?.board.id == a && pane.canvas.scene != nil }
    #expect(pane.canvas.currentCamera == was)
    // and after a relaunch
    await panes.close()
    let (shell2, panes2) = open()
    shell2.show(a)
    panes2.sync()
    let tab2 = try #require(shell2.selected)
    let pane2 = try #require(panes2.panes[tab2])
    await until("A after a relaunch") { pane2.canvas.scene != nil && pane2.canvas.shown?.board.id == a }
    #expect(pane2.canvas.currentCamera == was)
    #expect(try fm.subpathsOfDirectory(atPath: root.path).allSatisfy { !$0.contains("camera") }, "not in the vault")
  }

  /// main's paste onto another board: the cards copied are made shared cards on their board and pasted as the same
  /// cards; pasted again, they are there already; ⌥⌘V brings a copy of its own
  @Test func cardsCopiedOnAnotherBoardArePastedAsTheSameCards() async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "panes-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: root) }
    let vault = Vault(root: root)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    let a = BoardID(rawValue: "a")
    let b = BoardID(rawValue: "b")
    let c = CardID(rawValue: "c")
    try vault.newBoard(
      in: "", title: "Alpha",
      board: Board(
        id: a,
        cards: [
          Card(id: c, x: 0, y: 0, width: 200, height: 100, content: .own(CardContent(body: .note(Note(text: "c")))))
        ]))
    try vault.newBoard(in: "", title: "Beta", board: Board(id: b))
    let shell = Shell()
    shell.open(vault, restoring: nil)
    shell.apply(.success(try vault.tree()))
    let panes = BoardPanes(shell: shell)
    panes.frame = CGRect(x: 0, y: 0, width: 1000, height: 700)
    shell.show(a)
    panes.sync()
    let tab = try #require(shell.selected)
    let pane = try #require(panes.panes[tab])
    let clipboard = NSPasteboard(name: NSPasteboard.Name("codeboard-tests-\(UUID().uuidString)"))
    defer { clipboard.releaseGlobally() }
    pane.canvas.pasteboard = clipboard
    await until("Alpha shown") { pane.canvas.scene != nil && pane.canvas.shown?.board.id == a }
    let docA = try #require(panes.documents[a])
    docA.select([.card(c)])
    pane.canvas.copy(nil)
    shell.show(b)
    panes.sync()
    await until("Beta shown") { pane.canvas.shown?.board.id == b && pane.canvas.scene != nil }
    pane.canvas.paste(nil)
    let docB = try #require(panes.documents[b])
    #expect(docB.board.cards.map(\.id) == [c] && docB.board.card(c)?.isShared == true)
    #expect(docA.board.card(c)?.isShared == true && vault.sharedCardExists(c), "shared on Alpha first, written")
    #expect(pane.canvas.toastText == "Pasted as linked card · also on Alpha")
    // pasted again: already here
    docB.select([])
    pane.canvas.paste(nil)
    #expect(docB.board.cards.count == 1 && docB.selection == [.card(c)])
    #expect(pane.canvas.toastText == "Already on this board")
    // ⌥⌘V: a copy of its own
    pane.canvas.pasteAsCopy(nil)
    #expect(docB.board.cards.count == 2 && docB.board.cards[1].id != c && !docB.board.cards[1].isShared)
    #expect(pane.canvas.toastText == "Pasted a copy from Alpha")
  }
}

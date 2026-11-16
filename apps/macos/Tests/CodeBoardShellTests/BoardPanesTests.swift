import AppKit
import CodeBoardModel
import CodeBoardResources
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
    // the window's tracking of the shell, which syncs the panes
    pane.canvas.onEnterBoard = { e in
      shell.enter(e.board, from: e.frame, camera: e.camera)
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
    #expect(shell.current?.crumbs == [Tab.Crumb(board: a, frame: frame, camera: was)])
    #expect(pane.canvas.crumbs.map(\.board) == [a])
    // back (⌘[): Outer again, where its view was
    shell.goBack()
    panes.sync()
    await until("Outer again") { pane.canvas.shown?.board.id == a }
    #expect(pane.canvas.currentCamera == was)
    #expect(shell.current?.forward.map(\.board) == [b])
  }

  /// What the reading pane collects (`shell.collect`) is a Note with its source on the selected tab's board, not on
  /// another tab's; every canvas's feet are what `shell.sources` says of the entry
  @Test func aCollectedPassageIsANoteOnTheSelectedTabsBoardWithItsSourceFromTheShell() async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "panes-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: root) }
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    let a = BoardID(rawValue: "a")
    let b = BoardID(rawValue: "b")
    try vault.newBoard(in: "", title: "A", board: Board(id: a))
    try vault.newBoard(in: "", title: "B", board: Board(id: b))
    let papers = try vault.newResource(in: "", title: "Papers", preset: .papers)
    let v1 = VersionID(rawValue: "v1")
    try vault.newEntry(
      Entry(
        id: EntryID(rawValue: "e1"), title: "Field notes", added: 0,
        versions: [Version(id: v1, added: 0, content: .pdf(file: "paper.pdf"))]),
      in: papers.path)
    let shell = Shell()
    shell.open(vault, restoring: nil)
    shell.apply(.success(try vault.tree()))
    let panes = BoardPanes(shell: shell)
    panes.frame = CGRect(x: 0, y: 0, width: 1000, height: 700)
    shell.show(a)
    let tabA = try #require(shell.selected)
    shell.show(b, newTab: true)
    shell.select(tabA)
    panes.sync()
    let pa = try #require(panes.panes[tabA])
    let pb = try #require(shell.tabs.first { $0.id != tabA }.flatMap { panes.panes[$0.id] })
    await until("both shown") { pa.canvas.scene != nil && pb.canvas.scene != nil }
    #expect(pa.canvas.sources === shell.sources && pb.canvas.sources === shell.sources)

    let source = SourceAnchor(entry: EntryID(rawValue: "e1"), place: Place(version: v1, block: .page(3)))
    shell.collect(Collected(body: .note(markdown: "The river runs north."), source: source, title: "", label: ""))
    let card = try #require(panes.documents[a]?.board.cards.first)
    #expect(panes.documents[b]?.board.cards.isEmpty == true, "not on the other tab's board")
    guard case .own(let k) = card.content, case .note(let n) = k.body else {
      Issue.record("not a Note")
      return
    }
    #expect(n.text == "The river runs north." && k.source == source)
    await until("its foot") { pa.canvas.index(of: .card(card.id)) != nil }
    let foot = pa.canvas.index(of: .card(card.id)).flatMap { pa.canvas.scene?.items[$0].drawing.foot }
    #expect(foot?.title == "Field notes" && foot?.number == "p. 3" && foot?.icon == .paper && foot?.missing == false)
  }

  /// A [[ref]] to a card in a sub-board, all the way down: the sub-boards are entered in this tab, each on the way a
  /// crumb, and the card is selected there (actions/subboards.ts openCardRef, enterFrame with reveal; host handlers.ts
  /// enterBoard, core subboard.ts cardPath)
  @Test func aRefToACardDownInSubBoardsEntersThemWithTheirCrumbsAndSelectsIt() async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "panes-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: root) }
    let vault = Vault(root: root)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    let a = BoardID(rawValue: "a")
    let b = BoardID(rawValue: "b")
    let c = BoardID(rawValue: "c")
    let f = CardID(rawValue: "f")
    let g = CardID(rawValue: "g")
    let deep = CardID(rawValue: "deep")
    func sub(_ id: CardID, _ to: BoardID) -> Card {
      Card(id: id, x: 0, y: 0, width: 400, content: .own(CardContent(body: .board(SubBoard(board: to)))))
    }
    try vault.newBoard(
      in: "", title: "Inner",
      board: Board(
        id: c,
        cards: [
          Card(
            id: deep, x: 1500, y: 900, width: 200, height: 100,
            content: .own(CardContent(body: .note(Note(text: "# Deep")))))
        ]))
    try vault.newBoard(in: "", title: "Mid", board: Board(id: b, cards: [sub(g, c)]))
    try vault.newBoard(in: "", title: "Outer", board: Board(id: a, cards: [sub(f, b)]))
    let shell = Shell()
    shell.open(vault, restoring: nil)
    shell.apply(.success(try vault.tree()))
    let panes = BoardPanes(shell: shell)
    panes.frame = CGRect(x: 0, y: 0, width: 1000, height: 700)
    shell.show(a)
    panes.sync()
    let tab = try #require(shell.selected)
    let pane = try #require(panes.panes[tab])
    await until("Outer shown") { pane.canvas.scene != nil && pane.document?.id == a }
    let was = pane.canvas.currentCamera
    pane.canvas.goToRef(.elsewhere(c, deep), writing: false)
    // the window's tracking of the shell syncs the panes
    await until("Inner shown") {
      panes.sync()
      return pane.canvas.shown?.board.id == c && pane.canvas.scene != nil
    }
    #expect(shell.current?.board == c && shell.tabs.count == 1)
    #expect(
      shell.current?.crumbs == [Tab.Crumb(board: a, frame: f, camera: was), Tab.Crumb(board: b, frame: g, camera: nil)])
    #expect(pane.canvas.crumbs.map(\.board) == [a, b])
    await until("the card selected") { pane.document?.selection == [.card(deep)] }
    // its crumb goes back to Mid
    shell.leave()
    await until("Mid shown") {
      panes.sync()
      return pane.canvas.shown?.board.id == b
    }
    #expect(shell.current?.crumbs == [Tab.Crumb(board: a, frame: f, camera: was)])
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

  /// A board opened in a new tab (a relaunch, another window) shows the picture kept of it when it was left from the
  /// tab's first frame: put up as the tab loads it, before any of its work, and the tab shown at once with it
  @Test func aBoardOpenedInANewTabShowsItsPictureFromItsFirstFrame() async throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "panes-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: root) }
    let vault = Vault(root: root)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    let a = BoardID(rawValue: "a")
    let note = Card(
      id: CardID(rawValue: "n"), x: 100, y: 100, width: 200, height: 100,
      content: .own(CardContent(body: .note(Note(text: "kept")))))
    try vault.newBoard(in: "", title: "A", board: Board(id: a, cards: [note]))
    let store = CameraStore(folder: root.appending(path: "cameras"))
    let pictures = root.appending(path: "pictures")
    func open() -> (Shell, BoardPanes) {
      let shell = Shell()
      shell.open(vault, restoring: nil)
      shell.apply(.success(try! vault.tree()))
      let panes = BoardPanes(shell: shell)
      panes.cameras = store
      panes.pictures = pictures
      panes.frame = CGRect(x: 0, y: 0, width: 1000, height: 700)
      return (shell, panes)
    }
    let (shell, panes) = open()
    shell.show(a)
    panes.sync()
    let pane = try #require(shell.selected.flatMap { panes.panes[$0] })
    await until("A shown") { pane.canvas.scene != nil && pane.canvas.isSettled }
    await panes.close()
    CanvasView.pictureWrites.sync {}
    #expect(try fm.contentsOfDirectory(atPath: pictures.path(percentEncoded: false)).count == 1, "kept as it was left")
    let (shell2, panes2) = open()
    shell2.show(a)
    panes2.sync()
    let pane2 = try #require(shell2.selected.flatMap { panes2.panes[$0] })
    // nothing awaited yet: the tab has its picture up and shows
    #expect(pane2.canvas.pictureShown && pane2.ready && !pane2.isHidden)
    // (out of a window no frame ticks, which is when the picture goes once the board is drawn: CanvasPictureTests)
    await until("A loaded under it") { pane2.canvas.scene != nil }
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

  /// A sub-board card's Delete Board… asks first as main does (host handlers.ts deleteBoardAsked): only Delete sends
  /// the board to the trash, as the sidebar's Delete does
  @Test func deleteBoardAsksAsMainDoesThenTrashesTheBoard() async throws {
    let fm = FileManager.default
    let base = fm.temporaryDirectory.appending(path: "delete-board-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: base) }
    let root = base.appending(path: "vault")
    let trash = base.appending(path: "Trash")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    try fm.createDirectory(at: trash, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    let parent = try vault.newBoard(in: "", title: "Parent")
    let child = try vault.newBoard(in: "", title: "Child")
    func write(_ vb: VaultBoard, _ cards: [Card]) throws {
      let file = vault.url(of: vb.path).appending(path: Vault.boardFileName)
      var b = try vault.board(at: vb.path)
      b.cards = cards
      try b.encoded().write(to: file)
    }
    let note = { (id: String) in
      Card(id: CardID(rawValue: id), x: 0, y: 0, width: 200, content: .own(CardContent(body: .note(Note(text: id)))))
    }
    try write(child, [note("a"), note("b")])
    try write(
      parent,
      [
        Card(
          id: CardID(rawValue: "sub"), x: 0, y: 0, width: 300, height: 200,
          content: .own(CardContent(body: .board(SubBoard(board: child.id)))))
      ])
    let shell = Shell()
    shell.open(vault, restoring: nil)
    shell.apply(.success(try vault.tree()))
    shell.trasher = { url in
      let to = trash.appending(path: url.lastPathComponent)
      try FileManager.default.moveItem(at: url, to: to)
      return to
    }
    let panes = BoardPanes(shell: shell)
    shell.show(parent.id)
    panes.sync()
    let canvas = try #require(panes.panes.values.first?.canvas)
    var asked: [[String]] = []
    // what the sheet's next press is: read when it is shown, changed between the two
    let answer = Answer()
    panes.confirm = { alert, _ in
      asked.append([alert.messageText, alert.informativeText] + alert.buttons.map(\.title))
      return answer.yes
    }
    let ask = try #require(canvas.onDeleteBoard)
    #expect(await ask(child.id) == false)
    #expect(
      asked == [
        [
          "Delete board “Child”?", "2 cards and their links will be removed. Your code is not affected.", "Delete",
          "Cancel",
        ]
      ])
    #expect(fm.fileExists(atPath: vault.url(of: child.path).path), "Cancel: the board stays")
    answer.yes = true
    #expect(await ask(child.id) == true)
    #expect(
      !fm.fileExists(atPath: vault.url(of: child.path).path) && fm.fileExists(atPath: trash.path + "/Child.board"))
  }
}

/// The questions before what undo does not bring back (Delete Board…, the sidebar's Delete Folder): the button that goes
/// ahead marked as destroying and keyless, Cancel Esc's, no default button for Return
@MainActor @Test(arguments: ["board", "folder"]) func aQuestionBeforeDeletingTakesAPressToGoAhead(_ what: String) {
  _ = NSApplication.shared
  let a =
    what == "board" ? BoardPanes.deleteQuestion("Child", cards: 2) : BoardPanes.deleteFolderQuestion("F", boards: 2)
  a.layout()
  #expect(a.buttons.map(\.title) == [what == "board" ? "Delete" : "Delete Folder", "Cancel"])
  #expect(a.buttons[0].hasDestructiveAction && a.buttons[0].keyEquivalent.isEmpty)
  #expect(a.buttons[1].keyEquivalent == "\u{1b}")
  #expect(a.window.defaultButtonCell == nil)
}

@MainActor final class Answer {
  var yes = false
}

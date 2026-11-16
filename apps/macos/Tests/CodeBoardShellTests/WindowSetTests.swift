import AppKit
import CodeBoardModel
import CodeBoardReading
import CodeBoardResources
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardShell

// The app's windows over one session and one table of open boards: each window its own tabs, selection and camera,
// what is the app's (a fresh tree, writing every board) done once for all of them
@MainActor @Suite(.serialized) struct WindowSetTests {
  let a = BoardID(rawValue: "a")
  let b = BoardID(rawValue: "b")
  let n = CardID(rawValue: "n")
  let m = CardID(rawValue: "m")
  let k = CardID(rawValue: "k")

  /// A vault of boards A (two notes) and B, the first window on A and a second from New Window, never on screen
  func twoWindows() throws -> (WindowSet, WindowSet.Entry, WindowSet.Entry, Vault) {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appending(path: "windows-\(UUID().uuidString)")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    func note(_ id: CardID, x: Double) -> Card {
      Card(id: id, x: x, y: 0, width: 200, height: 100, content: .own(CardContent(body: .note(Note(text: "n")))))
    }
    try vault.newBoard(in: "", title: "A", board: Board(id: a, cards: [note(n, x: 0), note(m, x: 300)]))
    try vault.newBoard(in: "", title: "B", board: Board(id: b, cards: [note(k, x: 0)]))
    let set = WindowSet()
    set.present = { _ in }
    let s = Shell(session: set.session)
    s.open(vault, restoring: nil)
    s.apply(.success(try vault.tree()))
    s.show(a)
    let first = set.add(s)
    first.window.setFrameAutosaveName("")
    first.panes.sync()
    let second = try #require(set.open())
    return (set, first, second, vault)
  }

  func canvas(_ e: WindowSet.Entry) -> CanvasView? { e.shell.selected.flatMap { e.panes.panes[$0]?.canvas } }

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

  @Test func aNewWindowShowsTheMainWindowsBoardOnItsDocumentWithASelectionAndCameraOfItsOwn() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    #expect(second.shell.session === first.shell.session && second.shell.tabs.map(\.board) == [a])
    #expect(second.shell.tabs.map(\.id) != first.shell.tabs.map(\.id), "a tab of its own")
    let c1 = try #require(canvas(first))
    let c2 = try #require(canvas(second))
    await until("shown in both") { c1.scene != nil && c2.scene != nil }
    let doc = try #require(set.documents.open[a])
    let s1 = try #require(c1.document)
    let s2 = try #require(c2.document)
    #expect(s1 !== s2 && s1.document === doc && s2.document === doc)
    s1.select([.card(n)])
    s2.select([.card(m)])
    #expect(s1.selection == [.card(n)] && s2.selection == [.card(m)])
    let was = c1.camera
    c2.camera = Camera(origin: CGPoint(x: 400, y: 120), zoom: 2)
    #expect(c1.camera == was)
    // an edit in one is the other's board too
    s2.edit("Move") { $0.move([.card(n)], dx: 50, dy: 0) }
    #expect(s1.board.card(n)?.x == 50 && s1.selection == [.card(n)])
    // menu actions, and the driver's shell(of:), go to the window asked about
    #expect(set.entry(of: second.window) === second && set.entry(of: first.window) === first)
  }

  @Test func closingOneWindowLeavesItsBoardsAndKeepsTheDocumentForTheOther() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let c1 = try #require(canvas(first))
    let c2 = try #require(canvas(second))
    await until("shown in both") { c1.scene != nil && c2.scene != nil }
    let doc = try #require(set.documents.open[a])
    c2.document?.edit("Move") { $0.move([.card(m)], dx: 10, dy: 0) }
    second.window.close()
    #expect(set.all.map(\.window) == [first.window])
    #expect(second.panes.panes.isEmpty && c2.document == nil, "its canvas left its seat")
    #expect(set.documents.open[a] === doc && c1.document?.document === doc)
    let file = vault.url(of: try #require(set.session.board(a)).path).appending(path: Vault.boardFileName)
    #expect(try Board(decoding: Data(contentsOf: file), file: file).card(m)?.x == 310, "written as it closed")
  }

  @Test func aFreshTreeReachesEveryWindowAndQuittingWritesEachBoardOnce() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    second.shell.show(b, newTab: true)
    set.sync()
    #expect(second.panes.panes.count == 2)
    // B goes on disk; the tree read once, through the first window's shell: the second's tab on it closes too
    try FileManager.default.removeItem(at: vault.url(of: try #require(set.session.board(b)).path))
    first.shell.apply(.success(try vault.tree()))
    set.sync(reload: true)
    #expect(second.shell.tabs.map(\.board) == [a] && second.panes.panes.count == 1)

    // a board that would not read back, open in both windows: named once
    let doc = try #require(set.documents.open[a])
    doc.edit("Broken") {
      $0.arrows.append(
        Arrow(id: ArrowID(rawValue: "x"), from: Endpoint(card: n), to: Endpoint(card: CardID(rawValue: "gone"))))
    }
    #expect(set.flush().map(\.title) == ["A"])
  }

  @Test func eachWindowIsSavedAndWhatOneWindowSavedBeforeIsReadAsOne() throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let name = "WindowSetTests-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: name))
    defer { defaults.removePersistentDomain(forName: name) }
    let old = try #require(first.shell.state)
    defaults.set(try JSONEncoder().encode(old), forKey: WindowSet.oldStateKey)
    #expect(WindowSet.saved(in: defaults) == [SavedWindow(shell: old)])

    second.window.setFrame(CGRect(x: 200, y: 150, width: 900, height: 600), display: false)
    set.save(in: defaults)
    let saved = WindowSet.saved(in: defaults)
    #expect(saved.map(\.shell) == [old, try #require(second.shell.state)])
    #expect(saved[1].frame == CGRect(x: 200, y: 150, width: 900, height: 600))

    // the second closed and opened again from what was saved: its tabs as they were
    second.window.close()
    let again = try #require(set.open(saved[1]))
    #expect(again.shell.tabs == second.shell.tabs && again.shell.selected == second.shell.selected)
    // the last window closed saves nothing over what it saved
    for e in set.all { e.window.close() }
    set.save(in: defaults)
    #expect(WindowSet.saved(in: defaults).count == 2)
  }

  // MARK: Where things open

  /// The first window on A, the second on B, both drawn; every window counted on screen
  func onAAndB() async throws -> (WindowSet, WindowSet.Entry, WindowSet.Entry, Vault) {
    let (set, first, second, vault) = try twoWindows()
    set.onScreen = { _ in true }
    second.shell.show(b)
    set.sync()
    await until("A and B shown") {
      canvas(first)?.document?.id == a && canvas(second)?.document?.id == b && canvas(first)?.scene != nil
        && canvas(second)?.scene != nil
    }
    return (set, first, second, vault)
  }

  @Test func aReferenceToACardOnABoardAnotherWindowShowsGoesThereAndThisWindowsTabStays() async throws {
    let (set, first, second, vault) = try await onAAndB()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let c1 = try #require(canvas(first))
    let c2 = try #require(canvas(second))
    let tabs = first.shell.tabs
    c1.goToRef(.elsewhere(b, k), writing: false)
    #expect(first.shell.tabs == tabs && c1.document?.id == a)
    #expect(c2.document?.selection == [.card(k)] && second.shell.current?.board == b)

    // no window shows B on screen: this tab goes to B, as with one window
    c2.document?.select([])
    set.onScreen = { _ in false }
    c1.goToRef(.elsewhere(b, k), writing: false)
    #expect(first.shell.current?.board == b && first.shell.tabs.map(\.id) == tabs.map(\.id))
    #expect(c2.document?.selection.isEmpty == true)
  }

  @Test func addToBoardGoesToThisWindowsBoardElseToTheLatestWindowShowingOne() async throws {
    let (set, first, _, vault) = try await onAAndB()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let docA = try #require(set.documents.open[a])
    let docB = try #require(set.documents.open[b])
    func passage(_ text: String) -> Collected {
      Collected(body: .note(markdown: text), source: nil, title: "Field notes", label: "p. 1")
    }
    // this window's board
    first.shell.collect(passage("Here"))
    #expect(docA.board.cards.count == 3 && docB.board.cards.count == 1)
    // no board tab here: the board of the window that shows one
    first.shell.close(try #require(first.shell.selected))
    set.sync()
    first.shell.collect(passage("There"))
    #expect(docA.board.cards.count == 3 && docB.board.cards.count == 2)
    // and none on screen: nowhere
    set.onScreen = { _ in false }
    first.shell.collect(passage("Nowhere"))
    #expect(docA.board.cards.count == 3 && docB.board.cards.count == 2)
  }

  @Test func aWebCardsPageAndACardsSourceOpenInAnotherWindowAreGoneToThere() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    set.onScreen = { _ in true }
    // a Web card's page open in the second window's reading pane: selected there, nothing opened here
    let url = try #require(URL(string: "http://127.0.0.1:9/harbour"))
    second.shell.openWeb(url)
    let page = try #require(second.shell.reading.selected)
    second.shell.openWeb(nil)
    first.panes.openWeb(url)
    #expect(first.shell.reading.tabs.isEmpty && second.shell.reading.selected == page)

    // a PDF entry's passage, open in the second window: there, the first's pane opens nothing
    let resource = try vault.newResource(in: "", title: "Papers", preset: .papers)
    let file = "\(resource.path)/Field notes.pdf"
    try onePagePDF().write(to: vault.url(of: file))
    let e = Entry(
      id: EntryID(rawValue: "e1"), title: "Field notes", added: 0,
      versions: [Version(id: VersionID(rawValue: "v1"), added: 0, content: .pdf(file: "file.pdf"))])
    _ = try vault.promote(file: file, to: e, as: "file.pdf")
    first.shell.apply(.success(try vault.tree()))
    let anchor = SourceAnchor(entry: e.id, place: Place(version: e.versions[0].id, block: .page(1)))
    second.shell.sources.reveal(anchor)
    let pdf = try #require(second.shell.reading.selected)
    #expect(second.shell.reading.tabs.count == 3)
    second.shell.openWeb(nil)
    first.shell.sources.reveal(anchor)
    #expect(first.shell.reading.tabs.isEmpty && second.shell.reading.selected == pdf)
    #expect(second.shell.reading.tabs.count == 4)

    // the second window off screen: both open in this window's own pane
    set.onScreen = { _ in false }
    first.shell.sources.reveal(anchor)
    first.panes.openWeb(url)
    #expect(first.shell.reading.tabs.map(\.kind) == ["pdf", "web"])
  }

  func onePagePDF() -> Data {
    let data = NSMutableData()
    var box = CGRect(x: 0, y: 0, width: 300, height: 400)
    let ctx = CGContext(consumer: CGDataConsumer(data: data as CFMutableData)!, mediaBox: &box, nil)!
    ctx.beginPDFPage(nil)
    ctx.endPDFPage()
    ctx.closePDF()
    return data as Data
  }

  // MARK: Board tabs between windows

  /// The first window with a second tab, entered from A into B (its crumbs and history), drawn, a card selected there
  /// and its camera moved; every window counted on screen
  func withTabOnB(_ set: WindowSet, _ first: WindowSet.Entry) async throws -> (Tab, CanvasView) {
    set.onScreen = { _ in true }
    set.focus = { _ in }
    set.tabDrag.showPicture = { _ in }
    first.shell.show(a, newTab: true)
    first.shell.enter(b, from: CardID(rawValue: "f"), camera: nil)
    set.sync()
    let tab = try #require(first.shell.current)
    let c = try #require(canvas(first))
    await until("B drawn") { c.document?.id == b && c.scene != nil }
    c.document?.select([.card(k)])
    c.camera = Camera(origin: CGPoint(x: 40, y: 30), zoom: 1.5)
    return (tab, c)
  }

  @Test func aBoardTabMovedToAnotherWindowArrivesWholeWithItsOwnPaneAndTheLastOneLeavingClosesItsWindow() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let (tab, c) = try await withTabOnB(set, first)
    let pane = try #require(first.panes.panes[tab.id])
    let doc = try #require(set.documents.open[b])
    let stay = first.shell.tabs[0].id
    #expect(tab.crumbs.map(\.board) == [a] && tab.back.map(\.board) == [a])

    await set.move(tab.id, from: first, to: second, at: 0)
    #expect(second.shell.tabs.first == tab && second.shell.selected == tab.id, "its board, history and crumbs")
    #expect(second.panes.panes[tab.id] === pane && pane.canvas === c && pane.superview === second.panes)
    #expect(c.document?.document === doc && set.documents.open[b] === doc)
    #expect(c.document?.selection == [.card(k)] && c.camera == Camera(origin: CGPoint(x: 40, y: 30), zoom: 1.5))
    #expect(first.shell.tabs.map(\.id) == [stay] && first.shell.selected == stay && first.panes.panes[tab.id] == nil)
    #expect(second.panes.shownCanvas === c)

    // its last board tab gone and no reading tab: the window closes
    await set.move(stay, from: first, to: second, at: 9)
    #expect(set.all.map(\.window) == [second.window] && second.shell.tabs.last?.id == stay)
  }

  @Test func aTabMovedToANewWindowKeepsItsPaneAndAWindowWithReadingTabsStays() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let (tab, c) = try await withTabOnB(set, first)
    let frame = CGRect(x: 300, y: 200, width: 900, height: 640)
    let made = try #require(await set.moveToNewWindow(tab.id, from: first, frame: frame))
    #expect(set.all.count == 3 && made.window.frame == frame && made.shell.tabs == [tab])
    #expect(made.panes.panes[tab.id]?.canvas === c && c.document?.selection == [.card(k)])
    #expect(made.shell.reading.tabs.isEmpty && made.shell.sidebarShown == first.shell.sidebarShown)
    // a window's only tab stays where it is
    #expect(await set.moveToNewWindow(tab.id, from: made, frame: frame) == nil && set.all.count == 3)

    // the second window's only board tab moved away, its reading pane holding a tab: it stays, with no board tab
    second.shell.openWeb(nil)
    let only = try #require(second.shell.selected)
    await set.move(only, from: second, to: made, at: 1)
    #expect(set.all.count == 3 && second.shell.tabs.isEmpty && made.shell.tabs.map(\.id) == [tab.id, only])

    // quitting right after: each window as it is now
    let name = "WindowSetTests-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: name))
    defer { defaults.removePersistentDomain(forName: name) }
    set.save(in: defaults)
    #expect(WindowSet.saved(in: defaults).map(\.shell.tabs.count) == [1, 0, 2])
  }

  @Test func whatIsBeingWrittenInAMovedTabIsKeptAsOneStep() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let (tab, c) = try await withTabOnB(set, first)
    c.beginEditing(k)
    await until("the editor ready") { c.editing?.ready == true }
    c.editing?.writer?.insertText("More ", replacementRange: NSRange(location: NSNotFound, length: 0))
    await set.move(tab.id, from: first, to: second, at: 0)
    let doc = try #require(set.documents.open[b])
    #expect(!c.isEditing && doc.undoName == "Edit Note" && doc.board.card(k)?.writing?.contains("More") == true)
  }

  @Test func aTabDraggedPastItsRowOntoAnotherWindowsRowMovesThereAndEscPutsItBack() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let (tab, _) = try await withTabOnB(set, first)
    first.window.setFrame(CGRect(x: 100, y: 100, width: 1000, height: 700), display: false)
    second.window.setFrame(CGRect(x: 1200, y: 100, width: 1000, height: 700), display: false)
    for e in [first, second] { e.window.contentView?.layoutSubtreeIfNeeded() }
    let row1 = try #require(set.tabRow(of: first))
    let row2 = try #require(set.tabRow(of: second))
    let drag = set.tabDrag!
    let grab = CGPoint(x: 10, y: 6)
    let atTab = CGPoint(x: row1.minX + ShellTheme.stripPadding + TabItem.width(of: "A") + 12, y: row1.midY)

    // along the row, and a little below it: still the row's to reorder
    #expect(!drag.dragged(tab.id, title: "B", at: atTab, grab: grab))
    #expect(!drag.dragged(tab.id, title: "B", at: CGPoint(x: atTab.x + 30, y: row1.minY - 8), grab: grab))
    // past the threshold: out of the row; over the other row, the place it would go is marked there
    #expect(drag.dragged(tab.id, title: "B", at: CGPoint(x: atTab.x, y: row1.minY - 60), grab: grab))
    let over = CGPoint(x: row2.minX + ShellTheme.stripPadding + 2, y: row2.midY)
    #expect(drag.dragged(tab.id, title: "B", at: over, grab: grab) && second.shell.tabDrop == 0)
    // Esc: back where it was, the mark gone, and letting go there does nothing
    drag.cancel()
    #expect(second.shell.tabDrop == nil)
    drag.dropped(tab.id, at: over)
    #expect(first.shell.tabs.contains { $0.id == tab.id } && second.shell.tabs.count == 1)

    // again, let go on the other row: it moves there, first
    _ = drag.dragged(tab.id, title: "B", at: atTab, grab: grab)
    _ = drag.dragged(tab.id, title: "B", at: CGPoint(x: atTab.x, y: row1.minY - 60), grab: grab)
    _ = drag.dragged(tab.id, title: "B", at: over, grab: grab)
    drag.dropped(tab.id, at: over)
    await until("moved") { second.shell.tabs.first?.id == tab.id }
    #expect(
      second.shell.selected == tab.id && second.shell.tabDrop == nil && !first.shell.tabs.contains { $0.id == tab.id })

    // and let go where no row is, from a window with two tabs: a window of its own
    second.shell.show(b, newTab: true)
    set.sync()
    let other = try #require(second.shell.selected)
    let start = CGPoint(x: row2.minX + 40, y: row2.midY)
    _ = drag.dragged(other, title: "B", at: start, grab: grab)
    _ = drag.dragged(other, title: "B", at: CGPoint(x: start.x, y: row2.minY - 300), grab: grab)
    drag.dropped(other, at: CGPoint(x: start.x + 100, y: row2.minY - 300))
    await until("a window of its own") { set.all.contains { $0.shell.tabs.map(\.id) == [other] } }
    let made = try #require(set.all.first { $0.shell.tabs.map(\.id) == [other] })
    #expect(made.window.frame.size == second.window.frame.size)
  }
}

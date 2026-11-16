import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardReading
@testable import CodeBoardShell

// The app's windows over one session and one table of open boards: each window its own tabs, selection and camera,
// what is the app's (a fresh tree, writing every board) done once for all of them
@MainActor @Suite(.serialized) struct WindowSetTests {
  let a = BoardID(rawValue: "a")
  let b = BoardID(rawValue: "b")
  let n = CardID(rawValue: "n")
  let m = CardID(rawValue: "m")
  let k = CardID(rawValue: "k")
  static let wide = CGRect(x: 0, y: 0, width: 4000, height: 3000)

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
    // one screen, made up: never this Mac's
    set.screens = { [Screen(id: "S1", frame: Self.wide, visible: Self.wide, scale: 2)] }
    let s = Shell(session: set.session)
    s.open(vault, restoring: nil)
    s.apply(.success(try vault.tree()))
    s.show(a)
    let first = set.add(s)
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

  /// What one window saved before there were several has no frame: its window takes the frame kept under its name
  /// then (in the test process's own defaults here, under a name of its own), not the middle of the screen
  @Test func whatOneWindowSavedBeforeOpensAtTheFrameKeptUnderItsName() throws {
    let (set, first, _, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let name = "WindowSetTests-\(UUID().uuidString)"
    defer { UserDefaults.standard.removeObject(forKey: "NSWindow Frame \(name)") }
    let kept = CGRect(x: 210, y: 130, width: 980, height: 690)
    first.window.setFrame(kept, display: false)
    first.window.saveFrame(usingName: name)
    let old = SavedWindow(shell: try #require(first.shell.state))
    let s = Shell(session: set.session)
    s.vaultOpened(restoring: old.shell)
    let e = set.addFirst(s, saved: old, frameName: name)
    #expect(e.window.frame == kept && e.placed == ScreenPlace(screen: "S1", frame: kept))
    #expect(e.window.frameAutosaveName.isEmpty)
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
    try pdf([""]).write(to: vault.url(of: file))
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

  /// A PDF of a page per text
  func pdf(_ pages: [String]) -> Data {
    let data = NSMutableData()
    var box = CGRect(x: 0, y: 0, width: 300, height: 400)
    let ctx = CGContext(consumer: CGDataConsumer(data: data as CFMutableData)!, mediaBox: &box, nil)!
    for text in pages {
      ctx.beginPDFPage(nil)
      NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
      (text as NSString).draw(
        in: CGRect(x: 20, y: 20, width: 260, height: 360), withAttributes: [.font: NSFont.systemFont(ofSize: 14)])
      NSGraphicsContext.current = nil
      ctx.endPDFPage()
    }
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

  // MARK: Reading tabs between windows

  /// Both windows on screen and laid out side by side, each reading pane's views made for its tabs
  func laidOut(_ set: WindowSet, _ first: WindowSet.Entry, _ second: WindowSet.Entry) {
    set.onScreen = { _ in true }
    set.focus = { _ in }
    set.readingDrag.showPicture = { _ in }
    set.tabDrag.showPicture = { _ in }
    first.window.setFrame(CGRect(x: 100, y: 100, width: 1200, height: 700), display: false)
    second.window.setFrame(CGRect(x: 1400, y: 100, width: 1200, height: 700), display: false)
    for e in [first, second] {
      e.window.contentView?.layoutSubtreeIfNeeded()
      set.readingView(of: e)?.sync()
    }
  }

  func view(_ e: WindowSet.Entry, _ id: String) -> NSView? {
    func find(_ v: NSView) -> NSView? {
      v.accessibilityIdentifier() == id ? v : v.subviews.lazy.compactMap(find).first
    }
    return e.window.contentView.flatMap(find)
  }

  func js(_ v: WebPageView, _ script: String) async -> Int? {
    try? await v.web.evaluateJavaScript(script) as? Int
  }

  @Test func aWebTabMovedToAnotherWindowTakesItsLiveViewAndItsPageIsNotLoadedAgain() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    first.shell.openWeb(nil)
    first.shell.openWeb(nil)
    let (stay, tab) = (first.shell.reading.tabs[0].id, first.shell.reading.tabs[1].id)
    laidOut(set, first, second)
    let from = try #require(set.readingView(of: first))
    let to = try #require(set.readingView(of: second))
    let v = try #require(from.views[tab] as? WebPageView)
    v.web.loadHTMLString("<p>harbour</p>", baseURL: nil)
    await until("the page loaded") { !v.web.isLoading && v.web.url != nil }
    _ = try? await v.web.evaluateJavaScript("window.mark = 7; 0")
    #expect(await js(v, "window.mark") == 7)

    set.moveReading(tab, from: first, to: second, at: 0)
    #expect(second.shell.reading.tabs.map(\.id) == [tab] && second.shell.reading.selected == tab)
    #expect(to.views[tab] === v && v.superview === to && v.window === second.window && !v.isHidden)
    #expect(from.views[tab] == nil && first.shell.reading.tabs.map(\.id) == [stay])
    #expect(first.shell.reading.selected == stay)
    // what it says goes to the pane it is in now
    #expect(to.places[tab]?.pane === second.shell.reading && to.places[tab]?.paneView === to)
    from.sync()
    to.sync()
    #expect(to.views[tab] === v && v.superview === to)
    #expect(await js(v, "window.mark") == 7, "the same page, not loaded again")

    // the last reading tab moved away from a window with a board tab: it stays, its pane empty
    set.moveReading(stay, from: first, to: second, at: 9)
    #expect(set.all.count == 2 && first.shell.reading.tabs.isEmpty && second.shell.reading.tabs.last?.id == stay)
  }

  @Test func aPDFTabMovedToAnotherWindowStaysOnItsPageWithItsSelection() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let resource = try vault.newResource(in: "", title: "Papers", preset: .papers)
    let file = "\(resource.path)/Tides.pdf"
    try pdf(["The first page.", "The river runs north."]).write(to: vault.url(of: file))
    let e = Entry(
      id: EntryID(rawValue: "e1"), title: "Tides", added: 0,
      versions: [Version(id: VersionID(rawValue: "v1"), added: 0, content: .pdf(file: "file.pdf"))])
    _ = try vault.promote(file: file, to: e, as: "file.pdf")
    first.shell.apply(.success(try vault.tree()))
    set.onScreen = { _ in false }
    first.shell.sources.reveal(SourceAnchor(entry: e.id, place: Place(version: e.versions[0].id, block: .page(1))))
    let tab = try #require(first.shell.reading.selected)
    laidOut(set, first, second)
    let t = try #require(set.readingView(of: first)?.views[tab] as? PDFTabView)
    let page = try #require(t.pdf.document?.page(at: 1))
    t.pdf.go(to: page)
    t.pdf.setCurrentSelection(page.selection(for: (page.string! as NSString).range(of: "river")), animate: false)
    #expect(t.pdf.currentPage === page)

    set.moveReading(tab, from: first, to: second, at: 0)
    #expect(set.readingView(of: second)?.views[tab] === t && t.window === second.window)
    #expect(t.pdf.currentPage === page && t.pdf.currentSelection?.string == "river")
    #expect(t.context.pane === second.shell.reading && t.context.paneView === set.readingView(of: second))
  }

  @Test func aReadingTabInAWindowOfItsOwnShowsOnlyTheReadingPaneUntilABoardTabArrives() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    first.shell.openWeb(nil)
    first.shell.openWeb(nil)
    let tab = first.shell.reading.tabs[1].id
    laidOut(set, first, second)
    let v = try #require(set.readingView(of: first)?.views[tab])
    let panel = try #require(set.readingView(of: first)).frame.width

    let made = try #require(set.moveReadingToNewWindow(tab, from: first, frame: nil))
    made.window.contentView?.layoutSubtreeIfNeeded()
    #expect(made.shell.readingOnly && !made.shell.sidebarShown && made.shell.tabs.isEmpty)
    #expect(made.shell.reading.tabs.map(\.id) == [tab] && set.readingView(of: made)?.views[tab] === v)
    #expect(made.window.frame.width == panel + 2 * ShellTheme.inset && made.window.frame.height == 700)
    // no board panel and no divider; the reading panel takes the room, its tabs after the title controls
    #expect(view(made, "ui-boardtabs")?.isHiddenOrHasHiddenAncestor == true)
    #expect(view(made, "ui-readingdivider")?.isHidden == true)
    let pane = try #require(set.readingView(of: made))
    #expect(abs(pane.frame.width - (made.window.contentLayoutRect.width - 2 * ShellTheme.inset)) < 1)
    let row = try #require(set.tabRow(of: made, .reading))
    #expect(row.minX - made.window.frame.minX > 80)
    // its only tab stays: there is nothing to split
    #expect(set.moveReadingToNewWindow(tab, from: made, frame: nil) == nil && set.all.count == 3)

    // a board opened from its sidebar: the board panel comes back, the reading pane beside it
    made.shell.show(b)
    made.window.contentView?.layoutSubtreeIfNeeded()
    #expect(!made.shell.readingOnly && view(made, "ui-boardtabs")?.isHiddenOrHasHiddenAncestor == false)
    #expect(view(made, "ui-readingdivider")?.isHidden == false && pane.frame.width < panel + 1)
  }

  @Test func aReadingOnlyWindowClosesWithItsLastReadingTabAndComesBackAsOne() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    for _ in 0..<3 { first.shell.openWeb(nil) }
    let ids = first.shell.reading.tabs.map(\.id)
    laidOut(set, first, second)
    let frame = CGRect(x: 300, y: 200, width: 520, height: 640)
    let made = try #require(set.moveReadingToNewWindow(ids[1], from: first, frame: frame))
    #expect(made.window.frame == frame)
    let other = try #require(set.moveReadingToNewWindow(ids[2], from: first, frame: nil))

    // saved, and opened again from what was saved: no board tab, its reading tab, its frame
    let name = "WindowSetTests-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: name))
    defer { defaults.removePersistentDomain(forName: name) }
    set.save(in: defaults)
    let saved = try #require(WindowSet.saved(in: defaults).first { $0.shell.readingOnly == true })
    #expect(saved.shell.tabs.isEmpty && saved.shell.reading?.tabs.map(\.id) == [ids[1]] && saved.frame == frame)
    #expect(WindowSet.saved(in: defaults).filter { $0.shell.readingOnly == true }.count == 2)
    #expect(try #require(first.shell.state).readingOnly == nil)
    made.window.close()
    let again = try #require(set.open(saved))
    #expect(again.shell.readingOnly && again.shell.tabs.isEmpty && again.shell.reading.tabs.map(\.id) == [ids[1]])
    #expect(again.window.frame == frame)

    // its last reading tab closed: the window closes; in a window with a board tab the pane stays, empty
    again.shell.reading.close(ids[1])
    #expect(!set.all.contains { $0 === again })
    first.shell.reading.close(ids[0])
    #expect(set.all.contains { $0 === first } && first.shell.reading.tabs.isEmpty)
    // its last reading tab moved to another window: it closes too
    set.moveReading(ids[2], from: other, to: second, at: 0)
    #expect(!set.all.contains { $0 === other } && second.shell.reading.tabs.map(\.id) == [ids[2]])
  }

  @Test func aReadingTabDraggedGoesOnlyToReadingRowsAndWhereNoneIsToAWindowOfItsOwn() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    first.shell.openWeb(nil)
    first.shell.openWeb(nil)
    second.shell.openWeb(nil)
    let tab = first.shell.reading.tabs[1].id
    laidOut(set, first, second)
    let drag = set.readingDrag!
    let row1 = try #require(set.tabRow(of: first, .reading))
    let reading2 = try #require(set.tabRow(of: second, .reading))
    let board2 = try #require(set.tabRow(of: second))
    let grab = CGPoint(x: 10, y: 6)
    let start = CGPoint(x: row1.minX + ShellTheme.stripPadding + TabItem.width(of: "New Tab") + 12, y: row1.midY)
    #expect(!drag.dragged(tab, title: "New Tab", at: start, grab: grab))
    #expect(drag.dragged(tab, title: "New Tab", at: CGPoint(x: start.x, y: row1.minY - 60), grab: grab))
    // over the other window's board row: not a row for it, nothing marked
    let overBoard = CGPoint(x: board2.minX + 20, y: board2.midY)
    #expect(drag.dragged(tab, title: "New Tab", at: overBoard, grab: grab))
    #expect(second.shell.tabDrop == nil && second.shell.reading.tabDrop == nil)
    // over its reading row: the place it would go marked there
    let over = CGPoint(x: reading2.minX + ShellTheme.stripPadding + TabItem.width(of: "New Tab") + 4, y: reading2.midY)
    #expect(drag.dragged(tab, title: "New Tab", at: over, grab: grab) && second.shell.reading.tabDrop == 1)
    drag.dropped(tab, at: over)
    #expect(second.shell.reading.tabs.map(\.id).last == tab && second.shell.reading.tabDrop == nil)
    #expect(set.readingView(of: second)?.views[tab] is WebPageView)

    // a board tab over a reading row: nothing marked, and let go there it is a window of its own
    let board = try #require(second.shell.selected)
    second.shell.show(a, newTab: true)
    set.sync()
    let bd = set.tabDrag!
    let bstart = CGPoint(x: board2.minX + 20, y: board2.midY)
    _ = bd.dragged(board, title: "A", at: bstart, grab: grab)
    _ = bd.dragged(board, title: "A", at: CGPoint(x: bstart.x, y: board2.minY - 300), grab: grab)
    let readingRow1 = CGPoint(x: row1.minX + 20, y: row1.midY)
    #expect(bd.dragged(board, title: "A", at: readingRow1, grab: grab) && first.shell.tabDrop == nil)
    #expect(first.shell.reading.tabDrop == nil)
    bd.cancel()
    bd.dropped(board, at: readingRow1)

    // let go where no row is: a window with only the reading pane, its tab under the pointer
    let moving = second.shell.reading.tabs[0].id
    let from = CGPoint(x: reading2.minX + 30, y: reading2.midY)
    let width = set.readingFrame(of: second).width
    _ = drag.dragged(moving, title: "New Tab", at: from, grab: grab)
    _ = drag.dragged(moving, title: "New Tab", at: CGPoint(x: from.x, y: reading2.minY - 300), grab: grab)
    let away = CGPoint(x: from.x + 100, y: reading2.minY - 300)
    drag.dropped(moving, at: away)
    let made = try #require(set.all.first { $0.shell.reading.tabs.map(\.id) == [moving] })
    #expect(made.shell.readingOnly && made.window.frame.width == width && made.window.frame.height == 700)
    let row = try #require(set.tabRow(of: made, .reading))
    #expect(abs(row.minX + ShellTheme.stripPadding - (away.x - grab.x)) < 1)
    #expect(abs(made.window.frame.minY - (away.y - (from.y - second.window.frame.minY))) < 1)

    // a board tab let go on the reading-only window's page: it moves in, and the board panel is back
    let pv = try #require(set.readingView(of: made))
    let page = made.window.convertToScreen(pv.convert(pv.bounds, to: nil))
    let target = CGPoint(x: page.midX, y: page.midY)
    let other = try #require(second.shell.tabs.last?.id)
    _ = bd.dragged(other, title: "A", at: bstart, grab: grab)
    _ = bd.dragged(other, title: "A", at: CGPoint(x: bstart.x, y: board2.minY - 300), grab: grab)
    #expect(bd.dragged(other, title: "A", at: target, grab: grab) && made.shell.tabDrop == 0)
    bd.dropped(other, at: target)
    await until("the board tab moved in") { made.shell.tabs.map(\.id) == [other] }
    #expect(!made.shell.readingOnly)
  }

  @Test func whereATabLetGoOnAnotherWindowsRowGoesCountsTheRowScrolledSideways() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    for _ in 0..<3 { second.shell.openWeb(nil) }
    laidOut(set, first, second)
    let rows = set.tabRows(.reading)
    let r = try #require(rows.first { $0.entry === second }?.frame)
    let w = TabItem.width(of: "New Tab")
    let p = CGPoint(x: r.minX + ShellTheme.stripPadding + w / 2 - 2, y: r.midY)
    #expect(set.row(at: p, slack: 0, in: rows, .reading)?.index == 0)
    second.shell.reading.stripScroll = w + 2
    #expect(set.row(at: p, slack: 0, in: rows, .reading)?.index == 1)
    let boards = set.tabRows()
    let b = try #require(boards.first { $0.entry === second }?.frame)
    let q = CGPoint(x: b.minX + ShellTheme.stripPadding + TabItem.width(of: "A") / 2 - 2, y: b.midY)
    #expect(set.row(at: q, slack: 0, in: boards)?.index == 0)
    second.shell.stripScroll = TabItem.width(of: "A") + 2
    #expect(set.row(at: q, slack: 0, in: boards)?.index == 1)
  }

  @Test func aWebSourceOpenInAnotherWindowIsSelectedThere() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    set.onScreen = { _ in true }
    let resource = try vault.newResource(in: "", title: "Reading", preset: .papers)
    let hash = String(repeating: "ab", count: 32)
    let e = Entry(
      id: EntryID(rawValue: "w1"), title: "Quay plans", added: 1, origin: .web("http://127.0.0.1:9/quay"),
      versions: [
        Version(id: VersionID(rawValue: "v1"), added: 1, content: .page(hash: hash, bytes: 9)),
        Version(id: VersionID(rawValue: "v2"), added: 2, content: .pdf(file: "none.pdf")),
      ])
    try vault.newEntry(e, in: resource.path)
    first.shell.apply(.success(try vault.tree()))
    // its saved page open in the second window: selected there, nothing opened here
    let page = WebReading.Page.saved(hash: hash, address: URL(string: "http://127.0.0.1:9/quay")!, title: "Quay plans")
    second.shell.reading.open("Quay plans", key: page.key, kind: WebReading.kind, payload: page.payload)
    let saved = try #require(second.shell.reading.selected)
    second.shell.openWeb(nil)
    first.shell.sources.reveal(SourceAnchor(entry: e.id, place: Place(version: e.versions[0].id, block: .id("1.b2"))))
    #expect(first.shell.reading.tabs.isEmpty && second.shell.reading.selected == saved)
    // the page online, open there: the same
    second.shell.openWeb(URL(string: "http://127.0.0.1:9/quay"))
    let online = try #require(second.shell.reading.selected)
    second.shell.openWeb(nil)
    first.shell.sources.reveal(SourceAnchor(entry: e.id, place: Place(version: e.versions[1].id, block: .page(1))))
    #expect(first.shell.reading.tabs.isEmpty && second.shell.reading.selected == online)
    // the other window off screen: here
    set.onScreen = { _ in false }
    first.shell.sources.reveal(SourceAnchor(entry: e.id, place: Place(version: e.versions[0].id, block: .id("1.b2"))))
    #expect(first.shell.reading.tabs.map(\.key) == [page.key])
  }

  // MARK: Screens

  @Test func aWindowOnAScreenUnpluggedGoesBackWhenItIsPluggedInAgainAndRemembersItAcrossARelaunch() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let (laptop, monitor) = (ScreenPlacesTests.laptop, ScreenPlacesTests.monitor)
    var screens = [laptop, monitor]
    set.screens = { screens }
    // placed on the one screen they were made on, which these replace
    for e in [first, second] { e.placed = nil }
    let onMonitor = CGRect(x: 1700, y: 200, width: 1200, height: 800)
    let onLaptop = CGRect(x: 60, y: 40, width: 1000, height: 700)
    first.window.setFrame(onLaptop, display: false)
    second.window.setFrame(onMonitor, display: false)
    set.moved(first)
    set.moved(second)
    #expect(second.placed == ScreenPlace(screen: "MONITOR", frame: onMonitor))

    // unplugged: the system moves the window to the laptop first; that is not a place of its own
    screens = [laptop]
    let put = CGRect(x: 100, y: 50, width: 1200, height: 800)
    second.window.setFrame(put, display: false)
    set.moved(second)
    set.screensChanged()
    #expect(second.window.frame == put && second.home == ScreenPlace(screen: "MONITOR", frame: onMonitor))
    #expect(first.window.frame == onLaptop && first.home == nil)
    set.screensChanged()
    #expect(second.window.frame == put && second.home?.screen == "MONITOR", "the same again: nothing")

    // moved by hand on the laptop meanwhile, saved and opened again on the laptop alone: its home kept
    let byHand = CGRect(x: 200, y: 60, width: 1100, height: 760)
    second.window.setFrame(byHand, display: false)
    set.moved(second)
    let name = "WindowSetTests-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: name))
    defer { defaults.removePersistentDomain(forName: name) }
    set.save(in: defaults)
    let saved = WindowSet.saved(in: defaults)[1]
    #expect(saved.frame == byHand && saved.display == "LAPTOP" && saved.home?.frame == onMonitor)
    second.window.close()
    let again = try #require(set.open(saved))
    #expect(again.window.frame == byHand && again.home?.frame == onMonitor)

    // the monitor back: home; again: nothing
    screens = [laptop, monitor]
    set.screensChanged()
    #expect(again.window.frame == onMonitor && again.home == nil && first.window.frame == onLaptop)
    set.screensChanged()
    #expect(again.window.frame == onMonitor && again.placed?.screen == "MONITOR")

    // unplugged with the window left where it was: to the laptop, inside what it shows
    screens = [laptop]
    set.screensChanged()
    #expect(again.window.frame == CGRect(x: 240, y: 75, width: 1200, height: 800) && again.home?.frame == onMonitor)
  }

  @Test func aFullScreenFrameIsNeverSavedAndNoWindowKeepsAFrameUnderAName() async throws {
    let (set, first, _, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    let before = CGRect(x: 120, y: 80, width: 1000, height: 700)
    first.window.setFrame(before, display: false)
    first.windowWillEnterFullScreen(Notification(name: NSWindow.willEnterFullScreenNotification))
    first.window.setFrame(CGRect(x: 0, y: 0, width: 4000, height: 3000), display: false)
    set.moved(first)
    let name = "WindowSetTests-\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: name))
    defer { defaults.removePersistentDomain(forName: name) }
    set.save(in: defaults)
    #expect(WindowSet.saved(in: defaults)[0].frame == before && first.placed?.frame != first.window.frame)
    first.window.setFrame(before, display: false)
    first.windowDidExitFullScreen(Notification(name: NSWindow.didExitFullScreenNotification))
    #expect(first.placed?.frame == before)

    // every window's place is in its saved state: none is kept under the autosave name "main"
    let made = try #require(set.open())
    #expect(made.window.frameAutosaveName.isEmpty && first.window.frameAutosaveName.isEmpty)
  }

  /// Code taken from the reading pane goes where Add to Board goes: this window's board, else in a window with no board
  /// tab (one that shows only the reading pane) the board of the latest used window that shows one
  @Test func codeFromAReadingOnlyWindowGoesToTheBoardOfTheWindowUsedLast() async throws {
    let (set, first, second, vault) = try await onAAndB()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    first.shell.openWeb(nil)
    first.shell.openWeb(nil)
    laidOut(set, first, second)
    #expect(first.panes.addBoard?.id == a && second.panes.addBoard?.id == b)
    let made = try #require(set.moveReadingToNewWindow(first.shell.reading.tabs[1].id, from: first, frame: nil))
    #expect(made.shell.readingOnly && made.panes.addBoard?.id == canvas(first)?.document?.id)
    set.onScreen = { _ in false }
    #expect(made.panes.addBoard == nil)
  }

  // MARK: Cards between windows

  /// Both windows side by side and laid out, their boards drawn, the cards' picture kept off screen
  func cardWindows(_ set: WindowSet, _ first: WindowSet.Entry, _ second: WindowSet.Entry) async {
    set.onScreen = { _ in true }
    set.focus = { _ in }
    set.cardDrag.showPicture = { _ in }
    first.window.setFrame(CGRect(x: 100, y: 100, width: 1200, height: 700), display: false)
    second.window.setFrame(CGRect(x: 1400, y: 100, width: 1200, height: 700), display: false)
    for e in [first, second] { e.window.contentView?.layoutSubtreeIfNeeded() }
    await until("both drawn") { canvas(first)?.scene != nil && canvas(second)?.scene != nil }
  }

  /// A board point of a canvas on screen
  func onScreen(_ c: CanvasView, _ p: CGPoint) -> CGPoint {
    c.window!.convertPoint(toScreen: c.convert(c.camera.view(p), to: nil))
  }

  func mouse(_ c: CanvasView, _ type: NSEvent.EventType, _ p: CGPoint) -> NSEvent {
    NSEvent.mouseEvent(
      with: type, location: c.window!.convertPoint(fromScreen: p), modifierFlags: [], timestamp: 0,
      windowNumber: c.window!.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
  }

  /// A press on `c` at board point `at`, dragged a little on it and then through `points` on screen
  func drag(_ c: CanvasView, at: CGPoint, through points: [CGPoint]) {
    // pressed unselected, it moves (the one card selected, dragged on its body, has its text selected)
    c.document?.select([])
    let start = onScreen(c, at)
    c.mouseDown(with: mouse(c, .leftMouseDown, start))
    c.mouseDragged(with: mouse(c, .leftMouseDragged, CGPoint(x: start.x + 20, y: start.y)))
    for p in points { c.mouseDragged(with: mouse(c, .leftMouseDragged, p)) }
  }

  /// The middle of a window's canvas on screen
  func middle(_ e: WindowSet.Entry) -> CGPoint {
    let c = canvas(e)!
    let r = e.window.convertToScreen(c.convert(c.visibleRect, to: nil))
    return CGPoint(x: r.midX, y: r.midY)
  }

  @Test func cardsDraggedOntoAnotherWindowsBoardArePastedThereSharedAsOneStepAndStayHere() async throws {
    let (set, first, second, vault) = try await onAAndB()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    await cardWindows(set, first, second)
    let (from, to) = (try #require(canvas(first)), try #require(canvas(second)))
    let docA = try #require(set.documents.open[a])
    let docB = try #require(set.documents.open[b])
    let before = docA.board.card(n).map { CGPoint(x: $0.x, y: $0.y) }
    let target = middle(second)

    // out of its canvas over the other one: the cards back where they were here, a mark there, nothing changed yet
    drag(from, at: CGPoint(x: 100, y: 50), through: [target])
    #expect(from.cardsOut?.clip.cards.map(\.id) == [n] && from.liveRect(.card(n))?.origin != nil)
    #expect(to.cardsDropLayer?.path != nil && docB.board.cards.count == 1 && docA.undoName == nil)
    from.mouseUp(with: mouse(from, .leftMouseUp, target))

    // let go there: Copy here and Paste there, the press where the pointer is
    let landed = try #require(to.boardPoint(onScreen: target))
    #expect(docB.board.cards.count == 2 && docB.undoName == "Paste" && to.cardsDropLayer?.path == nil)
    let pasted = try #require(docB.board.cards.first { $0.id != k })
    #expect(pasted.x == (landed.x - 100).rounded() && pasted.y == (landed.y - 50).rounded())
    #expect(to.document?.selection == [.card(pasted.id)])
    // shared by both: here it is the same card as there, where it was
    let here = try #require(docA.board.card(pasted.id))
    #expect(here.isShared && pasted.isShared && docA.board.cards.count == 2)
    #expect(CGPoint(x: here.x, y: here.y) == before)
    #expect(from.gesture == nil && from.cardsOut == nil)
  }

  @Test func cardsDraggedToTheSameBoardInAnotherWindowMoveThereAsOneStep() async throws {
    let (set, first, second, vault) = try twoWindows()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    await cardWindows(set, first, second)
    let (from, to) = (try #require(canvas(first)), try #require(canvas(second)))
    #expect(from.document?.id == a && to.document?.id == a)
    let doc = try #require(set.documents.open[a])
    let target = middle(second)
    drag(from, at: CGPoint(x: 100, y: 50), through: [target])
    from.mouseUp(with: mouse(from, .leftMouseUp, target))
    let landed = try #require(to.boardPoint(onScreen: target))
    let card = try #require(doc.board.card(n))
    #expect(card.x == (landed.x - 100).rounded() && card.y == (landed.y - 50).rounded())
    #expect(doc.board.cards.count == 2 && doc.undoName == "Move")
  }

  /// With no other window's canvas under the pointer the drag stays the canvas's own wherever the pointer goes: over
  /// its window's sidebar, past every window, and let go there it lands where it is let go
  @Test func aCardDragOutOfItsCanvasWithNoOtherBoardUnderItStaysItsOwn() async throws {
    let (set, first, second, vault) = try await onAAndB()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    await cardWindows(set, first, second)
    let from = try #require(canvas(first))
    let docA = try #require(set.documents.open[a])
    let start = try #require(docA.board.card(n).map { CGPoint(x: $0.x, y: $0.y) })
    let sidebar = CGPoint(x: first.window.frame.minX + 60, y: middle(first).y)
    #expect(!from.visibleRect.contains(from.convert(first.window.convertPoint(fromScreen: sidebar), from: nil)))
    drag(from, at: CGPoint(x: 100, y: 50), through: [sidebar])
    #expect(from.cardsOut == nil && from.liveRect(.card(n)).map { $0.minX < start.x } == true, "it follows")
    from.mouseUp(with: mouse(from, .leftMouseUp, sidebar))
    #expect(docA.undoName == "Move" && (docA.board.card(n)?.x ?? 0) < start.x)

    // the other card, past every window
    let away = CGPoint(x: first.window.frame.minX - 300, y: first.window.frame.minY - 200)
    drag(from, at: CGPoint(x: 400, y: 50), through: [sidebar, away])
    #expect(from.cardsOut == nil)
    from.mouseUp(with: mouse(from, .leftMouseUp, away))
    #expect(docA.undoName == "Move" && docA.history.undoSteps.count == 2 && (docA.board.card(m)?.x ?? 300) < 300)
  }

  @Test func cardsLetGoOffABoardOrAfterEscChangeNothingAndBackOverTheirCanvasTheDragGoesOn() async throws {
    let (set, first, second, vault) = try await onAAndB()
    defer { try? FileManager.default.removeItem(at: vault.root) }
    await cardWindows(set, first, second)
    let (from, to) = (try #require(canvas(first)), try #require(canvas(second)))
    let docA = try #require(set.documents.open[a])
    let docB = try #require(set.documents.open[b])
    let start = docA.board.card(n).map { CGPoint(x: $0.x, y: $0.y) }

    // over the other window's sidebar, then the desktop: no mark, and let go there nothing changes
    let sidebar = CGPoint(x: second.window.frame.minX + 60, y: middle(second).y)
    drag(from, at: CGPoint(x: 100, y: 50), through: [middle(second), sidebar])
    #expect(set.canvas(at: sidebar) == nil && to.cardsDropLayer?.path == nil && from.cardsOut != nil)
    let desktop = CGPoint(x: 5000, y: 5000)
    from.mouseDragged(with: mouse(from, .leftMouseDragged, desktop))
    from.mouseUp(with: mouse(from, .leftMouseUp, desktop))
    #expect(docA.undoName == nil && docB.undoName == nil && docB.board.cards.count == 1)

    // Esc over the other canvas: the mark gone; let go there, nothing; back over its own canvas it stays put
    drag(from, at: CGPoint(x: 100, y: 50), through: [middle(second)])
    #expect(to.cardsDropLayer?.path != nil)
    set.cardDrag.cancel()
    #expect(to.cardsDropLayer?.path == nil)
    from.mouseDragged(with: mouse(from, .leftMouseDragged, onScreen(from, CGPoint(x: 400, y: 300))))
    from.mouseUp(with: mouse(from, .leftMouseUp, middle(second)))
    #expect(docA.undoName == nil && docB.board.cards.count == 1)

    // out and back over its own canvas: the ordinary drag goes on and moves it there
    let back = onScreen(from, CGPoint(x: 600, y: 350))
    drag(from, at: CGPoint(x: 100, y: 50), through: [middle(second), back])
    #expect(from.cardsOut == nil)
    from.mouseUp(with: mouse(from, .leftMouseUp, back))
    #expect(docA.undoName == "Move" && docA.board.card(n).map { CGPoint(x: $0.x, y: $0.y) } != start)
    #expect(docB.board.cards.count == 1)
  }
}

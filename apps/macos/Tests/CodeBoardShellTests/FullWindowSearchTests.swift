import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Synchronization
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardNotes
@testable import CodeBoardShell

// ⌘K and ⌘F in the whole window (keymap.ts search, searchBoard; ui/Palette.tsx): the palette over the board, its
// groups, ↑ ↓ and Return, Tab between all boards and this one, Esc; the toolbar's Search; both keys in the shortcut list;
// Related by Meaning over a fake index (never box itself), with settings in a defaults suite and the key in memory;
// Resources, Return opening an entry and ⌥↵ putting its passage on the board

/// A key in memory that counts how often it is read
final class CountingKeyStore: KeyStore {
  let reads = Mutex(0)
  func key() -> String? {
    reads.withLock { $0 += 1 }
    return "ek-1"
  }
  func setKey(_ key: String?) {}
}

/// box as Related by Meaning asks it: the nth search's answer, the reranker's hits (nil: it fails as a server without a
/// reranking model), and every request
final class FakeMeaning: MeaningIndex {
  struct Log: Sendable {
    var syncs: [(embedder: BoxEmbedder, items: [BoxItem])] = []
    var searches: [BoxQuery] = []
    var reranks: [BoxQuery] = []
  }
  let answer: @Sendable (Int) throws -> BoxResult
  let reranked: [BoxHit]?
  let log = Mutex(Log())
  /// Holding: the reranker answers once `release` is yielded to
  let hold: Bool
  let release = AsyncStream<Void>.makeStream()

  init(reranked: [BoxHit]? = nil, hold: Bool = false, answer: @escaping @Sendable (Int) throws -> BoxResult) {
    self.answer = answer
    self.reranked = reranked
    self.hold = hold
  }

  func sync(source: String, ref: String, embedder: BoxEmbedder, items: [BoxItem]) async throws -> Int {
    log.withLock { $0.syncs.append((embedder, items)) }
    return items.count
  }
  func search(_ q: BoxQuery) async throws -> BoxResult {
    let n = log.withLock {
      $0.searches.append(q)
      return $0.searches.count
    }
    return try answer(n)
  }
  func rerank(_ q: BoxQuery) async throws -> BoxResult {
    log.withLock { $0.reranks.append(q) }
    if hold { for await _ in release.stream { break } }
    guard let reranked else { throw BoxError.service(boxNoReranker) }
    return BoxResult(hits: reranked, source: q.source, ref: q.ref)
  }
  func status(source: String, ref: String) async throws -> BoxStatus { throw BoxError.unavailable }
}

@MainActor @Suite(.serialized) struct FullWindowSearchTests {
  let board = BoardID(rawValue: "w")
  let other = BoardID(rawValue: "o")
  let env = FullWindowEditTests()

  func vault() throws -> Vault {
    let root = FileManager.default.temporaryDirectory.appending(path: "search-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    func note(_ id: String, _ text: String, x: Double = 0, y: Double = 0) -> Card {
      Card(
        id: CardID(rawValue: id), x: x, y: y, width: 240, height: 120,
        content: .own(CardContent(body: .note(Note(text: text)))))
    }
    try vault.newBoard(
      in: "", title: "W",
      board: Board(
        id: board, cards: [note("n", "# A plan"), note("far", "# Waiting list", x: 4000, y: 3000)],
        sidenotes: [
          Sidenote(
            id: SidenoteID(rawValue: "sn"), anchor: .card(CardID(rawValue: "n")),
            body: .text(TextNote(text: "waiting is FIFO")))
        ],
        shelf: [ShelfEntry(id: "e1", at: 0, cards: [note("put", "# Waiting room", x: 300)])]))
    try vault.newBoard(
      in: "", title: "Other",
      board: Board(
        id: other, cards: [note("on", "# Waiting elsewhere"), note("q", "# Queue theory", x: 400)],
        shelf: [ShelfEntry(id: "e2", at: 0, cards: [note("stow", "# Stowed sketch", x: 800)])]))
    return vault
  }

  /// Until `f` holds (it may ask the palette's page), the canvas's frames ticking meanwhile
  func until(_ what: String, in w: FullWindowEditTests.Window, _ f: () async -> Bool) async {
    let deadline = ContinuousClock.now + .seconds(30)
    while !(await f()) {
      if ContinuousClock.now > deadline {
        Issue.record("\(what): not within 30 s")
        return
      }
      w.pane?.tick(at: CACurrentMediaTime())
      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  func opened() async throws -> FullWindowEditTests.Window {
    let w = try await env.opened(try vault())
    BoardPanes.search.drawOffScreen()
    return w
  }

  /// A key of the app menu as AppKit gives it: its item's action up the key window's responder chain (the window
  /// here is never key, so from its first responder)
  func menuKey(_ w: FullWindowEditTests.Window, _ key: String) throws {
    func items(_ m: NSMenu) -> [NSMenuItem] { m.items.flatMap { [$0] + ($0.submenu.map(items) ?? []) } }
    let item = try #require(
      items(AppDelegate().mainMenu()).first { $0.keyEquivalent == key && $0.keyEquivalentModifierMask == .command },
      "⌘\(key) is in the menu")
    let r = try #require(w.window.firstResponder)
    #expect(r.tryToPerform(try #require(item.action), with: item), "⌘\(key) is answered")
  }

  struct Shown {
    var here: Bool
    var groups: [String]
    var rows: [String]
    var details: [String]
    var on: Int
    var empty: String?
    var focused: Bool
    var busy: Bool
    var maybe: [Bool]
    var error: String?
    var off: String?
    var sliding: Int
    var marked: String
  }

  func shown() async -> Shown? {
    guard let s = await BoardPanes.search.run("return palette.state()") as? [String: Any] else { return nil }
    let rows = s["rows"] as? [[String: Any]] ?? []
    return Shown(
      here: s["here"] as? Bool ?? false, groups: s["groups"] as? [String] ?? [],
      rows: rows.map { $0["label"] as? String ?? "" }, details: rows.map { $0["detail"] as? String ?? "" },
      on: s["on"] as? Int ?? -1, empty: s["empty"] as? String, focused: s["focused"] as? Bool ?? false,
      busy: s["busy"] as? Bool ?? false, maybe: rows.map { $0["maybe"] as? Bool ?? false },
      error: s["error"] as? String, off: s["off"] as? String, sliding: s["sliding"] as? Int ?? 0,
      marked: s["marked"] as? String ?? "")
  }

  func open(_ w: FullWindowEditTests.Window, _ key: String) async throws {
    try menuKey(w, key)
    await until("the palette up", in: w) { !BoardPanes.search.view.isHidden }
    await until("its field ready", in: w) { await shown()?.focused == true }
  }

  func type(_ w: FullWindowEditTests.Window, _ text: String, rows: Int) async -> Shown? {
    _ = await BoardPanes.search.run("palette.type(t)", ["t": text])
    await until("\(rows) rows for “\(text)”", in: w) {
      let s = await shown()
      return s?.busy == false && s?.rows.count == rows
    }
    return await shown()
  }

  func press(_ key: String, alt: Bool = false) async {
    _ = await BoardPanes.search.run("palette.press(k, a)", ["k": key, "a": alt])
  }

  @Test func commandKSearchesEveryBoardAndReturnOpensTheCardsBoard() async throws {
    let w = try await opened()
    defer { w.close() }
    try await open(w, "k")
    #expect(w.window.firstResponder === BoardPanes.search.view, "the palette takes the keys")
    let s = try #require(await shown())
    #expect(!s.here && s.empty == "Type to search.")
    let found = try #require(await type(w, "waiting", rows: 4))
    // this board's first (the one on its Shelf too), then the other board's; then the sidenote
    #expect(found.groups == ["Cards on Boards", "Sidenotes"])
    #expect(found.rows == ["Waiting list", "Waiting room", "Waiting elsewhere", "waiting is FIFO"])
    #expect(found.details == ["This board", "This board", "Other", "W · A plan"])
    #expect(found.on == 0)
    await press("ArrowDown")
    await press("ArrowDown")
    #expect(await shown()?.on == 2)
    await press("ArrowUp")
    await press("ArrowDown")
    await press("Enter")
    await until("the other board shown", in: w) { w.shows(other) }
    #expect(BoardPanes.search.isOpen == false && BoardPanes.search.view.isHidden)
    await until("its card selected", in: w) { w.pane?.document?.selection == [.card(CardID(rawValue: "on"))] }
  }

  @Test func returnOnACardOfThisBoardBringsItIntoViewSelected() async throws {
    let w = try await opened()
    defer { w.close() }
    try await open(w, "k")
    _ = await type(w, "waiting list", rows: 1)
    await press("Enter")
    let far = CardID(rawValue: "far")
    await until("it is selected", in: w) { w.pane?.document?.selection == [.card(far)] }
    #expect(w.shows(board))
    await until("it is in view", in: w) {
      w.canvas.safeView.contains(CGPoint(x: 4000 + 120, y: 3000 + 10)) && w.canvas.motion.isResting
    }
    #expect(w.window.firstResponder === w.canvas, "the keys back on the board")
  }

  /// A shelved card picked is shown as a click on its thumbnail shows it: the Shelf open, the entry large beside it, its
  /// thumbnail ringed; the board not edited (no undo step, nothing to save), the card still on the Shelf; Esc lets it go
  func shownOnTheShelf(_ w: FullWindowEditTests.Window, _ entry: String, _ card: String) async throws {
    await until("shown on the Shelf", in: w) {
      w.pane?.previewing == entry && w.pane?.shelfPreview != nil && w.pane?.shelfPanel?.lit == entry
    }
    let doc = try #require(w.pane?.document)
    #expect(doc.board.card(CardID(rawValue: card)) == nil && doc.board.shelf.map(\.id) == [entry])
    #expect(!doc.history.canUndo && !doc.isDirty && doc.selection.isEmpty)
    #expect(w.window.firstResponder === w.canvas, "the keys back on the board")
    let esc = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: w.window.windowNumber,
      context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!
    w.canvas.keyDown(with: esc)
    #expect(w.canvas.previewing == nil && w.canvas.shelfPreview == nil, "Esc closes it")
    #expect(doc.board.shelf.map(\.id) == [entry] && !doc.history.canUndo && !doc.isDirty)
  }

  @Test func aShelvedCardPickedIsShownOnTheShelfAndLeftThere() async throws {
    let w = try await opened()
    defer { w.close() }
    try await open(w, "k")
    _ = await type(w, "waiting room", rows: 1)
    await press("Enter")
    try await shownOnTheShelf(w, "e1", "put")
    #expect(w.shows(board))
  }

  @Test func commandFSearchesThisBoardTabSwitchesAndEscClosesWithTheCameraWhereItWas() async throws {
    let w = try await opened()
    defer { w.close() }
    let camera = w.canvas.currentCamera
    try await open(w, "f")
    #expect(await shown()?.here == true)
    #expect(await shown()?.empty == "Type to search this board.")
    let found = try #require(await type(w, "waiting", rows: 3))
    #expect(found.groups == ["Cards on This Board", "Sidenotes"])
    #expect(found.rows == ["Waiting list", "Waiting room", "waiting is FIFO"])
    await press("Tab")
    await until("all boards", in: w) { await shown()?.rows.count == 4 }
    #expect(await shown()?.here == false)
    await press("Escape")
    await until("closed", in: w) { !BoardPanes.search.isOpen }
    #expect(BoardPanes.search.view.isHidden)
    #expect(w.window.firstResponder === w.canvas, "the keys back on the board")
    #expect(w.canvas.currentCamera == camera)
    #expect(w.pane?.document?.selection.isEmpty == true)
  }

  @Test func theToolbarsSearchOpensCommandK() async throws {
    let w = try await opened()
    defer { w.close() }
    let pane = try #require(w.pane.flatMap { $0.superview })
    let bar = try #require(pane.subviews.compactMap { $0 as? CanvasToolbar }.first)
    let r = bar.extraRects().search
    let at = bar.convert(CGPoint(x: r.midX, y: r.midY), to: nil)
    let frame = try #require(w.window.contentView?.superview)
    let hit = try #require(frame.hitTest(frame.convert(at, from: nil)))
    #expect(hit === bar, "the button is the toolbar's: \(hit)")
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      let e = NSEvent.mouseEvent(
        with: type, location: at, modifierFlags: [], timestamp: 0, windowNumber: w.window.windowNumber, context: nil,
        eventNumber: 0, clickCount: 1, pressure: 1)!
      if type == .leftMouseDown { hit.mouseDown(with: e) } else { hit.mouseUp(with: e) }
    }
    await until("the palette up", in: w) { !BoardPanes.search.view.isHidden }
    await until("on all boards", in: w) { await shown()?.focused == true }
    #expect(await shown()?.here == false)
    await press("Escape")
    await until("closed", in: w) { !BoardPanes.search.isOpen }
  }

  // MARK: Related by Meaning

  /// box's hits for these items, still embedding `left`
  nonisolated static func hits(_ hits: [BoxHit], left: Int = 0) -> BoxResult {
    BoxResult(hits: hits, left: left, source: "", ref: "")
  }

  /// ⌘K with Related by Meaning answered by `index`, an embedding address set (or not) and its key in memory; the app's
  /// own put back after
  func withMeaning(
    _ index: FakeMeaning, address: String? = "http://127.0.0.1:11001/v1", _ body: () async throws -> Void
  ) async rethrows {
    let name = "codeboard-tests-\(UUID().uuidString)"
    let d = UserDefaults(suiteName: name)!
    let was = (BoardPanes.meaningIndex, BoardPanes.searchSettings, BoardPanes.embeddingKeys)
    defer {
      // a palette left open would not open again
      BoardPanes.search.close()
      d.removePersistentDomain(forName: name)
      (BoardPanes.meaningIndex, BoardPanes.searchSettings, BoardPanes.embeddingKeys) = was
    }
    if let address { d.set(address, forKey: SearchSettings.embeddingURLKey) }
    BoardPanes.meaningIndex = index
    BoardPanes.searchSettings = SearchSettings(defaults: d)
    BoardPanes.embeddingKeys = MemoryKeyStore("ek-1")
    try await body()
  }

  @Test func relatedByMeaningComesAfterCardsAndSidenotesLessWhatTheWordsFoundItsMaybesFaint() async throws {
    let index = FakeMeaning { _ in
      Self.hits([
        BoxHit(id: "card:far", score: 0.8), BoxHit(id: "card:n", score: 0.7, piece: 1, range: [2, 8]),
        BoxHit(id: "sidenote:sn", score: 0.69), BoxHit(id: "card:q", score: 0.6),
      ])
    }
    try await withMeaning(index) {
      let w = try await opened()
      defer { w.close() }
      try await open(w, "k")
      let s = try #require(await type(w, "waiting", rows: 6))
      #expect(s.groups == ["Cards on Boards", "Sidenotes", "Related by Meaning"])
      // the list and the sidenote the words found are not listed again
      #expect(s.rows.suffix(2) == ["A plan", "Queue theory"] && s.details.suffix(2) == ["This board", "Other"])
      #expect(s.maybe == [false, false, false, false, false, true], "the one below 0.635 is a maybe")
      // its passage marked in the preview
      for _ in 0..<4 { await press("ArrowDown") }
      await until("the passage marked", in: w) { await shown()?.marked == "A plan" }
      // every board's items handed to box when ⌘K opened (the shelved card too), the key with them
      let sync = try #require(index.log.withLock { $0.syncs.first })
      #expect(sync.embedder == BoxEmbedder(base: "http://127.0.0.1:11001/v1", key: "ek-1"))
      #expect(
        Set(sync.items.map(\.id)) == [
          "card:n", "card:far", "card:put", "sidenote:sn", "card:on", "card:q", "card:stow",
        ])
      #expect(index.log.withLock { $0.searches.map(\.q) } == ["waiting"])
    }
  }

  @Test func whileIndexingItSaysHowManyAreLeftAndAsksAgain() async throws {
    let index = FakeMeaning { n in Self.hits([BoxHit(id: "card:q", score: 0.7)], left: n == 1 ? 3 : 0) }
    try await withMeaning(index) {
      let w = try await opened()
      defer { w.close() }
      try await open(w, "k")
      let s = try #require(await type(w, "lobby", rows: 1))
      #expect(s.groups == ["Related by Meaning · indexing, 3 left"] && s.rows == ["Queue theory"])
      await until("asked again, and done", in: w) { await shown()?.groups == ["Related by Meaning"] }
      #expect(index.log.withLock { $0.searches.map(\.q) } == ["lobby", "lobby"])
    }
  }

  @Test func theRerankersOrderReplacesTheFirstTheRowsSliding() async throws {
    let index = FakeMeaning(
      reranked: [BoxHit(id: "card:q", score: 0.68), BoxHit(id: "card:n", score: 0.7)], hold: true
    ) { _ in Self.hits([BoxHit(id: "card:n", score: 0.7), BoxHit(id: "card:q", score: 0.68)]) }
    // a server of its own: another test's, found to have no reranker, is not asked again
    try await withMeaning(index, address: "http://127.0.0.1:11002/v1") {
      let w = try await opened()
      defer { w.close() }
      try await open(w, "k")
      #expect(await type(w, "lobby", rows: 2)?.rows == ["A plan", "Queue theory"])
      await until("the reranker asked", in: w) { index.log.withLock { $0.reranks.count } == 1 }
      await press("ArrowDown")
      index.release.continuation.yield()
      await until("in the reranker's order", in: w) { await shown()?.rows == ["Queue theory", "A plan"] }
      let s = try #require(await shown())
      #expect(s.on == 0, "the row highlighted stays highlighted")
      #expect(s.sliding > 0, "the rows slide there")
    }
  }

  @Test func anErrorIsTheGroupsLine() async throws {
    let index = FakeMeaning { _ in throw BoxError.unavailable }
    try await withMeaning(index) {
      let w = try await opened()
      defer { w.close() }
      try await open(w, "k")
      _ = await type(w, "waiting", rows: 4)
      await until("the error line", in: w) { await shown()?.error != nil }
      let s = try #require(await shown())
      #expect(s.groups == ["Cards on Boards", "Sidenotes", "Related by Meaning"])
      #expect(s.error?.hasPrefix("Related by Meaning needs box, the index service") == true)
    }
  }

  @Test func withoutAnEmbeddingAddressItIsOffAndNothingIsAsked() async throws {
    let index = FakeMeaning { _ in Self.hits([BoxHit(id: "card:q", score: 0.7)]) }
    try await withMeaning(index, address: nil) {
      let keys = CountingKeyStore()
      BoardPanes.embeddingKeys = keys
      let w = try await opened()
      defer { w.close() }
      try await open(w, "k")
      _ = await type(w, "zzzq", rows: 0)
      await until("said to be off", in: w) { await shown()?.off != nil }
      let s = try #require(await shown())
      #expect(s.empty == "No matches" && s.off?.hasPrefix("Related by Meaning is off") == true)
      // with words found, it is not said
      _ = await BoardPanes.search.run("document.querySelector('.palette .pin').select()")
      _ = await type(w, "waiting", rows: 4)
      #expect(await shown()?.off == nil)
      let log = index.log.withLock { $0 }
      #expect(log.syncs.isEmpty && log.searches.isEmpty && log.reranks.isEmpty)
      #expect(keys.reads.withLock { $0 } == 0, "the Keychain is not read")
    }
  }

  @Test func aRowPickedGoesToItsCardOnAnotherBoard() async throws {
    let index = FakeMeaning { _ in Self.hits([BoxHit(id: "card:q", score: 0.7)]) }
    try await withMeaning(index) {
      let w = try await opened()
      defer { w.close() }
      try await open(w, "k")
      _ = await type(w, "lobby", rows: 1)
      await press("Enter")
      await until("the other board shown", in: w) { w.shows(other) }
      await until("its card selected", in: w) { w.pane?.document?.selection == [.card(CardID(rawValue: "q"))] }
    }
  }

  @Test func aShelvedCardPickedIsShownOnTheShelfAsTheWordsDo() async throws {
    let index = FakeMeaning { _ in Self.hits([BoxHit(id: "card:put", score: 0.7)]) }
    try await withMeaning(index) {
      let w = try await opened()
      defer { w.close() }
      try await open(w, "k")
      #expect(await type(w, "lobby", rows: 1)?.rows == ["Waiting room"])
      await press("Enter")
      try await shownOnTheShelf(w, "e1", "put")
    }
  }

  /// Words find another board's shelved cards not at all (Search.swift: only from their own board); meaning does
  @Test func aCardShelvedOnAnotherBoardPickedOpensThatBoardAndShowsItOnItsShelf() async throws {
    let index = FakeMeaning { _ in Self.hits([BoxHit(id: "card:stow", score: 0.7)]) }
    try await withMeaning(index) {
      let w = try await opened()
      defer { w.close() }
      try await open(w, "k")
      #expect(await type(w, "lobby", rows: 1)?.details == ["Other"])
      await press("Enter")
      await until("the other board shown", in: w) { w.shows(other) }
      try await shownOnTheShelf(w, "e2", "stow")
      #expect(w.shows(other))
    }
  }

  // MARK: Resources

  /// The search vault with a resource of papers: Tidal mills, a plain PDF whose one page tells of the mill wheel
  func withPapers() throws -> Vault {
    let v = try vault()
    let r = try v.newResource(in: "", title: "Papers", preset: .papers)
    let pdf = try ShellPDFTests().outside("mills.pdf", "Every mill on the coast ran on the tide.")
    defer { try? FileManager.default.removeItem(at: pdf.deletingLastPathComponent()) }
    let e = Entry(
      id: EntryID(rawValue: "e-mills"), title: "Tidal mills", added: 1, authors: ["Ana Ruíz"],
      versions: [Version(id: VersionID(rawValue: "v1"), added: 1, content: .pdf(file: "v1.pdf"))])
    _ = try v.newEntry(e, in: r.path, with: ["v1.pdf": try Data(contentsOf: pdf)])
    return v
  }

  @Test func resourcesComeAfterSidenotesReturnOpensTheEntryAndOptionReturnPutsThePassageOnTheBoard() async throws {
    let w = try await env.opened(try withPapers())
    BoardPanes.search.drawOffScreen()
    defer {
      BoardPanes.search.close()
      w.close()
    }
    try await open(w, "k")
    let s = try #require(await type(w, "mill tide", rows: 1))
    #expect(s.groups == ["Resources"] && s.rows == ["Tidal mills"])
    let ctx = await BoardPanes.search.run("return palette.state().rows[0].context") as? String
    #expect(ctx?.hasPrefix("p. 1 · ") == true && ctx?.contains("mill on the coast") == true, "\(ctx ?? "")")
    #expect(await BoardPanes.search.run("return palette.state().foot") as? String == " Open | ⌥↵ Add to Board")
    // the words marked in the row
    await until("marked", in: w) { await shown()?.marked.contains("mill") == true }

    // ⌥↵: the passage a Note on the board, its source the entry's page
    await press("Enter", alt: true)
    await until("closed", in: w) { !BoardPanes.search.isOpen }
    let doc = try #require(w.pane?.document)
    await until("a Note collected", in: w) { doc.board.cards.count == 3 }
    let note = try #require(doc.board.cards.last)
    guard case .own(let c) = note.content, case .note(let n) = c.body else {
      Issue.record("not a Note: \(note.content)")
      return
    }
    #expect(n.text.contains("mill on the coast ran on the tide"))
    #expect(c.source?.entry == EntryID(rawValue: "e-mills") && c.source?.place?.block == .page(1))

    // ↵: the entry opened in the reading pane
    try await open(w, "k")
    _ = await type(w, "tidal", rows: 1)
    await press("Enter")
    await until("its tab open", in: w) { w.shell.reading.tabs.map(\.title) == ["Tidal mills"] }
  }

  /// ⌘K's functions and classes come after the other groups, asked of the shell apart and merged in when they come
  /// without moving the row highlighted; Return opens one, ⌥ adds it to the board
  @Test func functionsAndClassesMergeInLastWithoutMovingTheHighlightedRow() async throws {
    let w = try await opened()
    defer { w.close() }
    try await open(w, "k")
    let s = BoardPanes.search
    let (gate, release) = AsyncStream<Void>.makeStream()
    nonisolated(unsafe) var asked: [String] = []
    s.onCode = { q in
      asked.append(q)
      for await _ in gate { break }
      return ["waiting_list", "Waiting"].map {
        SearchPanel.Symbol(
          label: $0, detail: "pkg/q.py:3", repository: "/r", name: "r", path: "pkg/q.py", start: 3, line: 3, end: 9,
          isClass: $0 == "Waiting")
      }
    }
    var picked: [(String, Bool)] = []
    s.onCodePick = { picked.append(($0.label, $1)) }
    _ = await type(w, "waiting", rows: 4)
    await press("ArrowDown")
    await press("ArrowDown")
    #expect(await shown()?.on == 2 && asked == ["waiting"])
    release.yield()
    await until("the code group", in: w) { await shown()?.rows.count == 6 }
    let found = try #require(await shown())
    #expect(found.groups == ["Cards on Boards", "Sidenotes", "Functions & Classes"])
    #expect(found.rows.suffix(2) == ["waiting_list", "Waiting"] && found.details.last == "pkg/q.py:3")
    #expect(found.on == 2 && found.rows[2] == "Waiting elsewhere", "the highlighted row stays")
    let foot = "return palette.state().foot"
    #expect(await s.run(foot) as? String == " Go to Card", "on a card")
    for _ in 0..<3 { await press("ArrowDown") }
    #expect(await s.run(foot) as? String == " Open | ⌥↵ Add to Board", "on a function: Return opens it, ⌥↵ adds it")
    await press("Enter")
    await until("opened", in: w) { !picked.isEmpty }
    #expect(picked.first?.0 == "Waiting" && picked.first?.1 == false)
    await press("ArrowUp")
    await press("Enter", alt: true)
    await until("added", in: w) { picked.count == 2 }
    #expect(picked.last?.0 == "waiting_list" && picked.last?.1 == true)
  }

  @Test func bothKeysAreInTheShortcutList() {
    let view = KeysPanel.rows().first { $0.name == "View" }?.rows ?? []
    #expect(view.prefix(2).map(\.key) == ["⌘K", "⌘F"])
    #expect(view.prefix(2).map(\.label) == ["Search", "Search This Board"])
  }
}

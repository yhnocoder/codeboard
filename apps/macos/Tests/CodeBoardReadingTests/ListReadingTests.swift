import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

@testable import CodeBoardReading

/// A vault in a temporary folder with the papers resource Reading list: three papers (one with two PDF versions, v2
/// added before v1, and a translation), a saved link, a page saved twice, and a PDF that is an entry alone; and a pane
/// on it, in a window, with a resource tab of the list kind. The pages' addresses are a port of the loopback nothing
/// listens on
@MainActor final class ListVault {
  let vault: Vault
  let resource: VaultResource
  let pane = ReadingPane()
  let paneView: ReadingPaneView
  let window: NSWindow
  let paper = Entry(
    id: EntryID(rawValue: "e-paper"), title: "Tidal mills", added: 1, origin: .arxiv("2401.00001"),
    authors: ["Ana Ruíz", "Bo Chen"], year: 2021,
    versions: [
      Version(id: VersionID(rawValue: "v2"), label: "v2", added: 1, content: .pdf(file: "v2.pdf")),
      Version(id: VersionID(rawValue: "v1"), label: "v1", added: 2, content: .pdf(file: "v1.pdf")),
      Version(id: VersionID(rawValue: "v2-zh"), added: 3, of: VersionID(rawValue: "v2"), content: .pdf(file: "zh.pdf")),
    ])
  let estuary = Entry(
    id: EntryID(rawValue: "e-estuary"), title: "Estuary flows", added: 4, authors: ["Cai Lun"], year: 2023)
  let weirs = Entry(id: EntryID(rawValue: "e-weirs"), title: "Weirs", added: 5, authors: ["Dee Okafor"], year: 2021)
  let link = Entry(
    id: EntryID(rawValue: "e-link"), title: "Harbour log", added: 2, origin: .web("http://127.0.0.1:9/harbour"))
  static let newer = String(repeating: "cd", count: 32)
  let saved = Entry(
    id: EntryID(rawValue: "e-saved"), title: "Quay plans", added: 3, origin: .web("http://127.0.0.1:9/quay"),
    versions: [
      Version(
        id: VersionID(rawValue: "v1"), added: 1, content: .page(hash: String(repeating: "ab", count: 32), bytes: 9)),
      Version(id: VersionID(rawValue: "v2"), added: 2, content: .page(hash: newer, bytes: 9)),
    ])
  var paperPath = ""

  init(empty: Bool = false) throws {
    ReadingKinds.registerBuiltIn()
    let root = FileManager.default.temporaryDirectory.appending(path: "list-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    vault = Vault(root: root)
    resource = try vault.newResource(in: "", title: "Reading list", preset: .papers)
    if !empty {
      paperPath = try vault.newEntry(paper, in: resource.path)
      for f in ["v1.pdf", "v2.pdf", "zh.pdf"] {
        try makePDF(["Page of \(f)"]).write(to: vault.url(of: "\(paperPath)/\(f)"))
      }
      for e in [estuary, weirs, link, saved] { try vault.newEntry(e, in: resource.path) }
      try makePDF(["Notes"]).write(to: vault.url(of: "\(resource.path)/Pier notes.pdf"))
    }
    pane.vault = vault
    pane.entries = EntryIndex(vault, try vault.tree())
    paneView = ReadingPaneView(pane: pane)
    window = NSWindow(
      contentRect: CGRect(x: 0, y: 0, width: 640, height: 600), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = paneView
  }

  func remove() {
    window.close()
    try? FileManager.default.removeItem(at: vault.root)
  }

  /// A resource's tab, as the shell opens it, and its view, with which boards its entries are on read
  func openList(_ r: VaultResource? = nil) async throws -> (ReadingTab.ID, ListTabView) {
    let r = r ?? resource
    let id = pane.open(
      r.title, key: "resource:\(r.id.rawValue)", kind: ListReading.kind, payload: ["resource": r.id.rawValue])
    paneView.sync()
    let view = try #require(paneView.views[id] as? ListTabView)
    await view.boardsRead?.value
    paneView.layoutSubtreeIfNeeded()
    view.layoutSubtreeIfNeeded()
    return (id, view)
  }

  /// What a tree read does to the pane's tabs (Shell.apply), and the boards read again
  func treeRead(_ list: ListTabView? = nil) async throws {
    pane.entries = EntryIndex(vault, try vault.tree())
    pane.follow { ReadingKinds.follow($0, in: pane) }
    await list?.boardsRead?.value
  }

  func anchor(_ e: Entry) -> SourceAnchor {
    SourceAnchor(entry: e.id, place: Place(version: VersionID(rawValue: "v1"), block: .page(1)))
  }

  func note(_ id: String, from e: Entry) -> Card {
    Card(
      id: CardID(rawValue: id), x: 0, y: 0, width: 200,
      content: .own(CardContent(source: anchor(e), body: .note(Note(text: "From \(e.title)")))))
  }
}

@MainActor private func key(_ special: Int, _ code: UInt16) -> NSEvent {
  NSEvent.keyEvent(
    with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil,
    characters: String(UnicodeScalar(special)!), charactersIgnoringModifiers: String(UnicodeScalar(special)!),
    isARepeat: false, keyCode: code)!
}

@MainActor private let down = key(NSDownArrowFunctionKey, 125)
@MainActor private let up = key(NSUpArrowFunctionKey, 126)
@MainActor private let returnKey = key(0x0D, 36)

/// A double-click on a row of the list's table, as the window delivers it. A single click is AppKit's own (the table
/// selects on it); its tracking loop is not run here, off screen
@MainActor private func doubleClick(_ list: ListTabView, row: Int) {
  let t = list.table
  let r = t.rect(ofRow: row)
  let at = t.convert(CGPoint(x: r.minX + 40, y: r.midY), to: nil)
  t.mouseDown(
    with: NSEvent.mouseEvent(
      with: .leftMouseDown, location: at, modifierFlags: [], timestamp: 0, windowNumber: t.window?.windowNumber ?? 0,
      context: nil, eventNumber: 0, clickCount: 2, pressure: 1)!)
}

@MainActor private func cell(_ list: ListTabView, _ column: String, _ row: Int) throws -> ListCell {
  let c = list.table.column(withIdentifier: NSUserInterfaceItemIdentifier(column))
  let cell = try #require(list.table.view(atColumn: c, row: row, makeIfNecessary: true) as? ListCell)
  cell.layoutSubtreeIfNeeded()
  return cell
}

@MainActor private func filter(_ list: ListTabView, _ text: String) {
  list.search.stringValue = text
  _ = list.search.sendAction(list.search.action, to: list.search.target)
}

@MainActor @Suite(.serialized) struct ListReadingTests {
  @Test func eachPresetHasItsColumns() throws {
    #expect(ListColumn.of(.papers).map(\.id) == ["title", "year", "boards"])
    #expect(ListColumn.of(.web).map(\.id) == ["title", "saved", "boards"])
    #expect(ListColumn.of(.files).map(\.id) == ["title", "size", "modified", "boards"])
    #expect(ListColumn.of(.files).map(\.title) == ["Name", "Size", "Modified", "Boards"])
    #expect(ListColumn.of(.papers).map { $0.detail != nil } == [true, false, false])
    #expect(ListColumn.of(.files).allSatisfy { $0.detail == nil })
  }

  /// A papers resource: the table's columns, the title over the authors on two lines, newest year first and then by
  /// title; the theme's ink, quieter on the second line
  @Test func aPapersListHasTwoLineTitlesAndIsSortedByYearThenTitle() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (id, list) = try await v.openList()
    #expect(list.table.tableColumns.map(\.title) == ["Title", "Year", "Boards"])
    #expect(
      list.rows.map(\.title) == ["Estuary flows", "Harbour log", "Pier notes", "Quay plans", "Tidal mills", "Weirs"])
    #expect(
      list.shown.map(\.title) == ["Estuary flows", "Tidal mills", "Weirs", "Harbour log", "Pier notes", "Quay plans"])
    #expect(
      list.table.sortDescriptors.map(\.key) == ["year", "title"] && list.table.sortDescriptors[0].ascending == false)
    #expect(list.table.rowHeight == 42 && list.empty.isHidden)
    #expect(v.pane.tabs.first { $0.id == id }?.icon == "list.bullet.rectangle")

    let title = try cell(list, "title", 1)
    #expect(title.line.stringValue == "Tidal mills" && title.detail.stringValue == "Ana Ruíz, Bo Chen")
    #expect(!title.detail.isHidden && title.detail.frame.minY >= title.line.frame.maxY && title.status.isHidden)
    #expect(try cell(list, "year", 1).line.stringValue == "2021")
    let ink = try #require(NSColor(cgColor: ReadingBarLook.warmInk(dark: false).ink))
    #expect(title.line.textColor == ink && title.detail.textColor == ink.withAlphaComponent(0.5))
    #expect(title.line.lineBreakMode == .byTruncatingTail)
  }

  /// A header clicked: that column first, its direction flipped on a second click; rows equal in it keep Finder's order
  @Test func aClickedHeaderSortsStably() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    // what the header does on a click: the column's prototype first, the others after
    let year = try #require(list.table.tableColumns[1].sortDescriptorPrototype)
    list.table.sortDescriptors = [year]
    #expect(
      list.shown.map(\.title) == ["Estuary flows", "Tidal mills", "Weirs", "Harbour log", "Pier notes", "Quay plans"])
    list.table.sortDescriptors = [year.reversedSortDescriptor as! NSSortDescriptor]
    #expect(
      list.shown.map(\.title) == ["Harbour log", "Pier notes", "Quay plans", "Tidal mills", "Weirs", "Estuary flows"])
    let title = try #require(list.table.tableColumns[0].sortDescriptorPrototype)
    list.table.sortDescriptors = [title.reversedSortDescriptor as! NSSortDescriptor]
    #expect(
      list.shown.map(\.title) == ["Weirs", "Tidal mills", "Quay plans", "Pier notes", "Harbour log", "Estuary flows"])
  }

  /// The filter matches titles and authors, ignoring case and accents, the selected row kept selected while it is shown;
  /// nothing matched says so; cleared, all are back
  @Test func theFilterMatchesTitlesAndAuthorsIgnoringCaseAndAccents() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    list.select(1)
    filter(list, "RUIZ")
    #expect(list.shown.map(\.title) == ["Tidal mills"] && list.selected == 0)
    filter(list, "okafor")
    #expect(list.shown.map(\.title) == ["Weirs"] && list.selected == nil)
    filter(list, "quay")
    #expect(list.shown.map(\.title) == ["Quay plans"])
    filter(list, "nothing like it")
    #expect(list.shown.isEmpty && !list.empty.isHidden && list.empty.stringValue == "No matches")
    filter(list, "")
    #expect(list.shown.count == 6 && list.empty.isHidden)
    #expect(list.search.frame.maxX == list.bounds.width - 12)
  }

  /// A web pages resource: the site under the title (its own, else the address's host), newest saving first
  @Test func aWebPagesListShowsTheSiteAndTheSavedDate() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let web = try v.vault.newResource(in: "", title: "Pages", preset: .web)
    let day: Double = 86_400_000
    let entries = [
      Entry(
        id: EntryID(rawValue: "w1"), title: "Harbour log", added: 100 * day, origin: .web("http://127.0.0.1:9/h"),
        meta: WebMeta(site: "Harbour Board")),
      Entry(
        id: EntryID(rawValue: "w2"), title: "Ferry times", added: 200 * day,
        origin: .web("https://ferries.example.org/times")),
      Entry(
        id: EntryID(rawValue: "w3"), title: "Quay plans", added: 50 * day, origin: .web("http://127.0.0.1:9/q"),
        versions: [
          Version(id: VersionID(rawValue: "v1"), added: 300 * day, content: .page(hash: ListVault.newer, bytes: 9))
        ]),
    ]
    for e in entries { try v.vault.newEntry(e, in: web.path) }
    let (_, list) = try await v.openList(web)
    #expect(list.table.tableColumns.map(\.title) == ["Title", "Saved", "Boards"] && list.table.rowHeight == 42)
    #expect(list.shown.map(\.title) == ["Quay plans", "Ferry times", "Harbour log"])
    #expect(list.shown.map(\.site) == ["127.0.0.1", "ferries.example.org", "Harbour Board"])
    #expect(list.shown[0].saved == Date(timeIntervalSince1970: 300 * 86_400))
    #expect(try cell(list, "title", 2).detail.stringValue == "Harbour Board")
    #expect(try cell(list, "saved", 2).line.stringValue == ListColumn.day(Date(timeIntervalSince1970: 100 * 86_400)))
    filter(list, "board")
    #expect(list.shown.map(\.title) == ["Harbour log"])
  }

  /// A files resource: one line a row, name, size and modified date, newest first
  @Test func aFilesListShowsNameSizeAndModifiedDate() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let files = try v.vault.newResource(in: "", title: "Files", preset: .files)
    let fm = FileManager.default
    func put(_ data: Data, _ path: String, day: Double) throws {
      try data.write(to: v.vault.url(of: path))
      try fm.setAttributes(
        [.modificationDate: Date(timeIntervalSince1970: day * 86_400)], ofItemAtPath: v.vault.url(of: path).path)
    }
    try put(Data("abc".utf8), "\(files.path)/Tide table.txt", day: 10)
    try put(makePDF(["Gauge"]), "\(files.path)/Gauge.pdf", day: 30)
    let gauges = try v.vault.newEntry(
      Entry(
        id: EntryID(rawValue: "f1"), title: "Readings", added: 1,
        versions: [Version(id: VersionID(rawValue: "v1"), added: 1, content: .file("r.csv"))]),
      in: files.path)
    try put(Data("1,2\n3,4\n".utf8), "\(gauges)/r.csv", day: 20)
    let (_, list) = try await v.openList(files)
    #expect(
      list.table.tableColumns.map(\.title) == ["Name", "Size", "Modified", "Boards"] && list.table.rowHeight == 28)
    #expect(list.shown.map(\.title) == ["Gauge", "Readings", "Tide table"])
    #expect(list.shown.map(\.size) == [list.shown[0].size, 8, 3] && list.shown[0].size ?? 0 > 0)
    let name = try cell(list, "title", 2)
    #expect(name.line.stringValue == "Tide table" && name.detail.isHidden)
    #expect(try cell(list, "size", 2).line.stringValue == ListColumn.size(3))
    #expect(try cell(list, "modified", 1).line.stringValue == ListColumn.day(Date(timeIntervalSince1970: 20 * 86_400)))
  }

  /// The boards column: a Note taken from an entry, an image card showing one of its blocks, a shared card's source
  /// (from its own file); after a board and the shared card change, a tree read brings the new boards
  @Test func theBoardsColumnNamesTheBoardsWithCardsFromEachEntry() async throws {
    let v = try ListVault()
    defer { v.remove() }
    try v.vault.newBoard(
      in: "", title: "Alpha", board: Board(id: BoardID(rawValue: "b-a"), cards: [v.note("c1", from: v.paper)]))
    let image = Card(
      id: CardID(rawValue: "c2"), x: 0, y: 0, width: 200,
      content: .own(CardContent(body: .image(ImageCard(source: .resource(v.anchor(v.saved)))))))
    let beta = try v.vault.newBoard(in: "", title: "Beta", board: Board(id: BoardID(rawValue: "b-b"), cards: [image]))
    try FileManager.default.createDirectory(at: v.vault.sharedFolderURL, withIntermediateDirectories: true)
    let sharedFile = v.vault.sharedFolderURL.appending(path: "sh1.json")
    let shared = v.note("sh1", from: v.link)
    guard case .own(let content) = shared.content else { return }
    try SharedCard(id: shared.id, content: content).encoded().write(to: sharedFile)
    let placed = Card(id: shared.id, x: 0, y: 0, width: 200, content: .shared)
    try v.vault.newBoard(in: "", title: "Gamma", board: Board(id: BoardID(rawValue: "b-c"), cards: [placed]))

    let (_, list) = try await v.openList()
    let by = { (t: String) in list.rows.first { $0.title == t }?.boards ?? [] }
    #expect(by("Tidal mills") == ["Alpha"] && by("Quay plans") == ["Beta"] && by("Harbour log") == ["Gamma"])
    #expect(by("Weirs").isEmpty && by("Pier notes").isEmpty)
    #expect(try cell(list, "boards", 1).line.stringValue == "Alpha")

    try Board(id: BoardID(rawValue: "b-b"), cards: [image, v.note("c3", from: v.paper)]).encoded()
      .write(to: v.vault.url(of: beta.path).appending(path: Vault.boardFileName))
    try SharedCard(
      id: shared.id, content: CardContent(source: v.anchor(v.paper), body: .note(Note(text: "Mills again")))
    )
    .encoded().write(to: sharedFile)
    try await v.treeRead(list)
    #expect(
      by("Tidal mills") == ["Alpha", "Beta", "Gamma"] && by("Harbour log").isEmpty && by("Quay plans") == ["Beta"])
  }

  @Test func boardNamesTruncateWithHowManyMore() {
    let font = NSFont.systemFont(ofSize: 12)
    let names = ["Board A", "Board B", "Board C", "Board D"]
    let two = ("Board A, Board B +2" as NSString).size(withAttributes: [.font: font]).width
    #expect(EntryBoards.fit(names, width: two, font: font) == "Board A, Board B +2")
    #expect(EntryBoards.fit(names, width: 1000, font: font) == "Board A, Board B, Board C, Board D")
    #expect(EntryBoards.fit(names, width: 4, font: font) == "Board A +3")
    #expect(EntryBoards.fit([], width: 100, font: font) == "")
  }

  /// A row selected opens nothing; ↑ ↓ move the selection; Return opens the selected row, a double-click the row
  /// clicked: a PDF alone, a paper at its newest version that is not a translation (once), a link
  /// online, a saved page at its newest saving (once)
  @Test func aClickSelectsAndADoubleClickOrReturnOpens() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (listTab, list) = try await v.openList()
    let at = { (t: String) in list.shown.firstIndex { $0.title == t }! }
    // what a single click does: it selects, and opens nothing
    list.select(at("Pier notes"))
    #expect(v.pane.tabs.count == 1)
    v.window.makeFirstResponder(list.table)
    list.table.keyDown(with: down)
    list.table.keyDown(with: up)
    #expect(list.selected == at("Pier notes"))
    list.table.keyDown(with: returnKey)
    #expect(
      v.pane.tabs.last?.payload == ["file": "\(v.resource.path)/Pier notes.pdf"] && v.pane.tabs.last?.kind == "pdf")
    #expect(v.pane.selected == v.pane.tabs.last?.id)

    for _ in 0..<2 {
      v.pane.select(listTab)
      v.paneView.sync()
      doubleClick(list, row: at("Tidal mills"))
    }
    let paper = try #require(v.pane.tabs.first { $0.title == "Tidal mills" })
    #expect(paper.payload == ["entry": "e-paper", "version": "v2"] && v.pane.selected == paper.id)
    #expect(v.pane.tabs.count(where: { $0.title == "Tidal mills" }) == 1 && list.selected == at("Tidal mills"))

    v.pane.select(listTab)
    v.paneView.sync()
    doubleClick(list, row: at("Harbour log"))
    #expect(
      v.pane.tabs.contains {
        $0.kind == "web" && $0.payload == ["url": "http://127.0.0.1:9/harbour"]
          && $0.key == "web:http://127.0.0.1:9/harbour"
      })

    let page = ["url": "http://127.0.0.1:9/quay", "hash": ListVault.newer, "title": "Quay plans"]
    for _ in 0..<2 {
      v.pane.select(listTab)
      v.paneView.sync()
      doubleClick(list, row: at("Quay plans"))
    }
    let saved = v.pane.tabs.filter { $0.key == "web:" + ListVault.newer }
    #expect(saved.count == 1 && saved.first?.kind == "web" && saved.first?.payload == page)
    #expect(saved.first?.title == "Quay plans" && v.pane.selected == saved.first?.id)
  }

  /// A tree read after an entry is added, renamed and removed: the rows follow, the selected one stays selected; the
  /// tab is renamed with its resource and closes when it is gone
  @Test func theListFollowsAnEntryAddedRenamedAndRemoved() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (id, list) = try await v.openList()
    list.select(list.shown.firstIndex { $0.title == "Quay plans" }!)
    try v.vault.newEntry(Entry(id: EntryID(rawValue: "e-new"), title: "Ferry times", added: 5), in: v.resource.path)
    try await v.treeRead(list)
    #expect(list.rows.map(\.title).first == "Estuary flows" && list.rows.map(\.title).contains("Ferry times"))
    let ferry = try #require(list.rows.first { $0.title == "Ferry times" })
    #expect(ferry.opens == nil && ferry.kind == "Entry")
    #expect(list.selected.map { list.shown[$0].title } == "Quay plans")

    var renamed = v.paper
    renamed.title = "Tide mills of the coast"
    try v.vault.write(renamed, at: v.paperPath)
    try await v.treeRead(list)
    #expect(list.shown[1].title == "Tide mills of the coast")

    try FileManager.default.removeItem(at: v.vault.url(of: "\(v.resource.path)/Pier notes.pdf"))
    try await v.treeRead(list)
    #expect(!list.shown.map(\.title).contains("Pier notes") && list.table.numberOfRows == 6)
    #expect(list.selected.map { list.shown[$0].title } == "Quay plans")

    try FileManager.default.moveItem(
      at: v.vault.url(of: v.resource.path), to: v.vault.root.appending(path: "Shelf.\(Vault.resourceExtension)"))
    try await v.treeRead(list)
    #expect(v.pane.tabs.first { $0.id == id }?.title == "Shelf")
    try FileManager.default.removeItem(at: v.vault.root.appending(path: "Shelf.\(Vault.resourceExtension)"))
    try await v.treeRead(list)
    #expect(!v.pane.tabs.contains { $0.id == id })
  }

  /// The selected row is an entry, not a place: an entry added before it, another sort, a filter keep it selected, and
  /// Return opens it; every sort is by what the rows show (an entry's title, not its folder's name)
  @Test func theSelectionFollowsItsEntryAndSortsAreByWhatIsShown() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let quay = { list.selected.map { list.shown[$0].title } }
    list.select(list.shown.firstIndex { $0.title == "Quay plans" }!)
    // its folder named "Zebra", its title "Aardvark"
    let zebra = try v.vault.newEntry(Entry(id: EntryID(rawValue: "e-z"), title: "Zebra", added: 9), in: v.resource.path)
    try v.vault.write(Entry(id: EntryID(rawValue: "e-z"), title: "Aardvark", added: 9), at: zebra)
    try await v.treeRead(list)
    #expect(quay() == "Quay plans" && list.rows.last?.title == "Aardvark")
    #expect(
      list.shown.map(\.title) == [
        "Estuary flows", "Tidal mills", "Weirs", "Aardvark", "Harbour log", "Pier notes", "Quay plans",
      ])
    list.table.sortDescriptors = [try #require(list.table.tableColumns[0].sortDescriptorPrototype)]
    #expect(list.shown.first?.title == "Aardvark" && quay() == "Quay plans")
    filter(list, "plans")
    #expect(list.shown.count == 1 && quay() == "Quay plans")
    filter(list, "")
    #expect(quay() == "Quay plans")
    list.table.keyDown(with: returnKey)
    #expect(v.pane.tabs.last?.key == "web:" + ListVault.newer && v.pane.selected == v.pane.tabs.last?.id)
  }

  /// A paper known by its DOI or arXiv number without its PDF says it is a paper, shows its title, authors and year, and
  /// opens its page online
  @Test func aPaperWithoutItsPDFSaysWhatItIsAndOpensOnline() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    try v.vault.newEntry(
      Entry(
        id: EntryID(rawValue: "e-doi"), title: "Sluice gates", added: 1, origin: .doi("10.1000/xyz"),
        authors: ["Eva Lind"], year: 2019),
      in: v.resource.path)
    try v.vault.newEntry(
      Entry(id: EntryID(rawValue: "e-ax"), title: "Locks", added: 2, origin: .arxiv("2402.00002"), year: 2024),
      in: v.resource.path)
    let (_, list) = try await v.openList()
    #expect(list.shown.map(\.title) == ["Locks", "Sluice gates"] && list.shown.allSatisfy { $0.kind == "Paper" })
    let c = try cell(list, "title", 1)
    #expect(c.line.stringValue == "Sluice gates" && c.detail.stringValue == "Eva Lind")
    let year = try cell(list, "year", 1)
    #expect(c.accessibilityLabel() == "Sluice gates, Paper" && year.line.stringValue == "2019")
    list.open(1)
    #expect(v.pane.tabs.last?.kind == "web" && v.pane.tabs.last?.payload == ["url": "https://doi.org/10.1000/xyz"])
    #expect(list.shown[0].opens == .web(.online(URL(string: "https://arxiv.org/abs/2402.00002"))))
  }

  /// A board's source that is a whole entry with its PDF and a translation listed first opens what its row opens: the
  /// PDF, not the translation
  @Test func aWholeEntryRevealedFromTheBoardOpensWhatItsRowOpens() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let e = Entry(
      id: EntryID(rawValue: "e-mill"), title: "Mill races", added: 1,
      versions: [
        Version(id: VersionID(rawValue: "zh"), added: 2, of: VersionID(rawValue: "v1"), content: .pdf(file: "zh.pdf")),
        Version(id: VersionID(rawValue: "v1"), added: 1, content: .pdf(file: "v1.pdf")),
      ])
    let path = try v.vault.newEntry(e, in: v.resource.path)
    for f in ["v1.pdf", "zh.pdf"] { try makePDF(["Page of \(f)"]).write(to: v.vault.url(of: "\(path)/\(f)")) }
    v.pane.entries = EntryIndex(v.vault, try v.vault.tree())
    let (_, list) = try await v.openList()
    let original = PDFTarget.entry(e.id, version: VersionID(rawValue: "v1"))
    #expect(list.shown.first?.opens == .pdf(original))
    ReadingSources(pane: v.pane).reveal(SourceAnchor(entry: e.id))
    #expect(v.pane.tabs.last?.key == original.key && v.pane.selected == v.pane.tabs.last?.id)
  }

  /// A PDF opened from the list and closed: the list shown again has what the resource holds now
  @Test func theListShownAgainAfterATabFromItClosesIsUpToDate() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (listTab, list) = try await v.openList()
    list.open(list.shown.firstIndex { $0.title == "Pier notes" }!)
    v.paneView.sync()
    try makePDF(["Gulls"]).write(to: v.vault.url(of: "\(v.resource.path)/Gull counts.pdf"))
    v.pane.close(try #require(v.pane.selected))
    v.paneView.sync()
    #expect(v.pane.selected == listTab && !list.isHidden)
    #expect(list.rows.map(\.title).contains("Gull counts"))
  }

  /// A paper's translation that failed: its row says so, with the reason under the title and Retry, which queues it
  /// again
  @Test func aFailedTranslationShowsOnItsRowWithRetry() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let machine = FileManager.default.temporaryDirectory.appending(path: "machine-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: machine) }
    // a tongtu whose doctor fails at once
    let queue = Translations(folder: machine, tongtu: { URL(filePath: "/usr/bin/false") }, poll: .milliseconds(20))
    v.pane.translations = queue
    let (_, list) = try await v.openList()
    let row = list.shown.firstIndex { $0.title == "Tidal mills" }!
    #expect(try cell(list, "title", row).status.isHidden)
    let job = try #require(TranslationJob(vault: v.vault, entry: v.paper, version: v.paper.versions[0]))
    queue.add(job)
    await queue.settled()
    let c = try cell(list, "title", row)
    #expect(c.status.stringValue == "译文 · 失败" && !c.status.isHidden && !c.retry.isHidden)
    #expect(c.detail.stringValue == "doctor: tongtu doctor stopped (exit status 1).")
    #expect(c.retry.frame.maxX <= c.bounds.width && c.line.frame.maxX <= c.status.frame.minX)
    c.retry.performClick(nil)
    #expect(queue.state(of: job) == .waiting)
    #expect(try cell(list, "title", row).status.stringValue == "译文 · 排队中")
    await queue.settled()
  }

  @Test func anEmptyResourceSaysSoQuietly() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let (_, list) = try await v.openList()
    #expect(list.rows.isEmpty && list.table.numberOfRows == 0)
    #expect(
      !list.empty.isHidden && list.empty.stringValue == "Drop PDFs here or paste an arXiv address"
        && list.empty.font?.pointSize == 12)
    list.table.keyDown(with: down)
    list.table.keyDown(with: returnKey)
    #expect(list.selected == nil && v.pane.tabs.count == 1)
    v.pane.barLook = .inkWash(dark: true)
    v.paneView.sync()
    #expect(list.empty.textColor == NSColor(cgColor: ReadingBarLook.inkWash(dark: true).ink)?.withAlphaComponent(0.45))
  }
}

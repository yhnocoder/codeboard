import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

@testable import CodeBoardReading

/// A drag as the window hands it to the list: what a test wrote on a pasteboard of its own; no dragging session
@MainActor private final class ListDrag: NSObject, @MainActor NSDraggingInfo {
  let draggingPasteboard = NSPasteboard(name: NSPasteboard.Name("list-drag-\(UUID().uuidString)"))
  init(_ write: (NSPasteboard) -> Void) {
    draggingPasteboard.clearContents()
    write(draggingPasteboard)
  }
  convenience init(files: [URL]) { self.init { $0.writeObjects(files as [NSURL]) } }
  var draggingLocation = NSPoint(x: 100, y: 100)
  var draggingDestinationWindow: NSWindow? { nil }
  var draggingSourceOperationMask: NSDragOperation { .copy }
  var draggedImageLocation: NSPoint { draggingLocation }
  var draggedImage: NSImage? { nil }
  var draggingSource: Any? { nil }
  var draggingSequenceNumber: Int { 1 }
  func slideDraggedImage(to screenPoint: NSPoint) {}
  var draggingFormation: NSDraggingFormation {
    get { .default }
    set {}
  }
  var animatesToDestination: Bool {
    get { false }
    set {}
  }
  var numberOfValidItemsForDrop: Int {
    get { 1 }
    set {}
  }
  func enumerateDraggingItems(
    options enumOpts: NSDraggingItemEnumerationOptions = [], for view: NSView?, classes classArray: [AnyClass],
    searchOptions: [NSPasteboard.ReadingOptionKey: Any] = [:],
    using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void
  ) {}
  var springLoadingHighlight: NSSpringLoadingHighlight { .none }
  func resetSpringLoading() {}
}

/// Files outside the vault to add from, made up for each test
private final class Outside {
  let dir = FileManager.default.temporaryDirectory.appending(path: "outside-\(UUID().uuidString)")

  init() throws { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }

  func file(_ name: String, _ data: Data = Data("tide".utf8)) throws -> URL {
    let u = dir.appending(path: name)
    try data.write(to: u)
    return u
  }

  func remove() { try? FileManager.default.removeItem(at: dir) }
}

/// Dropped on the list: whether it showed it would take it (its ring lit) and whether it took it
@MainActor private func drop(_ list: ListTabView, _ drag: ListDrag) -> (offered: Bool, took: Bool) {
  let offered = list.draggingEntered(drag) == .copy
  #expect(list.dropRing.isHidden == !offered)
  let took = list.performDragOperation(drag)
  #expect(list.dropRing.isHidden)
  return (offered, took)
}

/// What the + button's chooser was asked for, and what it gives
@MainActor private final class Chooser {
  var asked: [ResourcePreset] = []
  var give: [URL] = []
}

@MainActor private func selectedKey(_ list: ListTabView) -> String? { list.selected.map { list.shown[$0].key } }

/// The pane given a pasteboard of its own, holding what `write` put on it, and ⌘V sent to the list
@MainActor private func paste(_ v: ListVault, _ list: ListTabView, _ write: (NSPasteboard) -> Void) {
  let pb = NSPasteboard(name: NSPasteboard.Name("list-paste-\(UUID().uuidString)"))
  pb.clearContents()
  write(pb)
  v.pane.pasteboard = pb
  list.paste(nil)
}

// Adding to a resource from its list: files dropped, an address or files pasted, files chosen with +; what each preset
// takes and refuses; the first added selected; the empty list says how
@MainActor @Suite(.serialized) struct ListAddingTests {
  /// PDFs dropped on a papers list: each a paper entry titled from the PDF (here its name), the first selected, the
  /// filter that hid it cleared
  @Test func pdfsDroppedOnAPapersListAreAddedAndTheFirstIsSelected() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let out = try Outside()
    defer { out.remove() }
    let (_, list) = try await v.openList()
    list.search.stringValue = "gull"
    list.filterChanged()
    let pdfs = [try out.file("Weir survey.pdf", makePDF(["Weir"])), try out.file("Bay survey.pdf", makePDF(["Bay"]))]
    #expect(drop(list, ListDrag(files: pdfs)) == (true, true))
    #expect(
      list.rows.map(\.title).sorted() == ["Bay survey", "Weir survey"] && list.rows.allSatisfy { $0.kind == "PDF" })
    #expect(list.search.stringValue.isEmpty)
    #expect(selectedKey(list) == "\(v.resource.path)/Weir survey")
    #expect(FileManager.default.fileExists(atPath: pdfs[0].path), "a copy is added; the file stays where it was")
  }

  /// A drop with one file a papers list does not take is not taken at all: nothing of it is added
  @Test func aPapersListRefusesADropWithAFileThatIsNotAPDF() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let out = try Outside()
    defer { out.remove() }
    let (_, list) = try await v.openList()
    let files = [try out.file("Bay survey.pdf", makePDF(["Bay"])), try out.file("Tide table.txt")]
    #expect(drop(list, ListDrag(files: files)) == (false, false))
    #expect(try v.vault.items(in: v.resource.path).isEmpty && list.rows.isEmpty)
  }

  /// A files list takes any file, but not a folder (it would not be an entry)
  @Test func aFilesListTakesAnyFileButNotAFolder() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let out = try Outside()
    defer { out.remove() }
    let files = try v.vault.newResource(in: "", title: "Files", preset: .files)
    let (_, list) = try await v.openList(files)
    let folder = out.dir.appending(path: "Gauges")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
    #expect(drop(list, ListDrag(files: [try out.file("Tide table.txt"), folder])) == (false, false))
    #expect(list.rows.isEmpty)
    let csv = try out.file("Readings.csv", Data("1,2\n".utf8))
    #expect(drop(list, ListDrag(files: [csv, try out.file("Tide table.txt")])) == (true, true))
    #expect(list.rows.map(\.title) == ["Readings", "Tide table"] && selectedKey(list) == "\(files.path)/Readings.csv")
    // the same file again: not copied again, its row selected
    list.table.deselectAll(nil)
    #expect(drop(list, ListDrag(files: [csv])) == (true, true))
    #expect(list.rows.count == 2 && selectedKey(list) == "\(files.path)/Readings.csv")
    // the same size, other content: added
    #expect(drop(list, ListDrag(files: [try out.file("Tide table.txt", Data("tidf".utf8))])) == (true, true))
    #expect(list.rows.count == 3 && selectedKey(list) == "\(files.path)/Tide table 2.txt")
  }

  /// A file with the content of one the resource has (a file alone or an entry's PDF), under any name, is not added
  /// again: its row is selected; in a batch, the new ones are added (a PDF to papers: a paper entry) and the first of
  /// them selected
  @Test func aFileTheResourceHasAlreadyIsNotAddedAgain() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let out = try Outside()
    defer { out.remove() }
    let (_, list) = try await v.openList()
    let count = list.rows.count
    let notes = try out.file("Notes copy.pdf", Data(contentsOf: v.vault.url(of: "\(v.resource.path)/Pier notes.pdf")))
    let mills = try out.file("Mills.pdf", Data(contentsOf: v.vault.url(of: "\(v.paperPath)/v1.pdf")))
    #expect(drop(list, ListDrag(files: [notes, mills])) == (true, true))
    #expect(list.rows.count == count && selectedKey(list) == "\(v.resource.path)/Pier notes.pdf")
    #expect(drop(list, ListDrag(files: [mills, try out.file("Bay survey.pdf", makePDF(["Bay"]))])) == (true, true))
    #expect(list.rows.count == count + 1 && selectedKey(list) == "\(v.resource.path)/Bay survey")
  }

  /// Two files of one content in one batch, under other names: only the first is added
  @Test func aBatchAddsOneFileOfEachContent() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let out = try Outside()
    defer { out.remove() }
    let (_, list) = try await v.openList()
    let bay = makePDF(["Bay"])
    let pdfs = [try out.file("Bay survey.pdf", bay), try out.file("Bay copy.pdf", bay)]
    #expect(drop(list, ListDrag(files: pdfs)) == (true, true))
    #expect(list.rows.map(\.title) == ["Bay survey"] && selectedKey(list) == "\(v.resource.path)/Bay survey")
  }

  /// A web pages list takes no file; addresses pasted (one a line) or dropped become link entries, an address saved
  /// already its entry selected again; words that are not an address add nothing
  @Test func aWebListTakesAddressesPastedOrDroppedAndNoFile() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let out = try Outside()
    defer { out.remove() }
    let web = try v.vault.newResource(in: "", title: "Pages", preset: .web)
    let (_, list) = try await v.openList(web)
    #expect(list.addButton.isHidden && list.empty.stringValue == "Paste or drop an address here")
    #expect(drop(list, ListDrag(files: [try out.file("Tide table.txt")])) == (false, false))
    paste(v, list) { $0.setString("https://ferries.example.org/times\n  harbour.example.org/log\n", forType: .string) }
    let entries = try v.vault.items(in: web.path).compactMap { i -> Entry? in
      if case .entry(let e, _) = i { e } else { nil }
    }
    let origins = entries.compactMap(\.origin)
    #expect(origins.count == 2 && origins.contains(.web("https://ferries.example.org/times")))
    #expect(origins.contains(.web("https://harbour.example.org/log")))
    #expect(entries.allSatisfy { $0.versions.isEmpty } && v.pane.entries.all.count == 2)
    #expect(list.rows.map(\.title).sorted() == ["ferries.example.org/times", "harbour.example.org/log"])
    #expect(list.selected.map { list.shown[$0].title } == "ferries.example.org/times")
    // a link dragged in from a browser, already saved: its entry, selected
    list.table.deselectAll(nil)
    let link = ListDrag { $0.writeObjects([URL(string: "https://harbour.example.org/log")! as NSURL]) }
    #expect(drop(list, link) == (true, true))
    #expect(list.rows.count == 2 && list.selected.map { list.shown[$0].title } == "harbour.example.org/log")
    paste(v, list) { $0.setString("tide tables for the bay", forType: .string) }
    #expect(list.rows.count == 2)
  }

  /// An arXiv address pasted in a papers list: the paper's metadata and newest PDF from arXiv (its fake here), a new
  /// entry, selected; pasted again, the same entry
  @Test func anArxivAddressPastedInAPapersListAddsThePaper() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    v.pane.arxiv = fakeArxiv(latest: 3)
    let (_, list) = try await v.openList()
    paste(v, list) { $0.setString("https://arxiv.org/abs/1706.03762", forType: .string) }
    #expect(list.note.stringValue == "Adding arXiv 1706.03762…")
    await list.adding?.value
    #expect(list.note.stringValue.isEmpty)
    let row = try #require(list.selected.map { list.shown[$0] })
    #expect(row.title == "Attention Is All You Need" && row.year == 2017 && row.kind == "PDF")
    let found = try #require(v.pane.entries.arxiv("1706.03762"))
    #expect(found.entry.versions.map(\.label) == ["v3"] && row.key == found.path)
    list.table.deselectAll(nil)
    list.adding = nil
    paste(v, list) { $0.setString("arXiv:1706.03762v1", forType: .string) }
    #expect(list.adding == nil && list.rows.count == 1 && selectedKey(list) == found.path)
  }

  /// A DOI pasted in a papers list: its metadata from doi.org (its fake here), a new entry without a PDF, selected
  @Test func aDOIPastedInAPapersListAddsThePaper() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    v.pane.doi = DOI { req in
      let body = #"{"title": "Weirs of the Bay", "author": [{"given": "Ada", "family": "Brook"}]}"#
      return (Data(body.utf8), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    let (_, list) = try await v.openList()
    paste(v, list) { $0.setString("https://doi.org/10.1000/xyz", forType: .string) }
    #expect(list.note.stringValue == "Adding DOI 10.1000/xyz…")
    await list.adding?.value
    let found = try #require(v.pane.entries.doi("10.1000/xyz"))
    #expect(found.entry.title == "Weirs of the Bay" && found.entry.versions.isEmpty)
    #expect(list.note.stringValue.isEmpty && selectedKey(list) == found.path && list.rows.count == 1)
  }

  /// A PDF dropped on a papers list is titled from the PDF itself (its document info here)
  @Test func aPDFDroppedOnAPapersListIsAPaperTitledFromThePDF() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let out = try Outside()
    defer { out.remove() }
    let (_, list) = try await v.openList()
    let pdf = try out.file(
      "scan 7.pdf", makePaperPDF(title: nil, body: "Weirs.", info: ("Weirs of the Bay", "Ada Brook")))
    #expect(drop(list, ListDrag(files: [pdf])) == (true, true))
    let items = try v.vault.items(in: v.resource.path)
    guard case .entry(let e, let path)? = items.first, items.count == 1 else {
      Issue.record("\(items)")
      return
    }
    #expect(e.title == "Weirs of the Bay" && e.authors == ["Ada Brook"] && selectedKey(list) == path)
  }

  /// A drop whose second PDF cannot be read adds none of it, and the bar says why
  @Test func aDropWhoseSecondPDFCannotBeReadAddsNothing() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let out = try Outside()
    defer { out.remove() }
    let (_, list) = try await v.openList()
    let locked = try out.file("Bay survey.pdf", makePDF(["Bay"]))
    try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: locked.path)
    #expect(drop(list, ListDrag(files: [try out.file("Weir survey.pdf", makePDF(["Weir"])), locked])) == (true, true))
    #expect(try v.vault.items(in: v.resource.path).isEmpty && list.rows.isEmpty)
    #expect(list.note.stringValue.hasPrefix("The files could not be added"))
  }

  /// arXiv not having the paper: nothing added, and the bar says why
  @Test func anArxivPaperThatCannotBeFetchedAddsNothingAndSaysWhy() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    v.pane.arxiv = Arxiv { req in
      (Data(), HTTPURLResponse(url: req.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
    }
    let (_, list) = try await v.openList()
    paste(v, list) { $0.setString("2401.99999", forType: .string) }
    await list.adding?.value
    #expect(list.note.stringValue.hasPrefix("arXiv has no paper") && list.note.toolTip == list.note.stringValue)
    #expect(try v.vault.items(in: v.resource.path).isEmpty)
  }

  /// Files pasted (copied in Finder) are added as if dropped, refused as a drop would be
  @Test func filesPastedAreAddedAsIfDropped() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let out = try Outside()
    defer { out.remove() }
    let (_, list) = try await v.openList()
    let txt = try out.file("Tide table.txt")
    paste(v, list) { $0.writeObjects([txt as NSURL]) }
    #expect(list.rows.isEmpty)
    let pdf = try out.file("Bay survey.pdf", makePDF(["Bay"]))
    paste(v, list) { $0.writeObjects([pdf as NSURL]) }
    #expect(list.rows.map(\.title) == ["Bay survey"] && selectedKey(list) == "\(v.resource.path)/Bay survey")
  }

  /// + beside the filter: what its chooser gives added, as a drop would be; nothing chosen, nothing added
  @Test func theAddButtonAddsWhatItsChooserGives() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let out = try Outside()
    defer { out.remove() }
    let (_, list) = try await v.openList()
    #expect(!list.addButton.isHidden && list.addButton.toolTip == "Add PDFs…")
    #expect(list.addButton.frame.maxX < list.search.frame.minX && list.addButton.frame.midY == list.search.frame.midY)
    let chooser = Chooser()
    list.choose = { preset, _ in
      chooser.asked.append(preset)
      return chooser.give
    }
    list.addButton.performClick(nil)
    await list.choosing?.value
    #expect(chooser.asked == [.papers] && list.rows.isEmpty)
    chooser.give = [try out.file("Bay survey.pdf", makePDF(["Bay"]))]
    list.addButton.performClick(nil)
    await list.choosing?.value
    #expect(list.rows.map(\.title) == ["Bay survey"] && selectedKey(list) == "\(v.resource.path)/Bay survey")
  }

  /// The empty list's one line says how to add to it, by its preset
  @Test func anEmptyListSaysHowToAddToIt() async throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let (_, papers) = try await v.openList()
    #expect(papers.empty.stringValue == "Drop PDFs here or paste an arXiv address or DOI" && !papers.empty.isHidden)
    let files = try v.vault.newResource(in: "", title: "Files", preset: .files)
    let (_, list) = try await v.openList(files)
    #expect(list.empty.stringValue == "Drop files here or add them with +" && list.addButton.toolTip == "Add Files…")
  }
}

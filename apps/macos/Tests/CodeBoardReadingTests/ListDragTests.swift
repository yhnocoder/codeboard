import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

@testable import CodeBoardReading

// A row dragged out of the list onto a board (ListDrag.swift): what each kind of row puts on the pasteboard, read back
// from a pasteboard of the test's own

/// What the table would drag for the row titled `title`, written on a pasteboard of its own
@MainActor private func dragged(_ list: ListTabView, _ title: String) throws -> NSPasteboard? {
  let i = try #require(list.shown.firstIndex { $0.title == title })
  guard let item = list.tableView(list.table, pasteboardWriterForRow: i) else { return nil }
  let pb = NSPasteboard(name: NSPasteboard.Name("list-out-\(UUID().uuidString)"))
  pb.clearContents()
  pb.writeObjects([item])
  return pb
}

@MainActor @Suite(.serialized) struct ListDragTests {
  @Test func aPaperIsANoteOfItsTitleAndAuthorsWithTheWholeEntryAsItsSource() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    for (title, id, byline) in [
      ("Tidal mills", "e-paper", "\nAna Ruíz, Bo Chen"), ("Estuary flows", "e-estuary", "\nCai Lun"),
    ] {
      let pb = try #require(try dragged(list, title))
      defer { pb.releaseGlobally() }
      let c = try #require(Collected(from: pb))
      #expect(c.body == .note(markdown: "**\(title)**\(byline)"))
      #expect(c.source == SourceAnchor(entry: EntryID(rawValue: id), place: nil) && c.title == title && c.label == "")
      #expect(pb.string(forType: .string) == title)
    }
  }

  @Test func aWebPageCarriesItsAddress() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    for (title, address) in [("Harbour log", "http://127.0.0.1:9/harbour"), ("Quay plans", "http://127.0.0.1:9/quay")] {
      let pb = try #require(try dragged(list, title))
      defer { pb.releaseGlobally() }
      #expect((pb.readObjects(forClasses: [NSURL.self]) as? [URL])?.first?.absoluteString == address)
      #expect(pb.string(forType: .string) == address && pb.data(forType: .collected) == nil)
    }
  }

  /// Rows selected together drag together, as the table drags them: each row's writer its own item
  @Test func twoRowsSelectedAreTwoItems() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let rows = try ["Tidal mills", "Harbour log"].map { t in try #require(list.shown.firstIndex { $0.title == t }) }
    list.table.selectRowIndexes(IndexSet(rows), byExtendingSelection: false)
    let pb = NSPasteboard(name: NSPasteboard.Name("list-out-\(UUID().uuidString)"))
    defer { pb.releaseGlobally() }
    pb.clearContents()
    pb.writeObjects(list.table.selectedRowIndexes.compactMap { list.tableView(list.table, pasteboardWriterForRow: $0) })
    let items = try #require(pb.pasteboardItems)
    #expect(items.count == 2)
    #expect(items.contains { $0.data(forType: .collected) != nil })
    #expect(items.contains { $0.string(forType: .URL) == "http://127.0.0.1:9/harbour" })
  }

  @Test func titlesAndAuthorsShowLiterallyAndNoAuthorsMeansOneLine() {
    var row = ListRow(
      .entry(Entry(id: EntryID(rawValue: "e"), title: "a*b*_c_ [[x]] $y$ ==z== <i> `q` \\ & #1", added: 1), path: "p"),
      vault: nil)
    #expect(
      row.collected(EntryID(rawValue: "e")).body
        == .note(markdown: ##"**a\*b\*\_c\_ \[\[x\]\] \$y\$ \=\=z\=\= \<i\> \`q\` \\ \& \#1**"##))
    row.authors = ["O'Neil_2", "Li*"]
    #expect(row.collected(EntryID(rawValue: "e")).body.markdown?.hasSuffix(#"\#nO'Neil\_2, Li\*"#) == true)
  }

  @Test func filesAndUnreadableItemsAreNotDragged() {
    let file = Entry(
      id: EntryID(rawValue: "e-f"), title: "Tide table", added: 1,
      versions: [Version(id: VersionID(rawValue: "v1"), added: 1, content: .file("table.csv"))])
    for item in [
      ResourceItem.entry(file, path: "r/Tide table"), .file(path: "r/table.csv"),
      .unreadable(path: "r/x", reason: "bad"),
    ] {
      #expect(ListRow(item, vault: nil).dragItem == nil, "\(item)")
    }
  }

  @Test func aPDFThatIsAFileAloneBecomesAnEntryFirstUnlessATabHasItAsAFile() async throws {
    let v = try ListVault()
    defer { v.remove() }
    let (_, list) = try await v.openList()
    let path = "\(v.resource.path)/Pier notes.pdf"
    // open in a tab as a file: that tab would lose it, so no drag and the file stays
    list.open(try #require(list.shown.firstIndex { $0.title == "Pier notes" }))
    let tab = try #require(v.pane.tabs.last { $0.payload == ["file": path] })
    #expect(try dragged(list, "Pier notes") == nil)
    #expect(FileManager.default.fileExists(atPath: v.vault.url(of: path).path))
    v.pane.close(tab.id)
    let pb = try #require(try dragged(list, "Pier notes"))
    defer { pb.releaseGlobally() }
    let c = try #require(Collected(from: pb))
    let id = try #require(c.source?.entry)
    #expect(c.source?.place == nil && c.body == .note(markdown: "**Pier notes**"))
    let found = try #require(v.pane.entries[id], "the board's source provider finds it")
    #expect(found.entry.title == "Pier notes" && !FileManager.default.fileExists(atPath: v.vault.url(of: path).path))
    #expect(try v.vault.entry(at: found.path).id == id)
    // the drag over: the list shows it as an entry
    list.tableView(list.table, draggingSession: NSDraggingSession(), endedAt: .zero, operation: [])
    #expect(list.rows.first { $0.title == "Pier notes" }?.id == id)
  }
}

extension Collected.Body {
  fileprivate var markdown: String? { if case .note(let md) = self { md } else { nil } }
}

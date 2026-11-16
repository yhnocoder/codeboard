import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import Testing

@testable import CodeBoardReading

/// A vault in a temporary folder with the resource Reading list: a paper with two PDF versions (v2 added before v1)
/// and a translation, a saved link, a page saved twice, and a PDF that is an entry alone; and a pane on it with a
/// resource tab of the list kind. The pages' addresses are a port of the loopback nothing listens on
@MainActor final class ListVault {
  let vault: Vault
  let resource: VaultResource
  let pane = ReadingPane()
  let paneView: ReadingPaneView
  let paper = Entry(
    id: EntryID(rawValue: "e-paper"), title: "Tidal mills", added: 1, origin: .arxiv("2401.00001"),
    versions: [
      Version(id: VersionID(rawValue: "v2"), label: "v2", added: 1, content: .pdf(file: "v2.pdf")),
      Version(id: VersionID(rawValue: "v1"), label: "v1", added: 2, content: .pdf(file: "v1.pdf")),
      Version(id: VersionID(rawValue: "v2-zh"), added: 3, of: VersionID(rawValue: "v2"), content: .pdf(file: "zh.pdf")),
    ])
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
      try vault.newEntry(link, in: resource.path)
      try vault.newEntry(saved, in: resource.path)
      try makePDF(["Notes"]).write(to: vault.url(of: "\(resource.path)/Pier notes.pdf"))
    }
    pane.vault = vault
    pane.entries = EntryIndex(vault, try vault.tree())
    paneView = ReadingPaneView(pane: pane)
    paneView.frame = CGRect(x: 0, y: 0, width: 420, height: 600)
  }

  func remove() { try? FileManager.default.removeItem(at: vault.root) }

  /// The resource's tab, as the shell opens it, and its view
  func openList() throws -> (ReadingTab.ID, ListTabView) {
    let id = pane.open(
      resource.title, key: "resource:\(resource.id.rawValue)", kind: ListReading.kind,
      payload: ["resource": resource.id.rawValue])
    paneView.sync()
    let view = try #require(paneView.views[id] as? ListTabView)
    view.layoutSubtreeIfNeeded()
    return (id, view)
  }

  /// What a tree read does to the pane's tabs (Shell.apply)
  func treeRead() throws {
    pane.entries = EntryIndex(vault, try vault.tree())
    pane.follow { ReadingKinds.follow($0, in: pane) }
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
@MainActor private let click = NSEvent.mouseEvent(
  with: .leftMouseDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0,
  clickCount: 1, pressure: 1)!

@MainActor @Suite(.serialized) struct ListReadingTests {
  @Test func aResourcesTabHasARowForEachEntryWithItsTitleAndKind() throws {
    let v = try ListVault()
    defer { v.remove() }
    let (id, list) = try v.openList()
    #expect(list.rows.map(\.title) == ["Harbour log", "Pier notes", "Quay plans", "Tidal mills"], "Finder's order")
    #expect(list.rows.map(\.kind) == ["Web page", "PDF", "Saved page", "PDF"])
    #expect(list.rowViews.map(\.title.stringValue) == list.rows.map(\.title) && list.empty.isHidden)
    #expect(
      list.rowViews[1].accessibilityLabel() == "Pier notes, PDF" && list.rowViews[1].accessibilityRole() == .button)
    #expect(v.pane.tabs.first { $0.id == id }?.icon == "list.bullet.rectangle")
    // Warm Ink light, the pane's look until the shell sets another
    let ink = try #require(NSColor(cgColor: ReadingBarLook.warmInk(dark: false).ink))
    #expect(list.rowViews[0].title.textColor == ink && list.rowViews[0].kind.textColor == ink.withAlphaComponent(0.5))
    let frames = list.rowViews.map(\.frame)
    #expect(frames.allSatisfy { $0.height == ListTabView.rowHeight && $0.width > 0 } && frames[0].minY < frames[1].minY)
  }

  /// ↓ ↓ Return opens the second row's PDF, a file alone; a click on the paper opens it at its newest version by its
  /// arXiv number that is not a translation; going back to the list and clicking it again goes to the tab already open;
  /// a saved link opens online, a saved page at its newest saving, once
  @Test func returnAndAClickOpenTheRightEntry() throws {
    let v = try ListVault()
    defer { v.remove() }
    let (listTab, list) = try v.openList()
    list.keyDown(with: down)
    list.keyDown(with: down)
    list.keyDown(with: up)
    list.keyDown(with: down)
    #expect(list.selected == 1)
    list.keyDown(with: returnKey)
    #expect(
      v.pane.tabs.last?.payload == ["file": "\(v.resource.path)/Pier notes.pdf"] && v.pane.tabs.last?.kind == "pdf")
    #expect(v.pane.selected == v.pane.tabs.last?.id)

    v.pane.select(listTab)
    v.paneView.sync()
    list.rowViews[3].mouseDown(with: click)
    let paper = try #require(v.pane.tabs.first { $0.title == "Tidal mills" })
    #expect(paper.payload == ["entry": "e-paper", "version": "v2"] && v.pane.selected == paper.id)
    #expect(list.selected == 3)
    v.pane.select(listTab)
    list.rowViews[3].mouseDown(with: click)
    #expect(v.pane.tabs.count(where: { $0.title == "Tidal mills" }) == 1 && v.pane.selected == paper.id)

    // a saved link opens in a web tab on its address
    v.pane.select(listTab)
    v.paneView.sync()
    #expect(list.rowViews[0].accessibilityPerformPress())
    #expect(v.pane.tabs.contains { $0.kind == "web" && $0.payload == ["url": "http://127.0.0.1:9/harbour"] })

    let page = ["url": "http://127.0.0.1:9/quay", "hash": ListVault.newer, "title": "Quay plans"]
    for _ in 0..<2 {
      v.pane.select(listTab)
      v.paneView.sync()
      list.rowViews[2].mouseDown(with: click)
    }
    let saved = v.pane.tabs.filter { $0.key == "web:" + ListVault.newer }
    #expect(saved.count == 1 && saved.first?.kind == "web" && saved.first?.payload == page)
    #expect(saved.first?.title == "Quay plans" && v.pane.selected == saved.first?.id)
  }

  /// A tree read after an entry is added, renamed and removed: the rows follow; the tab is renamed with its resource
  /// and closes when it is gone
  @Test func theListFollowsAnEntryAddedRenamedAndRemoved() throws {
    let v = try ListVault()
    defer { v.remove() }
    let (id, list) = try v.openList()
    list.select(2)
    try v.vault.newEntry(Entry(id: EntryID(rawValue: "e-new"), title: "Ferry times", added: 5), in: v.resource.path)
    try v.treeRead()
    #expect(list.rows.map(\.title) == ["Ferry times", "Harbour log", "Pier notes", "Quay plans", "Tidal mills"])
    #expect(list.rows[0].kind == "" && list.rows[0].opens == nil)

    var renamed = v.paper
    renamed.title = "Tide mills of the coast"
    try v.vault.write(renamed, at: v.paperPath)
    try v.treeRead()
    #expect(list.rows.last?.title == "Tide mills of the coast")

    try FileManager.default.removeItem(at: v.vault.url(of: "\(v.resource.path)/Pier notes.pdf"))
    try v.treeRead()
    #expect(list.rows.map(\.title) == ["Ferry times", "Harbour log", "Quay plans", "Tide mills of the coast"])
    #expect(list.rowViews.count == 4 && list.selected == 2)

    try FileManager.default.moveItem(
      at: v.vault.url(of: v.resource.path), to: v.vault.root.appending(path: "Shelf.\(Vault.resourceExtension)"))
    try v.treeRead()
    #expect(v.pane.tabs.first { $0.id == id }?.title == "Shelf")
    try FileManager.default.removeItem(at: v.vault.root.appending(path: "Shelf.\(Vault.resourceExtension)"))
    try v.treeRead()
    #expect(!v.pane.tabs.contains { $0.id == id })
  }

  /// A PDF opened from the list and closed: the list shown again has what the resource holds now
  @Test func theListShownAgainAfterATabFromItClosesIsUpToDate() throws {
    let v = try ListVault()
    defer { v.remove() }
    let (listTab, list) = try v.openList()
    list.open(1)
    v.paneView.sync()
    try makePDF(["Gulls"]).write(to: v.vault.url(of: "\(v.resource.path)/Gull counts.pdf"))
    v.pane.close(try #require(v.pane.selected))
    v.paneView.sync()
    #expect(v.pane.selected == listTab && !list.isHidden)
    #expect(list.rows.map(\.title).contains("Gull counts"))
  }

  @Test func anEmptyResourceSaysSoQuietly() throws {
    let v = try ListVault(empty: true)
    defer { v.remove() }
    let (_, list) = try v.openList()
    #expect(list.rows.isEmpty && list.rowViews.isEmpty)
    #expect(!list.empty.isHidden && list.empty.stringValue == "No entries yet" && list.empty.font?.pointSize == 12)
    list.keyDown(with: down)
    list.keyDown(with: returnKey)
    #expect(list.selected == nil && v.pane.tabs.count == 1)
    v.pane.barLook = .inkWash(dark: true)
    v.paneView.sync()
    #expect(list.empty.textColor == NSColor(cgColor: ReadingBarLook.inkWash(dark: true).ink)?.withAlphaComponent(0.45))
  }
}

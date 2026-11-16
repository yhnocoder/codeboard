import CodeBoardModel
import CodeBoardResources
import Foundation
import PDFKit
import Testing

// apps/macos/SampleVault, the vault try.sh opens, read with the current code as the app reads it: every file decodes
// strictly and every reference in it lands. Read in place, never written.

private let sample = Vault(
  root: URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../SampleVault").standardizedFileURL)

@Test func theSampleVaultReadsWholeWithTheCurrentFormat() throws {
  let tree = try sample.tree()
  let folders = tree.allFolders
  #expect(folders.flatMap(\.unreadable).map(\.reason) == [])
  #expect(folders.flatMap(\.unreadableResources).map(\.reason) == [])
  #expect(tree.folders.map(\.name) == ["Engine"])
  #expect(
    tree.allBoards.map(\.title).sorted() == ["Blocks and cache", "Engine", "Sampling", "Scheduler", "Start here"])
  #expect(tree.folder(at: "Engine")?.folderBoard != nil)
  #expect(tree.resources.map(\.title) == ["Files", "Links", "Papers"])

  // the resources and their entries
  var entries: [EntryID: (Entry, URL)] = [:]
  var values: [(field: Resource.Field, value: Entry.Value, path: String)] = []
  for r in folders.flatMap(\.resources) {
    let resource = try sample.resource(at: r.path)
    let items = try sample.items(in: r.path)
    #expect(!items.isEmpty, "\(r.title) has no entries")
    for item in items {
      switch item {
      case .entry(let e, let path):
        #expect(entries[e.id] == nil, "entry \(e.id.rawValue) twice")
        let folder = sample.url(of: path)
        entries[e.id] = (e, folder)
        values += resource.fields.compactMap { f in e.fields[f.id].map { (f, $0, path) } }
        for v in e.versions {
          if case .pdf(let file, _, _) = v.content {
            #expect(PDFDocument(url: folder.appending(path: file)) != nil, "\(path)/\(file)")
          }
        }
      case .file(let path): #expect(FileManager.default.fileExists(atPath: sample.url(of: path).path))
      case .unreadable(let path, let reason): Issue.record("\(path): \(reason)")
      }
    }
  }
  /// A place in an entry: its version is there and, in a plain PDF, its page and characters are
  func lands(_ entry: EntryID, _ place: Place?, _ what: String) {
    guard let (e, folder) = entries[entry] else {
      Issue.record("\(what): no entry \(entry.rawValue)")
      return
    }
    guard let place else { return }
    guard let v = e.versions.first(where: { $0.id == place.version }), case .pdf(let file, nil, _) = v.content,
      case .page(let n, _) = place.block
    else {
      Issue.record("\(what): not a page of a plain PDF of \(entry.rawValue)")
      return
    }
    let page = PDFDocument(url: folder.appending(path: file))?.page(at: n - 1)
    #expect(page != nil, "\(what): no page \(n)")
    if let r = place.range, let page { #expect(r.upperBound <= page.numberOfCharacters, "\(what): past the page") }
  }
  for (e, _) in entries.values {
    for h in e.highlights { lands(e.id, h.place, "highlight \(h.id)") }
    for s in e.sidenotes { lands(e.id, s.place, "annotation \(s.id.rawValue)") }
  }

  // the boards, what their cards show and where they point
  let ids = Set(tree.allBoards.map(\.id))
  // the values of the resources' own fields: a select's one of its options, a board's a board there is
  #expect(!values.isEmpty)
  for (f, v, path) in values {
    switch (f.type, v) {
    case (.select, .text(let o)): #expect(f.options?.contains { $0.id == o } == true, "\(path): \(f.name)")
    case (.board, .text(let b)): #expect(ids.contains(BoardID(rawValue: b)), "\(path): \(f.name)")
    default: break
    }
  }
  for vb in tree.allBoards {
    let board = try sample.board(at: vb.path)
    let package = sample.url(of: vb.path)
    for c in board.cards + board.shelf.flatMap(\.cards) {
      let what = "\(vb.title): \(c.id.rawValue)"
      var content: CardContent
      var images = package.appending(path: "images")
      switch c.content {
      case .own(let own): content = own
      case .shared:
        content = try sample.sharedCard(c.id).content
        images = sample.sharedFolderURL.appending(path: "images")
      }
      if let s = content.source { lands(s.entry, s.place, what) }
      switch content.body {
      case .image(let i):
        switch i.source {
        case .file(let f): #expect(FileManager.default.fileExists(atPath: images.appending(path: f).path), "\(what)")
        case .resource(let a): lands(a.entry, a.place, what)
        case .url: break
        }
      case .board(let s):
        switch s.target {
        case .board(let id): #expect(ids.contains(id), "\(what) shows a board that is not there")
        case .folder(let name): #expect(tree.folder(at: vb.folder)?.folders.contains { $0.name == name } == true)
        }
      default: break
      }
    }
  }
}

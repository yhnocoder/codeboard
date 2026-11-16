import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import PDFKit
import Synchronization
import Testing

@testable import CodeBoardReading
@testable import CodeBoardShell

// PDFs through the shell: added to a resource from its row (Add PDF…, a drop from Finder), opened in the reading pane,
// a passage handed to the shell, a highlighted file's tab following its new entry, tabs kept across a relaunch
@MainActor @Suite(.serialized) struct ShellPDFTests {
  let fm = FileManager.default

  /// A PDF of one page with this text, in a folder of its own outside the vault (as Finder would hand it)
  func outside(_ name: String, _ text: String) throws -> URL {
    let dir = fm.temporaryDirectory.appending(path: "outside-\(UUID().uuidString)")
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    let data = NSMutableData()
    var box = CGRect(x: 0, y: 0, width: 300, height: 400)
    let ctx = CGContext(consumer: CGDataConsumer(data: data as CFMutableData)!, mediaBox: &box, nil)!
    ctx.beginPDFPage(nil)
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    (text as NSString).draw(
      in: CGRect(x: 20, y: 20, width: 260, height: 360), withAttributes: [.font: NSFont.systemFont(ofSize: 14)])
    NSGraphicsContext.current = nil
    ctx.endPDFPage()
    ctx.closePDF()
    let url = dir.appending(path: name)
    try (data as Data).write(to: url)
    return url
  }

  func vault() throws -> (Vault, Shell, VaultResource) {
    let root = fm.temporaryDirectory.appending(path: "shellpdf-\(UUID().uuidString)")
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    let r = try vault.newResource(in: "", title: "Papers", preset: .papers)
    let shell = Shell()
    shell.pasteboard = NSPasteboard(name: NSPasteboard.Name("shellpdf-\(UUID().uuidString)"))
    shell.open(vault, restoring: nil)
    shell.apply(.success(try vault.tree()))
    return (vault, shell, r)
  }

  @Test func addPDFCopiesTheFileUnderAFreeNameAndOpensItsTab() async throws {
    let (vault, shell, r) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    let first = try outside("Field notes.pdf", "The river runs north.")
    let again = try outside("Field notes.pdf", "Evening light on the water.")
    let other = try outside("list.txt", "not a PDF")
    defer { for u in [first, again, other] { try? fm.removeItem(at: u.deletingLastPathComponent()) } }

    // the row's menu: Add PDF… first, asking for the files (here answered without a panel)
    let entry = try #require(shell.menu(resource: r).first ?? nil)
    #expect(entry.title == "Add PDF…")
    shell.askPDFs = { [first] }
    entry.run()
    let deadline = ContinuousClock.now + .seconds(10)
    while shell.reading.tabs.isEmpty && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
    #expect(try Data(contentsOf: vault.url(of: "Papers.resource/Field notes.pdf")) == Data(contentsOf: first))

    // the same name again (dropped on the row): a name of its own, the first one untouched
    #expect(shell.addPDFs([again, other], to: r))
    #expect(try Data(contentsOf: vault.url(of: "Papers.resource/Field notes.pdf")) == Data(contentsOf: first))
    #expect(try Data(contentsOf: vault.url(of: "Papers.resource/Field notes 2.pdf")) == Data(contentsOf: again))
    #expect(!fm.fileExists(atPath: vault.url(of: "Papers.resource/list.txt").path), "only PDFs")
    #expect(
      try vault.items(in: r.path) == [
        .file(path: "Papers.resource/Field notes 2.pdf"), .file(path: "Papers.resource/Field notes.pdf"),
      ])
    #expect(shell.reading.tabs.map(\.title) == ["Field notes", "Field notes 2"])
    #expect(shell.reading.tabs.allSatisfy { $0.kind == "pdf" } && shell.reading.shown)
    #expect(shell.reading.selected == shell.reading.tabs[1].id)
    #expect(!shell.addPDFs([other], to: r), "nothing to add")
  }

  @Test func addArxivPaperMakesAnEntryOpensItAndTheSameIdAgainOpensThatEntry() async throws {
    let (vault, shell, r) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    let asked = Mutex<[String]>([])
    shell.reading.arxiv = Arxiv { req in
      let url = req.url!.absoluteString
      asked.withLock { $0.append(url) }
      let known = url.contains("1706.03762")
      let body =
        !known
        ? "<feed xmlns=\"http://www.w3.org/2005/Atom\"></feed>"
        : url.contains("api/query")
          ? "<feed xmlns=\"http://www.w3.org/2005/Atom\"><entry><id>http://arxiv.org/abs/1706.03762v7</id>"
            + "<published>2017-06-12T17:57:34Z</published><title>Attention Is All You Need</title>"
            + "<author><name>Ashish Vaswani</name></author></entry></feed>" : "%PDF-1.4 v7"
      return (Data(body.utf8), HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    let machine = fm.temporaryDirectory.appending(path: "machine-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: machine) }
    shell.reading.translations = Translations(folder: machine, tongtu: { nil })
    // the row's menu: Add arXiv Paper… asks with the sheet (here: nothing shown)
    var sheetFor: VaultResource?
    shell.askArxiv = { sheetFor = $0 }
    shell.menu(resource: r).compactMap { $0 }.first { $0.title == "Add arXiv Paper…" }?.run()
    #expect(sheetFor == r)

    #expect(await shell.addArxiv("attention", translate: false, to: r) == "“attention” is not an arXiv id or address.")
    #expect(await shell.addArxiv("2401.00001", translate: false, to: r) == "arXiv has no paper 2401.00001.")
    #expect(await shell.addArxiv("https://arxiv.org/abs/1706.03762", translate: true, to: r) == nil)
    let e = try #require(shell.reading.entries.arxiv("1706.03762"))
    #expect(e.path == "Papers.resource/Attention Is All You Need" && e.entry.authors == ["Ashish Vaswani"])
    #expect(e.entry.versions.map(\.label) == ["v7"])
    #expect(try Data(contentsOf: vault.url(of: "\(e.path)/1706.03762v7.pdf")) == Data("%PDF-1.4 v7".utf8))
    let tab = try #require(shell.reading.tabs.first)
    #expect(shell.reading.tabs.count == 1 && tab.kind == "pdf" && tab.title == "Attention Is All You Need")
    #expect(tab.payload == ["entry": e.entry.id.rawValue, "version": e.entry.versions[0].id.rawValue])
    #expect(shell.reading.translations?.jobs.map(\.paper) == ["1706.03762v7"], "Translate ticked")
    #expect(asked.withLock { $0.last } == "https://arxiv.org/pdf/1706.03762v7")

    // again, as arXiv:…: that entry, not a second one, and nothing asked of arXiv
    let before = asked.withLock { $0.count }
    #expect(await shell.addArxiv("arXiv:1706.03762v7", translate: false, to: r) == nil)
    #expect(asked.withLock { $0.count } == before)
    #expect(try vault.items(in: r.path).count == 1 && shell.reading.tabs.count == 1)
  }

  @Test func addToBoardAndOptionReturnHandTheSameCollectedPassageToTheShell() throws {
    let (vault, shell, r) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    let pdf = try outside("Field notes.pdf", "The river runs north.")
    defer { try? fm.removeItem(at: pdf.deletingLastPathComponent()) }
    shell.addPDFs([pdf], to: r)
    var handed: [Collected] = []
    shell.onCollect = { handed.append($0) }
    let view = ReadingPaneView(pane: shell.reading)
    view.frame = CGRect(x: 0, y: 0, width: 500, height: 800)
    view.sync()
    let selected = try #require(shell.reading.selected)
    let t = try #require(view.views[selected] as? PDFTabView)
    let page = try #require(t.pdf.document?.page(at: 0))
    t.pdf.setCurrentSelection(page.selection(for: (page.string! as NSString).range(of: "river")), animate: false)
    t.released()
    let add = t.bar.buttons[0]
    NSApp.sendAction(add.action!, to: add.target, from: add)
    let key = try #require(
      NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: .option, timestamp: 0, windowNumber: 0, context: nil,
        characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
    t.keyDown(with: key)
    #expect(handed.count == 2 && handed.allSatisfy { $0 == shell.collected })
    let c = try #require(shell.collected)
    #expect(c.body == .note(markdown: "river") && c.title == "Field notes" && c.label == "p. 1")
    let e = try #require(shell.reading.tabs.first?.payload["entry"])
    #expect(c.source?.entry.rawValue == e && c.source?.place?.range == 4..<9)
  }

  /// A highlight makes the file an entry; the tree read again, the tab is the entry's and stays open, and a source
  /// anchored in it has its line and opens it again
  @Test func aHighlightedFilesTabFollowsItsEntryThroughTheNextTreeRead() throws {
    let (vault, shell, r) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    let pdf = try outside("Field notes.pdf", "The river runs north.")
    defer { try? fm.removeItem(at: pdf.deletingLastPathComponent()) }
    shell.addPDFs([pdf], to: r)
    let view = ReadingPaneView(pane: shell.reading)
    view.frame = CGRect(x: 0, y: 0, width: 500, height: 800)
    view.sync()
    let id = try #require(shell.reading.selected)
    let t = try #require(view.views[id] as? PDFTabView)
    let page = try #require(t.pdf.document?.page(at: 0))
    t.pdf.setCurrentSelection(page.selection(for: (page.string! as NSString).range(of: "north")), animate: false)
    var changed = 0
    shell.sources.onSourcesChanged = { changed += 1 }
    t.highlight()
    shell.apply(.success(try vault.tree()))
    #expect(changed == 1)
    let tab = try #require(shell.reading.tabs.first)
    #expect(shell.reading.tabs.count == 1 && tab.id == id && tab.title == "Field notes")
    let e = try #require(tab.payload["entry"])
    let v = try #require(tab.payload["version"])
    let anchor = SourceAnchor(
      entry: EntryID(rawValue: e), place: Place(version: VersionID(rawValue: v), block: .page(1), range: 4..<9))
    #expect(shell.sources.sourceLabel(anchor) == SourceLabel(title: "Field notes", number: "p. 1", icon: .paper))
    shell.reading.close(id)
    shell.sources.reveal(anchor)
    view.sync()
    let reopened = try #require(shell.reading.selected)
    let back = try #require(view.views[reopened] as? PDFTabView)
    #expect(back.selectedText == "river")
    // its folder gone: the tab closes
    let folder = try #require(shell.reading.entries[anchor.entry]?.path)
    _ = try vault.trash(folder) { url in
      try FileManager.default.removeItem(at: url)
      return nil
    }
    shell.apply(.success(try vault.tree()))
    #expect(shell.reading.tabs.isEmpty && shell.sources.sourceLabel(anchor) == nil)
  }

  @Test func aPDFTabIsThereAgainAfterARelaunch() throws {
    let (vault, shell, r) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    let pdf = try outside("Field notes.pdf", "The river runs north.")
    defer { try? fm.removeItem(at: pdf.deletingLastPathComponent()) }
    shell.addPDFs([pdf], to: r)
    let saved = try JSONDecoder().decode(ShellState.self, from: JSONEncoder().encode(try #require(shell.state)))
    let again = Shell()
    again.open(vault, restoring: saved)
    // its view made before the tree is read, as at launch
    let view = ReadingPaneView(pane: again.reading)
    view.sync()
    let tab = try #require(again.reading.tabs.first)
    #expect(
      tab.kind == "pdf" && tab.title == "Field notes" && tab.payload == ["file": "Papers.resource/Field notes.pdf"])
    #expect((view.views[tab.id] as? PDFTabView)?.pdf.document?.pageCount == 1)
    again.apply(.success(try vault.tree()))
    #expect(again.reading.tabs.map(\.id) == [tab.id])
  }
}

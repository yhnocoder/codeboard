import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import PDFKit
import Synchronization
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardReading
@testable import CodeBoardShell

// PDFs through the shell: added to a resource from its row (Add PDF…, a drop from Finder), opened in the reading pane,
// a passage handed to the shell, a highlighted file's tab following its new entry, tabs kept across a relaunch, a
// highlight's annotations written in the board's sidenote popup (needs the board's fonts: node tools/markdown/assets.mjs)
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

  /// A resource's tab, opened from its row, lists its entries and follows every tree read the shell applies: a PDF
  /// added is a row at once, which opens the PDF's tab; renamed, the tab takes the resource's name; gone, it closes
  @Test func aResourcesListFollowsTheTreeReadsTheShellApplies() throws {
    let (vault, shell, r) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    let pdf = try outside("Field notes.pdf", "The river runs north.")
    defer { try? fm.removeItem(at: pdf.deletingLastPathComponent()) }
    shell.openResource(r)
    let pane = ReadingPaneView(pane: shell.reading)
    pane.sync()
    let listTab = try #require(shell.reading.tabs.first?.id)
    let list = try #require(pane.views[listTab] as? ListTabView)
    #expect(list.rows.isEmpty && !list.empty.isHidden)

    #expect(shell.addPDFs([pdf], to: r))
    #expect(list.rows.map(\.title) == ["Field notes"] && list.rows[0].kind == "PDF" && list.empty.isHidden)
    shell.reading.select(listTab)
    pane.sync()
    list.open(0)
    #expect(shell.reading.tabs.map(\.kind) == ["list", "pdf"] && shell.reading.selected == shell.reading.tabs[1].id)

    shell.rename(resource: r, to: "Field work")
    #expect(shell.reading.tabs[0].title == "Field work" && list.rows.map(\.title) == ["Field notes"])
    try fm.removeItem(at: vault.url(of: "Field work.resource"))
    shell.apply(.success(try vault.tree()))
    #expect(!shell.reading.tabs.contains { $0.id == listTab })
  }

  // MARK: Annotations

  /// A PDF tab of the shell's reading pane in a window of its own, off the screen, "north" highlighted and clicked
  func highlightedTab() throws -> (Vault, Shell, NSWindow, PDFTabView) {
    let (vault, shell, r) = try vault()
    let pdf = try outside("Field notes.pdf", "The river runs north.")
    defer { try? fm.removeItem(at: pdf.deletingLastPathComponent()) }
    shell.addPDFs([pdf], to: r)
    let view = ReadingPaneView(pane: shell.reading)
    let window = NSWindow(
      contentRect: CGRect(x: -30000, y: -30000, width: 600, height: 900), styleMask: [.titled], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    window.contentView = view
    view.sync()
    view.layoutSubtreeIfNeeded()
    let selected = try #require(shell.reading.selected)
    let t = try #require(view.views[selected] as? PDFTabView)
    t.layoutSubtreeIfNeeded()
    let page = try #require(t.pdf.document?.page(at: 0))
    t.pdf.setCurrentSelection(page.selection(for: (page.string! as NSString).range(of: "north")), animate: false)
    t.highlight()
    t.pdf.clearSelection()
    t.dismiss()
    let lit = try #require(page.annotations.first { $0.type == "Highlight" }).bounds
    t.released(at: t.pdf.convert(CGPoint(x: lit.midX, y: lit.midY), from: page))
    return (vault, shell, window, t)
  }

  /// The sidenote popup the tab shows its highlight's annotations in
  func sidenotePop(_ t: PDFTabView) throws -> SidenotePop {
    try #require((t.pop?.view as? PopView)?.pop)
  }

  func entry(_ shell: Shell) throws -> Entry {
    let id = try #require(shell.reading.tabs.first?.payload["entry"])
    let path = try #require(shell.reading.entries[EntryID(rawValue: id)]?.path)
    return try #require(shell.vault).entry(at: path)
  }

  func type(_ pop: SidenotePop, _ s: String) {
    pop.field?.insertText(s, replacementRange: NSRange(location: NSNotFound, length: 0))
  }

  func enter(_ pop: SidenotePop) { pop.field?.doCommand(by: #selector(NSResponder.insertNewline(_:))) }

  /// Until `f` holds, the main queue running meanwhile (the next input takes the keys after it)
  func until(_ what: String, _ f: () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while !f() {
      guard ContinuousClock.now < deadline else {
        Issue.record("never: \(what)")
        return
      }
      try await Task.sleep(for: .milliseconds(5))
    }
  }

  /// Annotate opens the board's popup beside the highlight with its input ready: ↵ writes an annotation in the entry
  /// and the next one is written in a new input; the ? asks a question, which is answered, resolved and opened again
  /// in the popup; an annotation is changed and deleted there; Esc closes it. The tools a board's sidenote has for
  /// code and for the board (Always Show, Place on Board, a code search) are not there
  @Test func annotationsAndQuestionsAreWrittenInTheBoardsSidenotePopup() async throws {
    let (vault, shell, window, t) = try highlightedTab()
    defer {
      window.contentView = nil
      window.close()
      try? fm.removeItem(at: vault.root)
    }
    #expect(t.pop == nil, "no annotations yet: no popup")
    let annotate = t.highlightBar.buttons[0]
    NSApp.sendAction(annotate.action!, to: annotate.target, from: annotate)
    let pop = try sidenotePop(t)
    #expect(pop.view.alphaValue == 1 && window.firstResponder === pop.field, "the input has the keys")
    #expect(pop.shown?.title == "Field notes" && pop.shown?.range == "p. 1" && pop.shown?.theme.id == .warmInk)
    #expect(pop.labels() == ["Remove Highlight", "Close"])
    let composer = try #require(pop.bottom as? Composer)
    #expect(composer.askButton != nil && composer.codeButton == nil, "no code search")
    // beside the highlight: under its line, from where it starts but shifted in to stay inside the tab
    let line = try #require(t.lines(of: t.shownHighlight).first?.1)
    let box = pop.view.convert(pop.view.popRect, to: t)
    #expect(abs(box.minY - (line.maxY + 6)) < 0.5 && abs(box.minX - min(line.minX, t.bounds.maxX - box.width)) < 0.5)
    #expect(t.floatArea.contains(box) && box.width == 460)

    type(pop, "Which mill?")
    enter(pop)
    #expect(try entry(shell).sidenotes.map(\.note) == [TextNote(text: "Which mill?")])
    try await until("the next input has the keys") { window.firstResponder === pop.field && pop.field != nil }
    #expect(pop.slips.count == 1)
    // the ? asks it; after ↵ the row is the + again
    #expect(pop.press("Question"))
    type(pop, "Why north?")
    enter(pop)
    var e = try entry(shell)
    #expect(e.sidenotes.count == 2 && e.sidenotes[1].note.question.map { !$0.done && $0.answers.isEmpty } == true)
    #expect(e.sidenotes.allSatisfy { $0.place == e.highlights[0].place })
    #expect((pop.bottom as? PopButton)?.label == "Add Sidenote")
    let (n, q) = (e.sidenotes[0].id.rawValue, e.sidenotes[1].id.rawValue)
    #expect(pop.labels(in: n) == ["Edit", "Delete Sidenote"], "no Always Show, no Place on Board")
    #expect(pop.labels(in: q) == ["Resolve", "Edit", "Delete Question"])
    // answered under the question, then resolved by its tick and opened again
    #expect(pop.press("Answer", in: q))
    #expect(window.firstResponder === pop.field)
    type(pop, "Upstream")
    enter(pop)
    e = try entry(shell)
    #expect(e.sidenotes[1].note.question?.answers.map(\.text) == ["Upstream"])
    try await until("the answer drawn") { pop.slips.last?.answers.count == 1 }
    #expect(pop.press("Resolve", in: q))
    #expect(try entry(shell).sidenotes[1].note.question?.done == true)
    try await until("drawn resolved") { pop.slips.last?.question == true }
    #expect(pop.press("Reopen", in: q))
    #expect(try entry(shell).sidenotes[1].note.question?.done == false)
    // the first one written again in its slip, then deleted
    #expect(pop.press("Edit", in: n))
    type(pop, " The old one.")
    enter(pop)
    #expect(try entry(shell).sidenotes[0].note.text == "Which mill? The old one.")
    #expect(pop.press("Delete Sidenote", in: try entry(shell).sidenotes[0].id.rawValue))
    e = try entry(shell)
    #expect(e.sidenotes.map(\.id.rawValue) == [q] && pop.slips.count == 1)
    // with nothing being written, Esc closes it, and the keys go back to the tab
    window.makeFirstResponder(pop.view)
    pop.view.cancelOperation(nil)
    #expect(t.pop == nil && window.firstResponder === t)
    // clicked again: its annotations, not written in
    let page = try #require(t.pdf.document?.page(at: 0))
    let lit = try #require(page.annotations.first { $0.type == "Highlight" }).bounds
    t.released(at: t.pdf.convert(CGPoint(x: lit.midX, y: lit.midY), from: page))
    let again = try sidenotePop(t)
    #expect(again !== pop && again.slips.count == 1 && again.bottom is PopButton)
  }

  /// What is being written when the popup closes is added; the title bar's Remove Highlight takes the highlight and
  /// what was written on it
  @Test func whatIsWrittenAsThePopupClosesIsAddedAndRemoveHighlightTakesItAll() throws {
    let (vault, shell, window, t) = try highlightedTab()
    defer {
      window.contentView = nil
      window.close()
      try? fm.removeItem(at: vault.root)
    }
    t.annotate()
    let pop = try sidenotePop(t)
    type(pop, "Half written")
    t.dismiss()
    #expect(t.pop == nil && pop.key == nil)
    #expect(try entry(shell).sidenotes.map(\.note.text) == ["Half written"])
    let page = try #require(t.pdf.document?.page(at: 0))
    let lit = try #require(page.annotations.first { $0.type == "Highlight" }).bounds
    t.released(at: t.pdf.convert(CGPoint(x: lit.midX, y: lit.midY), from: page))
    let again = try sidenotePop(t)
    #expect(again.slips.count == 1)
    #expect(again.press("Remove Highlight"))
    let e = try entry(shell)
    #expect(e.highlights.isEmpty && e.sidenotes.isEmpty && t.pop == nil && t.highlightBar.isHidden)
    #expect(!page.annotations.contains { $0.type == "Highlight" || $0.type == "Circle" })
  }

  /// In a reading pane narrower than the popup it is whole: over the window, its right edge the tab's and the rest
  /// over the board, Close and its input under the pointer, the board beside it; it moves with the page as it
  /// scrolls and goes when another tab is shown
  @Test(arguments: [420.0, 280.0])
  func inANarrowPaneThePopupReachesOverTheBoardWhole(_ width: Double) async throws {
    let (vault, shell, r) = try vault()
    defer { try? fm.removeItem(at: vault.root) }
    let pdf = try outside("Field notes.pdf", "The river runs north.")
    let other = try outside("Other.pdf", "Evening light.")
    defer { for u in [pdf, other] { try? fm.removeItem(at: u.deletingLastPathComponent()) } }
    shell.addPDFs([pdf], to: r)
    shell.reading.width = width
    // the whole window, never shown: off the screen, short enough that the page scrolls
    let (window, _) = makeMainWindow(shell: shell)
    defer { window.close() }
    window.setFrame(CGRect(x: -30000, y: -30000, width: 1200, height: 420), display: false)
    let root = try #require(window.contentView)
    root.layoutSubtreeIfNeeded()
    func find<T: NSView>(_ v: NSView) -> T? { v as? T ?? v.subviews.lazy.compactMap { find($0) }.first }
    let paneView: ReadingPaneView = try #require(find(root))
    paneView.sync()
    root.layoutSubtreeIfNeeded()
    let t: PDFTabView = try #require(find(paneView))
    t.layoutSubtreeIfNeeded()
    #expect(abs(t.bounds.width - width) < 40, "the tab is about as wide as the pane: \(t.bounds.width)")
    let page = try #require(t.pdf.document?.page(at: 0))
    t.pdf.setCurrentSelection(page.selection(for: (page.string! as NSString).range(of: "north")), animate: false)
    t.highlight()
    t.pdf.clearSelection()
    t.dismiss()
    let lit = try #require(page.annotations.first { $0.type == "Highlight" }).bounds
    t.released(at: t.pdf.convert(CGPoint(x: lit.midX, y: lit.midY), from: page))
    t.annotate()
    let pop = try sidenotePop(t)
    #expect(t.highlightBar.isHidden, "the popup, not the bar")
    func box() -> CGRect { pop.view.convert(pop.view.popRect, to: nil) }
    let inWindow = root.convert(root.bounds, to: nil)
    let tab = t.convert(t.floatArea, to: nil)
    #expect(inWindow.contains(box()), "whole in the window: \(box()) in \(inWindow)")
    #expect(box().maxX <= tab.maxX + 0.5 && box().maxX >= tab.maxX - 8.5, "its right edge the tab's: \(box()) \(tab)")
    #expect(box().minX < tab.minX && box().width == 460, "over the board")
    // under the pointer: Close, the input; beside it, not the popup
    let frame = try #require(root.superview)
    func hit(_ p: CGPoint) -> NSView? { frame.hitTest(frame.convert(p, from: nil)) }
    let close = try #require(PopButton.find("Close", in: pop.view))
    let c = close.convert(CGPoint(x: close.bounds.midX, y: close.bounds.midY), to: nil)
    #expect(hit(c) === close)
    let field = try #require(pop.field)
    type(pop, "Why")
    try await until("the input laid out") { field.frame.height > 0 }
    let f = field.convert(CGPoint(x: field.bounds.midX, y: field.bounds.midY), to: nil)
    #expect(hit(f).map { $0 === field || $0.isDescendant(of: field) } == true && window.firstResponder === field)
    let beside = CGPoint(x: box().minX - 12, y: box().midY)
    #expect(hit(beside).map { $0.isDescendant(of: pop.view) } == false, "the board beside it gets the press")
    // scrolled: it stays by the highlight
    func line() -> CGRect { t.lines(of: t.shownHighlight).first.map { t.convert($0.1, to: nil) } ?? .null }
    let before = line()
    let gap = box().maxY - before.minY
    let clip = try #require(t.pdf.documentView?.enclosingScrollView?.contentView)
    clip.scroll(to: CGPoint(x: clip.bounds.minX, y: clip.bounds.minY + (clip.isFlipped ? 30 : -30)))
    clip.enclosingScrollView?.reflectScrolledClipView(clip)
    try await until("scrolled") { abs(line().minY - before.minY) > 10 }
    #expect(abs(box().maxY - line().minY - gap) < 0.5, "moved with the page")
    #expect(inWindow.contains(box()) && box().maxX <= tab.maxX + 0.5)
    // another tab shown: it goes
    shell.addPDFs([other], to: r)
    paneView.sync()
    #expect(t.pop == nil && pop.view.superview == nil)
  }
}

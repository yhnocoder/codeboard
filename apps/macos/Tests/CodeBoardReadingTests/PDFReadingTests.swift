import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import PDFKit
import Testing

@testable import CodeBoardReading

// Places of a plain PDF to and from PDFKit's selections
@MainActor @Suite struct PDFPlaceTests {
  let doc = PDFDocument(data: makePDF(samplePages))!
  let v = VersionID(rawValue: "v1")

  @Test func aSelectionOnOnePageIsOnePlaceOfItsCharactersInUTF16() throws {
    let page = try #require(doc.page(at: 0))
    let text = try #require(page.string) as NSString
    let at = text.range(of: "north")
    let s = try #require(page.selection(for: at))
    let places = PDFPlaces.places(s, in: doc, version: v)
    #expect(places == [Place(version: v, block: .page(1), range: at.location..<(at.location + at.length))])
    #expect(PDFPlaces.selection(places, in: doc)?.string == "north")
  }

  @Test func aSelectionAcrossPagesIsOnePlacePerPageAndComesBackWhole() throws {
    let one = try #require(doc.page(at: 0))
    let two = try #require(doc.page(at: 1))
    let from = (try #require(one.string) as NSString).range(of: "Birds").location
    let to = (try #require(two.string) as NSString).range(of: "light").location
    let s = try #require(doc.selection(from: one, atCharacterIndex: from, to: two, atCharacterIndex: to + 4))
    let places = PDFPlaces.places(s, in: doc, version: v)
    #expect(
      places == [
        Place(version: v, block: .page(1), range: from..<one.numberOfCharacters),
        Place(version: v, block: .page(2), range: 0..<(to + 5)),
      ])
    let back = try #require(PDFPlaces.selection(places, in: doc))
    #expect(back.string == s.string && back.pages.count == 2)
    #expect(PDFPlaces.label(PDFPlaces.pages(back, in: doc)) == "p. 1–2")
  }

  @Test func aPlaceWithoutARangeIsTheWholePageAndOneOffThePagesIsNothing() throws {
    let page = try #require(doc.page(at: 1))
    #expect(PDFPlaces.selection([Place(version: v, block: .page(2))], in: doc)?.string == page.string)
    #expect(PDFPlaces.selection([Place(version: v, block: .page(3), range: 0..<4)], in: doc) == nil)
    #expect(PDFPlaces.selection([Place(version: v, block: .id("b1"))], in: doc) == nil)
  }
}

// A PDF tab: PDFKit's view and selection, the bar over a selection, Copy, Add to Board, Highlight, what is written
@MainActor @Suite(.serialized) struct PDFTabTests {
  @Test func theBarComesOverASelectionWithItsThreeButtonsAndGoesWhenTheSelectionIsCleared() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let w = try PDFWindow(v)
    defer { w.close() }
    let id = try #require(w.pane.openPDF(.file(v.file)))
    #expect(w.pane.tabs.first?.title == "Field notes" && w.pane.tabs.first?.kind == "pdf")
    let t = try w.tab(id)
    #expect(t.pdf.document?.pageCount == 2 && t.pdf.displayMode == .singlePageContinuous && t.pdf.autoScales)
    #expect(t.bar.isHidden)
    try w.select(t, "rest on the")
    #expect(t.selectedText == "rest on the" && !t.bar.isHidden)
    #expect(
      t.bar.buttons.map { $0.accessibilityIdentifier() } == [
        "ui-selectionadd", "ui-selectionhighlight", "ui-selectioncopy",
      ])
    #expect(t.bar.buttons.map(\.toolTip) == ["Add to Board", "Highlight", "Copy"])
    // just above the line, from where it starts, and there on the page as it scrolls
    let page = try #require(t.pdf.document?.page(at: 0))
    let selection = try #require(t.pdf.currentSelection)
    func line() -> CGRect { t.convert(t.pdf.convert(selection.bounds(for: page), from: page), from: t.pdf) }
    #expect(abs(t.bar.frame.maxY - (line().minY - 6)) < 0.5 && abs(t.bar.frame.minX - line().minX) < 0.5)
    let clip = try #require(t.pdf.documentView?.enclosingScrollView?.contentView)
    let was = line()
    clip.scroll(to: CGPoint(x: clip.bounds.minX, y: clip.bounds.minY + (clip.isFlipped ? 20 : -20)))
    #expect(line().minY != was.minY, "scrolled")
    #expect(abs(t.bar.frame.maxY - (line().minY - 6)) < 0.5, "\(t.bar.frame) over \(line())")
    t.pdf.clearSelection()
    #expect(t.bar.isHidden)
    // and when the tab is left
    try w.select(t, "far bank")
    #expect(!t.bar.isHidden)
    w.pane.open("Other")
    w.paneView.sync()
    #expect(t.isHidden && t.bar.isHidden)
  }

  @Test func copyPutsTheSelectedTextOnThePasteboard() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let w = try PDFWindow(v)
    defer { w.close() }
    let t = try w.tab(try #require(w.pane.openPDF(.file(v.file))))
    let page = try #require(t.pdf.document?.page(at: 1))
    t.pdf.setCurrentSelection(
      page.selection(for: (page.string! as NSString).range(of: "Evening light")), animate: false)
    NSApp.sendAction(t.bar.buttons[2].action!, to: t.bar.buttons[2].target, from: t.bar.buttons[2])
    #expect(w.pasteboard.string(forType: .string) == "Evening light")
  }

  /// A file alone is made an entry by the first passage taken from it, so the passage has its source
  @Test func addToBoardAndOptionReturnHandTheSameCollectedPassageWithItsSource() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let w = try PDFWindow(v)
    defer { w.close() }
    let t = try w.tab(try #require(w.pane.openPDF(.file(v.file))))
    let page = try #require(t.pdf.document?.page(at: 1))
    t.pdf.setCurrentSelection(page.selection(for: (page.string! as NSString).range(of: "boat")), animate: false)
    NSApp.sendAction(t.bar.buttons[0].action!, to: t.bar.buttons[0].target, from: t.bar.buttons[0])
    let key = try #require(
      NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: .option, timestamp: 0, windowNumber: w.window.windowNumber,
        context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
    t.pdf.keyDown(with: key)
    t.keyDown(with: key)
    #expect(w.collected.count == 3)
    #expect(w.collected.allSatisfy { $0 == w.collected[0] })
    guard case .entry(let entry, _)? = try v.vault.items(in: v.resource.path).first else {
      Issue.record("the file made an entry")
      return
    }
    let place = Place(
      version: entry.versions[0].id, block: .page(2),
      range: (page.string! as NSString).range(of: "boat").location..<(page.string! as NSString).range(of: "boat")
        .location + 4)
    #expect(
      w.collected.first
        == Collected(
          body: .note(markdown: "boat"), source: SourceAnchor(entry: entry.id, place: place), title: "Field notes",
          label: "p. 2"))
    #expect(entry.highlights.isEmpty && entry.sidenotes.isEmpty)
  }

  /// A file alone is made an entry by its first highlight: a folder, the file moved into it under a plain name,
  /// entry.json with the highlight's places; the tab goes on showing it and follows the entry
  @Test func aHighlightMakesAFileAnEntryWritesItsPlacesAndIsDrawnAgainWhenReopened() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let w = try PDFWindow(v)
    defer { w.close() }
    let id = try #require(w.pane.openPDF(.file(v.file)))
    let t = try w.tab(id)
    let doc = try #require(t.pdf.document)
    let one = try #require(doc.page(at: 0))
    let two = try #require(doc.page(at: 1))
    let from = (one.string! as NSString).range(of: "north").location
    t.pdf.setCurrentSelection(
      doc.selection(from: one, atCharacterIndex: from, to: two, atCharacterIndex: 6), animate: false)
    t.highlight()

    let items = try v.vault.items(in: v.resource.path)
    guard case .entry(let entry, let path)? = items.first, items.count == 1 else {
      Issue.record("one entry: \(items)")
      return
    }
    #expect(path == "\(v.resource.path)/Field notes")
    #expect(entry.title == "Field notes" && entry.versions.count == 1)
    let version = try #require(entry.versions.first)
    #expect(version.content == .pdf(file: "file.pdf"))
    #expect(FileManager.default.fileExists(atPath: v.vault.url(of: "\(path)/file.pdf").path))
    #expect(
      entry.highlights.map(\.place) == [
        Place(version: version.id, block: .page(1), range: from..<one.numberOfCharacters),
        Place(version: version.id, block: .page(2), range: 0..<7),
      ])
    #expect(entry.highlights.allSatisfy { $0.color == .yellow })
    let written = try Data(contentsOf: v.vault.url(of: "\(path)/entry.json"))
    #expect(written == (try entry.encoded()), "the deterministic encoder's output")
    // the same view, the same document, its tab now the entry's
    #expect(w.paneView.views[id] === t && t.pdf.document === doc && t.selectedText != nil)
    let tab = try #require(w.pane.tabs.first)
    #expect(tab.payload == ["entry": entry.id.rawValue, "version": version.id.rawValue] && tab.title == "Field notes")
    #expect(one.annotations.count == 2 && two.annotations.count == 1, "a highlight a line")
    #expect(
      PDFPlaces.highlight(at: CGPoint(x: one.annotations[0].bounds.midX, y: one.annotations[0].bounds.midY), on: one)
        == entry.highlights[0].id)

    // closed and opened again from what the tree says: drawn from entry.json
    w.pane.close(id)
    w.paneView.sync()
    w.pane.entries = EntryIndex(v.vault, try v.vault.tree())
    let again = try w.tab(try #require(w.pane.openPDF(.entry(entry.id, version: version.id))))
    #expect(again.pdf.document?.page(at: 0)?.annotations.count == 2)
  }

  @Test func highlightingTheSameTextTwiceAddsOneHighlight() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let w = try PDFWindow(v)
    defer { w.close() }
    let t = try w.tab(try #require(w.pane.openPDF(.file(v.file))))
    let page = try #require(t.pdf.document?.page(at: 0))
    let words = page.selection(for: (page.string! as NSString).range(of: "far bank"))
    t.pdf.setCurrentSelection(words, animate: false)
    t.highlight()
    t.pdf.setCurrentSelection(page.selection(for: (page.string! as NSString).range(of: "far bank")), animate: false)
    t.highlight()
    guard case .entry(let entry, _)? = try v.vault.items(in: v.resource.path).first else {
      Issue.record("an entry")
      return
    }
    #expect(entry.highlights.count == 1)
    #expect(page.annotations.count == 1)
  }

  @Test func openingAPDFAndSelectingInItWritesNothing() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let before = v.files()
    let w = try PDFWindow(v)
    defer { w.close() }
    let t = try w.tab(try #require(w.pane.openPDF(.file(v.file))))
    try w.select(t, "past the mill")
    t.copySelection()
    #expect(t.selectedText == "past the mill")
    #expect(v.files() == before)
  }

  @Test func aTabWhoseFileIsGoneShowsTheBlankPanelAndClosesWhenTheTreeIsReadAgain() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let w = try PDFWindow(v)
    defer { w.close() }
    let id = try #require(w.pane.openPDF(.file(v.file)))
    try FileManager.default.removeItem(at: v.vault.url(of: v.file))
    let t = try w.tab(id)
    #expect(t.pdf.isHidden && t.pdf.document == nil)
    w.pane.follow { ReadingKinds.follow($0, in: w.pane) }
    #expect(w.pane.tabs.isEmpty)
  }
}

// What the board asks of a PDF entry's sources: its source line, a page's region as a picture, the passage shown
@MainActor @Suite(.serialized) struct PDFSourceTests {
  /// The vault's file made an entry, with one version
  func entry(_ v: PDFVault) throws -> (Entry, String) {
    let e = Entry(
      id: EntryID(rawValue: "e1"), title: "Field notes", added: 0,
      versions: [Version(id: VersionID(rawValue: "v1"), added: 0, content: .pdf(file: "file.pdf"))])
    let path = try v.vault.promote(file: v.file, to: e, as: "file.pdf")
    return (e, path)
  }

  @Test func theSourceLineIsTheEntrysTitleAndPageAndNothingOnceTheEntryIsGone() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let (e, path) = try entry(v)
    let w = try PDFWindow(v)
    defer { w.close() }
    let s = ReadingSources(pane: w.pane)
    let at = SourceAnchor(entry: e.id, place: Place(version: e.versions[0].id, block: .page(2), range: 0..<4))
    #expect(s.sourceLabel(at) == SourceLabel(title: "Field notes", number: "p. 2", icon: .paper))
    #expect(
      s.sourceLabel(SourceAnchor(entry: e.id, place: Place(version: VersionID(rawValue: "v9"), block: .page(1)))) == nil
    )
    try FileManager.default.removeItem(at: v.vault.url(of: path))
    w.pane.entries = EntryIndex(v.vault, try v.vault.tree())
    #expect(s.sourceLabel(at) == nil)
  }

  @Test func aPagesRegionHasItsSizeAndIsDrawnAtTheWidthAsked() async throws {
    let v = try PDFVault()
    defer { v.remove() }
    let (e, _) = try entry(v)
    let w = try PDFWindow(v)
    defer { w.close() }
    let s = ReadingSources(pane: w.pane)
    let region = SourceAnchor(
      entry: e.id,
      place: Place(version: e.versions[0].id, block: .page(1, rect: Place.Rect(x: 10, y: 300, width: 200, height: 50))))
    #expect(s.blockSize(region) == CGSize(width: 200, height: 50))
    let image = try #require(await s.blockImage(region, pixelWidth: 400))
    #expect(image.width == 400 && image.height == 100)
    let page = SourceAnchor(entry: e.id, place: Place(version: e.versions[0].id, block: .page(2)))
    #expect(s.blockSize(page) == CGSize(width: 300, height: 400))
    #expect(
      await s.blockImage(
        SourceAnchor(entry: e.id, place: Place(version: e.versions[0].id, block: .page(5))), pixelWidth: 100) == nil)
  }

  @Test func revealOpensTheEntrysTabAndShowsThePassageAsASelection() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let (e, _) = try entry(v)
    let w = try PDFWindow(v)
    defer { w.close() }
    let s = ReadingSources(pane: w.pane)
    s.reveal(SourceAnchor(entry: e.id, place: Place(version: e.versions[0].id, block: .page(2), range: 0..<7)))
    let tab = try #require(w.pane.tabs.first)
    #expect(w.pane.tabs.count == 1 && w.pane.selected == tab.id && tab.title == "Field notes")
    let t = try w.tab(tab.id)
    #expect(t.selectedText == "Evening" && t.bar.isHidden)
    // open already: the same tab
    s.reveal(SourceAnchor(entry: e.id, place: Place(version: e.versions[0].id, block: .page(1), range: 4..<9)))
    #expect(w.pane.tabs.count == 1 && t.selectedText == "river")
  }
}

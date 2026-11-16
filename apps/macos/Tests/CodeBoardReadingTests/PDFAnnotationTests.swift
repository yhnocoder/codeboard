import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import PDFKit
import Testing

@testable import CodeBoardReading

// A PDF tab's highlights clicked (their bar, Remove), annotated (the popup, a mark at the highlight's end, questions
// for the board's question list) and regions of a page taken as pictures
@MainActor @Suite(.serialized) struct PDFAnnotationTests {
  /// A highlight made on these words of a page, then the selection cleared
  func highlighted(_ w: PDFWindow, _ t: PDFTabView, _ words: String, page: Int = 0) throws {
    try w.select(t, words, page: page)
    t.highlight()
    t.pdf.clearSelection()
    t.dismiss()
  }

  /// The middle of a highlight's first line, in the PDF view's space
  func point(on t: PDFTabView, page: Int = 0) throws -> CGPoint {
    let p = try #require(t.pdf.document?.page(at: page))
    let a = try #require(p.annotations.first { $0.type == "Highlight" })
    return t.pdf.convert(CGPoint(x: a.bounds.midX, y: a.bounds.midY), from: p)
  }

  func entry(_ v: PDFVault) throws -> Entry {
    guard case .entry(let e, _)? = try v.vault.items(in: v.resource.path).first else {
      throw CocoaError(.fileNoSuchFile)
    }
    return e
  }

  func press(_ b: NSButton) { NSApp.sendAction(b.action!, to: b.target, from: b) }

  /// The tab's view with the popup the shell would make standing in, the highlight on these words clicked
  func clicked(_ v: PDFVault, _ words: String) throws -> (PDFWindow, PDFTabView, FakePop) {
    let w = try PDFWindow(v)
    let fake = FakePop(w.pane)
    let t = try w.tab(try #require(w.pane.openPDF(.file(v.file))))
    try highlighted(w, t, words)
    t.released(at: try point(on: t))
    return (w, t, fake)
  }

  @Test func highlightsMadeTogetherAreOneGroup() {
    let v = VersionID(rawValue: "v1")
    let w = VersionID(rawValue: "v2")
    func h(_ id: String, _ at: Double, _ c: Highlight.Color = .yellow, _ version: VersionID? = nil) -> Highlight {
      Highlight(id: id, place: Place(version: version ?? v, block: .page(1), range: 0..<2), color: c, at: at)
    }
    let groups = PDFPlaces.groups([h("a", 1), h("b", 1), h("c", 2), h("d", 1, .blue), h("e", 1, .yellow, w)])
    #expect(groups.map { $0.map(\.id) } == [["a", "b"], ["c"], ["d"], ["e"]])
  }

  @Test func aClickOnAHighlightBringsItsBarAboveItAndAClickElsewhereTakesItAway() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let w = try PDFWindow(v)
    defer { w.close() }
    let t = try w.tab(try #require(w.pane.openPDF(.file(v.file))))
    try highlighted(w, t, "rest on the")
    t.released(at: try point(on: t))
    #expect(!t.highlightBar.isHidden && t.bar.isHidden && t.pop == nil, "no annotations yet: no popup")
    #expect(t.highlightBar.accessibilityIdentifier() == "ui-highlightbar")
    #expect(
      t.highlightBar.buttons.map { $0.accessibilityIdentifier() } == ["ui-highlightannotate", "ui-highlightremove"])
    #expect(t.highlightBar.buttons.map(\.toolTip) == ["Annotate", "Remove"])
    let line = try #require(t.lines(of: t.shownHighlight).first?.1)
    #expect(abs(t.highlightBar.frame.maxY - (line.minY - 6)) < 0.5 && abs(t.highlightBar.frame.minX - line.minX) < 0.5)
    // a click on plain text: nothing
    t.dismiss()
    let page = try #require(t.pdf.document?.page(at: 0))
    let plain = page.characterBounds(at: (page.string! as NSString).range(of: "mill").location)
    t.released(at: t.pdf.convert(CGPoint(x: plain.midX, y: plain.midY), from: page))
    #expect(t.highlightBar.isHidden && t.shownHighlight.isEmpty)
  }

  /// A highlight made across two pages is two Highlights made at once: Remove takes both, and what was written on it
  @Test func removeTakesTheHighlightOnEveryPageItWasMadeOn() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let w = try PDFWindow(v)
    defer { w.close() }
    let t = try w.tab(try #require(w.pane.openPDF(.file(v.file))))
    let doc = try #require(t.pdf.document)
    let one = try #require(doc.page(at: 0))
    let from = (one.string! as NSString).range(of: "Birds").location
    t.pdf.setCurrentSelection(
      doc.selection(from: one, atCharacterIndex: from, to: try #require(doc.page(at: 1)), atCharacterIndex: 6),
      animate: false)
    t.highlight()
    t.pdf.clearSelection()
    try highlighted(w, t, "north")
    #expect(try entry(v).highlights.count == 3)
    t.released(at: try point(on: t, page: 1))
    #expect(t.shownHighlight.count == 2)
    let fake = FakePop(w.pane)
    t.annotate()
    fake.act?(.add("Why there?", ask: false))
    #expect(try entry(v).sidenotes.count == 1)
    press(t.highlightBar.buttons[1])
    let e = try entry(v)
    #expect(e.highlights.count == 1 && e.highlights[0].place.block == .page(1))
    #expect(e.sidenotes.isEmpty && t.highlightBar.isHidden && t.pop == nil)
    #expect(try #require(doc.page(at: 1)).annotations.isEmpty)
  }

  @Test func aLineEndingWhereThereIsNoGlyphOrAtThePagesLastOneHasItsMarkAfterIt() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let page = try #require(PDFDocument(url: v.vault.url(of: v.file))?.page(at: 0))
    let box = page.bounds(for: .mediaBox)
    // a line drawn into the margin, as a block's is to its column's edge: no glyph at its end
    let empty = CGRect(x: box.maxX - 40, y: box.minY + 2, width: 38, height: 10)
    #expect(page.characterIndex(at: CGPoint(x: empty.maxX - 0.5, y: empty.midY)) == NSNotFound)
    #expect(PDFPlaces.nextGlyph(after: empty, on: page) == nil)
    #expect(PDFPlaces.mark(after: empty, on: page, .yellow, id: "h").bounds.minX > empty.maxX)
    // the page's last glyph that has a box
    let n = page.numberOfCharacters
    let last = try #require((0..<n).reversed().map { page.characterBounds(at: $0) }.first { $0.width > 1 })
    _ = PDFPlaces.nextGlyph(after: last, on: page)
    #expect(PDFPlaces.mark(after: last, on: page, .yellow, id: "h").bounds.width == 3)
  }

  @Test func theMarkOfAHighlightEndingInAWordSitsAboveTheLineAtItsEnd() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let w = try PDFWindow(v)
    defer { w.close() }
    let t = try w.tab(try #require(w.pane.openPDF(.file(v.file))))
    try highlighted(w, t, "runs nor")
    let page = try #require(t.pdf.document?.page(at: 0))
    let lit = try #require(page.annotations.first { $0.type == "Highlight" }).bounds
    let mark = PDFPlaces.mark(after: lit, on: page, .yellow, id: "h")
    let next = try #require(PDFPlaces.nextGlyph(after: lit, on: page))
    #expect(mark.bounds.maxX > next.minX && mark.bounds.minY >= lit.maxY && abs(mark.bounds.midX - lit.maxX) < 0.5)
  }

  @Test func anAnnotationIsWrittenAtTheHighlightMarksItsEndAndShowsWhenItIsClickedAgain() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let (w, t, fake) = try clicked(v, "runs north")
    defer { w.close() }
    press(t.highlightBar.buttons[0])
    let pop = try #require(t.pop)
    let opened = try #require(fake.shown.last)
    #expect(!pop.view.isHidden && opened.notes.isEmpty && opened.write && fake.focused == 1, "ready to write")
    #expect(opened.title == "Field notes" && opened.range == "p. 1" && opened.folder == v.vault.url(of: t.entryPath!))
    // under the highlight's last line, from where it starts
    let line = try #require(t.lines(of: t.shownHighlight).first?.1)
    let box = t.convert(pop.view.frame, from: pop.view.superview)
    #expect(abs(box.minY - (line.maxY + 6)) < 0.5 && abs(box.minX - line.minX) < 0.5)
    #expect(pop.view.superview === w.window.contentView, "over the window, where no pane clips it")
    #expect(t.highlightBar.isHidden, "the popup offers what its bar does")
    fake.act?(.add("Which mill?", ask: true))
    fake.act?(.add("Look at the map", ask: false))
    let e = try entry(v)
    #expect(e.sidenotes.map(\.note.text) == ["Which mill?", "Look at the map"])
    #expect(e.sidenotes.allSatisfy { $0.place == e.highlights[0].place && !$0.note.alwaysShow })
    #expect(e.sidenotes[0].note.question.map { !$0.done && $0.answers.isEmpty } == true)
    #expect(e.sidenotes[1].note.question == nil)
    #expect(fake.shown.last?.notes == e.sidenotes && fake.shown.last?.write == false, "shown again, written in no more")
    let page = try #require(t.pdf.document?.page(at: 0))
    let mark = try #require(page.annotations.first { $0.type == "Circle" })
    let lit = try #require(page.annotations.first { $0.type == "Highlight" }).bounds
    // raised like a superscript in the gap after the last glyph, clear of the next word
    #expect(mark.bounds.minX >= lit.maxX && abs(mark.bounds.maxY - lit.maxY) < 0.5 && mark.bounds.width <= 3)
    #expect(mark.bounds.maxX < (try #require(PDFPlaces.nextGlyph(after: lit, on: page))).minX)

    // clicked again: the bar and, under it, the annotations, not written in
    t.dismiss()
    #expect(t.pop == nil && fake.ended == 1, "what was being written is added as it closes")
    t.released(at: t.pdf.convert(CGPoint(x: mark.bounds.midX, y: mark.bounds.midY), from: page))
    #expect(t.highlightBar.isHidden && t.pop != nil && fake.shown.last?.notes.count == 2, "the popup, not the bar")
    #expect(fake.shown.last?.write == false && fake.focused == 2, "not written in, but it has the keys")
    for n in e.sidenotes { fake.act?(.delete(n.id)) }
    #expect(try entry(v).sidenotes.isEmpty && fake.shown.last?.notes.isEmpty == true && t.pop != nil)
    #expect(!page.annotations.contains { $0.type == "Circle" }, "no annotations: no mark")
    fake.act?(.close)
    #expect(t.pop == nil && w.window.firstResponder === t)
  }

  /// What is done in the popup is written to the entry's file: an annotation changed, a question answered, its answer
  /// changed and deleted, resolved and opened again; the title bar's Remove Highlight takes the highlight with them
  @Test func whatIsDoneInThePopupIsWrittenToTheEntrysFile() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let (w, t, fake) = try clicked(v, "runs north")
    defer { w.close() }
    t.annotate()
    fake.act?(.add("Which mill?", ask: true))
    fake.act?(.add("A note", ask: false))
    var e = try entry(v)
    let (q, n) = (e.sidenotes[0].id, e.sidenotes[1].id)
    fake.act?(.write(n, "A better note"))
    fake.act?(.answer(q, "The old one"))
    fake.act?(.answer(q, "Or the new one"))
    e = try entry(v)
    #expect(e.sidenotes[1].note.text == "A better note")
    let answers = try #require(e.sidenotes[0].note.question?.answers)
    #expect(answers.map(\.text) == ["The old one", "Or the new one"] && Set(answers.map(\.id)).count == 2)
    fake.act?(.writeAnswer(q, answer: answers[0].id, "The oldest one"))
    fake.act?(.writeAnswer(q, answer: answers[1].id, ""))
    fake.act?(.done(q, true))
    e = try entry(v)
    #expect(e.sidenotes[0].note.question?.answers.map(\.text) == ["The oldest one"])
    #expect(e.sidenotes[0].note.question?.done == true)
    #expect(fake.shown.last?.notes == e.sidenotes)
    fake.act?(.done(q, false))
    #expect(try entry(v).sidenotes[0].note.question?.done == false)
    // written empty: gone
    fake.act?(.write(n, ""))
    #expect(try entry(v).sidenotes.map(\.id) == [q])
    fake.act?(.remove)
    e = try entry(v)
    #expect(e.highlights.isEmpty && e.sidenotes.isEmpty && t.pop == nil && t.highlightBar.isHidden)
  }

  /// A highlight removed with its annotations is one step the window's Undo brings back as it was (the entry's file
  /// the same, ids, places, a question's answers and the lists' order), and Redo takes away again; the bar's Remove
  /// of a highlight without annotations too
  @Test func removingAHighlightIsUndoneAndRedone() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let (w, t, fake) = try clicked(v, "runs north")
    defer { w.close() }
    t.annotate()
    fake.act?(.add("Which mill?", ask: true))
    fake.act?(.add("A note", ask: false))
    let q = try entry(v).sidenotes[0].id
    fake.act?(.answer(q, "The old one"))
    t.dismiss()
    // one made later, before it in neither list
    try highlighted(w, t, "far bank")
    t.showHighlight([try #require(try entry(v).highlights.last)])
    t.annotate()
    fake.act?(.add("Which bank?", ask: false))
    t.dismiss()
    let file = v.vault.url(of: try #require(t.entryPath)).appending(path: Vault.entryFileName)
    let before = try Data(contentsOf: file)
    let all = try entry(v)
    t.released(at: try point(on: t))
    #expect(t.shownHighlight.first?.id == all.highlights[0].id)
    fake.act?(.remove)
    #expect(try entry(v).highlights.map(\.id) == [all.highlights[1].id])
    let removed = try entry(v)
    #expect(removed.sidenotes.map(\.note.text) == ["Which bank?"])
    let undo = try #require(t.undoManager)
    #expect(undo === w.window.undoManager && undo.canUndo && undo.undoActionName == "Remove Highlight")
    undo.undo()
    #expect(try Data(contentsOf: file) == before && t.entry == all)
    let page = try #require(t.pdf.document?.page(at: 0))
    let drawn = page.annotations.map(\.type)
    #expect(drawn.filter { $0 == "Highlight" }.count == 2 && drawn.contains("Circle"), "drawn again")
    #expect(undo.canRedo && undo.redoActionName == "Remove Highlight")
    undo.redo()
    let redone = try entry(v)
    #expect(redone.highlights.count == 1 && redone.sidenotes.count == 1)
    undo.undo()
    #expect(try Data(contentsOf: file) == before)
    // the bar's Remove, nothing written on it
    try highlighted(w, t, "mill")
    let plain = try Data(contentsOf: file)
    let mill = try #require(try entry(v).highlights.last)
    t.showHighlight([mill])
    press(t.highlightBar.buttons[1])
    #expect(try entry(v).highlights.count == 2)
    undo.undo()
    #expect(try Data(contentsOf: file) == plain)
  }

  /// The look changed while it is open: shown again in it, what was being written in it added first
  @Test func thePopupIsShownAgainInANewLook() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let (w, t, fake) = try clicked(v, "runs north")
    defer { w.close() }
    t.annotate()
    fake.onEnd = { fake.act?(.add("Half written", ask: false)) }
    let dark = ReadingBarLook.warmInk(dark: true)
    w.pane.barLook = dark
    t.barLookChanged(dark)
    #expect(fake.ended == 1 && t.pop != nil && fake.shown.last?.look == dark)
    #expect(fake.shown.last?.notes.map(\.note.text) == ["Half written"] && fake.made == 2)
  }

  /// Questions on the entries' passages, for the board's question list: listed with their anchors, done and answered
  /// in the entry's file
  @Test func questionsAreListedWithTheirAnchorsAndAreDoneAndAnsweredInTheEntrysFile() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let (w, t, fake) = try clicked(v, "far bank")
    defer { w.close() }
    t.annotate()
    fake.act?(.add("Which bank?", ask: true))
    fake.act?(.add("Not a question", ask: false))
    // what the board asks, through the protocol
    let s: any SourceProvider = ReadingSources(pane: w.pane)
    let e = try entry(v)
    let qs = s.questions()
    #expect(qs.count == 1 && s.questions(in: e.id) == qs && s.questions(in: EntryID(rawValue: "other")).isEmpty)
    let q = try #require(qs.first)
    #expect(q.anchor == SourceAnchor(entry: e.id, place: e.highlights[0].place) && q.entryTitle == "Field notes")
    #expect(q.note.text == "Which bank?" && q.sidenote == e.sidenotes[0].id)
    let answer = try s.answer("The east one", question: q.sidenote, in: e.id)
    try s.setDone(true, question: q.sidenote, in: e.id)
    let written = try #require(try entry(v).sidenotes.first?.note.question)
    #expect(written.done && written.answers.map(\.text) == ["The east one"] && written.answers[0].id == answer)
    #expect(s.questions().first?.note.question == written, "the list sees it at once")
    #expect(throws: VaultError.self) { try s.setDone(true, question: e.sidenotes[1].id, in: e.id) }
  }

  @Test func theAnnotationPopupGoesBelowTheHighlightAndAboveOnlyWhenThereIsNoRoom() {
    let size = CGSize(width: 200, height: 120)
    let visible = CGRect(x: 0, y: 0, width: 400, height: 600)
    let lines = [CGRect(x: 60, y: 200, width: 200, height: 16), CGRect(x: 20, y: 218, width: 300, height: 16)]
    #expect(AnnotationPop.origin(size: size, lines: lines, visible: visible) == CGPoint(x: 60, y: 240))
    let low = lines.map { $0.offsetBy(dx: 0, dy: 300) }
    #expect(AnnotationPop.origin(size: size, lines: low, visible: visible) == CGPoint(x: 60, y: 500 - 6 - 120))
    let right = [CGRect(x: 380, y: 100, width: 10, height: 16)]
    #expect(AnnotationPop.origin(size: size, lines: right, visible: visible).x == 200)
    for dy in stride(from: -200.0, through: 560, by: 20) {
      let ls = lines.map { $0.offsetBy(dx: 0, dy: dy) }
      let r = CGRect(origin: AnnotationPop.origin(size: size, lines: ls, visible: visible), size: size)
      #expect(!ls.contains { $0.intersects(r) }, "\(r) over \(ls)")
    }
  }

  /// The side is chosen once with room for one more note: low on the page, where the empty popup would fit below but
  /// not with a note added, it goes above, and stays there as it grows, growing upwards
  @Test func theAnnotationPopupKeepsItsSideAndGrowsAwayFromTheHighlight() {
    let visible = CGRect(x: 0, y: 0, width: 400, height: 600)
    let lines = [CGRect(x: 60, y: 440, width: 200, height: 16)]
    let empty = CGSize(width: 200, height: 120)
    // 440 + 16 + 6 + 120 = 582 fits; with a note of 24 more it does not
    #expect(AnnotationPop.origin(size: empty, lines: lines, visible: visible).y == 462)
    #expect(!AnnotationPop.below(height: empty.height + 24, lines: lines, visible: visible))
    #expect(AnnotationPop.origin(size: empty, lines: lines, visible: visible, below: false).y == CGFloat(440 - 6 - 120))
    let grown = CGSize(width: 200, height: 200)
    #expect(AnnotationPop.origin(size: grown, lines: lines, visible: visible, below: false).y == CGFloat(440 - 6 - 200))
    // high on the page it goes below, and stays below as it grows
    let high = [CGRect(x: 60, y: 40, width: 200, height: 16)]
    #expect(AnnotationPop.below(height: empty.height + 24, lines: high, visible: visible))
    #expect(AnnotationPop.origin(size: grown, lines: high, visible: visible, below: true).y == 62)
    // no room either side: the side with more room
    #expect(AnnotationPop.below(height: 400, lines: [CGRect(x: 60, y: 250, width: 200, height: 16)], visible: visible))
    #expect(!AnnotationPop.below(height: 400, lines: [CGRect(x: 60, y: 350, width: 200, height: 16)], visible: visible))
  }

  /// What floats over the pages stays above the versions bar: the popup, the bars, a link's preview
  @Test func theAnnotationPopupAndTheBarsStayAboveTheVersionsBar() throws {
    let p = try PaperVault()
    defer { p.v.remove() }
    let w = try PDFWindow(p.v)
    defer { w.close() }
    let t = try w.tab(try #require(w.pane.openPDF(.entry(p.entry.id, version: VersionID(rawValue: "v7")))))
    #expect(!t.versions.isHidden && t.floatArea.maxY <= t.versions.frame.minY - 6)
    let plain = try w.tab(try #require(w.pane.openPDF(.file(p.v.file))))
    #expect(plain.floatArea == plain.bounds, "no bar: the whole tab")
    // a passage just above the bar: the popup goes above it, clear of the bar
    let lines = [CGRect(x: 40, y: t.versions.frame.minY - 30, width: 200, height: 16)]
    let o = AnnotationPop.origin(size: CGSize(width: 300, height: 140), lines: lines, visible: t.floatArea)
    #expect(o.y + 140 <= t.versions.frame.minY)
  }

  // MARK: Regions

  /// A region framed from one point of the first page to another, in the PDF view's space (page points)
  func frame(_ t: PDFTabView, _ a: CGPoint, _ b: CGPoint) throws {
    let page = try #require(t.pdf.document?.page(at: 0))
    t.beginRegion(at: t.pdf.convert(a, from: page))
    t.dragRegion(to: t.pdf.convert(CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2), from: page))
    t.dragRegion(to: t.pdf.convert(b, from: page))
    t.endRegion()
  }

  @Test func aRegionFramedOnAPageIsAPictureWithItsSizeAndAnchorAndCopiesAtTwiceItsSize() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let w = try PDFWindow(v)
    defer { w.close() }
    let t = try w.tab(try #require(w.pane.openPDF(.file(v.file))))
    try frame(t, CGPoint(x: 20, y: 330), CGPoint(x: 220, y: 380))
    let (page, r) = try #require(t.region)
    #expect(t.pdf.document?.index(for: page) == 0)
    #expect(
      abs(r.minX - 20) < 0.01 && abs(r.minY - 330) < 0.01 && abs(r.width - 200) < 0.01 && abs(r.height - 50) < 0.01)
    #expect(!t.regionFrame.isHidden && t.regionFrame.accessibilityIdentifier() == "ui-pdfregion")
    #expect(t.regionFrame.frame.width > 200, "drawn at the page's scale")
    #expect(!t.regionBar.isHidden && t.bar.isHidden)
    #expect(t.regionBar.buttons.map { $0.accessibilityIdentifier() } == ["ui-selectionadd", "ui-selectioncopy"])

    press(t.regionBar.buttons[1])
    let png = try #require(w.pasteboard.data(forType: .png))
    let image = try #require(NSBitmapImageRep(data: png))
    #expect(image.pixelsWide == 400 && image.pixelsHigh == 100)

    press(t.regionBar.buttons[0])
    let key = try #require(
      NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: .option, timestamp: 0, windowNumber: w.window.windowNumber,
        context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
    t.pdf.keyDown(with: key)
    #expect(w.collected.count == 2 && w.collected[0] == w.collected[1])
    let e = try entry(v)
    let c = try #require(w.collected.first)
    #expect(c.body == .image(alt: nil, width: 200, height: 50) && c.label == "p. 1" && c.title == "Field notes")
    #expect(
      c.source
        == SourceAnchor(
          entry: e.id,
          place: Place(
            version: e.versions[0].id, block: .page(1, rect: Place.Rect(x: 20, y: 330, width: 200, height: 50)))))
    // the board reads the same picture back
    let s = ReadingSources(pane: w.pane)
    let anchor = try #require(c.source)
    #expect(s.blockSize(anchor) == CGSize(width: 200, height: 50))

    // a click elsewhere clears it
    t.dismiss()
    #expect(t.region == nil && t.regionFrame.isHidden && t.regionBar.isHidden)
    // a frame of almost nothing is no region
    try frame(t, CGPoint(x: 50, y: 50), CGPoint(x: 52, y: 51))
    #expect(t.region == nil && t.regionBar.isHidden)
  }

  @Test func aRegionStaysWithinItsPage() throws {
    let v = try PDFVault()
    defer { v.remove() }
    let w = try PDFWindow(v)
    defer { w.close() }
    let t = try w.tab(try #require(w.pane.openPDF(.file(v.file))))
    try frame(t, CGPoint(x: 250, y: 350), CGPoint(x: 400, y: 600))
    let (_, r) = try #require(t.region)
    #expect(r.maxX <= 300 && r.maxY <= 400 && abs(r.width - 50) < 0.01)
  }

  @Test func picturesAndDocumentsAreKeptUntilTheSourcesChange() async throws {
    let v = try PDFVault()
    defer { v.remove() }
    let w = try PDFWindow(v)
    defer { w.close() }
    let t = try w.tab(try #require(w.pane.openPDF(.file(v.file))))
    try frame(t, CGPoint(x: 20, y: 330), CGPoint(x: 220, y: 380))
    t.collect()
    let anchor = try #require(w.collected.first?.source)
    let s = ReadingSources(pane: w.pane)
    var changed = 0
    s.onSourcesChanged = { changed += 1 }
    let a = try #require(await s.blockImage(anchor, pixelWidth: 300))
    let b = try #require(await s.blockImage(anchor, pixelWidth: 300))
    #expect(a === b && a.width == 300 && a.height == 75)
    let placed = try #require(anchor.place)
    let url = try #require(w.pane.locate(.entry(anchor.entry, version: placed.version), scanning: false)?.url)
    #expect(s.document(url) === s.document(url))
    let doc = s.document(url)
    s.sourcesChanged()
    #expect(changed == 1)
    let c = try #require(await s.blockImage(anchor, pixelWidth: 300))
    #expect(c !== a && s.document(url) !== doc)
  }
}

/// The popup the shell makes, standing in for it: what it is shown, and what is done in it said by the test
@MainActor final class FakePop {
  var shown: [AnnotationPop.Shown] = []
  var act: ((AnnotationPop.Action) -> Void)?
  var made = 0
  var focused = 0
  var ended = 0
  /// What closing it does first (what was being written added)
  var onEnd: (() -> Void)?

  init(_ pane: ReadingPane) {
    pane.makePop = { [unowned self] act, _ in
      self.act = act
      self.made += 1
      let size = CGSize(width: 300, height: 120)
      return AnnotationPop(
        view: NSView(), size: { size }, frame: { CGRect(origin: $0, size: size) },
        show: { [unowned self] in self.shown.append($0) }, focus: { [unowned self] in self.focused += 1 },
        end: { [unowned self] in
          self.ended += 1
          self.onEnd?()
          self.onEnd = nil
        })
    }
  }
}

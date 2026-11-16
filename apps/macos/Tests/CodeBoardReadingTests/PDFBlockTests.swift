import AppKit
import CodeBoardModel
import CodeBoardResources
import Foundation
import PDFKit
import Testing

@testable import CodeBoardReading

/// A made-up two-page paper read by its blocks: a PDF made here, its block list built from where PDFKit finds each
/// line, the TeX its lines are of, and a link from "(1)" to the equation
@MainActor struct BlockPaper {
  let v: PDFVault
  let path: String
  let entry: Entry
  let version = VersionID(rawValue: "zh")

  static let pages = [
    "1 Intro\nThe river runs north past the mill.\nBirds rest (1) by the bank.\n\nE = mc2 (1)\n\n[picture]\nFigure 1: A boat.",
    "Evening light falls on the water.\nTable 1: Numbers.",
  ]

  static let tex = #"""
    \documentclass{article}
    \newcommand{\R}{\mathbb{R}}
    \begin{document}
    \section{Intro}
    The river runs \emph{north} past the mill.
    Birds rest (\ref{eq:e}) by the bank.
    \begin{equation}
    E = mc^2 \label{eq:e}
    \end{equation}
    \begin{figure}
    \caption{A boat.}
    \end{figure}
    Evening light falls on the water.
    \begin{table}
    \caption{Numbers.}
    \end{table}
    \end{document}
    """#

  init() throws {
    v = try PDFVault()
    let doc = try #require(PDFDocument(data: makePDF(Self.pages)))
    func line(_ page: Int, _ text: String) throws -> CGRect {
      let p = try #require(doc.page(at: page - 1))
      let str = try #require(p.string) as NSString
      let sel = try #require(p.selection(for: str.range(of: text)))
      return sel.bounds(for: p)
    }
    func block(
      _ id: String, _ kind: String, _ lines: ClosedRange<Int>, _ page: Int, _ texts: [String], parent: String? = nil
    )
      throws -> [String: Any]
    {
      let r = try texts.map { try line(page, $0) }.reduce(CGRect.null) { $0.union($1) }
      var b: [String: Any] = [
        "id": id, "kind": kind, "first_line": lines.lowerBound, "last_line": lines.upperBound,
        "rects": [["page": page, "x0": r.minX, "y0": r.minY, "x1": r.maxX, "y1": r.maxY]],
      ]
      if let parent { b["parent"] = parent }
      return b
    }
    let blocks = [
      try block("PAR-0-0", "heading", 4...4, 1, ["1 Intro"]),
      try block("PAR-1-0", "text", 5...6, 1, ["The river runs north past the mill.", "Birds rest (1) by the bank."]),
      try block("BLK-0", "math", 7...9, 1, ["E = mc2 (1)"]),
      try block("BLK-1", "figure", 10...12, 1, ["[picture]", "Figure 1: A boat."]),
      try block("CAP-0", "caption", 11...11, 1, ["Figure 1: A boat."], parent: "BLK-1"),
      try block("PAR-2-0", "text", 13...13, 2, ["Evening light falls on the water."]),
      try block("BLK-2", "table", 14...16, 2, ["Table 1: Numbers."]),
      try block("CAP-1", "caption", 15...15, 2, ["Table 1: Numbers."], parent: "BLK-2"),
    ]
    let anchors = try JSONSerialization.data(withJSONObject: [
      "pdf": "p.zh.pdf", "tex": "zh.tex", "pages": [[String: Any]](), "blocks": blocks,
    ])
    // "(1)" links to just above the equation
    let p1 = try #require(doc.page(at: 0))
    let link = PDFAnnotation(bounds: try line(1, "(1) by"), forType: .link, withProperties: nil)
    let eq = try line(1, "E = mc2 (1)")
    link.action = PDFActionGoTo(destination: PDFDestination(page: p1, at: CGPoint(x: eq.minX, y: eq.maxY + 4)))
    p1.addAnnotation(link)
    let pdf = Self.pointingAtPage(try #require(doc.dataRepresentation()))
    let e = Entry(
      id: EntryID(rawValue: "e-paper"), title: "Rivers and Mills: A Study of Banks", added: 0,
      origin: .arxiv("2401.00001"),
      versions: [
        Version(
          id: version, label: "v1 中文", added: 0, language: "zh",
          content: .pdf(file: "p.zh.pdf", blocks: "p.zh.anchors.json", source: "p.zh.tex"))
      ])
    path = try v.vault.newEntry(
      e, in: v.resource.path, with: ["p.zh.pdf": pdf, "p.zh.anchors.json": anchors, "p.zh.tex": Data(Self.tex.utf8)])
    entry = e
  }

  /// PDFKit writes a link's destination page as a name no reader resolves (`/D [ /##1 /XYZ … ]`): the first page's
  /// object put there instead, padded to the same length so the file's offsets hold
  static func pointingAtPage(_ pdf: Data) -> Data {
    guard var text = String(data: pdf, encoding: .isoLatin1), let page = text.firstMatch(of: /\/Kids \[ (\d+) 0 R/),
      let dest = text.firstMatch(of: /\/D \[ (\/\S+) \/XYZ/)
    else { return pdf }
    let ref = "\(page.1) 0 R"
    guard ref.count <= dest.1.count else { return pdf }
    text.replaceSubrange(
      dest.1.startIndex..<dest.1.endIndex, with: ref.padding(toLength: dest.1.count, withPad: " ", startingAt: 0))
    return text.data(using: .isoLatin1) ?? pdf
  }

  func anchor(_ id: String, _ range: Range<Int>? = nil) -> SourceAnchor {
    SourceAnchor(entry: entry.id, place: Place(version: version, block: .id(id), range: range))
  }
}

@MainActor @Suite(.serialized) struct PDFBlockTests {
  func open(_ p: BlockPaper) throws -> (PDFWindow, PDFTabView) {
    let w = try PDFWindow(p.v)
    let t = try w.tab(try #require(w.pane.openPDF(.entry(p.entry.id, version: p.version))))
    return (w, t)
  }

  /// A point of a page (page space) in the PDF view
  func at(_ t: PDFTabView, _ page: Int, _ text: String) throws -> CGPoint {
    let pg = try #require(t.pdf.document?.page(at: page - 1))
    let str = try #require(pg.string) as NSString
    let sel = try #require(pg.selection(for: str.range(of: text)))
    let b = sel.bounds(for: pg)
    return t.pdf.convert(CGPoint(x: b.midX, y: b.midY), from: pg)
  }

  func select(_ t: PDFTabView, _ text: String, page: Int = 1) throws {
    let pg = try #require(t.pdf.document?.page(at: page - 1))
    let str = try #require(pg.string) as NSString
    t.pdf.setCurrentSelection(pg.selection(for: str.range(of: text)), animate: false)
    t.released()
  }

  @Test func aClickOnAFigureOrAFormulaTakesTheWholeObjectFramedAndOneOnTextClearsIt() throws {
    let p = try BlockPaper()
    defer { p.v.remove() }
    let (w, t) = try open(p)
    defer { w.close() }
    #expect(t.paper?.list.blocks.count == 8)
    // the caption is the figure's
    #expect(t.clickObject(at: try at(t, 1, "A boat.")))
    #expect(
      t.object?.id == "BLK-1" && !t.regionFrame.isHidden && t.regionFrame.accessibilityIdentifier() == "ui-pdfobject")
    #expect(
      !t.regionBar.isHidden
        && t.regionBar.buttons.map { $0.accessibilityIdentifier() } == ["ui-selectionadd", "ui-selectioncopy"])
    let fig = try #require(p.anchorBlock(t, "BLK-1"))
    let c = try #require(t.collecting())
    #expect(c.body == .image(alt: nil, width: fig.width, height: fig.height))
    #expect(c.source == p.anchor("BLK-1") && c.label == "图 1" && c.title == "Rivers and Mills: A Study of Banks")
    // the formula: its LaTeX
    #expect(t.clickObject(at: try at(t, 1, "E = mc2")))
    #expect(t.collecting()?.body == .note(markdown: "$$\nE = mc^2\n$$"))
    #expect(t.collecting()?.label == "式 (1)")
    t.copySelection()
    #expect(w.pasteboard.string(forType: .string) == "E = mc^2")
    // text is not an object: the click goes on to PDFKit, which clears it
    #expect(!t.clickObject(at: try at(t, 1, "river")))
    t.dismiss()
    #expect(t.object == nil && t.regionFrame.isHidden && t.regionFrame.accessibilityIdentifier() == "ui-pdfregion")
  }

  @Test func aTripleClickedLineIsItsWholeBlockAndASelectionIsPlacesOfBlocks() throws {
    let p = try BlockPaper()
    defer { p.v.remove() }
    let (w, t) = try open(p)
    defer { w.close() }
    try select(t, "Birds rest (1) by the bank.")
    t.selectParagraph()
    #expect(
      t.selectedText?.hasPrefix("The river runs north") == true && t.selectedText?.hasSuffix("by the bank.") == true)
    let whole = try #require(t.pdf.currentSelection)
    #expect(t.places(whole, version: p.version) == [Place(version: p.version, block: .id("PAR-1-0"))])
    // a part: the span of the block's TeX it is of
    try select(t, "runs north past")
    let part = try #require(t.pdf.currentSelection)
    let text = try #require(t.paper?.block("PAR-1-0").flatMap { t.paper?.text($0) })
    let span = (text as NSString).range(of: "runs \\emph{north} past")
    let places = t.places(part, version: p.version)
    #expect(places == [Place(version: p.version, block: .id("PAR-1-0"), range: span.location..<span.upperBound)])
    let c = try #require(t.collecting())
    #expect(c.body == .note(markdown: "runs *north* past") && c.label == "§ 1")
    t.copySelection()
    #expect(w.pasteboard.string(forType: .string) == "runs *north* past")
    // across two blocks
    let pg = try #require(t.pdf.document?.page(at: 0))
    let str = try #require(pg.string) as NSString
    t.pdf.setCurrentSelection(
      t.pdf.document?.selection(
        from: pg, atCharacterIndex: str.range(of: "Intro").location, to: pg,
        atCharacterIndex: str.range(of: "river").upperBound - 1), animate: false)
    #expect(
      t.pdf.currentSelection.map { t.places($0, version: p.version) }?.map(\.block) == [
        .id("PAR-0-0"), .id("PAR-1-0"),
      ])
  }

  @Test func aBlocksSpanIsRevealedAsItsTextAndAnObjectAsItsFrame() throws {
    let p = try BlockPaper()
    defer { p.v.remove() }
    let (w, t) = try open(p)
    defer { w.close() }
    let text = try #require(t.paper?.block("PAR-1-0").flatMap { t.paper?.text($0) })
    let span = (text as NSString).range(of: "runs \\emph{north} past")
    t.reveal(Place(version: p.version, block: .id("PAR-1-0"), range: span.location..<span.upperBound))
    #expect(t.selectedText == "runs north past")
    t.reveal(Place(version: p.version, block: .id("PAR-1-0")))
    #expect(t.selectedText?.hasSuffix("by the bank.") == true)
    t.reveal(Place(version: p.version, block: .id("BLK-2")))
    #expect(t.object?.id == "BLK-2" && !t.regionFrame.isHidden)
  }

  @Test func aHighlightOnABlockPlaceIsDrawnOverItsSpan() throws {
    let p = try BlockPaper()
    defer { p.v.remove() }
    let (w, t) = try open(p)
    defer { w.close() }
    try select(t, "runs north past")
    t.highlight()
    let e = try p.v.vault.entry(at: p.path)
    guard case .id("PAR-1-0")? = e.highlights.first?.place.block else {
      Issue.record("not on the block")
      return
    }
    #expect(e.highlights.first?.place.range != nil)
    let drawn = t.drawn.filter { $0.1.type == "Highlight" }
    #expect(drawn.count == 1)
  }

  @Test func theSourcesLabelBlocksByThePapersNumbersAndDrawThemWithTheMacros() async throws {
    let p = try BlockPaper()
    defer { p.v.remove() }
    let pane = ReadingPane()
    pane.vault = p.v.vault
    pane.entries = EntryIndex(p.v.vault, try p.v.vault.tree())
    let s = ReadingSources(pane: pane)
    #expect(s.sourceLabel(p.anchor("BLK-0")) == SourceLabel(title: "Rivers and Mills", number: "式 (1)", icon: .paper))
    #expect(s.sourceLabel(p.anchor("BLK-2"))?.number == "表 1")
    #expect(s.sourceLabel(p.anchor("PAR-2-0"))?.number == "§ 1")
    #expect(s.mathPreamble(for: p.anchor("BLK-0")) == "\\newcommand{\\R}{\\mathbb{R}}")
    let size = try #require(s.blockSize(p.anchor("BLK-1")))
    #expect(size.width > 0 && size.height > 0)
    let image = try #require(await s.blockImage(p.anchor("BLK-1"), pixelWidth: 200))
    #expect(image.width == 200)
  }

  @Test func aLinksTargetIsTheBlockItGoesToPreviewedAfterAMoment() async throws {
    let p = try BlockPaper()
    defer { p.v.remove() }
    let (w, t) = try open(p)
    defer { w.close() }
    let link = try at(t, 1, "(1) by")
    #expect(t.linkTarget(at: link)?.0.id == "BLK-0")
    #expect(t.linkTarget(at: try at(t, 1, "river")) == nil)
    t.pointerMoved(to: link)
    #expect(t.refPreview.isHidden, "not at once")
    await t.previewTask?.value
    #expect(
      !t.refPreview.isHidden && t.refPreview.accessibilityIdentifier() == "ui-refpreview" && t.refPreview.image != nil)
    t.pointerMoved(to: try at(t, 1, "river"))
    #expect(t.refPreview.isHidden)
    // a link is not an object click
    #expect(!t.clickObject(at: try at(t, 1, "Birds")))
  }
}

extension BlockPaper {
  /// A block's rects on its first page together
  @MainActor func anchorBlock(_ t: PDFTabView, _ id: String) -> CGSize? {
    guard let b = t.paper?.block(id), let n = b.firstPage else { return nil }
    return b.union(on: n)?.size
  }
}

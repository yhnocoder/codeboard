import AppKit
import CodeBoardModel
import CodeBoardNotes
import Testing

import struct CodeCore.CodeSelection

@testable import CodeBoardCanvas

// An Always Show sidenote in its code card (CodeBody .inotes, highlights.ts useHighlights): drawn by the Note renderer
// under its Highlight's last row (a line's, or a hidden run's), from where the Highlight's code starts, the card growing
// by its height and the Highlight's band down to its end; none where the Highlight has no row (its lines all blank and
// blank lines hidden) or the card is in a folded Section. Turned on and off in one step each, undone as one.

private let seg = SegmentID(rawValue: "s1")

private func alwaysBoard(
  hidden: [ClosedRange<Int>] = [], blank: Bool = false, folded: Bool = false, arrow: Bool = false
) -> Board {
  let lines = [
    "def schedule(queue):", "    batch = queue.take(8)", "    if batch:", "        run(batch)", "", "    return batch",
  ]
  let s = Segment(
    id: seg, source: nil, language: "python", firstLine: 10, lines: lines, hidden: hidden,
    highlights: [12...13, 14...14])
  func code(_ id: String, x: Double) -> Card {
    Card(
      id: cid(id), x: x, y: 0, width: 420, section: folded ? SectionID(rawValue: "g") : nil,
      content: .own(CardContent(body: .code(CodeCard(segments: [s], hide: HideFlags(blankLines: blank))))))
  }
  func note(_ id: String, _ card: String, _ r: ClosedRange<Int>, _ text: String) -> Sidenote {
    Sidenote(
      id: SidenoteID(rawValue: id), anchor: .card(cid(card), segment: seg, lines: r),
      body: .text(TextNote(text: text, alwaysShow: true)))
  }
  return Board(
    id: BoardID(rawValue: "always"),
    cards: [code("c1", x: 0), code("plain", x: 600)],
    // from the last line, under both Highlights' notes, to the other card's header
    arrows: arrow
      ? [
        Arrow(
          id: ArrowID(rawValue: "l"), from: Endpoint(card: cid("c1"), segment: seg, line: 15),
          to: Endpoint(card: cid("plain")))
      ] : [],
    sections: folded
      ? [
        Section(
          id: SectionID(rawValue: "g"), title: "G", x: -40, y: -60, width: 500, height: 400, collapsed: true)
      ] : [],
    sidenotes: [
      note("a", "c1", 12...13, "Takes **eight** at most, waits for none."),
      note("b", "c1", 12...13, "A second one, under the first."),
      // on the blank line
      note("e", "c1", 14...14, "On the blank line."),
    ])
}

@MainActor @Suite(.serialized) struct CanvasAlwaysShowTests {
  func layout(_ r: Rig, _ id: String) throws -> (CodeLayout, CGFloat) {
    let p = try #require(r.canvas.scene?.placed[cid(id)]?.code)
    return (p.layout, p.top)
  }

  func notesRow(_ l: CodeLayout) -> [CodeLayout.Placed] {
    l.rows.filter { if case .notes = $0.row { true } else { false } }
  }

  /// native: its notes measured and drawn by the native component, as the app does (NativeNotes)
  @Test(arguments: [false, true]) func anAlwaysShownSidenoteIsDrawnUnderItsLinesAndTheCardGrows(native: Bool)
    async throws
  {
    let r = try await Rig(alwaysBoard(), zoom: 1, native: native)
    defer { r.close() }
    await r.settle()
    let (l, top) = try layout(r, "c1")
    let (plain, _) = try layout(r, "plain")
    // two Highlights with notes: under line 13 (a and b, one under the other) and under the blank line 14
    let rows = notesRow(l)
    #expect(rows.count == 2 && l.inline.count == 2)
    let line13 = try #require(l.row(segment: 0, line: 13))
    let first = try #require(l.inline.first)
    #expect(first.always.lines == 12...13 && first.always.notes.map(\.id.rawValue) == ["a", "b"])
    #expect(first.y == line13.y + line13.height && rows.first?.y == first.y)
    #expect(first.always.notes.allSatisfy { $0.height > 10 }, "measured: \(first.always.notes)")
    #expect(rows.first?.height == first.always.notes.reduce(0) { $0 + $1.height })
    // where the Highlight's least indented code starts: 4 columns in (no indent hidden: the def is at 0)
    let m = r.canvas.theme.metrics
    #expect(l.dedent == 0 && abs(first.x - 4 * m.charWidth) < 0.01, "\(first.x) \(l.shift)")
    // the line after comes after the notes; the card grows by them; the band reaches their end
    let line14 = try #require(l.row(segment: 0, line: 14))
    #expect(line14.y == first.y + (rows.first?.height ?? 0))
    let grown = rows.reduce(0) { $0 + $1.height }
    #expect(abs(l.height - plain.height - grown) < 0.01)
    #expect(abs(r.rect("c1").height - (top + l.height)) < 0.01 && r.rect("c1").height > r.rect("plain").height)
    #expect(l.bands.contains { abs($0.upperBound - (first.y + (rows.first?.height ?? 0))) < 0.01 })
    // the card is drawn with its notes by the Note renderer, ink where each note is
    let c = r.canvas
    let item = try #require(c.scene?.items.first { $0.owner == .card(cid("c1")) })
    guard case .code(let d) = item.drawing else {
      Issue.record("not code")
      return
    }
    #expect(item.drawing.byRenderer && d.inline.map(\.id.rawValue) == ["a", "b", "e"])
    let a = d.inline[0]
    #expect(a.frame.minX == l.gutter + first.x && a.frame.minY == top + first.y)
    #expect(a.frame.width == l.inlineWidth(card: 420, x: first.x, metrics: m))
    let snap = try #require(
      await CanvasView.picture(item, scale: 2, theme: c.theme, display: c.display, priority: 1), "drawn")
    #expect(ink(snap.surface, in: a.frame, scale: 2) > 20, "the note's text is there")
    #expect(ink(snap.surface, in: CGRect(x: 0, y: top, width: a.frame.minX - 2, height: a.frame.height), scale: 2) == 0)
  }

  /// Hidden by Hide Lines: under the hidden run's row, as main; lines all blank and blank lines hidden: none; in a folded
  /// Section: the card is not drawn, nor its notes
  @Test func hiddenLinesKeepThemUnderTheirRowAndNoRowOrAFoldedSectionShowsNone() async throws {
    let hid = try await Rig(alwaysBoard(hidden: [12...13]), zoom: 1)
    let (l, _) = try layout(hid, "c1")
    let gap = try #require(l.rows.firstIndex { if case .gap(_, 12, 13) = $0.row { true } else { false } })
    #expect(l.rows.indices.contains(gap + 1))
    if case .notes = l.rows[gap + 1].row {} else { Issue.record("not under the hidden run: \(l.rows[gap + 1].row)") }
    hid.close()
    let blank = try await Rig(alwaysBoard(blank: true), zoom: 1)
    let (b, _) = try layout(blank, "c1")
    #expect(b.inline.map(\.always.lines) == [12...13], "the blank line's has no row")
    blank.close()
    let folded = try await Rig(alwaysBoard(folded: true), zoom: 1)
    defer { folded.close() }
    #expect(folded.canvas.scene?.placed[cid("c1")]?.code == nil)
    #expect(folded.canvas.scene?.items.contains { $0.owner == .card(cid("c1")) } == false)
  }

  /// Always Show off and on again from the popup: the card shrinks and grows back, one step each, undone as one; an
  /// arrow from a line below moves up and down with it; the flag is in the board's file
  @Test func turningItOffAndOnChangesTheCardsHeightAndUndoes() async throws {
    let r = try await Rig(alwaysBoard(arrow: true), zoom: 1)
    defer { r.close() }
    await r.settle()
    let tall = r.rect("c1").height
    func arrowLow() -> CGFloat? { r.canvas.scene?.arrows.first?.fill.cg.boundingBox.maxY }
    let low = try #require(arrowLow())
    let one = try #require(try layout(r, "c1").0.inline.first?.always.notes.first { $0.id.rawValue == "b" }?.height)
    r.canvas.openPop(.lines(Lines(card: cid("c1"), segment: seg, range: 12...13)))
    await r.canvas.popTask?.value
    r.canvas.popAction(.alwaysShow("b"))
    #expect(r.doc.undoName == "Always Show")
    await r.until("shorter") { abs(r.rect("c1").height - (tall - one)) < 0.01 }
    #expect(abs((arrowLow() ?? 0) - (low - one)) < 1, "the arrow from line 15 moved up with it")
    r.doc.flush()
    let saved = try Board(decoding: Data(contentsOf: r.file), file: r.file)
    if case .text(let t)? = saved.sidenote(SidenoteID(rawValue: "b"))?.body {
      #expect(!t.alwaysShow, "written to the file")
    } else {
      Issue.record("not in the file")
    }
    r.doc.undo()
    await r.until("back") { abs(r.rect("c1").height - tall) < 0.01 }
    #expect(abs((arrowLow() ?? 0) - low) < 1)
    r.doc.redo()
    await r.until("shorter again") { abs(r.rect("c1").height - (tall - one)) < 0.01 }
  }

  /// Written, Free code's Highlights, their Always Show sidenotes and the arrow ends on its lines follow the lines as
  /// they move (LineAnchors, as writeFreeCode makes them follow); the editor's undo brings them back with the lines, and
  /// an end whose line goes is at the header in the lost look (lines.ts moveLineRefs), as it is once written
  @Test func whileFreeCodeIsWrittenWhatIsOnItsLinesFollowsThem() async throws {
    let r = try await Rig(alwaysBoard(arrow: true), zoom: 1)
    defer { r.close() }
    await r.settle()
    let c = r.canvas
    let s = try #require(c.scene)
    let i = try #require(s.arrowModels.firstIndex { $0.id == ArrowID(rawValue: "l") })
    let (l, top) = try layout(r, "c1")
    let card = r.rect("c1")
    let drawn = try #require(s.arrows[i].pts.first?.y)
    let heights = l.inline.map { $0.always.notes.reduce(0) { $0 + $1.height } }
    let row10 = try #require(l.row(segment: 0, line: 10))
    let p = CGPoint(x: card.maxX - 10, y: card.minY + top + row10.y + 10)
    r.doubleClick(p)
    await r.editorReady()
    let v = try #require(c.editing?.codeView)
    func endY() -> CGFloat? { c.routedArrows[i]?.pts.first?.y }
    func line(_ n: Int) -> CGFloat? { v.frame(ofLines: n...n).map { card.minY + top + $0.first.midY } }
    // as drawn: the bands, the room under them, the end on line 15
    #expect(v.decorations.bands.map(\.lines) == [12...13, 14...14])
    #expect(v.insertions == [.init(afterLine: 13, height: heights[0]), .init(afterLine: 14, height: heights[1])])
    #expect(endY() == nil || endY() == drawn)
    // a line written above them: everything one line down
    r.press("\r")
    v.insertText("x = 1", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(v.decorations.bands.map(\.lines) == [13...14, 15...15])
    #expect(v.insertions.map(\.afterLine) == [14, 15])
    #expect(endY() == line(16) && endY() == drawn + 20)
    let room = v.layout.lines.rows.compactMap { if case .inserted = $0.kind { $0.y } else { nil } }
    let layers = c.editing?.written?.layers ?? []
    #expect(layers.count == 3 && layers.first?.frame.minY == room.first && layers.last?.frame.minY == room.last)
    // undone in the editor: back where they were
    while v.editor.text.contains("x = 1") { v.undo(nil) }
    #expect(v.decorations.bands.map(\.lines) == [12...13, 14...14] && endY() == drawn)
    // the end's line gone: at the header, lost
    let ns = v.editor.text as NSString
    let last = ns.range(of: "\n    return batch")
    v.change { $0.select(CodeSelection(anchor: last.location, head: NSMaxRange(last))) }
    v.perform(.deleteBackward)
    #expect(endY() == card.minY + c.theme.headerHeight / 2 && c.routedArrows[i]?.color == c.theme.arrowLost)
    r.press("\u{1b}")
    await r.until("left") { !c.isEditing }
    #expect(r.doc.board.arrows.first?.from.lost == true)
  }
}

/// Pixels with any ink in `rect` (card points) of a surface drawn at `scale`
private func ink(_ s: IOSurface, in rect: CGRect, scale: CGFloat) -> Int {
  s.lock(options: .readOnly, seed: nil)
  defer { s.unlock(options: .readOnly, seed: nil) }
  let p = s.baseAddress.assumingMemoryBound(to: UInt8.self)
  var n = 0
  let x0 = max(0, Int(rect.minX * scale))
  let x1 = min(s.width, Int(rect.maxX * scale))
  let y0 = max(0, Int(rect.minY * scale))
  let y1 = min(s.height, Int(rect.maxY * scale))
  guard x0 < x1, y0 < y1 else { return 0 }
  for y in y0..<y1 {
    for x in x0..<x1 where p[y * s.bytesPerRow + x * 4 + 3] > 40 { n += 1 }
  }
  return n
}

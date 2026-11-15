import AppKit
import CodeBoardMarkdown
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardMarkdownUI

// Writing in a card with the native editor, everything through the window as a person does it: presses go where the
// window's hit test puts them (the canvas, or the editor over the card), keys to its first responder, an input method's
// composition through the editor's own input context (Pinyin, this process's own input method). The window is under
// the desktop picture and the test guard is in (the canvas puts it in).

@MainActor @Suite(.serialized) struct NativeWindowWritingTests {
  static let text = "The vocabulary maps each word to a number."

  func note(_ id: String, x: Double, y: Double, width: Double = 300, height: Double? = nil, _ text: String) -> Card {
    Card(
      id: cid(id), x: x, y: y, width: width, height: height, content: .own(CardContent(body: .note(Note(text: text)))))
  }

  func rig(_ cards: [Card]) async throws -> Rig {
    try await Rig(Board(id: BoardID(rawValue: "window"), cards: cards), zoom: 1)
  }

  func writer(_ r: Rig) throws -> MarkdownEditorView { try #require(r.canvas.editing?.writer) }

  /// Where the editor draws the middle of a letter of `word` (its third), on the board
  func spot(_ r: Rig, _ v: MarkdownEditorView, _ word: String) throws -> CGPoint {
    let i = (v.source as NSString).range(of: word).location
    try #require(i != NSNotFound, "\(word)")
    let box = try #require(v.core.rects(for: (i + 2)..<(i + 3)).first)
    let inView = CGPoint(x: box.midX * v.zoom, y: box.midY * v.zoom)
    return r.canvas.camera.board(r.canvas.convert(v.convert(inView, to: nil), from: nil))
  }

  /// The text selected in the editor
  func selected(_ v: MarkdownEditorView) -> String {
    let s = v.core.selection
    let r = min(s.anchor, s.head)..<max(s.anchor, s.head)
    return (v.source as NSString).substring(with: NSRange(location: r.lowerBound, length: r.count))
  }

  /// A double-click on the selected Note: its first click opens the editor and its second, which the window gives the
  /// editor now under the pointer, only puts the caret there; what is typed goes into the word. Once it is open a
  /// double-click selects a word and a triple-click the paragraph
  @Test func theSecondClickOfTheDoubleClickThatOpensItOnlyPutsTheCaretThenClicksSelectWordsAndParagraphs()
    async throws
  {
    let r = try await rig([note("n1", x: 100, y: 100, Self.text)])
    defer { r.close() }
    // where its words are, read on the editor (it lays the Note out where the canvas draws it)
    r.click(through: r.centre("n1"))
    r.press("\r")
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let (vocabulary, number) = (try spot(r, try writer(r), "vocabulary"), try spot(r, try writer(r), "number"))
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.doc.selection == [.card(cid("n1"))])
    r.click(through: vocabulary)
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let v = try writer(r)
    #expect(r.window.contentView?.hitTest(r.at(vocabulary)) === v, "the editor is under the pointer")
    r.click(through: vocabulary, clicks: 2)
    #expect(v.core.selection.isEmpty, "no word selected: \(selected(v))")
    r.press("xy")
    // into the word where the caret went
    #expect(
      v.source.replacingOccurrences(of: "xy", with: "") == Self.text && !v.source.contains("vocabulary"),
      "\(v.source)")
    r.click(through: number)
    r.click(through: number, clicks: 2)
    #expect(selected(v) == "number")
    r.click(through: number)
    r.click(through: number, clicks: 2)
    r.click(through: number, clicks: 3)
    #expect(selected(v) == v.source, "the paragraph: \(selected(v))")
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
  }

  /// A press on the card's own paper while it is written in: below the text the caret goes to the end, beside it
  /// nothing changes; either way the writing goes on. A press on another card or on the canvas ends it
  @Test func aPressOnItsPaperBelowTheTextGoesToTheEndBesideItKeepsTheCaretAndElsewhereEnds() async throws {
    let r = try await rig([
      note("n1", x: 100, y: 100, height: 220, Self.text), note("n2", x: 500, y: 100, "Other"),
    ])
    defer { r.close() }
    let n = r.rect("n1")
    r.click(through: r.centre("n1"))
    r.press("\r")
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let v = try writer(r)
    let session = r.canvas.editing?.session
    v.core.select(MDSelection(4))
    r.click(through: CGPoint(x: n.midX, y: n.maxY - 20))
    #expect(r.canvas.editing?.session == session, "still writing")
    #expect(v.core.selection == MDSelection((Self.text as NSString).length), "the caret at the end")
    #expect(r.window.firstResponder === v)
    v.core.select(MDSelection(4))
    // in its right padding, beside the first line
    let line = try #require(v.core.rects(for: 0..<1).first)
    let lineY = r.canvas.convert(v.convert(CGPoint(x: 0, y: line.midY), to: nil), from: nil)
    let beside = CGPoint(x: n.maxX - 4, y: r.canvas.camera.board(lineY).y)
    r.click(through: beside)
    #expect(r.canvas.editing?.session == session, "still writing")
    #expect(v.core.selection == MDSelection(4), "the caret where it was")
    r.click(through: r.centre("n2"))
    await r.until("left") { r.canvas.editing?.session != session }
    #expect(r.canvas.editing == nil || r.canvas.editing?.id != cid("n1"))
    #expect(r.doc.selection == [.card(cid("n2"))])
    r.click(through: CGPoint(x: n.midX, y: n.midY))
    r.click(through: CGPoint(x: n.midX, y: n.midY))
    await r.until("writing") { r.canvas.editing?.writer != nil }
    r.click(through: CGPoint(x: 400, y: 600))
    await r.until("left") { !r.canvas.isEditing }
  }

  /// Esc while a composition is under way cancels the composition only; the next Esc leaves the card with what was
  /// committed. The input method's commit goes in as one word (Pinyin: letters compose, Space commits)
  @Test func anEscDuringACompositionCancelsOnlyTheComposition() async throws {
    Pinyin.install()
    let r = try await rig([note("n1", x: 100, y: 100, "Words")])
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    r.click(through: r.centre("n1"))
    r.press("\r")
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let v = try writer(r)
    Pinyin.windows.insert(r.window.windowNumber)
    r.press("ni")
    #expect(v.hasMarkedText() && v.source == "Words", "composing, nothing in the text yet")
    r.press(" ")
    #expect(!v.hasMarkedText() && v.source == "Words你")
    r.press("hao")
    #expect(v.hasMarkedText())
    r.press("\u{1b}")
    #expect(!v.hasMarkedText() && r.canvas.isEditing, "the Esc cancelled the composition only")
    #expect(v.source == "Words你")
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.card("n1").writing == "Words你")
  }

  /// A double-click beside the end of a line that ends in a link: the caret after the link's last letter, and what is
  /// typed lengthens its text (interact.ts staticSpot)
  @Test func aDoubleClickBesideALineEndingInALinkWritesInTheLinksText() async throws {
    let r = try await rig([note("n1", x: 100, y: 100, width: 400, "See the [docs](https://e.x)")])
    defer { r.close() }
    let n = r.rect("n1")
    let line = try #require(r.canvas.scene?.placed[cid("n1")]?.blocks?.first)
    r.doubleClick(through: CGPoint(x: n.maxX - 8, y: n.minY + line.y + line.line / 2))
    await r.until("writing") { r.canvas.editing?.writer != nil }
    r.press("xy")
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.card("n1").writing == "See the [docsxy](https://e.x)", "\(r.card("n1").writing ?? "nil")")
  }

  /// A double-click within 3 points of a Note's right edge writes in it, the caret at the end of the line there (the
  /// edge's resize grip is the selected card's, and a double-click's second press does not take it)
  @Test func aDoubleClickByTheRightEdgeWritesInTheNote() async throws {
    let r = try await rig([note("n1", x: 100, y: 100, Self.text)])
    defer { r.close() }
    let n = r.rect("n1")
    let line = try #require(r.canvas.scene?.placed[cid("n1")]?.blocks?.first)
    let p = CGPoint(x: n.maxX - 2.5, y: n.minY + line.y + line.line / 2)
    let width = r.card("n1").width
    r.doubleClick(through: p)
    await r.until("writing") { r.canvas.editing?.writer != nil }
    #expect(r.canvas.editing?.id == cid("n1"))
    r.press("xy")
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    let got = r.card("n1").writing ?? ""
    #expect(got.contains("xy") && got.replacingOccurrences(of: "xy", with: "") == Self.text, "\(got)")
    #expect(r.card("n1").width == width, "not resized")
  }

  /// A new Text made by a double-click on the canvas and left empty goes, with no step; a new Note too
  @Test func anEmptyNewCardGoesWithNoStep() async throws {
    let r = try await rig([note("n1", x: 100, y: 100, Self.text)])
    defer { r.close() }
    let start = r.bytes
    r.doubleClick(through: CGPoint(x: 600, y: 400))
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let id = try #require(r.canvas.editing?.id)
    #expect(r.doc.board.card(id) != nil)
    r.click(through: CGPoint(x: 700, y: 600))
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.doc.board.card(id) == nil && r.bytes == start && !r.doc.history.canUndo)
    r.canvas.createInView(.note)
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let note = try #require(r.canvas.editing?.id)
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.doc.board.card(note) == nil && r.bytes == start && !r.doc.history.canUndo)
  }

  /// A Note whose header shows its leading heading, written in: the header folds away (its paper has no title) and the
  /// heading shows once, in the editor, where the header had it; leaving brings the header back
  @Test func aNotesTitleShowsOnceWhileItIsWrittenIn() async throws {
    let r = try await rig([note("n1", x: 100, y: 100, "# Why words\n\nThe vocabulary maps each word.")])
    defer { r.close() }
    let i = try #require(r.canvas.index(of: .card(cid("n1"))))
    let header = r.canvas.theme.headerHeight
    /// Dark pixels in the band of the card's header on its paper, as the canvas shows it
    func titleInk() throws -> Int {
      let it = r.canvas.items[i]
      let s = try #require(it.overview ?? (it.rest.contents as? IOSurface) ?? (it.held.contents as? IOSurface))
      let img = try #require(CanvasView.image(s))
      let k = CGFloat(img.width) / r.rect("n1").width
      return ink(img, rows: 0..<Int(header * k))
    }
    let atRest = try titleInk()
    #expect(atRest > 20, "the header shows the title")
    r.click(through: r.centre("n1"))
    r.press("\r")
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let v = try writer(r)
    #expect(try titleInk() < atRest / 10, "the paper's header folded: no title on it")
    // the selected card's header strip over it: its buttons only (M↓ and ···), no title drawn again (.chead.fold > .ib)
    let head = try #require(r.canvas.head(cid("n1")))
    #expect(head.folded && head.buttons.map(\.0) == [.source, .more])
    let shown = try #require(r.canvas.headShown[cid("n1")]?.layer.contents, "the strip shows")
    let strip = shown as! CGImage
    let dots = try #require(head.buttons.first?.1)
    let k = CGFloat(strip.width) / r.rect("n1").width
    #expect(ink(strip, rows: 0..<Int(header * k), columns: 0..<Int(dots.minX * k)) == 0, "no title on the strip")
    #expect(v.source.hasPrefix("# Why words"), "the heading is the editor's")
    let heading = try #require(v.core.layout.blockFrames.first)
    let top = r.canvas.convert(v.convert(CGPoint(x: 0, y: heading.minY * v.zoom), to: nil), from: nil).y
    #expect(abs(r.canvas.camera.board(CGPoint(x: 0, y: top)).y - r.rect("n1").minY) < header, "where the header was")
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    await r.settle()
    await r.idle()
    #expect(try titleInk() > atRest / 2, "the header back")
  }

  /// Dark pixels in these rows of a picture
  func ink(_ img: CGImage, rows: Range<Int>, columns: Range<Int>? = nil) -> Int {
    let (w, h) = (img.width, img.height)
    var px = [UInt8](repeating: 0, count: w * h * 4)
    px.withUnsafeMutableBytes { buf in
      let ctx = CGContext(
        data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      ctx?.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    var n = 0
    for y in rows.clamped(to: 0..<h) {
      for x in (columns ?? 0..<w).clamped(to: 0..<w) {
        let i = (y * w + x) * 4
        if px[i + 3] > 200 && Int(px[i]) + Int(px[i + 1]) + Int(px[i + 2]) < 300 { n += 1 }
      }
    }
    return n
  }

  /// Pinching and panning the board while a card is written in: the editor's layer scales over the card frame by frame
  /// (nothing drawn anew), the caret and the selection stay, and at rest it shows itself at the new zoom
  @Test func pinchingAndPanningWhileWritingScaleTheEditorAndKeepTheSelection() async throws {
    let r = try await rig([note("n1", x: 100, y: 100, Self.text)])
    defer { r.close() }
    r.click(through: r.centre("n1"))
    r.press("\r")
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let v = try writer(r)
    v.core.select(MDSelection(anchor: 4, head: 14))
    await r.idle()
    let host = try #require(v.superview)
    let before = r.breaks
    /// Where the editor's text should start now, in its host, and how big at the camera's zoom
    func want() throws -> CGRect {
      let ed = try #require(r.canvas.editing)
      let o = r.canvas.camera.view(CGPoint(x: r.rect("n1").minX + ed.inset.x, y: r.rect("n1").minY + ed.inset.y))
      let z = r.canvas.camera.zoom
      return r.canvas.convert(
        CGRect(x: o.x, y: o.y, width: v.core.layout.size.width * z, height: v.core.layout.size.height * z), to: host)
    }
    var t: TimeInterval = 1
    let around = CGPoint(x: 500, y: 350)
    r.canvas.pinch(by: 1.05, around: around, at: t, began: true, ended: false)
    for _ in 0..<12 {
      t += 1.0 / 120
      r.canvas.pinch(by: 1.02, around: around, at: t, began: false, ended: false)
      r.canvas.tick(at: t)
      let got = try #require(v.layer?.frame)
      let w = try want()
      // its text's top left where the card's is (its height is whole device pixels, the text's is not)
      #expect(
        abs(got.minX - w.minX) < 1 && abs(got.maxY - w.maxY) < 1 && abs(got.width - w.width) < 1,
        "its layer \(got) over \(w)")
    }
    #expect(r.canvas.editing?.zooming == true)
    #expect(r.breaks == before, "nothing drawn, decoded, asked for or swapped during the gesture")
    t += 1.0 / 120
    r.canvas.pinch(by: 1, around: around, at: t, began: false, ended: true)
    await r.until("at rest") { r.canvas.editing?.zooming == false && r.canvas.motion.isResting }
    #expect(abs(v.zoom - r.canvas.camera.zoom) < 0.001 && v.layer?.affineTransform() == .identity)
    #expect(v.core.selection == MDSelection(anchor: 4, head: 14), "the selection kept")
    // a pan moves it with the card, at the same scale
    for k in 0..<6 {
      t += 1.0 / 120
      r.canvas.scroll(by: CGVector(dx: 6, dy: 4), at: t, began: k == 0, ended: k == 5)
      r.canvas.tick(at: t)
      let got = try #require(v.layer?.frame)
      let w = try want()
      #expect(abs(got.minX - w.minX) < 1 && abs(got.maxY - w.maxY) < 1, "with the card: \(got) over \(w)")
    }
    #expect(v.core.selection == MDSelection(anchor: 4, head: 14))
    #expect(r.window.firstResponder === v)
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
  }

  // MARK: the editor's chrome on the canvas (the UX thread's findings, against what the web board's editor does)

  /// A point of a view's own (flipped) coordinates on the board
  func board(_ r: Rig, _ v: NSView, _ p: CGPoint) -> CGPoint {
    r.canvas.camera.board(r.canvas.convert(v.convert(p, to: nil), from: nil))
  }

  /// The selection toolbar over a word on a Note's first line: above it, over the card's header, as the web board's
  /// bar sits (8 above the selection), never over the line under it; its buttons take a press through the window there,
  /// outside the editor's frame. After a zoom it sits over the word at the new zoom
  @Test func theSelectionToolbarSitsAboveTheFirstLineTakesPressesAndFollowsTheZoom() async throws {
    let r = try await rig([note("n1", x: 100, y: 100, Self.text + "\n\nA second paragraph.")])
    defer { r.close() }
    r.click(through: r.centre("n1"))
    r.press("\r")
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let v = try writer(r)
    let word = (Self.text as NSString).range(of: "vocabulary")
    v.core.select(MDSelection(anchor: word.location, head: NSMaxRange(word)))
    v.placeToolbar()
    #expect(!v.toolbar.isHidden)
    let sel = try #require(v.core.selectionRects.first)
    let below = try #require(v.core.rects(for: 60..<61).first)
    #expect(abs(v.toolbar.frame.maxY - (sel.minY - 8)) < 0.5, "above the word: \(v.toolbar.frame) over \(sel)")
    #expect(v.toolbar.frame.maxY <= sel.minY && v.toolbar.frame.minY < 0, "over the header, off the next lines")
    #expect(below.minY > sel.maxY)
    // Bold, pressed where it is drawn
    let bold = try #require(v.toolbar.controls().first { $0.id == "bold" })
    let at = board(r, v.toolbar, CGPoint(x: bold.box.midX, y: bold.box.midY))
    #expect(r.window.contentView?.hitTest(r.at(at))?.isDescendant(of: v) == true, "the toolbar is under the pointer")
    r.click(through: at)
    #expect(v.source.hasPrefix("The **vocabulary** maps"), "\(v.source)")
    // a zoom: at rest the toolbar is over the word at the new zoom
    v.placeToolbar()
    var t: TimeInterval = 1
    // about the card's top left, which stays in view, so above the word there is still room for it
    let corner = r.rect("n1").origin
    r.canvas.pinch(by: 1.2, around: corner, at: t, began: true, ended: false)
    for _ in 0..<4 {
      t += 1.0 / 120
      r.canvas.pinch(by: 1.05, around: corner, at: t, began: false, ended: false)
      r.canvas.tick(at: t)
    }
    t += 1.0 / 120
    r.canvas.pinch(by: 1, around: corner, at: t, began: false, ended: true)
    await r.until("at rest") { r.canvas.editing?.zooming == false && r.canvas.motion.isResting }
    let z = v.zoom
    #expect(z > 1.2)
    let now = try #require(v.core.selectionRects.first)
    #expect(!v.toolbar.isHidden && abs(v.toolbar.frame.maxY - (now.minY * z - 8)) < 1, "\(v.toolbar.frame) at \(z)")
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
  }

  /// A click on a link while it is written in opens the link's box, the caret where it was: no source shown, no line
  /// moved (the web editor's handleClick)
  @Test func aClickOnALinkOpensItsBoxAndMovesNoLine() async throws {
    let r = try await rig([
      note("n1", x: 100, y: 100, width: 260, "Read the [long notes on paging](https://e.x/a/b) first.")
    ])
    defer { r.close() }
    r.click(through: r.centre("n1"))
    r.press("\r")
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let v = try writer(r)
    v.core.select(MDSelection(2))
    let frames = v.core.layout.blockFrames
    let head = v.core.layout.head
    let link = try #require(v.core.rects(for: 12..<16).first)
    r.click(through: board(r, v, CGPoint(x: link.midX * v.zoom, y: link.midY * v.zoom)))
    #expect(!v.linkBox.isHidden && v.linkBox.place?.text == "long notes on paging")
    #expect(v.core.selection == MDSelection(2) && v.core.layout.head == head && v.core.layout.blockFrames == frames)
    // Esc closes the box, the keys back in the text; the next leaves
    r.press("\u{1b}")
    #expect(v.linkBox.isHidden && r.window.firstResponder === v && r.canvas.isEditing)
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.card("n1").writing == "Read the [long notes on paging](https://e.x/a/b) first.")
  }

  /// Return at the end of a task item makes a new unchecked one, as the web editor does (- [x] done ↵ new: - [ ] new)
  @Test func returnAtTheEndOfATaskItemMakesAnUncheckedOne() async throws {
    let r = try await rig([note("n1", x: 100, y: 100, "- [x] hash full blocks\n- [ ] evict the least used")])
    defer { r.close() }
    r.click(through: r.centre("n1"))
    r.press("\r")
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let v = try writer(r)
    v.core.select(MDSelection(("- [x] hash full blocks" as NSString).length))
    r.press("\r")
    r.press("new")
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.card("n1").writing == "- [x] hash full blocks\n- [ ] new\n- [ ] evict the least used")
  }

  /// The pointer over a link while it is written in: the hand and its line drawn solid (the board's .md-link:hover);
  /// over a table's cell: its band and the grips of its row and column, as the web editor's table overlay
  @Test func hoveringALinkAndATableShowsWhatTheWebEditorShows() async throws {
    let r = try await rig([
      note("n1", x: 100, y: 100, width: 320, "See [the notes](https://e.x) here.\n\n| a | b |\n|---|---|\n| 1 | 2 |")
    ])
    defer { r.close() }
    r.click(through: r.centre("n1"))
    r.press("\r")
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let v = try writer(r)
    v.core.select(MDSelection(0))
    /// The pointer moved to a point of the layout, as the editor's tracking area gives it the move
    func move(_ p: CGPoint) {
      let w = v.convert(CGPoint(x: p.x * v.zoom, y: p.y * v.zoom), to: nil)
      v.mouseMoved(
        with: NSEvent.mouseEvent(
          with: .mouseMoved, location: w, modifierFlags: [], timestamp: 0, windowNumber: r.window.windowNumber,
          context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!)
    }
    let words = try #require(v.core.rects(for: 6..<9).first)
    move(CGPoint(x: words.midX, y: words.midY))
    #expect(v.hoveredLine != nil, "its line solid")
    #expect(v.cursor(at: CGPoint(x: words.midX, y: words.midY)) == .pointingHand)
    guard case .table(let t) = v.core.document.blocks[1].kind else {
      Issue.record("no table")
      return
    }
    let cell = v.core.layout.cellBoxes(of: t)[1][1]
    move(CGPoint(x: cell.midX, y: cell.midY))
    #expect(v.band.shown && v.band.table != nil, "the table's band")
    #expect(v.cursor(at: CGPoint(x: v.core.layout.cellBoxes(of: t)[1][0].minX + 6, y: cell.midY)) == .openHand)
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
  }
}

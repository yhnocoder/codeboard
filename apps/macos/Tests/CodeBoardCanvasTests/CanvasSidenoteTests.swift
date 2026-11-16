import AppKit
import CodeBoardModel
import CodeBoardNotes
import MarkdownCore
import TestGuard
import Testing

@testable import CodeBoardCanvas
@testable import MarkdownUI

// Sidenotes on the real canvas (as CanvasEditTests: a window of its own far off screen, events straight to the canvas,
// frames ticked by the test): a marker for each kind of anchor where the web board puts it, hit areas that keep their
// size on screen, a click that opens and closes the popup.

private func nid(_ s: String) -> SidenoteID { SidenoteID(rawValue: s) }
private func gid(_ s: String) -> SectionID { SectionID(rawValue: s) }
let s1 = SegmentID(rawValue: "s1")
let noteText = "# 调度 Scheduling\n\nRequests wait in the queue until a slot is free.\n\n- 每一步取一批\n- 再算一步"
let noteBlocks = ["# 调度 Scheduling", "Requests wait in the queue until a slot is free.", "- 每一步取一批\n- 再算一步"]

/// A code card with a Highlight and a sidenote on it, a Note with sidenotes on itself and on its third block, a Section
/// with one and a free one; `question`: the Note's is an open question
func sidenoteBoard(question: Bool = false) -> Board {
  let seg = Segment(
    id: s1, source: nil, language: "python", firstLine: 10,
    lines: [
      "def schedule(queue):", "    # 取出等待的请求", "    batch = queue.take(8)", "    run(batch)", "    return batch",
    ], highlights: [12...13])
  func text(_ t: String, q: Bool = false) -> Sidenote.Body {
    .text(TextNote(text: t, question: q ? Question(at: 1000) : nil))
  }
  return Board(
    id: BoardID(rawValue: "sidenotes"),
    cards: [
      Card(id: cid("c1"), x: 0, y: 0, width: 420, content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))),
      Card(
        id: cid("n1"), x: 600, y: 0, width: 300, section: gid("g1"),
        content: .own(CardContent(body: .note(Note(text: noteText))))),
      Card(
        id: cid("t1"), x: 0, y: 400, width: 200, content: .own(CardContent(body: .text(TextCard(text: "备注 a note"))))),
    ],
    sections: [Section(id: gid("g1"), title: "调度 Section", x: 560, y: -80, width: 400, height: 420)],
    sidenotes: [
      Sidenote(id: nid("l1"), anchor: .card(cid("c1"), segment: s1, lines: 12...13), body: text("取一批")),
      Sidenote(id: nid("l2"), anchor: .card(cid("c1"), segment: s1, lines: 12...13), body: text("再取")),
      Sidenote(id: nid("w1"), anchor: .card(cid("n1")), body: text("整张卡", q: question)),
      Sidenote(
        id: nid("b1"), anchor: .card(cid("n1"), block: BlockRef(index: 2, hash: BlockRef.sig(noteBlocks[2]))),
        body: text("这一块")),
      Sidenote(id: nid("g1"), anchor: .section(gid("g1")), body: text("分段")),
      Sidenote(id: nid("f1"), anchor: .point(x: 300, y: 600), body: text("自由")),
      Sidenote(id: nid("t1"), anchor: .card(cid("t1")), body: text("文字")),
    ])
}

@MainActor @Suite(.serialized) struct CanvasSidenoteTests {
  @Test(arguments: [0.1, 0.5, 1, 2] as [CGFloat])
  func eachAnchorsMarkerIsWhereTheWebBoardPutsItAndTakesTheClick(zoom asked: CGFloat) async throws {
    let r = try await Rig(sidenoteBoard(question: true), zoom: asked)
    defer { r.close() }
    let c = r.canvas
    // the smallest is held at the board's own floor
    let zoom = c.camera.zoom
    let t = c.theme
    func mark(_ at: PopAt) throws -> Mark { try #require(c.marks.first { $0.at == at }, "\(at)") }
    func onBoard(_ m: Mark) -> CGRect {
      guard case .card(let id)? = m.owner else {
        if case .sectionTitle(let s)? = m.owner, let r = c.scene?.items.first(where: { $0.owner == .sectionTitle(s) }) {
          return m.frame.offsetBy(dx: r.rect.minX, dy: r.rect.minY)
        }
        return m.frame
      }
      let o = r.rect(id.rawValue).origin
      return m.frame.offsetBy(dx: o.x, dy: o.y)
    }
    #expect(c.marks.count == 6 && c.markLayers.count == 6)
    let gap = 4.5 * sqrt(max(1, 1 / zoom)) + 5 / zoom
    // a whole card: past its right edge, clear of its ports, level with its header; an open question's is a ?
    let n1 = r.rect("n1")
    let whole = try mark(.spot(.card(cid("n1"))))
    #expect(
      abs(onBoard(whole).minX - (n1.maxX + gap)) < 0.01
        && abs(onBoard(whole).midY - (n1.minY + t.headerHeight / 2)) < 0.01)
    #expect(onBoard(whole).minX > n1.maxX + c.portRadius && whole.ask && whole.notes == [nid("w1")])
    // a Text has no header: 16 from its top
    let text = try mark(.spot(.card(cid("t1"))))
    #expect(abs(onBoard(text).midY - (r.rect("t1").minY + 16)) < 0.01)
    // a Note's block: level with the block's first line, under the whole card's
    let block = try mark(.spot(.block(cid("n1"), BlockRef(index: 2, hash: BlockRef.sig(noteBlocks[2])))))
    #expect(onBoard(block).minX == onBoard(whole).minX && onBoard(block).midY > onBoard(whole).midY + 40)
    #expect(onBoard(block).maxY < n1.maxY)
    // a Highlight: in the line numbers, right of them and left of the code, level with its first line; its count
    let lines = try mark(.lines(Lines(card: cid("c1"), segment: s1, range: 12...13)))
    let c1 = r.rect("c1")
    let code = try #require(c.scene?.placed[cid("c1")]?.code)
    let row = try #require(code.layout.row(segment: 0, line: 12))
    #expect(lines.gutter && lines.notes.count == 2 && onBoard(lines).height == 13)
    #expect(onBoard(lines).maxX == c1.minX + code.layout.gutter - 6)
    #expect(abs(onBoard(lines).minY - (c1.minY + code.top + row.y + 3.5)) < 0.01)
    // a Section's: after its title
    let section = try mark(.spot(.section(gid("g1"))))
    let title = try #require(c.scene?.items.first { $0.owner == .sectionTitle(gid("g1")) }?.rect)
    #expect(onBoard(section).minX == title.maxX + 6 && abs(onBoard(section).midY - title.midY) < 0.01)
    // a free one: centred on its point
    let free = try mark(.spot(.point(x: 300, y: 600)))
    #expect(onBoard(free).midX == 300 && onBoard(free).midY == 600 && free.owner == nil)
    // each takes the pointer at least 18 px across on screen, and never less than 18 board units
    for m in c.marks {
      #expect(m.hit.width * zoom >= 17.99 && m.hit.width >= 17.99, "\(m.at)")
      if !m.gutter { #expect(m.hit.height * zoom >= 17.99) }
      #expect(m.hit.contains(CGPoint(x: onBoard(m).midX, y: onBoard(m).midY)))
    }
    // a gutter marker is no taller than a line, so the next line's keeps its own
    #expect(lines.hit.height <= 20)
    // a click opens its popup, another closes it; hover opens nothing
    var opened: [PopAt?] = []
    c.onPop = { opened.append($0) }
    let p = CGPoint(x: onBoard(whole).midX, y: onBoard(whole).midY)
    #expect(c.markAt(p) != nil)
    // zoomed out past the switch point the summaries show: the card level, its markers with it, is not there to click
    if c.levels.level == .summaries {
      r.click(p)
      #expect(c.openPop == nil && opened.isEmpty)
      return
    }
    r.click(p)
    #expect(c.openPop == .spot(.card(cid("n1"))))
    r.click(p)
    #expect(c.openPop == nil && opened == [.spot(.card(cid("n1"))), nil])
    #expect(r.doc.selection.isEmpty, "a marker click selects nothing")
  }
}

extension Rig {
  /// A press and release through the window at a point of the popup's view, as a person's click arrives
  func click(pop v: NSView, at p: CGPoint, clicks: Int = 1) {
    for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] { mouse(t, pop: v, at: p, clicks: clicks) }
  }

  func mouse(_ t: NSEvent.EventType, pop v: NSView, at p: CGPoint, clicks: Int = 1) {
    window.sendEvent(
      NSEvent.mouseEvent(
        with: t, location: v.convert(p, to: nil), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!)
  }

  /// Typed into the popup's field, as the keys type it
  func type(_ pop: SidenotePop, _ s: String) {
    pop.field?.insertText(s, replacementRange: NSRange(location: NSNotFound, length: 0))
  }

  /// ↵ or Esc in the popup's field, as the key binding sends it
  func enter(_ pop: SidenotePop) { pop.field?.doCommand(by: #selector(NSResponder.insertNewline(_:))) }
  func escape(_ pop: SidenotePop) {
    if let f = pop.field {
      f.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
    } else {
      pop.view.cancelOperation(nil)
    }
  }
}

extension SidenotePop {
  func slip(_ id: String) -> SlipView? { slips.first { $0.note.id == id } }
  var order: [String] { slips.map(\.note.id) }
}

extension CanvasSidenoteTests {
  /// The popup's box in the canvas's points, as its view shows it
  func popBox(_ c: CanvasView) -> CGRect {
    let p = c.sidenotePop
    return p.view.convert(CGRect(origin: p.origin, size: p.size), to: c)
  }

  /// A marker's place on the board
  func onBoard(_ c: CanvasView, _ m: Mark) -> CGRect {
    guard let o = m.owner, let r = c.scene?.items.first(where: { $0.owner == o })?.rect else { return m.frame }
    return m.frame.offsetBy(dx: r.minX, dy: r.minY)
  }

  func opened(_ r: Rig, _ at: PopAt) async {
    await r.until("the popup shows") { r.canvas.popShown == at && r.canvas.sidenotePop.view.alphaValue == 1 }
    await r.canvas.popTask?.value
  }

  @Test(arguments: [0.5, 1, 2] as [CGFloat])
  func aPopupSitsRightOfItsCardTopAtItsMarkerAndCoversTheCardWhenThereIsNoRoom(zoom: CGFloat) async throws {
    let r = try await Rig(sidenoteBoard(), zoom: zoom)
    defer { r.close() }
    let c = r.canvas
    let start = r.bytes
    // each anchor kind: right of the card with its markers (or the Section's title, the free marker), its top 6 above
    // the marker's, in the window
    for at: PopAt in [
      .spot(.card(cid("n1"))), .spot(.block(cid("n1"), BlockRef(index: 2, hash: BlockRef.sig(noteBlocks[2])))),
      .lines(Lines(card: cid("c1"), segment: s1, range: 12...13)), .spot(.section(SectionID(rawValue: "g1"))),
      .spot(.point(x: 300, y: 600)),
    ] {
      let m = try #require(c.marks.first { $0.at == at })
      let mark = onBoard(c, m)
      r.click(CGPoint(x: mark.midX, y: mark.midY))
      await opened(r, at)
      let box = popBox(c)
      let a = try #require(c.popAnchor(at))
      let right = c.camera.view(CGPoint(x: a.right, y: 0)).x
      let top = c.camera.view(mark.origin).y
      let vw = c.bounds.width
      let vh = c.bounds.height
      #expect(box.width == 460 && box.height > 40)
      #expect(abs(box.minX - max(8, min(right + 12, vw - 8 - box.width))) < 0.5, "\(at)")
      #expect(abs(box.minY - max(8, min(top - 6, vh - 8 - box.height))) < 0.5, "\(at)")
      // it takes the pointer on itself only
      let inside = c.convert(CGPoint(x: box.midX, y: box.midY), to: c.superview)
      let outside = c.convert(CGPoint(x: box.minX - 30, y: box.midY), to: c.superview)
      #expect(c.sidenotePop.view.hitTest(inside) != nil && c.sidenotePop.view.hitTest(outside) == nil)
      r.click(CGPoint(x: mark.midX, y: mark.midY))
      await r.until("it closes") { c.popShown == nil }
    }
    // no room on its right: over the card, inside the window, the same side
    let n1 = r.rect("n1")
    c.place(zoom: zoom, centre: CGPoint(x: n1.maxX - 100 / zoom, y: n1.midY))
    await r.idle()
    let m = try #require(c.marks.first { $0.at == .spot(.card(cid("n1"))) })
    r.click(CGPoint(x: onBoard(c, m).midX, y: onBoard(c, m).midY))
    await opened(r, .spot(.card(cid("n1"))))
    let box = popBox(c)
    #expect(abs(box.maxX - (c.bounds.width - 8)) < 0.5 && box.minX < c.camera.view(n1.origin).x + n1.width * zoom)
    r.key(53)
    await r.until("Esc closes it") { c.popShown == nil }
    // opened and closed with nothing written: the board is as it was
    #expect(r.bytes == start && !r.doc.history.canUndo)
  }

  @Test func aDraggedPopupKeepsItsOffsetFromItsMarkerAsTheCameraMovesWithADashedLineBack() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let at = PopAt.spot(.card(cid("n1")))
    let m = try #require(c.marks.first { $0.at == at })
    r.click(CGPoint(x: onBoard(c, m).midX, y: onBoard(c, m).midY))
    await opened(r, at)
    let was = popBox(c).origin
    // dragged by its title bar
    let grip = c.sidenotePop.view.grip
    #expect(grip.frame.height >= 30 && grip.frame.width > 300, "the title bar but its buttons")
    let g = grip.convert(CGPoint(x: 40, y: 10), to: nil)
    func ev(_ t: NSEvent.EventType, _ d: CGPoint) -> NSEvent {
      NSEvent.mouseEvent(
        with: t, location: CGPoint(x: g.x + d.x, y: g.y - d.y), modifierFlags: [], timestamp: 1,
        windowNumber: r.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    }
    #expect(c.sidenotePop.view.hitTest(grip.convert(CGPoint(x: 40, y: 10), to: c.sidenotePop.view.superview)) === grip)
    grip.mouseDown(with: ev(.leftMouseDown, .zero))
    for i in 1...6 { grip.mouseDragged(with: ev(.leftMouseDragged, CGPoint(x: -40 * i, y: 30 * i))) }
    grip.mouseUp(with: ev(.leftMouseUp, CGPoint(x: -240, y: 180)))
    #expect(abs(popBox(c).minX - (was.x - 240)) < 0.5 && abs(popBox(c).minY - (was.y + 180)) < 0.5)
    #expect(c.popHeld != nil && c.popLine?.isHidden == false)
    await r.idle()
    // pans and a pinch: it keeps its offset from the marker, scaled with the zoom; only its view moves
    let breaks = r.breaks
    let held = try #require(c.popHeld)
    func expectHeld() {
      let mk = c.camera.view(onBoard(c, c.marks.first { $0.at == at }!).origin)
      let z = c.camera.zoom
      #expect(abs(popBox(c).minX - (mk.x + held.dx * z)) < 0.5 && abs(popBox(c).minY - (mk.y + held.dy * z)) < 0.5)
    }
    for _ in 0..<4 {
      let e = try #require(
        CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -12, wheel2: 8, wheel3: 0))
      c.scrollWheel(with: try #require(NSEvent(cgEvent: e)))
      r.tick()
      expectHeld()
    }
    c.pinch(by: 1.1, around: CGPoint(x: 300, y: 300), at: 1, began: true, ended: false)
    r.tick()
    expectHeld()
    c.pinch(by: 1.1, around: CGPoint(x: 300, y: 300), at: 1.016, began: false, ended: false)
    r.tick()
    expectHeld()
    #expect(r.breaks == breaks, "a camera move only moves the popup's web view")
    c.pinch(by: 1, around: CGPoint(x: 300, y: 300), at: 1.032, began: false, ended: true)
    await r.idle()
    // closed and opened again: in its place again, no line
    r.key(53)
    await r.until("closed") { c.popShown == nil }
    let m2 = try #require(c.marks.first { $0.at == at })
    r.click(CGPoint(x: onBoard(c, m2).midX, y: onBoard(c, m2).midY))
    await opened(r, at)
    #expect(c.popHeld == nil && c.popLine?.isHidden == true)
  }

  /// Sidenote popups stay open side by side (state/pop.ts openPop keeps the pinned ones, and actions/notes.ts pins every
  /// sidenote popup it opens: pinMarker, openSpot, openAddNote, goToQuestion): a second marker clicked opens its popup, in
  /// a web view of its own, and the first stays where it is; a marker clicked again closes its own only; Esc and a press on
  /// the canvas close them all (ui/pops/index.tsx Popovers' layer, interact.ts canvasPointerDown: closeAllPops)
  @Test func popupsStayOpenTogetherAndEscOrAPressOnTheCanvasClosesThemAll() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let a = PopAt.spot(.card(cid("n1")))
    let b = PopAt.spot(.card(cid("t1")))
    func click(_ at: PopAt) throws {
      let m = try #require(c.marks.first { $0.at == at })
      r.click(CGPoint(x: onBoard(c, m).midX, y: onBoard(c, m).midY))
    }
    func both() async throws -> (SidenotePop, SidenotePop, CGRect) {
      try click(a)
      await opened(r, a)
      let first = c.sidenotePop
      let was = first.view.frame
      try click(b)
      await opened(r, b)
      return (first, c.sidenotePop, was)
    }
    var (first, second, was) = try await both()
    #expect(first !== second, "a web view each")
    #expect(first.view.alphaValue == 1 && second.view.alphaValue == 1, "both shown")
    #expect(first.view.frame == was, "the first stays where it was")
    #expect(first.key != nil && first.key != second.key)
    try click(a)
    await r.until("its marker closes the first only") { first.view.alphaValue == 0 }
    #expect(c.popShown == b && second.view.alphaValue == 1)
    r.key(53)
    await r.until("Esc closes the rest") { c.popShown == nil && second.view.alphaValue == 0 }
    (first, second, was) = try await both()
    #expect(first !== second && first.view.alphaValue == 1)
    r.click(CGPoint(x: 480, y: 560))
    await r.until("a press on the canvas closes them all") { c.popShown == nil }
    await c.popTask?.value
    #expect(first.view.alphaValue == 0 && second.view.alphaValue == 0)
  }

  /// The title bar's delete is there only with something to delete (notes.tsx: <Show when={p.remove}>): a spot with
  /// sidenotes, a Highlight; a popup opened to write the first one has Close alone
  @Test func thePopupsDeleteIsShownOnlyWithSomethingToDelete() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    func head() async -> [String] { c.sidenotePop.labels() }
    let empty = PopAt.spot(.point(x: 900, y: 900))
    c.openPop(empty, write: true)
    await opened(r, empty)
    #expect(await head() == ["Close"])
    c.openPop(nil)
    let some = PopAt.spot(.card(cid("t1")))
    c.openPop(some)
    await opened(r, some)
    #expect(await head() == ["Delete Sidenotes", "Close"])
  }

  @Test func writtenInThePopupASidenoteOrQuestionIsAddedAndTheInputStaysForTheNext() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let pop = c.sidenotePop
    let at = PopAt.spot(.card(cid("t1")))
    c.openPop(at, write: true)
    await opened(r, at)
    #expect(r.window.firstResponder === pop.field, "the input has the keys")
    r.type(pop, "第二条 sidenote")
    r.enter(pop)
    await r.until("added") { r.doc.board.sidenotes(at: .card(cid("t1"))).count == 2 }
    #expect(r.doc.board.sidenotes(at: .card(cid("t1"))).last?.body == .text(TextNote(text: "第二条 sidenote")))
    // in place, and the next one is written in a new input
    await r.until("shown") { pop.slips.count == 2 }
    #expect(pop.bottom is Composer && r.window.firstResponder === pop.field)
    // the ? makes it a question; after ↵ the row is the + again
    pop.press("Question")
    #expect(r.window.firstResponder === pop.field, "the ? takes no focus")
    r.type(pop, "为什么等?")
    r.enter(pop)
    await r.until("asked") { r.doc.board.sidenotes(at: .card(cid("t1"))).count == 3 }
    #expect(r.doc.board.sidenotes(at: .card(cid("t1"))).last?.isOpenQuestion == true)
    #expect((pop.bottom as? PopButton)?.label == "Add Sidenote", "the + again")
    await r.settle()
    // its marker is a ? now
    #expect(c.marks.first { $0.at == at }?.ask == true)
    // answered under the question, then resolved by its tick
    let q = try #require(r.doc.board.sidenotes(at: .card(cid("t1"))).last)
    await r.until("its reply row") { pop.slip(q.id.rawValue)?.reply != nil }
    #expect(pop.press("Answer", in: q.id.rawValue))
    #expect(pop.slip(q.id.rawValue)?.answering != nil && r.window.firstResponder === pop.field)
    r.type(pop, "因为 [[调")
    await r.until("the [[ list, once its candidates come") { pop.field?.typedMenu.shown == true }
    // the first Esc closes the list, the second ends the answer, which is added
    r.escape(pop)
    r.escape(pop)
    await r.until("answered") { r.doc.board.sidenote(q.id)?.question?.answers.count == 1 }
    await r.until("drawn") { pop.slip(q.id.rawValue)?.answers.count == 1 }
    #expect(pop.press("Resolve", in: q.id.rawValue))
    await r.until("resolved") { r.doc.board.sidenote(q.id)?.question?.done == true }
    await r.until("drawn resolved") { pop.slip(q.id.rawValue)?.question == true }
    #expect(pop.slip(q.id.rawValue)?.reply == nil, "no reply row on a resolved one")
    // one step each, undone in turn
    #expect(r.doc.history.undoSteps.map(\.name) == ["Add Sidenote", "Add Question", "Answer", "Resolve"])
    // with nothing being written, Esc closes the popup
    r.escape(pop)
    await r.until("closed") { c.popShown == nil }
  }

  /// The input's code switch (NoteComposer.tsx): a search of code by its function's or file's name, ↑↓ and ↵ add the
  /// one chosen as a code sidenote of its own lines, one step; Esc leaves the search, adding nothing
  @Test func theInputsCodeSwitchSearchesCodeAndAddsACodeSidenote() async throws {
    var b = sidenoteBoard()
    let seg = Segment(
      id: SegmentID(rawValue: "s9"), source: .file(path: "engine/block_manager.py", hash: nil), language: "python",
      firstLine: 40, lines: ["def can_allocate(self, seq):", "    return True"],
      symbol: Symbol(name: "BlockManager.can_allocate", kind: .function), highlights: [40...40])
    b.cards.append(
      Card(id: cid("c9"), x: 0, y: 700, width: 400, content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))))
    let r = try await Rig(b, zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let pop = c.sidenotePop
    let at = PopAt.spot(.card(cid("t1")))
    c.openPop(at, write: true)
    await opened(r, at)
    #expect(pop.labels(in: nil) == ["Delete Sidenotes", "Close"])
    #expect(pop.press("Code"))
    let composer = try #require(pop.bottom as? Composer)
    let search = try #require(composer.search)
    #expect(composer.editor == nil && r.window.firstResponder === search.currentEditor())
    search.stringValue = "alloc"
    pop.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
    #expect(composer.found.map(\.label) == ["BlockManager.can_allocate"])
    #expect(composer.found.first?.detail == "engine/block_manager.py:40 · This board")
    let tv = NSTextView()
    #expect(pop.control(search, textView: tv, doCommandBy: #selector(NSResponder.insertNewline(_:))))
    await r.until("added") { r.doc.board.sidenotes(at: .card(cid("t1"))).count == 2 }
    let n = try #require(r.doc.board.sidenotes(at: .card(cid("t1"))).last)
    guard case .code(let made) = n.body else {
      Issue.record("a code sidenote")
      return
    }
    #expect(made.lines == seg.lines && made.symbol == seg.symbol && made.id != seg.id && made.highlights.isEmpty)
    #expect(r.doc.undoName == "Add Sidenote")
    await r.until("its slip, head and lines") { pop.slip(n.id.rawValue)?.code?.lines == seg.lines }
    #expect(pop.slip(n.id.rawValue)?.head?.title == "BlockManager.can_allocate")
    // the input goes on, as text again; switched again, Esc leaves the search with nothing added
    #expect(composer.mode == .text && composer.editor != nil)
    pop.press("Code")
    #expect(pop.control(composer.search!, textView: tv, doCommandBy: #selector(NSResponder.cancelOperation(_:))))
    #expect((pop.bottom as? PopButton)?.label == "Add Sidenote")
    #expect(r.doc.board.sidenotes(at: .card(cid("t1"))).count == 2)
  }
}

extension CanvasSidenoteTests {
  @Test func linesSelectedByTheirNumbersShowAPlusThatOpensTheirPopupToWriteOnThem() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let c1 = r.rect("c1")
    let code = try #require(c.scene?.placed[cid("c1")]?.code)
    func number(_ line: Int) throws -> CGPoint {
      let row = try #require(code.layout.row(segment: 0, line: line))
      return CGPoint(x: c1.minX + code.layout.gutter - 12, y: c1.minY + code.top + row.y + row.height / 2)
    }
    r.click(try number(10))
    r.click(try number(11), [.shift])
    #expect(c.lineSel == Lines(card: cid("c1"), segment: s1, range: 10...11) && r.doc.selection == [.card(cid("c1"))])
    // the + by the last line's number; the run tinted
    let plus = try #require(c.marks.first { $0.add })
    let row = try #require(code.layout.row(segment: 0, line: 11))
    #expect(abs(plus.frame.minY - (code.top + row.y + 3.5)) < 0.01 && plus.frame.maxX == code.layout.gutter - 6)
    // a card's menu starts with Add Sidenote, on the lines selected
    let menu = try #require(c.menu(for: r.mouse(.rightMouseDown, try number(10))))
    #expect(menu.items.first?.title == "Add Sidenote" && c.lineSel?.range == 10...11)
    r.click(CGPoint(x: onBoard(c, plus).midX, y: onBoard(c, plus).midY))
    let at = PopAt.lines(Lines(card: cid("c1"), segment: s1, range: 10...11))
    await opened(r, at)
    let pop = c.sidenotePop
    #expect(pop.shown?.range == "10–11")
    r.type(pop, "两行")
    r.enter(pop)
    await r.until("on them, a Highlight made") {
      r.doc.board.sidenotes.contains { $0.body == .text(TextNote(text: "两行")) }
    }
    #expect(r.doc.board.highlights(cid("c1"), s1) == [10...11, 12...13] && c.lineSel == nil)
  }

  @Test func theBoardsMenuAndSPutAFreeSidenoteOrOneOnTheSectionSelected() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let start = r.bytes
    let p = CGPoint(x: 300, y: 900)
    let menu = try #require(c.menu(for: r.mouse(.rightMouseDown, p)))
    #expect(menu.items.map(\.title).contains("Add Sidenote"))
    let item = try #require(menu.items.first { $0.title == "Add Sidenote" })
    _ = (item.target as? NSObject)?.perform(item.action, with: item)
    await opened(r, .spot(.point(x: 300, y: 900)))
    // an empty ring where it goes, its popup beside it
    let ring = try #require(c.marks.first { $0.at == .spot(.point(x: 300, y: 900)) })
    #expect(ring.notes.isEmpty && onBoard(c, ring).midX == 300)
    // nothing written: it goes, the board as it was
    r.key(53)
    await r.until("gone") { c.popShown == nil }
    #expect(!c.marks.contains { $0.at == .spot(.point(x: 300, y: 900)) } && r.bytes == start)
    // S on the one Section selected: its popup
    r.doc.select([.section(SectionID(rawValue: "g1"))])
    r.key(1)
    await opened(r, .spot(.section(SectionID(rawValue: "g1"))))
  }

  @Test func aFreeMarkerDraggedOntoANotesBlockGoesOnItAndOntoTheBoardMovesThere() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let free = try #require(c.marks.first { $0.at == .spot(.point(x: 300, y: 600)) })
    let block = try #require(c.scene?.placed[cid("n1")]?.blocks?[1])
    let n1 = r.rect("n1")
    let target = CGPoint(x: n1.midX, y: n1.minY + block.y + block.h / 2)
    r.drag(CGPoint(x: onBoard(c, free).midX, y: onBoard(c, free).midY), target) {
      #expect(c.dropAim != nil, "the block it would go on is tinted")
    }
    #expect(c.dropAim == nil)
    #expect(
      r.doc.board.sidenote(SidenoteID(rawValue: "f1"))?.anchor
        == .card(cid("n1"), block: BlockRef(index: 1, hash: block.sig)))
    r.doc.undo()
    await r.settle()
    let again = try #require(c.marks.first { $0.at == .spot(.point(x: 300, y: 600)) })
    r.drag(CGPoint(x: onBoard(c, again).midX, y: onBoard(c, again).midY), CGPoint(x: 340.4, y: 700))
    #expect(r.doc.board.sidenote(SidenoteID(rawValue: "f1"))?.anchor == .point(x: 340, y: 700))
    // a click (no move) opens its popup
    await r.settle()
    let moved = try #require(c.marks.first { $0.at == .spot(.point(x: 340, y: 700)) })
    r.click(CGPoint(x: onBoard(c, moved).midX, y: onBoard(c, moved).midY))
    #expect(c.openPop == .spot(.point(x: 340, y: 700)))
  }
}

extension CanvasSidenoteTests {
  @Test func theDockShowsTheZoomAndWhileQuestionsAreOpenTheirCount() throws {
    let dock = CanvasDock(theme: .warmInk)
    #expect(dock.rect(.questions) == nil, "no question open: no button")
    let plain = dock.size.width
    dock.questions = 3
    let q = try #require(dock.rect(.questions))
    #expect(dock.size.width > plain && q.height == 24)
    #expect(dock.part(at: CGPoint(x: q.midX, y: q.midY)) == .questions)
    let zoom = try #require(dock.rect(.zoom))
    #expect(dock.part(at: CGPoint(x: zoom.midX, y: zoom.midY)) == .zoom && zoom.width == 44)
    // the questions last, at the far right
    #expect(q.minX > zoom.maxX && q.maxX == dock.size.width - 4 - 2)
    dock.questions = 0
    #expect(dock.rect(.questions) == nil)
  }

  /// The dock (Chrome.tsx Dock): the Shelf | Zoom Out, the zoom, Zoom In | Fit to Window, in that order, each part
  /// doing what its button does on the web board
  @Test func theDocksPartsInOrderAndWhatEachDoes() async throws {
    for theme in [Theme.warmInk, .inkWash] {
      let dock = CanvasDock(theme: theme)
      let ink = theme.id == .inkWash
      let order: [CanvasDock.Part] = [.shelf, .zoomOut, .zoom, .zoomIn, .fit]
      let rects = try order.map { try #require(dock.rect($0)) }
      for (a, b) in zip(rects, rects.dropFirst()) { #expect(a.maxX <= b.minX) }
      #expect(rects[0].minX == (ink ? 18 : 4) && dock.size.width == rects[4].maxX + (ink ? 26 : 4))
      #expect(dock.size.height == (ink ? 46 : 34) && rects.allSatisfy { $0.midY == dock.size.height / 2 })
      // Ink Wash: the buttons inside the stroke's body, not on its tail
      if ink { #expect(rects[4].maxX <= CanvasToolbar.inkBody(CGRect(origin: .zero, size: dock.size)).maxX) }
    }
    let r = try await Rig(sidenoteBoard(question: true), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let d = c.dock
    #expect(!d.isHidden && d.frame.maxX == c.bounds.width - 12 && d.frame.maxY == c.bounds.height - 12)
    c.useDock(.zoomIn)
    await r.until("zoomed in") { abs(c.camera.zoom - 1.25) < 1e-9 && c.motion.isResting }
    #expect(abs(d.zoom - 1.25) < 1e-9)
    c.useDock(.zoomOut)
    await r.until("zoomed out") { abs(c.camera.zoom - 1) < 1e-9 && c.motion.isResting }
    c.useDock(.zoomOut)
    await r.until("zoomed out again") { abs(c.camera.zoom - 0.8) < 1e-9 && c.motion.isResting }
    c.useDock(.zoom)
    await r.until("at 100 %") { abs(c.camera.zoom - 1) < 1e-9 && c.motion.isResting }
    c.useDock(.shelf)
    #expect(c.shelfPanel != nil && d.open)
    c.useDock(.shelf)
    #expect(c.shelfPanel == nil && !d.open)
  }

  @Test func theQuestionListListsThisAndOtherBoardsQuestionsAndARowGoesToItsPopup() async throws {
    let root = FileManager.default.temporaryDirectory.appending(path: "questions-\(UUID().uuidString)")
    // another board with a question of its own
    var other = Board(id: BoardID(rawValue: "other"), cards: [])
    other.sidenotes = [
      Sidenote(
        id: nid("oq"), anchor: .point(x: 0, y: 0),
        body: .text(TextNote(text: "另一块白板的问题", question: Question(at: 5))))
    ]
    let package = root.appending(path: "other.board")
    try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
    try other.encoded().write(to: package.appending(path: Vault.boardFileName))
    let r = try await Rig(sidenoteBoard(question: true), zoom: 1, root: root)
    defer { r.close() }
    let c = r.canvas
    var counts: [Int] = []
    c.onQuestions = { counts.append($0) }
    c.questionsChanged()
    #expect(c.openQuestions == 1)
    let list = c.questionList
    c.toggleQuestionList(under: CGRect(x: 600, y: 650, width: 40, height: 24))
    await r.until("the list shows") { list.view.alphaValue == 1 }
    // this board's, newest first; emptied, every board's, grouped
    #expect(await list.run("return document.querySelectorAll('.qlist-row').length") as? Int == 1)
    #expect(await list.run("return document.querySelector('.qlist-l').textContent") as? String == "整张卡")
    #expect(await list.run("return document.querySelector('.qlist-w').textContent") as? String == "调度 Scheduling")
    _ = await list.run("document.querySelector('.qlist-clear').click()")
    #expect(await list.run("return document.querySelectorAll('.qlist-row').length") as? Int == 2)
    #expect(await list.run("return document.querySelectorAll('.qlist-group').length") as? Int == 2)
    // its bottom right 12 over the button, 6 right of it
    let box = list.view.convert(list.view.listRect, to: c)
    #expect(abs(box.maxY - (650 - 12)) < 0.5 && abs(box.maxX - 646) < 0.5)
    // another board's row: that board is to open
    var asked: (BoardID, Arrival?)?
    c.onOpenBoard = { asked = ($0, $1) }
    _ = await list.run("document.querySelector('.qlist-row[data-q=\"oq\"]').click()")
    await r.until("its board asked for") { asked != nil }
    #expect(asked?.0 == BoardID(rawValue: "other") && asked?.1 == .question(nid("oq")) && !c.listShown)
    // this board's: its popup, the question shown
    c.toggleQuestionList(under: CGRect(x: 600, y: 650, width: 40, height: 24))
    await r.until("the list shows") { list.view.alphaValue == 1 }
    _ = await list.run("document.querySelector('.qlist-row').click()")
    await opened(r, .spot(.card(cid("n1"))))
    #expect(!c.listShown)
  }
}

extension CanvasSidenoteTests {
  /// The questions on entries' passages (a paper's or a PDF's annotations, from the source provider): every board's
  /// scope lists them, each entry a group titled with it after the boards, where its source line's number, the resolved
  /// ones only with Show Resolved; the list follows the provider's changes; a row shows its passage in the reading pane,
  /// the camera still
  @Test func entriesQuestionsAreListedUnderTheirEntriesAndARowShowsItsPassage() async throws {
    func q(_ id: String, _ entry: String, _ text: String, at: Double, done: Bool = false) -> EntryQuestion {
      EntryQuestion(
        anchor: anchor(entry, id), sidenote: nid(id),
        note: TextNote(text: text, question: Question(at: at, done: done)), entryTitle: entry == "e1" ? "注意力" : "A PDF")
    }
    let fake = FakeSources()
    fake.labels["e1"] = SourceLabel(title: "注意力", number: "p. 12", icon: .paper)
    fake.entryQuestions = [q("eq1", "e1", "为什么缩放", at: 3000), q("eq2", "e1", "Done one", at: 4000, done: true)]
    fake.entryQuestions.append(q("eq3", "e2", "Which kernel?", at: 2000))
    let r = try await Rig(sidenoteBoard(question: true), zoom: 1, sources: fake)
    defer { r.close() }
    let c = r.canvas
    let list = c.questionList
    func rows() async -> String? {
      await list.run(
        "return [...document.querySelectorAll('.qlist-row')].map(e => e.dataset.q + ' ' + e.querySelector('.qlist-w')"
          + ".textContent + (e.classList.contains('done') ? ' done' : '')).join('|')") as? String
    }
    c.toggleQuestionList(under: CGRect(x: 600, y: 650, width: 40, height: 24))
    await r.until("the list shows") { list.view.alphaValue == 1 }
    #expect(await rows() == "w1 调度 Scheduling", "not on this board")
    _ = await list.run("document.querySelector('.qlist-clear').click()")
    #expect(await rows() == "w1 调度 Scheduling|eq1 p. 12|eq3 ")
    let groups =
      await list.run(
        "return [...document.querySelectorAll('.qlist-group')].map(e => e.textContent).join('|')") as? String
    #expect(groups?.hasSuffix("|注意力|A PDF") == true)
    _ = await list.run("document.querySelector('.ib').click()")
    #expect(await rows() == "w1 调度 Scheduling|eq2 p. 12 done|eq1 p. 12|eq3 ", "newest first")
    fake.entryQuestions.append(q("eq4", "e2", "Asked later", at: 5000))
    fake.onSourcesChanged?()
    await r.until("the new one listed") { await rows() == "w1 调度 Scheduling|eq2 p. 12 done|eq1 p. 12|eq4 |eq3 " }
    var opened = false
    c.onOpenBoard = { _, _ in opened = true }
    let there = c.camera
    _ = await list.run("document.querySelector('.qlist-row[data-q=\"eq3\"]').click()")
    await r.until("its passage shown") { !fake.revealed.isEmpty }
    #expect(fake.revealed == [anchor("e2", "eq3")] && !c.listShown && !opened && c.camera == there)
  }

  /// No provider, or one with no questions: the list is the boards' alone
  @Test func withoutEntriesQuestionsTheListIsTheBoardsAlone() async throws {
    let r = try await Rig(sidenoteBoard(question: true), zoom: 1)
    defer { r.close() }
    #expect(r.canvas.entryItems().groups.isEmpty && r.canvas.entryItems().rows.isEmpty)
    r.canvas.sources = FakeSources()
    #expect(r.canvas.entryItems().groups.isEmpty && r.canvas.entryItems().rows.isEmpty)
  }
}

extension CanvasSidenoteTests {
  /// The other boards are read with their shared cards (core collectQuestions): a question that travels with one is
  /// listed once, on the first board in the vault that shows it, this one among them; a board-only one on its lines
  /// says its file
  @Test func otherBoardsQuestionsOnASharedCardAreListedOnceOnTheFirstBoardThatShowsIt() throws {
    let fm = FileManager.default
    let vault = Vault(root: fm.temporaryDirectory.appending(path: "questions-shared-\(UUID().uuidString)"))
    defer { try? fm.removeItem(at: vault.root) }
    try fm.createDirectory(at: vault.sharedFolderURL, withIntermediateDirectories: true)
    let sc = cid("sc")
    let seg = Segment(
      id: s1, source: .file(path: "engine/sched.py", hash: nil), language: "python", firstLine: 10,
      lines: ["def step():", "    take()", "    run()"])
    try SharedCard(
      id: sc, content: CardContent(body: .code(CodeCard(segments: [seg]))),
      sidenotes: [
        Sidenote(id: nid("tq"), anchor: .card(sc), body: .text(TextNote(text: "跟着卡走", question: Question(at: 7))))
      ]
    ).encoded().write(to: vault.sharedFolderURL.appending(path: "sc.json"))
    for name in ["a", "m", "z"] {
      var b = Board(
        id: BoardID(rawValue: name), cards: [Card(id: sc, x: 0, y: 0, width: 300, content: .shared)])
      if name == "z" {
        b.sidenotes = [
          Sidenote(
            id: nid("bq"), anchor: .card(sc, segment: s1, lines: 11...11),
            body: .text(TextNote(text: "只在这块", question: Question(at: 8))), boardOnly: true)
        ]
      }
      try vault.newBoard(in: "", title: name, board: b)
    }
    let all = try vault.tree().allBoards
    func listed(current id: String) throws -> [String: [String]] {
      let vb = try #require(all.first { $0.id.rawValue == id })
      let current = try vault.board(at: vb.path).inflated { try? vault.sharedCard($0) }
      let others = CanvasView.otherQuestions(in: vault, current: current, at: vb)
      return Dictionary(
        uniqueKeysWithValues: others.map { o in (o.0.id.rawValue, o.1.map { "\($0.note) \($0.where)" }) })
    }
    #expect(try listed(current: "m") == ["a": ["tq sched.py 10–12"], "z": ["bq sched.py:11"]])
    #expect(try listed(current: "a") == ["m": [], "z": ["bq sched.py:11"]], "on this board, so on no other")
  }

  /// Gone to from the list (actions/notes.ts goToQuestion, scenario questionOpensAfterFlight): a question out of view
  /// is flown to, its card with room on its right for the popup, which opens only once the camera is at rest; one in
  /// view opens where it is, the camera still
  @Test func aQuestionOutOfViewIsFlownToAndItsPopupOpensOnceTheCameraIsAtRest() async throws {
    let r = try await Rig(sidenoteBoard(question: true), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    c.place(zoom: 1, centre: CGPoint(x: 6000, y: 4000))
    c.showQuestion(nid("w1"))
    #expect(!c.motion.isResting, "a flight, not a jump")
    var frames = 0
    while !c.motion.isResting && frames < 600 {
      #expect(c.pops.isEmpty, "no popup while the camera moves")
      r.tick()
      frames += 1
      await Task.yield()
    }
    #expect(frames > 2 && c.motion.isResting)
    let there = c.camera
    await opened(r, .spot(.card(cid("n1"))))
    #expect(c.camera == there)
    let card = r.rect("n1")
    #expect(c.safeView.contains(card.union(CGRect(x: card.maxX, y: card.minY, width: 500, height: 1))))
    // in view: no move
    c.showQuestion(nid("w1"))
    #expect(c.motion.isResting && c.camera == there)
    await opened(r, .spot(.card(cid("n1"))))
    #expect(c.camera == there)
  }

  @Test func theInputOpenedAtOnceOffersTheReferenceListOnceItsCandidatesCome() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let pop = c.sidenotePop
    let at = PopAt.spot(.card(cid("t1")))
    c.openPop(at, write: true)
    await opened(r, at)
    r.type(pop, "见 [[调")
    await r.until("the [[ list with this board's Note") { pop.field?.typedMenu.shown == true }
    let f = try #require(pop.field)
    #expect(f.typedMenu.items.contains { $0.title.contains("调度") })
    #expect(!pop.view.panel.clipsToBounds, "the list hangs out of the popup")
    // picked, the ref is drawn as what it points at at once (the list came after the input was made)
    r.enter(pop)
    r.type(pop, " 好")
    #expect(f.source.hasPrefix("见 [[调度") && f.source.hasSuffix(" 好"))
    #expect(f.core.layout.drawnRefs.contains { $0.label.contains("调度") }, "drawn as found")
  }
}

extension CanvasSidenoteTests {
  /// A sidenote's menu (notes.tsx noteMenu): a right-click on it in the popup shows it, and it is the slip's menu as
  /// AppKit asks a view for one (menu(for:)); a text sidenote's is Edit, Place on Board when it is on a card and asks
  /// nothing, then Delete Sidenote
  @Test func aRightClickOnASidenoteGivesItsMenu() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let pop = c.sidenotePop
    let at = PopAt.lines(Lines(card: cid("c1"), segment: s1, range: 12...13))
    c.openPop(at)
    await opened(r, at)
    let slip = try #require(pop.slip("l1"))
    let p = slip.convert(CGPoint(x: 30, y: 12), to: pop.view)
    let press = NSEvent.mouseEvent(
      with: .rightMouseDown, location: pop.view.convert(p, to: nil), modifierFlags: [], timestamp: 1,
      windowNumber: r.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    func titles(_ m: NSMenu) -> [String] { m.items.map { $0.isSeparatorItem ? "-" : $0.title } }
    let asked = try #require(slip.menu(for: press))
    #expect(titles(asked) == ["Edit", "Place on Board", "-", "Delete Sidenote"])
    try #require(TestGuard.guardsContextMenus, "the menu guard is not in")
    TestGuard.shown = []
    r.window.sendEvent(press)
    #expect(TestGuard.shown == ["menu: Edit | Place on Board | — | Delete Sidenote"], "shown by the press")
    let m = c.sidenoteMenu(nid("l1"))
    #expect(titles(m) == titles(asked))
    #expect(titles(c.sidenoteMenu(nid("g1"))) == ["Edit", "-", "Delete Sidenote"], "on a Section: no card to place by")
    r.doc.edit("x") {
      $0.sidenotes.append(
        Sidenote(
          id: nid("k1"), anchor: .card(cid("n1")),
          body: .code(
            Segment(
              id: SegmentID(rawValue: "k"), source: nil, language: "python", firstLine: 1, lines: ["x = 1"]))))
    }
    #expect(titles(c.sidenoteMenu(nid("k1"))) == ["Place on Board", "-", "Delete Sidenote"])
    (m.items.first?.representedObject as? MenuAction)?.run()
    #expect(pop.slip("l1")?.writing != nil && r.window.firstResponder === pop.field, "written in")
    // written in place: ↵ saves it, one step
    r.type(pop, " 再")
    r.enter(pop)
    await r.until("saved") { Scene.text(r.doc.board.sidenote(nid("l1"))!) == "取一批 再" }
    #expect(r.doc.undoName == "Edit Sidenote" && pop.slip("l1")?.writing == nil)
    (m.items.last?.representedObject as? MenuAction)?.run()
    #expect(r.doc.board.sidenote(nid("l1")) == nil && r.doc.undoName == "Delete Sidenote")
  }

  /// The popup's buttons are main's <button>s: a press and a release off one does nothing, a click acts, and a press
  /// takes no keys from where they are
  @Test func thePopupsButtonsActOnTheReleaseOverThemAndTakeNoFocus() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let pop = c.sidenotePop
    let at = PopAt.spot(.point(x: 300, y: 600))
    c.openPop(at)
    await opened(r, at)
    let b = try #require(PopButton.find("Close", in: pop.view))
    let v = pop.view
    let close = b.convert(CGPoint(x: b.bounds.midX, y: b.bounds.midY), to: v)
    let before = r.window.firstResponder
    r.mouse(.leftMouseDown, pop: v, at: close)
    r.mouse(.leftMouseUp, pop: v, at: CGPoint(x: close.x - 120, y: close.y + 60))
    #expect(r.window.firstResponder === before, "pressed: the keys stay where they were")
    #expect(c.openPop == at, "let go off it: still open")
    r.click(pop: v, at: close)
    await r.until("closed by the click") { c.openPop == nil }
  }
}

extension CanvasSidenoteTests {
  /// The tools of a sidenote hovered in its popup (notes.tsx Slip): Edit, Always Show (on lines), Place on Board (on a
  /// card, no question), Delete; a question's Resolve, Edit and Delete Question. Placed, its popup stays with the rest
  @Test func aSidenotesToolsAreMainsAndPlaceOnBoardMakesItACard() async throws {
    let r = try await Rig(sidenoteBoard(question: true), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    func tools(_ n: String) async -> [String] { c.sidenotePop.labels(in: n) }
    let lines = PopAt.lines(Lines(card: cid("c1"), segment: s1, range: 12...13))
    c.openPop(.spot(.section(gid("g1"))))
    await opened(r, .spot(.section(gid("g1"))))
    #expect(await tools("g1") == ["Edit", "Delete Sidenote"])
    c.openPop(nil)
    c.openPop(.spot(.card(cid("n1"))))
    await opened(r, .spot(.card(cid("n1"))))
    #expect(await tools("w1") == ["Resolve", "Edit", "Delete Question"])
    c.openPop(nil)
    c.openPop(lines)
    await opened(r, lines)
    #expect(await tools("l1") == ["Edit", "Always Show", "Place on Board", "Delete Sidenote"])
    // pressed: a Note of its text beside the card, an arrow to it from the Highlight's first line, one step, selected
    let from = r.rect("c1")
    #expect(c.sidenotePop.press("Place on Board", in: "l1"))
    await r.until("placed") { r.doc.board.sidenote(nid("l1")) == nil }
    let id = try #require(r.doc.selection.first?.card)
    let card = try #require(r.doc.board.card(id))
    #expect(card.content == .own(CardContent(body: .note(Note(text: "取一批")))) && card.width == Board.newNoteWidth)
    #expect(r.doc.board.arrows.last?.from == Endpoint(card: cid("c1"), segment: s1, line: 12))
    #expect(r.doc.board.arrows.last?.to == Endpoint(card: id))
    // its popup stays, pinned, with the other sidenote on the lines (actions/notes.ts placeSidenote: closePop() closes
    // only popups not pinned)
    #expect(r.doc.undoName == "Place on Board" && c.openPop == lines)
    await c.popTask?.value
    #expect(c.popShown == lines && c.sidenotePop.view.alphaValue == 1, "the popup stays")
    func slips() async -> [String] { c.sidenotePop.order }
    await r.until("it shows the other one") { await slips() == ["l2"] }
    // from 48 right of the card and 20 down, the nearest place clear of the others
    await r.settle()
    let placed = r.rect(id.rawValue)
    #expect(placed.minX >= from.maxX + 48 || placed.minY >= from.minY + 20, "\(placed)")
    for o in r.doc.board.cards where o.id != id {
      #expect(!r.rect(o.id.rawValue).insetBy(dx: -28, dy: -28).intersects(placed), "\(o.id.rawValue)")
    }
    r.doc.undo()
    #expect(r.doc.board.sidenote(nid("l1")) != nil && r.doc.board.card(id) == nil)
  }
}

extension CanvasSidenoteTests {
  /// Always Show (notes.tsx Slip): its eye on, the sidenote last in its Highlight's popup, one step; Mark Reviewed, in
  /// the slip's second-look line and in its menu, clears the look
  @Test func alwaysShowAndMarkReviewedAreMains() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let pop = c.sidenotePop
    let at = PopAt.lines(Lines(card: cid("c1"), segment: s1, range: 12...13))
    c.openPop(at)
    await opened(r, at)
    func order() async -> [String] { pop.order }
    #expect(await order() == ["l1", "l2"])
    #expect(pop.press("Always Show", in: "l1"))
    await r.until("always shown") {
      if case .text(let t)? = r.doc.board.sidenote(nid("l1"))?.body { t.alwaysShow } else { false }
    }
    #expect(r.doc.undoName == "Always Show")
    await r.until("drawn so") {
      pop.slip("l1")?.always == true && pop.slip("l1")?.tools.first { $0.label == "Always Show" }?.on == true
    }
    #expect(await order() == ["l2", "l1"], "the ones always shown last")
    // a second look: said in the slip, and Mark Reviewed there and in its menu
    #expect(!c.sidenoteMenu(nid("l2")).items.map(\.title).contains("Mark Reviewed"))
    r.doc.edit("x") { b in
      if let i = b.sidenotes.firstIndex(where: { $0.id == nid("l2") }) { b.sidenotes[i].review = "v2" }
    }
    #expect(
      c.sidenoteMenu(nid("l2")).items.map { $0.isSeparatorItem ? "-" : $0.title } == [
        "Edit", "Place on Board", "Mark Reviewed", "-", "Delete Sidenote",
      ])
    await r.until("its second look said") { pop.slip("l2")?.review == "Line changed in v2, check it" }
    #expect(pop.press("Mark Reviewed", in: "l2"))
    await r.until("reviewed") { r.doc.board.sidenote(nid("l2"))?.review == nil }
    #expect(r.doc.undoName == "Mark Reviewed")
    await r.until("its line gone") { pop.slip("l2")?.review == nil }
  }

  /// A code sidenote's "why" is its line under the code (notes.tsx .sn-why)
  @Test func aCodeSidenotesWhyShowsUnderItsCode() async throws {
    var b = sidenoteBoard()
    b.sidenotes.append(
      Sidenote(
        id: nid("k1"), anchor: .card(cid("t1")),
        body: .code(Segment(id: SegmentID(rawValue: "k"), source: nil, language: "python", firstLine: 1, lines: ["x"])),
        why: "where it is called"))
    let r = try await Rig(b, zoom: 1)
    defer { r.close() }
    let at = PopAt.spot(.card(cid("t1")))
    r.canvas.openPop(at)
    await opened(r, at)
    #expect(r.canvas.sidenotePop.slip("k1")?.why == "where it is called")
  }

  /// A free code sidenote's head links where it was pasted from (notes.tsx CodeHead); a click opens a web page, never a
  /// file or another program (main's host openLink)
  @Test func aFreeCodeSidenotesHeadLinksWhereItWasPastedFrom() async throws {
    var b = sidenoteBoard()
    for (id, url) in [("k1", "https://gist.github.com/x"), ("k2", "file:///Applications/Calculator.app")] {
      b.sidenotes.append(
        Sidenote(
          id: nid(id), anchor: .card(cid("t1")),
          body: .code(
            Segment(
              id: SegmentID(rawValue: id), source: nil, language: "python", firstLine: 1, lines: ["x"], url: url))))
    }
    let r = try await Rig(b, zoom: 1)
    defer { r.close() }
    var urls: [URL] = []
    r.canvas.openURL = { urls.append($0) }
    let at = PopAt.spot(.card(cid("t1")))
    r.canvas.openPop(at)
    await opened(r, at)
    let pop = r.canvas.sidenotePop
    #expect(pop.press("https://gist.github.com/x", in: "k1"))
    #expect(pop.press("file:///Applications/Calculator.app", in: "k2"))
    #expect(urls == [URL(string: "https://gist.github.com/x")!], "the file link is not opened")
  }
}

extension CanvasSidenoteTests {
  /// What a question's slip and a field in the popup do as the web popup does
  @MainActor @Suite struct PopupAsMain {
    /// A question's tools sit over its own text, not over the slip with its answers (.qbody > .kt), and opened from
    /// the question list its slip pulses once (.slip.flash)
    @Test func aQuestionsToolsSitOverItsTextAndItFlashesWhenGoneTo() async throws {
      var b = sidenoteBoard(question: true)
      let i = try #require(b.sidenotes.firstIndex { $0.id.rawValue == "w1" })
      b.sidenotes[i].body = .text(
        TextNote(text: "整张卡", question: Question(at: 1000, answers: [.init(id: "a1", text: "答", at: 2000)])))
      let r = try await Rig(b, zoom: 1)
      defer { r.close() }
      let c = r.canvas
      let pop = c.sidenotePop
      c.openPop(.spot(.card(cid("n1"))), focus: nid("w1"))
      await r.until("the popup") { c.popShown != nil && pop.size.height > 0 }
      let s = try #require(pop.slip("w1"))
      let body = try #require(s.body).frame
      let answer = try #require(s.answers.first).frame
      #expect(abs(s.bar.frame.minY - (body.minY - 4)) < 0.5 && abs(s.bar.frame.maxX - (s.bounds.width + 6)) < 0.5)
      #expect(s.bar.frame.maxY < answer.minY, "over the question's text, clear of its answer")
      #expect(s.flashRing?.animation(forKey: "flash") != nil, "it pulses")
      #expect(pop.slip("b1")?.flashRing == nil, "only the one gone to")
    }

    /// A click on a drawn ref in a field being written goes to the canvas as one in a sidenote's text: a far card is
    /// previewed, and the field keeps its text and its caret
    @Test func aRefClickedInAFieldIsPreviewed() async throws {
      let r = try await refRig()
      defer { r.close() }
      let c = r.canvas
      let pop = c.sidenotePop
      c.openPop(.spot(.card(cid("n1"))))
      await r.until("the popup") { c.popShown != nil && pop.size.height > 0 }
      let s = try #require(pop.slip("s1"))
      s.onEdit?()
      let e = try #require(s.writing)
      // the caret away from the ref: one it is beside shows its source
      e.selection = MDSelection(0)
      let caret = e.selection
      let ref = try #require(e.core.layout.drawnRefs.first)
      r.click(in: e, at: CGPoint(x: ref.rect.midX * e.zoom, y: ref.rect.midY * e.zoom))
      await r.until("the preview drawn") { c.refPeek?.ready == true }
      #expect(e.selection == caret && s.writing === e)
    }
  }
}

extension CanvasSidenoteTests {
  /// A popup closed on one canvas is that canvas's next one; another canvas's popup is its own, so a closing on one
  /// board leaves what another board's popup shows as it is (#244: the web popup's shared web views)
  @Test func aPopupClosedOnOneCanvasLeavesAnotherCanvasesPopupAsItShows() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    let other = try await Rig(sidenoteBoard(), zoom: 1, alongside: r)
    defer {
      other.close()
      r.close()
    }
    let at = PopAt.lines(Lines(card: cid("c1"), segment: s1, range: 12...13))
    r.canvas.openPop(at)
    await opened(r, at)
    let first = r.canvas.sidenotePop
    r.canvas.openPop(nil)
    other.canvas.openPop(at)
    let pop = other.canvas.sidenotePop
    #expect(pop !== first, "another canvas's popup is its own")
    await opened(other, at)
    await r.canvas.popTask?.value
    #expect(pop.view.alphaValue == 1 && other.canvas.popShown == at)
    #expect(pop.order.count == 2, "what it shows kept: \(pop.order)")
  }
}

extension CanvasSidenoteTests {
  /// A popup closed is let go, with its view and what it searched (each one opened stayed, held by its own closures)
  @Test func aClosedPopupIsLetGo() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let at = PopAt.lines(Lines(card: cid("c1"), segment: s1, range: 12...13))
    weak var popup: Popup?
    weak var pop: SidenotePop?
    do {
      r.canvas.openPop(at, write: true)
      await opened(r, at)
      popup = r.canvas.pops.last
      pop = r.canvas.sidenotePop
      r.canvas.openPop(nil)
      await r.canvas.popTask?.value
    }
    await r.until("the closed popup is let go") { popup == nil && pop == nil }
  }
}

extension CanvasSidenoteTests {
  /// There is one question list: opened on another canvas (another tab), it closes on the one it was open on, which
  /// then neither closes the other's with its next press nor shows its own board's questions in it
  @Test func theQuestionListOpenedOnAnotherCanvasClosesOnTheFirst() async throws {
    let r = try await Rig(sidenoteBoard(question: true), zoom: 1)
    let other = try await Rig(sidenoteBoard(), zoom: 1, alongside: r)
    defer {
      other.close()
      r.close()
    }
    let button = CGRect(x: 600, y: 650, width: 40, height: 24)
    let list = r.canvas.questionList
    r.canvas.toggleQuestionList(under: button)
    // at once, while the first still reads the other boards' questions
    other.canvas.toggleQuestionList(under: button)
    #expect(!r.canvas.listShown && other.canvas.listShown)
    await r.until("the list shows") { list.view.alphaValue == 1 }
    #expect(list.view.superview === other.canvas.superview)
    #expect(await list.run("return document.querySelectorAll('.qlist-row').length") as? Int == 0, "the other's board")
    // closing where it no longer is does nothing to the one open
    r.canvas.closeQuestionList()
    #expect(other.canvas.listShown && list.view.alphaValue == 1)
    other.canvas.closeQuestionList()
    #expect(!other.canvas.listShown && CanvasView.listOutside == nil)
  }
}

extension CanvasSidenoteTests {
  /// The popup as a host other than the canvas uses it (the reading pane's annotations): made, shown, written in and
  /// heard through its package API alone, in a window of its own with no canvas; with no code to find, its input has
  /// the ? and no switch to a code search
  @Test func aPopupWithoutACanvasIsShownWrittenInAndHeardThroughItsOwnAPI() throws {
    _ = NSApplication.shared
    let window = NSWindow(
      contentRect: CGRect(x: -30000, y: -30000, width: 600, height: 900), styleMask: [.titled], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    let host = try #require(window.contentView)
    let pop = SidenotePop()
    func type(_ s: String) { pop.field?.insertText(s, replacementRange: NSRange(location: NSNotFound, length: 0)) }
    func enter() { pop.field?.doCommand(by: #selector(NSResponder.insertNewline(_:))) }
    var heard: [SidenotePop.Action] = []
    var sizes: [CGSize] = []
    pop.onAction = { heard.append($0) }
    pop.onSize = { sizes.append($0) }
    host.addSubview(pop.view)
    let shown = SidenotePop.Shown(
      key: "paper-a1", theme: .warmInk, title: "Attention Is All You Need",
      notes: [.init(id: "a1", body: .text("Scaled", q: nil, lines: false, always: false))], write: true,
      folder: FileManager.default.temporaryDirectory)
    let size = pop.show(shown, maxHeight: 560)
    pop.view.frame = pop.frame(popupAt: CGPoint(x: 20, y: 20), flipped: host.isFlipped)
    pop.view.alphaValue = 1
    pop.focus()
    #expect(size.height > 0 && sizes.last == size)
    let composer = try #require(pop.bottom as? Composer)
    #expect(composer.askButton != nil && composer.codeButton == nil, "no switch to a code search without findCode")
    #expect(window.firstResponder === pop.field, "opened to write: the input has the keys")
    // a question asked
    #expect(pop.press("Question"))
    type("Why divide by √d?")
    enter()
    #expect(heard == [.add("Why divide by √d?", ask: true)])
    // the sidenote's own text written in place
    #expect(pop.press("Edit", in: "a1"))
    #expect(pop.writing)
    type(" dot products")
    enter()
    #expect(heard.last == .write("a1", "Scaled dot products") && !pop.writing)
    #expect(pop.press("Close"))
    #expect(heard.last == .close)
    pop.end()
    pop.clear()
    #expect(pop.key == nil)
  }
}

extension CanvasSidenoteTests {
  /// The popup is moved by its title bar while a sidenote is being written in it: what was typed, the caret and the
  /// keys stay where they were, and nothing is added
  @Test func draggingThePopupByItsTitleBarKeepsWhatIsBeingWritten() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let at = PopAt.spot(.card(cid("n1")))
    let notes = r.doc.board.sidenotes
    c.openPop(at, write: true)
    await opened(r, at)
    let pop = c.sidenotePop
    let field = try #require(pop.field)
    await r.until("the input has the keys") { r.window.firstResponder === field }
    r.type(pop, "why wait")
    field.doCommand(by: #selector(NSResponder.moveLeft(_:)))
    let caret = field.selectedRange()
    let was = popBox(c).origin
    let grip = pop.view.grip
    r.mouse(.leftMouseDown, pop: grip, at: CGPoint(x: 40, y: 10))
    for i in 1...4 { r.mouse(.leftMouseDragged, pop: grip, at: CGPoint(x: 40 - 20 * i, y: 10 + 15 * i)) }
    r.mouse(.leftMouseUp, pop: grip, at: CGPoint(x: -40, y: 70))
    #expect(popBox(c).origin != was, "moved")
    #expect(pop.field === field && field.source == "why wait", "what was typed, in the same input")
    #expect(r.window.firstResponder === field && field.selectedRange() == caret, "the keys and the caret")
    #expect(r.doc.board.sidenotes == notes, "nothing added")
    r.type(pop, "!")
    #expect(field.source == "why wai!t")
  }
}

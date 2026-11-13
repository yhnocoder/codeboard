import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

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
  func eachAnchorsMarkerIsWhereTheWebBoardPutsItAndTakesTheClick(zoom: CGFloat) async throws {
    let r = try await Rig(sidenoteBoard(question: true), zoom: zoom)
    defer { r.close() }
    let c = r.canvas
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
    r.click(p)
    #expect(c.openPop == .spot(.card(cid("n1"))))
    r.click(p)
    #expect(c.openPop == nil && opened == [.spot(.card(cid("n1"))), nil])
    #expect(r.doc.selection.isEmpty, "a marker click selects nothing")
  }
}

extension CanvasSidenoteTests {
  /// The popup's box in the canvas's points, as its web view shows it
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
    #expect(c.popHeld != nil && !c.popLine.isHidden)
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
    #expect(c.popHeld == nil && c.popLine.isHidden)
  }

  @Test func writtenInThePopupASidenoteOrQuestionIsAddedAndTheInputStaysForTheNext() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let pop = c.sidenotePop
    let at = PopAt.spot(.card(cid("t1")))
    c.openPop(at, write: true)
    await opened(r, at)
    await r.until("the input is ready") {
      await pop.run("return !!document.querySelector('.ProseMirror')") as? Bool == true
    }
    _ = await pop.run("pop.type(t)", ["t": "第二条 sidenote"])
    _ = await pop.run("pop.press('Enter')")
    await r.until("added") { r.doc.board.sidenotes(at: .card(cid("t1"))).count == 2 }
    #expect(r.doc.board.sidenotes(at: .card(cid("t1"))).last?.body == .text(TextNote(text: "第二条 sidenote")))
    // in place, and the next one is written in a new input
    await r.until("shown") { await pop.run("return document.querySelectorAll('.slip').length") as? Int == 2 }
    #expect(await pop.run("return !!document.querySelector('.ncomp .ProseMirror')") as? Bool == true)
    // the ? makes it a question; after ↵ the row is the + again
    _ = await pop.run("pop.click('.ncomp-ask')")
    _ = await pop.run("pop.type(t)", ["t": "为什么等?"])
    _ = await pop.run("pop.press('Enter')")
    await r.until("asked") { r.doc.board.sidenotes(at: .card(cid("t1"))).count == 3 }
    #expect(r.doc.board.sidenotes(at: .card(cid("t1"))).last?.isOpenQuestion == true)
    await r.until("the + again") { await pop.run("return !!document.querySelector('.tray > .add')") as? Bool == true }
    await r.settle()
    // its marker is a ? now
    #expect(c.marks.first { $0.at == at }?.ask == true)
    // answered under the question, then resolved by its tick
    await r.until("its reply row") { await pop.run("return pop.click('.reply')") as? Bool == true }
    await r.until("the answer's input") {
      await pop.run("return !!document.querySelector('.ans-in .ProseMirror')") as? Bool == true
    }
    _ = await pop.run("pop.type(t)", ["t": "因为 [[备注"])
    await r.until("the [[ list") { !pop.view.uiRects.isEmpty }
    _ = await pop.run("pop.press('Escape')")
    _ = await pop.run("pop.press('Escape')")
    await r.until("answered") { r.doc.board.sidenotes(at: .card(cid("t1"))).last?.question?.answers.count == 1 }
    let q = try #require(r.doc.board.sidenotes(at: .card(cid("t1"))).last)
    await r.until("its tick") {
      await pop.run("return !!document.querySelector('.slip.ask.open .kt button')") as? Bool == true
    }
    _ = await pop.run("pop.click('.slip.ask.open .kt button')")
    await r.until("resolved") { r.doc.board.sidenote(q.id)?.question?.done == true }
    await r.until("drawn resolved") {
      await pop.run("return document.querySelectorAll('.slip.ask.done').length") as? Int == 1
    }
    #expect(await pop.run("return document.querySelectorAll('.reply').length") as? Int == 0)
    // one step each, undone in turn
    #expect(r.doc.history.undoSteps.map(\.name) == ["Add Sidenote", "Add Question", "Answer", "Resolve"])
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
    await r.until("its input") {
      await pop.run("return !!document.querySelector('.ncomp .ProseMirror')") as? Bool == true
    }
    #expect(await pop.run("return document.querySelector('.hh .rng').textContent") as? String == "10–11")
    _ = await pop.run("pop.type(t)", ["t": "两行"])
    _ = await pop.run("pop.press('Enter')")
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
    #expect(menu.items.map(\.title) == ["Add Sidenote"])
    let item = try #require(menu.items.first)
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
  @Test func theToolbarShowsTheZoomAndWhileQuestionsAreOpenTheirCount() {
    let bar = CanvasToolbar(frame: CGRect(x: 0, y: 0, width: 600, height: 120))
    #expect(bar.questionsRect == nil, "no question open: no button")
    let plain = bar.intrinsicContentSize.width
    bar.questions = 3
    let q = try? #require(bar.questionsRect)
    #expect(bar.intrinsicContentSize.width > plain && q?.height == 24)
    #expect(bar.button(at: CGPoint(x: q!.midX, y: q!.midY)) == -2)
    let zoom = bar.extraRects().zoom
    #expect(bar.button(at: CGPoint(x: zoom.midX, y: zoom.midY)) == -1 && zoom.width == 44)
    // after the last tool, the zoom figure, then the questions at the far right
    #expect(zoom.minX > bar.buttonRects().last!.maxX && q!.minX > zoom.maxX && q!.maxX < bar.barRect.maxX)
    bar.questions = 0
    #expect(bar.questionsRect == nil)
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
    var asked: (BoardID, SidenoteID)?
    c.onOpenBoard = { asked = ($0, $1) }
    _ = await list.run("document.querySelector('.qlist-row[data-q=\"oq\"]').click()")
    await r.until("its board asked for") { asked != nil }
    #expect(asked?.0 == BoardID(rawValue: "other") && asked?.1 == nid("oq") && !c.listShown)
    // this board's: its popup, the question shown
    c.toggleQuestionList(under: CGRect(x: 600, y: 650, width: 40, height: 24))
    await r.until("the list shows") { list.view.alphaValue == 1 }
    _ = await list.run("document.querySelector('.qlist-row').click()")
    await opened(r, .spot(.card(cid("n1"))))
    #expect(!c.listShown)
  }
}

extension CanvasSidenoteTests {
  @Test func theInputOpenedAtOnceOffersTheReferenceListOnceItsCandidatesCome() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let pop = c.sidenotePop
    let at = PopAt.spot(.card(cid("t1")))
    c.openPop(at, write: true)
    await opened(r, at)
    await r.until("its input") {
      await pop.run("return !!document.querySelector('.ncomp .ProseMirror')") as? Bool == true
    }
    _ = await pop.run("pop.type(t)", ["t": "见 [[调"])
    await r.until("the [[ list with this board's Note") {
      await pop.run("return document.querySelector('.md-pick')?.textContent ?? ''") as? String ?? "" != ""
    }
    #expect((await pop.run("return document.querySelector('.md-pick').textContent") as? String)?.contains("调度") == true)
  }
}

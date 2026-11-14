import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// Arrows on the real canvas (as CanvasEditTests: a window of its own far off screen, events straight to the canvas,
// frames ticked by the test): found by the line or the label, selected and drawn in the accent, the label written in
// place and dragged along the line, the arrow's and the label's menus, Connect with Arrow.

private func aid(_ s: String) -> ArrowID { ArrowID(rawValue: s) }

/// Two Notes side by side with an arrow between them, a third under them; with `more`, a Text and a code card under them
/// and no arrow
private func arrows(label: String? = nil, more: Bool = false) -> Board {
  func note(_ id: String, x: Double, y: Double) -> Card {
    Card(
      id: cid(id), x: x, y: y, width: 240, height: 160,
      content: .own(CardContent(body: .note(Note(text: "# \(id)\n\n线程在屏障处等待。")))))
  }
  let seg = Segment(
    id: SegmentID(rawValue: "s1"), source: nil, language: "python", firstLine: 1,
    lines: ["def wait(barrier):", "    barrier.arrive()", "    return barrier.done"])
  let extra = [
    Card(id: cid("t1"), x: 0, y: 800, width: 200, content: .own(CardContent(body: .text(TextCard(text: "备注 a note"))))),
    Card(id: cid("c1"), x: 700, y: 800, width: 320, content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))),
  ]
  return Board(
    id: BoardID(rawValue: "arrows"),
    cards: [note("n1", x: 0, y: 0), note("n2", x: 700, y: 0), note("n3", x: 300, y: 500)] + (more ? extra : []),
    arrows: more
      ? [] : [Arrow(id: aid("a1"), from: Endpoint(card: cid("n1")), to: Endpoint(card: cid("n2")), label: label)])
}

private func titles(_ m: NSMenu?) -> [String] { m?.items.map { $0.isSeparatorItem ? "-" : $0.title } ?? [] }

/// Runs the item titled so in a menu or its submenus
private func fire(_ m: NSMenu?, _ path: String...) {
  var menu = m
  for (i, t) in path.enumerated() {
    guard let item = menu?.items.first(where: { $0.title == t }) else {
      Issue.record("no \(t) in \(titles(menu))")
      return
    }
    if i == path.count - 1 {
      #expect(item.action != nil, "\(t) is enabled")
      (item.representedObject as? MenuAction)?.run()
    }
    menu = item.submenu
  }
}

@MainActor @Suite(.serialized) struct CanvasArrowTests {
  @Test(arguments: [nil, 400] as [Double?])
  func anArrowOnANotesBlockMeetsTheNoteAtThatBlock(height: Double?) async throws {
    let text = "# 调度 Scheduling\n\nRequests wait in the queue until a slot is free.\n\n- 每一步取一批\n- 再算一步\n\n结尾 the end"
    let blocks = [
      "# 调度 Scheduling", "Requests wait in the queue until a slot is free.", "- 每一步取一批\n- 再算一步", "结尾 the end",
    ]
    let to = { (i: Int) in Endpoint(card: cid("n1"), block: BlockRef(index: i, hash: BlockRef.sig(blocks[i]))) }
    let board = Board(
      id: BoardID(rawValue: "blocks"),
      cards: [
        Card(
          id: cid("n1"), x: 0, y: 0, width: 300, height: height,
          content: .own(CardContent(body: .note(Note(text: text))))),
        Card(id: cid("n2"), x: 600, y: 0, width: 240, content: .own(CardContent(body: .note(Note(text: "Other"))))),
      ],
      arrows: [
        Arrow(id: aid("b0"), from: Endpoint(card: cid("n2")), to: to(0)),
        Arrow(id: aid("b2"), from: Endpoint(card: cid("n2")), to: to(2)),
        Arrow(id: aid("b3"), from: Endpoint(card: cid("n2")), to: to(3)),
        Arrow(id: aid("w"), from: Endpoint(card: cid("n2")), to: Endpoint(card: cid("n1"))),
      ])
    let r = try await Rig(board, zoom: 1)
    defer { r.close() }
    let y = { (a: String) in r.canvas.arrowPoints(aid(a))?.end.y ?? -1 }
    let card = r.rect("n1")
    // the whole card at its header; each block lower than the one before it, inside the card
    #expect(y("w") < y("b0") && y("b0") < y("b2") && y("b2") < y("b3") && y("b3") < card.maxY)
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func anArrowIsFoundByItsLineWithinSixPointsAndDrawnInTheAccentWhenSelectedOrHovered(zoom: CGFloat) async throws {
    let r = try await Rig(arrows(), zoom: zoom)
    defer { r.close() }
    let a = try #require(r.canvas.scene?.arrows.first)
    let mid = a.mid
    #expect(r.canvas.hitArrow(mid) == aid("a1"))
    // the line runs about level here: 5 view points above it is on it, 8 is not
    #expect(r.canvas.hitArrow(CGPoint(x: mid.x, y: mid.y - 5 / zoom)) == aid("a1"))
    #expect(r.canvas.hitArrow(CGPoint(x: mid.x, y: mid.y - 8 / zoom)) == nil)
    // within reach of its start but on its card: the card's
    let onCard = CGPoint(x: a.pts[0].x - 2, y: a.pts[0].y)
    #expect(r.canvas.hitArrow(onCard) == aid("a1") && r.canvas.arrowAt(onCard) == nil)
    let before = r.canvas.litArrows.sublayers?.count ?? 0
    r.canvas.mouseMoved(with: r.mouse(.mouseMoved, mid))
    #expect(r.canvas.hoveredArrow == aid("a1"))
    let accent = r.canvas.currentTheme.accent
    // over the arrows, under their labels
    let level = r.canvas.cardLevel.sublayers ?? []
    #expect(
      r.canvas.above.superlayer === r.canvas.cardLevel
        && level.firstIndex(of: r.canvas.litArrows)! < level.firstIndex(of: r.canvas.above)!)
    let lit = { (r.canvas.litArrows.sublayers ?? []).contains { ($0 as? CAShapeLayer)?.fillColor == accent } }
    #expect(lit(), "hovered: in the accent")
    r.canvas.mouseMoved(with: r.mouse(.mouseMoved, CGPoint(x: 400, y: 400)))
    #expect(r.canvas.hoveredArrow == nil && (r.canvas.litArrows.sublayers?.count ?? 0) == before)
    r.click(mid)
    #expect(r.doc.selection == [.arrow(aid("a1"))])
    #expect(lit())
    // ⇧ adds a card; a click on the canvas lets go
    r.click(r.centre("n3"), .shift)
    #expect(r.doc.selection == [.arrow(aid("a1")), .card(cid("n3"))])
    r.click(CGPoint(x: 400, y: 380))
    #expect(r.doc.selection.isEmpty)
    // selected, its accent line follows its card while the card is dragged, as only layers move
    r.click(mid)
    let breaks = r.breaks
    var moving: CGRect?
    // ⇧: the card joins the selection, the arrow stays in it
    r.drag(r.centre("n2"), CGPoint(x: r.centre("n2").x, y: r.centre("n2").y + 200), .shift) {
      r.tick()
      moving = (r.canvas.litArrows.sublayers?.first as? CAShapeLayer)?.path?.boundingBoxOfPath
      #expect(r.breaks == breaks)
    }
    #expect(moving.map { $0.maxY > 150 } == true, "the accent line went down with the card")
    await r.settle()
    r.click(try #require(r.canvas.scene?.arrows.first?.mid))
    r.key(51)
    #expect(r.doc.board.arrows.isEmpty && r.doc.board.cards.count == 3, "⌫ takes the arrow, not its cards")
  }

  @Test func aLabelIsWrittenInPlaceKeptByReturnLeftByEscapeAndRemovedWhenBlank() async throws {
    let r = try await Rig(arrows(), zoom: 1)
    defer { r.close() }
    let mid = try #require(r.canvas.scene?.arrows.first?.mid)
    r.send(r.mouse(.leftMouseDown, mid))
    r.send(r.mouse(.leftMouseUp, mid))
    r.send(r.mouse(.leftMouseDown, mid, clicks: 2))
    r.send(r.mouse(.leftMouseUp, mid, clicks: 2))
    let field = try #require(r.canvas.inPlace?.field)
    #expect(field.superview != nil && field.stringValue.isEmpty && field.placeholderString == "Label")
    // where the label goes: the middle of the line
    let c = field.superview!.convert(CGPoint(x: field.frame.midX, y: field.frame.midY), to: r.canvas)
    #expect(abs(c.x - r.canvas.viewPoint(mid).x) < 1 && abs(c.y - r.canvas.viewPoint(mid).y) < 1)
    field.stringValue = "  等待 waits "
    _ = r.canvas.control(field, textView: NSTextView(), doCommandBy: #selector(NSResponder.insertNewline(_:)))
    #expect(r.doc.board.arrows[0].label == "等待 waits" && r.doc.history.undoSteps.count == 1)
    #expect(r.canvas.inPlace == nil)
    #expect(r.canvas.closingField === field, "the field stays until the label is drawn")
    await r.settle()
    #expect(r.canvas.closingField == nil && field.superview == nil)
    let li = try #require(r.canvas.index(of: .arrowLabel(aid("a1"))))
    #expect(!r.canvas.items[li].box.isHidden)
    // Return on the selected arrow writes it again; Esc leaves it as it was
    r.key(36)
    let again = try #require(r.canvas.inPlace?.field)
    #expect(again.stringValue == "等待 waits" && r.canvas.items[li].box.isHidden, "its label hides under the field")
    again.stringValue = "something else"
    _ = r.canvas.control(again, textView: NSTextView(), doCommandBy: #selector(NSResponder.cancelOperation(_:)))
    #expect(r.doc.board.arrows[0].label == "等待 waits" && r.doc.history.undoSteps.count == 1)
    #expect(!r.canvas.items[li].box.isHidden && again.superview == nil)
    // a camera move keeps what is written
    r.key(36)
    r.canvas.inPlace?.field.stringValue = "调用"
    r.canvas.scroll(by: CGVector(dx: 30, dy: 0), at: 1, began: true, ended: true)
    #expect(r.doc.board.arrows[0].label == "调用")
    await r.settle()
    // blank: no label
    r.key(36)
    r.canvas.inPlace?.field.stringValue = "   "
    r.canvas.endInPlace(commit: true)
    #expect(r.doc.board.arrows[0].label == nil && r.doc.undoName == "Delete Label")
    await r.settle()
    #expect(r.canvas.index(of: .arrowLabel(aid("a1"))) == nil)
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func aLabelSlidesAlongItsLineClearOfTheCardsAsOneStep(zoom: CGFloat) async throws {
    let r = try await Rig(arrows(label: "等待"), zoom: zoom)
    defer { r.close() }
    let li = try #require(r.canvas.index(of: .arrowLabel(aid("a1"))))
    let label = r.canvas.items[li]
    let from = label.box.position
    let breaks = r.breaks
    // towards n2, past its edge
    r.drag(from, CGPoint(x: 760, y: from.y + 30)) {
      r.tick()
      #expect(label.box.position.x > from.x + 100)
      #expect(r.breaks == breaks, "only the label's layer moves")
    }
    let at = try #require(r.doc.board.arrows[0].labelPosition)
    #expect(at > 0.6 && at < 1 && r.doc.history.undoSteps.count == 1 && r.doc.undoName == "Move Label")
    #expect((at * 100).rounded() / 100 == at, "two decimals")
    // its box stays 6 clear of n2
    #expect(label.box.frame.maxX + 6 <= r.rect("n2").minX + 0.5)
    let dropped = label.box.position
    await r.settle()
    #expect(r.canvas.items[li] === label, "it keeps its layer")
    #expect(hypot(label.box.position.x - dropped.x, label.box.position.y - dropped.y) < 0.5, "where it was let go")
    #expect(r.doc.selection == [.arrow(aid("a1"))])
    // its menu: back to the middle, then no label
    let menu = r.canvas.labelMenu(aid("a1"))
    #expect(titles(menu) == ["Edit Label", "-", "Reset Label Position", "Delete Label"])
    fire(menu, "Reset Label Position")
    #expect(r.doc.board.arrows[0].labelPosition == nil)
    fire(r.canvas.labelMenu(aid("a1")), "Delete Label")
    #expect(r.doc.board.arrows[0].label == nil)
  }

  @Test func theArrowMenuHasMainsPlainItemsAndConnectWithArrowJoinsTwoCards() async throws {
    let r = try await Rig(arrows(), zoom: 1)
    defer { r.close() }
    let mid = try #require(r.canvas.scene?.arrows.first?.mid)
    let menu = r.canvas.menu(for: r.mouse(.rightMouseDown, mid))
    #expect(r.doc.selection == [.arrow(aid("a1"))])
    #expect(
      titles(menu) == [
        "Line", "Width", "Start", "End", "Color", "-", "Start Side", "End Side", "Reset Sides", "-", "Add Label", "-",
        "Delete",
      ])
    #expect(titles(menu?.items[1].submenu) == ["Thin 1px", "Regular 2px", "Bold 3px"])
    #expect(menu?.items[1].submenu?.items[1].state == .on)
    #expect(titles(menu?.items[6].submenu) == ["Auto", "Left", "Right", "Top", "Bottom"])
    #expect(menu?.items.first { $0.title == "Reset Sides" }?.action == nil, "no side chosen yet")
    fire(menu, "Line", "Dashed")
    fire(r.canvas.arrowMenu(aid("a1")), "Width", "Bold 3px")
    fire(r.canvas.arrowMenu(aid("a1")), "Start", "Arrowhead")
    fire(r.canvas.arrowMenu(aid("a1")), "End", "None")
    fire(r.canvas.arrowMenu(aid("a1")), "Color", "Blue")
    fire(r.canvas.arrowMenu(aid("a1")), "End Side", "Top")
    let a = r.doc.board.arrows[0]
    #expect(a.dashed && a.width == 3 && a.startHead && !a.endHead && a.color == "blue" && a.to.side == .top)
    #expect(r.doc.history.undoSteps.count == 6, "one step each")
    fire(r.canvas.arrowMenu(aid("a1")), "Reset Sides")
    #expect(r.doc.board.arrows[0].to.side == nil)
    await r.settle()
    #expect(r.canvas.scene?.arrows.first?.stroke != nil, "drawn dashed")
    // the label from the menu
    fire(r.canvas.arrowMenu(aid("a1")), "Add Label")
    #expect(r.canvas.inPlace?.what == .label(aid("a1")))
    r.canvas.endInPlace(commit: false)
    // two cards selected: an arrow from the one on the left (or above, as here) to the other
    r.doc.select([.card(cid("n2")), .card(cid("n3"))])
    let several = r.canvas.menu(for: r.mouse(.rightMouseDown, r.centre("n3")))
    #expect(titles(several).first == "Connect with Arrow")
    fire(several, "Connect with Arrow")
    let made = try #require(r.doc.board.arrows.last)
    #expect(r.doc.board.arrows.count == 2 && made.from.card == cid("n2") && made.to.card == cid("n3"))
    #expect(made.from.side == nil && made.label == nil && made.width == 2)
    // three: not enabled
    r.doc.select([.card(cid("n1")), .card(cid("n2")), .card(cid("n3"))])
    let three = r.canvas.menu(for: r.mouse(.rightMouseDown, r.centre("n3")))
    #expect(three?.items.first?.title == "Connect with Arrow" && three?.items.first?.action == nil)
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func aCardsPortDrawsAnArrowToTheCardOrLineLetGoOnAndNothingOnTheCanvas(zoom: CGFloat) async throws {
    let r = try await Rig(arrows(more: true), zoom: zoom)
    defer { r.close() }
    let surface = r.canvas.currentTheme.surface
    let dots = { (r.canvas.chrome.sublayers ?? []).filter { ($0 as? CAShapeLayer)?.fillColor == surface }.count }
    // the card under the pointer shows a port on each side; a Text none
    r.canvas.mouseMoved(with: r.mouse(.mouseMoved, r.centre("n1")))
    #expect(r.canvas.hoveredCard == cid("n1") && dots() == 4)
    r.canvas.mouseMoved(with: r.mouse(.mouseMoved, r.centre("t1")))
    #expect(r.canvas.hoveredCard == cid("t1") && dots() == 0)
    r.canvas.mouseMoved(with: r.mouse(.mouseMoved, r.centre("n1")))
    let right = try #require(r.canvas.ports(of: cid("n1"), line: nil).first { $0.side == .right })
    #expect(right.at == CGPoint(x: 240, y: r.canvas.currentTheme.headerHeight / 2))
    // dragged to n2: the preview is routed to it, n2 grows and shows as selected; only layers change meanwhile
    let breaks = r.breaks
    let target = r.canvas.items[try #require(r.canvas.index(of: .card(cid("n2"))))].box
    r.drag(right.at, r.centre("n2")) {
      r.tick()
      #expect(r.canvas.connecting?.target == Endpoint(card: cid("n2")))
      #expect(abs(target.affineTransform().a - 1.03) < 0.001 && target.sublayers?.contains { $0.name == "aim" } == true)
      let accent = r.canvas.currentTheme.accent
      #expect((r.canvas.chrome.sublayers ?? []).contains { ($0 as? CAShapeLayer)?.fillColor == accent })
      #expect(r.breaks == breaks)
    }
    let a = try #require(r.doc.board.arrows.first)
    #expect(a.from == Endpoint(card: cid("n1"), side: .right) && a.to == Endpoint(card: cid("n2")))
    #expect(r.doc.selection == [.card(cid("n2"))] && r.doc.history.undoSteps.count == 1 && r.doc.undoName == "Arrow")
    #expect(target.affineTransform().a == 1 && target.sublayers?.contains { $0.name == "aim" } == false)
    await r.settle()
    // the side the arrow meets shows no port, yet one drawn from there is a new arrow, the first left as it was
    r.canvas.mouseMoved(with: r.mouse(.mouseMoved, r.centre("n1")))
    #expect(dots() == 3)
    r.drag(right.at, r.centre("n3"))
    #expect(r.doc.board.arrows.count == 2 && r.doc.board.arrows[0] == a)
    #expect(r.doc.board.arrows[1].from == Endpoint(card: cid("n1"), side: .right))
    r.doc.undo()
    await r.settle()
    // let go on the canvas: nothing
    r.canvas.mouseMoved(with: r.mouse(.mouseMoved, r.centre("n1")))
    let bottom = try #require(r.canvas.ports(of: cid("n1"), line: nil).first { $0.side == .bottom })
    r.drag(bottom.at, CGPoint(x: 400, y: 330))
    #expect(r.doc.board.arrows.count == 1 && r.doc.history.undoSteps.count == 1)
    // to a code line: the line is the end
    let l2 = Endpoint(card: cid("c1"), segment: SegmentID(rawValue: "s1"), line: 2)
    let y2 = try #require(r.canvas.lineMiddle(l2))
    r.canvas.mouseMoved(with: r.mouse(.mouseMoved, r.centre("n1")))
    r.drag(bottom.at, CGPoint(x: 800, y: y2))
    #expect(r.doc.board.arrows.last?.to == l2 && r.doc.board.arrows.last?.from.side == .bottom)
    await r.settle()
    // from a code line's port: the line under the pointer shows one at each end
    let l1 = Endpoint(card: cid("c1"), segment: SegmentID(rawValue: "s1"), line: 1)
    let y1 = try #require(r.canvas.lineMiddle(l1))
    r.canvas.mouseMoved(with: r.mouse(.mouseMoved, CGPoint(x: 800, y: y1)))
    #expect(r.canvas.hoveredLine == l1)
    let lineLeft = try #require(r.canvas.ports(of: cid("c1"), line: l1).first { $0.end == l1 && $0.side == .left })
    r.drag(lineLeft.at, r.centre("n3"))
    let fromLine = try #require(r.doc.board.arrows.last)
    #expect(fromLine.from == Endpoint(card: cid("c1"), segment: SegmentID(rawValue: "s1"), line: 1, side: .left))
    #expect(fromLine.to == Endpoint(card: cid("n3")) && r.doc.board.arrows.count == 3)
    #expect(r.doc.history.undoSteps.count == 3)
  }

  @Test func theSelectedArrowsEndsMoveToAnotherCardAsOneStepButNotOntoItsOtherEnd() async throws {
    let r = try await Rig(arrows(), zoom: 1)
    defer { r.close() }
    r.click(try #require(r.canvas.scene?.arrows.first?.mid))
    let ends = r.canvas.endHandles()
    #expect(ends.count == 2)
    let to = try #require(ends.first { $0.0 == .to }?.1)
    let breaks = r.breaks
    let line = r.canvas.arrowGroups[0]
    r.drag(to, r.centre("n3")) {
      r.tick()
      #expect(line.allSatisfy { $0.isHidden }, "the arrow is drawn where its end goes")
      #expect(r.breaks == breaks)
    }
    #expect(r.doc.board.arrows[0].to == Endpoint(card: cid("n3")) && r.doc.board.arrows[0].from.card == cid("n1"))
    #expect(r.doc.selection == [.arrow(aid("a1"))] && r.doc.history.undoSteps.count == 1)
    await r.settle()
    // its start onto its end's card, or onto the canvas: no change
    let from = try #require(r.canvas.endHandles().first { $0.0 == .from }?.1)
    r.drag(from, r.centre("n3"))
    r.drag(from, CGPoint(x: 500, y: 300))
    #expect(r.doc.board.arrows[0].from.card == cid("n1") && r.doc.history.undoSteps.count == 1)
    #expect(r.canvas.arrowGroups[0].allSatisfy { !$0.isHidden })
  }
}

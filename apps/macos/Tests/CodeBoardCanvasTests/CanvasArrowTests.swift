import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// Arrows on the real canvas (as CanvasEditTests: a window of its own far off screen, events straight to the canvas,
// frames ticked by the test): found by the line or the label, selected and drawn in the accent, the label written in
// place and dragged along the line, the arrow's and the label's menus, Connect with Arrow.

private func aid(_ s: String) -> ArrowID { ArrowID(rawValue: s) }

/// Two Notes side by side with an arrow between them, a third under them
private func arrows(label: String? = nil) -> Board {
  func note(_ id: String, x: Double, y: Double) -> Card {
    Card(
      id: cid(id), x: x, y: y, width: 240, height: 160,
      content: .own(CardContent(body: .note(Note(text: "# \(id)\n\n线程在屏障处等待。")))))
  }
  return Board(
    id: BoardID(rawValue: "arrows"),
    cards: [note("n1", x: 0, y: 0), note("n2", x: 700, y: 0), note("n3", x: 300, y: 500)],
    arrows: [Arrow(id: aid("a1"), from: Endpoint(card: cid("n1")), to: Endpoint(card: cid("n2")), label: label)])
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
    let before = r.canvas.chrome.sublayers?.count ?? 0
    r.canvas.mouseMoved(with: r.mouse(.mouseMoved, mid))
    #expect(r.canvas.hoveredArrow == aid("a1"))
    let accent = r.canvas.currentTheme.accent
    let lit = { (r.canvas.chrome.sublayers ?? []).contains { ($0 as? CAShapeLayer)?.fillColor == accent } }
    #expect(lit(), "hovered: in the accent")
    r.canvas.mouseMoved(with: r.mouse(.mouseMoved, CGPoint(x: 400, y: 400)))
    #expect(r.canvas.hoveredArrow == nil && (r.canvas.chrome.sublayers?.count ?? 0) == before)
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
      moving = (r.canvas.chrome.sublayers?.first as? CAShapeLayer)?.path?.boundingBoxOfPath
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
    let field = try #require(r.canvas.labelEditing?.field)
    #expect(field.superview != nil && field.stringValue.isEmpty && field.placeholderString == "Label")
    // where the label goes: the middle of the line
    let c = field.superview!.convert(CGPoint(x: field.frame.midX, y: field.frame.midY), to: r.canvas)
    #expect(abs(c.x - r.canvas.viewPoint(mid).x) < 1 && abs(c.y - r.canvas.viewPoint(mid).y) < 1)
    field.stringValue = "  等待 waits "
    _ = r.canvas.control(field, textView: NSTextView(), doCommandBy: #selector(NSResponder.insertNewline(_:)))
    #expect(r.doc.board.arrows[0].label == "等待 waits" && r.doc.history.undoSteps.count == 1)
    #expect(r.canvas.labelEditing == nil)
    #expect(r.canvas.closingLabel === field, "the field stays until the label is drawn")
    await r.settle()
    #expect(r.canvas.closingLabel == nil && field.superview == nil)
    let li = try #require(r.canvas.index(of: .arrowLabel(aid("a1"))))
    #expect(!r.canvas.items[li].box.isHidden)
    // Return on the selected arrow writes it again; Esc leaves it as it was
    r.key(36)
    let again = try #require(r.canvas.labelEditing?.field)
    #expect(again.stringValue == "等待 waits" && r.canvas.items[li].box.isHidden, "its label hides under the field")
    again.stringValue = "something else"
    _ = r.canvas.control(again, textView: NSTextView(), doCommandBy: #selector(NSResponder.cancelOperation(_:)))
    #expect(r.doc.board.arrows[0].label == "等待 waits" && r.doc.history.undoSteps.count == 1)
    #expect(!r.canvas.items[li].box.isHidden && again.superview == nil)
    // a camera move keeps what is written
    r.key(36)
    r.canvas.labelEditing?.field.stringValue = "调用"
    r.canvas.scroll(by: CGVector(dx: 30, dy: 0), at: 1, began: true, ended: true)
    #expect(r.doc.board.arrows[0].label == "调用")
    await r.settle()
    // blank: no label
    r.key(36)
    r.canvas.labelEditing?.field.stringValue = "   "
    r.canvas.endLabelEditing(commit: true)
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
    #expect(r.canvas.labelEditing?.id == aid("a1"))
    r.canvas.endLabelEditing(commit: false)
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
}

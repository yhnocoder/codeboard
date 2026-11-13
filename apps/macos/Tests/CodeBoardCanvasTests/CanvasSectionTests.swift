import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// Sections and the toolbar's Section and Arrow on the real canvas (as CanvasEditTests: a window of its own far off
// screen, events straight to the canvas, frames ticked by the test).

private func gid(_ s: String) -> SectionID { SectionID(rawValue: s) }

/// Two Notes above a Section that holds a third and, inside it, a smaller one with a fourth
private func sections() -> Board {
  func note(_ id: String, x: Double, y: Double, section: String? = nil) -> Card {
    Card(
      id: cid(id), x: x, y: y, width: 240, height: 160, section: section.map(gid),
      content: .own(CardContent(body: .note(Note(text: "# \(id)\n\n分段 sections")))))
  }
  return Board(
    id: BoardID(rawValue: "sections"),
    cards: [
      note("n1", x: 0, y: 0), note("n2", x: 400, y: 0), note("m1", x: 40, y: 480, section: "g1"),
      note("m2", x: 700, y: 520, section: "g2"),
    ],
    sections: [
      Section(id: gid("g1"), title: "Outer", x: 0, y: 420, width: 1200, height: 500),
      Section(id: gid("g2"), title: "Inner", x: 660, y: 460, width: 400, height: 300, parent: gid("g1")),
    ])
}

private func titles(_ m: NSMenu?) -> [String] { m?.items.map { $0.isSeparatorItem ? "-" : $0.title } ?? [] }

@MainActor private func fire(_ m: NSMenu?, _ path: String...) {
  var menu = m
  for (i, t) in path.enumerated() {
    guard let item = menu?.items.first(where: { $0.title == t }) else {
      Issue.record("no \(t) in \(titles(menu))")
      return
    }
    if i == path.count - 1 {
      if let a = item.representedObject as? MenuAction {
        a.run()
      } else {
        NSApp.sendAction(item.action!, to: item.target, from: item)
      }
    }
    menu = item.submenu
  }
}

/// Once the title of a new Section is being written
@MainActor private func titleWritten(_ r: Rig) async -> SectionID? {
  for _ in 0..<2000 {
    if case .title(let id)? = r.canvas.inPlace?.what { return id }
    await r.canvas.refreshing?.value
    await Task.yield()
  }
  return nil
}

@MainActor @Suite(.serialized) struct CanvasSectionTests {
  @Test(arguments: [1, 0.5] as [CGFloat])
  func theToolbarsSectionDrawsAFrameThatTakesWhatItCoversAndItsTitleIsWrittenAtOnce(zoom: CGFloat) async throws {
    let r = try await Rig(sections(), zoom: zoom)
    defer { r.close() }
    var shown: [Tool?] = []
    r.canvas.onMode = { shown.append($0) }
    #expect(Tool.made == [.note, .text, .box, .section, .arrow])
    r.canvas.use(.section)
    #expect(r.canvas.mode == .drawSection && shown == [.section])
    #expect(r.canvas.toastText == "Drag on the canvas to draw a section · Esc to cancel")
    // round n1 and n2
    r.drag(CGPoint(x: -40, y: -50), CGPoint(x: 680, y: 220))
    #expect(r.canvas.mode == nil && shown == [.section, nil] && r.canvas.toastText == nil)
    let id = try #require(await titleWritten(r))
    let s = try #require(r.doc.board.section(id))
    #expect(s.x == -40 && s.y == -50 && s.width == 720 && s.height == 270 && s.parent == nil)
    #expect(r.card("n1").section == id && r.card("n2").section == id && r.card("m1").section == gid("g1"))
    #expect(r.doc.selection == [.section(id)] && r.doc.undoName == "New Section")
    let field = try #require(r.canvas.inPlace?.field)
    #expect(field.stringValue == "Untitled Section")
    field.stringValue = "调度 Scheduling"
    _ = r.canvas.control(field, textView: NSTextView(), doCommandBy: #selector(NSResponder.insertNewline(_:)))
    #expect(r.doc.board.section(id)?.title == "调度 Scheduling" && r.doc.history.undoSteps.count == 2)
    await r.settle()
    // a click in the Outer Section: 360 × 240 from there, inside it, taking m1 and not the inner Section
    r.canvas.use(.section)
    r.click(CGPoint(x: 20, y: 460))
    let inner = try #require(await titleWritten(r))
    r.canvas.endInPlace(commit: false)
    let q = try #require(r.doc.board.section(inner))
    #expect(q.x == 20 && q.y == 460 && q.width == 360 && q.height == 240 && q.parent == gid("g1"))
    #expect(r.card("m1").section == inner && r.doc.board.section(gid("g2"))?.parent == gid("g1"))
    await r.settle()
    // drawn round the Outer one: it goes inside the new one; Esc leaves the mode with nothing made
    r.canvas.use(.section)
    r.drag(CGPoint(x: -100, y: 300), CGPoint(x: 1400, y: 1100))
    let around = try #require(await titleWritten(r))
    r.canvas.endInPlace(commit: false)
    #expect(r.doc.board.section(gid("g1"))?.parent == around && r.doc.board.section(around)?.parent == nil)
    let steps = r.doc.history.undoSteps.count
    r.canvas.use(.section)
    r.key(53)
    #expect(r.canvas.mode == nil && r.canvas.toastText == nil && r.doc.history.undoSteps.count == steps)
  }

  @Test func theToolbarsArrowJoinsTwoSelectedCardsOrTheNextCardClicked() async throws {
    let r = try await Rig(sections(), zoom: 1)
    defer { r.close() }
    r.canvas.use(.arrow)
    #expect(r.canvas.toastText == "Select a card first, then click another card" && r.canvas.mode == nil)
    r.doc.select([.card(cid("n1")), .card(cid("n2"))])
    r.canvas.use(.arrow)
    #expect(r.doc.board.arrows.count == 1 && r.doc.board.arrows[0].from.card == cid("n1"))
    // one card: the next card clicked
    r.doc.select([.card(cid("n2"))])
    r.canvas.use(.arrow)
    #expect(r.canvas.mode == .connect(from: cid("n2")))
    #expect(r.canvas.toastText == "Click a card to connect · Esc to cancel")
    r.click(r.centre("m1"))
    let a = try #require(r.doc.board.arrows.last)
    #expect(r.doc.board.arrows.count == 2 && a.from == Endpoint(card: cid("n2")) && a.to == Endpoint(card: cid("m1")))
    #expect(r.canvas.mode == nil && r.doc.history.undoSteps.count == 2)
    // the canvas, the same card or Esc: cancelled
    r.doc.select([.card(cid("n2"))])
    r.canvas.use(.arrow)
    r.click(CGPoint(x: 330, y: 300))
    #expect(r.canvas.mode == nil && r.canvas.toastText == "Connect cancelled")
    r.canvas.use(.arrow)
    r.click(r.centre("n2"))
    #expect(r.canvas.toastText == "Connect cancelled")
    r.canvas.use(.arrow)
    r.key(53)
    #expect(r.canvas.mode == nil && r.canvas.toastText == "Connect cancelled" && r.doc.board.arrows.count == 2)
  }

  @Test func aSectionsTitleIsWrittenInPlaceAndItsMenuFitsColoursMovesOutAndRemovesKeepingItsCards() async throws {
    let r = try await Rig(sections(), zoom: 1)
    defer { r.close() }
    // double-click its title: written there
    let title = try #require(r.canvas.sectionTitle(gid("g2")))
    let at = CGPoint(x: title.midX, y: title.midY)
    r.send(r.mouse(.leftMouseDown, at))
    r.send(r.mouse(.leftMouseUp, at))
    r.send(r.mouse(.leftMouseDown, at, clicks: 2))
    r.send(r.mouse(.leftMouseUp, at, clicks: 2))
    let field = try #require(r.canvas.inPlace?.field)
    #expect(r.canvas.inPlace?.what == .title(gid("g2")) && field.stringValue == "Inner")
    field.stringValue = "  "
    r.canvas.endInPlace(commit: true)
    #expect(r.doc.board.section(gid("g2"))?.title == "Untitled Section" && r.doc.undoName == "Rename Section")
    await r.settle()
    let menu = r.canvas.menu(for: r.mouse(.rightMouseDown, at))
    #expect(r.doc.selection == [.section(gid("g2"))])
    #expect(titles(menu) == ["Fit Content", "Color", "Lock", "-", "Move Out of Parent Section", "Remove Section"])
    #expect(titles(menu?.items[1].submenu) == ["None", "Warm Sand", "Light Blue", "Light Green", "Light Pink"])
    fire(menu, "Color", "Light Blue")
    #expect(r.doc.board.section(gid("g2"))?.color == "blue")
    // Fit Content: its frame round m2 with the room a Section keeps
    fire(r.canvas.sectionMenu(gid("g2")), "Fit Content")
    let g2 = try #require(r.doc.board.section(gid("g2")))
    #expect(g2.x == 678 && g2.y == 486 && g2.width == 284 && g2.height == 216)
    fire(r.canvas.sectionMenu(gid("g2")), "Move Out of Parent Section")
    #expect(r.doc.board.section(gid("g2"))?.parent == nil)
    fire(r.canvas.sectionMenu(gid("g2")), "Remove Section")
    #expect(r.doc.board.section(gid("g2")) == nil && r.card("m2").section == nil, "its card stays")
    #expect(r.doc.history.undoSteps.count == 5)
    await r.settle()
    #expect(!titles(r.canvas.sectionMenu(gid("g1"))).contains("Move Out of Parent Section"), "it is in none")
    // Move to New Section: round the selected cards, in the one Section they were all in, its title written
    r.doc.select([.card(cid("n1")), .card(cid("n2"))])
    let several = r.canvas.menu(for: r.mouse(.rightMouseDown, r.centre("n1")))
    fire(several, "Move to New Section")
    let id = try #require(await titleWritten(r))
    r.canvas.endInPlace(commit: false)
    let s = try #require(r.doc.board.section(id))
    #expect(s.x == 0 && s.y == 0 && s.width == 640 && s.height == 160 && s.parent == nil)
    #expect(r.card("n1").section == id && r.card("n2").section == id)
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func aCardDraggedOverASectionTintsItAndItsFrameEasesToHoldItAtTheDrop(zoom: CGFloat) async throws {
    let r = try await Rig(sections(), zoom: zoom)
    defer { r.close() }
    let breaks = r.breaks
    let gi = try #require(r.canvas.scene?.frames.firstIndex { $0.id == gid("g1") })
    let before = try #require(r.canvas.scene?.frames[gi].rect)
    // n1 into the Outer Section's bottom left, past its edge
    r.drag(r.centre("n1"), CGPoint(x: 120, y: 880)) {
      r.tick()
      #expect(r.canvas.dropLit == [gid("g1")] && r.canvas.dropLayer.sublayers?.isEmpty == false)
      #expect(r.breaks == breaks, "only layers change")
    }
    #expect(r.canvas.dropLit.isEmpty && r.canvas.dropLayer.sublayers?.isEmpty != false)
    #expect(r.card("n1").section == gid("g1"))
    await r.settle()
    let after = try #require(r.canvas.scene?.frames.first { $0.id == gid("g1") }?.rect)
    #expect(after.maxY > before.maxY, "it grew round the card")
    let layer = try #require(r.canvas.sections.sublayers?[gi])
    #expect(layer.animation(forKey: "ease") != nil, "from where it was")
    // over the Section it is in already: no tint
    r.drag(r.centre("m1"), CGPoint(x: r.centre("m1").x + 40, y: r.centre("m1").y)) {
      #expect(r.canvas.dropLit.isEmpty)
    }
  }
}

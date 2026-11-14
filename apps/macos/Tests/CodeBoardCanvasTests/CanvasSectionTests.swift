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
    #expect(Tool.made == [.note, .text, .box, .section, .arrow, .sticker])
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

  /// A member card dragged: its Section's frame grows round it on every step, while a third of it still lies in the
  /// frame the drag began with; past that it leaves and the frame goes back (state/sections.ts setMovingHome, homeFor)
  @Test func aSectionsFrameFollowsADraggedMember() async throws {
    let r = try await Rig(sections(), zoom: 0.5)
    defer { r.close() }
    let c = r.canvas
    let g = gid("g1")
    let fi = try #require(c.scene?.frames.firstIndex { $0.id == g })
    let start = try #require(c.scene?.frames[fi].rect)
    func shown() -> CGRect { c.sections.sublayers![fi].frame }
    // the canvas's clock, moved on by hand: 120 frames a second
    var t = c.now
    c.steppedClock = { t }
    defer { c.steppedClock = nil }
    func frames(_ n: Int) {
      for _ in 0..<n {
        t += 1.0 / 120
        c.tick(at: t)
      }
    }
    let from = r.centre("m1")
    // down by 340 at 1020 pt/s: still in g1 (a third of it in the frame it began in), whose frame eases after it on
    // every frame and holds it once it stops
    var bottoms: [CGFloat] = []
    r.send(r.mouse(.leftMouseDown, from))
    for k in 1...10 {
      r.send(r.mouse(.leftMouseDragged, CGPoint(x: from.x, y: from.y + CGFloat(k) * 34)))
      frames(4)
      bottoms.append(shown().maxY)
    }
    let moved = r.rect("m1").offsetBy(dx: 0, dy: 340)
    #expect(shown().maxY > moved.maxY - 40, "frame \(shown()), card \(moved): the spring a few frames behind")
    frames(60)
    #expect(shown().maxY >= moved.maxY + 22, "frame \(shown()), card \(moved)")
    #expect(bottoms == bottoms.sorted() && bottoms.last! > start.maxY, "\(bottoms), began \(start)")
    r.send(r.mouse(.leftMouseUp, CGPoint(x: from.x, y: from.y + 340)))
    await r.settle()
    #expect(r.doc.board.card(cid("m1"))?.section == g)
    #expect(try #require(c.scene?.frames.first { $0.id == g }?.rect).maxY >= r.rect("m1").maxY + 22)
    // far down: out of it, the frame back round what stays
    let now = try #require(c.scene?.frames.first { $0.id == g }?.rect)
    let at = r.centre("m1")
    r.send(r.mouse(.leftMouseDown, at))
    for k in 1...12 {
      r.send(r.mouse(.leftMouseDragged, CGPoint(x: at.x, y: at.y + CGFloat(k) * 80)))
      frames(4)
    }
    // the frame shrinks back by its spring, no step longer than three times the one before or after it (watch.ts jumped)
    var heights = [shown().height]
    for _ in 0..<40 {
      frames(1)
      heights.append(shown().height)
    }
    #expect(shown().maxY < now.maxY, "frame \(shown()), was \(now)")
    let steps = zip(heights, heights.dropFirst()).map { abs($1 - $0) }
    for i in 1..<(steps.count - 1) where steps[i] > 1 {
      #expect(steps[i] <= 3 * max(steps[i - 1], steps[i + 1]) + 1, "step \(i): \(steps)")
    }
    r.send(r.mouse(.leftMouseUp, CGPoint(x: at.x, y: at.y + 960)))
    await r.settle()
    #expect(r.doc.board.card(cid("m1"))?.section == nil)
  }

  /// A card dragged into a Section past its edge: the drop tint lies over the frame on every frame as the frame eases
  /// round the card (.sect.drop is the frame's own class on the board)
  @Test func theDropTintFollowsTheFrameAsItEases() async throws {
    let r = try await Rig(sections(), zoom: 0.5)
    defer { r.close() }
    let c = r.canvas
    let g = gid("g1")
    let fi = try #require(c.scene?.frames.firstIndex { $0.id == g })
    let start = try #require(c.scene?.frames[fi].rect)
    var t = c.now
    c.steppedClock = { t }
    defer { c.steppedClock = nil }
    let from = r.centre("n1")
    let to = CGPoint(x: 120, y: 880)
    r.send(r.mouse(.leftMouseDown, from))
    for k in 1...10 {
      let f = CGFloat(k) / 10
      r.send(r.mouse(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f)))
      for _ in 0..<4 {
        t += 1.0 / 120
        c.tick(at: t)
        guard c.dropLit == [g] else { continue }
        let shown = c.sections.sublayers![fi].frame
        let wash = (c.dropLayer.sublayers?.last as? CAShapeLayer)?.path?.boundingBox ?? .null
        #expect(abs(wash.maxY - shown.maxY) < 0.5 && abs(wash.minX - shown.minX) < 0.5, "tint \(wash), frame \(shown)")
      }
    }
    #expect(c.sections.sublayers![fi].frame.maxY > start.maxY, "the frame grew")
    r.send(r.mouse(.leftMouseUp, to))
    await r.settle()
  }

  /// Any open Section's edge or corner resizes it, selected or not (Sections.tsx .sedge)
  @Test func aSectionIsResizedByItsEdgeWithoutBeingSelected() async throws {
    let r = try await Rig(sections(), zoom: 1)
    defer { r.close() }
    let g = gid("g2")
    let f = try #require(r.canvas.scene?.frames.first { $0.id == g }?.rect)
    #expect(r.doc.selection.isEmpty)
    let edge = CGPoint(x: f.maxX + 2, y: f.midY)
    #expect(r.canvas.hitHandle(r.canvas.camera.view(edge))?.0 == .section(g))
    r.drag(edge, CGPoint(x: edge.x + 60, y: edge.y))
    await r.settle()
    let after = try #require(r.canvas.scene?.frames.first { $0.id == g }?.rect)
    #expect(abs(after.width - f.width - 60) < 1 && after.minX == f.minX, "\(f) → \(after)")
    // a corner both ways
    let corner = CGPoint(x: after.maxX + 3, y: after.maxY + 3)
    r.drag(corner, CGPoint(x: corner.x + 20, y: corner.y + 30))
    await r.settle()
    let last = try #require(r.canvas.scene?.frames.first { $0.id == g }?.rect)
    #expect(abs(last.width - after.width - 20) < 1 && abs(last.height - after.height - 30) < 1)
  }

  /// Its title or its grip dragged: the whole Section goes, its cards and the Sections in it with it (board
  /// sectionLabelDown); a card outside stays
  @Test(arguments: [false, true]) func aSectionIsDraggedByItsTitleOrItsGrip(grip: Bool) async throws {
    let r = try await Rig(sections(), zoom: 1)
    defer { r.close() }
    let title = try #require(r.canvas.sectionTitle(gid("g1")))
    let at = CGPoint(x: title.midX, y: title.midY)
    r.send(r.mouse(.mouseMoved, at))
    #expect(r.canvas.actsSection == gid("g1"))
    let grab = grip ? CGPoint(x: title.minX - 6, y: title.midY) : at
    if grip { #expect(r.canvas.hitSectionTitle(grab) == gid("g1")) }
    let (m1, n1, s1) = (r.rect("m1"), r.rect("n1"), try #require(r.doc.board.section(gid("g2"))))
    r.drag(grab, CGPoint(x: grab.x + 120, y: grab.y + 40))
    await r.settle()
    #expect(r.rect("m1").minX - m1.minX == 120 && r.rect("m1").minY - m1.minY == 40)
    #expect(r.doc.board.section(gid("g2"))?.x == s1.x + 120)
    #expect(r.rect("n1") == n1)
    #expect(r.doc.selection == [.section(gid("g1"))])
  }

  /// The grip and the chevron are there before the title is hovered (only faded out: .dots, .chev2), so a press that
  /// comes with no move before it (the pointer resting there as the camera brought the Section under it) drags or
  /// folds it as one after a hover does
  @Test func aSectionsGripAndChevronTakeAPressBeforeAnyHover() async throws {
    let r = try await Rig(sections(), zoom: 1)
    defer { r.close() }
    let g = gid("g1")
    #expect(r.canvas.actsSection == nil)
    let title = try #require(r.canvas.sectionTitle(g))
    let grab = CGPoint(x: title.minX - 6, y: title.midY)
    let m1 = r.rect("m1")
    r.drag(grab, CGPoint(x: grab.x + 120, y: grab.y + 40))
    await r.settle()
    #expect(r.rect("m1").minX - m1.minX == 120 && r.rect("m1").minY - m1.minY == 40, "dragged by its grip")
    r.doc.select([])
    r.send(r.mouse(.mouseMoved, CGPoint(x: 5, y: 5)))
    #expect(r.canvas.actsSection == nil)
    let fold = try #require(r.canvas.actsLayout(g).first { $0.0 == .fold }?.1)
    r.click(CGPoint(x: fold.midX, y: fold.midY))
    #expect(r.doc.board.section(g)?.collapsed == true, "folded by its chevron")
  }

  /// A Section's title row in main's order (Sections.tsx): the title, its sidenote marker, the chevron, then Fit
  /// Content, Color and Lock; folded, the title, the marker, "· N cards", the chevron. None of them overlap, with a
  /// marker or without, a long title too, in both looks; a click on the chevron folds it, on the marker opens its popup
  @Test(arguments: [false, true], [false, true])
  func aSectionsTitleRowHasItsMarkerThenItsChevronAndNothingOverlaps(folded: Bool, long: Bool) async throws {
    for theme in [Theme.warmInk, .inkWash] {
      for noted in [false, true] {
        var b = sections()
        b.sections[0].title = long ? "A long title that goes on well past where the chevron used to sit" : "Outer"
        b.sections[0].collapsed = folded
        if noted {
          b.sidenotes = [
            Sidenote(
              id: SidenoteID(rawValue: "sn"), anchor: Spot.section(gid("g1")).anchor, body: .text(TextNote(text: "why"))
            )
          ]
        }
        let r = try await Rig(b, zoom: 1)
        defer { r.close() }
        let c = r.canvas
        try await c.show(theme: theme)
        await r.idle()
        let what = "\(theme.id) folded \(folded) long \(long) noted \(noted)"
        let t = try #require(c.sectionTitle(gid("g1")), "\(what)")
        let font = c.currentTheme.sectionTitleFont
        let text = CGRect(
          x: t.minX, y: t.minY,
          width: (c.currentTheme.frame == .tray ? 6 : 0) + Drawing.width(b.sections[0].title, font),
          height: t.height)
        var row: [(String, CGRect)] = [("title", text)]
        let mark = c.marks.first { $0.at == .spot(.section(gid("g1"))) }.map {
          $0.frame.offsetBy(dx: t.minX, dy: t.minY)
        }
        #expect((mark != nil) == noted, "\(what): a marker only with a sidenote")
        if let mark { row.append(("marker", mark)) }
        if folded {
          let n = Drawing.foldedCount(1)
          let cw = Drawing.width(n, c.currentTheme.sectionCount)
          let cx = text.maxX + 2 + (mark.map { $0.width + 8 } ?? 0) + 5
          row.append(("count", CGRect(x: cx, y: t.minY, width: cw, height: t.height)))
        }
        let acts = c.actsLayout(gid("g1"))
        let fold = try #require(acts.first { $0.0 == .fold }?.1)
        row.append(("chevron", fold))
        if !folded {
          for a in [SectionAct.fit, .color, .lock] {
            row.append(("\(a)", try #require(acts.first { $0.0 == a }?.1)))
          }
        }
        // left to right, apart
        for (x, y) in zip(row, row.dropFirst()) {
          #expect(x.1.maxX <= y.1.minX + 0.01, "\(what): \(x.0) \(x.1) reaches \(y.0) \(y.1)")
        }
        if !folded {
          #expect(abs(fold.minX - (mark.map { $0.maxX + 2 } ?? t.maxX)) < 0.01, "\(what): the chevron 2 after")
        }
        if let mark {
          r.click(CGPoint(x: mark.midX, y: mark.midY))
          await r.until("\(what): its popup") { c.popShown == .spot(.section(gid("g1"))) }
          r.click(CGPoint(x: mark.midX, y: mark.midY))
          await r.until("\(what): closed") { c.popShown == nil }
        }
        r.click(CGPoint(x: fold.midX, y: fold.midY))
        #expect(r.doc.board.section(gid("g1"))?.collapsed == !folded, "\(what): the chevron folds it")
      }
    }
  }

  /// The pointer over a Section's title row is the arrow, as main's (styles.css: buttons and the chrome take
  /// `cursor: default`; .slabel, .sname, .dots and .chev2 set none): over its title, grip, chevron, Fit Content,
  /// Color, a swatch and Lock. Over its sidenote marker it is the pointing hand (.snb `cursor: pointer`)
  @Test func aSectionsTitleRowShowsTheArrowAndItsSidenoteMarkerThePointingHand() async throws {
    var b = sections()
    b.sidenotes = [
      Sidenote(
        id: SidenoteID(rawValue: "sn"), anchor: Spot.section(gid("g1")).anchor, body: .text(TextNote(text: "why")))
    ]
    let r = try await Rig(b, zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let g = gid("g1")
    let t = try #require(c.sectionTitle(g))
    func cursor(at p: CGPoint) -> NSCursor {
      r.send(r.mouse(.mouseMoved, p))
      return NSCursor.current
    }
    #expect(cursor(at: CGPoint(x: t.minX + 4, y: t.midY)) == .arrow, "the title")
    #expect(cursor(at: CGPoint(x: t.minX - 6, y: t.midY)) == .arrow && c.hoveredAct == .grip, "the grip")
    func act(_ a: SectionAct) throws -> CGPoint {
      let rect = try #require(c.actsLayout(g).first { $0.0 == a }?.1, "\(a)")
      return CGPoint(x: rect.midX, y: rect.midY)
    }
    r.click(try act(.color))
    #expect(c.swatchesOpen == g)
    for a in [SectionAct.fold, .fit, .color, .swatch("blue"), .lock] {
      let cur = cursor(at: try act(a))
      #expect(c.hoveredAct == a && cur == .arrow, "\(a): \(cur.image.size)")
    }
    let mark = try #require(c.marks.first { $0.at == .spot(.section(g)) }).frame.offsetBy(dx: t.minX, dy: t.minY)
    #expect(cursor(at: CGPoint(x: mark.midX, y: mark.midY)) == .pointingHand, "the sidenote marker")
  }

  /// Hovered, its title shows Fit Content, Color with its five swatches, Lock and the chevron that folds it
  /// (Sections.tsx SectionActs)
  @Test func aSectionsTitleControlsFitColourLockAndFoldIt() async throws {
    let r = try await Rig(sections(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let g = gid("g2")
    let title = try #require(c.sectionTitle(g))
    r.send(r.mouse(.mouseMoved, CGPoint(x: title.midX, y: title.midY)))
    #expect(c.actsSection == g)
    func spot(_ a: SectionAct) throws -> CGPoint {
      let rect = try #require(c.actsLayout(g).first { $0.0 == a }?.1)
      return CGPoint(x: rect.midX, y: rect.midY)
    }
    // the pointer over a control keeps them shown
    r.send(r.mouse(.mouseMoved, try spot(.fit)))
    #expect(c.actsSection == g && c.hoveredAct == .fit)
    let before = try #require(r.doc.board.section(g))
    r.click(try spot(.fit))
    let fitted = try #require(r.doc.board.section(g))
    #expect(fitted.width != before.width || fitted.height != before.height)
    r.click(try spot(.color))
    #expect(c.swatchesOpen == g && c.actsLayout(g).filter { if case .swatch = $0.0 { true } else { false } }.count == 5)
    r.click(try spot(.swatch("blue")))
    #expect(r.doc.board.section(g)?.color == "blue")
    r.click(try spot(.lock))
    #expect(r.doc.board.section(g)?.locked == true)
    #expect(c.fitBlocked(g) == "the Section is locked")
    r.click(try spot(.lock))
    #expect(r.doc.board.section(g)?.locked == false)
    // folded and back: the frame it had open comes back
    let open = try #require(c.scene?.frames.first { $0.id == g }?.rect)
    r.click(try spot(.fold))
    await r.settle()
    #expect(r.doc.board.section(g)?.collapsed == true)
    #expect(c.fitBlocked(g) == "expand the Section first")
    r.send(
      r.mouse(.mouseMoved, CGPoint(x: try #require(c.sectionTitle(g)).midX, y: try #require(c.sectionTitle(g)).midY)))
    r.click(try spot(.fold))
    await r.settle()
    #expect(r.doc.board.section(g)?.collapsed == false)
    #expect(c.scene?.frames.first { $0.id == g }?.rect == open)
    // each a step of its own: Fit, the colour, Lock, Unlock, fold, unfold
    #expect(r.doc.history.undoSteps.count == 6)
    // the pointer gone: they go
    r.send(r.mouse(.mouseMoved, CGPoint(x: -400, y: -400)))
    #expect(c.actsSection == nil)
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
    #expect(
      titles(menu) == [
        "Fit Content", "Color", "Lock", "-", "Add Sidenote", "Collapse", "Move Out of Parent Section", "Copy Path", "-",
        "Remove Section",
      ])
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

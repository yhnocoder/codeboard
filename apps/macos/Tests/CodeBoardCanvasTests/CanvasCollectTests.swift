import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// What a reading pane collects onto the board (CanvasCollect.swift), made up, from a provider of the test's own: Add to
// Board puts its card in a free place of the view, a drag holds the card as it will be at the pointer and lets it go
// there; selected, one step, in the Section it lands in. Only the drags' own pasteboards are written. Under
// CanvasPasteTests, the copy and paste area's tests

extension CanvasPasteTests {
  @MainActor @Suite struct Collect {
    static let note = Collected(
      body: .note(markdown: "Clipped gradients keep $\\tau$ small."), source: anchor("e1"),
      title: "Sparse Gradient Notes", label: "§2")
    static let figure = Collected(
      body: .image(alt: "Figure 3: loss over steps", width: 320, height: 180), source: anchor("e1", "fig3"),
      title: "Sparse Gradient Notes", label: "Figure 3")

    func rig() async throws -> (Rig, FakeSources) {
      let fake = FakeSources()
      fake.labels["e1"] = SourceLabel(title: "Sparse Gradient Notes", number: "2405.01234", icon: .paper)
      fake.sizes["e1"] = CGSize(width: 320, height: 180)
      fake.picture = flat(640, 360)
      return (try await Rig(CanvasPasteTests.board(), zoom: 1, sources: fake), fake)
    }

    /// A drag from a reading pane: the collected JSON (or `raw`) and a plain string, at a board point
    func drag(_ c: Collected, at p: CGPoint, _ r: Rig, raw: Data? = nil) throws -> Drag {
      let data = try raw ?? c.data()
      return Drag(at: r.at(p)) { pb in
        pb.declareTypes([CanvasView.collectedType, .string], owner: nil)
        pb.setData(data, forType: CanvasView.collectedType)
        pb.setString("Clipped gradients keep τ small.", forType: .string)
      }
    }

    func added(_ r: Rig, _ before: Set<CardID>) throws -> Card {
      try #require(r.doc.board.cards.first { !before.contains($0.id) })
    }

    @Test func addToBoardMakesANoteWithItsSourceSelectedInViewInOneStep() async throws {
      let (r, _) = try await rig()
      defer { r.close() }
      let before = Set(r.doc.board.cards.map(\.id))
      #expect(r.canvas.collect(Self.note))
      let c = try added(r, before)
      guard case .own(let k) = c.content, case .note(let n) = k.body else {
        Issue.record("not a Note: \(c)")
        return
      }
      #expect(
        n.text == "Clipped gradients keep $\\tau$ small." && k.source == anchor("e1") && c.width == Board.newNoteWidth)
      #expect(
        r.doc.selection == [.card(c.id)] && r.doc.undoName == "Add to Board" && r.doc.history.undoSteps.count == 1)
      await r.until("its card drawn") { r.canvas.index(of: .card(c.id)) != nil }
      let it = try #require(r.canvas.index(of: .card(c.id)).map { r.canvas.scene!.items[$0] })
      #expect(it.drawing.foot?.title == "Sparse Gradient Notes", "its source at its foot")
      #expect(r.canvas.camera.visible(r.canvas.bounds.size).contains(it.rect), "in view")
      #expect(!it.rect.intersects(r.rect("a").insetBy(dx: -CanvasView.pasteGap, dy: -CanvasView.pasteGap)), "free")
    }

    @Test func addToBoardMakesAFigureAResourceImageCardOfItsNaturalSize() async throws {
      let (r, _) = try await rig()
      defer { r.close() }
      let before = Set(r.doc.board.cards.map(\.id))
      #expect(r.canvas.collect(Self.figure))
      let c = try added(r, before)
      guard case .own(let k) = c.content, case .image(let img) = k.body else {
        Issue.record("not an image card: \(c)")
        return
      }
      #expect(img.source == .resource(anchor("e1", "fig3")) && img.alt == "Figure 3: loss over steps")
      #expect(k.source == nil, "the block it shows names the place")
      await r.until("its card drawn") { r.canvas.index(of: .card(c.id)) != nil }
      // the picture at the block's size, its source on a strip under it
      let it = try #require(r.canvas.index(of: .card(c.id)).map { r.canvas.scene!.items[$0] })
      guard case .image(let p) = it.drawing else {
        Issue.record("not drawn as an image: \(it.drawing)")
        return
      }
      #expect(it.rect.width == 320 && it.rect.height - p.below == 180 && p.foot != nil)
      // an image with nothing to draw it from is no card
      var none = Self.figure
      none.source = nil
      #expect(!r.canvas.collect(none) && r.doc.board.cards.count == before.count + 1)
      #expect(r.doc.history.undoSteps.count == 1)
    }

    @Test(arguments: [1, 0.5] as [CGFloat])
    func aDragHoldsTheCardAtItsRealSizeAtThePointerUntilItLeaves(zoom: CGFloat) async throws {
      let (r, _) = try await rig()
      defer { r.close() }
      r.canvas.place(zoom: zoom, centre: CGPoint(x: 550, y: 400))
      let d = try drag(Self.note, at: CGPoint(x: 700, y: 500), r)
      defer { d.draggingPasteboard.releaseGlobally() }
      #expect(r.canvas.draggingEntered(d) == .copy)
      await r.until("the card in hand") { r.canvas.inHand?.layers != nil }
      let box = try #require(r.canvas.inHand?.layers?.box)
      // in the board's own units, under the camera: as big on screen as the card it will be at this zoom
      #expect(box.superlayer === r.canvas.shelfDrag && box.bounds.width == Board.newNoteWidth && box.bounds.height > 40)
      #expect(box.position == CGPoint(x: 700, y: 500), "centred on the pointer")
      #expect(r.canvas.inHand?.layers?.held.contents != nil, "drawn")
      #expect(
        !d.items.isEmpty && d.items.allSatisfy { $0.imageComponents?.isEmpty ?? true }, "no picture of the drag's")
      d.draggingLocation = r.at(CGPoint(x: 820, y: 560))
      #expect(r.canvas.draggingUpdated(d) == .copy)
      #expect(box.position == CGPoint(x: 820, y: 560), "following")
      // off the board: nothing in hand, nothing made
      r.canvas.draggingExited(d)
      #expect(box.superlayer == nil && r.canvas.inHand == nil)
      // over again, and the drag over without a drop (Esc): nothing either
      #expect(r.canvas.draggingEntered(d) == .copy)
      await r.until("the card in hand") { r.canvas.inHand?.layers != nil }
      r.canvas.draggingEnded(d)
      #expect(r.canvas.inHand == nil && r.canvas.shelfDrag.sublayers?.isEmpty ?? true)
      #expect(r.doc.board.cards.count == 1 && !r.doc.history.canUndo)
    }

    @Test func aDropLandsTheCardWhereItWasHeldSelectedInOneStepInItsSection() async throws {
      let (r, fake) = try await rig()
      defer { r.close() }
      let before = Set(r.doc.board.cards.map(\.id))
      let d = try drag(Self.note, at: CGPoint(x: 700, y: 500), r)
      defer { d.draggingPasteboard.releaseGlobally() }
      _ = r.canvas.draggingEntered(d)
      await r.until("the card in hand") { r.canvas.inHand?.layers != nil }
      d.draggingLocation = r.at(CGPoint(x: 250, y: 200))
      _ = r.canvas.draggingUpdated(d)
      let held = try #require(r.canvas.inHand?.layers?.box.frame)
      #expect(r.canvas.performDragOperation(d))
      r.canvas.draggingEnded(d)
      let c = try added(r, before)
      #expect(c.x == held.minX.rounded() && c.y == held.minY.rounded(), "where it was held")
      #expect(c.section == SectionID(rawValue: "g"), "in the Section it landed in")
      #expect(
        r.doc.selection == [.card(c.id)] && r.doc.undoName == "Add to Board" && r.doc.history.undoSteps.count == 1)
      #expect(r.window.firstResponder === r.canvas && r.canvas.inHand == nil)
      await r.until("its card drawn") { r.canvas.index(of: .card(c.id)) != nil }
      #expect(abs(r.rect(c.id.rawValue).height - held.height) < 1, "as tall as held")
      // a figure: its block asked of the provider, held at its natural size, let go there
      let f = try drag(Self.figure, at: CGPoint(x: 700, y: 600), r)
      defer { f.draggingPasteboard.releaseGlobally() }
      _ = r.canvas.draggingEntered(f)
      await r.until("its block asked for") { !fake.asked.isEmpty }
      fake.letGo()
      await r.until("the figure in hand") { r.canvas.inHand?.layers != nil }
      let fig = try #require(r.canvas.inHand?.layers?.box)
      #expect(fig.bounds.width == 320 && fig.bounds.height > 180 && fig.position == CGPoint(x: 700, y: 600))
      #expect(r.canvas.performDragOperation(f))
      let g = try #require(r.doc.board.cards.last)
      #expect(g.x == (700 - 160) && g.y == (600 - fig.bounds.height / 2).rounded(), "\(g.x), \(g.y), \(fig.bounds)")
      #expect(r.doc.history.undoSteps.count == 2)
    }

    @Test func aDragWithoutTheTypeOrWithJSONThatDoesNotReadIsLeftAlone() async throws {
      let (r, _) = try await rig()
      defer { r.close() }
      let text = Drag(at: r.at(CGPoint(x: 700, y: 500))) { $0.setString("plain words", forType: .string) }
      defer { text.draggingPasteboard.releaseGlobally() }
      #expect(r.canvas.draggingEntered(text) == [] && r.canvas.inHand == nil)
      #expect(!r.canvas.performDragOperation(text))
      let bad = try drag(Self.note, at: CGPoint(x: 700, y: 500), r, raw: Data("{\"body\": [1,".utf8))
      defer { bad.draggingPasteboard.releaseGlobally() }
      #expect(r.canvas.draggingEntered(bad) == [] && r.canvas.inHand == nil)
      #expect(!r.canvas.performDragOperation(bad))
      #expect(r.doc.board.cards.count == 1 && !r.doc.history.canUndo)
    }
  }
}

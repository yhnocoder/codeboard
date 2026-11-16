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

    func rig(pictures: (@Sendable (URL) async -> Data?)? = nil) async throws -> (Rig, FakeSources) {
      let fake = FakeSources()
      fake.labels["e1"] = SourceLabel(title: "Sparse Gradient Notes", number: "2405.01234", icon: .paper)
      fake.sizes["e1"] = CGSize(width: 320, height: 180)
      fake.picture = flat(640, 360)
      return (try await Rig(CanvasPasteTests.board(), zoom: 1, pictures: pictures, sources: fake), fake)
    }

    /// A web page's picture: the page (an entry with no place) as its source
    static func picture(_ url: String, width: Double = 300) -> Collected {
      Collected(
        body: .picture(url: url, alt: "A heron", width: width, height: width / 2),
        source: SourceAnchor(entry: EntryID(rawValue: "e1")),
        title: "Sparse Gradient Notes", label: "")
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

    @Test func aWebPictureIsAnImageCardAtItsAddressWithThePageAsItsSource() async throws {
      // read through the test's own loader: never the network
      let png = CanvasPasteTests.png(600, 300)
      let (r, _) = try await rig(pictures: { _ in png })
      defer { r.close() }
      let before = Set(r.doc.board.cards.map(\.id))
      let url = "https://example.com/heron.png"
      #expect(r.canvas.collect(Self.picture(url)))
      let c = try added(r, before)
      guard case .own(let k) = c.content, case .image(let img) = k.body else {
        Issue.record("not an image card: \(c)")
        return
      }
      #expect(
        img.source == .url(url) && img.alt == "A heron" && k.source == SourceAnchor(entry: EntryID(rawValue: "e1")))
      #expect(c.width == 300 && r.doc.selection == [.card(c.id)] && r.doc.history.undoSteps.count == 1)
      // drawn once its picture is read: as tall as its proportions make its width
      func pictureHeight(_ id: CardID) -> CGFloat? {
        guard let i = r.canvas.index(of: .card(id)), let it = r.canvas.scene?.items[i], case .image(let p) = it.drawing,
          p.url != nil
        else { return nil }
        return it.rect.height - p.below
      }
      await r.until("drawn with its picture") { pictureHeight(c.id) != nil }
      #expect(pictureHeight(c.id) == 150)
      // a huge one: as wide as a pasted picture can be
      #expect(r.canvas.collect(Self.picture("https://example.com/hero.png", width: 3000)))
      let h = try #require(r.doc.board.cards.last)
      #expect(h.width == Board.newNoteWidth)
      await r.until("drawn with its picture") { pictureHeight(h.id) != nil }
      #expect(pictureHeight(h.id).map { abs($0 - Board.newNoteWidth / 2) < 0.01 } == true)
    }

    @Test func aDataPictureIsKeptInTheBoardsImagesAndOneThatIsNoPictureIsRefused() async throws {
      let (r, _) = try await rig()
      defer { r.close() }
      let before = Set(r.doc.board.cards.map(\.id))
      let png = "data:image/png;base64," + CanvasPasteTests.png(600, 300).base64EncodedString()
      #expect(r.canvas.collect(Self.picture(png)))
      let c = try added(r, before)
      guard case .own(let k) = c.content, case .image(let img) = k.body, case .file(let name) = img.source else {
        Issue.record("not an image file: \(c)")
        return
      }
      #expect(k.source != nil && img.alt == "A heron" && c.width == 300)
      let file = r.file.deletingLastPathComponent().appending(path: Vault.imagesFolder).appending(path: name)
      #expect(FileManager.default.fileExists(atPath: file.path(percentEncoded: false)))
      // not a picture, not base64, an SVG (a paste cleans it first), no address of either kind: nothing
      for bad in [
        "data:text/plain;base64," + Data("plain words".utf8).base64EncodedString(), "data:image/png,abc",
        "data:image/svg+xml;base64," + Data("<svg xmlns='http://www.w3.org/2000/svg'/>".utf8).base64EncodedString(),
        "file:///etc/hosts",
      ] {
        #expect(!r.canvas.collect(Self.picture(bad)), "\(bad)")
      }
      let d = try drag(Self.picture("data:image/png;base64,AAAA"), at: CGPoint(x: 700, y: 500), r)
      defer { d.draggingPasteboard.releaseGlobally() }
      _ = r.canvas.draggingEntered(d)
      #expect(!r.canvas.performDragOperation(d))
      r.canvas.draggingEnded(d)
      #expect(r.doc.board.cards.count == before.count + 1 && r.doc.history.undoSteps.count == 1)
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

    /// An entry dragged from a resource's list: a Note whose source is the entry as a whole (no place), its foot the
    /// provider's, a click on it showing that anchor
    @Test func anEntryDroppedIsANoteWithAPlacelessSourceWhoseFootShowsIt() async throws {
      let (r, fake) = try await rig()
      defer { r.close() }
      fake.labels["e2"] = SourceLabel(title: "Tidal mills", number: nil, icon: .paper)
      let whole = SourceAnchor(entry: EntryID(rawValue: "e2"))
      let entry = Collected(
        body: .note(markdown: "**Tidal mills**\nAna Ruíz, Bo Chen"), source: whole, title: "Tidal mills", label: "")
      let d = try drag(entry, at: CGPoint(x: 700, y: 500), r)
      defer { d.draggingPasteboard.releaseGlobally() }
      _ = r.canvas.draggingEntered(d)
      await r.until("the card in hand") { r.canvas.inHand?.layers != nil }
      #expect(r.canvas.performDragOperation(d))
      r.canvas.draggingEnded(d)
      let c = try #require(r.doc.board.cards.last)
      guard case .own(let k) = c.content, case .note(let n) = k.body else {
        Issue.record("not a Note: \(c)")
        return
      }
      #expect(n.text == "**Tidal mills**\nAna Ruíz, Bo Chen" && k.source == whole && k.source?.place == nil)
      #expect(r.doc.selection == [.card(c.id)] && r.doc.history.undoSteps.count == 1)
      await r.until("its foot drawn") {
        r.canvas.index(of: .card(c.id)).flatMap { r.canvas.scene?.items[$0].drawing.foot } != nil
      }
      let foot = try #require(r.canvas.index(of: .card(c.id)).flatMap { r.canvas.scene?.items[$0].drawing.foot })
      #expect(foot.title == "Tidal mills" && foot.number == nil && foot.anchor == whole)
      let at = foot.frame.offsetBy(dx: r.rect(c.id.rawValue).minX, dy: r.rect(c.id.rawValue).maxY)
      r.click(CGPoint(x: at.midX, y: at.midY))
      #expect(fake.revealed == [whole])
    }

    /// A web address dragged alone (a list's web page, a link from a browser): held as the Web card a pasted address
    /// makes, let go there, selected, one step, its page read through the canvas's own fetch
    @Test func anAddressDroppedIsAWebCardWhereItWasLetGo() async throws {
      let (r, _) = try await rig()
      defer { r.close() }
      let pages = CanvasWebTests.Pages()
      r.canvas.fetchPage = pages.fetch
      let d = Drag(at: r.at(CGPoint(x: 700, y: 500))) { pb in
        pb.writeObjects([URL(string: "https://harbour.example.org/log")! as NSURL])
      }
      defer { d.draggingPasteboard.releaseGlobally() }
      #expect(r.canvas.draggingEntered(d) == .copy)
      await r.until("the card in hand") { r.canvas.inHand?.layers != nil }
      let held = try #require(r.canvas.inHand?.layers?.box.frame)
      #expect(held.width == Board.webWidth && held.midX == 700 && held.midY == 500)
      #expect(r.canvas.performDragOperation(d))
      r.canvas.draggingEnded(d)
      let c = try #require(r.doc.board.cards.last)
      guard case .own(let k) = c.content, case .web(let w) = k.body else {
        Issue.record("not a Web card: \(c)")
        return
      }
      #expect(w.url == "https://harbour.example.org/log" && c.width == Board.webWidth)
      #expect(c.x == held.minX.rounded() && c.y == held.minY.rounded(), "where it was held")
      #expect(
        r.doc.selection == [.card(c.id)] && r.doc.undoName == "Add to Board" && r.doc.history.undoSteps.count == 1)
      await r.until("its page read") { pages.asked == ["https://harbour.example.org/log"] }
    }

    /// An address with other words around it is no address alone: no Web card, the drag left alone as plain text is
    @Test func anAddressWithOtherWordsDroppedIsNoWebCard() async throws {
      let (r, _) = try await rig()
      defer { r.close() }
      let d = Drag(at: r.at(CGPoint(x: 700, y: 500))) {
        $0.setString("see https://harbour.example.org/log", forType: .string)
      }
      defer { d.draggingPasteboard.releaseGlobally() }
      #expect(r.canvas.draggingEntered(d) == [] && r.canvas.inHand == nil)
      #expect(!r.canvas.performDragOperation(d))
      #expect(r.doc.board.cards.count == 1 && !r.doc.history.canUndo)
    }

    /// An address that is not http or https is no Web card
    @Test func anAddressNotHTTPDroppedIsNoWebCard() async throws {
      let (r, _) = try await rig()
      defer { r.close() }
      let d = Drag(at: r.at(CGPoint(x: 700, y: 500))) { pb in
        pb.writeObjects([URL(string: "ftp://harbour.example.org/log")! as NSURL])
      }
      defer { d.draggingPasteboard.releaseGlobally() }
      #expect(r.canvas.draggingEntered(d) == [] && r.canvas.inHand == nil)
      #expect(!r.canvas.performDragOperation(d))
      #expect(r.doc.board.cards.count == 1 && !r.doc.history.canUndo)
    }
  }
}

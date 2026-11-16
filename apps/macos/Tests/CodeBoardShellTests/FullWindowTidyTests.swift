import AppKit
import CodeBoardModel
import Foundation
import Testing

@testable import CodeBoardCanvas
@testable import CodeBoardNotes
@testable import CodeBoardShell

// Tidy Up in the whole window (keymap.ts tidyUp ⌥T, menus.ts multiItems and multiSectionItems, actions/edit.ts tidyUp,
// core tidy and tidyMove, actions/common.ts slideFrom): the cards and Sections selected go where core's tidy puts them
// in one step, sliding there with the arrows on them; nothing applies when they were moved or deleted meanwhile

@MainActor @Suite(.serialized) struct FullWindowTidyTests {
  let board = BoardID(rawValue: "w")
  let env = FullWindowEditTests()

  func vault() throws -> Vault {
    let root = FileManager.default.temporaryDirectory.appending(path: "tidy-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let vault = Vault(root: root)
    func note(_ id: String, x: Double, y: Double, section: String? = nil, locked: Bool = false) -> Card {
      Card(
        id: CardID(rawValue: id), x: x, y: y, width: 240, height: 160, section: section.map(SectionID.init),
        locked: locked, content: .own(CardContent(body: .note(Note(text: id)))))
    }
    try vault.newBoard(
      in: "", title: "W",
      board: Board(
        id: board,
        cards: [
          note("a", x: 0, y: 0), note("b", x: 500, y: 300), note("c", x: 100, y: 700),
          note("m", x: 1040, y: 80, section: "g"), note("far", x: 3000, y: 0), note("l", x: 1000, y: 700, locked: true),
        ],
        arrows: [
          Arrow(
            id: ArrowID(rawValue: "ab"), from: Endpoint(card: CardID(rawValue: "a")),
            to: Endpoint(card: CardID(rawValue: "b")))
        ],
        sections: [
          Section(id: SectionID(rawValue: "g"), title: "G", x: 1000, y: 0, width: 400, height: 300),
          Section(id: SectionID(rawValue: "h"), title: "H", x: 1600, y: 600, width: 300, height: 200),
        ]))
    return vault
  }

  func cid(_ s: String) -> CardID { CardID(rawValue: s) }
  func gid(_ s: String) -> SectionID { SectionID(rawValue: s) }

  func opened() async throws -> FullWindowEditTests.Window { try await env.opened(try vault()) }

  /// ⌥T as the canvas gets it
  func optionT(_ w: FullWindowEditTests.Window) {
    let e = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: .option, timestamp: 0, windowNumber: w.window.windowNumber,
      context: nil, characters: "†", charactersIgnoringModifiers: "t", isARepeat: false, keyCode: 17)!
    w.window.makeFirstResponder(w.canvas)
    w.canvas.keyDown(with: e)
  }

  func place(_ w: FullWindowEditTests.Window, _ id: String) -> [Double]? {
    w.canvas.document?.board.card(cid(id)).map { [$0.x, $0.y] }
  }

  /// The menu a right press at a board point gets
  func menu(_ w: FullWindowEditTests.Window, at p: CGPoint) -> NSMenu? {
    let e = NSEvent.mouseEvent(
      with: .rightMouseDown, location: w.at(p), modifierFlags: [], timestamp: 0, windowNumber: w.window.windowNumber,
      context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
    return w.canvas.menu(for: e)
  }

  /// ⌥T on three cards, two with an arrow between them: core tidy's places (the web board's for the same rects), as one
  /// "Tidy Up" step that undoes to where they were; the one far off and the locked one stay
  @Test func optionTPutsTheCardsWhereCoreTidyDoesInOneStep() async throws {
    let w = try await opened()
    defer { w.close() }
    let c = w.canvas
    let doc = try #require(c.document)
    doc.select([.card(cid("a")), .card(cid("b")), .card(cid("c"))])
    #expect(c.canTidyUp)
    optionT(w)
    await env.until("tidied", in: w) { doc.undoName == "Tidy Up" }
    #expect(place(w, "a") == [0, 0] && place(w, "b") == [296, 0] && place(w, "c") == [0, 216])
    #expect(place(w, "far") == [3000, 0] && place(w, "l") == [1000, 700])
    doc.undo()
    #expect(place(w, "b") == [500, 300] && place(w, "c") == [100, 700])
  }

  /// The slide: the scene with the new places comes in with the cards still where they were, and they ease there
  /// (k 170, c 26) a frame at a time, never stepping back, with no step three times its neighbours; only their layers'
  /// positions change (the same layers, the same bitmaps); the arrow on them follows
  @Test func theCardsSlideToTheirPlacesWithTheArrowFollowing() async throws {
    let w = try await opened()
    defer { w.close() }
    let c = w.canvas
    let doc = try #require(c.document)
    // the bitmaps compared are the ones it shows once its redraws after opening are in (the Notes' pictures come from the
    // renderer, on its own time), so that only the slide could replace them
    await env.until("its redraws in", in: w) { c.isSettled }
    var t = CACurrentMediaTime()
    c.steppedClock = { t }
    let i = try #require(c.index(of: .card(cid("b"))))
    let before = try #require(c.scene?.items[i].rect)
    let box = c.items[i].box
    let bitmaps = [c.items[i].held.contents, c.items[i].rest.contents].map { $0 as AnyObject? }
    doc.select([.card(cid("a")), .card(cid("b")), .card(cid("c"))])
    c.tidyUp()
    let deadline = ContinuousClock.now + .seconds(20)
    while c.tidySlide?.started != true {
      try #require(ContinuousClock.now < deadline, "the slide starts with the scene that has the new places")
      t += 1 / 60
      c.tick(at: t)
      try await Task.sleep(for: .milliseconds(5))
    }
    let j = try #require(c.index(of: .card(cid("b"))))
    let to = try #require(c.scene?.items[j].rect)
    #expect(to.origin != before.origin)
    var shown = [box.position]
    var ends: [CGPoint] = []
    while c.tidySlide != nil && shown.count < 200 {
      t += 1 / 60
      c.tick(at: t)
      shown.append(box.position)
      if let p = c.arrowPoints(ArrowID(rawValue: "ab"))?.end { ends.append(p) }
    }
    #expect(c.tidySlide == nil && shown.count > 20, "the slide ends, a frame at a time: \(shown.count) frames")
    #expect(
      abs(shown[0].x - before.midX) < 0.5 && abs(shown[0].y - before.midY) < 0.5, "from where it was: \(shown[0])")
    // landed where the scene has it: its corner is on whole board units, so on device pixels on a 1x screen too
    #expect(shown.last == CGPoint(x: to.midX, y: to.midY), "landed: \(shown.last.map { "\($0)" } ?? "nowhere")")
    let target = CGPoint(x: to.midX, y: to.midY)
    let left = shown.map { hypot($0.x - target.x, $0.y - target.y) }
    #expect(zip(left, left.dropFirst()).allSatisfy { $1 <= $0 + 0.01 }, "never back: \(left)")
    let steps = zip(left, left.dropFirst()).map { $0 - $1 }
    for k in 1..<max(1, steps.count - 1) where steps[k] > 1 {
      #expect(steps[k] <= 3 * max(steps[k - 1], steps[k + 1]) + 0.5, "a jump at frame \(k): \(steps)")
    }
    #expect(c.items[j].box === box, "the same layer")
    let now = [c.items[j].held.contents, c.items[j].rest.contents].map { $0 as AnyObject? }
    #expect(zip(now, bitmaps).allSatisfy { $0 === $1 }, "not drawn again")
    // the arrow's end goes with the card: on its left edge, where the card was shown, every frame
    #expect(ends.count == shown.count - 1)
    for (p, at) in zip(ends, shown.dropFirst()) {
      #expect(abs(p.x - (at.x - to.width / 2)) < 12 && abs(p.y - at.y) < to.height / 2, "\(p) for a card at \(at)")
    }
  }

  /// What the layout would move was moved or deleted before it came: nothing applies
  @Test(arguments: ["moved", "deleted"]) func nothingAppliesWhenTheCardsChangedMeanwhile(_ how: String) async throws {
    let w = try await opened()
    defer { w.close() }
    let c = w.canvas
    let doc = try #require(c.document)
    doc.select([.card(cid("a")), .card(cid("b")), .card(cid("c"))])
    let task = try #require(c.tidyUp())
    if how == "moved" {
      doc.edit("Move") { $0.move([.card(cid("c"))], dx: 10, dy: 0) }
    } else {
      doc.edit("Delete") { $0.delete([.card(cid("c"))]) }
    }
    await task.value
    #expect(doc.undoName == (how == "moved" ? "Move" : "Delete"))
    #expect(place(w, "b") == [500, 300])
  }

  /// The menus: several cards have Tidy Up ⌥T after Tilt; several Sections after Fit Content, on with two unlocked. A
  /// Section chosen is one block: it moves with what is in it, its frame easing there as with Fit Content
  @Test func theMenusTidyAndASectionMovesAsOneBlock() async throws {
    let w = try await opened()
    defer { w.close() }
    let c = w.canvas
    let doc = try #require(c.document)
    doc.select([.card(cid("a")), .card(cid("b"))])
    let m = try #require(menu(w, at: CGPoint(x: 120, y: 80)))
    let titles = m.items.map(\.title)
    let item = try #require(m.item(withTitle: "Tidy Up"))
    #expect(titles.firstIndex(of: "Tidy Up") == titles.firstIndex(of: "Tilt").map { $0 + 1 })
    #expect(item.action != nil && item.keyEquivalent == "t" && item.keyEquivalentModifierMask == .option)
    doc.select([.section(gid("g")), .section(gid("h"))])
    let title = try #require(c.sectionTitle(gid("g")))
    let sm = try #require(menu(w, at: CGPoint(x: title.midX, y: title.midY)))
    let sItem = try #require(sm.item(withTitle: "Tidy Up"))
    #expect(sm.items.map(\.title).prefix(2) == ["Fit Content", "Tidy Up"] && sItem.action != nil)
    try #require(sItem.representedObject as? MenuAction).run()
    await env.until("tidied", in: w) { doc.undoName == "Tidy Up" }
    let g = try #require(doc.board.section(gid("g")))
    let h = try #require(doc.board.section(gid("h")))
    #expect([g.x, g.y, h.x, h.y] == [1000, 0, 1000, 328], "\([g.x, g.y, h.x, h.y])")
    #expect(place(w, "m") == [1040 + g.x - 1000, 80 + g.y])
    // the scene with its new place comes in a moment after the step, its frame easing there
    await env.until("its frame eases", in: w) {
      guard c.shownBoard == doc.board, let at = c.scene?.frames.firstIndex(where: { $0.id == gid("h") }),
        let ls = c.sections.sublayers, at < ls.count
      else { return false }
      return ls[at].animation(forKey: "ease") != nil
    }
    doc.edit("Lock") { b in
      for i in b.sections.indices where b.sections[i].id == gid("h") { b.sections[i].locked = true }
    }
    #expect(doc.board.section(gid("h"))?.locked == true)
    await env.until("drawn", in: w) { c.shownBoard == doc.board }
    let locked = try #require(menu(w, at: CGPoint(x: title.midX, y: title.midY))?.item(withTitle: "Tidy Up"))
    // off: no action, which the menu's validation greys
    #expect(locked.action == nil)
  }
}

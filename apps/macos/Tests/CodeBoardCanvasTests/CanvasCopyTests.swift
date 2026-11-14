import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// What a copy on its own board takes and leaves, as main's commands: ⌘D (core commands/cards.ts duplicateCards) and ⌘C
// ⌘V (board actions/shared.ts pasteCopied → core commands/shared.ts pasteCards; both through core edit/ops.ts
// placeCards), then Reference and Copy on the chip (core edit/twins.ts makeTwin, detachTwin)

private let cs = SegmentID(rawValue: "cs")

/// sample() with a locked, tilted code card with hidden and highlighted lines and a summary, an arrow from it to n2, a
/// sidenote on its lines (it travels with the card), one kept to this board, and a sticker on it
private func copyBoard() -> Board {
  var b = sample()
  let seg = Segment(
    id: cs, source: nil, language: "python", firstLine: 10,
    lines: ["def schedule(queue):", "    batch = queue.take(8)", "    run(batch)", "    return batch"],
    hidden: [11...11], highlights: [12...13])
  b.cards.append(
    Card(
      id: cid("c9"), x: 1300, y: 0, width: 360, locked: true, tilted: true,
      summary: Summary(text: "Takes a batch", at: 1, sig: "x"),
      content: .own(CardContent(body: .code(CodeCard(segments: [seg]))))))
  b.arrows.append(Arrow(id: ArrowID(rawValue: "a2"), from: Endpoint(card: cid("c9")), to: Endpoint(card: cid("n2"))))
  b.sidenotes = [
    Sidenote(
      id: SidenoteID(rawValue: "why"), anchor: .card(cid("c9"), segment: cs, lines: 12...13),
      body: .text(TextNote(text: "why"))),
    Sidenote(
      id: SidenoteID(rawValue: "here"), anchor: .card(cid("c9"), segment: nil, lines: nil),
      body: .text(TextNote(text: "here")),
      boardOnly: true),
  ]
  b.stickers = [
    Sticker(id: StickerID(rawValue: "k1"), glyph: .builtin(.star), anchor: .card(cid("c9"), x: 20, y: 30, size: 40))
  ]
  return b
}

@MainActor @Suite(.serialized) struct CanvasCopyTests {
  /// The copies made, by the card each was made from
  func copies(_ r: Rig) throws -> [CardID: Card] {
    let pairs = try #require(r.canvas.pasteChip?.pairs)
    return Dictionary(uniqueKeysWithValues: try pairs.map { ($0.of, try #require(r.doc.board.card($0.copy))) })
  }

  func touches(_ b: Board, _ id: CardID) -> (arrows: Int, sidenotes: [String], stickers: Int) {
    let notes = b.sidenotes.compactMap { n -> String? in
      guard case .card(id, _, _, _) = n.anchor, case .text(let t) = n.body else { return nil }
      return t.text
    }
    return (
      b.arrows.filter { $0.from.card == id || $0.to.card == id }.count, notes,
      b.stickers.filter { $0.anchor.card == id }.count
    )
  }

  /// Each copy's content (hidden and highlighted lines too) and tilt as its original's; not locked, no summary (both are
  /// the place's on the board: core Place locked, summary)
  func sameButPlace(_ copy: Card, _ of: Card) {
    #expect(copy.content == of.content && copy.tilted == of.tilted, "\(of.id)")
    #expect(!copy.locked && copy.summary == nil && copy.same == nil, "\(of.id)")
  }

  /// ⌘D: copies 48 down and right, without arrows, sidenotes or stickers, and in no Section (duplicateCards: "without
  /// folding or locks and without arrows"; placeCards takes no sticker, and only the sidenotes it is given: none)
  @Test func duplicateTakesTheContentAndTiltAndLeavesArrowsSidenotesStickersLockSummaryAndSection() async throws {
    let r = try await Rig(copyBoard(), zoom: 0.5)
    defer { r.close() }
    let was = r.doc.board
    r.doc.select([.card(cid("c9")), .card(cid("n2")), .card(cid("m1"))])
    r.canvas.duplicate(nil)
    let made = try copies(r)
    #expect(Set(made.keys) == [cid("c9"), cid("n2"), cid("m1")])
    for (of, copy) in made {
      let o = try #require(was.card(of))
      sameButPlace(copy, o)
      #expect(copy.x == o.x + 48 && copy.y == o.y + 48 && copy.section == nil, "\(of)")
      let t = touches(r.doc.board, copy.id)
      #expect(t.arrows == 0 && t.sidenotes.isEmpty && t.stickers == 0, "\(of): \(t)")
    }
    #expect(r.doc.board.arrows.count == was.arrows.count && r.doc.board.sidenotes.count == was.sidenotes.count)
    #expect(r.doc.board.stickers.count == was.stickers.count)
  }

  /// ⌘C ⌘V on the same board: copies with the arrows among them and the sidenotes that travel with a card (not one kept
  /// to the board), no sticker, each in the Section it lands in (pasteCopied: cardCopies, the links among them, settleHome);
  /// Reference then keeps the copy's own arrows and sidenotes and makes it the original's other place, Copy a card of
  /// its own again with them still on it
  @Test func pasteTakesTheArrowsAmongThemAndTravellingSidenotesAndLandsInItsSection() async throws {
    let board = NSPasteboard(name: NSPasteboard.Name("codeboard-tests-\(UUID().uuidString)"))
    defer { board.releaseGlobally() }
    let r = try await Rig(copyBoard(), zoom: 0.5, pasteboard: board)
    defer { r.close() }
    let was = r.doc.board
    r.doc.select([.card(cid("c9")), .card(cid("n2")), .card(cid("m1"))])
    r.canvas.copy(nil)
    r.canvas.paste(nil)
    let made = try copies(r)
    #expect(Set(made.keys) == [cid("c9"), cid("n2"), cid("m1")])
    for (of, copy) in made { sameButPlace(copy, try #require(was.card(of))) }
    let c9 = try #require(made[cid("c9")])
    let n2 = try #require(made[cid("n2")])
    let m1 = try #require(made[cid("m1")])
    #expect(r.doc.board.arrows.contains { $0.from.card == c9.id && $0.to.card == n2.id }, "the arrow among them")
    #expect(touches(r.doc.board, m1.id).arrows == 0, "not the one from n1, which was not copied")
    #expect(touches(r.doc.board, c9.id).sidenotes == ["why"] && touches(r.doc.board, c9.id).stickers == 0)
    #expect(r.doc.board.sidenotes.filter { $0.id == SidenoteID(rawValue: "why") }.count == 1, "a new id")
    #expect(m1.section == SectionID(rawValue: "g1") && c9.section == nil && n2.section == nil, "where they landed")
    // Reference: the copy is the original's other place and keeps its own arrow and sidenote; Copy: its own again
    await r.settle()
    let rect = try #require(r.canvas.chipRect())
    let l = ChipLayout.layout(ref: false, font: ChipLayout.font(r.canvas.theme))
    let z = r.canvas.camera.zoom
    r.click(CGPoint(x: rect.minX + l.reference.midX / z, y: rect.minY + l.reference.midY / z))
    let twin = try #require(r.doc.board.card(c9.id))
    #expect(twin.same != nil && twin.same == r.doc.board.card(cid("c9"))?.same)
    #expect(touches(r.doc.board, c9.id).arrows == 1 && touches(r.doc.board, c9.id).sidenotes == ["why"])
    let l2 = ChipLayout.layout(ref: true, font: ChipLayout.font(r.canvas.theme))
    let rect2 = try #require(r.canvas.chipRect())
    r.click(CGPoint(x: rect2.minX + l2.copy.midX / z, y: rect2.minY + l2.copy.midY / z))
    #expect(r.doc.board.card(c9.id)?.same == nil)
    #expect(touches(r.doc.board, c9.id).arrows == 1 && touches(r.doc.board, c9.id).sidenotes == ["why"])
  }
}

// MARK: What is copied, where pastes go, cut and paste back (main's actions/edit.ts duplicateSel, actions/shared.ts
// copyCardsSel, pasteCopied, cutCardsSel, pasteCut)

@MainActor @Suite(.serialized) struct CanvasCopyPlacesTests {
  func rig() async throws -> (Rig, NSPasteboard) {
    let board = NSPasteboard(name: NSPasteboard.Name("codeboard-tests-\(UUID().uuidString)"))
    var b = sample()
    b.arrows.append(Arrow(id: ArrowID(rawValue: "a2"), from: Endpoint(card: cid("n2")), to: Endpoint(card: cid("n1"))))
    return (try await Rig(b, zoom: 0.5, pasteboard: board), board)
  }

  /// Only cards are copied: "const cs = selCards()…; if (!cs.length) return toast("Select a card to duplicate")"
  /// (duplicateSel), "const cs = selHosts(); if (!cs.length) return false;" (copyCardsSel: the key goes on, nothing is
  /// copied). A selected Section with its cards adds nothing; the cards selected with it are copied, alone
  @Test func duplicateAndCopyTakeOnlyTheSelectedCards() async throws {
    let (r, board) = try await rig()
    defer {
      r.close()
      board.releaseGlobally()
    }
    let was = r.doc.board
    r.doc.select([.section(SectionID(rawValue: "g1"))])
    r.canvas.duplicate(nil)
    #expect(r.doc.board.cards.count == was.cards.count && r.doc.board.sections.count == was.sections.count)
    #expect(r.canvas.toastText == "Select a card to duplicate")
    r.canvas.copy(nil)
    #expect(board.data(forType: NSPasteboard.PasteboardType(Clip.pasteboardType)) == nil, "nothing copied")
    r.doc.select([.section(SectionID(rawValue: "g1")), .card(cid("n1"))])
    r.canvas.duplicate(nil)
    #expect(r.doc.board.sections.count == was.sections.count && r.doc.board.cards.count == was.cards.count + 1)
    #expect(r.canvas.pasteChip?.pairs.map(\.of) == [cid("n1")])
    r.doc.select([.section(SectionID(rawValue: "g1")), .card(cid("n2"))])
    r.canvas.copy(nil)
    r.canvas.paste(nil)
    #expect(r.doc.board.sections.count == was.sections.count && r.doc.board.cards.count == was.cards.count + 2)
    #expect(r.canvas.pasteChip?.pairs.map(\.of) == [cid("n2")])
  }

  /// ⌘V on the board the cards were copied on: 36 × n down and right of the originals, n counting the pastes since that
  /// ⌘C ("const k = ++c.n" … "{ x: box.x + 36 * k, y: box.y + 36 * k }", n: 0 at each copyCardsSel)
  @Test func pastesGo36TimesNFromTheOriginals() async throws {
    let (r, board) = try await rig()
    defer {
      r.close()
      board.releaseGlobally()
    }
    let n1 = r.card("n1")
    r.doc.select([.card(cid("n1")), .card(cid("n2"))])
    r.canvas.copy(nil)
    func pasted() throws -> Card {
      r.canvas.paste(nil)
      let id = try #require(r.canvas.pasteChip?.pairs.first { $0.of == cid("n1") }?.copy)
      return try #require(r.doc.board.card(id))
    }
    for k in 1...3 {
      let c = try pasted()
      #expect(c.x == n1.x + 36 * Double(k) && c.y == n1.y + 36 * Double(k), "paste \(k)")
    }
    r.doc.select([.card(cid("n1")), .card(cid("n2"))])
    r.canvas.copy(nil)
    let again = try pasted()
    #expect(again.x == n1.x + 36 && again.y == n1.y + 36, "a new ⌘C counts from 1")
  }

  /// ⌘X then ⌘V on the same board: the cards come back with their ids, the arrows that touched them to cards still here
  /// with them, at the first free place by the pointer (pasteCut: putCards(c.cards, c.links, !back, at); placeCards
  /// copy false); ⌘V again: copies, with only the arrows among them
  @Test func cutThenPastePutsTheCardsBackWithTheirArrows() async throws {
    let (r, board) = try await rig()
    defer {
      r.close()
      board.releaseGlobally()
    }
    let was = r.doc.board
    r.doc.select([.card(cid("n1")), .card(cid("m1"))])
    r.canvas.cut(nil)
    #expect(r.doc.board.card(cid("n1")) == nil && r.doc.board.card(cid("m1")) == nil)
    #expect(r.doc.board.arrows.isEmpty && r.canvas.toastText == "Cut 2 cards")
    let at = CGPoint(x: 1600, y: 200)
    r.send(r.mouse(.mouseMoved, at))
    r.canvas.paste(nil)
    let n1 = try #require(r.doc.board.card(cid("n1")))
    let m1 = try #require(r.doc.board.card(cid("m1")))
    #expect(r.canvas.toastText == "Pasted 2 cards")
    #expect(
      Set(r.doc.board.arrows.map { [$0.from.card.rawValue, $0.to.card.rawValue] }) == [["n1", "m1"], ["n2", "n1"]],
      "both arrows back")
    // their top left where the pointer is (free there), the two keeping their places to each other
    let o1 = try #require(was.card(cid("n1")))
    let o2 = try #require(was.card(cid("m1")))
    #expect(n1.x == at.x && n1.y == at.y, "\(n1.x) \(n1.y)")
    #expect(m1.x - n1.x == o2.x - o1.x && m1.y - n1.y == o2.y - o1.y)
    // again: copies with new ids, the arrow among them only
    r.canvas.paste(nil)
    #expect(r.canvas.toastText == "Pasted 2 copies")
    #expect(r.doc.board.cards.count == was.cards.count + 2 && r.doc.board.arrows.count == 3)
  }
}

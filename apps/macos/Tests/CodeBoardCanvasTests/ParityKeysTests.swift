import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// The web board's keys (packages/board/src/keymap.ts) on the real canvas, as apps/macos/review/parity-keys-menus.md
// lists them: each press goes where the window sends it (keys with ⌘ to performKeyEquivalent before the app menu, the
// rest to keyDown). The app menu's own keys are checked in CodeBoardShellTests/ParityMenuKeysTests.

private func keysBoard() -> Board {
  let seg = Segment(
    id: SegmentID(rawValue: "s1"), source: nil, language: "python", firstLine: 1,
    lines: ["def step(batch):", "    ids = batch.ids", "    return run(ids)"])
  return Board(
    id: BoardID(rawValue: "keys"),
    cards: [
      Card(
        id: cid("n1"), x: 0, y: 0, width: 240, height: 160,
        content: .own(CardContent(body: .note(Note(text: "# Plan\n\nA few words."))))),
      Card(
        id: cid("c1"), x: 400, y: 0, width: 320,
        content: .own(CardContent(title: "Step", body: .code(CodeCard(segments: [seg]))))),
      Card(
        id: cid("w1"), x: 0, y: 400, width: 420,
        content: .own(
          CardContent(
            body: .web(
              WebCard(
                url: "https://www.example.org/posts/one", meta: WebMeta(title: "One", fetchedAt: 1),
                style: .compact))))),
    ])
}

/// A key as the window delivers it: with ⌘ to performKeyEquivalent first (whether the canvas took it), else keyDown
@MainActor @discardableResult private func press(
  _ r: Rig, _ code: UInt16, _ chars: String, _ flags: NSEvent.ModifierFlags = []
) -> Bool {
  let e = NSEvent.keyEvent(
    with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0, windowNumber: r.window.windowNumber,
    context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
  if flags.contains(.command) { return r.canvas.performKeyEquivalent(with: e) }
  r.canvas.keyDown(with: e)
  return true
}

/// Whether the canvas took the key (not the rig: a failed expectation would print the whole canvas)
@MainActor private func pressed(
  _ r: Rig, _ code: UInt16, _ chars: String, _ flags: NSEvent.ModifierFlags = []
) -> Bool {
  press(r, code, chars, flags)
}

@MainActor private func flyTarget(_ r: Rig) -> Camera? {
  if case .fly(let f) = r.canvas.motion.phase { f.to } else { nil }
}

@MainActor @Suite(.serialized) struct ParityKeysTests {
  func rig() async throws -> Rig {
    let r = try await Rig(keysBoard(), zoom: 1)
    r.window.makeFirstResponder(r.canvas)
    return r
  }

  /// N, T, R: a new Note, Text, Box with its top left at the pointer (keymap.ts newNote, newText, newBox)
  @Test func nTAndRMakeANoteATextAndABoxAtThePointer() async throws {
    let r = try await rig()
    defer { r.close() }
    for (chars, code, at) in [("n", UInt16(45), CGPoint(x: 800, y: 300)), ("t", 17, CGPoint(x: 820, y: 500))] {
      let before = Set(r.doc.board.cards.map(\.id))
      r.canvas.pointerInWindow = r.at(at)
      press(r, code, chars)
      await r.until("the new card") { r.doc.board.cards.count > before.count }
      let made = try #require(r.doc.board.cards.first { !before.contains($0.id) })
      #expect(made.x == at.x && made.y == at.y)
      if chars == "n" {
        guard case .own(let c) = made.content, case .note = c.body else {
          Issue.record("N made \(made.content)")
          continue
        }
      } else {
        guard case .own(let c) = made.content, case .text(let t) = c.body, t.look == .text else {
          Issue.record("T made \(made.content)")
          continue
        }
      }
      await r.editorReady()
      await r.canvas.endEditing()
      await r.idle()
    }
    let before = Set(r.doc.board.cards.map(\.id))
    r.canvas.pointerInWindow = r.at(CGPoint(x: 900, y: 700))
    press(r, 15, "r")
    await r.until("the new card") { r.doc.board.cards.count > before.count }
    let box = try #require(r.doc.board.cards.first { !before.contains($0.id) })
    guard case .own(let c) = box.content, case .text(let t) = c.body else {
      Issue.record("R made a non-Box")
      return
    }
    #expect(t.look == .box)
    await r.editorReady()
    await r.canvas.endEditing()
  }

  /// ⇧1 and ⌘0 fit the board (Fit to Window, Fit All: at most 100 %); ⇧2 the selection (at most 140 %)
  @Test func shiftOneAndCommandZeroFitTheBoardShiftTwoTheSelection() async throws {
    let r = try await rig()
    defer { r.close() }
    let all = r.canvas.fitRect(r.canvas.scene!.bounds, maxZoom: 1)
    press(r, 18, "!", .shift)
    #expect(flyTarget(r) == all)
    r.canvas.place(zoom: 2, centre: .zero)
    #expect(pressed(r, 29, "0", .command))
    #expect(flyTarget(r) == all)
    r.canvas.place(zoom: 2, centre: .zero)
    r.doc.select([.card(cid("c1"))])
    press(r, 19, "@", .shift)
    #expect(flyTarget(r) == r.canvas.fitRect(r.rect("c1"), maxZoom: 1.4))
  }

  /// ⌘= and ⌘+ zoom in by 1.25, ⌘- out by 0.8, ⌘1 to 100 %, about the middle of the view (camera.ts zoomAt)
  @Test func commandPlusMinusAndOneZoom() async throws {
    let r = try await rig()
    defer { r.close() }
    #expect(pressed(r, 24, "=", .command))
    #expect(abs((flyTarget(r)?.zoom ?? 0) - 1.25) < 1e-9)
    #expect(pressed(r, 24, "+", [.command, .shift]))
    #expect(abs((flyTarget(r)?.zoom ?? 0) - 1.5625) < 1e-9)
    #expect(pressed(r, 27, "-", .command))
    #expect(abs((flyTarget(r)?.zoom ?? 0) - 1.25) < 1e-9)
    #expect(pressed(r, 18, "1", .command))
    #expect(abs((flyTarget(r)?.zoom ?? 0) - 1) < 1e-9)
    // the middle of the view stays where it is
    let mid = CGPoint(x: r.canvas.bounds.midX, y: r.canvas.bounds.midY)
    #expect(flyTarget(r).map { $0.board(mid) } == r.canvas.camera.board(mid))
  }

  /// ⇧⌘] and ⇧⌘[ bring the cards selected to the front and send them to the back; with none selected the keys are
  /// not the board's (the tabs take them)
  @Test func shiftCommandBracketsBringToFrontAndSendToBack() async throws {
    let r = try await rig()
    defer { r.close() }
    #expect(!pressed(r, 30, "}", [.command, .shift]))
    r.doc.select([.card(cid("n1"))])
    #expect(pressed(r, 30, "}", [.command, .shift]))
    #expect(r.doc.board.cards.last?.id == cid("n1"))
    #expect(pressed(r, 33, "{", [.command, .shift]))
    #expect(r.doc.board.cards.first?.id == cid("n1"))
  }

  /// ⌥⇧T tilts the cards selected; ⌥Z wraps a code card's lines and unwraps them
  @Test func optionShiftTTiltsOptionZWrapsLines() async throws {
    let r = try await rig()
    defer { r.close() }
    r.doc.select([.card(cid("n1"))])
    press(r, 17, "T", [.option, .shift])
    #expect(r.doc.board.card(cid("n1"))?.tilted == true)
    func wrap() -> Bool? {
      if case .own(let c)? = r.doc.board.card(cid("c1"))?.content, case .code(let k) = c.body { k.wrap } else { nil }
    }
    r.doc.select([.card(cid("c1"))])
    press(r, 6, "Ω", .option)
    #expect(wrap() == true)
    press(r, 6, "Ω", .option)
    #expect(wrap() == false)
  }

  /// Return on a Web card opens its page (keymap.ts open); on a Note it is written in
  @Test func returnOpensAWebCardsPage() async throws {
    let r = try await rig()
    defer { r.close() }
    var opened: [URL] = []
    r.canvas.openURL = { opened.append($0) }
    r.doc.select([.card(cid("w1"))])
    press(r, 36, "\r")
    #expect(opened == [URL(string: "https://www.example.org/posts/one")!])
  }

  /// ⇧⌘B with no card selected makes nothing and says so (subboards.ts turnIntoBoard)
  @Test func commandShiftBWithNoCardSelectedSaysToSelectCards() async throws {
    let r = try await rig()
    defer { r.close() }
    let cards = r.doc.board.cards
    #expect(pressed(r, 11, "b", [.command, .shift]))
    #expect(r.doc.board.cards == cards)
    #expect(r.canvas.toastText == "Select the cards to turn into a board first")
  }
}

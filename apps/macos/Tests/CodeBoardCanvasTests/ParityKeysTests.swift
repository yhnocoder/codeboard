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

  /// ? opens the shortcut list and ? or Esc closes it (keymap.ts help, BoardView.tsx Keys). Its rows are the key
  /// table's, by group, every key the board answers among them, then the app menu's keys by menu, none twice
  @Test func questionMarkOpensTheShortcutListMadeFromTheKeyTable() async throws {
    let r = try await rig()
    defer { r.close() }
    let c = r.canvas
    #expect(pressed(r, 44, "?", .shift) && c.keysPanel != nil)
    let groups = try #require(c.keysPanel?.groups)
    let rows = groups.flatMap(\.rows)
    for k in BoardKey.all { #expect(rows.contains { $0.key == k.show && $0.label == k.label }, "\(k.label) listed") }
    #expect(groups.prefix(4).map(\.name) == ["Create", "View", "Cards", "Board"])
    #expect(pressed(r, 44, "?", .shift) && c.keysPanel == nil)
    _ = pressed(r, 44, "?", .shift)
    r.key(53)
    #expect(c.keysPanel == nil)
    // the app menu's keys after the board's, by menu; a key the board lists already not again
    let menu = NSMenu()
    let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    edit.submenu = NSMenu(title: "Edit")
    edit.submenu?.addItem(NSMenuItem(title: "Undo", action: nil, keyEquivalent: "z"))
    edit.submenu?.addItem(NSMenuItem(title: "Redo", action: nil, keyEquivalent: "Z"))
    edit.submenu?.addItem(NSMenuItem(title: "Zoom to 100% again", action: nil, keyEquivalent: "1"))
    let hidden = NSMenuItem(title: "Redo", action: nil, keyEquivalent: "y")
    hidden.isHidden = true
    edit.submenu?.addItem(hidden)
    menu.addItem(edit)
    let listed = KeysPanel.rows(menu: menu)
    #expect(listed.last?.name == "Edit")
    #expect(listed.last?.rows.map(\.key) == ["⌘Z", "⇧⌘Z"] && listed.last?.rows.map(\.label) == ["Undo", "Redo"])
  }

  /// ⌥F Fit Content on cards (keymap.ts fitContent, actions/common.ts fitContent, core fitCardSizes): the card under the
  /// pointer, else the cards selected. A code card as wide as its longest line (240 to 1600), its height stored only when
  /// its code is taller than the 460 a card grows to by itself; a Note's and a Web card's height follows their content
  /// again; a Text is left as it is. One undo step
  @Test func optionFFitsTheCardUnderThePointerElseTheSelectedCardsToTheirContent() async throws {
    let long = String(repeating: "x", count: 100)
    let seg = Segment(
      id: SegmentID(rawValue: "s2"), source: nil, language: "python", firstLine: 1,
      lines: ["def f():"] + (1...39).map { "    v\($0) = \(long)" })
    var b = keysBoard()
    b.cards[0].height = 400
    b.cards.append(
      Card(
        id: cid("c2"), x: 0, y: 800, width: 300, height: 200,
        content: .own(CardContent(title: "Long", body: .code(CodeCard(segments: [seg]))))))
    b.cards.append(
      Card(id: cid("t1"), x: 900, y: 0, width: 200, content: .own(CardContent(body: .text(TextCard(text: "Hi"))))))
    let r = try await Rig(b, zoom: 1)
    defer { r.close() }
    r.window.makeFirstResponder(r.canvas)
    let c = r.canvas
    let m = c.theme.metrics
    func card(_ id: String) -> Card? { r.doc.board.card(cid(id)) }
    // under the pointer, not selected: the short code card, at the narrowest width, as tall as its code
    r.canvas.pointerInWindow = r.at(r.centre("c1"))
    r.key(3, .option)
    #expect(card("c1")?.width == 240 && card("c1")?.height == nil)
    #expect(r.doc.history.undoSteps.last?.name == "Fit Content")
    // the pointer off the board: the selection. The long code: its longest line after the line numbers; taller than
    // 460, its height kept
    r.canvas.pointerInWindow = CGPoint(x: -100, y: -100)
    r.doc.select([.card(cid("c2")), .card(cid("n1")), .card(cid("w1")), .card(cid("t1"))])
    let textBefore = card("t1")
    r.key(3, .option)
    let gutter = m.padLeft + 2 * m.charWidth + m.numberGap
    let w = (gutter + CGFloat(long.count + 10) * m.charWidth + m.padRight).rounded(.up)
    #expect(card("c2")?.width == Double(w))
    #expect(card("c2")?.height == Double(m.padTop + 40 * m.row + m.padBottom))
    #expect(card("n1")?.height == nil && card("n1")?.width == 240 && card("w1")?.height == nil)
    #expect(card("t1") == textBefore)
  }

  /// Space + drag pans (keymap.ts pan, interact.ts startPan): pressed on a card too, the board follows the pointer and
  /// glides on as two fingers' do once let go; nothing is selected, moved or recorded. With Space up a drag is the
  /// board's again
  @Test func spaceAndDragPansEvenOverACard() async throws {
    let r = try await rig()
    defer { r.close() }
    let c = r.canvas
    // view points: the camera moves under the pointer, so the board points under it change
    func drag(_ type: NSEvent.EventType, _ v: CGPoint) {
      r.send(
        NSEvent.mouseEvent(
          with: type, location: c.convert(v, to: nil), modifierFlags: [], timestamp: r.next(0.016),
          windowNumber: r.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!)
    }
    let start = c.camera.view(r.centre("n1"))
    let before = c.camera.origin
    let steps = r.doc.history.undoSteps.count
    r.key(49, up: false)
    drag(.leftMouseDown, start)
    for i in 1...8 { drag(.leftMouseDragged, CGPoint(x: start.x + 12.5 * CGFloat(i), y: start.y + 5 * CGFloat(i))) }
    #expect(abs(c.camera.origin.x - (before.x - 100)) < 1e-6 && abs(c.camera.origin.y - (before.y - 40)) < 1e-6)
    drag(.leftMouseUp, CGPoint(x: start.x + 100, y: start.y + 40))
    await r.until("the glide ends") { c.motion.isResting }
    #expect(c.camera.origin.x < before.x - 100, "it glides on")
    #expect(r.doc.selection.isEmpty && r.rect("n1").origin == .zero && r.doc.history.undoSteps.count == steps)
    // Space up: a drag on the empty board draws a marquee, the camera stays
    r.keyUp(49)
    let after = c.camera.origin
    let empty = c.camera.view(CGPoint(x: 300, y: 250))
    drag(.leftMouseDown, empty)
    drag(.leftMouseDragged, CGPoint(x: empty.x + 60, y: empty.y + 60))
    drag(.leftMouseUp, CGPoint(x: empty.x + 60, y: empty.y + 60))
    #expect(c.camera.origin == after)
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

  /// ⇧⌘] and ⇧⌘[ are the tabs' always, cards selected or not (NOT DO: main's Bring to Front / Send to Back on them):
  /// the canvas never takes them, the order stays
  @Test func shiftCommandBracketsAreAlwaysTheTabs() async throws {
    let r = try await rig()
    defer { r.close() }
    let order = r.doc.board.cards.map(\.id)
    #expect(!pressed(r, 30, "}", [.command, .shift]))
    r.doc.select([.card(cid("n1"))])
    #expect(!pressed(r, 30, "}", [.command, .shift]))
    #expect(!pressed(r, 33, "{", [.command, .shift]))
    #expect(r.doc.board.cards.map(\.id) == order)
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

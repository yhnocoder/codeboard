import AppKit
import CodeBoardModel

// The board's keys (the web board's keymap.ts KEYMAP, in its order: the first row that matches and applies takes the
// key). Keys the app menu shows (Undo, Redo, Cut, Copy, Paste, Duplicate, Select All, Lock, Back, Forward) are its items;
// these are the rest. Letters match what the key types (e.key), keys with ⌥ and digits and brackets the key itself
// (e.code), as there.

extension CanvasView {
  /// A key the board answers, with or without ⌘ / ⌃; whether it did
  func boardKey(_ e: NSEvent) -> Bool {
    guard let doc = document else { return false }
    let mods = e.modifierFlags.intersection([.command, .control, .option, .shift])
    let key = e.charactersIgnoringModifiers?.lowercased() ?? ""
    let cards = doc.selection.compactMap(\.card)
    switch (mods, e.keyCode) {
    case ([], _) where key == "n": newWriting(.note)
    case ([], _) where key == "t": newWriting(.text(.text))
    case ([], _) where key == "r": newWriting(.text(.box))
    case ([], _) where key == "s": addSidenoteFromKey()
    case (.shift, 18): fitAll()
    case (.shift, 19): fitSelection()
    case (.command, 29): fitAll()
    case (.command, 18): zoom(by: 1 / zoomTarget.zoom)
    case (.command, 24), ([.command, .shift], 24): zoom(by: 1.25)
    case (.command, 27): zoom(by: 0.8)
    case ([], 49): holdSpace(e)
    case ([], 36), ([], 76):
      // Return: an arrow alone, its label; else the first card selected opens
      if doc.selection.count == 1, let a = doc.selection.first?.arrow { editLabel(a) } else { return open(cards) }
    case (.command, 36), (.command, 76):
      guard let c = cards.first, case .board? = scene?.parts[c]?.content.body else { return false }
      openSubBoard(c)
    case ([], 51), ([], 117): delete(nil)
    case ([.command, .shift], _) where key == "b": turnIntoBoard(nil)
    case (.option, 3): fitContentKey()
    case ([.option, .shift], 17) where !cards.isEmpty: tilt(nil)
    case (.option, 1) where !doc.selection.isEmpty: moveToShelf(nil)
    case (.option, 6): toggleWrap(cards)
    case ([], 123), ([], 124), ([], 125), ([], 126), (.shift, 123), (.shift, 124), (.shift, 125), (.shift, 126):
      guard !cards.isEmpty else { return false }
      nudge(e)
    case ([], 53): escape()
    default: return false
    }
    return true
  }

  /// N, T, R: a new Note, Text or Box with its top left at the pointer (create.ts newWriting at atPointer()), in the
  /// middle of the view when the pointer is not over the board
  private func newWriting(_ kind: Board.Writing) {
    guard let p = pointerOnBoard else { return createInView(kind) }
    editSoon { await self.create(kind, at: p) }
  }

  /// The pointer on the board, while it is over the view
  var pointerOnBoard: CGPoint? {
    guard let w = pointerInWindow ?? window?.mouseLocationOutsideOfEventStream else { return nil }
    let v = convert(w, from: nil)
    return bounds.contains(v) ? camera.board(v) : nil
  }

  /// Return on a card (keymap.ts open): a Note, Text or Box is written in, a Web card's page opens, a sub-board opens
  private func open(_ cards: [CardID]) -> Bool {
    guard let c = cards.first, let doc = document else { return false }
    if isWriting(c) {
      beginEditing(c)
    } else if case .own(let k)? = doc.board.card(c)?.content, case .web(let w) = k.body {
      if let u = URL(string: w.url) { openURL(u) }
    } else if !openSubBoard(c) {
      return false
    }
    return true
  }

  /// Esc: a ref's preview, the mode, else the popup, else the selection
  private func escape() {
    if refPeek != nil { return closeRefPeek() }
    if placing != nil { return cancelPlacing() }
    if stickerPalette != nil { return closeStickerPalette() }
    if previewing != nil { return closePreview() }
    if cancelMode() { return }
    if openPop != nil { return openPop(nil) }
    if lineSel != nil { return clearLineSel() }
    if gesture == nil { document?.select([]) }
  }

  /// ⌥F (keymap.ts fitContent): the Sections selected fit what is in them
  private func fitContentKey() {
    let ids = document?.selection.compactMap(\.section) ?? []
    let fit = fittable(ids)
    if !fit.isEmpty { fitContent(fit) }
  }

  /// ⌥Z, Wrap Lines (commands/code.ts toggleWrap): the code cards selected wrap, or all stop when all do
  func toggleWrap(_ ids: [CardID]) {
    guard let doc = document else { return }
    func code(_ c: Card) -> CodeCard? {
      if case .own(let k) = c.content, case .code(let code) = k.body { code } else { nil }
    }
    let cs = Set(ids.filter { doc.board.card($0).flatMap(code) != nil })
    guard !cs.isEmpty else { return }
    let on = !cs.allSatisfy { doc.board.card($0).flatMap(code)?.wrap == true }
    doc.edit("Wrap Lines") { b in
      for i in b.cards.indices where cs.contains(b.cards[i].id) {
        guard case .own(var k) = b.cards[i].content, case .code(var c) = k.body else { continue }
        c.wrap = on
        k.body = .code(c)
        b.cards[i].content = .own(k)
      }
    }
  }

  // MARK: The camera

  /// Where the camera is going: a move under way counts as there (camera.ts camTarget)
  var zoomTarget: Camera {
    if case .fly(let f) = motion.phase { f.to } else { camera }
  }

  /// ⌘= / ⌘+, ⌘-, ⌘1: the zoom times `f` about the middle of the view, eased (camera.ts zoomAt)
  func zoom(by f: CGFloat) {
    var c = zoomTarget
    let mid = CGPoint(x: bounds.midX, y: bounds.midY)
    c.zoom(to: limits.clamp(c.zoom * f), at: mid)
    motion.fly(to: c)
    moved()
  }

  /// ⇧1, ⌘0, Fit to Window (common.ts fitAll): everything on the board in view, at most 100 %; an empty board at 100 %
  /// with its origin 80 in
  public func fitAll() {
    guard let r = scene?.bounds, !r.isNull, !r.isEmpty else {
      motion.fly(to: Camera(origin: CGPoint(x: -80, y: -80), zoom: 1))
      return moved()
    }
    motion.fly(to: fitRect(r, maxZoom: 1))
    moved()
  }

  /// ⇧2, Fit Selection (common.ts fitSelection): the cards selected in view, at most 140 %; nothing selected, all
  func fitSelection() {
    let ids = Set(document?.selection.compactMap(\.card) ?? [])
    let rs = (scene?.items ?? []).filter { if case .card(let c)? = $0.owner { ids.contains(c) } else { false } }.map(
      \.rect)
    guard let first = rs.first else { return fitAll() }
    motion.fly(to: fitRect(rs.dropFirst().reduce(first) { $0.union($1) }, maxZoom: 1.4))
    moved()
  }
}

// MARK: Space + drag (keymap.ts pan, interact.ts startPan)

extension CanvasView {
  /// Space held: a drag anywhere on the board, cards and Sections too, pans it
  func holdSpace(_ e: NSEvent) {
    guard !e.isARepeat else { return }
    spaceHeld = true
    if spacePan == nil { NSCursor.openHand.set() }
  }

  func releaseSpace() {
    spaceHeld = false
    if spacePan == nil { NSCursor.arrow.set() }
  }

  @objc func windowResignedKey() { releaseSpace() }

  /// A press with Space held starts a pan: the board follows the pointer as it does two fingers, and glides on from
  /// how fast it went when let go
  func spacePanDown(_ e: NSEvent) -> Bool {
    guard spaceHeld, document != nil else { return false }
    spacePan = convert(e.locationInWindow, from: nil)
    NSCursor.closedHand.set()
    scroll(by: .zero, at: e.timestamp, began: true, ended: false)
    return true
  }

  func spacePanDragged(_ e: NSEvent) -> Bool {
    guard let last = spacePan else { return false }
    let v = convert(e.locationInWindow, from: nil)
    spacePan = v
    scroll(by: CGVector(dx: v.x - last.x, dy: v.y - last.y), at: e.timestamp, began: false, ended: false)
    return true
  }

  func spacePanUp(_ e: NSEvent) -> Bool {
    guard spacePan != nil else { return false }
    _ = spacePanDragged(e)
    spacePan = nil
    scroll(by: .zero, at: e.timestamp, began: false, ended: true)
    (spaceHeld ? NSCursor.openHand : NSCursor.arrow).set()
    return true
  }
}

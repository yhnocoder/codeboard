import AppKit
import CodeBoardModel

// Sub-board cards on the canvas: a double-click opens the board one shows in this tab (onOpenBoard), as main's does.

extension CanvasView {
  /// The vault changed on disk (a board renamed, moved, made or changed elsewhere): sub-board cards are drawn again
  public func vaultChanged() {
    vaultSeen += 1
    refresh()
  }

  /// The board a sub-board card shows: its own, or for a subfolder's card that folder's folder board (nil when it has
  /// none)
  func subBoardTarget(_ id: CardID) -> BoardID? {
    guard let part = scene?.parts[id], case .board(let s) = part.content.body else { return nil }
    switch s.target {
    case .board(let b): return b
    case .folder(let f):
      guard let (here, vault) = shown else { return nil }
      let path = here.folder.isEmpty ? f : "\(here.folder)/\(f)"
      return (try? vault.tree())?.folder(at: path)?.folderBoard?.id
    }
  }

  /// A card of board `b` drawn in the map of a sub-board card here: that card, and the card's block in it (board
  /// points); the first such sub-board card
  func inSubBoard(_ b: BoardID, _ c: CardID) -> (frame: CardID, block: CGRect)? {
    for it in scene?.items ?? [] {
      guard case .board(let d) = it.drawing, d.board == b, let map = d.map, case .card(let id)? = it.owner,
        let r = Drawing.block(c, in: map, it.rect)
      else { continue }
      return (id, r)
    }
    return nil
  }

  /// Opens the board a sub-board card shows in this tab; whether it is one
  @discardableResult func openSubBoard(_ id: CardID) -> Bool {
    guard case .board? = scene?.parts[id]?.content.body else { return false }
    if let b = subBoardTarget(id) { onOpenBoard?(b, nil) }
    return true
  }

  // MARK: Turn into Board (⌘⇧B)

  /// ⌘⇧B, which is in no menu (as on the web board)
  public override func performKeyEquivalent(with e: NSEvent) -> Bool {
    let mods = e.modifierFlags.intersection(.deviceIndependentFlagsMask)
    if mods == [.command, .shift], e.charactersIgnoringModifiers?.lowercased() == "b", window?.firstResponder === self {
      turnIntoBoard(nil)
      return true
    }
    return super.performKeyEquivalent(with: e)
  }

  /// With cards selected: they become a new board in this board's folder and a sub-board card takes their place (core
  /// cardsToFrame); with nothing selected, a new empty board and its card in the middle of the view. Either is one undo
  /// step here, and its name is written in place over the card's head (Return keeps it, Esc and blank leave the one it
  /// was given)
  @objc public func turnIntoBoard(_ sender: Any?) {
    guard let doc = document, let (here, vault) = shown, gesture == nil, editing == nil, inPlace == nil else { return }
    let ids = Set(doc.selection.compactMap(\.card).filter { doc.board.card($0) != nil })
    let child = BoardID(rawValue: Board.newID("b"))
    let frame = CardID(rawValue: Board.newID("card-"))
    let folder = here.folder
    guard !ids.isEmpty else {
      let c = camera.board(CGPoint(x: bounds.midX, y: bounds.midY))
      let title = vault.freeName(in: folder, "New Board", package: true)
      guard let made = try? vault.newBoard(in: folder, title: title, board: Board(id: child)) else { return }
      let (w, h) = (Board.autoWidth, Double(Drawing.subHeight))
      doc.edit("New Board", selection: [.card(frame)]) {
        $0.cards.append(
          Card(
            id: frame, x: (c.x - w / 2).rounded(), y: (c.y - h / 2).rounded(), width: w, height: h,
            content: .own(CardContent(body: .board(SubBoard(board: child))))))
      }
      return nameInPlace(frame, made)
    }
    let rects = { [scene] (id: CardID) -> Rect? in
      scene?.placed[id].map { Rect(x: $0.rect.minX, y: $0.rect.minY, width: $0.rect.width, height: $0.rect.height) }
    }
    var copy = doc.board
    guard let made = copy.extract(ids, rects: rects, child: child, frame: frame) else { return }
    // named as main names it: the Section selected, else the first card's title up to its first space or bracket
    let resolver = RefResolver(doc.board, package: vault.url(of: here.path), vault: vault)
    let sec = doc.selection.compactMap(\.section).compactMap { doc.board.section($0)?.title }.first { !$0.isEmpty }
    let first = doc.board.cards.first { ids.contains($0.id) }.map(resolver.title)
    let word = first.flatMap { $0.split(whereSeparator: { $0 == " " || $0 == "(" }).first.map(String.init) }
    let title = vault.freeName(in: folder, Vault.packageName(for: sec ?? word ?? "New Board"), package: true)
    guard let at = try? vault.newBoard(in: folder, title: title, board: made) else { return }
    doc.edit("Turn into Board", selection: [.card(frame)]) {
      _ = $0.extract(ids, rects: rects, child: child, frame: frame)
    }
    nameInPlace(frame, at)
  }

  /// The name of a board just made, written over its card's head once the card is drawn
  private func nameInPlace(_ frame: CardID, _ at: VaultBoard) {
    onVaultChanged?()
    Task {
      while index(of: .card(frame)) == nil, document?.board.card(frame) != nil {
        await refreshing?.value
        await Task.yield()
      }
      guard let r = scene?.placed[frame]?.rect else { return }
      writeInPlace(
        .board(frame, at), at.title, at: CGPoint(x: r.minX + 6, y: r.minY - Drawing.subHead), select: .card(frame))
    }
  }
}

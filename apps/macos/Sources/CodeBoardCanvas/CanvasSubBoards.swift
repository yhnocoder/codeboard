import AppKit
import CodeBoardModel

// Sub-board cards on the canvas: a double-click enters the board one shows in this tab, as main's does (CanvasCrumbs).

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

  /// Whether board `b` shows this board through its sub-board cards, all the way down (core wouldCycle)
  func holdsThisBoard(_ b: BoardID) -> Bool {
    guard let (here, vault) = shown, let tree = try? vault.tree() else { return false }
    // the boards each board shows as sub-boards, read once
    let byID = Dictionary(tree.allBoards.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    var seen: Set<BoardID> = []
    func holds(_ b: BoardID) -> Bool {
      guard seen.insert(b).inserted, let vb = byID[b],
        let file = try? vault.board(at: vb.path)
      else { return false }
      return file.cards.contains { c in
        guard case .own(let k) = c.content, case .board(let s) = k.body, case .board(let t) = s.target else {
          return false
        }
        return t == here.id || holds(t)
      }
    }
    return holds(b)
  }

  /// The way down to board `b` through sub-board cards, this board's first, nine deep at most (core subboard.ts
  /// cardPath): each card and the board it shows
  func subPath(to b: BoardID) -> [SubHop]? {
    guard let (here, vault) = shown, let scene else { return nil }
    let tree = try? vault.tree()
    var seen: Set<BoardID> = [here.id]
    var level: [[SubHop]] = []
    for it in scene.items {
      guard case .card(let id)? = it.owner, let t = subBoardTarget(id), !seen.contains(t) else { continue }
      seen.insert(t)
      level.append([SubHop(frame: id, board: t)])
    }
    for _ in 0..<9 where !level.isEmpty {
      if let p = level.first(where: { $0.last?.board == b }) { return p }
      var next: [[SubHop]] = []
      for path in level {
        guard let meta = tree?.allBoards.first(where: { $0.id == path.last?.board }),
          let board = try? vault.board(at: meta.path)
        else { continue }
        let package = vault.url(of: meta.path)
        for c in board.cards + board.autoCards.map(\.card) {
          guard case .board(let sub)? = Scene.content(of: c, package: package, vault: vault)?.0.body else { continue }
          let t: BoardID? =
            switch sub.target {
            case .board(let x): x
            case .folder(let f): tree?.folder(at: meta.folder.isEmpty ? f : "\(meta.folder)/\(f)")?.folderBoard?.id
            }
          guard let t, !seen.contains(t) else { continue }
          seen.insert(t)
          next.append(path + [SubHop(frame: c.id, board: t)])
        }
      }
      level = next
    }
    return nil
  }

  /// Enters the board a sub-board card shows, in this tab (CanvasCrumbs.swift), brought to the card of its map under
  /// `p` when there is one (interact.ts data-sub); whether it is one
  @discardableResult func openSubBoard(_ id: CardID, at p: CGPoint? = nil) -> Bool {
    guard case .board? = scene?.parts[id]?.content.body else { return false }
    if !isGone(id), let b = subBoardTarget(id) { enterSubBoard(id, b, reveal: p.flatMap { mapCard(at: $0, of: id) }) }
    return true
  }

  /// The card of a sub-board card's map drawn under `p`, the topmost
  private func mapCard(at p: CGPoint, of id: CardID) -> CardID? {
    guard case .board(let d)? = scene?.parts[id]?.drawing, let map = d.map, let r = scene?.placed[id]?.rect else {
      return nil
    }
    return map.cards.last { Drawing.block($0.id, in: map, r)?.contains(p) == true }?.id
  }

  /// A sub-board card whose board or subfolder is not there now
  package func isGone(_ id: CardID) -> Bool {
    if case .board(let d)? = scene?.parts[id]?.drawing { d.gone } else { false }
  }

  /// The automatic cards here whose board or subfolder is missing: they can be deleted as any card
  var goneAutoCards: Set<CardID> {
    guard let doc = document else { return [] }
    return Set(doc.board.autoCards.map(\.card.id).filter(isGone))
  }

  // MARK: Turn into Board (⌘⇧B)

  /// The board's keys with ⌘ the app menu does not have (CanvasKeys), before the menu is asked
  public override func performKeyEquivalent(with e: NSEvent) -> Bool {
    if e.modifierFlags.contains(.command), window?.firstResponder === self, editing == nil, keysAhead == nil,
      boardKey(e)
    {
      return true
    }
    return super.performKeyEquivalent(with: e)
  }

  /// With cards selected: they become a new board in this board's folder and a sub-board card takes their place (core
  /// cardsToFrame), one undo step here, its name written in place over the card's head (Return keeps it, Esc and blank
  /// leave the one it was given); with none selected, it says to select some (subboards.ts turnIntoBoard)
  @objc public func turnIntoBoard(_ sender: Any?) {
    guard let doc = document, let (here, vault) = shown, gesture == nil, editing == nil, inPlace == nil else { return }
    let ids = Set(doc.selection.compactMap(\.card).filter { doc.board.card($0) != nil })
    let child = BoardID(rawValue: Board.newID("b"))
    let frame = CardID(rawValue: Board.newID("card-"))
    let folder = here.folder
    guard !ids.isEmpty else { return toast("Select the cards to turn into a board first") }
    let rects = { [scene] (id: CardID) -> Rect? in
      scene?.placed[id].map { Rect(x: $0.rect.minX, y: $0.rect.minY, width: $0.rect.width, height: $0.rect.height) }
    }
    var copy = doc.board
    guard let made = copy.extract(ids, rects: rects, child: child, frame: frame, auto: here.isFolderBoard) else {
      return
    }
    // named as main names it: the Section selected, else the first card's title up to its first space or bracket
    let resolver = RefResolver(doc.board, package: vault.url(of: here.path), vault: vault)
    let sec = doc.selection.compactMap(\.section).compactMap { doc.board.section($0)?.title }.first { !$0.isEmpty }
    let first = doc.board.cards.first { ids.contains($0.id) }.map(resolver.title)
    let word = first.flatMap { $0.split(whereSeparator: { $0 == " " || $0 == "(" }).first.map(String.init) }
    let title = vault.freeName(in: folder, Vault.packageName(for: sec ?? word ?? "New Board"), package: true)
    guard let at = try? vault.newBoard(in: folder, title: title, board: made) else { return }
    doc.edit("Turn into Board", selection: [.card(frame)]) {
      _ = $0.extract(ids, rects: rects, child: child, frame: frame, auto: here.isFolderBoard)
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

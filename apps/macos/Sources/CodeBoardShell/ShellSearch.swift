import AppKit
import CodeBoardCanvas
import CodeBoardModel
import CodeBoardNotes

// ⌘K and ⌘F (keymap.ts search, searchBoard; ui/Palette.tsx): the search palette over the board in front, on all boards
// or this board's. The boards open in a tab are searched as they are now, the rest as their files are. A card picked
// on this board is brought into view and selected (one on the Shelf put back first); one on another board opens that
// board in the tab, at the card. Esc or a click outside closes it, the camera where it was.

extension BoardPanes {
  /// One palette for the app
  @MainActor static let search = SearchPanel()

  /// The View menu's Search… (⌘K) and the toolbar's Search
  @objc func searchBoards(_ sender: Any?) { openSearch(thisBoard: false) }
  /// The View menu's Search This Board… (⌘F)
  @objc func searchThisBoard(_ sender: Any?) { openSearch(thisBoard: true) }

  /// The pane in front, with its board
  private var frontPane: Pane? {
    shell.selected.flatMap { panes[$0] }.flatMap { $0.document == nil ? nil : $0 }
  }

  func openSearch(thisBoard: Bool) {
    let s = Self.search
    guard !s.isOpen, let pane = frontPane, let here = pane.document?.id, let vault = shell.vault else { return }
    let tree = shell.tree?.allBoards ?? []
    // the open boards as they are now; the others' files read off the main thread
    let live = tree.compactMap { b in documents[b.id].map { (b, $0.board) } }
    let unread = tree.filter { documents[$0.id] == nil }
    let sources = Task.detached { () -> [BoardSearch.Source] in
      var read: [BoardID: Board] = [:]
      for b in unread {
        read[b.id] = (try? vault.board(at: b.path))?.inflated { try? vault.sharedCard($0) }
      }
      let now = Dictionary(live.map { ($0.0.id, $0.1) }, uniquingKeysWith: { a, _ in a })
      return tree.compactMap { b in
        (now[b.id] ?? read[b.id]).map {
          BoardSearch.Source(
            id: b.id, name: b.title, board: $0, images: vault.url(of: b.path).appending(path: Vault.imagesFolder))
        }
      }
    }
    s.onSearch = { q, thisBoard in
      BoardSearch.search(q, in: await sources.value, here: here, thisBoard: thisBoard)
    }
    s.onPick = { [weak self] in self?.picked($0) }
    s.onClose = { [weak self] in self?.closeSearch() }
    s.view.frame = pane.bounds
    s.view.autoresizingMask = [.width, .height]
    if s.view.superview !== pane { pane.addSubview(s.view) }
    let look = shell.look
    Task { await s.show(.init(look: look.id.rawValue, dark: look.dark, here: thisBoard)) }
  }

  /// Closes it, the keys back on the board
  func closeSearch() {
    let s = Self.search
    // open over this window's boards, not another's
    guard s.isOpen, s.view.isDescendant(of: self) else { return }
    let had = window?.firstResponder === s.view
    s.close()
    if had, let pane = frontPane { window?.makeFirstResponder(pane.canvas) }
  }

  private func picked(_ p: SearchPanel.Pick) {
    closeSearch()
    guard let pane = frontPane else { return }
    guard p.board == pane.document?.id else {
      // the canvas's way to another board: it opens in this tab, then goes to the card
      pane.canvas.onOpenBoard?(p.board, .card(p.card))
      return
    }
    if let entry = p.shelf {
      pane.canvas.putBack(entry)
      pane.document?.select([.card(p.card)])
    } else {
      pane.canvas.arrive(at: p.card)
    }
  }
}

import AppKit
import CodeBoardModel

// Sub-board cards on the canvas: a double-click opens the board one shows in this tab (onOpenBoard), as main's does.

extension CanvasView {
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

  /// Opens the board a sub-board card shows in this tab; whether it is one
  @discardableResult func openSubBoard(_ id: CardID) -> Bool {
    guard case .board? = scene?.parts[id]?.content.body else { return false }
    if let b = subBoardTarget(id) { onOpenBoard?(b, nil) }
    return true
  }
}

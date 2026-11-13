import AppKit
import CodeBoardModel

/// What a sidebar row drags: a board package's or a folder's path in the vault, as a string
public enum VaultDrag {
  public static let prefix = "codeboard-vault-item:"
  public static func payload(_ path: String) -> String { prefix + path }
  public static func path(_ s: String) -> String? { s.hasPrefix(prefix) ? String(s.dropFirst(prefix.count)) : nil }
}

// A board or folder dragged from the sidebar onto an open folder board goes into that folder, its card where it was let
// go (`onVaultDrop`: the path and the board point of the card's middle)
extension CanvasView {
  private func vaultPath(_ info: NSDraggingInfo) -> String? {
    guard let (vb, _) = shown, vb.isFolderBoard,
      let s = info.draggingPasteboard.string(forType: .string), let path = VaultDrag.path(s),
      path != vb.folder, !vb.folder.hasPrefix(path + "/"),
      path.split(separator: "/").dropLast().joined(separator: "/") != vb.folder
    else { return nil }
    return path
  }

  public override func draggingEntered(_ info: NSDraggingInfo) -> NSDragOperation {
    vaultPath(info) == nil ? [] : .move
  }

  public override func draggingUpdated(_ info: NSDraggingInfo) -> NSDragOperation {
    vaultPath(info) == nil ? [] : .move
  }

  public override func performDragOperation(_ info: NSDraggingInfo) -> Bool {
    guard let path = vaultPath(info) else { return false }
    onVaultDrop?(path, camera.board(convert(info.draggingLocation, from: nil)))
    return true
  }
}

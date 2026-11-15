import AppKit
import CodeBoardModel

/// What a sidebar row drags: a board package's or a folder's path in the vault, as a string
public enum VaultDrag {
  public static let prefix = "codeboard-vault-item:"
  public static func payload(_ path: String) -> String { prefix + path }
  public static func path(_ s: String) -> String? { s.hasPrefix(prefix) ? String(s.dropFirst(prefix.count)) : nil }
}

// A board or folder dragged from the sidebar onto an open folder board goes into that folder, its card where it was let
// go (`onVaultDrop`: the path and the board point of the card's middle). Files dragged in from Finder become image
// cards where they are let go (create.ts dropFiles)
extension CanvasView {
  private func files(_ info: NSDraggingInfo) -> [URL] {
    info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
      ?? []
  }

  private func vaultPath(_ info: NSDraggingInfo) -> String? {
    guard let (vb, _) = shown, vb.isFolderBoard,
      let s = info.draggingPasteboard.string(forType: .string), let path = VaultDrag.path(s),
      path != vb.folder, !vb.folder.hasPrefix(path + "/"),
      path.split(separator: "/").dropLast().joined(separator: "/") != vb.folder
    else { return nil }
    return path
  }

  public override func draggingEntered(_ info: NSDraggingInfo) -> NSDragOperation { dropOperation(info) }

  public override func draggingUpdated(_ info: NSDraggingInfo) -> NSDragOperation { dropOperation(info) }

  private func dropOperation(_ info: NSDraggingInfo) -> NSDragOperation {
    vaultPath(info) != nil ? .move : document != nil && !files(info).isEmpty ? .copy : []
  }

  public override func performDragOperation(_ info: NSDraggingInfo) -> Bool {
    let at = camera.board(convert(info.draggingLocation, from: nil))
    if let path = vaultPath(info) {
      onVaultDrop?(path, at)
      return true
    }
    let urls = files(info)
    guard document != nil, !urls.isEmpty else { return false }
    addPictureFiles(urls, at: at)
    return true
  }
}

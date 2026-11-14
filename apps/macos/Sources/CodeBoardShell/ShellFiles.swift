import AppKit
import CodeBoardModel

// The sidebar's changes to the vault's files (VaultFiles.swift does each one): what open boards have not written yet is
// written first, then the one rename or new name, then the tree is read again at once, so tabs and documents follow
// (they hold boards by id) and expanded folders keep their state under their new path. Nothing is ever written over;
// deleting moves to the system Trash.

extension Shell {
  /// A menu item; nil: a separator
  public typealias MenuEntry = (title: String, run: () -> Void)?

  /// A folder's row menu
  public func menu(folder: VaultFolder) -> [MenuEntry] {
    var m: [MenuEntry] = [
      ("New Board", { self.newBoard(in: folder.path) }), ("New Folder", { self.newFolder(in: folder.path) }), nil,
      ("Rename", { self.renaming = .folder(folder.path) }), nil,
    ]
    if let own = folder.folderBoard { m.append(("Delete Folder Board", { self.trash(own.path) })) }
    m.append(("Delete Folder", { self.trash(folder.path) }))
    return m
  }

  /// A board's row menu
  public func menu(board: VaultBoard) -> [MenuEntry] {
    [
      ("Rename", { self.renaming = .board(board.id) }), ("Edit Mark…", { self.sealEditing = board.id }), nil,
      ("Delete", { self.trash(board.path) }),
    ]
  }

  /// What `hoveredRow` names
  public static func rowKey(folder path: String) -> String { "folder:" + path }
  public static func rowKey(board id: BoardID) -> String { "board:" + id.rawValue }

  /// Runs a change to the vault's files; whether it went through (a name taken: nothing changed, a beep)
  @discardableResult
  func files(_ change: (Vault) throws -> Void) -> Bool {
    guard let vault else { return false }
    beforeFiles?()
    var ok = true
    fileError = nil
    do { try change(vault) } catch {
      ok = false
      fileError = String(describing: error)
      NSSound.beep()
    }
    apply(Result { try vault.tree() })
    afterFiles?()
    return ok
  }

  /// A new empty board in `folder`, shown, its name written in place
  public func newBoard(in folder: String) {
    var made: VaultBoard?
    files { v in made = try v.newBoard(in: folder, title: v.freeName(in: folder, "New Board", package: true)) }
    guard let made else { return }
    if !folder.isEmpty { expanded.insert(folder) }
    show(made.id)
    renaming = .board(made.id)
  }

  /// A new folder in `folder`, its name written in place
  public func newFolder(in folder: String) {
    var path: String?
    files { v in path = try v.newFolder(in: folder, name: v.freeName(in: folder, "New Folder", package: false)) }
    guard let path else { return }
    if !folder.isEmpty { expanded.insert(folder) }
    renaming = .folder(path)
  }

  /// The folder's own board, made and shown
  public func newFolderBoard(in folder: String) {
    var made: VaultBoard?
    files { v in made = try v.newFolderBoard(in: folder) }
    if let made { show(made.id) }
  }

  public func rename(board: VaultBoard, to title: String) {
    let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, t != board.title else { return }
    files { v in try v.rename(board: board, to: t) }
  }

  public func rename(folder path: String, to name: String) {
    let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !n.isEmpty, n != path.split(separator: "/").last.map(String.init) else { return }
    var to: String?
    files { v in
      to = try v.rename(folder: path, to: n)
      let parts = path.split(separator: "/").map(String.init)
      folderRenamed?(parts.dropLast().joined(separator: "/"), parts.last ?? "", n)
    }
    if let to { follow(path, to) }
  }

  /// A board package or a folder moved into `folder` (the vault itself: ""); its new path
  @discardableResult
  public func move(_ path: String, into folder: String) -> String? {
    var to: String?
    files { v in to = try v.move(path, into: folder) }
    if let to {
      follow(path, to)
      if !folder.isEmpty { expanded.insert(folder) }
    }
    return to
  }

  /// To the trash (`trasher`: the system Trash in the app); nothing changes when it cannot go there (a beep)
  @discardableResult
  public func trash(_ path: String) -> Bool {
    let ok = files { v in try v.trash(path, with: trasher) }
    guard ok else { return false }
    expanded = expanded.filter { $0 != path && !$0.hasPrefix(path + "/") }
    return true
  }

  /// Expanded folders at or under a folder that moved keep their state at their new paths
  private func follow(_ from: String, _ to: String) {
    expanded = Set(
      expanded.map { p in
        p == from ? to : p.hasPrefix(from + "/") ? to + p.dropFirst(from.count) : p
      })
  }
}

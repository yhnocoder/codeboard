import Foundation

// Changes to the vault's files from the app (the sidebar): boards and folders made, renamed, moved and deleted. Each is
// one rename or one new name in the file system (a package is built under a hidden name first, then renamed into place
// whole); nothing is ever written over (`renamex_np` with RENAME_EXCL); deleting moves to the system Trash, never removes.
// Boards refer to each other by id, so a board renamed or moved keeps every ref and sub-board card to it.

extension Vault {
  /// A name nothing in `folder` has (as APFS compares names: without case, normalised): `base`, else `base 2`, `base 3`…
  /// `package`: for a board (its package name, `.board` added)
  public func freeName(in folder: String, _ base: String, package: Bool) -> String {
    let names = Set(
      ((try? FileManager.default.contentsOfDirectory(atPath: url(of: folder).path)) ?? []).map(Vault.fold))
    let ext = package ? ".\(Vault.packageExtension)" : ""
    var n = 1
    while true {
      let name = n == 1 ? base : "\(base) \(n)"
      if !names.contains(Vault.fold(name + ext)) { return name }
      n += 1
    }
  }

  private static func fold(_ s: String) -> String { s.precomposedStringWithCanonicalMapping.lowercased() }

  /// A new board package `<title>.board` in `folder` with `board` in it (a new empty one when nil)
  @discardableResult
  public func newBoard(in folder: String, title: String, board: Board? = nil) throws -> VaultBoard {
    let name = Vault.packageName(for: title)
    let b = board ?? Board(id: BoardID(rawValue: Board.newID("b")))
    let path = Vault.join(folder, "\(name).\(Vault.packageExtension)")
    try writePackage(b, at: path)
    return VaultBoard(id: b.id, title: name, path: path)
  }

  /// A folder's own board, `.folder.board` in it, empty (its automatic cards come when it opens)
  @discardableResult
  public func newFolderBoard(in folder: String) throws -> VaultBoard {
    let b = Board(id: BoardID(rawValue: Board.newID("b")))
    let path = Vault.join(folder, Vault.folderBoardName)
    try writePackage(b, at: path)
    let name = folder.split(separator: "/").last.map(String.init) ?? ""
    return VaultBoard(id: b.id, title: name, path: path, isFolderBoard: true)
  }

  /// A new folder `name` in `folder`; its path
  @discardableResult
  public func newFolder(in folder: String, name: String) throws -> String {
    let path = Vault.join(folder, Vault.folderName(for: name))
    let to = url(of: path)
    do {
      try FileManager.default.createDirectory(at: to, withIntermediateDirectories: false)
    } catch CocoaError.fileWriteFileExists {
      throw VaultError.exists(to)
    } catch {
      throw VaultError.unwritable(to, error.localizedDescription)
    }
    return path
  }

  /// A board package renamed (its title is its name); its new path
  @discardableResult
  public func rename(board: VaultBoard, to title: String) throws -> String {
    precondition(!board.isFolderBoard, "a folder board is renamed with its folder")
    let path = Vault.join(board.folder, "\(Vault.packageName(for: title)).\(Vault.packageExtension)")
    try move(board.path, to: path)
    return path
  }

  /// A folder renamed (its folder board's title with it); its new path
  @discardableResult
  public func rename(folder: String, to name: String) throws -> String {
    let parent = folder.split(separator: "/").dropLast().joined(separator: "/")
    let path = Vault.join(parent, Vault.folderName(for: name))
    try move(folder, to: path)
    return path
  }

  /// A board package or a folder moved into `folder`, its name kept; its new path
  @discardableResult
  public func move(_ path: String, into folder: String) throws -> String {
    guard folder != path, !folder.hasPrefix(path + "/") else {
      throw VaultError.unwritable(url(of: folder), "a folder cannot go into itself")
    }
    let name = path.split(separator: "/").last.map(String.init) ?? path
    let to = Vault.join(folder, name)
    if to != path { try move(path, to: to) }
    return to
  }

  /// Moves a file or folder to a trash and says where it went; the app's is the system Trash (`systemTrash`), tests give
  /// one of their own
  public typealias Trasher = @Sendable (URL) throws -> URL?

  /// The system Trash, where Finder can put it back
  public static let systemTrash: Trasher = { url in
    var out: NSURL?
    try FileManager.default.trashItem(at: url, resultingItemURL: &out)
    return out as URL?
  }

  /// A board package or a folder (with all in it) to the trash, never removed outright; only something in the vault, not
  /// the vault itself. Where it went
  @discardableResult
  public func trash(_ path: String, with trasher: Trasher = Vault.systemTrash) throws -> URL? {
    let at = url(of: path)
    guard !path.isEmpty, !path.hasPrefix("/"), let p = self.path(of: at), !p.isEmpty else {
      throw VaultError.unwritable(at, "only something in the vault goes to the Trash")
    }
    guard FileManager.default.fileExists(atPath: at.path) else { throw VaultError.unwritable(at, "it is not there") }
    do {
      return try trasher(at)
    } catch {
      throw VaultError.unwritable(at, error.localizedDescription)
    }
  }

  // MARK: The file system

  /// One rename, never over anything; a change of case alone goes through a hidden name (APFS takes the two for the
  /// same name)
  private func move(_ from: String, to: String) throws {
    let a = url(of: from)
    let b = url(of: to)
    if Vault.fold(from) == Vault.fold(to) && from != to {
      let hidden = Vault.join(
        from.split(separator: "/").dropLast().joined(separator: "/"), ".rename-\(UUID().uuidString)")
      try Vault.rename(a, to: url(of: hidden))
      do { try Vault.rename(url(of: hidden), to: b) } catch {
        try? Vault.rename(url(of: hidden), to: a)
        throw error
      }
      return
    }
    try Vault.rename(a, to: b)
  }

  static func rename(_ from: URL, to: URL) throws {
    guard renamex_np(from.path, to.path, UInt32(RENAME_EXCL)) == 0 else {
      if errno == EEXIST { throw VaultError.exists(to) }
      throw VaultError.unwritable(to, String(cString: strerror(errno)))
    }
  }

  /// A package built under a hidden name beside where it goes, then renamed there whole
  private func writePackage(_ b: Board, at path: String) throws {
    let to = url(of: path)
    let parent = to.deletingLastPathComponent()
    let hidden = parent.appending(path: ".\(to.lastPathComponent).new-\(UUID().uuidString)")
    do {
      try FileManager.default.createDirectory(at: hidden, withIntermediateDirectories: false)
      try b.encoded().write(to: hidden.appending(path: Vault.boardFileName))
    } catch {
      try? FileManager.default.removeItem(at: hidden)
      throw VaultError.unwritable(to, error.localizedDescription)
    }
    do { try Vault.rename(hidden, to: to) } catch {
      try? FileManager.default.removeItem(at: hidden)
      throw error
    }
  }

  static func join(_ folder: String, _ name: String) -> String { folder.isEmpty ? name : "\(folder)/\(name)" }

  /// A folder name for what was typed, as a package's is made (`packageName(for:)`), and never ending in `.board`
  public static func folderName(for name: String) -> String {
    var n = packageName(for: name)
    while n.lowercased().hasSuffix(".\(packageExtension)") { n.removeLast(packageExtension.count + 1) }
    n = n.trimmingCharacters(in: .whitespaces)
    return n.isEmpty ? "Untitled" : n
  }
}

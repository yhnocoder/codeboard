import Foundation

/// A vault is a folder whose folder tree is the sidebar's: real folders, nested, and board packages `<title>.board/`.
public struct Vault: Sendable {
  /// The app's own data at the vault root (shared cards); hidden, so never listed as a folder
  public static let appDataFolder = ".codeboard"
  public static let packageExtension = "board"
  public static let boardFileName = "board.json"
  public static let imagesFolder = "images"
  /// In the app-data folder: `<card id>.json`, and their images in its own images folder
  public static let sharedFolder = "shared"
  /// A folder's own board, hidden in it: its title is always the folder's name
  public static let folderBoardName = ".folder.board"

  public let root: URL

  public init(root: URL) {
    self.root = root
  }

  public var sharedFolderURL: URL {
    root.appending(path: Vault.appDataFolder).appending(path: Vault.sharedFolder)
  }

  /// A path relative to the vault, "/" between folders ("" is the vault itself)
  public func url(of path: String) -> URL {
    path.isEmpty ? root : root.appending(path: path)
  }

  /// The whole tree; reads each board's id, not its content. A board of another format version is listed too, and opening
  /// it says why it cannot be read
  public func tree() throws -> VaultFolder {
    try folder(at: "", name: root.lastPathComponent)
  }

  /// The board in the package at `path`
  public func board(at path: String) throws -> Board {
    let file = url(of: path).appending(path: Vault.boardFileName)
    return try Board(decoding: read(file), file: file)
  }

  public func sharedCard(_ id: CardID) throws -> SharedCard {
    guard Vault.isSafeID(id.rawValue) else { throw VaultError.badSharedCardID(id.rawValue) }
    let file = sharedFolderURL.appending(path: "\(id.rawValue).json")
    let card = try SharedCard(decoding: read(file), file: file)
    guard card.id == id else { throw VaultError.malformed(file, "its id is \(card.id.rawValue), not its file name") }
    return card
  }

  /// The package folder name (without `.board`) for a title: characters that cannot be in a file name on macOS, or that
  /// break a clone of the vault on Windows, become "-"; leading dots go (they would hide the board), and the name is cut to
  /// leave room for a " 2" and the extension in the 255 bytes a name may have
  public static func packageName(for title: String) -> String {
    var name = String(
      title.precomposedStringWithCanonicalMapping.unicodeScalars.compactMap { s -> Character? in
        if s.properties.generalCategory == .control { return nil }
        return "/\\:*?\"<>|".unicodeScalars.contains(s) ? "-" : Character(s)
      })
    name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    while name.hasPrefix(".") { name.removeFirst() }
    while name.utf8.count > 200 { name.removeLast() }
    while name.hasSuffix(".") || name.hasSuffix(" ") { name.removeLast() }
    return name.isEmpty ? "Untitled" : name
  }

  /// A file in an images folder: no folders, not hidden
  static func isFileName(_ name: String) -> Bool {
    name.wholeMatch(of: /[A-Za-z0-9_-][A-Za-z0-9_.-]*/) != nil
  }

  /// What may name a shared card's file; the old host held board ids to the same rule
  static func isSafeID(_ id: String) -> Bool {
    id.wholeMatch(of: /[A-Za-z0-9_-]{1,80}/) != nil
  }

  private func folder(at path: String, name: String) throws -> VaultFolder {
    let dir = url(of: path)
    let names: [String]
    do {
      names = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { !$0.hasPrefix(".") }
    } catch {
      throw VaultError.unreadable(dir, error.localizedDescription)
    }
    var out = VaultFolder(name: name, path: path, folders: [], boards: [])
    // the vault itself has none
    if !path.isEmpty {
      let own = dir.appending(path: Vault.folderBoardName)
      var isDir: ObjCBool = false
      if FileManager.default.fileExists(atPath: own.path, isDirectory: &isDir), isDir.boolValue {
        let child = "\(path)/\(Vault.folderBoardName)"
        out.folderBoard = VaultBoard(
          id: try boardID(in: own.appending(path: Vault.boardFileName)), title: name, path: child, isFolderBoard: true)
      }
    }
    for name in names.sorted(by: { $0.localizedStandardCompare($1) == .orderedAscending }) {
      let entry = dir.appending(path: name)
      var isDir: ObjCBool = false
      guard FileManager.default.fileExists(atPath: entry.path, isDirectory: &isDir), isDir.boolValue else { continue }
      let child = path.isEmpty ? entry.lastPathComponent : "\(path)/\(entry.lastPathComponent)"
      if entry.pathExtension == Vault.packageExtension {
        let file = entry.appending(path: Vault.boardFileName)
        let title = entry.deletingPathExtension().lastPathComponent
        out.boards.append(VaultBoard(id: try boardID(in: file), title: title, path: child))
      } else {
        out.folders.append(try folder(at: child, name: entry.lastPathComponent))
      }
    }
    return out
  }

  private func boardID(in file: URL) throws -> BoardID {
    struct Head: Decodable {
      var id: BoardID
    }
    let head: Head
    do {
      head = try JSONDecoder().decode(Head.self, from: read(file))
    } catch let e as VaultError {
      throw e
    } catch {
      throw VaultError.malformed(file, "no board id")
    }
    return head.id
  }

  private func read(_ file: URL) throws -> Data {
    do {
      return try Data(contentsOf: file)
    } catch {
      throw VaultError.unreadable(file, error.localizedDescription)
    }
  }
}

public struct VaultFolder: Equatable, Sendable {
  public var name: String
  /// Relative to the vault; "" for the vault itself
  public var path: String
  public var folders: [VaultFolder]
  public var boards: [VaultBoard]
  /// Its own board (`.folder.board` in it), titled with its name
  public var folderBoard: VaultBoard?

  public init(
    name: String, path: String, folders: [VaultFolder], boards: [VaultBoard], folderBoard: VaultBoard? = nil
  ) {
    self.name = name
    self.path = path
    self.folders = folders
    self.boards = boards
    self.folderBoard = folderBoard
  }

  /// Every board in this folder and below, folder boards too
  public var allBoards: [VaultBoard] { (folderBoard.map { [$0] } ?? []) + boards + folders.flatMap(\.allBoards) }

  /// Every folder in it and below, itself first
  public var allFolders: [VaultFolder] { [self] + folders.flatMap(\.allFolders) }

  /// The folder at a path in it
  public func folder(at path: String) -> VaultFolder? { allFolders.first { $0.path == path } }

  /// What is directly in it, in sidebar order: its boards, then its subfolders (what its folder board has a card for)
  public var entries: [FolderEntry] { boards.map { .board($0.id) } + folders.map { .folder($0.name) } }
}

/// A board or a subfolder directly in a folder
public enum FolderEntry: Hashable, Sendable {
  case board(BoardID)
  case folder(String)
}

public struct VaultBoard: Equatable, Sendable {
  public var id: BoardID
  /// The package's name without `.board`
  public var title: String
  /// Of the package, relative to the vault
  public var path: String
  /// A folder's own board: its title is its folder's name
  public var isFolderBoard: Bool

  public init(id: BoardID, title: String, path: String, isFolderBoard: Bool = false) {
    self.id = id
    self.title = title
    self.path = path
    self.isFolderBoard = isFolderBoard
  }

  /// The folder it is in, relative to the vault ("" for the vault itself); a folder board's is the folder it is of
  public var folder: String {
    path.split(separator: "/").dropLast().joined(separator: "/")
  }
}

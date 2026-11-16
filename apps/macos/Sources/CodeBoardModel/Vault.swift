import Foundation

/// A vault is a folder whose folder tree is the sidebar's: real folders, nested, board packages `<title>.board/` and
/// resource packages `<title>.resource/`.
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
  public static let resourceExtension = "resource"
  public static let resourceFileName = "resource.json"
  /// In an entry's folder in a resource package
  public static let entryFileName = "entry.json"

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

  /// A URL in the vault as a path relative to it; nil outside it
  public func path(of url: URL) -> String? {
    let r = root.standardizedFileURL.path
    let u = url.standardizedFileURL.path
    if u == r { return "" }
    return u.hasPrefix(r + "/") ? String(u.dropFirst(r.count + 1)) : nil
  }

  /// The whole tree; reads each board's id, not its content, and each resource's id and preset, counting its entries
  /// without reading them. A board or resource of another format version is listed too, and opening it says why it
  /// cannot be read
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

  /// Whether a shared card of that id is there: what `Board.share` must not take (an unsafe id counts as taken)
  public func sharedCardExists(_ id: CardID) -> Bool {
    !Vault.isSafeID(id.rawValue)
      || FileManager.default.fileExists(atPath: sharedFolderURL.appending(path: "\(id.rawValue).json").path)
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
  package static func isFileName(_ name: String) -> Bool {
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
        // one that cannot be read: the folder is shown without it
        if let (id, seal) = try? boardHead(in: own.appending(path: Vault.boardFileName)) {
          out.folderBoard = VaultBoard(id: id, title: name, path: child, isFolderBoard: true, seal: seal)
        }
      }
    }
    // by the names shown, a package's without `.board` or `.resource` ("Plan" before "Plan copy"), as Finder lists them
    func shown(_ n: String) -> String {
      let ext = (n as NSString).pathExtension
      return [Vault.packageExtension, Vault.resourceExtension].contains(ext) ? String(n.dropLast(ext.count + 1)) : n
    }
    for name in names.sorted(by: { shown($0).localizedStandardCompare(shown($1)) == .orderedAscending }) {
      let entry = dir.appending(path: name)
      var isDir: ObjCBool = false
      guard FileManager.default.fileExists(atPath: entry.path, isDirectory: &isDir), isDir.boolValue else { continue }
      let child = path.isEmpty ? entry.lastPathComponent : "\(path)/\(entry.lastPathComponent)"
      if entry.pathExtension == Vault.packageExtension {
        let file = entry.appending(path: Vault.boardFileName)
        let title = entry.deletingPathExtension().lastPathComponent
        // one that cannot be read is listed as such, and the rest reads as ever (sidebar.ts "Can't open")
        do {
          let (id, seal) = try boardHead(in: file)
          out.boards.append(VaultBoard(id: id, title: title, path: child, seal: seal))
        } catch {
          out.unreadable.append(VaultUnreadable(title: title, path: child, reason: "\(error)"))
        }
      } else if entry.pathExtension == Vault.resourceExtension {
        let title = entry.deletingPathExtension().lastPathComponent
        do {
          let (id, preset) = try resourceHead(in: entry.appending(path: Vault.resourceFileName))
          out.resources.append(
            VaultResource(id: id, title: title, path: child, preset: preset, entryCount: try entryCount(in: entry)))
        } catch {
          out.unreadableResources.append(VaultUnreadable(title: title, path: child, reason: "\(error)"))
        }
      } else {
        out.folders.append(try folder(at: child, name: entry.lastPathComponent))
      }
    }
    return out
  }

  /// A board's id and its seal, the two the tree needs from its file
  private func boardHead(in file: URL) throws -> (BoardID, Seal?) {
    struct Head: Decodable {
      var id: BoardID
      var seal: Seal?
    }
    let head: Head
    do {
      head = try JSONDecoder().decode(Head.self, from: read(file))
    } catch let e as VaultError {
      throw e
    } catch {
      throw VaultError.malformed(file, "no board id")
    }
    return (head.id, head.seal)
  }

  /// A resource's id and preset, all the tree reads of its file
  private func resourceHead(in file: URL) throws -> (ResourceID, ResourcePreset) {
    struct Head: Decodable {
      var id: ResourceID
      var preset: ResourcePreset
    }
    let head: Head
    do {
      head = try JSONDecoder().decode(Head.self, from: read(file))
    } catch let e as VaultError {
      throw e
    } catch {
      throw VaultError.malformed(file, "no resource id and preset")
    }
    return (head.id, head.preset)
  }

  /// A resource's entries, none of them read: its folders with an entry file, and its files (each an entry of its own)
  private func entryCount(in package: URL) throws -> Int {
    let names: [String]
    do {
      names = try FileManager.default.contentsOfDirectory(atPath: package.path)
    } catch {
      throw VaultError.unreadable(package, error.localizedDescription)
    }
    return names.filter { name in
      guard !name.hasPrefix("."), name != Vault.resourceFileName else { return false }
      let at = package.appending(path: name)
      var isDir: ObjCBool = false
      guard FileManager.default.fileExists(atPath: at.path, isDirectory: &isDir) else { return false }
      return !isDir.boolValue || FileManager.default.fileExists(atPath: at.appending(path: Vault.entryFileName).path)
    }.count
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
  /// Its board packages whose file cannot be read, in the same order
  public var unreadable: [VaultUnreadable] = []
  /// Its resource packages, by title
  public var resources: [VaultResource] = []
  /// Its resource packages whose file cannot be read, in the same order
  public var unreadableResources: [VaultUnreadable] = []

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

  /// How many board packages are in it and below, folder boards and those that cannot be read too
  public var boardCount: Int { allBoards.count + allFolders.reduce(0) { $0 + $1.unreadable.count } }

  /// Every folder in it and below, itself first
  public var allFolders: [VaultFolder] { [self] + folders.flatMap(\.allFolders) }

  /// The folder at a path in it
  public func folder(at path: String) -> VaultFolder? { allFolders.first { $0.path == path } }

  /// The book a board is in (in the vault's tree): the folder board of the top-level folder it is in, when that folder
  /// has one; else the board itself (a top-level board, or one in a top-level folder without a folder board)
  public func book(of id: BoardID) -> VaultBoard? {
    guard let b = allBoards.first(where: { $0.id == id }) else { return nil }
    guard let top = b.path.split(separator: "/").first, b.path.contains("/"),
      let f = folders.first(where: { $0.name == top }), let fb = f.folderBoard
    else { return b }
    return fb
  }

  /// Another board in the same book drawn with this seal (the first, in tree order)
  public func sealClash(_ id: BoardID, _ text: String, _ color: Seal.Color) -> VaultBoard? {
    guard let book = book(of: id)?.id else { return nil }
    return allBoards.first { b in
      b.id != id && book == self.book(of: b.id)?.id && b.drawnSeal.text == text && b.drawnSeal.color == color
    }
  }

  /// What is directly in it, in sidebar order: its boards, then its subfolders (what its folder board has a card for)
  public var entries: [FolderEntry] { boards.map { .board($0.id) } + folders.map { .folder($0.name) } }
}

/// A board or a subfolder directly in a folder
public enum FolderEntry: Hashable, Sendable {
  case board(BoardID)
  case folder(String)
}

/// What a resource's list starts with (its columns and actions); it does not limit what an entry may be
public enum ResourcePreset: String, Codable, Sendable {
  /// `images`: a grid of pictures; `blank`: nothing but the title and the columns the user adds
  case papers, web, files, images, blank
}

/// A resource package as the tree lists it, its entries not read
public struct VaultResource: Equatable, Sendable {
  public var id: ResourceID
  /// The package's name without `.resource`
  public var title: String
  /// Of the package, relative to the vault
  public var path: String
  public var preset: ResourcePreset
  /// Its entries: folders with an entry file, and files that are entries alone
  public var entryCount: Int

  public init(id: ResourceID, title: String, path: String, preset: ResourcePreset, entryCount: Int) {
    self.id = id
    self.title = title
    self.path = path
    self.preset = preset
    self.entryCount = entryCount
  }

  /// The folder it is in, relative to the vault ("" for the vault itself)
  public var folder: String {
    path.split(separator: "/").dropLast().joined(separator: "/")
  }
}

/// A board (or resource) package whose file cannot be read: what the sidebar lists instead of it
public struct VaultUnreadable: Equatable, Sendable {
  public var title: String
  public var path: String
  public var reason: String
}

public struct VaultBoard: Equatable, Sendable {
  public var id: BoardID
  /// The package's name without `.board`
  public var title: String
  /// Of the package, relative to the vault
  public var path: String
  /// A folder's own board: its title is its folder's name
  public var isFolderBoard: Bool
  /// Its seal as the user set it (`Seal.of` gives what is drawn)
  public var seal: Seal?

  public init(id: BoardID, title: String, path: String, isFolderBoard: Bool = false, seal: Seal? = nil) {
    self.id = id
    self.title = title
    self.path = path
    self.isFolderBoard = isFolderBoard
    self.seal = seal
  }

  /// Its seal as drawn: its own, else the default from its title and id
  public var drawnSeal: (text: String, color: Seal.Color) { Seal.of(id: id, name: title, seal: seal) }

  /// The folder it is in, relative to the vault ("" for the vault itself); a folder board's is the folder it is of
  public var folder: String {
    path.split(separator: "/").dropLast().joined(separator: "/")
  }
}

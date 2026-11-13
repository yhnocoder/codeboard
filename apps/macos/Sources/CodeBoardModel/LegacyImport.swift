import Foundation

// The one-way importer from the VS Code extension's storage folder (board files of version 13–17; main writes 17) into a
// vault. With LegacyUpgrade, the only code that knows the old format: a file is brought to version 17 as the extension
// brings it there, then mapped. It never writes into the old folder. FORMAT.md lists what maps to what.

public enum LegacyImport {
  /// Tests: a write (a file, or a folder made) to a place for which it gives true fails, as a full disk would
  @TaskLocal static var failing: (@Sendable (URL) -> Bool)?

  /// The versions of the old files it reads; any other is refused
  public static let versions = LegacyUpgrade.oldest...LegacyUpgrade.current

  /// Imports every board and shared card of the old storage folder `source` into the vault at `destination`. A file that
  /// cannot be imported is listed in the report's failures and the rest go on. It never writes over a file in the vault: a
  /// board already there (found by id, wherever it is now) comes in as a copy, under a new id, and so does a shared card
  /// whose file there has other content
  public static func run(from source: URL, to destination: URL) throws -> ImportReport {
    try checkPlaces(source: source, destination: destination)
    let fm = FileManager.default
    do {
      try fm.createDirectory(at: destination, withIntermediateDirectories: true)
    } catch {
      throw LegacyImportError.unwritable(destination, error.localizedDescription)
    }
    let vault = Vault(root: destination)
    var inVault: [BoardID: String] = [:]
    for b in try vault.tree().allBoards {
      if let other = inVault.updateValue(b.path, forKey: b.id) {
        throw VaultError.duplicateBoardID(b.id, [vault.url(of: other), vault.url(of: b.path)])
      }
    }
    var run = Run(source: source, vault: vault)
    try run.sharedCards()
    // the library cards are written with the boards' copies known, as a copy's Markdown may refer to them
    try run.boards(inVault: inVault)
    return ImportReport(
      imported: run.entries.sorted { $0.source < $1.source },
      failed: run.failed.sorted { String(describing: $0) < String(describing: $1) })
  }

  /// The vault is a folder of its own: not the old storage folder or inside it, and the old folder not its app-data folder
  private static func checkPlaces(source: URL, destination: URL) throws {
    var isDir: ObjCBool = false
    guard FileManager.default.fileExists(atPath: source.path, isDirectory: &isDir), isDir.boolValue else {
      throw LegacyImportError.notAStorageFolder(source)
    }
    let src = resolved(source).pathComponents
    let dst = resolved(destination).pathComponents
    if dst.starts(with: src) { throw LegacyImportError.destinationInsideSource(destination) }
    if src.starts(with: dst + [Vault.appDataFolder]) { throw LegacyImportError.sourceInsideAppData(source) }
  }

  /// The path with symlinks resolved, also when its end does not exist yet
  private static func resolved(_ url: URL) -> URL {
    var head = url.standardizedFileURL
    var tail: [String] = []
    while !FileManager.default.fileExists(atPath: head.path), head.pathComponents.count > 1 {
      tail.insert(head.lastPathComponent, at: 0)
      head.deleteLastPathComponent()
    }
    return tail.reduce(head.resolvingSymlinksInPath()) { $0.appending(path: $1) }
  }
}

public struct ImportReport: Equatable, Sendable {
  public struct Entry: Equatable, Sendable {
    /// The old file, relative to the old storage folder
    public var source: String
    /// What it became, relative to the vault; nil: nothing (a shared card of a kind not imported yet)
    public var destination: String?
    /// It was in the vault already (a board by id, a shared card with other content): the file there, relative to the
    /// vault, which the import left as it was; `destination` is the copy
    public var copyOf: String?
    public var skipped: [Skipped]

    public init(source: String, destination: String?, copyOf: String? = nil, skipped: [Skipped]) {
      self.source = source
      self.destination = destination
      self.copyOf = copyOf
      self.skipped = skipped
    }
  }

  public struct Skipped: Equatable, Sendable {
    public var kind: SkipKind
    /// The old ids of what was left out (for a field: `<owner id>.<field>`; for an image: its file name)
    public var ids: [String]
    public var count: Int { ids.count }
  }

  /// Sorted by source
  public var imported: [Entry]
  /// Sorted by what they say, which starts with the file
  public var failed: [LegacyImportError]
}

/// What the importer leaves out because the format has no place for it. The old files are never changed, so a later
/// import that knows it brings it in
public enum SkipKind: String, CaseIterable, Sendable {
  /// The Compare and its two columns
  case compareCard
  /// A card on no canvas and in no shelf entry that is not a Compare column
  case unplacedCard
  /// A card the board shows from the card library that is not in it, or could not be imported
  case missingSharedCard
  /// Code variants: the card is imported with the variant it showed
  case variants
  /// The cards a merged card was made from (for Unmerge)
  case mergedFrom
  /// What a Generated card was generated from
  case generated
  /// A class card's list of shown members: imported as its code
  case classMembers
  /// A message Note's mark: imported as a plain Note
  case messageNote
  /// Another place of the same card on the board: imported as a copy of its own
  case twin
  /// A card's process tags (rank 0, Scheduler × TP)
  case processes
  /// An arrow's call, RPC, back or generated-from mark: the arrow is imported plain
  case callMark
  /// An arrow with an end on a card that was not imported or does not exist
  case arrowWithoutEnd
  /// A sidenote on a card, segment or section that was not imported or does not exist, or on a Variant not shown
  case sidenoteWithoutAnchor
  /// A sticker on a card or segment that was not imported or does not exist
  case stickerWithoutAnchor
  /// A sticker on an arrow: where it is drawn depends on the arrow's route, which the importer does not lay out
  case arrowSticker
  /// A sticker from a sticker pack, or a built-in glyph the format does not have
  case stickerPack
  /// A section or parent that does not exist: left out
  case danglingReference
  /// An image file the board names that is not in the old assets folder; the reference is kept
  case missingImage
  /// An image of a shared card whose name the vault's shared images folder already has for other bytes: that file is left
  /// as it is, and the card shows it
  case imageNameTaken
  /// Any other field: known ones the model does not hold yet, and unknown ones
  case field
}

public enum LegacyImportError: Error, Equatable, CustomStringConvertible {
  case notAStorageFolder(URL)
  case destinationInsideSource(URL)
  case sourceInsideAppData(URL)
  case oldVersion(URL, Int)
  case newerVersion(URL, Int)
  case malformed(URL, String)
  case duplicateBoardID(URL, BoardID, other: URL)
  case unwritable(URL, String)

  public var description: String {
    switch self {
    case .notAStorageFolder(let url): "\(url.path) is not a folder"
    case .destinationInsideSource(let url):
      "\(url.path) is the old storage folder or inside it; a vault is a folder of its own"
    case .sourceInsideAppData(let url): "\(url.path) is inside the vault's own \(Vault.appDataFolder) folder"
    case .oldVersion(let url, let v):
      "\(url.path) is a version \(v) board file; open it in the VS Code extension and change anything once, so it is "
        + "saved as version \(LegacyImport.versions.upperBound), then import again"
    case .newerVersion(let url, let v):
      "\(url.path) is a version \(v) board file, newer than this app imports (\(LegacyImport.versions.upperBound))"
    case .malformed(let url, let why): "\(url.path): \(why)"
    case .duplicateBoardID(let url, let id, let other):
      "\(url.path) has board id \(id.rawValue), which \(other.path) has too; it was not imported"
    case .unwritable(let url, let why): "\(url.path) cannot be written: \(why)"
    }
  }
}

// MARK: The import run

/// The old storage folder's own folders, which are not board groups
private let reserved: Set<String> = ["assets", "github", "cards", "runs"]

private enum SharedState {
  case imported(tilted: Bool, segments: Set<SegmentID>, text: Bool)
  case skipped(SkipKind)
}

private struct Run {
  let source: URL
  let vault: Vault
  var entries: [ImportReport.Entry] = []
  var failed: [LegacyImportError] = []
  var shared: [String: SharedState] = [:]
  /// The library cards upgraded to version 17, for the titles of references to them
  var sharedJSON: [String: NSDictionary] = [:]

  init(source: URL, vault: Vault) {
    self.source = source
    self.vault = vault
  }

  /// Each library card read and mapped, not written yet (`write` decides where it goes)
  private var cards: [(file: URL, rel: String, card: SharedCard, mapper: Mapper)] = []

  mutating func sharedCards() throws {
    for file in jsonFiles(in: source.appending(path: "cards")) {
      let id = file.deletingPathExtension().lastPathComponent
      let rel = "cards/\(file.lastPathComponent)"
      do {
        guard Vault.isSafeID(id) else { throw Bad("\(id) cannot name a shared card") }
        let (raw, version) = try oldFile(file)
        let upgraded = LegacyUpgrade.sharedCard(raw)
        let o = try Obj(upgraded, path: "")
        var m = Mapper(version: version)
        m.only(o, ["version", "card", "sidenotes"], id: id)
        let card = try o.object("card")
        sharedJSON[id] = card.fields as NSDictionary
        guard case (let content, let tilted)? = try m.content(card, id: id) else {
          if let kind = m.skippedKind { shared[id] = .skipped(kind) }
          entries.append(.init(source: rel, destination: nil, skipped: m.skips.list))
          continue
        }
        let cid = CardID(rawValue: id)
        var segments = Set<SegmentID>()
        if case .code(let code) = content.body { segments = Set(code.segments.map(\.id)) }
        var notes: [Sidenote] = []
        for n in try o.optObjects("sidenotes") {
          guard let note = try m.sidenote(n) else { continue }
          // the sidenotes in a library file travel with its card: on it, never one board's own
          guard note.anchor.card == cid, !note.boardOnly, m.holds(note.anchor, segments: [cid: segments]) else {
            m.skips.add(.sidenoteWithoutAnchor, note.id.rawValue)
            continue
          }
          notes.append(note)
        }
        let sharedCard = SharedCard(id: cid, content: content, sidenotes: notes)
        if let p = sharedCard.problem() { throw Bad(p) }
        var isText = false
        if case .text = content.body { isText = true }
        shared[id] = .imported(tilted: tilted, segments: segments, text: isText)
        cards.append((file, rel, sharedCard, m))
      } catch let bad as Bad {
        failed.append(.malformed(file, bad.message))
      } catch let e as LegacyImportError {
        failed.append(e)
      }
    }
  }

  /// The library cards written: a card whose file is not in the vault yet under its own id; one whose file is there with
  /// the same bytes is left as it is and used; one whose file is there with other content (the user changed it, or the
  /// old one changed) becomes a copy under a new id, which the boards of this import show instead
  private mutating func writeSharedCards() throws {
    var taken = Set(cards.map(\.card.id.rawValue))
    for (_, _, card, _) in cards {
      let file = sharedFile(card.id.rawValue)
      guard let there = try? Data(contentsOf: file), there != (try card.encoded()) else { continue }
      let copy = copyID(card.id.rawValue) { taken.contains($0) || exists(sharedFile($0)) }
      taken.insert(copy)
      renames.cards[card.id] = CardID(rawValue: copy)
    }
    for (_, rel, card, m) in cards {
      var m = m
      // what this card's write made, taken away again when it fails
      var made: [URL] = []
      do {
        let images = vault.sharedFolderURL.appending(path: Vault.imagesFolder)
        let (skips, madeImages) = try copyImages(m, into: images)
        made += madeImages
        for (kind, name) in skips { m.skips.add(kind, name) }
        let dest: String
        var copyOf: String?
        if let new = renames.cards[card.id] {
          var c = card
          c.rename(renames)
          made.append(try place(try c.encoded(), at: sharedFile(new.rawValue)))
          dest = sharedPath(new.rawValue)
          copyOf = sharedPath(card.id.rawValue)
        } else {
          let out = sharedFile(card.id.rawValue)
          if !exists(out) { made.append(try place(try card.encoded(), at: out)) }
          dest = sharedPath(card.id.rawValue)
        }
        sharedMade[renames.card(card.id)] = (made, m.images.union(m.dataImages.keys))
        entries.append(.init(source: rel, destination: dest, copyOf: copyOf, skipped: m.skips.list))
      } catch let e as LegacyImportError {
        for u in made { try? FileManager.default.removeItem(at: u) }
        // the boards show it as a shared card that could not be imported
        shared[card.id.rawValue] = nil
        renames.cards[card.id] = nil
        failed.append(e)
      }
    }
  }

  /// What each shared card this import wrote made (its file, its images new to the vault) and the image names it shows
  private var sharedMade: [CardID: (files: [URL], images: Set<String>)] = [:]
  /// The shared cards the boards written show
  private var sharedShown = Set<CardID>()

  /// A shared card copied for this import's boards that none of them was written with is taken away again, with the
  /// images it alone brought
  private mutating func dropUnusedCopies() {
    for (old, new) in renames.cards where !sharedShown.contains(new) {
      guard let made = sharedMade[new] else { continue }
      let copies = Set(renames.cards.values)
      let kept = sharedMade.filter { $0.key != new && (sharedShown.contains($0.key) || !copies.contains($0.key)) }
      let needed = kept.values.reduce(into: Set<String>()) { $0.formUnion($1.images) }
      for u in made.files
      where
        !(u.deletingLastPathComponent().lastPathComponent == Vault.imagesFolder
        && needed.contains(u.lastPathComponent))
      {
        try? FileManager.default.removeItem(at: u)
      }
      sharedMade[new] = nil
      let (was, copy) = (sharedPath(old.rawValue), sharedPath(new.rawValue))
      entries.removeAll { $0.copyOf == was && $0.destination == copy }
    }
  }

  private func sharedFile(_ id: String) -> URL { vault.sharedFolderURL.appending(path: "\(id).json") }
  private func sharedPath(_ id: String) -> String { "\(Vault.appDataFolder)/\(Vault.sharedFolder)/\(id).json" }

  /// What this import renames: shared cards and boards that became copies
  private var renames = Renames()

  mutating func boards(inVault: [BoardID: String]) throws {
    var files = jsonFiles(in: source).map { (file: $0, group: "", rel: $0.lastPathComponent) }
    for dir in subfolders(of: source) where !reserved.contains(dir.lastPathComponent) {
      let group = dir.lastPathComponent
      files += jsonFiles(in: dir).map { (file: $0, group: group, rel: "\(group)/\($0.lastPathComponent)") }
    }
    files.sort { $0.rel < $1.rel }
    // first every board's id, so a board already in the vault gets its copy's id before anything refers to it
    var read: [(file: URL, group: String, rel: String, o: Obj, version: Int, id: BoardID)] = []
    var seen: [BoardID: URL] = [:]
    for (file, group, rel) in files {
      do {
        let (raw, version) = try oldFile(file)
        let upgraded = LegacyUpgrade.board(raw)
        LegacyUpgrade.titleRefs(upgraded, version: version, shared: sharedJSON)
        let o = try Obj(upgraded, path: "")
        let stem = file.deletingPathExtension().lastPathComponent
        let own = try o.optString("id")
        guard let raw = [own, stem].compactMap({ $0 }).first(where: Vault.isSafeID) else {
          throw Bad("no usable board id")
        }
        let id = BoardID(rawValue: raw)
        if let other = seen[id] { throw LegacyImportError.duplicateBoardID(file, id, other: other) }
        seen[id] = file
        read.append((file, group, rel, o, version, id))
      } catch let bad as Bad {
        failed.append(.malformed(file, bad.message))
      } catch let e as LegacyImportError {
        failed.append(e)
      }
    }
    var taken = Set(inVault.keys.map(\.rawValue)).union(seen.keys.map(\.rawValue))
    for r in read where inVault[r.id] != nil {
      let copy = copyID(r.id.rawValue) { taken.contains($0) }
      taken.insert(copy)
      renames.boards[r.id] = BoardID(rawValue: copy)
    }
    try writeSharedCards()
    for (file, group, rel, o, version, id) in read {
      do {
        var m = Mapper(version: version)
        var board = try m.board(o, id: id, shared: shared)
        if let p = board.problem() { throw Bad(p) }
        board.rename(renames)
        let folder = group.isEmpty ? "" : folderName(group)
        // already in the vault: a copy beside where a new one would go, named as the Finder names a copy
        let title = Vault.packageName(for: try o.string("name"))
        let name = freeName(inVault[id] == nil ? title : "\(title) copy", in: folder)
        let path = folder.isEmpty ? name : "\(folder)/\(name)"
        for (kind, name) in try writePackage(board, m, folder: folder, name: name) { m.skips.add(kind, name) }
        for c in board.cards where c.content == .shared { sharedShown.insert(c.id) }
        entries.append(.init(source: rel, destination: path, copyOf: inVault[id], skipped: m.skips.list))
      } catch let bad as Bad {
        failed.append(.malformed(file, bad.message))
      } catch let e as LegacyImportError {
        failed.append(e)
      }
    }
    dropUnusedCopies()
  }

  /// A board package, built under a hidden name in its folder and moved into place whole, never over anything: a failure
  /// halfway leaves nothing of it (nor the group folder, when it made it). Returns what was left out of its images
  private func writePackage(_ board: Board, _ m: Mapper, folder: String, name: String) throws -> [(SkipKind, String)] {
    let fm = FileManager.default
    let parent = vault.url(of: folder)
    let madeFolder = !exists(parent)
    let building = parent.appending(path: ".\(name).import-\(UUID().uuidString)")
    do {
      try makeFolder(building)
      try place(try board.encoded(), at: building.appending(path: Vault.boardFileName))
      let (skips, _) = try copyImages(m, into: building.appending(path: Vault.imagesFolder))
      try rename(building, to: parent.appending(path: name))
      return skips
    } catch {
      try? fm.removeItem(at: building)
      if madeFolder, (try? fm.contentsOfDirectory(atPath: parent.path))?.isEmpty == true {
        try? fm.removeItem(at: parent)
      }
      throw error
    }
  }

  /// `<id>-copy`, then `<id>-copy-2`, `-3`…: the first that is not taken
  private func copyID(_ id: String, taken: (String) -> Bool) -> String {
    let stem = String(id.prefix(80 - "-copy-9999".count))
    var n = 1
    while true {
      let c = n == 1 ? "\(stem)-copy" : "\(stem)-copy-\(n)"
      if !taken(c) { return c }
      n += 1
    }
  }

  private func exists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }

  /// A group's folder name, never taken for a board package
  private func folderName(_ group: String) -> String {
    let name = Vault.packageName(for: group)
    return name.hasSuffix(".\(Vault.packageExtension)") ? name + "-" : name
  }

  /// `name.board`, or `name 2.board`… when something in `folder` has that name already (APFS compares names without
  /// case and normalisation, so this does too). Each package is written before the next name is chosen
  private func freeName(_ name: String, in folder: String) -> String {
    let key = { (s: String) in s.precomposedStringWithCanonicalMapping.lowercased() }
    let used = Set(((try? FileManager.default.contentsOfDirectory(atPath: vault.url(of: folder).path)) ?? []).map(key))
    var n = 1
    var candidate = "\(name).\(Vault.packageExtension)"
    while used.contains(key(candidate)) {
      n += 1
      candidate = "\(name) \(n).\(Vault.packageExtension)"
    }
    return candidate
  }

  /// Copies the images `m` found where no file of that name is; returns what was left out (the ones not in the old
  /// assets folder; a name already there for other bytes, left as it is) and the files it made
  private func copyImages(_ m: Mapper, into folder: URL) throws -> (skipped: [(SkipKind, String)], made: [URL]) {
    let assets = source.appending(path: "assets")
    var out: [(SkipKind, String)] = []
    var found: [(String, Data)] = []
    for name in m.images.sorted() {
      guard let data = try? Data(contentsOf: assets.appending(path: name)) else {
        out.append((.missingImage, name))
        continue
      }
      found.append((name, data))
    }
    found += m.dataImages.sorted(by: { $0.key < $1.key })
    var made: [URL] = []
    do {
      for (name, data) in found {
        let url = folder.appending(path: name)
        if let there = try? Data(contentsOf: url) {
          if there != data { out.append((.imageNameTaken, name)) }
          continue
        }
        made.append(try place(data, at: url))
      }
    } catch {
      for u in made { try? FileManager.default.removeItem(at: u) }
      throw error
    }
    return (out, made)
  }

  /// Writes a file that is not there yet, whole or not at all: into a hidden file beside it, then renamed to its name
  /// only if nothing has that name (an import never writes over a file in the vault). Returns the file
  @discardableResult
  private func place(_ data: Data, at url: URL) throws -> URL {
    try makeFolder(url.deletingLastPathComponent())
    let temp = url.deletingLastPathComponent().appending(path: ".\(url.lastPathComponent).import-\(UUID().uuidString)")
    do {
      if LegacyImport.failing?(url) == true { throw CocoaError(.fileWriteUnknown) }
      try data.write(to: temp, options: .withoutOverwriting)
    } catch {
      try? FileManager.default.removeItem(at: temp)
      throw LegacyImportError.unwritable(url, error.localizedDescription)
    }
    do {
      try rename(temp, to: url)
    } catch {
      try? FileManager.default.removeItem(at: temp)
      throw error
    }
    return url
  }

  /// Renames a file or folder to a name nothing has (RENAME_EXCL): never over anything
  private func rename(_ from: URL, to: URL) throws {
    guard renamex_np(from.path, to.path, UInt32(RENAME_EXCL)) == 0 else {
      let why = errno == EEXIST ? "it is already in the vault" : String(cString: strerror(errno))
      throw LegacyImportError.unwritable(to, why)
    }
  }

  private func makeFolder(_ url: URL) throws {
    do {
      if LegacyImport.failing?(url) == true { throw CocoaError(.fileWriteNoPermission) }
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    } catch {
      throw LegacyImportError.unwritable(url, error.localizedDescription)
    }
  }
}

private func entries(of dir: URL) -> [URL] {
  // built from dir, not listed as URLs, so paths in errors are spelled as the caller spelled them
  let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
  return names.filter { !$0.hasPrefix(".") }.sorted().map { dir.appending(path: $0) }
}

private func isFolder(_ url: URL) -> Bool {
  (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
}

private func jsonFiles(in dir: URL) -> [URL] {
  entries(of: dir).filter { $0.pathExtension == "json" && !isFolder($0) }
}

private func subfolders(of dir: URL) -> [URL] {
  entries(of: dir).filter(isFolder)
}

/// An old board or shared card file of a version this importer reads, as mutable JSON, and its version
private func oldFile(_ file: URL) throws -> (NSMutableDictionary, Int) {
  let raw: Any
  do {
    raw = try JSONSerialization.jsonObject(with: Data(contentsOf: file), options: [.mutableContainers])
  } catch {
    throw Bad("not JSON")
  }
  guard let o = raw as? NSMutableDictionary else { throw Bad("(root): expected an object") }
  let version = try Obj(o, path: "").optInt("version") ?? 1
  if version < LegacyImport.versions.lowerBound { throw LegacyImportError.oldVersion(file, version) }
  if version > LegacyImport.versions.upperBound { throw LegacyImportError.newerVersion(file, version) }
  return (o, version)
}

// MARK: Mapping the old content

private struct Bad: Error {
  var message: String
  init(_ message: String) { self.message = message }
}

private struct Skips {
  private var byKind: [SkipKind: [String]] = [:]

  mutating func add(_ kind: SkipKind, _ id: String) { byKind[kind, default: []].append(id) }

  var list: [ImportReport.Skipped] {
    SkipKind.allCases.compactMap { k in byKind[k].map { ImportReport.Skipped(kind: k, ids: $0) } }
  }
}

private struct Mapper {
  /// The old file's own version, before the upgrade
  let version: Int
  var skips = Skips()
  /// Old asset file names to copy
  var images: Set<String> = []
  /// Images that were data: URLs, by the file name they get
  var dataImages: [String: Data] = [:]
  /// Why the last content(…) gave nil
  var skippedKind: SkipKind?
  /// The Variant each code card shows ("up": the pinned one), for its sidenotes
  var shownVariant: [String: String] = [:]

  init(version: Int) {
    self.version = version
  }

  /// Reports the fields of `o` that are not in `known`
  mutating func only(_ o: Obj, _ known: Set<String>, id: String) {
    for key in o.fields.keys.sorted() where !known.contains(key) { skips.add(.field, "\(id).\(key)") }
  }

  mutating func board(_ o: Obj, id: BoardID, shared: [String: SharedState]) throws -> Board {
    let bid = id.rawValue
    only(
      o,
      [
        "version", "id", "name", "cards", "place", "links", "sections", "sidenotes", "stickers", "hideAllComments",
        "shelf", "seal",
      ], id: bid)

    let oldShelf = try o.optObjects("shelf")
    var sections = try o.objects("sections").map { try section($0) }
    var shelfSections = try oldShelf.map { e in try e.objects("sections").map { try section($0) } }
    let sectionIDs = Set(sections.map(\.id) + shelfSections.flatMap { $0.map(\.id) })
    func dropDangling(_ list: inout [Section]) {
      for i in list.indices {
        if let p = list[i].parent, !sectionIDs.contains(p) {
          skips.add(.danglingReference, "\(list[i].id.rawValue).parent")
          list[i].parent = nil
        }
      }
    }
    dropDangling(&sections)
    for i in shelfSections.indices { dropDangling(&shelfSections[i]) }

    let place = try o.object("place")
    let shelfPlaces = try oldShelf.map { try $0.object("place") }
    let oldCards = try o.objects("cards")
    var columns = Set<String>()
    for c in oldCards {
      if try c.string("kind") == "compare" { columns.formUnion(try c.strings("cols")) }
      if try c.string("kind") == "code" { shownVariant[try c.string("id")] = try c.optString("active") ?? "up" }
    }
    var cards: [Card] = []
    var shelfCards = Array(repeating: [Card](), count: oldShelf.count)
    var codeSegments: [CardID: Set<SegmentID>] = [:]
    for c in oldCards {
      let cid = try c.string("id")
      let entry = try shelfPlaces.firstIndex { try $0.optObject(cid) != nil }
      guard let p = try place.optObject(cid) ?? entry.flatMap({ try shelfPlaces[$0].optObject(cid) }) else {
        skips.add(columns.contains(cid) ? .compareCard : .unplacedCard, cid)
        continue
      }
      let content: Card.Content
      var tilted = false
      var isText = false
      if try c.string("kind") == "shared" {
        only(c, ["id", "kind"], id: cid)
        switch shared[cid] {
        case .imported(let t, let segments, let text)?:
          tilted = t
          isText = text
          content = .shared
          codeSegments[CardID(rawValue: cid)] = segments
        case .skipped(let kind)?:
          skips.add(kind, cid)
          continue
        case nil:
          skips.add(.missingSharedCard, cid)
          continue
        }
      } else {
        guard case (let own, let t)? = try self.content(c, id: cid) else { continue }
        tilted = t
        content = .own(own)
        if case .code(let code) = own.body { codeSegments[CardID(rawValue: cid)] = Set(code.segments.map(\.id)) }
        if case .text = own.body { isText = true }
      }
      only(p, ["x", "y", "w", "h", "mh", "section", "locked", "summary"], id: cid)
      var section = try p.optString("section").map(SectionID.init(rawValue:))
      if let s = section, !sectionIDs.contains(s) {
        skips.add(.danglingReference, "\(cid).section")
        section = nil
      }
      var height = try p.optDouble("h")
      // a Text or Box is as tall as its text; before 16 a library Text kept the height its board file stored, which the
      // extension drops once it has the card's content
      if isText && height != nil {
        if !(content == .shared && version < 16) { skips.add(.field, "\(cid).h") }
        height = nil
      }
      // on the canvas mh is a height the board measured, written again whenever it is drawn; a shelved card keeps it for
      // its thumbnail
      let card = Card(
        id: CardID(rawValue: cid), x: try p.double("x"), y: try p.double("y"), width: try p.double("w"),
        height: height, measuredHeight: entry == nil ? nil : try p.optDouble("mh"), section: section,
        locked: try p.flag("locked"), tilted: tilted, summary: try p.optObject("summary").map { try summary($0) },
        content: content)
      if let entry { shelfCards[entry].append(card) } else { cards.append(card) }
    }
    let allCards = Set(cards.map(\.id) + shelfCards.flatMap { $0.map(\.id) })
    let segmentsOf = { (card: CardID) -> Set<SegmentID>? in codeSegments[card] }

    func arrows(_ links: [Obj]) throws -> [Arrow] {
      var out: [Arrow] = []
      for l in links {
        let a = try arrow(l)
        let ok = [a.from, a.to].allSatisfy { end in
          guard let segments = segmentsOf(end.card) else { return end.segment == nil && allCards.contains(end.card) }
          return end.segment.map(segments.contains) ?? true
        }
        if ok { out.append(a) } else { skips.add(.arrowWithoutEnd, a.id.rawValue) }
      }
      return out
    }
    func stickers(_ list: [Obj]) throws -> [Sticker] {
      var out: [Sticker] = []
      for k in list {
        guard let sticker = try self.sticker(k) else { continue }
        if let card = sticker.anchor.card {
          var ok = allCards.contains(card)
          if case .line(_, let seg, _) = sticker.anchor { ok = segmentsOf(card)?.contains(seg) ?? false }
          guard ok else {
            skips.add(.stickerWithoutAnchor, sticker.id.rawValue)
            continue
          }
        }
        out.append(sticker)
      }
      return out
    }

    var notes: [Sidenote] = []
    for n in try o.objects("sidenotes") {
      guard let note = try sidenote(n) else { continue }
      var ok = true
      switch note.anchor {
      case .card(let card, let seg, _, _):
        ok = allCards.contains(card) && (seg.map { segmentsOf(card)?.contains($0) ?? true } ?? true)
      case .section(let s): ok = sectionIDs.contains(s)
      case .point: break
      }
      if ok { notes.append(note) } else { skips.add(.sidenoteWithoutAnchor, note.id.rawValue) }
    }

    var shelf: [ShelfEntry] = []
    for (i, e) in oldShelf.enumerated() {
      let eid = try e.string("id")
      only(e, ["id", "at", "place", "sections", "links", "stickers"], id: eid)
      shelf.append(
        ShelfEntry(
          id: eid, at: try e.double("at"), cards: shelfCards[i], sections: shelfSections[i],
          arrows: try arrows(try e.objects("links")), stickers: try stickers(try e.objects("stickers"))))
    }
    return Board(
      id: id, cards: cards, arrows: try arrows(try o.objects("links")), sections: sections, sidenotes: notes,
      stickers: try stickers(try o.objects("stickers")), shelf: shelf, seal: try seal(o, id: bid),
      hideComments: try o.flag("hideAllComments"))
  }

  private mutating func seal(_ o: Obj, id: String) throws -> Seal? {
    guard let s = try o.optObject("seal") else { return nil }
    only(s, ["text", "color"], id: "\(id).seal")
    var seal = Seal()
    if let t = try s.optString("text") {
      if Seal.isText(t) { seal.text = t } else { skips.add(.field, "\(id).seal.text") }
    }
    if let c = try s.optString("color") {
      if let color = Seal.Color(rawValue: c) { seal.color = color } else { skips.add(.field, "\(id).seal.color") }
    }
    return seal == Seal() ? nil : seal
  }

  /// Whether a sidenote's anchor is there: its card, and its segment among that card's
  func holds(_ a: Anchor, segments: [CardID: Set<SegmentID>]) -> Bool {
    guard case .card(let card, let seg, _, _) = a, let segs = segments[card] else { return false }
    return seg.map { segs.isEmpty || segs.contains($0) } ?? true
  }

  /// A card's content and whether it was tilted; nil (reported) for a kind the format does not hold
  mutating func content(_ c: Obj, id: String) throws -> (CardContent, tilted: Bool)? {
    skippedKind = nil
    let kind = try c.string("kind")
    if kind == "compare" {
      skips.add(.compareCard, id)
      skippedKind = .compareCard
      return nil
    }
    if c.has("same") { skips.add(.twin, id) }
    if !(try c.optObjects("procs")).isEmpty { skips.add(.processes, id) }
    let common: Set = ["id", "kind", "title", "desc", "procs", "tilt", "same"]
    let body: CardContent.Body
    switch kind {
    case "code":
      body = .code(try code(c, id: id))
      only(
        c, common.union(["segments", "hide", "wrap", "bg", "members", "mergedFrom", "gen", "variants", "active"]),
        id: id)
    case "note":
      body = try note(c, id: id)
      only(c, common.union(["md", "look", "fill", "fs", "wrap", "msg", "mdLayout"]), id: id)
    case "image":
      body = .image(try image(c))
      only(c, common.union(["src", "alt", "bg", "frame", "loop"]), id: id)
    case "web":
      let style = try c.optString("style") ?? "automatic"
      guard let s = WebCard.Style(rawValue: style), style != "automatic" || !c.has("style") else {
        throw Bad("\(c.at("style")): unknown style \(style)")
      }
      body = .web(
        WebCard(url: try c.string("url"), meta: try c.optObject("meta").map { try meta($0, id: id) }, style: s))
      only(c, common.union(["url", "meta", "style"]), id: id)
    case "links":
      var items: [LinkList.Item] = []
      for item in try c.objects("items") {
        let iid = try item.string("id")
        only(item, ["id", "url", "title", "meta", "rich"], id: "\(id).items.\(iid)")
        items.append(
          LinkList.Item(
            id: iid, url: try item.string("url"), title: try item.optString("title"),
            meta: try item.optObject("meta").map { try meta($0, id: "\(id).items.\(iid)") },
            rich: try item.optBool("rich")))
      }
      body = .links(LinkList(items: items, rich: try c.flag("rich")))
      only(c, common.union(["items", "rich"]), id: id)
    case "board":
      let board = try c.string("board")
      guard Vault.isSafeID(board) else { throw Bad("\(c.at("board")): \(board) is not a board id") }
      body = .board(SubBoard(board: BoardID(rawValue: board)))
      // pcols: how many columns its preview showed, a choice of the moment
      only(c, common.union(["board"]), id: id)
    default:
      throw Bad("\(c.at("kind")): unknown card kind \(kind)")
    }
    let content = CardContent(
      title: try c.optString("title"), description: try c.optString("desc").map { markdown($0) }, body: body)
    return (content, try c.flag("tilt"))
  }

  private mutating func code(_ c: Obj, id: String) throws -> CodeCard {
    if c.has("members") { skips.add(.classMembers, id) }
    if c.has("mergedFrom") { skips.add(.mergedFrom, id) }
    if c.has("gen") { skips.add(.generated, id) }
    if c.has("variants") || c.has("active") { skips.add(.variants, id) }
    var hide = HideFlags()
    if let h = try c.optObject("hide") {
      only(h, ["comments", "docstrings", "blank"], id: "\(id).hide")
      hide = HideFlags(
        comments: try h.flag("comments"), docstrings: try h.flag("docstrings"), blankLines: try h.flag("blank"))
    }
    return CodeCard(
      segments: try c.objects("segments").map { try segment($0) }, hide: hide, wrap: try c.flag("wrap"),
      framed: try c.optBool("bg") ?? true)
  }

  private mutating func segment(_ s: Obj) throws -> Segment {
    let sid = try s.string("id")
    only(
      s,
      ["id", "src", "path", "lang", "start", "end", "text", "version", "symbol", "scope", "hidden", "hl", "annots"],
      id: sid)
    let start = try s.int("start")
    let end = try s.int("end")
    let text = try s.strings("text")
    guard end - start + 1 == text.count else {
      throw Bad("\(s.path): lines \(start)–\(end) but \(text.count) lines of text")
    }
    let symbol = try s.optObject("symbol").map { o in
      guard let kind = Symbol.Kind(rawValue: try o.string("kind")) else { throw Bad("\(o.at("kind")): unknown kind") }
      return Symbol(name: try o.string("qual"), kind: kind)
    }
    var annotations: [Annotation] = []
    for a in try s.optObjects("annots") {
      only(a, ["line", "from", "to", "text", "color", "below"], id: "\(sid).annots")
      annotations.append(
        Annotation(
          line: try a.int("line"), from: try a.int("from"), to: try a.int("to"), text: try a.string("text"),
          color: try a.pick("color", HandColor.self) ?? .blue, below: try a.flag("below")))
    }
    return Segment(
      id: SegmentID(rawValue: sid), source: try codeSource(s, id: sid), language: try s.string("lang"),
      firstLine: start, lines: text, symbol: symbol, scope: try s.optString("scope"), hidden: try s.ranges("hidden"),
      highlights: try s.ranges("hl"), annotations: annotations)
  }
  private mutating func codeSource(_ s: Obj, id: String) throws -> CodeSource? {
    let src = try s.object("src")
    let version = try s.object("version")
    let path = try s.string("path")
    let kind = try src.string("kind")
    only(src, kind == "free" ? ["kind"] : ["kind", "repo", "root", "owner", "name", "ref"], id: "\(id).src")
    if kind == "free" { return nil }
    only(version, ["kind", "commit", "uncommitted", "name", "version", "hash"], id: "\(id).version")
    switch try version.string("kind") {
    case "pkg":
      return .package(name: try version.string("name"), version: try version.string("version"), path: path)
    case "git":
      let commit = try version.string("commit")
      let uncommitted = try version.flag("uncommitted")
      switch kind {
      case "github":
        let repo = "https://github.com/\(try src.string("owner"))/\(try src.string("name"))"
        return .git(repository: repo, commit: commit, path: path, uncommitted: uncommitted, checkout: nil)
      case "repo":
        return .git(
          repository: nil, commit: commit, path: path, uncommitted: uncommitted, checkout: try src.string("repo"))
      case "external":
        return .git(
          repository: nil, commit: commit, path: path, uncommitted: uncommitted, checkout: try src.string("root"))
      default: throw Bad("\(src.at("kind")): unknown source kind \(kind)")
      }
    case "hash", "none":
      let hash = try version.optString("hash")
      switch kind {
      case "github":
        // a GitHub file is pinned to the ref it was read at
        let repo = "https://github.com/\(try src.string("owner"))/\(try src.string("name"))"
        return .git(repository: repo, commit: try src.string("ref"), path: path, uncommitted: false, checkout: nil)
      case "repo": return .file(path: joined(try src.string("repo"), path), hash: hash)
      case "external": return .file(path: joined(try src.string("root"), path), hash: hash)
      default: throw Bad("\(src.at("kind")): unknown source kind \(kind)")
      }
    default:
      throw Bad("\(version.at("kind")): unknown version kind")
    }
  }

  /// A Note, or a Text or Box
  private mutating func note(_ c: Obj, id: String) throws -> CardContent.Body {
    if c.has("msg") { skips.add(.messageNote, id) }
    let text = markdown(try c.string("md"))
    let layout = try layout(c, id: id)
    let look = try c.string("look")
    switch look {
    case "note":
      for key in ["fill", "fs", "wrap"] where c.has(key) { skips.add(.field, "\(id).\(key)") }
      return .note(Note(text: text, layout: layout))
    case "text", "box":
      let fontSize = try c.optDouble("fs") ?? TextCard.sizes[0]
      guard TextCard.fontSizes.contains(fontSize) else { throw Bad("\(c.at("fs")): \(fontSize) is outside 10…240") }
      return .text(
        TextCard(
          text: text, look: look == "box" ? .box : .text, fill: try c.pick("fill", BoxFill.self) ?? .yellow,
          fontSize: fontSize, wrap: try c.flag("wrap"), layout: layout))
    default:
      throw Bad("\(c.at("look")): unknown look \(look)")
    }
  }

  private mutating func layout(_ c: Obj, id: String) throws -> NoteLayout? {
    guard let l = try c.optObject("mdLayout") else { return nil }
    only(l, ["tables", "wrap"], id: "\(id).mdLayout")
    let tables = try l.optArray("tables")?.enumerated().map { i, t -> NoteLayout.Table? in
      if t is NSNull { return nil }
      let o = try Obj(t, path: l.at("tables[\(i)]"))
      only(o, ["cols", "rows"], id: "\(id).mdLayout.tables")
      return NoteLayout.Table(cols: try o.sizes("cols"), rows: try o.sizes("rows"))
    }
    let wrap = try l.optArray("wrap")?.enumerated().map { i, w in try integer(w, at: l.at("wrap[\(i)]")) }
    return NoteLayout(tables: tables, wrap: wrap)
  }

  private mutating func image(_ c: Obj) throws -> ImageCard {
    let frame = try c.optInt("frame")
    return ImageCard(
      source: try imageSource(try c.string("src"), at: c.at("src")), alt: try c.optString("alt"),
      framed: try c.flag("bg"), stillFrame: frame, loops: try c.flag("loop"))
  }

  /// An old image reference: an asset's file name (or assets/<file>), copied; a data: URL, made a file; or an address
  private mutating func imageSource(_ src: String, at path: String) throws -> ImageSource {
    if src.hasPrefix("data:") { return .file(try dataImage(src, at: path)) }
    if src.hasPrefix("https://") || src.hasPrefix("http://") { return .url(src) }
    let name = src.hasPrefix("assets/") ? String(src.dropFirst("assets/".count)) : src
    guard Vault.isFileName(name) else { throw Bad("\(path): \(src) is not an image file name") }
    images.insert(name)
    return .file(name)
  }

  private mutating func meta(_ m: Obj, id: String) throws -> WebMeta {
    only(m, ["title", "desc", "site", "image", "icon", "at", "failed"], id: "\(id).meta")
    return WebMeta(
      title: try m.optString("title"), description: try m.optString("desc"), site: try m.optString("site"),
      image: try m.optString("image").map { try imageSource($0, at: m.at("image")) },
      icon: try m.optString("icon").map { try imageSource($0, at: m.at("icon")) }, fetchedAt: try m.optDouble("at"),
      failed: try m.flag("failed"))
  }

  /// A data: URL image becomes a file named by a fingerprint of its bytes, as the old host names assets by content
  private mutating func dataImage(_ url: String, at path: String) throws -> String {
    let types = [
      "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
    ]
    guard let m = url.wholeMatch(of: /data:([\w\/+.-]+);base64,(.*)/.dotMatchesNewlines()),
      let ext = types[String(m.1)], let data = Data(base64Encoded: String(m.2), options: .ignoreUnknownCharacters)
    else { throw Bad("\(path): not a PNG, JPEG, GIF, WebP or SVG data: URL") }
    var h: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in data {
      h ^= UInt64(byte)
      h = h &* 0x100_0000_01b3
    }
    let hex = String(h, radix: 16)
    let name = String(repeating: "0", count: 16 - hex.count) + hex + ".\(ext)"
    dataImages[name] = data
    return name
  }

  /// Old Markdown names images assets/<file>; in a vault they are in the images folder beside the JSON. Only where
  /// Markdown reads an address: an image's or link's destination (`](assets/…`, `](<assets/…`) and a link reference
  /// definition (`[x]: assets/…`), outside code; the same words in prose or code are the user's text
  private mutating func markdown(_ md: String) -> String {
    guard md.contains("assets/") else { return md }
    let name = "[A-Za-z0-9_-][A-Za-z0-9_.-]*"
    let at = [
      try! Regex("(\\]\\(\\s*<?)assets/(\(name))"),
      try! Regex("(^ {0,3}\\[[^\\]\\n]+\\]:[ \\t]*\\n?[ \\t]*<?)assets/(\(name))").anchorsMatchLineEndings(),
    ]
    return LegacyUpgrade.mapProse(md) { prose in
      at.reduce(prose) { text, r in
        text.replacing(r) { m in
          let file = String(m.output[2].substring ?? "")
          images.insert(file)
          return "\(m.output[1].substring ?? "")\(Vault.imagesFolder)/\(file)"
        }
      }
    }
  }

  private mutating func arrow(_ l: Obj) throws -> Arrow {
    let id = try l.string("id")
    only(l, ["id", "from", "to", "label", "at", "style", "sides", "lost", "call", "rpc", "back", "gen"], id: id)
    if ["call", "rpc", "back", "gen"].contains(where: l.has) { skips.add(.callMark, id) }
    let style = try l.optObject("style")
    let head = try style?.optObject("head")
    if let style { only(style, ["dash", "width", "head", "color"], id: "\(id).style") }
    if let head { only(head, ["start", "end"], id: "\(id).style.head") }
    let width = try style?.optInt("width") ?? 2
    let sides = try l.optObject("sides")
    let lost = try l.optObject("lost")
    if let sides { only(sides, ["from", "to"], id: "\(id).sides") }
    if let lost { only(lost, ["from", "to"], id: "\(id).lost") }
    func end(_ key: String) throws -> Endpoint {
      let e = try l.object(key)
      only(e, ["card", "seg", "line", "block"], id: "\(id).\(key)")
      let block = try e.optObject("block").map { BlockRef(index: try $0.int("i"), hash: try $0.string("h")) }
      return Endpoint(
        card: CardID(rawValue: try e.string("card")), segment: try e.optString("seg").map(SegmentID.init(rawValue:)),
        line: try e.optInt("line"), block: block, side: try sides?.pick(key, Endpoint.Side.self),
        lost: try lost?.flag(key) ?? false)
    }
    return Arrow(
      id: ArrowID(rawValue: id), from: try end("from"), to: try end("to"), label: try l.optString("label"),
      labelPosition: try l.optDouble("at"), dashed: try style?.flag("dash") ?? false, width: width,
      startHead: try head?.optBool("start") ?? false, endHead: try head?.optBool("end") ?? true,
      color: try style?.optString("color"))
  }

  private mutating func section(_ s: Obj) throws -> Section {
    let id = try s.string("id")
    only(
      s,
      [
        "id", "title", "x", "y", "w", "h", "parent", "color", "collapsed", "locked", "desc", "summary", "directSummary",
      ],
      id: id)
    return Section(
      id: SectionID(rawValue: id), title: try s.string("title"), x: try s.double("x"), y: try s.double("y"),
      width: try s.double("w"), height: try s.double("h"),
      parent: try s.optString("parent").map(SectionID.init(rawValue:)), color: try s.optString("color"),
      collapsed: try s.flag("collapsed"), locked: try s.flag("locked"),
      description: try s.optString("desc").map { markdown($0) },
      summary: try s.optObject("summary").map { try summary($0) },
      directSummary: try s.optObject("directSummary").map { try summary($0) })
  }

  private mutating func summary(_ o: Obj) throws -> Summary {
    only(o, ["text", "title", "at", "sig", "edited", "pairs", "input"], id: "\(o.path)")
    let pairs = try o.optObjects("pairs").map { p in
      Summary.Pair(ai: try p.string("ai"), user: try p.string("user"), at: try p.double("at"))
    }
    return Summary(
      text: try o.string("text"), title: try o.optString("title"), at: try o.double("at"), sig: try o.string("sig"),
      edited: try o.flag("edited"), pairs: pairs, input: try o.optString("input"))
  }

  /// A sidenote; nil (reported) for one on a Variant its card does not show
  mutating func sidenote(_ n: Obj) throws -> Sidenote? {
    let id = try n.string("id")
    let kind = try n.string("kind")
    let a = try n.object("at")
    let anchor: Anchor
    if a.has("section") {
      only(a, ["section"], id: "\(id).at")
      anchor = .section(SectionID(rawValue: try a.string("section")))
    } else if a.has("card") {
      only(a, ["card", "seg", "lines", "block"], id: "\(id).at")
      let lines = try a.ranges("lines", single: true).first
      let block = try a.optObject("block").map { BlockRef(index: try $0.int("i"), hash: try $0.string("h")) }
      anchor = .card(
        CardID(rawValue: try a.string("card")), segment: try a.optString("seg").map(SegmentID.init(rawValue:)),
        lines: lines, block: block)
    } else {
      only(a, ["x", "y"], id: "\(id).at")
      anchor = .point(x: try a.double("x"), y: try a.double("y"))
    }
    if let v = try n.optString("variant"), let card = anchor.card, v != shownVariant[card.rawValue] ?? "up" {
      skips.add(.sidenoteWithoutAnchor, id)
      return nil
    }
    let why = try n.optString("why").flatMap { $0.isEmpty ? nil : $0 }
    let body: Sidenote.Body
    switch kind {
    case "text":
      only(
        n, ["id", "kind", "at", "why", "lineRemoved", "boardOnly", "review", "variant", "md", "alwaysShow", "q"], id: id
      )
      var md = markdown(try n.string("md"))
      // the old separate "why" line is the note's first line now
      if let why { md = md.isEmpty ? why : "\(why)\n\n\(md)" }
      let question = try n.optObject("q").map { q in
        only(q, ["at", "done", "answers"], id: "\(id).q")
        return Question(
          at: try q.double("at"), done: try q.flag("done"),
          answers: try q.optObjects("answers").map { a in
            only(a, ["id", "md", "at"], id: "\(id).q.answers")
            return Question.Answer(id: try a.string("id"), text: markdown(try a.string("md")), at: try a.double("at"))
          })
      }
      body = .text(TextNote(text: md, alwaysShow: try n.flag("alwaysShow"), question: question))
    case "code":
      // a code sidenote has no text to put its "why" in: reported as a field
      only(n, ["id", "kind", "at", "lineRemoved", "boardOnly", "review", "variant", "code"], id: id)
      body = .code(try segment(try n.object("code")))
    default:
      throw Bad("\(n.at("kind")): unknown sidenote kind \(kind)")
    }
    return Sidenote(
      id: SidenoteID(rawValue: id), anchor: anchor, body: body, lineRemoved: try n.flag("lineRemoved"),
      boardOnly: try n.flag("boardOnly"), review: try n.optString("review"))
  }

  /// A sticker; nil (reported) for one on an arrow or from a sticker pack
  private mutating func sticker(_ k: Obj) throws -> Sticker? {
    let id = try k.string("id")
    only(k, ["id", "icon", "color", "at"], id: id)
    let icon = try k.object("icon")
    let name = try icon.string("name")
    let glyph: Sticker.Glyph
    switch try icon.string("pack") {
    case "builtin":
      guard let b = BuiltinSticker(rawValue: name) else {
        skips.add(.stickerPack, id)
        return nil
      }
      glyph = .builtin(b)
    case "emoji" where name.count == 1:
      glyph = .emoji(name)
    default:
      skips.add(.stickerPack, id)
      return nil
    }
    let at = try k.object("at")
    let anchor: Sticker.Anchor
    switch try at.string("kind") {
    case "line":
      only(at, ["kind", "card", "seg", "line"], id: "\(id).at")
      anchor = .line(
        CardID(rawValue: try at.string("card")), segment: SegmentID(rawValue: try at.string("seg")),
        line: try at.int("line"))
    case "canvas":
      only(at, ["kind", "x", "y", "size", "on"], id: "\(id).at")
      let x = try at.double("x")
      let y = try at.double("y")
      let size = try at.optDouble("size")
      if let on = try at.optObject("on") {
        guard on.has("card") else {
          skips.add(.arrowSticker, id)
          return nil
        }
        anchor = .card(CardID(rawValue: try on.string("card")), x: x, y: y, size: size)
      } else {
        anchor = .canvas(x: x, y: y, size: size)
      }
    case let kind:
      throw Bad("\(at.at("kind")): unknown sticker place \(kind)")
    }
    return Sticker(id: StickerID(rawValue: id), glyph: glyph, color: try k.optString("color"), anchor: anchor)
  }
}

private func joined(_ root: String, _ path: String) -> String {
  root.isEmpty ? path : root.hasSuffix("/") ? root + path : "\(root)/\(path)"
}

private func integer(_ v: Any, at path: String) throws -> Int {
  guard let n = v as? NSNumber, !isBool(n), let i = Int(exactly: n.doubleValue) else {
    throw Bad("\(path): expected a whole number")
  }
  return i
}

private func isBool(_ n: NSNumber) -> Bool {
  CFGetTypeID(n) == CFBooleanGetTypeID()
}

/// A JSON object of an old file, read field by field; every error says where in the file
private struct Obj {
  let fields: [String: Any]
  let path: String

  init(_ value: Any?, path: String) throws {
    guard let fields = value as? [String: Any] else {
      throw Bad("\(path.isEmpty ? "(root)" : path): expected an object")
    }
    self.fields = fields
    self.path = path
  }

  func at(_ key: String) -> String { path.isEmpty ? key : "\(path).\(key)" }
  func has(_ key: String) -> Bool { fields[key] != nil }

  private func required(_ key: String) throws -> Any {
    guard let v = fields[key] else { throw Bad("\(at(key)): missing") }
    return v
  }

  func string(_ key: String) throws -> String {
    guard let s = try required(key) as? String else { throw Bad("\(at(key)): expected a string") }
    return s
  }
  func optString(_ key: String) throws -> String? { has(key) ? try string(key) : nil }

  func double(_ key: String) throws -> Double {
    guard let n = try required(key) as? NSNumber, !isBool(n) else { throw Bad("\(at(key)): expected a number") }
    return n.doubleValue
  }
  func optDouble(_ key: String) throws -> Double? { has(key) ? try double(key) : nil }

  func int(_ key: String) throws -> Int { try integer(try required(key), at: at(key)) }
  func optInt(_ key: String) throws -> Int? { has(key) ? try int(key) : nil }

  func optBool(_ key: String) throws -> Bool? {
    guard has(key) else { return nil }
    guard let n = fields[key] as? NSNumber, isBool(n) else { throw Bad("\(at(key)): expected true or false") }
    return n.boolValue
  }
  /// An old flag: left out means false
  func flag(_ key: String) throws -> Bool { try optBool(key) ?? false }

  func pick<T: RawRepresentable>(_ key: String, _: T.Type) throws -> T? where T.RawValue == String {
    guard let raw = try optString(key) else { return nil }
    guard let v = T(rawValue: raw) else { throw Bad("\(at(key)): unknown value \(raw)") }
    return v
  }

  func object(_ key: String) throws -> Obj { try Obj(try required(key), path: at(key)) }
  func optObject(_ key: String) throws -> Obj? { has(key) ? try object(key) : nil }

  func optArray(_ key: String) throws -> [Any]? {
    guard has(key) else { return nil }
    guard let a = fields[key] as? [Any] else { throw Bad("\(at(key)): expected a list") }
    return a
  }
  func objects(_ key: String) throws -> [Obj] {
    _ = try required(key)
    return try optObjects(key)
  }
  /// Left out: none
  func optObjects(_ key: String) throws -> [Obj] {
    try (optArray(key) ?? []).enumerated().map { i, v in try Obj(v, path: "\(at(key))[\(i)]") }
  }
  func strings(_ key: String) throws -> [String] {
    guard let a = try required(key) as? [Any], let s = a as? [String] else {
      throw Bad("\(at(key)): expected a list of strings")
    }
    return s
  }
  /// [[first, last]…]; left out: none. single: the value is one [first, last]
  func ranges(_ key: String, single: Bool = false) throws -> [ClosedRange<Int>] {
    let list = single ? (has(key) ? [fields[key]!] : []) : (try optArray(key) ?? [])
    return try list.enumerated().map { i, v in
      let here = single ? at(key) : "\(at(key))[\(i)]"
      guard let pair = v as? [Any], pair.count == 2 else { throw Bad("\(here): expected [first, last]") }
      let a = try integer(pair[0], at: here)
      let b = try integer(pair[1], at: here)
      guard a <= b else { throw Bad("\(here): \(a) is after \(b)") }
      return a...b
    }
  }
  /// Table cell sizes: numbers or null
  func sizes(_ key: String) throws -> [Double?]? {
    try optArray(key)?.map { v in
      if v is NSNull { return nil }
      guard let n = v as? NSNumber, !isBool(n) else { throw Bad("\(at(key)): expected numbers or null") }
      return n.doubleValue
    }
  }
}

// MARK: Copies

/// The ids an import gives what became a copy: shared cards and boards already in the vault. Everything this import writes
/// refers to the copies, so what came in together stays together
private struct Renames {
  var cards: [CardID: CardID] = [:]
  var boards: [BoardID: BoardID] = [:]

  func card(_ id: CardID) -> CardID { cards[id] ?? id }

  /// [[label#^target]] refs to a renamed card or board (`card`, `board`, `board/card`) point at the copy
  func markdown(_ md: String) -> String {
    guard !cards.isEmpty || !boards.isEmpty else { return md }
    return LegacyUpgrade.mapRefs(md) { label, target in
      guard let target else { return nil }
      let parts = target.split(separator: "/").map(String.init)
      let new: String
      if parts.count == 2 {
        let b = boards[BoardID(rawValue: parts[0])]?.rawValue ?? parts[0]
        new = "\(b)/\(cards[CardID(rawValue: parts[1])]?.rawValue ?? parts[1])"
      } else {
        new = cards[CardID(rawValue: target)]?.rawValue ?? boards[BoardID(rawValue: target)]?.rawValue ?? target
      }
      return new == target ? nil : "[[\(label)#^\(new)]]"
    }
  }
}

extension Board {
  fileprivate mutating func rename(_ r: Renames) {
    id = r.boards[id] ?? id
    for i in cards.indices { cards[i].rename(r) }
    for i in arrows.indices { arrows[i].rename(r) }
    for i in sections.indices { sections[i].description = sections[i].description.map(r.markdown) }
    for i in sidenotes.indices { sidenotes[i].rename(r) }
    for i in stickers.indices { stickers[i].rename(r) }
    for e in shelf.indices {
      for i in shelf[e].cards.indices { shelf[e].cards[i].rename(r) }
      for i in shelf[e].sections.indices {
        shelf[e].sections[i].description = shelf[e].sections[i].description.map(r.markdown)
      }
      for i in shelf[e].arrows.indices { shelf[e].arrows[i].rename(r) }
      for i in shelf[e].stickers.indices { shelf[e].stickers[i].rename(r) }
    }
  }
}

extension SharedCard {
  fileprivate mutating func rename(_ r: Renames) {
    id = r.card(id)
    content.rename(r)
    for i in sidenotes.indices { sidenotes[i].rename(r) }
  }
}

extension Card {
  fileprivate mutating func rename(_ r: Renames) {
    id = r.card(id)
    if case .own(var c) = content {
      c.rename(r)
      content = .own(c)
    }
  }
}

extension CardContent {
  fileprivate mutating func rename(_ r: Renames) {
    description = description.map(r.markdown)
    switch body {
    case .note(var n):
      n.text = r.markdown(n.text)
      body = .note(n)
    case .text(var t):
      t.text = r.markdown(t.text)
      body = .text(t)
    case .board(let b):
      body = .board(SubBoard(board: r.boards[b.board] ?? b.board))
    case .code, .image, .web, .links: break
    }
  }
}

extension Arrow {
  fileprivate mutating func rename(_ r: Renames) {
    from.card = r.card(from.card)
    to.card = r.card(to.card)
  }
}

extension Sidenote {
  fileprivate mutating func rename(_ r: Renames) {
    if case .card(let c, let s, let l, let b) = anchor { anchor = .card(r.card(c), segment: s, lines: l, block: b) }
    if case .text(var t) = body {
      t.text = r.markdown(t.text)
      if var q = t.question {
        for i in q.answers.indices { q.answers[i].text = r.markdown(q.answers[i].text) }
        t.question = q
      }
      body = .text(t)
    }
  }
}

extension Sticker {
  fileprivate mutating func rename(_ r: Renames) {
    switch anchor {
    case .canvas: break
    case .card(let c, let x, let y, let size): anchor = .card(r.card(c), x: x, y: y, size: size)
    case .line(let c, let s, let l): anchor = .line(r.card(c), segment: s, line: l)
    }
  }
}

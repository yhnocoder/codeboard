import Foundation

// The one-way importer from the VS Code extension's storage folder (version 13 board files, as main writes them) into a
// vault. The only code that knows the old format. It never writes into the old folder. FORMAT.md lists what maps to what.

public enum LegacyImport {
  /// The version of the old files it reads; any other is refused
  public static let oldVersion = 13

  /// Imports every board and shared card of the old storage folder `source` into the vault at `destination`. A file that
  /// cannot be imported is listed in the report's failures and the rest go on; a board already in the vault (found by id,
  /// wherever it is now) is written again in place, so running it twice gives the same files
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
    try run.boards(inVault: inVault)
    return ImportReport(
      imported: run.entries.sorted { $0.source < $1.source }, failed: run.failed)
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
    public var skipped: [Skipped]
  }

  public struct Skipped: Equatable, Sendable {
    public var kind: SkipKind
    /// The old ids of what was left out (for a field: `<owner id>.<field>`; for an image: its file name)
    public var ids: [String]
    public var count: Int { ids.count }
  }

  /// Sorted by source
  public var imported: [Entry]
  public var failed: [LegacyImportError]
}

/// What the importer leaves out because model v1 has no place for it yet. The old files are never changed, so a later
/// import that knows it brings it in
public enum SkipKind: String, CaseIterable, Sendable {
  case sidenote, sticker, shelf
  case webCard, linksCard, compareCard, subBoardCard
  /// A card on no canvas that is not a Compare column (a shelved card)
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
  case summary
  /// An arrow's call, RPC, back or generated-from mark: the arrow is imported plain
  case callMark
  /// An arrow with an end on a card that was not imported or does not exist
  case arrowWithoutEnd
  /// A section or parent that does not exist: left out
  case danglingReference
  /// An image file the board names that is not in the old assets folder; the reference is kept
  case missingImage
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
        + "saved as version \(LegacyImport.oldVersion), then import again"
    case .newerVersion(let url, let v):
      "\(url.path) is a version \(v) board file, newer than this app imports (\(LegacyImport.oldVersion))"
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
  case imported(tilted: Bool, segments: Set<SegmentID>)
  case skipped(SkipKind)
}

private struct Run {
  let source: URL
  let vault: Vault
  var entries: [ImportReport.Entry] = []
  var failed: [LegacyImportError] = []
  var shared: [String: SharedState] = [:]

  init(source: URL, vault: Vault) {
    self.source = source
    self.vault = vault
  }

  mutating func sharedCards() throws {
    for file in jsonFiles(in: source.appending(path: "cards")) {
      let id = file.deletingPathExtension().lastPathComponent
      let rel = "cards/\(file.lastPathComponent)"
      do {
        guard Vault.isSafeID(id) else { throw Bad("\(id) cannot name a shared card") }
        let o = try oldFile(file)
        var m = Mapper()
        m.only(o, ["version", "card", "sidenotes"], id: id)
        for n in try o.optObjects("sidenotes") { m.skips.add(.sidenote, try n.string("id")) }
        guard case (let content, let tilted)? = try m.content(try o.object("card"), id: id) else {
          if let kind = m.skippedKind { shared[id] = .skipped(kind) }
          entries.append(.init(source: rel, destination: nil, skipped: m.skips.list))
          continue
        }
        let card = SharedCard(id: CardID(rawValue: id), content: content)
        if let p = content.problem() { throw Bad(p) }
        let out = vault.sharedFolderURL.appending(path: "\(id).json")
        try write(try card.encoded(), to: out)
        for name in try copyImages(m, into: vault.sharedFolderURL.appending(path: Vault.imagesFolder)) {
          m.skips.add(.missingImage, name)
        }
        var segments = Set<SegmentID>()
        if case .code(let code) = content.body { segments = Set(code.segments.map(\.id)) }
        shared[id] = .imported(tilted: tilted, segments: segments)
        let dest = "\(Vault.appDataFolder)/\(Vault.sharedFolder)/\(id).json"
        entries.append(.init(source: rel, destination: dest, skipped: m.skips.list))
      } catch let bad as Bad {
        failed.append(.malformed(file, bad.message))
      } catch let e as LegacyImportError {
        failed.append(e)
      }
    }
  }

  mutating func boards(inVault: [BoardID: String]) throws {
    var files = jsonFiles(in: source).map { (file: $0, group: "", rel: $0.lastPathComponent) }
    for dir in subfolders(of: source) where !reserved.contains(dir.lastPathComponent) {
      let group = dir.lastPathComponent
      files += jsonFiles(in: dir).map { (file: $0, group: group, rel: "\(group)/\($0.lastPathComponent)") }
    }
    files.sort { $0.rel < $1.rel }
    var seen: [BoardID: URL] = [:]
    for (file, group, rel) in files {
      do {
        let o = try oldFile(file)
        let stem = file.deletingPathExtension().lastPathComponent
        let own = try o.optString("id")
        guard let raw = [own, stem].compactMap({ $0 }).first(where: Vault.isSafeID) else {
          throw Bad("no usable board id")
        }
        let id = BoardID(rawValue: raw)
        if let other = seen[id] { throw LegacyImportError.duplicateBoardID(file, id, other: other) }
        seen[id] = file
        var m = Mapper()
        let board = try m.board(o, id: id, shared: shared)
        if let p = board.problem() { throw Bad(p) }
        let path: String
        if let existing = inVault[id] {
          path = existing
        } else {
          let folder = group.isEmpty ? "" : folderName(group)
          let name = freeName(Vault.packageName(for: try o.string("name")), in: folder)
          path = folder.isEmpty ? name : "\(folder)/\(name)"
        }
        let package = vault.url(of: path)
        try write(try board.encoded(), to: package.appending(path: Vault.boardFileName))
        for name in try copyImages(m, into: package.appending(path: Vault.imagesFolder)) {
          m.skips.add(.missingImage, name)
        }
        entries.append(.init(source: rel, destination: path, skipped: m.skips.list))
      } catch let bad as Bad {
        failed.append(.malformed(file, bad.message))
      } catch let e as LegacyImportError {
        failed.append(e)
      }
    }
  }

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

  /// Copies the images `m` found; returns the ones not in the old assets folder
  private func copyImages(_ m: Mapper, into folder: URL) throws -> [String] {
    let assets = source.appending(path: "assets")
    var missing: [String] = []
    for name in m.images.sorted() {
      guard let data = try? Data(contentsOf: assets.appending(path: name)) else {
        missing.append(name)
        continue
      }
      try write(data, to: folder.appending(path: name))
    }
    for (name, data) in m.dataImages.sorted(by: { $0.key < $1.key }) {
      try write(data, to: folder.appending(path: name))
    }
    return missing
  }

  /// Written only when it differs, so a re-import leaves unchanged files alone
  private func write(_ data: Data, to url: URL) throws {
    if (try? Data(contentsOf: url)) == data { return }
    do {
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: url, options: .atomic)
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

/// An old board or shared card file at the version this importer reads
private func oldFile(_ file: URL) throws -> Obj {
  let raw: Any
  do {
    raw = try JSONSerialization.jsonObject(with: Data(contentsOf: file))
  } catch {
    throw Bad("not JSON")
  }
  let o = try Obj(raw, path: "")
  let version = try o.optInt("version") ?? 1
  if version < LegacyImport.oldVersion { throw LegacyImportError.oldVersion(file, version) }
  if version > LegacyImport.oldVersion { throw LegacyImportError.newerVersion(file, version) }
  return o
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
  var skips = Skips()
  /// Old asset file names to copy
  var images: Set<String> = []
  /// Images that were data: URLs, by the file name they get
  var dataImages: [String: Data] = [:]
  /// Why the last content(…) gave nil
  var skippedKind: SkipKind?

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
        "hideNumbers", "shelf",
      ], id: bid)
    for n in try o.optObjects("sidenotes") { skips.add(.sidenote, try n.string("id")) }
    for s in try o.optObjects("stickers") { skips.add(.sticker, try s.string("id")) }
    for s in try o.optObjects("shelf") { skips.add(.shelf, try s.string("id")) }

    var sections = try o.objects("sections").map { try section($0) }
    let ids = Set(sections.map(\.id))
    for i in sections.indices {
      if let p = sections[i].parent, !ids.contains(p) {
        skips.add(.danglingReference, "\(sections[i].id.rawValue).parent")
        sections[i].parent = nil
      }
    }

    let place = try o.object("place")
    let oldCards = try o.objects("cards")
    var columns = Set<String>()
    for c in oldCards {
      if try c.string("kind") == "compare" { columns.formUnion(try c.strings("cols")) }
    }
    var cards: [Card] = []
    var codeSegments: [CardID: Set<SegmentID>] = [:]
    for c in oldCards {
      let cid = try c.string("id")
      guard let p = try place.optObject(cid) else {
        skips.add(columns.contains(cid) ? .compareCard : .unplacedCard, cid)
        continue
      }
      let content: Card.Content
      var tilted = false
      if try c.string("kind") == "shared" {
        only(c, ["id", "kind"], id: cid)
        switch shared[cid] {
        case .imported(let t, let segments)?:
          tilted = t
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
      }
      // mh is a height the board measured, written again whenever it is drawn
      only(p, ["x", "y", "w", "h", "mh", "section", "locked", "summary"], id: cid)
      if p.has("summary") { skips.add(.summary, cid) }
      var section = try p.optString("section").map(SectionID.init(rawValue:))
      if let s = section, !ids.contains(s) {
        skips.add(.danglingReference, "\(cid).section")
        section = nil
      }
      cards.append(
        Card(
          id: CardID(rawValue: cid), x: try p.double("x"), y: try p.double("y"), width: try p.double("w"),
          height: try p.optDouble("h"), section: section, locked: try p.flag("locked"), tilted: tilted,
          content: content))
    }

    var arrows: [Arrow] = []
    for l in try o.objects("links") {
      let a = try arrow(l)
      let ok = [a.from, a.to].allSatisfy { end in
        guard let segments = codeSegments[end.card] else {
          return end.segment == nil && cards.contains { $0.id == end.card }
        }
        return end.segment.map(segments.contains) ?? true
      }
      if ok { arrows.append(a) } else { skips.add(.arrowWithoutEnd, a.id.rawValue) }
    }
    return Board(
      id: id, cards: cards, arrows: arrows, sections: sections, hideComments: try o.flag("hideAllComments"),
      hideLineNumbers: try o.flag("hideNumbers"))
  }

  /// A card's content and whether it was tilted; nil (reported) for a kind model v1 does not hold
  mutating func content(_ c: Obj, id: String) throws -> (CardContent, tilted: Bool)? {
    skippedKind = nil
    let kind = try c.string("kind")
    let outOfScope: [String: SkipKind] = [
      "web": .webCard, "links": .linksCard, "compare": .compareCard, "board": .subBoardCard,
    ]
    if let k = outOfScope[kind] {
      skips.add(k, id)
      skippedKind = k
      return nil
    }
    if c.has("same") { skips.add(.twin, id) }
    let common: Set = ["id", "kind", "title", "desc", "procs", "tilt", "same"]
    let body: CardContent.Body
    switch kind {
    case "code":
      body = .code(try code(c, id: id))
      only(
        c, common.union(["segments", "hide", "wrap", "bg", "members", "mergedFrom", "gen", "variants", "active"]),
        id: id)
    case "note":
      body = .note(try note(c, id: id))
      only(
        c, common.union(["md", "look", "size", "bold", "fill", "hand", "weight", "level", "fs", "msg", "mdLayout"]),
        id: id)
    case "image":
      body = .image(try image(c))
      only(c, common.union(["src", "alt", "bg", "frame", "loop"]), id: id)
    default:
      throw Bad("\(c.at("kind")): unknown card kind \(kind)")
    }
    var processes: [ProcessTag] = []
    for p in try c.optObjects("procs") {
      only(p, ["text", "light"], id: "\(id).procs")
      processes.append(ProcessTag(text: try p.string("text"), light: try p.flag("light")))
    }
    let content = CardContent(
      title: try c.optString("title"), description: try c.optString("desc").map { markdown($0) },
      processes: processes, body: body)
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

  private mutating func note(_ c: Obj, id: String) throws -> Note {
    let look = try c.string("look")
    if c.has("msg") { skips.add(.messageNote, id) }
    let style: NoteStyle
    let used: Set<String>
    switch look {
    case "note":
      style = .note
      used = []
    case "text":
      style = .text(size: try c.pick("size", NoteStyle.TextSize.self) ?? .body, bold: try c.flag("bold"))
      used = ["size", "bold"]
    case "box":
      style = .box(fill: try c.pick("fill", NoteStyle.BoxFill.self) ?? .yellow)
      used = ["fill"]
    case "mark":
      style = .mark(
        color: try c.pick("hand", HandColor.self) ?? .blue,
        weight: try c.pick("weight", NoteStyle.HandWeight.self) ?? .regular, fontSize: try c.optDouble("fs"))
      used = ["hand", "weight", "fs"]
    case "freetext":
      style = .freeText(level: try c.optInt("level") ?? 0, bold: try c.flag("bold"), fontSize: try c.optDouble("fs"))
      used = ["level", "bold", "fs"]
    default:
      throw Bad("\(c.at("look")): unknown look \(look)")
    }
    for key in ["size", "bold", "fill", "hand", "weight", "level", "fs"] where c.has(key) && !used.contains(key) {
      skips.add(.field, "\(id).\(key)")
    }
    let text = try c.string("md")
    return Note(text: look == "freetext" ? text : markdown(text), style: style, layout: try layout(c, id: id))
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
    let src = try c.string("src")
    let source: ImageSource
    if src.hasPrefix("data:") {
      source = .file(try dataImage(src, at: c.at("src")))
    } else if src.hasPrefix("https://") || src.hasPrefix("http://") {
      source = .url(src)
    } else {
      let name = src.hasPrefix("assets/") ? String(src.dropFirst("assets/".count)) : src
      guard Vault.isFileName(name) else { throw Bad("\(c.at("src")): \(src) is not an image file name") }
      images.insert(name)
      source = .file(name)
    }
    let frame = try c.optInt("frame")
    return ImageCard(
      source: source, alt: try c.optString("alt"), framed: try c.flag("bg"), stillFrame: frame,
      loops: try c.flag("loop"))
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

  /// Old Markdown names images assets/<file>; in a vault they are in the images folder beside the JSON
  private mutating func markdown(_ md: String) -> String {
    md.replacing(/(^|[^\w\/.-])assets\/([\w-][\w.-]*)/.anchorsMatchLineEndings()) { m in
      images.insert(String(m.2))
      return "\(m.1)\(Vault.imagesFolder)/\(m.2)"
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
    if s.has("summary") || s.has("directSummary") { skips.add(.summary, id) }
    return Section(
      id: SectionID(rawValue: id), title: try s.string("title"), x: try s.double("x"), y: try s.double("y"),
      width: try s.double("w"), height: try s.double("h"),
      parent: try s.optString("parent").map(SectionID.init(rawValue:)), color: try s.optString("color"),
      collapsed: try s.flag("collapsed"), locked: try s.flag("locked"),
      description: try s.optString("desc").map { markdown($0) })
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
  /// [[first, last]…]; left out: none
  func ranges(_ key: String) throws -> [ClosedRange<Int>] {
    try (optArray(key) ?? []).enumerated().map { i, v in
      let here = "\(at(key))[\(i)]"
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

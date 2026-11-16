import CodeBoardModel
import Foundation

// What was saved, in a resource (FORMAT.md, Resources): one entry per address, `origin: web`; a link alone is an entry
// with no versions, each page saved whole one more Version, `content: page`. Pages saved elsewhere (the browser
// extension) come in from the newest down to where this Mac got to last time.

extension Vault {
  /// The address an entry is known by: the address as saved without its fragment, which is the same page; nothing
  /// else is made the same (scheme, case, www., a trailing slash and the query all count)
  public static func pageAddress(_ url: String) -> String {
    String(url.prefix { $0 != "#" })
  }

  /// `item` in the resource at `resource`, in the entry of its address, made when there is none: a link gives the
  /// entry its title, a page adds a version unless one has its hash already; `meta`, what was read of the page, takes
  /// the place of what the entry had. Nothing is written when nothing changes. The entry's path
  @discardableResult
  public func save(_ item: SavedItem, in resource: String, meta: WebMeta? = nil) throws -> String {
    let address = Vault.pageAddress(item.url)
    let found = try items(in: resource).lazy.compactMap { i -> (entry: Entry, path: String)? in
      guard case .entry(let e, let path) = i, case .web(let url) = e.origin, Vault.pageAddress(url) == address else {
        return nil
      }
      return (e, path)
    }.first
    var entry =
      found?.entry
      ?? Entry(
        id: EntryID(rawValue: Board.newID("e")), title: item.title, added: Double(item.savedAt),
        origin: .web(address))
    if let meta { entry.meta = meta }
    switch item.kind {
    case .link:
      entry.title = item.title
    case .page:
      guard let hash = item.pageHash, let bytes = item.bytes else {
        throw VaultError.unwritable(url(of: resource), "page \(item.id) was saved without its hash and size")
      }
      let has = entry.versions.contains {
        if case .page(hash, _, _) = $0.content { true } else { false }
      }
      if !has {
        var n = entry.versions.count + 1
        while entry.versions.contains(where: { $0.id.rawValue == "v\(n)" }) { n += 1 }
        entry.versions.append(
          Version(
            id: VersionID(rawValue: "v\(n)"), added: Double(item.savedAt), content: .page(hash: hash, bytes: Int(bytes))
          ))
      }
    }
    guard let found else { return try newEntry(entry, in: resource) }
    if entry != found.entry { try write(entry, at: found.path) }
    return found.path
  }
}

/// Where this Mac's import of saved pages got to: the newest `savedAt` taken in, and every item saved at that very
/// time that was, since others saved in the same millisecond may come after. Kept on the Mac, not in the vault
public struct PageWatermark: Codable, Equatable, Sendable {
  public var savedAt: Int64
  public var ids: [String]

  public init(savedAt: Int64, ids: [String]) {
    self.savedAt = savedAt
    self.ids = ids
  }

  /// None when the file is not there: nothing taken in yet
  public static func read(_ file: URL) throws -> PageWatermark? {
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    return try JSONDecoder().decode(PageWatermark.self, from: Data(contentsOf: file))
  }

  public func write(_ file: URL) throws {
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(self).write(to: file, options: .atomic)
  }
}

/// The items read from the newest down that are new since a watermark, and the watermark after them. An item saved
/// again is read again, newer: taken in again, it adds only what its entry lacks
public struct PageImport: Equatable, Sendable {
  private let start: PageWatermark?
  public private(set) var watermark: PageWatermark?
  /// Newest first, as read
  private var found: [SavedItem] = []

  public init(after watermark: PageWatermark?) {
    start = watermark
    self.watermark = watermark
  }

  /// What to take in, oldest first, so that the newest saving of an address is the last word
  public var new: [SavedItem] { found.reversed() }

  /// One page of items, newest first; false once one older than the watermark was read: none after it is new
  public mutating func take(_ items: [SavedItem]) -> Bool {
    for item in items {
      if let start {
        if item.savedAt < start.savedAt { return false }
        if item.savedAt == start.savedAt, start.ids.contains(item.id) { continue }
      }
      found.append(item)
      if let w = watermark, item.savedAt == w.savedAt {
        watermark?.ids.append(item.id)
      } else if watermark.map({ item.savedAt > $0.savedAt }) ?? true {
        watermark = PageWatermark(savedAt: item.savedAt, ids: [item.id])
      }
    }
    return true
  }

  /// What `store` saved since the watermark in the file `watermark`, saved in the resource at `resource`, then the
  /// file moved on (only then, so that an import cut short is done again, which adds nothing twice). How many items
  /// were taken in
  @discardableResult
  public static func run(
    from store: any PageStore, into vault: Vault, resource: String, watermark file: URL, pageSize: Int = 100
  ) async throws -> Int {
    var run = PageImport(after: try PageWatermark.read(file))
    var cursor: String?
    repeat {
      let page = try await store.items(kind: nil, after: cursor, limit: pageSize)
      guard run.take(page.items) else { break }
      cursor = page.next
    } while cursor != nil
    for item in run.new { try vault.save(item, in: resource) }
    if run.watermark != run.start, let w = run.watermark { try w.write(file) }
    return run.found.count
  }
}

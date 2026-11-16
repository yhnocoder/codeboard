import CodeBoardResources
import CryptoKit
import Foundation

/// The saving service in memory, as its interface describes it: one item per link address and one per page file,
/// saved again with a newer time; read newest first, the cursor an offset. Times are the test's
actor PageTestStore: PageStore {
  private(set) var saved: [SavedItem]
  private var files: [String: Data] = [:]
  private(set) var pinned: Set<String> = []
  private(set) var read: Set<String> = []
  var rulesByHost: [String: [Data]] = [:]
  /// The pages of `items` asked for
  private(set) var reads = 0
  /// What the next saving is saved at, one later each time
  var now: Int64

  init(_ saved: [SavedItem] = [], now: Int64 = 1_000) {
    self.saved = saved
    self.now = now
  }

  func saveLink(_ meta: PageLink) -> SavedItem {
    save(SavedItem(id: "link-\(saved.count)", kind: .link, url: meta.url, title: meta.title, savedAt: 0)) {
      $0.kind == .link && $0.url == meta.url
    }
  }

  func savePage(_ meta: PageCapture, file: URL) throws -> SavedItem {
    let data = try Data(contentsOf: file)
    let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    files[hash] = data
    let item = SavedItem(
      id: "page-\(saved.count)", kind: .page, url: meta.url, title: meta.title, savedAt: 0, pageHash: hash,
      bytes: Int64(data.count))
    return save(item) { $0.pageHash == hash }
  }

  private func save(_ new: SavedItem, same: (SavedItem) -> Bool) -> SavedItem {
    var item = saved.first(where: same) ?? new
    item.title = new.title
    item.savedAt = now
    now += 1
    saved.removeAll { $0.id == item.id }
    saved.append(item)
    return item
  }

  func items(kind: SavedItem.Kind?, after: String?, limit: Int) -> SavedItems {
    reads += 1
    // stable: of the same time, the one saved later first
    let all = saved.reversed().sorted { $0.savedAt > $1.savedAt }.filter { kind == nil || $0.kind == kind }
    let from = after.flatMap(Int.init) ?? 0
    let to = min(all.count, from + limit)
    return SavedItems(items: Array(all[from..<to]), next: to < all.count ? String(to) : nil)
  }

  struct Missing: Error { var hash: String }

  func writePage(hash: String, to: URL) throws -> Int64 {
    guard let data = files[hash] else { throw Missing(hash: hash) }
    try data.write(to: to)
    read.insert(hash)
    return Int64(data.count)
  }

  func pin(id: String, pinned on: Bool) {
    if on { pinned.insert(id) } else { pinned.remove(id) }
  }

  func rules(forHost host: String) -> [Data] { rulesByHost[host] ?? [] }
  func putRule(domain: String, _ rules: Data) {}
  func setVault(_ folder: URL?) {}
}

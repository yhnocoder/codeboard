import AppKit
import CodeBoardModel

/// Which boards have cards taken from each entry: a card whose source names it, or an image card whose picture is one
/// of its blocks, on the canvas or the shelf, a shared card's from its own file. Read off the main thread; a board or
/// shared card file is read again only when its modification date or size changed
actor EntryBoards {
  static let shared = EntryBoards()

  private struct Read {
    var stamp: Stamp
    var entries: Set<EntryID>
    var shared: Set<CardID>
  }

  private struct Stamp: Equatable {
    var date: Date?
    var size: Int?
  }

  private var files: [URL: Read] = [:]

  /// The titles of the boards (in tree order) each entry has cards on
  func lookup(_ vault: Vault, _ boards: [VaultBoard]) -> [EntryID: [String]] {
    var out: [EntryID: [String]] = [:]
    for b in boards {
      let own = read(vault.url(of: b.path).appending(path: Vault.boardFileName)) {
        let board = try vault.board(at: b.path)
        let cards = board.cards + board.shelf.flatMap(\.cards)
        let content = cards.compactMap { if case .own(let c) = $0.content { c } else { nil } }
        return (Set(content.flatMap(Self.entries)), Set(cards.filter { $0.content == .shared }.map(\.id)))
      }
      var entries = own.entries
      for id in own.shared {
        entries.formUnion(
          read(vault.sharedFolderURL.appending(path: "\(id.rawValue).json")) {
            (Set(Self.entries(try vault.sharedCard(id).content)), [])
          }.entries)
      }
      for e in entries { out[e, default: []].append(b.title) }
    }
    return out
  }

  /// What a file says, read again only when it changed; an unreadable file names nothing
  private func read(_ url: URL, _ parse: () throws -> (Set<EntryID>, Set<CardID>)) -> Read {
    let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
    let stamp = Stamp(date: attrs?[.modificationDate] as? Date, size: (attrs?[.size] as? NSNumber)?.intValue)
    if let r = files[url], r.stamp == stamp { return r }
    let (entries, shared) = (try? parse()) ?? ([], [])
    let r = Read(stamp: stamp, entries: entries, shared: shared)
    files[url] = r
    return r
  }

  static func entries(_ c: CardContent) -> [EntryID] {
    var out = c.source.map { [$0.entry] } ?? []
    if case .image(let i) = c.body, case .resource(let a) = i.source { out.append(a.entry) }
    return out
  }

  /// As many names as fit in `width`, then how many more: "Board A, Board B +2"; the first name cut short when even it
  /// does not fit
  static func fit(_ names: [String], width: CGFloat, font: NSFont) -> String {
    let attrs: [NSAttributedString.Key: Any] = [.font: font]
    for k in stride(from: names.count, to: 0, by: -1) {
      let s = names.prefix(k).joined(separator: ", ") + (k < names.count ? " +\(names.count - k)" : "")
      if (s as NSString).size(withAttributes: attrs).width <= width { return s }
    }
    return names.first.map { names.count > 1 ? "\($0) +\(names.count - 1)" : $0 } ?? ""
  }
}

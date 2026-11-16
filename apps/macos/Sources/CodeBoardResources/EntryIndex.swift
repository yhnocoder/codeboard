import CodeBoardModel
import Foundation

/// Every entry of the vault's resources by its id, with its folder's path: how a tab or a card's source finds an entry
/// wherever its folder went. Made from a tree read, each resource's entries read once
public struct EntryIndex: Sendable {
  public struct Found: Equatable, Sendable {
    public var entry: Entry
    /// The entry's folder, relative to the vault
    public var path: String

    public init(entry: Entry, path: String) {
      self.entry = entry
      self.path = path
    }
  }

  private var byID: [EntryID: Found] = [:]

  public init() {}

  // ponytail: every entry file read again on each tree read; keep the last read per resource when vaults grow large
  public init(_ vault: Vault, _ tree: VaultFolder) {
    for r in tree.allFolders.flatMap(\.resources) {
      for case .entry(let e, let path) in (try? vault.items(in: r.path)) ?? [] where byID[e.id] == nil {
        byID[e.id] = Found(entry: e, path: path)
      }
    }
  }

  public subscript(_ id: EntryID) -> Found? { byID[id] }

  /// The entry of the arXiv paper `id` (without a version), the first by its folder's path when there are several
  public func arxiv(_ id: String) -> Found? { all.first { $0.entry.origin == .arxiv(id) } }

  /// The entry of the paper with the DOI `doi`, compared lowercased, the first by its folder's path when there are
  /// several
  public func doi(_ doi: String) -> Found? {
    all.first { if case .doi(let d)? = $0.entry.origin { d.lowercased() == doi.lowercased() } else { false } }
  }

  /// Every entry, by its folder's path
  public var all: [Found] { byID.values.sorted { $0.path < $1.path } }

  /// An entry just written, before the tree is read again
  public mutating func update(_ entry: Entry, at path: String) { byID[entry.id] = Found(entry: entry, path: path) }
}

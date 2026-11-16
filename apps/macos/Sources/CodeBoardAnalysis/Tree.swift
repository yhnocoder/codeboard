import TreeSitterCore

// tree-sitter for the analysis, as packages/analysis/src/tree.ts has it, on TreeSitterCore's trees: every index and
// column is a UTF-16 code unit, as JavaScript's strings count them. A TreeCache keeps the last tree of each key (usually
// a file path): when the text changed it is edited and parsed incrementally, when it did not it is reused.

extension Grammar {
  var language: Language {
    switch self {
    case .python: .python
    case .cpp: .cuda
    case .rust: .rust
    }
  }

  /// The tree of a text, reusing what of old (edited to match the text already) did not change
  func parse(_ units: [UInt16], old: SyntaxTree? = nil) -> SyntaxTree {
    guard let tree = language.parse(units, old: old) else {
      preconditionFailure("the \(self) grammar does not fit this tree-sitter")
    }
    return tree
  }
}

extension Query {
  // The analysis's queries match plain words with #match?, which read the same in ICU's regular expressions as in
  // JavaScript's
  convenience init(_ g: Grammar, _ source: String) {
    do {
      try self.init(g.language, source)
    } catch {
      preconditionFailure("query for \(g): \(error)")
    }
  }
}

/// Whether an edit can turn a into b (only the lengths and the parts it leaves alone are checked)
private func fits(_ a: [UInt16], _ b: [UInt16], _ e: TreeEdit) -> Bool {
  0 <= e.startIndex && e.startIndex <= e.oldEndIndex && e.oldEndIndex <= a.count && e.startIndex <= e.newEndIndex
    && e.newEndIndex <= b.count && a.count - e.oldEndIndex == b.count - e.newEndIndex
    && a[..<e.startIndex] == b[..<e.startIndex] && a[e.oldEndIndex...] == b[e.newEndIndex...]
}

/// The trees kept between parses of the same key (usually a file path), least recently used first out. Keyed by path,
/// not by content, so each host keeps its own: one host's files must not evict or forget another's.
public final class TreeCache {
  private struct Entry {
    let g: Grammar
    let tree: SyntaxTree
  }

  /// How many trees to keep (each takes a few times the source's memory)
  public let max: Int
  private var trees: [String: Entry] = [:]
  /// Least recently used first
  private var order: [String] = []

  public init(max: Int = 16) { self.max = max }

  /// The tree of a text, kept under key: parsed incrementally when the key's last text differs (by edit, or by the
  /// common prefix and suffix when edit is missing or does not fit)
  func tree(_ g: Grammar, _ units: [UInt16], key: String, edit: TreeEdit?) -> SyntaxTree {
    let tree: SyntaxTree
    if let old = trees[key] {
      remove(key)
      if old.g == g && old.tree.units == units {
        tree = old.tree
      } else if old.g == g {
        old.tree.edit(edit.flatMap { fits(old.tree.units, units, $0) ? $0 : nil } ?? diffEdit(old.tree.units, units))
        tree = g.parse(units, old: old.tree)
      } else {
        tree = g.parse(units)
      }
    } else {
      tree = g.parse(units)
    }
    trees[key] = Entry(g: g, tree: tree)
    order.append(key)
    while order.count > max { remove(order[0]) }
    return tree
  }

  /// Let go of key's tree, or of all of them
  public func forget(_ key: String? = nil) {
    for k in order where key == nil || k == key { remove(k) }
  }

  /// The keys kept, least recently used first
  public var keys: [String] { order }

  private func remove(_ key: String) {
    trees[key] = nil
    order.removeAll { $0 == key }
  }
}

/// Where a parse keeps its tree: the cache, the key, and optionally the edit from the key's last text to this one
public struct TreeAt {
  public var cache: TreeCache
  public var key: String
  public var edit: TreeEdit?

  public init(cache: TreeCache, key: String, edit: TreeEdit? = nil) {
    self.cache = cache
    self.key = key
    self.edit = edit
  }
}

/// The tree of a text: kept in at's cache, or, without one, parsed for this call alone
func treeOf(_ g: Grammar, _ units: [UInt16], _ at: TreeAt?) -> SyntaxTree {
  guard let at, at.cache.max > 0 else { return g.parse(units) }
  return at.cache.tree(g, units, key: at.key, edit: at.edit)
}

/// Where lines went when a text changed, found by their content (the TypeScript side's mapLines, fuzzy): a line
/// still there goes where it is now; of a run of lines removed and added in its place, a removed line similar to an
/// added one goes to it, those between such pairs pair side by side, and the rest are gone
public struct LineAnchors: Sendable {
  private let map: [Int: Int]

  /// `oldStart`, `newStart`: the line numbers of the first lines
  public init(from old: [String], start oldStart: Int = 1, to new: [String], start newStart: Int = 1) {
    var map: [Int: Int] = [:]
    for (l, r) in LineAnchors.pairs(old, new) { map[oldStart + l] = newStart + r }
    self.map = map
  }

  /// An old line's line now; nil: it is gone
  public func line(_ old: Int) -> Int? { map[old] }

  /// A run of old lines now: from the first to the last of them still there; nil: all gone
  public func range(_ old: ClosedRange<Int>) -> ClosedRange<Int>? {
    let now = old.compactMap { map[$0] }
    guard let lo = now.min(), let hi = now.max() else { return nil }
    return lo...hi
  }

  /// Old and new indices that pair (diff.ts alignRows: its same and changed rows)
  static func pairs(_ a: [String], _ b: [String]) -> [(Int, Int)] {
    // a long diff gives up past this many edits: all removed, all added (diff.ts diffLines)
    let cap = max(1000, Int(4e7 / Double(a.count + b.count + 1)))
    let runs = diff(a, b, maxEdit: cap) ?? [(.removed, a.count), (.added, b.count)]
    var out: [(Int, Int)] = []
    var i = 0
    var j = 0
    var k = 0
    while k < runs.count {
      if runs[k].op == .same {
        for _ in 0..<runs[k].count {
          out.append((i, j))
          i += 1
          j += 1
        }
        k += 1
        continue
      }
      var dels: [Int] = []
      var adds: [Int] = []
      while k < runs.count, runs[k].op != .same {
        for _ in 0..<runs[k].count {
          if runs[k].op == .removed {
            dels.append(i)
            i += 1
          } else {
            adds.append(j)
            j += 1
          }
        }
        k += 1
      }
      // in order: a removed line with a similar added one within the next 12 pairs with it, those between them side by
      // side
      var p = 0
      var q = 0
      func side(_ pe: Int, _ qe: Int) {
        while p < pe && q < qe {
          out.append((dels[p], adds[q]))
          p += 1
          q += 1
        }
        p = max(p, pe)
        q = max(q, qe)
      }
      for d in dels.indices where d >= p {
        guard let t = (q..<min(adds.count, q + 12)).first(where: { similar(a[dels[d]], b[adds[$0]]) }) else { continue }
        side(d, t)
        out.append((dels[p], adds[q]))
        p += 1
        q += 1
      }
      side(dels.count, adds.count)
    }
    return out
  }

  /// Two lines share at least a third of their words: runs of ASCII letters, digits and _ (diff.ts similar, JavaScript's
  /// \w); two lines without words are similar when both are blank
  static func similar(_ x: String, _ y: String) -> Bool {
    let tx = Set(words(x))
    let ty = words(y)
    if tx.isEmpty || ty.isEmpty { return blank(x) && blank(y) }
    let common = ty.filter { tx.contains($0) }.count
    return Double(common) / Double(max(tx.count, ty.count)) >= 0.34
  }

  private static func words(_ s: String) -> [Substring] {
    s.utf8.split {
      !($0 == 0x5f || (0x30...0x39).contains($0) || (0x41...0x5a).contains($0) || (0x61...0x7a).contains($0))
    }
    .map { Substring($0) }
  }

  /// Only JavaScript's white space and line ends (its String.trim)
  private static func blank(_ s: String) -> Bool {
    s.utf16.allSatisfy { u in
      switch u {
      case 0x09...0x0d, 0x20, 0xa0, 0x1680, 0x2000...0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff: true
      default: false
      }
    }
  }

  enum Op { case same, removed, added }

  /// jsdiff's diffArrays (diff 9.0.0 base.js), its choices kept so the same lines pair: Myers's shortest edit script,
  /// branching from the path farthest along the old lines, the diagonals past an edge of the graph left out. Runs of
  /// equal, removed and added lines in order; nil past `maxEdit` edits
  static func diff(_ old: [String], _ new: [String], maxEdit: Int) -> [(op: Op, count: Int)]? {
    final class Run {
      let op: Op
      let count: Int
      let previous: Run?
      init(_ op: Op, _ count: Int, _ previous: Run?) {
        self.op = op
        self.count = count
        self.previous = previous
      }
    }
    struct Path {
      var oldPos: Int
      var last: Run?
    }
    let oldLen = old.count
    let newLen = new.count
    func equal(_ x: String, _ y: String) -> Bool { x.utf8.elementsEqual(y.utf8) }
    func common(_ path: inout Path, _ diagonal: Int) -> Int {
      var o = path.oldPos
      var n = o - diagonal
      var count = 0
      while n + 1 < newLen && o + 1 < oldLen && equal(old[o + 1], new[n + 1]) {
        n += 1
        o += 1
        count += 1
      }
      if count > 0 { path.last = Run(.same, count, path.last) }
      path.oldPos = o
      return n
    }
    func step(_ path: Path, _ op: Op, _ oldInc: Int) -> Path {
      if let last = path.last, last.op == op {
        return Path(oldPos: path.oldPos + oldInc, last: Run(op, last.count + 1, last.previous))
      }
      return Path(oldPos: path.oldPos + oldInc, last: Run(op, 1, path.last))
    }
    func runs(_ last: Run?) -> [(op: Op, count: Int)] {
      var out: [(op: Op, count: Int)] = []
      var r = last
      while let c = r {
        out.append((c.op, c.count))
        r = c.previous
      }
      return out.reversed()
    }
    var first = Path(oldPos: -1, last: nil)
    var newPos = common(&first, 0)
    if first.oldPos + 1 >= oldLen && newPos + 1 >= newLen { return runs(first.last) }
    var best: [Int: Path] = [0: first]
    var minDiagonal = Int.min
    var maxDiagonal = Int.max
    let most = min(oldLen + newLen, maxEdit)
    var length = 1
    while length <= most {
      var d = max(minDiagonal, -length)
      while d <= min(maxDiagonal, length) {
        defer { d += 2 }
        let remove = best[d - 1]
        let add = best[d + 1]
        if remove != nil { best[d - 1] = nil }
        var canAdd = false
        if let add {
          let n = add.oldPos - d
          canAdd = 0 <= n && n < newLen
        }
        let canRemove = remove.map { $0.oldPos + 1 < oldLen } ?? false
        if !canAdd && !canRemove {
          best[d] = nil
          continue
        }
        var base: Path
        if let add, !canRemove || (canAdd && remove.map { $0.oldPos < add.oldPos } ?? true) {
          base = step(add, .added, 0)
        } else if let remove {
          base = step(remove, .removed, 1)
        } else {
          continue
        }
        newPos = common(&base, d)
        if base.oldPos + 1 >= oldLen && newPos + 1 >= newLen { return runs(base.last) }
        best[d] = base
        if base.oldPos + 1 >= oldLen { maxDiagonal = min(maxDiagonal, d - 1) }
        if newPos + 1 >= newLen { minDiagonal = max(minDiagonal, d + 1) }
      }
      length += 1
    }
    return nil
  }
}

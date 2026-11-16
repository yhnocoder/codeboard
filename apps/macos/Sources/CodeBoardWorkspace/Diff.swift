import CodeBoardAnalysis
import Foundation

// core's diffLines: a line diff by jsdiff's diffArrays (diff 9.0.0, lib/diff/base.js), ported step by step so that
// where several shortest edit scripts exist it picks the one the TypeScript picks (onlyHiddenChanged reads which
// lines it calls changed).

public struct DiffLine: Hashable, Sendable {
  public enum Op: String, Hashable, Sendable {
    case same = " "
    case add = "+"
    case del = "-"
  }

  public var op: Op
  public var text: String
  /// Line numbers, from each side's start
  public var a: Int?
  public var b: Int?
}

/// Myers is O((n+m)·D): the edit count is capped, so two very different texts are one deletion and one insertion
public func diffLines(_ a: [String], _ b: [String], aStart: Int = 1, bStart: Int = 1) -> [DiffLine] {
  let cap = max(1000, Int((4e7 / Double(a.count + b.count + 1)).rounded(.down)))
  let runs = arrayDiff(a, b, maxEditLength: cap) ?? [(a.count, false, true), (b.count, true, false)]
  var out: [DiffLine] = []
  var i = 0
  var j = 0
  for (count, added, removed) in runs {
    for _ in 0..<count {
      if removed {
        out.append(DiffLine(op: .del, text: a[i], a: aStart + i))
        i += 1
      } else if added {
        out.append(DiffLine(op: .add, text: b[j], b: bStart + j))
        j += 1
      } else {
        out.append(DiffLine(op: .same, text: a[i], a: aStart + i, b: bStart + j))
        i += 1
        j += 1
      }
    }
  }
  return out
}

// A component is an index into the arena of components, so that long chains are not freed by recursion
private struct Component {
  let count: Int
  let added: Bool
  let removed: Bool
  let previous: Int?
}

private struct DiffPath {
  var oldPos: Int
  var last: Int?
}

/// The runs (count, added, removed) from old to new; nil when more than maxEditLength edits are needed
private func arrayDiff(_ oldLines: [String], _ newLines: [String], maxEditLength: Int) -> [(Int, Bool, Bool)]? {
  // Lines as numbers, equal when their UTF-16 code units are (JavaScript's ===)
  var ids: [[UInt16]: Int] = [:]
  let id = { (s: String) -> Int in
    let k = Array(s.utf16)
    if let n = ids[k] { return n }
    ids[k] = ids.count
    return ids.count - 1
  }
  let old = oldLines.map(id)
  let new = newLines.map(id)
  let oldLen = old.count
  let newLen = new.count
  let maxEdit = min(newLen + oldLen, maxEditLength)

  var arena: [Component] = []
  func component(_ count: Int, _ added: Bool, _ removed: Bool, _ previous: Int?) -> Int {
    arena.append(Component(count: count, added: added, removed: removed, previous: previous))
    return arena.count - 1
  }

  func extractCommon(_ base: inout DiffPath, _ diagonal: Int) -> Int {
    var oldPos = base.oldPos
    var newPos = oldPos - diagonal
    var common = 0
    while newPos + 1 < newLen && oldPos + 1 < oldLen && old[oldPos + 1] == new[newPos + 1] {
      newPos += 1
      oldPos += 1
      common += 1
    }
    if common > 0 { base.last = component(common, false, false, base.last) }
    base.oldPos = oldPos
    return newPos
  }

  func addToPath(_ path: DiffPath, added: Bool, removed: Bool, oldPosInc: Int) -> DiffPath {
    if let i = path.last, arena[i].added == added, arena[i].removed == removed {
      return DiffPath(
        oldPos: path.oldPos + oldPosInc, last: component(arena[i].count + 1, added, removed, arena[i].previous))
    }
    return DiffPath(oldPos: path.oldPos + oldPosInc, last: component(1, added, removed, path.last))
  }

  func values(_ last: Int?) -> [(Int, Bool, Bool)] {
    var out: [(Int, Bool, Bool)] = []
    var c = last
    while let i = c {
      out.append((arena[i].count, arena[i].added, arena[i].removed))
      c = arena[i].previous
    }
    return out.reversed()
  }

  // Diagonals -(maxEdit + 1)…maxEdit + 1, stored from offset 0
  let offset = maxEdit + 1
  var best = [DiffPath?](repeating: nil, count: 2 * offset + 1)
  var seed = DiffPath(oldPos: -1, last: nil)
  var newPos = extractCommon(&seed, 0)
  if seed.oldPos + 1 >= oldLen && newPos + 1 >= newLen { return values(seed.last) }
  best[offset] = seed

  var minDiagonal = Int.min
  var maxDiagonal = Int.max
  var editLength = 1
  while editLength <= maxEdit {
    var diagonal = max(minDiagonal, -editLength)
    while diagonal <= min(maxDiagonal, editLength) {
      defer { diagonal += 2 }
      let removePath = best[offset + diagonal - 1]
      let addPath = best[offset + diagonal + 1]
      if removePath != nil { best[offset + diagonal - 1] = nil }
      var canAdd = false
      if let addPath {
        let addNewPos = addPath.oldPos - diagonal
        canAdd = 0 <= addNewPos && addNewPos < newLen
      }
      let canRemove = removePath.map { $0.oldPos + 1 < oldLen } ?? false
      if !canAdd && !canRemove {
        best[offset + diagonal] = nil
        continue
      }
      var base: DiffPath
      if !canRemove || (canAdd && removePath!.oldPos < addPath!.oldPos) {
        base = addToPath(addPath!, added: true, removed: false, oldPosInc: 0)
      } else {
        base = addToPath(removePath!, added: false, removed: true, oldPosInc: 1)
      }
      newPos = extractCommon(&base, diagonal)
      if base.oldPos + 1 >= oldLen && newPos + 1 >= newLen { return values(base.last) }
      best[offset + diagonal] = base
      if base.oldPos + 1 >= oldLen { maxDiagonal = min(maxDiagonal, diagonal - 1) }
      if newPos + 1 >= newLen { minDiagonal = max(minDiagonal, diagonal + 1) }
    }
    editLength += 1
  }
  return nil
}

// core's alignRows, wordDiff and mapLines: two versions of a run of lines side by side, the words that changed in a
// line, and where each old line went

/// One row of two columns (core's AlignRow): l and r are 0-based indices into each side
public struct AlignRow: Hashable, Sendable {
  public enum Kind: Hashable, Sendable {
    /// The same on both sides
    case same
    /// On both sides, but not the same
    case changed
    /// Only on the left or only on the right
    case left, right
  }

  public var kind: Kind
  public var l: Int?
  public var r: Int?
}

/// Two runs of lines side by side: the same lines on one row; deletions and additions in between paired as changed,
/// similar lines first (in order, never crossing), the rest by position, only what one side has left over alone
public func alignRows(_ a: [String], _ b: [String]) -> [AlignRow] {
  let d = diffLines(a, b, aStart: 0, bStart: 0)
  var rows: [AlignRow] = []
  var k = 0
  while k < d.count {
    if d[k].op == .same {
      rows.append(AlignRow(kind: .same, l: d[k].a, r: d[k].b))
      k += 1
      continue
    }
    var dels: [Int] = []
    var adds: [Int] = []
    while k < d.count && d[k].op != .same {
      if d[k].op == .del { dels.append(d[k].a!) } else { adds.append(d[k].b!) }
      k += 1
    }
    var i = 0
    var j = 0
    func side(_ ie: Int, _ je: Int) {
      while i < ie && j < je {
        rows.append(AlignRow(kind: .changed, l: dels[i], r: adds[j]))
        i += 1
        j += 1
      }
      while i < ie {
        rows.append(AlignRow(kind: .left, l: dels[i]))
        i += 1
      }
      while j < je {
        rows.append(AlignRow(kind: .right, r: adds[j]))
        j += 1
      }
    }
    for p in dels.indices where p >= i {
      guard let q = (j..<min(adds.count, j + 12)).first(where: { similar(a[dels[p]], b[adds[$0]]) }) else { continue }
      side(p, q)
      rows.append(AlignRow(kind: .changed, l: dels[i], r: adds[j]))
      i += 1
      j += 1
    }
    side(dels.count, adds.count)
  }
  return rows
}

private func isWordUnit(_ u: UInt16) -> Bool {
  (u >= 48 && u <= 57) || (u >= 65 && u <= 90) || (u >= 97 && u <= 122) || u == 95
}

private func isSpaceUnit(_ u: UInt16) -> Bool {
  switch u {
  case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
  default: false
  }
}

/// /\w+|\s+|[^\w\s]/g over UTF-16 code units, each token as its units
private func tokens(_ s: String) -> [[UInt16]] {
  let u = Array(s.utf16)
  var out: [[UInt16]] = []
  var i = 0
  while i < u.count {
    var j = i + 1
    if isWordUnit(u[i]) {
      while j < u.count && isWordUnit(u[j]) { j += 1 }
    } else if isSpaceUnit(u[i]) {
      while j < u.count && isSpaceUnit(u[j]) { j += 1 }
    }
    out.append(Array(u[i..<j]))
    i = j
  }
  return out
}

/// A third of the words in common
private func similar(_ x: String, _ y: String) -> Bool {
  let words = { (t: [UInt16]) in t.contains(where: isWordUnit) }
  let tx = Set(tokens(x).filter(words))
  let ty = tokens(y).filter(words)
  if tx.isEmpty || ty.isEmpty { return jsTrim(x).isEmpty && jsTrim(y).isEmpty }
  let common = ty.filter { tx.contains($0) }.count
  return Double(common) / Double(max(tx.count, ty.count)) >= 0.34
}

/// The characters that changed in each of two lines, as UTF-16 offsets [start, end), by a diff of their words
public func wordDiff(_ x: String, _ y: String) -> (a: [Range<Int>], b: [Range<Int>]) {
  let tx = tokens(x)
  let ty = tokens(y)
  let d = diffLines(
    tx.map { String(decoding: $0, as: UTF16.self) }, ty.map { String(decoding: $0, as: UTF16.self) }, aStart: 0,
    bStart: 0)
  func ends(_ ts: [[UInt16]]) -> [Int] {
    var p = [0]
    for t in ts { p.append(p[p.count - 1] + t.count) }
    return p
  }
  let px = ends(tx)
  let py = ends(ty)
  var a: [Range<Int>] = []
  var b: [Range<Int>] = []
  func push(_ rs: inout [Range<Int>], _ s: Int, _ e: Int) {
    if let last = rs.last, last.upperBound == s { rs[rs.count - 1] = last.lowerBound..<e } else { rs.append(s..<e) }
  }
  for l in d {
    if l.op == .del { push(&a, px[l.a!], px[l.a! + 1]) }
    if l.op == .add { push(&b, py[l.b!], py[l.b! + 1]) }
  }
  return (a, b)
}

/// Where each old line is in the new lines, by line number: the same lines (the diff's), and with `fuzzy` a changed
/// line paired with one (alignRows' changed); a line not there is not in the map
public func mapLines(_ old: [String], _ oldStart: Int, _ new: [String], _ newStart: Int, fuzzy: Bool = true) -> [Int:
  Int]
{
  var map: [Int: Int] = [:]
  if fuzzy {
    for r in alignRows(old, new) { if let l = r.l, let n = r.r { map[oldStart + l] = newStart + n } }
  } else {
    for d in diffLines(old, new, aStart: oldStart, bStart: newStart) where d.op == .same { map[d.a!] = d.b! }
  }
  return map
}

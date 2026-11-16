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

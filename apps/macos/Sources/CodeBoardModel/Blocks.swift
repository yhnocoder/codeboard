import Foundation

// Arrow ends and sidenotes on a Note's block follow that block when the Note is rewritten (core edit/blocks.ts): blocks
// are matched by fingerprint, and a rewritten one by kind and likeness. The Markdown is split into blocks by the Note
// page (@yhnocoder/markdown's mdBlockStarts), so they are the blocks on screen; nothing here parses Markdown.

extension BlockRef {
  /// A block's fingerprint (core blockSig): FNV-1a of its Markdown without the white space around it, in base 36
  public static func sig(_ source: String) -> String {
    var h: UInt32 = 2_166_136_261
    for u in source.trimmingCharacters(in: .whitespacesAndNewlines).utf16 { h = (h ^ UInt32(u)) &* 16_777_619 }
    return String(h, radix: 36)
  }

  /// The block it is on in `sigs` (core blockAt): the one at its index when the fingerprint matches, else the nearest
  /// one with that fingerprint; nil when there is none
  public func at(_ sigs: [String]) -> Int? {
    if index >= 0, index < sigs.count, sigs[index] == hash { return index }
    var best: Int?
    for (k, s) in sigs.enumerated() where s == hash {
      if best.map({ abs(k - index) < abs($0 - index) }) ?? true { best = k }
    }
    return best
  }
}

enum Blocks {
  /// What kind of block its Markdown starts as: a rewrite one for one is only matched within a kind
  static func kind(_ src: String) -> String {
    let t = src.drop { $0.isWhitespace }
    for p in ["```", "~~~", "$$", ">", "|", "!["] where t.hasPrefix(p) { return p }
    var hashes = 0
    while hashes < t.count, t[t.index(t.startIndex, offsetBy: hashes)] == "#" { hashes += 1 }
    if (1...6).contains(hashes), t.dropFirst(hashes).first?.isWhitespace == true {
      return String(repeating: "#", count: hashes)
    }
    if let c = t.first, "-*+".contains(c), t.dropFirst().first?.isWhitespace == true { return String(c) }
    let digits = t.prefix { $0.isASCII && $0.isNumber }
    if !digits.isEmpty {
      let rest = t.dropFirst(digits.count)
      if let c = rest.first, c == "." || c == ")", rest.dropFirst().first?.isWhitespace == true { return "1\(c)" }
    }
    return "p"
  }

  /// How alike two blocks read (the Dice coefficient of their character pairs; Chinese has no spaces to split at): 0…1
  static func likeness(_ x: String, _ y: String) -> Double {
    func grams(_ s: String) -> [UInt32: Int] {
      let t = Array(
        s.lowercased().split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").utf16)
      var m: [UInt32: Int] = [:]
      if t.count > 1 { for i in 0..<(t.count - 1) { m[UInt32(t[i]) << 16 | UInt32(t[i + 1]), default: 0] += 1 } }
      return m
    }
    let a = grams(x)
    let c = grams(y)
    let na = a.values.reduce(0, +)
    let nc = c.values.reduce(0, +)
    var both = 0
    for (g, v) in c { both += min(v, a[g] ?? 0) }
    guard na + nc > 0 else {
      return x.trimmingCharacters(in: .whitespacesAndNewlines) == y.trimmingCharacters(in: .whitespacesAndNewlines)
        ? 1 : 0
    }
    return Double(2 * both) / Double(na + nc)
  }

  /// A rewritten block is still the same one when it reads at least this alike
  static let like = 0.3

  /// A Note's blocks old → new (core blockMap; nil: that block is gone): blocks not changed are matched by fingerprint
  /// (Myers); within a run of changes between two of them, one block for one of the same kind is its rewrite, and
  /// otherwise each goes to the new one that reads most like it, if alike enough
  static func map(_ old: [String], _ now: [String]) -> [Int?] {
    var out = [Int?](repeating: nil, count: old.count)
    let diff = now.map(BlockRef.sig).difference(from: old.map(BlockRef.sig))
    var removed = Set<Int>()
    var inserted = Set<Int>()
    for c in diff {
      switch c {
      case .remove(let o, _, _): removed.insert(o)
      case .insert(let o, _, _): inserted.insert(o)
      }
    }
    var i = 0
    var j = 0
    while i < old.count || j < now.count {
      if i < old.count, j < now.count, !removed.contains(i), !inserted.contains(j) {
        out[i] = j
        i += 1
        j += 1
        continue
      }
      var dels: [Int] = []
      var adds: [Int] = []
      while (i < old.count && removed.contains(i)) || (j < now.count && inserted.contains(j)) {
        if i < old.count, removed.contains(i) {
          dels.append(i)
          i += 1
        } else {
          adds.append(j)
          j += 1
        }
      }
      if dels.count == 1, adds.count == 1, kind(old[dels[0]]) == kind(now[adds[0]]) {
        out[dels[0]] = adds[0]
        continue
      }
      var used = Set<Int>()
      for d in dels {
        var best: Int?
        var score = like
        for a in adds where !used.contains(a) {
          let s = likeness(old[d], now[a])
          if s >= score {
            best = a
            score = s
          }
        }
        if let best {
          out[d] = best
          used.insert(best)
        }
      }
    }
    return out
  }
}

extension Board {
  /// A Note's Markdown rewritten (`old` → `now`, its blocks as the Note page splits them; nil: they could not be split):
  /// the arrow ends and sidenotes on one of its blocks follow that block, and go to the whole card when it is gone. One
  /// whose fingerprint is not the old block's at its index (made against text not saved yet) is found by its fingerprint
  public mutating func rebaseBlocks(_ card: CardID, old: [String]?, now: [String]?) {
    let anchored =
      arrows.contains { ($0.from.card == card && $0.from.block != nil) || ($0.to.card == card && $0.to.block != nil) }
      || sidenotes.contains { if case .card(card, _, _, .some) = $0.anchor { true } else { false } }
    guard anchored else { return }
    let map = old.flatMap { o in now.map { Blocks.map(o, $0) } }
    let sigs = now?.map(BlockRef.sig) ?? []
    func follow(_ ref: BlockRef) -> BlockRef? {
      var k: Int?
      if let map, let old, ref.index >= 0, ref.index < old.count, BlockRef.sig(old[ref.index]) == ref.hash {
        k = map[ref.index]
      }
      if k == nil { k = ref.at(sigs) }
      guard let k, now != nil else { return nil }
      return BlockRef(index: k, hash: sigs[k])
    }
    for i in arrows.indices {
      if arrows[i].from.card == card, let r = arrows[i].from.block { arrows[i].from.block = follow(r) }
      if arrows[i].to.card == card, let r = arrows[i].to.block { arrows[i].to.block = follow(r) }
    }
    for i in sidenotes.indices {
      guard case .card(card, let seg, let lines, .some(let r)) = sidenotes[i].anchor else { continue }
      sidenotes[i].anchor = .card(card, segment: seg, lines: lines, block: follow(r))
    }
  }
}

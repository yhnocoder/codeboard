import Foundation

/// Text the lexer works on, with where each UTF-16 unit came from in the Markdown source. marked rewrites text as it
/// descends (a quote's `> ` is cut off, a list item is dedented, tabs become spaces, a cell's `\|` becomes `|`); the
/// tokens it makes from the rewritten text still have to point into the source, so every rewrite goes through here.
struct Mapped: Equatable {
  private(set) var units: [UInt16]
  /// source offset of each unit, plus one more: where the text ends in the source
  private(set) var map: [Int]

  /// the text as an NSString, made once: every tokenizer tried at a position matches on it
  let ns: NSString

  init(_ s: String, at base: Int = 0) {
    units = Array(s.utf16)
    map = Array(base...(base + units.count))
    ns = s as NSString
  }
  private init(units: [UInt16], map: [Int]) {
    self.units = units
    self.map = map
    ns = String(decoding: units, as: UTF16.self) as NSString
  }

  static func == (a: Mapped, b: Mapped) -> Bool { a.units == b.units && a.map == b.map }

  var count: Int { units.count }
  var isEmpty: Bool { units.isEmpty }
  var string: String { ns as String }
  /// the source range this text spans
  var source: Range<Int> { map[0]..<map[units.count] }
  func sourceOffset(_ i: Int) -> Int { map[i] }

  subscript(r: Range<Int>) -> Mapped {
    Mapped(units: Array(units[r]), map: Array(map[r.lowerBound...r.upperBound]))
  }
  func prefix(_ n: Int) -> Mapped { self[0..<min(n, count)] }
  func dropFirst(_ n: Int) -> Mapped { self[min(n, count)..<count] }

  static func + (a: Mapped, b: Mapped) -> Mapped {
    if a.isEmpty { return b }
    if b.isEmpty { return Mapped(units: a.units, map: Array(a.map.dropLast()) + [b.map[0]]) }
    return Mapped(units: a.units + b.units, map: Array(a.map.dropLast()) + b.map)
  }
  /// text that is not in the source (a `\n` marked puts between lines it joined, a space it adds), placed at offset
  static func synthetic(_ s: String, at offset: Int) -> Mapped {
    let u = Array(s.utf16)
    return Mapped(units: u, map: Array(repeating: offset, count: u.count + 1))
  }

  /// `split("\n")`
  func lines() -> [Mapped] {
    var out: [Mapped] = []
    var start = 0
    for (i, u) in units.enumerated() where u == 0x0A {
      out.append(self[start..<i])
      start = i + 1
    }
    out.append(self[start..<count])
    return out
  }
  /// `arr.join("\n")`: the newline between two lines keeps its place in the source when the lines were neighbours
  static func join(_ parts: [Mapped], separator: String = "\n") -> Mapped {
    guard var out = parts.first else { return Mapped("") }
    for p in parts.dropFirst() {
      let sepAt = out.map[out.count]
      out = out + .synthetic(separator, at: sepAt) + p
    }
    return out
  }

  /// the text with ranges removed (each range in this text's offsets, ascending, not overlapping)
  func removing(_ ranges: [Range<Int>]) -> Mapped {
    var u: [UInt16] = []
    var m: [Int] = []
    var at = 0
    for r in ranges {
      u += units[at..<r.lowerBound]
      m += map[at..<r.lowerBound]
      at = r.upperBound
    }
    u += units[at..<count]
    m += map[at...count]
    return Mapped(units: u, map: m)
  }

  /// `replace(regex, f)`: each replacement is placed at the start of what it replaces in the source
  func replacing(_ re: JSRegex, _ with: (JSRegex.Match, NSString) -> String) -> Mapped {
    let s = ns
    let ms = re.global ? re.matches(s) : (re.exec(s).map { [$0] } ?? [])
    if ms.isEmpty { return self }
    var out = Mapped(units: [], map: [map[0]])
    var last = 0
    for m in ms {
      out = out + self[last..<m.range.location]
      let rep = with(m, s)
      out = out + replacement(rep, for: m.range.location..<m.range.upperBound)
      last = m.range.upperBound
    }
    return out + self[last..<count]
  }
  func replacing(_ re: JSRegex, template: String) -> Mapped {
    replacing(re) { m, s in
      re.replace(s.substring(with: m.range), template: template)
    }
  }
  /// replacement text for r: units it shares with r at its start and end keep their source places
  private func replacement(_ rep: String, for r: Range<Int>) -> Mapped {
    let new = Array(rep.utf16)
    let old = Array(units[r])
    var head = 0
    while head < new.count, head < old.count, new[head] == old[head] { head += 1 }
    var tail = 0
    while tail < new.count - head, tail < old.count - head, new[new.count - 1 - tail] == old[old.count - 1 - tail] {
      tail += 1
    }
    var m: [Int] = Array(map[r.lowerBound..<(r.lowerBound + head)])
    // what was rewritten sits where the rewritten part began (a removed backslash, a tab turned into spaces)
    let at = map[r.lowerBound + head]
    m += Array(repeating: at, count: new.count - head - tail)
    m += Array(map[(r.upperBound - tail)..<r.upperBound])
    m.append(map[r.upperBound])
    return Mapped(units: new, map: m)
  }

  func trimmingEnd(_ c: UInt16) -> Mapped {
    var n = count
    while n > 0, units[n - 1] == c { n -= 1 }
    return self[0..<n]
  }
  /// JavaScript's trim / trimStart / trimEnd (its whitespace set)
  func trimmed() -> Mapped { trimmedStart().trimmedEnd() }
  func trimmedStart() -> Mapped {
    var i = 0
    while i < count, Self.isJSSpace(units[i]) { i += 1 }
    return self[i..<count]
  }
  func trimmedEnd() -> Mapped {
    var n = count
    while n > 0, Self.isJSSpace(units[n - 1]) { n -= 1 }
    return self[0..<n]
  }
  static func isJSSpace(_ u: UInt16) -> Bool {
    switch u {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
    default: false
    }
  }
  /// marked's expandTabs: tabs to the next multiple of 4 columns, counting from column `indent`
  func expandingTabs(from indent: Int) -> Mapped {
    var u: [UInt16] = []
    var m: [Int] = []
    var col = indent
    var i = 0
    // marked walks code points: a surrogate pair is one column
    while i < count {
      let c = units[i]
      if c == 0x09 {
        let added = 4 - (col % 4)
        u += Array(repeating: 0x20, count: added)
        m += Array(repeating: map[i], count: added)
        col += added
        i += 1
      } else {
        let pair = UTF16.isLeadSurrogate(c) && i + 1 < count && UTF16.isTrailSurrogate(units[i + 1])
        let n = pair ? 2 : 1
        u += units[i..<(i + n)]
        m += map[i..<(i + n)]
        col += 1
        i += n
      }
    }
    m.append(map[count])
    return Mapped(units: u, map: m)
  }

  func hasSuffix(_ s: String) -> Bool {
    units.count >= s.utf16.count && units.suffix(s.utf16.count).elementsEqual(s.utf16)
  }
  func hasPrefix(_ s: String) -> Bool {
    units.count >= s.utf16.count && units.prefix(s.utf16.count).elementsEqual(s.utf16)
  }
  /// `indexOf`
  func firstIndex(of s: String, from: Int = 0) -> Int? {
    let r = ns.range(of: s, options: .literal, range: NSRange(location: from, length: count - from))
    return r.location == NSNotFound ? nil : r.location
  }
  func unit(_ i: Int) -> UInt16? { i >= 0 && i < count ? units[i] : nil }
}

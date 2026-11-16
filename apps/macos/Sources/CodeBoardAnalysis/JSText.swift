// The string rules of packages/analysis, which runs on JavaScript strings: lengths, offsets and slices count UTF-16
// code units (as the results' columns do), and `trim` and the regular expressions' `\s` take JavaScript's white space
// (Unicode's spaces, line ends and U+FEFF). Swift's own String operations go by Character, where "\r\n" is one.

typealias Units = ArraySlice<UInt16>

/// What JavaScript's `\s` matches and its `trim` removes: WhiteSpace and LineTerminator
func isJSSpace(_ u: UInt16) -> Bool {
  switch u {
  case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
  default: false
  }
}

/// The code unit of a character of the Basic Multilingual Plane
func unit(_ c: Unicode.Scalar) -> UInt16 { UInt16(c.value) }

func string(_ u: Units) -> String { String(decoding: u, as: UTF16.self) }

/// JavaScript's `slice(a, b)` of a string's code units or of an array: offsets from the start, a negative one counted
/// from the end, both clamped
func jsSlice<C: RandomAccessCollection>(_ xs: C, _ a: Int, _ b: Int? = nil) -> C.SubSequence where C.Index == Int {
  let n = xs.count
  let s = a < 0 ? max(0, n + a) : min(a, n)
  let e = b.map { $0 < 0 ? max(0, n + $0) : min($0, n) } ?? n
  return xs[xs.startIndex + s..<xs.startIndex + max(s, e)]
}

func jsTrim(_ u: Units) -> Units { jsTrimEnd(jsTrimStart(u)) }
func jsTrimStart(_ u: Units) -> Units { u.drop(while: isJSSpace) }

func jsTrimEnd(_ u: Units) -> Units {
  var e = u.endIndex
  while e > u.startIndex && isJSSpace(u[e - 1]) { e -= 1 }
  return u[u.startIndex..<e]
}

package func jsTrim(_ s: String) -> String { string(jsTrim(s.units)) }
package func jsTrimStart(_ s: String) -> String { string(jsTrimStart(s.units)) }
func jsTrimEnd(_ s: String) -> String { string(jsTrimEnd(s.units)) }

/// `s.replace(/\s+/g, " ").trim()`: a text on one line
func oneLine(_ s: Units) -> String {
  var out: [UInt16] = []
  out.reserveCapacity(s.count)
  var space = false
  for u in s {
    if isJSSpace(u) {
      space = true
      continue
    }
    if space && !out.isEmpty { out.append(unit(" ")) }
    space = false
    out.append(u)
  }
  return String(decoding: out, as: UTF16.self)
}

func oneLine(_ s: String) -> String { oneLine(s.units) }

/// A value as a call shows it: at most `n` code units, cut with an ellipsis
func short(_ s: String, _ n: Int) -> String { s.jsLength > n ? string(s.units.prefix(n - 1)) + "…" : s }

extension ArraySlice<UInt16> {
  var isBlank: Bool { allSatisfy(isJSSpace) }

  /// Split at `\r?\n`, as `split(/\r?\n/)` does
  func lines() -> [Units] {
    var out: [Units] = []
    var start = startIndex
    for i in indices where self[i] == unit("\n") {
      let end = i > start && self[i - 1] == unit("\r") ? i - 1 : i
      out.append(self[start..<end])
      start = i + 1
    }
    out.append(self[start..<endIndex])
    return out
  }
}

extension String {
  var units: Units { Units(utf16) }
  var jsLength: Int { utf16.count }

  /// `split(separator)`: code unit by code unit, empty parts kept
  func jsSplit(_ separator: String) -> [String] {
    precondition(!separator.isEmpty, "splitting on an empty separator is not ported")
    let t = JSText(self)
    var out: [String] = []
    var at = 0
    var i = t.indexOf(separator)
    while i >= 0 {
      out.append(t.slice(at, i))
      at = i + separator.jsLength
      i = t.indexOf(separator, from: at)
    }
    out.append(t.slice(at))
    return out
  }

  func jsStartsWith(_ prefix: String) -> Bool { utf16.starts(with: prefix.utf16) }
}

/// A string read as JavaScript reads it, by UTF-16 code unit, kept with the String the regular expressions search
struct JSText {
  let string: String
  let units: [UInt16]

  init(_ s: String) {
    string = s
    units = Array(s.utf16)
  }

  var count: Int { units.count }

  /// `text[i]`: nil out of range, as JavaScript's undefined
  subscript(i: Int) -> UInt16? { i >= 0 && i < units.count ? units[i] : nil }

  func slice(_ a: Int, _ b: Int? = nil) -> String { CodeBoardAnalysis.string(jsSlice(units, a, b)) }

  func indexOf(_ search: String, from: Int = 0) -> Int {
    let needle = Array(search.utf16)
    let n = units.count
    var i = max(0, from)
    if needle.isEmpty { return min(i, n) }
    while i + needle.count <= n {
      if units[i] == needle[0] {
        var k = 1
        while k < needle.count && units[i + k] == needle[k] { k += 1 }
        if k == needle.count { return i }
      }
      i += 1
    }
    return -1
  }

  /// `lastIndexOf(unit, from)` for a single code unit
  func lastIndexOf(_ unit: UInt16, from: Int) -> Int {
    var i = min(max(from, 0), units.count - 1)
    while i >= 0 {
      if units[i] == unit { return i }
      i -= 1
    }
    return -1
  }

  func startsWith(_ s: String, at i: Int) -> Bool {
    let needle = Array(s.utf16)
    guard i >= 0, i + needle.count <= units.count else { return false }
    for k in 0..<needle.count where units[i + k] != needle[k] { return false }
    return true
  }
}

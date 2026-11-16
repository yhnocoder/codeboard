// The string rules of packages/analysis, which runs on JavaScript strings: lengths and slices count UTF-16 code units,
// and `trim` and the regular expressions' `\s` take JavaScript's white space (Unicode's spaces, line ends and U+FEFF).

typealias Units = ArraySlice<UInt16>

func isJSSpace(_ u: UInt16) -> Bool {
  switch u {
  case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
  default: false
  }
}

func string(_ u: Units) -> String { String(decoding: u, as: UTF16.self) }

extension ArraySlice<UInt16> {
  func trimmed() -> Units { trimmedStart().trimmedEnd() }
  func trimmedStart() -> Units { drop(while: isJSSpace) }

  func trimmedEnd() -> Units {
    var e = endIndex
    while e > startIndex && isJSSpace(self[e - 1]) { e -= 1 }
    return self[startIndex..<e]
  }

  var isBlank: Bool { allSatisfy(isJSSpace) }

  /// JavaScript's `slice(from, to)` with offsets from the slice's start, clamped to it
  func js(_ from: Int, _ to: Int? = nil) -> Units {
    let s = startIndex + Swift.min(Swift.max(from, 0), count)
    let e = startIndex + Swift.min(Swift.max(to ?? count, 0), count)
    return s < e ? self[s..<e] : self[s..<s]
  }

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

func oneLine(_ s: String) -> String { oneLine(Units(s.utf16)) }

extension String {
  var units: Units { Units(utf16) }
  var jsLength: Int { utf16.count }

  /// JavaScript's `split(separator)`: code unit by code unit, empty parts kept
  func jsSplit(_ separator: String) -> [String] {
    let s = Array(utf16)
    let sep = Array(separator.utf16)
    var out: [String] = []
    var start = 0
    var i = 0
    while i + sep.count <= s.count {
      if s[i..<i + sep.count].elementsEqual(sep) {
        out.append(String(decoding: s[start..<i], as: UTF16.self))
        i += sep.count
        start = i
      } else {
        i += 1
      }
    }
    out.append(String(decoding: s[start...], as: UTF16.self))
    return out
  }
}

/// The code unit of a character of the Basic Multilingual Plane
func unit(_ c: Unicode.Scalar) -> UInt16 { UInt16(c.value) }

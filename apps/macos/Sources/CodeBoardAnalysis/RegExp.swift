import Foundation

// packages/analysis works on JavaScript strings and regular expressions, and its results (lines, columns, offsets) are
// in UTF-16 code units. These helpers keep both: text is scanned as UTF-16, and each pattern is written as in the
// TypeScript source and translated to ICU (NSRegularExpression) with JavaScript's meaning of `\w`, `\d`, `\s`, `\b`,
// `.`, `^` and `$` (ICU's are Unicode-aware and see more line terminators).

/// What JavaScript's `\s` matches and its `trim` removes: WhiteSpace and LineTerminator
private let jsSpaceUnits: Set<UInt16> = Set(
  [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF]
    + Array(0x2000...0x200A))

func isJSSpace(_ u: UInt16) -> Bool { jsSpaceUnits.contains(u) }

/// A string as JavaScript sees it: indexed by UTF-16 code unit
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

  /// `slice(a, b)` with JavaScript's handling of negative and out-of-range ends
  func slice(_ a: Int, _ b: Int? = nil) -> String {
    let n = units.count
    let s = a < 0 ? max(0, n + a) : min(a, n)
    let e = b.map { $0 < 0 ? max(0, n + $0) : min($0, n) } ?? n
    return s < e ? String(decoding: units[s..<e], as: UTF16.self) : ""
  }

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

func unit(_ c: Unicode.Scalar) -> UInt16 { UInt16(c.value) }

extension String {
  /// `split(separator)` by UTF-16 code units (Swift's own splitting goes by Character, where "\r\n" is one)
  func jsSplit(_ separator: String) -> [String] {
    precondition(!separator.isEmpty, "splitting on an empty separator is not ported")
    let t = JSText(self)
    var out: [String] = []
    var at = 0
    var i = t.indexOf(separator)
    while i >= 0 {
      out.append(t.slice(at, i))
      at = i + separator.utf16.count
      i = t.indexOf(separator, from: at)
    }
    out.append(t.slice(at))
    return out
  }

  /// `startsWith` by UTF-16 code units
  func jsStartsWith(_ prefix: String) -> Bool { utf16.starts(with: prefix.utf16) }
}

func jsTrim(_ s: String) -> String { jsTrimEnd(jsTrimStart(s)) }

func jsTrimStart(_ s: String) -> String {
  let u = Array(s.utf16)
  var a = 0
  while a < u.count && isJSSpace(u[a]) { a += 1 }
  return a == 0 ? s : String(decoding: u[a...], as: UTF16.self)
}

func jsTrimEnd(_ s: String) -> String {
  let u = Array(s.utf16)
  var b = u.count
  while b > 0 && isJSSpace(u[b - 1]) { b -= 1 }
  return b == u.count ? s : String(decoding: u[..<b], as: UTF16.self)
}

/// `s.length` in JavaScript
func jsLength(_ s: String) -> Int { s.utf16.count }

/// `s.slice(0, n)` in JavaScript
func jsPrefix(_ s: String, _ n: Int) -> String {
  let u = Array(s.utf16)
  return u.count <= n ? s : String(decoding: u[..<max(0, n)], as: UTF16.self)
}

/// `array.slice(a, b)` with JavaScript's handling of negative and out-of-range ends
func jsSlice<T>(_ xs: [T], _ a: Int, _ b: Int? = nil) -> [T] {
  let n = xs.count
  let s = a < 0 ? max(0, n + a) : min(a, n)
  let e = b.map { $0 < 0 ? max(0, n + $0) : min($0, n) } ?? n
  return s < e ? Array(xs[s..<e]) : []
}

func escapeRegExp(_ s: String) -> String {
  var out = ""
  for c in s.unicodeScalars {
    if ".*+?^${}()|[]\\".unicodeScalars.contains(c) { out.append("\\") }
    out.unicodeScalars.append(c)
  }
  return out
}

struct JSMatch {
  /// Start and end of the whole match, in UTF-16 code units
  let index: Int
  let end: Int
  /// Group 0 is the whole match; nil is a group that took no part (undefined)
  let groups: [String?]

  subscript(i: Int) -> String? { i < groups.count ? groups[i] : nil }
  var text: String { groups[0] ?? "" }
}

/// A JavaScript regular expression (flags `g` aside: each call says whether it wants one match or all)
struct JSRegex: @unchecked Sendable {
  // NSRegularExpression is immutable and documented as safe to use from several threads; it is not marked Sendable
  private let re: NSRegularExpression

  init(_ pattern: String, _ flags: String = "") {
    let icu = JSRegex.icu(pattern, multiline: flags.contains("m"), dotAll: flags.contains("s"))
    do {
      re = try NSRegularExpression(pattern: icu)
    } catch {
      preconditionFailure("pattern /\(pattern)/ (ICU \(icu)) does not compile: \(error)")
    }
  }

  func test(_ s: String) -> Bool { test(JSText(s)) }
  func test(_ t: JSText, from: Int = 0) -> Bool { first(t, from: from) != nil }

  func exec(_ s: String) -> JSMatch? { first(JSText(s)) }

  /// The first match in `t.slice(from)`, indices still counted from the start of `t`
  func first(_ t: JSText, from: Int = 0) -> JSMatch? {
    let r = NSRange(location: from, length: t.count - from)
    return re.firstMatch(in: t.string, range: r).map { match($0, t) }
  }

  /// `matchAll` / a global `exec` loop
  func all(_ s: String) -> [JSMatch] { all(JSText(s)) }
  func all(_ t: JSText) -> [JSMatch] {
    re.matches(in: t.string, range: NSRange(location: 0, length: t.count)).map { match($0, t) }
  }

  /// `replace` with a function: the first match, or every match when `global`
  func replace(_ s: String, global: Bool = false, _ f: (JSMatch) -> String) -> String {
    let t = JSText(s)
    let ms = global ? all(t) : first(t).map { [$0] } ?? []
    if ms.isEmpty { return s }
    var out = ""
    var at = 0
    for m in ms {
      out += t.slice(at, m.index) + f(m)
      at = m.end
    }
    return out + t.slice(at)
  }

  /// `replace` with a replacement string: `$1`…`$9` and `$&` as in JavaScript
  func replace(_ s: String, global: Bool = false, with template: String) -> String {
    replace(s, global: global) { m in JSRegex.expand(template, m) }
  }

  /// `split` with JavaScript's handling of empty matches and of capture groups (each is put between the pieces)
  func split(_ s: String) -> [String?] {
    let t = JSText(s)
    if t.count == 0 { return first(t) == nil ? [s] : [] }
    var out: [String?] = []
    var p = 0
    for m in all(t) {
      if m.index >= t.count { break }
      if m.end == p { continue }
      out.append(t.slice(p, m.index))
      out.append(contentsOf: m.groups.dropFirst())
      p = m.end
    }
    out.append(t.slice(p))
    return out
  }

  private func match(_ r: NSTextCheckingResult, _ t: JSText) -> JSMatch {
    var groups: [String?] = []
    for i in 0..<r.numberOfRanges {
      let g = r.range(at: i)
      groups.append(g.location == NSNotFound ? nil : t.slice(g.location, g.location + g.length))
    }
    return JSMatch(index: r.range.location, end: r.range.location + r.range.length, groups: groups)
  }

  private static func expand(_ template: String, _ m: JSMatch) -> String {
    let u = Array(template.unicodeScalars)
    var out = ""
    var i = 0
    while i < u.count {
      if u[i] == "$", i + 1 < u.count {
        let c = u[i + 1]
        if c == "&" {
          out += m.text
          i += 2
          continue
        }
        if c == "$" {
          out += "$"
          i += 2
          continue
        }
        if let d = Int(String(c)), d > 0, d < m.groups.count {
          out += m[d] ?? ""
          i += 2
          continue
        }
      }
      out.unicodeScalars.append(u[i])
      i += 1
    }
    return out
  }

  /// A JavaScript pattern (no `u` flag) in ICU syntax with the same meaning
  static func icu(_ js: String, multiline: Bool, dotAll: Bool) -> String {
    let space = #"\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}"#
    let word = "A-Za-z0-9_"
    let terminators = #"\n\r\x{2028}\x{2029}"#
    let cs = Array(js.unicodeScalars)
    var out = ""
    var inClass = false
    var i = 0
    while i < cs.count {
      let c = cs[i]
      if c == "\\", i + 1 < cs.count {
        let e = cs[i + 1]
        i += 2
        switch (e, inClass) {
        case ("w", false): out += "[\(word)]"
        case ("W", false): out += "[^\(word)]"
        case ("d", false): out += "[0-9]"
        case ("D", false): out += "[^0-9]"
        case ("s", false): out += "[\(space)]"
        case ("S", false): out += "[^\(space)]"
        case ("b", false): out += "(?:(?<=[\(word)])(?![\(word)])|(?<![\(word)])(?=[\(word)]))"
        case ("B", false): out += "(?:(?<=[\(word)])(?=[\(word)])|(?<![\(word)])(?![\(word)]))"
        case ("w", true): out += word
        case ("W", true): out += "[^\(word)]"
        case ("d", true): out += "0-9"
        case ("D", true): out += "[^0-9]"
        case ("s", true): out += space
        case ("S", true): out += "[^\(space)]"
        case ("b", true): out += #"\x{08}"#
        default:
          out += "\\"
          out.unicodeScalars.append(e)
        }
        continue
      }
      i += 1
      if inClass {
        switch c {
        case "]": inClass = false
        // ICU reads these inside a class as nested sets, set operations or POSIX names; JavaScript as plain characters
        case "[", "&", ":":
          out += "\\"
        default: break
        }
        out.unicodeScalars.append(c)
        continue
      }
      switch c {
      case "[":
        inClass = true
        out += "["
        if i < cs.count, cs[i] == "^" {
          out += "^"
          i += 1
        }
        precondition(i < cs.count && cs[i] != "]", "/\(js)/: an empty class means something else in ICU")
      case ".": out += dotAll ? "(?s:.)" : "[^\(terminators)]"
      case "^": out += multiline ? "(?:^|(?<=[\(terminators)]))" : "^"
      case "$": out += multiline ? "(?=[\(terminators)]|\\z)" : "\\z"
      default: out.unicodeScalars.append(c)
      }
    }
    return out
  }
}

import Foundation

/// A regular expression written for JavaScript, run by ICU with JavaScript's meaning. The TypeScript Markdown package
/// tokenizes with JavaScript regexes (marked's and its own); reading the same sources here keeps the two parsers equal,
/// as long as the few constructs whose meaning differs are rewritten:
/// - `\b \w \d` (and their negations) are ASCII-only in JavaScript, Unicode-aware in ICU
/// - `\s` and `.` match slightly different sets (`\s` includes U+FEFF in JavaScript; `.` excludes U+0085 in ICU)
/// - `$` without the m flag matches only at the end in JavaScript, also before a final line break in ICU
/// - a `{` that is not a quantifier, and `[` or `&&` / `--` inside a class, are literal in JavaScript, syntax in ICU
///
/// Matching is on UTF-16 offsets of an `NSString`, like JavaScript's string indices. A match at `from` sees the text from
/// `from` on as if it were the whole string (`^` matches there, lookbehind does not look before it), which is what
/// `regex.exec(src.slice(from))` does.
struct JSRegex: @unchecked Sendable {
  let source: String
  let global: Bool
  let unicode: Bool
  private let regex: NSRegularExpression

  init(_ source: String, flags: String) {
    self.source = source
    global = flags.contains("g")
    unicode = flags.contains("u")
    var options: NSRegularExpression.Options = []
    if flags.contains("i") { options.insert(.caseInsensitive) }
    if flags.contains("m") { options.insert(.anchorsMatchLines) }
    if flags.contains("s") { options.insert(.dotMatchesLineSeparators) }
    let icu = Self.translate(source, multiline: flags.contains("m"), dotAll: flags.contains("s"))
    do {
      regex = try NSRegularExpression(pattern: icu, options: options)
    } catch {
      preconditionFailure("JSRegex: cannot compile \(source) as \(icu): \(error)")
    }
  }

  struct Match {
    /// group ranges in the string matched in (absolute UTF-16 offsets); nil for a group that did not take part
    let groups: [NSRange?]
    var range: NSRange { groups[0]! }
    func group(_ i: Int, in s: NSString) -> String? {
      guard i < groups.count, let r = groups[i] else { return nil }
      return s.substring(with: r)
    }
  }

  /// `regex.exec(s.slice(from, to))`, with the match's offsets in s
  func exec(_ s: NSString, from: Int = 0, to: Int? = nil) -> Match? {
    let end = to ?? s.length
    guard from <= end else { return nil }
    // anchoring, non-transparent bounds: ^ and $ meet the range's ends and lookaround sees nothing outside it
    let m = regex.firstMatch(in: s as String, options: [], range: NSRange(location: from, length: end - from))
    return m.map(Self.match)
  }

  /// A global regex's `exec` with `lastIndex` at `at`: the search starts there, but the string is all of s
  func exec(_ s: NSString, lastIndex at: Int) -> Match? {
    guard at <= s.length else { return nil }
    let m = regex.firstMatch(
      in: s as String, options: [.withTransparentBounds, .withoutAnchoringBounds],
      range: NSRange(location: at, length: s.length - at))
    return m.map(Self.match)
  }

  private static func match(_ m: NSTextCheckingResult) -> Match {
    Match(groups: (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? nil : m.range(at: $0) })
  }

  func test(_ s: NSString, from: Int = 0, to: Int? = nil) -> Bool { exec(s, from: from, to: to) != nil }
  func test(_ s: String) -> Bool { test(s as NSString) }

  /// All matches of a global regex over s, as its exec loop finds them
  func matches(_ s: NSString) -> [Match] {
    var out: [Match] = []
    var at = 0
    while let m = exec(s, lastIndex: at) {
      out.append(m)
      // JavaScript's String.replace steps past an empty match
      at = m.range.length == 0 ? m.range.upperBound + 1 : m.range.upperBound
    }
    return out
  }

  /// `s.replace(regex, f)`: every match when global, else the first
  func replace(_ s: String, _ with: (Match, NSString) -> String) -> String {
    let ns = s as NSString
    let ms = global ? matches(ns) : (exec(ns).map { [$0] } ?? [])
    if ms.isEmpty { return s }
    var out = ""
    var last = 0
    for m in ms {
      out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
      out += with(m, ns)
      last = m.range.upperBound
    }
    return out + ns.substring(from: last)
  }

  /// `$1`-style replacement text
  func replace(_ s: String, template: String) -> String {
    replace(s) { m, ns in
      var out = ""
      var it = template.makeIterator()
      while let c = it.next() {
        if c == "$", let d = it.next() {
          if let n = d.wholeNumberValue {
            out += m.group(n, in: ns) ?? ""
          } else if d == "&" {
            out += ns.substring(with: m.range)
          } else if d == "$" {
            out += "$"
          } else {
            out += "$\(d)"
          }
        } else {
          out.append(c)
        }
      }
      return out
    }
  }

  // MARK: JavaScript → ICU

  private static let jsSpace =
    #"\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}"#
  private static let word = "A-Za-z0-9_"
  private static let lineEnds = #"\n\r\x{2028}\x{2029}"#

  static func translate(_ js: String, multiline: Bool, dotAll: Bool) -> String {
    let c = Array(js.unicodeScalars)
    var out = ""
    var i = 0
    var inClass = false
    var classStart = false
    func peek(_ k: Int) -> Unicode.Scalar? { i + k < c.count ? c[i + k] : nil }
    while i < c.count {
      let ch = c[i]
      if ch == "\\", let n = peek(1) {
        i += 2
        switch n {
        case "w": out += inClass ? word : "[\(word)]"
        case "W": out += inClass ? #"\x{0}-/:-@\[-^`{-\x{10FFFF}"# : "[^\(word)]"
        case "d": out += inClass ? "0-9" : "[0-9]"
        case "D": out += inClass ? #"\x{0}-/:-\x{10FFFF}"# : "[^0-9]"
        case "s": out += inClass ? jsSpace : "[\(jsSpace)]"
        case "S": out += inClass ? #"\S"# : "[^\(jsSpace)]"
        case "b" where !inClass:
          out += "(?:(?<=[\(word)])(?![\(word)])|(?<![\(word)])(?=[\(word)]))"
        case "B" where !inClass:
          out += "(?:(?<=[\(word)])(?=[\(word)])|(?<![\(word)])(?![\(word)]))"
        case "u" where peek(0) != "{":
          // \uXXXX
          let hex = String(String.UnicodeScalarView(c[i..<min(i + 4, c.count)]))
          out += "\\x{\(hex)}"
          i += 4
        default:
          out += "\\" + String(n)
        }
        classStart = false
        continue
      }
      if inClass {
        if ch == "]" && !classStart {
          inClass = false
          out += "]"
        } else if ch == "[" || ch == "&" {
          out += "\\" + String(ch)
        } else if ch == "-" && (peek(1) == "-" || out.hasSuffix("-")) {
          out += "\\-"
        } else if ch == "^" && classStart {
          out += "^"
          i += 1
          continue  // still at the class start: a ] right after [^ is literal in neither, but keep the state
        } else {
          out += String(ch)
        }
        classStart = false
        i += 1
        continue
      }
      switch ch {
      case "[":
        inClass = true
        classStart = true
        out += "["
      case "$" where !multiline:
        out += #"(?![\s\S])"#
      case "." where !dotAll:
        out += "[^\(lineEnds)]"
      case "{":
        // a quantifier is {n}, {n,} or {n,m}; anything else is a literal brace in JavaScript
        var j = i + 1
        var digits = 0
        while j < c.count, c[j].properties.numericType != nil, c[j].isASCII {
          j += 1
          digits += 1
        }
        if digits > 0, j < c.count, c[j] == "," {
          j += 1
          while j < c.count, c[j].properties.numericType != nil, c[j].isASCII { j += 1 }
        }
        out += digits > 0 && j < c.count && c[j] == "}" ? "{" : "\\{"
      case "}":
        // a closing brace of a quantifier was copied with it below; a lone one is literal
        out += out.range(of: #"\{[0-9]+(,[0-9]*)?$"#, options: .regularExpression) != nil ? "}" : "\\}"
      default:
        out += String(ch)
      }
      i += 1
    }
    return out
  }
}

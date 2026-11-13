import Foundation

// Old board and shared-card files from version 13 up to the one the importer maps (16), brought to that one as the VS
// Code extension's migrate.ts does (packages/core/src/migrate.ts): 13 → 14 rewrites `<mark>…</mark>` as `==…==`, 14 → 15
// changes only sidenotes (which the importer skips), 15 → 16 turns Text, Mark, Free Text and Box into Text and Box at a
// size of their own (textAndBox). Only what the importer reads is upgraded. A port, kept line for line close to the
// TypeScript so the two can be read side by side; LegacyUpgradeTests checks it against that code's own output.

enum LegacyUpgrade {
  /// A board file at `from` (13…16) brought to 16, in place
  static func board(_ b: inout [String: Any], from: Int) {
    guard from < LegacyImport.currentVersion else { return }
    var cards = b["cards"] as? [Any] ?? []
    if from < 14 {
      cards = cards.map { c in
        guard var c = c as? [String: Any], c["kind"] as? String != "shared" else { return c }
        markCard(&c)
        return c
      }
    }
    if from < 16 {
      var place = b["place"] as? [String: Any] ?? [:]
      cards = cards.map { c in
        guard var c = c as? [String: Any], c["kind"] as? String != "shared" else { return c }
        textAndBox(&c, place: &place)
        return c
      }
      b["place"] = place
    }
    b["cards"] = cards
    b["version"] = LegacyImport.currentVersion
  }

  /// A shared card file (the card library's `cards/<id>.json`) at `from` (13…16) brought to 16, in place. Its place, and
  /// the height a Box had there, is in each board's file
  static func sharedCard(_ sc: inout [String: Any], from: Int) {
    guard from < LegacyImport.currentVersion else { return }
    if var card = sc["card"] as? [String: Any] {
      if from < 14 { markCard(&card) }
      var none: [String: Any] = [:]
      if from < 16 { textAndBox(&card, place: &none) }
      sc["card"] = card
    }
    sc["version"] = LegacyImport.currentVersion
  }

  // MARK: 15 → 16: Text and Box

  /// Warm Ink's sizes of the old Text's three levels (px)
  static let oldTextPx = ["title": 26.0, "heading": 16.0, "body": 13.5]
  /// An old Free Text's size at each level (0 = plain, 1–3 = H1–H3) when it stored none (px)
  static let oldFreePx = [20.0, 40, 30, 24]
  /// An old Mark's size when it stored none, and an old Box's (px)
  static let oldMarkPx = 18.0
  static let oldBoxPx = 13.5
  /// How much larger than a Text's own size its # and ## headings are (styles.css .tx h1, .tx h2)
  static let headingScale = [1, 1.8, 1.35]

  /// migrate.ts textAndBox: a Note's other looks become a Text or a Box, Markdown at a size of their own. `place`: the
  /// board's places (a Box's stored height goes)
  static func textAndBox(_ c: inout [String: Any], place: inout [String: Any]) {
    guard c["kind"] as? String == "note" else { return }
    var fs: Double?
    switch c["look"] as? String {
    case "text":
      fs = oldTextLevel(&c)
      c["wrap"] = true
    case "freetext":
      let level = c["level"] as? Int ?? 0
      let heading = level == 3 ? 2 : level != 0 ? 1 : 0
      c["md"] = plainToMarkdown(c["md"] as? String ?? "", heading: heading, bold: c["bold"] as? Bool ?? false)
      let px = (c["fs"] as? Double) ?? (oldFreePx.indices.contains(level) ? oldFreePx[level] : oldFreePx[0])
      fs = px / headingScale[heading]
      c["look"] = "text"
      c["mdLayout"] = nil
    case "mark":
      fs = (c["fs"] as? Double) ?? oldMarkPx
      c["look"] = "text"
      c["wrap"] = true
    case "box":
      fs = oldBoxPx
      c["wrap"] = true
      if let id = c["id"] as? String, var p = place[id] as? [String: Any] {
        p["h"] = nil
        place[id] = p
      }
    default: break
    }
    for k in ["size", "bold", "hand", "weight", "level", "fs"] { c[k] = nil }
    guard let fs else { return }
    let size = min(NoteStyle.textSizes.upperBound, max(NoteStyle.textSizes.lowerBound, (fs * 2).rounded() / 2))
    if size != NoteStyle.defaultTextSize { c["fs"] = size }
  }

  /// A line Markdown reads as the start of a block (heading, quote, list, rule, fence, table, math, image)
  static let blockStart = re(#"^\s*(?:#|>|[-+*]\s|[0-9]+[.)]|```|~~~|\||\$\$|!\[)"#)

  /// migrate.ts oldTextLevel: the old Text's Markdown at a title or heading level, and the text size it takes
  static func oldTextLevel(_ c: inout [String: Any]) -> Double {
    let size = c["size"] as? String
    let px = size.flatMap { oldTextPx[$0] } ?? oldTextPx["body"]!
    let heading = size == "title" ? 1 : size == "heading" ? 2 : 0
    let md = c["md"] as? String ?? ""
    let trimmed = jsTrim(md)
    let paras = trimmed.isEmpty ? [] : split(trimmed, re(#"\n\s*\n"#))
    let plain = !paras.isEmpty && paras.allSatisfy { !$0.contains("\n") && !matches(blockStart, $0) }
    if heading != 0 && plain {
      c["md"] = paras.map { "\(String(repeating: "#", count: heading)) \(jsTrim($0))" }.joined(separator: "\n\n")
      return px / headingScale[heading]
    }
    // bold around text with its own * marks would nest them into something else
    if (c["bold"] as? Bool ?? false) && plain && !md.contains("*") {
      c["md"] = paras.map { "**\(jsTrim($0))**" }.joined(separator: "\n\n")
    }
    return px
  }

  /// migrate.ts plainToMarkdown: an old Free Text's plain text as Markdown that shows the same
  static func plainToMarkdown(_ text: String, heading: Int, bold: Bool) -> String {
    if jsTrim(text).isEmpty { return "" }
    return replace(text, re(#"\s+$"#), with: { _ in "" })
      .components(separatedBy: "\n")
      .map { line in
        let body = jsTrimEnd(line)
        if jsTrim(body).isEmpty { return "&nbsp;" }
        let start = jsTrimStart(body)
        let lead = (body as NSString).length - (start as NSString).length
        var md = replace(escapePlain(start), re(" {2,}")) { m in
          " " + String(repeating: "\u{a0}", count: (m as NSString).length - 1)
        }
        if bold { md = "**\(md)**" }
        md = String(repeating: "\u{a0}", count: lead) + md
        return heading != 0 ? "\(String(repeating: "#", count: heading)) \(md)" : md
      }
      .joined(separator: "\n\n")
  }

  /// migrate.ts escapePlain: plain text escaped where Markdown (with the board's own marks) reads markup
  static func escapePlain(_ s: String) -> String {
    var out = replace(s, re(#"[\\`*_~$\[\]<^{|]"#)) { "\\" + $0 }
    out = replace(out, re("==")) { _ in "\\==" }
    out = replace(out, re("&(?=#?[A-Za-z0-9_]+;)")) { _ in "&amp;" }
    out = replace(out, re(":(?=[A-Za-z0-9_+-]+:)")) { _ in "\\:" }
    out = replace(out, re("^#")) { _ in "\\#" }
    out = replace(out, re("^[-+>]")) { "\\" + $0 }
    return replace(out, re("^([0-9]+)([.)])")) { m in
      let ns = m as NSString
      return ns.substring(to: ns.length - 1) + "\\" + ns.substring(from: ns.length - 1)
    }
  }

  // MARK: 13 → 14: <mark> as ==

  static func markCard(_ c: inout [String: Any]) {
    if let d = c["desc"] as? String { c["desc"] = markTags(d) }
    // a Free Text's md is plain text, not Markdown
    if c["kind"] as? String == "note", c["look"] as? String != "freetext", let md = c["md"] as? String {
      c["md"] = markTags(md)
    }
    if let merged = c["mergedFrom"] as? [Any] {
      c["mergedFrom"] = merged.map { m -> Any in
        guard var m = m as? [String: Any], var card = m["card"] as? [String: Any] else { return m }
        markCard(&card)
        m["card"] = card
        return m
      }
    }
  }

  /// A line's list and quote markers and its indent
  static let container = re(#"^(?:\s*(?:>|[-+*](?=\s)|[0-9]{1,9}[.)](?=\s)))*\s*"#)

  /// migrate.ts markTags: `<mark>x</mark>` (no attributes, on one line, nothing nested) → `==x==`, outside code,
  /// formulas and HTML blocks, and only where the == form says the same
  static func markTags(_ md: String) -> String {
    guard matches(re("<mark>", caseless: true), md) else { return md }
    var out: [String] = []
    var run: [String] = []
    var fence = ""
    var cont = ""
    var html = false
    func flush() {
      if !run.isEmpty { out.append(markText(run.joined(separator: "\n"))) }
      run = []
    }
    func fixed(_ l: String) {
      flush()
      out.append(l)
    }
    for l in md.components(separatedBy: "\n") {
      // inside a fence only its own container's prefix comes off a line; a line without that prefix ends the container,
      // and the fence with it
      if !fence.isEmpty && (l.hasPrefix(cont) || jsTrim(l).isEmpty) {
        fixed(l)
        let marker = NSRegularExpression.escapedPattern(for: String(fence.first!))
        let closes = re("^ {0,3}\(marker){\((fence as NSString).length),}\\s*$")
        if matches(closes, (l as NSString).substring(from: min((cont as NSString).length, (l as NSString).length))) {
          fence = ""
        }
        continue
      }
      fence = ""
      let inner = replace(l, container) { _ in "" }
      if let f = firstGroup(re("^(`{3,}|~{3,})"), inner) {
        fence = f
        cont = contOf((l as NSString).substring(to: (l as NSString).length - (inner as NSString).length))
        fixed(l)
      } else if html {
        fixed(l)
        html = !jsTrim(l).isEmpty
      } else if matches(re("^ {0,3}<[A-Za-z/!?]"), l) && !matches(re("^ {0,3}<mark>", caseless: true), l) {
        html = true
        fixed(l)
      } else if matches(re("^( {4}|\t)"), l) && !(!run.isEmpty && !jsTrim(run.last!).isEmpty) {
        fixed(l)
      } else {
        run.append(l)
      }
    }
    flush()
    return out.joined(separator: "\n")
  }

  /// The quote markers a fence opened after this prefix keeps on its lines (list markers and indents become spaces)
  static func contOf(_ prefix: String) -> String {
    jsTrimEnd(replace(prefix, re("[-+*]|[0-9]{1,9}[.)]")) { String(repeating: " ", count: ($0 as NSString).length) })
  }

  /// Lines of text (no code or HTML blocks): inline code spans and formulas skipped
  static func markText(_ src: String) -> String {
    let s = src as NSString
    var out = ""
    var i = 0
    // where the last rewritten <mark> ended: one right after it stays as written (==a====b== would read as one run)
    var last = -1
    let tag = re(#"(?<!\\)(\\*)<mark>([^<>\n]*)</mark>"#, caseless: true)
    func char(_ at: Int) -> String {
      at >= 0 && at < s.length ? s.substring(with: NSRange(location: at, length: 1)) : ""
    }
    func marks(_ from: Int, _ to: Int) -> String {
      let slice = s.substring(with: NSRange(location: from, length: to - from)) as NSString
      var result = ""
      var pos = 0
      for m in tag.matches(in: slice as String, range: NSRange(location: 0, length: slice.length)) {
        result += slice.substring(with: NSRange(location: pos, length: m.range.location - pos))
        pos = m.range.location + m.range.length
        let whole = slice.substring(with: m.range)
        let esc = slice.substring(with: m.range(at: 1))
        let x = slice.substring(with: m.range(at: 2))
        let t = jsTrim(x)
        let abs = from + m.range.location
        let before = char(abs - 1 + (esc as NSString).length)
        let after = char(abs + m.range.length)
        if (esc as NSString).length % 2 == 1 || t.isEmpty || t.contains("==") || matches(re(#"^=|[=\\]$"#), t)
          || before == "=" || after == "=" || abs == last
        {
          result += whole
          continue
        }
        last = abs + m.range.length
        let xs = x as NSString
        let lead = xs.substring(to: xs.length - (jsTrimStart(x) as NSString).length)
        let trail = xs.substring(from: (jsTrimEnd(x) as NSString).length)
        result += "\(esc)\(lead)==\(t)==\(trail)"
      }
      return result + slice.substring(from: pos)
    }
    while i < s.length {
      guard let at = skipAt(s, i) else {
        out += marks(i, s.length)
        break
      }
      out += marks(i, at.0) + s.substring(with: NSRange(location: at.0, length: at.1 - at.0))
      i = at.1
    }
    return out
  }

  /// The next inline code span or formula from i on, as (start, end): nil when there is no ` or unescaped $ left
  static func skipAt(_ src: NSString, _ i: Int) -> (Int, Int)? {
    let opener = re(#"`+|(?<!\\)\$\$?"#)
    var from = i
    while from <= src.length,
      let m = opener.firstMatch(in: src as String, range: NSRange(location: from, length: src.length - from))
    {
      let s = m.range.location
      let d = src.substring(with: m.range) as NSString
      let after = s + d.length
      let rest = src.substring(from: after)
      if d.hasPrefix("`") {
        let close = re("(?<!`)`{\(d.length)}(?!`)").firstMatch(
          in: rest, range: NSRange(location: 0, length: (rest as NSString).length))
        return (s, close.map { after + $0.range.location + d.length } ?? after)
      }
      // a formula ends at the same $ or $$ before a blank line; an unclosed $ is a dollar sign
      let para = re(#"\n\s*\n"#).firstMatch(in: rest, range: NSRange(location: 0, length: (rest as NSString).length))
      let scope = para.map { (rest as NSString).substring(to: $0.range.location) } ?? rest
      let close = re(d.length == 2 ? #"(?<!\\)\$\$"# : #"(?<!\\)\$(?!\$)"#).firstMatch(
        in: scope, range: NSRange(location: 0, length: (scope as NSString).length))
      if let close { return (s, after + close.range.location + d.length) }
      from = after
    }
    return nil
  }

  // MARK: JavaScript's string helpers, as the TypeScript uses them

  /// JS whitespace for trim(): Unicode white space and line terminators
  private static let jsSpace = CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{feff}"))

  static func jsTrim(_ s: String) -> String { s.trimmingCharacters(in: jsSpace) }
  static func jsTrimStart(_ s: String) -> String {
    String(s.unicodeScalars.drop { jsSpace.contains($0) })
  }
  static func jsTrimEnd(_ s: String) -> String {
    var scalars = Array(s.unicodeScalars)
    while let last = scalars.last, jsSpace.contains(last) { scalars.removeLast() }
    return String(String.UnicodeScalarView(scalars))
  }

  // MARK: Regular expressions (ICU, UTF-16 offsets as in JavaScript; \w and \d written out as ASCII)

  nonisolated(unsafe) private static var compiled: [String: NSRegularExpression] = [:]
  private static let lock = NSLock()

  static func re(_ pattern: String, caseless: Bool = false) -> NSRegularExpression {
    let key = (caseless ? "i:" : ":") + pattern
    lock.lock()
    defer { lock.unlock() }
    if let r = compiled[key] { return r }
    // a pattern here is a constant of this file, so a bad one is a programming error
    let r = try! NSRegularExpression(pattern: pattern, options: caseless ? [.caseInsensitive] : [])
    compiled[key] = r
    return r
  }

  static func matches(_ r: NSRegularExpression, _ s: String) -> Bool {
    r.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
  }

  static func firstGroup(_ r: NSRegularExpression, _ s: String) -> String? {
    guard let m = r.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) else { return nil }
    return (s as NSString).substring(with: m.range(at: 1))
  }

  /// Every match replaced by what `with` makes of its text
  static func replace(_ s: String, _ r: NSRegularExpression, with: (String) -> String) -> String {
    let ns = s as NSString
    var out = ""
    var pos = 0
    for m in r.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
      out += ns.substring(with: NSRange(location: pos, length: m.range.location - pos))
      out += with(ns.substring(with: m.range))
      pos = m.range.location + m.range.length
    }
    return out + ns.substring(from: pos)
  }

  static func split(_ s: String, _ r: NSRegularExpression) -> [String] {
    let ns = s as NSString
    var out: [String] = []
    var pos = 0
    for m in r.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
      out.append(ns.substring(with: NSRange(location: pos, length: m.range.location - pos)))
      pos = m.range.location + m.range.length
    }
    out.append(ns.substring(from: pos))
    return out
  }
}

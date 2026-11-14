import Foundation

/// An inline token. Plain strings: the spans (Spans.swift) are worked out from raw lengths inside one inline text, as
/// the TypeScript editor does, and only then mapped to source offsets.
final class InlineToken {
  var type: String
  var raw: String
  var text: String
  var tokens: [InlineToken] = []
  var href = ""
  var title: String?
  var latex = ""
  var display = false
  var name = ""
  var label = ""
  var target: String?
  var note = ""
  var color = "blue"
  var below = false
  var textEnd = 0
  var broken = false
  var attrs: ImageAttributes?
  init(_ type: String, raw: String, text: String? = nil) {
    self.type = type
    self.raw = raw
    self.text = text ?? raw
  }
}

/// marked's inline lexer (Lexer.inlineTokens and the inline methods of its Tokenizer), with the package's tokenizer
/// overrides (emphasis, tags, links) and inline extensions, in marked's order: extensions first, the last registered
/// first. Footnote references are not supported (`[^1]` reads as text). Link reference definitions are never resolved
/// here, as in the TypeScript editor, whose lexer has none.
struct InlineLexer {
  private var inLink = false
  private var inRawBlock = false

  static func tokens(_ src: String) -> [InlineToken] {
    var lx = InlineLexer()
    return lx.inlineTokens(src)
  }

  mutating func inlineTokens(_ input: String) -> [InlineToken] {
    var tokens: [InlineToken] = []
    let full = input as NSString
    let total = full.length
    // String with escapes and links/code/html masked, so emphasis delimiters inside them do not count
    var masked = Array(input.utf16)
    for m in MarkedRules.Inline.anyPunctuation.matches(full) {
      masked[m.range.location] = 0x2B
      masked[m.range.location + 1] = 0x2B
    }
    var at = 0
    while true {
      let s = String(decoding: masked, as: UTF16.self) as NSString
      guard let m = MarkedRules.Inline.blockSkip.exec(s, lastIndex: at) else { break }
      let offset = m.groups.count > 2 ? (m.groups[2]?.length ?? 0) : 0
      let r = m.range
      masked[r.location + offset] = 0x5B
      for k in (r.location + offset + 1)..<(r.upperBound - 1) { masked[k] = 0x61 }
      masked[r.upperBound - 1] = 0x5D
      at = r.upperBound
    }
    let maskedSrc = String(decoding: masked, as: UTF16.self) as NSString

    var pos = 0
    var keepPrevChar = false
    var prevChar = ""
    while pos < total {
      if !keepPrevChar { prevChar = "" }
      keepPrevChar = false
      let src = full.substring(from: pos) as NSString
      func push(_ t: InlineToken) {
        pos += (t.raw as NSString).length
        tokens.append(t)
      }
      if let t = extensions(src, tokens) {
        push(t)
        continue
      }
      if let t = escape(src) ?? tag(src) ?? link(src) {
        push(t)
        continue
      }
      if let t = reflink(src) {
        pos += (t.raw as NSString).length
        if t.type == "text", let last = tokens.last, last.type == "text" {
          last.raw += t.raw
          last.text += t.text
        } else {
          tokens.append(t)
        }
        continue
      }
      if let t = emStrong(src, maskedSrc, prevChar) ?? codespan(src) ?? br(src) ?? del(src, maskedSrc, prevChar)
        ?? autolink(src)
      {
        push(t)
        continue
      }
      if !inLink, let t = url(src) {
        push(t)
        continue
      }
      // text stops where an extension could start
      var cut = src
      if let s = Self.extensionStart(src.length > 0 ? src.substring(from: 1) as NSString : src) {
        cut = src.substring(to: s + 1) as NSString
      }
      if let t = inlineText(cut) {
        pos += (t.raw as NSString).length
        if !t.raw.hasSuffix("_") { prevChar = String(t.raw.utf16.suffix(1)).map { $0 } ?? "" }
        keepPrevChar = true
        if let last = tokens.last, last.type == "text" {
          last.raw += t.raw
          last.text += t.text
        } else {
          tokens.append(t)
        }
        continue
      }
      // marked throws here; text always takes at least one character, so this does not happen
      break
    }
    return tokens
  }

  // MARK: extensions (the package's, in marked's order)

  private mutating func extensions(_ src: NSString, _ tokens: [InlineToken]) -> InlineToken? {
    let prevRaw = tokens.last?.raw ?? ""
    if let raw = Self.htmlInlineAt(src) { return InlineToken("htmlInline", raw: raw) }
    if let t = emoji(src) { return t }
    if let t = wikiRef(src) { return t }
    if let t = inlineMath(src, prev: String(prevRaw.utf16.suffix(1)).map { $0 } ?? "") { return t }
    if let t = markExt("x_superscript", Ext.sup, open: "^", src, prevRaw) { return t }
    if let t = markExt("x_subscript", Ext.sub, open: "~", src, prevRaw) { return t }
    if let t = markExt("x_kbd", Ext.kbd, open: "<", src, prevRaw) { return t }
    if let t = markExt("x_underline", Ext.underline, open: "<", src, prevRaw) { return t }
    if let t = markExt("x_highlight", Ext.highlight, open: "=", src, prevRaw) { return t }
    return annot(src)
  }

  /// marked's startInline: where the next extension could start (footnote references are not supported)
  static func extensionStart(_ s: NSString) -> Int? {
    var best: Int?
    func at(_ needle: String) {
      let r = s.range(of: needle, options: .literal)
      if r.location != NSNotFound { best = min(best ?? .max, r.location) }
    }
    for n in ["{", "==", "<u>", "<kbd>", "~", "^", "$", "[[", "<"] { at(n) }
    if let e = emojiStart(s) { best = min(best ?? .max, e) }
    return best
  }

  private static func emojiStart(_ s: NSString) -> Int? {
    var at = 0
    while let m = Ext.emojiStart.exec(s, lastIndex: at) {
      if Emoji.glyph(m.group(1, in: s)!) != nil { return m.range.location }
      at = m.range.location + 1
    }
    return nil
  }

  private func emoji(_ src: NSString) -> InlineToken? {
    guard let m = Ext.emoji.exec(src), let name = m.group(1, in: src), Emoji.glyph(name) != nil else { return nil }
    let t = InlineToken("emoji", raw: src.substring(with: m.range))
    t.name = name
    return t
  }

  private func wikiRef(_ src: NSString) -> InlineToken? {
    guard let m = Ext.wikiRef.exec(src), let inner = m.group(1, in: src) else { return nil }
    let r = Self.splitRef(inner)
    if r.label.isEmpty { return nil }
    let t = InlineToken("wikiRef", raw: src.substring(with: m.range))
    t.label = r.label
    t.target = r.target
    return t
  }
  static func splitRef(_ inner: String) -> (label: String, target: String?) {
    let s = inner as NSString
    if let m = Ext.refTarget.exec(s) {
      return (Mapped(s.substring(to: m.range.location)).trimmed().string, m.group(1, in: s))
    }
    return (Mapped(inner).trimmed().string, nil)
  }

  /// mathAt: src starts with a $, prev is the character right before it
  private func inlineMath(_ src: NSString, prev: String) -> InlineToken? {
    if prev == "\\" || prev == "$" { return nil }
    guard let m = Ext.inlineMath.exec(src) else { return nil }
    let t = InlineToken("inlineMath", raw: src.substring(with: m.range))
    t.display = m.groups[1] != nil
    t.latex = Mapped(m.group(1, in: src) ?? m.group(2, in: src) ?? "").trimmed().string
    return t
  }

  private mutating func markExt(_ type: String, _ re: JSRegex, open: Character, _ src: NSString, _ prevRaw: String)
    -> InlineToken?
  {
    // right after the same marker it does not open (~~ is strikethrough; == and ^ likewise)
    if prevRaw.last == open { return nil }
    guard let m = re.exec(src) else { return nil }
    let t = InlineToken(type, raw: src.substring(with: m.range))
    t.tokens = inlineTokens(m.group(1, in: src)!)
    return t
  }

  private mutating func annot(_ src: NSString) -> InlineToken? {
    guard let a = Self.annotAt(src) else { return nil }
    let un = { (t: String) in Ext.annotUnescape.replace(t, template: "$1") }
    let opts = a.opts.split(whereSeparator: { Mapped.isJSSpace(UInt16($0.utf16.first ?? 0)) }).map(String.init)
    let t = InlineToken("x_annot", raw: src.substring(to: a.len))
    t.textEnd = 1 + (a.text as NSString).length
    t.tokens = inlineTokens(un(a.text))
    t.note = Mapped(un(a.note)).trimmed().string
    t.color = ["blue", "purple", "orange", "green"].first { opts.contains($0) } ?? "blue"
    t.below = opts.contains("below")
    return t
  }

  /// annotAt (schema-marks.ts): {text|note} or {text|note|options} at the start of s
  static func annotAt(_ s: NSString) -> (text: String, note: String, opts: String, len: Int)? {
    guard s.length > 0, s.character(at: 0) == 0x7B else { return nil }
    func part(_ from: Int) -> (end: Int, by: UInt16)? {
      var depth = 0
      var i = from
      while i < s.length {
        let c = s.character(at: i)
        if c == 0x0A { return nil }
        if c == 0x5C {
          if i + 1 < s.length, s.character(at: i + 1) == 0x0A { return nil }
          i += 1
        } else if c == 0x7B {
          depth += 1
        } else if c == 0x7D && depth > 0 {
          depth -= 1
        } else if (c == 0x7D || c == 0x7C) && depth == 0 {
          return (i, c)
        }
        i += 1
      }
      return nil
    }
    guard let a = part(1), a.by == 0x7C, a.end != 1 else { return nil }
    guard let b = part(a.end + 1), b.end != a.end + 1 else { return nil }
    let text = s.substring(with: NSRange(location: 1, length: a.end - 1))
    let note = s.substring(with: NSRange(location: a.end + 1, length: b.end - a.end - 1))
    if b.by == 0x7D { return (text, note, "", b.end + 1) }
    let rest = s.substring(from: b.end) as NSString
    guard let o = Ext.annotOptions.exec(rest) else { return nil }
    return (text, note, o.group(1, in: rest)!, b.end + o.range.length)
  }

  /// htmlInlineAt (schema-nodes.ts): a tag with its matching closing tag, or one tag or comment on its own
  static func htmlInlineAt(_ src: NSString) -> String? {
    guard let m = Ext.htmlTag.exec(src) else { return nil }
    let whole = src.substring(with: m.range)
    let name = m.group(1, in: src)?.lowercased()
    if let name, !HTMLNames.names.contains(name) { return nil }
    if let name, name == "u" || name == "kbd",
      JSRegex("^<\(name)>[\\s\\S]+?</\(name)>", flags: "").test(src)
    {
      return nil
    }
    guard let name, !whole.hasPrefix("</"), !whole.hasSuffix("/>") else { return whole }
    let re = Self.tagPairs.get(name) { JSRegex("<(/?)\(name)\\b[^>]*>", flags: "gi") }
    var depth = 1
    var at = m.range.length
    while let t = re.exec(src, lastIndex: at) {
      depth += t.groups[1].map { $0.length > 0 ? -1 : 1 } ?? 1
      at = t.range.upperBound
      if depth == 0 { return src.substring(to: at) }
    }
    return whole
  }
  private static let tagPairs = RegexCache()

  // MARK: marked's inline tokenizers

  private func escape(_ src: NSString) -> InlineToken? {
    guard let m = MarkedRules.Inline.escape.exec(src) else { return nil }
    return InlineToken("escape", raw: src.substring(with: m.range), text: m.group(1, in: src))
  }

  private mutating func tag(_ src: NSString) -> InlineToken? {
    // the package's override: a tag HTML has no element for is text
    if HTMLNames.notHTMLTag(Mapped(src as String)) { return nil }
    guard let m = MarkedRules.Inline.tag.exec(src) else { return nil }
    let raw = src.substring(with: m.range)
    if !inLink && Other.startATag.test(raw) {
      inLink = true
    } else if inLink && Other.endATag.test(raw) {
      inLink = false
    }
    if !inRawBlock && Other.startPreScriptTag.test(raw) {
      inRawBlock = true
    } else if inRawBlock && Other.endPreScriptTag.test(raw) {
      inRawBlock = false
    }
    return InlineToken("html", raw: raw)
  }

  /// marked's link, then the package's: an address CommonMark rejects still makes a (broken) image, and an image takes
  /// the attribute block right after it
  private mutating func link(_ src: NSString) -> InlineToken? {
    var t = markedLink(src)
    if t == nil, let m = Ext.brokenImage.exec(src) {
      let b = InlineToken("image", raw: src.substring(with: m.range), text: m.group(1, in: src))
      b.href = Mapped(m.group(2, in: src)!).trimmed().string
      b.broken = true
      t = b
    }
    if let t, t.type == "image" {
      let rest = src.substring(from: (t.raw as NSString).length)
      if let a = Self.imageAttrsAt(rest) {
        t.raw += a.raw
        t.attrs = a.attrs
      }
    }
    return t
  }

  private mutating func markedLink(_ src: NSString) -> InlineToken? {
    guard let m = MarkedRules.Inline.link.exec(src) else { return nil }
    var cap0 = src.substring(with: m.range)
    var cap2 = m.group(2, in: src) ?? ""
    var cap3 = m.group(3, in: src)
    let cap1 = m.group(1, in: src) ?? ""
    let trimmedUrl = Mapped(cap2).trimmed().string
    if trimmedUrl.hasPrefix("<") {
      if !trimmedUrl.hasSuffix(">") { return nil }
      let inner = String(trimmedUrl.utf16.dropLast()).map { $0 } ?? ""
      var n = (inner as NSString).length
      while n > 0, (inner as NSString).character(at: n - 1) == 0x5C { n -= 1 }
      if ((trimmedUrl as NSString).length - n) % 2 == 0 { return nil }
    } else {
      let last = Self.findClosingBracket(cap2)
      if last == -2 { return nil }
      if last > -1 {
        let start = cap0.hasPrefix("!") ? 5 : 4
        let linkLen = start + (cap1 as NSString).length + last
        cap2 = (cap2 as NSString).substring(to: last)
        cap0 = Mapped((cap0 as NSString).substring(to: linkLen)).trimmed().string
        cap3 = ""
      }
    }
    var href = Mapped(cap2).trimmed().string
    var title = ""
    if let c3 = cap3, (c3 as NSString).length >= 2 {
      title = (c3 as NSString).substring(with: NSRange(location: 1, length: (c3 as NSString).length - 2))
    }
    if href.hasPrefix("<") {
      let h = href as NSString
      href = h.length >= 2 ? h.substring(with: NSRange(location: 1, length: h.length - 2)) : ""
    }
    let ap = MarkedRules.Inline.anyPunctuation
    return outputLink(
      cap0, label: cap1, href: href.isEmpty ? href : ap.replace(href, template: "$1"),
      title: title.isEmpty ? nil : ap.replace(title, template: "$1"))
  }

  private mutating func outputLink(_ raw: String, label: String, href: String, title: String?) -> InlineToken {
    let text = InlineLexer.outputLinkReplace.replace(label, template: "$1")
    inLink = true
    let t = InlineToken(raw.hasPrefix("!") ? "image" : "link", raw: raw, text: text)
    t.href = href
    t.title = title
    t.tokens = inlineTokens(text)
    inLink = false
    return t
  }
  private static let outputLinkReplace = JSRegex(#"\\([\[\]])"#, flags: "g")

  /// reflink / nolink without definitions: the [ (or !) is text
  private func reflink(_ src: NSString) -> InlineToken? {
    guard MarkedRules.Inline.reflink.test(src) || MarkedRules.Inline.nolink.test(src) else { return nil }
    let first = src.substring(to: 1)
    return InlineToken("text", raw: first)
  }

  private mutating func emStrong(_ src: NSString, _ maskedFull: NSString, _ prevChar: String) -> InlineToken? {
    // the package's override: _ never makes emphasis, * not right after a letter, digit, _ or )
    guard src.length > 0 else { return nil }
    let first = src.character(at: 0)
    if first == 0x5F { return nil }
    if first == 0x2A && Ext.wordEnd.test(prevChar) { return nil }
    guard let match = MarkedRules.Inline.emStrongLDelim.exec(src) else { return nil }
    let g = (1...4).map { match.group($0, in: src) }
    if g.allSatisfy({ $0 == nil || $0!.isEmpty }) { return nil }
    if g[3] != nil, !g[3]!.isEmpty, Other.unicodeAlphaNumeric.test(prevChar) { return nil }
    let nextChar = g[0] ?? g[2] ?? ""
    guard nextChar.isEmpty || prevChar.isEmpty || MarkedRules.Inline.punctuation.test(prevChar) else { return nil }
    let m0 = src.substring(with: match.range)
    let lLength = m0.unicodeScalars.count - 1
    var delimTotal = lLength
    var midDelimTotal = 0
    let endReg = m0.hasPrefix("*") ? MarkedRules.Inline.emStrongRDelimAst : MarkedRules.Inline.emStrongRDelimUnd
    // the masked text from just after the left delimiter (lLength counts code points; marked slices by them too
    // only through its length arithmetic, so units are used here as marked's slice does)
    let sliceFrom = maskedFull.length - src.length + lLength
    let masked = maskedFull.substring(from: max(0, sliceFrom)) as NSString
    var at = 0
    while let m = endReg.exec(masked, lastIndex: at) {
      at = m.range.length == 0 ? m.range.upperBound + 1 : m.range.upperBound
      guard let rd = (1...6).lazy.compactMap({ m.group($0, in: masked) }).first(where: { !$0.isEmpty }) else {
        continue
      }
      var rLength = rd.unicodeScalars.count
      if m.groups[3] != nil || m.groups[4] != nil {
        delimTotal += rLength
        continue
      } else if m.groups[5] != nil || m.groups[6] != nil {
        if lLength % 3 != 0 && (lLength + rLength) % 3 == 0 {
          midDelimTotal += rLength
          continue
        }
      }
      delimTotal -= rLength
      if delimTotal > 0 { continue }
      rLength = min(rLength, rLength + delimTotal + midDelimTotal)
      let whole = masked.substring(with: m.range)
      let lastCharLength = whole.unicodeScalars.first.map { $0.utf16.count } ?? 1
      let rawLen = lLength + m.range.location + lastCharLength + rLength
      let raw = src.substring(to: min(src.length, rawLen))
      let r = raw as NSString
      if min(lLength, rLength) % 2 == 1 {
        let text = r.length >= 2 ? r.substring(with: NSRange(location: 1, length: r.length - 2)) : ""
        let t = InlineToken("em", raw: raw, text: text)
        t.tokens = inlineTokens(text)
        return t
      }
      let text = r.length >= 4 ? r.substring(with: NSRange(location: 2, length: r.length - 4)) : ""
      let t = InlineToken("strong", raw: raw, text: text)
      t.tokens = inlineTokens(text)
      return t
    }
    return nil
  }

  private func codespan(_ src: NSString) -> InlineToken? {
    guard let m = MarkedRules.Inline.code.exec(src) else { return nil }
    return InlineToken("codespan", raw: src.substring(with: m.range), text: m.group(2, in: src))
  }

  private func br(_ src: NSString) -> InlineToken? {
    guard let m = MarkedRules.Inline.br.exec(src) else { return nil }
    return InlineToken("br", raw: src.substring(with: m.range))
  }

  private mutating func del(_ src: NSString, _ maskedFull: NSString, _ prevChar: String) -> InlineToken? {
    guard let match = MarkedRules.Inline.delLDelim.exec(src) else { return nil }
    let nextChar = match.group(1, in: src) ?? ""
    guard nextChar.isEmpty || prevChar.isEmpty || MarkedRules.Inline.punctuation.test(prevChar) else { return nil }
    let m0 = src.substring(with: match.range)
    let lLength = m0.unicodeScalars.count - 1
    var delimTotal = lLength
    let sliceFrom = maskedFull.length - src.length + lLength
    let masked = maskedFull.substring(from: max(0, sliceFrom)) as NSString
    var at = 0
    while let m = MarkedRules.Inline.delRDelim.exec(masked, lastIndex: at) {
      at = m.range.length == 0 ? m.range.upperBound + 1 : m.range.upperBound
      guard let rd = (1...6).lazy.compactMap({ m.group($0, in: masked) }).first(where: { !$0.isEmpty }) else {
        continue
      }
      var rLength = rd.unicodeScalars.count
      if rLength != lLength { continue }
      if m.groups[3] != nil || m.groups[4] != nil {
        delimTotal += rLength
        continue
      }
      delimTotal -= rLength
      if delimTotal > 0 { continue }
      rLength = min(rLength, rLength + delimTotal)
      let whole = masked.substring(with: m.range)
      let lastCharLength = whole.unicodeScalars.first.map { $0.utf16.count } ?? 1
      let raw = src.substring(to: min(src.length, lLength + m.range.location + lastCharLength + rLength)) as NSString
      let text =
        raw.length >= 2 * lLength
        ? raw.substring(with: NSRange(location: lLength, length: raw.length - 2 * lLength)) : ""
      let t = InlineToken("del", raw: raw as String, text: text)
      t.tokens = inlineTokens(text)
      return t
    }
    return nil
  }

  private func autolink(_ src: NSString) -> InlineToken? {
    guard let m = MarkedRules.Inline.autolink.exec(src) else { return nil }
    let text = m.group(1, in: src) ?? ""
    let t = InlineToken("link", raw: src.substring(with: m.range), text: text)
    t.href = m.group(2, in: src) == "@" ? "mailto:" + text : text
    t.tokens = [InlineToken("text", raw: text)]
    return t
  }

  private func url(_ src: NSString) -> InlineToken? {
    guard let m = MarkedRules.Inline.url.exec(src) else { return nil }
    var text: String
    var href: String
    if m.group(2, in: src) == "@" {
      text = src.substring(with: m.range)
      href = "mailto:" + text
    } else {
      var cap0 = src.substring(with: m.range)
      var prev: String
      repeat {
        prev = cap0
        let c = cap0 as NSString
        cap0 = MarkedRules.Inline.backpedal.exec(c).map { c.substring(with: $0.range) } ?? ""
      } while prev != cap0
      text = cap0
      href = m.group(1, in: src) == "www." ? "http://" + cap0 : cap0
    }
    let t = InlineToken("link", raw: text, text: text)
    t.href = href
    t.tokens = [InlineToken("text", raw: text)]
    return t
  }

  private func inlineText(_ src: NSString) -> InlineToken? {
    guard let m = MarkedRules.Inline.text.exec(src) else { return nil }
    return InlineToken("text", raw: src.substring(with: m.range))
  }

  // MARK: helpers

  /// marked's findClosingBracket for ( )
  static func findClosingBracket(_ str: String) -> Int {
    let s = Array(str.utf16)
    if !s.contains(0x29) { return -1 }
    var level = 0
    var i = 0
    while i < s.count {
      if s[i] == 0x5C {
        i += 1
      } else if s[i] == 0x28 {
        level += 1
      } else if s[i] == 0x29 {
        level -= 1
        if level < 0 { return i }
      }
      i += 1
    }
    return level > 0 ? -2 : -1
  }

  /// imageattrs.ts: the attribute block at the start of s, when it is one
  static func imageAttrsAt(_ s: String) -> (attrs: ImageAttributes, raw: String)? {
    let ns = s as NSString
    guard let m = Ext.imageAttrBlock.exec(ns), let inner = m.group(1, in: ns),
      let a = parseAttrBlock(inner)
    else { return nil }
    return (a, ns.substring(with: m.range))
  }

  static func parseAttrBlock(_ inner: String) -> ImageAttributes? {
    var a = ImageAttributes()
    var seen: Set<String> = []
    let parts = Mapped(inner).trimmed().string.split(whereSeparator: { $0.isWhitespace }).map(String.init)
    if parts.isEmpty { return nil }
    for p in parts {
      guard let eq = p.firstIndex(of: "="), eq != p.startIndex else { return nil }
      let k = String(p[..<eq])
      let v = String(p[p.index(after: eq)...])
      guard !v.isEmpty,
        k.utf8.allSatisfy({ $0 == 0x5F || ($0 >= 0x30 && $0 <= 0x39) || ($0 | 0x20 >= 0x61 && $0 | 0x20 <= 0x7A) }),
        !seen.contains(k)
      else { return nil }
      seen.insert(k)
      switch k {
      case "width":
        guard JSRegex(#"^(\d{1,3}(?:\.\d+)?)%$"#, flags: "").test(v), let w = Double(v.dropLast()), w > 0, w <= 100
        else { return nil }
        a.width = w
      case "frame":
        guard JSRegex(#"^\d{1,6}$"#, flags: "").test(v), let f = Int(v), f >= 1 else { return nil }
        a.frame = f
      case "loop" where v == "true":
        a.loop = true
      default:
        return nil
      }
    }
    return a
  }
}

/// The emoji names `:name:` reads (EmojiTable, generated from the TypeScript package's table)
enum Emoji {
  private static let table: [String: String] = {
    var d: [String: String] = [:]
    d.reserveCapacity(EmojiTable.count)
    for line in EmojiTable.lines.split(separator: "\n") {
      guard let tab = line.firstIndex(of: "\t") else { continue }
      d[String(line[..<tab])] = String(line[line.index(after: tab)...])
    }
    return d
  }()
  static func glyph(_ name: String) -> String? { table[name] }
  /// every name, in the table's order (gemoji's)
  static let names: [String] = EmojiTable.lines.split(separator: "\n").compactMap {
    $0.split(separator: "\t").first.map(String.init)
  }
}

/// The emoji a `:name:` shows (gemoji names, the TypeScript package's table)
public enum MarkdownEmoji {
  public static func glyph(_ name: String) -> String? { Emoji.glyph(name) }
}

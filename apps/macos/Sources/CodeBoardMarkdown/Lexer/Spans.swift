import Foundation

/// One inline construct in an inline text (editor/spans.ts's Span), offsets inside that text
struct Span: Equatable, Sendable {
  var from: Int
  var to: Int
  /// markers: hidden while the caret is elsewhere
  var marks: [Range<Int>]
  /// the formatted text inside
  var inner: Range<Int>?
  /// the HTML element it is drawn as ("strong", "em", "s", "code", "u", "kbd", "mark", "sub", "sup", "a", "span")
  var tag: String?
  var tagClass: String?
  var href: String?
  var atom: SpanAtom?
  /// source that always shows (an HTML comment): never hidden, not one character
  var plain = false
  var kids: [Span] = []
}

enum SpanAtom: Equatable, Sendable {
  case math(latex: String, display: Bool)
  case image(
    src: String, alt: String, title: String, width: Double?, frame: Int?, loop: Bool, altTo: Int, url: Range<Int>,
    widthAt: Range<Int>?, broken: Bool)
  case emoji(name: String)
  case ref(label: String, target: String?)
  case html(raw: String)
  case br
  case annot(note: String, color: String, below: Bool, text: String)
}

/// editor/spans.ts: how one inline text (a paragraph's, a heading's, a cell's) splits into spans
enum Spans {
  /// The placeholder an escaped \$ is read with (placeholders.ts ESC_DOLLAR): two characters still, offsets hold
  static let escDollar: UInt16 = 0xE024

  static func of(_ body: String) -> [Span] {
    if body.isEmpty { return [] }
    let src = JSRegex(#"\\\$"#, flags: "g").replace(body) { _, _ in "\\" + String(utf16CodeUnits: [escDollar], count: 1)
    }
    let toks = InlineLexer.tokens(src)
    var out: [Span] = []
    walk(toks, src as NSString, 0, &out)
    return out
  }

  private static func walk(_ toks: [InlineToken], _ src: NSString, _ base: Int, _ out: inout [Span]) {
    var at = 0
    for t in toks {
      let raw = t.raw as NSString
      let from = base + at
      let to = from + raw.length
      // the tokens no longer match the text (the lexer rewrote it): nothing after this is drawn
      guard at + raw.length <= src.length, src.substring(with: NSRange(location: at, length: raw.length)) == t.raw
      else {
        break
      }
      if let sp = spanOf(t, raw, src, at, from, to) {
        out.append(sp)
      } else if t.type == "text" || t.type == "escape" {
        textSpans(raw, from, &out)
      }
      at += raw.length
    }
  }

  private static func spanOf(_ t: InlineToken, _ raw: NSString, _ src: NSString, _ at: Int, _ from: Int, _ to: Int)
    -> Span?
  {
    func mk(_ marks: [Range<Int>], _ inner: Range<Int>?) -> Span {
      Span(from: from, to: to, marks: marks, inner: inner)
    }
    switch t.type {
    case "escape":
      return mk([from..<(from + 1)], (from + 1)..<to)
    case "codespan":
      let a = leading(raw, 0x60)
      let b = trailing(raw, 0x60)
      var s = mk([from..<(from + a), (to - b)..<to], (from + a)..<(to - b))
      s.tag = "code"
      return s
    case "link":
      let inner = t.tokens.map(\.raw).joined()
      let ni = (inner as NSString).length
      let i =
        inner.isEmpty
        ? (raw.hasPrefix("[") ? 1 : 0)
        : (raw.range(of: inner, options: .literal).location)
      if i == NSNotFound { return nil }
      var sp = mk([], (from + i)..<(from + i + ni))
      sp.tag = "a"
      sp.tagClass = "md-link"
      sp.href = t.href
      if i > 0 { sp.marks.append(from..<(from + i)) }
      if i + ni < raw.length { sp.marks.append((from + i + ni)..<to) }
      var kids: [Span] = []
      walk(t.tokens, src.substring(with: NSRange(location: at + i, length: ni)) as NSString, from + i, &kids)
      sp.kids = kids
      return sp
    case "image":
      var s = mk([], nil)
      s.atom = imageAtom(t, raw, from)
      return s
    case "inlineMath":
      let d = raw.hasPrefix("$$") ? 2 : 1
      var s = mk([from..<(from + d), (to - d)..<to], (from + d)..<(to - d))
      s.atom = .math(latex: t.latex, display: t.display)
      return s
    case "emoji":
      var s = mk([from..<(from + 1), (to - 1)..<to], (from + 1)..<(to - 1))
      s.atom = .emoji(name: t.name)
      return s
    case "wikiRef":
      // the #^id after the title counts as marker with ]]: the source shows the title
      let tail = t.target.map { ($0 as NSString).length + 4 } ?? 2
      var s = mk([from..<(from + 2), (to - tail)..<to], (from + 2)..<(to - tail))
      s.tag = "span"
      s.tagClass = "md-refsrc"
      s.atom = .ref(label: t.label, target: t.target)
      return s
    case "br":
      var s = mk([from..<to], nil)
      s.atom = .br
      return s
    case "htmlInline":
      if JSRegex(#"^<br\s*\/?>$"#, flags: "i").test(raw) {
        var s = mk([from..<to], nil)
        s.atom = .br
        return s
      }
      if JSRegex(#"^<!--[\s\S]*-->$"#, flags: "").test(raw) {
        var s = mk([from..<to], nil)
        s.plain = true
        return s
      }
      var s = mk([from..<to], nil)
      s.atom = .html(raw: t.raw)
      return s
    case "x_annot":
      let k = t.textEnd
      var s = mk([from..<(from + 1), (from + k)..<to], (from + 1)..<(from + k))
      s.tag = "span"
      s.tagClass = "md-annotsrc"
      s.atom = .annot(
        note: t.note, color: t.color, below: t.below,
        text: raw.substring(with: NSRange(location: 1, length: k - 1)))
      return s
    default:
      break
    }
    guard let tag = tags[t.type], !t.tokens.isEmpty else { return nil }
    let inner = t.tokens.map(\.raw).joined()
    let ni = (inner as NSString).length
    // after a tag (<u>, <kbd>), else between markers of equal length (** and __, ~ and ~~)
    let symD = Double(raw.length - ni) / 2
    let i: Int
    if raw.hasPrefix("<") {
      i = raw.range(of: ">").location + 1
    } else if symD == symD.rounded(), Int(symD) + ni <= raw.length,
      raw.substring(with: NSRange(location: Int(symD), length: ni)) == inner
    {
      i = Int(symD)
    } else {
      let r = raw.range(of: inner, options: .literal, range: NSRange(location: 1, length: raw.length - 1))
      i = r.location == NSNotFound ? -1 : r.location
    }
    guard i > 0, i + ni <= raw.length, raw.substring(with: NSRange(location: i, length: ni)) == inner else {
      return nil
    }
    var sp = mk([from..<(from + i), (from + i + ni)..<to], (from + i)..<(from + i + ni))
    sp.tag = tag
    var kids: [Span] = []
    walk(t.tokens, src.substring(with: NSRange(location: at + i, length: ni)) as NSString, from + i, &kids)
    sp.kids = kids
    return sp
  }

  private static let tags = [
    "strong": "strong", "em": "em", "del": "s", "codespan": "code", "x_underline": "u", "x_kbd": "kbd",
    "x_highlight": "mark", "x_subscript": "sub", "x_superscript": "sup",
  ]

  private static func leading(_ s: NSString, _ c: UInt16) -> Int {
    var n = 0
    while n < s.length, s.character(at: n) == c { n += 1 }
    return n
  }
  private static func trailing(_ s: NSString, _ c: UInt16) -> Int {
    var n = 0
    while n < s.length, s.character(at: s.length - 1 - n) == c { n += 1 }
    return n
  }

  /// escaped \$ in text, and $formulas$ the lexer left as text (parseMd's mathify reads them too)
  private static func textSpans(_ raw: NSString, _ from: Int, _ out: inout [Span]) {
    var i = raw.range(of: "\\").location
    while i != NSNotFound, i < raw.length - 1 {
      if raw.character(at: i + 1) == escDollar {
        out.append(
          Span(
            from: from + i, to: from + i + 2, marks: [(from + i)..<(from + i + 1)],
            inner: (from + i + 1)..<(from + i + 2)))
      }
      let next = i + 2
      if next >= raw.length { break }
      i = raw.range(of: "\\", options: .literal, range: NSRange(location: next, length: raw.length - next)).location
    }
    if raw.range(of: "$").location == NSNotFound { return }
    for m in Ext.textMath.matches(raw) {
      let lead = m.groups[1]!.length
      let latex = raw.substring(with: m.groups[2]!)
      let a = from + m.range.location + lead
      let b = a + (latex as NSString).length + 2
      var s = Span(from: a, to: b, marks: [a..<(a + 1), (b - 1)..<b], inner: (a + 1)..<(b - 1))
      s.atom = .math(latex: latex, display: false)
      out.append(s)
    }
    out.sort { $0.from < $1.from }
  }

  private static let imgHead = JSRegex(#"^!\[((?:\\.|[^\]\\])*)\]\(\s*"#, flags: "")

  private static func imageAtom(_ t: InlineToken, _ raw: NSString, _ from: Int) -> SpanAtom {
    let h = imgHead.exec(raw)
    let altTo = 2 + (h?.groups[1]?.length ?? 0)
    let urlFrom = h?.range.length ?? 2
    var urlTo = urlFrom
    if urlFrom < raw.length, raw.character(at: urlFrom) == 0x3C {
      let r = raw.range(of: ">", options: .literal, range: NSRange(location: urlFrom, length: raw.length - urlFrom))
      urlTo = r.location == NSNotFound ? urlFrom : r.location + 1
    } else {
      var depth = 0
      while urlTo < raw.length {
        let c = raw.character(at: urlTo)
        if c == 0x5C {
          urlTo += 2
          continue
        }
        if Mapped.isJSSpace(c) { break }
        if c == 0x29 {
          if depth == 0 { break }
          depth -= 1
        }
        if c == 0x28 { depth += 1 }
        urlTo += 1
      }
      urlTo = min(urlTo, raw.length)
    }
    let w = imageAttrsEnd(raw)
    return .image(
      src: t.href, alt: t.text, title: t.title ?? "", width: w?.attrs.width, frame: w?.attrs.frame,
      loop: w?.attrs.loop ?? false, altTo: from + altTo, url: (from + urlFrom)..<(from + urlTo),
      widthAt: w.map { (from + $0.at)..<(from + raw.length) }, broken: t.broken)
  }

  /// imageattrs.ts imageAttrsEnd: the attribute block that ends an image's source
  static func imageAttrsEnd(_ raw: NSString) -> (attrs: ImageAttributes, at: Int)? {
    let open = raw.range(of: "{", options: .backwards).location
    guard open != NSNotFound, open > 0, raw.hasSuffix("}"), raw.character(at: open - 1) == 0x29 else { return nil }
    let tail = raw.substring(from: open)
    guard let r = InlineLexer.imageAttrsAt(tail), (r.raw as NSString).length == raw.length - open else { return nil }
    return (r.attrs, open)
  }

  /// all spans, nested ones included, in order
  static func flat(_ spans: [Span]) -> [Span] {
    var out: [Span] = []
    for s in spans {
      out.append(s)
      out += flat(s.kids)
    }
    return out
  }
}

import CodeBoardMarkdown
import CoreText
import Foundation

/// How a piece of inline text looks: the attributes inline formatting stacks up
struct InlineStyle {
  var families: [String]
  var size: CGFloat
  var weight: Double
  var italic = false
  var color: MDColor
  var mono = false
  var strike: MDColor?
  var underline: MDColor?
  var highlight: MDColor?
  /// a stroke width around the glyphs, as a share of the size (bold in Ink Wash)
  var stroke: Double = 0
  /// inline code and kbd: a box behind the text
  var box: InlineBox?
  /// sub (-1) or sup (+1)
  var shift = 0
}

/// A box drawn behind inline code or kbd
struct InlineBox: Hashable {
  var fill: MDColor?
  var stroke: MDColor?
  var radius: CGFloat
  /// the horizontal padding inside it: spacers before and after the text make room for it
  var pad: CGFloat
}

/// Attribute keys the layout reads back after CoreText has set the lines
enum Attr {
  static let box = NSAttributedString.Key("md.box")
  static let boxID = NSAttributedString.Key("md.boxID")
  static let strike = NSAttributedString.Key("md.strike")
  static let highlight = NSAttributedString.Key("md.highlight")
  static let atom = NSAttributedString.Key("md.atom")
  static let link = NSAttributedString.Key("md.link")
  static let underline = NSAttributedString.Key("md.underline")
  static let ref = NSAttributedString.Key("md.ref")
}

/// Something drawn in place of its source: its size and how it sits on the line
final class AtomBox: @unchecked Sendable {
  enum Content {
    case math(MathPicture, size: CGFloat)
    case image(src: String, nth: Int, size: CGSize, broken: Bool, frame: Int?, loops: Bool)
    case ref(RefBox)
    case spacer
  }
  let content: Content
  let width: CGFloat
  /// above and below the baseline
  let ascent: CGFloat
  let descent: CGFloat
  init(_ content: Content, width: CGFloat, ascent: CGFloat, descent: CGFloat) {
    self.content = content
    self.width = width
    self.ascent = ascent
    self.descent = descent
  }
}

/// An inline text made ready for CoreText: the display string (markers left out, atoms one character each) and, for each
/// of its UTF-16 units, the source offset it shows
struct DisplayText {
  var string = NSMutableAttributedString()
  var toSource: [Int] = []
  var endSource = 0
  /// links in display ranges, for hits
  var links: [(NSRange, String)] = []
  var refs: [(NSRange, String, String?)] = []
}

/// Builds display text for one inline text with every marker hidden (the static picture is the editor with the caret
/// nowhere)
struct InlineBuilder {
  let theme: MarkdownTheme
  let resources: MarkdownResources
  /// how many images of each address came before, for MarkdownImageSlot.nth
  var imageCounts: [String: Int]
  /// the width images are sized against (the body's)
  let bodyWidth: CGFloat
  var out = DisplayText()
  private var boxCount = 0

  init(theme: MarkdownTheme, resources: MarkdownResources, imageCounts: [String: Int], bodyWidth: CGFloat) {
    self.theme = theme
    self.resources = resources
    self.imageCounts = imageCounts
    self.bodyWidth = bodyWidth
  }

  mutating func build(_ text: MDText, _ inlines: [MDInline], _ style: InlineStyle) -> DisplayText {
    out = DisplayText()
    out.endSource = text.offsets.last ?? 0
    let units = Array(text.string.utf16)
    emit(units, text.offsets, 0..<units.count, inlines, style)
    return out
  }

  /// the inline-text index of a source offset (the first unit at or after it)
  private func index(_ offsets: [Int], _ source: Int) -> Int {
    var lo = 0
    var hi = offsets.count - 1
    while lo < hi {
      let mid = (lo + hi) / 2
      if offsets[mid] < source { lo = mid + 1 } else { hi = mid }
    }
    return lo
  }

  private mutating func emit(
    _ u: [UInt16], _ offsets: [Int], _ range: Range<Int>, _ ins: [MDInline], _ style: InlineStyle
  ) {
    var pos = range.lowerBound
    for i in ins {
      let a = max(pos, index(offsets, i.range.lowerBound))
      let b = min(range.upperBound, index(offsets, i.range.upperBound))
      if a > pos { plain(u, offsets, pos..<a, style) }
      inline(i, u, offsets, a..<max(a, b), style)
      pos = max(pos, b)
    }
    if pos < range.upperBound { plain(u, offsets, pos..<range.upperBound, style) }
  }

  private mutating func inline(_ i: MDInline, _ u: [UInt16], _ offsets: [Int], _ r: Range<Int>, _ style: InlineStyle) {
    let m = theme.metrics
    var s = style
    let innerRange = i.inner.map { index(offsets, $0.lowerBound)..<index(offsets, $0.upperBound) }
    switch i.kind {
    case .atom(let atom):
      self.atom(atom, i, u, offsets, r, innerRange, style)
      return
    case .text:
      // an escape shows what it escapes; source shown as written (an HTML comment) is faint
      if let inner = innerRange {
        plain(u, offsets, inner, style)
      } else {
        s.color = theme.colors.ink3
        plain(u, offsets, r, s)
      }
      return
    case .strong:
      s.weight = m.strongWeight
      s.stroke = m.strongStroke
    case .emphasis: s.italic = true
    case .strike:
      s.strike = theme.colors.ink2
      s.color = theme.colors.ink2
    case .highlight: s.highlight = theme.marks.highlight
    case .underline: s.underline = s.color
    case .code:
      s.families = theme.fonts.mono
      s.mono = true
      s.size = m.em(m.inlineCodeSize)
      s.weight = 400
      s.box = InlineBox(
        fill: theme.colors.fill, stroke: nil, radius: CGFloat(m.inlineCodeRadius), pad: CGFloat(m.inlineCodePadding))
    case .kbd:
      s.families = theme.fonts.mono
      s.mono = true
      s.size = m.em(m.kbdSize)
      s.box = InlineBox(fill: nil, stroke: theme.colors.hair, radius: 4, pad: CGFloat(m.kbdPadding))
    case .subscript:
      s.shift = -1
      s.size = style.size * 0.75
    case .superscript:
      s.shift = 1
      s.size = style.size * 0.75
    case .link(let url), .autolink(let url):
      s.color = theme.colors.link
      s.underline = theme.colors.link.alpha(m.linkUnderlineAlpha)
      let start = out.string.length
      emitInner(i, u, offsets, r, innerRange, s)
      out.links.append((NSRange(location: start, length: out.string.length - start), url))
      return
    }
    emitInner(i, u, offsets, r, innerRange, s)
  }

  private mutating func emitInner(
    _ i: MDInline, _ u: [UInt16], _ offsets: [Int], _ r: Range<Int>, _ inner: Range<Int>?, _ s: InlineStyle
  ) {
    let range = inner ?? r
    if let box = s.box {
      boxCount += 1
      spacer(box.pad, at: offsets[range.lowerBound], s, box: boxCount)
      emit(u, offsets, range, i.children, s, box: boxCount)
      spacer(box.pad, at: offsets[max(range.lowerBound, range.upperBound - 1)], s, box: boxCount)
    } else {
      emit(u, offsets, range, i.children, s)
    }
  }

  private mutating func emit(
    _ u: [UInt16], _ offsets: [Int], _ r: Range<Int>, _ ins: [MDInline], _ s: InlineStyle, box: Int
  ) {
    let start = out.string.length
    emit(u, offsets, r, ins, s)
    out.string.addAttribute(Attr.boxID, value: box, range: NSRange(location: start, length: out.string.length - start))
  }

  /// room for an inline box's padding: an invisible character as wide as the padding
  private mutating func spacer(_ w: CGFloat, at source: Int, _ s: InlineStyle, box: Int) {
    let a = AtomBox(.spacer, width: w, ascent: 0, descent: 0)
    var attrs = attributes(s)
    attrs[NSAttributedString.Key(kCTRunDelegateAttributeName as String)] = Self.delegate(a)
    attrs[Attr.atom] = a
    attrs[Attr.boxID] = box
    append("\u{FFFC}", attrs, source: [source])
  }

  private mutating func plain(_ u: [UInt16], _ offsets: [Int], _ r: Range<Int>, _ s: InlineStyle) {
    if r.isEmpty { return }
    let str = String(decoding: u[r], as: UTF16.self)
    append(str, attributes(s), source: Array(offsets[r]))
  }

  private mutating func append(_ str: String, _ attrs: [NSAttributedString.Key: Any], source: [Int]) {
    out.string.append(NSAttributedString(string: str, attributes: attrs))
    // a string can come out longer than its source units (never here, but keep the map the display's length)
    let n = (str as NSString).length
    out.toSource += source.count == n ? source : Array(repeating: source.first ?? out.endSource, count: n)
  }

  func attributes(_ s: InlineStyle) -> [NSAttributedString.Key: Any] {
    let font = FontBook.font(s.families, size: s.size, weight: s.weight, italic: s.italic)
    var a: [NSAttributedString.Key: Any] = [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): s.color.cg,
      // ligatures off, as the page has them (the editor needs it to place the caret inside one)
      NSAttributedString.Key(kCTLigatureAttributeName as String): 0,
    ]
    if let c = s.strike { a[Attr.strike] = c }
    if let c = s.highlight { a[Attr.highlight] = c }
    // underlines are drawn by the layout (CoreText's sit too close to the text for text-underline-offset)
    if let c = s.underline { a[Attr.underline] = c }
    if s.stroke > 0 {
      // a negative stroke width fills and strokes (percent of the size)
      a[NSAttributedString.Key(kCTStrokeWidthAttributeName as String)] = -s.stroke * 100
      a[NSAttributedString.Key(kCTStrokeColorAttributeName as String)] = s.color.cg
    }
    if let b = s.box { a[Attr.box] = b }
    if s.shift != 0 {
      // drawn with a flipped text matrix: a positive offset goes down there, so a superscript's is negative
      a[NSAttributedString.Key(kCTBaselineOffsetAttributeName as String)] = -CGFloat(s.shift) * s.size * 0.45
    }
    return a
  }

  // MARK: atoms

  private mutating func atom(
    _ atom: MDAtom, _ i: MDInline, _ u: [UInt16], _ offsets: [Int], _ r: Range<Int>, _ inner: Range<Int>?,
    _ style: InlineStyle
  ) {
    let source = offsets[min(r.lowerBound, offsets.count - 1)]
    switch atom {
    case .emoji(let name):
      append(Emoji.glyph(name) ?? ":\(name):", attributes(style), source: [source])
    case .lineBreak:
      append("\u{2028}", attributes(style), source: [source])
    case .html(let raw):
      var s = style
      s.families = theme.fonts.mono
      s.size = theme.metrics.em(theme.metrics.htmlSize)
      s.color = theme.colors.ink3
      append(raw, attributes(s), source: [source])
    case .ref(let label, let target):
      let box = RefBox(label: label, hit: resources.ref(label: label, target: target), style: style, theme: theme)
      let a = AtomBox(.ref(box), width: box.width, ascent: box.ascent, descent: box.descent)
      var attrs = attributes(style)
      attrs[NSAttributedString.Key(kCTRunDelegateAttributeName as String)] = Self.delegate(a)
      attrs[Attr.atom] = a
      let start = out.string.length
      append("\u{FFFC}", attrs, source: [source])
      out.refs.append((NSRange(location: start, length: 1), label, target))
    case .annotation:
      // the annotated text shows; its note is drawn above it by the line layout
      var s = style
      if case .annotation(_, _, let color, _) = atom {
        s.underline = theme.marks.annotations[color] ?? theme.colors.link
      }
      if let inner { emit(u, offsets, inner, i.children, s) }
    case .math(let latex, let display):
      mathAtom(latex, display: display, source: source, style)
    case .image(let img):
      imageAtom(img, source: source, style)
    }
  }

  private mutating func mathAtom(_ latex: String, display: Bool, source: Int, _ style: InlineStyle) {
    // KaTeX draws formulas 1.08 times the text size (markdown.css .katex)
    let size = style.size * 1.08
    if let tex = resources.math,
      case .ok(let pic) = tex.typeset(latex, display: display, preamble: resources.mathPreamble)
    {
      let a = AtomBox(
        .math(pic, size: size), width: CGFloat(pic.width) * size, ascent: CGFloat(pic.baseline) * size,
        descent: CGFloat(pic.height - pic.baseline) * size)
      var attrs = attributes(style)
      attrs[NSAttributedString.Key(kCTRunDelegateAttributeName as String)] = Self.delegate(a)
      attrs[Attr.atom] = a
      append("\u{FFFC}", attrs, source: [source])
      return
    }
    // no typesetter (or the formula does not typeset): its TeX, in the code font
    var s = style
    s.families = theme.fonts.mono
    s.size = theme.metrics.em(theme.metrics.inlineCodeSize)
    s.color = theme.colors.ink2
    append(display ? "$$\(latex)$$" : "$\(latex)$", attributes(s), source: [source])
  }

  private mutating func imageAtom(_ img: MDImage, source: Int, _ style: InlineStyle) {
    let nth = imageCounts[img.src, default: 0]
    imageCounts[img.src] = nth + 1
    let natural = img.broken ? nil : resources.imageSize(img.src)
    var size: CGSize
    if let n = natural, n.width > 0, n.height > 0 {
      var w = img.width.map { CGFloat($0) * bodyWidth } ?? n.width
      w = min(w, bodyWidth)
      size = CGSize(width: w, height: w * n.height / n.width)
    } else {
      // a broken image: a quiet fixed-size box
      size = CGSize(width: min(bodyWidth, 160), height: 28)
    }
    let m = CGFloat(theme.metrics.imageMargin)
    // vertical-align: middle with 4px margins: centred on the baseline plus half an x-height
    let font = FontBook.font(style.families, size: style.size, weight: style.weight)
    let mid = CTFontGetXHeight(font) / 2
    let half = size.height / 2 + m
    let a = AtomBox(
      .image(src: img.src, nth: nth, size: size, broken: natural == nil, frame: img.frame, loops: img.loops),
      width: size.width, ascent: half + mid, descent: max(0, half - mid))
    var attrs = attributes(style)
    attrs[NSAttributedString.Key(kCTRunDelegateAttributeName as String)] = Self.delegate(a)
    attrs[Attr.atom] = a
    append("\u{FFFC}", attrs, source: [source])
  }

  /// a CTRunDelegate giving the atom's width, ascent and descent (it holds the box)
  static func delegate(_ a: AtomBox) -> CTRunDelegate {
    var cb = CTRunDelegateCallbacks(
      version: kCTRunDelegateVersion1,
      dealloc: { Unmanaged<AtomBox>.fromOpaque($0).release() },
      getAscent: { Unmanaged<AtomBox>.fromOpaque($0).takeUnretainedValue().ascent },
      getDescent: { Unmanaged<AtomBox>.fromOpaque($0).takeUnretainedValue().descent },
      getWidth: { Unmanaged<AtomBox>.fromOpaque($0).takeUnretainedValue().width })
    return CTRunDelegateCreate(&cb, Unmanaged.passRetained(a).toOpaque())!
  }
}

/// The emoji glyph for a gemoji name
enum Emoji {
  static func glyph(_ name: String) -> String? { MarkdownEmoji.glyph(name) }
}

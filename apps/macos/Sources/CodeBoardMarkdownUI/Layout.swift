import CodeBoardMarkdown
import CoreGraphics
import CoreText
import Foundation

/// One piece of Markdown laid out at 100 %: immutable, made on any thread, drawn on any thread at any scale. Line breaks
/// never depend on the scale it is drawn at (guideline 3.1).
public final class MarkdownLayout: @unchecked Sendable {
  public let size: CGSize
  /// each top-level block's box, one to one with document.blocks
  public let blockFrames: [CGRect]
  /// the images to draw: where and how wide; the host decodes them for the scale it draws at
  public let images: [MarkdownImageSlot]
  let items: [Item]
  let theme: MarkdownTheme
  /// what text inside formulas is drawn with: what the typesetter measured it with
  let mathTextFont: [String]?

  init(
    size: CGSize, blockFrames: [CGRect], images: [MarkdownImageSlot], items: [Item], theme: MarkdownTheme,
    mathTextFont: [String]?
  ) {
    self.mathTextFont = mathTextFont
    self.size = size
    self.blockFrames = blockFrames
    self.images = images
    self.items = items
    self.theme = theme
  }

  /// Lays the document out `width` points wide (nil: as wide as its widest paragraph line or code line, max-content;
  /// tables, formulas, diagrams and images do not widen it)
  public static func make(
    _ document: MarkdownDocument, width: CGFloat?, theme: MarkdownTheme, layout: MDLayoutInfo?,
    resources: MarkdownResources
  ) -> MarkdownLayout {
    var b = LayoutBuilder(theme: theme, resources: resources, info: layout, width: width ?? 100_000)
    b.setSource(document.source)
    let frames = b.top(document.blocks)
    let w = width ?? ceil(b.widest)
    return MarkdownLayout(
      size: CGSize(width: w, height: ceil(b.bottom * 100) / 100), blockFrames: frames, images: b.images, items: b.items,
      theme: theme, mathTextFont: (resources.math as? JSEngines)?.textFont)
  }
}

/// Where a point lands
public enum MarkdownHit: Sendable, Equatable {
  case text(offset: Int)
  case link(url: String)
  case ref(label: String, target: String?)
  case task(nth: Int)
  case image(src: String, nth: Int)
}

/// One image to draw
public struct MarkdownImageSlot: Sendable, Hashable {
  /// the address as the Markdown writes it, and which image of that address this is (from 0)
  public var src: String
  public var nth: Int
  /// where, in 100 % coordinates
  public var frame: CGRect
  /// an animated image's still frame (from 1); nil: the first
  public var stillFrame: Int?
  public var loops: Bool
  /// no picture can be had: drawn as a broken-image box, never asked for
  public var broken: Bool
  /// the pixel width to decode for drawing at `scale` device pixels per point
  public func pixelWidth(at scale: CGFloat) -> Int { Int((frame.width * scale).rounded(.up)) }
}

/// What layout makes: things to draw, in order
enum Item {
  case text(TextBlock)
  case fill(CGRect, radius: CGFloat, MDColor)
  /// a rounded frame or a line (rect of zero height or width) stroked at `width`
  case stroke(CGRect, radius: CGFloat, MDColor, width: CGFloat)
  case line(CGPoint, CGPoint, MDColor, width: CGFloat)
  case checkbox(CGRect, checked: Bool, radius: CGFloat)
  /// a table header row's background, with the frame's rounded top corners
  case header(CGRect, radius: CGFloat, MDColor)
  /// items drawn clipped to a rect (a code block or table wider than the body)
  case clip(CGRect, [Item])
  case image(MarkdownImageSlot)
  /// an image's caption, or a broken image's box, in the figure's frame
  case figure(FigureBox, CGRect)
  /// {text|note}, its top left at the point
  case annot(AnnotBox, CGPoint)
  /// a Mermaid diagram's shapes and labels, in points from the frame's top left
  case diagram([MDPath], [MDGlyphText], CGRect)
  /// a [[reference]], its baseline starting at the point
  case ref(RefBox, CGPoint)
  /// a list bullet: 0 a disc, 1 a ring, 2 a square
  case bullet(CGRect, Int, MDColor)
  case math(MathPicture, size: CGFloat, origin: CGPoint, color: MDColor)

  var bounds: CGRect {
    switch self {
    case .text(let t): t.frame
    case .fill(let r, _, _), .stroke(let r, _, _, _), .checkbox(let r, _, _), .header(let r, _, _), .clip(let r, _): r
    case .line(let a, let b, _, let w):
      CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y)).insetBy(dx: -w, dy: -w)
    case .image(let s): s.frame
    case .bullet(let r, _, _): r
    case .diagram(_, _, let r): r
    case .figure(let f, let r):
      CGRect(
        x: r.minX + min(0, f.captionX), y: r.minY, width: max(r.width, f.caption?.size.width ?? 0), height: r.height)
    case .annot(let b, let o):
      CGRect(x: o.x - b.note.size.width, y: o.y, width: b.width + 2 * b.note.size.width, height: b.height)
    case .ref(let b, let o): CGRect(x: o.x, y: o.y - b.ascent, width: b.width, height: b.ascent + b.descent)
    case .math(let p, let size, let o, _):
      CGRect(
        x: o.x, y: o.y - CGFloat(p.baseline) * size, width: CGFloat(p.width) * size, height: CGFloat(p.height) * size)
    }
  }
}

/// A run of text set into lines
final class TextBlock {
  struct Line {
    let line: CTLine
    /// where the line's baseline starts (y down)
    let origin: CGPoint
    /// the line box
    let top: CGFloat
    let height: CGFloat
    let range: NSRange
  }
  let display: DisplayText
  let lines: [Line]
  let frame: CGRect
  /// its widest line's width, trailing spaces left out (what it would take without wrapping, max-content)
  let widest: CGFloat
  init(display: DisplayText, lines: [Line], frame: CGRect, widest: CGFloat = 0) {
    self.display = display
    self.lines = lines
    self.frame = frame
    self.widest = widest
  }
}

/// How a block is spaced (markdown.css): a paragraph, a block spaced like one, or neither (gaps.ts)
private enum GapKind { case p, block, none }

struct LayoutBuilder {
  let theme: MarkdownTheme
  let resources: MarkdownResources
  let info: MDLayoutInfo?
  let width: CGFloat
  var items: [Item] = []
  var images: [MarkdownImageSlot] = []
  var imageCounts: [String: Int] = [:]
  var bottom: CGFloat = 0
  var widest: CGFloat = 0
  var tableIndex = 0
  var codeIndex = 0
  var taskIndex = 0
  /// how deep in quotes and list items the block being laid out is
  var nesting = 0
  var m: MarkdownTheme.Metrics { theme.metrics }

  init(theme: MarkdownTheme, resources: MarkdownResources, info: MDLayoutInfo?, width: CGFloat) {
    self.theme = theme
    self.resources = resources
    self.info = info
    self.width = width
  }

  var bodyStyle: InlineStyle {
    InlineStyle(
      families: theme.fonts.body, size: m.em(1), weight: m.bodyWeight, color: theme.colors.ink,
      kern: CGFloat(m.tracking))
  }

  mutating func top(_ blocks: [MDBlock]) -> [CGRect] {
    let (frames, end) = stack(blocks, x: 0, width: width, y: 0, style: bodyStyle)
    bottom = end
    return frames
  }

  // MARK: blocks

  private func gapKind(_ b: MDBlock) -> GapKind {
    switch b.kind {
    case .paragraph: .p
    case .list, .quote, .code, .mermaid, .table, .math: .block
    default: .none
    }
  }
  /// a block's own margins (top, bottom)
  private func margins(_ b: MDBlock) -> (CGFloat, CGFloat) {
    switch b.kind {
    case .heading(let l):
      let mm = m.headingMargins[min(5, max(0, l - 1))]
      return (CGFloat(mm[0]), CGFloat(mm[1]))
    case .list: return (CGFloat(m.listMargin), CGFloat(m.listMargin))
    case .quote: return (CGFloat(m.quoteMargin), CGFloat(m.quoteMargin))
    case .code: return (CGFloat(m.codeMargin), CGFloat(m.codeMargin))
    // a drawn diagram's margin (.mmd); one shown as its source is a code block
    case .mermaid: return resources.diagrams == nil ? (CGFloat(m.codeMargin), CGFloat(m.codeMargin)) : (4, 4)
    case .table: return (CGFloat(m.tableMargin), CGFloat(m.tableMargin))
    case .rule: return (CGFloat(m.ruleMargin), CGFloat(m.ruleMargin))
    default: return (0, 0)
    }
  }

  /// Blocks one under another; neighbouring margins collapse into the larger, and a paragraph next to a paragraph or a
  /// block gets the paragraph gap. The first block's top margin and the last one's bottom margin stay out (the
  /// container's own margins hold them)
  mutating func stack(_ blocks: [MDBlock], x: CGFloat, width: CGFloat, y y0: CGFloat, style: InlineStyle) -> (
    [CGRect], CGFloat
  ) {
    var y = y0
    var frames: [CGRect] = []
    var prev: MDBlock?
    for b in blocks {
      let (mt, _) = margins(b)
      if let p = prev {
        let (_, mb) = margins(p)
        let pk = gapKind(p)
        let k = gapKind(b)
        if pk == .p && k == .block {
          // .md-gap on a block after a paragraph: its top margin is the gap, half an em of its own text (a code
          // block's is the code's), in place of its own margin
          let em = { if case .code = b.kind { CGFloat(m.codeSize) } else { m.em(1) } }()
          y += max(mb, em * CGFloat(m.paragraphGap))
        } else {
          let paragraphGap = (pk == .p && k == .p) || (pk == .block && k == .p) ? m.em(m.paragraphGap) : 0
          y += max(mb, mt, paragraphGap)
        }
      }
      let top = y
      y = block(b, x: x, width: width, y: y, style: style)
      frames.append(CGRect(x: x, y: top, width: width, height: y - top))
      prev = b
    }
    return (frames, y)
  }

  /// lays one block out at y; returns its bottom
  mutating func block(_ b: MDBlock, x: CGFloat, width: CGFloat, y: CGFloat, style: InlineStyle) -> CGFloat {
    switch b.kind {
    case .paragraph:
      guard let t = b.inlineText else { return y }
      // centred (render.ts md-psized): a paragraph with a narrowed image anywhere, one that is only an image at the top
      let images = b.inlines.compactMap { i -> MDImage? in
        if case .atom(.image(let img)) = i.kind { return img }
        return nil
      }
      let alone =
        nesting == 0 && images.count == 1 && b.inlines.count == 1
        && t.string.trimmingCharacters(in: .whitespaces).utf16.count == b.inlines[0].range.count
      let centred = alone || images.contains { $0.width != nil }
      return paragraph(
        t, b.inlines, x: x, width: width, y: y, style: style, lineHeight: CGFloat(m.lineHeight),
        center: centred || (m.center && nesting == 0))
    case .heading(let level):
      guard let t = b.inlineText else { return y }
      let l = min(5, max(0, level - 1))
      var s = style
      s.families = theme.fonts.headings[min(l, theme.fonts.headings.count - 1)]
      s.size = m.em(m.headingSizes[l])
      s.weight = m.headingWeight
      if l == 0 { s.kern = s.size * CGFloat(m.h1Tracking) }
      if let c = theme.colors.heading { s.color = c }
      return paragraph(
        t, b.inlines, x: x, width: width, y: y, style: s, lineHeight: CGFloat(m.headingLineHeights[l]),
        center: m.center && nesting == 0
      )
    case .quote(let children):
      var s = style
      s.color = theme.colors.ink2
      // the bar is the quote's left border; its padding comes after it
      let bar = CGFloat(m.quoteBar)
      let pad = CGFloat(m.quotePadding) + bar
      nesting += 1
      let (_, end) = stack(children, x: x + pad, width: width - pad, y: y, style: s)
      nesting -= 1
      items.append(.fill(CGRect(x: x, y: y, width: bar, height: end - y), radius: 0, theme.colors.hair))
      return end
    case .list(let list):
      return self.list(list, x: x, width: width, y: y, style: style)
    case .code(let language, let body):
      return code(body: body, language: language, b: b, x: x, width: width, y: y)
    case .mermaid(let body):
      return diagram(body: body, b: b, x: x, width: width, y: y)
    case .math(let latex):
      return mathBlock(latex, x: x, width: width, y: y, style: style)
    case .table(let t):
      return table(t, x: x, width: width, y: y, style: style)
    case .rule:
      items.append(.fill(CGRect(x: x, y: y, width: width, height: 1), radius: 0, theme.colors.hair))
      return y + 1
    case .html:
      // shown as its source: faint, in the code font
      var s = style
      s.families = theme.fonts.mono
      s.size = m.em(m.htmlSize)
      s.color = theme.colors.ink3
      let text = MDText(string: sourceText(b.range), offsets: Array(b.range.lowerBound...b.range.upperBound))
      return paragraph(text, [], x: x, width: width, y: y, style: s, lineHeight: CGFloat(m.lineHeight))
    }
  }

  /// the source of a range: blocks keep no source of their own; an HTML block's text is its range of the document
  private var source: String = ""
  private func sourceText(_ r: Range<Int>) -> String {
    (source as NSString).substring(with: NSRange(location: r.lowerBound, length: r.count))
  }
  mutating func setSource(_ s: String) { source = s }

  // MARK: text

  mutating func paragraph(
    _ text: MDText, _ inlines: [MDInline], x: CGFloat, width: CGFloat, y: CGFloat, style: InlineStyle,
    lineHeight: CGFloat, center: Bool = false
  ) -> CGFloat {
    var ib = InlineBuilder(theme: theme, resources: resources, imageCounts: imageCounts, bodyWidth: width)
    let d = ib.build(text, inlines, style)
    imageCounts = ib.imageCounts
    let tb = setText(d, x: x, width: width, y: y, style: style, lineHeight: lineHeight, center: center)
    widest = max(widest, x + tb.widest)
    items.append(.text(tb))
    atoms(tb)
    return tb.frame.maxY
  }

  /// CSS line boxes: every line is `lineHeight` × the font size tall, its baseline where half-leading puts the strut
  /// font's ascent; an atom taller than that makes its line taller
  func setText(
    _ d: DisplayText, x: CGFloat, width: CGFloat, y: CGFloat, style: InlineStyle, lineHeight: CGFloat,
    center: Bool = false, right: Bool = false, wrap: Bool = true
  ) -> TextBlock {
    let strut = FontBook.font(style.families, size: style.size, weight: style.weight, italic: style.italic)
    let lh = lineHeight * style.size
    let strutAbove = FontBook.baseline(strut, lineHeight: lh)
    var lines: [TextBlock.Line] = []
    var top = y
    let attr = d.string
    let n = attr.length
    var widest: CGFloat = 0
    if n == 0 {
      // an empty paragraph keeps one line's height
      let line = CTLineCreateWithAttributedString(NSAttributedString(string: ""))
      lines.append(
        .init(line: line, origin: CGPoint(x: x, y: top + strutAbove), top: top, height: lh, range: NSRange()))
      return TextBlock(display: d, lines: lines, frame: CGRect(x: x, y: y, width: width, height: lh))
    }
    let ts = CTTypesetterCreateWithAttributedString(attr)
    var start = 0
    while start < n {
      var len = wrap ? CTTypesetterSuggestLineBreak(ts, start, Double(width)) : n - start
      if !wrap,
        let nl = (attr.string as NSString).rangeOfCharacter(
          from: .newlines, range: NSRange(location: start, length: n - start)
        ).location as Int?, nl != NSNotFound
      {
        len = nl - start + 1
      }
      len = max(1, len)
      let line = CTTypesetterCreateLine(ts, CFRange(location: start, length: len))
      var above = strutAbove
      var below = lh - strutAbove
      var centred = center
      for run in CTLineGetGlyphRuns(line) as! [CTRun] {
        let attrs = CTRunGetAttributes(run) as NSDictionary
        if let a = attrs[Attr.atom] as? AtomBox {
          above = max(above, a.ascent)
          below = max(below, a.descent)
          if a.center { centred = true }
        }
      }
      let lw = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil) - CTLineGetTrailingWhitespaceWidth(line))
      widest = max(widest, lw)
      let lx = centred ? x + max(0, (width - lw) / 2) : right ? x + max(0, width - lw) : x
      lines.append(
        .init(
          line: line, origin: CGPoint(x: lx, y: top + above), top: top, height: above + below,
          range: NSRange(location: start, length: len)))
      top += above + below
      start += len
    }
    return TextBlock(
      display: d, lines: lines, frame: CGRect(x: x, y: y, width: wrap ? width : widest, height: top - y), widest: widest
    )
  }

  /// images and formulas of a text block, placed where their characters are
  mutating func atoms(_ tb: TextBlock) {
    for l in tb.lines {
      for run in CTLineGetGlyphRuns(l.line) as! [CTRun] {
        let attrs = CTRunGetAttributes(run) as NSDictionary
        guard let a = attrs[Attr.atom] as? AtomBox else { continue }
        let at = CTRunGetStringRange(run).location
        let x = l.origin.x + CTLineGetOffsetForStringIndex(l.line, at, nil)
        switch a.content {
        case .math(let pic, let size):
          let color = (attrs[kCTForegroundColorAttributeName] as! CGColor)
          items.append(.math(pic, size: size, origin: CGPoint(x: x, y: l.origin.y), color: Self.mdColor(color)))
        case .image(let src, let nth, let figure, let broken, let frame, let loops):
          // the box is centred on the baseline less half an x-height (vertical-align: middle)
          let mid = (a.ascent - a.descent) / 2
          let top = l.origin.y - mid - figure.height / 2
          if let label = figure.broken {
            _ = label
            items.append(.figure(figure, CGRect(x: x, y: top, width: figure.width, height: figure.height)))
            break
          }
          let r = CGRect(x: x, y: top, width: figure.image.width, height: figure.image.height)
          let slot = MarkdownImageSlot(src: src, nth: nth, frame: r, stillFrame: frame, loops: loops, broken: broken)
          images.append(slot)
          items.append(.image(slot))
          if figure.caption != nil {
            items.append(.figure(figure, CGRect(x: x, y: top, width: figure.width, height: figure.height)))
          }
        case .annot(let box):
          items.append(.annot(box, CGPoint(x: x, y: l.origin.y - box.baseline)))
        case .ref(let box):
          items.append(.ref(box, CGPoint(x: x, y: l.origin.y)))
        case .spacer:
          break
        }
      }
    }
  }

  static func mdColor(_ c: CGColor) -> MDColor {
    let s = c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil) ?? c
    let k = s.components ?? [0, 0, 0, 1]
    return k.count >= 4 ? MDColor(k[0], k[1], k[2], k[3]) : MDColor(k[0], k[0], k[0], k.count > 1 ? k[1] : 1)
  }

  // MARK: lists

  mutating func list(_ list: MDList, x: CGFloat, width: CGFloat, y y0: CGFloat, style: InlineStyle, depth: Int = 0)
    -> CGFloat
  {
    nesting += 1
    defer { nesting -= 1 }
    var y = y0
    let task = {
      if case .task = list.marker { return true }
      return list.items.contains { $0.checked != nil }
    }()
    let indent = task ? CGFloat(m.taskIndent) : m.em(m.listIndent)
    for (i, item) in list.items.enumerated() {
      let cx = x + indent
      var s = style
      if let checked = item.checked {
        // the box, as tall as the first line, then the text after a gap
        let box = CGFloat(m.taskBox)
        let lh = CGFloat(m.lineHeight) * style.size
        items.append(
          .checkbox(
            CGRect(x: cx, y: y + (lh - box) / 2, width: box, height: box), checked: checked,
            radius: CGFloat(m.taskBoxRadius)))
        taskIndex += 1
        if checked {
          s.color = theme.colors.ink3
          s.strike = theme.colors.ink3.alpha(0.6)
        }
        let tx = cx + box + CGFloat(m.taskGap)
        let (_, end) = stack(item.children, x: tx, width: width - (tx - x), y: y, style: s)
        y = max(end, y + lh)
        continue
      }
      // the marker sits outside the item's box, in the faint ink: a number right-aligned against the item with a
      // space after it, a bullet as Chrome draws one (a disc, then a ring, then a square, 0.3em wide, its centre 1em
      // before the item, at half the x-height)
      if case .ordered(let start, _) = list.marker {
        var ms = style
        ms.color = theme.colors.ink3
        let label = "\(start + i). "
        var mb = InlineBuilder(theme: theme, resources: resources, imageCounts: [:], bodyWidth: width)
        let d = mb.build(
          MDText(string: label, offsets: Array(repeating: item.markerRange.lowerBound, count: label.utf16.count + 1)),
          [], ms)
        let mt = setText(d, x: 0, width: 1000, y: y, style: style, lineHeight: CGFloat(m.lineHeight), wrap: false)
        let mw = mt.lines.first.map { CGFloat(CTLineGetTypographicBounds($0.line, nil, nil, nil)) } ?? 0
        let lines = mt.lines.map {
          TextBlock.Line(
            line: $0.line, origin: CGPoint(x: cx - mw, y: $0.origin.y), top: $0.top, height: $0.height, range: $0.range)
        }
        items.append(
          .text(
            TextBlock(display: d, lines: lines, frame: CGRect(x: cx - mw, y: y, width: mw, height: mt.frame.height))))
      } else {
        let font = FontBook.font(style.families, size: style.size, weight: 400)
        let base = y + FontBook.baseline(font, lineHeight: CGFloat(m.lineHeight) * style.size)
        let dia = style.size * 0.3
        let c = CGPoint(x: cx - style.size, y: base - CTFontGetXHeight(font) / 2)
        let r = CGRect(x: c.x - dia / 2, y: c.y - dia / 2, width: dia, height: dia)
        items.append(.bullet(r, depth % 3, theme.colors.ink3))
      }
      var end = y
      var prev: MDBlock?
      var yy = y
      for c in item.children {
        if let p = prev {
          let pk = gapKind(p)
          let k = gapKind(c)
          let gap = (pk == .p && k != .none) || (pk == .block && k == .p) ? m.em(m.paragraphGap) : 0
          yy += max(margins(p).1, margins(c).0, gap)
        }
        if case .list(let sub) = c.kind {
          yy = self.list(sub, x: cx, width: width - indent, y: yy, style: style, depth: depth + 1)
        } else {
          yy = block(c, x: cx, width: width - indent, y: yy, style: s)
        }
        prev = c
      }
      end = max(yy, y + CGFloat(m.lineHeight) * style.size)
      // the last child's bottom margin collapses through the item into the gap before the next one (the last item's
      // collapses with the list's own)
      if i < list.items.count - 1, let last = item.children.last { end += margins(last).1 }
      y = end
    }
    return y
  }

  // MARK: code

  mutating func code(body: Range<Int>, language: String?, b: MDBlock, x: CGFloat, width: CGFloat, y: CGFloat) -> CGFloat
  {
    let wraps = info?.wrap?.contains(codeIndex) ?? false
    codeIndex += 1
    let pv = CGFloat(m.codePadding[0])
    let ph = CGFloat(m.codePadding[1])
    let text = sourceText(body)
    let lines = text.components(separatedBy: "\n")
    let tokens = language.flatMap { resources.highlight(lines: lines, language: $0) }
    var style = InlineStyle(
      families: theme.fonts.mono, size: CGFloat(m.codeSize), weight: 400, color: theme.code.plain, mono: true)
    let italic = FontBook.font(theme.fonts.mono, size: CGFloat(m.codeSize), weight: 400, italic: true)
    let keyword = theme.code.keywordWeight.map {
      FontBook.font(theme.fonts.mono, size: CGFloat(m.codeSize), weight: $0)
    }
    let lh = CGFloat(m.codeLineHeight)
    var yy = y + pv
    var inner: [Item] = []
    for (i, line) in lines.enumerated() {
      let attr = NSMutableAttributedString(
        string: line,
        attributes: InlineBuilder(theme: theme, resources: resources, imageCounts: [:], bodyWidth: width).attributes(
          style))
      // code blocks keep the code font's ligatures, as the page's code editor draws them (prose turns them off)
      attr.addAttribute(
        NSAttributedString.Key(kCTLigatureAttributeName as String), value: 1,
        range: NSRange(location: 0, length: attr.length))
      for t in tokens?[safe: i] ?? [] {
        guard let c = theme.code.kinds[t.kind], t.columns.upperBound <= attr.length else { continue }
        attr.addAttribute(
          NSAttributedString.Key(kCTForegroundColorAttributeName as String), value: c.cg,
          range: NSRange(location: t.columns.lowerBound, length: t.columns.count))
        if let keyword, t.kind == .keyword || t.kind == .operator {
          attr.addAttribute(
            NSAttributedString.Key(kCTFontAttributeName as String), value: keyword,
            range: NSRange(location: t.columns.lowerBound, length: t.columns.count))
        }
        if t.kind == .comment && theme.code.italicComments {
          attr.addAttribute(
            NSAttributedString.Key(kCTFontAttributeName as String), value: italic,
            range: NSRange(location: t.columns.lowerBound, length: t.columns.count))
        }
      }
      var d = DisplayText()
      d.string = attr
      style.color = theme.code.plain
      let tb = setText(d, x: x + ph, width: width - 2 * ph, y: yy, style: style, lineHeight: lh, wrap: wraps)
      widest = max(widest, x + 2 * ph + tb.widest)
      inner.append(.text(tb))
      yy = tb.frame.maxY
    }
    let h = yy + pv - y
    let box = CGRect(x: x, y: y, width: width, height: h)
    items.append(.fill(box, radius: CGFloat(m.codeRadius), theme.colors.codeBlock))
    // a long line is cut at the block's edge (overflow: hidden on the padding box)
    items.append(.clip(box, inner))
    return y + h
  }

  // MARK: diagrams

  /// a Mermaid diagram: drawn at its own size, or, wider than the body, with a width limit in 40 px steps that turns it
  /// vertical (diagram.ts); its source as a code block when it does not draw
  mutating func diagram(body: Range<Int>, b: MDBlock, x: CGFloat, width: CGFloat, y: CGFloat) -> CGFloat {
    guard let r = resources.diagrams else {
      return code(body: body, language: "mermaid", b: b, x: x, width: width, y: y)
    }
    let src = sourceText(body)
    // pele's node corners: half the board's --md-radius (markdown.css .mmd --pele-radius)
    let corner = m.radius / 2
    var result = r.diagram(src, fonts: theme.fonts.body, maxWidth: nil, cornerRadius: corner)
    if case .ok(let w, _, _, _) = result, CGFloat(w) > width {
      let step = 40
      result = r.diagram(
        src, fonts: theme.fonts.body, maxWidth: max(step, Int(width) / step * step), cornerRadius: corner)
    }
    guard case .ok(let w, let h, let paths, let texts) = result else {
      return code(body: body, language: "mermaid", b: b, x: x, width: width, y: y)
    }
    // centred in the body (.mmd.ok: flex, justify-content: center)
    let frame = CGRect(x: x + max(0, (width - CGFloat(w)) / 2), y: y, width: CGFloat(w), height: CGFloat(h))
    items.append(.clip(CGRect(x: x, y: y, width: width, height: frame.height), [.diagram(paths, texts, frame)]))
    return frame.maxY
  }

  // MARK: math blocks

  mutating func mathBlock(_ latex: String, x: CGFloat, width: CGFloat, y: CGFloat, style: InlineStyle) -> CGFloat {
    // .math pads 2px above and below and the formula's display margin is 2px more (markdown.css); half a point more
    // stands for KaTeX's struts, which make its boxes that much taller than MathJax's on average over the look samples
    // (the tall ones, a sum with limits or two aligned rows, by up to 3 pt; one-line ones not at all)
    let pad: CGFloat = 4.5
    let size = style.size * 1.08
    let (body, tag) = MathTag.split(latex)
    if let tex = resources.math, case .ok(let pic) = tex.typeset(body, display: true, preamble: resources.mathPreamble)
    {
      let w = CGFloat(pic.width) * size
      let h = CGFloat(pic.height) * size
      let base = y + pad + CGFloat(pic.baseline) * size
      // centred; a tag at the right edge on the formula's baseline, as KaTeX places it
      items.append(.math(pic, size: size, origin: CGPoint(x: x + max(0, (width - w) / 2), y: base), color: style.color))
      if let tag, case .ok(let t) = tex.typeset(tag, display: false, preamble: resources.mathPreamble) {
        items.append(
          .math(t, size: size, origin: CGPoint(x: x + width - CGFloat(t.width) * size, y: base), color: style.color))
      }
      return y + pad + h + pad
    }
    var s = style
    s.families = theme.fonts.mono
    s.size = m.em(m.inlineCodeSize)
    s.color = theme.colors.ink2
    var ib = InlineBuilder(theme: theme, resources: resources, imageCounts: [:], bodyWidth: width)
    let d = ib.build(MDText(string: latex, offsets: Array(repeating: 0, count: latex.utf16.count + 1)), [], s)
    let tb = setText(d, x: x, width: width, y: y + pad, style: s, lineHeight: CGFloat(m.lineHeight), center: true)
    items.append(.text(tb))
    return tb.frame.maxY + pad
  }

  // MARK: tables

  mutating func table(_ t: MDTable, x: CGFloat, width: CGFloat, y: CGFloat, style: InlineStyle) -> CGFloat {
    let given = info?.tables?[safe: tableIndex] ?? nil
    tableIndex += 1
    var s = style
    s.size = m.em(m.tableSize)
    let lh = CGFloat(m.lineHeight)
    let pv = CGFloat(m.cellPadding[0])
    let ph = CGFloat(m.cellPadding[1])
    let cols = t.rows.map(\.count).max() ?? 0
    guard cols > 0 else { return y }
    // each column's natural (longest line) and least (longest word) content widths
    var natural = [CGFloat](repeating: 0, count: cols)
    var least = [CGFloat](repeating: 0, count: cols)
    func styleFor(_ r: Int) -> InlineStyle {
      var c = s
      if r == 0 { c.weight = m.headingWeight }
      return c
    }
    var texts: [[DisplayText]] = []
    for (r, row) in t.rows.enumerated() {
      var rowTexts: [DisplayText] = []
      for (c, cell) in row.enumerated() {
        var ib = InlineBuilder(theme: theme, resources: resources, imageCounts: imageCounts, bodyWidth: width)
        let d = ib.build(cell.text, cell.inlines, styleFor(r))
        imageCounts = ib.imageCounts
        let one = CTLineCreateWithAttributedString(d.string)
        natural[c] = max(natural[c], CGFloat(CTLineGetTypographicBounds(one, nil, nil, nil)))
        least[c] = max(least[c], Self.longestWord(d.string))
        rowTexts.append(d)
      }
      texts.append(rowTexts)
    }
    // CSS automatic table layout: natural widths when they fit, else shrink towards the least widths
    let minCell = 2 * s.size
    var widths = (0..<cols).map { max(natural[$0], minCell) }
    let pad = 2 * ph + 1
    let avail = width - 1 - CGFloat(cols) * pad
    let sumN = widths.reduce(0, +)
    if sumN > avail {
      let mins = (0..<cols).map { max(least[$0], minCell) }
      let sumM = mins.reduce(0, +)
      widths =
        sumM >= avail
        ? mins : (0..<cols).map { mins[$0] + (widths[$0] - mins[$0]) * (avail - sumM) / max(1, sumN - sumM) }
    }
    if let g = given?.cols {
      for (i, w) in g.enumerated() where i < cols { if let w { widths[i] = max(CGFloat(w) - pad, CGFloat(25) - pad) } }
    }
    let tableW = max(min(CGFloat(m.tableMinWidth), width), widths.reduce(0, +) + CGFloat(cols) * pad + 1)
    let extra = tableW - (widths.reduce(0, +) + CGFloat(cols) * pad + 1)
    if extra > 0 {
      let sum = max(1, widths.reduce(0, +))
      widths = widths.map { $0 + extra * $0 / sum }
    }
    var inner: [Item] = []
    var yy = y + 1
    var rowTops: [CGFloat] = []
    for (r, row) in texts.enumerated() {
      rowTops.append(yy)
      var cx = x + 1
      var rowH: CGFloat = 0
      var blocks: [TextBlock] = []
      for c in 0..<cols {
        let d = c < row.count ? row[c] : DisplayText()
        // each column's alignment (:-- :-: --:), its header too (td and th take the align attribute)
        let align = c < t.align.count ? t.align[c] : .none
        let tb = setText(
          d, x: cx + ph, width: widths[c], y: yy + pv, style: styleFor(r), lineHeight: lh, center: align == .center,
          right: align == .right)
        blocks.append(tb)
        rowH = max(rowH, tb.frame.height + 2 * pv)
        cx += widths[c] + pad
      }
      if let h = given?.rows?[safe: r] ?? nil { rowH = max(rowH, CGFloat(h)) }
      if r == 0 {
        inner.append(
          .header(
            CGRect(x: x + 1, y: yy, width: tableW - 2, height: rowH), radius: CGFloat(m.tableRadius) - 1,
            theme.colors.fill))
      }
      for tb in blocks {
        inner.append(.text(tb))
      }
      atomsInto(&inner, blocks)
      yy += rowH
      if r < texts.count - 1 {
        inner.append(.fill(CGRect(x: x + 1, y: yy, width: tableW - 2, height: 1), radius: 0, theme.colors.hair))
        yy += 1
      }
    }
    yy += 1
    var cx = x + 1
    for c in 0..<(cols - 1) {
      cx += widths[c] + pad - 1
      inner.append(.fill(CGRect(x: cx, y: y + 1, width: 1, height: yy - y - 2), radius: 0, theme.colors.hair))
      cx += 1
    }
    let frame = CGRect(x: x, y: y, width: tableW, height: yy - y)
    inner.append(
      .stroke(frame.insetBy(dx: 0.5, dy: 0.5), radius: CGFloat(m.tableRadius) - 0.5, theme.colors.hair, width: 1))
    widestTable(frame)
    items.append(.clip(CGRect(x: x, y: y - 1, width: width, height: frame.height + 2), inner))
    var end = yy
    if let cap = t.caption {
      var cs = style
      cs.size = m.em(m.captionSize)
      cs.color = theme.colors.ink2
      end += CGFloat(m.captionMargin[0])
      end = paragraph(
        cap.text, cap.inlines, x: x, width: width, y: end, style: cs, lineHeight: CGFloat(m.captionLineHeight),
        center: true)
      end += CGFloat(m.captionMargin[1])
    }
    return end
  }

  private mutating func widestTable(_ f: CGRect) { widest = max(widest, f.maxX) }

  private mutating func atomsInto(_ list: inout [Item], _ blocks: [TextBlock]) {
    let saved = items
    items = []
    for b in blocks { atoms(b) }
    list += items
    items = saved
  }

  /// the widest run between break opportunities: a table cell is never narrower (cells break only between words)
  static func longestWord(_ s: NSAttributedString) -> CGFloat {
    let str = s.string as NSString
    var best: CGFloat = 0
    var start = 0
    func measure(_ r: NSRange) {
      guard r.length > 0 else { return }
      let l = CTLineCreateWithAttributedString(s.attributedSubstring(from: r))
      best = max(best, CGFloat(CTLineGetTypographicBounds(l, nil, nil, nil)))
    }
    for i in 0...str.length {
      let breakHere = i == str.length || [0x20, 0x09, 0x0A, 0x2028].contains(str.character(at: i))
      if breakHere {
        measure(NSRange(location: start, length: i - start))
        start = i + 1
      } else if str.character(at: i) >= 0x2E80 {
        // CJK text breaks between any two characters
        measure(NSRange(location: start, length: i - start))
        measure(NSRange(location: i, length: 1))
        start = i + 1
      }
    }
    return best
  }
}

extension Array {
  subscript(safe i: Int) -> Element? { i >= 0 && i < count ? self[i] : nil }
}

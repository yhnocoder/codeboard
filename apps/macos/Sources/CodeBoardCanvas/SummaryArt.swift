import AppKit
import CoreText

// A summary column drawn (the web board's .sumlay, styles.css and Summaries.tsx): an optional kick line, the title (a
// small square before it; a header's own size and rule instead), then the body, key phrases (**…**) bold in ink. All in
// board units: em the board's summary font size, pad the padding. Measured and drawn with Core Text off the main thread;
// the picture holds the whole text, and the canvas clips it at the column's height at rest (with the fade over its last
// lines) and shows it all on hover, so nothing is drawn again for either.

/// What one column shows
struct SummaryColumnText: Sendable, Hashable {
  struct Code: Sendable, Hashable {
    var name: String
    var at: String
  }

  var title: String
  var kick: String?
  var code: Code?
  var text: String?
  /// A header's level (1: a top Section with child Sections, 2: deeper), nil for a column
  var head: Int?
  /// A card's or a Section's own cards' column (its square in ink-3, not the accent)
  var loose: Bool
  /// Pending with a summary: the body's dotted underline
  var stale: Bool
}

/// The summary layer's look in one theme (styles.css .sumlay tokens)
struct SummaryLook: Sendable {
  let hd: CGColor
  let grey: CGColor
  let ink: CGColor
  let ink3: CGColor
  let accent: CGColor
  let panel: CGColor
  let shade: CGColor
  let serif: Bool
  let dark: Bool
  /// Screen points per unit of the sizes the text is made at, where main lays it out (the switch point's: S · cut px for
  /// S): the system font takes its optical size and tracking from there, as Chrome's does
  var layout: CGFloat = 0.3

  init(_ t: Theme) {
    func rgb(_ v: UInt32, _ a: CGFloat = 1) -> CGColor {
      CGColor(
        srgbRed: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255, blue: CGFloat(v & 255) / 255,
        alpha: a)
    }
    let ink = t.id == .inkWash
    dark = t.dark
    serif = ink
    // --sum-hd, --sum-grey: their own in each light look; in the dark ones ink-2, and ink-3 80 % over the canvas
    hd = t.dark ? t.ink2 : ink ? rgb(0x4c4943) : rgb(0x57534b)
    grey = t.dark ? ink ? rgb(0x5c5952) : rgb(0x65625b) : ink ? rgb(0x88836f) : rgb(0x8a857b)
    self.ink = t.ink
    ink3 = t.ink3
    accent = t.accent
    panel = !t.dark && ink ? t.surface : t.canvas
    shade = t.dark ? CGColor(gray: 0, alpha: 1) : rgb(0x32230a)
  }
}

/// A column measured: its title block's and body's heights (board units), as main's view measures .sumhdi and .sumtx
struct SummaryMeasure: Sendable, Equatable {
  var hd: CGFloat
  var tx: CGFloat
}

enum SummaryArt {
  // MARK: Fonts

  /// The system font with its optical size and tracking at `opsz` (main's layout size), and PingFang SC for CJK as
  /// Chrome falls back to (the system's own fallback at display sizes, PingFang UI Display, is about 6 % narrower)
  static func sans(_ size: CGFloat, _ weight: NSFont.Weight, opsz: CGFloat) -> CTFont {
    let small = NSFont.systemFont(ofSize: opsz, weight: weight) as CTFont
    let cjk = CTFontDescriptorCreateWithNameAndSize(
      (weight >= .semibold ? "PingFangSC-Semibold" : "PingFangSC-Regular") as CFString, 0)
    let d = CTFontDescriptorCreateCopyWithAttributes(
      CTFontCopyFontDescriptor(small),
      [kCTFontCascadeListAttribute: [cjk], kCTFontOpticalSizeAttribute: opsz as CFNumber] as CFDictionary)
    return CTFontCreateWithFontDescriptor(d, size, nil)
  }

  /// Source Serif 4 (the board's own) with Songti SC after it for CJK, as the Ink Wash stylesheets ask
  static func serif(_ size: CGFloat, _ weight: CGFloat) -> CTFont {
    let songti = CTFontDescriptorCreateWithNameAndSize("STSongti-SC-Regular" as CFString, size)
    if var d = BoardFonts.descriptor("SourceSerif4-400-600") {
      d = CTFontDescriptorCreateCopyWithVariation(d, 0x7767_6874 as CFNumber, min(600, weight))
      d = CTFontDescriptorCreateCopyWithVariation(d, 0x6f70_737a as CFNumber, size)
      d = CTFontDescriptorCreateCopyWithAttributes(d, [kCTFontCascadeListAttribute: [songti]] as CFDictionary)
      return CTFontCreateWithFontDescriptor(d, size, nil)
    }
    return CTFontCreateWithName("Songti SC" as CFString, size, nil)
  }

  static func mono(_ size: CGFloat, _ weight: CGFloat) -> CTFont {
    (Font.board("JetBrainsMono-400-600", size: size, weight: weight)
      ?? Font.mono(size, weight > 500 ? .semibold : .regular))
      .ct
  }

  static func head(_ look: SummaryLook, _ size: CGFloat, bold: Bool) -> CTFont {
    look.serif ? serif(size, bold ? 700 : 600) : sans(size, bold ? .bold : .semibold, opsz: size * look.layout)
  }

  static func body(_ look: SummaryLook, _ size: CGFloat, bold: Bool) -> CTFont {
    look.serif ? serif(size, bold ? 700 : 400) : sans(size, bold ? .bold : .regular, opsz: size * look.layout)
  }

  // MARK: Text

  /// The body as an attributed string: **bold** runs in ink, the rest in the summary grey; ==mark== and [[ref]] show their
  /// text
  static func bodyString(_ t: String, look: SummaryLook, font em: CGFloat) -> NSAttributedString {
    let out = NSMutableAttributedString()
    let plain = t.replacingOccurrences(of: "==", with: "").replacing(/\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/) { String($0.1) }
    let para = paragraph(lineHeight: 1.5 * em)
    var bold = false
    for part in plain.components(separatedBy: "**") {
      if !part.isEmpty {
        var a: [NSAttributedString.Key: Any] = [
          .font: body(look, em, bold: bold), .foregroundColor: bold ? look.ink : look.grey, .paragraphStyle: para,
        ]
        out.append(NSAttributedString(string: part, attributes: a))
      }
      bold.toggle()
    }
    return out
  }

  static func paragraph(lineHeight: CGFloat) -> NSParagraphStyle {
    let p = NSMutableParagraphStyle()
    p.minimumLineHeight = lineHeight
    p.maximumLineHeight = lineHeight
    p.lineBreakMode = .byWordWrapping
    return p
  }

  /// A string's lines laid out at `width`, at most `max` (the last cut with an ellipsis)
  static func lines(_ s: NSAttributedString, width: CGFloat, max: Int = .max) -> [CTLine] {
    guard s.length > 0, width > 1 else { return [] }
    let ts = CTTypesetterCreateWithAttributedString(s)
    var out: [CTLine] = []
    var at = 0
    while at < s.length, out.count < max {
      var k = CTTypesetterSuggestLineBreak(ts, at, Double(width))
      if k <= 0 { k = 1 }
      if out.count == max - 1, at + k < s.length {
        let rest = CTTypesetterCreateLine(ts, CFRange(location: at, length: s.length - at))
        let attrs = s.attributes(at: at, effectiveRange: nil)
        let dots = CTLineCreateWithAttributedString(NSAttributedString(string: "…", attributes: attrs))
        out.append(CTLineCreateTruncatedLine(rest, Double(width), .end, dots) ?? rest)
        break
      }
      out.append(CTTypesetterCreateLine(ts, CFRange(location: at, length: k)))
      at += k
    }
    return out
  }

  // MARK: The title block

  struct TitleBlock {
    var kick: [CTLine] = []
    var kickLine: CGFloat = 0
    var title: [CTLine] = []
    var titleLine: CGFloat = 0
    /// The square's side and its gap (0 for a header)
    var square: CGFloat = 0
    var squareGap: CGFloat = 0
    var code: (name: [CTLine], at: [CTLine], nameLine: CGFloat, atLine: CGFloat, indent: CGFloat)?
    /// Under a header's title: its rule's thickness (and below it, the padding)
    var rule: CGFloat = 0
    var rulePad: CGFloat = 0
    var height: CGFloat = 0
  }

  /// `whole`: the title not cut at two lines (a column's while it is hovered)
  static func titleBlock(
    _ c: SummaryColumnText, look: SummaryLook, font em: CGFloat, width w: CGFloat, cut: CGFloat, whole: Bool = false
  )
    -> TitleBlock
  {
    var b = TitleBlock()
    if let k = c.kick, !k.isEmpty {
      let f = head(look, 0.56 * em, bold: false)
      let s = NSAttributedString(
        string: "\(k) ›",
        attributes: [
          .font: f, .foregroundColor: look.ink3, .kern: 0.04 * 0.56 * em,
          .paragraphStyle: paragraph(lineHeight: 1.3 * 0.56 * em),
        ])
      b.kick = lines(s, width: w)
      b.kickLine = 1.3 * 0.56 * em
      b.height += CGFloat(b.kick.count) * b.kickLine + 0.2 * 0.56 * em
    }
    if let code = c.code {
      let nf = mono(0.7 * em, 600)
      let af = mono(0.6 * em, 400)
      let indent = 0.8 * em
      let name = lines(
        NSAttributedString(
          string: code.name,
          attributes: [.font: nf, .foregroundColor: look.hd, .paragraphStyle: paragraph(lineHeight: 0.7 * em * 1.3)]),
        width: w - 0.55 * 0.7 * em - 0.45 * 0.7 * em)
      let at =
        code.at.isEmpty
        ? []
        : lines(
          NSAttributedString(
            string: code.at,
            attributes: [
              .font: af, .foregroundColor: look.ink3, .paragraphStyle: paragraph(lineHeight: 0.6 * em * 1.4),
            ]),
          width: .greatestFiniteMagnitude, max: 1)
      b.square = 0.55 * 0.7 * em
      b.squareGap = 0.45 * 0.7 * em
      b.code = (name, at, 0.7 * em * 1.3, 0.6 * em * 1.4, indent)
      b.height += CGFloat(name.count) * 0.7 * em * 1.3 + CGFloat(at.count) * 0.6 * em * 1.4
      return b
    }
    let level = c.head
    let size = level == 1 ? 1.12 * em : level == 2 ? 0.92 * em : 0.8 * em
    let color = level == 1 ? look.ink : look.hd
    let kern = (level == 1 ? 0.03 : 0.04) * size
    b.titleLine = 1.3 * size
    if level == nil {
      b.square = 0.55 * size
      b.squareGap = 0.45 * size
    }
    let s = NSAttributedString(
      string: c.title,
      attributes: [
        .font: head(look, size, bold: true), .foregroundColor: color, .kern: kern,
        .paragraphStyle: paragraph(lineHeight: b.titleLine),
      ])
    // the square sits in the first line, so the first line is that much narrower: laid out as an indent
    b.title = indentedLines(s, width: w, indent: b.square + b.squareGap, max: level == nil && !whole ? 2 : .max)
    b.height += CGFloat(max(1, b.title.count)) * b.titleLine
    if let level {
      b.rulePad = (level == 1 ? 0.16 : 0.12) * size
      b.rule = level == 1 ? max(2 / max(cut, 0.01), 0.045 * size) : max(1 / max(cut, 0.01), 0.03 * size)
      b.height += b.rulePad + b.rule
    }
    return b
  }

  /// Lines with the first one `indent` narrower
  static func indentedLines(_ s: NSAttributedString, width: CGFloat, indent: CGFloat, max: Int) -> [CTLine] {
    guard s.length > 0 else { return [] }
    // the first line as it breaks (asked for with max 1 it would already be cut short with its ellipsis)
    let first = Array(lines(s, width: width - indent).prefix(1))
    guard let l = first.first else { return [] }
    let n = CTLineGetStringRange(l).length
    guard n < s.length, max > 1 else {
      return max == 1 ? lines(s, width: width - indent, max: 1) : first
    }
    let rest = s.attributedSubstring(from: NSRange(location: n, length: s.length - n))
    return [l] + lines(rest, width: width, max: max - 1)
  }

  // MARK: Measuring and drawing

  /// Whether the title is cut at two lines at this width (hovered, the column shows it whole)
  static func cutsTitle(_ c: SummaryColumnText, look: SummaryLook, font em: CGFloat, pad: CGFloat, width: CGFloat)
    -> Bool
  {
    guard c.head == nil, c.code == nil else { return false }
    let w = width - 2 * pad
    return titleBlock(c, look: look, font: em, width: w, cut: 1, whole: true).title.count
      > titleBlock(c, look: look, font: em, width: w, cut: 1).title.count
  }

  /// The title block's and the body's heights at the column's width
  static func measure(
    _ c: SummaryColumnText, look: SummaryLook, font em: CGFloat, pad: CGFloat, width: CGFloat, cut: CGFloat
  )
    -> SummaryMeasure
  {
    let w = width - 2 * pad
    let hd = titleBlock(c, look: look, font: em, width: w, cut: cut).height
    let tx =
      c.text.map { CGFloat(lines(bodyString($0, look: look, font: em), width: w).count) * 1.5 * em }
      ?? 0
    return SummaryMeasure(hd: hd, tx: tx)
  }

  /// The whole column (its full height: 2P + hd + gap + body) drawn at `scale` pixels per board unit. `hd`: the title
  /// row's height the layout gave (bodies on one row start level)
  static func draw(
    _ c: SummaryColumnText, look: SummaryLook, font em: CGFloat, pad: CGFloat, width: CGFloat, hd: CGFloat,
    cut: CGFloat,
    scale: CGFloat, whole: Bool = false
  ) -> Drawn? {
    let w = width - 2 * pad
    let block = titleBlock(c, look: look, font: em, width: w, cut: cut, whole: whole)
    let body = c.text.map { lines(bodyString($0, look: look, font: em), width: w) } ?? []
    let gap = c.head == 1 ? 1.12 * 0.32 * em : c.head == 2 ? 0.92 * 0.3 * em : 0.3 * em
    let bodyH = CGFloat(body.count) * 1.5 * em
    let full = ceil(2 * pad + max(hd, block.height) + (c.head != nil && body.isEmpty ? 0 : gap) + bodyH)
    let pw = Int(ceil(width * scale))
    let ph = Int(ceil(full * scale))
    guard pw > 0, ph > 0, pw * ph < 64_000_000,
      let ctx = CGContext(
        data: nil, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue)
    else { return nil }
    // y down, board units
    ctx.translateBy(x: 0, y: CGFloat(ph))
    ctx.scaleBy(x: scale, y: -scale)
    ctx.setShouldSmoothFonts(false)
    var y = pad
    var titleEnd = CGPoint(x: pad, y: pad)
    func end(_ l: CTLine, x: CGFloat, top: CGFloat, lineHeight: CGFloat) {
      titleEnd = CGPoint(x: x + CGFloat(CTLineGetTypographicBounds(l, nil, nil, nil)), y: top + lineHeight / 2)
    }
    @discardableResult func put(_ l: CTLine, x: CGFloat, top: CGFloat, lineHeight: CGFloat) -> CGFloat {
      var asc: CGFloat = 0
      var desc: CGFloat = 0
      _ = CTLineGetTypographicBounds(l, &asc, &desc, nil)
      // CSS centres the glyphs' ascent + descent in the line box
      let base = top + (lineHeight - (asc + desc)) / 2 + asc
      ctx.saveGState()
      ctx.translateBy(x: x, y: base)
      ctx.scaleBy(x: 1, y: -1)
      ctx.textPosition = .zero
      CTLineDraw(l, ctx)
      ctx.restoreGState()
      return base
    }
    for l in block.kick {
      put(l, x: pad, top: y, lineHeight: block.kickLine)
      y += block.kickLine
    }
    if !block.kick.isEmpty { y += 0.2 * 0.56 * em }
    if let code = block.code {
      square(ctx, x: pad, top: y, line: code.nameLine, side: block.square, color: look.ink3)
      for (i, l) in code.name.enumerated() {
        put(l, x: pad + (i == 0 ? block.square + block.squareGap : 0), top: y, lineHeight: code.nameLine)
        end(l, x: pad + (i == 0 ? block.square + block.squareGap : 0), top: y, lineHeight: code.nameLine)
        y += code.nameLine
      }
      for l in code.at {
        put(l, x: pad + code.indent, top: y, lineHeight: code.atLine)
        y += code.atLine
      }
    } else {
      if block.square > 0 {
        square(ctx, x: pad, top: y, line: block.titleLine, side: block.square, color: c.loose ? look.ink3 : look.accent)
      }
      for (i, l) in block.title.enumerated() {
        put(l, x: pad + (i == 0 ? block.square + block.squareGap : 0), top: y, lineHeight: block.titleLine)
        end(l, x: pad + (i == 0 ? block.square + block.squareGap : 0), top: y, lineHeight: block.titleLine)
        y += block.titleLine
      }
      if c.head != nil {
        y += block.rulePad
        let ruleColor =
          c.head == 1 ? look.accent.copy(alpha: 0.7) ?? look.accent : look.ink.copy(alpha: 0.3) ?? look.ink
        ctx.setFillColor(ruleColor)
        if c.head == 1 {
          ctx.fill(CGRect(x: pad, y: y, width: w, height: block.rule))
        } else {
          // dashed, as CSS draws a dashed border: dashes three times the width
          var x = pad
          let dash = 3 * block.rule
          while x < pad + w {
            ctx.fill(CGRect(x: x, y: y, width: min(dash, pad + w - x), height: block.rule))
            x += 2 * dash
          }
        }
      }
    }
    y = pad + max(hd, block.height) + gap
    for l in body {
      let base = put(l, x: pad, top: y, lineHeight: 1.5 * em)
      // pending: a dotted underline (.sumcol.pend .sumtx: dotted, 0.07em thick, 0.28em under the baseline, ink at 45 %),
      // round dots a dot apart as Chrome draws them
      if c.stale {
        let d = 0.07 * em
        let run = CGFloat(CTLineGetTypographicBounds(l, nil, nil, nil) - CTLineGetTrailingWhitespaceWidth(l))
        ctx.setFillColor(look.ink.copy(alpha: 0.45) ?? look.ink)
        var x = pad
        while x + d <= pad + run + 0.01 {
          ctx.fillEllipse(in: CGRect(x: x, y: base + 0.28 * em, width: d, height: d))
          x += 2 * d
        }
      }
      y += 1.5 * em
    }
    return ctx.makeImage().map {
      Drawn(image: $0, full: full, titleEnd: titleEnd, bodyTop: pad + max(hd, block.height) + gap)
    }
  }

  /// A column's picture, its full height, where its title's last line ends (the ↻ goes after it: its x, the line's middle)
  /// and where its body starts, in the column's units
  struct Drawn {
    var image: CGImage
    var full: CGFloat
    var titleEnd: CGPoint
    var bodyTop: CGFloat
  }

  /// The small square before a title (.sumhdi::before): 0.55em, 1 px round, set in the line
  static func square(_ ctx: CGContext, x: CGFloat, top: CGFloat, line: CGFloat, side: CGFloat, color: CGColor) {
    ctx.setFillColor(color)
    let r = CGRect(x: x, y: top + (line - side) / 2, width: side, height: side)
    ctx.addPath(CGPath(roundedRect: r, cornerWidth: side * 0.08, cornerHeight: side * 0.08, transform: nil))
    ctx.fillPath()
  }
}

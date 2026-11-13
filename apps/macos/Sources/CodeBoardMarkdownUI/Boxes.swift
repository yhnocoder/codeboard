import CodeBoardMarkdown
import CoreGraphics
import CoreText
import Foundation

/// Lines of text set inside an inline box (a caption, an annotated phrase): plain CoreText lines, relative to the box
struct BoxText {
  struct Line {
    let line: CTLine
    /// the baseline, from the top of the text; x from the text's left
    let origin: CGPoint
  }
  let lines: [Line]
  let size: CGSize

  /// sets attributed text in `width` (nil: one line), lines `lineHeight` tall with Chrome's baseline, each line centred
  /// when `center`
  init(_ s: NSAttributedString, width: CGFloat?, lineHeight: CGFloat, strut: CTFont, center: Bool) {
    let base = FontBook.baseline(strut, lineHeight: lineHeight)
    var out: [Line] = []
    var widest: CGFloat = 0
    if s.length > 0 {
      let ts = CTTypesetterCreateWithAttributedString(s)
      var start = 0
      var y: CGFloat = 0
      var raw: [(CTLine, CGFloat, CGFloat)] = []
      while start < s.length {
        let n = max(1, width.map { CTTypesetterSuggestLineBreak(ts, start, Double($0)) } ?? s.length - start)
        let l = CTTypesetterCreateLine(ts, CFRange(location: start, length: n))
        let w = CGFloat(CTLineGetTypographicBounds(l, nil, nil, nil) - CTLineGetTrailingWhitespaceWidth(l))
        widest = max(widest, w)
        raw.append((l, w, y + base))
        y += lineHeight
        start += n
      }
      let box = width ?? widest
      out = raw.map { Line(line: $0.0, origin: CGPoint(x: center ? (box - $0.1) / 2 : 0, y: $0.2)) }
      size = CGSize(width: box, height: y)
    } else {
      size = CGSize(width: 0, height: lineHeight)
    }
    lines = out
  }

  func draw(at o: CGPoint, _ ctx: CGContext) {
    for l in lines {
      ctx.saveGState()
      ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
      ctx.textPosition = CGPoint(x: o.x + l.origin.x, y: o.y + l.origin.y)
      CTLineDraw(l.line, ctx)
      ctx.restoreGState()
    }
  }
}

/// An image with its caption under it (markdown.css .md-fig: the caption 0.76em, centred, 5px above, 2px below; as wide
/// as the image, or the body when the image is narrowed with {width=…}), or the quiet box of one that cannot be shown
/// (.md-imgerr)
final class FigureBox: @unchecked Sendable {
  let image: CGSize
  let caption: BoxText?
  /// where the caption's text box starts, relative to the image's left
  let captionX: CGFloat
  let captionTop: CGFloat
  let broken: BoxText?
  let width: CGFloat
  let height: CGFloat

  init(image: CGSize, caption: BoxText?, captionX: CGFloat, captionGap: (CGFloat, CGFloat)) {
    self.image = image
    self.caption = caption
    self.captionX = captionX
    captionTop = image.height + captionGap.0
    broken = nil
    width = image.width
    height = caption.map { image.height + captionGap.0 + $0.size.height + captionGap.1 } ?? image.height
  }

  /// a broken image: an icon and its alt text (or address) in a hairline box, 11.5px text, padding 4 and 9
  init(brokenLabel: BoxText) {
    image = .zero
    caption = nil
    captionX = 0
    captionTop = 0
    broken = brokenLabel
    width = 9 + 14 + 6 + brokenLabel.size.width + 9
    height = 4 + brokenLabel.size.height + 4
  }

  func drawBroken(_ r: CGRect, ink3: MDColor, hair: MDColor, _ ctx: CGContext) {
    guard let label = broken else { return }
    ctx.setStrokeColor(hair.cg)
    ctx.setLineWidth(1)
    ctx.addPath(CGPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), cornerWidth: 6.5, cornerHeight: 6.5, transform: nil))
    ctx.strokePath()
    // the missing-picture icon: a frame with a hill and a sun, 1.3 wide (image.ts MISSING_ICON, a 16 grid at 14px)
    ctx.saveGState()
    ctx.translateBy(x: r.minX + 9, y: r.midY - 7)
    ctx.scaleBy(x: 14 / 16, y: 14 / 16)
    ctx.setStrokeColor(ink3.cg)
    ctx.setLineWidth(1.3)
    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)
    ctx.addPath(
      CGPath(
        roundedRect: CGRect(x: 2.5, y: 3, width: 11, height: 10), cornerWidth: 1.8, cornerHeight: 1.8, transform: nil))
    ctx.addPath(SVGShapes.path("M2.5 11l3.2-3.2 2.6 2.6 1.7-1.7 3.5 3.5M10.2 6.2h.01"))
    ctx.strokePath()
    ctx.restoreGState()
    label.draw(at: CGPoint(x: r.minX + 9 + 14 + 6, y: r.minY + 4), ctx)
  }
}

/// {text|note}: the annotated text on a tint of its colour, with a rail above (below) it 2.05em tall holding the note in
/// the hand font and an arrow pointing at the text (markdown.css .md-annot)
final class AnnotBox: @unchecked Sendable {
  let text: BoxText
  let note: BoxText
  let color: MDColor
  let below: Bool
  let fontSize: CGFloat
  let rail: CGFloat
  let width: CGFloat
  /// the text's baseline, from the box's top
  let baseline: CGFloat
  let height: CGFloat

  init(text: BoxText, note: BoxText, color: MDColor, below: Bool, fontSize: CGFloat) {
    self.text = text
    self.note = note
    self.color = color
    self.below = below
    self.fontSize = fontSize
    rail = 2.05 * fontSize
    width = text.size.width
    let firstBase = text.lines.first?.origin.y ?? text.size.height * 0.7
    baseline = (below ? 0 : rail) + firstBase
    height = rail + text.size.height
  }

  /// the box's top left at o
  func draw(at o: CGPoint, _ ctx: CGContext) {
    let textTop = below ? o.y : o.y + rail
    ctx.setFillColor(color.alpha(0.16).cg)
    ctx.addPath(
      CGPath(
        roundedRect: CGRect(x: o.x, y: textTop, width: width, height: text.size.height), cornerWidth: 3,
        cornerHeight: 3,
        transform: nil))
    ctx.fillPath()
    text.draw(at: CGPoint(x: o.x, y: textTop), ctx)
    // the note, centred over the text; it may stick out to either side
    let noteTop = below ? o.y + height - note.size.height : o.y
    note.draw(at: CGPoint(x: o.x + (width - note.size.width) / 2, y: noteTop), ctx)
    // the arrow: 10 wide, 0.72em tall, from 1.3em below the top (a path on an 8×10 grid, 1.3 wide)
    let h = max(9, 0.72 * fontSize)
    let ax = o.x + width / 2 - 5
    ctx.saveGState()
    if below {
      ctx.translateBy(x: ax, y: o.y + height - 1.3 * fontSize)
      ctx.scaleBy(x: 10 / 8, y: -h / 10)
    } else {
      ctx.translateBy(x: ax, y: o.y + 1.3 * fontSize)
      ctx.scaleBy(x: 10 / 8, y: h / 10)
    }
    ctx.setStrokeColor(color.cg)
    ctx.setLineWidth(1.3 * 8 / 10)
    ctx.setLineCap(.round)
    ctx.addPath(SVGShapes.path("M3.6 .8Q2.9 5 4 9.2M1.4 6.4Q3 7.6 4 9.2Q4.8 7.4 6.6 6.6"))
    ctx.strokePath()
    ctx.restoreGState()
  }
}

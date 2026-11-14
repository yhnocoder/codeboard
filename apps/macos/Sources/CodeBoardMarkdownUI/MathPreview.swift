import AppKit
import CodeBoardMarkdown

/// The formula the caret is in, typeset as the user types (editor/mathblock.ts, mathhints.ts's preview): a bubble under
/// its source at the screen's own size, whatever the zoom. Typesetting runs off the main thread; the last good picture
/// stays while the next is made, and a TeX that does not typeset keeps it, faded, with the reason under it. Nothing is
/// shown before the first result, so there is never an empty box, and the text never moves for it.
@MainActor
final class MathPreview: NSView {
  private var latex: String?
  private var display = false
  private var picture: MathPicture?
  private var error: String?
  private var theme: MarkdownTheme?
  private var textFont: [String]?
  /// counts requests: a result for an older one is dropped
  private var asked = 0
  private let queue = DispatchQueue(label: "markdown.math-preview", qos: .userInteractive)
  /// where its formula's source is, in the editor view's points
  private var anchor = CGRect.zero

  override var isFlipped: Bool { true }

  /// Shows the formula with TeX `latex` under `anchor`, typesetting it unless it is what is shown; nil hides the bubble
  func show(
    _ f: (latex: String, display: Bool)?, under anchor: CGRect, theme: MarkdownTheme, resources: MarkdownResources
  ) {
    guard let f, let math = resources.math else {
      latex = nil
      picture = nil
      error = nil
      isHidden = true
      return
    }
    self.anchor = anchor
    self.theme = theme
    textFont = (math as? JSEngines)?.textFont
    if f.latex != latex || f.display != display {
      latex = f.latex
      display = f.display
      asked += 1
      let n = asked
      let preamble = resources.mathPreamble
      let (body, tag) = MathTag.split(f.latex)
      queue.async {
        var r = math.typeset(body, display: f.display, preamble: preamble)
        if f.display, let tag, case .ok(let pic) = r,
          case .ok(let t) = math.typeset(tag, display: false, preamble: preamble)
        {
          r = .ok(MathTag.attach(t, to: pic))
        }
        DispatchQueue.main.async {
          MainActor.assumeIsolated { self.took(r, n) }
        }
      }
    }
    place()
  }

  private func took(_ r: MathResult, _ n: Int) {
    guard n == asked, latex != nil else { return }
    switch r {
    case .ok(let pic):
      picture = pic
      error = nil
    case .error(let message, _, _):
      error = message
    }
    place()
  }

  private var size: CGFloat { CGFloat(theme?.metrics.bodySize ?? 13.5) * 1.08 }
  private let pad: CGFloat = 8

  private var errorText: NSAttributedString? {
    guard let error, let theme else { return nil }
    return NSAttributedString(
      string: error,
      attributes: [
        .font: NSFont.systemFont(ofSize: 11),
        .foregroundColor: NSColor(cgColor: theme.colors.ink2.cg) ?? .secondaryLabelColor,
      ])
  }

  private func place() {
    guard picture != nil || error != nil else {
      isHidden = true
      return
    }
    var w: CGFloat = 0
    var h: CGFloat = 0
    if let p = picture {
      w = CGFloat(p.width) * size
      h = CGFloat(p.height) * size
    }
    if let e = errorText {
      let b = e.boundingRect(with: CGSize(width: 320, height: 200), options: [.usesLineFragmentOrigin])
      w = max(w, ceil(b.width))
      h += ceil(b.height) + (picture == nil ? 0 : 4)
    }
    frame = CGRect(x: anchor.minX - pad, y: anchor.maxY + 6, width: w + 2 * pad, height: h + 2 * pad)
    isHidden = false
    needsDisplay = true
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let theme, let ctx = NSGraphicsContext.current?.cgContext else { return }
    let box = bounds.insetBy(dx: 0.5, dy: 0.5)
    let path = CGPath(roundedRect: box, cornerWidth: 8, cornerHeight: 8, transform: nil)
    ctx.addPath(path)
    ctx.setFillColor(theme.colors.surface.cg)
    ctx.fillPath()
    ctx.addPath(path)
    ctx.setStrokeColor(theme.colors.hair.cg)
    ctx.setLineWidth(1)
    ctx.strokePath()
    var y = pad
    if let p = picture {
      ctx.saveGState()
      // the last good picture, faded while the TeX does not typeset
      if error != nil { ctx.setAlpha(0.4) }
      ctx.translateBy(x: pad, y: y)
      SVGShapes.draw(p.paths, p.texts, ctx, scale: size, ink: theme.colors.ink, theme: theme, textFont: textFont)
      ctx.restoreGState()
      y += CGFloat(p.height) * size + 4
    }
    errorText?.draw(at: CGPoint(x: pad, y: y))
  }

  /// what it shows (tests)
  var shown: (latex: String?, picture: Bool, error: String?) { (latex, picture != nil, error) }
}

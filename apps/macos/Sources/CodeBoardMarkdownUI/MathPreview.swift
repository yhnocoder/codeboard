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
  /// the error said in plain words, with its fixes (MarkdownEditing.explainMath)
  private var problem: MDMathProblem?
  /// a command name is being typed at the caret: no error for it yet, the last picture stays
  private var typing = false
  /// only the reason (an open formula block draws its formula itself, in place)
  private var errorOnly = false
  /// a fix pressed: the range of the TeX and what to write there
  var onFix: (Range<Int>, String) -> Void = { _, _ in }
  private var preamble = ""
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
    _ f: (latex: String, display: Bool)?, under anchor: CGRect, theme: MarkdownTheme, resources: MarkdownResources,
    caret: Int? = nil, errorOnly: Bool = false
  ) {
    self.errorOnly = errorOnly
    guard let f, let math = resources.math else {
      latex = nil
      picture = nil
      error = nil
      isHidden = true
      return
    }
    self.anchor = anchor
    self.theme = theme
    preamble = resources.mathPreamble
    typing = caret.map { MarkdownEditing.typingCommand(f.latex, caret: $0, preamble: preamble) } ?? false
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
      problem = nil
    case .error(let message, _, _):
      error = message
      problem = latex.map { MarkdownEditing.explainMath(message, tex: $0, preamble: preamble) }
    }
    place()
  }

  private var size: CGFloat { CGFloat(theme?.metrics.bodySize ?? 13.5) * 1.08 }
  /// .md-mathtip: 8 × 12 padding, at least 120 wide
  private let pad: CGFloat = 8
  private let padX: CGFloat = 12

  private static let fixKey = NSAttributedString.Key("MDMathFix")

  /// the problem in words: text, code in the code font, fixes in the accent (pressable)
  private var errorText: NSAttributedString? {
    guard error != nil, !typing, let theme else { return nil }
    let body = NSFont.systemFont(ofSize: 11)
    let ink2 = NSColor(cgColor: theme.colors.ink2.cg) ?? .secondaryLabelColor
    let out = NSMutableAttributedString()
    for (i, part) in (problem?.parts ?? [.text(error ?? "")]).enumerated() {
      switch part {
      case .text(let t): out.append(NSAttributedString(string: t, attributes: [.font: body, .foregroundColor: ink2]))
      case .code(let c):
        out.append(
          NSAttributedString(
            string: c,
            attributes: [.font: NSFont.monospacedSystemFont(ofSize: 10.5, weight: .regular), .foregroundColor: ink2]))
      case .fix(let label, _, _):
        out.append(
          NSAttributedString(
            string: label,
            attributes: [
              .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
              .foregroundColor: NSColor(cgColor: theme.colors.accent.cg) ?? .controlAccentColor, Self.fixKey: i,
            ]))
      }
    }
    return out
  }

  private func place() {
    guard (picture != nil && !errorOnly) || (error != nil && !typing) else {
      isHidden = true
      return
    }
    var w: CGFloat = 0
    var h: CGFloat = 0
    if let p = picture, !errorOnly {
      w = CGFloat(p.width) * size
      h = CGFloat(p.height) * size
    }
    if let e = errorText {
      let b = e.boundingRect(with: CGSize(width: 320, height: 200), options: [.usesLineFragmentOrigin])
      w = max(w, ceil(b.width))
      h += ceil(b.height) + (picture == nil || errorOnly ? 0 : 4)
    }
    frame = CGRect(x: anchor.minX - padX, y: anchor.maxY + 6, width: max(120, w + 2 * padX), height: h + 2 * pad)
    isHidden = false
    needsDisplay = true
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let theme, let ctx = NSGraphicsContext.current?.cgContext else { return }
    let box = bounds.insetBy(dx: 0.5, dy: 0.5)
    let path = CGPath(roundedRect: box, cornerWidth: 8, cornerHeight: 8, transform: nil)
    // the bar's soft shadow, as the toolbar and the menus have
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: 3), blur: 12, color: CGColor(gray: 0, alpha: 0.16))
    ctx.addPath(path)
    ctx.setFillColor(theme.colors.surface.cg)
    ctx.fillPath()
    ctx.restoreGState()
    ctx.addPath(path)
    ctx.setStrokeColor(theme.colors.hair.cg)
    ctx.setLineWidth(1)
    ctx.strokePath()
    var y = pad
    if let p = picture, !errorOnly {
      ctx.saveGState()
      // the last good picture, faded while the TeX does not typeset
      if error != nil { ctx.setAlpha(0.4) }
      // centred in the tip (.md-mathpv text-align: center)
      ctx.translateBy(x: (bounds.width - CGFloat(p.width) * size) / 2, y: y)
      SVGShapes.draw(p.paths, p.texts, ctx, scale: size, ink: theme.colors.ink, theme: theme, textFont: textFont)
      ctx.restoreGState()
      y += CGFloat(p.height) * size + 4
    }
    errorText?.draw(with: CGRect(x: padX, y: y, width: 320, height: 200), options: [.usesLineFragmentOrigin])
    errorTop = y
  }

  private var errorTop: CGFloat = 0

  /// a press on a fix writes it
  override func mouseDown(with e: NSEvent) {
    guard let text = errorText, let problem else { return }
    let p = convert(e.locationInWindow, from: nil)
    let storage = NSTextStorage(attributedString: text)
    let lm = NSLayoutManager()
    let tc = NSTextContainer(size: CGSize(width: 320, height: 200))
    tc.lineFragmentPadding = 0
    lm.addTextContainer(tc)
    storage.addLayoutManager(lm)
    let i = lm.characterIndex(
      for: CGPoint(x: p.x - padX, y: p.y - errorTop), in: tc, fractionOfDistanceBetweenInsertionPoints: nil)
    guard i < storage.length, let k = storage.attribute(Self.fixKey, at: i, effectiveRange: nil) as? Int,
      case .fix(_, let range, let t) = problem.parts[k]
    else { return }
    onFix(range, t)
  }

  /// where in its TeX the shown problem is, when known (the editor marks it in the source)
  var problemAt: Int? { error != nil && !typing && !isHidden ? problem?.at : nil }

  /// what it shows (tests)
  var shown: (latex: String?, picture: Bool, error: String?) { (latex, picture != nil, error) }
}

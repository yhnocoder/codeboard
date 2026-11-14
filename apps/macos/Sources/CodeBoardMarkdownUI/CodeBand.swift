import AppKit
import CodeBoardMarkdown

/// A code block's tool band (editor/band.ts): a 30 pt strip in the block's own colour that grows upward out of the block's
/// top edge over what is above it, the block and the Note never resizing for it. It shows the language (a click picks
/// another), Copy and Wrap; a click on its blank part goes to what is under it. It scales with the editor's zoom, as the
/// block does, and slides with Core Animation, so the slide runs at the display's rate on the render server.
@MainActor
final class CodeBand: NSView {
  static let height: CGFloat = 30

  /// the strip, inside this view, which clips it at the block's top edge
  private let strip = Strip()
  var block: EditorCore.CodeBlock?
  var shown = false

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.masksToBounds = true
    strip.wantsLayer = true
    addSubview(strip)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isFlipped: Bool { true }

  /// clicks on the blank part of the band go through
  override func hitTest(_ p: NSPoint) -> NSView? {
    guard shown, let hit = super.hitTest(p), hit === strip else { return nil }
    let local = strip.convert(p, from: superview)
    return strip.part(at: local) == nil ? nil : strip
  }

  /// Puts the band over `blockRect` (the code block's box in the editor view's points), scaled by `zoom`
  func place(over blockRect: CGRect, zoom: CGFloat, theme: MarkdownTheme, language: String?, wraps: Bool) {
    let h = Self.height * zoom
    frame = CGRect(x: blockRect.minX, y: blockRect.minY - h, width: blockRect.width, height: h)
    strip.zoom = zoom
    strip.theme = theme
    strip.language = language
    strip.wraps = wraps
    strip.radius = CGFloat(theme.metrics.codeRadius) * zoom
    strip.frame.size = CGSize(width: blockRect.width, height: h)
    if !shown { strip.frame.origin = CGPoint(x: 0, y: h) }
    strip.needsDisplay = true
  }

  func show(_ on: Bool) {
    guard on != shown else { return }
    shown = on
    isHidden = false
    let h = bounds.height
    NSAnimationContext.runAnimationGroup { c in
      c.duration = on ? MarkdownTiming.bandShow : MarkdownTiming.bandHide
      c.timingFunction = CAMediaTimingFunction(name: on ? .easeOut : .easeIn)
      strip.animator().setFrameOrigin(CGPoint(x: 0, y: on ? 0 : h))
    } completionHandler: {
      MainActor.assumeIsolated { if !self.shown { self.isHidden = true } }
    }
  }

  var onLanguage: (NSView, CGRect) -> Void = { _, _ in }
  var onCopy: () -> Void = {}
  var onWrap: () -> Void = {}

  /// what the band shows, drawn at the zoom
  final class Strip: NSView {
    enum Part { case language, copy, wrap }
    var zoom: CGFloat = 1
    var theme: MarkdownTheme?
    var language: String?
    var wraps = false
    var radius: CGFloat = 12
    override var isFlipped: Bool { true }

    private var font: NSFont { NSFont.systemFont(ofSize: 11 * zoom, weight: .medium) }
    private func size(_ s: String) -> CGSize { (s as NSString).size(withAttributes: [.font: font]) }
    var label: String { (language?.isEmpty ?? true) ? "Plain text" : language! }

    /// where each part is
    func rect(_ p: Part) -> CGRect {
      let pad = 12 * zoom
      let h = bounds.height
      switch p {
      case .language:
        let w = size(label + " ▾").width + 2 * 6 * zoom
        return CGRect(x: pad - 6 * zoom, y: 0, width: w, height: h)
      case .wrap:
        let w = size("Wrap").width + 12 * zoom
        return CGRect(x: bounds.width - pad - w + 6 * zoom, y: 0, width: w, height: h)
      case .copy:
        let wrap = rect(.wrap)
        let w = size("Copy").width + 12 * zoom
        return CGRect(x: wrap.minX - w, y: 0, width: w, height: h)
      }
    }

    func part(at p: CGPoint) -> Part? {
      [Part.language, .copy, .wrap].first { rect($0).contains(p) }
    }

    override func draw(_ dirtyRect: NSRect) {
      guard let theme, let ctx = NSGraphicsContext.current?.cgContext else { return }
      let path = CGMutablePath()
      let b = bounds
      path.move(to: CGPoint(x: 0, y: b.maxY))
      path.addArc(tangent1End: CGPoint(x: 0, y: 0), tangent2End: CGPoint(x: radius, y: 0), radius: radius)
      path.addArc(tangent1End: CGPoint(x: b.maxX, y: 0), tangent2End: CGPoint(x: b.maxX, y: radius), radius: radius)
      path.addLine(to: CGPoint(x: b.maxX, y: b.maxY))
      path.closeSubpath()
      ctx.addPath(path)
      ctx.setFillColor(theme.colors.codeBlock.cg)
      ctx.fillPath()
      let ink = NSColor(cgColor: theme.colors.ink2.cg) ?? .secondaryLabelColor
      let faint = NSColor(cgColor: theme.colors.ink3.cg) ?? .tertiaryLabelColor
      func text(_ s: String, in r: CGRect, _ c: NSColor) {
        let sz = size(s)
        (s as NSString).draw(
          at: CGPoint(x: r.minX + (r.width - sz.width) / 2, y: r.midY - sz.height / 2),
          withAttributes: [.font: font, .foregroundColor: c])
      }
      text(label + " ▾", in: rect(.language), ink)
      text("Copy", in: rect(.copy), faint)
      text("Wrap", in: rect(.wrap), wraps ? ink : faint)
    }

    override func mouseDown(with e: NSEvent) {
      let p = convert(e.locationInWindow, from: nil)
      guard let band = superview as? CodeBand, let part = part(at: p) else { return }
      switch part {
      case .language: band.onLanguage(self, rect(.language))
      case .copy: band.onCopy()
      case .wrap: band.onWrap()
      }
    }
  }
}

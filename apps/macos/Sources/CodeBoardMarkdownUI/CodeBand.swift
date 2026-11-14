import AppKit
import CodeBoardMarkdown

/// A block's tool band (editor/band.ts): a 30 pt strip in the block's own colour that grows upward out of the block's
/// top edge over what is above it, the block and the Note never resizing for it: a code block's (its language, a click
/// picks another; Copy; Wrap) or a table's (rows, columns, alignment). A click on its blank part goes to what is under
/// it. It scales with the editor's zoom, as the block does, and slides with Core Animation, so the slide runs at the
/// display's rate on the render server.
@MainActor
final class CodeBand: NSView {
  /// one button: what it shows, whether it is on, and whether it goes at the left (the rest go right, in order)
  struct Part: Equatable {
    var id: String
    var label: String
    var on = false
    var left = false
  }
  static let height: CGFloat = 30

  /// the strip, inside this view, which clips it at the block's top edge
  private let strip = Strip()
  var block: EditorCore.CodeBlock?
  /// the table it is for, when it is a table's
  var table: Range<Int>?
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
  func place(over blockRect: CGRect, zoom: CGFloat, theme: MarkdownTheme, parts: [Part], fill: MDColor) {
    let h = Self.height * zoom
    frame = CGRect(x: blockRect.minX, y: blockRect.minY - h, width: blockRect.width, height: h)
    strip.zoom = zoom
    strip.theme = theme
    strip.parts = parts
    strip.fill = fill
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

  var onPart: (String, NSView, CGRect) -> Void = { _, _, _ in }

  /// what the band shows, drawn at the zoom
  final class Strip: NSView {
    var zoom: CGFloat = 1
    var theme: MarkdownTheme?
    var parts: [Part] = []
    var fill = MDColor(0.95, 0.95, 0.95, 1)
    var radius: CGFloat = 12
    override var isFlipped: Bool { true }

    private var font: NSFont { NSFont.systemFont(ofSize: 11 * zoom, weight: .medium) }
    private func size(_ s: String) -> CGSize { (s as NSString).size(withAttributes: [.font: font]) }

    /// where each part is: the left ones from the left edge, the others from the right edge back
    func rects() -> [(Part, CGRect)] {
      let pad = 6 * zoom
      let h = bounds.height
      var out: [(Part, CGRect)] = []
      var x = pad
      for p in parts where p.left {
        let w = size(p.label).width + 12 * zoom
        out.append((p, CGRect(x: x, y: 0, width: w, height: h)))
        x += w
      }
      var r = bounds.width - pad
      for p in parts.reversed() where !p.left {
        let w = size(p.label).width + 12 * zoom
        r -= w
        out.append((p, CGRect(x: r, y: 0, width: w, height: h)))
      }
      return out
    }

    func part(at p: CGPoint) -> Part? { rects().first { $0.1.contains(p) }?.0 }

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
      ctx.setFillColor(fill.cg)
      ctx.fillPath()
      let ink = NSColor(cgColor: theme.colors.ink2.cg) ?? .secondaryLabelColor
      let faint = NSColor(cgColor: theme.colors.ink3.cg) ?? .tertiaryLabelColor
      for (p, r) in rects() {
        let sz = size(p.label)
        (p.label as NSString).draw(
          at: CGPoint(x: r.minX + (r.width - sz.width) / 2, y: r.midY - sz.height / 2),
          withAttributes: [.font: font, .foregroundColor: p.on || p.left ? ink : faint])
      }
    }

    override func mouseDown(with e: NSEvent) {
      let p = convert(e.locationInWindow, from: nil)
      guard let band = superview as? CodeBand, let hit = rects().first(where: { $0.1.contains(p) }) else { return }
      band.onPart(hit.0.id, self, hit.1)
    }
  }
}

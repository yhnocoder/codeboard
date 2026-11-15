import AppKit

// Buttons' tips as main's (ui/Menu.tsx TooltipLayer, styles.css .tip): after the pointer rests TIP_DELAY on a button its
// tip shows over it, centred, 8 above (below when there is no room), with the button's key after it; moving on to
// another button switches at once, and for TIP_WARM after one hides the next shows at once; a press hides it. Drawn in
// the window over everything, never taking the pointer; the system's tool tips are not used, as they wait longer and
// look like the system's.

/// What a button says when the pointer rests on it (its data-tip) and its key (data-kbd)
package struct Tip: Equatable, Sendable {
  package var text: String
  package var kbd: String?

  package init(_ text: String, kbd: String? = nil) {
    self.text = text
    self.kbd = kbd
  }
}

@MainActor
package final class Tips {
  package static let shared = Tips()

  /// state/timing.ts TIP_DELAY, TIP_WARM
  package static let delay: TimeInterval = 0.5
  package static let warm: TimeInterval = 0.8

  /// Runs `f` after `s` seconds; tests run it when they choose
  package var after: (TimeInterval, @escaping @MainActor () -> Void) -> Void = { s, f in
    DispatchQueue.main.asyncAfter(deadline: .now() + s) { MainActor.assumeIsolated { f() } }
  }
  package var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }

  /// The tip showing and the view it is over
  package private(set) var shown: (tip: Tip, in: NSView)?
  /// The tip the pointer rests on, waiting its turn
  private var waiting: (tip: Tip, rect: CGRect, view: NSView, theme: Theme)?
  private var asked = 0
  private var warmUntil: TimeInterval = 0
  private let view = TipView()

  /// The pointer over a button saying `tip` (at `rect` in `view`), or over none
  package func hover(_ tip: Tip?, _ rect: CGRect = .zero, in view: NSView, theme: Theme) {
    guard let tip else {
      if waiting?.view === view || shown?.in === view { hide() }
      return
    }
    if let w = waiting, w.tip == tip, w.view === view, w.rect == rect { return }
    waiting = (tip, rect, view, theme)
    asked += 1
    if shown != nil || now() < warmUntil { return show() }
    let n = asked
    after(Self.delay) { [weak self] in
      guard let self, asked == n else { return }
      show()
    }
  }

  /// A press anywhere: the tip goes and the next waits its full delay again
  package func press() {
    hide()
    warmUntil = 0
  }

  private func hide() {
    asked += 1
    waiting = nil
    guard shown != nil else { return }
    shown = nil
    warmUntil = now() + Self.warm
    view.fade(in: false)
  }

  private func show() {
    guard let w = waiting, let content = w.view.window?.contentView else { return }
    shown = (w.tip, w.view)
    view.draw(w.tip, theme: w.theme, scale: w.view.window?.backingScaleFactor ?? 2)
    // over everything in the window: added again on top each time
    content.addSubview(view)
    let r = content.convert(w.rect, from: w.view)
    let size = view.frame.size
    let pad: CGFloat = 4
    let gap: CGFloat = 8
    let x = min(max(r.midX - size.width / 2, pad), content.bounds.width - pad - size.width)
    // above, in the content view's own direction; below when there is no room
    let up = content.isFlipped ? r.minY - gap - size.height : r.maxY + gap
    let down = content.isFlipped ? r.maxY + gap : r.minY - gap - size.height
    let fits = content.isFlipped ? up >= pad : up + size.height <= content.bounds.height - pad
    view.setFrameOrigin(CGPoint(x: x.rounded(), y: (fits ? up : down).rounded()))
    view.fade(in: true)
  }
}

/// The tip itself: a pill of the theme's tip colours (Ink Wash: nearly square), its text and key
final class TipView: NSView {
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer?.opacity = 0
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("TipView is not loaded from nibs") }

  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  /// themes.css --tip-bg and --tip-ink (styles.css :root for Warm Ink)
  static func colours(_ t: Theme) -> (bg: CGColor, ink: CGColor) {
    func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
      CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }
    return switch (t.id == .inkWash, t.dark) {
    case (true, false): (rgb(0x1d, 0x1c, 0x1a), rgb(0xfd, 0xfd, 0xfb))
    case (true, true): (rgb(0xe9, 0xe5, 0xda), rgb(0x13, 0x13, 0x12))
    case (false, false): (rgb(34, 32, 28, 0.92), rgb(0xf6, 0xf4, 0xef))
    case (false, true): (rgb(245, 243, 238, 0.94), rgb(0x1d, 0x1c, 0x1a))
    }
  }

  func draw(_ tip: Tip, theme t: Theme, scale: CGFloat) {
    let ink = t.id == .inkWash
    let font =
      ink
      ? Font.board("SourceSerif4-400-600", size: 11.5, weight: 400, opticalSize: true)
        ?? Font(NSFont.systemFont(ofSize: 11.5)) : Font(NSFont.systemFont(ofSize: 11.5))
    let mono = Font.board("JetBrainsMono-400-600", size: 10.5, weight: 400) ?? Font.mono(10.5, .regular)
    let (bg, fg) = Self.colours(t)
    let tw = Drawing.width(tip.text, font)
    let kw = tip.kbd.map { Drawing.width($0, mono) } ?? 0
    // 4 above and below a line of 1.5 (the board's 13px / 1.5, inherited)
    let size = CGSize(width: (8 + tw + (tip.kbd == nil ? 0 : 8 + kw) + 8).rounded(.up), height: 25)
    let radius: CGFloat = ink ? 2 : 8.5
    let image = CanvasView.picture(size: size, scale: scale) { ctx in
      ctx.addPath(
        CGPath(
          roundedRect: CGRect(origin: .zero, size: size), cornerWidth: radius, cornerHeight: radius, transform: nil))
      ctx.setFillColor(bg)
      ctx.fillPath()
      Drawing.text(ctx, tip.text, font, fg, x: 8, midY: size.height / 2, width: .infinity)
      if let k = tip.kbd {
        Drawing.text(
          ctx, k, mono, fg.copy(alpha: fg.alpha * 0.6) ?? fg, x: 8 + tw + 8, midY: size.height / 2, width: .infinity)
      }
    }
    setFrameSize(size)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer?.contents = image
    layer?.contentsScale = scale
    CATransaction.commit()
  }

  /// .tip.show: in over 120 ms on the board's ease-out; out over 80 ms
  func fade(in shows: Bool) {
    guard let layer else { return }
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = layer.presentation()?.opacity ?? layer.opacity
    a.toValue = shows ? 1 : 0
    a.duration = shows ? 0.12 : 0.08
    a.timingFunction =
      shows ? CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1) : CAMediaTimingFunction(name: .linear)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.opacity = shows ? 1 : 0
    CATransaction.commit()
    layer.add(a, forKey: "fade")
  }
}

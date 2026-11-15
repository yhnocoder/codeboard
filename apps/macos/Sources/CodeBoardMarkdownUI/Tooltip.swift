import AppKit

/// The board's own tooltip (ui/Menu.tsx TooltipLayer, styles.css .tip), for what the Note shows and for the controls
/// floating on it. It comes up once the pointer has rested TIP_DELAY on something with a tip, at once while another is
/// up or for TIP_WARM after one went; it goes when the pointer leaves, presses, scrolls, or the Note moves or zooms
/// under it. Above what it is about, 8 points off, flipped below when there is no room and shifted to stay 4 points
/// inside the window (place "top", gap 8, pad 4), so the Note's edge never cuts it. At the screen's own size; the
/// system's tooltip would have its own delay, look and wrapping
@MainActor
final class TipView: NSView {
  struct Tip: Equatable {
    var text: String
    /// the keys beside the name (data-kbd)
    var kbd: String?
    /// an address: wrapped, at most 480 wide (.tip.long)
    var long = false
    /// what it is about, in its superview's points
    var anchor: CGRect
    /// who asked for it: only that one takes it away when the pointer leaves
    var owner: ObjectIdentifier
  }

  private(set) var tip: Tip?
  /// waiting for its delay
  private(set) var pending: Tip?
  private var timer: Timer?
  private var warmUntil = -Double.infinity
  var clock: () -> Double = { CACurrentMediaTime() }
  var theme: MarkdownTheme?
  /// where it may go, in its superview's points: the window's part of it
  var area: () -> CGRect = { .zero }

  override var isFlipped: Bool { true }
  /// it never takes the pointer (pointer-events: none)
  override func hitTest(_ p: NSPoint) -> NSView? { nil }

  /// its delay is running
  var isTicking: Bool { timer != nil }

  /// The pointer is on something with this tip
  func over(_ t: Tip) {
    if let tip, tip.text == t.text, tip.kbd == t.kbd, tip.anchor == t.anchor { return }
    if pending == t { return }
    timer?.invalidate()
    timer = nil
    pending = nil
    if tip != nil || clock() < warmUntil { return show(t) }
    pending = t
    timer = Timer.scheduledTimer(withTimeInterval: MarkdownTiming.tipDelay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.fire() }
    }
  }

  /// the delay is over
  func fire() {
    timer?.invalidate()
    timer = nil
    guard let p = pending else { return }
    pending = nil
    show(p)
  }

  /// the pointer left what `owner` asked a tip for
  func leave(_ owner: ObjectIdentifier) {
    guard tip?.owner == owner || pending?.owner == owner else { return }
    hide()
  }

  /// a press anywhere: gone, and the next one waits its delay again
  func press() {
    hide()
    warmUntil = -.infinity
  }

  func hide() {
    timer?.invalidate()
    timer = nil
    pending = nil
    if tip != nil { warmUntil = clock() + MarkdownTiming.tipWarm }
    tip = nil
    isHidden = true
  }

  private func show(_ t: Tip) {
    tip = t
    guard let theme else { return }
    let area = area()
    frame = Self.place(Self.size(t, theme: theme, in: area), anchor: t.anchor, in: area)
    isHidden = false
    // over everything else floating on the Note
    if let sv = superview, sv.subviews.last !== self { sv.addSubview(self, positioned: .above, relativeTo: nil) }
    needsDisplay = true
    wantsLayer = true
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0
    fade.toValue = 1
    fade.duration = MarkdownTiming.tipShow
    // the board's --out
    fade.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
    layer?.add(fade, forKey: "show")
  }

  // MARK: its look

  /// .tip: 4 and 8 of padding, 11.5 text at the board's line height (1.5), the keys in the code font at 10.5, 8 apart
  static let padding = CGSize(width: 8, height: 4)
  static let lineHeight: CGFloat = 11.5 * 1.5
  static let gap: CGFloat = 8

  private static func text(_ t: Tip, _ theme: MarkdownTheme) -> NSAttributedString {
    let p = NSMutableParagraphStyle()
    p.minimumLineHeight = lineHeight
    p.maximumLineHeight = lineHeight
    p.lineBreakMode = t.long ? .byWordWrapping : .byClipping
    let font = FontBook.font(theme.fonts.body, size: 11.5) as NSFont
    return NSAttributedString(
      string: t.text,
      attributes: [
        .font: font, .paragraphStyle: p,
        .foregroundColor: NSColor(cgColor: theme.controls.tipInk.cg) ?? .white,
        // the half-leading CSS puts above the glyphs as well as below them
        .baselineOffset: (lineHeight - (font.ascender - font.descender)) / 2 - 0.5,
      ])
  }

  private static func keys(_ k: String, _ theme: MarkdownTheme) -> NSAttributedString {
    NSAttributedString(
      string: k,
      attributes: [
        .font: FontBook.font(theme.fonts.mono, size: 10.5) as NSFont,
        .foregroundColor: NSColor(cgColor: theme.controls.tipInk.alpha(0.6).cg) ?? .white,
      ])
  }

  /// the widest a tip may be: an address at most 480, and never wider than the window less 8 on each side
  static func widest(_ t: Tip, in area: CGRect) -> CGFloat {
    t.long ? min(480, area.width - 16) : .greatestFiniteMagnitude
  }

  static func size(_ t: Tip, theme: MarkdownTheme, in area: CGRect) -> CGSize {
    let k = t.kbd.map { keys($0, theme).size().width + gap } ?? 0
    let room = widest(t, in: area) - 2 * padding.width - k
    let r = text(t, theme).boundingRect(
      with: CGSize(width: max(1, room), height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading])
    let lines = max(1, (r.height / lineHeight).rounded())
    return CGSize(
      width: ceil(min(r.width, room) + k + 2 * padding.width), height: ceil(lines * lineHeight + 2 * padding.height))
  }

  /// Above the anchor, 8 off, centred on it; below when above leaves the area and below does not (else the side that
  /// overflows less); then shifted on both axes to stay 4 inside the area (floating-ui flip and shift, crossAxis)
  static func place(_ size: CGSize, anchor a: CGRect, in area: CGRect) -> CGRect {
    let pad: CGFloat = 4
    let gap: CGFloat = 8
    let above = a.minY - gap - size.height
    let below = a.maxY + gap
    let overAbove = max(0, area.minY + pad - above)
    let overBelow = max(0, below + size.height - (area.maxY - pad))
    var y = overAbove > 0 && overBelow < overAbove ? below : above
    var x = a.midX - size.width / 2
    x = max(area.minX + pad, min(x, area.maxX - pad - size.width))
    y = max(area.minY + pad, min(y, area.maxY - pad - size.height))
    return CGRect(origin: CGPoint(x: x.rounded(), y: y.rounded()), size: size)
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let t = tip, let theme, let ctx = NSGraphicsContext.current?.cgContext else { return }
    let r = CGFloat(theme.controls.tipRadius)
    ctx.addPath(CGPath(roundedRect: bounds, cornerWidth: r, cornerHeight: r, transform: nil))
    ctx.setFillColor(theme.controls.tipBackground.cg)
    ctx.fillPath()
    let k = t.kbd.map { keys($0, theme) }
    let kw = k.map { $0.size().width + Self.gap } ?? 0
    let box = bounds.insetBy(dx: Self.padding.width, dy: Self.padding.height)
    Self.text(t, theme).draw(
      with: CGRect(x: box.minX, y: box.minY, width: box.width - kw, height: box.height),
      options: [.usesLineFragmentOrigin, .usesFontLeading])
    if let k {
      let s = k.size()
      k.draw(at: CGPoint(x: box.maxX - s.width, y: box.midY - s.height / 2))
    }
  }

  private func keys(_ k: String, _ theme: MarkdownTheme) -> NSAttributedString { Self.keys(k, theme) }
}

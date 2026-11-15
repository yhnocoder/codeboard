import AppKit

/// A view of clickable controls as main's buttons behave (markdown.css .md-bb, the board's .tbtn): the control under the
/// pointer is `hovered`, the one the button went down on `pressed` until it comes up, wherever the pointer goes (CSS
/// :active), and a control acts on the release over the one it went down on (a click), never on a release elsewhere.
/// The view draws each control with `look(_:)`, the background eased over `fade` when main eases it. The pointer is a
/// pointing hand over a control (cursor: pointer) and an arrow elsewhere; a control's name is its tooltip, the board's
/// own (TipView)
@MainActor
class HoverControls: NSView {
  /// the control under the pointer, by its id
  private(set) var hovered: String?
  /// the control the button went down on, while it is held
  private(set) var pressed: String?
  /// the controls: id, box in the view's points, tooltip
  func controls() -> [(id: String, box: CGRect, tip: String)] { [] }
  /// the keys shown beside a control's name in its tip (data-kbd)
  func keys(_ id: String) -> String? { nil }
  /// a click on a control
  func activate(_ id: String, box: CGRect) {}

  /// how long the background takes to change on hover (0: at once, as .tbtn and .md-bb do); a press always changes it
  /// at once (:active has transition: none)
  var fade: Double { 0 }
  /// the background's share of the ink when hovered, and while pressed (nil: no pressed look, as .md-bb)
  var hoverInk: Double { 0.07 }
  var pressInk: Double? { nil }
  /// how much a pressed control shrinks (.tbtn:active scale .96)
  static let pressScale: CGFloat = 0.96

  /// the clock the background's easing is read from (a test's own)
  var clock: () -> Double = { CACurrentMediaTime() }
  private var levels: [String: Transition] = [:]
  private var link: CADisplayLink?

  /// A control's look now: its background's share of the ink, how far it is toward its hover look (0…1, for its ink),
  /// and its scale
  func look(_ id: String) -> (ink: Double, hover: Double, scale: CGFloat) {
    let ink = levels[id]?.value(at: clock()) ?? 0
    return (ink, min(1, ink / hoverInk), pressed == id && pressInk != nil ? Self.pressScale : 1)
  }

  /// whether a background is still easing (its display link runs only then)
  var isEasing: Bool { link != nil }

  /// a control kept in its hover look whatever the pointer does (the one whose menu is open: .open)
  var open: String? {
    didSet { if open != oldValue { restyle() } }
  }

  private func restyle() {
    let now = clock()
    for id in Set(levels.keys).union([hovered, pressed, open].compactMap { $0 }) {
      var t = levels[id] ?? Transition()
      if id == pressed, let p = pressInk {
        t.go(to: p, at: now, over: 0)
      } else {
        t.go(to: id == hovered || id == open ? hoverInk : 0, at: now, over: fade, .ease)
      }
      levels[id] = t
    }
    levels = levels.filter { $0.value.running(at: now) || $0.value.value(at: now) != 0 }
    ease()
  }

  /// what else of the view is easing now (a subclass's own transitions)
  func easing(at now: Double) -> Bool { false }

  private func running(at now: Double) -> Bool {
    levels.values.contains { $0.running(at: now) } || easing(at: now)
  }

  /// redraws, each frame while anything eases and no longer
  func ease() {
    needsDisplay = true
    guard link == nil, running(at: clock()) else { return }
    let l = displayLink(target: self, selector: #selector(easeFrame(_:)))
    l.add(to: .main, forMode: .common)
    link = l
  }

  @objc func easeFrame(_ l: CADisplayLink?) {
    MarkdownEditorView.linkTicks += 1
    needsDisplay = true
    if !running(at: clock()) {
      link?.invalidate()
      link = nil
    }
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window == nil {
      link?.invalidate()
      link = nil
    }
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for a in trackingAreas where a.owner === self { removeTrackingArea(a) }
    // over the whole view, not its visible rect: what floats past the Note's edges is cut out of that, and got no moves
    addTrackingArea(
      NSTrackingArea(
        rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .cursorUpdate, .activeAlways], owner: self))
  }

  override func setFrameSize(_ s: NSSize) {
    super.setFrameSize(s)
    updateTrackingAreas()
  }

  /// the editor's tooltip, when this floats on one
  var tips: TipView? {
    var v = superview
    while let s = v {
      if let e = s as? MarkdownEditorView { return e.tipView }
      v = s.superview
    }
    return nil
  }

  func hover(at p: CGPoint?) {
    let c = p.flatMap { p in controls().first { $0.box.contains(p) } }
    let id = c?.id
    guard id != hovered else { return }
    hovered = id
    restyle()
    (id == nil ? NSCursor.arrow : NSCursor.pointingHand).set()
    // no tips while the button is held (ui/Menu.tsx: not while dragging)
    if let c, !c.tip.isEmpty, pressed == nil, let tips {
      tips.over(
        .init(
          text: c.tip, kbd: keys(c.id), anchor: tips.superview.map { $0.convert(c.box, from: self) } ?? c.box,
          owner: ObjectIdentifier(self)))
    } else {
      tips?.leave(ObjectIdentifier(self))
    }
  }

  /// the button goes down on a control
  func press(at p: CGPoint) {
    tips?.press()
    pressed = controls().first { $0.box.contains(p) }?.id
    restyle()
  }

  /// the button comes up: the control acts when the pointer is still on it
  func release(at p: CGPoint) {
    let was = pressed
    pressed = nil
    restyle()
    hover(at: p)
    if let was, let c = controls().first(where: { $0.id == was && $0.box.contains(p) }) { activate(c.id, box: c.box) }
  }

  override func mouseMoved(with e: NSEvent) { hover(at: convert(e.locationInWindow, from: nil)) }
  override func mouseEntered(with e: NSEvent) { hover(at: convert(e.locationInWindow, from: nil)) }
  override func mouseExited(with e: NSEvent) { hover(at: nil) }
  override func mouseDown(with e: NSEvent) { press(at: convert(e.locationInWindow, from: nil)) }
  override func mouseDragged(with e: NSEvent) { hover(at: convert(e.locationInWindow, from: nil)) }
  override func mouseUp(with e: NSEvent) { release(at: convert(e.locationInWindow, from: nil)) }
  override func cursorUpdate(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    (controls().contains { $0.box.contains(p) } ? NSCursor.pointingHand : NSCursor.arrow).set()
  }
  override func resetCursorRects() {
    for c in controls() { addCursorRect(c.box, cursor: .pointingHand) }
  }

  /// draws `body` scaled about `box`'s centre as a pressed control shrinks
  func scaled(_ s: CGFloat, about box: CGRect, _ ctx: CGContext, _ body: () -> Void) {
    guard s != 1 else { return body() }
    ctx.saveGState()
    ctx.translateBy(x: box.midX, y: box.midY)
    ctx.scaleBy(x: s, y: s)
    ctx.translateBy(x: -box.midX, y: -box.midY)
    body()
    ctx.restoreGState()
  }
}

extension MDColor {
  /// this colour `k` of the way to `other` (CSS color transitions mix in sRGB)
  func mixed(_ other: MDColor, _ k: Double) -> MDColor {
    MDColor(r + (other.r - r) * k, g + (other.g - g) * k, b + (other.b - b) * k, a + (other.a - a) * k)
  }
}

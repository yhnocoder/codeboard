import AppKit
import CodeBoardModel

// Into a sub-board and out again, and the breadcrumb over it (ui/Crumbs.tsx CrumbsNav; actions/subboards.ts enterFrame,
// leaveBoard, morphIn, morphOut, boardShown; styles.css .crumbs, .sbmorph). The camera does not move: the card's name
// flies from above the card to the breadcrumb's current crumb while the board fades out, and the board entered fades in
// from 1.03 times its size about the view's middle. Leaving, the name flies back onto the card it came from, the
// breadcrumb fades and the board left fades out growing to 1.03; the parent comes back where its camera was. The name
// is never shown twice: the card's own name is hidden while its copy flies, and the current crumb until it lands.

/// What the breadcrumb shows of a board this one was entered from
public struct CrumbShown: Equatable, Sendable {
  public var board: BoardID
  /// The sub-board card it was entered by
  public var frame: CardID
  public var name: String

  public init(board: BoardID, frame: CardID, name: String) {
    self.board = board
    self.frame = frame
    self.name = name
  }
}

/// 280 ms in, 220 out; the board shown fades in for at least 140 (subboards.ts ENTER_MS, LEAVE_MS, FADE_IN_MIN)
private let enterTime = 0.28
private let leaveTime = 0.22
private let fadeInMin = 0.14
private let grownBy: CGFloat = 1.03
/// No board came: the move is taken back (GIVE_UP)
private let giveUp = 2.5
private var easeOut: CAMediaTimingFunction { CAMediaTimingFunction(controlPoints: 0.215, 0.61, 0.355, 1) }
private var easeInOut: CAMediaTimingFunction { CAMediaTimingFunction(controlPoints: 0.645, 0.045, 0.355, 1) }

/// Where a name is in the canvas (view points): its left edge, its middle, its font size
struct NameSpot: Equatable {
  var left: CGFloat
  var mid: CGFloat
  var font: CGFloat
}

/// A move into a sub-board or out of one, from its start until the board it goes to is shown
struct BoardMove {
  let id: Int
  let entering: Bool
  let start: CFTimeInterval
  let time: Double
  /// The name's copy in flight, and when its flight ends
  var ghost: CALayer?
  var flightEnds: CFTimeInterval = 0
  /// Leaving: the card the name lands on
  var back: CrumbShown?
  /// The card whose name is hidden meanwhile
  var masked: CardID?
  /// The breadcrumb was there when entering (from a sub-board deeper): it stays, only the new crumb comes in
  var navKept = false
  var arrived = false
}

/// The breadcrumb (.crumbs.pill): ← Engine › Scheduler at the top left of the board, 12 down and 16 in
@MainActor
final class CrumbsBar: NSView {
  enum Part: Equatable {
    case back
    case crumb(Int)
  }

  var theme = Theme.warmInk {
    didSet { if !theme.same(as: oldValue) { redraw() } }
  }
  /// The boards this one was entered from, outermost first, and this board's name
  var parents: [CrumbShown] = [] {
    didSet { if parents != oldValue { redraw() } }
  }
  var current = "" {
    didSet { if current != oldValue { redraw() } }
  }
  /// .crumbs.morph: the current crumb hidden while the name flies to it or from it
  var hidesCurrent = false {
    didSet { if hidesCurrent != oldValue { redraw() } }
  }
  /// A crumb clicked (its depth), or ← (nil: the parent)
  var onLeave: ((Int?) -> Void)?
  /// The canvas's way to the shell: into a sub-board's board, back to a crumb's
  var enter: ((BoardID, CardID, Camera) -> Void)?
  var leave: ((Int?) -> Void)?
  /// The copies of names in flight, over the breadcrumb (.sbmorph z-index 22 over .crumbs 21)
  let flight = LayerView()
  /// Where the copies are, y-down as the canvas (AppKit keeps the view's own layer's geometry)
  let stage = CALayer()
  /// What the canvas keeps for the board shown: its crumbs as the shell gave them, the move under way
  var crumbs: [CrumbShown] = []
  var move: BoardMove?
  var moves = 0
  /// Where each card's name was when its sub-board was entered (board|card): leaving flies back there
  static var titleSpots: [String: NameSpot] = [:]

  private var hover: Part? {
    didSet { if hover != oldValue { redraw() } }
  }
  private var pressed: Part?
  private let face = LayerView()
  /// Room around the pill for its shadow
  private static let margin: CGFloat = 32

  init() {
    super.init(frame: .zero)
    wantsLayer = true
    face.wantsLayer = true
    addSubview(face)
    flight.wantsLayer = true
    stage.isGeometryFlipped = true
    stage.anchorPoint = .zero
    flight.layer?.addSublayer(stage)
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("CrumbsBar is not loaded from nibs") }

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  // MARK: Layout (.crumbs: padding 3 6, gap 2, 12.5 / 1; .crumb padding 4 6; .back padding 3 5 round a 14 icon)

  static func font(_ t: Theme, bold: Bool) -> Font {
    if t.id == .inkWash,
      let f = Font.board("SourceSerif4-400-600", size: 12.5, weight: bold ? 600 : 400, opticalSize: true)
    {
      return f
    }
    return Font(NSFont.systemFont(ofSize: 12.5, weight: bold ? .semibold : .regular))
  }

  static let cellHeight: CGFloat = 12.5 + 8
  static let pad: CGFloat = 6

  /// Each part's rect, the separators' left edges and the pill's size, with the pill's top left at the origin
  static func layout(parents: [String], current: String, theme t: Theme) -> (
    parts: [(Part, CGRect)], seps: [CGFloat], cur: CGRect, size: CGSize
  ) {
    let h = cellHeight + 6
    var x: CGFloat = 6
    var parts: [(Part, CGRect)] = [(.back, CGRect(x: x, y: (h - 20) / 2, width: 24, height: 20))]
    var seps: [CGFloat] = []
    x += 24 + 2
    let plain = font(t, bold: false)
    let sepW = Drawing.width("›", plain)
    for (i, p) in parents.enumerated() {
      let w = Drawing.width(p, plain) + 2 * pad
      parts.append((.crumb(i), CGRect(x: x, y: 3, width: w, height: cellHeight)))
      x += w + 2
      seps.append(x)
      x += sepW + 2
    }
    let cw = Drawing.width(current, font(t, bold: true)) + 2 * pad
    let cur = CGRect(x: x, y: 3, width: cw, height: cellHeight)
    return (parts, seps, cur, CGSize(width: (x + cw + 6).rounded(.up), height: h))
  }

  var laidOut: (parts: [(Part, CGRect)], seps: [CGFloat], cur: CGRect, size: CGSize) {
    Self.layout(parents: parents.map(\.name), current: current, theme: theme)
  }

  func part(at p: CGPoint) -> Part? { laidOut.parts.first { $0.1.contains(p) }?.0 }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard !isHidden, alphaValue > 0, let sv = superview else { return nil }
    return CGRect(origin: .zero, size: laidOut.size).contains(convert(point, from: sv)) ? self : nil
  }

  func redraw() {
    let t = theme
    let l = laidOut
    let look = BarLook.of(t)
    let m = Self.margin
    let scale = window?.backingScaleFactor ?? 2
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if frame.size != l.size { setFrameSize(l.size) }
    face.frame = bounds.insetBy(dx: -m, dy: -m)
    face.layer?.contentsScale = scale
    let plain = Self.font(t, bold: false)
    let bold = Self.font(t, bold: true)
    let names = parents.map(\.name)
    face.layer?.contents = CanvasToolbar.bitmap(face.frame.size, scale: scale) { ctx in
      ctx.translateBy(x: m, y: m)
      WritingBar.float(
        CGRect(origin: .zero, size: l.size), radius: look.radius, look: look, glass: HeadActs.glass(t), scale: scale,
        squircle: t.id != .inkWash, in: ctx)
      ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
      for (p, r) in l.parts {
        let lit = self.hover == p
        // .crumb:hover: the row tint (--row: the accent at 9 %), the ink
        if lit {
          ctx.addPath(CGPath(roundedRect: r, cornerWidth: 7, cornerHeight: 7, transform: nil))
          ctx.setFillColor(t.accent.copy(alpha: 0.09) ?? t.accent)
          ctx.fillPath()
        }
        switch p {
        case .back:
          ctx.saveGState()
          ctx.translateBy(x: r.minX + 5, y: r.minY + 3)
          ctx.scaleBy(x: 14 / 16, y: 14 / 16)
          Icons.stroke(SVGPath.parse("M10 12 6 8l4-4"), at: .zero, color: lit ? look.ink : look.ink2, in: ctx)
          ctx.restoreGState()
        case .crumb(let i):
          Drawing.text(
            ctx, names[i], plain, lit ? look.ink : look.ink2, x: r.minX + Self.pad, midY: r.midY, width: .infinity)
        }
      }
      for x in l.seps { Drawing.text(ctx, "›", plain, t.ink3, x: x, midY: l.cur.midY, width: .infinity) }
      if !self.hidesCurrent {
        Drawing.text(
          ctx, self.current, bold, look.ink, x: l.cur.minX + Self.pad, midY: l.cur.midY, width: .infinity)
      }
    }
    CATransaction.commit()
  }

  // MARK: Pointer: a crumb acts on the release over it

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    for t in trackingAreas where t.owner === self { removeTrackingArea(t) }
    addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
  }

  override func mouseMoved(with e: NSEvent) { hover = part(at: convert(e.locationInWindow, from: nil)) }
  override func mouseExited(with e: NSEvent) { hover = nil }
  override func mouseDown(with e: NSEvent) { pressed = part(at: convert(e.locationInWindow, from: nil)) }
  override func mouseUp(with e: NSEvent) {
    defer { pressed = nil }
    guard let p = pressed, p == part(at: convert(e.locationInWindow, from: nil)) else { return }
    switch p {
    case .back: onLeave?(nil)
    case .crumb(let i): onLeave?(i)
    }
  }

  // the parts as accessibility elements (ui-crumbs, ui-crumbback, ui-crumb0…, ui-crumbcur)
  override func isAccessibilityElement() -> Bool { true }
  override func accessibilityRole() -> NSAccessibility.Role? { .group }
  override func accessibilityIdentifier() -> String { "ui-crumbs" }
  override func accessibilityChildren() -> [Any]? {
    let l = laidOut
    return l.parts.map { p, r in
      switch p {
      case .back: uiElement("crumbback", r, label: "Back", in: self)
      case .crumb(let i): uiElement("crumb\(i)", r, label: parents[i].name, in: self)
      }
    } + [uiElement("crumbcur", l.cur, in: self)]
  }
}

extension CanvasView {
  /// The boards this one was entered from (the shell's crumbs for its tab). While a move is under way they are shown
  /// once its board is
  public var crumbs: [CrumbShown] {
    get { crumbsBar.crumbs }
    set {
      crumbsBar.crumbs = newValue
      if crumbsBar.move == nil { showCrumbs() }
    }
  }

  /// A sub-board card's board entered from it in this tab: the board, the card, the camera here then
  public var onEnterBoard: ((BoardID, CardID, Camera) -> Void)? {
    get { crumbsBar.enter }
    set { crumbsBar.enter = newValue }
  }

  /// Back to a crumb's board (its depth; nil: the parent)
  public var onLeaveBoard: ((Int?) -> Void)? {
    get { crumbsBar.leave }
    set { crumbsBar.leave = newValue }
  }

  /// The breadcrumb as the board shown has it: shown over a sub-board, hidden over a board at the top
  func showCrumbs() {
    let bar = crumbsBar
    if bar.superview !== self {
      addSubview(bar)
      addSubview(bar.flight, positioned: .above, relativeTo: bar)
      bar.onLeave = { [weak self] in self?.leaveBoard($0) }
    }
    bar.theme = theme
    bar.parents = crumbs
    bar.current = shown?.board.title ?? ""
    bar.setFrameOrigin(CGPoint(x: 16, y: 12))
    bar.flight.frame = bounds
    withoutAnimation { bar.stage.frame = bar.flight.bounds }
    bar.isHidden = crumbs.isEmpty
  }

  /// Where the name over a sub-board card is drawn now (Drawing.subBoard: 6 in, its middle 31 above the card)
  func subNameSpot(_ id: CardID) -> NameSpot? {
    guard let r = scene?.placed[id]?.rect else { return nil }
    let p = camera.view(CGPoint(x: r.minX + 6, y: r.minY - 31))
    return NameSpot(left: p.x, mid: p.y, font: CTFontGetSize(theme.subName.ct) * camera.zoom)
  }

  /// A sub-board card's name hidden (its head: name and count), or shown again
  func maskSubName(_ id: CardID, _ hide: Bool) {
    guard let i = index(of: .card(id)) else { return }
    let box = items[i].box
    withoutAnimation {
      guard hide else {
        box.mask = nil
        return
      }
      let m = CAShapeLayer()
      let all = box.bounds.insetBy(dx: -400, dy: -400)
      m.frame = all
      let p = CGMutablePath()
      p.addRect(CGRect(origin: .zero, size: all.size))
      p.addRect(CGRect(x: 400 - 2, y: 400 - Drawing.subHead, width: box.bounds.width + 4, height: Drawing.subHead - 12))
      m.path = p
      m.fillRule = .evenOdd
      box.mask = m
    }
  }

  /// The current crumb's cell in this view, as the breadcrumb lays it out for these parents and name
  func crumbCell(parents: [String], current: String) -> CGRect {
    CrumbsBar.layout(parents: parents, current: current, theme: theme).cur.offsetBy(dx: 16, dy: 12)
  }

  /// The copy of a name that flies (.sbmorph): a box on the crumb's cell, the crumb's font, moved by its transform
  func nameCopy(_ text: String, on cell: CGRect, largest k: CGFloat) -> CALayer {
    let l = CALayer()
    l.anchorPoint = .zero
    l.frame = cell
    let scale = (window?.backingScaleFactor ?? 2) * max(1, k)
    let font = CrumbsBar.font(theme, bold: true)
    let ink = BarLook.of(theme).ink
    l.contentsScale = scale
    l.contents = CanvasToolbar.bitmap(cell.size, scale: scale) { ctx in
      ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
      Drawing.text(ctx, text, font, ink, x: CrumbsBar.pad, midY: cell.height / 2, width: .infinity)
    }
    crumbsBar.stage.addSublayer(l)
    return l
  }

  /// The transform that lays the copy on a card's name (onTitle): scaled to its size, its text's left on the name's
  static func onName(_ n: NameSpot, cell: CGRect, font: CGFloat) -> CATransform3D {
    let k = n.font / font
    let dx = n.left - CrumbsBar.pad * k - cell.minX
    let dy = n.mid - cell.minY - cell.height * k / 2
    return CATransform3DScale(CATransform3DMakeTranslation(dx, dy, 0), k, k, 1)
  }

  /// The world's transform at `k` times about the view's middle
  private var grownWorld: CATransform3D {
    let c = CGPoint(x: bounds.midX, y: bounds.midY)
    return CATransform3DScale(
      CATransform3DMakeTranslation(c.x * (1 - grownBy), c.y * (1 - grownBy), 0), grownBy, grownBy, 1)
  }

  private func animate(
    _ l: CALayer, _ key: String, from: Any?, to: Any, over d: Double, _ f: CAMediaTimingFunction
  ) {
    let a = CABasicAnimation(keyPath: key)
    a.fromValue = from ?? l.presentation()?.value(forKeyPath: key) ?? l.value(forKeyPath: key)
    a.toValue = to
    a.duration = d
    a.timingFunction = f
    withoutAnimation { l.setValue(to, forKeyPath: key) }
    l.add(a, forKey: key)
  }

  // MARK: In and out

  /// Double-click, ⌘↵ or Open on a sub-board card (enterFrame): its board in this tab, the name flying to the breadcrumb
  func enterSubBoard(_ id: CardID, _ target: BoardID) {
    guard let enter = onEnterBoard else { return onOpenBoard?(target, nil) ?? () }
    guard crumbsBar.move == nil, let here = shown?.board else { return }
    guard case .board(let d)? = scene?.parts[id]?.drawing else { return }
    showCrumbs()
    let bar = crumbsBar
    let back = camera
    bar.moves += 1
    var m = BoardMove(
      id: bar.moves, entering: true, start: CACurrentMediaTime(), time: enterTime, navKept: !bar.isHidden)
    let cell = crumbCell(parents: crumbs.map(\.name) + [here.title], current: d.name)
    if let from = subNameSpot(id) {
      CrumbsBar.titleSpots["\(here.id.rawValue)|\(id.rawValue)"] = from
      let font: CGFloat = 12.5
      let ghost = nameCopy(d.name, on: cell, largest: from.font / font)
      withoutAnimation { ghost.transform = Self.onName(from, cell: cell, font: font) }
      animate(ghost, "transform", from: nil, to: CATransform3DIdentity, over: enterTime, easeOut)
      m.ghost = ghost
      m.flightEnds = m.start + enterTime
      maskSubName(id, true)
      m.masked = id
    }
    animate(world, "opacity", from: 1, to: 0, over: enterTime * 0.6, CAMediaTimingFunction(name: .easeIn))
    bar.move = m
    let n = m.id
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(enterTime * 0.6))
      guard self?.crumbsBar.move?.id == n else { return }
      enter(target, id, back)
    }
    giveUpLater(n)
  }

  /// A crumb, ← or Esc (leaveBoard): back to the board at `depth` (nil: the parent), where its camera was; the name
  /// flies back onto its card there
  func leaveBoard(_ depth: Int? = nil) {
    guard let leave = onLeaveBoard, crumbsBar.move == nil, !crumbs.isEmpty else { return }
    showCrumbs()
    let bar = crumbsBar
    let d = max(0, min(crumbs.count - 1, depth ?? crumbs.count - 1))
    bar.moves += 1
    var m = BoardMove(id: bar.moves, entering: false, start: CACurrentMediaTime(), time: leaveTime)
    m.back = crumbs[d]
    let cell = crumbCell(parents: crumbs.map(\.name), current: bar.current)
    let at = CrumbsBar.titleSpots["\(crumbs[d].board.rawValue)|\(crumbs[d].frame.rawValue)"]
    // drawn sharp at its largest: on the card's name
    let ghost = nameCopy(bar.current, on: cell, largest: (at?.font ?? 12.5) / 12.5)
    bar.hidesCurrent = true
    if let at {
      animate(
        ghost, "transform", from: CATransform3DIdentity, to: Self.onName(at, cell: cell, font: 12.5), over: leaveTime,
        easeInOut)
    }
    m.ghost = ghost
    m.flightEnds = m.start + leaveTime
    animate(bar.layer!, "opacity", from: 1, to: 0, over: leaveTime * 0.3, CAMediaTimingFunction(name: .easeOut))
    let ease = CAMediaTimingFunction(name: .easeIn)
    animate(world, "opacity", from: 1, to: 0, over: leaveTime * 0.65, ease)
    animate(world, "transform", from: CATransform3DIdentity, to: grownWorld, over: leaveTime * 0.65, ease)
    bar.move = m
    let n = m.id
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(leaveTime * 0.65))
      guard self?.crumbsBar.move?.id == n else { return }
      leave(d)
    }
    giveUpLater(n)
  }

  /// The board shown after a load (boardShown): it fades in (entering, from 1.03 times its size), the breadcrumb comes
  /// with its new crumbs, and leaving, the name lands on its card where that is now
  func boardArrived() {
    guard var m = crumbsBar.move, !m.arrived else { return showCrumbs() }
    m.arrived = true
    crumbsBar.move = m
    let bar = crumbsBar
    let now = CACurrentMediaTime()
    let left = max(fadeInMin, m.time - (now - m.start))
    world.removeAllAnimations()
    bar.layer?.removeAllAnimations()
    withoutAnimation { bar.layer?.opacity = 1 }
    if m.entering {
      animate(world, "opacity", from: 0, to: 1, over: left, easeOut)
      animate(world, "transform", from: grownWorld, to: CATransform3DIdentity, over: left, easeOut)
    } else {
      withoutAnimation { world.transform = CATransform3DIdentity }
      animate(world, "opacity", from: 0, to: 1, over: left, easeOut)
    }
    let wasHidden = bar.isHidden
    showCrumbs()
    bar.hidesCurrent = m.entering && m.ghost != nil
    if !bar.isHidden && (!m.entering || !m.navKept || wasHidden) {
      animate(bar.layer!, "opacity", from: 0, to: 1, over: left, CAMediaTimingFunction(name: .easeOut))
    }
    if !m.entering, let g = m.ghost, let back = m.back {
      if let real = subNameSpot(back.frame) {
        maskSubName(back.frame, true)
        m.masked = back.frame
        let want = Self.onName(real, cell: CGRect(origin: g.position, size: g.bounds.size), font: 12.5)
        let was = CrumbsBar.titleSpots["\(back.board.rawValue)|\(back.frame.rawValue)"]
        // where the name is now on the board it came back to, when that is not where it was left
        if was.map({ abs($0.left - real.left) + abs($0.mid - real.mid) > 1 }) ?? true {
          animate(g, "transform", from: nil, to: want, over: left, easeInOut)
          m.flightEnds = now + left
        }
      } else {
        g.removeFromSuperlayer()
        m.ghost = nil
      }
      crumbsBar.move = m
    }
    let n = m.id
    let ends = max(now + left, m.flightEnds)
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(ends - CACurrentMediaTime()))
      guard let self, self.crumbsBar.move?.id == n else { return }
      self.finishMove()
    }
  }

  /// The copy goes, the card's name and the current crumb show again
  private func finishMove() {
    guard let m = crumbsBar.move else { return }
    crumbsBar.move = nil
    m.ghost?.removeFromSuperlayer()
    if let c = m.masked { maskSubName(c, false) }
    crumbsBar.hidesCurrent = false
  }

  /// No board came (the shell refused, a load failed): the board fades back, the name goes back to its place
  private func giveUpLater(_ n: Int) {
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(giveUp))
      guard let self, let m = self.crumbsBar.move, m.id == n, !m.arrived else { return }
      self.world.removeAllAnimations()
      self.crumbsBar.layer?.removeAllAnimations()
      withoutAnimation {
        self.world.transform = CATransform3DIdentity
        self.crumbsBar.layer?.opacity = 1
      }
      self.animate(self.world, "opacity", from: 0, to: 1, over: fadeInMin, easeOut)
      self.finishMove()
    }
  }
}

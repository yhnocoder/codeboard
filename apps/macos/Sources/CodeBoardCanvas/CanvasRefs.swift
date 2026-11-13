import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import SwiftUI

// Clicks on [[refs]] (the web board's ui/Md.tsx openRef, ui/pops/cardpeek.tsx, actions/subboards.ts openCardRef,
// cardNear, goToNearCard, goAfterDblClick): in a Note, Text or Box at rest, in the one being written in, in the sidenote
// popup. A ref to a card of this board near the view goes there, once the double-click time is over (a double-click
// opens the ref's source): the camera glides until the card is in view, the card flashes and, unless it was clicked
// while writing, is selected. A card farther away or on another board is previewed in place at once, beside what the
// ref is on; the preview's arrow goes there. A Section or a board is gone to as a near card is. ⌘-click goes at once.

extension CanvasView {
  /// Where a clicked ref is: on a card (its box on the board), or in the sidenote popup (its box in the popup's web
  /// view)
  package enum RefAt: Equatable {
    case card(CardID, CGRect)
    case popup(CGRect)
  }

  /// The ref drawn on a card at rest under a board point, and the card
  func refAt(_ p: CGPoint) -> (card: CardID, box: NoteRefBox)? {
    guard let c = hitCard(p), editing?.id != c, let placed = scene?.placed[c], !placed.folded else { return nil }
    let local = CGPoint(x: p.x - placed.rect.minX, y: p.y - placed.rect.minY)
    guard let b = placed.refs.first(where: { $0.rect.insetBy(dx: -1, dy: -1).contains(local) }) else { return nil }
    return (c, b)
  }

  func boardRect(_ box: NoteRefBox, on c: CardID) -> CGRect {
    let o = scene?.placed[c]?.rect.origin ?? .zero
    return box.rect.offsetBy(dx: o.x, dy: o.y)
  }

  /// The middles of the refs drawn on a card, on the board, in order (the review sheets)
  package func refPoints(on c: CardID) -> [CGPoint] {
    (scene?.placed[c]?.refs ?? []).map { b in
      let r = boardRect(b, on: c)
      return CGPoint(x: r.midX, y: r.midY)
    }
  }

  /// A click on a board point as the pointer gives one (the review sheets)
  package func refClick(at p: CGPoint) {
    guard let r = refAt(p) else { return }
    refClicked(.card(r.card, boardRect(r.box, on: r.card)), r.box.ref, r.box.target, go: false, writing: false)
  }

  /// A ref pressed in a web view: the editor's (on the card being written in) or the popup's; nil: the second press
  /// of a double-click on one, which drops what the first began
  func refPressed(_ p: RefPress?, inPopup: Bool) {
    guard let p else { return cancelRefGo() }
    if inPopup {
      refClicked(.popup(p.rect), p.ref, p.target, go: p.go, writing: p.writing)
    } else if let id = editing?.id {
      let v = noteEditor.view.convert(p.rect, to: self)
      let r = CGRect(
        origin: camera.board(v.origin), size: CGSize(width: v.width / camera.zoom, height: v.height / camera.zoom))
      refClicked(.card(id, r), p.ref, p.target, go: p.go, writing: true)
    }
  }

  /// A click on a ref (`writing`: in an editor, whose caret stays: the camera only moves, nothing is selected)
  package func refClicked(_ at: RefAt, _ label: String, _ target: String?, go: Bool, writing: Bool) {
    guard let doc = document, let (vb, vault) = shown else { return }
    let key = refKey(at, NoteRefBox(ref: label, target: target, rect: .zero))
    // its second click closes what its first opened
    if let peek = refPeek, peek.key == key { return closeRefPeek() }
    closeRefPeek()
    let resolver = RefResolver(doc.board, package: vault.url(of: vb.path), vault: vault)
    guard let place = resolver.locate(label, target: target) else { return }
    if !go {
      switch place {
      case .card(let c) where !cardNear(c): return openRefPeek(key: key, at: at, card: c, on: nil)
      // a card in a sub-board shown here is on this board for the rule: near, gone to; far, previewed
      case .elsewhere(let b, let c) where !(inSubBoard(b, c).map { rectNear($0.block) } ?? false):
        return openRefPeek(key: key, at: at, card: c, on: b)
      default: break
      }
    }
    if go { return goToRef(place, writing: writing) }
    cancelRefGo()
    let wait = refWait
    refGo = Task { [weak self] in
      try? await Task.sleep(for: wait)
      guard !Task.isCancelled, let self else { return }
      refGo = nil
      goToRef(place, writing: writing)
    }
  }

  /// What tells a ref's second click from a click on another
  func refKey(_ at: RefAt, _ box: NoteRefBox) -> String {
    switch at {
    case .card(let c, let r): "card \(c.rawValue) \(Int(r.minX)) \(Int(r.minY)) \(box.ref) \(box.target ?? "")"
    case .popup(let r): "popup \(Int(r.minX)) \(Int(r.minY)) \(box.ref) \(box.target ?? "")"
    }
  }

  func cancelRefGo() {
    refGo?.cancel()
    refGo = nil
  }

  /// Goes where a ref points: a card of this board into view, flashed (selected too unless written in), a Section
  /// framed, another board opened (at its card)
  func goToRef(_ place: RefResolver.Place, writing: Bool) {
    guard let doc = document else { return }
    switch place {
    case .card(let c):
      guard let r = scene?.items.first(where: { $0.owner == .card(c) })?.rect else { return }
      if !writing { doc.select([.card(c)]) }
      reveal(r)
      flash(c)
    case .section(let s):
      guard let r = scene?.frames.first(where: { $0.id == s })?.rect else { return }
      if !writing { doc.select([.section(s)]) }
      motion.fly(to: fitRect(r, maxZoom: 1.4))
      moved()
    case .board(let b): onOpenBoard?(b, nil)
    case .elsewhere(let b, let c):
      // in a sub-board shown here: its block in the map, the sub-board card selected
      guard let (frame, block) = inSubBoard(b, c) else {
        onOpenBoard?(b, .card(c))
        return
      }
      if !writing { doc.select([.card(frame)]) }
      reveal(block)
      flash(block, tilt: 0, radius: 2.5, id: frame)
    }
  }

  /// Another board opened at a card a ref points to: it is brought into view, selected and flashed
  public func arrive(at c: CardID) {
    guard document?.board.card(c) != nil else { return }
    goToRef(.card(c), writing: false)
  }

  // MARK: The camera (camera.ts SAFE, isVisible, fitTop, fitRect, cardNear)

  /// The room kept free around what the camera brings into view, in view points: left, right, top, bottom
  static let safe = (l: CGFloat(24), r: CGFloat(24), t: CGFloat(60), b: CGFloat(64))

  /// The view without the room kept free, on the board
  var safeView: CGRect {
    let s = Self.safe
    let z = camera.zoom
    return CGRect(
      x: camera.origin.x + s.l / z, y: camera.origin.y + s.t / z, width: (bounds.width - s.l - s.r) / z,
      height: (bounds.height - s.t - s.b) / z)
  }

  /// A card is near the view: less than a view away across and down, or in it
  func cardNear(_ c: CardID) -> Bool {
    guard let r = scene?.items.first(where: { $0.owner == .card(c) })?.rect else { return false }
    return rectNear(r)
  }

  /// Within one view of the view in each direction
  func rectNear(_ r: CGRect) -> Bool {
    let v = safeView
    let dx = max(0, v.minX - r.maxX, r.minX - v.maxX)
    let dy = max(0, v.minY - r.maxY, r.minY - v.maxY)
    return dx < v.width && dy < v.height
  }

  /// `r` into view, the zoom kept (lower when it is wider than the view); nothing moves when it is in view
  func reveal(_ r: CGRect) {
    let v = safeView
    let top = CGRect(x: r.minX, y: r.minY, width: r.width, height: min(r.height, v.height))
    guard !v.contains(top) else { return }
    motion.fly(to: fitTop(r, maxZoom: camera.zoom))
    moved()
  }

  func fitTop(_ r: CGRect, maxZoom: CGFloat) -> Camera {
    let s = Self.safe
    let w = bounds.width - s.l - s.r
    let h = bounds.height - s.t - s.b
    let z = max(limits.min, min(maxZoom, w / r.width))
    if r.height * z <= h { return fitRect(r, maxZoom: z) }
    let x = s.l + (w - r.width * z) / 2 - r.minX * z
    return Camera(origin: CGPoint(x: -x / z, y: -(s.t - r.minY * z) / z), zoom: z)
  }

  func fitRect(_ r: CGRect, maxZoom: CGFloat) -> Camera {
    let s = Self.safe
    let w = bounds.width - s.l - s.r
    let h = bounds.height - s.t - s.b
    let z = max(limits.min, min(maxZoom, w / r.width, h / r.height))
    let x = s.l + (w - r.width * z) / 2 - r.minX * z
    let y = s.t + (h - r.height * z) / 2 - r.minY * z
    return Camera(origin: CGPoint(x: -x / z, y: -y / z), zoom: z)
  }

  /// The card flashes once (styles.css .card.ping: a ring of the accent at 45 % spreading 14 out and fading, 700 ms)
  func flash(_ c: CardID) {
    guard let it = scene?.items.first(where: { $0.owner == .card(c) }) else { return }
    flash(it.rect, tilt: it.tilt, radius: theme.cardRadius, id: c)
  }

  /// A rect of the board flashes as a card does (a card's block in a sub-board's map; `id`: the card it is in)
  func flash(_ r: CGRect, tilt: CGFloat, radius: CGFloat, id c: CardID) {
    let ring = CAShapeLayer()
    ring.frame = r.insetBy(dx: -20, dy: -20)
    if tilt != 0 { ring.setAffineTransform(CGAffineTransform(rotationAngle: tilt)) }
    let inner = CGRect(x: 20, y: 20, width: r.width, height: r.height)
    func band(_ s: CGFloat) -> CGPath {
      let p = CGMutablePath()
      let o = inner.insetBy(dx: -s, dy: -s)
      p.addRoundedRect(in: o, cornerWidth: radius + s, cornerHeight: radius + s)
      p.addRoundedRect(in: inner, cornerWidth: radius, cornerHeight: radius)
      return p
    }
    ring.fillRule = .evenOdd
    ring.path = band(14)
    ring.fillColor = theme.accent.copy(alpha: 0)
    ring.zPosition = 20
    let grow = CABasicAnimation(keyPath: "path")
    grow.fromValue = band(0)
    grow.toValue = band(14)
    let fade = CABasicAnimation(keyPath: "fillColor")
    fade.fromValue = theme.accent.copy(alpha: 0.45)
    fade.toValue = theme.accent.copy(alpha: 0)
    let g = CAAnimationGroup()
    g.animations = [grow, fade]
    g.duration = 0.7
    g.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak ring] in ring?.removeFromSuperlayer() }
    world.addSublayer(ring)
    ring.add(g, forKey: "ping")
    CATransaction.commit()
    flashed = c
    flashRing = (ring, band)
  }

  /// The flash held as it is `k` of the way through (the review sheets: a still picture of it)
  package func holdFlash(at k: CGFloat) {
    guard let (ring, band) = flashRing else { return }
    let e = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
    // the eased fraction: the curve's y at x = k, by bisection
    var lo: Float = 0
    var hi: Float = 1
    var p: [Float] = [0, 0]
    func point(_ i: Int, _ t: Float) -> Float {
      e.getControlPoint(at: 1, values: &p)
      let a = p[i]
      e.getControlPoint(at: 2, values: &p)
      let b = p[i]
      let u = 1 - t
      return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
    }
    for _ in 0..<30 {
      let m = (lo + hi) / 2
      if point(0, m) < Float(k) { lo = m } else { hi = m }
    }
    let y = CGFloat(point(1, lo))
    withoutAnimation {
      ring.removeAllAnimations()
      ring.path = band(14 * y)
      ring.fillColor = theme.accent.copy(alpha: 0.45 * (1 - y))
    }
  }

  // MARK: The preview

  func openRefPeek(key: String, at: RefAt, card c: CardID, on board: BoardID?) {
    guard let doc = document, let (vb, vault) = shown, let host = superview else { return }
    let peek = RefPeek(key: key, at: at, card: c, board: board, theme: theme)
    peek.onGo = { [weak self] in
      self?.closeRefPeek()
      self?.goToRef(board.map { .elsewhere($0, c) } ?? .card(c), writing: false)
    }
    peek.onDrag = { [weak self, weak peek] in
      guard let self, let peek, let host = peek.superview, let a = refPeekAnchor(peek.at) else { return }
      let o = convert(peek.frame, from: host).origin
      let m = RefPeek.margin
      peek.put = CGPoint(x: o.x + m - a.ref.x, y: o.y + m - a.ref.y)
    }
    refPeek = peek
    host.addSubview(peek, positioned: .above, relativeTo: popShown != nil ? sidenotePop.view : self)
    let theme = self.theme
    let notes = self.notes
    let images = self.images
    let here = doc.board
    let backing = self.backing
    let room = max(120, min(RefPeek.width, bounds.width - RefPeek.edge))
    Task {
      let picture = await Task.detached { () -> RefPeek.Picture? in
        var source = here
        var package = vault.url(of: vb.path)
        if let board {
          guard let other = ((try? vault.tree())?.allBoards ?? []).first(where: { $0.id == board }),
            let b = try? vault.board(at: other.path)
          else { return nil }
          source = b
          package = vault.url(of: other.path)
        }
        guard let card = source.card(c) else { return nil }
        return await CanvasView.peekPicture(
          card, board: source.id, package: package, vault: vault, theme: theme, notes: notes, images: images,
          room: room, backing: backing)
      }.value
      guard refPeek === peek else { return }
      guard let picture else { return closeRefPeek() }
      peek.show(picture)
      placeRefPeek()
    }
  }

  /// The card alone drawn as the board draws it, `room` points wide at most, cut at the preview's height
  nonisolated static func peekPicture(
    _ card: Card, board: BoardID, package: URL, vault: Vault, theme: Theme, notes: NoteRenderer, images: DecodeCache,
    room: CGFloat, backing: CGFloat
  ) async -> RefPeek.Picture? {
    var lone = card
    lone.section = nil
    let b = Board(id: board, cards: [lone])
    let measures = Scene.measures(b, package: package, vault: vault)
    let sizes = await CanvasView.measure(measures, theme: theme, notes: notes)
    let highlighter = await MainActor.run { CanvasView.highlighter } ?? Highlighter()
    let scene = Scene(b, package: package, vault: vault, theme: theme, highlighter: highlighter, sizes: sizes)
    guard let it = scene.items.first(where: { $0.owner == .card(card.id) }) else { return nil }
    let k = min(1, room / max(1, it.rect.width))
    let scale = k * backing
    let surface: IOSurface?
    if it.drawing.byRenderer {
      guard let snap = await CanvasView.picture(it, scale: scale, theme: theme, notes: notes, priority: 1) else {
        return nil
      }
      surface = CanvasView.compose(it, snap, scale: scale, theme: theme, images: images)
    } else {
      surface = CanvasView.render(it, scale: scale, theme: theme, images: images).surface
    }
    guard let surface else { return nil }
    return RefPeek.Picture(surface: surface, size: it.rect.size, bleed: it.bleed, k: k, header: theme.headerHeight)
  }

  /// Esc in a web view over the canvas: a preview open closes first
  func escapePeek() -> Bool {
    guard refPeek != nil else { return false }
    closeRefPeek()
    return true
  }

  public func closeRefPeek() {
    guard let peek = refPeek else { return }
    refPeek = nil
    peek.removeFromSuperview()
  }

  /// What the preview is beside (in this view's points): the card the ref is on, at the ref's height, or the popup;
  /// and the ref's top left, which a dragged preview keeps its place from
  func refPeekAnchor(_ at: RefAt) -> (beside: CGRect, ref: CGPoint)? {
    switch at {
    case .card(let c, let r):
      guard let card = scene?.items.first(where: { $0.owner == .card(c) })?.rect else { return nil }
      let a = camera.view(CGPoint(x: card.minX, y: r.minY))
      let b = camera.view(CGPoint(x: card.maxX, y: r.maxY))
      return (CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y), camera.view(r.origin))
    case .popup(let r):
      guard popShown != nil, sidenotePop.view.superview != nil else { return nil }
      let v = sidenotePop.view
      let box = v.convert(CGRect(origin: sidenotePop.origin, size: sidenotePop.size), to: self)
      return (box, v.convert(r, to: self).origin)
    }
  }

  /// The preview beside what its ref is on, on its right (right-start, 10 away), moved in to stay 8 inside the view;
  /// where it was dragged to, from its ref. Only its frame moves, as the camera moves
  func placeRefPeek() {
    guard let peek = refPeek, peek.ready, let host = peek.superview else { return }
    guard let a = refPeekAnchor(peek.at) else { return closeRefPeek() }
    let s = peek.boxSize
    var o: CGPoint
    if let put = peek.put {
      o = CGPoint(x: a.ref.x + put.x, y: a.ref.y + put.y)
    } else {
      o = CGPoint(x: a.beside.maxX + 10, y: a.beside.minY)
      o.x = min(max(8, o.x), bounds.width - s.width - 8)
      o.y = min(max(8, o.y), bounds.height - s.height - 8)
    }
    // the view has room for the box's shadow around it
    let m = RefPeek.margin
    let f = convert(CGRect(origin: o, size: s).insetBy(dx: -m, dy: -m), to: host)
    if peek.frame != f { peek.frame = f }
  }
}

/// A card's preview in place (cardpeek.tsx CardPeek): the beginning of the card as the board draws it, scaled to
/// `width` at most and cut at `height` with a fade, in a box with 12 of padding; its header drags it, the arrow under
/// it goes to the card. Drawn once; the camera only moves its frame
package final class RefPeek: NSView {
  /// PEEK_W, PEEK_H, PEEK_EDGE
  static let width: CGFloat = 520
  static let height: CGFloat = 280
  static let edge: CGFloat = 40
  static let pad: CGFloat = 12
  /// The arrow's button (.ib), 6 under the picture, 4 into the padding
  static let button: CGFloat = 26

  struct Picture: @unchecked Sendable {
    var surface: IOSurface
    var size: CGSize
    var bleed: CGFloat
    var k: CGFloat
    var header: CGFloat
  }

  let key: String
  let at: CanvasView.RefAt
  let card: CardID
  let board: BoardID?
  private let theme: Theme
  var onGo: (() -> Void)?
  var onDrag: (() -> Void)?
  /// Shown once its picture is drawn
  package private(set) var ready = false
  /// Dragged: its top left from its ref's top left, in the canvas's points
  var put: CGPoint?
  private var from: (pointer: CGPoint, origin: CGPoint)?
  private var gripHeight: CGFloat = 0
  private let box = CALayer()
  private let stage = CALayer()
  private let picture = CALayer()
  private let arrow = CAShapeLayer()
  package private(set) var cut = false

  init(key: String, at: CanvasView.RefAt, card: CardID, board: BoardID?, theme: Theme) {
    self.key = key
    self.at = at
    self.card = card
    self.board = board
    self.theme = theme
    super.init(frame: .zero)
    // layer-hosting, y-down like the canvas: AppKit leaves its layers alone
    let root = CALayer()
    root.isGeometryFlipped = true
    layer = root
    wantsLayer = true
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  package override var isFlipped: Bool { true }
  package override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  func show(_ p: Picture) {
    let t = theme
    let w = ceil(p.size.width * p.k)
    let h = ceil(min(p.size.height * p.k, Self.height))
    cut = p.size.height * p.k > Self.height + 1
    let pad = Self.pad
    let size = CGSize(width: w + 2 * pad, height: pad + h + 6 + Self.button - 4 + pad - 4)
    boxSize = size
    let m = Self.margin
    setFrameSize(CGSize(width: size.width + 2 * m, height: size.height + 2 * m))
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    guard let root = layer else { return }
    box.frame = CGRect(origin: CGPoint(x: m, y: m), size: size)
    box.cornerRadius = 14
    box.backgroundColor = t.canvas
    box.borderColor = t.hair
    box.borderWidth = 0.5
    box.shadowColor = CGColor(gray: 0, alpha: 1)
    box.shadowOpacity = t.dark ? 0.55 : 0.25
    box.shadowRadius = 18
    box.shadowOffset = CGSize(width: 0, height: 14)
    box.shadowPath = CGPath(
      roundedRect: box.bounds.insetBy(dx: 6, dy: 6), cornerWidth: 14, cornerHeight: 14, transform: nil)
    root.addSublayer(box)
    stage.frame = CGRect(x: pad, y: pad, width: w, height: h)
    stage.masksToBounds = true
    box.addSublayer(stage)
    let b = p.bleed * p.k
    picture.frame = CGRect(
      x: -b, y: -b, width: (p.size.width + 2 * p.bleed) * p.k, height: (p.size.height + 2 * p.bleed) * p.k)
    picture.contents = p.surface
    picture.contentsGravity = .resize
    stage.addSublayer(picture)
    if cut {
      // the last 48 fade out
      let m = CAGradientLayer()
      m.frame = stage.bounds
      m.colors = [CGColor(gray: 0, alpha: 1), CGColor(gray: 0, alpha: 1), CGColor(gray: 0, alpha: 0)]
      m.locations = [0, NSNumber(value: Double((h - 48) / h)), 1]
      stage.mask = m
    }
    // the arrow (arrowR, 14 in a 26 button) at the right under the picture
    let bx = size.width - pad + 4 - Self.button
    let by = pad + h + 6
    arrow.frame = CGRect(x: bx, y: by, width: Self.button, height: Self.button)
    let a = CGMutablePath()
    let u: CGFloat = 14 / 16
    let o = CGPoint(x: (Self.button - 14) / 2, y: (Self.button - 14) / 2)
    a.move(to: CGPoint(x: o.x + 3 * u, y: o.y + 8 * u))
    a.addLine(to: CGPoint(x: o.x + 13 * u, y: o.y + 8 * u))
    a.move(to: CGPoint(x: o.x + 9 * u, y: o.y + 4 * u))
    a.addLine(to: CGPoint(x: o.x + 13 * u, y: o.y + 8 * u))
    a.addLine(to: CGPoint(x: o.x + 9 * u, y: o.y + 12 * u))
    arrow.path = a
    arrow.fillColor = nil
    arrow.strokeColor = t.ink2
    arrow.lineWidth = 1.5
    arrow.lineCap = .round
    arrow.lineJoin = .round
    box.addSublayer(arrow)
    CATransaction.commit()
    gripHeight = min(Self.height, p.header * p.k) + pad
    ready = true
    isHidden = false
  }

  /// The box (the view has `margin` around it for its shadow)
  package private(set) var boxSize = CGSize.zero
  static let margin: CGFloat = 36

  /// The arrow's button, in the view's points
  package var goRect: CGRect { arrow.frame.offsetBy(dx: Self.margin, dy: Self.margin) }

  /// The pointer goes through the room around the box
  package override func hitTest(_ point: NSPoint) -> NSView? {
    guard let sv = superview else { return nil }
    let p = convert(point, from: sv)
    return CGRect(origin: CGPoint(x: Self.margin, y: Self.margin), size: boxSize).contains(p) ? self : nil
  }

  package override func mouseDown(with e: NSEvent) {
    let p = convert(e.locationInWindow, from: nil)
    if goRect.contains(p) { return onGo?() ?? () }
    guard p.y - Self.margin < gripHeight, let sv = superview else { return }
    from = (sv.convert(e.locationInWindow, from: nil), frame.origin)
    NSCursor.closedHand.push()
  }

  package override func mouseDragged(with e: NSEvent) {
    guard let f = from, let sv = superview else { return }
    let p = sv.convert(e.locationInWindow, from: nil)
    let o = CGPoint(x: f.origin.x + p.x - f.pointer.x, y: f.origin.y + p.y - f.pointer.y)
    setFrameOrigin(o)
    onDrag?()
  }

  package override func mouseUp(with e: NSEvent) {
    guard from != nil else { return }
    from = nil
    NSCursor.pop()
  }

  package override func resetCursorRects() {
    addCursorRect(
      CGRect(x: Self.margin, y: Self.margin, width: boxSize.width, height: gripHeight), cursor: .openHand)
  }
}

extension CanvasView {
  // MARK: Edit Mark… on a ref

  /// The other board a ref drawn here points at or into
  func refBoard(_ box: NoteRefBox) -> VaultBoard? {
    guard let doc = document, let (vb, vault) = shown else { return nil }
    let resolver = RefResolver(doc.board, package: vault.url(of: vb.path), vault: vault)
    let b: BoardID
    switch resolver.locate(box.ref, target: box.target) {
    case .board(let id)?, .elsewhere(let id, _)?: b = id
    default: return nil
    }
    return resolver.vaultTree()?.allBoards.first { $0.id == b && $0.id != vb.id }
  }

  /// The seal popover beside the ref, never over it
  func editSeal(_ b: VaultBoard, at r: (card: CardID, box: NoteRefBox)) {
    sealPopover?.close()
    let pop = NSPopover()
    pop.behavior = .transient
    let tree = shown.flatMap { try? $0.vault.tree() }
    pop.contentViewController = NSHostingController(
      rootView: SealEditor(
        id: b.id, name: b.title, seal: b.seal, clash: { t, c in tree?.sealClash(b.id, t, c)?.title },
        apply: { [weak self] seal, done in self?.onSetSeal?(b.id, seal, done) },
        dismiss: { [weak self, weak pop] in
          pop?.close()
          if self?.sealPopover === pop { self?.sealPopover = nil }
        }))
    sealPopover = pop
    let br = boardRect(r.box, on: r.card)
    let a = camera.view(br.origin)
    let z = camera.view(CGPoint(x: br.maxX, y: br.maxY))
    pop.show(relativeTo: CGRect(x: a.x, y: a.y, width: z.x - a.x, height: z.y - a.y), of: self, preferredEdge: .maxY)
  }
}

import AppKit
import CodeBoardModel
import QuartzCore

// Drawing an arrow out of a card, after the web board's cards/Card.tsx (.eport), cards/CodeBody.tsx (.lport) and
// interact.ts linkPortDown: the card under the pointer shows a port on each side (a Text none, a Box its four), a code
// card one at each end of the line under the pointer; dragging one draws an arrow to the card or line let go on, the side
// it left from kept. Let go on the canvas, nothing is made. The card aimed at grows a little and shows as selected, a line
// aimed at is tinted. The ends of the one arrow selected can be dragged to another card or line the same way (the web
// board has no such handles: asked for here).

/// A port a new arrow is drawn from: a card's side, or one end of a code line
struct Port: Equatable {
  var end: Endpoint
  var side: Endpoint.Side
  /// Its centre (board units)
  var at: CGPoint
  /// An arrow already meets the card there: not drawn until the pointer is on it, still taken (.eport.land)
  var landed = false
}

/// An arrow being drawn from a port, or one end of an arrow being moved
struct Connect {
  /// The end that stays
  var fixed: Endpoint
  /// Which end follows the pointer: .to for a new arrow
  var moving: Board.End
  /// The arrow whose end moves; nil: a new one
  var arrow: ArrowID?
  /// A new arrow's start side
  var side: Endpoint.Side?
  /// What it would join now
  var target: Endpoint?
  var pointer: CGPoint
}

/// How far below the zoom the web board's Simplify Below default hides the line ports
private let linePortsBelow: CGFloat = 0.5

extension CanvasView {
  // MARK: Ports

  /// The ports of a card: its sides (not a Text's), and a code card's line under the pointer at each end. A side an
  /// arrow already meets is marked (.eport.land)
  func ports(of id: CardID, line: Endpoint?) -> [Port] {
    guard let s = scene, let i = index(of: .card(id)) else { return [] }
    let r = s.items[i].rect
    var out: [Port] = []
    if !isText(id) || isBox(id) {
      let row = r.minY + theme.headerHeight / 2
      let sides: [(Endpoint.Side, CGPoint)] = [
        (.top, CGPoint(x: r.midX, y: r.minY)), (.right, CGPoint(x: r.maxX, y: row)),
        (.bottom, CGPoint(x: r.midX, y: r.maxY)), (.left, CGPoint(x: r.minX, y: row)),
      ]
      let landed = s.arrows.indices.flatMap { k -> [CGPoint] in
        guard let a = liveArrow(k) else { return [] }
        return (a.from == id ? [a.pts[0]] : []) + (a.to == id ? [a.pts[3]] : [])
      }
      for (side, at) in sides {
        let land = landed.contains { hypot($0.x - at.x, $0.y - at.y) < 2 }
        out.append(Port(end: Endpoint(card: id), side: side, at: at, landed: land))
      }
    }
    if let line, let y = lineMiddle(line), camera.zoom >= linePortsBelow {
      out.append(Port(end: line, side: .left, at: CGPoint(x: r.minX, y: y)))
      out.append(Port(end: line, side: .right, at: CGPoint(x: r.maxX, y: y)))
    }
    return out
  }

  /// The code line at a board point of a code card, with the rows it takes (a wrapped line's continuations with it)
  func codeLine(at p: CGPoint, of id: CardID) -> (end: Endpoint, rows: CGRect)? {
    guard let s = scene, let placed = s.placed[id], let c = placed.code, !placed.folded else { return nil }
    let top = placed.rect.minY + c.top
    var line: (segment: Int, number: Int, y: CGFloat)?
    var hit: (segment: Int, number: Int, y: CGFloat)?
    var bottom: CGFloat = 0
    for row in c.layout.rows {
      guard case .line(let si, let n, _, _) = row.row else {
        if hit != nil { break }
        line = nil
        continue
      }
      if let n {
        if hit != nil { break }
        line = (si, n, row.y)
      }
      if hit == nil, p.y >= top + row.y, p.y < top + row.y + row.height { hit = line }
      if hit != nil { bottom = row.y + row.height }
    }
    guard let hit, hit.segment < c.segments.count else { return nil }
    let r = placed.rect
    return (
      Endpoint(card: id, segment: c.segments[hit.segment], line: hit.number),
      CGRect(x: r.minX, y: top + hit.y, width: r.width, height: bottom - hit.y)
    )
  }

  /// A line end's middle (board units)
  func lineMiddle(_ e: Endpoint) -> CGFloat? {
    guard let s = scene, let placed = s.placed[e.card], let c = placed.code, let l = e.line,
      let si = e.segment.flatMap({ c.segments.firstIndex(of: $0) }), let y = c.layout.lineY(segment: si, line: l)
    else { return nil }
    return placed.rect.minY + c.top + y
  }

  /// A port's dot: 9 points across at full size and above, 9·√zoom points when zoomed out (hover.ts --uv); it takes the
  /// pointer within 9 view points across whatever the zoom
  var portRadius: CGFloat { 4.5 * sqrt(max(1, 1 / camera.zoom)) }
  var portReach: CGFloat { max(4.5, 4.5 / camera.zoom) }

  /// The port of the hovered card under a view point
  func hitPort(_ v: CGPoint) -> Port? {
    guard let id = hoveredCard, document?.board.card(id) != nil else { return nil }
    let p = camera.board(v)
    return ports(of: id, line: hoveredLine).first { hypot($0.at.x - p.x, $0.at.y - p.y) <= portReach }
  }

  /// The card under the pointer, the line under it and the port under it: shown, and the port in the accent
  func hoverPorts(at v: CGPoint) {
    let p = camera.board(v)
    var card = hitCard(p)
    // on a port just outside its card: still that card's
    if let id = hoveredCard, hitPort(v) != nil { card = id }
    let line = card.flatMap { codeLine(at: p, of: $0)?.end }
    guard card != hoveredCard || line != hoveredLine || hitPort(v) != hoveredPort else { return }
    hoveredCard = card
    hoveredLine = line
    hoveredPort = hitPort(v)
    drawChrome()
  }

  /// The hovered card's ports, over everything (z-index 4): the card's paper ringed in the line colour, in the accent under
  /// the pointer
  func drawPorts() {
    guard gesture == nil, inPlace == nil, editing == nil, let id = hoveredCard else { return }
    let rad = portRadius
    for port in ports(of: id, line: hoveredLine) where !port.landed || port == hoveredPort {
      let l = CAShapeLayer()
      l.path = CGPath(
        ellipseIn: CGRect(x: port.at.x - rad, y: port.at.y - rad, width: 2 * rad, height: 2 * rad), transform: nil)
      l.fillColor = port == hoveredPort ? theme.accent : theme.surface
      l.strokeColor = port == hoveredPort ? theme.accent : theme.arrow
      l.lineWidth = 1.5 * rad / 4.5
      chrome.addSublayer(l)
    }
  }

  // MARK: Ends of the selected arrow

  /// The one arrow selected: its two ends, which can be dragged to another card or line
  func endHandles() -> [(Board.End, CGPoint)] {
    guard let doc = document, doc.selection.count == 1, let id = doc.selection.first?.arrow, let i = arrowIndex(id),
      let a = liveArrow(i)
    else { return [] }
    return [(.from, a.pts[0]), (.to, a.pts[3])]
  }

  func hitEndHandle(_ v: CGPoint) -> Board.End? {
    let p = camera.board(v)
    let reach = 7 / camera.zoom
    return endHandles().first { hypot($0.1.x - p.x, $0.1.y - p.y) <= reach }?.0
  }

  func drawEndHandles() {
    guard gesture == nil || connecting == nil else { return }
    let rad = portRadius
    for (_, at) in endHandles() {
      let l = CAShapeLayer()
      l.path = CGPath(ellipseIn: CGRect(x: at.x - rad, y: at.y - rad, width: 2 * rad, height: 2 * rad), transform: nil)
      l.fillColor = theme.surface
      l.strokeColor = theme.accent
      l.lineWidth = 1.5 * rad / 4.5
      chrome.addSublayer(l)
    }
  }

  // MARK: Connecting

  var connecting: Connect? {
    if case .connect(let c)? = gesture?.kind { c } else { nil }
  }

  /// A drag from a port starts a new arrow from it
  func startConnect(from port: Port, at v: CGPoint) {
    gesture = Gesture(
      kind: .connect(Connect(fixed: port.end, moving: .to, side: port.side, pointer: camera.board(v))),
      startView: v, start: camera.board(v))
    hoveredPort = nil
  }

  /// A drag from an end of the selected arrow moves that end; the arrow's own line hides meanwhile
  func startMoveEnd(_ end: Board.End, of id: ArrowID, at p: CGPoint) -> Connect? {
    guard let a = document?.board.arrow(id), let i = arrowIndex(id) else { return nil }
    withoutAnimation {
      for l in arrowGroups[i] { l.isHidden = true }
      if let li = index(of: .arrowLabel(id)) { items[li].box.isHidden = true }
    }
    return Connect(fixed: end == .to ? a.from : a.to, moving: end, arrow: id, pointer: p)
  }

  /// What the pointer would join: the line or card under it (a Section is never an end); none on the canvas or on the
  /// fixed end's own place
  func connectTarget(_ c: Connect, at p: CGPoint) -> Endpoint? {
    guard let id = hitCard(p) else { return nil }
    let e = codeLine(at: p, of: id)?.end ?? Endpoint(card: id)
    // a card to itself only from one of its lines to another
    if id == c.fixed.card && (e.line == nil || c.fixed.line == nil || e.line == c.fixed.line) { return nil }
    return e
  }

  /// The pointer moved: the target, the card aimed at grown and the preview routed to it or to the pointer
  func dragConnect(_ c: inout Connect, to p: CGPoint) {
    c.pointer = p
    let t = connectTarget(c, at: p)
    if t?.card != c.target?.card { aim(t?.card, from: c.target?.card, at: p) }
    c.target = t
  }

  /// The card aimed at grows 3 % about where the pointer came in, with a little spring, and shows as selected
  /// (.card.aim); the one left shrinks back in 90 ms. Only its layer's transform and the look in it change
  func aim(_ id: CardID?, from old: CardID?, at p: CGPoint) {
    if let old, let i = index(of: .card(old)) {
      let t = scene!.items[i].tilt
      CATransaction.begin()
      CATransaction.setAnimationDuration(0.09)
      items[i].box.setAffineTransform(t == 0 ? .identity : CGAffineTransform(rotationAngle: t))
      CATransaction.commit()
      withoutAnimation {
        for l in items[i].box.sublayers ?? [] where l.name == "aim" { l.removeFromSuperlayer() }
      }
    }
    guard let id, let i = index(of: .card(id)) else { return }
    let b = items[i].box
    let f: CGFloat = 1.03
    let c = b.position
    let t = scene!.items[i].tilt
    let m = CGAffineTransform(translationX: (1 - f) * (c.x - p.x), y: (1 - f) * (c.y - p.y))
      .rotated(by: t).scaledBy(x: f, y: f)
    let look = CALayer()
    look.name = "aim"
    look.frame = b.bounds
    withoutAnimation {
      selectedLook(id, CGRect(origin: .zero, size: b.bounds.size), tilt: 0, into: look)
      b.addSublayer(look)
    }
    CATransaction.begin()
    CATransaction.setAnimationDuration(0.12)
    CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.3, 1.35, 0.5, 1))
    b.setAffineTransform(m)
    CATransaction.commit()
  }

  /// The arrow as it would be: routed as the board routes it, to the target or to the pointer, drawn in the accent; the
  /// line aimed at tinted (.src .l.drop), the card aimed at ringed as selected
  func drawConnect() {
    guard let c = connecting, let s = scene else { return }
    let virtual = CardID(rawValue: "·pointer")
    var model =
      c.arrow.flatMap { document?.board.arrow($0) }
      ?? Arrow(id: ArrowID(rawValue: "·new"), from: c.fixed, to: c.fixed)
    let moving =
      c.target ?? Endpoint(card: virtual, segment: SegmentID(rawValue: "·"), line: 0)
    if c.moving == .to {
      model.from = c.fixed
      if c.arrow == nil { model.from.side = c.side }
      model.to = moving
      model.to.side = nil
    } else {
      model.from = moving
      model.from.side = nil
      model.to = c.fixed
    }
    model.label = nil
    let at = CGRect(
      x: c.pointer.x, y: c.pointer.y - theme.headerHeight / 2, width: 0, height: theme.headerHeight)
    func placed(_ e: Endpoint) -> Scene.Placed? {
      e.card == virtual ? Scene.Placed(rect: at, code: nil, tilt: 0) : s.placed[e.card]
    }
    if let target = c.target {
      if let row = target.line != nil ? codeLine(at: c.pointer, of: target.card)?.rows : nil {
        let tint = CALayer()
        tint.frame = row
        tint.backgroundColor = theme.accent.copy(alpha: 0.16)
        let bar = CALayer()
        bar.frame = CGRect(x: 0, y: 0, width: 2, height: row.height)
        bar.backgroundColor = theme.accent
        tint.addSublayer(bar)
        chrome.addSublayer(tint)
      }
    }
    guard let from = placed(model.from), let to = placed(model.to) else { return }
    let (arrow, _) = Scene.route(model, from: from, to: to, theme: theme)
    accentArrow(arrow)
  }

  /// Let go: on a card or line, the arrow is drawn there (or its end moved there) as one step and the card is selected;
  /// on the canvas nothing changes
  func commitConnect(_ c: Connect) {
    gesture = nil
    aim(nil, from: c.target?.card, at: c.pointer)
    if let id = c.arrow, let i = arrowIndex(id) {
      withoutAnimation {
        for l in arrowGroups[i] { l.isHidden = false }
        if let li = index(of: .arrowLabel(id)) { items[li].box.isHidden = false }
      }
    }
    defer { drawChrome() }
    guard let doc = document, let t = c.target else { return }
    if let id = c.arrow {
      var b = doc.board
      guard b.retarget(id, c.moving, to: t) else { return }
      doc.edit("Move Arrow End", selection: [.arrow(id)]) { $0 = b }
    } else {
      var b = doc.board
      guard b.addArrow(ArrowID(rawValue: Board.newID("l")), from: c.fixed, to: t, side: c.side) else { return }
      doc.edit("Arrow", selection: [.card(t.card)]) { $0 = b }
    }
  }
}

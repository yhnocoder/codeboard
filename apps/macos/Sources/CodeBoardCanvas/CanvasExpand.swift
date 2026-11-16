import AppKit
import CodeBoardModel

// A call on a code card clicked or dragged out (the board's actions/flow.ts expandCall, placeExpanded,
// followExpanded and attachCall; interact.ts callPointerDown): the shell says what it expands into, its card is
// placed beside the card it is called from (core layout.ts placeChild) with an arrow from the call's line, selected
// and brought into view with that line; clicked again, the card it expanded into is shown. Dragged onto another code
// card, the line is linked to it; let go on the board, the card goes there. The arrows are plain ones from the line:
// what the call passes and crossed (its Call mark) is not in the format yet.

/// The gaps core layout.ts keeps between a card and the ones expanded from it
enum CallPlace {
  /// Between a card and the column to its right (room for the arrows)
  static let colGap: CGFloat = 96
  static let sibGap: CGFloat = 24
  /// A card put under the one it is called from is indented this much
  static let indent: CGFloat = 56
  static let gap: CGFloat = 28
  /// The camera's flights to a new call keep code this readable: no further out than this
  static let readableZoom: CGFloat = 0.6

  /// Closer than `gap` (layout.ts overlaps)
  static func overlaps(_ a: CGRect, _ b: CGRect, _ gap: CGFloat) -> Bool {
    a.minX < b.maxX + gap && b.minX < a.maxX + gap && a.minY < b.maxY + gap && b.minY < a.maxY + gap
  }

  /// Where a card expanded from `parent` goes (placeChild): `side`, in the column to its right, its top at `top` (the
  /// call's line); else indented under it; below `before` (the cards of the calls before it, and theirs), then down
  /// past `others`, or near there when that is far down
  static func child(
    _ parent: CGRect, _ size: CGSize, before: [CGRect], others: [CGRect], side: Bool, top: CGFloat
  ) -> CGPoint {
    let x = side ? parent.maxX + colGap : parent.minX + indent
    var y = side ? max(parent.minY, top) : parent.maxY + gap
    for s in before { y = max(y, s.maxY + sibGap) }
    let want = CGRect(x: x, y: y, width: size.width, height: size.height)
    let down = freeDown(want, others)
    if down.y - y <= max(400, size.height) { return down }
    return CanvasView.findFree(want, others: others + [parent])
  }

  /// Down from `want` past whatever it meets (findFreeDown)
  static func freeDown(_ want: CGRect, _ others: [CGRect]) -> CGPoint {
    var y = want.minY
    for _ in 0..<400 {
      let r = CGRect(x: want.minX, y: y, width: want.width, height: want.height)
      let hit = others.filter { overlaps(r, $0, sibGap / 2) }
      guard let bottom = hit.map(\.maxY).max() else { return CGPoint(x: want.minX, y: y) }
      y = bottom + sibGap
    }
    return CGPoint(x: want.minX, y: y)
  }

  /// A code card's function is the one called: its name's last part, or a class's for its __init__ (core callName)
  static func callee(_ c: Card, _ name: String) -> Bool {
    guard case .own(let k) = c.content, case .code(let code) = k.body else { return false }
    return code.segments.contains { s in
      guard let q = s.symbol?.name else { return false }
      let parts = q.split(separator: ".").map(String.init)
      let last = parts.last ?? q
      return last == name || (last == "__init__" && parts.count > 1 && parts[parts.count - 2] == name)
    }
  }
}

extension CanvasView {
  /// The card a call already expanded into: one an arrow from its line goes to whose function it calls
  // ponytail: by the callee's name, as there are no Call marks on arrows yet; by the mark's name and column then
  func expandedTo(_ c: CallAt) -> CardID? {
    guard let b = document?.board else { return nil }
    for a in b.arrows
    where a.from.card == c.card && a.from.segment == c.segment.id && a.from.line == c.call.line && !a.to.lost {
      if let t = b.card(a.to.card), CallPlace.callee(t, c.call.name) { return t.id }
    }
    return nil
  }

  /// A call clicked: what it expands into, from the shell; `drop`: let go there on the board; `pick`: one picked of an
  /// earlier answer; `again`: a new card even when it was expanded before
  func expandCall(_ c: CallAt, drop: CGPoint? = nil, pick: CallChoice? = nil, again: Bool = false) {
    guard let host = callHost, let doc = document else { return }
    if !again, drop == nil, pick == nil, let had = expandedTo(c) { return goToRef(.card(had), writing: false) }
    let key = "\(c.card.rawValue):\(c.segment.id.rawValue):\(c.call.line):\(c.call.col)"
    guard callsAsked.insert(key).inserted else { return }
    let at = viewRect(c.rect)
    Task { [weak self] in
      guard let self else { return }
      let a = await host.expand(c.segment, call: c.call, pick: pick, at: at, on: self)
      callsAsked.remove(key)
      // the board switched, or the card is gone, meanwhile
      guard document === doc, doc.board.card(c.card) != nil else { return }
      switch a {
      case .card(let s, let title): placeCall(c, s, title: title, drop: drop)
      case .pick(let ps):
        pickCall(c, ps, "\(c.call.name)() · \(ps.count) definitions", at: at, drop: drop, again: again)
      case .impls(let ps, _):
        pickCall(c, ps, "\(c.call.name)() · \(ps.count) implementations", at: at, drop: drop, again: again)
      case .none(let why, _): toast(why)
      case .said: break
      }
    }
  }

  /// The choices of an answer, under the call: the one picked expanded
  func pickCall(_ c: CallAt, _ ps: [CallChoice], _ title: String, at: CGRect, drop: CGPoint?, again: Bool) {
    let m = NSMenu()
    m.autoenablesItems = false
    let head = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    head.isEnabled = false
    m.addItem(head)
    for p in ps {
      let i = menuItem(p.detail.isEmpty ? p.label : "\(p.label)  \(p.detail)") { [weak self] in
        self?.expandCall(c, drop: drop, pick: p, again: again)
      }
      m.addItem(i)
    }
    showMenu(m, CGPoint(x: at.minX, y: at.maxY + 4))
  }

  /// The definition's card placed (placeExpanded): where the call was let go, else beside or under the card it is
  /// called from; the cards of that call graph below it moved down when it lands on them. One step with the arrow from
  /// the call's line, in the calling card's Section; selected, and the camera brings the line and it into view
  func placeCall(_ c: CallAt, _ s: Segment, title: String?, drop: CGPoint?) {
    guard let doc = document, let host = liveRect(.card(c.card)) else { return }
    let b = doc.board
    let size = CGSize(width: Self.codeWidth(s), height: 52 + Double(s.lines.count) * 19)
    let rect = { (id: CardID) in self.liveRect(.card(id)) }
    var at: CGPoint
    var pushed: [CardID] = []
    if let drop {
      at = CGPoint(x: drop.x.rounded(), y: drop.y.rounded())
    } else {
      // the line arrows of the call graph: a card's callees, and who calls it
      let lineArrows = b.arrows.filter { $0.from.line != nil && !$0.to.lost }
      func below(_ id: CardID) -> Set<CardID> {
        var seen: Set<CardID> = []
        var todo = [id]
        while let x = todo.popLast() {
          for a in lineArrows where a.from.card == x && seen.insert(a.to.card).inserted { todo.append(a.to.card) }
        }
        return seen
      }
      // the cards of the calls on lines before it (on its own segment), and the cards they call: it goes under them
      var beforeIds: Set<CardID> = []
      for a in lineArrows where a.from.card == c.card {
        if a.from.segment == c.segment.id, let l = a.from.line, l > c.call.line { continue }
        beforeIds.formUnion([a.to.card])
        beforeIds.formUnion(below(a.to.card))
      }
      beforeIds.remove(c.card)
      let before = beforeIds.compactMap(rect)
      // who calls it, up the graph: they stay; the rest of the graph below its line makes room
      var chain: Set<CardID> = [c.card]
      var up = [c.card]
      while let x = up.popLast() {
        for a in lineArrows where a.to.card == x && chain.insert(a.from.card).inserted { up.append(a.from.card) }
      }
      var tree: Set<CardID> = [c.card]
      var todo = [c.card]
      while let x = todo.popLast() {
        for a in lineArrows where a.from.card == x || a.to.card == x {
          for y in [a.from.card, a.to.card] where tree.insert(y).inserted { todo.append(y) }
        }
      }
      let side = host.width + CallPlace.colGap + size.width <= safeWidth(at: CallPlace.readableZoom)
      let top = side ? c.rect.midY - 18 : host.maxY
      let cards = b.cards.filter { $0.id != c.card }
      let fixed = cards.filter { !tree.contains($0.id) || (!chain.contains($0.id) && $0.y < top) }.compactMap {
        rect($0.id)
      }
      at = CallPlace.child(host, size, before: before, others: fixed, side: side, top: top)
      at = CGPoint(x: at.x.rounded(), y: at.y.rounded())
      let want = CGRect(origin: at, size: size)
      let under = cards.filter {
        tree.contains($0.id) && !chain.contains($0.id) && !beforeIds.contains($0.id) && $0.y >= top - 1
      }
      let hit = under.contains {
        guard let r = rect($0.id) else { return false }
        return r.minX < want.maxX && want.minX < r.maxX && r.minY < want.maxY + CallPlace.sibGap
      }
      if hit { pushed = under.map(\.id) }
    }
    let id = CardID(rawValue: Board.newID("card-"))
    let card = Card(
      id: id, x: at.x, y: at.y, width: size.width,
      content: .own(CardContent(title: title, body: .code(CodeCard(segments: [s])))))
    let section = b.card(c.card)?.section
    let from = Endpoint(card: c.card, segment: c.segment.id, line: c.call.line)
    let dy = (size.height + CallPlace.sibGap).rounded()
    settle(id, size, "Expand Call", keepSection: section != nil) { b in
      for p in pushed { if let i = b.cards.firstIndex(where: { $0.id == p }) { b.cards[i].y += dy } }
      var n = card
      n.section = section
      b.cards.append(n)
      _ = b.addArrow(ArrowID(rawValue: Board.newID("l")), from: from, to: Endpoint(card: id))
    }
    followCall(c, CGRect(origin: at, size: size))
  }

  /// The view's width without the room kept free, on the board at zoom `z` (camera.ts usableW)
  func safeWidth(at z: CGFloat) -> CGFloat { (bounds.width - Self.safe.l - Self.safe.r) / z }

  /// After an expand the camera follows (followExpanded): the call's line and the new card in view, zoomed out to fit
  /// but no further than code stays readable; still too big, the card's top with the call's name, else the card alone
  /// with as much to its left as fits
  func followCall(_ c: CallAt, _ r: CGRect) {
    guard let p = liveRect(.card(c.card)) else { return }
    let from = CGRect(x: p.minX, y: c.rect.midY - 14, width: p.width, height: 28)
    let v = safeView
    if v.contains(from) && v.contains(r) { return }
    let z = camera.zoom
    let floor = min(z, CallPlace.readableZoom)
    let s = Self.safe
    let usableH = (bounds.height - s.t - s.b) / floor
    let body = CGRect(x: r.minX, y: r.minY, width: r.width, height: min(r.height, usableH))
    let name = CGRect(x: c.rect.minX - 24, y: from.minY, width: c.rect.width + 48, height: from.height)
    var f = fitRect(from.union(r), maxZoom: z)
    for t in [from.union(body), name.union(body)] where f.zoom < floor { f = fitRect(t, maxZoom: z) }
    if f.zoom < floor {
      let w = safeWidth(at: floor)
      let left = r.width >= w ? r.minX : max(min(name.minX, r.minX), r.maxX - w)
      let t = CGRect(x: left, y: body.minY, width: min(r.maxX - left, w), height: body.height)
      f = fitRect(t, maxZoom: z)
      if f.zoom < floor { f = centred(t, at: floor) }
    }
    motion.fly(to: f)
    moved()
  }

  /// `r` in the middle of the view at zoom `z` (camera.ts fitRect at its least zoom)
  private func centred(_ r: CGRect, at z: CGFloat) -> Camera {
    let s = Self.safe
    let w = bounds.width - s.l - s.r
    let h = bounds.height - s.t - s.b
    let x = s.l + (w - r.width * z) / 2 - r.minX * z
    let y = s.t + (h - r.height * z) / 2 - r.minY * z
    return Camera(origin: CGPoint(x: -x / z, y: -y / z), zoom: z)
  }

  /// A call dragged out and let go (callPointerDown's end): on another code card, its line linked to it; anywhere
  /// else (its own card too), expanded there
  func dropCall(_ c: CallAt, on target: CardID?, at p: CGPoint) {
    guard let doc = document else { return }
    guard let t = target, t != c.card else { return expandCall(c, drop: CGPoint(x: p.x + 8, y: p.y - 18)) }
    let b = doc.board
    guard let card = b.card(t), case .own(let k) = card.content, case .code = k.body else {
      return toast("Only code cards can be the target of a call.")
    }
    let title = cardTitle(k)
    let from = Endpoint(card: c.card, segment: c.segment.id, line: c.call.line)
    if b.arrows.contains(where: { $0.from == from && $0.to.card == t }) {
      flash(t)
      return toast("Already linked to \(title)")
    }
    var nb = b
    guard nb.addArrow(ArrowID(rawValue: Board.newID("l")), from: from, to: Endpoint(card: t)) else { return }
    doc.edit("Link Call", selection: [.card(t)]) { $0 = nb }
    toast("Linked to \(title)")
    flash(t)
  }

  /// The call under the pointer tinted in the function colour at 12 %, rounded 4 (styles.css .call:hover): a layer over
  /// the card, whose picture is not drawn again. Whether there is one
  func hoverCall(at p: CGPoint) -> Bool {
    let c = gesture == nil ? callAt(p) : nil
    withoutAnimation {
      if callTint.superlayer !== world {
        callTint.cornerRadius = 4
        callTint.zPosition = 3
        world.addSublayer(callTint)
      }
      callTint.isHidden = c == nil
      guard let c else { return }
      let fn = theme.syntax[.function] ?? theme.ink
      callTint.backgroundColor = fn.copy(alpha: fn.alpha * 0.12)
      callTint.frame = c.rect.insetBy(dx: 0, dy: 1)
    }
    return c != nil
  }
}

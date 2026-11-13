import AppKit
import CodeBoardModel
import QuartzCore

// Arrows on the canvas, after the web board's canvas/Links.tsx, canvas/Labels.tsx and actions/menus.ts linkMenu and
// labelMenu: an arrow is found by its line (12 view points wide, .lhit) or its label, selected (⇧ adds) and drawn in the
// accent while selected or under the pointer; its label is written in place (double-click, Return, the menu), dragged
// along the line, reset and deleted; its look, its ends' sides and Delete are in its context menu.

/// A label dragged along its arrow: only along the line, its box clear of the cards at the ends (Labels.tsx labelDrag)
struct LabelDrag {
  var id: ArrowID
  /// The label's scene item
  var item: Int
  /// The curve [start, c1, c2, end] it rides on, its box and the end cards, measured once at the start
  var pts: [CGPoint]
  var box: CGSize
  var ends: [CGRect]
  /// The pointer's offset from the label's centre at the press
  var grab: CGVector
  /// Where along the line it is (0…1); nil until it moved
  var t: CGFloat?
}

/// An arrow's label or a Section's title being written in place
struct InPlace {
  enum What: Equatable {
    case label(ArrowID)
    case title(SectionID)
  }

  var what: What
  var field: NSTextField
  /// What it said before
  var before: String
  /// Where it is on the board: a label's centre, a title's top left
  var at: CGPoint
}

/// A menu item's action as a closure (an item keeps it as its represented object)
final class MenuAction: NSObject {
  let run: () -> Void
  init(_ run: @escaping () -> Void) { self.run = run }
  @objc func fire(_ sender: Any?) { run() }
}

/// The label field's cell: its text in the middle of its height, as the label box has it
final class MiddleCell: NSTextFieldCell {
  override func drawingRect(forBounds r: NSRect) -> NSRect {
    let d = super.drawingRect(forBounds: r)
    let h = cellSize(forBounds: r).height
    return NSRect(x: d.minX, y: d.minY + max(0, (d.height - h) / 2), width: d.width, height: min(d.height, h))
  }
}

extension CanvasView {
  // MARK: Finding

  /// An arrow as drawn now (re-routed while its cards move)
  func liveArrow(_ i: Int) -> Scene.Arrow? {
    routedArrows[i] ?? scene.flatMap { i < $0.arrows.count ? $0.arrows[i] : nil }
  }

  func arrowIndex(_ id: ArrowID) -> Int? { scene?.arrows.firstIndex { $0.id == id } }

  /// Where an arrow is drawn: its start, the middle of its line and its end (LookCompare)
  package func arrowPoints(_ id: ArrowID) -> (start: CGPoint, mid: CGPoint, end: CGPoint)? {
    guard let i = arrowIndex(id), let a = liveArrow(i) else { return nil }
    return (a.pts[0], a.mid, a.pts[3])
  }

  /// A code line's middle on the board (LookCompare)
  package func lineCentre(_ e: Endpoint) -> CGFloat? { lineMiddle(e) }

  /// The arrow whose label is at a board point (labels are over the cards)
  func hitArrowLabel(_ p: CGPoint) -> ArrowID? {
    guard let s = scene else { return nil }
    for i in (s.labelsFrom..<s.items.count).reversed() {
      if case .arrowLabel(let id)? = s.items[i].owner, !items[i].box.isHidden, items[i].box.frame.contains(p) {
        return id
      }
    }
    return nil
  }

  /// The topmost arrow whose line passes within 6 view points of a board point (the 12 point .lhit stroke)
  func hitArrow(_ p: CGPoint) -> ArrowID? {
    guard let s = scene else { return nil }
    let reach = 6 / camera.zoom
    for i in s.arrows.indices.reversed() {
      guard let line = liveArrow(i)?.line.cg,
        line.boundingBoxOfPath.insetBy(dx: -reach, dy: -reach).contains(p),
        line.copy(strokingWithWidth: 2 * reach, lineCap: .round, lineJoin: .round, miterLimit: 10).contains(p)
      else { continue }
      return s.arrows[i].id
    }
    return nil
  }

  /// The arrow a press at a board point takes: its label, else its line where no card is over it
  func arrowAt(_ p: CGPoint) -> ArrowID? {
    hitArrowLabel(p) ?? (hitCard(p) == nil ? hitArrow(p) : nil)
  }

  // MARK: Looks

  /// A selected or hovered arrow (.edge.on, .taper.on, .brush.on): the line and its heads in the accent, a solid line's
  /// outline stroked 0.45 wider, a dashed one 0.45 wider; its start dot (.port) on it, and its label's box ringed
  func arrowChrome(_ i: Int, labelRing: Bool) {
    guard let a = liveArrow(i) else { return }
    accentArrow(a, into: litArrows)
    // the label's box: a 1.5 ring of the accent (.vchips.on .vcard)
    guard labelRing, theme.label == .box, let li = index(of: .arrowLabel(a.id)), !items[li].box.isHidden else { return }
    let r = items[li].box.frame
    let ring = CAShapeLayer()
    ring.path = Drawing.squircle(r.insetBy(dx: -0.75, dy: -0.75), theme.labelRadius + 0.75)
    ring.fillColor = nil
    ring.strokeColor = theme.accent
    ring.lineWidth = 1.5
    chrome.addSublayer(ring)
  }

  /// An arrow's line and heads in the accent, its start dot on it
  func accentArrow(_ a: Scene.Arrow, into parent: CALayer? = nil) {
    let chrome = parent ?? self.chrome
    let accent = theme.accent
    if !a.fill.isEmpty {
      let l = CAShapeLayer()
      l.path = a.fill.cg
      l.fillColor = accent
      l.strokeColor = accent
      l.lineWidth = 0.45
      l.lineJoin = .round
      chrome.addSublayer(l)
    }
    if let p = a.stroke {
      let l = CAShapeLayer()
      l.path = p.cg
      l.fillColor = nil
      l.strokeColor = accent
      l.lineWidth = a.width + 0.45
      l.lineCap = .round
      l.lineDashPattern = [4, 4]
      chrome.addSublayer(l)
    }
    if let p = a.dry {
      let l = CAShapeLayer()
      l.path = p.cg
      l.fillColor = nil
      l.strokeColor = theme.dryBrush
      l.lineWidth = 0.6
      l.lineCap = .round
      chrome.addSublayer(l)
    }
    if !a.heads.isEmpty {
      let l = CAShapeLayer()
      l.path = a.heads.cg
      l.fillColor = accent
      l.strokeColor = accent
      l.lineWidth = a.headStroke + 0.45
      l.lineJoin = .round
      chrome.addSublayer(l)
    }
    // the start dot: r 3, the card's paper ringed in the line's colour (.port)
    let o = a.pts[0]
    let dot = CAShapeLayer()
    dot.path = CGPath(ellipseIn: CGRect(x: o.x - 3, y: o.y - 3, width: 6, height: 6), transform: nil)
    dot.fillColor = theme.surface
    dot.strokeColor = a.color
    dot.lineWidth = theme.arrowWidth
    chrome.addSublayer(dot)
  }

  /// The arrows to draw in the accent: the selected ones and the one under the pointer
  func drawArrowChrome() {
    guard let doc = document, let s = scene else { return }
    var on = Set(doc.selection.compactMap(\.arrow))
    if let h = hoveredArrow { on.insert(h) }
    // the one whose end is being moved is drawn where the end goes
    if let id = connecting?.arrow { on.remove(id) }
    for (i, a) in s.arrows.enumerated() where on.contains(a.id) {
      arrowChrome(i, labelRing: doc.selection.contains(.arrow(a.id)))
    }
  }

  /// The arrow under the pointer changed
  func hover(_ id: ArrowID?) {
    guard id != hoveredArrow else { return }
    hoveredArrow = id
    drawChrome()
  }

  // MARK: Writing in place

  /// Writes the arrow's label in place, where its label is (the middle of its line when it has none): Return and a click
  /// elsewhere keep it, Esc leaves it as it was, blank removes it (Labels.tsx, Editable.tsx)
  func editLabel(_ id: ArrowID) {
    guard let doc = document, let i = arrowIndex(id), let a = liveArrow(i), let arrow = doc.board.arrow(id) else {
      return
    }
    let centre = index(of: .arrowLabel(id)).map { items[$0].box.position } ?? a.mid
    writeInPlace(.label(id), arrow.label ?? "", at: centre, select: .arrow(id))
  }

  /// Writes a Section's title where it is, all of it selected; blank is "Untitled Section" (Sections.tsx, its .slabel)
  func editTitle(_ id: SectionID) {
    guard let doc = document, let s = doc.board.section(id), let f = scene?.frames.first(where: { $0.id == id }) else {
      return
    }
    let at = s.collapsed ? theme.foldedTitleAt : theme.sectionTitleAt
    writeInPlace(.title(id), s.title, at: CGPoint(x: f.rect.minX + at.x, y: f.rect.minY + at.y), select: .section(id))
  }

  /// The item a field stands in for
  func inPlaceItem(_ w: InPlace.What) -> Int? {
    switch w {
    case .label(let id): index(of: .arrowLabel(id))
    case .title(let id): index(of: .sectionTitle(id))
    }
  }

  private func writeInPlace(_ what: InPlace.What, _ text: String, at: CGPoint, select item: Item) {
    guard let doc = document, let host = superview else { return }
    endInPlace(commit: true)
    if doc.selection != [item] { doc.select([item]) }
    let label = { if case .label = what { true } else { false } }()
    let field = NSTextField(string: text)
    field.cell = MiddleCell(textCell: text)
    field.isEditable = true
    field.isSelectable = true
    field.isBordered = false
    field.isBezeled = false
    field.drawsBackground = false
    field.focusRingType = .none
    field.alignment = label ? .center : .left
    field.usesSingleLineMode = true
    field.cell?.isScrollable = true
    field.placeholderString = label ? "Label" : Board.untitledSection
    field.textColor = NSColor(cgColor: label ? (theme.label == .box ? theme.ink : theme.ink2) : theme.sectionTitle)
    field.wantsLayer = true
    field.delegate = self
    inPlace = InPlace(what: what, field: field, before: text, at: at)
    withoutAnimation {
      if let i = inPlaceItem(what) { items[i].box.isHidden = true }
      placeField()
    }
    host.addSubview(field, positioned: .above, relativeTo: self)
    window?.makeFirstResponder(field)
    field.currentEditor()?.selectAll(nil)
    drawChrome()
  }

  /// The field where its text is drawn, as wide as its text, at the zoom shown: a label's box (60 at least, .vlabel), a
  /// title's line
  func placeField() {
    guard let ip = inPlace, let host = superview else { return }
    let z = camera.zoom
    let label = { if case .label = ip.what { true } else { false } }()
    let font = label ? theme.arrowLabel : theme.sectionTitleFont
    ip.field.font = CTFontCreateCopyWithAttributes(font.ct, CTFontGetSize(font.ct) * z, nil, nil) as NSFont
    let text = ip.field.stringValue.isEmpty ? (ip.field.placeholderString ?? "") : ip.field.stringValue
    let v = camera.view(ip.at)
    let r: CGRect
    if label {
      let pad: CGFloat = theme.label == .box ? 13 : 33
      let w = max(60, Drawing.width(text, font) + pad + 4) * z
      let h = 22 * z
      r = CGRect(x: v.x - w / 2, y: v.y - h / 2, width: w, height: h)
    } else {
      // a tray's label has 6 before its text
      let x: CGFloat = theme.frame == .tray ? 6 : 0
      r = CGRect(
        x: v.x, y: v.y, width: (max(80, Drawing.width(text, font) + 2 * x + 12)) * z,
        height: theme.sectionTitleHeight * z)
    }
    ip.field.frame = convert(r, to: host)
    let l = ip.field.layer
    let boxed = !label || theme.label == .box
    l?.backgroundColor = boxed ? theme.surface : theme.canvas
    l?.cornerRadius = (label ? theme.labelRadius : min(theme.sectionRadius, 6)) * z
    l?.borderColor = boxed ? theme.accent : nil
    l?.borderWidth = boxed ? 1.5 * z : 0
  }

  /// Leaves what is being written: kept (`commit`) or as it was. A changed one's field stays until the board drawn with
  /// it is on screen, so nothing is blank for a frame
  func endInPlace(commit: Bool) {
    guard let ip = inPlace else { return }
    inPlace = nil
    ip.field.delegate = nil
    let text = ip.field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if window?.firstResponder === ip.field.currentEditor() || window?.firstResponder === ip.field {
      window?.makeFirstResponder(self)
    }
    ip.field.isEditable = false
    var change: ((inout Board) -> Void)?
    var name = ""
    if commit, let doc = document, text != ip.before {
      switch ip.what {
      case .label(let id) where doc.board.arrow(id) != nil:
        name = text.isEmpty ? "Delete Label" : "Label"
        change = { $0.setArrowLabel(id, text) }
      case .title(let id) where doc.board.section(id) != nil && !(text.isEmpty && ip.before == Board.untitledSection):
        name = "Rename Section"
        change = { $0.renameSection(id, text) }
      default: break
      }
    }
    guard let change, let doc = document else {
      ip.field.removeFromSuperview()
      if let i = inPlaceItem(ip.what) { withoutAnimation { items[i].box.isHidden = false } }
      drawChrome()
      return
    }
    closingField?.removeFromSuperview()
    closingField = ip.field
    doc.edit(name, change)
  }

  /// The board drawn with what was written is on screen: its field goes
  func fieldShown() {
    closingField?.removeFromSuperview()
    closingField = nil
  }

  // MARK: Dragging a label

  /// A press on an arrow's label moved: the label follows along the line
  func startLabelDrag(_ id: ArrowID, at p: CGPoint) -> LabelDrag? {
    guard let s = scene, let i = arrowIndex(id), let a = liveArrow(i), let li = index(of: .arrowLabel(id)) else {
      return nil
    }
    let m = s.arrowModels[i]
    let ends = [m.from.card, m.to.card].compactMap { s.placed[$0]?.rect }
    let c = items[li].box.position
    return LabelDrag(
      id: id, item: li, pts: a.pts, box: s.items[li].rect.size, ends: ends,
      grab: CGVector(dx: p.x - c.x, dy: p.y - c.y))
  }

  /// The place on the line nearest the pointer (less the grab) where the box keeps clear of the end cards, sampled at
  /// 0.01 (geom.ts nearestT, labelpos.ts dragT); the middle when none is clear
  static func dragT(_ d: LabelDrag, _ p: CGPoint) -> CGFloat {
    let x = p.x - d.grab.dx
    let y = p.y - d.grab.dy
    var best: CGFloat = 0.5
    var bd = CGFloat.infinity
    for i in 0...100 {
      let t = CGFloat(i) / 100
      let q = ArrowRoute.bezAt(d.pts, t)
      guard ArrowRoute.boxClear(q, d.box, d.ends) else { continue }
      let dd = (q.x - x) * (q.x - x) + (q.y - y) * (q.y - y)
      if dd < bd {
        bd = dd
        best = t
      }
    }
    return best
  }

  func showLabelDrag(_ d: LabelDrag) {
    guard let t = d.t else { return }
    let q = ArrowRoute.bezAt(d.pts, t)
    withoutAnimation { items[d.item].box.position = q }
    drawChrome()
  }

  func commitLabelDrag(_ d: LabelDrag) {
    gesture = nil
    guard let t = d.t, let doc = document else { return }
    let at = Double((t * 100).rounded() / 100)
    guard doc.board.arrow(d.id)?.labelPosition != at else { return }
    doc.edit("Move Label") { $0.setLabelPosition(d.id, at) }
  }

  // MARK: Menus

  func menuItem(_ title: String, checked: Bool = false, enabled: Bool = true, _ run: @escaping () -> Void)
    -> NSMenuItem
  {
    let a = MenuAction(run)
    let i = NSMenuItem(title: title, action: enabled ? #selector(MenuAction.fire(_:)) : nil, keyEquivalent: "")
    i.target = a
    i.representedObject = a
    i.state = checked ? .on : .off
    return i
  }

  func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    let m = NSMenu()
    for it in items { m.addItem(it) }
    i.submenu = m
    return i
  }

  /// An arrow's menu (menus.ts linkMenu, its plain arrow's items): Line, Width, Start, End, Color; Start Side, End Side,
  /// Reset Sides; Add or Edit Label; Delete
  func arrowMenu(_ id: ArrowID) -> NSMenu? {
    guard let doc = document, let a = doc.board.arrow(id) else { return nil }
    let one: Set<ArrowID> = [id]
    let m = NSMenu()
    m.autoenablesItems = true
    m.addItem(
      submenu(
        "Line",
        [
          menuItem("Solid", checked: !a.dashed) { doc.edit("Line") { $0.setArrowsDashed(one, false) } },
          menuItem("Dashed", checked: a.dashed) { doc.edit("Line") { $0.setArrowsDashed(one, true) } },
        ]))
    m.addItem(
      submenu(
        "Width",
        [(1, "Thin 1px"), (2, "Regular 2px"), (3, "Bold 3px")].map { w, title in
          menuItem(title, checked: a.width == w) { doc.edit("Width") { $0.setArrowsWidth(one, w) } }
        }))
    for (end, title, on) in [(Board.End.from, "Start", a.startHead), (.to, "End", a.endHead)] {
      m.addItem(
        submenu(
          title,
          [
            menuItem("Arrowhead", checked: on) { doc.edit("Arrowhead") { $0.setArrowsHead(one, end, true) } },
            menuItem("None", checked: !on) { doc.edit("Arrowhead") { $0.setArrowsHead(one, end, false) } },
          ]))
    }
    m.addItem(
      submenu(
        "Color",
        [(nil, "Grey"), ("orange", "Orange"), ("blue", "Blue"), ("green", "Green")].map { (c: String?, title) in
          menuItem(title, checked: a.color == c) { doc.edit("Color") { $0.setArrowsColor(one, c) } }
        }))
    m.addItem(.separator())
    for (end, title, e) in [(Board.End.from, "Start Side", a.from), (.to, "End Side", a.to)] {
      // a line takes the left or the right only
      var sides: [(Endpoint.Side?, String)] = [(nil, "Auto"), (.left, "Left"), (.right, "Right")]
      if e.line == nil { sides += [(.top, "Top"), (.bottom, "Bottom")] }
      m.addItem(
        submenu(
          title,
          sides.map { s, t in
            menuItem(t, checked: e.side == s) { doc.edit("Side") { $0.setArrowSide(id, end, s) } }
          }))
    }
    m.addItem(
      menuItem("Reset Sides", enabled: a.from.side != nil || a.to.side != nil) {
        doc.edit("Reset Sides") { b in
          b.setArrowSide(id, .from, nil)
          b.setArrowSide(id, .to, nil)
        }
      })
    m.addItem(.separator())
    m.addItem(menuItem(a.label == nil ? "Add Label" : "Edit Label") { [weak self] in self?.editLabel(id) })
    m.addItem(.separator())
    let del = NSMenuItem(title: "Delete", action: #selector(delete(_:)), keyEquivalent: "")
    del.target = self
    m.addItem(del)
    return m
  }

  /// An arrow label's menu (menus.ts labelMenu): Edit Label; Reset Label Position, Delete Label
  func labelMenu(_ id: ArrowID) -> NSMenu? {
    guard let doc = document, let a = doc.board.arrow(id) else { return nil }
    let m = NSMenu()
    m.addItem(menuItem("Edit Label") { [weak self] in self?.editLabel(id) })
    m.addItem(.separator())
    m.addItem(
      menuItem("Reset Label Position", enabled: a.labelPosition != nil) {
        doc.edit("Reset Label Position") { $0.setLabelPosition(id, nil) }
      })
    m.addItem(
      menuItem("Delete Label", enabled: a.label != nil) { doc.edit("Delete Label") { $0.setArrowLabel(id, nil) } })
    return m
  }

  /// Connect with Arrow (menus.ts multiItems): an arrow between the two selected cards, from the one on the left (above,
  /// when one is over the other) to the other
  func connectSelected() {
    guard let doc = document else { return }
    let cs = doc.selection.compactMap(\.card)
    guard cs.count == 2 else { return }
    let rects = cs.map { id in index(of: .card(id)).map { scene!.items[$0].rect } ?? .zero }
    let leftFirst =
      abs(rects[0].midX - rects[1].midX) >= abs(rects[0].midY - rects[1].midY)
      ? rects[0].midX <= rects[1].midX : rects[0].midY <= rects[1].midY
    let (a, b) = leftFirst ? (cs[0], cs[1]) : (cs[1], cs[0])
    doc.edit("Connect with Arrow") {
      $0.addArrow(ArrowID(rawValue: Board.newID("l")), from: Endpoint(card: a), to: Endpoint(card: b))
    }
  }
}

extension CanvasView: NSTextFieldDelegate {
  public func controlTextDidChange(_ n: Notification) {
    withoutAnimation { placeField() }
  }

  public func controlTextDidEndEditing(_ n: Notification) {
    endInPlace(commit: true)
  }

  public func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
    switch sel {
    case #selector(NSResponder.cancelOperation(_:)):
      endInPlace(commit: false)
      return true
    case #selector(NSResponder.insertNewline(_:)):
      endInPlace(commit: true)
      return true
    default:
      return false
    }
  }
}

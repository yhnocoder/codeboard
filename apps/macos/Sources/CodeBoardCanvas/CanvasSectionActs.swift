import AppKit
import CodeBoardModel

// A Section title's controls (canvas/Sections.tsx and SectionTools.tsx): the ⋮⋮ grip left of the title, the chevron
// that folds it, then Fit Content, Color (its five swatches open to its right) and Lock just past it. They show while
// the title is hovered or the Section is selected alone, fading in (styles.css .sacts, .dots, .chev2). In board units,
// one bitmap as the Text bar is, drawn again only when what it shows or the resting zoom changes. The grip drags the
// Section as its title does.

/// A control of a Section's title
enum SectionAct: Equatable {
  case grip
  case fold
  case fit
  case color
  /// One of the five swatches (nil: None)
  case swatch(String?)
  case lock
  /// A locked Section's lock, first in its title (.slabel .lockb): Unlock Section
  case unlock
}

extension CanvasView {
  /// The Section whose controls show: its title hovered, or it selected alone; none while something is moved
  var actsSection: SectionID? {
    guard levels.level == .cards, let doc = document, inPlace == nil else { return nil }
    switch gesture?.kind {
    case .move?, .nudge?, .marquee?, .resize?: return nil
    default: break
    }
    if let h = hoveredTitle, doc.board.section(h) != nil, sectionTitle(h) != nil { return h }
    if doc.selection.count == 1, case .section(let id)? = doc.selection.first, sectionTitle(id) != nil { return id }
    return nil
  }

  /// Each control's place on the board
  func actsLayout(_ id: SectionID) -> [(SectionAct, CGRect)] {
    guard let s = document?.board.section(id), let r = sectionTitle(id) else { return [] }
    var out: [(SectionAct, CGRect)] = [(.grip, CGRect(x: r.minX - 12, y: r.minY, width: 12, height: r.height))]
    if s.locked {
      let x = r.minX + (theme.frame == .tray ? 6 : 0)
      out.append((.unlock, CGRect(x: x, y: r.midY - 8, width: 16, height: 16)))
    }
    var x = r.maxX
    if s.collapsed {
      // the folded title draws its chevron at its right end
      out.append((.fold, CGRect(x: r.maxX - 18, y: r.midY - 8, width: 16, height: 16)))
    } else {
      // after the sidenote marker when it has one (.chev2 order 1: last in the row)
      x += CanvasView.titleBadge(id, in: scene?.notes ?? []) ?? 0
      out.append((.fold, CGRect(x: x, y: r.midY - 8, width: 16, height: 16)))
      x += 16 + 2
    }
    x += 6
    func button(_ a: SectionAct) {
      out.append((a, CGRect(x: x, y: r.midY - 13, width: 26, height: 26)))
      x += 26 + 2
    }
    button(.fit)
    button(.color)
    if swatchesOpen == id {
      x += 6
      for (c, _) in CanvasView.sectionColors {
        out.append((.swatch(c), CGRect(x: x, y: r.midY - 8, width: 16, height: 16)))
        x += 16 + 6
      }
      x += 2
    }
    button(.lock)
    return out
  }

  /// The control under a board point, of the Section whose controls show
  func sectionAct(at p: CGPoint) -> (SectionID, SectionAct)? {
    guard let id = actsSection else { return nil }
    return actsLayout(id).first { $0.1.insetBy(dx: -1, dy: -1).contains(p) }.map { (id, $0.0) }
  }

  /// The grip or the chevron of a Section whose controls do not show: they are only faded out (.dots, .chev2: opacity
  /// 0), so a press finds them before any hover (one that comes as the camera brings the title under a resting pointer)
  func fadedSectionAct(at p: CGPoint) -> (SectionID, SectionAct)? {
    guard levels.level == .cards, inPlace == nil, let doc = document else { return nil }
    for s in doc.board.sections.reversed() where s.id != actsSection {
      let hit = actsLayout(s.id).first { a, r in
        (a == .fold || a == .unlock || (a == .grip && !s.collapsed)) && r.insetBy(dx: -1, dy: -1).contains(p)
      }
      if let (a, _) = hit { return (s.id, a) }
    }
    return nil
  }

  /// The Section whose title, grip or controls are under a board point
  func titleHover(at p: CGPoint) -> SectionID? {
    if let id = actsSection, let b = actsBounds(id), b.contains(p) { return id }
    return hitSectionTitle(p)
  }

  private func actsBounds(_ id: SectionID) -> CGRect? {
    let rs = actsLayout(id).map(\.1)
    guard let f = rs.first else { return nil }
    return rs.dropFirst().reduce(f) { $0.union($1) }.insetBy(dx: -2, dy: -2)
  }

  /// Fit Content does nothing: why (folded, locked, empty), nil when it can
  func fitBlocked(_ id: SectionID) -> String? {
    guard let s = document?.board.section(id) else { return "" }
    if s.collapsed { return "expand the Section first" }
    if document?.board.isLocked(section: id) == true { return "the Section is locked" }
    return fitFrame(id) == nil ? "no cards inside" : nil
  }

  /// What a control does
  func press(_ a: SectionAct, of id: SectionID) {
    guard let doc = document, let s = doc.board.section(id) else { return }
    switch a {
    case .grip: break
    case .fold:
      guard let f = scene?.frames.first(where: { $0.id == id })?.rect else { return }
      let open = (Double(f.minX), Double(f.minY), Double(f.width), Double(f.height))
      doc.edit(s.collapsed ? "Expand Section" : "Collapse Section") { $0.setFolded(id, !s.collapsed, open: open) }
    case .fit:
      if fitBlocked(id) == nil { fitContent([id]) }
    case .color:
      swatchesOpen = swatchesOpen == id ? nil : id
      drawChrome()
    case .swatch(let c):
      if s.color != c { doc.edit("Color") { $0.setSectionColor([id], c) } }
    case .lock:
      doc.edit(s.locked ? "Unlock" : "Lock") { $0.setLocked([.section(id)], !s.locked) }
    case .unlock:
      doc.edit("Unlock") { $0.setLocked([.section(id)], false) }
    }
  }

  /// The hovered title, its hovered control: the controls follow
  func hoverTitle(_ id: SectionID?, act: SectionAct?) {
    guard id != hoveredTitle || act != hoveredAct else { return }
    if id != hoveredTitle { swatchesOpen = nil }
    hoveredTitle = id
    hoveredAct = act
    showTip()
    drawChrome()
  }

  /// What a control says when the pointer rests on it (SectionTools.tsx, Sections.tsx .lockb data-tip and data-kbd)
  func sectionTip(_ a: SectionAct, of id: SectionID) -> Tip? {
    guard let s = document?.board.section(id) else { return nil }
    return switch a {
    case .grip, .fold: nil
    case .fit: Tip(fitBlocked(id).map { "Fit Content · \($0)" } ?? "Fit Content", kbd: BoardKey.show(of: "Fit Content"))
    case .color: Tip("Color")
    case .swatch(let c): CanvasView.sectionColors.first { $0.0 == c }.map { Tip($0.1) }
    case .lock: Tip(s.locked ? "Unlock" : "Lock", kbd: BoardKey.show(of: "Lock / Unlock"))
    case .unlock: Tip("Unlock Section")
    }
  }

  /// The controls as a chrome layer (board units), fading in when they come
  func sectionActsLayer() -> CALayer? {
    guard let id = actsSection, let doc = document, let s = doc.board.section(id) else {
      actsShown = nil
      return nil
    }
    let items = actsLayout(id)
    guard let bounds = actsBounds(id) else { return nil }
    let scale = (restZoom ?? camera.zoom) * backing
    let hovered = hoveredTitle == id ? hoveredAct : nil
    let blocked = fitBlocked(id) != nil
    let key =
      "\(s.collapsed) \(s.color ?? "") \(s.locked) \(blocked) \(String(describing: hovered)) \(items.map(\.1)) "
      + "\(theme.id) \(theme.dark) \(scale)"
    if actsImage?.key != key {
      let t = theme
      let img = CanvasView.picture(size: bounds.size, scale: scale) { ctx in
        ctx.translateBy(x: -bounds.minX, y: -bounds.minY)
        for (a, r) in items { SectionActs.draw(a, in: r, section: s, hovered: hovered == a, blocked: blocked, t, ctx) }
      }
      actsImage = img.map { (key, $0) }
    }
    let l = CALayer()
    l.frame = bounds
    l.contents = actsImage?.image
    l.contentsGravity = .resize
    if actsShown != id {
      // .sacts, .dots: opacity over 150 ms
      let a = CABasicAnimation(keyPath: "opacity")
      a.fromValue = 0
      a.duration = 0.15
      a.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
      l.add(a, forKey: "in")
      actsShown = id
    }
    return l
  }
}

enum SectionActs {
  static var fit: CGPath {
    SVGPath.parse(
      "M2 5V2.5A.5 .5 0 0 1 2.5 2H5M11 2H13.5A.5 .5 0 0 1 14 2.5V5M14 11V13.5A.5 .5 0 0 1 13.5 14H11M5 14H2.5A.5 .5 0 0 1 2 13.5V11"
    )
  }
  static var paint: CGPath {
    SVGPath.parse(
      "M12 7L7 2L1.707 7.293A1 1 0 0 0 1.707 8.707L5.293 12.293A1 1 0 0 0 6.707 12.293L12 7zM2 1l4 4M2 8h9M15 13.5a1.5 1.5 0 1 1-3 0c0-1.2 1.28-1.8 1.5-3 .22 1.2 1.5 1.8 1.5 3z"
    )
  }
  static var lock: CGPath {
    SVGPath.parse(
      "M2.5 7H13.5A.5 .5 0 0 1 14 7.5V13.5A.5 .5 0 0 1 13.5 14H2.5A.5 .5 0 0 1 2 13.5V7.5A.5 .5 0 0 1 2.5 7zM5 7V5a3 3 0 0 1 6 0v2"
    )
  }
  /// The chevron pointing down (icons.tsx chev)
  static var chev: CGPath { SVGPath.parse("M4 6l4 4 4-4") }
  static var dots: Font { Font(NSFont.systemFont(ofSize: 11)) }

  static func draw(
    _ a: SectionAct, in r: CGRect, section s: Section, hovered: Bool, blocked: Bool, _ t: Theme, _ ctx: CGContext
  ) {
    func round(_ c: CGColor, radius: CGFloat) {
      ctx.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil))
      ctx.setFillColor(c)
      ctx.fillPath()
    }
    let hover = t.ink.copy(alpha: 0.07) ?? t.hlrow
    switch a {
    case .grip:
      // "⋮⋮" with -2 letter spacing, right against the title
      let w = Drawing.width("⋮", dots)
      for k in 0..<2 {
        Drawing.text(ctx, "⋮", dots, t.ink3, x: r.maxX - 1 - (2 - CGFloat(k)) * (w - 2), midY: r.midY, width: w)
      }
    case .fold:
      // a folded title draws its own chevron
      guard !s.collapsed else { return }
      if hovered { round(t.hlrow, radius: 5) }
      // 10 px in its 16 px box, its stroke 2 of 16
      ctx.saveGState()
      ctx.translateBy(x: r.minX + 3, y: r.minY + 3)
      ctx.scaleBy(x: 10 / 16, y: 10 / 16)
      ctx.addPath(chev)
      ctx.setStrokeColor(hovered ? t.ink : t.ink3)
      ctx.setLineWidth(2)
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      ctx.strokePath()
      ctx.restoreGState()
    case .fit, .color, .lock:
      let on = a == .lock && s.locked
      let faint = a == .fit && blocked
      if hovered && !faint { round(hover, radius: 8.5) }
      let ink = on ? t.accent : hovered && !faint ? t.ink : t.ink2
      let path = a == .fit ? fit : a == .color ? paint : lock
      ctx.saveGState()
      if faint { ctx.setAlpha(0.35) }
      Icons.stroke(path, at: CGPoint(x: r.midX - 8, y: r.midY - 8), color: ink, in: ctx)
      ctx.restoreGState()
    case .unlock:
      // drawn with the title; lit: .lockb:hover, the row's tint behind it and the lock in the accent
      guard hovered else { return }
      round(t.hlrow, radius: 5.5)
      Drawing.lock(ctx, in: r, t.accent)
    case .swatch(let c):
      let cur = s.color == c
      let d = hovered ? r.insetBy(dx: -1, dy: -1) : r
      if cur {
        // a ring 2 of paper, then 1.5 of ink
        ctx.setFillColor(t.ink2)
        ctx.fillEllipse(in: d.insetBy(dx: -3.5, dy: -3.5))
        ctx.setFillColor(t.surface)
        ctx.fillEllipse(in: d.insetBy(dx: -2, dy: -2))
      }
      ctx.setFillColor(t.surface)
      ctx.fillEllipse(in: d)
      if let c, let wash = t.sectionColors[c] {
        ctx.setFillColor(wash.copy(alpha: c == "sand" ? 0.6 : 0.5) ?? wash)
        ctx.fillEllipse(in: d)
      }
      ctx.setStrokeColor(t.ink.copy(alpha: 0.16) ?? t.ink3)
      ctx.setLineWidth(1)
      ctx.strokeEllipse(in: d.insetBy(dx: 0.5, dy: 0.5))
    }
  }
}

import AppKit
import CodeBoardModel
import QuartzCore

// The toolbar's Section and Arrow, Sections drawn and made from a selection, their menus, and what a drag shows of them,
// after the web board's state/mode.ts, interact.ts drawSection and finishConnect, actions/menus.ts sectionMenu and
// multiItems, canvas/Sections.tsx (.sect.drop) and the toast (state/toast.ts).

/// A mode of the board: one at a time, Esc leaves it (state/mode.ts)
public enum CanvasMode: Equatable, Sendable {
  /// The toolbar's Arrow with one card selected: the next card clicked gets an arrow from it
  case connect(from: CardID)
  /// The toolbar's Section: a frame is dragged out on the canvas
  case drawSection
}

/// How long a toast shows (state/toast.ts)
let toastFor: TimeInterval = 2.6
let drawHint = "Drag on the canvas to draw a section · Esc to cancel"

extension CanvasView {
  // MARK: Modes

  /// The toolbar's tool that shows as in use
  var activeTool: Tool? {
    switch mode {
    case .connect?: .arrow
    case .drawSection?: .section
    case nil: nil
    }
  }

  /// The toolbar's Section: drag out a frame. Its Arrow: two cards selected, an arrow between them; one, the next card
  /// clicked; none, a hint (Chrome.tsx)
  func useSection() {
    mode = .drawSection
    toast(drawHint)
  }

  func useArrow() {
    guard let doc = document else { return }
    let cs = doc.selection.compactMap(\.card)
    if cs.count == 2 {
      connectSelected()
    } else if cs.count == 1 {
      mode = .connect(from: cs[0])
      toast("Click a card to connect · Esc to cancel")
    } else {
      toast("Select a card first, then click another card")
    }
  }

  /// Esc: the mode left; a connection says it was cancelled, a Section being drawn just takes its hint away
  func cancelMode() -> Bool {
    guard let m = mode else { return false }
    mode = nil
    if m == .drawSection {
      if toastText == drawHint { hideToast() }
    } else {
      toast("Connect cancelled")
    }
    return true
  }

  /// A press in connect mode: on another card, the arrow to it; anywhere else, cancelled (interact.ts finishConnect)
  func finishConnect(from: CardID, at p: CGPoint) {
    mode = nil
    guard let doc = document, let to = hitCard(p), to != from else { return toast("Connect cancelled") }
    doc.edit("Arrow") {
      $0.addArrow(ArrowID(rawValue: Board.newID("l")), from: Endpoint(card: from), to: Endpoint(card: to))
    }
  }

  // MARK: The toast

  /// A short line over the bottom of the board, gone after 2.6 s: Warm Ink's dark pill, Ink Wash's sheet of paper with a
  /// small seal before its text (styles.css .toast, themes.css)
  func toast(_ text: String) {
    toastText = text
    toastShown += 1
    let n = toastShown
    let scale = backing
    let ink = theme.id == .inkWash
    let font =
      ink
      ? Font.board("SourceSerif4-400-600", size: 12.5, weight: 400, opticalSize: true)
        ?? Font(NSFont.systemFont(ofSize: 12.5)) : Font(NSFont.systemFont(ofSize: 12.5))
    let lead: CGFloat = ink ? 8 + 12 + 10 : 12
    let size = CGSize(width: (lead + Drawing.width(text, font) + 12).rounded(.up), height: 31)
    let bg =
      ink
      ? theme.surface
      : theme.dark
        ? CGColor(srgbRed: 245 / 255, green: 243 / 255, blue: 238 / 255, alpha: 0.94)
        : CGColor(srgbRed: 34 / 255, green: 32 / 255, blue: 28 / 255, alpha: 0.92)
    let fg =
      ink
      ? theme.ink
      : theme.dark
        ? CGColor(srgbRed: 29 / 255, green: 28 / 255, blue: 26 / 255, alpha: 1)
        : CGColor(srgbRed: 246 / 255, green: 244 / 255, blue: 239 / 255, alpha: 1)
    let accent = theme.accent
    let image = Raster.surface(size: size, scale: scale) { ctx in
      let r = CGRect(origin: .zero, size: size)
      ctx.addPath(CGPath(roundedRect: r, cornerWidth: ink ? 2 : 11, cornerHeight: ink ? 2 : 11, transform: nil))
      ctx.setFillColor(bg)
      ctx.fillPath()
      if ink {
        ctx.addPath(
          CGPath(
            roundedRect: CGRect(x: 8, y: (size.height - 12) / 2, width: 12, height: 12), cornerWidth: 2,
            cornerHeight: 2, transform: nil))
        ctx.setFillColor(accent)
        ctx.fillPath()
      }
      Drawing.text(ctx, text, font, fg, x: lead, midY: size.height / 2, width: size.width - lead - 12)
    }
    let bottom: CGFloat = ink ? 72 : 62
    withoutAnimation {
      toastLayer.contents = image
      toastLayer.bounds = CGRect(origin: .zero, size: size)
      toastLayer.position = CGPoint(x: bounds.midX, y: bounds.maxY - bottom - size.height / 2)
      toastLayer.shadowColor = CGColor(gray: 0, alpha: 1)
      toastLayer.shadowOpacity = ink ? 0.12 : 0.35
      toastLayer.shadowRadius = ink ? 10 : 12
      toastLayer.shadowOffset = CGSize(width: 0, height: 8)
      toastLayer.shadowPath = CGPath(
        roundedRect: toastLayer.bounds, cornerWidth: ink ? 2 : 11, cornerHeight: ink ? 2 : 11, transform: nil)
      toastLayer.isHidden = false
      toastLayer.opacity = 1
    }
    // fades in as it rises 8 points (.toast.show)
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 0
    fade.duration = 0.18
    fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
    let rise = CABasicAnimation(keyPath: "position.y")
    rise.fromValue = toastLayer.position.y + 8
    rise.duration = 0.22
    rise.timingFunction = CAMediaTimingFunction(name: .easeOut)
    toastLayer.add(fade, forKey: "fade")
    toastLayer.add(rise, forKey: "rise")
    DispatchQueue.main.asyncAfter(deadline: .now() + toastFor) { [weak self] in
      guard let self, self.toastShown == n else { return }
      self.hideToast()
    }
  }

  func hideToast() {
    toastText = nil
    withoutAnimation { toastLayer.isHidden = true }
  }

  // MARK: Drawing a Section

  /// The frame dragged out so far, in the view (the rubber band's look)
  func showDraw(from a: CGPoint, to b: CGPoint) {
    let r = CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    withoutAnimation {
      marquee.path = CGPath(rect: r.insetBy(dx: 0.5, dy: 0.5), transform: nil)
      marquee.fillColor = theme.accent.copy(alpha: 0.06)
      marquee.strokeColor = theme.accent.copy(alpha: 0.7)
      marquee.lineWidth = 1
    }
  }

  /// Let go: the frame dragged (120 × 80 at least) or, for a click, 360 × 240 from the click, as a new Section. Its parent
  /// is the innermost Section at its middle (not one wholly inside it); it takes the cards it covers by more than a third
  /// that are in that parent or further out, and the Sections wholly inside it that share its parent. It is selected and
  /// its title written (interact.ts drawSection, actions/edit.ts moveToNewSection)
  func commitDraw(from a: CGPoint, to b: CGPoint, moved: Bool) {
    gesture = nil
    mode = nil
    if toastText == drawHint { hideToast() }
    withoutAnimation { marquee.path = nil }
    guard let doc = document, let s = scene else { return }
    let r =
      moved
      ? CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: max(120, abs(b.x - a.x)), height: max(80, abs(b.y - a.y)))
      : CGRect(x: a.x, y: a.y, width: 360, height: 240)
    let r0 = CGRect(x: r.minX.rounded(), y: r.minY.rounded(), width: r.width.rounded(), height: r.height.rounded())
    let frames = Dictionary(s.frames.map { ($0.id, $0.rect) }, uniquingKeysWith: { a, _ in a })
    let enclosed = Set(frames.filter { r0.contains($0.value) }.map(\.key))
    let parent = deepestSection(CGPoint(x: r0.midX, y: r0.midY), skip: enclosed)
    var outer: Set<SectionID?> = [nil]
    var at = parent
    while let p = at, outer.insert(p).inserted { at = doc.board.section(p)?.parent }
    let cards = s.items.compactMap { it -> CardID? in
      guard case .card(let id)? = it.owner, let c = doc.board.card(id), outer.contains(c.section) else { return nil }
      let o = it.rect.intersection(r0)
      return !o.isNull && o.width * o.height > it.rect.width * it.rect.height / 3 ? id : nil
    }
    let subs = doc.board.sections.filter { enclosed.contains($0.id) && $0.parent == parent }.map(\.id)
    newSection(r0, drawn: true, parent: parent, cards: cards, sections: subs)
  }

  /// A new Section as one step, selected, its title written as soon as it is drawn
  func newSection(_ r: CGRect, drawn: Bool, parent: SectionID?, cards: [CardID], sections: [SectionID]) {
    guard let doc = document else { return }
    let id = SectionID(rawValue: Board.newID("g"))
    doc.edit("New Section", selection: [.section(id)]) {
      $0.addSection(
        id, x: r.minX, y: r.minY, width: r.width, height: r.height, drawn: drawn, parent: parent, cards: cards,
        sections: sections)
    }
    Task {
      while index(of: .sectionTitle(id)) == nil, doc.board.section(id) != nil, document === doc {
        await refreshing?.value
        await Task.yield()
      }
      if doc.selection == [.section(id)] { editTitle(id) }
    }
  }

  /// Move to New Section: the selected cards and Sections in a new one round them (actions/edit.ts moveToNewSection)
  func moveToNewSection() {
    guard let doc = document, let s = scene else { return }
    let cards = doc.selection.compactMap(\.card).filter { doc.board.card($0) != nil }
    let subs = doc.selection.compactMap(\.section).filter { doc.board.section($0) != nil }
    var r = CGRect.null
    for id in cards { if let i = index(of: .card(id)) { r = r.union(s.items[i].rect) } }
    for id in subs { if let f = s.frames.first(where: { $0.id == id }) { r = r.union(f.rect) } }
    guard !r.isNull else { return }
    newSection(
      CGRect(x: r.minX.rounded(), y: r.minY.rounded(), width: r.width.rounded(), height: r.height.rounded()),
      drawn: false, parent: nil, cards: cards.sorted { $0.rawValue < $1.rawValue },
      sections: subs.sorted { $0.rawValue < $1.rawValue })
  }

  // MARK: Fit Content

  /// What a Section's own frame becomes to fit what is in it: its cards and the Sections in it, each with its room round it
  /// (state/sections.ts fitFrame, core sectionFit); nil when it holds nothing
  func fitFrame(_ id: SectionID) -> CGRect? {
    guard let doc = document, let s = scene else { return nil }
    var r = CGRect.null
    for c in doc.board.cards where c.section == id {
      if let i = index(of: .card(c.id)) { r = r.union(Scene.padded(s.items[i].rect)) }
    }
    for q in doc.board.sections where q.parent == id {
      if let f = s.frames.first(where: { $0.id == q.id }) { r = r.union(Scene.padded(f.rect)) }
    }
    guard !r.isNull else { return nil }
    let x = r.minX.rounded(.down)
    let y = r.minY.rounded(.down)
    return CGRect(x: x, y: y, width: r.maxX.rounded(.up) - x, height: r.maxY.rounded(.up) - y)
  }

  /// The Sections that can be fitted: open, not locked, with something in them
  func fittable(_ ids: [SectionID]) -> [SectionID] {
    guard let b = document?.board else { return [] }
    return ids.filter { id in
      b.section(id).map { !$0.collapsed } == true && !b.isLocked(section: id) && fitFrame(id) != nil
    }
  }

  func fitContent(_ ids: [SectionID]) {
    guard let doc = document else { return }
    let fits = fittable(ids).compactMap { id in fitFrame(id).map { (id, $0) } }
    guard !fits.isEmpty else { return }
    doc.edit("Fit Content") { b in
      for (id, r) in fits { b.resize(section: id, x: r.minX, y: r.minY, width: r.width, height: r.height) }
    }
  }

  // MARK: Menus

  static let sectionColors: [(String?, String)] = [
    (nil, "None"), ("sand", "Warm Sand"), ("blue", "Light Blue"), ("green", "Light Green"), ("pink", "Light Pink"),
  ]

  func colorItem(_ ids: [SectionID]) -> NSMenuItem {
    guard let doc = document else { return NSMenuItem() }
    return submenu(
      "Color",
      CanvasView.sectionColors.map { c, title in
        menuItem(title, checked: ids.allSatisfy { doc.board.section($0)?.color == c }) {
          doc.edit("Color") { $0.setSectionColor(Set(ids), c) }
        }
      })
  }

  /// A Section's menu (menus.ts sectionMenu, its row of Fit Content, Color and Lock as items): then Move Out of Parent
  /// Section when it is in one, and Remove Section, which keeps what is in it
  func sectionMenu(_ id: SectionID) -> NSMenu? {
    guard let doc = document, let s = doc.board.section(id) else { return nil }
    let m = NSMenu()
    m.addItem(menuItem("Fit Content", enabled: !fittable([id]).isEmpty) { [weak self] in self?.fitContent([id]) })
    m.addItem(colorItem([id]))
    let lock = NSMenuItem(title: s.locked ? "Unlock" : "Lock", action: #selector(lock(_:)), keyEquivalent: "")
    lock.target = self
    m.addItem(lock)
    m.addItem(.separator())
    if s.parent != nil {
      m.addItem(
        menuItem("Move Out of Parent Section") { doc.edit("Move Out of Parent Section") { $0.moveOutOfParent(id) } })
    }
    let remove = NSMenuItem(title: "Remove Section", action: #selector(delete(_:)), keyEquivalent: "")
    remove.target = self
    m.addItem(remove)
    return m
  }

  /// Several Sections and no cards (menus.ts multiSectionItems): Fit Content, Lock, Color, then Remove N Sections
  func sectionsMenu(_ ids: [SectionID]) -> NSMenu {
    let m = NSMenu()
    let fit = fittable(ids)
    m.addItem(menuItem("Fit Content", enabled: !fit.isEmpty) { [weak self] in self?.fitContent(fit) })
    let all = ids.allSatisfy { document?.board.section($0)?.locked == true }
    let lock = NSMenuItem(title: all ? "Unlock" : "Lock", action: #selector(lock(_:)), keyEquivalent: "")
    lock.target = self
    m.addItem(lock)
    m.addItem(colorItem(ids))
    m.addItem(.separator())
    let remove = NSMenuItem(title: "Remove \(ids.count) Sections", action: #selector(delete(_:)), keyEquivalent: "")
    remove.target = self
    m.addItem(remove)
    return m
  }

  // MARK: Where a drag lands

  /// The Sections the dragged cards would go into, other than the ones they are in: tinted while the drag runs
  /// (state/sections.ts dropSections, .sect.drop: an ink edge at 42 %, a wash at 6.5 %, a 4 point ring at 7 %; Ink Wash
  /// the wash only). Only a layer of their own changes
  func showDrop(_ m: Move) {
    guard let doc = document, let s = scene else { return }
    let dx = m.d.dx.rounded()
    let dy = m.d.dy.rounded()
    var frames = Dictionary(s.frames.map { ($0.id, $0.rect) }, uniquingKeysWith: { a, _ in a })
    for id in m.sections { frames[id] = frames[id]?.offsetBy(dx: dx, dy: dy) }
    var lit = Set<SectionID>()
    for id in m.loose {
      guard let i = index(of: .card(id)) else { continue }
      if let h = home(of: s.items[i].rect.offsetBy(dx: dx, dy: dy), frames: frames, skip: m.sections),
        h != doc.board.card(id)?.section
      {
        lit.insert(h)
      }
    }
    guard lit != dropLit else { return }
    dropLit = lit
    let ink = theme.ink
    let tray = theme.frame == .tray
    withoutAnimation {
      dropLayer.sublayers = nil
      for f in s.frames where lit.contains(f.id) {
        let r = frames[f.id] ?? f.rect
        let radius = tray ? theme.sectionRadius : 2
        if tray {
          let ring = CAShapeLayer()
          ring.path = Drawing.squircle(r.insetBy(dx: -2, dy: -2), radius + 2)
          ring.fillColor = nil
          ring.strokeColor = ink.copy(alpha: ink.alpha * 0.07)
          ring.lineWidth = 4
          dropLayer.addSublayer(ring)
        }
        let wash = CAShapeLayer()
        wash.path = Drawing.squircle(r, radius)
        wash.fillColor = ink.copy(alpha: ink.alpha * 0.065)
        wash.strokeColor = tray ? ink.copy(alpha: ink.alpha * 0.42) : nil
        wash.lineWidth = 1
        dropLayer.addSublayer(wash)
      }
    }
  }

  func clearDrop() {
    guard !dropLit.isEmpty else { return }
    dropLit = []
    withoutAnimation { dropLayer.sublayers = nil }
  }

  // MARK: Frames easing to their new size

  /// A Section's frame that changed size or place on a change (a card dropped in or taken out, Fit Content) eases from
  /// where it was shown to where it is now, as the web board's frames spring (k 2500, c 100); a layer animation only
  func easeFrames(from shown: [SectionID: CGRect], in s: Scene) {
    let ls = sections.sublayers ?? []
    for (i, f) in s.frames.enumerated() where i < ls.count {
      guard let old = shown[f.id], old != f.rect, old.width > 0, old.height > 0 else { continue }
      var t = CATransform3DMakeTranslation(old.midX - f.rect.midX, old.midY - f.rect.midY, 0)
      t = CATransform3DScale(t, old.width / f.rect.width, old.height / f.rect.height, 1)
      let a = CASpringAnimation(keyPath: "transform")
      a.stiffness = 2500
      a.damping = 100
      a.mass = 1
      a.fromValue = NSValue(caTransform3D: t)
      a.toValue = NSValue(caTransform3D: CATransform3DIdentity)
      a.duration = a.settlingDuration
      ls[i].add(a, forKey: "ease")
    }
  }
}

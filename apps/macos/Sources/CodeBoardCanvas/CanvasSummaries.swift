import AppKit
import CodeBoardModel

// The summary level (the web board's canvas/Summaries.tsx): one column per item the board summarizes, laid out by the
// model's layoutSummaries in two passes (estimated, then measured here with Core Text) and drawn once into pictures at the
// switch point's scale, before they are needed. At rest a column is clipped at its height with its last lines fading;
// hovered it shows all of it on a panel, with ↻ (when an AI key is set), the stale dot and ✓ 保留. Clicking its body
// edits it in place (Enter keeps, Esc leaves); double-clicking its title flies to what it summarizes. Nothing here is
// drawn while a gesture runs: hover, the panel and the switch change opacity, masks and transforms only.

/// A column on screen
struct SummaryColumn {
  var col: SumCol
  var text: SummaryColumnText
  /// The picture, its frame the column's top left and its whole height
  var layer: CALayer
  var image: CGImage
  /// Behind it while hovered (.sumover::before)
  var panel: CALayer
  /// At rest, when its text is taller than its room: the clip and the fade over its last 1.5 lines
  var mask: CALayer?
  var full: CGFloat
  /// Board units: where its title's last line ends, and where its body starts
  var titleEnd: CGPoint
  var bodyTop: CGFloat
  /// Its picture with the title whole, when the title is cut at two lines: shown while hovered
  var open: SummaryArt.Drawn?

  var rect: CGRect { CGRect(x: col.rect.x, y: col.rect.y, width: col.rect.w, height: col.rect.h) }
  /// Its title row, where a double-click flies to it
  var titleRect: CGRect { CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: bodyTop) }
}

/// A column's picture, kept while what it shows stays the same
struct SummaryPictureKey: Hashable {
  var text: SummaryColumnText
  var width: CGFloat
  var hd: CGFloat
  var font: CGFloat
  var scale: CGFloat
  var look: String
  var whole = false
}

extension CanvasView {
  /// What the summary level shows, laid out again (after the board or its look changed): the switch point, the columns'
  /// pictures (the ones whose text, width and look are unchanged are kept)
  func summariesChanged() {
    guard let doc = document, let s = scene, let (vb, vault) = shown else {
      clearSummaries()
      return
    }
    let package = vault.url(of: vb.path)
    let board = doc.board
    let contents: CardContents = { Scene.content(of: $0, package: package, vault: vault)?.0 }
    var rects: [CardID: SumRect] = [:]
    for it in s.items {
      if case .card(let id)? = it.owner { rects[id] = SumRect(it.rect) }
    }
    var frames: [SectionID: SumRect] = [:]
    for f in s.frames { frames[f.id] = SumRect(f.rect) }
    let input = board.summarySources(rect: { rects[$0] }, frames: frames, contents: contents)
    let draft = layoutSummaries(input)
    levels.cut = CGFloat(draft.cut)
    var look = SummaryLook(theme)
    look.layout = CGFloat(draft.cut)
    let em = CGFloat(draft.font)
    let pad = CGFloat(draft.padding)
    let cut = CGFloat(draft.cut)
    var texts: [SummaryKey: SummaryColumnText] = [:]
    for it in input.items {
      let sum = board.summary(for: it.key)
      let loose = { if case .card = it.key { true } else { it.group } }()
      texts[it.key] = SummaryColumnText(
        title: it.title, kick: it.kick, code: it.code.map { .init(name: $0.name, at: $0.at) },
        text: (it.text ?? "").isEmpty ? nil : it.text, head: it.head?.level, loose: loose,
        stale: sum != nil && board.summaryPending(it.key, contents: contents))
    }
    let lookID = theme.id.rawValue + (theme.dark ? "-dark" : "")
    var measured: [SummaryKey: SumMeasure] = [:]
    var measures: [SummaryPictureKey: SumMeasure] = [:]
    for c in draft.cols {
      guard let t = texts[c.key] else { continue }
      // measured again only when its text, width or look changed
      let k = SummaryPictureKey(text: t, width: CGFloat(c.rect.w), hd: 0, font: em, scale: cut, look: lookID)
      let m =
        summaryMeasures[k]
        ?? {
          let m = SummaryArt.measure(t, look: look, font: em, pad: pad, width: CGFloat(c.rect.w), cut: cut)
          return SumMeasure(hd: Double(m.hd), tx: Double(m.tx))
        }()
      measures[k] = m
      measured[c.key] = m
    }
    summaryMeasures = measures
    let layout = layoutSummaries(input, measured: measured)
    summaryLayout = layout
    let scale = cut * backing
    var pictures: [SummaryPictureKey: SummaryArt.Drawn] = [:]
    var columns: [SummaryColumn] = []
    for c in layout.cols {
      guard let t = texts[c.key] else { continue }
      let key = SummaryPictureKey(
        text: t, width: CGFloat(c.rect.w), hd: CGFloat(c.hd), font: em, scale: scale,
        look: lookID)
      guard
        let d = summaryPictures[key]
          ?? SummaryArt.draw(
            t, look: look, font: em, pad: pad, width: CGFloat(c.rect.w), hd: CGFloat(c.hd), cut: cut, scale: scale)
      else { continue }
      var column = column(c, t, d, look: look, em: em)
      var whole = key
      whole.whole = true
      // a picture kept: its whole-title one was made with it when it cuts its title
      let cuts =
        summaryPictures[key] != nil
        ? summaryPictures[whole] != nil
        : SummaryArt.cutsTitle(t, look: look, font: em, pad: pad, width: CGFloat(c.rect.w))
      pictures[key] = d
      if cuts {
        column.open =
          summaryPictures[whole]
          ?? SummaryArt.draw(
            t, look: look, font: em, pad: pad, width: CGFloat(c.rect.w), hd: CGFloat(c.hd), cut: cut, scale: scale,
            whole: true)
        pictures[whole] = column.open
      }
      columns.append(column)
    }
    summaryPictures = pictures
    withoutAnimation {
      summaryLayer.sublayers = nil
      // a loose image card's picture stays, as a thumbnail over its summary (its bitmap as the card level has it)
      for c in layout.cols {
        guard let r = c.image, case .card(let id) = c.key, let i = index(of: .card(id)) else { continue }
        let l = CALayer()
        l.frame = CGRect(x: r.x, y: r.y, width: r.w, height: r.h)
        l.contents = items[i].held.contents ?? items[i].rest.contents
        l.contentsGravity = .resizeAspect
        l.minificationFilter = .trilinear
        summaryLayer.addSublayer(l)
      }
      for c in columns {
        summaryLayer.addSublayer(c.panel)
        summaryLayer.addSublayer(c.layer)
      }
    }
    summaryColumns = columns
    for k in summaryWriting { breathe(k, true) }
    if let ed = summaryEditor {
      if let c = columns.first(where: { $0.col.key == ed.key }) {
        cropForEdit(c)
        placeSummaryEditor()
      } else {
        endSummaryEdit(commit: false)
      }
    }
    if let k = summaryHover, columns.contains(where: { $0.col.key == k }) {
      summaryHover = nil
      hoverSummary(k)
    } else {
      summaryHover = nil
    }
  }

  func clearSummaries() {
    summaryColumns = []
    summaryLayout = nil
    summaryHover = nil
    levels.cut = 0
    withoutAnimation { summaryLayer.sublayers = nil }
  }

  /// A column's layers: the picture, the clip and fade when it overflows, the panel behind it (hidden)
  private func column(_ c: SumCol, _ t: SummaryColumnText, _ d: SummaryArt.Drawn, look: SummaryLook, em: CGFloat)
    -> SummaryColumn
  {
    let r = CGRect(x: c.rect.x, y: c.rect.y, width: c.rect.w, height: d.full)
    let l = CALayer()
    l.anchorPoint = .zero
    l.frame = r
    l.contents = d.image
    l.contentsScale = backing
    l.minificationFilter = .trilinear
    l.zPosition = 1
    var mask: CALayer?
    let h = CGFloat(c.rect.h)
    if d.full > h + 1 {
      // clipped at its height, fading from 1.5 lines above it (mask-image: linear-gradient(#000 rest − 2.25S, transparent
      // rest))
      let g = CAGradientLayer()
      g.frame = CGRect(origin: .zero, size: r.size)
      g.colors = [CGColor(gray: 0, alpha: 1), CGColor(gray: 0, alpha: 1), CGColor(gray: 0, alpha: 0)]
      g.locations = [0, NSNumber(value: Double(max(0, h - 2.25 * em) / d.full)), NSNumber(value: Double(h / d.full))]
      l.mask = g
      mask = g
    }
    let p = CALayer()
    p.frame = r.insetBy(dx: -0.6 * em, dy: -0.6 * em)
    p.backgroundColor = look.panel
    p.cornerRadius = 0.25 * em
    p.borderWidth = max(1, 0.02 * em)
    p.borderColor = look.shade.copy(alpha: 0.07)
    p.shadowColor = look.shade
    p.shadowOpacity = 0.22
    p.shadowRadius = 1.2 * em
    p.shadowOffset = CGSize(width: 0, height: 0.9 * em)
    p.shadowPath = CGPath(
      roundedRect: CGRect(origin: .zero, size: p.bounds.size), cornerWidth: p.cornerRadius,
      cornerHeight: p.cornerRadius,
      transform: nil)
    p.opacity = 0
    p.isHidden = true
    p.zPosition = 0.5
    return SummaryColumn(
      col: c, text: t, layer: l, image: d.image, panel: p, mask: mask, full: d.full, titleEnd: d.titleEnd,
      bodyTop: d.bodyTop)
  }

  // MARK: Finding a column

  func summaryColumn(at p: CGPoint) -> Int? {
    // a hovered one shows all of it, over the others
    if let k = summaryHover, let i = summaryColumns.firstIndex(where: { $0.col.key == k }) {
      let c = summaryColumns[i]
      let full = c.open?.full ?? c.full
      if CGRect(x: c.rect.minX, y: c.rect.minY, width: c.rect.width, height: max(c.rect.height, full)).contains(p) {
        return i
      }
    }
    return summaryColumns.lastIndex { $0.rect.contains(p) }
  }

  // MARK: Hover

  /// The pointer over a column (nil: over none): it shows all of its text on its panel, raised over the others, with
  /// its ↻, dot and ✓ 保留
  package func hoverSummary(_ key: SummaryKey?) {
    guard key != summaryHover else { return }
    if let old = summaryHover, let i = summaryColumns.firstIndex(where: { $0.col.key == old }) {
      let c = summaryColumns[i]
      fade(c.panel, to: 0, duration: 0.09)
      withoutAnimation {
        if c.open != nil {
          c.layer.contents = c.image
          c.layer.bounds.size.height = c.full
        }
        c.layer.mask = c.mask
        c.layer.zPosition = 1
        c.panel.zPosition = 0.5
        summaryButtons.removeFromSuperlayer()
      }
    }
    summaryHover = key
    guard let key, let i = summaryColumns.firstIndex(where: { $0.col.key == key }) else { return }
    let c = summaryColumns[i]
    withoutAnimation {
      c.layer.zPosition = 3
      c.panel.zPosition = 2.5
      // a title cut at two lines shows whole (its picture drawn with it whole, made with the others)
      if let o = c.open {
        c.layer.contents = o.image
        c.layer.bounds.size.height = o.full
        c.layer.mask = nil
      }
      // a body cut at its room shows whole on its panel (.sumover), the panel as tall as what it holds
      if c.full > c.rect.height + 1 {
        c.layer.mask = nil
        c.panel.frame = CGRect(x: c.rect.minX, y: c.rect.minY, width: c.rect.width, height: c.open?.full ?? c.full)
          .insetBy(dx: -0.6 * em(), dy: -0.6 * em())
        c.panel.shadowPath = CGPath(
          roundedRect: CGRect(origin: .zero, size: c.panel.bounds.size), cornerWidth: c.panel.cornerRadius,
          cornerHeight: c.panel.cornerRadius, transform: nil)
        c.panel.isHidden = false
      }
      placeSummaryButtons(c)
    }
    if c.full > c.rect.height + 1 { fade(c.panel, to: 1, duration: 0.14) }
  }

  /// The board's summary font size (S)
  private func em() -> CGFloat { CGFloat(summaryLayout?.font ?? 60) }

  private func fade(_ l: CALayer, to o: Float, duration: CFTimeInterval) {
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = l.presentation()?.opacity ?? l.opacity
    a.toValue = o
    a.duration = duration
    a.timingFunction = CAMediaTimingFunction(name: o > 0 ? .easeOut : .easeIn)
    withoutAnimation { l.opacity = o }
    l.add(a, forKey: "fade")
    if o == 0 {
      DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak l] in
        if l?.opacity == 0 { l?.isHidden = true }
      }
    }
  }

  /// ↻ (an AI key set), the stale dot on it, ✓ 保留 (stale): 20 view points, after the title's last line, kept that size
  /// at any zoom
  func placeSummaryButtons(_ c: SummaryColumn) {
    summaryButtons.removeFromSuperlayer()
    summaryButtons.sublayers = nil
    guard let doc = document else { return }
    let pending = doc.board.summary(for: c.col.key) != nil && c.text.stale
    let writing = summaryWriting.contains(c.col.key)
    guard summaryWriter != nil || pending else { return }
    let z = camera.zoom
    let k = 1 / z
    let ink = theme.ink
    var x: CGFloat = 0
    func button(_ path: CGPath, dot: Bool, spin: Bool) {
      let b = CALayer()
      b.frame = CGRect(x: x, y: -10, width: 20, height: 20)
      b.cornerRadius = 10
      b.backgroundColor = theme.surface.copy(alpha: 0.8)
      let icon = CAShapeLayer()
      icon.frame = CGRect(x: 3.5, y: 3.5, width: 13, height: 13)
      var t = CGAffineTransform(scaleX: 13 / 16, y: 13 / 16)
      icon.path = path.copy(using: &t)
      icon.fillColor = nil
      icon.strokeColor = ink.copy(alpha: 0.55)
      icon.lineWidth = 1.7 * 13 / 16
      icon.lineCap = .round
      icon.lineJoin = .round
      b.addSublayer(icon)
      if spin {
        let r = CABasicAnimation(keyPath: "transform.rotation.z")
        r.fromValue = 0
        r.toValue = 2 * Double.pi
        r.duration = 1
        r.repeatCount = .infinity
        icon.add(r, forKey: "spin")
      }
      if dot {
        let d = CALayer()
        d.frame = CGRect(x: 15, y: 0, width: 5, height: 5)
        d.cornerRadius = 2.5
        d.backgroundColor = theme.accent
        b.addSublayer(d)
      }
      summaryButtons.addSublayer(b)
      x += 24
    }
    if summaryWriter != nil { button(SummaryIcons.rewrite, dot: pending, spin: writing) }
    if pending, !writing { button(SummaryIcons.keep, dot: summaryWriter == nil, spin: false) }
    let end = c.open?.titleEnd ?? c.titleEnd
    // 0.3em of the title's font after its end
    let at = CGPoint(x: c.rect.minX + end.x + 0.3 * 0.8 * em(), y: c.rect.minY + end.y)
    summaryButtons.anchorPoint = CGPoint(x: 0, y: 0.5)
    summaryButtons.bounds = CGRect(x: 0, y: -10, width: x, height: 20)
    summaryButtons.position = at
    summaryButtons.setAffineTransform(CGAffineTransform(scaleX: k, y: k))
    summaryButtons.zPosition = 4
    summaryLayer.addSublayer(summaryButtons)
  }

  /// Which of the hovered column's buttons is under a board point
  func summaryButton(at p: CGPoint) -> (key: SummaryKey, keep: Bool)? {
    guard let k = summaryHover, summaryButtons.superlayer != nil else { return nil }
    let local = summaryButtons.convert(p, from: summaryLayer)
    for (i, b) in (summaryButtons.sublayers ?? []).enumerated() where b.frame.insetBy(dx: -2, dy: -2).contains(local) {
      return (k, summaryWriter == nil || i == 1)
    }
    return nil
  }

  // MARK: Clicks

  /// A press at the summary level: a column, else one of the cards shown there as they are (sub-boards, Texts, Boxes),
  /// pressed and dragged as at the card level, else the canvas (a marquee over those cards)
  func pressAtSummaries(_ e: NSEvent, view v: CGPoint, board p: CGPoint, _ doc: BoardDocument) {
    if pressSummary(e, view: v, board: p) { return }
    let item = hitCard(p).map { Item.card($0) }
    if e.clickCount >= 2 {
      if item != nil { doubleClick(at: p) }
      return
    }
    let toggle = !e.modifierFlags.isDisjoint(with: [.shift, .command])
    let was = item.map(doc.selection.contains) ?? false
    if let item, !was { doc.select(toggle ? doc.selection.union([item]) : [item]) }
    gesture = Gesture(kind: .press(item: item, toggle: toggle, wasSelected: was, inside: nil), startView: v, start: p)
  }

  /// The level shown changed: at the summaries, what was being written is kept, only the cards still there stay
  /// selected, and the card level's popups go; at the cards, a summary being written is kept
  func levelChanged() {
    hoverSummary(nil)
    summaryPress = nil
    if levels.level == .summaries {
      if editing != nil { Task { await endEditing() } }
      endInPlace(commit: true)
      if openPop != nil { openPop(nil) }
      closeRefPeek()
      cancelPlacing()
      closeStickerPalette()
      if let doc = document, let s = scene {
        let kept = Set(
          s.items.filter(\.kept).compactMap { it -> Item? in
            if case .card(let id)? = it.owner { .card(id) } else { nil }
          })
        let keep = doc.selection.intersection(kept)
        if keep != doc.selection { doc.select(keep) }
      }
    } else {
      endSummaryEdit(commit: true)
    }
    drawChrome()
  }

  /// A press at the summary level: a column's button, its body (edited on release when it did not move), its title
  /// (a double-click flies to it). False: not on a column
  func pressSummary(_ e: NSEvent, view v: CGPoint, board p: CGPoint) -> Bool {
    if let b = summaryButton(at: p) {
      if e.clickCount == 1 { b.keep ? keepSummary(b.key) : rewriteSummary(b.key) }
      return true
    }
    guard let i = summaryColumn(at: p) else { return false }
    let c = summaryColumns[i]
    let bodyTop = (summaryHover == c.col.key ? c.open?.bodyTop : nil) ?? c.bodyTop
    if p.y < c.rect.minY + bodyTop {
      if e.clickCount == 2 { zoomToSummary(c.col.key) }
      return true
    }
    if e.clickCount == 1, !summaryWriting.contains(c.col.key), c.text.text != nil { summaryPress = (c.col.key, v) }
    return true
  }

  /// The press let go: a body clicked without moving more than 4 points is edited
  func releaseSummary(at v: CGPoint) -> Bool {
    guard let (key, from) = summaryPress else { return false }
    summaryPress = nil
    if hypot(v.x - from.x, v.y - from.y) <= 4 { editSummary(key) }
    return true
  }

  /// Double-click on a title (interact.ts zoomToSummary): a card at 100 %, its top left at (24, 72) and centred across
  /// when narrower than the view; a Section's frame, or its own cards, fitted at 100 % at most
  func zoomToSummary(_ key: SummaryKey) {
    guard let s = scene else { return }
    var target: Camera?
    switch key {
    case .card(let id):
      if let i = index(of: .card(id)) {
        let r = s.items[i].rect
        let x = 24 + max(0, (bounds.width - 48 - r.width) / 2)
        target = Camera(origin: CGPoint(x: r.minX - x, y: r.minY - 72), zoom: 1)
      }
    case .section(let id):
      if let f = s.frames.first(where: { $0.id == id }) { target = fitRect(f.rect, maxZoom: 1) }
    case .own(let id):
      let mine = document?.board.cards.filter { $0.section == id }.compactMap { c in index(of: .card(c.id)) } ?? []
      let r = mine.map { s.items[$0].rect }.reduce(CGRect.null) { $0.union($1) }
      if !r.isNull {
        target = fitRect(r, maxZoom: 1)
      } else if let f = s.frames.first(where: { $0.id == id }) {
        target = fitRect(f.rect, maxZoom: 1)
      }
    }
    guard let target else { return }
    hoverSummary(nil)
    motion.fly(to: target)
    moved()
  }

  // MARK: Editing

  /// The body written in place, with its bold as bold (⌘B); Enter keeps it, Esc leaves it, leaving the field keeps it
  package func editSummary(_ key: SummaryKey) {
    guard let doc = document, let i = summaryColumns.firstIndex(where: { $0.col.key == key }),
      let host = superview, let sum = doc.board.summary(for: key)
    else { return }
    endSummaryEdit(commit: true)
    // written in place on its picture at rest (a whole title folds back to two lines)
    hoverSummary(nil)
    let c = summaryColumns[i]
    let em = CGFloat(summaryLayout?.font ?? 60)
    var look = SummaryLook(theme)
    look.layout = CGFloat(summaryLayout?.cut ?? 0.3)
    let ed = SummaryEditor(frame: .zero)
    ed.key = key
    ed.before = sum.text
    ed.look = look
    ed.em = em
    ed.onEnd = { [weak self] commit in self?.endSummaryEdit(commit: commit) }
    ed.load(sum.text)
    summaryEditor = ed
    cropForEdit(c)
    host.addSubview(ed.ring, positioned: .above, relativeTo: self)
    host.addSubview(ed, positioned: .above, relativeTo: ed.ring)
    placeSummaryEditor()
    window?.makeFirstResponder(ed)
    ed.setSelectedRange(NSRange(location: ed.string.utf16.count, length: 0))
  }

  /// The body's place while it is written: the picture shows only its title row
  func cropForEdit(_ c: SummaryColumn) {
    withoutAnimation {
      c.layer.mask = nil
      c.layer.contentsRect = CGRect(x: 0, y: 0, width: 1, height: c.bodyTop / c.full)
      c.layer.bounds.size.height = c.bodyTop
      c.panel.isHidden = true
      summaryButtons.removeFromSuperlayer()
    }
  }

  /// The editor over the body at the zoom shown
  func placeSummaryEditor() {
    guard let ed = summaryEditor, let host = superview,
      let c = summaryColumns.first(where: { $0.col.key == ed.key })
    else { return }
    let z = camera.zoom
    let pad = CGFloat(summaryLayout?.padding ?? 20)
    let r = CGRect(
      x: c.rect.minX + pad, y: c.rect.minY + c.bodyTop, width: c.rect.width - 2 * pad,
      height: max(c.full - c.bodyTop - pad, 1.5 * ed.em))
    let v = CGRect(origin: camera.view(r.origin), size: CGSize(width: r.width * z, height: r.height * z))
    ed.zoom = z
    ed.frame = convert(v, to: host)
    ed.restyle()
  }

  /// The edit kept (one step: Edit Summary) or left
  func endSummaryEdit(commit: Bool) {
    guard let ed = summaryEditor else { return }
    summaryEditor = nil
    let text = ed.markdown()
    ed.onEnd = nil
    if window?.firstResponder === ed { window?.makeFirstResponder(self) }
    ed.removeFromSuperview()
    ed.ring.removeFromSuperview()
    if commit, let doc = document, let (vb, vault) = shown {
      let package = vault.url(of: vb.path)
      let key = ed.key
      let now = (Date().timeIntervalSince1970 * 1000).rounded()
      var b = doc.board
      if b.editSummary(
        key, text: text, now: now, contents: { Scene.content(of: $0, package: package, vault: vault)?.0 })
      {
        // shown at once (the board's own refresh follows; nothing it shows moved)
        doc.edit("Edit Summary") { $0 = b }
      }
    }
    summariesChanged()
  }

  /// ✓ 保留: the summary kept as written for what changed (one step)
  func keepSummary(_ key: SummaryKey) {
    guard let doc = document, let (vb, vault) = shown else { return }
    let package = vault.url(of: vb.path)
    var b = doc.board
    if b.keepSummary(key, contents: { Scene.content(of: $0, package: package, vault: vault)?.0 }) {
      doc.edit("Keep Summary") { $0 = b }
    }
  }

  // MARK: ↻

  /// The AI writes this one summary again: it breathes meanwhile; the answer is one step (Rewrite Summary); a failure
  /// leaves the old text as it was
  func rewriteSummary(_ key: SummaryKey) {
    guard let doc = document, let writer = summaryWriter, !summaryWriting.contains(key), let (vb, vault) = shown
    else { return }
    let package = vault.url(of: vb.path)
    let contents: CardContents = { Scene.content(of: $0, package: package, vault: vault)?.0 }
    let board = doc.board
    guard board.summaryRequest(key, contents: contents) != nil else { return }
    summaryWriting.insert(key)
    breathe(key, true)
    weak var d = doc
    Task { [weak self] in
      // the examples: the user's own edits on every board of the vault (main: every board the host has read), this one
      // as it is now
      let others = await Task.detached(priority: .userInitiated) {
        ((try? vault.tree().allBoards) ?? []).filter { $0.id != board.id }.compactMap { try? vault.board(at: $0.path) }
      }.value
      let examples = summaryExamples([board] + others, n: 4, but: (board.id, key))
      let r: Result<Summary, SummaryFailure>
      if let req = board.summaryRequest(key, examples: examples, contents: contents) {
        r = await summarize(req, with: writer, now: (Date().timeIntervalSince1970 * 1000).rounded())
      } else {
        r = .failure(.http("gone"))
      }
      guard let self else { return }
      summaryWriting.remove(key)
      // a failure leaves the text as it was
      if case .success(let s) = r, let d { d.edit("Rewrite Summary") { _ = $0.putSummary(s, for: key) } }
      if document === d {
        breathe(key, false)
        if let i = summaryColumns.firstIndex(where: { $0.col.key == key }), summaryHover == key {
          placeSummaryButtons(summaryColumns[i])
        }
      }
    }
    if let i = summaryColumns.firstIndex(where: { $0.col.key == key }), summaryHover == key {
      placeSummaryButtons(summaryColumns[i])
    }
  }

  /// A column being written: its text breathes (1 → 0.3 → 1 over 1.1 s, .gen)
  func breathe(_ key: SummaryKey, _ on: Bool) {
    guard let c = summaryColumns.first(where: { $0.col.key == key }) else { return }
    guard on else {
      c.layer.removeAnimation(forKey: "breathe")
      return
    }
    let a = CAKeyframeAnimation(keyPath: "opacity")
    a.values = [1, 0.3, 1]
    a.keyTimes = [0, 0.5, 1]
    a.duration = 1.1
    a.repeatCount = .infinity
    a.timingFunctions = [CAMediaTimingFunction(name: .easeInEaseOut), CAMediaTimingFunction(name: .easeInEaseOut)]
    c.layer.add(a, forKey: "breathe")
  }
}

/// The summary buttons' icons (Summaries.tsx), in a 16-unit box
enum SummaryIcons {
  static var rewrite: CGPath {
    let p = CGMutablePath()
    // M13.2 9.4 A5.4 5.4 0 1 1 11.6 4: the arc around (8, 8)
    let c = CGPoint(x: 8.0, y: 8.0)
    let a0 = atan2(9.4 - 8.0, 13.2 - 8.0)
    let a1 = atan2(4 - 8.0, 11.6 - 8.0)
    p.addArc(center: c, radius: 5.4, startAngle: a0, endAngle: a1, clockwise: false)
    p.move(to: CGPoint(x: 12.4, y: 1.6))
    p.addLine(to: CGPoint(x: 12.4, y: 4.8))
    p.addLine(to: CGPoint(x: 9.2, y: 4.8))
    return p
  }
  static var keep: CGPath {
    let p = CGMutablePath()
    p.move(to: CGPoint(x: 3.2, y: 8.6))
    p.addLine(to: CGPoint(x: 6.3, y: 11.7))
    p.addLine(to: CGPoint(x: 12.8, y: 4.7))
    return p
  }
}

extension SumRect {
  init(_ r: CGRect) { self.init(x: Double(r.minX), y: Double(r.minY), w: Double(r.width), h: Double(r.height)) }
}

/// The body being written: rich text with its bold, read back as **…** (Summaries.tsx readBack)
final class SummaryEditor: NSTextView {
  var key = SummaryKey.card(CardID(rawValue: ""))
  var before = ""
  var look: SummaryLook?
  var em: CGFloat = 60
  var zoom: CGFloat = 1
  var onEnd: ((Bool) -> Void)?
  /// Behind the field: its paper and ring
  let ring = NSView()

  func load(_ text: String) {
    guard let look else { return }
    let s = NSMutableAttributedString(attributedString: SummaryArt.bodyString(text, look: look, font: em))
    textStorage?.setAttributedString(s)
    isRichText = true
    allowsUndo = true
    drawsBackground = false
    textContainerInset = .zero
    textContainer?.lineFragmentPadding = 0
    wantsLayer = true
  }

  /// The look at the zoom shown: its sizes are view points here, not board units
  private var shownLook: SummaryLook? {
    guard var l = look else { return nil }
    l.layout /= zoom
    return l
  }

  /// Fonts and line heights at the zoom shown
  func restyle() {
    guard let look = shownLook, let ts = textStorage else { return }
    let size = em * zoom
    ts.beginEditing()
    ts.enumerateAttribute(.font, in: NSRange(location: 0, length: ts.length)) { v, r, _ in
      let bold = (v as? NSFont).map { $0.fontDescriptor.symbolicTraits.contains(.bold) || isHeavy($0) } ?? false
      ts.addAttribute(.font, value: SummaryArt.body(look, size, bold: bold) as NSFont, range: r)
      ts.addAttribute(.foregroundColor, value: NSColor(cgColor: bold ? look.ink : look.grey) ?? .textColor, range: r)
    }
    ts.addAttribute(
      .paragraphStyle, value: SummaryArt.paragraph(lineHeight: 1.5 * size),
      range: NSRange(location: 0, length: ts.length))
    ts.endEditing()
    typingAttributes = [
      .font: SummaryArt.body(look, size, bold: false) as NSFont,
      .foregroundColor: NSColor(cgColor: look.grey) ?? .textColor,
      .paragraphStyle: SummaryArt.paragraph(lineHeight: 1.5 * size),
    ]
    insertionPointColor = NSColor(cgColor: look.ink) ?? .textColor
    // the field's paper and its ring, outside the text as main's box-shadow spread: a view of their own behind it
    let r = 0.12 * size
    ring.wantsLayer = true
    ring.layer?.backgroundColor = look.panel.copy(alpha: 0.8)
    ring.layer?.cornerRadius = 0.08 * size + r
    ring.layer?.borderWidth = r
    ring.layer?.borderColor = look.accent.copy(alpha: 0.45)
    ring.frame = frame.insetBy(dx: -r, dy: -r)
  }

  private func isHeavy(_ f: NSFont) -> Bool {
    let w = (f.fontDescriptor.object(forKey: .traits) as? [NSFontDescriptor.TraitKey: Any])?[.weight] as? CGFloat ?? 0
    return w >= NSFont.Weight.semibold.rawValue
  }

  /// The text as stored: bold runs as **…**, no-break spaces as spaces, empty bold dropped, trimmed
  func markdown() -> String {
    guard let ts = textStorage else { return string }
    var out = ""
    ts.enumerateAttribute(.font, in: NSRange(location: 0, length: ts.length)) { v, r, _ in
      let part = (ts.string as NSString).substring(with: r)
      let bold = (v as? NSFont).map { $0.fontDescriptor.symbolicTraits.contains(.bold) || isHeavy($0) } ?? false
      out += bold && !part.trimmingCharacters(in: .whitespaces).isEmpty ? "**\(part)**" : part
    }
    return out.replacingOccurrences(of: "\u{a0}", with: " ").replacingOccurrences(of: "\n", with: " ")
      .replacingOccurrences(of: #"\*\*(\s*)\*\*"#, with: "$1", options: .regularExpression).trimmingCharacters(
        in: .whitespacesAndNewlines)
  }

  /// ⌘B: the selection bold or not
  func toggleBold() {
    guard let look = shownLook, let ts = textStorage else { return }
    let r = selectedRange()
    guard r.length > 0 else { return }
    let size = em * zoom
    let f = ts.attribute(.font, at: r.location, effectiveRange: nil) as? NSFont
    let bold = !(f.map { $0.fontDescriptor.symbolicTraits.contains(.bold) || isHeavy($0) } ?? false)
    ts.addAttribute(.font, value: SummaryArt.body(look, size, bold: bold) as NSFont, range: r)
    ts.addAttribute(.foregroundColor, value: NSColor(cgColor: bold ? look.ink : look.grey) ?? .textColor, range: r)
  }

  override func keyDown(with e: NSEvent) {
    if e.keyCode == 53 {
      onEnd?(false)
      return
    }
    if e.keyCode == 36 || e.keyCode == 76, !e.modifierFlags.contains(.shift), !hasMarkedText() {
      onEnd?(true)
      return
    }
    if e.modifierFlags.contains(.command), e.charactersIgnoringModifiers?.lowercased() == "b" {
      toggleBold()
      return
    }
    super.keyDown(with: e)
  }

  override func resignFirstResponder() -> Bool {
    let r = super.resignFirstResponder()
    if r, let end = onEnd {
      DispatchQueue.main.async { end(true) }
    }
    return r
  }
}

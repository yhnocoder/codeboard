import AppKit
import CodeBoardModel
import CodeBoardNotes

// A card header's hover buttons (CodeHead.tsx and NoteBody.tsx .hov, styles.css .chead > .hov): a code card's Fit
// Content, Wrap Lines (in the accent when on), Copy Code and, on Free code, its language; a Note's Fit Content and Split by
// Headings (faint when they have nothing to do). They show while the card is hovered or selected, fading in over 150 ms
// and out over 160, and the title gives way for them; the ··· (.cmenu) fades with them in the place the header keeps for
// it. The bottom-right grip (.grip::after) shows while the card is hovered. Both are drawn in the card's own layer, so
// they move, lift and tilt with it. A button acts on the release over it.

/// A button of a card's header
enum HeadAct: Hashable {
  case fit, wrap, copy, lang, split, more
  /// A Web card's Open in Browser
  case open
  /// A locked card's lock, first in its header (.lockb): Unlock
  case unlock
  /// A hovered Link List row's tools (.ltools): Show as Compact / Rich, Open in Browser, Remove from List
  case row(String, RowTool)
}

enum RowTool: CaseIterable {
  case rich, open, remove
}

extension CanvasView {
  /// What a card's header shows: its buttons in card points, the room the hover ones take, what they say
  struct Head {
    var drawing: Drawing
    var buttons: [(HeadAct, CGRect)]
    var reserve: CGFloat
    var on: Set<HeadAct> = []
    var faint: Set<HeadAct> = []
    var lang: String?
    /// How many cards Split by Headings makes (0: none)
    var parts = 0
    /// A Web card's: its two buttons on glass over its top right corner (.wacts), no header behind them
    var floating = false
    /// A Note written in whose header is its heading: the header folds away under the editor, which draws the heading,
    /// and only its ··· stays (.chead.fold > .ib)
    var folded = false
  }

  /// The language picker's languages and the label of any language (analysis langs.ts LANG_TABLE, those picked first)
  static let languages: [(id: String, label: String, pick: Bool)] = [
    ("python", "Python", true), ("triton", "Triton", true), ("tilelang", "TileLang", true), ("cuda-cpp", "CUDA", true),
    ("cpp", "C++", true), ("c", "C", true), ("rust", "Rust", true), ("typescript", "TypeScript", true),
    ("javascript", "JavaScript", true), ("go", "Go", true), ("java", "Java", false), ("shellscript", "Shell", true),
    ("json", "JSON", false), ("yaml", "YAML", false), ("toml", "TOML", false), ("ini", "INI", false),
    ("sql", "SQL", false), ("lua", "Lua", false), ("ruby", "Ruby", false), ("r", "R", false), ("perl", "Perl", false),
    ("haskell", "Haskell", false), ("diff", "Diff", false), ("css", "CSS", false), ("html", "HTML", false),
    ("plaintext", "Plain Text", false),
  ]

  static func languageLabel(_ id: String) -> String { languages.first { $0.id == id }?.label ?? id }

  /// A card's header and its buttons; nil when it has none (unframed, a Text or Box, a Note folded as it is written in)
  func head(_ id: CardID) -> Head? {
    guard let doc = document, let s = scene, let i = index(of: .card(id)), let card = doc.board.card(id) else {
      return nil
    }
    let t = theme
    let it = s.items[i]
    let w = it.rect.width
    let y = t.headerHeight / 2 - 13
    let more = (HeadAct.more, CGRect(x: w - t.headerPadRight - 26, y: y, width: 26, height: 26))
    var right: CGFloat
    var acts: [HeadAct]
    var h: Head
    switch it.drawing {
    case .web:
      // ↗ and ⋯ over the top right corner, 22 square, 7 in, 2 apart (web.css .wacts)
      var h = Head(drawing: it.drawing, buttons: [], reserve: 0, floating: true)
      h.buttons = [
        (.open, CGRect(x: w - 7 - 22 - 2 - 22, y: 7, width: 22, height: 22)),
        (.more, CGRect(x: w - 7 - 22, y: 7, width: 22, height: 22)),
      ]
      return h
    case .links:
      // its ···: its title keeps clear of it already; the hovered row's tools
      return Head(drawing: it.drawing, buttons: [more] + rowTools(id), reserve: 0)
    case .code(let c) where c.framed:
      guard case .code(let code)? = s.parts[id]?.content.body, let seg = code.segments.first else { return nil }
      let free = doc.board.isFreeCode(id)
      acts = [.fit, .wrap, .copy] + (free ? [.lang] : [])
      h = Head(drawing: it.drawing, buttons: [], reserve: 0, on: code.wrap ? [.wrap] : [])
      if free { h.lang = CanvasView.languageLabel(seg.language) }
      right = Drawing.headerRight(c, width: w, t)
    case .note(let n):
      guard case .note = n.content, !n.folded, case .note(let note)? = s.parts[id]?.content.body else { return nil }
      // as showPaper folds it
      if n.hideHead, let ed = editing, ed.id == id, ed.ready, !ed.ending {
        return Head(drawing: it.drawing, buttons: [more], reserve: 0, folded: true)
      }
      acts = [.fit, .split]
      let parts = HeadingSplit(note.text)?.parts.count ?? 0
      h = Head(drawing: it.drawing, buttons: [], reserve: 0, parts: parts)
      if card.height == nil { h.faint.insert(.fit) }
      if parts == 0 { h.faint.insert(.split) }
      right = Drawing.headerRight(nil, width: w, t)
    default:
      return nil
    }
    // right to left, 2 apart (.hov > span gap), anchored right; the title gives way for them and the gap before them
    var x = right
    var buttons: [(HeadAct, CGRect)] = []
    for a in acts.reversed() {
      if a == .lang, let label = h.lang {
        let lw = (Drawing.width(label, HeadActs.langFont) + 10).rounded(.up)
        x -= lw
        buttons.append((a, CGRect(x: x, y: t.headerHeight / 2 - 9, width: lw, height: 18)))
      } else {
        x -= 26
        buttons.append((a, CGRect(x: x, y: y, width: 26, height: 26)))
      }
      x -= 2
    }
    // a locked card's lock first, left of its title (.lockb)
    let locked =
      switch it.drawing {
      case .code(let c): c.locked
      case .note(let n): n.locked
      default: false
      }
    let lockb = CGRect(x: t.headerPad, y: t.headerHeight / 2 - 9, width: 18, height: 18)
    h.buttons = (locked ? [(.unlock, lockb)] : []) + buttons.reversed() + [more]
    h.reserve = right - (x + 2) + t.headerGap
    return h
  }

  /// The cards whose header buttons show: the one hovered and those selected (.card:hover, .card.sel)
  var headCards: Set<CardID> {
    guard levels.level == .cards, let doc = document else { return [] }
    var ids = Set(doc.selection.compactMap(\.card))
    if let h = hoveredCard { ids.insert(h) }
    return ids
  }

  /// The header button under a board point, of a card showing them and on top there
  func headAct(at p: CGPoint) -> (CardID, HeadAct)? {
    // the card under the pointer is the one hovered: its buttons are there to be found as it comes under it
    guard levels.level == .cards, let id = hitCard(p), let h = head(id), let i = index(of: .card(id)) else {
      return nil
    }
    let box = items[i].box
    let local = box.convert(p, from: box.superlayer)
    return h.buttons.first { $0.1.contains(local) }.map { (id, $0.0) }
  }

  /// What a button does
  func press(_ a: HeadAct, of id: CardID) {
    guard let doc = document, let h = head(id) else { return }
    switch a {
    case .fit: if !h.faint.contains(.fit) { fitCards([id]) }
    case .wrap: toggleWrap([id])
    case .copy: copyCode(id)
    case .unlock: doc.edit("Unlock") { $0.setLocked([.card(id)], false) }
    case .row(let item, let tool): pressRowTool(id, item, tool)
    case .split: if !h.faint.contains(.split) { splitByHeadings(id) }
    case .open:
      if case .own(let k)? = doc.board.card(id)?.content, case .web(let w) = k.body { openLink(w.url) }
    case .lang, .more:
      guard let r = h.buttons.first(where: { $0.0 == a })?.1, let i = index(of: .card(id)) else { return }
      // under the button (main's below(el)), in the view
      let box = items[i].box
      let under = box.convert(CGPoint(x: r.minX, y: r.maxY + 4), to: box.superlayer)
      let v = camera.view(under)
      if a == .more {
        showMenu(cardMenu(id, at: CGPoint(x: under.x, y: under.y)), v)
      } else {
        Task { [weak self] in
          guard let self, let m = await self.languageMenu(id), self.document === doc else { return }
          self.showMenu(m, v)
        }
      }
    }
  }

  /// Copy Code: the lines the card shows, one under the other (edit.ts copyCard, clipboard.ts cardText)
  func copyCode(_ id: CardID) {
    guard let p = scene?.placed[id]?.code, case .code(let code)? = scene?.parts[id]?.content.body else { return }
    var lines: [String] = []
    for r in p.layout.rows {
      guard case .line(let si, let n?, _, _) = r.row, si < code.segments.count else { continue }
      let s = code.segments[si]
      let k = n - s.firstLine
      lines.append(s.lines.indices.contains(k) ? s.lines[k] : "")
    }
    pasteboard.clearContents()
    pasteboard.setString(lines.joined(separator: "\n"), forType: .string)
    lastCopy = (id, lines.joined(separator: "\n"), 0)
    toast("Copied \(lines.count) lines")
  }

  /// Free code's languages (edit.ts langMenu): Auto-detect, with what its text looks like, then the languages to pick
  func languageMenu(_ id: CardID) async -> NSMenu? {
    guard let doc = document, let s = doc.board.freeCodeSegment(id) else { return nil }
    let auto = try? await notes.freeLanguage(s.lines.joined(separator: "\n"))
    let picked = s.languagePicked == true
    let m = NSMenu()
    m.addItem(
      menuItem(auto.map { "Auto-detect (\(CanvasView.languageLabel($0)))" } ?? "Auto-detect", checked: !picked) {
        [weak self] in self?.setLanguage(id, nil, guessed: auto)
      })
    m.addItem(.separator())
    for l in CanvasView.languages where l.pick {
      m.addItem(menuItem(l.label, checked: picked && s.language == l.id) { [weak self] in self?.setLanguage(id, l.id) })
    }
    return m
  }

  /// A language picked, or (nil) Free code follows its text again (commands/code.ts setCodeLang)
  func setLanguage(_ id: CardID, _ lang: String?, guessed: String? = nil) {
    document?.edit("Change Language") { $0.setFreeCodeLanguage(id, lang, guessed: guessed) }
  }

  /// Split by Headings (notes.ts splitByHeadings): the Note and its parts measured as they will be drawn, then cut in
  /// one step, the Note and its new cards selected
  func splitByHeadings(_ id: CardID) {
    guard let doc = document, let (vb, vault) = shown, let c = doc.board.card(id), case .own(let k) = c.content,
      case .note(let note) = k.body, let sp = HeadingSplit(note.text)
    else { return }
    let package = vault.root.appending(path: vb.path)
    let refs = RefResolver(doc.board, package: package, vault: vault)
    func measure(_ md: String) -> Scene.Measure {
      let n = Note(text: md)
      return Scene.Measure(
        card: c.id, note: .note(n), width: c.width, folder: package, refs: refs.refs(in: md),
        hideHead: CardContent(body: .note(n)).hidesHeading)
    }
    let others = (scene?.items ?? []).compactMap { it -> (x: Double, y: Double, w: Double, h: Double)? in
      guard case .card(let o)? = it.owner, o != id else { return nil }
      return (Double(it.rect.minX), Double(it.rect.minY), Double(it.rect.width), Double(it.rect.height))
    }
    let theme = theme
    let display = display
    Task { [weak self] in
      if self?.editing?.id == id { await self?.endEditing() }
      var hs: [Double] = []
      for md in [sp.pre] + sp.parts.map(\.md) {
        let m = await CanvasView.measure([measure(md)], theme: theme, display: display)[c.id]
        hs.append(m.map { Double($0.size.height) } ?? 0)
      }
      guard let self, self.document === doc else { return }
      let measured = hs.allSatisfy { $0 > 0 } ? (root: hs[0], parts: Array(hs.dropFirst())) : nil
      var made: [CardID] = []
      doc.edit("Split by Headings") { b in made = b.splitNoteByHeadings(id, heights: measured, others: others) ?? [] }
      guard !made.isEmpty else { return }
      doc.select(Set(([id] + made).map(Item.card)))
      self.toast("Split into \(made.count) card\(made.count > 1 ? "s" : ""). ⌘Z undoes it")
    }
  }

  /// What a button says when the pointer rests on it (its data-tip and data-kbd)
  func headTip(_ a: HeadAct, _ h: Head) -> Tip {
    switch a {
    case .fit:
      Tip(
        h.faint.contains(.fit) ? "Fit Content · already as tall as its content" : "Fit Content",
        kbd: BoardKey.show(of: "Fit Content"))
    case .wrap: Tip("Wrap Lines", kbd: BoardKey.show(of: "Wrap Lines"))
    case .copy: Tip("Copy Code")
    case .lang: Tip("Change Language")
    case .split:
      Tip(
        h.parts > 0
          ? "Split by Headings · \(h.parts + 1) cards, linked by arrows" : "Split by Headings · no headings to split at"
      )
    case .more: Tip("More Actions")
    case .open: Tip("Open in Browser", kbd: "Double-click")
    case .unlock: Tip("Unlock", kbd: BoardKey.show(of: "Lock / Unlock"))
    case .row(let item, let tool):
      switch tool {
      case .rich: Tip(isRichRow(h.drawing, item) ? "Show as Compact" : "Show as Rich")
      case .open: Tip("Open in Browser")
      case .remove: Tip("Remove from List")
      }
    }
  }

  /// The header button under the pointer, lit, and what it says
  func hoverHead(_ on: (CardID, HeadAct)?) {
    guard on?.0 != hoveredHead?.0 || on?.1 != hoveredHead?.1 else { return }
    hoveredHead = on
    showTip()
    drawChrome()
  }

  /// The canvas's one tip (main's TooltipLayer): of the header button, Section control or port under the pointer
  func showTip() {
    func inView(_ r: CGRect) -> CGRect {
      let (a, b) = (camera.view(CGPoint(x: r.minX, y: r.minY)), camera.view(CGPoint(x: r.maxX, y: r.maxY)))
      return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }
    var tip: (Tip, CGRect)?
    if let (id, a) = hoveredHead, let h = head(id), let r = h.buttons.first(where: { $0.0 == a })?.1,
      let i = index(of: .card(id))
    {
      let box = items[i].box
      tip = (headTip(a, h), inView(box.convert(r, to: box.superlayer)))
    } else if let id = hoveredTitle, let a = hoveredAct, let t = sectionTip(a, of: id),
      let r = actsLayout(id).first(where: { $0.0 == a })?.1
    {
      tip = (t, inView(r))
    } else {
      tip = portTip()
    }
    tips.hover(tip?.0, tip?.1 ?? .zero, in: self, theme: theme)
  }

  /// The header strips and grips of the cards showing them, in the cards' own layers (drawChrome calls this)
  func placeHeadActs() {
    let want = headCards
    let scale = (restZoom ?? camera.zoom) * backing
    for (id, shown) in headShown where !want.contains(id) || index(of: .card(id)) == nil {
      headShown[id] = nil
      fadeOut(shown.layer, over: shown.out)
    }
    for id in want {
      guard let i = index(of: .card(id)), let h = head(id) else {
        if let shown = headShown.removeValue(forKey: id) { shown.layer.removeFromSuperlayer() }
        continue
      }
      let box = items[i].box
      let hovered = hoveredHead?.0 == id ? hoveredHead?.1 : nil
      let size = box.bounds.size
      let key =
        "\(h.drawing) \(h.folded) \(h.on) \(h.faint) \(String(describing: hovered)) \(size) \(theme.id) \(theme.dark) \(scale)"
      let l: CALayer
      if let shown = headShown[id] {
        l = shown.layer
        // the card's layers were made again (a redraw, the paper it shows while written in): onto the new ones as it is
        if l.superlayer !== box { box.addSublayer(l) }
        if shown.key == key { continue }
      } else {
        l = CALayer()
        l.zPosition = 3.5
        box.addSublayer(l)
        // .chead > .hov: opacity over 150 ms
        let a = CABasicAnimation(keyPath: "opacity")
        a.fromValue = 0
        a.duration = h.floating ? 0.12 : 0.15
        if !h.floating { a.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1) }
        l.add(a, forKey: "in")
      }
      let strip = CGRect(x: 0, y: 0, width: size.width, height: theme.headerHeight)
      l.frame = strip
      l.contentsGravity = .resize
      l.contents = CanvasView.picture(size: strip.size, scale: scale) { ctx in
        HeadActs.draw(h, card: size, hovered: hovered, theme, ctx)
      }
      headShown[id] = (l, key, h.floating ? 0.12 : 0.16)
    }
    placeGrip()
    placeRowHover()
  }

  /// The hovered card's grip (.grip::after): 1.5 of ink-3 round the corner, concentric with the card's, at 0.7; none on
  /// a locked card, a Text or a Box (theirs are their own handles)
  private func placeGrip() {
    let id = hoveredCard.flatMap { id -> CardID? in
      guard levels.level == .cards, let doc = document, !doc.board.isLocked(.card(id)), !isText(id) else { return nil }
      return id
    }
    if let g = gripShown, g.id != id || index(of: .card(g.id)).map({ items[$0].box }) !== g.layer.superlayer {
      gripShown = nil
      fadeOut(g.layer, over: 0.12)
    }
    guard let id, gripShown == nil, let i = index(of: .card(id)) else { return }
    let box = items[i].box
    let l = CAShapeLayer()
    l.path = HeadActs.grip(box.bounds.size, radius: theme.cardRadius)
    l.strokeColor = theme.ink3
    l.fillColor = nil
    l.lineWidth = 1.5
    l.opacity = 0.7
    l.zPosition = 3.5
    box.addSublayer(l)
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = 0
    a.toValue = 0.7
    a.duration = 0.12
    l.add(a, forKey: "in")
    gripShown = (id, l)
  }

  private func fadeOut(_ l: CALayer, over d: CFTimeInterval) {
    CATransaction.begin()
    CATransaction.setCompletionBlock { MainActor.assumeIsolated { if l.opacity == 0 { l.removeFromSuperlayer() } } }
    let a = CABasicAnimation(keyPath: "opacity")
    a.fromValue = (l.presentation() ?? l).opacity
    a.toValue = 0
    a.duration = d
    l.opacity = 0
    l.add(a, forKey: "out")
    CATransaction.commit()
  }

  /// Puts a menu up at a view point (tests look at it instead)
  func showMenu(_ m: NSMenu, _ v: CGPoint) {
    if let menuShown { return menuShown(m, v) }
    m.popUp(positioning: nil, at: v, in: self)
  }
}

enum HeadActs {
  /// The language label's font: 500 10.5 mono (.chead .lang)
  static var langFont: Font {
    Font.board("JetBrainsMono-400-600", size: 10.5, weight: 500) ?? Font.mono(10.5, .medium)
  }

  static var wrap: CGPath { SVGPath.parse("M2 4h12M2 8h10a2 2 0 1 1 0 4H9M11 10l-2 2 2 2M2 12h4") }
  static var copy: CGPath {
    SVGPath.parse(
      "M6.5 6H13.5A.5 .5 0 0 1 14 6.5V13.5A.5 .5 0 0 1 13.5 14H6.5A.5 .5 0 0 1 6 13.5V6.5A.5 .5 0 0 1 6.5 6zM3 10H2.5A.5 .5 0 0 1 2 9.5V2.5A.5 .5 0 0 1 2.5 2H9.5A.5 .5 0 0 1 10 2.5V3"
    )
  }
  static var splitH: CGPath { SVGPath.parse("M2 2h12M2 5h8M1 8h2M5 8h2M9 8h2M13 8h2M2 11h12M2 14h8") }

  /// The header strip, card points from its top left: its own background inside its paddings (so the card's edge stays),
  /// its kind, title and chips again with the title giving way, then the buttons
  static func draw(_ h: CanvasView.Head, card size: CGSize, hovered: HeadAct?, _ t: Theme, _ ctx: CGContext) {
    let card = CGRect(origin: .zero, size: size)
    ctx.saveGState()
    ctx.clip(
      to: CGRect(
        x: t.headerPad - 4, y: 2, width: size.width - t.headerPadRight - (t.headerPad - 4), height: t.headerHeight - 4))
    // folded: the editor's heading shows through
    switch h.folded ? nil : h.drawing {
    case .code(let c)?:
      Drawing.paper(ctx, card, t, id: c.id, rule: false)
      Drawing.header(ctx, c, card, t, reserve: h.reserve)
    case .note(let n)?:
      Drawing.paper(ctx, card, t, id: n.id, rule: true)
      Drawing.noteHeader(ctx, n, width: size.width, t, reserve: h.reserve)
    default: break
    }
    ctx.restoreGState()
    for (a, r) in h.buttons {
      // drawn with the row (placeRowHover)
      if case .row = a { continue }
      let lit = hovered == a
      if h.floating {
        floating(a, in: r, lit: lit, t, ctx)
        continue
      }
      if a == .lang, let label = h.lang {
        if lit {
          ctx.addPath(CGPath(roundedRect: r, cornerWidth: 7, cornerHeight: 7, transform: nil))
          ctx.setFillColor(t.hlrow)
          ctx.fillPath()
        }
        Drawing.text(ctx, label, HeadActs.langFont, lit ? t.ink : t.ink3, x: r.minX + 5, midY: r.midY, width: .infinity)
        continue
      }
      if a == .unlock {
        // drawn with the header; lit: .lockb:hover, the row's tint behind it and the lock in the accent
        if lit {
          ctx.addPath(CGPath(roundedRect: r, cornerWidth: 5.5, cornerHeight: 5.5, transform: nil))
          ctx.setFillColor(t.hlrow)
          ctx.fillPath()
          Drawing.lock(ctx, in: r, t.accent)
        }
        continue
      }
      let faint = h.faint.contains(a)
      if lit && !faint {
        ctx.addPath(CGPath(roundedRect: r, cornerWidth: 8.5, cornerHeight: 8.5, transform: nil))
        ctx.setFillColor(t.ink.copy(alpha: 0.07) ?? t.hlrow)
        ctx.fillPath()
      }
      let ink = h.on.contains(a) ? t.accent : lit && !faint ? t.ink : t.ink2
      if a == .more {
        // three dots 3 across, 5 apart, as the toolbar's ⋯ (the 1-unit outline of icons.tsx more's squares, filled)
        ctx.setFillColor(ink)
        for k in -1...1 {
          ctx.fillEllipse(in: CGRect(x: r.midX + CGFloat(k) * 5 - 1.5, y: r.midY - 1.5, width: 3, height: 3))
        }
        continue
      }
      let path =
        switch a {
        case .fit: SectionActs.fit
        case .wrap: wrap
        case .copy: copy
        case .split: splitH
        case .more, .lang, .open, .unlock, .row: CGMutablePath()
        }
      ctx.saveGState()
      if faint { ctx.setAlpha(0.35) }
      Icons.stroke(path, at: CGPoint(x: r.midX - 8, y: r.midY - 8), color: ink, in: ctx)
      ctx.restoreGState()
    }
  }

  /// A Web card's button: glass in a hairline ring, its icon ink-2, ink when hovered (web.css .wacts .ib); ↗ at 13, ⋯
  /// at 14
  private static func floating(_ a: HeadAct, in r: CGRect, lit: Bool, _ t: Theme, _ ctx: CGContext) {
    let shape = CGPath(roundedRect: r, cornerWidth: 8.5, cornerHeight: 8.5, transform: nil)
    ctx.addPath(shape)
    ctx.setFillColor(glass(t))
    ctx.fillPath()
    ctx.addPath(
      CGPath(roundedRect: r.insetBy(dx: -0.25, dy: -0.25), cornerWidth: 8.75, cornerHeight: 8.75, transform: nil))
    ctx.setStrokeColor(t.hair)
    ctx.setLineWidth(0.5)
    ctx.strokePath()
    let ink = lit ? t.ink : t.ink2
    let k: CGFloat = a == .open ? 13 / 16 : 14 / 16
    ctx.saveGState()
    ctx.translateBy(x: r.midX - 8 * k, y: r.midY - 8 * k)
    ctx.scaleBy(x: k, y: k)
    if a == .open {
      Icons.stroke(external, at: .zero, color: ink, in: ctx)
    } else {
      ctx.setFillColor(ink)
      for d in -1...1 { ctx.fillEllipse(in: CGRect(x: 8 + CGFloat(d) * 5 - 1.5, y: 6.5, width: 3, height: 3)) }
    }
    ctx.restoreGState()
  }

  static var external: CGPath {
    SVGPath.parse("M10 2h4v4M14 2 7 9M12 9V13.5A.5 .5 0 0 1 11.5 14H2.5A.5 .5 0 0 1 2 13.5V4.5A.5 .5 0 0 1 2.5 4H7")
  }

  /// --glass: Warm Ink's (styles.css), Ink Wash's (themes.css)
  static func glass(_ t: Theme) -> CGColor {
    switch (t.id, t.dark) {
    case (.inkWash, false): CGColor(srgbRed: 253 / 255, green: 253 / 255, blue: 251 / 255, alpha: 1)
    case (.inkWash, true): CGColor(srgbRed: 28 / 255, green: 27 / 255, blue: 25 / 255, alpha: 1)
    case (_, false): CGColor(srgbRed: 253 / 255, green: 252 / 255, blue: 250 / 255, alpha: 0.94)
    case (_, true): CGColor(srgbRed: 42 / 255, green: 41 / 255, blue: 38 / 255, alpha: 0.94)
    }
  }

  /// The grip's corner in a card of `size` (styles.css .grip::after): inset 3, its radius the card's less 3, at least 8
  /// square, only its last 12 drawn; the line's middle half its width in from the box's edge
  static func grip(_ size: CGSize, radius: CGFloat) -> CGPath {
    let gr = max(0, radius - 3)
    let side = max(8, gr)
    let (right, bottom) = (size.width - 3 - 0.75, size.height - 3 - 0.75)
    let top = size.height - 3 - min(12, side)
    let left = size.width - 3 - min(12, side)
    let r = max(0, gr - 0.75)
    let p = CGMutablePath()
    p.move(to: CGPoint(x: right, y: top))
    p.addLine(to: CGPoint(x: right, y: bottom - r))
    if r > 0 {
      p.addArc(tangent1End: CGPoint(x: right, y: bottom), tangent2End: CGPoint(x: right - r, y: bottom), radius: r)
    }
    p.addLine(to: CGPoint(x: left, y: bottom))
    return p
  }
}

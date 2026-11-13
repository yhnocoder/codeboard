import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import CoreGraphics
import Foundation

/// Everything the canvas shows of one board, worked out once when it opens: the items that get bitmaps (cards, section
/// titles, arrow labels), the section frames and the arrows. Board units, y-down.
struct Scene: Sendable {
  /// What an item draws, to find it again in the next scene
  enum Owner: Hashable, Sendable {
    case card(CardID)
    case sectionTitle(SectionID)
    case arrowLabel(ArrowID)
  }

  struct Item: Sendable {
    var owner: Owner?
    var rect: CGRect
    var drawing: Drawing
    /// Radians, about the centre
    var tilt: CGFloat
    /// How far its bitmap reaches past `rect` on each side (paper, rings)
    var bleed: CGFloat = 0

    /// What its bitmap covers, in the item's own units (its rect's top left at 0, 0)
    var bitmapSize: CGSize { CGSize(width: rect.width + 2 * bleed, height: rect.height + 2 * bleed) }
  }

  struct Frame: Sendable {
    var id: SectionID
    var rect: CGRect
    var fill: CGColor
    /// `Theme.Frame.brush`'s strokes, filled, in the Section's units
    var strokes: Outline?
    /// Folded: only its title bar, with a smaller corner
    var folded = false
  }

  /// An arrow as filled and stroked paths in board units
  struct Arrow: Sendable {
    var id: ArrowID
    var from: CardID
    var to: CardID
    /// The line's outline and its heads, filled
    var fill: Outline
    var color: CGColor
    /// A dashed line, stroked; nil when the line is in `fill`
    var stroke: Outline?
    var width: CGFloat
    /// The heads' own outline, stroked in the line's colour
    var heads: Outline
    var headColor: CGColor
    var headStroke: CGFloat
    /// The dry brush's hairlines
    var dry: Outline?
    /// The line itself (its middle), which the pointer finds it by
    var line: Outline
    /// The cubic Bézier [start, c1, c2, end] its label rides on
    var pts: [CGPoint]
    /// Where its label sits by default (the middle)
    var mid: CGPoint
    /// Its stroke weight factor (0.6, 1, 1.6 for widths 1, 2, 3)
    var k: CGFloat
  }

  /// Section titles, cards from `cardsFrom` on, then arrow labels from `labelsFrom` on. Drawn as the web board layers
  /// them: section titles, the arrows, their labels, then the cards over all of them
  var items: [Item] = []
  var cardsFrom = 0
  var labelsFrom = 0
  var frames: [Frame] = []
  var arrows: [Arrow] = []
  var bounds = CGRect.null
  /// Shared cards whose file could not be read: left out
  var missing: [CardID] = []
  /// Where each card drawn is, for its arrows
  var placed: [CardID: Placed] = [:]
  /// The arrows drawn, as the board has them, in the order of `arrows`
  var arrowModels: [CodeBoardModel.Arrow] = []
  /// Each card's drawing and what it was made from, for the next scene to reuse
  var parts: [CardID: Part] = [:]
  /// The cards whose drawing came from the scene before, unchanged
  var reused: Set<CardID> = []
  /// The sidenotes shown: the board's own, then those that travel with its shared cards (in their files)
  var notes: [Sidenote] = []
  /// Of `notes`, the ones in shared cards' files (shown, not changed: this board writes only its own file)
  var sharedNotes: Set<SidenoteID> = []

  /// A card's drawing and what it was made from: the next scene reuses it while these are the same
  struct Part: Sendable {
    var content: CardContent
    var width: Double
    var height: Double?
    var tilted: Bool
    var measured: NoteMetrics?
    /// The arrow ends on it (a code card marks the lines they start from)
    var ends: [Endpoint]
    var drawing: Drawing
    var size: CGSize
    var code: (layout: CodeLayout, top: CGFloat, segments: [SegmentID])?
  }

  /// The tilt of a tilted card, as the board's (counter-clockwise)
  static let tilt = -1.2 * CGFloat.pi / 180

  /// A Note whose size only the Note renderer knows: one without a stored height, or a Text or Box; or a Note with a
  /// stored height that something is anchored to a block of (its blocks are measured)
  struct Measure: Sendable {
    var card: CardID
    var note: NoteBody
    var width: Double
    /// Where its images are: the board package or the vault's shared folder
    var folder: URL
    var refs: [NoteRef]
  }

  /// The Notes the renderer must measure before the scene can be made
  static func measures(_ board: Board, package: URL, vault: Vault) -> [Measure] {
    let refs = RefResolver(board, package: package, vault: vault)
    var onBlocks = Set<CardID>()
    for a in board.arrows {
      for e in [a.from, a.to] where e.block != nil { onBlocks.insert(e.card) }
    }
    for n in board.sidenotes { if case .card(let c, _, _, .some) = n.anchor { onBlocks.insert(c) } }
    return board.cards.compactMap { c in
      guard let (content, folder) = content(of: c, package: package, vault: vault) else { return nil }
      switch content.body {
      case .note(let n) where c.height == nil || onBlocks.contains(c.id):
        return Measure(card: c.id, note: .note(n), width: c.width, folder: folder, refs: refs.refs(in: n.text))
      // a Text or Box is as tall as its text, and as wide too unless it wraps
      case .text(let t):
        return Measure(card: c.id, note: .text(t), width: c.width, folder: folder, refs: refs.refs(in: t.text))
      default:
        return nil
      }
    }
  }

  /// A card's content and the folder its images are in; nil for a shared card whose file could not be read
  static func content(of c: Card, package: URL, vault: Vault) -> (CardContent, URL)? {
    switch c.content {
    case .own(let own): (own, package)
    case .shared: (try? vault.sharedCard(c.id)).map { ($0.content, vault.sharedFolderURL) }
    }
  }

  /// Off the main thread: code is highlighted here, once, and kept with its item for every redraw. `sizes`: what the
  /// Note renderer measured of each Note in `measures`
  init(
    _ board: Board, package: URL, vault: Vault, theme t: Theme, highlighter: Highlighter,
    sizes: [CardID: NoteMetrics] = [:],
    reusing previous: Scene? = nil
  ) {
    // what a folded Section hides: the cards and Sections inside it (the outermost folded one around each)
    let byID = Dictionary(board.sections.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    func foldedAround(_ id: SectionID?) -> SectionID? {
      var at = id
      var out: SectionID?
      var n = 0
      while let s = at.flatMap({ byID[$0] }), n < 64 {
        if s.collapsed { out = s.id }
        at = s.parent
        n += 1
      }
      return out
    }
    let refs = RefResolver(board, package: package, vault: vault)
    notes = board.sidenotes
    var ends: [CardID: [Endpoint]] = [:]
    for a in board.arrows {
      ends[a.from.card, default: []].append(a.from)
      ends[a.to.card, default: []].append(a.to)
    }
    var cardItems: [Item] = []
    var hiddenIn: [CardID: SectionID] = [:]
    var members: [SectionID: [CGRect]] = [:]
    for c in board.cards {
      if let f = foldedAround(c.section) {
        hiddenIn[c.id] = f
        continue
      }
      guard var (content, folder) = Scene.content(of: c, package: package, vault: vault) else {
        missing.append(c.id)
        continue
      }
      if case .shared = c.content, let s = try? vault.sharedCard(c.id) {
        notes += s.sidenotes
        sharedNotes.formUnion(s.sidenotes.map(\.id))
      }
      // the Highlights the board shows: the segment's own and this board's own sidenotes' lines (core shownRanges)
      if case .code(var code) = content.body {
        for i in code.segments.indices {
          let s = code.segments[i]
          code.segments[i].highlights = board.highlights(c.id, s.id, own: s.highlights)
        }
        content.body = .code(code)
      }
      let tilt = c.tilted ? Scene.tilt : 0
      let mine = ends[c.id] ?? []
      let part: Part
      if let p = previous?.parts[c.id], p.content == content, p.width == c.width, p.height == c.height,
        p.tilted == c.tilted, p.measured == sizes[c.id], p.ends == mine
      {
        part = p
        reused.insert(c.id)
      } else {
        // web cards, link lists and sub-boards are not drawn yet
        guard
          let (drawing, size, code) = Scene.card(
            c, content, board: board, folder: folder, measured: sizes[c.id]?.size, theme: t, highlighter: highlighter,
            refs: refs)
        else { continue }
        part = Part(
          content: content, width: c.width, height: c.height, tilted: c.tilted, measured: sizes[c.id], ends: mine,
          drawing: drawing, size: size, code: code)
      }
      parts[c.id] = part
      let r = CGRect(origin: CGPoint(x: c.x, y: c.y), size: part.size)
      placed[c.id] = Placed(rect: r, code: part.code, tilt: tilt, blocks: part.measured?.blocks)
      cardItems.append(
        Item(owner: .card(c.id), rect: r, drawing: part.drawing, tilt: tilt, bleed: part.drawing.bleed(t)))
      if let s = c.section { members[s, default: []].append(r) }
      bounds = bounds.union(r)
    }
    // a Section's frame: its own ∪ its cards and the Sections in it, each with room around it (core sectionFrame); a
    // folded one just holds its title, "Title · N cards" and the chevron
    var children: [SectionID: [SectionID]] = [:]
    for s in board.sections { if let p = s.parent { children[p, default: []].append(s.id) } }
    var counts: [SectionID: Int] = [:]
    for c in board.cards {
      var at = c.section
      var seen = Set<SectionID>()
      while let s = at, seen.insert(s).inserted {
        counts[s, default: 0] += 1
        at = byID[s]?.parent
      }
    }
    func titleWidth(_ s: Section) -> CGFloat {
      if s.collapsed { return Drawing.foldedTitleWidth(s.title, count: counts[s.id] ?? 0, t) }
      // a tray's label has 6 before its text and 2 after, a brush title 2 after
      return s.title.isEmpty ? 0 : Drawing.width(s.title, t.sectionTitleFont) + (t.frame == .tray ? 8 : 2)
    }
    var frameOf: [SectionID: CGRect] = [:]
    var visiting = Set<SectionID>()
    func frame(_ id: SectionID) -> CGRect {
      if let f = frameOf[id] { return f }
      guard let s = byID[id] else { return .null }
      var r: CGRect
      if s.collapsed {
        r = CGRect(
          x: s.x, y: s.y, width: (t.foldedTitleAt.x + titleWidth(s) + 8).rounded(.up),
          height: 2 * t.foldedTitleAt.y + t.sectionTitleHeight)
      } else {
        r = CGRect(x: s.x, y: s.y, width: s.width, height: s.height)
        visiting.insert(id)
        for m in members[id] ?? [] { r = r.union(Scene.padded(m)) }
        for c in children[id] ?? [] where !visiting.contains(c) { r = r.union(Scene.padded(frame(c))) }
        visiting.remove(id)
      }
      frameOf[id] = r
      return r
    }
    for s in board.sections where foldedAround(s.parent) == nil {
      let r = frame(s.id)
      let tw = titleWidth(s)
      let strokes: Outline? =
        switch t.frame {
        case .tray: nil
        // the gap is the title label's width, its collapse chevron (16, shown on hover) and the gap before it included
        case .brush: Outline(InkFrame.path(id: s.id.rawValue, size: r.size, gap: max(40, tw + 18)))
        }
      frames.append(
        Frame(
          id: s.id, rect: r, fill: s.color.flatMap { t.sectionColors[$0] } ?? t.sectionFill, strokes: strokes,
          folded: s.collapsed))
      bounds = bounds.union(r)
      if !s.title.isEmpty || s.collapsed {
        let at = s.collapsed ? t.foldedTitleAt : t.sectionTitleAt
        items.append(
          Item(
            owner: .sectionTitle(s.id),
            // at the frame's top left, as it grows round its cards (Sections.tsx shownFrame)
            rect: CGRect(x: r.minX + at.x, y: r.minY + at.y, width: tw, height: t.sectionTitleHeight),
            drawing: .label(.init(text: s.title, kind: .section, count: s.collapsed ? counts[s.id] ?? 0 : nil)),
            tilt: 0))
      }
    }
    cardsFrom = items.count
    items += cardItems
    labelsFrom = items.count
    // a card folded away: its arrows meet its outermost folded Section's title bar, at the middle of its height; an
    // arrow with both ends folded into the same one is not drawn
    for (id, f) in hiddenIn {
      let r = frame(f)
      if !r.isNull { placed[id] = Placed(rect: r, code: nil, tilt: 0, folded: true) }
    }
    for var a in board.arrows {
      if let f = hiddenIn[a.from.card], f == hiddenIn[a.to.card] { continue }
      if hiddenIn[a.from.card] != nil { a.from = Endpoint(card: a.from.card, side: a.from.side) }
      if hiddenIn[a.to.card] != nil { a.to = Endpoint(card: a.to.card, side: a.to.side) }
      guard let from = placed[a.from.card], let to = placed[a.to.card] else { continue }
      let (arrow, label) = Scene.route(a, from: from, to: to, theme: t)
      arrows.append(arrow)
      arrowModels.append(a)
      if let label { items.append(label) }
    }
    if bounds.isNull { bounds = CGRect(x: 0, y: 0, width: 800, height: 600) }
  }

  /// An arrow between two placed cards, and its label's item when it has one
  static func route(_ a: CodeBoardModel.Arrow, from: Placed, to: Placed, theme t: Theme) -> (Arrow, Item?) {
    func end(_ e: Endpoint, _ p: Placed) -> CGFloat {
      // a line's row; a Note block's middle; a hidden line, a block not measured or the card itself: the header row
      if !e.lost, let b = e.block, !p.folded, let y = p.blockY(b, header: t.headerHeight) { return y }
      if !e.lost, let l = e.line, let c = p.code, let si = e.segment.flatMap({ c.segments.firstIndex(of: $0) }),
        let y = c.layout.lineY(segment: si, line: l)
      {
        return p.rect.minY + c.top + y
      }
      return p.folded ? p.rect.midY : p.rect.minY + t.headerHeight / 2
    }
    let lineA = a.from.line != nil || a.from.block != nil
    let lineB = a.to.line != nil || a.to.block != nil
    func pinned(_ e: Endpoint, _ line: Bool) -> ArrowRoute.Side? {
      e.side.flatMap { s in !line || s == .left || s == .right ? ArrowRoute.Side(rawValue: s.rawValue) : nil }
    }
    let ua = pinned(a.from, lineA)
    let ub = pinned(a.to, lineB)
    let shape: ArrowShape
    if a.from.card == a.to.card {
      let s = ua ?? .right
      let p = ArrowRoute.anchor(from.rect, s, rowY: end(a.from, from))
      let q = ArrowRoute.anchor(to.rect, ub ?? s, rowY: end(a.to, to))
      shape = ArrowRoute.selfArc(ArrowRoute.turn(p, from.rect, from.tilt), ArrowRoute.turn(q, to.rect, to.tilt))
    } else {
      let auto = ArrowRoute.sides(
        ArrowRoute.chooseMode(from.rect, to.rect, cards: !lineA && !lineB, prev: nil, buffer: ArrowRoute.sideBuffer))
      let p = ArrowRoute.anchor(from.rect, ua ?? auto.0, rowY: end(a.from, from))
      let q = ArrowRoute.anchor(to.rect, ub ?? auto.1, rowY: end(a.to, to))
      shape = ArrowRoute.connect(
        ArrowRoute.turn(p, from.rect, from.tilt), ArrowRoute.turn(q, to.rect, to.tilt), a: from.rect, b: to.rect)
    }
    let headScale: CGFloat = a.width == 1 ? 0.85 : a.width == 3 ? 1.25 : 1
    let k: CGFloat = a.width == 1 ? 0.6 : a.width == 3 ? 1.6 : 1
    let base = a.from.lost || a.to.lost ? t.arrowLost : a.color.flatMap { t.arrowColors[$0] } ?? t.arrow
    let arrow = Scene.arrow(a, shape, base: base, k: k, headScale: headScale, theme: t)
    guard let label = a.label, !label.isEmpty else { return (arrow, nil) }
    let box =
      switch t.label {
      case .box: CGSize(width: Drawing.width(label, t.arrowLabel) + 13, height: 22)
      case .halo: CGSize(width: Drawing.width(label, t.arrowLabel) + 33, height: 22)
      }
    let at =
      a.labelPosition.map {
        ArrowRoute.bezAt(shape.pts, ArrowRoute.placeT(shape.pts, $0, box, [from.rect, to.rect]))
      } ?? shape.mid
    let drawing = Drawing.label(.init(text: label, kind: .arrow))
    return (
      arrow,
      Item(
        owner: .arrowLabel(a.id),
        rect: CGRect(x: at.x - box.width / 2, y: at.y - box.height / 2, width: box.width, height: box.height),
        drawing: drawing, tilt: 0, bleed: drawing.bleed(t))
    )
  }

  /// The arrow in the theme's strokes: a solid line as a filled outline (tapered or brushed), a dashed one stroked
  private static func arrow(
    _ a: CodeBoardModel.Arrow, _ shape: ArrowShape, base: CGColor, k: CGFloat, headScale s: CGFloat, theme t: Theme
  ) -> Arrow {
    let fill = CGMutablePath()
    var stroke: Outline?
    var dry: Outline?
    var color = base
    if a.dashed {
      stroke = Outline(path(shape.path))
    } else {
      switch t.arrowLine {
      case .taper(let w0, let w1):
        fill.addPath(Strokes.taper(shape.path, w0: w0 * k, w1: w1 * k))
      case .brush(let half):
        let b = Strokes.brush(shape.path, seed: Strokes.brushSeed(a.id.rawValue), w: half * k)
        fill.addPath(b.outline)
        dry = b.dry.isEmpty ? nil : Outline(b.dry)
        // the brush's fill-opacity
        color = base.copy(alpha: base.alpha * 0.95) ?? base
      }
    }
    let heads = CGMutablePath()
    var tips: [(CGPoint, CGVector)] = []
    if a.endHead { tips.append((shape.pts[3], shape.inDir)) }
    if a.startHead { tips.append((shape.pts[0], shape.outDir)) }
    let headColor: CGColor
    let headStroke: CGFloat
    switch t.arrowHead {
    case .dart:
      for (tip, u) in tips { heads.addPath(path(ArrowRoute.dart(tip: tip, u, scale: s))) }
      headColor = base
      headStroke = 0.35 * k
    case .dot:
      for (tip, _) in tips {
        heads.addEllipse(in: CGRect(x: tip.x - 3.5 * s, y: tip.y - 3.5 * s, width: 7 * s, height: 7 * s))
      }
      headColor = base.copy(alpha: base.alpha * 0.9) ?? base
      headStroke = t.arrowWidth * k
    }
    return Arrow(
      id: a.id, from: a.from.card, to: a.to.card, fill: Outline(fill), color: color, stroke: stroke,
      width: t.arrowWidth * k, heads: Outline(heads),
      headColor: headColor,
      headStroke: headStroke, dry: dry, line: Outline(path(shape.path)), pts: shape.pts, mid: shape.mid, k: k)
  }

  static func path(_ ops: [PathOp]) -> CGPath {
    let p = CGMutablePath()
    for op in ops {
      switch op {
      case .move(let a): p.move(to: a)
      case .line(let a): p.addLine(to: a)
      case .quad(let c, let a): p.addQuadCurve(to: a, control: c)
      case .curve(let c1, let c2, let a): p.addCurve(to: a, control1: c1, control2: c2)
      }
    }
    return p
  }

  /// A card where arrows can find its lines
  struct Placed: Sendable {
    var rect: CGRect
    var code: (layout: CodeLayout, top: CGFloat, segments: [SegmentID])?
    var tilt: CGFloat
    /// A folded Section's title bar standing in for a card folded away in it: arrows meet it at its middle
    var folded = false
    /// A Note's blocks as laid out, from its top
    var blocks: [NoteBlock]?

    /// The middle of a Note block's band in board units, kept inside the card below its header (the board's blockY);
    /// nil when it is not measured or not there
    func blockY(_ ref: BlockRef, header: CGFloat) -> CGFloat? {
      guard let bs = blocks, let k = ref.at(bs.map(\.sig)), bs[k].h > 0 else { return nil }
      let y = CGFloat(bs[k].y + bs[k].h / 2)
      return rect.minY + min(max(y, header), max(header, rect.height - 8))
    }
  }

  /// A card's or an inner Section's frame with the room a Section keeps around it (core SECTION_PAD)
  static func padded(_ r: CGRect) -> CGRect {
    CGRect(x: r.minX - 22, y: r.minY - 34, width: r.width + 44, height: r.height + 56)
  }

  private static func card(
    _ c: Card, _ content: CardContent, board: Board, folder: URL, measured: CGSize?, theme t: Theme,
    highlighter: Highlighter, refs: RefResolver
  ) -> (
    Drawing, CGSize, (layout: CodeLayout, top: CGFloat, segments: [SegmentID])?
  )? {
    let images = folder.appending(path: Vault.imagesFolder)
    switch content.body {
    case .code(let code):
      let tokens = code.segments.map { highlighter.tokens(lines: $0.lines, language: $0.language) }
      let layout = CodeLayout(code, tokens: tokens, width: c.width, metrics: t.metrics)
      let s = code.segments.first
      let title = content.title ?? s?.symbol?.name ?? s?.scope ?? s.flatMap(CodeLayout.path).map(file) ?? "Code"
      let path = s.flatMap { s in CodeLayout.path(s).map { "\(file($0)):\(s.firstLine)" } }
      let top = code.framed ? t.headerHeight : 0
      let body = c.height ?? min(layout.height, t.metrics.maxAutoHeight)
      var linked = Set<[Int]>()
      for a in board.arrows {
        for e in [a.from, a.to] where e.card == c.id && !e.lost {
          if let l = e.line, let si = code.segments.firstIndex(where: { $0.id == e.segment }) {
            linked.insert([si, l])
          }
        }
      }
      let d = Drawing.Code(
        id: c.id.rawValue, title: title, path: code.segments.count > 1 ? nil : path, glyph: glyph(code),
        version: s.flatMap(version), linkedIn: board.arrows.count { $0.to.card == c.id }, linked: linked,
        layout: layout, framed: code.framed)
      return (.code(d), CGSize(width: c.width, height: top + body), (layout, top, code.segments.map(\.id)))
    case .note(let n):
      let title = content.title ?? heading(n.text)
      // a Note the renderer could not measure is shown as paper of an arbitrary height
      let size = CGSize(width: c.width, height: c.height ?? measured?.height ?? c.width * 0.6)
      let note = Drawing.Note(
        id: c.id.rawValue, title: title, content: .note(n), folder: folder, height: c.height,
        refs: refs.refs(in: n.text))
      return (.note(note), size, nil)
    case .text(let text):
      // as wide as its text unless it wraps at the card's width
      var size = CGSize(width: c.width, height: measured?.height ?? c.width * 0.6)
      if !text.wrap, let m = measured { size.width = m.width }
      let note = Drawing.Note(
        id: c.id.rawValue, title: nil, content: .text(text), folder: folder, height: nil,
        refs: refs.refs(in: text.text))
      return (.note(note), size, nil)
    case .image(let img):
      var url: URL?
      if case .file(let f) = img.source { url = images.appending(path: f) }
      let size = url.flatMap(DecodeCache.pixelSize)
      let h = c.height ?? size.map { c.width * $0.height / max($0.width, 1) } ?? c.width * 0.6
      let pic = Drawing.Picture(
        id: c.id.rawValue, url: size == nil ? nil : url, fileSize: size ?? .zero, frame: (img.stillFrame ?? 1) - 1,
        framed: img.framed)
      return (.image(pic), CGSize(width: c.width, height: h), nil)
    case .web, .links, .board:
      return nil
    }
  }

  private static func file(_ path: String) -> String { path.split(separator: "/").last.map(String.init) ?? path }

  /// The heading a Note starts with (its first non-blank line, when that is a heading), as its header shows it
  private static func heading(_ md: String) -> String? {
    guard let l = md.split(whereSeparator: \.isNewline).first(where: { !$0.allSatisfy(\.isWhitespace) }),
      l.hasPrefix("#")
    else { return nil }
    let t = String(l.drop { $0 == "#" || $0 == " " })
    return t.isEmpty ? nil : t
  }

  /// The card's kind before its title (core model.ts codeGlyph); nil for Free code, which shows none
  private static func glyph(_ c: CodeCard) -> String? {
    guard let s = c.segments.first else { return "⋮" }
    guard let source = s.source else { return nil }
    if case .git(let repo?, _, _, _, _) = source, repo.contains("github.com") { return "GH" }
    if c.segments.count > 1 { return "⋮" }
    switch s.symbol?.kind {
    case .class: return "C"
    case .function: return "ƒ"
    default: return "⋮"
    }
  }

  /// A segment's version as its header's chip shows it (core model.ts versionLabel, short)
  static func version(_ s: Segment) -> String? {
    switch s.source {
    case .git(_, let commit, _, _, _): String(commit.prefix(7))
    case .package(let name, let version, _): "\(name) \(version)"
    case .file(_, let hash?): String(hash.prefix(4))
    case .file(_, nil), nil: nil
    }
  }
}

/// A path kept in a scene: an immutable copy, which CoreGraphics allows any thread to read, though the SDK does not mark
/// CGPath Sendable
struct Outline: @unchecked Sendable {
  let cg: CGPath

  init(_ p: CGPath) { cg = p.copy() ?? p }

  var isEmpty: Bool { cg.isEmpty }
}

import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import CoreGraphics
import Foundation

/// Everything the canvas shows of one board, worked out once when it opens: the items that get bitmaps (cards, section
/// titles, arrow labels), the section frames and the arrows. Board units, y-down.
struct Scene: Sendable {
  struct Item: Sendable {
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
    var rect: CGRect
    var fill: CGColor
    /// `Theme.Frame.brush`'s strokes, filled, in the Section's units
    var strokes: Outline?
  }

  /// An arrow as filled and stroked paths in board units
  struct Arrow: Sendable {
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

  /// The tilt of a tilted card, as the board's (counter-clockwise)
  static let tilt = -1.2 * CGFloat.pi / 180

  /// A Note whose size only the Note renderer knows: one without a stored height, or a Text or Box
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
    return board.cards.compactMap { c in
      guard let (content, folder) = content(of: c, package: package, vault: vault) else { return nil }
      switch content.body {
      case .note(let n) where c.height == nil:
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
    _ board: Board, package: URL, vault: Vault, theme t: Theme, highlighter: Highlighter, sizes: [CardID: CGSize] = [:]
  ) {
    for s in board.sections {
      let r = CGRect(x: s.x, y: s.y, width: s.width, height: s.height)
      // the title's room: a tray's label has 6 before its text and 2 after, a brush title 2 after
      let titleWidth = s.title.isEmpty ? 0 : Drawing.width(s.title, t.sectionTitleFont) + (t.frame == .tray ? 8 : 2)
      let strokes: Outline? =
        switch t.frame {
        case .tray: nil
        // the gap is the title label's width, its collapse chevron (16, shown on hover) and the gap before it included
        case .brush: Outline(InkFrame.path(id: s.id.rawValue, size: r.size, gap: max(40, titleWidth + 18)))
        }
      frames.append(Frame(rect: r, fill: s.color.flatMap { t.sectionColors[$0] } ?? t.sectionFill, strokes: strokes))
      bounds = bounds.union(r)
      if !s.title.isEmpty {
        items.append(
          Item(
            rect: CGRect(
              x: s.x + t.sectionTitleAt.x, y: s.y + t.sectionTitleAt.y, width: titleWidth, height: t.sectionTitleHeight),
            drawing: .label(.init(text: s.title, kind: .section)),
            tilt: 0))
      }
    }
    cardsFrom = items.count
    let refs = RefResolver(board, package: package, vault: vault)
    var placed: [CardID: Placed] = [:]
    for c in board.cards {
      guard let (content, folder) = Scene.content(of: c, package: package, vault: vault) else {
        missing.append(c.id)
        continue
      }
      let tilt = c.tilted ? Scene.tilt : 0
      // web cards, link lists and sub-boards are not drawn yet
      guard
        let (drawing, size, code) = Scene.card(
          c, content, board: board, folder: folder, measured: sizes[c.id], theme: t, highlighter: highlighter,
          refs: refs)
      else { continue }
      let r = CGRect(origin: CGPoint(x: c.x, y: c.y), size: size)
      placed[c.id] = Placed(rect: r, code: code, tilt: tilt)
      items.append(Item(rect: r, drawing: drawing, tilt: tilt, bleed: drawing.bleed(t)))
      bounds = bounds.union(r)
    }
    labelsFrom = items.count
    for a in board.arrows {
      guard let from = placed[a.from.card], let to = placed[a.to.card] else { continue }
      func end(_ e: Endpoint, _ p: Placed) -> CGFloat {
        // a line's row; a hidden line, a Note block (not laid out yet) or the card itself: the header row
        if !e.lost, let l = e.line, let c = p.code, let si = e.segment.flatMap({ c.segments.firstIndex(of: $0) }),
          let y = c.layout.lineY(segment: si, line: l)
        {
          return p.rect.minY + c.top + y
        }
        return p.rect.minY + t.headerHeight / 2
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
      arrows.append(Scene.arrow(a, shape, base: base, k: k, headScale: headScale, theme: t))
      if let label = a.label, !label.isEmpty {
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
        items.append(
          Item(
            rect: CGRect(x: at.x - box.width / 2, y: at.y - box.height / 2, width: box.width, height: box.height),
            drawing: drawing, tilt: 0, bleed: drawing.bleed(t)))
      }
    }
    if bounds.isNull { bounds = CGRect(x: 0, y: 0, width: 800, height: 600) }
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
      fill: Outline(fill), color: color, stroke: stroke, width: t.arrowWidth * k, heads: Outline(heads),
      headColor: headColor,
      headStroke: headStroke, dry: dry)
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
  private struct Placed {
    var rect: CGRect
    var code: (layout: CodeLayout, top: CGFloat, segments: [SegmentID])?
    var tilt: CGFloat
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
  private static func version(_ s: Segment) -> String? {
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

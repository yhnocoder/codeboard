import CodeBoardModel
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
  }

  struct Frame: Sendable {
    var rect: CGRect
    var fill: CGColor
  }

  struct Arrow: Sendable {
    var line: [PathOp]
    var heads: [[PathOp]]
    var color: CGColor
    var width: CGFloat
    var dashed: Bool
  }

  /// In drawing order: section titles, cards, then arrow labels from `labelsFrom` on (the arrows are drawn in between)
  var items: [Item] = []
  var labelsFrom = 0
  var frames: [Frame] = []
  var arrows: [Arrow] = []
  var bounds = CGRect.null
  /// Shared cards whose file could not be read: left out
  var missing: [CardID] = []

  /// The tilt of a tilted card, as the board's (counter-clockwise)
  static let tilt = -1.2 * CGFloat.pi / 180

  /// Off the main thread: code is highlighted here, once, and kept with its item for every redraw
  init(_ board: Board, package: URL, vault: Vault, theme t: Theme, highlighter: Highlighter) {
    for s in board.sections {
      let r = CGRect(x: s.x, y: s.y, width: s.width, height: s.height)
      frames.append(Frame(rect: r, fill: s.color.flatMap { t.sectionColors[$0] } ?? t.sectionFill))
      bounds = bounds.union(r)
      if !s.title.isEmpty {
        let w = Drawing.width(s.title, t.sectionTitle.ct) + 8
        items.append(
          Item(
            rect: CGRect(x: s.x + 16, y: s.y + 6, width: w, height: 22),
            drawing: .label(.init(text: s.title, boxed: false)),
            tilt: 0))
      }
    }
    var placed: [CardID: Placed] = [:]
    for c in board.cards {
      let content: CardContent
      let images: URL
      switch c.content {
      case .own(let own):
        content = own
        images = package.appending(path: Vault.imagesFolder)
      case .shared:
        guard let s = try? vault.sharedCard(c.id) else {
          missing.append(c.id)
          continue
        }
        content = s.content
        images = vault.sharedFolderURL.appending(path: Vault.imagesFolder)
      }
      let tilt = c.tilted ? Scene.tilt : 0
      let (drawing, height, code) = Scene.card(c, content, images: images, theme: t, highlighter: highlighter)
      let r = CGRect(x: c.x, y: c.y, width: c.width, height: height)
      placed[c.id] = Placed(rect: r, code: code, tilt: tilt)
      items.append(Item(rect: r, drawing: drawing, tilt: tilt))
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
      var heads: [[PathOp]] = []
      if a.endHead { heads.append(ArrowRoute.dart(tip: shape.pts[3], shape.inDir, scale: headScale)) }
      if a.startHead { heads.append(ArrowRoute.dart(tip: shape.pts[0], shape.outDir, scale: headScale)) }
      let color = a.from.lost || a.to.lost ? t.arrowLost : a.color.flatMap { t.arrowColors[$0] } ?? t.arrow
      arrows.append(
        Arrow(
          line: shape.path, heads: heads, color: color,
          width: t.arrowWidth * (a.width == 1 ? 0.6 : a.width == 3 ? 1.6 : 1), dashed: a.dashed))
      if let label = a.label, !label.isEmpty {
        let box = CGSize(width: Drawing.width(label, t.arrowLabel.ct) + 13, height: 22)
        let at =
          a.labelPosition.map {
            ArrowRoute.bezAt(shape.pts, ArrowRoute.placeT(shape.pts, $0, box, [from.rect, to.rect]))
          } ?? shape.mid
        items.append(
          Item(
            rect: CGRect(x: at.x - box.width / 2, y: at.y - box.height / 2, width: box.width, height: box.height),
            drawing: .label(.init(text: label, boxed: true)), tilt: 0))
      }
    }
    if bounds.isNull { bounds = CGRect(x: 0, y: 0, width: 800, height: 600) }
  }

  /// A card where arrows can find its lines
  private struct Placed {
    var rect: CGRect
    var code: (layout: CodeLayout, top: CGFloat, segments: [SegmentID])?
    var tilt: CGFloat
  }

  private static func card(
    _ c: Card, _ content: CardContent, images: URL, theme t: Theme, highlighter: Highlighter
  ) -> (
    Drawing, CGFloat, (layout: CodeLayout, top: CGFloat, segments: [SegmentID])?
  ) {
    switch content.body {
    case .code(let code):
      let tokens = code.segments.map { highlighter.tokens(lines: $0.lines, language: $0.language) }
      let layout = CodeLayout(code, tokens: tokens, width: c.width, metrics: t.metrics)
      let s = code.segments.first
      let title = content.title ?? s?.symbol?.name ?? s?.scope ?? s.flatMap(CodeLayout.path).map(file) ?? "Code"
      let path = s.flatMap(CodeLayout.path).map(file)
      let top = code.framed ? t.headerHeight : 0
      let body = c.height ?? min(layout.height, t.metrics.maxAutoHeight)
      let d = Drawing.Code(
        title: title, path: path == title ? nil : path, layout: layout, framed: code.framed)
      return (.code(d), top + body, (layout, top, code.segments.map(\.id)))
    case .note(let n):
      let title = content.title ?? firstLine(n.text)
      let h = c.height ?? noteHeight(n, width: c.width, images: images, theme: t)
      return (.note(.init(title: title, style: n.style)), h, nil)
    case .image(let img):
      var url: URL?
      if case .file(let f) = img.source { url = images.appending(path: f) }
      let size = url.flatMap(DecodeCache.pixelSize)
      let h = c.height ?? size.map { c.width * $0.height / max($0.width, 1) } ?? c.width * 0.6
      let pic = Drawing.Picture(
        url: size == nil ? nil : url, fileSize: size ?? .zero, frame: (img.stillFrame ?? 1) - 1, framed: img.framed)
      return (.image(pic), h, nil)
    }
  }

  private static func file(_ path: String) -> String { path.split(separator: "/").last.map(String.init) ?? path }

  private static func firstLine(_ md: String) -> String {
    let l = md.split(whereSeparator: \.isNewline).first { !$0.allSatisfy(\.isWhitespace) } ?? ""
    return String(l.drop { $0 == "#" || $0 == " " })
  }

  /// ponytail: a guess from the Markdown's lines, off by tens of points, until the Note renderer measures Notes (the
  /// model keeps no height for a Note that grows with its text)
  static func noteHeight(_ n: Note, width: CGFloat, images: URL, theme t: Theme) -> CGFloat {
    let body = max(width - 28, 40)
    var h: CGFloat = n.style == .note ? t.headerHeight + 24 : 16
    var fence = false
    for raw in n.text.split(separator: "\n", omittingEmptySubsequences: false) {
      let l = raw.trimmingCharacters(in: .whitespaces)
      if l.hasPrefix("```") {
        fence.toggle()
        h += 10
      } else if fence {
        h += 20
      } else if l.isEmpty {
        h += 8
      } else if let m = l.firstMatch(of: /!\[[^\]]*\]\(images\/([^)\s]+)/) {
        let size = DecodeCache.pixelSize(images.appending(path: String(m.1)))
        h += size.map { min(body, $0.width) * $0.height / max($0.width, 1) } ?? 200
      } else if l.hasPrefix("|") {
        h += 30
      } else {
        // wide (CJK) characters count twice
        let units = l.unicodeScalars.reduce(0) { $0 + ($1.value > 0x2E80 ? 2 : 1) }
        let lines = max(1, (CGFloat(units) * 7.2 / body).rounded(.up))
        h += lines * (l.hasPrefix("#") ? 30 : 22)
      }
    }
    return h
  }
}

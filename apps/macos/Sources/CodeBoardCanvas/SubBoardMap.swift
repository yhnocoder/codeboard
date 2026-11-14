import CodeBoardModel
import CoreText
import Foundation
import ImageIO
import Synchronization

// A sub-board card as the web board draws it (cards/BoardBody.tsx, core subboard.ts skeletonOf and mapFit, styles.css
// .card.board, .sbhead, .sbmap): its name and card count above it, and inside a small map of the board it shows, its
// Sections, cards (Notes as paper with grey lines, code with a blue-grey head, a Text as lines, a Box as its outline,
// images as thumbnails) and the arrows between them as thin curves. Drawn natively, in one bitmap with the card.

/// What the map of a board is drawn from (core Skeleton), its positions from the content's top left
struct Skeleton: Sendable, Equatable {
  struct Box: Sendable, Equatable {
    var x: Double
    var y: Double
    var w: Double
    var h: Double
  }

  struct Card: Sendable, Equatable {
    enum Kind: Sendable, Equatable {
      case note, text, box, code
      case image(URL?)
      case web, links, board
    }

    var id: CardID
    var box: Box
    var kind: Kind
    /// The Section it is in (an index into `secs`)
    var section: Int?
  }

  struct Sec: Sendable, Equatable {
    var box: Box
    var color: String?
    var title: String
  }

  /// How many cards it has
  var n: Int
  var w: Double
  var h: Double
  var cards: [Card]
  var secs: [Sec]
  /// Arrows between cards, each pair once (indices into `cards`)
  var ln: [[Int]]

  /// The board `b` (in `package`) as its map shows it; card heights not stored are what was last measured, else a guess
  static func of(_ b: Board, package: URL, vault: Vault) -> Skeleton {
    var rects: [CardID: Box] = [:]
    var cards: [Card] = []
    let secIndex = Dictionary(b.sections.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
    for c in b.cards {
      let got = Scene.content(of: c, package: package, vault: vault)
      let folder = got?.1 ?? package
      var kind = Card.Kind.note
      var guess = c.width * 0.6
      switch got?.0.body ?? .note(Note(text: "")) {
      case .note: kind = .note
      case .text(let t):
        kind = t.look == .box ? .box : .text
        guess = 40
      case .code(let code):
        kind = .code
        let lines = code.segments.reduce(0) { $0 + $1.lines.count }
        guess = 36 + Double(min(lines, 40)) * 17
      case .image(let img):
        var url: URL?
        if case .file(let f) = img.source { url = folder.appending(path: Vault.imagesFolder).appending(path: f) }
        kind = .image(url)
        if let s = url.flatMap(DecodeCache.pixelSize), s.width > 0 { guess = c.width * s.height / s.width }
      case .web: kind = .web
      case .links: kind = .links
      case .board:
        kind = .board
        guess = 320
      }
      let box = Box(x: c.x, y: c.y, w: c.width, h: c.height ?? c.measuredHeight ?? guess)
      rects[c.id] = box
      cards.append(Card(id: c.id, box: box, kind: kind, section: c.section.flatMap { secIndex[$0] }))
    }
    // a Section's frame: its own and its cards' and inner Sections', each padded (core sectionFrames)
    var children: [SectionID: [SectionID]] = [:]
    for s in b.sections { if let p = s.parent { children[p, default: []].append(s.id) } }
    var members: [SectionID: [CGRect]] = [:]
    for c in b.cards { if let s = c.section, let r = rects[c.id] { members[s, default: []].append(r.cg) } }
    var frames: [SectionID: CGRect] = [:]
    var visiting = Set<SectionID>()
    func frame(_ s: Section) -> CGRect {
      if let f = frames[s.id] { return f }
      var r = CGRect(x: s.x, y: s.y, width: s.width, height: s.height)
      visiting.insert(s.id)
      for m in members[s.id] ?? [] { r = r.union(Scene.padded(m)) }
      for c in children[s.id] ?? [] where !visiting.contains(c) {
        if let inner = b.section(c) { r = r.union(Scene.padded(frame(inner))) }
      }
      visiting.remove(s.id)
      frames[s.id] = r
      return r
    }
    var secs = b.sections.map { s in
      let r = frame(s)
      return Sec(box: Box(x: r.minX, y: r.minY, w: r.width, h: r.height), color: s.color, title: s.title)
    }
    var ln: [[Int]] = []
    var seen = Set<[Int]>()
    let at = Dictionary(b.cards.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { a, _ in a })
    for a in b.arrows {
      guard let i = at[a.from.card], let j = at[a.to.card], i != j else { continue }
      let k = [min(i, j), max(i, j)]
      if seen.insert(k).inserted { ln.append([i, j]) }
    }
    let all = cards.map(\.box.cg) + secs.map(\.box.cg)
    let bounds = all.reduce(CGRect.null) { $0.union($1) }
    let o = bounds.isNull ? CGPoint.zero : bounds.origin
    func moved(_ b: Box) -> Box {
      Box(x: (b.x - o.x).rounded(), y: (b.y - o.y).rounded(), w: b.w.rounded(), h: b.h.rounded())
    }
    for i in cards.indices { cards[i].box = moved(cards[i].box) }
    for i in secs.indices { secs[i].box = moved(secs[i].box) }
    return Skeleton(
      n: b.cards.count, w: max(1, (bounds.isNull ? 1 : bounds.width).rounded()),
      h: max(1, (bounds.isNull ? 1 : bounds.height).rounded()), cards: cards, secs: secs, ln: ln)
  }

  /// The map's scale and its top left in a frame W × H, centred (core mapFit: 14 round it, 20 at the top for the
  /// Sections' names, never larger than half size)
  static func fit(w: Double, h: Double, frameW: Double, frameH: Double) -> (s: Double, ox: Double, oy: Double) {
    let s = max(1e-4, min(0.5, (frameW - 28) / w, (frameH - 20 - 14) / h))
    return (s, (frameW - w * s) / 2, 20 + (frameH - 20 - 14 - h * s) / 2)
  }
}

/// The maps of the boards sub-board cards show, kept while their file is unchanged
final class Skeletons: Sendable {
  static let shared = Skeletons()
  private let kept = Mutex([String: (Date, Skeleton)]())

  func of(_ b: VaultBoard, vault: Vault) -> Skeleton? {
    let file = vault.url(of: b.path).appending(path: Vault.boardFileName)
    guard let at = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date else {
      return nil
    }
    if let (d, s) = kept.withLock({ $0[file.path] }), d == at { return s }
    guard let board = try? vault.board(at: b.path) else { return nil }
    let s = Skeleton.of(board, package: vault.url(of: b.path), vault: vault)
    kept.withLock { $0[file.path] = (at, s) }
    return s
  }
}

extension Skeleton.Box {
  var cg: CGRect { CGRect(x: x, y: y, width: w, height: h) }
}

extension Drawing {
  /// A sub-board card's own: what it shows and how it says so
  struct SubBoard: Sendable {
    var id: String
    /// The board it shows (a subfolder's: its folder board's), when there is one
    var board: BoardID?
    /// Above it (its own title, else the board's name)
    var name: String
    /// nil: the board it points at is not there
    var map: Skeleton?
    /// What the count says when there is no map (a folder without a folder board: what is in it)
    var count: Int?
  }

  /// A sub-board card's height when it has none of its own (FRAME_H)
  static let subHeight: CGFloat = 320

  /// Where a card of the board a sub-board card shows is drawn in its map, in the sub-board card's rect `r`
  static func block(_ c: CardID, in map: Skeleton, _ r: CGRect) -> CGRect? {
    guard let b = map.cards.first(where: { $0.id == c })?.box else { return nil }
    let f = Skeleton.fit(w: map.w, h: map.h, frameW: r.width, frameH: r.height)
    return CGRect(
      x: r.minX + f.ox + b.x * f.s, y: r.minY + f.oy + b.y * f.s, width: max(1, b.w * f.s), height: max(1, b.h * f.s))
  }

  /// Room above the card for its name and count (.sbhead: a 30 high line 16 above it)
  static let subHead: CGFloat = 46

  /// Draws a sub-board card in its rect (y-down, the rect at 0, 0), its head above it
  static func subBoard(_ ctx: CGContext, _ b: SubBoard, _ r: CGRect, _ t: Theme, scale: CGFloat) -> Int {
    var decodes = 0
    let sheet = t.paper == .sheet
    let radius = t.cardRadius * 1.76
    let outline = Drawing.squircle(r, radius)
    let mix = { (a: CGColor, b: CGColor, k: CGFloat) -> CGColor in
      let x =
        a.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components ?? [
          0, 0, 0, 1,
        ]
      let y =
        b.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components ?? [
          0, 0, 0, 1,
        ]
      return CGColor(
        srgbRed: x[0] * k + y[0] * (1 - k), green: x[1] * k + y[1] * (1 - k), blue: x[2] * k + y[2] * (1 - k), alpha: 1)
    }
    let ground = mix(t.surface, t.canvas, 0.72)
    // the card (its shadow is the canvas's, as every framed card's) in a hairline ring (.card.board --ring): Warm Ink a
    // tinted sheet; Ink Wash the torn paper every card of it is, with its fibres (themes.css .card::before --deckle)
    if sheet {
      ctx.addPath(outline)
      ctx.setFillColor(ground)
      ctx.fillPath()
    } else {
      ctx.saveGState()
      ctx.translateBy(x: r.minX, y: r.minY)
      Drawing.paper(ctx, CGRect(origin: .zero, size: r.size), t, id: b.id, rule: nil)
      ctx.restoreGState()
    }
    ctx.addPath(Drawing.squircle(r.insetBy(dx: -0.5, dy: -0.5), radius + 0.5))
    ctx.setStrokeColor(t.hair)
    ctx.setLineWidth(1)
    ctx.strokePath()
    // the head: name, then the count, 10 apart, on one baseline; the name cut before the count
    let nameFont = t.subName
    let countFont = t.subCount
    let count = b.map.map { "\($0.n)" } ?? b.count.map { "\($0)" } ?? ""
    let cw = count.isEmpty ? 0 : Drawing.width(count, countFont)
    let midY = r.minY - 16 - 15
    let nw = min(Drawing.width(b.name, nameFont), r.width - 6 - (cw > 0 ? cw + 10 : 0))
    Drawing.text(ctx, b.name, nameFont, t.ink, x: r.minX + 6, midY: midY, width: nw)
    if cw > 0 { Drawing.text(ctx, count, countFont, t.ink3, x: r.minX + 6 + nw + 10, midY: midY, width: cw) }
    guard let sk = b.map else { return 0 }
    // the map, clipped to the card
    ctx.saveGState()
    ctx.addPath(outline)
    ctx.clip()
    let f = Skeleton.fit(w: sk.w, h: sk.h, frameW: r.width, frameH: r.height)
    let mx = { (v: Double) in r.minX + f.ox + v * f.s }
    let my = { (v: Double) in r.minY + f.oy + v * f.s }
    let ml = { (v: Double) in v * f.s }
    func rect(_ b: Skeleton.Box) -> CGRect { CGRect(x: mx(b.x), y: my(b.y), width: ml(b.w), height: ml(b.h)) }
    func round(_ r: CGRect, _ k: CGFloat) -> CGPath {
      CGPath(roundedRect: r, cornerWidth: min(k, r.width / 2), cornerHeight: min(k, r.height / 2), transform: nil)
    }
    let ink = { (a: CGFloat) in t.ink.copy(alpha: a) ?? t.ink }
    let fn = t.syntax[.function] ?? t.accent
    let fnA = { (a: CGFloat) in fn.copy(alpha: a) ?? fn }
    for s in sk.secs {
      ctx.addPath(round(rect(s.box), 6))
      ctx.setFillColor(s.color.flatMap { t.sectionColors[$0] } ?? t.sectionFill)
      ctx.fillPath()
      ctx.addPath(round(rect(s.box), 6))
      ctx.setStrokeColor(t.hair)
      ctx.setLineWidth(0.75)
      ctx.strokePath()
    }
    // the arrows: from the facing sides' middles, a curve bent along the longer way
    let edge = sheet ? t.ink3 : (t.ink.copy(alpha: t.dark ? 0.78 : 0.8) ?? t.ink)
    for pair in sk.ln {
      let a = sk.cards[pair[0]].box
      let b = sk.cards[pair[1]].box
      let (ax, ay, bx, by) = (a.x + a.w / 2, a.y + a.h / 2, b.x + b.w / 2, b.y + b.h / 2)
      let horiz = abs(bx - ax) > abs(by - ay)
      let p1 =
        horiz
        ? CGPoint(x: mx(ax < bx ? a.x + a.w : a.x), y: my(ay)) : CGPoint(x: mx(ax), y: my(ay < by ? a.y + a.h : a.y))
      let p2 =
        horiz
        ? CGPoint(x: mx(ax < bx ? b.x : b.x + b.w), y: my(by)) : CGPoint(x: mx(bx), y: my(ay < by ? b.y : b.y + b.h))
      let path = CGMutablePath()
      path.move(to: p1)
      if horiz {
        let mx = (p1.x + p2.x) / 2
        path.addCurve(to: p2, control1: CGPoint(x: mx, y: p1.y), control2: CGPoint(x: mx, y: p2.y))
      } else {
        let my = (p1.y + p2.y) / 2
        path.addCurve(to: p2, control1: CGPoint(x: p1.x, y: my), control2: CGPoint(x: p2.x, y: my))
      }
      ctx.addPath(path)
      ctx.setStrokeColor(edge.copy(alpha: edge.alpha * 0.75) ?? edge)
      ctx.setLineWidth(1)
      ctx.strokePath()
    }
    let codeW: [CGFloat] = [0.5, 0.78, 0.64, 0.4, 0.7, 0.56]
    let noteW: [CGFloat] = [0.98, 0.92, 0.97, 0.7, 0.95, 0.88, 0.6]
    func bar(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ c: CGColor) {
      ctx.addPath(round(CGRect(x: x, y: y, width: w, height: h), 0.8))
      ctx.setFillColor(c)
      ctx.fillPath()
    }
    for c in sk.cards {
      let x = mx(c.box.x)
      let y = my(c.box.y)
      let w = max(1, ml(c.box.w))
      let h = max(1, ml(c.box.h))
      let box = CGRect(x: x, y: y, width: w, height: h)
      switch c.kind {
      case .image(let url):
        let thumb = url.flatMap { Drawing.thumbnail($0, max(w, h) * scale) }
        if let thumb {
          decodes += 1
          // preserveAspectRatio slice: covers the block, cut to it
          ctx.saveGState()
          ctx.clip(to: box)
          let k = max(w / CGFloat(thumb.width), h / CGFloat(thumb.height))
          let iw = CGFloat(thumb.width) * k
          let ih = CGFloat(thumb.height) * k
          ctx.translateBy(x: x + (w - iw) / 2, y: y + (h - ih) / 2 + ih)
          ctx.scaleBy(x: 1, y: -1)
          ctx.setAlpha(0.96)
          ctx.draw(thumb, in: CGRect(x: 0, y: 0, width: iw, height: ih))
          ctx.restoreGState()
        } else {
          ctx.setFillColor(ink(0.08))
          ctx.fill(box)
        }
        ctx.setStrokeColor(ink(0.15))
        ctx.setLineWidth(0.5)
        ctx.stroke(box)
      case .text:
        // one line fits: a thick bar (a title, a short label); more: lines to its height, no paper
        if h < 9 {
          bar(x, y + h / 2 - 1.2, w * 0.8, 2.4, ink(0.55))
        } else {
          var yy = y + 2
          var k = 0
          while yy + 2 < y + h && k < 60 {
            bar(x, yy, w * noteW[k % 7], 1.6, ink(0.13))
            yy += 5
            k += 1
          }
        }
      case .box:
        ctx.addPath(round(box, 2.5))
        ctx.setStrokeColor(ink(0.4))
        ctx.setLineWidth(0.75)
        ctx.strokePath()
      default:
        let code = c.kind == .code
        let hd: CGFloat = code ? min(7, h / 3) : c.kind == .web ? min(h * 0.4, 40) : 0
        ctx.addPath(round(box, 2.5))
        ctx.setFillColor(code ? mix(t.surface, fn, 0.88) : t.surface)
        ctx.fillPath()
        ctx.addPath(round(box, 2.5))
        ctx.setStrokeColor(ink(0.22))
        ctx.setLineWidth(0.75)
        if c.kind == .board { ctx.setLineDash(phase: 0, lengths: [3, 2]) }
        ctx.strokePath()
        ctx.setLineDash(phase: 0, lengths: [])
        if hd > 0 {
          ctx.addPath(round(CGRect(x: x, y: y, width: w, height: hd), 2.5))
          ctx.setFillColor(c.kind == .web ? ink(0.09) : fnA(0.22))
          ctx.fillPath()
        }
        let lx = x + 4
        let lw = w - 8
        var yy = y + hd + 4
        var n = 0
        if lw > 6 {
          if c.kind == .note || c.kind == .board {
            bar(lx, yy, lw * 0.62, 2.2, ink(0.42))
            yy += 6
          }
          while yy + 2 < y + h - 4 && n < 40 {
            let ww = lw * (code ? codeW[n % 6] : noteW[n % 7])
            bar(lx + (code && n % 3 == 1 ? 6 : 0), yy, ww, 1.6, code ? fnA(0.3) : ink(0.13))
            yy += 5
            n += 1
          }
        }
      }
    }
    // the Sections' names and how many cards each has, riding on their top edge, at a fixed size
    var inSec: [Int: Int] = [:]
    for c in sk.cards { if let s = c.section { inSec[s, default: 0] += 1 } }
    let labFont = t.subLabel
    let labCount = t.subLabelCount
    for (i, s) in sk.secs.enumerated() where ml(s.box.w) >= 36 {
      let title = s.title.isEmpty ? "Section" : s.title
      let num = "\(inSec[i] ?? 0)"
      let maxW = ml(s.box.w) - 8
      let numW = Drawing.width(num, labCount)
      let tw = min(Drawing.width(title, labFont), max(0, maxW - 8 - 5 - numW))
      let lab = CGRect(
        x: mx(s.box.x) + 4, y: my(s.box.y) - 9, width: min(maxW, 4 + tw + 5 + numW + 4), height: 14.3 + 2)
      ctx.addPath(round(lab, 4))
      ctx.setFillColor(ground.copy(alpha: 0.9) ?? ground)
      ctx.fillPath()
      Drawing.text(ctx, title, labFont, t.ink2, x: lab.minX + 4, midY: lab.midY, width: tw)
      Drawing.text(ctx, num, labCount, t.ink3, x: lab.minX + 4 + tw + 5, midY: lab.midY, width: numW)
    }
    ctx.restoreGState()
    return decodes
  }

  /// An image decoded small, as large as `px` on its longer side
  static func thumbnail(_ url: URL, _ px: CGFloat) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: max(8, Int(px.rounded(.up))),
      kCGImageSourceCreateThumbnailWithTransform: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
  }
}

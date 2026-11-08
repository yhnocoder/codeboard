// Board thumbnails for the library: the board in small, drawn with Core Graphics off the main thread from its MiniMap
// (js/library.ts): the theme's paper, sections with their titles, arrows, and each card as on the board (paper, head strip,
// a Note's colour, a Mark's ink) with its title at a size that stays readable. Large boards show their top-left part at a
// legible scale rather than all of it as specks. Kept in memory per board, file time and appearance.
import AppKit
import SwiftUI

struct MiniMap: Decodable, Hashable {
  struct Card: Decodable, Hashable {
    var x, y, w, h: Double
    var kind: String
    var title: String
    var look: String?
    var fill: String?
  }
  struct Section: Decodable, Hashable {
    var x, y, w, h: Double
    var title: String
    var color: String?
  }
  var cards: [Card]
  var links: [[Int]]
  var sections: [Section]
}

enum Thumbs {
  /** Thumbnail size in points (drawn at 2×) */
  static let size = CGSize(width: 320, height: 200)
  /** Below this the board's text is not worth drawing: the thumbnail shows the start of the board at this scale instead */
  static let minScale: CGFloat = 0.11
  private static let cache = NSCache<NSString, CGImage>()
  private static let queue = DispatchQueue(label: "codeboard.thumbs", qos: .utility)

  static func cached(_ key: String) -> CGImage? { cache.object(forKey: key as NSString) }

  /** Draws off the main thread; done on the main thread */
  static func make(_ map: MiniMap, key: String, dark: Bool, _ done: @escaping (CGImage?) -> Void) {
    queue.async {
      let img = render(map, dark: dark)
      if let img { cache.setObject(img, forKey: key as NSString) }
      DispatchQueue.main.async { done(img) }
    }
  }

  static func render(_ m: MiniMap, dark: Bool) -> CGImage? {
    let scale: CGFloat = 2, W = size.width, H = size.height
    guard let cx = CGContext(data: nil, width: Int(W * scale), height: Int(H * scale), bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    // flipped, in points, like the board
    cx.scaleBy(x: scale, y: scale)
    cx.translateBy(x: 0, y: H)
    cx.scaleBy(x: 1, y: -1)
    let ap = NSAppearance(named: dark ? .darkAqua : .aqua)!
    var out: CGImage?
    ap.performAsCurrentDrawingAppearance {
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(cgContext: cx, flipped: true)
      draw(m, in: CGRect(x: 0, y: 0, width: W, height: H))
      NSGraphicsContext.restoreGraphicsState()
      out = cx.makeImage()
    }
    return out
  }

  private static func draw(_ m: MiniMap, in r: CGRect) {
    Theme.bg.setFill()
    r.fill()
    let rects = m.cards.map { CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h) } + m.sections.map { CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h) }
    guard var bb = rects.first else { return }
    for x in rects { bb = bb.union(x) }
    let pad: CGFloat = 14
    let fit = min((r.width - pad * 2) / max(1, bb.width), (r.height - pad * 2) / max(1, bb.height), 0.5)
    let k = max(fit, minScale)
    // fits: centred; too big to read: its top-left corner
    let ox = fit >= minScale ? (r.width - bb.width * k) / 2 - bb.minX * k : pad - bb.minX * k
    let oy = fit >= minScale ? (r.height - bb.height * k) / 2 - bb.minY * k : pad - bb.minY * k
    let map = { (x: Double, y: Double, w: Double, h: Double) in CGRect(x: x * k + ox, y: y * k + oy, width: w * k, height: h * k) }
    // a title at a size that reads (≥ 6.5 pt) in the card's width
    func label(_ s: String, _ rr: CGRect, size: CGFloat, weight: NSFont.Weight = .semibold, color: NSColor) {
      guard rr.width > 14, rr.height > 6, !s.isEmpty else { return }
      let st = NSMutableParagraphStyle()
      st.lineBreakMode = .byTruncatingTail
      NSAttributedString(string: s, attributes: [.font: NSFont.systemFont(ofSize: max(6.5, size), weight: weight), .foregroundColor: color, .paragraphStyle: st])
        .draw(with: rr, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }
    for s in m.sections {
      let sr = map(s.x, s.y, s.w, s.h)
      let p = NSBezierPath(roundedRect: sr, xRadius: max(2, 14 * k), yRadius: max(2, 14 * k))
      (Theme.sect[s.color ?? ""] ?? Theme.sectFill).setFill()
      p.fill()
      Theme.hair.setStroke()
      p.lineWidth = 0.5
      p.stroke()
      label(s.title, CGRect(x: sr.minX + 4, y: sr.minY + 2, width: sr.width - 8, height: 10), size: 13 * k, weight: .medium, color: Theme.ink2)
    }
    // arrows under the cards: a soft curve between card centres
    Theme.edge.withAlphaComponent(0.7).setStroke()
    for l in m.links where l.count == 2 && l[0] < m.cards.count && l[1] < m.cards.count {
      let a = m.cards[l[0]], b = m.cards[l[1]]
      let p = NSBezierPath()
      let pa = CGPoint(x: (a.x + a.w / 2) * k + ox, y: (a.y + a.h / 2) * k + oy), pb = CGPoint(x: (b.x + b.w / 2) * k + ox, y: (b.y + b.h / 2) * k + oy)
      p.move(to: pa)
      let dx = (pb.x - pa.x) / 2
      p.curve(to: pb, controlPoint1: CGPoint(x: pa.x + dx, y: pa.y), controlPoint2: CGPoint(x: pb.x - dx, y: pb.y))
      p.lineWidth = 0.8
      p.stroke()
    }
    for c in m.cards {
      let cr = map(c.x, c.y, c.w, c.h)
      guard cr.intersects(r) else { continue }
      let radius = max(1.5, Theme.cardRadius * k)
      let look = c.look ?? "note"
      if c.kind == "note" && (look == "mark" || look == "freetext" || look == "text") {
        // words on the board, no paper
        label(c.title, cr, size: (look == "freetext" ? 22 : 15) * k, weight: look == "text" ? .regular : .semibold, color: look == "mark" ? Theme.hand["blue"]! : Theme.ink)
        continue
      }
      let paper = NSBezierPath(roundedRect: cr, xRadius: radius, yRadius: radius)
      let sticky = c.kind == "note" && look == "box"
      NSGraphicsContext.saveGraphicsState()
      let sh = NSShadow()
      sh.shadowColor = NSColor.black.withAlphaComponent(0.18)
      sh.shadowBlurRadius = 2
      sh.shadowOffset = NSSize(width: 0, height: -0.6)
      sh.set()
      (sticky ? (Theme.box[c.fill ?? "yellow"] ?? Theme.sticky) : Theme.surface).setFill()
      paper.fill()
      NSGraphicsContext.restoreGraphicsState()
      Theme.hair.setStroke()
      paper.lineWidth = 0.5
      paper.stroke()
      let head = min(cr.height, max(5, Theme.headHeight * k))
      if !sticky {
        NSGraphicsContext.saveGraphicsState()
        paper.addClip()
        (c.kind == "code" ? Theme.head : Theme.head).setFill()
        CGRect(x: cr.minX, y: cr.minY, width: cr.width, height: head).fill()
        Theme.line.setFill()
        CGRect(x: cr.minX, y: cr.minY + head, width: cr.width, height: 0.5).fill()
        NSGraphicsContext.restoreGraphicsState()
      }
      label(c.title, CGRect(x: cr.minX + 3, y: cr.minY + max(0.5, (head - 9) / 2), width: cr.width - 6, height: max(head, 9)), size: 13 * k, color: sticky ? Theme.stickyInk : Theme.ink)
      // the body as lines of text: code in the token colours' ink, prose in grey
      let bodyTop = cr.minY + (sticky ? 11 : head + 4), lh: CGFloat = max(2.5, 20 * k)
      var y = bodyTop
      var i = 0
      (c.kind == "code" ? Theme.tok["fn"]! : Theme.ink3).withAlphaComponent(0.35).setFill()
      while y + lh * 0.5 < cr.maxY - 3, i < 40 {
        let w = (cr.width - 8) * (i % 4 == 3 ? 0.55 : i % 3 == 1 ? 0.8 : 0.92) - (c.kind == "code" ? CGFloat(i % 5) * 6 * k : 0)
        CGRect(x: cr.minX + 4 + (c.kind == "code" ? CGFloat(i % 3) * 8 * k : 0), y: y, width: max(2, w), height: max(0.8, lh * 0.38)).fill()
        y += lh
        i += 1
      }
    }
  }
}

/** A board's thumbnail: drawn off the main thread the first time, then from the cache */
struct BoardThumb: View {
  var map: MiniMap
  var key: String
  @Environment(\.colorScheme) private var scheme
  @ObservedObject private var look = Look.shared
  @State private var image: (key: String, img: CGImage)?
  var body: some View {
    let k = "\(key)|\(scheme == .dark)|\(look.chrome.board)"
    ZStack {
      Color(nsColor: Theme.bg)
      if let img = Thumbs.cached(k) ?? image.flatMap({ $0.key == k ? $0.img : nil }) {
        Image(decorative: img, scale: 2).resizable().aspectRatio(contentMode: .fill)
      }
    }
    .task(id: k) {
      if Thumbs.cached(k) != nil { return }
      Thumbs.make(map, key: k, dark: scheme == .dark) { image = $0.map { (k, $0) } }
    }
  }
}

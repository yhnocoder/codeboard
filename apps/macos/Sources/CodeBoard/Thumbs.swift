// Board thumbnails for the library: the board in small, drawn off the main thread with the canvas's own card drawing
// (CardLayer.drawCard: the look's paper, heads, blocks for text, Ink Wash's sheets and brush frames), its Sections and arrows.
// A board that fits is centred; a large one shows its densest part at a scale where cards still read. Kept in memory per
// board, file time and appearance.
import AppKit
import SwiftUI

/** js/library.ts MiniScene: the board's cards and Sections as its scene has them, its arrows as card indexes */
struct MiniScene: Decodable {
  var cards: [SceneCard]
  var sections: [SceneSection]
  var links: [[Int]]
}

enum Thumbs {
  /** Thumbnail size in points (drawn at 2×) */
  static let size = CGSize(width: 320, height: 200)
  /** Below this the board's cards are specks: the thumbnail shows its densest part at this scale instead */
  static let minScale: CGFloat = 0.11
  private static let cache = NSCache<NSString, CGImage>()
  private static let queue = DispatchQueue(label: "codeboard.thumbs", qos: .utility)

  static func cached(_ key: String) -> CGImage? { cache.object(forKey: key as NSString) }

  /** Draws off the main thread; done on the main thread */
  static func make(_ m: MiniScene, key: String, dark: Bool, _ done: @escaping (CGImage?) -> Void) {
    queue.async {
      let img = render(m, dark: dark)
      if let img { cache.setObject(img, forKey: key as NSString) }
      DispatchQueue.main.async { done(img) }
    }
  }

  static func render(_ m: MiniScene, dark: Bool) -> CGImage? {
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
      draw(m, in: CGRect(x: 0, y: 0, width: W, height: H), dark: dark)
      NSGraphicsContext.restoreGraphicsState()
      out = cx.makeImage()
    }
    return out
  }

  /** A card's drawn height: the scene's, else a guess from its content (the canvas measures Notes; a thumbnail cannot) */
  private static func height(_ c: SceneCard) -> CGFloat {
    if let h = c.h { return CGFloat(h) }
    switch c.kind {
    case "note": return (c.look == "note" ? Theme.headHeight + 24 : 8) + CGFloat(max(1, (c.md ?? "").split(separator: "\n", omittingEmptySubsequences: false).count)) * 18
    case "web": return 112
    default: return 160
    }
  }

  /** Where the thumbnail looks: everything when it fits at minScale or more, else the window at minScale that holds the most
   *  cards, tried at each card's corner */
  private static func window(_ rects: [CGRect], in r: CGRect) -> (k: CGFloat, origin: CGPoint) {
    guard var bb = rects.first else { return (1, .zero) }
    for x in rects { bb = bb.union(x) }
    let pad: CGFloat = 14
    let fit = min((r.width - pad * 2) / max(1, bb.width), (r.height - pad * 2) / max(1, bb.height), 0.5)
    if fit >= minScale { return (fit, CGPoint(x: (r.width - bb.width * fit) / 2 - bb.minX * fit, y: (r.height - bb.height * fit) / 2 - bb.minY * fit)) }
    let k = minScale, ww = r.width / k, wh = r.height / k
    var best = CGPoint(x: bb.minX - pad, y: bb.minY - pad), most = -1
    // ponytail: every corner against every card, fine for the 400 cards a thumbnail gets at most
    for c in rects {
      let win = CGRect(x: c.minX - pad, y: c.minY - pad, width: ww, height: wh)
      let n = rects.reduce(0) { $0 + (win.contains($1) ? 1 : 0) }
      if n > most { (most, best) = (n, win.origin) }
    }
    return (k, CGPoint(x: -best.x * k, y: -best.y * k))
  }

  private static func draw(_ m: MiniScene, in r: CGRect, dark: Bool) {
    Theme.bg.setFill()
    r.fill()
    if Theme.isInk, let scene = Ink.scene(dark: dark) {
      // the ink scene behind the board, bottom-anchored cover (themes.css .board)
      let k = max(r.width / scene.size.width, r.height / scene.size.height)
      let sz = CGSize(width: scene.size.width * k, height: scene.size.height * k)
      scene.draw(in: CGRect(x: (r.width - sz.width) / 2, y: r.height - sz.height, width: sz.width, height: sz.height), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
    let heights = m.cards.map(height)
    let rects = zip(m.cards, heights).map { CGRect(x: $0.x, y: $0.y, width: $0.w, height: $1) } + m.sections.map { CGRect(x: $0.x, y: $0.y, width: $0.w, height: $0.h) }
    let (k, o) = window(rects, in: r)
    guard let cg = NSGraphicsContext.current?.cgContext else { return }
    let lod = k < CardLayer.lodScale
    // the world at k: everything below draws in board units
    cg.saveGState()
    cg.translateBy(x: o.x, y: o.y)
    cg.scaleBy(x: k, y: k)
    let view = CGRect(x: -o.x / k, y: -o.y / k, width: r.width / k, height: r.height / k)
    for s in m.sections {
      let sr = CGRect(x: s.x, y: s.y, width: s.w, height: s.h)
      guard sr.intersects(view) else { continue }
      if Theme.isInk {
        let font = Theme.brushHand(25)
        let tw = (s.title as NSString).size(withAttributes: [.font: font]).width + 2
        if let path = Ink.frame(w: s.w, h: s.h, seed: s.seed, gap: max(40, tw)) {
          cg.saveGState()
          cg.translateBy(x: sr.minX - Ink.frameMargin - 1, y: sr.minY - Ink.frameMargin - 1)
          cg.addPath(path)
          cg.setFillColor(Theme.ink.withAlphaComponent(Theme.number("sbrush-opacity", 0.72)).cgColor)
          cg.fillPath()
          cg.restoreGState()
        }
        if !lod { NSAttributedString(string: s.title, attributes: [.font: font, .foregroundColor: Theme.ink]).draw(at: CGPoint(x: sr.minX + Theme.number("slabel-ml", 24), y: sr.minY + Theme.number("slabel-mt", -17))) }
      } else {
        let rad = Theme.number("sect-radius", Theme.cardRadius + 1)
        let p = NSBezierPath(roundedRect: sr.insetBy(dx: 0.5, dy: 0.5), xRadius: rad, yRadius: rad)
        (s.color.flatMap { Theme.sect[$0] } ?? Theme.sectFill).setFill()
        p.fill()
        Theme.hair.setStroke()
        p.lineWidth = 0.5
        p.stroke()
        if !lod {
          NSAttributedString(string: s.title, attributes: [.font: Theme.sys(12.5, weight: .semibold), .foregroundColor: Theme.ink2])
            .draw(at: CGPoint(x: sr.minX + Theme.number("slabel-ml", 16) + 6, y: sr.minY + Theme.number("slabel-mt", 6) + 1 + 2))
        }
      }
    }
    // arrows under the cards: a soft curve between card edges (no routing: the thumbnail has no router)
    Theme.edge.setStroke()
    for l in m.links where l.count == 2 && l[0] < m.cards.count && l[1] < m.cards.count {
      let a = rects[l[0]], b = rects[l[1]]
      let p = NSBezierPath()
      let pa = CGPoint(x: a.midX, y: a.midY), pb = CGPoint(x: b.midX, y: b.midY)
      p.move(to: pa)
      let dx = (pb.x - pa.x) / 2
      p.curve(to: pb, controlPoint1: CGPoint(x: pa.x + dx, y: pa.y), controlPoint2: CGPoint(x: pb.x - dx, y: pb.y))
      p.lineWidth = 1.5
      p.stroke()
    }
    for (c, cr) in zip(m.cards, rects) {
      guard cr.intersects(view) else { continue }
      let framed = !(c.kind == "note" && c.look != "note") && !(c.kind == "image" && c.bg != true)
      let paper = Theme.isInk && framed
      let p = Paint(card: c, height: cr.height, imageSrc: c.kind == "image" ? c.src : nil, imageMax: Int(cr.width * k * 2), framed: framed, paper: paper, dark: dark)
      cg.saveGState()
      cg.translateBy(x: cr.minX, y: cr.minY)
      let local = CGRect(origin: .zero, size: cr.size)
      if paper { Ink.drawPaper(local, dark: dark, seed: c.seed) } else if framed {
        // the card's soft shadow (styles.css --sh-card), one shadow as the layer casts it
        if let sh = Theme.shadows(Theme.isInk ? "card-shadow" : "card-soft-shadow").filter({ !$0.inset }).max(by: { $0.blur < $1.blur }), let col = Theme.parse(sh.color) {
          cg.saveGState()
          cg.setShadow(offset: CGSize(width: sh.x, height: -sh.y), blur: sh.blur, color: col.cgColor)
          Theme.surface.setFill()
          NSBezierPath(roundedRect: local, xRadius: Theme.cardRadius, yRadius: Theme.cardRadius).fill()
          cg.restoreGState()
        }
      }
      CardLayer.drawCard(p, in: local, lod: lod)
      cg.restoreGState()
    }
    cg.restoreGState()
  }
}

/** A board's thumbnail: drawn off the main thread the first time, then from the cache */
struct BoardThumb: View {
  var scene: MiniScene
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
      Thumbs.make(scene, key: k, dark: scheme == .dark) { image = $0.map { (k, $0) } }
    }
  }
}

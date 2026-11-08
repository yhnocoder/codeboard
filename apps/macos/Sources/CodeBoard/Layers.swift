// The layers the canvas is made of: one CardLayer per card (its look drawn into a bitmap with AppKit text, re-rasterised only when
// the zoom crosses a bucket), a SectionLayer per Section and an ArrowLayer per link (shape layers: a filled taper, a dart head).
// Pan, zoom and drag move these layers; nothing here waits on JavaScript.
import AppKit

/** The bitmap scale a card is drawn at for a zoom: a few buckets, so zooming re-rasterises rarely and never below what is readable */
func rasterBucket(zoom: CGFloat, backing: CGFloat) -> CGFloat {
  let z: CGFloat = zoom < 0.18 ? 0.125 : zoom < 0.35 ? 0.25 : zoom < 0.7 ? 0.5 : zoom < 1.4 ? 1 : 2
  return z * backing
}

/** What one raster of a card draws: a copy of the card and its prepared content, so the drawing can run off the main thread */
struct Paint {
  var card: SceneCard
  var height: CGFloat
  var noteText: NSAttributedString?
  /** An Image card: the file, decoded on the raster queue no larger than this many pixels across */
  var imageSrc: String?
  var imageMax: Int
  var selected: Bool
  var framed: Bool
}

final class CardLayer: CALayer {
  private(set) var card: SceneCard
  /** The card's drawn height (its Place's, or measured from its content) */
  private(set) var height: CGFloat = 0
  private var noteText: NSAttributedString?
  /** An Image card's pixel size, from the file's header (no decode on the main thread) */
  private var imageSize: CGSize?
  /** Has a bitmap now (the canvas drops the bitmaps of cards far off screen) */
  var drawn = false
  var selected = false {
    didSet { if selected != oldValue { setNeedsDisplay() } }
  }
  /** Below this bitmap scale a card is drawn as blocks: its paper, head and a few bars, no text */
  static let lodScale: CGFloat = 0.3
  /** Rasters run here, a few at a time; the main thread only hands over the finished bitmap */
  private static let queue = DispatchQueue(label: "codeboard.raster", qos: .userInteractive, attributes: .concurrent)
  private var gen = 0
  /** Decoded images by file and size, no larger than a card needs (a 4000px screenshot is not decoded again for every raster); the
   *  oldest go when there are more than `imageCacheMax` */
  private static var imageCache: [String: CGImage] = [:]
  private static var imageOrder: [String] = []
  private static let imageCacheMax = 64
  private static let imageLock = NSLock()

  init(card: SceneCard) {
    self.card = card
    super.init()
    needsDisplayOnBoundsChange = false
    anchorPoint = .zero
    shadowOffset = CGSize(width: 0, height: 3)
    shadowRadius = 7
    shadowColor = NSColor.black.cgColor
    apply(card)
  }
  override init(layer: Any) {
    let l = layer as! CardLayer
    card = l.card
    super.init(layer: layer)
  }
  required init?(coder: NSCoder) { fatalError() }

  var worldRect: CGRect { CGRect(x: card.x, y: card.y, width: card.w, height: height) }
  var framed: Bool { !(card.kind == "note" && card.look != "note") && !(card.kind == "image" && card.bg != true) }

  /** A new version of the card: content, place, measured height */
  func apply(_ c: SceneCard) {
    card = c
    noteText = nil
    imageSize = nil
    if c.kind == "note", let md = c.md { noteText = CardLayer.noteString(c, md) }
    if c.kind == "image", let src = c.src { imageSize = CardLayer.imageSize(src) }
    height = c.h.map { CGFloat($0) } ?? measure()
    frame = CGRect(x: c.x, y: c.y, width: c.w, height: height)
    shadowOpacity = framed ? 0.14 : 0
    shadowPath = framed ? CGPath(roundedRect: bounds, cornerWidth: Theme.cardRadius, cornerHeight: Theme.cardRadius, transform: nil) : nil
    setNeedsDisplay()
  }

  func move(to p: CGPoint) {
    card.x = p.x
    card.y = p.y
    frame.origin = p
  }

  /** The image's size from its header: cheap, for measuring the card */
  static func imageSize(_ src: String) -> CGSize? {
    guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: src) as CFURL, nil),
      let p = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any],
      let w = p[kCGImagePropertyPixelWidth] as? CGFloat, let h = p[kCGImagePropertyPixelHeight] as? CGFloat
    else { return nil }
    let turned = ((p[kCGImagePropertyOrientation] as? UInt32) ?? 1) >= 5
    return turned ? CGSize(width: h, height: w) : CGSize(width: w, height: h)
  }
  /** Decoded no larger than maxPixels across; called on the raster queue */
  static func loadImage(_ src: String, maxPixels: Int) -> CGImage? {
    let px = max(256, maxPixels)
    let key = "\(src)@\(px)"
    imageLock.lock()
    let hit = imageCache[key]
    imageLock.unlock()
    if let hit { return hit }
    guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: src) as CFURL, nil) else { return nil }
    let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: px, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true]
    guard let img = CGImageSourceCreateThumbnailAtIndex(s, 0, opts as CFDictionary) else { return nil }
    imageLock.lock()
    if imageCache[key] == nil {
      imageCache[key] = img
      imageOrder.append(key)
      while imageOrder.count > imageCacheMax { imageCache[imageOrder.removeFirst()] = nil }
    }
    imageLock.unlock()
    return img
  }

  /** The layer needs a bitmap: drawn on the raster queue, put in when done (the old one stays until then, so no frame is blank) */
  override func display() {
    gen += 1
    let g = gen
    let size = bounds.size
    let scale = min(contentsScale, sqrt(2_500_000 / max(1, size.width * size.height)))
    let paint = Paint(card: card, height: height, noteText: noteText, imageSrc: card.kind == "image" ? card.src : nil, imageMax: Int(card.w * scale), selected: selected, framed: framed)
    let appearance = Theme.appearance
    CardLayer.queue.async {
      let img = CardLayer.render(paint, size: size, scale: scale, appearance: appearance)
      DispatchQueue.main.async { [weak self] in
        guard let self, self.gen == g else { return }
        self.contents = img
        self.contentsScale = scale
      }
    }
  }

  static func render(_ p: Paint, size: CGSize, scale: CGFloat, appearance: NSAppearance) -> CGImage? {
    let w = max(1, Int((size.width * scale).rounded())), h = max(1, Int((size.height * scale).rounded()))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: 0, y: size.height)
    ctx.scaleBy(x: 1, y: -1)
    let gc = NSGraphicsContext(cgContext: ctx, flipped: true)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = gc
    appearance.performAsCurrentDrawingAppearance { drawCard(p, in: CGRect(origin: .zero, size: size), lod: scale < lodScale) }
    NSGraphicsContext.restoreGraphicsState()
    return ctx.makeImage()
  }

  private static let pad: CGFloat = 12
  private static func noteString(_ c: SceneCard, _ md: String) -> NSAttributedString {
    switch c.look ?? "note" {
    case "note":
      return Markdown.render(Markdown.body(md, droppingHeading: c.title))
    case "text":
      let size: CGFloat = c.size == "title" ? 22 : c.size == "heading" ? 16 : 13.5
      let f = c.size == "title" ? Theme.serif(size, weight: .semibold) : Theme.sys(size, weight: c.bold == true || c.size == "heading" ? .semibold : .regular)
      return Markdown.render(md, style: .init(body: size, font: { _, w in w == .regular ? f : NSFont.systemFont(ofSize: size, weight: .semibold) }))
    case "box":
      return Markdown.render(md, style: .init(body: 13.5, ink: Theme.stickyInk))
    case "mark":
      let fs = CGFloat(c.fs ?? 18)
      let bold = c.weight == "bold"
      let color = Theme.hand[c.hand ?? "blue"] ?? Theme.ink
      return NSAttributedString(string: md, attributes: [.font: Theme.handwriting(fs, bold: bold), .foregroundColor: color])
    default:  // freetext: plain text, the level's size, headings in the display face
      let base: [Int: CGFloat] = [0: 20, 1: 40, 2: 30, 3: 24]
      let fs = CGFloat(c.fs ?? Double(base[c.level ?? 0] ?? 20))
      let f = (c.level ?? 0) > 0 ? Theme.serif(fs, weight: .semibold) : Theme.sys(fs)
      return NSAttributedString(string: md, attributes: [.font: f, .foregroundColor: Theme.ink])
    }
  }

  /** The height of a card the board did not size: from its content at its width */
  private func measure() -> CGFloat {
    let w = CGFloat(card.w)
    switch card.kind {
    case "note":
      guard let t = noteText else { return 60 }
      let look = card.look ?? "note"
      if look == "note" { return Theme.headHeight + CardLayer.pad * 2 + Markdown.height(t, width: w - CardLayer.pad * 2) }
      if look == "box" { return 20 + Markdown.height(t, width: w - 20) }
      return 4 + Markdown.height(t, width: w - 8)
    case "image":
      guard let imageSize, imageSize.width > 0 else { return 160 }
      let inner = card.bg == true ? w - 16 : w
      let h = inner * imageSize.height / imageSize.width
      return card.bg == true ? h + 16 : h
    case "board": return 240
    case "web": return 112
    default: return 160
    }
  }

  private static func drawCard(_ p: Paint, in r: CGRect, lod: Bool) {
    let radius = Theme.cardRadius
    let paper = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
    if p.framed {
      Theme.surface.setFill()
      paper.fill()
    }
    switch p.card.kind {
    case "code": drawCode(p, r, lod: lod)
    case "note": drawNote(p, r, lod: lod)
    case "image": drawImage(p, r)
    case "board": drawBoard(p, r, lod: lod)
    default: drawHead(p, r, glyph: p.card.kind == "web" ? "🌐" : "▣", title: p.card.title, lod: lod)
    }
    if p.framed {
      Theme.hair.setStroke()
      paper.lineWidth = 1
      paper.stroke()
    }
    if p.selected {
      let ring = NSBezierPath(roundedRect: r.insetBy(dx: 1, dy: 1), xRadius: radius, yRadius: radius)
      Theme.accent.setStroke()
      ring.lineWidth = 2
      ring.stroke()
    }
  }

  private static func drawHead(_ p: Paint, _ r: CGRect, glyph: String, title: String, lod: Bool, note: Bool = false) {
    let hh = Theme.headHeight
    let head = NSBezierPath(roundedRect: CGRect(x: 0.5, y: 0.5, width: r.width - 1, height: hh), xRadius: Theme.cardRadius, yRadius: Theme.cardRadius)
    head.appendRect(CGRect(x: 0.5, y: hh / 2, width: r.width - 1, height: hh / 2 + 0.5))
    Theme.head.setFill()
    head.fill()
    Theme.line.setFill()
    CGRect(x: 0.5, y: hh, width: r.width - 1, height: 1).fill()
    if lod {
      Theme.ink3.withAlphaComponent(0.5).setFill()
      CGRect(x: 12, y: 12, width: min(r.width * 0.5, 160), height: 12).fill()
      return
    }
    let gfont = Theme.mono(10.5, weight: .medium)
    let g = NSAttributedString(string: glyph, attributes: [.font: gfont, .foregroundColor: Theme.ink2])
    let gw = max(20, g.size().width + 10)
    let pill = NSBezierPath(roundedRect: CGRect(x: 10, y: (hh - 19) / 2, width: gw, height: 19), xRadius: 7, yRadius: 7)
    Theme.hair.setFill()
    pill.fill()
    g.draw(at: CGPoint(x: 10 + (gw - g.size().width) / 2, y: (hh - g.size().height) / 2))
    let tfont = note ? Theme.sys(12.5, weight: .semibold) : Theme.mono(12, weight: .medium)
    let one = NSMutableParagraphStyle()
    one.lineBreakMode = .byTruncatingTail
    let t = NSAttributedString(string: title.replacingOccurrences(of: "\n", with: " "), attributes: [.font: tfont, .foregroundColor: Theme.ink, .paragraphStyle: one])
    let tx = 10 + gw + 8
    t.draw(with: CGRect(x: tx, y: (hh - t.size().height) / 2, width: r.width - tx - 10, height: t.size().height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    if p.card.locked == true {
      let l = NSAttributedString(string: "🔒", attributes: [.font: Theme.sys(10)])
      l.draw(at: CGPoint(x: r.width - 24, y: (hh - l.size().height) / 2))
    }
  }

  private static func drawCode(_ p: Paint, _ r: CGRect, lod: Bool) {
    drawHead(p, r, glyph: p.card.glyph ?? "⋮", title: p.card.title, lod: lod)
    guard let segs = p.card.segments else { return }
    let row = Theme.codeRow
    var y = Theme.headHeight + 6
    let font = Theme.mono(11)
    let ch = ("0" as NSString).size(withAttributes: [.font: font]).width
    let maxLine = segs.flatMap { $0.lines }.map(\.n).max() ?? 1
    let nd = max(3, String(maxLine).count)
    let gutter = 17 + CGFloat(nd) * ch + 22
    if lod {
      Theme.ink3.withAlphaComponent(0.35).setFill()
      for s in segs {
        for l in s.lines {
          let len = l.toks.reduce(0) { $0 + $1.text.count }
          let lead = l.toks.first.map { $0.text.prefix { $0 == " " }.count } ?? 0
          if len > lead { CGRect(x: gutter + CGFloat(lead) * ch, y: y + 6, width: min(r.width - gutter - 18, CGFloat(len - lead) * ch), height: 8).fill() }
          y += row
        }
        y += 20
      }
      return
    }
    let para = NSMutableParagraphStyle()
    para.minimumLineHeight = row
    para.maximumLineHeight = row
    para.lineBreakMode = .byClipping
    para.tabStops = []
    para.defaultTabInterval = ch * 4
    let numPara = NSMutableParagraphStyle()
    numPara.minimumLineHeight = row
    numPara.maximumLineHeight = row
    numPara.alignment = .right
    let numAttrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: Theme.ink3.withAlphaComponent(0.8), .paragraphStyle: numPara]
    for (i, s) in segs.enumerated() {
      if i > 0 {
        Theme.line.setFill()
        CGRect(x: 0.5, y: y + 9, width: r.width - 1, height: 1).fill()
        if !s.path.isEmpty {
          let p = NSAttributedString(string: "\(s.path) \(s.start)–\(s.end)", attributes: [.font: Theme.sys(10), .foregroundColor: Theme.ink3])
          p.draw(at: CGPoint(x: gutter, y: y + 2))
        }
        y += 20
      }
      let code = NSMutableAttributedString()
      let nums = NSMutableAttributedString()
      for (k, l) in s.lines.enumerated() {
        if k > 0 {
          code.append(NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: para]))
          nums.append(NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: numPara]))
        }
        nums.append(NSAttributedString(string: String(l.n), attributes: numAttrs))
        for t in l.toks {
          let color = t.cls.flatMap { Theme.tok[$0.split(separator: " ").first.map(String.init) ?? ""] } ?? Theme.ink
          code.append(NSAttributedString(string: t.text, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: para]))
        }
      }
      let h = CGFloat(s.lines.count) * row
      nums.draw(with: CGRect(x: 17, y: y, width: CGFloat(nd) * ch, height: h), options: [.usesLineFragmentOrigin])
      NSGraphicsContext.current?.cgContext.saveGState()
      NSGraphicsContext.current?.cgContext.clip(to: CGRect(x: gutter, y: y, width: r.width - gutter - 6, height: h))
      code.draw(with: CGRect(x: gutter, y: y, width: 100000, height: h), options: [.usesLineFragmentOrigin])
      NSGraphicsContext.current?.cgContext.restoreGState()
      y += h
    }
  }

  private static func drawNote(_ p: Paint, _ r: CGRect, lod: Bool) {
    let look = p.card.look ?? "note"
    let pad = pad
    switch look {
    case "note":
      drawHead(p, r, glyph: "¶", title: p.card.title, lod: lod, note: true)
      guard let t = p.noteText else { return }
      if lod {
        Theme.ink3.withAlphaComponent(0.35).setFill()
        var y = Theme.headHeight + pad
        while y + 8 < r.height - pad {
          CGRect(x: pad, y: y, width: r.width - pad * 2 - (y.truncatingRemainder(dividingBy: 3 * 18) == 0 ? 60 : 0), height: 8).fill()
          y += 18
        }
        return
      }
      t.draw(with: CGRect(x: pad, y: Theme.headHeight + pad, width: r.width - pad * 2, height: r.height - Theme.headHeight - pad * 2), options: [.usesLineFragmentOrigin, .usesFontLeading])
    case "box":
      let fill = Theme.box[p.card.fill ?? "yellow"] ?? Theme.sticky
      let bp = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
      fill.setFill()
      bp.fill()
      Theme.hair.setStroke()
      bp.stroke()
      if !lod { p.noteText?.draw(with: r.insetBy(dx: 10, dy: 10), options: [.usesLineFragmentOrigin, .usesFontLeading]) }
    default:
      if lod {
        Theme.ink3.withAlphaComponent(0.35).setFill()
        CGRect(x: 4, y: 6, width: r.width * 0.8, height: max(8, r.height * 0.5)).fill()
      } else {
        p.noteText?.draw(with: r.insetBy(dx: 4, dy: 2), options: [.usesLineFragmentOrigin, .usesFontLeading])
      }
    }
  }

  private static func drawImage(_ p: Paint, _ r: CGRect) {
    let inset: CGFloat = p.card.bg == true ? 8 : 0
    let box = r.insetBy(dx: inset, dy: inset)
    let clip = NSBezierPath(roundedRect: box, xRadius: p.card.bg == true ? 6 : Theme.cardRadius, yRadius: p.card.bg == true ? 6 : Theme.cardRadius)
    guard let src = p.imageSrc, let image = CardLayer.loadImage(src, maxPixels: p.imageMax) else {
      Theme.head.setFill()
      clip.fill()
      return
    }
    NSGraphicsContext.current?.saveGraphicsState()
    clip.addClip()
    let cg = NSGraphicsContext.current!.cgContext
    cg.saveGState()
    cg.translateBy(x: box.minX, y: box.maxY)
    cg.scaleBy(x: 1, y: -1)
    cg.interpolationQuality = .high
    cg.draw(image, in: CGRect(x: 0, y: 0, width: box.width, height: box.height))
    cg.restoreGState()
    NSGraphicsContext.current?.restoreGraphicsState()
  }

  private static func drawBoard(_ p: Paint, _ r: CGRect, lod: Bool) {
    drawHead(p, r, glyph: "▦", title: p.card.boardName ?? "Board", lod: lod, note: true)
    guard let mini = p.card.mini, !mini.isEmpty else { return }
    let inner = CGRect(x: 10, y: Theme.headHeight + 10, width: r.width - 20, height: r.height - Theme.headHeight - 20)
    let minX = mini.map(\.x).min()!, minY = mini.map(\.y).min()!
    let maxX = mini.map { $0.x + $0.w }.max()!, maxY = mini.map { $0.y + $0.h }.max()!
    let s = min(inner.width / max(1, maxX - minX), inner.height / max(1, maxY - minY))
    for m in mini {
      let rr = CGRect(x: inner.minX + (m.x - minX) * s, y: inner.minY + (m.y - minY) * s, width: max(2, m.w * s), height: max(2, m.h * s))
      let bp = NSBezierPath(roundedRect: rr, xRadius: 2, yRadius: 2)
      (m.kind == "note" ? Theme.head : Theme.bg).setFill()
      bp.fill()
      Theme.hair.setStroke()
      bp.lineWidth = 0.5
      bp.stroke()
    }
  }
}

/** A Section: a shape layer (no bitmap: a Section can be the size of the board) and its title */
final class SectionLayer: CALayer {
  private(set) var section: SceneSection
  private let shape = CAShapeLayer()
  private let title = CATextLayer()
  init(section: SceneSection) {
    self.section = section
    super.init()
    anchorPoint = .zero
    shape.lineWidth = 1
    title.font = Theme.sys(12.5, weight: .semibold)
    title.fontSize = 12.5
    title.truncationMode = .end
    title.anchorPoint = .zero
    addSublayer(shape)
    addSublayer(title)
    apply(section)
  }
  override init(layer: Any) {
    section = (layer as! SectionLayer).section
    super.init(layer: layer)
  }
  required init?(coder: NSCoder) { fatalError() }
  func apply(_ s: SceneSection) {
    section = s
    frame = CGRect(x: s.x, y: s.y, width: s.w, height: s.h)
    shape.frame = bounds
    shape.path = CGPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), cornerWidth: Theme.cardRadius + 1, cornerHeight: Theme.cardRadius + 1, transform: nil)
    title.string = s.title
    title.frame = CGRect(x: 14, y: 9, width: max(0, s.w - 28), height: 18)
    recolor()
  }
  /** The title's bitmap scale follows the zoom like the cards' */
  func setScale(_ scale: CGFloat) {
    title.contentsScale = max(0.5, scale)
    title.isHidden = scale < 0.2
  }
  func recolor() {
    Theme.appearance.performAsCurrentDrawingAppearance {
      shape.fillColor = (section.color.flatMap { Theme.sect[$0] } ?? Theme.sectFill).cgColor
      shape.strokeColor = Theme.hair.cgColor
      title.foregroundColor = Theme.ink2.cgColor
    }
  }
}

final class ArrowLayer: CALayer {
  let line = CAShapeLayer()
  let line2 = CAShapeLayer()
  let head = CAShapeLayer()
  let tail = CAShapeLayer()
  private(set) var link: SceneLink
  init(link: SceneLink) {
    self.link = link
    super.init()
    anchorPoint = .zero
    for l in [line, line2, head, tail] { addSublayer(l) }
    apply(link)
  }
  override init(layer: Any) {
    link = (layer as! ArrowLayer).link
    super.init(layer: layer)
  }
  required init?(coder: NSCoder) { fatalError() }
  var color: NSColor {
    if let h = link.hand { return Theme.hand[h] ?? Theme.edge }
    if let c = link.color, let k = Theme.link[c] { return k }
    return Theme.edge
  }
  func apply(_ l: SceneLink) {
    link = l
    recolor()
  }
  func recolor() {
    var c = color.cgColor
    Theme.appearance.performAsCurrentDrawingAppearance { c = color.cgColor }
    let stroked = link.dash == true || link.hand != nil
    line.fillColor = stroked ? nil : c
    line.strokeColor = stroked ? c : nil
    line.lineWidth = link.hand != nil ? 1.6 : 1.5 * CGFloat(link.width) / 2
    line.lineDashPattern = link.dash == true ? [5, 4] : nil
    line.lineCap = .round
    line2.strokeColor = c
    line2.fillColor = nil
    line2.lineWidth = 1.2
    line2.lineCap = .round
    head.fillColor = c
    tail.fillColor = c
    if link.hand != nil {
      head.fillColor = nil
      head.strokeColor = c
      head.lineWidth = 1.6
      tail.fillColor = nil
      tail.strokeColor = c
      tail.lineWidth = 1.6
    }
  }
  func apply(geo: RouteGeo) {
    let stroked = link.dash == true || link.hand != nil
    line.path = SVGPath.parse(stroked ? geo.d : (geo.taper ?? geo.d))
    line2.path = geo.d2.map(SVGPath.parse)
    head.path = geo.head.map(SVGPath.parse)
    tail.path = geo.tail.map(SVGPath.parse)
  }
}

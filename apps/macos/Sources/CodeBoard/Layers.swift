// The layers the canvas is made of: one CardLayer per card (Code / Image / sub-board cards drawn into a bitmap with AppKit text,
// Notes rendered by the web page through NoteRenderer; re-rasterised only when the zoom crosses a bucket), a SectionLayer per
// Section and an ArrowLayer per link (shape layers: a filled taper, a dart head). Pan, zoom and drag move these layers; nothing
// here waits on JavaScript.
import AppKit
import IOSurface

/** The bitmap scale a card is drawn at for a zoom: a few buckets, so zooming re-rasterises rarely and never below what is readable */
func rasterBucket(zoom: CGFloat, backing: CGFloat) -> CGFloat {
  let z: CGFloat = zoom < 0.18 ? 0.125 : zoom < 0.35 ? 0.25 : zoom < 0.7 ? 0.5 : zoom < 1.4 ? 1 : 2
  return z * backing
}

/** What one raster of a card draws: a copy of the card and its prepared content, so the drawing can run off the main thread */
struct Paint {
  var card: SceneCard
  var height: CGFloat
  /** An Image card: the file, decoded on the raster queue no larger than this many pixels across */
  var imageSrc: String?
  var imageMax: Int
  var framed: Bool
  /** A Note as the web page rendered it: drawn in place of the native card face */
  var pdf: NotePDF?
}

final class CardLayer: CALayer {
  private(set) var card: SceneCard
  /** The card's drawn height (its Place's, or measured from its content) */
  private(set) var height: CGFloat = 0
  /** An Image card's pixel size, from the file's header (no decode on the main thread) */
  private var imageSize: CGSize?
  /** Has a bitmap now (the canvas drops the bitmaps of cards far off screen) */
  var drawn = false
  /** The height is the board's own (Place.h): the page draws the card at it, however long the text */
  private var fixed = false
  /** Off screen: the bitmap goes, and a raster in flight lands nowhere */
  func drop() {
    gen += 1
    contents = nil
    drawn = false
  }
  /** The selection ring: a sublayer, so selecting never re-rasterises the card */
  private let ring = CAShapeLayer()
  var selected = false {
    didSet { if selected != oldValue { ring.isHidden = !selected } }
  }
  /** Notes are rendered by the web page (the canvas hands over its renderer) */
  weak var notes: NoteRenderer?
  /** The height changed after a Note was measured (the canvas re-routes its arrows) */
  var onMeasured: ((CardLayer) -> Void)?
  /** A Note's new bitmap landed (the edit card hides itself once the card shows the text it wrote) */
  var onRendered: ((CardLayer) -> Void)?
  /** Below this bitmap scale a card is drawn as blocks: its paper, head and a few bars, no text */
  static let lodScale: CGFloat = 0.3
  /** Rasters run here, three at a time (each holds a bitmap of up to `maxPixels` while it draws); the main thread only hands over
   *  the finished surface. A raster not started when the next one for the same layer is asked for is dropped */
  private static let queue: OperationQueue = {
    let q = OperationQueue()
    q.name = "codeboard.raster"
    q.qualityOfService = .userInteractive
    q.maxConcurrentOperationCount = 3
    return q
  }()
  /** A bitmap no larger than this (a 2× Note 380 wide is about 1.8M): one is 4 bytes a pixel */
  static let maxPixels: CGFloat = 1_600_000
  /** The space the bitmaps are drawn in and tagged with: sRGB, which the compositor converts to the display on the GPU. Untagged
   *  surfaces, or ones tagged with the window's ICC profile, cost it a pinch across every zoom bucket (40–60 % late frames) */
  static let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
  /** The card's shadow is drawn into its bitmap (Core Animation's own shadow is re-rendered for every layer on every zoom frame):
   *  the layer is this much bigger than the card on each side */
  static let shadowPad: CGFloat = 20
  /** Paper and corners until the first bitmap lands: a card is never a blank */
  private let placeholder = CALayer()
  private var gen = 0
  private var pendingOp: Operation?
  /** A finished bitmap goes here (the canvas lands a few per frame, nearest first) instead of straight into the layer */
  var handover: ((CardLayer, IOSurface, CGFloat, Int) -> Void)?
  /** Decoded images by file and size, no larger than a card needs (a 4000px screenshot is not decoded again for every raster); the
   *  oldest go when there are more than `imageCacheMax` */
  private static var imageCache: [String: CGImage] = [:]
  private static var imageOrder: [String] = []
  private static let imageCacheMax = 64
  private static let imageLock = NSLock()

  init(card: SceneCard, notes: NoteRenderer? = nil) {
    self.card = card
    self.notes = notes
    super.init()
    needsDisplayOnBoundsChange = false
    anchorPoint = .zero
    ring.fillColor = nil
    ring.lineWidth = 2
    ring.isHidden = true
    addSublayer(ring)
    apply(card)
    if framed {
      placeholder.backgroundColor = Theme.surface.cgColor
      placeholder.cornerRadius = Theme.cardRadius
      placeholder.frame = bounds.insetBy(dx: CardLayer.shadowPad, dy: CardLayer.shadowPad)
      addSublayer(placeholder)
    }
  }
  override init(layer: Any) {
    let l = layer as! CardLayer
    card = l.card
    super.init(layer: layer)
  }
  required init?(coder: NSCoder) { fatalError() }

  var worldRect: CGRect { CGRect(x: card.x, y: card.y, width: card.w, height: height) }
  var framed: Bool { !(card.kind == "note" && card.look != "note") && !(card.kind == "image" && card.bg != true) }

  /** A new version of the card: content, place, measured height. A Note's text is laid out on the raster queue, on the main
   *  thread only when its height is not known (then the layout is what sizes the card) */
  func apply(_ c: SceneCard) {
    card = c
    imageSize = nil
    if c.kind == "image", let src = c.src { imageSize = CardLayer.imageSize(src) }
    // a Note keeps its measured height until the page measures the new text (no jump to a guess)
    height = c.h.map { CGFloat($0) } ?? (c.kind == "note" && height > 0 ? height : measure())
    fixed = c.fixed == true
    setSize(CGSize(width: c.w, height: height))
    frame.origin = CGPoint(x: c.x - CardLayer.shadowPad, y: c.y - CardLayer.shadowPad)
    setNeedsDisplay()
  }
  /** The card's size; the layer is `shadowPad` bigger on every side (the shadow is in the bitmap) */
  private func setSize(_ s: CGSize) {
    let pad = CardLayer.shadowPad
    frame.size = CGSize(width: s.width + 2 * pad, height: s.height + 2 * pad)
    let r = CGRect(origin: CGPoint(x: pad, y: pad), size: s)
    placeholder.frame = r
    ring.frame = r
    ring.path = CGPath(roundedRect: CGRect(origin: .zero, size: s).insetBy(dx: 1, dy: 1), cornerWidth: Theme.cardRadius, cornerHeight: Theme.cardRadius, transform: nil)
    recolor()
  }
  /** The ring takes the appearance's accent */
  func recolor() {
    Theme.appearance.performAsCurrentDrawingAppearance { ring.strokeColor = Theme.accent.cgColor }
  }
  /** A live resize (the pointer on an edge): the frame follows, the bitmap is drawn again when it ends */
  func resize(to s: CGSize) {
    height = s.height
    setSize(s)
  }

  func move(to p: CGPoint, section: String? = nil) {
    card.x = p.x
    card.y = p.y
    if let section { card.section = section }
    frame.origin = CGPoint(x: p.x - CardLayer.shadowPad, y: p.y - CardLayer.shadowPad)
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
    if card.pending == true { return }  // its placeholder, until the coloured card comes
    let g = gen
    if card.kind == "note", let notes {
      // the web page renders Notes as PDFs; until one lands the old bitmap stays (or the placeholder for a brand new card)
      let scale = min(contentsScale, sqrt(CardLayer.maxPixels / max(1, card.w * max(height, 1))))
      let put = { [weak self] (pdf: NotePDF) in
        guard let self, self.gen == g else { return }
        if !self.fixed, abs(pdf.h - self.height) > 0.5 || abs(pdf.w - self.frame.width) > 0.5 {
          self.height = pdf.h
          self.setSize(CGSize(width: self.card.look == "freetext" ? pdf.w : self.card.w, height: pdf.h))
          self.onMeasured?(self)
        }
        var paint = Paint(card: self.card, height: self.height, imageSrc: nil, imageMax: 0, framed: self.framed)
        paint.pdf = pdf
        let size = self.bounds.size, appearance = Theme.appearance
        CardLayer.queue.addOperation {
          let surface = CardLayer.render(paint, size: size, scale: scale, appearance: appearance)
          DispatchQueue.main.async { [weak self] in
            guard let self, self.gen == g, let surface else { return }
            self.land(surface, scale, g)
            self.onRendered?(self)
          }
        }
      }
      if let hit = notes.render(CardSpec(card), done: put) { put(hit); return }
      if contents == nil { drawPlaceholder() }
      return
    }
    let size = bounds.size
    let scale = min(contentsScale, sqrt(CardLayer.maxPixels / max(1, size.width * size.height)))
    let paint = Paint(card: card, height: height, imageSrc: card.kind == "image" ? card.src : nil, imageMax: Int(card.w * scale), framed: framed)
    let appearance = Theme.appearance
    pendingOp?.cancel()
    let op = BlockOperation()
    op.addExecutionBlock { [weak op] in
      if op?.isCancelled == true { return }
      let surface = CardLayer.render(paint, size: size, scale: scale, appearance: appearance)
      DispatchQueue.main.async { [weak self] in
        guard let self, let surface else { return }
        if let h = self.handover { h(self, surface, scale, g) } else { self.land(surface, scale, g) }
      }
    }
    pendingOp = op
    CardLayer.queue.addOperation(op)
  }

  /** The bitmap is shown, unless a newer raster was asked for since (then it is dropped; the old bitmap stays until that one lands) */
  func land(_ surface: IOSurface, _ scale: CGFloat, _ g: Int) {
    guard g == gen else { return }
    contents = surface
    contentsScale = scale
    placeholder.isHidden = true
  }

  /** A Note with no bitmap yet: its paper and head, grey bars for text (drawn at once, off the main thread like the rest) */
  private func drawPlaceholder() {
    let paint = Paint(card: card, height: height, imageSrc: nil, imageMax: 0, framed: framed)
    let size = bounds.size, g = gen, appearance = Theme.appearance
    CardLayer.queue.addOperation {
      let surface = CardLayer.render(paint, size: size, scale: 1, appearance: appearance)
      DispatchQueue.main.async { [weak self] in
        guard let self, self.gen == g, self.contents == nil, let surface else { return }
        self.contents = surface
        self.contentsScale = 1
      }
    }
  }

  /** Drawn straight into an IOSurface: Core Animation shows the surface itself (no copy into its own backing when the contents
   *  are set), and the one buffer is the card's whole cost */
  static func render(_ p: Paint, size: CGSize, scale: CGFloat, appearance: NSAppearance) -> IOSurface? {
    let w = max(1, Int((size.width * scale).rounded())), h = max(1, Int((size.height * scale).rounded()))
    guard let surface = IOSurface(properties: [.width: w, .height: h, .bytesPerElement: 4, .pixelFormat: UInt32(0x42475241)]) else { return nil }  // 'BGRA'
    let space = CardLayer.colorSpace
    surface.setAttachment(space.copyPropertyList()!, forKey: "IOSurfaceColorSpace")
    surface.lock(options: [], seed: nil)
    defer { surface.unlock(options: [], seed: nil) }
    memset(surface.baseAddress, 0, surface.allocationSize)
    guard let ctx = CGContext(data: surface.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: surface.bytesPerRow, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: 0, y: size.height)
    ctx.scaleBy(x: 1, y: -1)
    let gc = NSGraphicsContext(cgContext: ctx, flipped: true)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = gc
    let pad = CardLayer.shadowPad
    appearance.performAsCurrentDrawingAppearance { drawCard(p, in: CGRect(origin: .zero, size: size).insetBy(dx: pad, dy: pad), lod: scale < lodScale) }
    NSGraphicsContext.restoreGraphicsState()
    ctx.flush()
    return surface
  }

  private static let pad: CGFloat = 12
  /** The height of a card the board did not size: from its content at its width */
  private func measure() -> CGFloat {
    let w = CGFloat(card.w)
    switch card.kind {
    case "note":
      // a guess until the page measures it: about 18px a line of Markdown
      let lines = max(1, (card.md ?? "").split(separator: "\n", omittingEmptySubsequences: false).count)
      return (card.look == "note" ? Theme.headHeight + CardLayer.pad * 2 : 8) + CGFloat(lines) * 18
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
      let cg = NSGraphicsContext.current!.cgContext
      cg.saveGState()
      cg.setShadow(offset: CGSize(width: 0, height: -3), blur: 14, color: CGColor(gray: 0, alpha: 0.14))
      Theme.surface.setFill()
      paper.fill()
      cg.restoreGState()
    }
    if let pdf = p.pdf, let page = pdf.doc.page(at: 1) {
      // the page's own paper, border and text; only the shadow is native
      let cg = NSGraphicsContext.current!.cgContext, box = page.getBoxRect(.mediaBox)
      cg.saveGState()
      cg.translateBy(x: r.minX, y: r.maxY)
      cg.scaleBy(x: r.width / box.width, y: -r.height / box.height)
      cg.translateBy(x: -box.minX, y: -box.minY)
      cg.drawPDFPage(page)
      cg.restoreGState()
      return
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
      for range in s.hl ?? [] where range.count == 2 {
        let a = max(range[0], s.start), b = min(range[1], s.end)
        if a > b { continue }
        Theme.accent.withAlphaComponent(0.065).setFill()
        CGRect(x: 0.5, y: y + CGFloat(a - s.start) * row, width: r.width - 1, height: CGFloat(b - a + 1) * row).fill()
      }
      nums.draw(with: CGRect(x: 17, y: y, width: CGFloat(nd) * ch, height: h), options: [.usesLineFragmentOrigin])
      NSGraphicsContext.current?.cgContext.saveGState()
      NSGraphicsContext.current?.cgContext.clip(to: CGRect(x: gutter, y: y, width: r.width - gutter - 6, height: h))
      code.draw(with: CGRect(x: gutter, y: y, width: 100000, height: h), options: [.usesLineFragmentOrigin])
      NSGraphicsContext.current?.cgContext.restoreGState()
      y += h
    }
  }

  /** The placeholder for a Note the page has not rendered yet: head and bars (the look of the lod blocks) */
  private static func drawNote(_ p: Paint, _ r: CGRect, lod: Bool) {
    let look = p.card.look ?? "note"
    let pad = pad
    switch look {
    case "note":
      drawHead(p, r, glyph: "¶", title: p.card.title, lod: true, note: true)
      Theme.ink3.withAlphaComponent(0.35).setFill()
      var y = Theme.headHeight + pad
      while y + 8 < r.height - pad {
        CGRect(x: pad, y: y, width: r.width - pad * 2 - (y.truncatingRemainder(dividingBy: 3 * 18) == 0 ? 60 : 0), height: 8).fill()
        y += 18
      }
    case "box":
      let fill = Theme.box[p.card.fill ?? "yellow"] ?? Theme.sticky
      let bp = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: 8, yRadius: 8)
      fill.setFill()
      bp.fill()
    default:
      Theme.ink3.withAlphaComponent(0.35).setFill()
      CGRect(x: 4, y: 6, width: r.width * 0.8, height: max(8, r.height * 0.5)).fill()
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
  static let foldedHeight: CGFloat = 30
  private(set) var section: SceneSection
  private let shape = CAShapeLayer()
  private let title = CATextLayer()
  init(section: SceneSection) {
    self.section = section
    super.init()
    shouldRasterize = true
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
    // folded: the title bar alone (core keeps the open frame in x, y, w, h)
    frame = CGRect(x: s.x, y: s.y, width: s.w, height: s.collapsed == true ? SectionLayer.foldedHeight : s.h)
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
    rasterizationScale = max(0.125, scale)
  }
  var selected = false {
    didSet { if selected != oldValue { recolor() } }
  }
  func recolor() {
    Theme.appearance.performAsCurrentDrawingAppearance {
      shape.fillColor = (section.color.flatMap { Theme.sect[$0] } ?? Theme.sectFill).cgColor
      shape.strokeColor = (selected ? Theme.accent : Theme.hair).cgColor
      shape.lineWidth = selected ? 1.5 : 1
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
    // a bitmap of the arrow at the zoom bucket's scale, like a card: a zoom frame scales it instead of filling the shapes again
    shouldRasterize = true
    for l in [line, line2, head, tail] { addSublayer(l) }
    apply(link)
  }
  func setScale(_ scale: CGFloat) { rasterizationScale = max(0.125, scale) }
  override init(layer: Any) {
    link = (layer as! ArrowLayer).link
    super.init(layer: layer)
  }
  required init?(coder: NSCoder) { fatalError() }
  /** The route itself (geo.d), for hit testing */
  private var route: CGPath?
  var selected = false {
    didSet { if selected != oldValue { recolor() } }
  }
  var color: NSColor {
    if selected { return Theme.accent }
    if let h = link.hand { return Theme.hand[h] ?? Theme.edge }
    if let c = link.color, let k = Theme.link[c] { return k }
    return Theme.edge
  }
  func apply(_ l: SceneLink) {
    link = l
    recolor()
  }
  /** Is the world point within `tolerance` of the line */
  func hit(_ p: CGPoint, tolerance: CGFloat) -> Bool {
    guard let route else { return false }
    return route.copy(strokingWithWidth: tolerance * 2, lineCap: .round, lineJoin: .round, miterLimit: 10).contains(p)
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
    let d = geo.path(geo.n.d, geo.s.d)
    route = d
    line.path = stroked ? d : (geo.path(geo.n.taper, geo.s.taper) ?? d)
    line2.path = geo.path(geo.n.d2, geo.s.d2)
    head.path = geo.path(geo.n.head, geo.s.head)
    tail.path = geo.path(geo.n.tail, geo.s.tail)
    // the layer's own box around its paths (the paths stay in world coordinates: bounds.origin shifts them in), so the raster
    // is just the arrow
    var box = CGRect.null
    for l in [line, line2, head, tail] { if let p = l.path { box = box.union(p.boundingBoxOfPath) } }
    if !box.isNull {
      box = box.insetBy(dx: -8, dy: -8)
      bounds = box
      position = box.origin
    }
  }
}

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
  /** Ink Wash: the paper under the card (a bitmap of its own, PAPER_M outside the card) */
  var paper: Bool
  var dark: Bool
  /** A code card's Always Show notes: their heights by "<segment index>:<after line>" (measured by the page), and where the
   *  drawing put them (filled on the raster queue, read on the main thread after it) */
  var inoteHeights: [String: CGFloat] = [:]
  var slots = Slots()
}
final class Slots {
  var rects: [String: CGRect] = [:]
  /** The head's sidenote count chip (.mk.inline), in card coordinates: a click on it opens the card's Sidenotes */
  var chip: CGRect?
  /** A code card's rows as drawn: "<segment id>:<line>" → the middle of the row from the card's top (arrows end on them) */
  var lines: [String: Double] = [:]
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
  /** The head's sidenote chip as last drawn (card coordinates); nil when the card has no whole-card sidenotes */
  var chipRect: CGRect?
  /** A code card's rows as last drawn in full ("<segment>:<line>" → the row's middle from the top): routing puts an arrow's end
   *  on the line as drawn, hidden runs, notes and separators included; empty until the first full raster */
  private(set) var rowYs: [String: Double] = [:]
  /** Off screen: the bitmap goes, and a raster in flight lands nowhere */
  func drop() {
    gen += 1
    face.contents = nil
    drawn = false
  }
  /** The selection ring (Warm Ink: styles.css .card.sel --ring, two rings), sublayers, so selecting never re-rasterises the card */
  private let ring = CAShapeLayer()
  private let ring2 = CAShapeLayer()
  /** The card's bitmap: a sublayer, above the paper sheet (a sublayer draws above its parent's own contents) */
  private let face = CALayer()
  /** Ink Wash: the torn paper under the card (PAPER_M outside it) and the 选 seal of a selected card */
  private let sheet = CALayer()
  private let stamp = CALayer()
  /** A selected Text card's width handles (.hw), a Mark's corner grip too (.mkgrip) */
  private var handles: [CAShapeLayer] = []
  /** A code card's head buttons, shown while it is selected (styles.css .card.sel .hov / .cmenu): Copy Code, a Free code card's
   *  language, the card menu; a bitmap of its own drawn with the card, so selecting never re-rasterises the card */
  private let tools = CALayer()
  /** A selected Mark's toolbar above it (styles.css .card.text .ttb / .pill / .hdots: the four hand colours, the three weights);
   *  it floats over the arrows (the board's .ttb is above the links layer), so the canvas hands over a layer above them */
  private let bar = CALayer()
  weak var riser: CALayer? {
    didSet { riser?.addSublayer(bar); placeBar() }
  }
  private var barOffset = CGPoint.zero
  private func placeBar() { bar.frame.origin = CGPoint(x: frame.minX + barOffset.x, y: frame.minY + barOffset.y) }
  /** Off the canvas, the toolbar too */
  func detach() {
    bar.removeFromSuperlayer()
    removeFromSuperlayer()
  }
  /** A sub-board card's name and card count above its frame (styles.css .sbhead: 25 px, a 30 px line, 16 px over the frame) */
  private let nameHead = CALayer()
  var selected = false {
    didSet { if selected != oldValue { showSelection() } }
  }
  /** A Text, Mark, Box or Free Text card: words on the board (styles.css .card.text), selected with an outline, not the ring */
  private var isText: Bool { card.kind == "note" && card.look != "note" }
  private func showSelection() {
    tools.isHidden = !selected || card.kind != "code"
    bar.isHidden = !selected || card.look != "mark"
    if !bar.isHidden, bar.contents == nil { showBar() }
    if isText {
      stamp.isHidden = true
      ring.isHidden = !selected
      ring2.isHidden = true
      for h in handles { h.isHidden = !selected }
      return
    }
    if Theme.isInk && framed {
      ring.isHidden = true
      ring2.isHidden = true
      stamp.isHidden = !selected
      // the paper lifts 2 px and its shadow deepens (themes.css .card.sel translate / box-shadow)
      transform = selected ? CATransform3DMakeTranslation(0, Theme.number("sel-lift", -2), 0) : CATransform3DIdentity
      applyShadow()
    } else {
      stamp.isHidden = Theme.isInk ? !selected : true
      ring.isHidden = !selected
      ring2.isHidden = !selected
    }
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
  static let queue: OperationQueue = {
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
  /** The card's shadow is drawn into its sheet bitmap (Core Animation's own shadow is re-rendered for every layer on every zoom
   *  frame): the sheet reaches this far outside the card (Ink Wash's paper, paperMargin, fits inside it) */
  static let sheetMargin: CGFloat = 24
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
    contentsGravity = .topLeft
    sheet.anchorPoint = .zero
    sheet.contentsGravity = .topLeft
    addSublayer(sheet)
    placeholder.anchorPoint = .zero
    placeholder.isHidden = true
    addSublayer(placeholder)
    face.anchorPoint = .zero
    face.contentsGravity = .topLeft
    addSublayer(face)
    for r in [ring2, ring] {
      r.fillColor = nil
      r.isHidden = true
      addSublayer(r)
    }
    tools.anchorPoint = .zero
    tools.contentsGravity = .topLeft
    tools.isHidden = true
    addSublayer(tools)
    bar.anchorPoint = .zero
    bar.contentsGravity = .topLeft
    bar.isHidden = true
    bar.zPosition = 6
    stamp.anchorPoint = CGPoint(x: 0.5, y: 0.5)
    stamp.contentsGravity = .resizeAspect
    stamp.isHidden = true
    stamp.zPosition = 6
    addSublayer(stamp)
    nameHead.anchorPoint = .zero
    nameHead.contentsGravity = .topLeft
    addSublayer(nameHead)
    apply(card)
    if framed {
      placeholder.backgroundColor = Theme.surface.cgColor
      placeholder.cornerRadius = radius
      placeholder.isHidden = false
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
  /** The card's corner (styles.css .card --r-card; a sub-board frame's --cr) */
  var radius: CGFloat { card.kind == "board" ? Theme.number("board-radius", Theme.cardRadius * 1.76) : Theme.cardRadius }

  /** A new version of the card: content, place, measured height. A Note's text is laid out on the raster queue, on the main
   *  thread only when its height is not known (then the layout is what sizes the card) */
  func apply(_ c: SceneCard) {
    if c.hand != card.hand || c.weight != card.weight { bar.contents = nil }
    card = c
    defer { placeBar() }
    imageSize = nil
    if c.kind == "image", let src = c.src { imageSize = CardLayer.imageSize(src) }
    // a Note keeps its measured height until the page measures the new text (no jump to a guess)
    height = c.h.map { CGFloat($0) } ?? (c.kind == "note" && height > 0 ? height : measure())
    fixed = c.fixed == true
    setSize(CGSize(width: c.w, height: height))
    frame.origin = CGPoint(x: c.x, y: c.y)
    setNeedsDisplay()
  }
  /** The card's size (the sheet reaches sheetMargin outside it) */
  private func setSize(_ s: CGSize) {
    frame.size = s
    let r = CGRect(origin: .zero, size: s)
    let m = CardLayer.sheetMargin
    sheet.frame = r.insetBy(dx: -m, dy: -m)
    face.frame = r
    placeholder.frame = r
    let size = Theme.number("stamp-size", 24)
    stamp.bounds = CGRect(x: 0, y: 0, width: size, height: size)
    stamp.position = CGPoint(x: s.width + Theme.number("stamp-right", -19) * -1 - size / 2, y: Theme.number("stamp-top", -17) + size / 2)
    recolor()
  }
  /**
   * A Text card's selection (styles.css): .card.text.sel an outline 1.5 px of the accent 2 px out, with its 5.5 px corners; a
   * Mark (.card.mark.sel) a dashed 1 px outline in its hand colour 4 px out, with a grip at the corner; a Box (.card.text.box.sel)
   * the outline 3 px out around its 12.5 px corners. The width handles (.hw: 8 × 22, 4 px corners, on the surface with a 1.5 px
   * ring) sit on the left and right edges, a Mark's 8 × 14
   */
  private func recolorText(_ r: CGRect) {
    let look = card.look ?? "text"
    let mark = look == "mark", box = look == "box"
    let hand = mark ? (Theme.hand[card.hand ?? "blue"] ?? Theme.accent) : Theme.accent
    let off: CGFloat = mark ? 4 : box ? 3 : 2
    let corner: CGFloat = box ? Theme.cardRadius : 5.5
    ring.frame = r
    ring.lineWidth = mark ? 1 : 1.5
    ring.lineDashPattern = mark ? [3, 3] : nil
    ring.strokeColor = hand.cgColor
    ring.path = CGPath(roundedRect: r.insetBy(dx: -off - ring.lineWidth / 2, dy: -off - ring.lineWidth / 2), cornerWidth: corner + off, cornerHeight: corner + off, transform: nil)
    while handles.count < 3 {
      let h = CAShapeLayer()
      h.isHidden = true
      addSublayer(h)
      handles.append(h)
    }
    let hw: CGFloat = 8, hh: CGFloat = mark ? 14 : 22
    let sides = [CGRect(x: -8, y: r.midY - hh / 2, width: hw, height: hh), CGRect(x: r.width, y: r.midY - hh / 2, width: hw, height: hh)]
    for (h, q) in zip(handles, sides) {
      h.frame = r
      h.path = CGPath(roundedRect: q, cornerWidth: 4, cornerHeight: 4, transform: nil)
      h.fillColor = Theme.surface.cgColor
      h.strokeColor = hand.cgColor
      h.lineWidth = 1.5
    }
    // the corner grip of a Mark or Free Text (.mkgrip: 10 × 10, 3 px corners, 9 px out)
    let grip = handles[2]
    grip.frame = r
    grip.path = (mark || look == "freetext") ? CGPath(roundedRect: CGRect(x: r.width - 1, y: r.height - 1, width: 10, height: 10), cornerWidth: 3, cornerHeight: 3, transform: nil) : nil
    grip.fillColor = Theme.surface.cgColor
    grip.strokeColor = hand.cgColor
    grip.lineWidth = 1.5
    if box { ring2.isHidden = true }
  }

  /** The shadow is in the sheet bitmap (drawSheet); Ink Wash's deepens on selection, so the sheet is drawn again then */
  private var sheetSelected = false
  private func applyShadow() {
    guard Theme.isInk, framed, sheetSelected != selected else { return }
    drawSheet(gen)
  }
  /** The rings and the seal take the look's colours (styles.css .card.sel --ring: the first two shadows of the list) */
  func recolor() {
    let r = bounds
    Theme.appearance.performAsCurrentDrawingAppearance {
      if isText { recolorText(r); showSelection(); return }
      let rings = Theme.shadows(card.kind == "board" ? "board-sel-ring" : "card-sel-ring").filter { !$0.inset && $0.blur == 0 && $0.spread > 0 }
      for (layer, sh) in zip([ring, ring2], rings) {
        layer.frame = r
        layer.lineWidth = sh.spread
        layer.strokeColor = Theme.parse(sh.color)?.cgColor
        layer.path = CGPath(roundedRect: r.insetBy(dx: -sh.spread / 2, dy: -sh.spread / 2), cornerWidth: radius + sh.spread / 2, cornerHeight: radius + sh.spread / 2, transform: nil)
      }
      stamp.contents = Theme.isInk ? Ink.stamp(dark: Theme.isDark) : nil
      stamp.opacity = Float(Theme.number("stamp-opacity", 1))
      stamp.transform = CATransform3DMakeRotation(Theme.number("stamp-rotate", 0) * .pi / 180, 0, 0, 1)
      stamp.contentsScale = contentsScale
      applyShadow()
      showSelection()
    }
  }
  /** A live resize (the pointer on an edge): the frame follows every frame, as the board lays the card out again each frame.
   *  The paper shows at the new size at once (the placeholder under the face, the sheet stretched to it), the text is drawn again
   *  at the new size as fast as the raster queue returns it (one raster in flight at a time, never a queue of stale sizes), and
   *  the last size is drawn once more when the resize ends */
  /** The editor over the card grew: the frame follows (the editor covers it; the bitmap is drawn when the edit ends) */
  func grow(toHeight h: CGFloat) {
    height = h
    setSize(CGSize(width: frame.width, height: h))
  }
  func resize(width: CGFloat, height h: CGFloat?) {
    if !resizing {
      resizing = true
      sheet.contentsGravity = .resize
      // the old bitmap is cut at the new edge while the card shrinks
      face.masksToBounds = true
      if framed {
        placeholder.backgroundColor = Theme.surface.cgColor
        placeholder.cornerRadius = radius
        placeholder.isHidden = false
      }
    }
    card.w = width
    // the bottom edge pulled sets the height; the width alone keeps the card's own (a Note's follows its text as it is drawn)
    if let h { height = h }
    setSize(CGSize(width: width, height: height))
    if resizeGen == landedGen { redrawForResize() }
  }
  func endResize() {
    guard resizing else { return }
    resizing = false
    sheet.contentsGravity = .topLeft
    face.masksToBounds = false
    redrawForResize()
  }
  private var resizing = false
  /** The raster asked for by the resize and the one that landed: equal when none is in flight */
  private var resizeGen = 0, landedGen = 0
  private func redrawForResize() {
    resizeGen += 1
    let mine = resizeGen
    resizeLanded = { [weak self] in self?.landedGen = mine }
    setNeedsDisplay()
  }
  private var resizeLanded: (() -> Void)?

  func move(to p: CGPoint, section: String? = nil) {
    card.x = p.x
    card.y = p.y
    if let section { card.section = section }
    frame.origin = p
    placeBar()
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
    if card.kind == "board" { showName() }
    if card.kind == "note" || card.kind == "board", let notes {
      // the web page renders Notes (and a sub-board's map) as PDFs; until one lands the old bitmap stays (or the placeholder for a brand new card)
      let scale = min(contentsScale, sqrt(CardLayer.maxPixels / max(1, card.w * max(height, 1))))
      let put = { [weak self] (pdf: NotePDF) in
        guard let self, self.gen == g else { return }
        if !self.fixed, abs(pdf.h - self.height) > 0.5 || abs(pdf.w - self.frame.width) > 0.5 {
          self.height = pdf.h
          self.setSize(CGSize(width: self.card.look == "freetext" ? pdf.w : self.card.w, height: pdf.h))
          self.onMeasured?(self)
        }
        self.drawSheet(g)
        CardLayer.queue.addOperation {
          let img = pdf.raster(scale: scale)
          DispatchQueue.main.async { [weak self] in
            guard let self, self.gen == g else { return }
            self.face.contents = img
            self.face.contentsScale = scale
            self.placeholder.isHidden = true
            self.resizeLanded?()
            self.resizeLanded = nil
            self.onRendered?(self)
          }
        }
      }
      if let hit = notes.render(CardSpec(card), done: put) { put(hit); return }
      if face.contents == nil { drawPlaceholder() }
      return
    }
    let size = bounds.size
    let scale = min(contentsScale, sqrt(CardLayer.maxPixels / max(1, size.width * size.height)))
    var paint = Paint(card: card, height: height, imageSrc: card.kind == "image" ? card.src : nil, imageMax: Int(card.w * scale), framed: framed, paper: Theme.isInk && framed, dark: Theme.isDark)
    // a code card's Always Show notes come from the page first (their heights make room between the rows); the rest of the
    // card waits for the last of them, then draws once
    if card.kind == "code", let notes {
      let specs = inoteSpecs()
      var pdfs: [String: NotePDF] = [:]
      var waiting = specs.count
      let go = { [weak self] in
        guard let self, self.gen == g else { return }
        for (key, pdf) in pdfs { paint.inoteHeights[key] = pdf.h }
        self.inotePdfs = pdfs
        self.raster(paint, size: size, scale: scale, g)
      }
      for (key, spec) in specs {
        let put = { (pdf: NotePDF) in
          pdfs[key] = pdf
          waiting -= 1
          if waiting == 0 { go() }
        }
        if let hit = notes.render(spec, done: put) { put(hit) }
      }
      if specs.isEmpty { go() }
      return
    }
    raster(paint, size: size, scale: scale, g)
  }
  /** The page's pictures of the Always Show notes, placed after the raster (placeInotes) */
  private var inotePdfs: [String: NotePDF] = [:]
  private var inoteLayers: [String: CALayer] = [:]
  /** One page spec per Highlight with Always Show notes: at the room they get (.inote max-width: the card less the gutter,
   *  --code-pr, the indent and 20 px, at most 600) */
  private func inoteSpecs() -> [(String, CardSpec)] {
    guard let segs = card.segments else { return [] }
    let ch = ("0" as NSString).size(withAttributes: [.font: Theme.mono(11)]).width
    let nd = String(segs.flatMap { $0.lines }.map(\.n).max() ?? 1).count
    let gutter = 17 + CGFloat(nd) * ch + 22
    var out: [(String, CardSpec)] = []
    for (si, s) in segs.enumerated() {
      for n in s.inotes ?? [] {
        let w = min(600, CGFloat(card.w) - gutter - 18 - CGFloat(n.lead) * ch - 20)
        out.append(("\(si):\(n.after)", CardSpec(inote: "\(card.id):\(si):\(n.after)", mds: n.md, width: max(40, w))))
      }
    }
    return out
  }
  private func raster(_ paint: Paint, size: CGSize, scale: CGFloat, _ g: Int) {
    let appearance = Theme.appearance
    if paint.paper { _ = Ink.paper(dark: paint.dark, seed: card.seed) }
    let sel = selected, radius = radius
    sheetSelected = sel
    pendingOp?.cancel()
    let op = BlockOperation()
    op.addExecutionBlock { [weak op] in
      if op?.isCancelled == true { return }
      let surface = CardLayer.render(paint, size: size, scale: scale, appearance: appearance)
      let paper = paint.framed ? CardLayer.renderSheet(paint, selected: sel, radius: radius, size: size, scale: scale, appearance: appearance) : nil
      let tools = paint.card.kind == "code" ? CardLayer.renderTools(paint, scale: scale, appearance: appearance) : nil
      DispatchQueue.main.async { [weak self] in
        guard let self, let surface else { return }
        if self.gen == g {
          self.sheet.contents = paper
          self.sheet.contentsScale = scale
        }
        if let (tools, w) = tools, self.gen == g {
          self.tools.frame = CGRect(x: size.width - w, y: 0, width: w, height: Theme.headHeight)
          self.tools.contents = tools
          self.tools.contentsScale = scale
        }
        if let h = self.handover { h(self, surface, scale, g) } else { self.land(surface, scale, g) }
        if self.gen == g { self.placeInotes(paint.slots.rects, scale: scale, g) }
        self.chipRect = paint.slots.chip
        if !paint.slots.lines.isEmpty, self.rowYs != paint.slots.lines {
          self.rowYs = paint.slots.lines
          self.onMeasured?(self)
        }
      }
    }
    pendingOp = op
    CardLayer.queue.addOperation(op)
  }

  /** The bitmap is shown, unless a newer raster was asked for since (then it is dropped; the old bitmap stays until that one lands) */
  func land(_ surface: IOSurface, _ scale: CGFloat, _ g: Int) {
    guard g == gen else { return }
    face.contents = surface
    face.contentsScale = scale
    placeholder.isHidden = true
    resizeLanded?()
    resizeLanded = nil
  }

  /** A Note with no bitmap yet: its paper and head, grey bars for text (drawn at once, off the main thread like the rest) */
  private func drawPlaceholder() {
    let paint = Paint(card: card, height: height, imageSrc: nil, imageMax: 0, framed: framed, paper: false, dark: Theme.isDark)
    let size = bounds.size, g = gen, appearance = Theme.appearance
    CardLayer.queue.addOperation {
      let surface = CardLayer.render(paint, size: size, scale: 1, appearance: appearance)
      DispatchQueue.main.async { [weak self] in
        guard let self, self.gen == g, self.face.contents == nil, let surface else { return }
        self.face.contents = surface
        self.face.contentsScale = 1
      }
    }
  }

  /** A code card's head buttons (Copy Code, the language of Free code, the menu) at the head's right, as a bitmap: its surface
   *  and width. .chead: padding-right 6 (Ink Wash 8), gap 7 (9); .ib 26 × 26; .lang 10.5 px mono with 5 px padding */
  static func renderTools(_ p: Paint, scale: CGFloat, appearance: NSAppearance) -> (IOSurface, CGFloat)? {
    let ink = p.paper
    let pr: CGFloat = ink ? 8 : 6, gap: CGFloat = ink ? 9 : 7, ib: CGFloat = 26
    var langText: NSAttributedString?
    if let l = p.card.lang {
      langText = NSAttributedString(string: l, attributes: [.font: Theme.mono(10.5, weight: .medium), .foregroundColor: Theme.ink3])
    }
    let langW = langText.map { $0.size().width + 10 } ?? 0
    let w = pr + ib + gap + (langText != nil ? langW + gap : 0) + ib + gap
    let hh = Theme.headHeight
    let surface = surface(CGSize(width: w, height: hh), scale: scale) {
      appearance.performAsCurrentDrawingAppearance {
        var x = w - pr - ib
        Theme.drawIcon("more", at: CGPoint(x: x + 5, y: (hh - 16) / 2), color: Theme.ink2)
        x -= gap
        if let langText {
          x -= langW
          langText.draw(at: CGPoint(x: x + 5, y: (hh - langText.size().height) / 2))
          x -= gap
        }
        x -= ib
        Theme.drawIcon("copy", at: CGPoint(x: x + 5, y: (hh - 16) / 2), color: Theme.ink2)
      }
    }
    return surface.map { ($0, w) }
  }

  /** The name above a sub-board frame, drawn on the raster queue: .sbname 700 25px, .sbmeta (the count) 500 25px ink-3, 10 px
   *  apart, letter-spacing -0.015em, the line 30 px with its bottom 16 px above the frame, 6 px in */
  private func showName() {
    let s = CardLayer.nameHeight, w = CGFloat(card.w) - 6, scale = contentsScale
    nameHead.frame = CGRect(x: 6, y: -16 - s, width: w, height: s)
    let title = card.title, count = card.count.map(String.init) ?? "", appearance = Theme.appearance
    CardLayer.queue.addOperation {
      let surface = CardLayer.surface(CGSize(width: w, height: s), scale: scale) {
        appearance.performAsCurrentDrawingAppearance {
          let font = Theme.sys(25, weight: .bold)
          let meta = NSAttributedString(string: count, attributes: [.font: Theme.sys(25, weight: .medium), .foregroundColor: Theme.ink3, .kern: -0.375])
          let mw = count.isEmpty ? 0 : meta.size().width + 10
          let para = NSMutableParagraphStyle()
          para.lineBreakMode = .byTruncatingTail
          let t = NSAttributedString(string: title, attributes: [.font: font, .foregroundColor: Theme.ink, .kern: -0.375, .paragraphStyle: para])
          // line-height 1.2: the text sits in the middle of the 30 px line
          let y = (s - font.ascender + font.descender) / 2
          let tw = min(t.size().width, w - mw)
          t.draw(with: CGRect(x: 0, y: y, width: tw, height: s), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
          if !count.isEmpty { meta.draw(at: CGPoint(x: tw + 10, y: y)) }
        }
      }
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.nameHead.contents = surface
        self.nameHead.contentsScale = scale
      }
    }
  }
  /** The Mark toolbar as a bitmap on the raster queue: a .pill.hdots (padding 8 / 10, gap 8, radius 14, --glass, --sh-float)
   *  at left 0, top -50 with the .hdot colours (16 px, a 2 px glass ring; the card's with a 3.5 px ink ring more), a .hsep
   *  (1 px hair, margins 1 / 2) and the .hwt weights (20 × 20, 5 px corners, "a" in the hand at 16 px; the card's on --hlrow) */
  private func showBar() {
    let hand = card.hand ?? "blue", weight = card.weight ?? "regular", scale = contentsScale, appearance = Theme.appearance
    let padX: CGFloat = 10, pad: CGFloat = 8, gap: CGFloat = 8, dot: CGFloat = 16, btn: CGFloat = 20
    let colors = ["blue", "purple", "orange", "green"], weights: [(String, NSFont.Weight)] = [("light", .light), ("regular", .regular), ("bold", .bold)]
    let w = padX * 2 + CGFloat(colors.count) * dot + CGFloat(colors.count) * gap + 1 + 4 + CGFloat(weights.count) * btn + CGFloat(weights.count - 1) * gap
    let h = pad * 2 + btn
    // room for the float shadow around the pill
    let m: CGFloat = 24
    barOffset = CGPoint(x: -m, y: -50 - m)
    bar.frame = CGRect(x: 0, y: 0, width: w + 2 * m, height: h + 2 * m)
    placeBar()
    CardLayer.queue.addOperation {
      let surface = CardLayer.surface(CGSize(width: w + 2 * m, height: h + 2 * m), scale: scale) {
        appearance.performAsCurrentDrawingAppearance {
          guard let cg = NSGraphicsContext.current?.cgContext else { return }
          let pill = CGRect(x: m, y: m, width: w, height: h)
          let path = NSBezierPath(roundedRect: pill, xRadius: 14, yRadius: 14)
          for sh in Theme.shadows("sh-float").filter({ !$0.inset }).reversed() {
            guard let c = Theme.parse(sh.color) else { continue }
            cg.saveGState()
            cg.setShadow(offset: CGSize(width: sh.x, height: -sh.y), blur: sh.blur, color: c.cgColor)
            Theme.c("glass").setFill()
            NSBezierPath(roundedRect: pill.insetBy(dx: -sh.spread, dy: -sh.spread), xRadius: 14 + sh.spread, yRadius: 14 + sh.spread).fill()
            cg.restoreGState()
          }
          Theme.c("glass").setFill()
          path.fill()
          var x = pill.minX + padX
          let y = pill.minY + pad
          for k in colors {
            let r = CGRect(x: x, y: y + (btn - dot) / 2, width: dot, height: dot)
            if k == hand {
              Theme.ink.setFill()
              NSBezierPath(ovalIn: r.insetBy(dx: -3.5, dy: -3.5)).fill()
            }
            Theme.c("glass").setFill()
            NSBezierPath(ovalIn: r.insetBy(dx: -2, dy: -2)).fill()
            (Theme.hand[k] ?? Theme.accent).setFill()
            NSBezierPath(ovalIn: r).fill()
            x += dot + gap
          }
          x += 2
          Theme.hair.setFill()
          CGRect(x: x, y: y + 1, width: 1, height: btn - 2).fill()
          x += 1 + 2 + gap
          for (name, wt) in weights {
            let r = CGRect(x: x, y: y, width: btn, height: btn)
            if name == weight {
              Theme.c("hlrow").setFill()
              NSBezierPath(roundedRect: r, xRadius: 5, yRadius: 5).fill()
            }
            let font = Theme.family("Shantell Sans Light", 16, weight: wt, cascade: ["Yozai"]) ?? Theme.handwriting(16, bold: wt == .bold)
            let t = NSAttributedString(string: "a", attributes: [.font: font, .foregroundColor: name == weight ? Theme.ink : Theme.ink2])
            let ts = t.size()
            t.draw(at: CGPoint(x: r.midX - ts.width / 2, y: r.midY - ts.height / 2))
            x += btn + gap
          }
        }
      }
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.bar.contents = surface
        self.bar.contentsScale = scale
      }
    }
  }
  /** .sbhead's line: 25 px × 1.2 */
  static let nameHeight: CGFloat = 30

  /** Ink Wash: the paper under a framed card the page rendered (the page paints the sheet inside the card, this the margin) */
  private func drawSheet(_ g: Int) {
    guard framed else { sheet.contents = nil; return }
    let paint = Paint(card: card, height: height, imageSrc: nil, imageMax: 0, framed: true, paper: Theme.isInk, dark: Theme.isDark)
    let size = bounds.size, scale = contentsScale, appearance = Theme.appearance, sel = selected, radius = radius
    sheetSelected = sel
    if paint.paper { _ = Ink.paper(dark: paint.dark, seed: card.seed) }
    CardLayer.queue.addOperation {
      let paper = CardLayer.renderSheet(paint, selected: sel, radius: radius, size: size, scale: scale, appearance: appearance)
      DispatchQueue.main.async { [weak self] in
        guard let self, self.gen == g else { return }
        self.sheet.contents = paper
        self.sheet.contentsScale = scale
      }
    }
  }

  /** The Always Show notes' pictures over the face, in the slots the drawing left for them */
  private func placeInotes(_ rects: [String: CGRect], scale: CGFloat, _ g: Int) {
    for (key, l) in inoteLayers where rects[key] == nil { l.removeFromSuperlayer(); inoteLayers[key] = nil }
    for (key, r) in rects {
      guard let pdf = inotePdfs[key] else { continue }
      let l = inoteLayers[key] ?? {
        let l = CALayer()
        l.anchorPoint = .zero
        l.contentsGravity = .topLeft
        inoteLayers[key] = l
        face.addSublayer(l)
        return l
      }()
      l.frame = r
      CardLayer.queue.addOperation {
        let img = pdf.raster(scale: scale)
        DispatchQueue.main.async { [weak self] in
          guard let self, self.gen == g else { return }
          l.contents = img
          l.contentsScale = scale
        }
      }
    }
  }

  /** The sheet under a card of this size, sheetMargin outside it, as the sheet layer's bitmap (the raster queue): the look's
   *  shadow list (themes.css .card box-shadow: Warm Ink's --sh-card-soft, Ink Wash's --sh-card, deeper when selected), each
   *  member a blurred fill under the card, then Ink Wash's paper */
  static func renderSheet(_ p: Paint, selected: Bool, radius: CGFloat, size: CGSize, scale: CGFloat, appearance: NSAppearance) -> IOSurface? {
    let m = sheetMargin
    let full = CGSize(width: size.width + 2 * m, height: size.height + 2 * m)
    let r = CGRect(x: m, y: m, width: size.width, height: size.height)
    let list = p.paper ? Theme.shadows(selected ? "card-sel-shadow" : "card-shadow") : Theme.shadows("card-soft-shadow")
    return surface(full, scale: scale) {
      appearance.performAsCurrentDrawingAppearance {
        guard let cg = NSGraphicsContext.current?.cgContext else { return }
        for sh in list.filter({ !$0.inset }).reversed() {
          guard let c = Theme.parse(sh.color) else { continue }
          cg.saveGState()
          cg.setShadow(offset: CGSize(width: sh.x, height: -sh.y), blur: sh.blur, color: c.cgColor)
          // the fill itself is under the card's own paint; only its shadow shows
          Theme.surface.setFill()
          NSBezierPath(roundedRect: r.insetBy(dx: -sh.spread, dy: -sh.spread), xRadius: radius + sh.spread, yRadius: radius + sh.spread).fill()
          cg.restoreGState()
        }
        if p.paper { Ink.drawPaper(r, dark: p.dark, seed: p.card.seed) }
      }
    }
  }
  /** An IOSurface of a size at a scale, drawn into with AppKit (flipped) */
  static func surface(_ size: CGSize, scale: CGFloat, _ draw: () -> Void) -> IOSurface? {
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
    draw()
    NSGraphicsContext.restoreGraphicsState()
    ctx.flush()
    return surface
  }

  /** Drawn straight into an IOSurface: Core Animation shows the surface itself (no copy into its own backing when the contents
   *  are set), and the one buffer is the card's whole cost */
  static func render(_ p: Paint, size: CGSize, scale: CGFloat, appearance: NSAppearance) -> IOSurface? {
    surface(size, scale: scale) {
      appearance.performAsCurrentDrawingAppearance { drawCard(p, in: CGRect(origin: .zero, size: size), lod: scale < lodScale) }
    }
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
    case "web": return 112
    default: return 160
    }
  }

  /** The card into the current (flipped) context at r, as its bitmap is drawn; lod: blocks, no text (zoomed far out) */
  static func drawCard(_ p: Paint, in r: CGRect, lod: Bool) {
    let radius = Theme.cardRadius
    let paper = NSBezierPath(roundedRect: r.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
    // Ink Wash's card has no fill or edge of its own: the paper under it is the sheet layer
    if p.framed && !p.paper {
      Theme.surface.setFill()
      paper.fill()
    }
    switch p.card.kind {
    case "code": drawCode(p, r, lod: lod)
    case "note": drawNote(p, r, lod: lod)
    case "image": drawImage(p, r)
    default: drawHead(p, r, glyph: p.card.kind == "web" ? "🌐" : "▣", title: p.card.title, lod: lod)
    }
    // the card's edge (--sh-ring: a hairline spread, a white highlight inset at the top), drawn inside the bitmap
    if p.framed && !p.paper {
      for sh in Theme.shadows("sh-ring") where sh.blur == 0 {
        guard let c = Theme.parse(sh.color) else { continue }
        c.setStroke()
        if sh.inset {
          let top = NSBezierPath()
          top.move(to: CGPoint(x: radius, y: sh.y / 2))
          top.line(to: CGPoint(x: r.width - radius, y: sh.y / 2))
          top.lineWidth = sh.y
          top.stroke()
        } else {
          let edge = NSBezierPath(roundedRect: r.insetBy(dx: sh.spread / 2, dy: sh.spread / 2), xRadius: radius, yRadius: radius)
          edge.lineWidth = sh.spread
          edge.stroke()
        }
      }
    }
  }

  /** The card head (styles.css .chead; themes.css for Ink Wash: a wash fading to the right, no line, no kind, the title in the
   *  serif) */
  private static func drawHead(_ p: Paint, _ r: CGRect, glyph: String?, title: String, lod: Bool, note: Bool = false) {
    let hh = Theme.headHeight
    let ink = p.paper
    let head = NSBezierPath(roundedRect: CGRect(x: 0.5, y: 0.5, width: r.width - 1, height: hh), xRadius: Theme.cardRadius, yRadius: Theme.cardRadius)
    head.appendRect(CGRect(x: 0.5, y: hh / 2, width: r.width - 1, height: hh / 2 + 0.5))
    if ink, let g = Theme.gradient("head-bg"), let cg = NSGraphicsContext.current?.cgContext {
      cg.saveGState()
      head.addClip()
      let colors = g.stops.map { cssColor($0.color) } as CFArray
      if let gr = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors, locations: g.stops.map { $0.at }) {
        // 90deg: left to right
        cg.drawLinearGradient(gr, start: CGPoint(x: 0, y: 0), end: CGPoint(x: r.width, y: 0), options: [.drawsAfterEndLocation])
      }
      cg.restoreGState()
    } else {
      Theme.head.setFill()
      head.fill()
      Theme.line.setFill()
      CGRect(x: 0.5, y: hh, width: r.width - 1, height: 1).fill()
    }
    if lod {
      Theme.ink3.withAlphaComponent(0.5).setFill()
      CGRect(x: 12, y: 12, width: min(r.width * 0.5, 160), height: 12).fill()
      return
    }
    // .chead: padding-left 10 (Ink Wash 14), gap 7 (9); .kind: 10 wide, italic serif (hidden in Ink Wash)
    var tx: CGFloat = ink ? Theme.number("head-pl", 14) : 10
    if !ink, let glyph {
      let g = NSAttributedString(string: glyph, attributes: [.font: glyph.count == 1 && glyph.unicodeScalars.first!.isASCII ? Theme.mono(11, weight: .semibold) : Theme.serif(12, weight: .semibold, italic: true), .foregroundColor: Theme.ink3])
      g.draw(at: CGPoint(x: tx + (10 - g.size().width) / 2, y: (hh - g.size().height) / 2))
      tx += 10 + 7
    }
    let tfont = ink ? Theme.serif(13, weight: .semibold) : note ? Theme.sys(12.5, weight: .semibold) : Theme.mono(12, weight: .medium)
    let one = NSMutableParagraphStyle()
    one.lineBreakMode = .byTruncatingTail
    let t = NSAttributedString(string: title.replacingOccurrences(of: "\n", with: " "), attributes: [.font: tfont, .foregroundColor: Theme.ink, .paragraphStyle: one, .kern: ink ? 0.13 : note ? 0 : -0.12])
    t.draw(with: CGRect(x: tx, y: (hh - t.size().height) / 2, width: r.width - tx - 10, height: t.size().height), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    if let n = p.card.notes, n > 0 {
      let chip = CGRect(x: min(tx + t.size().width + 7, r.width - 24), y: (hh - 14) / 2, width: 14, height: 14)
      p.slots.chip = chip
      Theme.c("mark").setFill()
      NSBezierPath(roundedRect: chip, xRadius: 5, yRadius: 5).fill()
      let c = NSAttributedString(string: String(n), attributes: [.font: Theme.sys(9, weight: .semibold), .foregroundColor: Theme.c("mark-ink")])
      c.draw(at: CGPoint(x: chip.midX - c.size().width / 2, y: chip.midY - c.size().height / 2))
    }
    if p.card.locked == true {
      let l = NSAttributedString(string: "🔒", attributes: [.font: Theme.sys(10)])
      l.draw(at: CGPoint(x: r.width - 24, y: (hh - l.size().height) / 2))
    }
  }

  private static func drawCode(_ p: Paint, _ r: CGRect, lod: Bool) {
    drawHead(p, r, glyph: p.card.glyph, title: p.card.title, lod: lod)
    guard let segs = p.card.segments else { return }
    let row = Theme.codeRow
    var y = Theme.headHeight + 6
    let font = Theme.mono(11)
    // .kw at --kw-w, .com in italic unless --com-i says not, .str in italic when --str-i says so
    let kwFont = Theme.mono(11, weight: Theme.number("kw-w", 400) >= 600 ? .semibold : Theme.number("kw-w", 400) >= 500 ? .medium : .regular)
    let italic = Theme.family("JetBrains Mono", 11, italic: true) ?? font
    let comItalic = Theme.string("com-i") != "normal", strItalic = Theme.string("str-i") == "italic"
    let ch = ("0" as NSString).size(withAttributes: [.font: font]).width
    let maxLine = segs.flatMap { $0.lines }.map(\.n).max() ?? 1
    // --nd: the digits of the last line number (CodeBody); --gutter = 17px + nd × 1ch + 22px
    let nd = String(maxLine).count
    let gutter = 17 + CGFloat(nd) * ch + 22
    // CSS centres the glyphs' content area in the 20 px line; the layout manager puts the extra leading above the baseline
    let lift = (row - (font.ascender - font.descender)) / 2
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
    let numAttrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: Theme.ink3.withAlphaComponent(Theme.number("no-opacity", 0.65)), .paragraphStyle: numPara, .baselineOffset: lift]
    let onAttrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: Theme.accent, .paragraphStyle: numPara, .baselineOffset: lift]
    let linkAttrs: [NSAttributedString.Key: Any] = [.font: Theme.number("no-link-w", 400) >= 500 ? kwFont : font, .foregroundColor: Theme.noLink, .paragraphStyle: numPara, .baselineOffset: lift]
    for (si, s) in segs.enumerated() {
      if si > 0 {
        Theme.line.setFill()
        CGRect(x: 0.5, y: y + 9, width: r.width - 1, height: 1).fill()
        if !s.path.isEmpty {
          let p = NSAttributedString(string: "\(s.path) \(s.start)–\(s.end)", attributes: [.font: Theme.sys(10), .foregroundColor: Theme.ink3])
          p.draw(at: CGPoint(x: gutter, y: y + 2))
        }
        y += 20
      }
      // a run of hidden lines (styles.css .gap): a 22 px row, 1 px margins, dashed hairlines, "⋯ N lines hidden (a–b)" 11 px
      // from gutter + 8; the lines after it are drawn as their own run
      let gaps = (s.gaps ?? []).filter { $0.count == 2 }
      let inotes = s.inotes ?? []
      var runs: [[SceneLine]] = [[]]
      for l in s.lines {
        if let last = runs[runs.count - 1].last, gaps.contains(where: { $0[0] > last.n && $0[1] < l.n }) || inotes.contains(where: { $0.after == last.n }) { runs.append([]) }
        runs[runs.count - 1].append(l)
      }
      let drawGap = { (g: [Int], y: CGFloat) in
        Theme.c("hlrow").setFill()
        CGRect(x: 0.5, y: y + 1, width: r.width - 1, height: 22).fill()
        let dash = NSBezierPath()
        dash.move(to: CGPoint(x: 0.5, y: y + 1.5)); dash.line(to: CGPoint(x: r.width - 0.5, y: y + 1.5))
        dash.move(to: CGPoint(x: 0.5, y: y + 22.5)); dash.line(to: CGPoint(x: r.width - 0.5, y: y + 22.5))
        dash.setLineDash([3, 2], count: 2, phase: 0)
        dash.lineWidth = 1
        Theme.hair.setStroke()
        dash.stroke()
        let n = g[1] - g[0] + 1
        let t = NSAttributedString(string: "⋯ \(n) line\(n > 1 ? "s" : "") hidden (\(g[0] == g[1] ? "\(g[0])" : "\(g[0])–\(g[1])"))", attributes: [.font: Theme.sys(11), .foregroundColor: Theme.ink3])
        t.draw(at: CGPoint(x: gutter + 8, y: y + 1 + (22 - t.size().height) / 2))
      }
      for (ri, lines) in runs.enumerated() {
      if ri > 0, let first = lines.first, let prev = runs[ri - 1].last, let g = gaps.first(where: { $0[1] < first.n && $0[0] > prev.n }) {
        drawGap(g, y)
        y += 24
      }
      let code = NSMutableAttributedString()
      let nums = NSMutableAttributedString()
      for (k, l) in lines.enumerated() {
        if k > 0 {
          code.append(NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: para]))
          nums.append(NSAttributedString(string: "\n", attributes: [.font: font, .paragraphStyle: numPara]))
        }
        let on = (s.hl ?? []).contains { $0.count == 2 && l.n >= $0[0] && l.n <= $0[1] }
        let link = (s.from ?? []).contains(l.n)
        nums.append(NSAttributedString(string: String(l.n), attributes: link ? linkAttrs : on ? onAttrs : numAttrs))
        for t in l.toks {
          let cls = t.cls.flatMap { $0.split(separator: " ").first.map(String.init) } ?? ""
          let color = Theme.tok[cls] ?? Theme.ink
          let f = cls == "kw" ? kwFont : (cls == "com" && comItalic) || (cls == "str" && strItalic) ? italic : font
          code.append(NSAttributedString(string: t.text, attributes: [.font: f, .foregroundColor: color, .paragraphStyle: para, .baselineOffset: lift]))
        }
      }
      let h = CGFloat(lines.count) * row
      let rowOf = { (n: Int) -> CGFloat? in lines.firstIndex { $0.n == n }.map { CGFloat($0) } }
      for (k, l) in lines.enumerated() { p.slots.lines["\(s.id):\(l.n)"] = y + CGFloat(k) * row + row / 2 }
      // the rows arrows start from (.rowbg.origin): a tint across the card
      for n in s.from ?? [] {
        guard let k = rowOf(n) else { continue }
        Theme.row.setFill()
        CGRect(x: 0.5, y: y + k * row, width: r.width - 1, height: row).fill()
      }
      // a Highlight's band (styles.css .hx-band .hxb): from 4 px left of the code to 14 px from the right, 2 px inside its first
      // and last rows (CodeBody HX_INSET), rounded 6
      for range in s.hl ?? [] where range.count == 2 {
        let shown = lines.filter { $0.n >= range[0] && $0.n <= range[1] }
        guard let a = shown.first.flatMap({ rowOf($0.n) }), let b = shown.last.flatMap({ rowOf($0.n) }) else { continue }
        Theme.band.setFill()
        NSBezierPath(roundedRect: CGRect(x: gutter - 4, y: y + a * row + 2, width: r.width - 14 - (gutter - 4), height: (b - a + 1) * row - 4), xRadius: 6, yRadius: 6).fill()
      }
      nums.draw(with: CGRect(x: 17, y: y, width: CGFloat(nd) * ch, height: h), options: [.usesLineFragmentOrigin])
      for (k, l) in lines.enumerated() {
        var x = gutter - 18
        for g in l.stk ?? [] {
          let w = StickerLayer.width(g, size: 14)
          StickerLayer.drawGlyph(g, size: 14, in: CGRect(x: x, y: y + CGFloat(k) * row + (row - 14) / 2, width: w, height: 14))
          x += w + 2
        }
      }
      NSGraphicsContext.current?.cgContext.saveGState()
      NSGraphicsContext.current?.cgContext.clip(to: CGRect(x: gutter, y: y, width: r.width - gutter - 6, height: h))
      code.draw(with: CGRect(x: gutter, y: y, width: 100000, height: h), options: [.usesLineFragmentOrigin])
      NSGraphicsContext.current?.cgContext.restoreGState()
      y += h
      // the Highlight's Always Show notes under its last line: the page's picture goes in the slot (CodeBody .inotes at
      // --hx-in = the lead's columns; .hx-band .inote: padding 9px 12px 3px 1px)
      if let last = lines.last, let n = inotes.first(where: { $0.after == last.n }), let ih = p.inoteHeights["\(si):\(n.after)"] {
        let x = gutter + CGFloat(n.lead) * ch
        p.slots.rects["\(si):\(n.after)"] = CGRect(x: x + 1, y: y + 9, width: min(600, r.width - x - 18 - 20), height: ih)
        y += ih + 12
      }
      }
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

}

/** A Section: a shape layer (no bitmap: a Section can be the size of the board) and its title; in Ink Wash four brush strokes
 *  (core's inkframe, through Ink.frame) with the title written in the top stroke's gap (themes.css .sbrush, .slabel) */
/** A Section: its frame under the cards (styles.css .sect; Ink Wash: four brush strokes, themes.css .sbrush) and its title above
 *  them (.slabel, z-index 4: the canvas's labels layer, `riser`). Collapsed, the frame wraps the title, "· N cards" and the caret
 *  (state/sections.ts measureShut). Selected: Warm Ink's border turns accent with a 3 px ring outside and an accent wash over the
 *  fill; Ink Wash's strokes turn vermilion, a second lighter stroke shows offset inside and a faint vermilion wash covers it.
 *  Colours and sizes are the stylesheets' (themes.json) */
final class SectionLayer: CALayer {
  private(set) var section: SceneSection
  /** Warm Ink: the frame (fill, border), the inset highlight along its top (--sect-sh), the selected ring and wash */
  private let shape = CAShapeLayer()
  private let hilite = CAShapeLayer()
  private let ring = CAShapeLayer()
  private let wash = CAShapeLayer()
  /** Ink Wash: the strokes, and under them the selected look's second stroke (.secho) */
  private let brush = CAShapeLayer()
  private let echo = CAShapeLayer()
  /** The title, a bitmap in the canvas's labels layer (above the cards, as the board's .slabel) */
  private let label = CALayer()
  weak var riser: CALayer? {
    didSet { riser?.addSublayer(label); placeLabel() }
  }
  private var labelScale: CGFloat = 2
  /** The label's box as the board lays it out (world px): padding, title, "· N cards" when collapsed, the caret */
  private var labelSize = CGSize.zero
  /** How far left of the label's box its bitmap reaches: the drag dots sit outside it (.slabel .dots: right: 100%) */
  private static let dotsRoom: CGFloat = 16
  /** The slabel's padding (styles.css: 1px 2px 1px 6px; Ink Wash 0 2px 0 0) */
  private static func padding(ink: Bool) -> (top: CGFloat, right: CGFloat, left: CGFloat) { ink ? (0, 2, 0) : (1, 2, 6) }
  /** The caret's box (.chev2: 16 × 16) and its icon (10 px, --ico-w 2) */
  private static let chev: CGFloat = 16, chevIcon: CGFloat = 10, chevStroke: CGFloat = 2
  /** The flex gap between the title, the count and the caret; the count's margin-left (.scount) */
  private static let gap: CGFloat = 2, countGap: CGFloat = 5 + 2
  /** The collapsed frame's room right of the label (state/sections.ts SHUT_PAD_R) */
  private static let shutPadRight: CGFloat = 8

  init(section: SceneSection) {
    self.section = section
    super.init()
    shouldRasterize = true
    anchorPoint = .zero
    for l in [shape, hilite, wash, ring, echo, brush] {
      l.anchorPoint = .zero
      addSublayer(l)
    }
    hilite.fillRule = .evenOdd
    ring.fillColor = nil
    wash.isHidden = true
    ring.isHidden = true
    echo.isHidden = true
    label.anchorPoint = .zero
    label.contentsGravity = .topLeft
    apply(section)
    drawLabel()
  }
  override init(layer: Any) {
    section = (layer as! SectionLayer).section
    super.init(layer: layer)
  }
  required init?(coder: NSCoder) { fatalError() }
  /** Off the canvas, the label too */
  func detach() {
    label.removeFromSuperlayer()
    removeFromSuperlayer()
  }
  /** Hidden inside a folded Section: its label too */
  override var isHidden: Bool {
    didSet { label.isHidden = isHidden }
  }
  var shut: Bool { section.collapsed == true }

  func apply(_ s: SceneSection) {
    // Ink Wash's open title ellipsizes at the frame's width: a narrower frame draws it again
    let relabel = s.title != section.title || s.count != section.count || s.collapsed != section.collapsed
      || (Theme.isInk && s.collapsed != true && s.w != section.w)
    section = s
    layoutLook()
    recolor()
    if relabel { drawLabel() }
  }
  /** The look changed: the frame is drawn the other way, the title set in the other type */
  func restyle() {
    layoutLook()
    recolor()
    drawLabel()
  }
  /** The title's margins from the frame's corner (.slabel --ml / --mt; collapsed Ink Wash has its own) */
  private var margins: CGPoint {
    shut
      ? CGPoint(x: Theme.number("slabel-shut-ml", 16), y: Theme.number("slabel-shut-mt", 6))
      : CGPoint(x: Theme.number("slabel-ml", 16), y: Theme.number("slabel-mt", 6))
  }
  /** The frame and the strokes for the look; the collapsed frame from the label's size */
  private func layoutLook() {
    let s = section, ink = Theme.isInk, m = margins
    labelSize = SectionLayer.measure(s, ink: ink, shut: shut, frameWidth: CGFloat(s.w))
    let shutSize = CGSize(width: m.x + labelSize.width + SectionLayer.shutPadRight, height: 2 * m.y + labelSize.height)
    frame = CGRect(x: s.x, y: s.y, width: shut ? shutSize.width : s.w, height: shut ? shutSize.height : s.h)
    let r = bounds
    for l in [shape, hilite, wash, ring] { l.frame = r }
    if ink {
      shape.path = nil
      hilite.path = nil
      ring.path = nil
      shape.isHidden = true
      hilite.isHidden = true
      ring.isHidden = true
      let fm = Ink.frameMargin
      brush.isHidden = false
      brush.frame = CGRect(x: -fm - 1, y: -fm - 1, width: r.width + 2 * fm, height: r.height + 2 * fm)
      // the title's width makes the gap in the top stroke (the board: max(40, the label's width)); none when collapsed
      brush.path = Ink.frame(w: r.width, h: r.height, seed: s.seed, gap: shut ? 0 : max(40, labelSize.width))
      let off = Theme.point("secho-offset")
      echo.frame = brush.frame.offsetBy(dx: off.x, dy: off.y)
      echo.path = brush.path
      wash.path = CGPath(rect: r, transform: nil)
    } else {
      brush.isHidden = true
      brush.path = nil
      echo.path = nil
      shape.isHidden = false
      hilite.isHidden = false
      let rad = shut ? Theme.number("sect-shut-radius", 10) : Theme.number("sect-radius", Theme.cardRadius + 1)
      let bw = Theme.border("sect-border")?.w ?? 0.5
      let round = { (q: CGRect, k: CGFloat) in CGPath(roundedRect: q, cornerWidth: max(0, k), cornerHeight: max(0, k), transform: nil) }
      // the border lies inside the box (its centre bw / 2 in); the wash fills the box; the ring is a band outside it
      shape.lineWidth = bw
      shape.path = round(r.insetBy(dx: bw / 2, dy: bw / 2), rad - bw / 2)
      wash.path = round(r, rad)
      let spread = Theme.shadows("sect-sel-ring").first?.spread ?? 3
      ring.lineWidth = spread
      ring.path = round(r.insetBy(dx: -spread / 2, dy: -spread / 2), rad + spread / 2)
      // the inset highlight (--sect-sh: inset 0 1px 0): the box less the box shifted by the offset, kept inside the box
      if let sh = Theme.shadows("sect-sh").first(where: { $0.inset && $0.blur == 0 }) {
        let path = CGMutablePath()
        path.addPath(round(r, rad))
        path.addPath(round(r.offsetBy(dx: sh.x, dy: sh.y), rad))
        hilite.path = path
        let mask = CAShapeLayer()
        mask.path = round(r, rad)
        hilite.mask = mask
      } else {
        hilite.path = nil
        hilite.mask = nil
      }
    }
    placeLabel()
  }
  /** The label's bitmap at the title's place: the margins in from the frame's corner, the dots' room to the left */
  private func placeLabel() {
    let m = margins
    label.bounds = CGRect(x: 0, y: 0, width: labelSize.width + SectionLayer.dotsRoom, height: labelSize.height)
    label.position = CGPoint(x: frame.minX + m.x - SectionLayer.dotsRoom, y: frame.minY + m.y)
  }
  /** The label's bitmap scale follows the zoom like the cards' */
  func setScale(_ scale: CGFloat) {
    rasterizationScale = max(0.125, scale)
    let s = max(0.5, scale)
    guard s != labelScale else { return }
    labelScale = s
    drawLabel()
  }
  var selected = false {
    didSet {
      if selected != oldValue {
        recolor()
        drawLabel()
      }
    }
  }
  func recolor() {
    let sel = selected
    Theme.appearance.performAsCurrentDrawingAppearance {
      if Theme.isInk {
        brush.fillColor = (sel ? Theme.zhu : Theme.ink).withAlphaComponent(Theme.number(sel ? "sbrush-sel-opacity" : "sbrush-opacity", 0.72)).cgColor
        echo.fillColor = Theme.zhu.cgColor
        echo.opacity = Float(Theme.number("secho-opacity", 0.42))
        echo.isHidden = !sel
      } else {
        shape.fillColor = (section.color.flatMap { Theme.sect[$0] } ?? Theme.sectFill).cgColor
        shape.strokeColor = (sel ? Theme.accent : Theme.border("sect-border")?.color ?? Theme.hair).cgColor
        hilite.fillColor = Theme.shadows("sect-sh").first(where: { $0.inset }).flatMap { Theme.parse($0.color) }?.cgColor
        ring.strokeColor = Theme.shadows("sect-sel-ring").first.flatMap { Theme.parse($0.color) }?.cgColor
        ring.isHidden = !sel
      }
      wash.fillColor = Theme.c("sect-wash").cgColor
      wash.isHidden = !sel
    }
  }

  // MARK: the label
  /** The fonts of the label's parts for the look (.slabel: 600 12.5 px / 20 px sys; Ink Wash 25 px / 32 px running script; the
   *  count 400, Ink Wash italic 13 px serif) */
  private static func fonts(ink: Bool) -> (title: NSFont, count: NSFont, line: CGFloat, kern: CGFloat) {
    ink
      ? (Theme.brushHand(25), Theme.serif(13, italic: true), 32, 25 * 0.01)
      : (NSFont.systemFont(ofSize: 12.5, weight: .semibold), NSFont.systemFont(ofSize: 12.5), 20, -12.5 * 0.005)
  }
  private static func countText(_ n: Int) -> String { "· \(n) card\(n == 1 ? "" : "s")" }
  /** The label's box as the board lays it out: padding, the title (Ink Wash open: at most max(60, frame − 64) wide, ellipsized),
   *  the count when collapsed, the gap and the caret (always in the flow, shown or not) */
  static func measure(_ s: SceneSection, ink: Bool, shut: Bool, frameWidth: CGFloat) -> CGSize {
    let f = fonts(ink: ink), p = padding(ink: ink)
    var w = p.left + titleWidth(s, ink: ink, shut: shut, frameWidth: frameWidth)
    if shut { w += countGap + (countText(s.count) as NSString).size(withAttributes: [.font: f.count]).width }
    w += gap + chev + p.right
    return CGSize(width: w.rounded(.up), height: f.line + 2 * p.top)
  }
  private static func titleWidth(_ s: SceneSection, ink: Bool, shut: Bool, frameWidth: CGFloat) -> CGFloat {
    let f = fonts(ink: ink), p = padding(ink: ink)
    let w = (s.title as NSString).size(withAttributes: [.font: f.title, .kern: f.kern]).width
    guard ink, !shut else { return max(20, w) }
    let room = max(60, frameWidth - 64) - p.left - p.right - gap - chev
    return max(20, min(w, room))
  }
  /** The label drawn last: a bitmap finished out of order (the queue is three wide) is not put in */
  private var labelGen = 0
  /** Draws the label on the raster queue and puts the bitmap in */
  private func drawLabel() {
    labelGen += 1
    let g = labelGen
    let s = section, ink = Theme.isInk, shut = shut, sel = selected, scale = labelScale, appearance = Theme.appearance
    let size = CGSize(width: labelSize.width + SectionLayer.dotsRoom, height: labelSize.height)
    let titleW = SectionLayer.titleWidth(s, ink: ink, shut: shut, frameWidth: CGFloat(s.w))
    CardLayer.queue.addOperation {
      let surface = CardLayer.surface(size, scale: scale) {
        appearance.performAsCurrentDrawingAppearance {
          guard let cg = NSGraphicsContext.current?.cgContext else { return }
          let f = SectionLayer.fonts(ink: ink), p = SectionLayer.padding(ink: ink)
          let ink3 = Theme.ink3
          let colour = sel ? (ink ? Theme.zhu : Theme.accent) : (ink ? Theme.ink : Theme.ink2)
          // a line box's text sits with the font's content area centred in the line (CSS line-height)
          let lineTop = p.top
          func draw(_ t: NSAttributedString, font: NSFont, x: CGFloat, width: CGFloat? = nil) {
            let lh = font.ascender - font.descender
            let y = lineTop + (f.line - lh) / 2
            if let width {
              let para = NSMutableParagraphStyle()
              para.lineBreakMode = .byTruncatingTail
              let m = NSMutableAttributedString(attributedString: t)
              m.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: m.length))
              m.draw(with: CGRect(x: x, y: y, width: width, height: lh + 2), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
            } else {
              t.draw(at: CGPoint(x: x, y: y))
            }
          }
          var x = SectionLayer.dotsRoom + p.left
          // the drag dots left of the box (.slabel .dots: 11 px, letter-spacing −2, 1 px right of them), while selected
          if sel && !shut {
            let dots = NSAttributedString(string: "⋮⋮", attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: ink3, .kern: -2])
            dots.draw(at: CGPoint(x: SectionLayer.dotsRoom - 1 - dots.size().width, y: lineTop + 1))
          }
          let title = NSAttributedString(string: s.title, attributes: [.font: f.title, .foregroundColor: colour, .kern: f.kern])
          draw(title, font: f.title, x: x, width: ink && !shut ? titleW : nil)
          x += titleW
          if shut {
            x += SectionLayer.countGap
            let count = NSAttributedString(string: SectionLayer.countText(s.count), attributes: [.font: f.count, .foregroundColor: ink3])
            draw(count, font: f.count, x: x)
            x += count.size().width
          }
          x += SectionLayer.gap
          // the caret: right when collapsed, down while open (shown then only while selected)
          if shut || sel {
            let box = CGRect(x: x, y: lineTop + (f.line - SectionLayer.chev) / 2, width: SectionLayer.chev, height: SectionLayer.chev)
            cg.saveGState()
            cg.translateBy(x: box.midX, y: box.midY)
            if !shut { cg.rotate(by: .pi / 2) }
            cg.translateBy(x: -SectionLayer.chevIcon / 2, y: -SectionLayer.chevIcon / 2)
            Theme.drawIcon("chevR", at: .zero, color: ink3, size: SectionLayer.chevIcon, stroke: SectionLayer.chevStroke)
            cg.restoreGState()
          }
        }
      }
      DispatchQueue.main.async { [weak self] in
        guard let self, let surface, self.labelGen == g else { return }
        self.label.contents = surface
        self.label.contentsScale = scale
      }
    }
  }
}

/** An arrow (styles.css .edge / .ahead / .port, themes.css for the look): the line (Warm Ink: a tapered fill; Ink Wash: a brush
 *  stroke with dry streaks; dashed, hand and coloured lines stroked), its heads, the port dot where it leaves its card while
 *  selected, and its label. Widths follow the look's --edge-w and the line's weight (w1 / w3: 0.6 / 1.6); selected (.on): the
 *  accent, 0.45 px wider */
final class ArrowLayer: CALayer {
  let line = CAShapeLayer()
  let line2 = CAShapeLayer()
  /** Ink Wash: the dry streaks over the stroke (.feibai) */
  let streaks = CAShapeLayer()
  let head = CAShapeLayer()
  let tail = CAShapeLayer()
  /** The port dots (.port): shown while the arrow is selected (Warm Ink and Ink Wash draw none otherwise) */
  let port = CAShapeLayer()
  let port2 = CAShapeLayer()
  private(set) var link: SceneLink
  /** The user's words on the line (styles.css .vchips > .vcard > .vhead > .vlabel), a bitmap centred on its place */
  private let label = CALayer()
  private var labelScale: CGFloat = 2
  /** The label's padding around its box in the bitmap */
  private var labelMargin: CGFloat = 4
  /** The rectangles of the cards at its ends (the canvas sets them with each route): a dragged label keeps clear of them */
  var ends: [CGRect] = []
  init(link: SceneLink) {
    self.link = link
    super.init()
    anchorPoint = .zero
    // a bitmap of the arrow at the zoom bucket's scale, like a card: a zoom frame scales it instead of filling the shapes again
    shouldRasterize = true
    for l in [line, streaks, line2, head, tail, port, port2] { addSublayer(l) }
    label.anchorPoint = CGPoint(x: 0.5, y: 0.5)
    label.contentsGravity = .resizeAspect
    label.isHidden = true
    addSublayer(label)
    apply(link)
    drawLabel()
  }
  /** The arrow's raster and its label's bitmap follow the zoom like the cards' */
  func setScale(_ s: CGFloat) {
    rasterizationScale = max(0.125, s)
    guard s != labelScale else { return }
    labelScale = s
    drawLabel()
  }
  /** .vcard: radius 8.5, --surface, 0 0 0 0.5px hair + 0 1px 2px 5 % shadow; .vhead min-height 22, padding 0 7 0 6; .vlabel
   *  500 11.5 px sys, padding 4px 0, ink. Ink Wash: a canvas-coloured halo (radial 62 %), no box, italic 12/16 serif ink-2,
   *  padding 2px 10px. Selected: a 1.5 px accent ring */
  private var labelGen = 0
  func drawLabel() {
    labelGen += 1
    let g = labelGen
    guard let text = link.label, !text.isEmpty else { label.isHidden = true; label.contents = nil; return }
    let ink = Theme.isInk, sel = selected, scale = labelScale, appearance = Theme.appearance
    let font = ink ? Theme.serif(12, italic: true) : Theme.sys(11.5, weight: .medium)
    let t = NSAttributedString(string: text, attributes: [.font: font, .foregroundColor: ink ? Theme.ink2 : Theme.ink])
    let ts = t.size()
    let padX: CGFloat = ink ? 10 : 7, w = ts.width + padX + (ink ? 10 : 6), h = ink ? max(20, ts.height + 4) : max(22, ts.height + 8)
    let m: CGFloat = ink ? 10 : 4
    labelMargin = m
    label.bounds = CGRect(x: 0, y: 0, width: w + 2 * m, height: h + 2 * m)
    label.isHidden = false
    placeLabel()
    CardLayer.queue.addOperation {
      let surface = CardLayer.surface(CGSize(width: w + 2 * m, height: h + 2 * m), scale: scale) {
        appearance.performAsCurrentDrawingAppearance {
          guard let cg = NSGraphicsContext.current?.cgContext else { return }
          let box = CGRect(x: m, y: m, width: w, height: h)
          if ink {
            let c = Theme.c("canvas")
            if let gr = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [c.cgColor, c.cgColor, c.withAlphaComponent(0).cgColor] as CFArray, locations: [0, 0.62, 1]) {
              let centre = CGPoint(x: box.midX, y: box.midY)
              cg.saveGState()
              cg.translateBy(x: centre.x, y: centre.y)
              cg.scaleBy(x: 1, y: (box.height + 2 * m) / (box.width + 2 * m))
              cg.drawRadialGradient(gr, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: (box.width + 2 * m) / 2, options: [])
              cg.restoreGState()
            }
          } else {
            let path = NSBezierPath(roundedRect: box, xRadius: 8.5, yRadius: 8.5)
            cg.saveGState()
            cg.setShadow(offset: CGSize(width: 0, height: -1), blur: 2, color: NSColor.black.withAlphaComponent(0.05).cgColor)
            Theme.surface.setFill()
            path.fill()
            cg.restoreGState()
            Theme.hair.setStroke()
            path.lineWidth = 0.5
            path.stroke()
          }
          if sel {
            let ring = NSBezierPath(roundedRect: box.insetBy(dx: -0.75, dy: -0.75), xRadius: ink ? 0 : 9.25, yRadius: ink ? 0 : 9.25)
            Theme.accent.setStroke()
            ring.lineWidth = 1.5
            ring.stroke()
          }
          t.draw(at: CGPoint(x: box.minX + padX, y: box.midY - ts.height / 2))
        }
      }
      DispatchQueue.main.async { [weak self] in
        guard let self, self.labelGen == g else { return }
        self.label.contents = surface
        self.label.contentsScale = scale
      }
    }
  }
  override init(layer: Any) {
    link = (layer as! ArrowLayer).link
    super.init(layer: layer)
  }
  required init?(coder: NSCoder) { fatalError() }
  /** The route itself (geo.d), for hit testing */
  private var route: CGPath?
  var selected = false {
    didSet { if selected != oldValue { recolor(); drawLabel() } }
  }
  var color: NSColor {
    if selected { return Theme.accent }
    if let h = link.hand { return Theme.hand[h] ?? Theme.edge }
    if let c = link.color, let k = Theme.link[c] { return k }
    return Theme.edge
  }
  func apply(_ l: SceneLink) {
    let relabel = l.label != link.label
    let replace = l.at != link.at
    link = l
    recolor()
    if relabel { drawLabel() } else if replace { placeLabel() }
  }
  /** Is the world point within `tolerance` of the line */
  func hit(_ p: CGPoint, tolerance: CGFloat) -> Bool {
    guard let route else { return false }
    return route.copy(strokingWithWidth: tolerance * 2, lineCap: .round, lineJoin: .round, miterLimit: 10).contains(p)
  }
  /** The line's weight (.edge.w1 / .w3: --lw 0.6 / 1.6) */
  private var weight: CGFloat { link.width == 1 ? 0.6 : link.width == 3 ? 1.6 : 1 }
  func recolor() {
    var c = color.cgColor
    Theme.appearance.performAsCurrentDrawingAppearance { c = color.cgColor }
    let ink = Theme.isInk, sel = selected, lw = weight, hand = link.hand != nil
    let stroked = link.dash == true || hand
    // .edge: --edge-w × lw, round caps; hand lines 1.6 × lw (2.4 selected); selected lines 0.45 wider; dashed 4 4
    let edgeW = Theme.number("edge-w", 1.25) * lw
    line.fillColor = stroked ? nil : c
    line.strokeColor = stroked || sel ? c : nil
    line.lineWidth = hand ? (sel ? 2.4 : 1.6) * lw : sel ? (stroked ? edgeW + 0.45 : 0.45) : edgeW
    line.lineDashPattern = link.dash == true ? [4, 4] : nil
    line.lineCap = .round
    line.lineJoin = .round
    // the hand line's second stroke: thinner and half seen
    line2.strokeColor = c
    line2.fillColor = nil
    line2.lineWidth = 1.1 * lw
    line2.lineCap = .round
    line2.opacity = 0.5
    // Ink Wash: the brush stroke at .brush's fill-opacity, its dry streaks in the paper's colour, the dot heads at .ahead.dot's
    // opacity; Warm Ink: a ↩ back line at 0.7
    line.opacity = ink && !stroked ? Float(Theme.number("brush-opacity", 1)) : !ink && link.back == true && !stroked ? 0.7 : 1
    streaks.fillColor = nil
    streaks.strokeColor = Theme.paper.withAlphaComponent(0.75).cgColor
    streaks.lineWidth = 0.6
    streaks.lineCap = .round
    streaks.isHidden = !ink || stroked
    // .ahead: filled in the line's colour, stroked --edge-w × lw (a dart 0.35 × lw: the fill is the shape); hand heads are two
    // strokes 1.6 × lw; selected: + 0.45 (a dart 0.45 × lw)
    for h in [head, tail] {
      h.fillColor = hand ? nil : c
      h.strokeColor = c
      h.lineWidth = hand ? (sel ? 2.4 : 1.6) * lw : ink ? edgeW + (sel ? 0.45 : 0) : (sel ? 0.45 : 0.35) * lw
      h.lineCap = .round
      h.lineJoin = .round
      h.opacity = ink ? Float(Theme.number("head-dot-opacity", 1)) : 1
    }
    // .port: the surface with the edge's stroke; Ink Wash: filled in the ink, no stroke
    for p in [port, port2] {
      p.fillColor = (ink ? Theme.ink : Theme.surface).cgColor
      p.strokeColor = ink ? nil : Theme.edge.cgColor
      p.lineWidth = Theme.number("edge-w", 1.25)
      p.isHidden = !sel
    }
  }
  /** The curve's control points (core Geo.pts), for a sticker riding the arrow */
  private(set) var pts: [Double] = []
  func apply(geo: RouteGeo) {
    let stroked = link.dash == true || link.hand != nil
    pts = geo.pts
    let d = geo.path(geo.n.d, geo.s.d)
    route = d
    line.path = stroked ? d : (geo.path(geo.n.taper, geo.s.taper) ?? d)
    streaks.path = geo.path(geo.n.fb, geo.s.fb)
    line2.path = geo.path(geo.n.d2, geo.s.d2)
    head.path = geo.path(geo.n.head, geo.s.head)
    tail.path = geo.path(geo.n.tail, geo.s.tail)
    let dot = { (p: ScenePoint?) -> CGPath? in p.map { CGPath(ellipseIn: CGRect(x: $0.x - 3, y: $0.y - 3, width: 6, height: 6), transform: nil) } }
    port.path = dot(geo.port)
    port2.path = dot(geo.port2)
    // the layer's own box around its paths (the paths stay in world coordinates: bounds.origin shifts them in), so the raster
    // is just the arrow
    var box = CGRect.null
    for l in [line, line2, head, tail, port, port2] { if let p = l.path { box = box.union(p.boundingBoxOfPath) } }
    if !box.isNull {
      box = box.insetBy(dx: -8, dy: -8)
      bounds = box
      position = box.origin
    }
    middle = CGPoint(x: geo.mx, y: geo.my)
    placeLabel()
  }
  private var middle = CGPoint.zero
  /** The label at the route's middle, or where the user dragged it (Link.at), moved towards the middle while its box would
   *  lie on an end card (core labelpos.ts placeT) */
  private func placeLabel() {
    guard !label.isHidden else { return }
    guard let at = link.at, pts.count >= 8 else { label.position = middle; return }
    let box = CGSize(width: label.bounds.width - 2 * labelMargin, height: label.bounds.height - 2 * labelMargin)
    label.position = LabelPos.bezAt(pts, LabelPos.placeT(pts, CGFloat(at), box: box, rects: ends))
  }
}

/** A sticker on the canvas: a bitmap drawn on the raster queue (stickers/glyphs.tsx Glyph, styles.css .glyph.bi: the disc in
 *  the colour mixed 86 % with #5b3d22 (Ink Wash: 30 % with the ink), the line in #fffaf1 (Ink Wash: the paper) 2 px wide in a
 *  24-unit box; a label sticker is a capsule; an emoji is the character at 0.86 of the size) */
final class StickerLayer: CALayer {
  private(set) var sticker: SceneSticker
  private var drawnScale: CGFloat = 0
  /** The selection ring (styles.css .stk.sel: 1.5 px of accent, 2 px out), a sublayer so selecting redraws nothing */
  private let ring = CAShapeLayer()
  var selected = false {
    didSet {
      guard selected != oldValue else { return }
      ring.isHidden = !selected
      if selected { Theme.appearance.performAsCurrentDrawingAppearance { ring.strokeColor = Theme.accent.cgColor } }
    }
  }
  init(sticker: SceneSticker) {
    self.sticker = sticker
    super.init()
    anchorPoint = .zero
    contentsGravity = .resizeAspect
    ring.fillColor = nil
    ring.lineWidth = 1.5
    ring.isHidden = true
    addSublayer(ring)
    apply(sticker)
  }
  override init(layer: Any) {
    sticker = (layer as! StickerLayer).sticker
    super.init(layer: layer)
  }
  required init?(coder: NSCoder) { fatalError() }
  func apply(_ s: SceneSticker) {
    let redraw = s.g != sticker.g || s.size != sticker.size
    sticker = s
    frame = CGRect(x: s.x + anchor.x, y: s.y + anchor.y, width: width, height: s.size)
    let r = bounds.insetBy(dx: -2.75, dy: -2.75)
    ring.frame = bounds
    ring.path = CGPath(roundedRect: r, cornerWidth: 4, cornerHeight: 4, transform: nil)
    if redraw || contents == nil { draw() }
  }
  /** On an arrow: the point t along its curve (the sticker's x / y are the offset from it); set as the arrow's route lands */
  private(set) var anchor = CGPoint.zero
  func place(along pts: [Double]) {
    guard pts.count >= 8, let t = sticker.t else { return }
    let u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t
    anchor = CGPoint(x: a * pts[0] + b * pts[2] + c * pts[4] + d * pts[6], y: a * pts[1] + b * pts[3] + c * pts[5] + d * pts[7])
    frame.origin = CGPoint(x: sticker.x + anchor.x, y: sticker.y + anchor.y)
  }
  /** A label sticker (TODO) is as wide as its text plus 0.55em each side */
  private var width: CGFloat { StickerLayer.width(sticker.g, size: sticker.size) }
  func setScale(_ s: CGFloat) {
    guard s != drawnScale else { return }
    draw(scale: s)
  }
  /** The glyph at a size into r (its width is r's: a label capsule is wider than it is tall), in the current appearance */
  static func drawGlyph(_ s: SceneGlyph, size: CGFloat, in r: CGRect) {
    guard let cg = NSGraphicsContext.current?.cgContext else { return }
    let ink = Theme.isInk
    if let emoji = s.emoji {
      let t = NSAttributedString(string: emoji, attributes: [.font: NSFont.systemFont(ofSize: size * 0.86)])
      let ts = t.size()
      t.draw(at: CGPoint(x: r.midX - ts.width / 2, y: r.midY - ts.height / 2))
      return
    }
    guard let colour = s.color.map({ NSColor(cgColor: cssColor($0)) ?? Theme.accent }) else {
      // a custom pack's icon the app has not read: the board's .glyph.missing box
      Theme.ink3.withAlphaComponent(0.3).setFill()
      NSBezierPath(roundedRect: r, xRadius: 5.5, yRadius: 5.5).fill()
      return
    }
    // ponytail: the board mixes in oklab; sRGB is close for these hues
    let bg = ink ? colour.blended(withFraction: 0.7, of: Theme.ink) ?? colour : colour.blended(withFraction: 0.14, of: NSColor(srgbRed: 0x5b / 255, green: 0x3d / 255, blue: 0x22 / 255, alpha: 1)) ?? colour
    let fg = ink ? Theme.c("paper") : NSColor(srgbRed: 1, green: 0xfa / 255, blue: 0xf1 / 255, alpha: 1)
    if let text = s.text {
      bg.setFill()
      NSBezierPath(roundedRect: r, xRadius: r.height / 2, yRadius: r.height / 2).fill()
      let f = Theme.sys(size * 0.5, weight: .bold)
      let t = NSAttributedString(string: text, attributes: [.font: f, .foregroundColor: fg, .kern: f.pointSize * 0.04])
      let ts = t.size()
      t.draw(at: CGPoint(x: r.midX - ts.width / 2, y: r.midY - ts.height / 2))
      return
    }
    let k = size / 24
    cg.saveGState()
    cg.translateBy(x: r.minX, y: r.minY)
    cg.scaleBy(x: k, y: k)
    cg.setFillColor(bg.cgColor)
    cg.fillEllipse(in: CGRect(x: 1, y: 1, width: 22, height: 22))
    cg.setLineCap(.round)
    cg.setLineJoin(.round)
    if let d = s.d {
      cg.addPath(SVGPath.parse(d))
      cg.setLineWidth(2)
      cg.setStrokeColor(fg.cgColor)
      cg.strokePath()
    }
    if let fill = s.fill {
      let path = SVGPath.parse(fill)
      cg.addPath(path)
      cg.setFillColor(fg.cgColor)
      cg.fillPath()
      cg.addPath(path)
      cg.setLineWidth(1)
      cg.setStrokeColor(fg.cgColor)
      cg.strokePath()
    }
    cg.restoreGState()
  }
  /** The width of a label capsule for a glyph at a size (StickerLayer.width) */
  static func width(_ g: SceneGlyph, size: CGFloat) -> CGFloat {
    guard let text = g.text else { return size }
    let f = Theme.sys(size * 0.5, weight: .bold)
    return (text as NSString).size(withAttributes: [.font: f, .kern: f.pointSize * 0.04]).width + 1.1 * f.pointSize
  }
  /** A pack icon's frames play only while the layer shows (the canvas hides stickers out of view): a keyframe animation on
   *  contents runs in the render server, no wakeup of the app; a hidden layer carries none */
  override var isHidden: Bool {
    didSet { if isHidden != oldValue { animate() } }
  }
  private func animate() {
    removeAnimation(forKey: "frames")
    guard !isHidden, let pack = sticker.g.pack, let name = sticker.g.name, let icon = Packs.icon(pack, name), icon.frames.count > 1 else { return }
    let a = CAKeyframeAnimation(keyPath: "contents")
    a.values = icon.frames
    a.keyTimes = icon.keyTimes as [NSNumber]
    a.duration = icon.duration
    a.calculationMode = .discrete
    a.repeatCount = .infinity
    add(a, forKey: "frames")
  }
  func draw(scale: CGFloat? = nil) {
    let scale = scale ?? max(drawnScale, 1)
    drawnScale = scale
    let s = sticker, size = CGSize(width: width, height: s.size), appearance = Theme.appearance
    if let pack = s.g.pack, let name = s.g.name, let icon = Packs.icon(pack, name) {
      contents = icon.frames[0]
      animate()
      return
    }
    CardLayer.queue.addOperation {
      let surface = CardLayer.surface(size, scale: scale) {
        appearance.performAsCurrentDrawingAppearance { StickerLayer.drawGlyph(s.g, size: s.size, in: CGRect(origin: .zero, size: size)) }
      }
      DispatchQueue.main.async { [weak self] in
        guard let self, let surface else { return }
        self.contents = surface
        self.contentsScale = scale
      }
    }
  }
}

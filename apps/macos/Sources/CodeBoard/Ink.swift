// Ink Wash's drawings for the native canvas, from the same maths the web board draws them with (core's canvas inkpaper.ts and
// inkframe.ts, called through the bridge): the torn paper sheet behind a card (a nine-slice image, one per edge pattern, light /
// dark), a Section's four brush strokes (a path), the 选 seal a selected card wears and the ink scene behind the board.
// Images are made once on the ink thread and kept; nobody on the main thread waits for one: the paper sheets are made ahead
// (`prewarm`, at load), a Section's frame comes back through a callback, and until then the plain paper / no frame shows.
import AppKit
import JavaScriptCore

/** paperSheet's result (core inkpaper.ts) */
struct PaperSheet: Decodable {
  var size: Double
  var outline: String
  var inner: String
  var fibres: String
  var paper: String
  var fiber: String
  var innerOpacity: Double
  var edgeOpacity: Double
}

enum Ink {
  /** The JavaScript with core's drawings: a small context of its own over router.js on a thread of its own (like the router's;
   *  the bridge's context is its thread's alone). Only the thumbnail queue waits on it (`frameNow`); the main thread and the
   *  raster queue read the caches, under `lock`, and get what is there */
  private static let js = JSThread("codeboard.ink")
  private static var art: JSValue?
  static func load(_ bundle: URL) {
    guard let src = try? String(contentsOf: bundle, encoding: .utf8) else { return }
    js.post {
      guard let ctx = JSContext(virtualMachine: JSVirtualMachine()!) else { return }
      ctx.exceptionHandler = { _, e in logLine("[codeboard ink] %@", e?.toString() ?? "?") }
      ctx.evaluateScript(src, withSourceURL: bundle)
      art = ctx.objectForKeyedSubscript("CodeRouter")
    }
  }
  /** Runs on the ink thread and hands back its result; never from the main thread */
  private static func onJS<T>(_ f: @escaping () -> T) -> T {
    dispatchPrecondition(condition: .notOnQueue(.main))
    let done = DispatchSemaphore(value: 0)
    var out: T!
    js.post { out = f(); done.signal() }
    done.wait()
    return out
  }
  private static let lock = NSLock()
  private static var sheets: [String: NSImage] = [:]
  private static var frames: [String: CGPath] = [:]
  /** Posted on the main thread when a sheet or a frame is there that someone asked for and missed */
  static let ready = Notification.Name("codeboard.ink.ready")
  /** The paper for every edge pattern (core PAPER_SEEDS), light and dark, made ahead on the ink thread */
  static func prewarm() {
    js.post {
      for dark in [false, true] { for seed in 0..<4 { _ = paperOnJS(dark: dark, seed: seed) } }
      DispatchQueue.main.async { NotificationCenter.default.post(name: ready, object: nil) }
    }
  }
  /** The seals and the scene, made and read on the main thread only */
  private static var stamps: [String: NSImage] = [:]
  private static var scenes: [String: NSImage] = [:]
  /** How far the paper reaches outside the card (core PAPER_M, themes.css inset: -14px) */
  static let paperMargin: CGFloat = 14
  /** The nine-slice's corner (core PAPER_SLICE) */
  private static let slice: CGFloat = 30
  /** The sheet is drawn this many times its size (the board's PAPER_SCALE: crisp on a 2× screen zoomed in) */
  private static let paperScale: CGFloat = 3

  /** The paper of a card with this edge pattern: a nine-slice image, made ahead (prewarm); nil until it is, and then `ready` */
  static func paper(dark: Bool, seed: Int) -> NSImage? {
    let key = "\(seed):\(dark)"
    if let s = lock.withLock({ sheets[key] }) { return s }
    // asked for once (every card and tile drawn before it is made asks): one `ready` when it is made, not one per ask, each of
    // which redraws every card in view
    guard lock.withLock({ asked.insert(key).inserted }) else { return nil }
    js.post {
      guard paperOnJS(dark: dark, seed: seed) != nil else { return }
      DispatchQueue.main.async { NotificationCenter.default.post(name: ready, object: nil) }
    }
    return nil
  }
  private static var asked: Set<String> = []
  /** On the ink thread */
  private static func paperOnJS(dark: Bool, seed: Int) -> NSImage? {
    let key = "\(seed):\(dark)"
    if let s = lock.withLock({ sheets[key] }) { return s }
    guard let art, let json = art.invokeMethod("paperSheet", withArguments: [dark, seed])?.toString(), let p = try? decodeJSON(PaperSheet.self, json) else { return nil }
    let s = CGFloat(p.size), k = paperScale
    let img = NSImage(size: NSSize(width: s, height: s), flipped: true) { _ in
      guard let cg = NSGraphicsContext.current?.cgContext else { return false }
      let outline = SVGPath.parse(p.outline)
      cg.setFillColor(cssColor(p.paper))
      cg.addPath(outline)
      cg.fillPath()
      cg.setLineWidth(0.5)
      cg.setStrokeColor(cssColor(p.fiber))
      cg.setAlpha(CGFloat(p.innerOpacity))
      cg.addPath(SVGPath.parse(p.inner))
      cg.strokePath()
      cg.setAlpha(1)
      cg.setLineWidth(0.7)
      cg.setLineCap(.round)
      cg.setStrokeColor(cssColor(p.paper))
      cg.addPath(SVGPath.parse(p.fibres))
      cg.strokePath()
      cg.setLineWidth(0.5)
      cg.setLineCap(.butt)
      cg.setStrokeColor(cssColor(p.fiber))
      cg.setAlpha(CGFloat(p.edgeOpacity))
      cg.addPath(outline)
      cg.strokePath()
      return true
    }
    // drawn into a bitmap at paperScale, so the drawing block runs once, not on every card
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(s * k), pixelsHigh: Int(s * k), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: s, height: s)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    img.draw(in: NSRect(x: 0, y: 0, width: s, height: s))
    NSGraphicsContext.restoreGraphicsState()
    let out = NSImage(size: NSSize(width: s, height: s))
    out.addRepresentation(rep)
    out.capInsets = NSEdgeInsets(top: slice, left: slice, bottom: slice, right: slice)
    out.resizingMode = .tile
    lock.withLock { sheets[key] = out }
    return out
  }

  /** The paper drawn under a card of this rect (the sheet reaches paperMargin outside it); called on the raster queue. Before the
   *  sheet is made the card shows its plain paper (the face), and is drawn again on `ready` */
  static func drawPaper(_ r: CGRect, dark: Bool, seed: Int) {
    guard let img = paper(dark: dark, seed: seed) else { return }
    img.draw(in: r.insetBy(dx: -paperMargin, dy: -paperMargin), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
  }

  /** A Section's brush frame for a size (rounded to 2 as the board does), seed and title gap: the path, FRAME_M bigger on each
   *  side. From the main thread: the cached path now, or nil and `then` on the main thread once it is made */
  @discardableResult
  static func frame(w: CGFloat, h: CGFloat, seed: Int, gap: CGFloat, _ then: ((CGPath) -> Void)? = nil) -> CGPath? {
    let key = frameKey(w, h, seed, gap)
    if let p = lock.withLock({ frames[key] }) { return p }
    js.post {
      guard let p = frameOnJS(key) else { return }
      if let then { DispatchQueue.main.async { then(p) } }
    }
    return nil
  }
  /** The frame, waited for: the thumbnail queue, never the main thread */
  static func frameNow(w: CGFloat, h: CGFloat, seed: Int, gap: CGFloat) -> CGPath? {
    let key = frameKey(w, h, seed, gap)
    if let p = lock.withLock({ frames[key] }) { return p }
    return onJS { frameOnJS(key) }
  }
  private static func frameKey(_ w: CGFloat, _ h: CGFloat, _ seed: Int, _ gap: CGFloat) -> String {
    let W = max(2, (w / 2).rounded() * 2), H = max(2, (h / 2).rounded() * 2), g = (gap / 2).rounded() * 2
    return "\(W)x\(H):\(g):\(seed)"
  }
  /** On the ink thread; key = frameKey's */
  private static func frameOnJS(_ key: String) -> CGPath? {
    if let p = lock.withLock({ frames[key] }) { return p }
    let parts = key.split(whereSeparator: { "x:".contains($0) }).map { Double($0) ?? 0 }
    guard parts.count == 4, let art, let d = art.invokeMethod("brushFrame", withArguments: [parts[0], parts[1], Int(parts[3]), parts[2]])?.toString() else { return nil }
    let p = SVGPath.parse(d)
    lock.withLock {
      if frames.count > 400 { frames.removeAll() }
      frames[key] = p
    }
    return p
  }
  /** How far the frame's image reaches outside the Section (core FRAME_M) */
  static let frameMargin: CGFloat = 12

  /** The 选 seal of a selected card (themes.css .cface::before): paper at 60 % with a vermilion ring and the character, the
   *  印泥 grain and rough edge masked in (--seal-mask) */
  static func stamp(dark: Bool) -> NSImage? {
    dispatchPrecondition(condition: .onQueue(.main))
    let key = dark ? "dark" : "light"
    if let s = stamps[key] { return s }
    let size = Theme.number("stamp-size", 24)
    guard let grain = Theme.image("seal-grain.png"), let edge = Theme.image("seal-edge.png") else { return nil }
    let ring = Theme.shadows("stamp-ring").first
    let img = NSImage(size: NSSize(width: size, height: size), flipped: true) { r in
      guard let cg = NSGraphicsContext.current?.cgContext else { return false }
      // mask: the grain tiled at 48 px, the edge stretched over the seal
      cg.saveGState()
      cg.translateBy(x: 0, y: r.height)
      cg.scaleBy(x: 1, y: -1)
      cg.clip(to: r, mask: edge)
      let tile = CGRect(x: 0, y: 0, width: 48, height: 48)
      cg.clip(to: r, mask: tiled(grain, tile, in: r))
      cg.scaleBy(x: 1, y: -1)
      cg.translateBy(x: 0, y: -r.height)
      let box = NSBezierPath(roundedRect: r, xRadius: 2, yRadius: 2)
      Theme.c("stamp-bg").setFill()
      box.fill()
      if let ring {
        Theme.parse(ring.color)?.setStroke()
        let inner = NSBezierPath(roundedRect: r.insetBy(dx: ring.spread / 2, dy: ring.spread / 2), xRadius: 2, yRadius: 2)
        inner.lineWidth = ring.spread
        inner.stroke()
      }
      let t = NSAttributedString(string: "选", attributes: [.font: Theme.serif(14, weight: .bold), .foregroundColor: Theme.zhu])
      let ts = t.size()
      t.draw(at: CGPoint(x: (r.width - ts.width) / 2, y: (r.height - ts.height) / 2))
      cg.restoreGState()
      return true
    }
    stamps[key] = img
    return img
  }
  /** A small image tiled over a rect as one mask image */
  private static func tiled(_ img: CGImage, _ tile: CGRect, in r: CGRect) -> CGImage {
    let w = Int(r.width * 2), h = Int(r.height * 2)
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.scaleBy(x: 2, y: 2)
    ctx.draw(img, in: tile, byTiling: true)
    return ctx.makeImage()!
  }

  /** The ink scene behind the board (packages/board/src/scenes/ink-*.svg): center bottom / cover, as the board's CSS; decoded
   *  once. Main thread only: a thumbnail asks for it on the main thread before it draws (Thumbs.make) */
  static func scene(dark: Bool) -> NSImage? {
    dispatchPrecondition(condition: .onQueue(.main))
    let key = dark ? "dark" : "light"
    if let s = scenes[key] { return s }
    let img = Theme.resource(dark ? "ink-dark.svg" : "ink-light.svg").flatMap { NSImage(contentsOf: $0) }
    scenes[key] = img
    return img
  }
}

/** "#rrggbbaa" or "#rrggbb" → a colour */
func cssColor(_ s: String) -> CGColor {
  var h = s.dropFirst()
  if h.count == 6 { h += "ff" }
  let n = UInt32(h, radix: 16) ?? 0
  return CGColor(srgbRed: CGFloat((n >> 24) & 0xff) / 255, green: CGFloat((n >> 16) & 0xff) / 255, blue: CGFloat((n >> 8) & 0xff) / 255, alpha: CGFloat(n & 0xff) / 255)
}

// The base tier: every card keeps a low-resolution picture of itself (Base.scale device pixels per world point; its face and,
// for a framed card, its sheet), always resident and never evicted, under the sharp bitmaps the zoom buckets draw. Wherever a
// sharp bitmap is not there (not drawn yet, culled, evicted, a tile not reached) the base shows: a card is at worst soft, never
// missing. Bases are kept on disk by what they depend on, so a board opened again has every card's base before it is shown.
import AppKit
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

enum Base {
  /** About the summary level's scale: a 500 × 700 card is 125 × 175 px, ~88 KB (250 cards ~22 MB) */
  static let scale: CGFloat = 0.25
  /** Bases are drawn here (disk reads, decodes and the small rasters), beside the sharp tier's queue */
  static let queue: OperationQueue = {
    let q = OperationQueue()
    q.name = "codeboard.base"
    q.qualityOfService = .userInitiated
    q.maxConcurrentOperationCount = 4
    return q
  }()
  static let dir = Home.caches.appendingPathComponent("CodeBoard/base", isDirectory: true)
  private static let disk = DispatchQueue(label: "codeboard.base.disk", qos: .utility)
  /** What every base depends on beyond its own key: this build's drawing (a rebuilt app never reads an older one's bases) */
  private static let build: String = {
    let exe = Bundle.main.executableURL.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.modificationDate] as? Date }
    return "\(exe?.timeIntervalSince1970 ?? 0)"
  }()
  static func key(_ parts: String) -> String {
    SHA256.hash(data: Data("\(build)|\(parts)".utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
  }
  private static func file(_ key: String) -> URL { dir.appendingPathComponent(key + ".png") }

  /** The base on disk for this key (a few KB of PNG), decoded here: call it on `queue` */
  static func read(_ key: String) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(file(key) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
  }
  static func write(_ key: String, _ img: CGImage) {
    prune()
    disk.async {
      let u = file(key)
      guard let d = CGImageDestinationCreateWithURL(u as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
      CGImageDestinationAddImage(d, img, nil)
      CGImageDestinationFinalize(d)
    }
  }
  /** At most this many files: the oldest half go when there are more (checked once per launch) */
  static let maxFiles = 12000
  private static var pruned = false
  private static func prune() {
    guard !pruned else { return }
    pruned = true
    disk.async {
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      guard let all = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey]), all.count > maxFiles else { return }
      let dated = all.map { u in (u, (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast) }.sorted { $0.1 < $1.1 }
      for (u, _) in dated.prefix(all.count - maxFiles / 2) { try? FileManager.default.removeItem(at: u) }
    }
  }

  /** A bitmap of a size at a scale, drawn into with AppKit (flipped, as CardLayer.surface) */
  static func bitmap(_ size: CGSize, scale: CGFloat, _ draw: () -> Void) -> CGImage? {
    let w = max(1, Int((size.width * scale).rounded())), h = max(1, Int((size.height * scale).rounded()))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CardLayer.colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: 0, y: size.height)
    ctx.scaleBy(x: 1, y: -1)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
    draw()
    NSGraphicsContext.restoreGraphicsState()
    return ctx.makeImage()
  }
}

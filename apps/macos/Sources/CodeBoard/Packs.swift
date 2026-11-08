// Custom sticker packs (the host's packsIn through the bridge, from ~/.codeboard/stickers): each icon decoded once per process
// into its frames (a GIF / APNG / WebP's, with their times; an SVG or still as one), for the StickerLayers to show and animate.
import AppKit
import ImageIO

enum Packs {
  struct Icon {
    var frames: [CGImage]
    /** Each frame's start as a share of the whole (CAKeyframeAnimation keyTimes) and the whole's length in seconds */
    var keyTimes: [Double]
    var duration: Double
  }
  private static var packs: [String: StickerPack.Icon] = [:]
  private static var decoded: [String: Icon?] = [:]
  /** Reads the packs once; a sticker drawn before they come shows the missing box until the next draw */
  static func load(_ bridge: JSBridge, dir: String = NSHomeDirectory() + "/.codeboard/stickers") {
    bridge.stickerPacks(dir) { r in
      guard case .success(let ps) = r else { return }
      for p in ps { for ic in p.icons { packs["\(p.id):\(ic.name)"] = ic } }
      if !ps.isEmpty { logLine("[codeboard] %d sticker packs, %d icons", ps.count, packs.count) }
    }
  }
  static func icon(_ pack: String, _ name: String) -> Icon? {
    let key = "\(pack):\(name)"
    if let d = decoded[key] { return d }
    let out = packs[key].flatMap(decode)
    decoded[key] = out
    return out
  }
  private static func decode(_ ic: StickerPack.Icon) -> Icon? {
    if let svg = ic.svg {
      // ponytail: AppKit's own SVG decoding, unsanitised (the file is the user's own); a pack's SVG it cannot read is the missing box
      guard let img = NSImage(data: Data(svg.utf8)), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
      return Icon(frames: [cg], keyTimes: [0], duration: 0)
    }
    guard let img = ic.img, let comma = img.firstIndex(of: ","), let data = Data(base64Encoded: String(img[img.index(after: comma)...])),
      let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let n = CGImageSourceGetCount(src)
    var frames: [CGImage] = [], delays: [Double] = []
    for i in 0..<n {
      guard let f = CGImageSourceCreateImageAtIndex(src, i, nil) else { continue }
      frames.append(f)
      let props = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any]
      let dict = (props?[kCGImagePropertyGIFDictionary] ?? props?[kCGImagePropertyPNGDictionary] ?? props?[kCGImagePropertyWebPDictionary]) as? [CFString: Any]
      let d = (dict?[kCGImagePropertyGIFUnclampedDelayTime] ?? dict?[kCGImagePropertyGIFDelayTime] ?? dict?[kCGImagePropertyAPNGUnclampedDelayTime] ?? dict?[kCGImagePropertyAPNGDelayTime] ?? dict?[kCGImagePropertyWebPUnclampedDelayTime] ?? dict?[kCGImagePropertyWebPDelayTime]) as? Double ?? 0.1
      delays.append(max(0.02, d))  // browsers treat 0 as 100 ms, and anything under 20 ms as slow as that
    }
    guard !frames.isEmpty else { return nil }
    let total = delays.reduce(0, +)
    var t = 0.0, keys: [Double] = []
    for d in delays { keys.append(total > 0 ? t / total : 0); t += d }
    return Icon(frames: frames, keyTimes: keys, duration: total)
  }
}

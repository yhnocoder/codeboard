import AppKit
import ImageIO
import Synchronization

/// Least recently used out first, once the bytes held pass the cap.
struct ByteLRU<Key: Hashable> {
  let cap: Int
  private(set) var bytes = 0
  private var entries: [Key: (bytes: Int, used: Int)] = [:]
  private var clock = 0

  init(cap: Int) { self.cap = cap }

  func contains(_ k: Key) -> Bool { entries[k] != nil }

  mutating func touch(_ k: Key) {
    clock += 1
    entries[k]?.used = clock
  }

  /// Adds (or replaces) `k` and returns what had to go, oldest first. The newest entry always stays, even alone over
  /// the cap
  mutating func insert(_ k: Key, bytes b: Int) -> [Key] {
    clock += 1
    bytes += b - (entries[k]?.bytes ?? 0)
    entries[k] = (b, clock)
    var out: [Key] = []
    // ponytail: a scan per eviction; a linked list if a cache ever holds thousands of pictures
    while bytes > cap, let old = entries.filter({ $0.key != k }).min(by: { $0.value.used < $1.value.used }) {
      bytes -= old.value.bytes
      entries[old.key] = nil
      out.append(old.key)
    }
    return out
  }
}

/// Pictures decoded for drawing into item bitmaps, at a power-of-two width of at least what is asked (up to the file's
/// own pixels), kept within a byte cap. Raster formats only: an SVG is drawn by the Note renderer. Safe from any thread; a decode runs on the caller's thread, outside the lock.
final class DecodeCache: Sendable {
  struct Key: Hashable {
    var url: URL
    var frame: Int
    var width: Int
  }

  private struct State {
    var lru: ByteLRU<Key>
    var images: [Key: CGImage] = [:]
  }

  private let state: Mutex<State>

  init(cap: Int) { state = Mutex(State(lru: ByteLRU(cap: cap))) }

  var bytes: Int { state.withLock { $0.lru.bytes } }

  /// `frame` from 0 (an animated image's rest frame). decoded: whether this call had to decode
  func image(_ url: URL, frame: Int, width: Int, fileSize: CGSize) -> (image: CGImage?, decoded: Bool) {
    let cap = max(1, Int(fileSize.width))
    var level = 128
    while level < width && level < cap { level *= 2 }
    level = min(level, cap)
    let hit = state.withLock { s -> CGImage? in
      let k = s.images.keys.filter { $0.url == url && $0.frame == frame && $0.width >= level }.min {
        $0.width < $1.width
      }
      guard let k else { return nil }
      s.lru.touch(k)
      return s.images[k]
    }
    if let hit { return (hit, false) }
    let img = DecodeCache.decode(url, frame: frame, width: level, cap: cap)
    if let img {
      state.withLock { s in
        let k = Key(url: url, frame: frame, width: level)
        s.images[k] = img
        for old in s.lru.insert(k, bytes: img.bytesPerRow * img.height) { s.images[old] = nil }
      }
    }
    return (img, true)
  }

  /// Pixel size from the file name (`<hash>-<w>x<h>.<ext>`, as the board names them), else from the file's header
  static func pixelSize(_ url: URL) -> CGSize? {
    let name = url.deletingPathExtension().lastPathComponent
    if let m = name.wholeMatch(of: /.*-(\d+)x(\d+)/), let w = Double(m.1), let h = Double(m.2), w > 0, h > 0 {
      return CGSize(width: w, height: h)
    }
    // NSImage reads an SVG's size from its root's width, height and viewBox (it draws it wrong, so only the size)
    if url.pathExtension.lowercased() == "svg" { return NSImage(contentsOf: url)?.size }
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
      let w = p[kCGImagePropertyPixelWidth] as? Double, let h = p[kCGImagePropertyPixelHeight] as? Double
    else { return nil }
    return CGSize(width: w, height: h)
  }

  private static func decode(_ url: URL, frame: Int, width: Int, cap: Int) -> CGImage? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let i = min(max(frame, 0), max(CGImageSourceGetCount(src) - 1, 0))
    if width >= cap {
      return CGImageSourceCreateImageAtIndex(src, i, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    }
    guard let p = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any],
      let w = p[kCGImagePropertyPixelWidth] as? Double, let h = p[kCGImagePropertyPixelHeight] as? Double, w > 0
    else { return nil }
    let side = max(Double(width), Double(width) * h / w)
    return CGImageSourceCreateThumbnailAtIndex(
      src, i,
      [
        kCGImageSourceThumbnailMaxPixelSize: Int(side.rounded(.up)),
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
      ] as CFDictionary)
  }
}

import AppKit

/// SVG pictures for a host's image path: ImageIO does not read SVG, the web board draws it (sanitised, md/images.ts).
/// Scripts, event handlers, foreignObject and references to anything outside the file are taken out first; the rest is
/// drawn by the system's SVG renderer at the pixel size asked for, so it stays sharp at any zoom
public enum MarkdownSVG {
  /// whether these bytes are an SVG document (by its start, not its name)
  public static func isSVG(_ data: Data) -> Bool {
    let head = String(decoding: data.prefix(512), as: UTF8.self).lowercased()
    return head.contains("<svg")
  }

  /// the document with what could run or load something removed
  public static func sanitized(_ data: Data) -> Data {
    var s = String(decoding: data, as: UTF8.self)
    let patterns = [
      #"<script\b[\s\S]*?</script\s*>"#, #"<script\b[^>]*/>"#, #"<foreignObject\b[\s\S]*?</foreignObject\s*>"#,
      #"\son[a-zA-Z]+\s*=\s*("[^"]*"|'[^']*')"#,
      // links and styles reaching outside the file: only fragments (#id) and data: stay
      #"\s(?:xlink:)?href\s*=\s*("(?!#|data:)[^"]*"|'(?!#|data:)[^']*')"#, #"url\(\s*['"]?(?!#|data:)[^)]*\)"#,
      #"@import[^;]*;"#,
    ]
    for p in patterns {
      s = s.replacingOccurrences(of: p, with: "", options: [.regularExpression, .caseInsensitive])
    }
    return Data(s.utf8)
  }

  /// its size in points (width and height, else the viewBox), nil when it cannot be read
  public static func size(_ data: Data) -> CGSize? {
    guard let i = NSImage(data: sanitized(data)), i.size.width > 0, i.size.height > 0 else { return nil }
    return i.size
  }

  /// drawn `pixelWidth` pixels wide, its height in proportion (at most 4096 a side)
  public static func image(_ data: Data, pixelWidth: Int) -> CGImage? {
    guard let i = NSImage(data: sanitized(data)), i.size.width > 0, i.size.height > 0 else { return nil }
    let w = min(4096, max(1, pixelWidth))
    let h = min(4096, max(1, Int((CGFloat(w) * i.size.height / i.size.width).rounded())))
    guard
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
    i.draw(in: CGRect(x: 0, y: 0, width: w, height: h))
    NSGraphicsContext.restoreGraphicsState()
    return ctx.makeImage()
  }
}

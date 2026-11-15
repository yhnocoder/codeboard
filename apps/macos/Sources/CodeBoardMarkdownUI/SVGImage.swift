import AppKit

/// SVG pictures for a host's image path: ImageIO does not read SVG, the web editor draws it (sanitised, md/images.ts).
/// Scripts, event handlers, foreignObject and references to anything outside the file are taken out first; the rest is
/// drawn by the system's SVG renderer at the pixel size asked for, so it stays sharp at any zoom. That renderer ignores
/// @media blocks, custom properties declared anywhere but :root and light-dark(): the stylesheet is resolved for the
/// look's appearance first (a file whose light colours sit in @media (prefers-color-scheme: light) drew its dark ones)
public enum MarkdownSVG {
  /// whether these bytes are an SVG document (by its start, not its name)
  public static func isSVG(_ data: Data) -> Bool {
    let head = String(decoding: data.prefix(512), as: UTF8.self).lowercased()
    return head.contains("<svg")
  }

  /// the document with what could run or load something removed
  public static func sanitized(_ data: Data, dark: Bool = false) -> Data {
    var s = resolved(String(decoding: data, as: UTF8.self), dark: dark)
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
  public static func image(_ data: Data, pixelWidth: Int, dark: Bool = false) -> CGImage? {
    guard let i = NSImage(data: sanitized(data, dark: dark)), i.size.width > 0, i.size.height > 0 else { return nil }
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

  /// The document's CSS as the renderer can take it, for a light or dark look: each @media (prefers-color-scheme: …)
  /// block kept bare when it matches and dropped when not, light-dark(a, b) as a or b, and var(--x) as the value the
  /// file declares last for --x (or its fallback)
  static func resolved(_ text: String, dark: Bool) -> String {
    var s = text
    // @media (prefers-color-scheme: …) { … }, its braces matched
    let media = try! NSRegularExpression(
      pattern: #"@media\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)\s*\{"#, options: .caseInsensitive)
    while let m = media.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) {
      let ns = s as NSString
      var depth = 1
      var i = NSMaxRange(m.range)
      while i < ns.length, depth > 0 {
        let c = ns.character(at: i)
        if c == 0x7B { depth += 1 } else if c == 0x7D { depth -= 1 }
        i += 1
      }
      let inner = ns.substring(
        with: NSRange(location: NSMaxRange(m.range), length: max(0, i - 1 - NSMaxRange(m.range))))
      let wants = ns.substring(with: m.range(at: 1)).lowercased() == "dark"
      s = ns.replacingCharacters(
        in: NSRange(location: m.range.location, length: i - m.range.location), with: wants == dark ? inner : "")
    }
    // light-dark(a, b): split at its top-level comma
    while let r = s.range(of: "light-dark(", options: .caseInsensitive) {
      var depth = 1
      var comma: String.Index?
      var j = r.upperBound
      while j < s.endIndex, depth > 0 {
        switch s[j] {
        case "(": depth += 1
        case ")": depth -= 1
        case "," where depth == 1 && comma == nil: comma = j
        default: break
        }
        if depth > 0 { j = s.index(after: j) }
      }
      guard j < s.endIndex, let c = comma else { break }
      let a = s[r.upperBound..<c].trimmingCharacters(in: .whitespaces)
      let b = s[s.index(after: c)..<j].trimmingCharacters(in: .whitespaces)
      s.replaceSubrange(r.lowerBound...j, with: dark ? b : a)
    }
    // custom properties: the last declaration of each wins; var() replaced, again for values made of var()
    var vars: [String: String] = [:]
    let decl = try! NSRegularExpression(pattern: #"(--[A-Za-z0-9_-]+)\s*:\s*([^;}]+)"#)
    for m in decl.matches(in: s, range: NSRange(location: 0, length: (s as NSString).length)) {
      let ns = s as NSString
      vars[ns.substring(with: m.range(at: 1))] = ns.substring(with: m.range(at: 2)).trimmingCharacters(in: .whitespaces)
    }
    let use = try! NSRegularExpression(
      pattern: #"var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)"#)
    for _ in 0..<4 {
      let ns = s as NSString
      let ms = use.matches(in: s, range: NSRange(location: 0, length: ns.length))
      guard !ms.isEmpty else { break }
      var out = ""
      var at = 0
      for m in ms {
        out += ns.substring(with: NSRange(location: at, length: m.range.location - at))
        let name = ns.substring(with: m.range(at: 1))
        let fallback = m.range(at: 2).location == NSNotFound ? "" : ns.substring(with: m.range(at: 2))
        out += vars[name] ?? fallback.trimmingCharacters(in: .whitespaces)
        at = NSMaxRange(m.range)
      }
      s = out + ns.substring(from: at)
    }
    return s
  }
}

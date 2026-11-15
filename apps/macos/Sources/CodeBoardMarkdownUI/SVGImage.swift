import AppKit

/// SVG pictures for a host's image path: ImageIO does not read SVG, the web board draws it (sanitised, md/images.ts).
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
    let clean = Data(cutMasks(String(decoding: sanitized(data, dark: dark), as: UTF8.self)).utf8)
    guard let i = NSImage(data: clean), i.size.width > 0, i.size.height > 0 else { return nil }
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

  /// Masks in the picture's own user space that reach far past it, cut to the picture (with a unit to spare): the
  /// system's renderer draws a mask's whole region before it applies it, whatever the size drawn, and drawing tools
  /// write masks thousands of units wide (six 3000-unit masks took 350 ms to draw, cut 50 ms). What shows is the same,
  /// as nothing outside the picture shows. Only a mask every user of which is in the root's user space (no transform
  /// on it or above it, no nested viewport, none by CSS) is cut; any other is left as it is
  static func cutMasks(_ s: String) -> String {
    guard s.contains("<mask"), let doc = try? XMLDocument(xmlString: s, options: []),
      let root = doc.rootElement(), let box = viewBox(root)
    else { return s }
    func value(_ e: XMLElement, _ name: String) -> String? { e.attribute(forName: name)?.stringValue }
    func number(_ e: XMLElement, _ name: String) -> CGFloat? { value(e, name).flatMap(Double.init).map { CGFloat($0) } }
    // CSS that could move what uses a mask: then no mask is cut
    let styles = ((try? root.nodes(forXPath: "//*[local-name()='style']")) ?? []).compactMap(\.stringValue)
    guard !styles.contains(where: { $0.contains("transform") }) else { return s }
    func inRootSpace(_ e: XMLElement) -> Bool {
      var n: XMLElement? = e
      while let x = n, x !== root {
        let style = value(x, "style") ?? ""
        guard value(x, "transform") == nil, !style.contains("transform"), x === e || ["g", "a"].contains(x.localName)
        else { return false }
        n = x.parent as? XMLElement
      }
      return n === root
    }
    // each mask's users, by the address they name it with, and how often the text names each (a mask named also where
    // the tree does not show it, as in CSS, is left alone)
    var users: [String: [XMLElement]] = [:]
    for case let e as XMLElement in (try? root.nodes(forXPath: "//*[@mask]")) ?? [] {
      users[value(e, "mask") ?? "", default: []].append(e)
    }
    let all = NSRange(location: 0, length: (s as NSString).length)
    var named: [String: Int] = [:]
    for m in Self.address.matches(in: s, range: all) {
      named[(s as NSString).substring(with: m.range), default: 0] += 1
    }
    var cuts: [String: CGRect] = [:]
    for case let m as XMLElement in (try? root.nodes(forXPath: "//*[local-name()='mask']")) ?? [] {
      guard value(m, "maskUnits") == "userSpaceOnUse", let id = value(m, "id"),
        let x = number(m, "x"), let y = number(m, "y"), let w = number(m, "width"), let h = number(m, "height")
      else { continue }
      let region = CGRect(x: x, y: y, width: w, height: h)
      let cut = region.intersection(box.insetBy(dx: -1, dy: -1))
      let by = users["url(#\(id))"] ?? []
      guard !cut.isNull, cut.width < region.width || cut.height < region.height, !by.isEmpty,
        named["url(#\(id))"] == by.count, by.allSatisfy(inRootSpace)
      else { continue }
      cuts[id] = cut
    }
    guard !cuts.isEmpty else { return s }
    // those masks' own tags, their regions' four numbers replaced
    let out = NSMutableString(string: s)
    for t in Self.maskTag.matches(in: s, range: all).reversed() {
      var text = out.substring(with: t.range)
      let tr = NSRange(location: 0, length: (text as NSString).length)
      guard let i = Self.idAttribute.firstMatch(in: text, range: tr),
        let cut = cuts[(text as NSString).substring(with: i.range(at: 2))]
      else { continue }
      for (a, v) in zip(Self.regionAttributes, [cut.minX, cut.minY, cut.width, cut.height]) {
        text = a.stringByReplacingMatches(
          in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "$1$2\(v)$2")
      }
      out.replaceCharacters(in: t.range, with: text)
    }
    return out as String
  }

  private static let address = try! NSRegularExpression(pattern: #"url\(#[^)]*\)"#)
  private static let maskTag = try! NSRegularExpression(pattern: #"<mask\b[^>]*>"#)
  private static let idAttribute = try! NSRegularExpression(pattern: #"\sid\s*=\s*(["'])([^"']*)\1"#)
  private static let regionAttributes = ["x", "y", "width", "height"].map {
    try! NSRegularExpression(pattern: #"(\s"# + $0 + #"\s*=\s*)(["'])[^"']*\2"#)
  }

  /// The root's user-space box: its viewBox, else its width and height in plain numbers
  private static func viewBox(_ root: XMLElement) -> CGRect? {
    if let v = root.attribute(forName: "viewBox")?.stringValue {
      let n = v.split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
      return n.count == 4 && n[2] > 0 && n[3] > 0 ? CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil
    }
    guard let w = root.attribute(forName: "width")?.stringValue.flatMap(Double.init),
      let h = root.attribute(forName: "height")?.stringValue.flatMap(Double.init), w > 0, h > 0
    else { return nil }
    return CGRect(x: 0, y: 0, width: w, height: h)
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
    // (looked for in the lowercased text first: a case-insensitive search of a long Swift string takes ms when it finds
    // nothing)
    while s.lowercased().contains("light-dark("), let r = s.range(of: "light-dark(", options: .caseInsensitive) {
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
    // one NSString for all the matches: a Swift string bridged anew finds each UTF-16 offset from its start
    let text = NSString(string: s)
    for m in decl.matches(in: s, range: NSRange(location: 0, length: text.length)) {
      let ns = text
      vars[ns.substring(with: m.range(at: 1))] = ns.substring(with: m.range(at: 2)).trimmingCharacters(in: .whitespaces)
    }
    let use = try! NSRegularExpression(
      pattern: #"var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)"#)
    for _ in 0..<4 {
      let ns = NSString(string: s)
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

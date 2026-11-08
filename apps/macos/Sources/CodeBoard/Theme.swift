// The board's looks as colours that follow the window's appearance, and the fonts the cards are set in. The colours are the
// stylesheets' tokens (packages/board/src/styles.css, themes.css), written to themes.json at build time (themes.mjs): every look,
// light and dark, `#rrggbbaa`; nothing here is copied by hand. The app draws Warm Ink, the board's default look.
import AppKit

enum Theme {
  /** The appearance the layers draw in (the canvas sets it: dynamic colours resolve against it off the view hierarchy) */
  static var appearance: NSAppearance = NSAppearance(named: .aqua)!
  static var look = "warm-ink"
  /** look → "light" / "dark" → token → "#rrggbbaa" or a number */
  private static var tokens: [String: [String: [String: Any]]] = [:]
  static func load(_ file: URL) {
    resources = file.deletingLastPathComponent()
    guard let d = try? Data(contentsOf: file), let t = try? JSONSerialization.jsonObject(with: d) as? [String: [String: [String: Any]]] else {
      logLine("[codeboard] no themes.json at %@: the board draws in placeholder colours", file.path)
      return
    }
    tokens = t
  }
  /** Where the app's resources are (themes.json, the fonts, the seal masks, the scenes): set with load */
  private static var resources: URL?
  static func resource(_ name: String) -> URL? { resources?.appendingPathComponent(name) }
  private static var images: [String: CGImage] = [:]
  static func image(_ name: String) -> CGImage? {
    if let i = images[name] { return i }
    guard let u = resource(name), let src = CGImageSourceCreateWithURL(u as CFURL, nil), let i = CGImageSourceCreateImageAtIndex(src, 0, nil) else { return nil }
    images[name] = i
    return i
  }
  /** The board's fonts (build.mjs: the stylesheets' woff2 as TTF in fonts/), registered for this process */
  static func registerFonts() {
    guard let dir = resource("fonts"), let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return }
    let urls = files.filter { $0.pathExtension == "ttf" }
    if urls.isEmpty { return }
    CTFontManagerRegisterFontURLs(urls as CFArray, .process, true) { _, _ in true }
  }
  /** The board's icons (icons.json, from ui/icons.tsx): stroked and filled path data on a 16 grid */
  private static var iconTable: [String: [String: String]] = [:]
  struct Icon {
    var stroke: CGPath?
    var fill: CGPath?
  }
  private static var iconCache: [String: Icon] = [:]
  static func icon(_ name: String) -> Icon? {
    if let i = iconCache[name] { return i }
    if iconTable.isEmpty, let u = resource("icons.json"), let d = try? Data(contentsOf: u), let t = try? JSONSerialization.jsonObject(with: d) as? [String: [String: String]] { iconTable = t }
    guard let e = iconTable[name] else { return nil }
    let i = Icon(stroke: e["stroke"].map(SVGPath.parse), fill: e["fill"].map(SVGPath.parse))
    iconCache[name] = i
    return i
  }
  /** An icon drawn at a point, 16 px, in a colour (styles.css .ico: stroke --ico-w, the strokes shifted by ico-w × 0.5 − 1) */
  static func drawIcon(_ name: String, at p: CGPoint, color: NSColor, size: CGFloat = 16) {
    guard let i = icon(name), let cg = NSGraphicsContext.current?.cgContext else { return }
    let w = number("ico-w", 1)
    cg.saveGState()
    cg.translateBy(x: p.x, y: p.y)
    cg.scaleBy(x: size / 16, y: size / 16)
    if let s = i.stroke {
      cg.saveGState()
      cg.translateBy(x: w * 0.5 - 1, y: w * 0.5 - 1)
      cg.addPath(s)
      cg.setLineWidth(w)
      cg.setLineCap(.round)
      cg.setLineJoin(.round)
      cg.setStrokeColor(color.cgColor)
      cg.strokePath()
      cg.restoreGState()
    }
    if let f = i.fill {
      cg.addPath(f)
      cg.setFillColor(color.cgColor)
      cg.fillPath()
    }
    cg.restoreGState()
  }
  static var isInk: Bool { look == "ink-wash" }
  static var isDark: Bool { appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua }
  private static func token(_ name: String, dark: Bool) -> Any? { tokens[look]?[dark ? "dark" : "light"]?[name] }
  static func parse(_ v: Any?) -> NSColor? {
    guard let s = v as? String, s.hasPrefix("#"), s.count == 9, let n = UInt32(s.dropFirst(), radix: 16) else { return nil }
    return NSColor(
      srgbRed: CGFloat((n >> 24) & 0xff) / 255, green: CGFloat((n >> 16) & 0xff) / 255, blue: CGFloat((n >> 8) & 0xff) / 255,
      alpha: CGFloat(n & 0xff) / 255)
  }
  /** A colour token, resolved for the appearance it is drawn in; an unknown token is loud (magenta), not quietly wrong */
  static func c(_ name: String, or fallback: String? = nil) -> NSColor {
    NSColor(name: nil) { ap in
      let dark = ap.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      return parse(token(name, dark: dark)) ?? fallback.flatMap { parse(token($0, dark: dark)) } ?? .magenta
    }
  }
  /** A token of one look (the window chrome's, which names its board theme), mixed `t` of the way to another token, at an
   *  alpha (light, dark) */
  static func c(_ name: String, look: String, mix: (String, CGFloat)? = nil, alpha: (CGFloat, CGFloat) = (1, 1)) -> NSColor {
    NSColor(name: nil) { ap in
      let dark = ap.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      func at(_ n: String) -> NSColor? { parse(tokens[look]?[dark ? "dark" : "light"]?[n]) }
      guard var col = at(name) else { return .magenta }
      if let (other, t) = mix, let o = at(other) { col = col.blended(withFraction: t, of: o) ?? col }
      return col.withAlphaComponent(col.alphaComponent * (dark ? alpha.1 : alpha.0))
    }
  }
  /** A token kept as text (a keyword the stylesheet sets, such as --com-i: normal); nil when unset or not text */
  static func string(_ name: String) -> String? { token(name, dark: isDark) as? String }
  static func number(_ name: String, _ fallback: CGFloat) -> CGFloat { (token(name, dark: false) as? Double).map { CGFloat($0) } ?? fallback }

  /** One shadow of a CSS box-shadow list (themes.mjs shadows) */
  struct Shadow: Decodable {
    var x, y, blur, spread: CGFloat
    var color: String
    var inset: Bool
  }
  /** A CSS linear-gradient (themes.mjs gradient): the angle in degrees and its stops (colour, 0–1) */
  struct Gradient: Decodable {
    struct Stop: Decodable {
      var color: String
      var at: CGFloat
    }
    var angle: CGFloat
    var stops: [Stop]
  }
  private static func structured<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
    guard let v = token(name, dark: isDark), let d = try? JSONSerialization.data(withJSONObject: v) else { return nil }
    return try? JSONDecoder().decode(type, from: d)
  }
  /** A shadow list token, for the appearance the canvas draws in (empty when the token is not a shadow list) */
  static func shadows(_ name: String) -> [Shadow] { structured([Shadow].self, name) ?? [] }
  static func gradient(_ name: String) -> Gradient? { structured(Gradient.self, name) }

  static let bg = c("bg")
  static let surface = c("surface")
  static let head = c("head")
  static let ink = c("ink")
  static let ink2 = c("ink-2")
  static let ink3 = c("ink-3")
  static let line = c("line")
  static let hair = c("hair")
  static let accent = c("accent")
  static let edge = c("edge")
  static let sectFill = c("sect-fill")
  static let noteCode = c("nc-bg", or: "hlrow")  // var(--nc-bg, var(--hlrow)): looks other than Warm Ink leave --nc-* unset
  static let sticky = c("sticky")
  static let stickyInk = c("sticky-ink")
  static let selection = accent
  /** Ink Wash's vermilion (seals, selection); other looks: the accent */
  static let zhu = c("zhu", or: "accent")
  static let paper = c("paper", or: "surface")
  /** A Highlight's band (styles.css .hx-band --band) */
  static let band = c("band")
  /** The row an arrow starts from (.rowbg.origin --row) and its number (.no.link --no-link, the accent unless the look says) */
  static let row = c("row")
  static let noLink = c("no-link", or: "accent")

  /** Token colour classes (core tokenClass; the host's "dec" is drawn like a number, styles.css .dec) */
  static let tok: [String: NSColor] = [
    "kw": c("k-kw"), "fn": c("k-fn"), "str": c("k-str"), "com": c("k-com"), "num": c("k-num"), "self": c("k-self"),
    "p": c("k-p"), "dec": c("k-num"),
  ]
  /** Section colours (--s-*), Box fills (--bf-*), Mark colours (--hd-*) and arrow colours (--lk-*) */
  static let sect: [String: NSColor] = ["sand": c("s-sand"), "blue": c("s-blue"), "green": c("s-green"), "pink": c("s-pink")]
  static let box: [String: NSColor] = [
    "yellow": c("bf-yellow"), "paper": c("bf-paper"), "blue": c("bf-blue"), "green": c("bf-green"), "pink": c("bf-pink"),
  ]
  static let hand: [String: NSColor] = ["blue": c("hd-blue"), "purple": c("hd-purple"), "orange": c("hd-orange"), "green": c("hd-green")]
  static let link: [String: NSColor] = ["orange": c("lk-orange"), "blue": c("lk-blue"), "green": c("lk-green")]

  static var cardRadius: CGFloat { number("r-card", 12.5) }
  static let headHeight: CGFloat = 36
  static let codeRow: CGFloat = 20

  private static var fontCache: [String: NSFont] = [:]
  private static let fontLock = NSLock()
  /** A registered family at a weight (its named instance), with a cascade for the characters it lacks */
  static func family(_ name: String, _ size: CGFloat, weight: NSFont.Weight = .regular, italic: Bool = false, cascade: [String] = []) -> NSFont? {
    let key = "\(name)|\(size)|\(weight.rawValue)|\(italic)"
    fontLock.lock()
    defer { fontLock.unlock() }
    if let f = fontCache[key] { return f }
    var traits: [NSFontDescriptor.TraitKey: Any] = [.weight: weight.rawValue]
    if italic { traits[.symbolic] = NSFontDescriptor.SymbolicTraits.italic.rawValue }
    var attrs: [NSFontDescriptor.AttributeName: Any] = [.family: name, .traits: traits]
    if !cascade.isEmpty { attrs[.cascadeList] = cascade.map { NSFontDescriptor(fontAttributes: [.family: $0]) } }
    guard let f = NSFont(descriptor: NSFontDescriptor(fontAttributes: attrs), size: size), f.familyName == name else { return nil }
    fontCache[key] = f
    return f
  }
  /** --mono: JetBrains Mono */
  static func mono(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
    family("JetBrains Mono", size, weight: weight) ?? NSFont.monospacedSystemFont(ofSize: size, weight: weight)
  }
  /** --sys in Warm Ink: the system font */
  /** --sys: the system font; Ink Wash's is the serif (themes.css :root.look-ink-wash --sys) */
  static func sys(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
    isInk ? serif(size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
  }
  /** --serif: Source Serif 4, Songti SC for Chinese (styles.css --serif) */
  static func serif(_ size: CGFloat, weight: NSFont.Weight = .regular, italic: Bool = false) -> NSFont {
    family("Source Serif 4", size, weight: weight, italic: italic, cascade: ["Songti SC"]) ?? sys(size, weight: weight)
  }
  /** --hand: Shantell Sans, Yozai for Chinese (styles.css --hand) */
  static func handwriting(_ size: CGFloat, bold: Bool = false) -> NSFont {
    family("Shantell Sans Light", size, weight: bold ? .bold : .regular, cascade: ["Yozai", "Kaiti SC"]) ?? sys(size, weight: bold ? .bold : .regular)
  }
  /** Ink Wash's Section titles: Zhi Mang Xing, the serif after it (themes.css .slabel) */
  static func brushHand(_ size: CGFloat) -> NSFont {
    family("Zhi Mang Xing", size, cascade: ["Xingkai SC", "Source Serif 4", "Songti SC"]) ?? serif(size)
  }
}

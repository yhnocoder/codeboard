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
    guard let d = try? Data(contentsOf: file), let t = try? JSONSerialization.jsonObject(with: d) as? [String: [String: [String: Any]]] else {
      logLine("[codeboard] no themes.json at %@: the board draws in placeholder colours", file.path)
      return
    }
    tokens = t
  }
  private static func token(_ name: String, dark: Bool) -> Any? { tokens[look]?[dark ? "dark" : "light"]?[name] }
  private static func parse(_ v: Any?) -> NSColor? {
    guard let s = v as? String, s.hasPrefix("#"), s.count == 9, let n = UInt32(s.dropFirst(), radix: 16) else { return nil }
    return NSColor(
      srgbRed: CGFloat((n >> 24) & 0xff) / 255, green: CGFloat((n >> 16) & 0xff) / 255, blue: CGFloat((n >> 8) & 0xff) / 255,
      alpha: CGFloat(n & 0xff) / 255)
  }
  /** A colour token, resolved for the appearance it is drawn in; an unknown token is loud (magenta), not quietly wrong */
  static func c(_ name: String) -> NSColor {
    NSColor(name: nil) { ap in parse(token(name, dark: ap.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua)) ?? .magenta }
  }
  static func number(_ name: String, _ fallback: CGFloat) -> CGFloat { (token(name, dark: false) as? Double).map { CGFloat($0) } ?? fallback }

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
  static let noteCode = c("nc-bg")
  static let sticky = c("sticky")
  static let stickyInk = c("sticky-ink")
  static let selection = accent

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

  static func mono(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
    NSFont(name: weight == .regular ? "JetBrainsMono-Regular" : "JetBrainsMono-Medium", size: size)
      ?? NSFont(name: "JetBrains Mono", size: size) ?? NSFont.monospacedSystemFont(ofSize: size, weight: weight)
  }
  static func sys(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
    NSFont.systemFont(ofSize: size, weight: weight)
  }
  static func serif(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
    let d = NSFont.systemFont(ofSize: size, weight: weight).fontDescriptor.withDesign(.serif)
    return d.flatMap { NSFont(descriptor: $0, size: size) } ?? sys(size, weight: weight)
  }
  static func handwriting(_ size: CGFloat, bold: Bool = false) -> NSFont {
    NSFont(name: bold ? "Noteworthy-Bold" : "Noteworthy-Light", size: size) ?? sys(size, weight: bold ? .bold : .regular)
  }
}

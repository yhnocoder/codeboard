// Warm Ink, the board's default look (packages/board/src/styles.css :root and :root[data-theme="dark"]), as colours that follow
// the window's appearance, and the fonts the cards are set in.
import AppKit

enum Theme {
  /** The appearance the layers draw in (the canvas sets it: dynamic colours resolve against it off the view hierarchy) */
  static var appearance: NSAppearance = NSAppearance(named: .aqua)!
  static func hex(_ light: UInt32, _ dark: UInt32, alpha: (CGFloat, CGFloat) = (1, 1)) -> NSColor {
    NSColor(name: nil) { ap in
      let dk = ap.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      let v = dk ? dark : light
      let a = dk ? alpha.1 : alpha.0
      return NSColor(
        srgbRed: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255, blue: CGFloat(v & 0xff) / 255,
        alpha: a)
    }
  }
  static let bg = hex(0xeeece6, 0x191816)
  static let surface = hex(0xfdfcfa, 0x252422)
  static let head = hex(0xf8f6f1, 0x2a2926)
  static let ink = hex(0x211f1b, 0xece8e0)
  static let ink2 = hex(0x625e56, 0xaca79d)
  static let ink3 = hex(0x9a958b, 0x78746c)
  static let line = hex(0x3c2d14, 0xfff0dc, alpha: (0.09, 0.07))
  static let hair = hex(0x3c2d14, 0xfff0dc, alpha: (0.16, 0.11))
  static let accent = hex(0xb5552d, 0xe3895f)
  static let edge = hex(0x9a958b, 0x78746c)
  static let sectFill = hex(0x211f1b, 0xece8e0, alpha: (0.022, 0.025))
  static let shadow = hex(0x32230a, 0x000000, alpha: (0.16, 0.5))
  static let noteCode = hex(0xf5f3ef, 0x2b2a27)
  static let sticky = hex(0xfbefb6, 0x4a4127)
  static let stickyInk = hex(0x4a3c12, 0xf1e6c2)
  static let selection = accent

  /** Token colour classes (core tokenClass) */
  static let tok: [String: NSColor] = [
    "kw": hex(0x9a3f22, 0xe59572), "fn": hex(0x2e5d86, 0x86b4de), "str": hex(0x4a7536, 0xa3c98c),
    "com": hex(0x9a958a, 0x7d786e), "num": hex(0x8a6416, 0xd9b36a), "self": hex(0x7a4f9a, 0xc8a3e6),
    "p": hex(0x6f6a62, 0xa39e93), "dec": hex(0x8a6416, 0xd9b36a),
  ]
  /** Section colours (styles.css --s-*) and Box fills */
  static let sect: [String: NSColor] = [
    "sand": hex(0xceaa6e, 0xd6b478, alpha: (0.16, 0.1)), "blue": hex(0x6091cd, 0x78a5e1, alpha: (0.12, 0.09)),
    "green": hex(0x6ea55f, 0x8cc378, alpha: (0.13, 0.09)), "pink": hex(0xd77891, 0xe68ca5, alpha: (0.12, 0.09)),
  ]
  static let box: [String: NSColor] = [
    "yellow": hex(0xfbefb6, 0x4a4127), "paper": hex(0xfdfcfa, 0x252422), "blue": hex(0xdfe9f6, 0x2a3442),
    "green": hex(0xe3efdc, 0x2d3a2a), "pink": hex(0xf8e2e8, 0x44303a),
  ]
  static let hand: [String: NSColor] = [
    "blue": hex(0x3a72aa, 0x7fb0e0), "purple": hex(0x7d55b0, 0xb89be6), "orange": hex(0xc46a2a, 0xe3955a),
    "green": hex(0x4c8a3a, 0x96c47e),
  ]
  static let link: [String: NSColor] = ["orange": hand["orange"]!, "blue": hand["blue"]!, "green": hand["green"]!]

  static let cardRadius: CGFloat = 12.5
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

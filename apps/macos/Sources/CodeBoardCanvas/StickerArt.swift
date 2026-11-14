import AppKit
import CodeBoardModel
import CoreText

// What a sticker looks like (the web board's stickers/glyphs.tsx Glyph, styles.css .glyph, themes.css per look): a
// built-in glyph is a coloured disc with a white Lucide mark on it, the TODO tag a coloured pill with the word, an emoji
// as the system draws it. Built as vector layers in the glyph's 24-unit box, scaled by the layer's sublayer transform,
// so a size change or a zoom never redraws a path.

enum StickerArt {
  /// glyphs.tsx BUILTIN: a stroked mark (`d`) or a filled one (`fill`)
  static func marks(_ b: BuiltinSticker) -> (stroke: String?, fill: String?) {
    switch b {
    case .star:
      (
        nil,
        "M11.762 7.148a.265 .265 0 0 1 .475 0l1.155 2.339a1.061 1.061 0 0 0 .797 .58l2.583 .378a.265 .265 0 0 1 .147 .452l-1.868 1.819a1.061 1.061 0 0 0-.305 .939l.441 2.57a.265 .265 0 0 1-.385 .28l-2.309-1.214a1.061 1.061 0 0 0-.986 0L9.198 16.505a.265 .265 0 0 1-.385-.28l.44-2.569a1.061 1.061 0 0 0-.305-.94L7.08 10.898a.265 .265 0 0 1 .147-.453l2.582-.377a1.061 1.061 0 0 0 .799-.58z"
      )
    case .exclaim: ("M12 7.875v5.625M12 16.5h.008", nil)
    case .check: ("M16.125 9.375 10.5 15 7.875 12.375", nil)
    case .flag:
      (
        "M8 17V8a.5 .5 0 0 1 .2-.4A3 3 0 0 1 10 7c1.5 0 2.5 1 3.667 1q1 0 1.534-.4A.5 .5 0 0 1 16 8v5a.5 .5 0 0 1-.2 .4A3 3 0 0 1 14 14c-1.5 0-2.5-1-4-1a3 3 0 0 0-2 .764",
        nil
      )
    case .zap: (nil, "M12.5 7 7.5 13h4.5l-.5 4 5-6h-4.5l.5-4z")
    case .bug:
      (
        "M12 16v-4.5M13 9.5a2 2 0 0 1 2 2v1.5a3 3 0 0 1-6 0v-1.5a2 2 0 0 1 2-2zM13.06 7.94 14 7M16.5 16.5a2 2 0 0 0-1.905-2M16.5 8.5a2 2 0 0 1-1.775 1.985M17 12.5h-2M7.5 16.5a2 2 0 0 1 1.905-2M7.5 8.5a2 2 0 0 0 1.775 1.985M9 12.5H7m3-5.5 .94 .94M10.5 9.565V9a1.5 1.5 0 1 1 3 0v.565",
        nil
      )
    case .todo:
      (
        "M9 8.25H15A.75 .75 0 0 1 15.75 9V15A.75 .75 0 0 1 15 15.75H9A.75 .75 0 0 1 8.25 15V9A.75 .75 0 0 1 9 8.25z",
        nil
      )
    case .heart:
      (
        nil,
        "M7 10.75a2.75 2.75 0 0 1 4.796-1.838 .28 .28 0 0 0 .409 0A2.745 2.745 0 0 1 17 10.75c0 1.145-.75 2-1.5 2.75l-2.746 2.657a1 1 0 0 1-1.5 .01L8.5 13.5c-.75-.75-1.5-1.6-1.5-2.75"
      )
    case .hourglass:
      (
        "M8.5 17h7M8.5 7h7M14.5 17v-2.086a1 1 0 0 0-.293-.707L12 12l-2.207 2.207A1 1 0 0 0 9.5 14.914V17M9.5 7v2.086a1 1 0 0 0 .293 .707L12 12l2.207-2.207A1 1 0 0 0 14.5 9.086V7",
        nil
      )
    case .warning:
      ("m16.865 15-4-7a1 1 0 0 0-1.74 0l-4 7A1 1 0 0 0 8 16.5h8a1 1 0 0 0 .865-1.5M12 10.5v2M12 14.5h.005", nil)
    case .todoText: (nil, nil)
    }
  }

  /// The built-ins the palette offers, in its order (PICKED_BUILTIN: not the ?)
  static let picked: [BuiltinSticker] = [
    .star, .exclaim, .check, .flag, .zap, .bug, .todo, .heart, .hourglass, .warning, .todoText,
  ]

  /// Parsed once
  nonisolated(unsafe) private static let paths: [BuiltinSticker: (stroke: CGPath?, fill: CGPath?)] = Dictionary(
    uniqueKeysWithValues: BuiltinSticker.allCases.map { b in
      let m = marks(b)
      return (b, (m.stroke.map(SVGPath.parse), m.fill.map(SVGPath.parse)))
    })

  /// The outline a glyph has in its box: a disc, a pill, or (an emoji) a rounded square
  enum Shape: Equatable {
    case disc
    case pill
    case square
  }

  static func shape(_ g: Sticker.Glyph) -> Shape {
    switch g {
    case .builtin(.todoText): .pill
    case .builtin: .disc
    case .emoji: .square
    }
  }

  // MARK: The TODO tag

  /// `.glyph.tag`: the word at half the height, bold, 0.04 em apart, 0.55 em in on each side, in 24 units
  nonisolated(unsafe) private static let tag: (path: CGPath, width: CGFloat) = {
    let font = NSFont.systemFont(ofSize: 12, weight: .bold) as CTFont
    let chars = Array("TODO".utf16)
    var glyphs = [CGGlyph](repeating: 0, count: chars.count)
    CTFontGetGlyphsForCharacters(font, chars, &glyphs, chars.count)
    var advances = [CGSize](repeating: .zero, count: glyphs.count)
    CTFontGetAdvancesForGlyphs(font, .horizontal, glyphs, &advances, glyphs.count)
    let pad = 0.55 * 12
    let track = 0.04 * 12
    let p = CGMutablePath()
    var x = pad
    // the line box centred: the baseline at the middle plus half the cap height
    let baseline = 12 + CTFontGetCapHeight(font) / 2
    for (g, a) in zip(glyphs, advances) {
      if let gp = CTFontCreatePathForGlyph(font, g, nil) {
        // glyph paths are y-up; the box is y-down
        p.addPath(gp, transform: CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: x, ty: baseline))
      }
      x += a.width + track
    }
    // the last letter's tracking is not room
    return (p, x - track + pad)
  }()

  /// A glyph's width in its 24-unit box (its height is 24)
  static func unitWidth(_ g: Sticker.Glyph) -> CGFloat {
    if case .builtin(.todoText) = g { tag.width } else { 24 }
  }

  /// Its size on the board at a height of `size`
  static func boxSize(_ g: Sticker.Glyph, size: CGFloat) -> CGSize {
    CGSize(width: unitWidth(g) * size / 24, height: size)
  }

  // MARK: Colours

  /// `#RRGGBB`
  static func color(_ hex: String) -> CGColor {
    let v = UInt32(hex.dropFirst(), radix: 16) ?? 0
    return CGColor(
      srgbRed: CGFloat(v >> 16 & 0xff) / 255, green: CGFloat(v >> 8 & 0xff) / 255, blue: CGFloat(v & 0xff) / 255,
      alpha: 1)
  }

  /// The disc's and the mark's colours in a look (styles.css .glyph --stk-bg / --stk-fg, themes.css): Warm Ink the
  /// colour warmed (86 % of it with a brown, in Oklab) under a warm white; Ink Wash 30 % of it in the ink, under the
  /// paper (pale discs with a dark mark in dark)
  static func colors(_ hex: String, _ t: Theme) -> (bg: CGColor, fg: CGColor) {
    let c = color(hex)
    if t.id == .inkWash {
      return (mixOklab(c, t.ink, 0.30), t.dark ? color("#1C1B19") : color("#FDFDFB"))
    }
    return (mixOklab(c, color("#5B3D22"), 0.86), color("#FFFAF1"))
  }

  /// color-mix(in oklab, a k, b)
  static func mixOklab(_ a: CGColor, _ b: CGColor, _ k: CGFloat) -> CGColor {
    func rgb(_ c: CGColor) -> [CGFloat] {
      c.converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components
        ?? [0, 0, 0, 1]
    }
    func lin(_ v: CGFloat) -> CGFloat { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
    func gam(_ v: CGFloat) -> CGFloat { v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1 / 2.4) - 0.055 }
    func lab(_ c: [CGFloat]) -> [CGFloat] {
      let r = lin(c[0])
      let g = lin(c[1])
      let b = lin(c[2])
      let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
      let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
      let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
      return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
      ]
    }
    let x = lab(rgb(a))
    let y = lab(rgb(b))
    let o = (0..<3).map { x[$0] * k + y[$0] * (1 - k) }
    let l = pow(o[0] + 0.3963377774 * o[1] + 0.2158037573 * o[2], 3)
    let m = pow(o[0] - 0.1055613458 * o[1] - 0.0638541728 * o[2], 3)
    let s = pow(o[0] - 0.0894841775 * o[1] - 1.2914855480 * o[2], 3)
    let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    let bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return CGColor(
      srgbRed: min(1, max(0, gam(r))), green: min(1, max(0, gam(g))), blue: min(1, max(0, gam(bl))), alpha: 1)
  }

  // MARK: Layers

  /// A glyph as a layer of `size` (its frame's origin at zero): its parts in 24 units under a sublayer transform. An
  /// emoji's text is drawn at `pixels` per unit of the board (the zoom at rest times the screen's scale)
  static func layer(_ g: Sticker.Glyph, color hex: String?, size: CGFloat, theme t: Theme, pixels: CGFloat) -> CALayer {
    let l = CALayer()
    l.anchorPoint = .zero
    fill(l, g, color: hex, theme: t, pixels: pixels * size / 24)
    resize(l, g, size: size)
    return l
  }

  /// The soft shadow under one on the board or a card (.stk.canvas .glyph: drop-shadow(0 1px 2px)): a built-in's
  /// follows its outline; an emoji's its own shape, drawn once with the text (rasterized, so moving it draws nothing)
  static func shadow(_ l: CALayer, _ g: Sticker.Glyph, size: CGFloat, pixels: CGFloat) {
    var target = l
    var k: CGFloat = 1
    if case .emoji = g, let text = l.sublayers?.first {
      // in the text's own 24 units
      target = text
      k = size / 24
      text.shouldRasterize = true
      text.rasterizationScale = max(1, pixels * k)
    } else {
      l.shadowPath = outline(g, size: size, out: 0)
    }
    target.shadowColor = CGColor(gray: 0, alpha: 1)
    target.shadowOpacity = 0.18
    target.shadowRadius = 1 / k
    target.shadowOffset = CGSize(width: 0, height: 1 / k)
  }

  /// Another size for a glyph's layer: its transform alone changes
  static func resize(_ l: CALayer, _ g: Sticker.Glyph, size: CGFloat) {
    let k = size / 24
    l.bounds = CGRect(origin: .zero, size: boxSize(g, size: size))
    l.sublayerTransform = CATransform3DMakeScale(k, k, 1)
  }

  /// Its parts (in 24 units), the old ones gone
  static func fill(_ l: CALayer, _ g: Sticker.Glyph, color hex: String?, theme t: Theme, pixels: CGFloat) {
    l.sublayers = nil
    switch g {
    case .emoji(let e):
      let text = CATextLayer()
      text.anchorPoint = .zero
      text.string = e
      text.font = NSFont.systemFont(ofSize: 24 * 0.86)
      text.fontSize = 24 * 0.86
      text.alignmentMode = .center
      // the line box centred in the 24-unit square
      let lineH = NSFont.systemFont(ofSize: 24 * 0.86).ascender - NSFont.systemFont(ofSize: 24 * 0.86).descender
      text.frame = CGRect(x: -6, y: (24 - lineH) / 2, width: 36, height: lineH)
      text.contentsScale = max(1, pixels)
      l.addSublayer(text)
    case .builtin(let b):
      let (bg, fg) = colors(hex ?? b.color, t)
      if b == .todoText {
        let pill = CAShapeLayer()
        pill.path = CGPath(
          roundedRect: CGRect(x: 0, y: 0, width: tag.width, height: 24), cornerWidth: 12, cornerHeight: 12,
          transform: nil)
        pill.fillColor = bg
        let word = CAShapeLayer()
        word.path = tag.path
        word.fillColor = fg
        l.addSublayer(pill)
        l.addSublayer(word)
        return
      }
      let disc = CAShapeLayer()
      disc.path = CGPath(ellipseIn: CGRect(x: 1, y: 1, width: 22, height: 22), transform: nil)
      disc.fillColor = bg
      l.addSublayer(disc)
      let p = paths[b]
      if let s = p?.stroke {
        let m = CAShapeLayer()
        m.path = s
        m.fillColor = nil
        m.strokeColor = fg
        m.lineWidth = 2
        m.lineCap = .round
        m.lineJoin = .round
        l.addSublayer(m)
      }
      if let f = p?.fill {
        let m = CAShapeLayer()
        m.path = f
        m.fillColor = fg
        m.strokeColor = fg
        m.lineWidth = 1
        m.lineJoin = .round
        l.addSublayer(m)
      }
    }
  }

  /// Its outline in its own box of `size` grown by `out` (the selection ring, the hover ring, the shadow)
  static func outline(_ g: Sticker.Glyph, size: CGFloat, out: CGFloat) -> CGPath {
    let b = CGRect(origin: .zero, size: boxSize(g, size: size))
    switch shape(g) {
    case .disc:
      let r = 11 * size / 24 + out
      return CGPath(ellipseIn: CGRect(x: b.midX - r, y: b.midY - r, width: 2 * r, height: 2 * r), transform: nil)
    case .pill:
      let r = b.insetBy(dx: -out, dy: -out)
      return CGPath(roundedRect: r, cornerWidth: r.height / 2, cornerHeight: r.height / 2, transform: nil)
    case .square:
      let r = b.insetBy(dx: -out, dy: -out)
      let c = min(8.5 * size / 24 + out, r.height / 2)
      return CGPath(roundedRect: r, cornerWidth: c, cornerHeight: c, transform: nil)
    }
  }
}

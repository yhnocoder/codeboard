import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax

/// A complete description of how the board looks, which the drawing code only reads: colours, fonts, sizes, and the few
/// ways of drawing that are not values (`Paper`, `Header`, `Line`…), each a small closed set the drawing code switches on.
/// A new look is a new instance, and at most a new case where it draws something no look drew before. Values from the web
/// board's themes (packages/board/src/styles.css for Warm Ink, themes.css for the others), each in a light and a dark
/// variant as the web board's html[data-theme] picks them.
public struct Theme: Sendable {
  /// The look's stable name: the web board's theme id, kept in settings, cache keys and the Note page
  public enum ID: String, CaseIterable, Sendable {
    case warmInk = "warm-ink"
    case inkWash = "ink-wash"
  }

  /// A framed card's paper
  enum Paper: Sendable {
    /// A squircle of `surface`, with a crisp edge over its content: a hairline, a light line inside the top and a warm one
    /// inside the bottom
    case sheet
    /// Torn rice paper reaching `Deckle.margin` past the card, its edge pattern picked by the card's id; no edge
    case deckle
  }

  /// A framed card's title bar
  enum Header: Sendable {
    /// The `head` colour; a Note keeps a rule under it, a code card has none
    case band
    /// Pale ink fading out towards the right, no rule
    case wash
  }

  /// A solid arrow's line, a filled outline
  enum Line: Sendable {
    /// Even, from `start` wide at its source to `end` at its head, with a round start
    case taper(start: CGFloat, end: CGFloat)
    /// A brush: a rounded, heavier start thinning to the end, a seeded wobble and three hairlines of dry brush
    case brush(half: CGFloat)
  }

  enum Head: Sendable {
    /// A small filled arrowhead with a notched tail
    case dart
    /// A dot on the card's edge
    case dot
  }

  /// A Section's frame
  enum Frame: Sendable {
    /// A tinted tray with a hairline edge and a light inner top line
    case tray
    /// Four dry brush strokes, the title written in a gap of the top one
    case brush
  }

  /// An arrow's label
  enum Label: Sendable {
    /// On a box of card paper with a hairline
    case box
    /// On the canvas colour, fading out at its edges
    case halo
  }

  public let id: ID
  /// As the View menu shows it
  public let name: String
  /// The variant for a dark appearance (the web board's :root[data-theme="dark"] values)
  public private(set) var dark = false

  /// The board's background; the shell's board panel is the same surface
  package var canvas: CGColor
  /// A picture behind the board, fixed to the view (an asset of the Note page build, by its source name): nil for none
  var backdrop: String?
  /// The backdrop drawn (once per process; tens of milliseconds the first time)
  package var backdropImage: CGImage? { backdrop.flatMap(Backdrop.image) }
  /// Card paper
  var surface: CGColor
  /// Card title bars (`Header.band`)
  var head: CGColor
  var ink: CGColor
  var ink2: CGColor
  var ink3: CGColor
  var accent: CGColor
  /// Rules inside a card (a Note's title bar)
  var line: CGColor
  /// Card and section edges
  var hair: CGColor
  /// Rows of hidden lines
  var hiddenRow: CGColor
  /// A highlight's band
  var highlight: CGColor
  /// The row an arrow starts from
  var linkedRow: CGColor
  /// A linked row's number
  var linkedNumber: CGColor
  /// Line numbers
  var number: CGColor
  /// `Paper.sheet`'s edge: its light top and warm bottom
  var edgeTop: CGColor
  var edgeBottom: CGColor
  var arrow: CGColor
  var arrowLost: CGColor
  var arrowColors: [String: CGColor]
  /// The dry brush's hairlines (`Line.brush`)
  var dryBrush: CGColor
  /// The faint fibres inside `Paper.deckle`, and its torn edge
  var fibreInner: CGColor
  var fibreEdge: CGColor
  /// An uncoloured Section's fill
  var sectionFill: CGColor
  var sectionColors: [String: CGColor]
  var sectionTitle: CGColor
  /// `Frame.tray`'s inner top line; `Frame.brush`'s strokes
  var sectionEdge: CGColor
  var boxFills: [BoxFill: CGColor]
  var boxEdge: CGColor
  /// The soft shadow under a card, CSS box-shadow layers (offset y, blur, spread, colour), on a rounded rectangle
  var shadow: [(y: CGFloat, blur: CGFloat, spread: CGFloat, color: CGColor)]
  var shadowRadius: CGFloat
  /// Code colours (`--k-*`); plain code is `ink`
  var syntax: [TokenClass: CGColor]

  var code: Font
  var codeComment: Font
  /// Keywords and operators: bold in Ink Wash
  var codeKeyword: Font
  var codeTitle: Font
  var codePath: Font
  /// The card's kind before a code card's title (ƒ, C, ⋮…); nil: not shown
  var kindGlyph: Font?
  var kindGlyphMono: Font?
  var noteTitle: Font
  /// Line counts and versions in a header, hidden-line rows
  var small: Font
  /// A hidden-line row's Show
  var smallStrong: Font
  var linkedIn: Font
  var sectionTitleFont: Font
  var arrowLabel: Font

  var paper: Paper
  var header: Header
  var arrowLine: Line
  var arrowHead: Head
  var frame: Frame
  var label: Label

  var cardRadius: CGFloat
  var sectionRadius: CGFloat
  var labelRadius: CGFloat
  var headerHeight: CGFloat
  /// Left of a header's first item, and between its items
  var headerPad: CGFloat
  var headerPadRight: CGFloat
  var headerGap: CGFloat
  /// A Section title's top left from the Section's, and its height
  var sectionTitleAt: CGPoint
  var sectionTitleHeight: CGFloat
  /// A stroked (dashed) arrow's width at the default weight (2), board units
  var arrowWidth: CGFloat
  var metrics: CodeMetrics

  /// What a framed item draws past its rect on each side: a deckled sheet's paper, a sheet's hairline ring (CSS
  /// 0 0 0 0.5px), which a bitmap of the rect alone would cut off along its sides and keep only round the corners
  var bleed: CGFloat { paper == .deckle ? Deckle.margin : 0.5 }

  /// The looks to choose from, light; each has its dark variant (`named(_:dark:)`)
  public static let all: [Theme] = [.warmInk, .inkWash]

  public static func named(_ id: ID, dark: Bool) -> Theme {
    switch id {
    case .warmInk: dark ? .warmInkDark : .warmInk
    case .inkWash: dark ? .inkWashDark : .inkWash
    }
  }

  /// The same look in the same appearance
  public func same(as other: Theme) -> Bool { id == other.id && dark == other.dark }

  public static let warmInk: Theme = {
    let surface: UInt32 = 0xfdfcfa
    let sys = { (size: CGFloat, weight: NSFont.Weight) in Font(NSFont.systemFont(ofSize: size, weight: weight)) }
    let code = Font.board("JetBrainsMono-400-600", size: 11, weight: 400) ?? Font.mono(11, .regular)
    return Theme(
      id: .warmInk, name: "Warm Ink",
      canvas: rgb(0xeeece6), backdrop: nil, surface: rgb(surface), head: rgb(0xf8f6f1), ink: rgb(0x211f1b),
      ink2: rgb(0x625e56), ink3: rgb(0x9a958b), accent: rgb(0xb5552d), line: rgb(0x3c2d14, 0.09),
      hair: rgb(0x3c2d14, 0.16), hiddenRow: rgb(0x3c2d14, 0.07), highlight: rgb(0xb5552d, 0.065),
      linkedRow: rgb(0xb5552d, 0.09), linkedNumber: rgb(0xb5552d), number: rgb(0x9a958b, 0.65),
      edgeTop: rgb(0xffffff), edgeBottom: rgb(0x3c2d14, 0.1), arrow: rgb(0x85786a), arrowLost: rgb(0xd64545),
      arrowColors: ["orange": rgb(0xc46a2a), "blue": rgb(0x3a72aa), "green": rgb(0x4c8a3a)],
      dryBrush: rgb(surface), fibreInner: rgb(0x6b5a3a, 0.04), fibreEdge: rgb(0x6b5a3a, 0.1),
      sectionFill: rgb(0x211f1b, 0.022),
      sectionColors: [
        "sand": rgb(0xceaa6e, 0.16), "blue": rgb(0x6091cd, 0.12), "green": rgb(0x6ea55f, 0.13),
        "pink": rgb(0xd77891, 0.12),
      ],
      sectionTitle: rgb(0x625e56), sectionEdge: rgb(0xffffff, 0.5),
      boxFills: boxFills(surface), boxEdge: rgb(0x211f1b, 0.34),
      shadow: [
        (1, 1, 0, rgb(0x32230a, 0.05)), (3, 6, -2, rgb(0x32230a, 0.05)), (12, 24, -12, rgb(0x32230a, 0.1)),
        (28, 50, -26, rgb(0x32230a, 0.12)),
      ],
      shadowRadius: 6.25,
      syntax: [
        // an operator is a keyword on a card (`kw op`)
        .keyword: rgb(0x9a3f22), .operator: rgb(0x9a3f22), .function: rgb(0x2e5d86), .string: rgb(0x4a7536),
        .comment: rgb(0x9a958a), .number: rgb(0x8a6416), .receiver: rgb(0x7a4f9a), .punctuation: rgb(0x6f6a62),
      ],
      code: code,
      codeComment: Font.board("JetBrainsMono-400i", size: 11, weight: nil) ?? code.italic,
      codeKeyword: code,
      codeTitle: Font.board("JetBrainsMono-400-600", size: 12, weight: 500, tracking: -0.12) ?? Font.mono(12, .medium),
      codePath: Font.board("JetBrainsMono-400-600", size: 10.5, weight: 400) ?? Font.mono(10.5, .regular),
      kindGlyph: Font.board("SourceSerif4-400i", size: 12, weight: nil, opticalSize: true) ?? sys(12, .regular),
      kindGlyphMono: Font.board("JetBrainsMono-400-600", size: 11, weight: 600) ?? Font.mono(11, .semibold),
      noteTitle: sys(12, .medium), small: sys(11, .regular), smallStrong: sys(11, .medium),
      linkedIn: Font.board("JetBrainsMono-400-600", size: 11, weight: 400) ?? Font.mono(11, .regular),
      sectionTitleFont: sys(12.5, .semibold),
      arrowLabel: sys(11.5, .medium),
      paper: .sheet, header: .band, arrowLine: .taper(start: 2.5, end: 0.9), arrowHead: .dart, frame: .tray,
      label: .box,
      cardRadius: 12.5, sectionRadius: 13.5, labelRadius: 8.5, headerHeight: 36, headerPad: 10, headerPadRight: 6,
      headerGap: 7,
      sectionTitleAt: CGPoint(x: 16, y: 6), sectionTitleHeight: 22, arrowWidth: 1.25,
      metrics: CodeMetrics(charWidth: code.advance))
  }()

  public static let inkWash: Theme = {
    let surface: UInt32 = 0xfdfdfb
    let serif = { (size: CGFloat, weight: CGFloat) in
      Font.board("SourceSerif4-400-600", size: size, weight: weight, opticalSize: true)
        ?? Font(NSFont(name: "Georgia", size: size) ?? NSFont.systemFont(ofSize: size))
    }
    let italic = Font.board("SourceSerif4-400i", size: 12, weight: nil, opticalSize: true) ?? serif(12, 400)
    let code = Font.board("JetBrainsMono-400-600", size: 11, weight: 400) ?? Font.mono(11, .regular)
    return Theme(
      id: .inkWash, name: "Ink Wash",
      canvas: rgb(0xf6f5f1), backdrop: "ink-light", surface: rgb(surface), head: rgb(0, 0), ink: rgb(0x1d1c1a),
      ink2: rgb(0x4c4943), ink3: rgb(0x9a958b), accent: rgb(0xb8321f), line: rgb(0x1d1c1a, 0.08),
      hair: rgb(0x1d1c1a, 0.16), hiddenRow: rgb(0x1d1c1a, 0.06), highlight: rgb(0xb8321f, 0.065),
      linkedRow: rgb(0xb8321f, 0.08), linkedNumber: rgb(0xb8321f), number: rgb(0x9a958b, 0.65),
      edgeTop: rgb(0xffffff), edgeBottom: rgb(0x1d1c1a, 0.1), arrow: rgb(0x1d1c1a, 0.8),
      arrowLost: rgb(0xd64545),
      arrowColors: ["orange": rgb(0x9a5a2c), "blue": rgb(0x2d5b70), "green": rgb(0x4d6b48)],
      dryBrush: rgb(surface, 0.75), fibreInner: rgb(0x6b5a3a, 0.04), fibreEdge: rgb(0x6b5a3a, 0.1),
      sectionFill: rgb(0, 0),
      sectionColors: [
        "sand": rgb(0x9a5a2c, 0.07), "blue": rgb(0x2d5b70, 0.07), "green": rgb(0x506e50, 0.07),
        "pink": rgb(0xb8321f, 0.06),
      ],
      sectionTitle: rgb(0x1d1c1a), sectionEdge: rgb(0x1d1c1a, 0.72),
      boxFills: boxFills(surface), boxEdge: rgb(0x1d1c1a, 0.34),
      shadow: [(4, 9, 0, rgb(0, 0.12))], shadowRadius: 2,
      syntax: [
        .keyword: rgb(0x1d1c1a), .operator: rgb(0x1d1c1a), .function: rgb(0x2d5b70), .string: rgb(0x9a5a2c),
        .comment: rgb(0x9a958b), .number: rgb(0x9a5a2c), .receiver: rgb(0x4c4943), .punctuation: rgb(0x9a958b),
      ],
      code: code,
      codeComment: Font.board("JetBrainsMono-400i", size: 11, weight: nil) ?? code.italic,
      codeKeyword: Font.board("JetBrainsMono-400-600", size: 11, weight: 600) ?? Font.mono(11, .semibold),
      codeTitle: serif(13, 600).tracked(0.13),
      codePath: Font.board("JetBrainsMono-400-600", size: 10.5, weight: 400) ?? Font.mono(10.5, .regular),
      kindGlyph: nil, kindGlyphMono: nil,
      noteTitle: serif(13, 600).tracked(0.13), small: serif(11, 400), smallStrong: serif(11, 500),
      linkedIn: code,
      sectionTitleFont: Font.board("ZhiMangXing-latin", size: 25, weight: nil, cascade: "ZhiMangXing-")
        ?? Font(NSFont(name: "Xingkai SC", size: 25) ?? NSFont.systemFont(ofSize: 25)),
      arrowLabel: italic,
      paper: .deckle, header: .wash, arrowLine: .brush(half: 1.5), arrowHead: .dot, frame: .brush, label: .halo,
      cardRadius: 2, sectionRadius: 2, labelRadius: 0, headerHeight: 36, headerPad: 14, headerPadRight: 8, headerGap: 9,
      sectionTitleAt: CGPoint(x: 24, y: -17), sectionTitleHeight: 32, arrowWidth: 2,
      metrics: CodeMetrics(charWidth: code.advance))
  }()

  /// :root[data-theme="dark"] in styles.css; the card's edge and shadow are its --wi-ring and --wi-soft
  public static let warmInkDark: Theme = {
    var t = warmInk
    let surface: UInt32 = 0x252422
    t.dark = true
    t.canvas = rgb(0x191816)
    t.surface = rgb(surface)
    t.head = rgb(0x2a2926)
    t.ink = rgb(0xece8e0)
    t.ink2 = rgb(0xaca79d)
    t.ink3 = rgb(0x78746c)
    t.accent = rgb(0xe3895f)
    t.line = rgb(0xfff0dc, 0.07)
    t.hair = rgb(0xfff0dc, 0.11)
    t.hiddenRow = rgb(0xfff0dc, 0.07)
    // .hx-band in dark: 11 % of the accent
    t.highlight = rgb(0xe3895f, 0.11)
    t.linkedRow = rgb(0xe3895f, 0.09)
    t.linkedNumber = rgb(0xe3895f)
    t.number = rgb(0x78746c, 0.65)
    t.edgeTop = rgb(0xfff5e6, 0.13)
    t.edgeBottom = rgb(0, 0.35)
    t.arrow = rgb(0xa69886)
    t.arrowColors = ["orange": rgb(0xe3955a), "blue": rgb(0x7fb0e0), "green": rgb(0x96c47e)]
    t.dryBrush = rgb(surface)
    t.sectionFill = rgb(0xece8e0, 0.025)
    t.sectionColors = [
      "sand": rgb(0xd6b478, 0.1), "blue": rgb(0x78a5e1, 0.09), "green": rgb(0x8cc378, 0.09),
      "pink": rgb(0xe68ca5, 0.09),
    ]
    t.sectionTitle = rgb(0xaca79d)
    t.sectionEdge = rgb(0xfff5e6, 0.025)
    t.boxFills = boxFills(surface)
    t.boxEdge = rgb(0xece8e0, 0.34)
    t.shadow = [
      (0.5, 1, 0, rgb(0, 0.22)), (2, 5, -1, rgb(0, 0.2)), (10, 22, -10, rgb(0, 0.3)), (26, 48, -24, rgb(0, 0.32)),
    ]
    t.syntax = [
      .keyword: rgb(0xe59572), .operator: rgb(0xe59572), .function: rgb(0x86b4de), .string: rgb(0xa3c98c),
      .comment: rgb(0x7d786e), .number: rgb(0xd9b36a), .receiver: rgb(0xc8a3e6), .punctuation: rgb(0xa39e93),
    ]
    return t
  }()

  /// The rubbing: :root.look-ink-wash[data-theme="dark"] in themes.css, the paper and its fibres as state/ink.ts draws
  /// them in dark
  public static let inkWashDark: Theme = {
    var t = inkWash
    t.dark = true
    t.canvas = rgb(0x131312)
    t.backdrop = "ink-dark"
    // the deckled sheet's paper (ink.ts), a shade off --surface, which box Notes mix their fills with
    t.surface = rgb(0x1e1d1a)
    t.ink = rgb(0xe9e5da)
    t.ink2 = rgb(0xb9b4a8)
    t.ink3 = rgb(0x6e6a62)
    t.accent = rgb(0xd6533a)
    t.line = rgb(0xe9e5da, 0.07)
    t.hair = rgb(0xe9e5da, 0.14)
    t.hiddenRow = rgb(0xe9e5da, 0.07)
    t.highlight = rgb(0xd6533a, 0.11)
    t.linkedRow = rgb(0xd6533a, 0.12)
    t.linkedNumber = rgb(0xd6533a)
    t.number = rgb(0x6e6a62, 0.65)
    t.arrow = rgb(0xe9e5da, 0.78)
    t.arrowColors = ["orange": rgb(0xd39a6c), "blue": rgb(0x8fb7c9), "green": rgb(0x9cbf92)]
    // --paper, at the feibai's opacity
    t.dryBrush = rgb(0x1c1b19, 0.75)
    t.fibreInner = rgb(0xe9e5da, 0.035)
    t.fibreEdge = rgb(0xe9e5da, 0.12)
    t.sectionColors = [
      "sand": rgb(0xd39a6c, 0.06), "blue": rgb(0x8fb7c9, 0.06), "green": rgb(0x8caa82, 0.06),
      "pink": rgb(0xd6533a, 0.06),
    ]
    t.sectionTitle = rgb(0xe9e5da)
    t.sectionEdge = rgb(0xe9e5da, 0.72)
    t.boxFills = boxFills(0x1c1b19)
    t.boxEdge = rgb(0xe9e5da, 0.34)
    t.shadow = [(4, 10, 0, rgb(0, 0.5))]
    t.syntax = [
      .keyword: rgb(0xe9e5da), .operator: rgb(0xe9e5da), .function: rgb(0x8fb7c9), .string: rgb(0xd39a6c),
      .comment: rgb(0x6e6a62), .number: rgb(0xd39a6c), .receiver: rgb(0xb9b4a8), .punctuation: rgb(0x8a857c),
    ]
    return t
  }()

  private static func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(
      srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255,
      alpha: a)
  }

  /// A box Note's fills: color-mix(in srgb, surface p, colour)
  private static func boxFills(_ surface: UInt32) -> [BoxFill: CGColor] {
    func mix(_ p: CGFloat, _ other: UInt32) -> CGColor {
      let c = [16, 8, 0].map { s in
        (CGFloat(surface >> UInt32(s) & 0xff) * p + CGFloat(other >> UInt32(s) & 0xff) * (1 - p)) / 255
      }
      return CGColor(srgbRed: c[0], green: c[1], blue: c[2], alpha: 1)
    }
    return [
      .yellow: mix(0.66, 0xf0cf62), .paper: rgb(surface), .blue: mix(0.78, 0x8eb0dc), .green: mix(0.76, 0x9cc48a),
      .pink: mix(0.78, 0xe3a0b4),
    ]
  }
}

/// CTFont is immutable and documented safe to use from any thread, but the SDK does not mark it Sendable
struct Font: @unchecked Sendable {
  let ct: CTFont
  /// Extra space after each character (CSS letter-spacing), points
  var tracking: CGFloat = 0

  init(_ f: CTFont, tracking: CGFloat = 0) {
    ct = f
    self.tracking = tracking
  }

  init(_ f: NSFont) { ct = f }

  /// One character's advance (the code font is monospaced)
  var advance: CGFloat {
    var g = CTFontGetGlyphWithName(ct, "zero" as CFString)
    var a = CGSize.zero
    CTFontGetAdvancesForGlyphs(ct, .horizontal, &g, &a, 1)
    return a.width
  }

  var italic: Font { Font(CTFontCreateCopyWithSymbolicTraits(ct, 0, nil, .traitItalic, .traitItalic) ?? ct) }

  func tracked(_ t: CGFloat) -> Font { Font(ct, tracking: t) }

  static func mono(_ size: CGFloat, _ weight: NSFont.Weight) -> Font {
    Font(NSFont.monospacedSystemFont(ofSize: size, weight: weight))
  }

  /// One of the board's own fonts, from the Note page build (the same files its stylesheets load): `file` is the font's
  /// source name (packages/board/src/fonts), weight a `wght` value for a variable font, opticalSize sets `opsz` to the size
  /// as browsers do; cascade: the source name prefix of further files that fill in characters the first one lacks. nil when
  /// the page build has no such file
  static func board(
    _ file: String, size: CGFloat, weight: CGFloat?, opticalSize: Bool = false, tracking: CGFloat = 0,
    cascade: String? = nil
  ) -> Font? {
    guard var d = BoardFonts.descriptor(file) else { return nil }
    if let weight { d = CTFontDescriptorCreateCopyWithVariation(d, 0x7767_6874 as CFNumber, weight) }
    if opticalSize { d = CTFontDescriptorCreateCopyWithVariation(d, 0x6f70_737a as CFNumber, size) }
    if let cascade {
      let rest = BoardFonts.files(prefix: cascade).filter { !$0.hasPrefix(file) }.compactMap(BoardFonts.descriptor)
      d = CTFontDescriptorCreateCopyWithAttributes(d, [kCTFontCascadeListAttribute: rest] as CFDictionary)
    }
    return Font(CTFontCreateWithFontDescriptor(d, size, nil), tracking: tracking)
  }
}

/// The board's font files as the Note page build carries them (`assets/<source name>-<hash>.woff2`), read once
enum BoardFonts {
  private static let folder = NoteRenderer.bundledPage.appending(path: "assets")
  private static let names: [String] =
    ((try? FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false))) ?? [])
    .filter { $0.hasSuffix(".woff2") }.sorted()
  private static let loaded: [String: Data] = {
    var out: [String: Data] = [:]
    for n in names {
      if let data = try? Data(contentsOf: folder.appending(path: n)) { out[source(n)] = data }
    }
    return out
  }()

  /// "JetBrainsMono-400-600-AB12CD34.woff2" → "JetBrainsMono-400-600"
  private static func source(_ name: String) -> String {
    let stem = name.dropLast(".woff2".count)
    return stem.lastIndex(of: "-").map { String(stem[..<$0]) } ?? String(stem)
  }

  static func descriptor(_ file: String) -> CTFontDescriptor? {
    loaded[file].flatMap { (CTFontManagerCreateFontDescriptorsFromData($0 as CFData) as? [CTFontDescriptor])?.first }
  }

  /// The source names starting with `prefix`, sorted
  static func files(prefix: String) -> [String] { loaded.keys.filter { $0.hasPrefix(prefix) }.sorted() }

  /// Every font the looks use is in the build (tests)
  static var complete: Bool {
    ["JetBrainsMono-400-600", "JetBrainsMono-400i", "SourceSerif4-400-600", "SourceSerif4-400i", "ZhiMangXing-latin"]
      .allSatisfy { loaded[$0] != nil }
  }
}

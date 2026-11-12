import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax

/// A complete description of how the board looks, which the drawing code only reads: colours, fonts, sizes, and the few
/// ways of drawing that are not values (`Paper`, `Header`, `Line`…), each a small closed set the drawing code switches on.
/// A new look is a new instance, and at most a new case where it draws something no look drew before. Values from the web
/// board's themes (packages/board/src/styles.css for Warm Ink, themes.css for the others), light variants only.
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

  /// The board's background; the shell's board panel is the same surface
  package var canvas: CGColor
  /// A picture behind the board, fixed to the view (an asset of the Note page build, by its source name): nil for none
  var backdrop: String?
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
  /// The fibres in and on the edge of `Paper.deckle`
  var fibre: CGColor
  /// An uncoloured Section's fill
  var sectionFill: CGColor
  var sectionColors: [String: CGColor]
  var sectionTitle: CGColor
  /// `Frame.tray`'s inner top line; `Frame.brush`'s strokes
  var sectionEdge: CGColor
  var boxFills: [NoteStyle.BoxFill: CGColor]
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

  /// The paper a framed item draws past its rect on each side
  var bleed: CGFloat { paper == .deckle ? Deckle.margin : 0 }

  public static let all: [Theme] = [.warmInk, .inkWash]

  public static func named(_ id: ID) -> Theme { all.first { $0.id == id } ?? .warmInk }

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
      dryBrush: rgb(surface), fibre: rgb(0x6b5a3a), sectionFill: rgb(0x211f1b, 0.022),
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
      dryBrush: rgb(surface, 0.75), fibre: rgb(0x6b5a3a), sectionFill: rgb(0, 0),
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

  private static func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(
      srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255,
      alpha: a)
  }

  /// A box Note's fills: color-mix(in srgb, surface p, colour)
  private static func boxFills(_ surface: UInt32) -> [NoteStyle.BoxFill: CGColor] {
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

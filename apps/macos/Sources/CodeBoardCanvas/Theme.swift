import AppKit
import CodeBoardModel
import CodeBoardSyntax

/// How the board looks: colours, fonts and the few sizes that are the look's. Values from the board's Warm Ink
/// (packages/board/src/styles.css, themes.css).
public struct Theme: Sendable {
  /// The board's background; the shell's board panel is the same surface
  package var canvas: CGColor
  /// Card paper
  var surface: CGColor
  /// Card title bars
  var head: CGColor
  var ink: CGColor
  var ink2: CGColor
  var ink3: CGColor
  /// Rules inside a card (a Note's title bar)
  var line: CGColor
  /// Card and section edges
  var hair: CGColor
  /// Rows of hidden lines
  var hiddenRow: CGColor
  var highlight: CGColor
  /// The card edge's light top and warm bottom
  var edgeTop: CGColor
  var edgeBottom: CGColor
  var arrow: CGColor
  var arrowLost: CGColor
  var arrowColors: [String: CGColor]
  var sectionFill: CGColor
  var sectionColors: [String: CGColor]
  var boxFills: [NoteStyle.BoxFill: CGColor]
  var boxEdge: CGColor
  /// The soft shadow under a card: offset y, blur, spread and alpha of each layer (CSS box-shadow)
  var shadow: [(y: CGFloat, blur: CGFloat, spread: CGFloat, alpha: CGFloat)]
  var shadowColor: (r: CGFloat, g: CGFloat, b: CGFloat)
  /// Code colours (`--k-*`); plain code is `ink`
  var syntax: [TokenClass: CGColor]

  var code: Font
  /// Comments in code: italic in Warm Ink
  var codeComment: Font
  var codeTitle: Font
  var codePath: Font
  var noteTitle: Font
  var small: Font
  var sectionTitle: Font
  var arrowLabel: Font

  var cardRadius: CGFloat
  var sectionRadius: CGFloat
  var labelRadius: CGFloat
  var headerHeight: CGFloat
  /// Arrow line width at the default weight (2), board units
  var arrowWidth: CGFloat
  var metrics: CodeMetrics

  public static let warmInkLight: Theme = {
    func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
      CGColor(
        srgbRed: CGFloat(hex >> 16 & 0xff) / 255, green: CGFloat(hex >> 8 & 0xff) / 255,
        blue: CGFloat(hex & 0xff) / 255,
        alpha: a)
    }
    /// color-mix(in srgb, surface p, other)
    func mix(_ p: CGFloat, _ other: UInt32) -> CGColor {
      let s: [CGFloat] = [0xfd, 0xfc, 0xfa]
      let o = [CGFloat(other >> 16 & 0xff), CGFloat(other >> 8 & 0xff), CGFloat(other & 0xff)]
      let c = (0..<3).map { (s[$0] * p + o[$0] * (1 - p)) / 255 }
      return CGColor(srgbRed: c[0], green: c[1], blue: c[2], alpha: 1)
    }
    let mono = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    return Theme(
      canvas: rgb(0xeeece6), surface: rgb(0xfdfcfa), head: rgb(0xf8f6f1), ink: rgb(0x211f1b), ink2: rgb(0x625e56),
      ink3: rgb(0x9a958b), line: rgb(0x3c2d14, 0.09), hair: rgb(0x3c2d14, 0.16), hiddenRow: rgb(0x3c2d14, 0.07),
      highlight: rgb(0xb5552d, 0.065), edgeTop: rgb(0xffffff), edgeBottom: rgb(0x3c2d14, 0.1), arrow: rgb(0x85786a),
      arrowLost: rgb(0xd64545),
      arrowColors: ["orange": rgb(0xc46a2a), "blue": rgb(0x3a72aa), "green": rgb(0x4c8a3a)],
      sectionFill: rgb(0x211f1b, 0.022),
      sectionColors: [
        "sand": rgb(0xceaa6e, 0.16), "blue": rgb(0x6091cd, 0.12), "green": rgb(0x6ea55f, 0.13),
        "pink": rgb(0xd77891, 0.12),
      ],
      boxFills: [
        .yellow: mix(0.66, 0xf0cf62), .paper: rgb(0xfdfcfa), .blue: mix(0.78, 0x8eb0dc), .green: mix(0.76, 0x9cc48a),
        .pink: mix(0.78, 0xe3a0b4),
      ],
      boxEdge: rgb(0x211f1b, 0.34),
      shadow: [(1, 1, 0, 0.05), (3, 6, -2, 0.05), (12, 24, -12, 0.1), (28, 50, -26, 0.12)],
      shadowColor: (50.0 / 255, 35.0 / 255, 10.0 / 255),
      syntax: [
        // an operator is a keyword on a card (`kw op`)
        .keyword: rgb(0x9a3f22), .operator: rgb(0x9a3f22), .function: rgb(0x2e5d86), .string: rgb(0x4a7536),
        .comment: rgb(0x9a958a), .number: rgb(0x8a6416), .receiver: rgb(0x7a4f9a), .punctuation: rgb(0x6f6a62),
      ],
      code: Font(mono),
      codeComment: Font(NSFont(descriptor: mono.fontDescriptor.withSymbolicTraits(.italic), size: 11) ?? mono),
      codeTitle: Font(NSFont.monospacedSystemFont(ofSize: 12, weight: .medium)),
      codePath: Font(NSFont.monospacedSystemFont(ofSize: 10.5, weight: .regular)),
      noteTitle: Font(NSFont.systemFont(ofSize: 12, weight: .medium)), small: Font(NSFont.systemFont(ofSize: 11)),
      sectionTitle: Font(NSFont.systemFont(ofSize: 12.5, weight: .semibold)),
      arrowLabel: Font(NSFont.systemFont(ofSize: 11.5, weight: .medium)),
      cardRadius: 12.5, sectionRadius: 13.5, labelRadius: 8.5, headerHeight: 36, arrowWidth: 1.25,
      metrics: CodeMetrics(charWidth: mono.maximumAdvancement.width))
  }()
}

/// CTFont is immutable and documented safe to use from any thread, but the SDK does not mark it Sendable
struct Font: @unchecked Sendable {
  let ct: CTFont

  init(_ f: NSFont) { ct = f }
}

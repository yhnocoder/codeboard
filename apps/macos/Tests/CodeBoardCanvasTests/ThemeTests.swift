import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import CoreText
import Foundation
import Testing

@testable import CodeBoardCanvas

@Suite struct ThemeTests {
  @Test func everyThemeFillsTheWholeTable() {
    #expect(Theme.all.map(\.id) == Theme.ID.allCases)
    for id in Theme.ID.allCases {
      #expect(Theme.named(id, dark: false).id == id && !Theme.named(id, dark: false).dark)
      #expect(Theme.named(id, dark: true).id == id && Theme.named(id, dark: true).dark)
    }
    let first = Theme.all[0]
    for t in Theme.all + Theme.all.map({ Theme.named($0.id, dark: true) }) {
      let fields = Mirror(reflecting: t).children
      // only these may be absent: a theme without a backdrop picture or a kind glyph font
      let optional: Set = ["backdrop", "kindGlyph", "kindGlyphMono"]
      for f in fields where !optional.contains(f.label ?? "") {
        #expect(!"\(f.value)".hasPrefix("nil"), "\(t.id) \(f.label ?? "?")")
      }
      #expect(fields.count == Mirror(reflecting: first).children.count)
      #expect(Set(t.syntax.keys) == Set(TokenClass.allCases), "\(t.id) syntax")
      #expect(Set(t.boxFills.keys) == [.yellow, .paper, .blue, .green, .pink], "\(t.id) box fills")
      #expect(Set(t.arrowColors.keys) == Set(first.arrowColors.keys), "\(t.id) arrow colours")
      #expect(Set(t.sectionColors.keys) == Set(first.sectionColors.keys), "\(t.id) section colours")
      #expect(!t.shadow.isEmpty && t.headerHeight > 0 && t.arrowWidth > 0, "\(t.id) metrics")
    }
  }

  /// Each look's dark variant is its own palette, the same shapes, fonts and sizes (a card holds the same whatever the
  /// appearance), and reads: dark ground, light ink, paper apart from the canvas
  @Test(arguments: Theme.ID.allCases) func eachThemeHasADarkVariantThatReads(_ id: Theme.ID) {
    let light = Theme.named(id, dark: false)
    let dark = Theme.named(id, dark: true)
    #expect(dark.name == light.name && !light.same(as: dark) && dark.same(as: Theme.named(id, dark: true)))
    #expect(dark.metrics.charWidth == light.metrics.charWidth && dark.headerHeight == light.headerHeight)
    #expect(dark.cardRadius == light.cardRadius && dark.paper == light.paper && dark.frame == light.frame)
    // every colour of the light look that is not transparent is another colour in the dark one
    let colours: [(String, KeyPath<Theme, CGColor>)] = [
      ("canvas", \.canvas), ("surface", \.surface), ("ink", \.ink), ("ink2", \.ink2), ("ink3", \.ink3),
      ("accent", \.accent), ("line", \.line), ("hair", \.hair), ("arrow", \.arrow), ("sectionTitle", \.sectionTitle),
      ("sectionEdge", \.sectionEdge), ("boxEdge", \.boxEdge), ("highlight", \.highlight), ("linkedRow", \.linkedRow),
    ]
    for (name, k) in colours { #expect(dark[keyPath: k] != light[keyPath: k], "\(id) \(name)") }
    for (k, c) in light.syntax { #expect(dark.syntax[k] != c, "\(id) \(k)") }
    for (k, c) in light.boxFills { #expect(dark.boxFills[k] != c, "\(id) box \(k)") }
    for (k, c) in light.sectionColors { #expect(dark.sectionColors[k] != c, "\(id) section \(k)") }
    for (k, c) in light.arrowColors { #expect(dark.arrowColors[k] != c, "\(id) arrow \(k)") }
    #expect(dark.backdrop != light.backdrop || light.backdrop == nil)

    #expect(luminance(dark.canvas) < 0.02 && luminance(light.canvas) > 0.8)
    for t in [light, dark] {
      // text on paper reads (WCAG AAA for the ink, AA for the secondary ink), and comments are not lost on it
      #expect(contrast(t.ink, t.surface) > 12, "\(t.id) dark: \(t.dark) ink")
      #expect(contrast(t.ink2, t.surface) > 4.5, "\(t.id) dark: \(t.dark) ink2")
      #expect(contrast(t.syntax[.comment]!, t.surface) > 2.5, "\(t.id) dark: \(t.dark) comments")
      // a card's paper stands apart from the canvas, lighter than it in both
      #expect(contrast(t.surface, t.canvas) > 1.05 && luminance(t.surface) > luminance(t.canvas))
    }
  }

  @Test func theFontsTheLooksUseAreInTheAssetsBuild() throws {
    let assets = NativeNotes.assets.appending(path: "assets").path(percentEncoded: false)
    try #require(FileManager.default.fileExists(atPath: assets), "build the assets first: node web/build.mjs")
    #expect(BoardFonts.complete)
    // the board's own faces, not a system fallback
    let names = Theme.all.map { CTFontCopyPostScriptName($0.code.ct) as String }
    #expect(names.allSatisfy { $0.hasPrefix("JetBrainsMono") }, "\(names)")
  }
}

@Suite struct SeededTests {
  // the board's values (canvas/random.ts, inkframe.ts), computed in Node
  @Test func theBoardsGeneratorsGiveTheBoardsNumbers() {
    let r = Seeded.rng(3)
    #expect([r(), r(), r()] == [0.2651473756413907, 0.40467985859140754, 0.46297591482289135])
    #expect(Seeded.fnv("ccode") == 1_314_057_791)
    #expect(Seeded.fnv("选") == 187_283_492)
    #expect(Seeded.hash(123456, 7) == 0.13493912783451378)
  }

  @Test func effectsAreTheSameEveryTimeAndDifferByCard() {
    let size = CGSize(width: 300, height: 200)
    let a = Deckle.paper(Deckle.sheet(1), size: size)
    let b = Deckle.paper(Deckle.sheet(1), size: size)
    #expect(a.outline == b.outline && a.fibres == b.fibres && a.inner == b.inner)
    #expect(a.outline != Deckle.paper(Deckle.sheet(2), size: size).outline)

    #expect(InkFrame.path(id: "s", size: size, gap: 40) == InkFrame.path(id: "s", size: size, gap: 40))
    #expect(InkFrame.path(id: "s", size: size, gap: 40) != InkFrame.path(id: "t", size: size, gap: 40))

    let ops: [PathOp] = [
      .move(CGPoint(x: 0, y: 0)), .curve(CGPoint(x: 80, y: 0), CGPoint(x: 120, y: 90), CGPoint(x: 200, y: 90)),
    ]
    let brush = Strokes.brush(ops, seed: Strokes.brushSeed("l"), w: 2)
    #expect(brush.outline == Strokes.brush(ops, seed: Strokes.brushSeed("l"), w: 2).outline)
    #expect(brush.outline != Strokes.brush(ops, seed: Strokes.brushSeed("m"), w: 2).outline)
    #expect(Strokes.taper(ops, w0: 1.4, w1: 2.6) == Strokes.taper(ops, w0: 1.4, w1: 2.6))
  }

  @Test func indentedCodeMovesLeftAsTheBoardDedentsIt() {
    let s = Segment(
      id: SegmentID(rawValue: "a"), source: nil, language: "python", firstLine: 1,
      lines: ["        x = 1", "", "          y = 2"])
    let l = CodeLayout(CodeCard(segments: [s]), width: 400, metrics: CodeMetrics(charWidth: 6.6))
    #expect(l.dedent == 8 && l.shift == 16 - 8 * 6.6)
    let flat = CodeLayout(
      CodeCard(segments: [Segment(id: s.id, source: nil, language: "python", firstLine: 1, lines: ["x", " y"])]),
      width: 400, metrics: CodeMetrics(charWidth: 6.6))
    #expect(flat.dedent == 0 && flat.shift == 0)
  }
}

/// WCAG relative luminance of an opaque sRGB colour
private func luminance(_ c: CGColor) -> Double {
  let v = (c.components ?? []).prefix(3).map { x in
    let x = Double(x)
    return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4)
  }
  return v.count == 3 ? 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] : 0
}

private func contrast(_ a: CGColor, _ b: CGColor) -> Double {
  let (x, y) = (luminance(a), luminance(b))
  return (max(x, y) + 0.05) / (min(x, y) + 0.05)
}

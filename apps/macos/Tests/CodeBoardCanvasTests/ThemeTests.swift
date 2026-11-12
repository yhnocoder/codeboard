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
    for id in Theme.ID.allCases { #expect(Theme.named(id).id == id) }
    let first = Theme.all[0]
    for t in Theme.all {
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

  @Test func theFontsTheLooksUseAreInTheNotePageBuild() throws {
    let assets = NoteRenderer.bundledPage.appending(path: "assets").path(percentEncoded: false)
    try #require(FileManager.default.fileExists(atPath: assets), "build the Note page first: node web/build.mjs")
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

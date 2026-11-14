import CodeBoardMarkdown
import CoreGraphics
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The board's looks as cards, and the assets as a host finds them: each test has a minute, so a layout that hangs (the
/// engines, the fonts) fails by name
@Suite(.timeLimit(.minutes(1))) struct LooksTests {
  struct NoResources: MarkdownResources {
    var math: MathTypesetter?
    var diagrams: DiagramRenderer? { math as? DiagramRenderer }
    func imageSize(_ src: String) -> CGSize? { nil }
    func ref(label: String, target: String?) -> MarkdownRefHit? { nil }
    func highlight(lines: [String], language: String) -> [[MarkdownToken]]? { nil }
    var mathPreamble: String { "" }
  }

  func laid(_ text: String, _ style: MarkdownLooks.Style, width: Double, math: MathTypesetter? = nil) throws -> (
    MarkdownLooks.Card, BlockLayout
  ) {
    try MarkdownAssets.fonts.get()
    let card = MarkdownLooks.card(style, look: "warm-ink", dark: false)
    let d = MarkdownDocument(text)
    var inner = max(1, CGFloat(width) - card.padding[1] - card.padding[3])
    if card.natural {
      inner = max(
        1, MarkdownLayout.make(d, width: nil, theme: card.theme, layout: nil, resources: NoResources()).size.width)
    }
    return (card, BlockLayout(d, width: inner, theme: card.theme, layout: nil, resources: NoResources(math: math)))
  }

  /// Each style's card at 100 %: a Note's header and padding and its stored height; a Text or Box as tall as its text at
  /// its size, as wide as its text unless it wraps
  @Test func everyStyleHasItsCard() throws {
    let (nc, nl) = try laid("# Plan\n\nThe scheduler takes **one step**.\n\n- prefill\n- decode", .note, width: 320)
    #expect(nc.size(content: nl.size, width: 320, height: nil).height > 100)
    #expect(nc.size(content: nl.size, width: 320, height: 120) == CGSize(width: 320, height: 120))
    var heights: [CGFloat] = []
    for size in [13.5, 20, 40] {
      let (c, l) = try laid("One line of words", .text(size: size, wrap: true), width: 600)
      heights.append(c.size(content: l.size, width: 600, height: nil).height)
    }
    // one line each at 1.6 em, and 2 above and below (.card.text padding): the web board's 25.6, 36, 68 rounded up
    #expect(heights == [26, 36, 68])
    let long = "A line of words much longer than fifty points"
    let (tc, tl) = try laid(long, .text(size: 20, wrap: false), width: 50)
    #expect(tc.size(content: tl.size, width: 50, height: nil).width > 300)
    let (bc, bl) = try laid("One line of words", .box(size: 20, wrap: true), width: 200)
    #expect(bc.size(content: bl.size, width: 200, height: 80) == CGSize(width: 200, height: 48))
  }

  /// A Text's or Box's Markdown is at its own size, its code at 0.82 em in the plain code band, its lines centred in a Box
  @Test func aTextIsMarkdownAtItsOwnSize() {
    let text = MarkdownLooks.card(.text(size: 30, wrap: false), look: "warm-ink", dark: false)
    #expect(text.theme.metrics.bodySize == 30 && text.theme.metrics.lineHeight == 1.6)
    #expect(text.theme.metrics.codeSize == 0.82 * 30 && text.theme.metrics.inlineCodeSize == 0.82)
    #expect(text.padding == [2, 4, 2, 4] && text.natural && !text.fixedHeight && !text.theme.metrics.center)
    let box = MarkdownLooks.card(.box(size: 20, wrap: true), look: "ink-wash", dark: true)
    #expect(box.theme.metrics.bodySize == 20 && box.theme.metrics.center)
    #expect(box.padding == [8, 14, 8, 14] && !box.natural)
    #expect(MarkdownLooks.card(.note, look: "warm-ink", dark: false).fixedHeight)
  }

  /// The engines, found as a host finds them, typeset a formula, and a Note with one lays it out
  @Test func theBuiltEnginesTypeset() throws {
    let engines = try MarkdownAssets.engines()
    guard case .ok(let pic) = engines.typeset("x^2 + \\frac{1}{2}", display: false, preamble: "") else {
      Issue.record("the formula did not typeset")
      return
    }
    #expect(pic.width > 0 && !pic.paths.isEmpty)
    let (_, math) = try laid("Energy $E = mc^2$ here.", .note, width: 320, math: engines)
    _ = try laid("Energy $E = mc^2$ here.", .note, width: 320)
    #expect(math.pieces[0].layout.items.contains { if case .math = $0 { true } else { false } })
  }
}

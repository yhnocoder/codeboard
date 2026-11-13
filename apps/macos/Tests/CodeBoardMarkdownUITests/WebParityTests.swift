import CodeBoardMarkdown
import CoreText
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// What the look comparison found against the web board, each held here
@Suite(.timeLimit(.minutes(1))) struct WebParityTests {
  func layout(_ md: String, theme: MarkdownTheme = testTheme, resources: MarkdownResources = TestResources())
    -> MarkdownLayout
  {
    MarkdownLayout.make(MarkdownDocument(md), width: 332, theme: theme, layout: nil, resources: resources)
  }

  /// every text line of the layout, tables' cells included
  func lines(_ l: MarkdownLayout) -> [TextBlock.Line] {
    func walk(_ items: [Item]) -> [TextBlock.Line] {
      items.flatMap { item -> [TextBlock.Line] in
        switch item {
        case .text(let t): t.lines
        case .clip(_, let inner): walk(inner)
        default: []
        }
      }
    }
    return walk(l.items)
  }

  func runFonts(_ l: MarkdownLayout) -> [(String, CTFont, CGFloat)] {
    lines(l).flatMap { line in
      (CTLineGetGlyphRuns(line.line) as! [CTRun]).map { run in
        let f = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
        return (
          CTFontCopyPostScriptName(f) as String, f, CGFloat(CTRunGetTypographicBounds(run, CFRange(), nil, nil, nil))
        )
      }
    }
  }

  /// :-- :-: --: align a column's cells, its header too
  @Test func tableColumnsTakeTheirAlignment() {
    let l = layout("| a | b | c |\n|:--|:-:|--:|\n| x | y | z |")
    let cells = lines(l).filter { (CTLineGetStringRange($0.line).length) > 0 }
    #expect(cells.count == 6)
    // the right column's text ends where the left column's text starts from its own cell's left, mirrored
    let xs = cells.map(\.origin.x)
    #expect(xs[0] < xs[1] && xs[1] < xs[2])
    #expect(xs[3] == xs[0] && abs(xs[4] - xs[1]) < 1 && abs(xs[5] - xs[2]) < 1)
  }

  /// Chinese under the system font is as wide as the browser sets it (CoreText's own fallback carries the system
  /// font's tracking: 13.77 a character at 13.5)
  @Test func chineseUnderTheSystemFontIsSetAtItsOwnAdvance() {
    var t = testTheme
    t.fonts.body = ["-apple-system", "PingFang SC"]
    let runs = runFonts(layout("调度器把请求分成批次", theme: t))
    #expect(runs.count == 1 && abs(runs[0].2 - 10 * 13.5) < 0.01, "\(runs.map { ($0.0, $0.2) })")
  }

  /// italic Chinese is slanted (Chrome's synthetic oblique), Latin italic keeps its italic face
  @Test func italicChineseIsSlanted() {
    var t = testTheme
    t.fonts.body = ["-apple-system", "PingFang SC"]
    let runs = runFonts(layout("*斜体 italic*", theme: t))
    let cjk = runs.first { $0.0.contains("PingFang") }
    #expect(cjk.map { CTFontGetMatrix($0.1).c } == 0.25)
    #expect(runs.contains { CTFontGetSymbolicTraits($0.1).contains(.traitItalic) })
  }

  /// an emoji as the browser draws it: as tall as the text's size, on an advance of 17 at 13.5
  @Test func emojiAreTheBrowsersSize() {
    var t = testTheme
    t.fonts.body = ["-apple-system", "PingFang SC"]
    let runs = runFonts(layout("a :rocket:", theme: t))
    let emoji = runs.first { $0.0 == "AppleColorEmoji" }
    #expect(emoji.map { abs(CTFontGetSize($0.1) - 13.5 / 1.26) < 0.01 } == true)
    #expect(emoji.map { abs($0.2 - 17) < 0.05 } == true, "\(String(describing: emoji?.2))")
  }

  /// an array's column rule is drawn (MathJax gives its width in its stylesheet, not on the line)
  @Test func anArraysColumnRuleIsDrawn() throws {
    let e = try #require(engines)
    guard case .ok(let pic) = e.typeset("\\begin{array}{c|c} 1 & 2 \\end{array}", display: true, preamble: "") else {
      Issue.record("did not typeset")
      return
    }
    #expect(pic.paths.contains { $0.strokeWidth == 70 })
  }

  /// a diagram is centred in the body, with its own 4 px margins
  @Test func aDiagramIsCentred() throws {
    let e = try #require(engines)
    let l = layout("```mermaid\nflowchart LR\n  A --> B\n```", resources: MathResources(math: e))
    let frames = l.items.compactMap { item -> CGRect? in
      if case .clip(_, let inner) = item, case .diagram(_, _, let f) = inner.first { return f }
      return nil
    }
    let f = try #require(frames.first)
    #expect(abs(f.midX - 166) < 1, "\(f)")
  }
}

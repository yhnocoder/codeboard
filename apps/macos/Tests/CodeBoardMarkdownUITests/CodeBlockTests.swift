import AppKit
import CodeBoardMarkdown
import CoreGraphics
import CoreText
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// Keys in a code block as the web's code editor has them (cm/editor.ts), and colours that never hold a key up
@Suite struct CodeBlockTests {
  struct Slow: MarkdownResources {
    let calls: Calls
    final class Calls: @unchecked Sendable {
      let lock = NSLock()
      var n = 0
    }
    func imageSize(_ src: String) -> CGSize? { nil }
    func ref(label: String, target: String?) -> MarkdownRefHit? { nil }
    func highlight(lines: [String], language: String) -> [[MarkdownToken]]? {
      calls.lock.withLock { calls.n += 1 }
      // every word a keyword: enough to see colours kept and replaced
      return lines.map { line in
        var out: [MarkdownToken] = []
        var start: Int?
        for (i, u) in Array(line.utf16 + [0x20]).enumerated() {
          if u == 0x20 {
            if let s = start { out.append(MarkdownToken(columns: s..<i, kind: .keyword)) }
            start = nil
          } else if start == nil {
            start = i
          }
        }
        return out
      }
    }
    var mathPreamble: String { "" }
  }

  func core(_ src: String, _ sel: MDSelection, resources: MarkdownResources = TestResources()) -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: resources)
    let e = EditorCore(layout: l)
    e.select(sel)
    return e
  }

  @Test func enterIndentsAfterAnOpener() {
    let e = core("```py\ndef f():\n```", MDSelection(15))
    e.key(.enter)
    #expect(e.source == "```py\ndef f():\n    \n```")
  }

  @Test func tabAndShiftTab() {
    var e = core("```\nab\n```", MDSelection(5))
    e.key(.tab)
    #expect(e.source == "```\na    b\n```")
    e = core("```\nx\ny\n```", MDSelection(anchor: 4, head: 7))
    e.key(.tab)
    #expect(e.source == "```\n    x\n    y\n```")
    e.key(.shiftTab)
    #expect(e.source == "```\nx\ny\n```")
    // Tab outside code does nothing
    e = core("text", MDSelection(2))
    #expect(!e.key(.tab))
  }

  @Test func commentLinesInTheirLanguage() {
    var e = core("```python\nx = 1\n  y = 2\n```", MDSelection(anchor: 10, head: 22))
    e.toggleComment()
    #expect(e.source == "```python\n# x = 1\n#   y = 2\n```")
    e.toggleComment()
    #expect(e.source == "```python\nx = 1\n  y = 2\n```")
    e = core("```rust\nlet a;\n```", MDSelection(10))
    e.toggleComment()
    #expect(e.source == "```rust\n// let a;\n```")
  }

  @Test func backspaceInAnEmptyBlockLeavesAParagraph() {
    let e = core("Before\n\n```\n```\n\nAfter", MDSelection(12))
    #expect(MarkdownEditing.context(at: 12, in: e.document).leaf == .code)
    e.key(.backspace)
    #expect(e.source == "Before\n\n\n\nAfter")
  }

  @MainActor @Test func coloursComeOffTheKeyAndKeepTheirLines() async throws {
    let calls = Slow.Calls()
    let live = LiveHighlight(Slow(calls: calls))
    let e = core("```py\nalpha beta\ngamma\n```", MDSelection(22), resources: live)
    var redrawn = 0
    e.onLayout = { redrawn += 1 }
    let first = calls.lock.withLock { calls.n }
    #expect(first == 1)
    // a key in the second line: laid out at once with the first line's colours kept
    e.insert("x")
    #expect(e.source == "```py\nalpha beta\ngammax\n```")
    let kept = live.highlight(lines: ["alpha beta", "gammaxy"], language: "py")!
    #expect(kept[0].count == 2)
    for _ in 0..<200 where redrawn == 0 { try await Task.sleep(for: .milliseconds(5)) }
    #expect(redrawn >= 1)
    #expect(calls.lock.withLock { calls.n } >= 2)
  }
}

/// The code block's band: shown with the caret in the block, its language written into the fence, its wrap kept in the
/// layout info
@MainActor @Suite struct CodeBandTests {
  @Test func theBandFollowsTheCaretAndWritesTheFence() {
    _ = boardFonts
    let src = "Before\n\n```py {.x}\nx = 1\n```\n\nAfter"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 3)
    #expect(!v.band.shown)
    v.selection = MDSelection(20)
    #expect(v.band.shown)
    // over the block, above its top edge, 30 points tall at 100 %
    let code = v.core.rects(for: 18..<23).first!
    #expect(v.band.bandFrame.maxY <= code.minY && abs(v.band.bandFrame.height - 30) < 0.01)
    let b = v.core.codeBlock(at: 20)!
    #expect(b.language == "py" && b.index == 0)
    v.core.setLanguage("rust", of: b)
    #expect(v.core.source == "Before\n\n```rust {.x}\nx = 1\n```\n\nAfter")
    v.core.undo()
    #expect(v.core.source == src)
    let h0 = v.core.layout.size.height
    var info: MDLayoutInfo?
    v.core.onLayoutInfo = { info = $0 }
    v.core.setWrap(true, of: v.core.codeBlock(at: 20)!)
    #expect(info?.wrap == [0] && v.core.layout.info?.wrap == [0])
    #expect(v.core.layout.size.height == h0)
    v.core.setWrap(false, of: v.core.codeBlock(at: 20)!)
    #expect(v.core.layout.info == nil)
    // away from the block: it goes (after its grace)
    v.selection = MDSelection(2)
    #expect(v.core.codeBlock(at: 2) == nil)
  }
}

/// The gap beside a block with no text next to it (editor/gap.ts)
@Suite struct GapTests {
  @Test func theCaretStandsBesideACodeBlockAndTypingMakesAParagraph() {
    _ = boardFonts
    let src = "```\nx\n```"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let e = EditorCore(layout: l, caret: 4)
    e.move(.character, forward: false, extend: false)
    #expect(e.selection == MDSelection(0))
    // a short line at the block's left, above it (main's gap cursor is 20px)
    let c = e.caretRect!
    #expect(c.height == 0 && c.minX == 0 && c.width == 20 && c.minY < l.blockFrames[0].minY)
    e.insert("a")
    #expect(e.source == "a\n\n```\nx\n```")
    e.undo()
    e.move(.document, forward: true, extend: false)
    #expect(e.selection == MDSelection(9))
    e.key(.enter)
    #expect(e.source == "```\nx\n```\n\n\n\n")
  }
}

/// Each band slides in for its own block: a table's band up, then the caret into a code block, and the code block's band
/// slides in too (it once appeared at once, the band already counting as shown)
@MainActor @Suite struct BandSlideTests {
  @Test func eachBlocksBandSlidesIn() {
    _ = boardFonts
    let src = "| a | b |\n|---|---|\n| 1 | 2 |\n\n```py\nx = 1\n```"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 2)
    v.selection = MDSelection(2)
    #expect(v.band.shown && v.band.table != nil && v.band.slidesIn == 1)
    v.selection = MDSelection((src as NSString).range(of: "x = 1").location + 1)
    #expect(v.band.shown && v.band.block != nil && v.band.slidesIn == 2)
  }
}

/// The band's first show, the click that starts editing landing in a code block, slides as a later block's does: only
/// the strip's y moves (it once came in from the upper left, its frame animated from a stale place)
@MainActor @Suite struct BandFirstShowTests {
  @Test func theFirstShowSlidesOnlyUpAsALaterOne() throws {
    _ = boardFonts
    let src = "Text\n\n```py\nx = 1\n```\n\nMid\n\n```py\ny = 2\n```"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    v.isEditing = false
    let r = try #require(l.caretRect(MDCaret(14)))
    v.enter(at: CGPoint(x: r.midX, y: r.midY))
    func slide() throws -> (String?, CGFloat?, CGFloat?) {
      // nothing but the slide moves: no frame of the band or its layers animates
      for layer in [v.band.layer, v.band.subviews.first?.layer, v.band.subviews.first?.subviews.first?.layer] {
        let keys = layer?.animationKeys() ?? []
        #expect(keys.allSatisfy { $0 == CodeBand.slideKey }, "\(keys)")
      }
      let a = try #require(v.band.lastSlide)
      return (a.keyPath, a.fromValue as? CGFloat, a.toValue as? CGFloat)
    }
    #expect(v.band.shown && v.band.slidesIn == 1)
    let first = try slide()
    #expect(first.0 == "transform.translation.y" && first.2 == 0 && (first.1 ?? 0) > 0)
    v.selection = MDSelection((src as NSString).range(of: "y = 2").location + 1)
    #expect(v.band.shown && v.band.slidesIn == 2)
    let later = try slide()
    #expect(first == later)
  }
}

/// The code band sits on the block's top edge, no gap between them (one shape, as on the web)
@MainActor @Suite struct CodeBandEdgeTests {
  @Test func theBandTouchesTheBlock() {
    _ = boardFonts
    let src = "Text\n\n```py\nx = 1\n```"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    v.selection = MDSelection(14)
    #expect(v.band.shown)
    let first = l.caretRect(MDCaret(14))!
    let panel = l.panel(around: CGPoint(x: first.midX, y: first.midY), of: 14, color: testTheme.colors.codeBlock)!
    #expect(abs(v.band.bandFrame.maxY - panel.minY) < 0.5, "\(v.band.bandFrame) \(panel)")
    // in a look with margins round code blocks too
    var t = testTheme
    t.metrics.codeMargin = 8
    let l2 = BlockLayout(MarkdownDocument(src), width: 300, theme: t, layout: nil, resources: TestResources())
    let w = MarkdownEditorView(layout: l2, caret: 0)
    w.selection = MDSelection(14)
    let f2 = l2.caretRect(MDCaret(14))!
    let p2 = l2.panel(around: CGPoint(x: f2.midX, y: f2.midY), of: 14, color: t.colors.codeBlock)!
    #expect(abs(w.band.bandFrame.maxY - p2.minY) < 0.5, "\(w.band.bandFrame) \(p2)")
  }
}

/// The band's face is where its box is: its strip, shown, ends on the block's edge (an unflipped clip once lifted it 8 pt)
@MainActor @Suite struct BandFaceTests {
  @Test func theFaceEndsOnTheEdge() {
    _ = boardFonts
    let src = "Text\n\n```py\nx = 1\n```"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    v.selection = MDSelection(14)
    // the strip is the fade (10) over the face (30)
    #expect(abs(v.band.stripFrame.maxY - v.band.bandFrame.maxY) < 0.5, "\(v.band.stripFrame) \(v.band.bandFrame)")
  }
}

/// A code block is laid out as code is (CodeLines): a tab goes to the next stop four columns apart (markdown.css
/// .md-pm pre tab-size: 4), and a wrapped block cuts a line wherever it reaches the width, by what each character is
/// drawn as (.md-code.wrap: break-all), a CJK character taking its own width
@Suite struct CodeBlockLayoutTests {
  @Test func tabsGoToTheirStopsAndWrappedLinesAreCutAtTheWidth() throws {
    _ = boardFonts
    let long = String(repeating: "中文", count: 30)
    let src = "```python\n\tx = 1\nab\tc\n\(long)\nx = \(String(repeating: "y", count: 100))\n```"
    let l = MarkdownLayout.make(
      MarkdownDocument(src), width: 300, theme: testTheme, layout: MDLayoutInfo(wrap: [0]), resources: TestResources())
    let texts = l.caretTexts
    let shown = texts.map { $0.display.string.string }
    #expect(shown.prefix(2) == ["    x = 1", "ab  c"])
    // not at a word's end: wherever the width is reached
    for text in [long, "x = " + String(repeating: "y", count: 100)] {
      let wide = try #require(texts.first { $0.display.string.string == text })
      let room = wide.frame.width
      #expect(wide.lines.count > 1)
      for line in wide.lines.dropLast() {
        let w = CGFloat(CTLineGetTypographicBounds(line.line, nil, nil, nil))
        // as full as a row gets: one more character would not have fitted
        let one = w / CGFloat(line.range.length)
        #expect(w <= room + 0.5 && w + one > room - 0.5, "\(w) of \(room)")
      }
    }
    // a caret after the tab is at its stop
    #expect(texts[0].display.toSource.prefix(4).allSatisfy { $0 == texts[0].display.toSource[0] })
  }
}

import CodeBoardMarkdown
import CoreGraphics
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

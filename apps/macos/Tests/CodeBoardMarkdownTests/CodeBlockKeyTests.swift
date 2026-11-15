import Foundation
import Testing

@testable import CodeBoardMarkdown

/// Keys in a code block and in a block shown as its source (cm/editor.ts): the rules the code component's CodeEditing
/// has, as the Markdown editor uses them. The edit's undo kind too: typing joins the step before, a whole-line change does
/// not
@Suite struct CodeBlockKeyTests {
  func press(_ key: MDKey, _ src: String, _ sel: MDSelection) -> (String, MDSelection, MDUndoKind)? {
    let state = MDEditState(source: src, selection: sel)
    guard let e = MarkdownEditing.key(key, in: state, document: MarkdownDocument(src)) else { return nil }
    return (apply(e, src), e.selection, e.undo)
  }

  func apply(_ e: MDEdit, _ src: String) -> String {
    (src as NSString).replacingCharacters(
      in: NSRange(location: e.range.lowerBound, length: e.range.count), with: e.replacement)
  }

  @Test func enterKeepsTheIndentAndDeepensAfterAnOpener() {
    #expect(press(.enter, "```py\ndef f():\n```", MDSelection(14))?.0 == "```py\ndef f():\n    \n```")
    let kept = press(.enter, "```\n\t  x = 1\n```", MDSelection(12))
    #expect(kept?.0 == "```\n\t  x = 1\n\t  \n```" && kept?.1 == MDSelection(16) && kept?.2 == .typing)
    // a block shown as its source keeps the indent only
    #expect(press(.enter, "<div>\n  <p>{\n</div>", MDSelection(12))?.0 == "<div>\n  <p>{\n  \n</div>")
    // over a selection, the indent before its start
    #expect(press(.enter, "```\n  ab(cd\n```", MDSelection(anchor: 9, head: 10))?.0 == "```\n  ab(\n      d\n```")
  }

  @Test func tabIndentsAndShiftTabOutdentsTheLines() {
    let one = press(.tab, "```\nab\n```", MDSelection(5))
    #expect(one?.0 == "```\na    b\n```" && one?.1 == MDSelection(9) && one?.2 == .typing)
    let two = press(.tab, "```\nx\n\ny\n```", MDSelection(anchor: 4, head: 8))
    #expect(two?.0 == "```\n    x\n\n    y\n```" && two?.1 == MDSelection(anchor: 8, head: 16) && two?.2 == .command)
    let back = press(.shiftTab, "```\n    x\n\ty\n      z\n```", MDSelection(anchor: 6, head: 20))
    #expect(back?.0 == "```\nx\ny\n  z\n```")
    #expect(back?.1 == MDSelection(anchor: 4, head: 11))
    #expect(back?.2 == .command)
    // ⇧Tab with a caret: its line only
    #expect(press(.shiftTab, "```\n  a\n  b\n```", MDSelection(6))?.0 == "```\na\n  b\n```")
    #expect(press(.tab, "text", MDSelection(2)) == nil)
  }

  @Test func commentsInTheLanguagesLineComment() {
    func toggle(_ src: String, _ sel: MDSelection, _ lang: String?) -> String? {
      let state = MDEditState(source: src, selection: sel)
      return MarkdownEditing.toggleComment(in: state, document: MarkdownDocument(src), language: lang).map {
        apply($0, src)
      }
    }
    let src = "```python\nx = 1\n\n  y = 2\n```"
    let on = toggle(src, MDSelection(anchor: 10, head: 23), "python")
    #expect(on == "```python\n# x = 1\n\n#   y = 2\n```")
    #expect(toggle(on ?? "", MDSelection(anchor: 10, head: 27), "python") == src)
    #expect(toggle("```rust\nlet a;\n```", MDSelection(10), "rust") == "```rust\n// let a;\n```")
    #expect(toggle("```sql\n  select 1\n```", MDSelection(10), "SQL") == "```sql\n  -- select 1\n```")
    #expect(toggle("```\n//x\n```", MDSelection(5), nil) == "```\nx\n```")
    #expect(toggle("text", MDSelection(1), "python") == nil)
  }
}

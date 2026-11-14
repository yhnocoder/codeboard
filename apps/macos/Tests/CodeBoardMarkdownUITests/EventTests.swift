import AppKit
import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The editor's events: what an inspector or a test driver sees, and nothing while nobody observes
@MainActor @Suite struct EventTests {
  /// a switch a host makes is timed from itself, not from the last key (the inspector once showed seconds for it)
  @Test func enteringEditingIsTimedFromItsOwnStart() {
    _ = boardFonts
    let l = BlockLayout(
      MarkdownDocument("a b c"), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    var editing: Double?
    v.observer = { e, ms in if case .editing = e { editing = ms } }
    v.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
    // CPU spent elsewhere after the key
    let start = BlockLayout.cpu()
    var n = 0.0
    while BlockLayout.cpu() - start < 120 { n += 1 }
    v.isEditing = false
    #expect(n > 0 && (editing ?? 999) < 60)
  }

  @Test func editsUndoKeysAndRevealsAreReported() {
    _ = boardFonts
    let l = BlockLayout(
      MarkdownDocument("a **b** c"), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    var lines: [String] = []
    var costs: [Double] = []
    v.observer = { e, ms in
      lines.append(e.line)
      costs.append(ms)
    }
    v.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
    v.doCommand(by: #selector(NSResponder.moveRight(_:)))
    v.doCommand(by: #selector(NSResponder.moveRight(_:)))
    v.undo(nil)
    #expect(lines.contains { $0.hasPrefix("edit 0..<0 \"\" → \"x\"") })
    #expect(lines.contains { $0.hasPrefix("type \"x\"") })
    #expect(lines.contains { $0.hasPrefix("moveRight:") })
    #expect(lines.contains { $0.hasPrefix("reveal at 3") })
    #expect(lines.contains("undo"))
    #expect(costs.allSatisfy { $0 >= 0 })
    // nobody watching: nothing built
    v.observer = nil
    #expect(v.core.observer == nil)
  }
}

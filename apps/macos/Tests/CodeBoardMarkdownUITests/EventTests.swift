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

/// A change a host makes (a block move, a width written on release) is timed from its own start, not from the last input
/// the editor timed (seconds showed in the inspector)
@MainActor @Suite struct HostEditTimingTests {
  @Test func timedFromItsStart() {
    _ = boardFonts
    let l = BlockLayout(
      MarkdownDocument("One\n\nTwo"), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    var last: Double?
    v.observer = { e, ms in if case .edit = e { last = ms } }
    v.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
    let start = BlockLayout.cpu()
    var n = 0.0
    while BlockLayout.cpu() - start < 120 { n += 1 }
    // without an input event of the view's: a host's edit
    v.core.apply(MDEdit(range: 0..<0, replacement: "y", selection: MDSelection(1), undo: .command))
    #expect(n > 0 && (last ?? 999) < 60)
  }
}

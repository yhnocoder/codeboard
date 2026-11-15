import AppKit
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

/// The one-line field names and seals are written in: nothing typed is handed on or cleaned while an input method is
/// composing; once it ends, the cleaned text is; Return commits it
@MainActor @Suite struct NameFieldTests {
  @Test func whatIsBeingComposedIsNeitherCleanedNorAppliedUntilTheCompositionEnds() throws {
    _ = NSApplication.shared
    var changes: [String] = []
    var committed: String?
    let spec = NameField(
      text: "", clean: Seal.clean, changed: { changes.append($0) }, commit: { committed = $0 }, cancel: {})
    let coordinator = spec.makeCoordinator()
    let field = NSTextField(string: "")
    field.delegate = coordinator
    let window = NSWindow(
      contentRect: CGRect(x: -30000, y: -30000, width: 300, height: 60), styleMask: [.titled], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    window.contentView?.addSubview(field)
    field.frame = CGRect(x: 10, y: 10, width: 200, height: 22)
    #expect(window.makeFirstResponder(field))
    let editor = try #require(field.currentEditor() as? NSTextView)
    let none = NSRange(location: NSNotFound, length: 0)
    // pinyin with a space in it, as an input method shows it while composing
    editor.setMarkedText("diao du", selectedRange: NSRange(location: 7, length: 0), replacementRange: none)
    #expect(editor.hasMarkedText())
    #expect(changes.isEmpty && field.stringValue == "diao du")
    editor.insertText("调度", replacementRange: none)
    #expect(changes == ["调度"])
    // typed outside a composition: cleaned at once (no spaces in a seal)
    editor.insertText(" K", replacementRange: none)
    #expect(changes.last == "调度K" && field.stringValue == "调度K")
    editor.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    #expect(committed == "调度K")
  }
}

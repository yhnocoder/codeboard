import AppKit
import CodeBoardTestGuard
import Foundation
import Testing

@testable import MarkdownEditorDemo

/// The component's own demo: a .md file opened in its window, edited and written back
@MainActor @Suite struct EditorDemoTests {
  @Test func aFileIsShownEditedAndWrittenBack() throws {
    TestGuard.install()
    let file = FileManager.default.temporaryDirectory.appending(path: "editor-demo-\(UUID().uuidString).md")
    defer { try? FileManager.default.removeItem(at: file) }
    try "# Title\n\nSome words.".write(to: file, atomically: true, encoding: .utf8)
    let demo = try EditorDemo(file: file)
    // the window made and laid out, never shown
    let editor = try #require(demo.editor)
    #expect(editor.core.source == "# Title\n\nSome words.")
    #expect(demo.window.title == file.lastPathComponent)
    #expect(editor.frame.height > 40 && editor.frame.minY == EditorDemo.margin, "laid out at the page's top")
    editor.insertText(" More", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(editor.core.source.contains("More") && demo.window.isDocumentEdited)
    try demo.save()
    #expect(try String(contentsOf: file, encoding: .utf8) == editor.core.source)
    #expect(!demo.window.isDocumentEdited)
  }
}

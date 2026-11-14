import AppKit
import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The menus typed into the text (editor/menu.tsx): / blocks, [[ references, : emoji
@MainActor @Suite struct MenuTests {
  final class Host: MarkdownEditorDelegate {
    func editor(_ e: MarkdownEditorView, didResize size: CGSize) {}
    func editorWantsToEnd(_ e: MarkdownEditorView) {}
    func editorDidBegin(_ e: MarkdownEditorView) {}
    func editor(_ e: MarkdownEditorView, didChange source: String) {}
    func editor(_ e: MarkdownEditorView, refCandidates query: String) -> [MarkdownRefCandidate] {
      [MarkdownRefCandidate(label: "Plan", target: "a1", title: "Plan", crumb: "Board")].filter {
        query.isEmpty || $0.title.lowercased().hasPrefix(query.lowercased())
      }
    }
  }

  func view(_ src: String, _ caret: Int) -> (MarkdownEditorView, Host) {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: caret)
    let h = Host()
    v.delegate = h
    v.selection = MDSelection(caret)
    return (v, h)
  }

  func type(_ v: MarkdownEditorView, _ s: String) {
    for ch in s { v.insertText(String(ch), replacementRange: NSRange(location: NSNotFound, length: 0)) }
  }

  @Test func slashWritesABlock() {
    let (v, _) = view("Before\n\nx", 9)
    v.core.key(.backspace)
    type(v, "/he")
    #expect(v.typedMenu.shown && v.typedMenu.items.map(\.title).prefix(3) == ["Heading 1", "Heading 2", "Heading 3"])
    v.doCommand(by: #selector(NSResponder.moveDown(_:)))
    v.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    #expect(v.core.source == "Before\n\n## ")
    let (w, _) = view("Text", 4)
    type(w, " /cod")
    w.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    #expect(w.core.source == "Text \n\n```\n\n```")
    // no menu inside a word
    let (u, _) = view("a", 1)
    type(u, "/x")
    #expect(!u.typedMenu.shown)
  }

  @Test func referencesFromTheHost() {
    let (v, host) = view("See ", 4)
    defer { withExtendedLifetime(host) {} }
    type(v, "[[")
    #expect(v.core.source == "See [[]]" || v.core.source == "See [[")
    type(v, "pl")
    #expect(v.typedMenu.shown && v.typedMenu.items.first?.title == "Plan")
    v.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    #expect(v.core.source == "See [[Plan#^a1]]")
  }

  @Test func emojiByName() {
    let (v, _) = view("Yay ", 4)
    type(v, ":tad")
    #expect(v.typedMenu.shown && v.typedMenu.items.first?.id == "tada")
    v.doCommand(by: #selector(NSResponder.insertTab(_:)))
    #expect(v.core.source == "Yay :tada:")
    // Esc closes it for that trigger
    type(v, " :smi")
    v.doCommand(by: #selector(NSResponder.cancelOperation(_:)))
    #expect(!v.typedMenu.shown)
    type(v, "l")
    #expect(!v.typedMenu.shown)
  }
}

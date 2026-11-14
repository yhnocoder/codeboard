import AppKit
import CodeBoardMarkdown
import Foundation
import Testing

@testable import CodeBoardMarkdownUI

/// The link box's writes (editor/links.ts, bubble.tsx)
@MainActor @Suite struct LinkTests {
  func core(_ src: String, _ sel: MDSelection) -> EditorCore {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let e = EditorCore(layout: l)
    e.select(sel)
    return e
  }

  func state(_ e: EditorCore) -> MDEditState { MDEditState(source: e.source, selection: e.selection) }

  @Test func newChangedAndRemovedLinks() {
    var e = core("See the docs here.", MDSelection(anchor: 8, head: 12))
    var p = MarkdownEditing.linkPlace(in: state(e), document: e.document)!
    #expect(!p.exists && p.text == "docs")
    e.apply(MarkdownEditing.writeLink(p, text: "docs", url: "https://example.com")!)
    #expect(e.source == "See the [docs](https://example.com) here.")
    // the caret in it: the link's text and address
    e.select(MDSelection(10))
    p = MarkdownEditing.linkPlace(in: state(e), document: e.document)!
    #expect(p.exists && p.text == "docs" && p.url == "https://example.com")
    #expect(MarkdownEditing.writeLink(p, text: "docs", url: "https://example.com") == nil)
    e.apply(MarkdownEditing.writeLink(p, text: "the [docs", url: "a path/with space")!)
    #expect(e.source == "See the [the \\[docs](<a path/with space>) here.")
    e = core("See [docs](https://x.y) here.", MDSelection(6))
    p = MarkdownEditing.linkPlace(in: state(e), document: e.document)!
    e.apply(MarkdownEditing.writeLink(p, text: p.text, url: "")!)
    #expect(e.source == "See docs here.")
    // nothing selected and no address: nothing written
    e = core("Plain.", MDSelection(2))
    p = MarkdownEditing.linkPlace(in: state(e), document: e.document)!
    #expect(MarkdownEditing.writeLink(p, text: "", url: "") == nil)
  }
}

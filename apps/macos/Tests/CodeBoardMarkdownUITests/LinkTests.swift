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

/// The link box closes when a press lands elsewhere in the Note, writing what changed and nothing else (it stayed open
/// after a click into other text)
@MainActor @Suite struct LinkBoxLeaveTests {
  func view(_ src: String, caret: Int) -> MarkdownEditorView {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    return MarkdownEditorView(layout: l, caret: caret)
  }

  @Test func aPressElsewhereClosesIt() {
    let v = view("Some text here.\n\nSee [the docs](https://x.y) now.", caret: 22)
    v.openLinkBox()
    #expect(!v.linkBox.isHidden)
    v.leaveLinkBox(later: true)
    #expect(v.linkBox.isHidden)
    v.mouseUp(with: NSEvent())
    #expect(v.core.source == "Some text here.\n\nSee [the docs](https://x.y) now.")
    // a changed address is written when the box is left, the caret kept where it was
    v.selection = MDSelection(22)
    v.openLinkBox()
    v.linkBox.url.stringValue = "https://z.w"
    v.selection = MDSelection(3)
    v.leaveLinkBox(later: false)
    #expect(v.core.source == "Some text here.\n\nSee [the docs](https://z.w) now." && v.core.selection.head == 3)
  }
}

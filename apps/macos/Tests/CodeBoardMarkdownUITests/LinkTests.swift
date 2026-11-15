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

/// A plain click on a link the caret is not in opens its box and leaves the caret alone: no source revealed, nothing
/// reflowed (session.ts handleClick); a click in the link the caret is in places the caret, one on its folded address
/// opens the box
@MainActor @Suite struct LinkClickTests {
  @Test func aClickOnALinkOpensItsBoxWithoutMovingTheCaret() {
    _ = boardFonts
    let src = "Some text here.\n\nSee [the docs](https://example.com/a/long/path) now."
    let l = BlockLayout(MarkdownDocument(src), width: 400, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 3)
    v.isEditing = true
    func click(_ p: CGPoint) {
      for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
        // a view with no window takes window points as its own, its y counted from the bottom
        let ev = NSEvent.mouseEvent(
          with: t, location: CGPoint(x: p.x, y: v.bounds.height - p.y), modifierFlags: [], timestamp: 0,
          windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        if t == .leftMouseDown { v.mouseDown(with: ev) } else { v.mouseUp(with: ev) }
      }
    }
    let docs = v.core.rects(for: 26..<30)[0]
    let head = v.core.layout.head
    let frames = v.core.layout.blockFrames
    click(CGPoint(x: docs.midX, y: docs.midY))
    #expect(!v.linkBox.isHidden && v.linkBox.place?.text == "the docs")
    #expect(v.core.selection == MDSelection(3) && v.core.layout.head == head && v.core.layout.blockFrames == frames)
    // what the box holds is written when it closes, the caret where it was
    v.linkBox.url.stringValue = "https://z.w"
    v.leaveLinkBox(later: false)
    #expect(
      v.core.source == "Some text here.\n\nSee [the docs](https://z.w) now." && v.core.selection == MDSelection(3))
    // in the link the caret is in: the caret goes there, no box
    v.selection = MDSelection(24)
    let the = v.core.rects(for: 22..<25)[0]
    click(CGPoint(x: the.midX, y: the.midY))
    #expect(v.linkBox.isHidden && v.core.selection.head >= 22 && v.core.selection.head <= 25)
    // its address folded to a chip while the caret is in its text: a click on the chip opens the box
    v.selection = MDSelection(24)
    let chip = v.core.rects(for: 32..<43).last!
    click(CGPoint(x: chip.maxX - 2, y: chip.midY))
    #expect(!v.linkBox.isHidden && v.core.selection == MDSelection(24))
  }
}

/// The link box stays inside the Note's width when it fits (it hung past the right edge for a link near it)
@MainActor @Suite struct LinkBoxPlaceTests {
  @Test func insideTheNote() {
    _ = boardFonts
    let src = "Some words at the start of a line and then [the docs](https://x.y)"
    let l = BlockLayout(MarkdownDocument(src), width: 400, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 50)
    v.openLinkBox()
    #expect(!v.linkBox.isHidden && v.linkBox.frame.maxX <= v.bounds.width + 0.5, "\(v.linkBox.frame) \(v.bounds)")
  }
}

/// A plain click on a drawn [[reference]] goes to the host first; taken, the caret stays where it was (onRef)
@MainActor @Suite struct RefActivateTests {
  final class Host: MarkdownEditorDelegate {
    var take = true
    var asked: [String] = []
    func editor(_ e: MarkdownEditorView, didChange source: String) {}
    func editor(_ e: MarkdownEditorView, didResize size: CGSize) {}
    func editorWantsToEnd(_ e: MarkdownEditorView) {}
    func editorDidBegin(_ e: MarkdownEditorView) {}
    func editor(_ e: MarkdownEditorView, activate label: String, target: String?) -> Bool {
      asked.append(label)
      return take
    }
  }

  @Test func theHostTakesIt() {
    _ = boardFonts
    let src = "See [[Step one]] here"
    let l = BlockLayout(MarkdownDocument(src), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    let host = Host()
    v.delegate = host
    let w = NSWindow(
      contentRect: CGRect(origin: .zero, size: l.size), styleMask: [.borderless], backing: .buffered, defer: true)
    w.isReleasedWhenClosed = false
    w.contentView = NSView(frame: CGRect(origin: .zero, size: l.size))
    w.contentView!.addSubview(v)
    let box = l.rects(forAtom: 4..<16)!
    func click() {
      for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
        let ev = NSEvent.mouseEvent(
          with: t, location: v.convert(CGPoint(x: box.midX, y: box.midY), to: nil), modifierFlags: [], timestamp: 0,
          windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        if t == .leftMouseDown { v.mouseDown(with: ev) } else { v.mouseUp(with: ev) }
      }
    }
    v.selection = MDSelection(0)
    click()
    #expect(host.asked == ["Step one"] && v.core.selection == MDSelection(0))
    host.take = false
    click()
    #expect(host.asked.count == 2 && v.core.selection.head > 4 && v.core.selection.head < 16)
    w.close()
  }
}

/// Long addresses fold to their site (url.ts): a bare one away from the caret; a [text](url) link's with the caret in its
/// text, as a chip; written out with the caret in the address
@Suite struct AddressFoldTests {
  func shown(_ src: String, head: Int?) -> String {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: 600, theme: testTheme, layout: nil, resources: TestResources())
    _ = l.setHead(head)
    return l.pieces.flatMap { $0.layout.caretTexts }.map { $0.display.string.string }.joined()
  }

  @Test func foldedToTheSite() {
    let bare = "See https://github.com/yhnocoder/codeboard/pull/214/files#diff here"
    #expect(shown(bare, head: nil).contains("github.com/…") && !shown(bare, head: nil).contains("/pull/214"))
    let link = "A [docs](https://example.com/very/long/path) b"
    // caret in the text: [docs]( and the site
    #expect(shown(link, head: 5).contains("[docs](example.com/…") && !shown(link, head: 5).contains("very/long"))
    // caret in the address: written out
    #expect(shown(link, head: 20).contains("https://example.com/very/long/path"))
    #expect(InlineBuilder.shortURL("https://www.example.com") == "example.com")
  }
}

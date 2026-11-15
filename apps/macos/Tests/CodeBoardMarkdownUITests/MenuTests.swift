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

/// The [[ menu as main groups it: recent, the local ones under their name, each other place's row and three of its items
/// with "N more", which lists the rest in place; the place's own row writes a reference to the place
@MainActor @Suite struct RefMenuGroupTests {
  final class Host: MarkdownEditorDelegate {
    var picked: [String] = []
    func editor(_ e: MarkdownEditorView, didResize size: CGSize) {}
    func editorWantsToEnd(_ e: MarkdownEditorView) {}
    func editorDidBegin(_ e: MarkdownEditorView) {}
    func editor(_ e: MarkdownEditorView, didChange source: String) {}
    func editor(_ e: MarkdownEditorView, refMenu query: String) -> MarkdownRefMenu {
      let c = { (t: String) in MarkdownRefCandidate(label: t, target: nil, title: t) }
      return MarkdownRefMenu(
        recent: [c("Last one")], here: "This board", local: [c("Plan")],
        groups: [
          MarkdownRefGroup(
            id: "g", title: "Other board", place: c("Other board"), note: "5 cards",
            items: ["A", "B", "C", "D", "E"].map(c))
        ], foot: "6 titled cards · 2 boards")
    }
    func editor(_ e: MarkdownEditorView, pickedRef r: MarkdownRefCandidate) { picked.append(r.label) }
  }

  @Test func groupsAndMore() {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument("See "), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 4)
    let host = Host()
    v.delegate = host
    v.selection = MDSelection(4)
    for ch in "[[" { v.insertText(String(ch), replacementRange: NSRange(location: NSNotFound, length: 0)) }
    let rows = v.typedMenu.items
    #expect(
      rows.map(\.title) == [
        "Recent", "Last one", "This board", "Plan", "Other board", "A", "B", "C", "2 more in Other board",
      ])
    #expect(v.typedMenu.items[v.typedMenu.chosen].title == "Last one")
    // the line under the rows (.md-foot), below the last row
    #expect(v.typedMenu.foot == "6 titled cards · 2 boards")
    #expect(v.typedMenu.frame.height == CGFloat(rows.count) * 26 + 8 + 25)
    // "N more" lists the rest in place
    v.typedMenu.onTake(rows.last!)
    #expect(v.typedMenu.items.map(\.title).suffix(5) == ["A", "B", "C", "D", "E"])
    // the place's own row writes a reference to the place
    v.typedMenu.onTake(v.typedMenu.items.first { $0.style == .brow }!)
    #expect(v.core.source.hasPrefix("See [[Other board") && host.picked == ["Other board"])
  }
}

/// A field whose holder cuts what hangs out of it (a popup's tray while it scrolls): its [[ list goes over the host it
/// names, where it would be
@MainActor @Suite struct LiftedMenuTests {
  @Test func theListIsLiftedIntoItsHost() {
    _ = boardFonts
    let host = FlippedHost(frame: CGRect(x: 0, y: 0, width: 600, height: 400))
    let clip = FlippedHost(frame: CGRect(x: 20, y: 30, width: 320, height: 40))
    clip.clipsToBounds = true
    host.addSubview(clip)
    let l = BlockLayout(MarkdownDocument("See "), width: 300, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 4)
    clip.addSubview(v)
    let h = RefMenuGroupTests.Host()
    v.delegate = h
    v.floatHost = host
    v.selection = MDSelection(4)
    for ch in "[[" { v.insertText(String(ch), replacementRange: NSRange(location: NSNotFound, length: 0)) }
    #expect(v.typedMenu.shown && v.typedMenu.superview === host)
    let caret = host.convert(v.core.caretRect ?? .zero, from: v)
    #expect(abs(v.typedMenu.frame.minY - (caret.maxY + 4)) < 0.5, "\(v.typedMenu.frame) under \(caret)")
  }

  final class FlippedHost: NSView {
    override var isFlipped: Bool { true }
  }
}

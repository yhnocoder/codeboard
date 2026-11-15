import AppKit
import CodeBoardMarkdown
import Testing

@testable import CodeBoardMarkdownUI

/// An unwrapped code block with a line longer than its panel scrolls its lines across inside the panel (they were cut
/// off at its right edge): the caret typed or moved past the edge scrolls into view, clicks and selections map through
/// the offset, a sideways wheel over the block scrolls it and a vertical one does not, and the panel stays put
@MainActor @Suite struct CodeScrollTests {
  static let long = "let total = first_value + second_value + third_value + fourth_value + fifth_value + sixth_value"
  static let src = "Intro line.\n\n```\nshort\n\(long)\nend\n```\n\nAfter."

  func view(_ src: String = src, width: CGFloat = 320) -> MarkdownEditorView {
    _ = boardFonts
    let l = BlockLayout(MarkdownDocument(src), width: width, theme: testTheme, layout: nil, resources: TestResources())
    let v = MarkdownEditorView(layout: l, caret: 0)
    v.isEditing = true
    return v
  }

  var lineEnd: Int { (Self.src as NSString).range(of: Self.long).upperBound }

  @Test func theCaretAtALongLinesEndIsInView() throws {
    let v = view()
    let panel = try #require(v.core.layout.codeScrolls.first)
    #expect(panel.room > 100)
    v.selection = MDSelection(lineEnd)
    let r = try #require(v.core.caretRect)
    #expect(r.maxX <= panel.box.maxX - 12 + 0.5)
    #expect(r.minX >= panel.box.minX)
    #expect(r.maxX <= v.core.layout.width)
    #expect((v.core.layout.codeScrollX[panel.start] ?? 0) > 0)
    // the panel did not move with the lines
    #expect(v.core.layout.codeScrolls.first?.box == panel.box)
    // back to the line's start: scrolled back so it shows again
    v.selection = MDSelection(lineEnd - (Self.long as NSString).length)
    #expect((v.core.layout.codeScrollX[panel.start] ?? 0) == 0)
  }

  @Test func commandRightAndTypingScrollTheCaretIntoView() throws {
    let v = view()
    v.selection = MDSelection(lineEnd - (Self.long as NSString).length)
    let panel = try #require(v.core.layout.codeScrolls.first)
    v.doCommand(by: #selector(NSResponder.moveToEndOfLine(_:)))
    #expect(v.core.selection.head == lineEnd)
    #expect(try #require(v.core.caretRect).maxX <= panel.box.maxX - 12 + 0.5)
    let s = try #require(v.core.layout.codeScrollX[panel.start])
    v.insertText(" + seventh", replacementRange: NSRange(location: NSNotFound, length: 0))
    let after = try #require(v.core.layout.codeScrolls.first)
    #expect(after.room > panel.room)
    #expect(try #require(v.core.caretRect).maxX <= after.box.maxX - 12 + 0.5)
    #expect((v.core.layout.codeScrollX[after.start] ?? 0) > s)
  }

  @Test func aClickAtAScrolledOffsetLandsOnTheSameCharacter() throws {
    let v = view()
    v.selection = MDSelection(lineEnd)
    let s = try #require(v.core.layout.codeScrollX.values.first)
    #expect(s > 0)
    // the character 20 before the end: where it is drawn, a click finds it again
    let target = lineEnd - 20
    let box = try #require(v.core.layout.selectionRects(target..<(target + 1)).first)
    #expect(box.minX > 0 && box.maxX < v.core.layout.width)
    v.core.mouseDown(at: CGPoint(x: box.minX + 1, y: box.midY), clicks: 1, extend: false)
    v.core.mouseUp()
    #expect(v.core.selection.head == target)
    // the click moved the caret inside the view: the offset stays
    #expect(v.core.layout.codeScrollX.values.first == s)
    // the caret drawn where the selection box of that character starts
    let c = try #require(v.core.caretRect)
    #expect(abs(c.minX - box.minX) < 0.5)
  }

  @Test func otherTextDoesNotScrollWithTheCode() throws {
    let v = view()
    let before = try #require(v.core.layout.caretRect(MDCaret(3)))
    v.selection = MDSelection(lineEnd)
    #expect((v.core.layout.codeScrollX.values.first ?? 0) > 0)
    #expect(v.core.layout.caretRect(MDCaret(3)) == before)
    // the short line in the same block does scroll, and a selection on it is cut at the panel
    let short = (Self.src as NSString).range(of: "short").location
    let panel = try #require(v.core.layout.codeScrolls.first)
    #expect(try #require(v.core.layout.caretRect(MDCaret(short))).minX < panel.box.minX)
    let cut = try #require(v.core.layout.selectionRects(short..<(short + 5)).first)
    #expect(cut.minX >= panel.box.minX && cut.width == 0)
  }

  @Test func wrappedCodeDoesNotScroll() {
    _ = boardFonts
    let l = BlockLayout(
      MarkdownDocument(Self.src), width: 320, theme: testTheme, layout: MDLayoutInfo(wrap: [0]),
      resources: TestResources())
    #expect(l.codeScrolls.isEmpty)
  }

  @Test func aSidewaysWheelScrollsTheBlockAndAVerticalOneDoesNot() throws {
    let v = view()
    v.frame.origin = .zero
    let panel = try #require(v.core.layout.codeScrolls.first)
    let at = CGPoint(x: panel.box.midX, y: panel.box.midY)
    func wheel(dx: Int32, dy: Int32, shift: Bool = false, phase: Int64 = 0) {
      let cg = CGEvent(
        scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)!
      cg.location = at
      if shift { cg.flags = .maskShift }
      cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
      // with no window an event's place is in screen points: moved so that it lands on `at` in the view
      let seen = v.convert(NSEvent(cgEvent: cg)!.locationInWindow, from: nil)
      cg.location = CGPoint(x: at.x + at.x - seen.x, y: at.y + at.y - seen.y)
      v.scrollWheel(with: NSEvent(cgEvent: cg)!)
    }
    // a trackpad gesture that starts mostly vertical stays vertical, however sideways it turns
    wheel(dx: -1, dy: -20, phase: 1)
    wheel(dx: -30, dy: -2, phase: 2)
    wheel(dx: -30, dy: 0, phase: 2)
    #expect(v.core.layout.codeScrollX.isEmpty)
    wheel(dx: 0, dy: 0, phase: 4)
    wheel(dx: 0, dy: -30)
    #expect(v.core.layout.codeScrollX.isEmpty)
    wheel(dx: -2, dy: -30)
    #expect(v.core.layout.codeScrollX.isEmpty)
    wheel(dx: -40, dy: 0)
    let s = try #require(v.core.layout.codeScrollX[panel.start])
    #expect(s > 0)
    wheel(dx: 0, dy: -40, shift: true)
    #expect((v.core.layout.codeScrollX[panel.start] ?? 0) > s)
    // the scroll by hand stays while the selection and the text do not change
    v.selection = v.core.selection
    #expect((v.core.layout.codeScrollX[panel.start] ?? 0) > s)
  }

  @Test func leavingEditingResetsTheScroll() throws {
    let v = view()
    v.selection = MDSelection(lineEnd)
    #expect(!v.core.layout.codeScrollX.isEmpty)
    v.isEditing = false
    #expect(v.core.layout.codeScrollX.isEmpty)
  }

  @Test func aCodeBlockInAListScrollsOnItsOwn() throws {
    let src = "- item\n\n  ```\n  \(Self.long)\n  ```\n- next"
    let v = view(src)
    let end = (src as NSString).range(of: Self.long).upperBound
    v.selection = MDSelection(end)
    let panel = try #require(v.core.layout.codeScrolls.first)
    let r = try #require(v.core.caretRect)
    #expect(r.maxX <= panel.box.maxX - 12 + 0.5)
    // the list's text is where it was
    #expect(v.core.layout.caretRect(MDCaret(2))!.minX > 0)
  }
}

import AppKit
import CodeBoardModel
import MarkdownCore
import Testing

@testable import CodeBoardCanvas

// Text selected in a Note at rest (interact.ts solo inBody, ui/StaticFormat.tsx, actions/format.ts): a drag on the
// body of the one card selected selects its text and leaves the card where it is; its bar comes up once it settles;
// ⌘B and ⌘⇧H write the marks as one step with the words kept selected, ⌘C copies them, ⌫ writes with them deleted

private let text = "# Plan\n\nThe quick brown fox jumps."

@MainActor @Suite struct CanvasRestTextTests {
  func rig() async throws -> Rig {
    let r = try await Rig(
      Board(
        id: BoardID(rawValue: "rest"),
        cards: [
          Card(
            id: cid("n1"), x: 100, y: 100, width: 320, content: .own(CardContent(body: .note(Note(text: text)))))
        ]), zoom: 1)
    r.doc.select([.card(cid("n1"))])
    await r.idle()
    return r
  }

  /// A board point in the middle of the drawn text's `range` (offsets in the body as drawn)
  func point(_ r: Rig, _ range: Range<Int>, end: Bool = false) throws -> CGPoint {
    let b = try #require(r.canvas.restBody(cid("n1")))
    let q = try #require(b.laid.layout.selectionRects(range).first)
    return CGPoint(x: (end ? q.maxX : q.minX) + b.origin.x, y: q.midY + b.origin.y)
  }

  func keyDown(_ r: Rig, _ chars: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags) {
    r.send(
      NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: r.window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars,
        isARepeat: false, keyCode: code)!)
  }

  @Test func aDragOnTheSelectedNotesBodySelectsItsTextAndTheBarComesUp() async throws {
    let r = try await rig()
    defer { r.close() }
    let c = r.canvas
    let was = r.rect("n1")
    // "quick" (the body as drawn starts after the heading the header shows)
    r.drag(try point(r, 4..<5), try point(r, 8..<9, end: true))
    #expect(c.restText?.range == 4..<9, "\(String(describing: c.restText))")
    #expect(r.rect("n1") == was && !c.isEditing, "the card stays, nothing is written in")
    #expect(c.restLayer.superlayer != nil)
    await r.until("the bar") { !c.restBar.isHidden }
    #expect(c.restBar.buttons.map(\.id) == ["bold", "highlight"])
    // ⌘C: its words
    c.copy(nil)
    #expect(c.pasteboard.string(forType: .string) == "quick")
    // ⌘B: one step, the same words still selected, ⌘B again takes it back off
    keyDown(r, "b", 11, .command)
    #expect(r.card("n1").writing == "# Plan\n\nThe **quick** brown fox jumps.")
    #expect(r.doc.undoName == "Edit Note")
    c.copy(nil)
    #expect(c.pasteboard.string(forType: .string) == "quick")
    keyDown(r, "b", 11, .command)
    #expect(r.card("n1").writing == text)
    keyDown(r, "h", 4, [.command, .shift])
    #expect(r.card("n1").writing == "# Plan\n\nThe ==quick== brown fox jumps.")
    // a press elsewhere drops it
    r.click(CGPoint(x: 900, y: 600))
    #expect(c.restText == nil && c.restBar.isHidden)
  }

  @Test func deleteWritesWithTheSelectedWordsGone() async throws {
    let r = try await rig()
    defer { r.close() }
    let c = r.canvas
    r.drag(try point(r, 4..<5), try point(r, 9..<10, end: true))
    #expect(c.restText?.range == 4..<10)
    r.key(51)
    await r.until("writing") { c.editing?.writer != nil }
    let v = try #require(c.writerView)
    #expect(v.source == "# Plan\n\nThe brown fox jumps.")
  }

  @Test func aClickWithoutADragStillWrites() async throws {
    let r = try await rig()
    defer { r.close() }
    r.click(try point(r, 4..<5))
    await r.until("writing") { r.canvas.editing?.writer != nil }
    #expect(r.canvas.restText == nil)
  }
}

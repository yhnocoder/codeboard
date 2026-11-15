import AppKit
import CodeBoardMarkdownUI
import CodeBoardModel
import Testing

@testable import CodeBoardCanvas

// A Note being written in has M↓ (Markdown Source, ⌘/) left of its ··· (NoteBody.tsx .ib.mdsrc): a click shows the
// Note as its Markdown source and back, the keys staying in the editor, the button on while the source shows; with
// its heading in its header (folded while written in) too. Not at rest
@MainActor @Suite struct CanvasSourceTests {
  @Test(arguments: ["Plain words to write.", "# Plan\n\nThe words."])
  func mDownShowsTheSourceAndBack(_ text: String) async throws {
    let r = try await Rig(
      Board(
        id: BoardID(rawValue: "src"),
        cards: [
          Card(id: cid("n1"), x: 100, y: 100, width: 320, content: .own(CardContent(body: .note(Note(text: text)))))
        ]), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    #expect(c.head(cid("n1"))?.buttons.contains { $0.0 == .source } == false, "not at rest")
    c.beginEditing(cid("n1"))
    await r.until("writing") { c.editing?.writer != nil && c.editing?.ready == true }
    let v = try #require(c.writerView)
    let h = try #require(c.head(cid("n1")))
    let b = try #require(h.buttons.first { $0.0 == .source }?.1)
    let more = try #require(h.buttons.first { $0.0 == .more }?.1)
    #expect(b.maxX <= more.minX && b.midY == more.midY, "left of the ···")
    let card = r.rect("n1")
    let at = CGPoint(x: card.minX + b.midX, y: card.minY + b.midY)
    r.click(through: at)
    #expect(v.isSourceMode, "the source shows")
    #expect(r.window.firstResponder === v && c.editing?.id == cid("n1"), "the writing goes on, its keys in the editor")
    #expect(c.head(cid("n1"))?.on.contains(.source) == true)
    r.click(through: at)
    #expect(!v.isSourceMode && c.head(cid("n1"))?.on.contains(.source) == false)
  }
}

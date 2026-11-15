import AppKit
import CodeBoardMarkdownUI
import CodeBoardModel
import CodeBoardNotes
import Testing

@testable import CodeBoardCanvas

// Writing in a Note with the native Markdown component's editor over the card (the canvas drawing its Markdown natively):
// it is there at once, keys go to it through the window, an input method composes in it, leaving writes its text as one
// step that undoes, with nothing to wait for.

@MainActor @Suite(.serialized) struct NativeWritingTests {
  func writer(_ r: Rig) throws -> MarkdownEditorView { try #require(r.canvas.editing?.writer) }

  /// Its text's top left on the card where the picture has it: the card's top left, its padding and its header in
  func textOrigin(_ r: Rig, _ id: String, _ v: MarkdownEditorView) -> (shown: CGPoint, expected: CGPoint) {
    let ed = r.canvas.editing!
    let card = r.canvas.camera.view(r.rect(id).origin)
    let top = r.canvas.convert(v.frame, from: v.superview).origin
    let z = r.canvas.camera.zoom
    return (top, CGPoint(x: card.x + ed.inset.x * z, y: card.y + ed.inset.y * z))
  }

  @Test func enteringAndLeavingWithNothingTypedChangesNothing() async throws {
    let r = try await Rig(zoom: 1, native: true)
    defer { r.close() }
    let start = r.bytes
    let onDisk = try Data(contentsOf: r.file)
    r.doubleClick(CGPoint(x: 40, y: 40))
    await r.until("writing") { r.canvas.editing?.ready == true }
    let v = try writer(r)
    #expect(r.canvas.editing?.id == cid("n1") && r.window.firstResponder === v)
    // its text where the card's picture has it
    let (shown, expected) = textOrigin(r, "n1", v)
    #expect(abs(shown.x - expected.x) < 0.5 && abs(shown.y - expected.y) < 0.5, "\(shown) \(expected)")
    // no web editor was made for it
    #expect(r.canvas.editing?.editor == nil)
    r.click(CGPoint(x: 800, y: 330))
    await r.until("left") { !r.canvas.isEditing }
    #expect(v.superview == nil && r.window.firstResponder === r.canvas)
    #expect(r.bytes == start)
    #expect(!r.doc.history.canUndo, "no step")
    r.doc.flush()
    #expect(try Data(contentsOf: r.file) == onDisk, "board.json byte for byte")
  }

  /// Keys through the window, an input method's composition (several keys, then the word), Esc: one "Edit Note" step
  /// with all of it, which undoes to the text before
  @Test func whatIsTypedAndComposedIsWrittenAsOneStepThatUndoes() async throws {
    let r = try await Rig(zoom: 1, native: true)
    defer { r.close() }
    // where n2 does not lie over it
    r.click(CGPoint(x: 40, y: 40))
    r.key(36)
    await r.until("writing") { r.canvas.editing?.ready == true }
    let v = try writer(r)
    // the editor's clock for its steps: a pause as long as a person's between two words of an input method
    var now = 0.0
    v.core.clock = { now }
    r.press(" ab")
    // as an input method's context gives a composition to its client: marked text growing key by key, then the word
    let none = NSRange(location: NSNotFound, length: 0)
    func compose(_ keys: [String], _ word: String) {
      for marked in keys {
        v.setMarkedText(marked, selectedRange: NSRange(location: marked.utf16.count, length: 0), replacementRange: none)
      }
      #expect(v.hasMarkedText())
      v.insertText(word, replacementRange: none)
      #expect(!v.hasMarkedText())
    }
    now += 1
    compose(["n", "ni", "nih", "niha", "nihao"], "你好")
    now += 1
    compose(["s", "sh", "shi", "shij", "shiji", "shijie"], "世界")
    // Undo in the Edit menu, as it goes from the window's first responder: the last word the input method gave only, not
    // the one before nor its composing (VS Code's steps), and Redo brings it back
    #expect(r.window.firstResponder?.tryToPerform(#selector(CanvasView.undo(_:)), with: nil) == true)
    #expect(v.source == "# n1\n\nA plan in a few words. ab你好")
    #expect(r.window.firstResponder?.tryToPerform(#selector(CanvasView.redo(_:)), with: nil) == true)
    #expect(v.source == "# n1\n\nA plan in a few words. ab你好世界")
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.card("n1").writing == "# n1\n\nA plan in a few words. ab你好世界")
    #expect(r.doc.undoName == "Edit Note")
    await r.settle()
    r.doc.undo()
    #expect(r.card("n1").writing == "# n1\n\nA plan in a few words.")
    #expect(!r.doc.history.canUndo, "one step for the whole session")
  }

  /// Keys typed the moment the double-click that writes in a Note ends: all of them, in order, where its caret went
  @Test func keysTypedAtOnceAfterADoubleClickAllReachTheNote() async throws {
    let r = try await Rig(zoom: 1, native: true)
    defer { r.close() }
    r.doubleClick(CGPoint(x: 40, y: 60))
    r.press("xy")
    await r.until("writing") { r.canvas.editing?.writer != nil }
    let v = try writer(r)
    #expect(v.source.contains("xy"), "\(v.source)")
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    let text = try #require(r.card("n1").writing)
    #expect(text.contains("xy") && text.count == "# n1\n\nA plan in a few words.".count + 2, "\(text)")
  }

  /// An arrow on a block of the Note follows the block the writing changed, in the same step
  @Test func anArrowOnANotesBlockFollowsItWhenTheWritingEndsAndUndoPutsItBack() async throws {
    let text = "# 调度 Scheduling\n\nRequests wait in the queue.\n\n每一步取一批"
    let last = BlockRef(index: 2, hash: BlockRef.sig("每一步取一批"))
    let board = Board(
      id: BoardID(rawValue: "blocks"),
      cards: [
        Card(id: cid("n1"), x: 0, y: 0, width: 300, content: .own(CardContent(body: .note(Note(text: text))))),
        Card(id: cid("n2"), x: 500, y: 0, width: 240, content: .own(CardContent(body: .note(Note(text: "Other"))))),
      ],
      arrows: [
        Arrow(id: ArrowID(rawValue: "a1"), from: Endpoint(card: cid("n2")), to: Endpoint(card: cid("n1"), block: last))
      ])
    let r = try await Rig(board, zoom: 1, native: true)
    defer { r.close() }
    r.click(r.centre("n1"))
    r.key(36)
    await r.until("writing") { r.canvas.editing?.ready == true }
    try writer(r).insertText("，再算", replacementRange: NSRange(location: NSNotFound, length: 0))
    await r.canvas.endEditing()
    #expect(r.doc.board.arrows[0].to.block == BlockRef(index: 2, hash: BlockRef.sig("每一步取一批，再算")))
    #expect(r.doc.undoName == "Edit Note")
    await r.settle()
    r.doc.undo()
    #expect(r.doc.board.arrows[0].to.block == last)
  }
}

import AppKit
import CodeBoardMarkdown
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
    let r = try await Rig(zoom: 1)
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
    Pinyin.install()
    let r = try await Rig(zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    // where n2 does not lie over it
    r.click(CGPoint(x: 40, y: 40))
    r.key(36)
    await r.until("writing") { r.canvas.editing?.ready == true }
    let v = try writer(r)
    // the editor's clock for its steps: a pause as long as a person's between two words of an input method
    var now = 0.0
    v.core.clock = { now }
    r.press(" ab")
    // through the window to the editor's input context, where the input method composes the letters and Space commits
    Pinyin.windows.insert(r.window.windowNumber)
    now += 1
    r.press("ni")
    #expect(v.hasMarkedText())
    r.press(" ")
    #expect(!v.hasMarkedText())
    now += 1
    r.press("hao ")
    #expect(v.source == "# n1\n\nA plan in a few words. ab你好")
    // Undo in the Edit menu, as it goes from the window's first responder: the last word the input method gave only, not
    // the one before nor its composing (the web editor's steps), and Redo brings it back
    #expect(r.window.firstResponder?.tryToPerform(#selector(CanvasView.undo(_:)), with: nil) == true)
    #expect(v.source == "# n1\n\nA plan in a few words. ab你")
    #expect(r.window.firstResponder?.tryToPerform(#selector(CanvasView.redo(_:)), with: nil) == true)
    #expect(v.source == "# n1\n\nA plan in a few words. ab你好")
    Pinyin.windows.remove(r.window.windowNumber)
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.card("n1").writing == "# n1\n\nA plan in a few words. ab你好")
    #expect(r.doc.undoName == "Edit Note")
    await r.settle()
    r.doc.undo()
    #expect(r.card("n1").writing == "# n1\n\nA plan in a few words.")
    #expect(!r.doc.history.canUndo, "one step for the whole session")
  }

  /// Keys typed the moment the double-click that writes in a Note ends: all of them, in order, where its caret went
  @Test func keysTypedAtOnceAfterADoubleClickAllReachTheNote() async throws {
    let r = try await Rig(zoom: 1)
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
    let r = try await Rig(board, zoom: 1)
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

  /// A Text as wide as its text widens as it is typed in and narrows as it is taken away, on one line all the while; a
  /// Text that wraps at its width keeps it and grows taller
  @Test func aTextIsAsWideAsWhatIsTypedAndOneThatWrapsKeepsItsWidth() async throws {
    let board = Board(
      id: BoardID(rawValue: "texts"),
      cards: [
        Card(
          id: cid("t"), x: 0, y: 0, width: 200,
          content: .own(CardContent(body: .text(TextCard(text: "Short", wrap: false))))),
        Card(
          id: cid("w"), x: 0, y: 200, width: 180,
          content: .own(CardContent(body: .text(TextCard(text: "Threads wait", wrap: true))))),
      ])
    let r = try await Rig(board, zoom: 1)
    defer { r.close() }
    let none = NSRange(location: NSNotFound, length: 0)
    r.click(r.centre("t"))
    r.key(36)
    await r.until("writing") { r.canvas.editing?.ready == true }
    var v = try writer(r)
    let narrow = try #require(r.canvas.editing?.size)
    v.insertText(" and a good deal longer than it was", replacementRange: none)
    let wide = try #require(r.canvas.editing?.size)
    #expect(wide.width > narrow.width + 100, "\(narrow) → \(wide)")
    #expect(abs(wide.height - narrow.height) < 0.5, "one line: \(narrow) → \(wide)")
    #expect(abs(r.canvas.liveRect(.card(cid("t")))!.width - wide.width) < 0.5, "the card follows")
    for _ in 0..<15 { v.doCommand(by: #selector(NSResponder.deleteBackward(_:))) }
    let back = try #require(r.canvas.editing?.size)
    #expect(back.width < wide.width - 50 && back.width > narrow.width)
    await r.canvas.endEditing()
    #expect(r.card("t").writing == "Short and a good deal lon")
    r.click(r.centre("w"))
    r.key(36)
    await r.until("writing") { r.canvas.editing?.ready == true }
    v = try writer(r)
    let one = try #require(r.canvas.editing?.size)
    v.insertText(" at the barrier for the others to come", replacementRange: none)
    let more = try #require(r.canvas.editing?.size)
    #expect(more.width == one.width && more.height > one.height + 10, "\(one) → \(more)")
    await r.canvas.endEditing()
  }

  /// While the Note is typed in, an arrow on one of its blocks stays on that block as blocks above it grow (onChange,
  /// as the end of the writing rebases it)
  @Test func anArrowOnABlockFollowsItWhileTheNoteIsTypedIn() async throws {
    let text = "# Steps\n\nRequests wait in the queue.\n\n每一步取一批"
    let last = BlockRef(index: 2, hash: BlockRef.sig("每一步取一批"))
    let board = Board(
      id: BoardID(rawValue: "live"),
      cards: [
        Card(id: cid("n1"), x: 0, y: 0, width: 300, content: .own(CardContent(body: .note(Note(text: text))))),
        Card(id: cid("n2"), x: 500, y: 0, width: 240, content: .own(CardContent(body: .note(Note(text: "Other"))))),
      ],
      arrows: [
        Arrow(id: ArrowID(rawValue: "a1"), from: Endpoint(card: cid("n2")), to: Endpoint(card: cid("n1"), block: last))
      ])
    let r = try await Rig(board, zoom: 1)
    defer { r.close() }
    let a = ArrowID(rawValue: "a1")
    let before = try #require(r.canvas.arrowPoints(a)?.end)
    r.click(CGPoint(x: 40, y: 60))
    r.key(36)
    await r.until("writing") { r.canvas.editing?.ready == true }
    let v = try writer(r)
    // at the end of the queue's paragraph, a new paragraph of two lines
    v.core.select(MDSelection(("# Steps\n\nRequests wait in the queue." as NSString).length))
    v.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    v.insertText(
      "Then each step takes a batch of them and runs it to the end of its words",
      replacementRange: NSRange(location: NSNotFound, length: 0))
    let during = try #require(r.canvas.arrowPoints(a)?.end)
    #expect(during.y > before.y + 30, "on its block, lower now: \(before) → \(during)")
    await r.canvas.endEditing()
    await r.settle()
    let after = try #require(r.canvas.arrowPoints(a)?.end)
    #expect(abs(after.y - during.y) < 1, "where the writing had it: \(during) → \(after)")
  }

  /// An empty new Note shows its placeholder until something is typed in it
  @Test func anEmptyNoteShowsItsPlaceholderUntilItIsTypedIn() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.canvas.createInView(.note)
    await r.until("writing") { r.canvas.editing?.ready == true }
    let v = try writer(r)
    /// How many pixels of its first line it inks, drawn off screen (an empty editor is no taller than its caret)
    func inked() throws -> Int {
      let (w, h) = (Int(v.bounds.width), 30)
      let ctx = try #require(
        CGContext(
          data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
      ctx.translateBy(x: 0, y: CGFloat(h))
      ctx.scaleBy(x: 1, y: -1)
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
      v.draw(CGRect(x: 0, y: 0, width: w, height: h))
      NSGraphicsContext.restoreGraphicsState()
      let data = try #require(ctx.data).assumingMemoryBound(to: UInt8.self)
      return (0..<(w * h)).filter { data[$0 * 4 + 3] > 80 }.count
    }
    // the caret off: it blinks
    v.freeze()
    #expect(v.placeholder == "Type / for blocks")
    #expect(try inked() > 20, "its placeholder")
    v.insertText("x", replacementRange: NSRange(location: NSNotFound, length: 0))
    let one = try inked()
    v.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
    #expect(try inked() > one, "back once it is empty again")
    await r.canvas.endEditing()
    #expect(r.doc.board.cards.count == sample().cards.count, "left empty, it goes")
  }

  /// [[ in a Note written in natively opens the board's reference list (md/load.ts editorOpts' refs) once its
  /// candidates are read; a row picked is written as [[its title#^its id]], drawn as what it points at at once, and is
  /// the first of the recent ones the next list offers
  @Test func doubleBracketsInANoteOfferTheBoardsCardsAndAPickedOneIsDrawnAsFound() async throws {
    let r = try await Rig(sidenoteBoard(), zoom: 1)
    defer { r.close() }
    CanvasView.recentRefs = []
    let t1 = r.rect("t1")
    r.doubleClick(CGPoint(x: t1.midX, y: t1.midY))
    await r.until("writing") { r.canvas.editing?.ready == true }
    let v = try writer(r)
    v.doCommand(by: #selector(NSResponder.moveToEndOfDocument(_:)))
    v.insertText(" [[调", replacementRange: NSRange(location: NSNotFound, length: 0))
    await r.until("the list, once its candidates are read") { r.canvas.editing?.refList != nil }
    v.insertText("度", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(r.canvas.editor(v, refMenu: "调度").local.map(\.title) == ["调度 Scheduling", "调度 Section"])
    v.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    v.insertText(" 好", replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(v.source.hasSuffix("[[调度 Scheduling#^n1]] 好"), "\(v.source)")
    #expect(v.core.layout.drawnRefs.contains { $0.target == "n1" }, "drawn as found")
    #expect(CanvasView.recentRefs.first.map { [$0.board, $0.id] } == [r.doc.board.id.rawValue, "n1"])
    await r.canvas.endEditing()
  }
}

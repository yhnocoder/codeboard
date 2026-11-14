import AppKit
import CodeBoardModel
import CodeBoardNotes
import Testing

@testable import CodeBoardCanvas

// Writing Free code (the board's FreeEdit): the code editor over the card puts every line where the canvas drew it and
// colours it as the canvas did; what is typed becomes one step, the card grows with it, and sourced code is not written.

private func freeBoard() -> Board {
  let free = Segment(
    id: s1, source: nil, language: "python", firstLine: 1,
    lines: ["def step(batch):", "    ids = batch.ids", "    return run(ids)"])
  let read = Segment(
    id: SegmentID(rawValue: "s2"), source: .file(path: "a.py", hash: nil), language: "python",
    firstLine: 10, lines: ["x = 1"])
  return Board(
    id: BoardID(rawValue: "free"),
    cards: [
      Card(
        id: cid("f"), x: 100, y: 100, width: 320,
        content: .own(CardContent(title: "Free", body: .code(CodeCard(segments: [free]))))),
      Card(
        id: cid("r"), x: 100, y: 400, width: 320,
        content: .own(CardContent(title: "Read", body: .code(CodeCard(segments: [read]))))),
    ])
}

@MainActor @Suite(.serialized) struct CanvasFreeCodeTests {
  @Test func freeCodeIsWrittenWhereItIsDrawnAsOneStep() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let card = r.rect("f")
    let code = try #require(c.scene?.placed[cid("f")]?.code)
    let row = try #require(code.layout.row(segment: 0, line: 2))
    // a double-click on line 2: the editor opens with the caret on it
    r.doubleClick(CGPoint(x: card.minX + code.layout.gutter + 40, y: card.minY + code.top + row.y + row.height / 2))
    await r.editorReady()
    #expect(c.editing?.id == cid("f") && c.editing?.code == true)
    // every line's text where the canvas drew it (card points at 100 %), and coloured
    let js = """
      const card = document.querySelector('#root .slot.shown .card').getBoundingClientRect();
      return [...document.querySelectorAll('.cm-line')].map(l => {
        const t = document.createRange(); t.selectNodeContents(l); const b = t.getBoundingClientRect();
        return [b.x - card.x, b.y - card.y, b.height, l.querySelectorAll('span[class]').length];
      });
      """
    let lines = try #require(
      try await c.noteEditor.view.callAsyncJavaScript(js, contentWorld: .page) as? [[Double]])
    #expect(lines.count == 3)
    for (k, l) in lines.enumerated() {
      let p = try #require(code.layout.row(segment: 0, line: k + 1))
      // the text box is the font's line box, centred in the 20 point row
      #expect(abs(l[1] + l[2] / 2 - (code.top + p.y + p.height / 2)) < 1, "line \(k + 1): \(l), row \(p)")
      #expect(
        abs(l[0] - code.layout.gutter) < 1, "line \(k + 1) starts at \(l[0]), the canvas's at \(code.layout.gutter)")
      #expect(l[3] > 0, "line \(k + 1) coloured")
    }
    // the caret on line 2
    let caretLine =
      try await c.noteEditor.view.callAsyncJavaScript(
        "const s = getSelection(); return s.anchorNode?.parentElement?.closest('.cm-line')?.textContent ?? null",
        contentWorld: .page) as? String
    #expect(caretLine == "    ids = batch.ids")
    // a new line typed: the card grows by a row
    let before = c.editing?.size?.height ?? 0
    await r.type("\n    out = 1")
    await r.until("the card grew") { (c.editing?.size?.height ?? 0) >= before + 19 }
    // Esc leaves: one step, the text written, the sourced card untouched
    _ = try await c.noteEditor.view.callAsyncJavaScript(
      "document.querySelector('.cm-content').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))",
      contentWorld: .page)
    await r.until("left") { !c.isEditing }
    #expect(r.doc.board.segment(cid("f"), s1)?.lines.count == 4)
    #expect(r.doc.history.undoSteps.map(\.name) == ["Edit Code"])
    r.doc.undo()
    #expect(r.doc.board.segment(cid("f"), s1)?.lines.count == 3)
  }

  /// Typing at once after the double-click, before the editor is there, and leaving with ⌘↵ as fast: nothing is lost
  /// (Return indents, as CodeMirror does on the board)
  @Test func keysTypedAtOnceAfterTheDoubleClickAreAllWritten() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let card = r.rect("f")
    let code = try #require(c.scene?.placed[cid("f")]?.code)
    let row = try #require(code.layout.row(segment: 0, line: 3))
    // past the end of the last line
    r.doubleClick(CGPoint(x: card.maxX - 10, y: card.minY + code.top + row.y + row.height / 2))
    r.press("x = 1\ry")
    // ⌘↵ leaves, whatever completion shows (Esc closes that first, as on the board)
    for t in [NSEvent.EventType.keyDown, .keyUp] {
      r.window.sendEvent(
        NSEvent.keyEvent(
          with: t, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
          windowNumber: r.window.windowNumber, context: nil, characters: "\r", charactersIgnoringModifiers: "\r",
          isARepeat: false, keyCode: 36)!)
    }
    await r.editorReady()
    await r.until("left") { !c.isEditing }
    #expect(r.doc.board.segment(cid("f"), s1)?.lines.suffix(2) == ["    return run(ids)x = 1", "    y"])
  }

  @Test func sourcedCodeIsNotWrittenByADoubleClick() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    let card = r.rect("r")
    r.doubleClick(CGPoint(x: card.midX, y: card.maxY - 10))
    await r.settle()
    #expect(!r.canvas.isEditing)
  }
}

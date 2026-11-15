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
    let typed = try? await c.noteEditor.view.callAsyncJavaScript(
      "return [...document.querySelectorAll('.cm-line')].map(l => l.textContent)", contentWorld: .page)
    let page = await r.pageState(c.noteEditor.view)
    #expect(
      (c.editing?.size?.height ?? 0) >= before + 19,
      "\(c.editing?.size?.height ?? 0) from \(before), lines \(String(describing: typed)), page \(page)")
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
  /// Writing code through an input method: an Esc while "ni" is composed only cancels it (CanvasIMETests' Pinyin)
  @Test func anEscDuringACompositionInCodeCancelsOnlyTheComposition() async throws {
    Pinyin.install()
    let r = try await Rig(freeBoard(), zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    let c = r.canvas
    let card = r.rect("f")
    let code = try #require(c.scene?.placed[cid("f")]?.code)
    let row = try #require(code.layout.row(segment: 0, line: 3))
    r.doubleClick(CGPoint(x: card.maxX - 10, y: card.minY + code.top + row.y + row.height / 2))
    await r.editorReady()
    func last() async -> String {
      (try? await c.noteEditor.view.callAsyncJavaScript(
        "return [...document.querySelectorAll('.cm-line')].at(-1)?.textContent ?? ''", contentWorld: .page) as? String)
        ?? ""
    }
    Pinyin.windows.insert(r.window.windowNumber)
    await r.typeInTurn("ni")
    await r.until("composing") { await last().hasSuffix("ni") }
    r.press("\u{1b}")
    // a key after it, with nothing composed: once it is written, whatever the Esc did has happened
    r.press("1")
    await r.until("1 written") { await last().hasSuffix("1") }
    #expect(c.isEditing, "the Esc cancelled the composition only")
    let got = await last()
    #expect(got == "    return run(ids)1", "nothing of the composition kept: \(got)")
  }

  /// "ni" and Space typed at once after the double-click on code, before the editor is there: they go through the input
  /// method too, so 你 is written (CanvasIMETests.pinyinTypedAtOnceAfterTheDoubleClickIsComposed)
  @Test(arguments: [false, true])
  func pinyinTypedAtOnceAfterTheDoubleClickOnCodeIsComposed(late: Bool) async throws {
    Pinyin.install()
    let r = try await Rig(freeBoard(), zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    if late { await r.editorFocusesLate() }
    let c = r.canvas
    let card = r.rect("f")
    let code = try #require(c.scene?.placed[cid("f")]?.code)
    let row = try #require(code.layout.row(segment: 0, line: 3))
    Pinyin.windows.insert(r.window.windowNumber)
    r.doubleClick(CGPoint(x: card.maxX - 10, y: card.minY + code.top + row.y + row.height / 2))
    r.press("ni ")
    await r.editorReady()
    await r.until("the keys handed over") { c.noteEditor.view.held == nil }
    r.press("\u{1b}")
    await r.until("left") { !c.isEditing }
    let lines = r.doc.board.segment(cid("f"), s1)?.lines ?? []
    #expect(lines.last == "    return run(ids)你", "\(lines)")
  }

  /// Code through an input method: "ni", Space and at once ⌘↵ or Esc leave with 你 written (as
  /// CanvasIMETests.anEscAtOnceAfterTheCommitLeavesWithTheText: CodeMirror's rule for the key that commits a
  /// composition takes the Space, not them)
  @Test(arguments: [53, 36] as [UInt16])
  func aKeyAtOnceAfterTheCommitInCodeIsTaken(key: UInt16) async throws {
    Pinyin.install()
    let r = try await Rig(freeBoard(), zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    let c = r.canvas
    let card = r.rect("f")
    let code = try #require(c.scene?.placed[cid("f")]?.code)
    let row = try #require(code.layout.row(segment: 0, line: 3))
    r.doubleClick(CGPoint(x: card.maxX - 10, y: card.minY + code.top + row.y + row.height / 2))
    await r.editorReady()
    Pinyin.windows.insert(r.window.windowNumber)
    await r.typeInTurn("ni ")
    // the key as soon as 你 is there to see (CodeMirror reads the commit from the page just after the composition ends)
    await r.until("你 written") {
      (try? await c.noteEditor.view.callAsyncJavaScript(
        "return [...document.querySelectorAll('.cm-line')].at(-1)?.textContent ?? ''", contentWorld: .page) as? String)?
        .hasSuffix("你") == true
    }
    let flags: NSEvent.ModifierFlags = key == 36 ? .command : []
    let chars = key == 36 ? "\r" : "\u{1b}"
    for t in [NSEvent.EventType.keyDown, .keyUp] {
      r.window.sendEvent(
        NSEvent.keyEvent(
          with: t, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
          windowNumber: r.window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars,
          isARepeat: false, keyCode: key)!)
    }
    await r.until("left") { !c.isEditing }
    let lines = r.doc.board.segment(cid("f"), s1)?.lines ?? []
    #expect(lines.last == "    return run(ids)你", "\(lines)")
  }

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

  /// interact.ts clickEditKind "free": a click on the code of the one Free code card selected before the press writes it,
  /// the caret where it was; not on its head, not sourced code
  @Test func aClickOnTheOneSelectedFreeCodesCodeWritesIt() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let card = r.rect("f")
    let code = try #require(c.scene?.placed[cid("f")]?.code)
    let row = try #require(code.layout.row(segment: 0, line: 2))
    let line2 = CGPoint(x: card.minX + code.layout.gutter + 40, y: card.minY + code.top + row.y + row.height / 2)
    r.click(line2)
    await r.settle()
    #expect(r.doc.selection == [.card(cid("f"))] && !c.isEditing, "the click that selects it")
    r.click(CGPoint(x: card.midX, y: card.minY + 10))
    await r.settle()
    #expect(!c.isEditing, "its head")
    r.click(line2)
    await r.editorReady()
    #expect(c.editing?.id == cid("f") && c.editing?.code == true)
    let caretLine =
      try await c.noteEditor.view.callAsyncJavaScript(
        "const s = getSelection(); return s.anchorNode?.parentElement?.closest('.cm-line')?.textContent ?? null",
        contentWorld: .page) as? String
    #expect(caretLine == "    ids = batch.ids")
    await c.endEditing()
    let read = r.rect("r")
    r.click(CGPoint(x: read.midX, y: read.maxY - 10))
    r.click(CGPoint(x: read.midX, y: read.maxY - 10))
    await r.settle()
    #expect(!c.isEditing, "sourced code")
  }

  /// interact.ts cardPointerDown: a double-click on a code card's title (on an untitled Free code card's head anywhere)
  /// writes its title where it is (CodeHead.tsx's Editable), one step; blank or the card's own title is none
  /// (cards.ts renameCard); elsewhere on a titled head nothing is written
  @Test func aDoubleClickOnACodeCardsTitleRenamesItWhereItIs() async throws {
    var b = freeBoard()
    b.cards.append(
      Card(
        id: cid("u"), x: 600, y: 100, width: 320,
        content: .own(
          CardContent(
            body: .code(
              CodeCard(segments: [
                Segment(id: SegmentID(rawValue: "s3"), source: nil, language: "python", firstLine: 1, lines: ["y = 2"])
              ]))))))
    let r = try await Rig(b, zoom: 1)
    defer { r.close() }
    let c = r.canvas
    func head(_ id: String, _ x: CGFloat) -> CGPoint {
      let k = r.rect(id)
      return CGPoint(x: x < 0 ? k.maxX + x : k.minX + x, y: k.minY + c.theme.headerHeight / 2)
    }
    func title(_ id: String) -> String? {
      if case .own(let k)? = r.doc.board.card(cid(id))?.content { k.title } else { nil }
    }
    // a titled head past its title: nothing
    r.doubleClick(head("f", -40))
    await r.settle()
    #expect(c.inPlace == nil && !c.isEditing)
    // on the title: its field, with the title
    r.doubleClick(head("r", 40))
    await r.settle()
    #expect(c.inPlace?.what == .card(cid("r")) && c.inPlace?.field.stringValue == "Read" && !c.isEditing)
    c.inPlace?.field.stringValue = "  Reader "
    c.endInPlace(commit: true)
    #expect(title("r") == "Reader" && r.doc.undoName == "Rename")
    // blank: untitled again
    r.doubleClick(head("f", 20))
    await r.settle()
    #expect(c.inPlace?.what == .card(cid("f")) && c.inPlace?.field.stringValue == "Free")
    c.inPlace?.field.stringValue = " "
    c.endInPlace(commit: true)
    #expect(title("f") == nil)
    // an untitled Free code card: anywhere on its head, empty
    r.doubleClick(head("u", -40))
    await r.settle()
    #expect(c.inPlace?.what == .card(cid("u")) && c.inPlace?.field.stringValue == "")
    c.inPlace?.field.stringValue = "Setup"
    c.endInPlace(commit: true)
    #expect(title("u") == "Setup")
    #expect(r.doc.history.undoSteps.count == 3)
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

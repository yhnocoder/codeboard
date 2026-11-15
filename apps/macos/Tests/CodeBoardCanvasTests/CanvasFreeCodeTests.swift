import AppKit
import CodeBoardModel
import CodeBoardNotes
import CodeBoardSyntax
import CodeCore
import CodeUI
import Testing

@testable import CodeBoardCanvas

// Writing Free code (the board's FreeEdit) in the code component's editor (CodeEditorView) over the card: every line
// where the canvas drew it, coloured as the canvas did; what is typed becomes one step, the card grows with it, and
// sourced code is not written. A full window under the desktop picture (Rig); keys go through the window to the view
// that has them, an input method's through its input context (CanvasIMETests' Pinyin), as a person's do.

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

private let none = NSRange(location: NSNotFound, length: 0)

extension Rig {
  /// The code editor over the card being written
  var code: CodeEditorView? { canvas.editing?.codeView }

  /// A key with modifiers, as the keyboard sends it, through the window
  func press(_ code: UInt16, _ chars: String, _ flags: NSEvent.ModifierFlags) {
    for t in [NSEvent.EventType.keyDown, .keyUp] {
      window.sendEvent(
        NSEvent.keyEvent(
          with: t, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
          windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars,
          isARepeat: false, keyCode: code)!)
    }
  }

  /// A key with ⌘ as the app gets it: offered to the window's views as a key equivalent first (NSApplication.sendEvent),
  /// sent to the first responder when none takes it
  func equivalent(_ code: UInt16, _ chars: String, _ flags: NSEvent.ModifierFlags) {
    for t in [NSEvent.EventType.keyDown, .keyUp] {
      let e = NSEvent.keyEvent(
        with: t, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars,
        isARepeat: false, keyCode: code)!
      if t == .keyDown, window.performKeyEquivalent(with: e) { continue }
      window.sendEvent(e)
    }
  }

  /// The middle of a line of Free code card `id`, `x` in from its gutter (past its end: a large x)
  func line(_ id: String, _ n: Int, x: CGFloat = 40) throws -> CGPoint {
    let card = rect(id)
    let code = try #require(canvas.scene?.placed[cid(id)]?.code)
    let row = try #require(code.layout.row(segment: 0, line: n))
    return CGPoint(
      x: min(card.maxX - 10, card.minX + code.layout.gutter + x), y: card.minY + code.top + row.y + row.height / 2)
  }

  /// The caret's line, 1 on
  var caretLine: Int? {
    code.map { v in (v.editor.text as NSString).substring(to: v.editor.selection.head).count { $0 == "\n" } + 1 }
  }
}

@MainActor @Suite(.serialized) struct CanvasFreeCodeTests {
  @Test func freeCodeIsWrittenWhereItIsDrawnAsOneStep() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let card = r.rect("f")
    let code = try #require(c.scene?.placed[cid("f")]?.code)
    r.doubleClick(try r.line("f", 2, x: 1000))
    await r.editorReady()
    let v = try #require(r.code)
    #expect(c.editing?.id == cid("f") && c.editing?.code == true)
    #expect(v.window === r.window && v.superview === c.superview && r.window.firstResponder === v)
    // over the card's body, every line in the row and from the gutter the canvas drew it in, coloured
    let body = c.convert(v.frame, from: v.superview)
    let shown = c.camera.view(CGPoint(x: card.minX, y: card.minY + code.top))
    #expect(abs(body.minX - shown.x) < 0.01 && abs(body.minY - shown.y) < 0.01)
    #expect(v.gutter == code.layout.gutter)
    for (k, row) in v.layout.lineRows.enumerated() {
      let p = try #require(code.layout.row(segment: 0, line: k + 1))
      #expect(row.y == p.y && row.height == p.height, "line \(k + 1)")
      if case .line(_, _, _, let runs) = row.kind { #expect(!runs.isEmpty, "line \(k + 1) coloured") }
    }
    #expect(r.caretLine == 2)
    // a new line typed: the card grows by a row
    let before = c.editing?.size?.height ?? 0
    r.press("\r")
    v.insertText("out = 1", replacementRange: none)
    #expect(c.editing?.size?.height == before + 20)
    #expect(v.editor.text.hasSuffix("    ids = batch.ids\n    out = 1\n    return run(ids)"))
    // its own undo while it is written
    v.undo(nil)
    #expect(!v.editor.text.contains("out = 1"))
    v.redo(nil)
    // Esc leaves: one step, the text written, the sourced card untouched
    r.press("\u{1b}")
    await r.until("left") { !c.isEditing }
    #expect(v.superview == nil && r.window.firstResponder === c)
    #expect(r.doc.board.segment(cid("f"), s1)?.lines.count == 4)
    #expect(r.doc.history.undoSteps.map(\.name) == ["Edit Code"])
    r.doc.undo()
    #expect(r.doc.board.segment(cid("f"), s1)?.lines.count == 3)
  }

  /// Writing code through an input method: an Esc while "ni" is composed only cancels it
  @Test func anEscDuringACompositionInCodeCancelsOnlyTheComposition() async throws {
    Pinyin.install()
    let r = try await Rig(freeBoard(), zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    r.doubleClick(try r.line("f", 3, x: 1000))
    await r.editorReady()
    Pinyin.windows.insert(r.window.windowNumber)
    r.press("ni")
    let v = try #require(r.code)
    #expect(v.hasMarkedText() && v.editor.text.hasSuffix("run(ids)"))
    r.press("\u{1b}")
    #expect(r.canvas.isEditing && !v.hasMarkedText(), "the Esc cancelled the composition only")
    r.press("1")
    #expect(v.editor.text.hasSuffix("    return run(ids)1"), "nothing of the composition kept: \(v.editor.text)")
  }

  /// Code's colours that come back while an input method composes on the line they colour: the line is drawn again,
  /// and the composition goes on and is committed once
  @Test func coloursComingWhileComposingInCodeLeaveTheCompositionAlone() async throws {
    Pinyin.install()
    let r = try await Rig(freeBoard(), zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    r.doubleClick(try r.line("f", 3, x: 1000))
    await r.editorReady()
    let v = try #require(r.code)
    let colors = try #require(v.colors)
    var came = 0
    let draw = colors.ready
    colors.ready = {
      draw?()
      came += 1
    }
    // a key that asks for colours, then a composition begun before they come
    v.insertText(" +", replacementRange: none)
    Pinyin.windows.insert(r.window.windowNumber)
    r.press("n")
    await r.until("the colours came") { came > 0 }
    #expect(v.hasMarkedText() && v.markedRange().length == 1, "still composing after the line was drawn again")
    r.press("i ")
    #expect(!v.hasMarkedText() && v.editor.text.hasSuffix("run(ids) +你"), "\(v.editor.text)")
  }

  /// "ni" and Space typed at once after the double-click on code, before the editor is there: they go through the
  /// input method too, so 你 is written (CanvasIMETests.pinyinTypedAtOnceAfterTheDoubleClickIsComposed)
  @Test func pinyinTypedAtOnceAfterTheDoubleClickOnCodeIsComposed() async throws {
    Pinyin.install()
    let r = try await Rig(freeBoard(), zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    Pinyin.windows.insert(r.window.windowNumber)
    r.doubleClick(try r.line("f", 3, x: 1000))
    r.press("ni ")
    await r.editorReady()
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    let lines = r.doc.board.segment(cid("f"), s1)?.lines ?? []
    #expect(lines.last == "    return run(ids)你", "\(lines)")
  }

  /// Code through an input method: "ni", Space and at once ⌘↵ or Esc leave with 你 written
  @Test(arguments: [53, 36] as [UInt16])
  func aKeyAtOnceAfterTheCommitInCodeIsTaken(key: UInt16) async throws {
    Pinyin.install()
    let r = try await Rig(freeBoard(), zoom: 1)
    defer {
      Pinyin.windows.remove(r.window.windowNumber)
      r.close()
    }
    r.doubleClick(try r.line("f", 3, x: 1000))
    await r.editorReady()
    Pinyin.windows.insert(r.window.windowNumber)
    r.press("ni ")
    r.press(key, key == 36 ? "\r" : "\u{1b}", key == 36 ? .command : [])
    await r.until("left") { !r.canvas.isEditing }
    let lines = r.doc.board.segment(cid("f"), s1)?.lines ?? []
    #expect(lines.last == "    return run(ids)你", "\(lines)")
  }

  /// ⌘/ comments the caret's line out with its language's line comment (FreeEdit.tsx: langInfo's), not always "//"
  @Test func commandSlashCommentsTheLineOutInItsLanguage() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    r.doubleClick(try r.line("f", 3, x: 1000))
    await r.editorReady()
    r.press(44, "/", .command)
    await r.canvas.endEditing()
    #expect(r.doc.board.segment(cid("f"), s1)?.lines.last == "    # return run(ids)")
  }

  /// Every key typed at once after the double-click, before the editor is there, is written in order (Return indents)
  @Test func keysTypedAtOnceAfterTheDoubleClickAreAllWritten() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    r.doubleClick(try r.line("f", 3, x: 1000))
    r.press("x = 1\ry")
    r.press(36, "\r", .command)
    await r.editorReady()
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.doc.board.segment(cid("f"), s1)?.lines.suffix(2) == ["    return run(ids)x = 1", "    y"])
  }

  /// interact.ts clickEditKind "free": a click on the code of the one Free code card selected before the press writes it,
  /// the caret where it was; not on its head, not sourced code
  @Test func aClickOnTheOneSelectedFreeCodesCodeWritesIt() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let card = r.rect("f")
    let line2 = try r.line("f", 2)
    r.click(line2)
    await r.settle()
    #expect(r.doc.selection == [.card(cid("f"))] && !c.isEditing, "the click that selects it")
    r.click(clearOfButtons(c, cid("f"), CGPoint(x: card.minX + 15, y: card.minY + 10)))
    await r.settle()
    #expect(!c.isEditing, "its head")
    r.click(line2)
    await r.editorReady()
    #expect(c.editing?.id == cid("f") && c.editing?.code == true && r.caretLine == 2)
    await c.endEditing()
    let read = r.rect("r")
    r.click(CGPoint(x: read.midX, y: read.maxY - 10))
    r.click(CGPoint(x: read.midX, y: read.maxY - 10))
    await r.settle()
    #expect(!c.isEditing, "sourced code")
  }

  /// A double-click on the selected card's code: its first press opens the editor, its second only puts the caret there
  /// and selects no word (as VS Code's board); a double-click once it is open selects the word
  @Test func theDoubleClickThatOpensTheEditorPutsTheCaretAndSelectsNoWord() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    let p = try r.line("f", 2, x: 4 + 4 * r.canvas.theme.metrics.charWidth + 2)
    r.click(p)
    await r.settle()
    // its first press and release open the editor; the second press comes once it is there, as a person's does
    r.send(r.mouse(.leftMouseDown, p))
    r.send(r.mouse(.leftMouseUp, p))
    await r.editorReady()
    r.send(r.mouse(.leftMouseDown, p, clicks: 2))
    r.send(r.mouse(.leftMouseUp, p, clicks: 2))
    let v = try #require(r.code)
    // line 2 is "    ids = batch.ids", from offset 17: "ids" is 21..<24
    #expect(v.editor.selection.isEmpty && (21...24).contains(v.editor.selection.head), "no word: \(v.editor.selection)")
    // open: a double-click selects the word (the window hands its presses to the editor over the card)
    r.doubleClick(p)
    #expect(v.editor.selection.range == 21..<24, "\(v.editor.selection)")
    await r.canvas.endEditing()
    #expect(!r.doc.history.canUndo)
  }

  /// ⌘F opens the editor's find bar over the card: what is typed is found from the caret on, ⌘G and ↩ find the next,
  /// ⇧⌘G the one before, going round; Esc closes the bar only, the found text selected and the keys the editor's
  /// Lines written are coloured as soon as the highlighter has them (a frame or two), not left in plain ink
  @Test func linesWrittenAreColouredOnceTheHighlighterHasThem() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    r.doubleClick(try r.line("f", 1, x: 400))
    await r.editorReady()
    let v = try #require(r.code)
    func runs(_ n: Int) -> [CodeRun]? {
      for row in v.layout.lineRows {
        if case .line(let number, false, _, let runs) = row.kind, number == n { return runs }
      }
      return nil
    }
    #expect(runs(1)?.isEmpty == false, "coloured as drawn")
    r.press("\r")
    v.insertText("x = run(1)", replacementRange: none)
    r.press("\r")
    v.insertText("return x", replacementRange: none)
    await r.until("the new lines coloured") { runs(2)?.isEmpty == false && runs(3)?.isEmpty == false }
    // `return` a keyword, `run` a call
    #expect(runs(3)?.contains { $0.style == TokenClass.keyword.rawValue } == true)
  }

  @Test func commandFFindsInTheCodeBeingWritten() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    r.doubleClick(try r.line("f", 1, x: 4))
    await r.editorReady()
    let v = try #require(r.code)
    r.equivalent(3, "f", .command)
    let bar = try #require(v.findBar)
    #expect(bar.isDescendant(of: v) && (r.window.firstResponder as? NSView)?.isDescendant(of: bar) == true)
    // "ids" is at 21, 33 and 52
    r.press("ids")
    #expect(v.editor.selection.range == 21..<24)
    r.equivalent(5, "g", .command)
    #expect(v.editor.selection.range == 33..<36)
    r.press("\r")
    #expect(v.editor.selection.range == 52..<55)
    r.equivalent(5, "g", .command)
    #expect(v.editor.selection.range == 21..<24, "round the end")
    r.equivalent(5, "G", [.command, .shift])
    #expect(v.editor.selection.range == 52..<55, "back round the start")
    r.press("\u{1b}")
    #expect(v.findBar == nil && r.window.firstResponder === v && r.canvas.isEditing)
    r.press("x")
    #expect(v.editor.text.hasSuffix("run(x)"))
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.doc.board.segment(cid("f"), s1)?.lines.last == "    return run(x)")
  }

  /// The find bar has the web editor's buttons (Toggle Replace, Match Case, back, on, Close; Replace and All beside the
  /// replacement) and its replace: ⌥⌘F opens it with the replacement, a click on a button does what its key does
  @Test func theFindBarHasTheWebEditorsButtonsAndReplaces() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    r.doubleClick(try r.line("f", 1, x: 4))
    await r.editorReady()
    let v = try #require(r.code)
    r.equivalent(3, "f", [.command, .option])
    let bar = try #require(v.findBar)
    let buttons = try #require(bar.buttons)
    bar.layoutSubtreeIfNeeded()
    #expect(bar.replacing && buttons.frame.width == 120 && buttons.frame.height == 54)
    // a click on button `k` of row `row` (or at `x` in it), to the view under it as the window gives it on: the rig's
    // window is never key, where a first click would only bring it forward
    func click(_ k: Int, row: Int = 0, x: CGFloat? = nil) {
      bar.layoutSubtreeIfNeeded()
      let p = buttons.convert(CGPoint(x: x ?? CGFloat(k) * 24 + 12, y: CGFloat(row) * 30 + 12), to: nil)
      let hit = r.window.contentView?.hitTest(r.window.contentView!.convert(p, from: nil))
      #expect(hit === buttons)
      for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
        let e = NSEvent.mouseEvent(
          with: t, location: p, modifierFlags: [], timestamp: r.next(0.016), windowNumber: r.window.windowNumber,
          context: nil, eventNumber: 0, clickCount: 1, pressure: 1)!
        if t == .leftMouseDown { hit?.mouseDown(with: e) } else { hit?.mouseUp(with: e) }
      }
    }
    // "ids" is at 21, 33 and 52
    bar.query.stringValue = "ids"
    bar.onChange()
    #expect(v.editor.selection.range == 21..<24)
    click(3)
    #expect(v.editor.selection.range == 33..<36, "Next Match")
    click(2)
    #expect(v.editor.selection.range == 21..<24, "Previous Match")
    bar.replacement.stringValue = "xs"
    click(0, row: 1, x: 29)
    #expect(v.editor.text.hasPrefix("def step(batch):\n    xs = batch.ids"), "Replace")
    #expect(v.editor.selection.range == 32..<35 && bar.count.stringValue == "1/2", "the next one, a unit sooner")
    click(0, row: 1, x: 62 + 16)
    #expect(!v.editor.text.contains("ids") && v.editor.text.hasSuffix("run(xs)"), "All")
    v.undo(nil)
    #expect(v.editor.text.contains("batch.ids") && v.editor.text.hasSuffix("run(ids)"), "All is one step")
    bar.query.stringValue = "IDS"
    click(1)
    #expect(bar.caseSensitive && bar.count.stringValue == "0", "Match Case")
    click(0)
    bar.layoutSubtreeIfNeeded()
    #expect(!bar.replacing && buttons.frame.height == 24, "Toggle Replace")
    click(4)
    #expect(v.findBar == nil && r.window.firstResponder === v, "Close")
  }

  /// The find bar is the screen's size at any zoom, at the top right of the editor; a match out of view brings the board
  /// to it at the zoom it has
  @Test func theFindBarKeepsItsSizeAndAMatchOutOfViewIsBroughtIn() async throws {
    let r = try await Rig(freeBoard(), zoom: 2)
    defer { r.close() }
    let c = r.canvas
    r.doubleClick(try r.line("f", 1, x: 4))
    await r.editorReady()
    let v = try #require(r.code)
    r.equivalent(3, "f", .command)
    let bar = try #require(v.findBar)
    #expect(abs(bar.convert(bar.bounds, to: nil).width - bar.size.width) < 0.5, "at 200 %")
    // the code's last line out of view, below it
    let line3 = try r.line("f", 3)
    c.place(zoom: 2, centre: CGPoint(x: line3.x, y: line3.y - c.bounds.height / 2))
    await r.idle()
    #expect(!c.safeView.contains(line3))
    r.press("run")
    await r.idle()
    #expect(v.editor.selection.range == 48..<51 && c.camera.zoom == 2)
    #expect(c.safeView.contains(line3), "brought into view")
    #expect(abs(bar.convert(bar.bounds, to: nil).width - bar.size.width) < 0.5)
  }

  /// Two fingers while code is written: a scroll moves the board and a pinch zooms it, the editor over the card all the
  /// while, scaled with it and not laid out again; the writing goes on
  @Test func panAndPinchWhileWritingCodeMoveTheBoardAndTheEditorWithIt() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    r.doubleClick(try r.line("f", 2))
    await r.editorReady()
    let v = try #require(r.code)
    let rows = v.layout.lineRows
    func over() -> Bool {
      let body = c.convert(v.frame, from: v.superview)
      let o = c.camera.view(CGPoint(x: r.rect("f").minX, y: r.rect("f").minY + c.theme.headerHeight))
      return abs(body.minX - o.x) < 0.5 && abs(body.minY - o.y) < 0.5
    }
    let at = CGPoint(x: r.rect("f").midX, y: r.rect("f").midY)
    #expect(r.scrollGesture(from: at, dy: 12) != 0 && over())
    await r.idle()
    #expect(r.pinchGesture(at: at) > 1 && over())
    #expect(abs(v.frame.width / v.bounds.width - c.camera.zoom) < 0.001 && v.layout.lineRows == rows)
    await r.idle()
    #expect(c.isEditing && r.window.firstResponder === v)
    v.insertText("z", replacementRange: none)
    await c.endEditing()
    #expect(r.doc.board.segment(cid("f"), s1)?.lines.count == 3 && r.doc.undoName == "Edit Code")
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
      return clearOfButtons(
        c, cid(id), CGPoint(x: x < 0 ? k.maxX + x : k.minX + x, y: k.minY + c.theme.headerHeight / 2))
    }
    func title(_ id: String) -> String? {
      if case .own(let k)? = r.doc.board.card(cid(id))?.content { k.title } else { nil }
    }
    // a titled head past its title, short of its buttons: nothing
    let first = try #require(c.head(cid("f"))?.buttons.map(\.1.minX).min())
    r.doubleClick(head("f", first - 8))
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
    // an untitled Free code card: anywhere on its head but its buttons, empty
    r.doubleClick(head("u", 60))
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

  /// The board's New Code (menus.ts canvasMenu, create.ts newFreeCode): a Free code card at the point, its code being
  /// written at once; left with nothing written it goes with no step (env.fresh), written it is one step "New Code"
  @Test func newCodeLeftEmptyGoesAndWrittenIsOneStep() async throws {
    let r = try await Rig(freeBoard(), zoom: 1)
    defer { r.close() }
    let c = r.canvas
    func newCode() throws {
      let item = try #require(c.boardMenu(at: CGPoint(x: 600, y: 120)).items.first { $0.title == "New Code" })
      (item.representedObject as? MenuAction)?.run()
    }
    let cards = r.doc.board.cards.count
    try newCode()
    await r.editorReady()
    let id = try #require(c.editing?.id)
    #expect(c.editing?.code == true && c.editing?.fresh == true)
    let made = try #require(r.doc.board.card(id))
    #expect(made.x == 600 && made.y == 120 && made.width == Board.newNoteWidth && r.doc.board.isFreeCode(id))
    await c.endEditing()
    #expect(r.doc.board.cards.count == cards && r.doc.board.card(id) == nil, "left empty: gone")
    #expect(r.doc.history.undoSteps.isEmpty, "with no step")
    try newCode()
    await r.editorReady()
    let id2 = try #require(c.editing?.id)
    r.code?.insertText("x = 1", replacementRange: none)
    await c.endEditing()
    guard case .own(let written)? = r.doc.board.card(id2)?.content, case .code(let code) = written.body else {
      Issue.record("no code card")
      return
    }
    #expect(code.segments.first?.lines == ["x = 1"])
    #expect(r.doc.history.undoSteps.map(\.name) == ["New Code"])
    r.doc.undo()
    #expect(r.doc.board.card(id2) == nil, "one undo takes it away")
  }

  /// Written, Free code's language is what its new text looks like (FreeLanguage, the board's guess), unless it was picked by hand
  /// (commands/code.ts writeFreeCode, freeLang)
  @Test func writtenFreeCodeTakesTheLanguageItsTextLooksLike() async throws {
    let rust = ["fn main() {", "    let v: Vec<u32> = Vec::new();", "    println!(\"{}\", v.len());", "}"]
    func free(_ id: String, y: Double, picked: Bool?) -> Card {
      let s = Segment(
        id: SegmentID(rawValue: "s-\(id)"), source: nil, language: "python", firstLine: 1, lines: rust,
        languagePicked: picked)
      return Card(
        id: cid(id), x: 100, y: y, width: 360, content: .own(CardContent(body: .code(CodeCard(segments: [s])))))
    }
    let board = Board(
      id: BoardID(rawValue: "lang"), cards: [free("auto", y: 100, picked: nil), free("picked", y: 400, picked: true)])
    let r = try await Rig(board, zoom: 1)
    defer { r.close() }
    let c = r.canvas
    for id in ["auto", "picked"] {
      let card = r.rect(id)
      let code = try #require(c.scene?.placed[cid(id)]?.code)
      let row = try #require(code.layout.row(segment: 0, line: 4))
      r.doubleClick(CGPoint(x: card.minX + code.layout.gutter + 4, y: card.minY + code.top + row.y + row.height / 2))
      await r.editorReady()
      r.code?.perform(.newline)
      r.code?.insertText("// done", replacementRange: none)
      await c.endEditing()
      let s = try #require(r.doc.board.freeCodeSegment(cid(id)))
      #expect(s.lines.count == 5 && r.doc.undoName == "Edit Code", "\(s.lines)")
      #expect(s.language == (id == "auto" ? "rust" : "python"), "\(id): \(s.language)")
    }
  }
}

/// A point on a card's header that is on none of its buttons: a press there must not act (a menu, a copy)
@MainActor private func clearOfButtons(_ c: CanvasView, _ id: CardID, _ p: CGPoint) -> CGPoint {
  let at = c.index(of: .card(id)).map { c.scene!.items[$0].rect.origin } ?? .zero
  let on = c.head(id)?.buttons.first { $0.1.offsetBy(dx: at.x, dy: at.y).contains(p) }
  #expect(on == nil, "\(p) is on the \(String(describing: on?.0)) button")
  return p
}

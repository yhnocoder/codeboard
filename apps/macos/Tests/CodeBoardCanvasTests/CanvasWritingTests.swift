import AppKit
import CodeBoardModel
import CodeBoardNotes
import Testing

@testable import CodeBoardCanvas
@testable import MarkdownUI

// Writing in Notes, Texts and Boxes on the canvas, with the native Markdown component's editor over the card (the Rig
// needs the built Note page, as CanvasEditTests): entering and leaving with nothing typed changes nothing, a session is
// one step, a new card left empty leaves none, and what another writer changes meanwhile merges with what is typed.

extension Rig {
  /// Presses keys as the keyboard does, through the window to whoever takes them, with no wait between them
  func press(_ text: String) {
    let codes: [Character: UInt16] = [
      "a": 0, "b": 11, "c": 8, "h": 4, "i": 34, "n": 45, "o": 31, "x": 7, "y": 16, "1": 18, "=": 24, " ": 49, "\r": 36,
      "\u{1b}": 53,
    ]
    for ch in text {
      for t in [NSEvent.EventType.keyDown, .keyUp] {
        window.sendEvent(
          NSEvent.keyEvent(
            with: t, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, characters: String(ch),
            charactersIgnoringModifiers: String(ch), isARepeat: false, keyCode: codes[ch] ?? 0)!)
      }
    }
  }

  /// Once the editor shows the card and takes keys
  func editorReady() async {
    let deadline = ContinuousClock.now + .seconds(60)
    while canvas.editing?.ready != true {
      if ContinuousClock.now > deadline {
        Issue.record("the editor did not mount: editing \(String(describing: canvas.editing))")
        return
      }
      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  func doubleClick(_ p: CGPoint) {
    send(mouse(.leftMouseDown, p))
    send(mouse(.leftMouseUp, p))
    send(mouse(.leftMouseDown, p, clicks: 2))
    send(mouse(.leftMouseUp, p, clicks: 2))
  }

  /// Types into the editor, whose layout follows at once
  func type(_ text: String) async {
    canvas.editing?.writer?.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
  }
}

@MainActor @Suite(.serialized) struct CanvasWritingTests {
  func writer(_ r: Rig) throws -> MarkdownEditorView { try #require(r.canvas.editing?.writer) }

  @Test(arguments: ["n1", "t1", "b1"])
  func enteringAndLeavingWithNothingTypedChangesNothing(id: String) async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let start = r.bytes
    let onDisk = try Data(contentsOf: r.file)
    let p = id == "n1" ? CGPoint(x: 40, y: 40) : r.centre(id)
    r.doubleClick(p)
    await r.editorReady()
    #expect(r.canvas.editing?.id == cid(id))
    let v = try writer(r)
    #expect(v.superview === r.canvas.superview && r.window.firstResponder === v)
    // over the card, its text where the card's picture has it (NativeCanvasTests: no line moves)
    let ed = try #require(r.canvas.editing)
    let text = r.canvas.camera.view(CGPoint(x: r.rect(id).minX + ed.inset.x, y: r.rect(id).minY + ed.inset.y))
    let top = r.canvas.convert(v.frame, from: v.superview).origin
    #expect(abs(top.x - text.x) < 0.5 && abs(top.y - text.y) < 0.5, "\(top) \(text)")
    // a click on the bare canvas leaves
    r.click(CGPoint(x: 800, y: 330))
    while r.canvas.isEditing { try await Task.sleep(for: .milliseconds(5)) }
    #expect(r.bytes == start)
    #expect(!r.doc.history.canUndo, "no step")
    #expect(v.superview == nil)
    r.doc.flush()
    #expect(try Data(contentsOf: r.file) == onDisk, "board.json byte for byte")
  }

  @Test func returnWritesInTheSelectedCardAndASessionIsOneStep() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.click(r.centre("t1"))
    r.key(36)
    await r.editorReady()
    await r.type(" now")
    await r.type(" and then")
    await r.canvas.endEditing()
    #expect(r.card("t1").writing == "Threads wait at the barrier now and then")
    #expect(r.doc.undoName == "Edit Text")
    await r.settle()
    r.doc.undo()
    #expect(r.card("t1").writing == "Threads wait at the barrier")
    #expect(!r.doc.history.canUndo, "one step for the whole session")
  }

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
    await r.editorReady()
    await r.type("，再算")
    await r.canvas.endEditing()
    #expect(r.doc.board.arrows[0].to.block == BlockRef(index: 2, hash: BlockRef.sig("每一步取一批，再算")))
    #expect(r.doc.undoName == "Edit Note")
    await r.settle()
    r.doc.undo()
    #expect(r.doc.board.arrows[0].to.block == last)
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func aDoubleClickOnTheCanvasMakesATextThatGoesWhenLeftEmpty(zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    let start = r.bytes
    let p = CGPoint(x: 800, y: 330)
    r.doubleClick(p)
    await r.editorReady()
    let id = try #require(r.canvas.editing?.id)
    let made = r.card(id.rawValue)
    #expect(made.x == p.x.rounded() && made.y == (p.y - 12).rounded())
    #expect(made.textCard?.look == .text && made.textCard?.wrap == false)
    #expect(!r.doc.history.canUndo, "no step while it is empty")
    r.key(53)
    // Esc reaches the editor (its first responder) in the app; here it is ended as Esc ends it
    await r.canvas.endEditing()
    #expect(r.doc.board.card(id) == nil)
    #expect(r.bytes == start)
    #expect(!r.doc.history.canUndo, "and none after")
    await r.settle()
    #expect(r.canvas.index(of: .card(id)) == nil)
  }

  /// interact.ts cardPointerDown / cardClick: a click on the body of the one Note selected before the press writes in it,
  /// the caret where it was; not the click that selects it, a click on its head, a ⇧-click, one of several selected or
  /// a Text's (Texts and Boxes are written by a double-click); the double-click's second press keeps the one session
  @Test func aClickOnTheOneSelectedNotesBodyWritesInIt() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let n = r.rect("n1")
    let body = CGPoint(x: n.minX + 40, y: n.maxY - 30)
    let head = CGPoint(x: n.minX + 40, y: n.minY + 10)
    r.click(body)
    await r.settle()
    #expect(r.doc.selection == [.card(cid("n1"))] && !c.isEditing, "the click that selects it")
    r.click(head)
    await r.settle()
    #expect(!c.isEditing, "its head")
    r.click(body, .shift)
    await r.settle()
    #expect(!c.isEditing, "a ⇧-click")
    r.doc.select([.card(cid("n1")), .card(cid("t1"))])
    r.click(body)
    await r.settle()
    #expect(r.doc.selection == [.card(cid("n1"))] && !c.isEditing, "one of several: only it stays selected")
    r.click(r.centre("t1"))
    r.click(r.centre("t1"))
    await r.settle()
    #expect(!c.isEditing, "a Text's")
    r.click(body)
    r.click(body)
    await r.editorReady()
    #expect(c.editing?.id == cid("n1"))
    await c.endEditing()
    #expect(!r.doc.history.canUndo)
    // the double-click on it selected: its first click began writing, its second keeps it
    r.doubleClick(body)
    await r.editorReady()
    let first = c.editing?.session
    await r.settle()
    #expect(c.editing?.session == first && first != nil)
    await c.endEditing()
  }

  /// interact.ts staticSpot: a double-click below the last line of a Note whose header shows its heading puts the caret
  /// at the end, as on the board (the web editor read the press on a render that showed the heading in the body, its
  /// lines lower by the heading's height than the canvas draws them, and put the caret on the first line's end)
  @Test func aDoubleClickBelowTheLastLineOfANoteWithItsHeadingInTheHeaderWritesAtTheEnd() async throws {
    let note = Card(
      id: cid("n1"), x: 100, y: 100, width: 300,
      content: .own(CardContent(body: .note(Note(text: "# Why words\nThe vocabulary maps each word to a number.")))))
    let r = try await Rig(Board(id: BoardID(rawValue: "heading"), cards: [note]), zoom: 1)
    defer { r.close() }
    let n = r.rect("n1")
    let last = try #require(r.canvas.scene?.placed[cid("n1")]?.blocks?.last)
    let below = n.minY + last.y + last.h
    #expect(n.maxY - below > 4, "room below the last line")
    r.doubleClick(CGPoint(x: n.minX + 150, y: (below + n.maxY) / 2))
    await r.editorReady()
    await r.type("XY")
    await r.canvas.endEditing()
    let got = r.doc.board.card(cid("n1"))?.writing
    #expect(got?.hasSuffix("a number.XY") == true, "\(got ?? "nil")")
  }

  /// The second press of a double-click on the selected Note's empty body, below its text, once the editor its first
  /// click opened is up: the window gives it to the editor, where it lands on the paper outside the text. The writing
  /// goes on, so what is typed next is written and no letter reaches the board's shortcuts
  @Test func theSecondPressOfADoubleClickOnTheEmptyBodyKeepsTheWritingGoing() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    let n = r.rect("n1")
    // below its two lines, in the window (its left edge is off it), clear of n2
    let blank = CGPoint(x: n.minX + 80, y: n.maxY - 10)
    let cards = r.doc.board.cards.count
    r.click(blank)
    await r.settle()
    #expect(r.doc.selection == [.card(cid("n1"))] && !c.isEditing)
    r.click(through: blank)
    await r.editorReady()
    let session = try #require(c.editing?.session)
    let v = try writer(r)
    r.click(through: blank, clicks: 2)
    await r.settle()
    #expect(c.editing?.session == session, "still writing")
    r.press("ab")
    #expect(v.source.contains("ab"))
    await c.endEditing()
    #expect(r.card("n1").writing?.contains("ab") == true, "what was typed after it is written")
    #expect(r.doc.board.cards.count == cards, "no card made by a letter")
  }

  /// A Note copied and pasted on the same board, then written in at once with a double-click on the copy's text: what is
  /// typed is the copy's, the original keeps its own (accept paste-copy)
  @Test func aPastedNoteIsWrittenInByADoubleClickOnItsText() async throws {
    let pb = NSPasteboard(name: NSPasteboard.Name("tests-\(UUID().uuidString)"))
    defer { pb.releaseGlobally() }
    let r = try await Rig(zoom: 1, pasteboard: pb)
    defer { r.close() }
    let was = try #require(r.card("n1").writing)
    r.doc.select([.card(cid("n1"))])
    r.canvas.copy(nil)
    r.canvas.paste(nil)
    let copy = try #require(r.canvas.pasteChip?.pairs.first?.copy)
    await r.settle()
    let at = r.rect(copy.rawValue)
    r.doubleClick(CGPoint(x: at.minX + 150, y: at.minY + 62))
    await r.editorReady()
    #expect(r.canvas.editing?.id == copy, "writing in the copy")
    r.press(" walrus")
    r.press("\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(
      r.doc.board.card(copy)?.writing?.contains("walrus") == true,
      "\(String(describing: r.doc.board.card(copy)?.writing))")
    #expect(r.card("n1").writing == was)
  }

  @Test func aNewCardWrittenInIsOneStep() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.canvas.createInView(.text(.box))
    await r.editorReady()
    let id = try #require(r.canvas.editing?.id)
    // in the middle of the view: x by its width, 40 above the middle
    let v = r.canvas.camera.visible(r.canvas.bounds.size)
    #expect(abs(r.card(id.rawValue).x - (v.midX - Board.newTextWidth / 2)) <= 0.5)
    #expect(abs(r.card(id.rawValue).y - (v.midY - 40)) <= 0.5)
    await r.type("Look **here**")
    await r.canvas.endEditing()
    #expect(r.card(id.rawValue).writing == "Look **here**")
    #expect(r.doc.undoName == "New Box")
    r.doc.undo()
    #expect(r.doc.board.card(id) == nil)
    #expect(!r.doc.history.canUndo)
  }

  @Test func theCardGrowsAsItIsTypedIn() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.canvas.createInView(.note)
    await r.editorReady()
    let id = try #require(r.canvas.editing?.id)
    await r.type("A first line")
    let before = try #require(r.canvas.editing?.size)
    let deadline = ContinuousClock.now + .seconds(60)
    let v = try writer(r)
    for _ in 0..<6 {
      v.doCommand(by: #selector(NSResponder.insertNewline(_:)))
      await r.type("another line")
    }
    while (r.canvas.editing?.size?.height ?? 0) <= before.height + 60, ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(5))
    }
    let grown = try #require(r.canvas.editing?.size)
    #expect(grown.height > before.height + 60)
    #expect(grown.width == before.width, "a Note keeps its width")
    let i = try #require(r.canvas.index(of: .card(id)))
    #expect(abs(r.canvas.items[i].box.bounds.height - grown.height) < 1, "its paper follows")
    #expect(r.canvas.liveRect(.card(id))?.height == grown.height, "arrows and rings too")
    await r.canvas.endEditing()
    #expect(r.card(id.rawValue).writing?.hasSuffix("another line") == true)
    #expect(r.doc.undoName == "New Note")
  }

  @Test func whatIsTypedWinsOverAnotherWritersTextAndTheRestMerges() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.click(r.centre("t1"))
    r.key(36)
    await r.editorReady()
    await r.type(" here")
    // another writer moves it and writes its text
    var theirs = try Board(decoding: Data(contentsOf: r.file), file: r.file)
    let i = try #require(theirs.cards.firstIndex { $0.id == cid("t1") })
    theirs.cards[i].x = 640
    if case .own(var c) = theirs.cards[i].content, case .text(var t) = c.body {
      t.text = "Theirs"
      c.body = .text(t)
      theirs.cards[i].content = .own(c)
    }
    try theirs.encoded().write(to: r.file)
    r.doc.diskChanged()
    #expect(r.card("t1").x == 640)
    await r.canvas.endEditing()
    #expect(r.card("t1").x == 640, "their move stays")
    #expect(r.card("t1").writing == "Threads wait at the barrier here", "what was typed wins")
  }

  @Test func aCardDeletedElsewhereWhileWrittenInComesBackWithWhatWasTyped() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.click(r.centre("b1"))
    r.key(36)
    await r.editorReady()
    await r.type("!")
    var theirs = try Board(decoding: Data(contentsOf: r.file), file: r.file)
    theirs.cards.removeAll { $0.id == cid("b1") }
    try theirs.encoded().write(to: r.file)
    r.doc.diskChanged()
    await r.canvas.endEditing()
    #expect(r.card("b1").writing == "Check the bounds!")
  }
}

// in the one serialized suite: the app has one editor, which these share
extension CanvasWritingTests {
  /// The middle of a button of the bar over a card (board units)
  func button(_ r: Rig, _ id: String, _ b: BarButton) throws -> CGPoint {
    let t = try #require(r.card(id).textCard)
    let bar = try #require(r.canvas.barRect(cid(id), t))
    let at = try #require(WritingBar.layout(box: t.look == .box).buttons.first { $0.0 == b }?.1)
    return CGPoint(x: bar.minX + at.midX, y: bar.minY + at.midY)
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func theBarSizesATextOneStepEach(zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    r.click(r.centre("t1"))
    #expect(r.canvas.barCard?.0 == cid("t1"))
    #expect(r.canvas.chrome.sublayers?.contains { $0.contents != nil } == true, "the bar is drawn")
    // over its neighbours while selected alone
    let i = try #require(r.canvas.index(of: .card(cid("t1"))))
    #expect(r.canvas.items[i].box.zPosition > 0)
    r.click(try button(r, "t1", .size(30)))
    #expect(r.card("t1").textCard?.fontSize == 30)
    #expect(r.doc.undoName == "Text Size" && r.doc.history.undoSteps.count == 1)
    // a Text that wraps keeps its line breaks: its width scales with it
    #expect(r.card("t1").width == (220.0 * 30 / 20).rounded())
    // the lit one does nothing
    r.click(try button(r, "t1", .size(30)))
    #expect(r.doc.history.undoSteps.count == 1)
    // another card selected: it goes back among them
    r.click(r.centre("b1"))
    await r.settle()
    let j = try #require(r.canvas.index(of: .card(cid("t1"))))
    #expect(r.canvas.items[j].box.zPosition == 0)
    // none while written in
    r.key(36)
    await r.editorReady()
    #expect(r.canvas.barCard == nil)
    await r.canvas.endEditing()
  }

  @Test func aBoxTakesItsFillsAndTextAndBoxKeepTheFirstLetterInPlace() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.click(r.centre("b1"))
    r.click(try button(r, "b1", .fill(.blue)))
    #expect(r.card("b1").textCard?.fill == .blue && r.doc.undoName == "Fill")
    await r.settle()
    // where its first letter is on the board, as the canvas's display lays it out
    func first(_ id: String) async throws -> CGPoint {
      let c = r.card(id)
      let t = try #require(c.textCard)
      let folder = r.file.deletingLastPathComponent()
      let m = try await r.canvas.display.firstGlyphs(of: [
        .init(note: .text(t), width: c.width, folder: folder, look: "warm-ink", dark: false)
      ])
      let p = try #require(m[0]?.first)
      return CGPoint(x: c.x + p.x, y: c.y + p.y)
    }
    let before = try await first("b1")
    let fs = r.card("b1").textCard?.fontSize
    r.click(try button(r, "b1", .look(.text)))
    while r.card("b1").textCard?.look != .text { try await Task.sleep(for: .milliseconds(5)) }
    #expect(r.doc.undoName == "Text")
    let after = try await first("b1")
    #expect(abs(after.x - before.x) < 0.5 && abs(after.y - before.y) < 0.5, "\(before) → \(after)")
    #expect(r.card("b1").textCard?.fontSize == fs)
    #expect(r.card("b1").width == 160, "a Box's sides are 20 wider")
    #expect(r.card("b1").textCard?.fill == .blue, "a Text keeps the fill it had")
    await r.settle()
    // back: the fill it had, the letter where it was
    r.click(try button(r, "b1", .look(.box)))
    while r.card("b1").textCard?.look != .box { try await Task.sleep(for: .milliseconds(5)) }
    let back = try await first("b1")
    #expect(abs(back.x - before.x) < 0.5 && abs(back.y - before.y) < 0.5)
    #expect(r.card("b1").textCard?.fill == .blue && r.card("b1").width == 180)
    r.doc.undo()
    r.doc.undo()
    r.doc.undo()
    #expect(r.card("b1").textCard?.fill == .yellow && r.card("b1").x == 500 && r.card("b1").y == 200)
  }
}

extension CanvasWritingTests {
  @Test func theToolbarShowsItsNineToolsAndMakesNoteTextAndBoxInTheViewsMiddle() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let bar = CanvasToolbar(frame: CGRect(x: 0, y: 0, width: 300, height: 100))
    #expect(bar.tools == [.note, .text, .box, .code, .image, .web, .section, .arrow, .sticker])
    // the web board's sizes: Warm Ink 4 + 9 × 30 + 8 × 2 + 4 wide, 36 tall; Ink Wash 22 + 9 × 30 + 8 + 34, 46; then
    // Search and ⋯ after a separator (gap, 0.5 with 4 each side, gap, 30, gap, 30)
    #expect(bar.barSize == CGSize(width: 294 + 2 + 8.5 + 2 + 30 + 2 + 30, height: 36))
    bar.theme = .inkWash
    #expect(bar.barSize == CGSize(width: 334 + 1 + 8.5 + 1 + 30 + 1 + 30, height: 46))
    var used: [Tool] = []
    bar.onTool = {
      used.append($0)
      r.canvas.use($0)
    }
    let host = NSView(frame: bar.frame)
    host.addSubview(bar)
    let p = bar.convert(CGPoint(x: bar.buttonRects()[2].midX, y: bar.buttonRects()[2].midY), to: nil)
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      bar.perform(
        type == .leftMouseDown ? #selector(NSView.mouseDown(with:)) : #selector(NSView.mouseUp(with:)),
        with: NSEvent.mouseEvent(
          with: type, location: p, modifierFlags: [], timestamp: 1, windowNumber: 0, context: nil, eventNumber: 0,
          clickCount: 1, pressure: 1))
    }
    #expect(used == [.box])
    await r.editorReady()
    let id = try #require(r.canvas.editing?.id)
    #expect(r.card(id.rawValue).textCard?.look == .box)
    await r.canvas.endEditing()
    #expect(r.doc.board.card(id) == nil, "left empty, it goes")
  }
}

extension CanvasWritingTests {
  @Test func aPictureGivenToTheEditorGoesIntoTheBoardsImages() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.doubleClick(CGPoint(x: 40, y: 40))
    await r.editorReady()
    // the editor's saveImage, as a paste or a drop calls it
    let png = try Data(contentsOf: r.file.deletingLastPathComponent().appending(path: "images/p.png"))
    let name = try #require(r.canvas.editor(try writer(r), saveImage: png, name: "p.png"))
    #expect(name.hasPrefix("images/") && name.hasSuffix("-400x200.png"))
    let stored = r.file.deletingLastPathComponent().appending(path: name)
    #expect(try Data(contentsOf: stored) == png)
    await r.canvas.endEditing()
  }
}

extension CanvasWritingTests {
  /// A click outside in the middle of an input method's composition: what is composed is written, as a field that loses
  /// its focus commits it
  @Test func focusLeavingMidCompositionWritesWhatIsComposed() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.click(r.centre("t1"))
    r.key(36)
    await r.editorReady()
    let v = try writer(r)
    v.doCommand(by: #selector(NSResponder.moveToEndOfDocument(_:)))
    v.setMarkedText(
      "屏障", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
    #expect(v.hasMarkedText())
    r.click(CGPoint(x: 800, y: 330))
    while r.canvas.isEditing { try await Task.sleep(for: .milliseconds(5)) }
    #expect(r.card("t1").writing == "Threads wait at the barrier屏障")
  }
}

extension CanvasWritingTests {
  /// Another board in the Rig's vault: "Memory Model", a Note titled Coalescing in its Section Caches
  func otherBoard(_ r: Rig) throws {
    let p = r.root.appending(path: "Memory Model.board")
    try FileManager.default.createDirectory(at: p, withIntermediateDirectories: true)
    let b = Board(
      id: BoardID(rawValue: "mem"),
      cards: [
        Card(
          id: CardID(rawValue: "m9"), x: 0, y: 0, width: 300, section: SectionID(rawValue: "g"),
          content: .own(CardContent(body: .note(Note(text: "# Coalescing\n\nbody")))))
      ],
      sections: [Section(id: SectionID(rawValue: "g"), title: "Caches", x: 0, y: 0, width: 400, height: 300)])
    try b.encoded().write(to: p.appending(path: Vault.boardFileName))
  }

  /// [[ opens the web board's list: this board's titled cards and Sections, then the other board's cards; picking one
  /// writes it as main does, `[[label#^id]]`, and the ref is drawn as what it points at at once
  @Test func doubleBracketListsTheCardsAndWritesThePickWithItsID() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    try otherBoard(r)
    r.click(r.centre("t1"))
    r.key(36)
    await r.editorReady()
    let v = try writer(r)
    await r.type(" [[")
    await r.until("the list, once its candidates are read") { r.canvas.editing?.refList != nil }
    let menu = r.canvas.editor(v, refMenu: "")
    let rows = menu.local.map(\.title) + menu.groups.flatMap { [$0.title] + $0.items.map(\.title) }
    for want in ["n1", "n2", "m1", "L1", "Group", "Memory Model", "Coalescing"] {
      #expect(rows.contains { $0.contains(want) }, "\(want) in \(rows)")
    }
    #expect(!rows.contains { $0.contains("Threads wait") }, "a Text without a heading is not listed")
    await r.type("n2")
    v.doCommand(by: #selector(NSResponder.insertNewline(_:)))
    // the caret away from it (beside it, the editor shows a ref's source)
    await r.type(" and on")
    #expect(v.core.layout.drawnRefs.contains { $0.target == "n2" }, "drawn as found")
    await r.canvas.endEditing()
    #expect(r.card("t1").writing == "Threads wait at the barrier [[n2#^n2]] and on")
    #expect(CanvasView.recentRefs.first.map { [$0.board, $0.id] } == ["edit-sample", "n2"])
  }

  @Test func aCardOnAnotherBoardIsWrittenWithTheBoardsName() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    try otherBoard(r)
    r.click(r.centre("t1"))
    r.key(36)
    await r.editorReady()
    await r.type(" [[")
    await r.until("the list, once its candidates are read") { r.canvas.editing?.refList != nil }
    await r.type("Coalesc")
    try writer(r).doCommand(by: #selector(NSResponder.insertNewline(_:)))
    await r.canvas.endEditing()
    #expect(r.card("t1").writing == "Threads wait at the barrier [[Memory Model › Coalescing#^mem/m9]]")
  }
}

extension CanvasWritingTests {
  /// What is typed reaches the board and the disk every couple of seconds while the card is written in, with no undo
  /// step and without the canvas redrawing the card under the editor; leaving makes the whole writing one step
  @Test
  func whatIsTypedIsDraftedOntoTheDiskWhileWritingAndLeavingIsStillOneStep() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.click(r.centre("t1"))
    r.key(36)
    await r.editorReady()
    let i = try #require(r.canvas.index(of: .card(cid("t1"))))
    let paper = r.canvas.items[i].box
    await r.type(" now")
    // the timer's draft
    let deadline = ContinuousClock.now + .seconds(10)
    while r.card("t1").writing != "Threads wait at the barrier now", ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(20))
    }
    #expect(r.card("t1").writing == "Threads wait at the barrier now")
    #expect(!r.doc.history.canUndo, "a draft is no step")
    #expect(r.canvas.items[i].box === paper, "the card under the editor is not drawn again for it")
    r.doc.flush()
    #expect(
      try Board(decoding: Data(contentsOf: r.file), file: r.file).card(cid("t1"))?.writing
        == "Threads wait at the barrier now", "on disk: a crash now loses nothing typed before it")
    await r.type(" and then")
    await r.canvas.saveDraft()
    #expect(r.card("t1").writing == "Threads wait at the barrier now and then")
    await r.canvas.endEditing()
    #expect(r.doc.history.undoSteps.map(\.name) == ["Edit Text"])
    await r.settle()
    r.doc.undo()
    #expect(r.card("t1").writing == "Threads wait at the barrier", "undo goes back to before the writing")
  }
}

extension CanvasWritingTests {
  /// Selects everything in the editor and deletes it, as ⌘A ⌫ does
  func emptyEditor(_ r: Rig) throws {
    let v = try writer(r)
    v.selectAll(nil)
    v.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
  }

  /// A Text with an arrow to it, emptied while written in (⌘A ⌫, then a pause past a draft): the draft does not take it off the board, nor
  /// the arrow to it, on the board or on disk; typed in again and left, it has the new text and its arrow
  @Test func aDraftOfAnEmptiedCardKeepsTheCardAndWhatPointsAtIt() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.doc.edit("Arrow") {
      $0.arrows.append(
        Arrow(id: ArrowID(rawValue: "a9"), from: Endpoint(card: cid("n1")), to: Endpoint(card: cid("t1"))))
    }
    await r.settle()
    r.click(r.centre("t1"))
    r.key(36)
    await r.editorReady()
    try emptyEditor(r)
    let emptied = try writer(r).source
    #expect(emptied.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, "blank: \(emptied)")
    await r.canvas.saveDraft()
    #expect(r.doc.board.card(cid("t1")) != nil && r.doc.board.arrows.contains { $0.id.rawValue == "a9" })
    r.doc.flush()
    let disk = try Board(decoding: Data(contentsOf: r.file), file: r.file)
    #expect(disk.card(cid("t1")) != nil && disk.arrows.contains { $0.id.rawValue == "a9" }, "on disk")
    #expect(disk.brokenReference == nil)
    await r.type("Again")
    await r.canvas.saveDraft()
    #expect(r.card("t1").writing == "Again")
    await r.canvas.endEditing()
    #expect(r.card("t1").writing == "Again" && r.doc.board.arrows.contains { $0.id.rawValue == "a9" })
    #expect(r.doc.history.undoSteps.map(\.name) == ["Arrow", "Edit Text"])
  }

  /// A new Text typed in, emptied and drafted, then typed in again: it stays on the board throughout and is one step
  @Test func aDraftOfAnEmptiedNewCardKeepsIt() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.doubleClick(CGPoint(x: 800, y: 330))
    await r.editorReady()
    let id = try #require(r.canvas.editing?.id)
    await r.type("abc")
    await r.canvas.saveDraft()
    #expect(r.doc.board.card(id)?.writing == "abc")
    try emptyEditor(r)
    await r.canvas.saveDraft()
    #expect(r.doc.board.card(id)?.writing == "abc", "the last draft stays")
    await r.type("x")
    await r.canvas.endEditing()
    #expect(r.doc.board.card(id)?.writing == "x")
    #expect(r.doc.history.undoSteps.map(\.name) == ["New Text"])
  }

  /// Typing at once after a double-click on the board, before the new Text is made: every key reaches it
  @Test func keysTypedAtOnceAfterADoubleClickAllReachTheNewText() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.doubleClick(CGPoint(x: 800, y: 330))
    r.press("hi a")
    await r.until("the editor has the keyboard") {
      r.canvas.editing?.writer.map { r.window.firstResponder === $0 } == true
    }
    let id = try #require(r.canvas.editing?.id)
    r.press("b\u{1b}")
    await r.until("left") { !r.canvas.isEditing }
    #expect(r.doc.board.card(id)?.writing == "hi ab")
  }

  /// A new Text left with Esc and pressed on its own left edge (where its double-click put it, under the pointer): the
  /// card is dragged, as on the board, whose width grips lie wholly outside the card
  @Test func aNewTextPressedOnItsEdgeIsDragged() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let c = r.canvas
    r.doubleClick(CGPoint(x: 800, y: 330))
    await r.editorReady()
    let id = try #require(c.editing?.id)
    await r.type("第一条想法")
    r.press("\u{1b}")
    await r.until("left") { !c.isEditing }
    #expect(r.doc.selection == [.card(id)])
    let before = r.rect(id.rawValue)
    r.drag(CGPoint(x: before.minX, y: before.midY), CGPoint(x: before.minX - 200, y: before.midY - 100))
    await r.settle()
    let after = r.rect(id.rawValue)
    #expect(after.minX == before.minX - 200 && after.minY == before.minY - 100 && after.width == before.width)
    #expect(r.doc.history.undoSteps.map(\.name) == ["New Text", "Move"])
  }

  /// ⌘A in a Note being written (the Edit menu's Select All, sent to the editor's view) selects all of it as the
  /// editor's own ⌘A does, so no format bar comes up (bubble.tsx: for a text selection only)
  @Test func selectAllInANoteSelectsItAllWithNoFormatBar() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.doubleClick(r.centre("m1"))
    await r.editorReady()
    let v = try writer(r)
    v.selectAll(nil)
    // past the time a selection waits for its bar
    try await Task.sleep(for: .seconds(MarkdownTiming.toolbarSettle * 2))
    #expect(!v.toolbarShown, "the format bar came up")
    let all = v.core.selection.range
    let sel = (v.source as NSString).substring(with: NSRange(location: all.lowerBound, length: all.count))
    #expect(sel.contains("m1") && sel.contains("few words"), "\(sel)")
  }
}

import AppKit
import CodeBoardModel
import CodeBoardNotes
import Testing

@testable import CodeBoardCanvas

// Writing in Notes, Texts and Boxes on the canvas, with the web board's editor over the card (needs the built Note page,
// as CanvasEditTests): entering and leaving with nothing typed changes nothing, a session is one step, a new card left
// empty leaves none, and what another writer changes meanwhile merges with what is typed.

extension Rig {
  /// Once the editor shows the card and takes keys
  func editorReady() async {
    let deadline = ContinuousClock.now + .seconds(10)
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

  /// Types into the editor and waits for its layout to follow
  func type(_ text: String) async {
    canvas.noteEditor.type(text)
    _ = try? await canvas.noteEditor.view.evaluateJavaScript("new Promise(r => requestAnimationFrame(() => r(1)))")
  }
}

@MainActor @Suite(.serialized) struct CanvasWritingTests {
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
    #expect(r.canvas.noteEditor.view.shown)
    #expect(r.canvas.noteEditor.view.superview === r.canvas.superview)
    // the web view lies over the card: the card's frame on screen is its card rect
    let card = r.canvas.noteEditor.view.convert(r.canvas.noteEditor.view.cardRect, to: r.canvas)
    let shown = r.canvas.camera.view(r.rect(id).origin)
    #expect(abs(card.minX - shown.x) < 0.5 && abs(card.minY - shown.y) < 0.5)
    // a click on the bare canvas leaves
    r.click(CGPoint(x: 800, y: 330))
    while r.canvas.isEditing { try await Task.sleep(for: .milliseconds(5)) }
    #expect(r.bytes == start)
    #expect(!r.doc.history.canUndo, "no step")
    #expect(!r.canvas.noteEditor.view.shown)
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

  @Test func keysPressedWhileTheEditorMountsReachIt() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.click(r.centre("b1"))
    r.key(36)
    // before the editor is there
    #expect(r.canvas.editing?.ready == false)
    let e = NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: [], timestamp: 2000, windowNumber: r.window.windowNumber,
      context: nil, characters: "!", charactersIgnoringModifiers: "!", isARepeat: false, keyCode: 18)!
    r.send(e)
    #expect(r.canvas.editing?.keys.count == 1)
    await r.editorReady()
    #expect(r.canvas.editing?.keys.isEmpty == true, "given to the editor")
    await r.canvas.endEditing()
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
    let deadline = ContinuousClock.now + .seconds(10)
    for _ in 0..<6 {
      try await r.canvas.noteEditor.view.evaluateJavaScript("document.execCommand('insertParagraph')")
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

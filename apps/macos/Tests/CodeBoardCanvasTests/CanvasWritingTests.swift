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
    let deadline = ContinuousClock.now + .seconds(60)
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
    // where its first letter is on the board, as the Note page lays it out
    func first(_ id: String) async throws -> CGPoint {
      let c = r.card(id)
      let t = try #require(c.textCard)
      let folder = r.file.deletingLastPathComponent()
      let m = try await Rig.notes.firstGlyphs(of: [
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
  @Test func theToolbarShowsNoteTextAndBoxAndMakesThemInTheViewsMiddle() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    let bar = CanvasToolbar(frame: CGRect(x: 0, y: 0, width: 300, height: 100))
    #expect(bar.tools == [.note, .text, .box])
    // the web board's sizes: Warm Ink 4 + 3 × 30 + 2 × 2 + 4 wide, 36 tall; Ink Wash 22 + 3 × 30 + 2 + 34, 46
    #expect(bar.barSize == CGSize(width: 102, height: 36))
    bar.theme = .inkWash
    #expect(bar.barSize == CGSize(width: 148, height: 46))
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
  /// A pinch while writing: the web view stays, its layer scaled over the card as the camera zooms, with nothing drawn,
  /// asked for or swapped in until the gesture ends (frames ticking as the display link gives them); at rest the editor
  /// shows itself at the new zoom, and what was typed survives
  @Test func zoomingWhileWritingScalesTheEditorsLayerThenShowsItAtTheNewZoomAtRest() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.click(r.centre("t1"))
    r.key(36)
    await r.editorReady()
    await r.type(" now")
    await r.idle()
    let editor = r.canvas.noteEditor
    let i = try #require(r.canvas.index(of: .card(cid("t1"))))
    let paper = r.canvas.items[i].box
    let before = r.breaks
    let host = try #require(editor.view.superview)
    let margin = editor.view.cardRect.minX
    let around = CGPoint(x: 500, y: 350)
    var t: TimeInterval = 1
    r.canvas.pinch(by: 1.05, around: around, at: t, began: true, ended: false)
    for _ in 0..<12 {
      t += 1.0 / 120
      r.canvas.pinch(by: 1.02, around: around, at: t, began: false, ended: false)
      r.canvas.tick(at: t)
      #expect(editor.view.shown, "the web view stays")
      #expect(r.canvas.items[i].box === paper, "no picture swapped in")
      // its layer covers the card where the camera shows it now
      let z = r.canvas.camera.zoom
      let k = try #require(r.canvas.editing?.shownZoom)
      let o = r.canvas.camera.view(r.rect("t1").origin)
      let size = try #require(r.canvas.editing?.size)
      let card = r.canvas.convert(CGRect(x: o.x, y: o.y, width: size.width * z, height: size.height * z), to: host)
      let f = z / k
      let want = card.insetBy(dx: -margin * f, dy: -margin * f)
      let got = try #require(editor.view.layer?.frame)
      #expect(
        abs(got.minX - want.minX) < 0.5 && abs(got.minY - want.minY) < 0.5 && abs(got.width - want.width) < 0.5,
        "layer \(got) over \(want)")
    }
    #expect(r.canvas.editing?.zooming == true)
    #expect(r.breaks == before, "nothing drawn, decoded, asked for or swapped during the gesture")
    t += 1.0 / 120
    r.canvas.pinch(by: 1, around: around, at: t, began: false, ended: true)
    await r.idle()
    let deadline = ContinuousClock.now + .seconds(20)
    while r.canvas.editing?.zooming == true, ContinuousClock.now < deadline {
      r.tick()
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(r.canvas.editing?.zooming == false)
    #expect(r.canvas.editing?.shownZoom == r.canvas.camera.zoom)
    #expect(editor.view.shown)
    #expect(editor.view.layer?.affineTransform() == .identity)
    // the web view's card lies on the card at the new zoom
    let card = editor.view.convert(editor.view.cardRect, to: r.canvas)
    let at = r.canvas.camera.view(r.rect("t1").origin)
    #expect(abs(card.minX - at.x) < 0.5 && abs(card.minY - at.y) < 0.5)
    #expect(abs(card.width - r.rect("t1").width * r.canvas.camera.zoom) < 1.5)
    await r.canvas.endEditing()
    #expect(r.card("t1").writing == "Threads wait at the barrier now", "what was typed survives the zoom")
  }

  @Test func aPictureGivenToTheEditorGoesIntoTheBoardsImages() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.doubleClick(CGPoint(x: 40, y: 40))
    await r.editorReady()
    // the editor's saveImage, as a paste or a drop calls it
    let png = try Data(contentsOf: r.file.deletingLastPathComponent().appending(path: "images/p.png"))
    let address =
      try await r.canvas.noteEditor.view.callAsyncJavaScript(
        "return await window.webkit.messageHandlers.image.postMessage({dataUrl: u, name: 'p.png'})",
        arguments: ["u": "data:image/png;base64," + png.base64EncodedString()], contentWorld: .page) as? String
    let name = try #require(address)
    #expect(name.hasPrefix("images/") && name.hasSuffix("-400x200.png"))
    let stored = r.file.deletingLastPathComponent().appending(path: name)
    #expect(try Data(contentsOf: stored) == png)
    await r.canvas.endEditing()
  }
}

extension CanvasWritingTests {
  /// The editor leaves by itself when its web view loses focus and posts "done"; a click outside meanwhile asks it to
  /// finish too. Whichever comes first, what was typed is written: here the "done" never reaches the canvas (it is
  /// what arrived late and was dropped), and the click outside must still get the text
  @Test func whatWasTypedIsWrittenWhenTheEditorLeftByItselfBeforeTheClickOutside() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.click(r.centre("t1"))
    r.key(36)
    await r.editorReady()
    await r.type(" now")
    let editor = r.canvas.noteEditor
    editor.onDone = nil
    // focus leaves the editor; it finishes on the timer after the blur
    _ = try await editor.view.callAsyncJavaScript(
      "document.activeElement.blur(); await new Promise(r => setTimeout(r, 20)); return 1", contentWorld: .page)
    r.click(CGPoint(x: 800, y: 330))
    while r.canvas.isEditing { try await Task.sleep(for: .milliseconds(5)) }
    #expect(r.card("t1").writing == "Threads wait at the barrier now")
    #expect(r.doc.undoName == "Edit Text")
  }

  /// Focus leaving in the middle of an IME composition (started and updated when focus goes; WebKit then commits it, as it
  /// does when a field loses focus): what is composed is written
  @Test func focusLeavingMidCompositionWritesWhatIsComposed() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    r.click(r.centre("t1"))
    r.key(36)
    await r.editorReady()
    let editor = r.canvas.noteEditor
    _ = try await editor.view.callAsyncJavaScript(
      """
      const pm = document.querySelector(".ProseMirror");
      pm.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      document.execCommand("insertText", false, "屏障");
      pm.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "屏障" }));
      await new Promise(r => requestAnimationFrame(() => r(1)));
      pm.blur();
      pm.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "屏障" }));
      return 1
      """, contentWorld: .page)
    r.click(CGPoint(x: 800, y: 330))
    while r.canvas.isEditing { try await Task.sleep(for: .milliseconds(5)) }
    #expect(r.card("t1").writing == "Threads wait at the barrier屏障")
  }
}

extension CanvasWritingTests {
  /// What the open [[ list shows, row by row (the editor's menu in the page)
  func refRows(_ r: Rig) async throws -> [String] {
    let rows = try await r.canvas.noteEditor.view.callAsyncJavaScript(
      """
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return [...document.querySelectorAll(".md-pick .md-list .tx, .md-pick .md-gh, .md-pick .md-foot")]
        .map(n => n.textContent.trim()).filter(Boolean)
      """, contentWorld: .page)
    return rows as? [String] ?? []
  }

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
  /// writes it as main does, `[[label#^id]]`, and the ref shows what it points at at once
  @Test func doubleBracketListsTheCardsAndWritesThePickWithItsID() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    try otherBoard(r)
    r.click(r.centre("t1"))
    r.key(36)
    await r.editorReady()
    await r.type(" [[")
    let rows = try await refRows(r)
    for want in ["n1", "n2", "m1", "L1", "Group", "Memory Model", "Coalescing", "5 titled cards · 2 boards"] {
      #expect(rows.contains { $0.contains(want) }, "\(want) in \(rows)")
    }
    #expect(!rows.contains { $0.contains("Threads wait") }, "a Text without a heading is not listed")
    let menu = try await r.canvas.noteEditor.view.callAsyncJavaScript(
      "return document.querySelector('.md-pick')?.className ?? null", contentWorld: .page)
    #expect((menu as? String)?.contains("ctx") == true, "the board's menu look: \(String(describing: menu))")
    await r.type("n2")
    await r.type("\n")
    // the caret away from it (beside it, the editor shows a ref's source)
    await r.type("and on")
    // the ref drawn in the text shows its card's title (what the list gave for it), once the editor has drawn it
    var shown: String?
    let deadline = ContinuousClock.now + .seconds(5)
    while shown?.contains("n2") != true, ContinuousClock.now < deadline {
      shown =
        try await r.canvas.noteEditor.view.callAsyncJavaScript(
          "await new Promise(r => requestAnimationFrame(r));"
            + " return document.querySelector('.ProseMirror[contenteditable=true] .md-ref')?.textContent ?? null",
          contentWorld: .page)
        as? String
    }
    #expect(shown?.contains("n2") == true, "the ref shows its card: \(String(describing: shown))")
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
    await r.type(" [[Coalesc")
    await r.type("\n")
    await r.canvas.endEditing()
    #expect(r.card("t1").writing == "Threads wait at the barrier [[Memory Model › Coalescing#^mem/m9]]")
  }
}

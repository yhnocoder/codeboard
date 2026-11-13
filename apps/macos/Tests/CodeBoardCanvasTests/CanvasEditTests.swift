import AppKit
import CodeBoardModel
import CodeBoardNotes
import Testing
import UniformTypeIdentifiers

@testable import CodeBoardCanvas

// Editing on the real canvas, driven by mouse and key events made in this process for a window of its own (never
// on screen: far off it, so nothing reaches the screen, the pointer or another app), at two zooms. The events go straight
// to the canvas's handlers, as the window would deliver them: a window off screen is never key, and NSWindow drops the
// first click on a window that is not. The Note page renders
// the Texts and Boxes, so these need the built page (node web/build.mjs) and a login session, as CanvasNoteTests.

func cid(_ s: String) -> CardID { CardID(rawValue: s) }
private func gid(_ s: String) -> SectionID { SectionID(rawValue: s) }

/// Two overlapping Notes, a Text, a Box, an image, a Section with a Note in it, a locked Note and an arrow
private func sample() -> Board {
  func note(_ id: String, x: Double, y: Double, section: String? = nil, locked: Bool = false) -> Card {
    Card(
      id: cid(id), x: x, y: y, width: 240, height: 160, section: section.map(gid), locked: locked,
      content: .own(CardContent(body: .note(Note(text: "# \(id)\n\nA plan in a few words.")))))
  }
  return Board(
    id: BoardID(rawValue: "edit-sample"),
    cards: [
      note("n1", x: 0, y: 0),
      note("n2", x: 100, y: 60),
      Card(
        id: cid("t1"), x: 500, y: 0, width: 220,
        content: .own(CardContent(body: .text(TextCard(text: "Threads wait at the barrier", wrap: true))))),
      Card(
        id: cid("b1"), x: 500, y: 200, width: 180,
        content: .own(CardContent(body: .text(TextCard(text: "Check the bounds", look: .box, wrap: true))))),
      Card(
        id: cid("i1"), x: 900, y: 0, width: 200,
        content: .own(CardContent(body: .image(ImageCard(source: .file("p.png")))))),
      note("m1", x: 50, y: 480, section: "g1"),
      note("L1", x: 900, y: 500, locked: true),
    ],
    arrows: [Arrow(id: ArrowID(rawValue: "a1"), from: Endpoint(card: cid("n1")), to: Endpoint(card: cid("m1")))],
    sections: [Section(id: gid("g1"), title: "Group", x: 0, y: 400, width: 600, height: 400)])
}

/// A 400 × 200 picture
private func png(_ url: URL) throws {
  let ctx = try #require(
    CGContext(
      data: nil, width: 400, height: 200, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
  ctx.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: 400, height: 200))
  let image = try #require(ctx.makeImage())
  let dest = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
  CGImageDestinationAddImage(dest, image, nil)
  #expect(CGImageDestinationFinalize(dest))
}

/// A board in a vault of its own, open in a canvas in a window of its own
@MainActor final class Rig {
  let root: URL
  let window: NSWindow
  let canvas: CanvasView
  let doc: BoardDocument
  let file: URL
  static let notes = NoteRenderer(
    cache: FileManager.default.temporaryDirectory.appending(path: "canvas-edit-cache-\(UUID().uuidString)"))

  init(_ board: Board = sample(), zoom: CGFloat, pasteboard: NSPasteboard? = nil, root given: URL? = nil) async throws {
    _ = NSApplication.shared
    let page = NoteRenderer.bundledPage.appending(path: "page.html").path(percentEncoded: false)
    try #require(FileManager.default.fileExists(atPath: page), "build the Note page first: node web/build.mjs")
    let fm = FileManager.default
    root = given ?? fm.temporaryDirectory.appending(path: "canvas-edit-\(UUID().uuidString)")
    let name = "\(board.id.rawValue).board"
    let package = root.appending(path: name)
    try fm.createDirectory(at: package.appending(path: Vault.imagesFolder), withIntermediateDirectories: true)
    try png(package.appending(path: Vault.imagesFolder).appending(path: "p.png"))
    file = package.appending(path: Vault.boardFileName)
    try board.encoded().write(to: file)
    let f = file
    doc = try BoardDocument { f }
    canvas = CanvasView(frame: CGRect(x: 0, y: 0, width: 1000, height: 700), notes: Rig.notes)
    if let pasteboard { canvas.pasteboard = pasteboard }
    window = NSWindow(
      contentRect: CGRect(x: -30000, y: -30000, width: 1000, height: 700), styleMask: [.titled], backing: .buffered,
      defer: false)
    window.isReleasedWhenClosed = false
    // the canvas in a view of its own, as in a tab: the editor's web view goes over it there
    let host = NSView(frame: canvas.frame)
    host.addSubview(canvas)
    window.contentView = host
    canvas.noteEditor.drawOffScreen()
    // far off screen: the web view runs its animation frames only in a window that is ordered in
    window.orderFrontRegardless()
    try await canvas.show(
      doc, at: VaultBoard(id: board.id, title: "B", path: name), in: Vault(root: root), theme: .warmInk)
    canvas.place(zoom: zoom, centre: CGPoint(x: 550, y: 400))
    // from rest: a test's gestures start with no redraw of the setup's under way, as a person's do on a board drawn
    await idle()
  }

  func close() {
    doc.flush()
    canvas.leave()
    window.close()
    try? FileManager.default.removeItem(at: root)
  }

  /// A board point in the window's coordinates
  func at(_ p: CGPoint) -> CGPoint { canvas.convert(canvas.camera.view(p), to: nil) }

  private var time: TimeInterval = 1000

  func mouse(_ type: NSEvent.EventType, _ p: CGPoint, _ flags: NSEvent.ModifierFlags = [], clicks: Int = 1) -> NSEvent {
    time += 0.016
    return NSEvent.mouseEvent(
      with: type, location: at(p), modifierFlags: flags, timestamp: time, windowNumber: window.windowNumber,
      context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
  }

  /// What the window does with a mouse or key event: to the canvas's handler
  func send(_ e: NSEvent) {
    switch e.type {
    case .leftMouseDown: canvas.mouseDown(with: e)
    case .leftMouseDragged: canvas.mouseDragged(with: e)
    case .leftMouseUp: canvas.mouseUp(with: e)
    case .keyDown: canvas.keyDown(with: e)
    case .keyUp: canvas.keyUp(with: e)
    default: Issue.record("no handler for \(e.type)")
    }
  }

  func click(_ p: CGPoint, _ flags: NSEvent.ModifierFlags = []) {
    send(mouse(.leftMouseDown, p, flags))
    send(mouse(.leftMouseUp, p, flags))
  }

  /// Presses at `from`, moves to `to` in steps (board points), and releases; `during` runs before the release
  func drag(
    _ from: CGPoint, _ to: CGPoint, _ flags: NSEvent.ModifierFlags = [], steps: Int = 8, during: () -> Void = {}
  ) {
    send(mouse(.leftMouseDown, from, flags))
    for i in 1...steps {
      let k = CGFloat(i) / CGFloat(steps)
      let p = CGPoint(x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k)
      send(mouse(.leftMouseDragged, p, flags))
    }
    during()
    send(mouse(.leftMouseUp, to, flags))
  }

  func key(_ code: UInt16, _ flags: NSEvent.ModifierFlags = [], up: Bool = true) {
    time += 0.016
    let chars = code == 53 ? "\u{1b}" : code == 51 ? "\u{7f}" : " "
    for type in up ? [NSEvent.EventType.keyDown, .keyUp] : [.keyDown] {
      send(
        NSEvent.keyEvent(
          with: type, location: .zero, modifierFlags: flags, timestamp: time, windowNumber: window.windowNumber,
          context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!)
    }
  }

  func keyUp(_ code: UInt16) {
    send(
      NSEvent.keyEvent(
        with: .keyUp, location: .zero, modifierFlags: [], timestamp: time, windowNumber: window.windowNumber,
        context: nil, characters: " ", charactersIgnoringModifiers: " ", isARepeat: false, keyCode: code)!)
  }

  /// Once the scene shows the board as the document has it
  func settle() async {
    while canvas.shownBoard != doc.board {
      await canvas.refreshing?.value
      await Task.yield()
    }
  }

  /// Once the canvas is at rest with no redraw queued or running: what a gesture after this counts is its own
  func idle() async {
    let deadline = ContinuousClock.now + .seconds(60)
    while !(canvas.queue.isIdle && canvas.tasks.isEmpty && canvas.motion.isResting) {
      if ContinuousClock.now > deadline {
        Issue.record("the canvas did not come to rest")
        return
      }
      tick()
      try? await Task.sleep(for: .milliseconds(2))
    }
  }

  /// A frame, as the display link gives one (it does not run while the display sleeps)
  func tick() { canvas.tick(at: CACurrentMediaTime()) }

  func card(_ id: String) -> Card { doc.board.card(cid(id))! }
  /// Where the scene draws a card
  func rect(_ id: String) -> CGRect { canvas.scene!.items[canvas.index(of: .card(cid(id)))!].rect }
  func centre(_ id: String) -> CGPoint { CGPoint(x: rect(id).midX, y: rect(id).midY) }
  var bytes: Data { try! doc.board.encoded() }
  var breaks: Int {
    let b = canvas.ruleBreaks
    return b.redraws + b.decodes + b.swaps + b.noteRequests + b.noteSwaps
  }
}

@MainActor @Suite(.serialized) struct CanvasEditTests {
  @Test(arguments: [1, 0.5] as [CGFloat])
  func hitTestingFindsTheTopCardTitlesSectionsAndHandles(zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    let c = r.canvas
    // n2 lies over n1 where they overlap
    #expect(c.hitCard(CGPoint(x: 150, y: 100)) == cid("n2"))
    #expect(c.hitCard(CGPoint(x: 20, y: 20)) == cid("n1"))
    #expect(c.hitCard(CGPoint(x: 400, y: 300)) == nil)
    #expect(c.deepestSection(CGPoint(x: 400, y: 700)) == gid("g1"))
    let title = try #require(c.scene?.items.first { $0.owner == .sectionTitle(gid("g1")) }?.rect)
    #expect(c.hitSectionTitle(CGPoint(x: title.midX, y: title.midY)) == gid("g1"))
    // a handle is taken within 6 view points of it, whatever the zoom
    r.doc.select([.card(cid("n1"))])
    let corner = c.camera.view(CGPoint(x: 240, y: 160))
    #expect(c.hitHandle(CGPoint(x: corner.x + 5, y: corner.y - 5))?.1 == [.right, .bottom])
    #expect(c.hitHandle(CGPoint(x: corner.x + 9, y: corner.y)) == nil)
    // a Text has its side edges and its corner; an image its right edge and corner
    #expect(Set(c.resizeEdges(.card(cid("t1"))).map(\.rawValue)) == [1, 2, 10])
    #expect(Set(c.resizeEdges(.card(cid("i1"))).map(\.rawValue)) == [2, 10])
    // a locked card has none
    r.doc.select([.card(cid("L1"))])
    #expect(c.hitHandle(c.camera.view(CGPoint(x: 1140, y: 660))) == nil)
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func clicksShiftAndCommandClicksEscapeAndSelectAll(zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    r.click(r.centre("t1"))
    #expect(r.doc.selection == [.card(cid("t1"))])
    r.click(r.centre("b1"), .shift)
    #expect(r.doc.selection == [.card(cid("t1")), .card(cid("b1"))])
    r.click(r.centre("t1"), .command)
    #expect(r.doc.selection == [.card(cid("b1"))])
    // a Section's blank inside selects it; its title too
    r.click(CGPoint(x: 450, y: 750))
    #expect(r.doc.selection == [.section(gid("g1"))])
    r.key(53)
    #expect(r.doc.selection.isEmpty)
    r.canvas.selectAll(nil)
    #expect(r.doc.selection.count == 7, "every card but the locked one, and the Section")
    #expect(!r.doc.selection.contains(.card(cid("L1"))))
    r.click(CGPoint(x: 800, y: 330))
    #expect(r.doc.selection.isEmpty, "a click on the bare canvas")
    #expect(!r.doc.history.canUndo, "selecting is no step")
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func theMarqueeTakesWhatItTouchesAndSectionsWhollyInside(zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    // from the bare canvas across the Section and onto the locked card
    r.drag(CGPoint(x: -30, y: 380), CGPoint(x: 950, y: 830))
    #expect(r.doc.selection == [.section(gid("g1")), .card(cid("m1"))])
    // ⇧ adds to what was selected
    r.drag(CGPoint(x: 480, y: -20), CGPoint(x: 510, y: 210), .shift)
    #expect(r.doc.selection == [.section(gid("g1")), .card(cid("m1")), .card(cid("t1")), .card(cid("b1"))])
    #expect(r.canvas.marquee.path == nil, "gone once released")
  }

  @Test func redrawsCancelledWithoutAGestureAreNoBreak() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    await r.idle()
    // redraws under way at another zoom, then the camera placed again (no gesture): they are cancelled and finish late
    for _ in 0..<5 {
      r.canvas.place(zoom: 0.7, centre: CGPoint(x: 550, y: 400))
      r.tick()
      #expect(!r.canvas.tasks.isEmpty, "redraws started")
      r.canvas.place(zoom: 1.4, centre: CGPoint(x: 550, y: 400))
      await r.idle()
    }
    #expect(r.breaks == 0, "work a placement cancelled is not work during a gesture")
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func draggingACardIsOneStepThatOnlyMovesLayersAndJoinsTheSectionItLandsIn(zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    let start = r.bytes
    let from = r.centre("t1")
    let layer = r.canvas.items[r.canvas.index(of: .card(cid("t1")))!]
    let contents = layer.held.contents as AnyObject?
    let breaks = r.breaks
    var arrowPath: CGPath?
    // n2 lies over n1's middle
    let n1 = CGPoint(x: 40, y: 40)
    r.click(n1)
    // n1 into the Section: its arrow follows during the drag
    let arrowBefore = (r.canvas.arrowGroups[0].first as? CAShapeLayer)?.path
    r.drag(n1, CGPoint(x: 100, y: 540)) {
      arrowPath = (r.canvas.arrowGroups[0].first as? CAShapeLayer)?.path
    }
    #expect(arrowPath != nil && arrowPath != arrowBefore)
    #expect(r.card("n1").x == 60 && r.card("n1").y == 500)
    #expect(r.card("n1").section == gid("g1"))
    #expect(r.doc.undoName == "Move" && r.doc.history.undoSteps.count == 1)
    await r.settle()
    // t1 moved by a drag of its own, without being selected first
    r.drag(from, CGPoint(x: from.x - 30, y: from.y + 40)) {
      #expect(r.breaks == breaks, "nothing is drawn, decoded, requested or swapped during the drag")
      #expect(layer.held.contents as AnyObject? === contents)
    }
    #expect(r.card("t1").x == 470 && r.card("t1").y == 40)
    #expect(r.doc.selection == [.card(cid("t1"))])
    await r.settle()
    #expect(r.canvas.items[r.canvas.index(of: .card(cid("t1")))!] === layer, "it keeps its layers and bitmaps")
    // undo all: back to the very bytes
    r.doc.undo()
    r.doc.undo()
    #expect(r.bytes == start)
    #expect(r.doc.selection == [.card(cid("n1"))], "undo restores the selection the step started with")
    r.doc.redo()
    r.doc.redo()
    #expect(r.card("t1").x == 470 && r.card("n1").section == gid("g1"))
    // the drag out takes it out
    await r.settle()
    // by a corner m1 does not cover
    r.drag(CGPoint(x: 270, y: 650), CGPoint(x: 1570, y: 650))
    #expect(r.card("n1").section == nil)
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func draggingASectionCarriesWhatIsInItButALockedCardStays(zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    let title = try #require(r.canvas.scene?.items.first { $0.owner == .sectionTitle(gid("g1")) }?.rect)
    r.drag(CGPoint(x: title.midX, y: title.midY), CGPoint(x: title.midX + 100, y: title.midY + 20))
    let g = try #require(r.doc.board.section(gid("g1")))
    #expect(g.x == 100 && g.y == 420)
    #expect(r.card("m1").x == 150 && r.card("m1").y == 500)
    #expect(r.doc.history.undoSteps.count == 1)
    // the locked card does not move
    r.doc.select([])
    r.drag(r.centre("L1"), CGPoint(x: r.centre("L1").x - 200, y: r.centre("L1").y))
    #expect(r.card("L1").x == 900)
    #expect(r.doc.history.undoSteps.count == 1)
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func arrowKeysNudgeOnePointOnScreenAndTenWithShiftAsOneStep(zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    r.click(r.centre("b1"))
    r.key(124, up: false)
    r.key(124, up: false)
    r.key(125, up: false)
    #expect(r.card("b1").x == 500, "not saved until the keys are up")
    r.keyUp(124)
    r.keyUp(125)
    let unit = max(1, (1 / zoom).rounded())
    #expect(r.card("b1").x == 500 + 2 * unit && r.card("b1").y == 200 + unit)
    #expect(r.doc.history.undoSteps.count == 1)
    r.key(123, .shift)
    let left = Double(500 + 2 * unit - (10 / zoom).rounded())
    #expect(r.card("b1").x == left)
    #expect(r.doc.history.undoSteps.count == 2)
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func eachKindResizesByItsOwnHandles(zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    // a Note: width and height from its corner
    r.click(CGPoint(x: 40, y: 40))
    r.drag(CGPoint(x: 240, y: 160), CGPoint(x: 300, y: 200))
    #expect(r.card("n1").width == 300 && r.card("n1").height == 200)
    // a Text's side edge: the width it wraps at, never below its longest word
    await r.settle()
    r.click(r.centre("t1"))
    let t = r.rect("t1")
    r.drag(CGPoint(x: t.maxX, y: t.midY), CGPoint(x: t.maxX + 80, y: t.midY))
    #expect(r.card("t1").width == 300)
    await r.settle()
    let t2 = r.rect("t1")
    r.drag(CGPoint(x: t2.maxX, y: t2.midY), CGPoint(x: t2.minX - 400, y: t2.midY))
    let least = try #require(r.canvas.leastWidths[cid("t1")])
    #expect(least > 60 && least < 120, "as wide as \"barrier\": \(least)")
    #expect(abs(r.card("t1").width - least.rounded()) <= 1)
    // a Box's corner: its text size, its width with it
    await r.settle()
    r.click(r.centre("b1"))
    let b = r.rect("b1")
    r.drag(CGPoint(x: b.maxX, y: b.maxY), CGPoint(x: b.maxX + b.width, y: b.maxY + b.height))
    guard case .own(let content) = r.card("b1").content, case .text(let box) = content.body else {
      Issue.record("b1 is a Box")
      return
    }
    #expect(box.fontSize == 40 && r.card("b1").width == 360)
    // far past the largest size: 240
    await r.settle()
    let b2 = r.rect("b1")
    r.drag(CGPoint(x: b2.maxX, y: b2.maxY), CGPoint(x: b2.maxX + 6000, y: b2.maxY + 6000))
    if case .own(let c) = r.card("b1").content, case .text(let box) = c.body { #expect(box.fontSize == 240) }
    // an image keeps its aspect
    await r.settle()
    r.click(r.centre("i1"))
    let i = r.rect("i1")
    #expect(i.height == 100)
    r.drag(CGPoint(x: i.maxX, y: i.maxY), CGPoint(x: i.maxX + 100, y: i.maxY + 10))
    #expect(r.card("i1").width == 300 && r.card("i1").height == nil)
    await r.settle()
    #expect(r.rect("i1").height == 150)
    // a Section's frame: what it now covers joins it
    let g = try #require(r.doc.board.section(gid("g1")))
    r.doc.select([.section(gid("g1"))])
    r.drag(CGPoint(x: g.x + g.width, y: g.y + g.height), CGPoint(x: 1200, y: 900))
    let g2 = try #require(r.doc.board.section(gid("g1")))
    #expect(g2.width == 1200 && g2.height == 500)
    #expect(r.card("L1").section == nil, "locked: not taken in")
    #expect(r.doc.history.undoSteps.count == 7)
  }

  @Test func deleteCopyPasteAndDuplicateWithinAndBetweenBoards() async throws {
    let board = NSPasteboard(name: NSPasteboard.Name("codeboard-tests-\(UUID().uuidString)"))
    defer { board.releaseGlobally() }
    let r = try await Rig(zoom: 1, pasteboard: board)
    defer { r.close() }
    let start = r.bytes
    r.doc.select([.card(cid("n1")), .card(cid("m1"))])
    r.canvas.copy(nil)
    r.canvas.paste(nil)
    #expect(r.doc.board.cards.count == 9 && r.doc.selection.count == 2)
    let pasted = r.doc.selection.compactMap(\.card).compactMap(r.doc.board.card).sorted { $0.y < $1.y }
    #expect(pasted.map(\.x) == [24, 74] && pasted.map(\.y) == [24, 504])
    #expect(r.doc.board.arrows.count == 2, "the arrow between them comes along")
    r.canvas.duplicate(nil)
    #expect(r.doc.board.cards.count == 11)
    r.key(51)
    #expect(r.doc.board.cards.count == 9 && r.doc.selection.isEmpty)
    // into another board
    var other = Board(id: BoardID(rawValue: "other"))
    other.cards = []
    let s = try await Rig(other, zoom: 1, pasteboard: board)
    defer { s.close() }
    s.canvas.paste(nil)
    #expect(s.doc.board.cards.count == 2 && s.doc.board.arrows.count == 1)
    #expect(s.doc.board.cards.allSatisfy { $0.section == nil }, "no Section to be in there")
    for _ in 0..<3 { r.doc.undo() }
    #expect(r.bytes == start)
  }

  @Test func arrangeLockTiltAndTheContextMenu() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    func titles(_ m: NSMenu?) -> [String] { m?.items.map { $0.isSeparatorItem ? "-" : $0.title } ?? [] }
    let n1 = CGPoint(x: 40, y: 40)
    let menu = r.canvas.menu(for: r.mouse(.rightMouseDown, n1))
    #expect(r.doc.selection == [.card(cid("n1"))], "right-click selects what is under it")
    #expect(titles(menu) == ["Arrange", "-", "Delete"])
    #expect(titles(menu?.items.first?.submenu) == ["Bring to Front", "Send to Back", "-", "Tilt", "Lock"])
    r.canvas.bringToFront(nil)
    #expect(r.doc.board.cards.last?.id == cid("n1"))
    r.canvas.sendToBack(nil)
    #expect(r.doc.board.cards.first?.id == cid("n1"))
    r.canvas.tilt(nil)
    #expect(r.card("n1").tilted)
    r.canvas.lock(nil)
    #expect(r.card("n1").locked)
    #expect(titles(r.canvas.menu(for: r.mouse(.rightMouseDown, n1))?.items.first?.submenu).last == "Unlock")
    // locked: it does not move, and ⌫ leaves it
    await r.settle()
    r.drag(n1, CGPoint(x: 340, y: 40))
    r.key(51)
    #expect(r.card("n1").x == 0)
    // several: Lock, Tilt, Arrange, then Cut, Copy, Duplicate, Delete
    r.doc.select([.card(cid("t1")), .card(cid("b1"))])
    #expect(
      titles(r.canvas.menu(for: r.mouse(.rightMouseDown, r.centre("t1"))))
        == ["Lock", "Tilt", "Arrange", "-", "Cut", "Copy", "Duplicate", "Delete"])
    // a Section's
    #expect(titles(r.canvas.menu(for: r.mouse(.rightMouseDown, CGPoint(x: 450, y: 750)))) == ["Lock", "-", "Delete"])
    #expect(r.doc.undoName == "Lock" && r.doc.history.undoSteps.count == 4)
  }

  @Test(arguments: [1, 0.5] as [CGFloat])
  func scrollAndPinchMoveOnlyTheCamera(zoom: CGFloat) async throws {
    let r = try await Rig(zoom: zoom)
    defer { r.close() }
    let start = r.bytes
    let origin = r.canvas.camera.origin
    let e = try #require(
      CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: -40, wheel2: -20, wheel3: 0))
    r.canvas.scrollWheel(with: try #require(NSEvent(cgEvent: e)))
    // the content follows the fingers up and left (shaped as a trackpad's deltas are)
    #expect(r.canvas.camera.origin.y > origin.y && r.canvas.camera.origin.x > origin.x)
    // NSEvent makes no magnify events: the pinch is given as its handler gets it
    let z = r.canvas.camera.zoom
    r.canvas.pinch(by: 1.2, around: CGPoint(x: 500, y: 350), at: 1, began: true, ended: false)
    r.canvas.pinch(by: 1.1, around: CGPoint(x: 500, y: 350), at: 1.016, began: false, ended: true)
    #expect(r.canvas.camera.zoom > z * 1.2)
    // a click still lands where the card is drawn
    r.click(r.centre("b1"))
    #expect(r.doc.selection == [.card(cid("b1"))])
    #expect(r.bytes == start && !r.doc.history.canUndo)
  }

  @Test func aChangeOnDiskIsShownWithoutAStep() async throws {
    let r = try await Rig(zoom: 1)
    defer { r.close() }
    var theirs = sample()
    theirs.move([.card(cid("b1"))], dx: 0, dy: 300)
    try theirs.encoded().write(to: r.file)
    r.doc.diskChanged()
    await r.settle()
    #expect(r.rect("b1").minY == 500 && !r.doc.history.canUndo)
  }
}
